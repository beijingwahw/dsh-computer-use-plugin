// src/guards/circuitBreakerGuard.ts
// 熔断守卫。pre 拦截 + post 计数的两点布控，用最小字符串协议实现跨工具聚合统计。
// 融合修复：
//   1. 模块级状态 -> 闭包状态：随插件卸载一并消亡，HMR 重载即重置（符合注册即效果模型）；
//   2. 阈值硬编码 3 -> 由 Config 注入；
//   3. 失败判定：统一走 resultContract（B-2），锚点 JSON 强类型字段 + 前缀协议回退。
// 第六轮：失败记忆自动接线 —— 每次失败即时写入 failureMemory（场景指纹随行），
//   熔断触发时再补记一条聚合症状。技能库只学「什么有效」，此处补全「什么无效」的对称面。
import type { Context } from '@deepseek-ai/cordis';
import { onToolPre, onToolPost } from './hooks';
import { failureMemory } from '../failureMemory';
import { journal } from '../journal';
import { contextManager } from '../contextManager';
import { classifyResult, isFailure, isSuccess } from '../resultContract';
import { RecoveryEfficacy, recoveryEfficacy, classifySyndromeSignature } from '../recoveryEfficacy'; // W2-5（R5）：恢复疗效账
import type { RecoveryActionId } from '../diagnosis'; // W2-5：疗效排序的动作名词空间

/** 把恢复提示附加到结果字符串：锚点 JSON 注入 recovery_hint 字段；非 JSON 则换行追加 */
function appendHint(result: string, hint: string): string {
  try {
    const obj = JSON.parse(result);
    if (obj && typeof obj === 'object') {
      obj.recovery_hint = hint;
      return JSON.stringify(obj, null, 2);
    }
  } catch { /* 前缀协议字符串，走下方追加 */ }
  return `${result}\n[${hint}]`;
}

/** 失败症状提炼：锚点 JSON 取 status/next_step 首句；前缀协议取首行
 *  W1-6：导出供 rootCauseGuard 复用（同上：单一推导源） */
export function extractSymptom(result: string): string {
  try {
    const obj = JSON.parse(result);
    if (obj?.status) {
      const step = typeof obj.next_step === 'string' ? obj.next_step.split(/[.\n]/)[0] : '';
      return `${obj.status}${step ? ': ' + step : ''}`;
    }
  } catch { /* 非锚点格式 */ }
  return result.split('\n')[0].slice(0, 120);
}

/** 动作签名：工具名 + 关键参数摘要（失败记忆的 approach 字段） */
function actionSignature(name: string, args: Record<string, any>): string {
  const keys = ['x', 'y', 'text', 'hotkey', 'direction', 'title', 'index', 'query', 'target_description'];
  const parts = keys.filter(k => args[k] !== undefined).map(k => `${k}=${String(args[k]).slice(0, 40)}`);
  return `${name}(${parts.join(', ')})`;
}

/** 写入失败记忆：query 取当前任务语境（无复杂任务则标注交互态），sceneHash 随行供场景加成
 *  W1-6（R1 鉴别试验）：可选 rootCause —— 鉴别探针的归因结论随行入库/刷新
 *  （同查询+同路径的近重复记录会更新病因字段，见 failureMemory.record）。
 *  导出供 rootCauseGuard 复用：同一套 query/approach/signature 推导，保证
 *  归因刷新命中同一条记录（两套推导 = 一次失败两条记录的污染）。
 *  W2-5（R5）：返回写入/刷新的记录 —— 调用方可回读 effective rootCause
 *  （近重复去重路径会把上一次鉴别结论带回来），喂给恢复疗效账的根因轴。 */
export function rememberFailure(
  name: string,
  args: Record<string, any>,
  symptom: string,
  rootCause?: import('../diagnosis').RootCauseId,
): import('../failureMemory').FailureRecord {
  const query = journal.currentTask() || 'interactive session (no complex task)';
  return failureMemory.record(query, actionSignature(name, args), symptom, contextManager.lastImageRecord()?.hash, rootCause);
}

// ── R 纪元（R-3 熔断层）：Beta-Bernoulli 序贯后验臂 ──
// 连续计数的盲区：交替成败型坏路线（fail-success-fail-…，真实失败率 50%+）
// 永远凑不满连续阈值 —— 旧熔断在此**永不触发**。后验臂：滚动窗内
// P(失败率 > θ | 窗口证据) ≥ 0.95 即熔断（Beta(a=f+1, b=s+1) 的上尾质量，
// 正则化不完全 Beta 函数 I_θ(a,b) —— Lentz 连分式，Numerical Recipes 形）。

/** ln Γ(x)（Lanczos 近似 g=7 —— |ε| < 1e-13；Math.lgamma 尚未进 ES） */
function lgamma(x: number): number {
  const g = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  }
  x -= 1;
  let a = g[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += g[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** 正则化不完全 Beta 函数 I_x(a,b)（Lentz 连分式；a,b > 0，x ∈ [0,1]） */
export function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lgamma(a + b) - lgamma(a) - lgamma(b)
    + a * Math.log(x) + b * Math.log(1 - x);
  const bt = Math.exp(lbeta);
  if (x < (a + 1) / (a + b + 2)) {
    return bt * betacf(x, a, b) / a;
  }
  return 1 - bt * betacf(1 - x, b, a) / b;
}

/** 连分式（NR 6.4：迭代至 |Δ| < 3e-12，上限 200 轮） */
/** W6-1（风格债）：连分式迭代上限 —— 原裸字面量 200 提取为具名常量，数值逐位不变 */
const BETACF_MAX_ITERATIONS = 200;
function betacf(x: number, a: number, b: number): number {
  const FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= BETACF_MAX_ITERATIONS; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}

/**
 * 滚动窗熔断判决（纯函数）：窗口内 f 败 s 胜 ⇒ P(失败率 > θ) 的后验质量。
 * ≥ 0.95 且窗口 ≥ minWindow ⇒ 熔断（θ=0.5：一半以上调用在坏路线上）。
 */
export function posteriorTripProbability(failures: number, successes: number, theta = 0.5): number {
  const a = failures + 1, b = successes + 1;
  return Math.round((1 - regularizedBeta(theta, a, b)) * 10000) / 10000;
}

const BREAKER_WINDOW = 20;  // 滚动窗容量（后验臂的证据上限）
const BREAKER_MIN_WINDOW = 8; // 最小判决样本（先验不越数据）
const BREAKER_TRIP_MASS = 0.95; // 后验质量阈值（误熔断率 ≈ 5%）

// ── W2-5（R5 恢复策略疗效归因）：恢复提示的动作面 ──
// 规范动作（diagnosis.RecoveryActionId）→ 提示文本。前两条是历史递进提示的
// 逐字节原文（冷启动零回归承诺：n<5 时疗效表返回的固定梯子恰好命中它们）；
// 其余四条按 ROOT_CAUSE_LADDER / RC_HYPOTHESIS 语义撰写 —— 疗效表样本量
// 充足后，提示从固定递进改为后验均值排序的动态处方。
// 导出供 metrics/doctor 消费（处方文案单一事实源），测试锁死冷启动等价性。
export const RECOVERY_HINT_TEXT: Record<RecoveryActionId, string> = {
  'zoom-refine': "Recovery hint: call 'zoom_inspect' around the target to refine coordinates before retrying.",
  'switch-modality': 'Recovery hint: switch modality — try keyboard navigation via press_hotkey (tab/enter), '
    + "or scroll_page if the target may be off-screen. Also try recall_ui for remembered locations.",
  're-observe': "Recovery hint: re-observe before retrying — take_screenshot (or diff_view) to refresh the "
    + 'world model; the screen may have changed under you.',
  'ground-target': 'Recovery hint: ground the target first — find_text to locate the labeled control, '
    + 'or probe_interactivity to verify the point is actually clickable.',
  'wait-settle': 'Recovery hint: the world may be stalling — let it settle (wait longer) before the next '
    + 'action; avoid rapid retries that amplify tail latency.',
  'stop-ask-user': 'Recovery hint: recovery attempts are not working — STOP retrying and ask the user for help.',
};

export function registerCircuitBreakerGuard(
  ctx: Context,
  maxFailures: number,
  /** W2-5（R5）：恢复疗效账的注入缝 —— 缺省进程级单例（guards/index.ts 零改动接线）；
   *  测试注入隔离实例（离线确定性）。账本绝不抛，喂入/查询失败的成本是
   *  「这一笔没记上 / 用固定梯子」，绝不是熔断路径异常。 */
  efficacy: RecoveryEfficacy = recoveryEfficacy,
): void {
  // Y6 会话隔离：与 repeatActionGuard 同源的真机战果 —— 熔断器挂在进程级
  // 管线上，看见所有会话的调用。旧实现的连续计数与滚动窗是共享闭包状态：
  // 会话 A 末尾的 3 连败会让会话 B 的第一个调用直接熔断（B 的模型对"A 走
  // 过弯路"一无所知）。状态按会话分键；无会话标识的旧表面退化为 '_anon'。
  interface BreakerState {
    recentFailures: number;
    // R-3：滚动窗（true=失败）—— 交替成败的证据在此累积，连续计数看不见它们
    window: boolean[];
  }
  const MAX_TRACKED_SESSIONS = 16;
  const bySession = new Map<string, BreakerState>();
  const stateFor = (sessionId: string | undefined): BreakerState => {
    const key = sessionId ?? '_anon';
    let s = bySession.get(key);
    if (!s) {
      if (bySession.size >= MAX_TRACKED_SESSIONS) {
        const oldest = bySession.keys().next().value;
        if (oldest !== undefined) bySession.delete(oldest);
      }
      s = { recentFailures: 0, window: [] };
      bySession.set(key, s);
    }
    return s;
  };

  // 1. 执行前：连续失败达到阈值 -> 熔断一轮（重置计数器 = 强制冷静后还给机会，而非永久锁死）
  onToolPre(ctx, async (toolCall, next) => {
    const st = stateFor(toolCall.sessionId);
    // R-3 后验臂：交替成败型坏路线（连续计数永不满足）的熔断判决
    const f = st.window.filter(Boolean).length;
    const suc = st.window.length - f;
    const tripMass = st.window.length >= BREAKER_MIN_WINDOW
      ? posteriorTripProbability(f, suc)
      : 0;
    const posteriorTrip = tripMass >= BREAKER_TRIP_MASS;
    if (st.recentFailures >= maxFailures || posteriorTrip) {
      const why = posteriorTrip
        ? `posterior arm: P(failure rate > 50% | last ${st.window.length} calls) = ${tripMass} ≥ 0.95 (flaky-broken route)`
        : `${maxFailures} consecutive failures`;
      // 聚合症状补记一条：按真实触发臂归因（match_skill 检索时作为强负向信号）
      const tripSymptom = `circuit-breaker: ${why} triggered a forced pause`;
      const tripRecord = rememberFailure(toolCall.name, toolCall.args, tripSymptom);
      // W2-5（R5）：熔断事件入疗效事件流 —— 恢复回合允许从熔断事件起算
      //（回读记录的病因：近重复去重可能带回上一次鉴别结论）
      efficacy.ingest({
        kind: 'failure', tool: toolCall.name, symptom: tripSymptom,
        ...(tripRecord?.rootCause !== undefined ? { rootCause: tripRecord.rootCause } : {}),
      });
      st.recentFailures = 0;
      st.window.length = 0; // 熔断即冷静：窗口清空（强制冷静后还给机会）
      // U 纪元（U-3）：守卫裁决入链 —— 拦截即防篡改存证（proof 器官闭环到守卫层：
      // 每次拦截都是可被 MMR 证明的历史事实，事后不可抵赖）
      void journal.appendMarker({ kind: 'GUARD_BLOCKED', guard: 'circuit-breaker', reason: posteriorTrip ? 'posterior' : 'consecutive' }).catch(() => { /* 存证旁路 */ });
      return `[Guard Blocked]: Circuit Breaker triggered (${why})! ` +
        `Please STOP and re-evaluate the overall strategy or ask the user for help.`;
    }
    return next();
  });

  // 2. 执行后：经统一契约解析器判定成败（B-2：不再依赖序列化格式巧合）；
  //    第 1/2 次失败注入递进式恢复提示（waterfall 允许改写透传值）
  onToolPost(ctx, async (toolCall, result, next) => {
    if (typeof result === 'string') {
      const st = stateFor(toolCall.sessionId);
      const c = classifyResult(result);

      st.window.push(isFailure(c));
      if (st.window.length > BREAKER_WINDOW) st.window.shift();
      if (isFailure(c)) {
        st.recentFailures++;
        // 失败即时入记忆：下一次 match_skill 即可召回「这条路走不通」
        const symptom = extractSymptom(result);
        const record = rememberFailure(toolCall.name, toolCall.args, symptom);
        // W2-5（R5）：失败事件喂疗效账（回合划定从失败事件起算；症候签名 ×
        // 回读病因 —— 近重复去重可能带回上一次鉴别结论，垃圾值由账本收口）
        efficacy.ingest({
          kind: 'failure', tool: toolCall.name, symptom,
          ...(record?.rootCause !== undefined ? { rootCause: record.rootCause } : {}),
        });
        // 递进式恢复策略：第一次失败教「放大精定位」，第二次教「换模态」
        // W2-5（R5）：提示选择消费疗效表排序 —— n<5 冷启动 = 固定递进梯子
        // （与历史行为逐字节等价）；n≥5 = 后验均值降序的动态处方
        if (st.recentFailures === 1 || st.recentFailures === 2) {
          const order = efficacy.prescriptionOrder(
            classifySyndromeSignature(symptom, toolCall.name),
            record?.rootCause,
          );
          const action = order[Math.min(st.recentFailures, order.length) - 1];
          return next(appendHint(result, RECOVERY_HINT_TEXT[action]));
        }
      } else if (isSuccess(c)) {
        st.recentFailures = 0; // 成功即重置
        efficacy.ingest({ kind: 'success', tool: toolCall.name }); // W2-5：恢复回合的闭合事件
      } else {
        // W2-5：不可判定结果仍消耗恢复回合窗口（是一次真实尝试），但不产生疗效观察
        efficacy.ingest({ kind: 'unknown', tool: toolCall.name });
      }
    }
    return next(result); // 必须把 result 透传给下一个
  });
}
