// src/processScore.ts
// W3-8(创新提案 E4):免标注过程评分器 —— step credit assignment。
//
// 世界观:终局分(任务成没成)是稀疏的 0/1 信号;一条轨迹里真正稠密的信息在
// 过程里 —— 每一步的动作效果、意图佐证、振荡与浪费。本模块离线回放 journal
// JSONL 轨迹(journal.ts 哈希链行格式),把每步可得证据量化为 0-1 步分,再聚合
// 成任务级过程分 —— 免标注:不需要人工打标,证据全部来自链上既有字段。
//
// W3-8 设计铁律:
//   1. 纯函数核心 + 离线确定性:零依赖、零 IO、零随机 —— 同一输入永远同一报告
//      (跨版本对比的前提;四通道定义/权重/聚合公式任一变更必须 bump
//      SCORE_CALIBER_VERSION,否则版本间分数不可比)。
//   2. 口径诚实:字段缺席 ⇒ 该通道记 0.5 中性并计数 —— 「没有证据」与「证据
//      不利」是两回事(缺席不是 0 分;与 Δ-7 诚实降级同律)。
//   3. 防御式绝不抛:垃圾行/缺字段跳过并计数、空轨迹诚实报空、病态载荷
//      (环形 args / BigInt)就地降级,最外层兜底捕获产出 ok=false 报告。
//
// 四通道(每步各 [0,1],加权合成步分;权重模块常量 + 可注入):
//   effect      动作效果:detected × scale(page-level 1.0 / element-level 0.9 /
//               缺席或矛盾 0.95 —— 双尺度中点,不猜测哪个对)。
//   intent      意图佐证:证据阶梯 intent.satisfied > phashCorroborates > thought
//               (actionVerifier.ts 的 CombinedEffect 字段落盘到 journal 行顶层后
//               即被采信;当前未落盘 ⇒ 0.5 中性 + 缺席计数)。
//   oscillation 振荡惩罚:连续同签名(tool + args 指纹)run=1/2/≥3 ⇒ 1.0/0.5/0;
//               环境重塑 marker(ENV_SHAPED/SENSE_SHIFT/AGENT_BEGIN)重置 run。
//   wait        等待浪费:连续无效果 streak 每步递减 0.4(单次失败 = 探索容错
//               0.6,连续失败 = 进度停滞 → 0);「无效果信息」(缺席)= 中性 0.5。

/** 口径版本号:四通道刻度/权重语义/聚合公式任一变更 ⇒ 必须 bump(跨版本可比的锚) */
export const SCORE_CALIBER_VERSION = 'E4-v1';

// ── W3-8 刻度常量(全部进报告 calibration 回显,消费方可复算) ──

/** scale → effect 通道刻度:页面级变化(导航/弹窗/大区块) */
export const SCALE_VALUE_PAGE = 1.0;
/** scale → effect 通道刻度:元素级变化(文字输入/光标出现)—— 真实但弱于页面级 */
export const SCALE_VALUE_ELEMENT = 0.9;
/** scale 缺席/矛盾(detected=true 而 scale='none')⇒ 双档中点,不站队 */
export const SCALE_VALUE_UNKNOWN = 0.95;
/** intent 证据阶梯:物理规则证实期望 */
export const INTENT_VALUE_SATISFIED = 1.0;
/** intent 证据阶梯:规则否证(变化不是预期的变化) */
export const INTENT_VALUE_UNSATISFIED = 0.0;
/** intent 证据阶梯:pHash 频谱第二意见同判(Q-2 佐证) */
export const INTENT_VALUE_PHASH_AGREE = 0.9;
/** intent 证据阶梯:pHash 异议 —— 证据冲突,存疑但不下 0.4 定罪 */
export const INTENT_VALUE_PHASH_DISSENT = 0.4;
/** intent 证据阶梯:仅有出声思考(thought)—— 弱佐证,意图可解释 ≠ 意图正确 */
export const INTENT_VALUE_THOUGHT_ONLY = 0.6;
/** osc 刻度:连续同签名第 2 次(一次重试在容错域内 ⇒ 减半) */
export const OSC_RUN2 = 0.5;
/** wait 刻度:每多一步连续无效果递减 0.4(streak=1→0.6, 2→0.2, ≥3→0) */
export const WAIT_STREAK_DECAY = 0.4;
/** 过程分与终局分的混合比(blended 参考值;并报不替代) */
export const BLEND_PROCESS = 0.7;
export const BLEND_FINAL = 0.3;

export interface ChannelWeights { effect: number; intent: number; oscillation: number; wait: number }

/**
 * W3-8 默认四通道权重。理由:
 *   effect 0.45 —— 主通道:「这一步改变了世界吗」是过程质量的直接证据;
 *   intent 0.15 —— 佐证通道:当前 journal 大多不落盘 intent/phash(缺席=0.5),
 *                   权重过高会稀释主信号,过低则退化为纯结果主义;
 *   oscillation 0.2 / wait 0.2 —— 浪费通道的两种正交形态:空间重复(同签名
 *                   反复执行)与时间停滞(连续无效果),等权对偶。
 */
export const DEFAULT_CHANNEL_WEIGHTS: Readonly<ChannelWeights> = Object.freeze({
  effect: 0.45, intent: 0.15, oscillation: 0.2, wait: 0.2,
});

/** 首低分步锚定阈值:低于此的首步被自动锚定。落在中性基线(≈0.6)与
 *  明确无效(≈0.1-0.3)之间 —— 只有「有明确负面证据」的步才被点名。 */
export const DEFAULT_LOW_STEP_THRESHOLD = 0.35;
/** PBR 风格晚期偏置 λ:步权重 w_i = (1-λ) + 2λ·i/(n-1) —— 后期步权重高
 *  (任务后期的无效步比开局的探索失败更致命;λ=0.5 ⇒ 末步权重 3 倍于首步) */
export const DEFAULT_LATE_BIAS = 0.5;

// ── W3-8 工具面(与 journal.ts 的 ACTION_TOOLS/MARKER_TOOLS 同步;
//    本模块零依赖(离线 CLI 可直接 strip-types 加载),故自持副本 + 执法测试防漂移) ──
//    ΠΑΝ-109（副本漂移清偿）：旧副本只有 6 个 marker，权威面（journal.ts）已
//    扩到 9（AGENT_NOTE/GUARD_PROBE/SANDBOX_HOST_REPLAY 相继入白名单）——
//    「执法测试防漂移」名不副实（漂移已发生而测试全绿：靠 entry.status===
//    'MARKER' 的兜底才没把 marker 行当动作步评分）。修法：副本对齐权威全集
//    （9 个）+ 两个集合导出为公共面 + 同源锁测试（test/pan105-113.misc.test.ts
//    直接对 journal 的导出面/源文本锁逐元素对账 —— journal.ts 的 MARKER_TOOLS
//    未导出，锁测试读源提取字面集合，任何一侧漂移即闸红）。
const SCORED_TOOLS: ReadonlySet<string> = new Set([
  'click_mouse', 'type_text', 'scroll_page', 'press_hotkey',
  'drag_mouse', 'click_element', 'switch_tab', 'switch_window', 'dismiss_popup',
  'open_url',
]);
const MARKER_TOOLS: ReadonlySet<string> = new Set([
  'AGENT_BEGIN', 'AGENT_END', 'ENV_SHAPED', 'SENSE_SHIFT', 'GUARD_BLOCKED', 'AUDIT_PRE',
  // ΠΑΝ-109：与 journal.ts MARKER_TOOLS 白名单对齐的三个迟到成员
  'AGENT_NOTE',      // W6-4：黑板行经 appendMarker 入链
  'GUARD_PROBE',     // ΑΩ-R4：守卫物理探针存证行
  'SANDBOX_HOST_REPLAY', // 沙箱宿主重放存证行
]);
/** ΠΑΝ-109：自持副本的公共面（同源锁测试的对账锚 —— 不改变任何运行行为） */
export const SCORE_TOOL_SETS: { scored: ReadonlySet<string>; markers: ReadonlySet<string> } = Object.freeze({
  scored: SCORED_TOOLS,
  markers: MARKER_TOOLS,
});
/** 环境被重塑/感知相变/代理重生 ⇒ 同签名的「连续性」被打断(物理直觉) */
const OSC_RESET_MARKERS: ReadonlySet<string> = new Set(['AGENT_BEGIN', 'ENV_SHAPED', 'SENSE_SHIFT']);

// ─── W3-8 报告类型 ───

export interface ChannelValues { effect: number; intent: number; oscillation: number; wait: number }
export interface ChannelFlags { effect: boolean; intent: boolean; oscillation: boolean; wait: boolean }

/** 步证据摘要(锚定与调试用;字段口径与来源见各通道注释) */
export interface StepEvidence {
  ts: number | null;
  status: string | null;
  detected: boolean | null;          // effect_detected(false = 链上明示无效果)
  scale: string | null;              // 'page-level' | 'element-level' | 'none' | 缺席
  intent_satisfied: boolean | null;  // intent.satisfied(缺席 = null)
  phash_corroborates: boolean | null;
  has_thought: boolean;
  has_observe: boolean;
  signature: string;                 // tool + args 指纹(剔除 reasoning 等易变键)
  repeat_run: number;                // 连续同签名长度(含本步)
  no_effect_streak: number;          // 连续无效果长度(含本步;缺席步不累积不清零)
}

export interface StepScore {
  index: number;                     // 动作步序号(过滤 marker/垃圾后的 0-based)
  tool: string;
  ts: number | null;
  score: number;                     // 四通道加权 ∈ [0,1]
  channels: ChannelValues;
  absent: ChannelFlags;              // 该步各通道是否按「缺席=0.5」计
  args_summary: string;
  evidence: StepEvidence;
}

/** 首低分步锚定:该步 + 前后文(过程诊断的入口) */
export interface LowStepAnchor {
  index: number;
  score: number;
  threshold: number;
  tool: string;
  args_summary: string;
  reasons: string[];                 // 负面证据清单(口径透明)
  channels: ChannelValues;
  prev: { index: number; tool: string; score: number } | null;
  next: { index: number; tool: string; score: number } | null;
}

export interface ProcessScoreReport {
  ok: boolean;                       // false = 内部兜底捕获(防御产物,零抛出)
  caliber_version: string;
  generated_by: string;
  internal_error: string | null;
  totals: {
    lines_total: number;
    lines_blank: number;
    lines_garbage: number;           // 非 JSON / 非对象 / 缺 tool
    lines_unscored_tool: number;     // 合法行但不在评分工具面(观察类工具等)
    action_steps: number;
    marker_lines: number;
  };
  channel_absence: { effect: number; intent: number; oscillation: number; wait: number };
  steps: StepScore[];
  task: {
    objective: string | null;        // AGENT_BEGIN 的任务目标(语境,不参与评分)
    step_count: number;
    plain_mean: number | null;       // 简单均值
    weighted_mean: number | null;    // PBR 晚期加权均值(主口径)
    final_score: number | null;      // 终局分(AGENT_END;缺席 = null)
    final_status: string | null;
    blended: number | null;          // 0.7×过程 + 0.3×终局(参考值;终局缺席 = null)
  };
  first_low_step: LowStepAnchor | null;
  calibration: {
    weights: ChannelWeights;
    low_step_threshold: number;
    late_bias: number;
    caliber_version: string;
  };
}

export interface ScoreOptions {
  weights?: Partial<ChannelWeights>;
  lowStepThreshold?: number;
  lateBias?: number;
}

// ─── W3-8 防御原语(绝不抛) ───

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function r3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** 键排序稳定序列化(journal.ts canonical 同律);环形/BigInt 等病态载荷 ⇒ 哨兵串 */
function safeCanonical(v: unknown): string {
  try {
    const walk = (x: unknown): string => {
      if (x === null || typeof x !== 'object') return JSON.stringify(x) ?? 'null';
      if (Array.isArray(x)) return '[' + x.map(walk).join(',') + ']';
      const rec = x as Record<string, unknown>;
      return '{' + Object.keys(rec).sort()
        .filter(k => rec[k] !== undefined)
        .map(k => JSON.stringify(k) + ':' + walk(rec[k])).join(',') + '}';
    };
    return walk(v);
  } catch {
    return '"#unserializable"'; // 病态载荷降级为常量哨兵(签名仍稳定,只是无区分度)
  }
}

/** args 摘要(人类可读锚定用):截断防长篇 reasoning 反噬 */
function argsSummary(args: unknown): string {
  const s = safeCanonical(args);
  return s.length > 120 ? s.slice(0, 117) + '...' : s;
}

/** 签名域:tool + args 指纹(剔除 reasoning —— 同坐标同工具的重复才叫振荡,
 *  出声思考的变化不应打断签名 run) */
function actionSignature(tool: string, args: unknown): string {
  let domain = args;
  if (isPlainObject(args) && 'reasoning' in args) {
    const { reasoning: _drop, ...rest } = args;
    domain = rest;
  }
  return tool + '|' + safeCanonical(domain);
}

/** 有界数值注入:非有限/越界 ⇒ 缺省(CLI 侧 Number('abc')=NaN 在此就地夹正) */
function numIn(v: unknown, def: number, lo: number, hi: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
}

function strField(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

/** 权重解析:注入值夹到 [0,∞) 后归一化(和≤0 ⇒ 回退默认 —— 全零权重无意义) */
function resolveWeights(pw?: Partial<ChannelWeights>): ChannelWeights {
  const w: ChannelWeights = { ...DEFAULT_CHANNEL_WEIGHTS };
  if (isPlainObject(pw)) {
    for (const k of ['effect', 'intent', 'oscillation', 'wait'] as const) {
      const v = (pw as Record<string, unknown>)[k];
      if (typeof v === 'number' && Number.isFinite(v)) w[k] = Math.max(0, v);
    }
  }
  const sum = w.effect + w.intent + w.oscillation + w.wait;
  if (sum <= 0) return { ...DEFAULT_CHANNEL_WEIGHTS };
  if (Math.abs(sum - 1) > 1e-9) {
    w.effect /= sum; w.intent /= sum; w.oscillation /= sum; w.wait /= sum;
  }
  return w;
}

/** 终局分解析:'success'→1 / fail|error|abort|crash→0 / 其他非空→0.5 / 空→null */
function parseFinalScore(status: string | null): number | null {
  if (!status) return null;
  const s = status.toLowerCase();
  if (s.includes('success')) return 1;
  if (/fail|error|abort|crash/.test(s)) return 0;
  return 0.5; // timeout/cancel 等已知但非二值的状态:中立 0.5(口径诚实,不猜)
}

function fallbackReport(msg: string): ProcessScoreReport {
  return {
    ok: false,
    caliber_version: SCORE_CALIBER_VERSION,
    generated_by: 'W3-8 processScore',
    internal_error: msg,
    totals: {
      lines_total: 0, lines_blank: 0, lines_garbage: 0,
      lines_unscored_tool: 0, action_steps: 0, marker_lines: 0,
    },
    channel_absence: { effect: 0, intent: 0, oscillation: 0, wait: 0 },
    steps: [],
    task: {
      objective: null, step_count: 0, plain_mean: null, weighted_mean: null,
      final_score: null, final_status: null, blended: null,
    },
    first_low_step: null,
    calibration: {
      weights: { ...DEFAULT_CHANNEL_WEIGHTS },
      low_step_threshold: DEFAULT_LOW_STEP_THRESHOLD,
      late_bias: DEFAULT_LATE_BIAS,
      caliber_version: SCORE_CALIBER_VERSION,
    },
  };
}

// ─── W3-8 步评分状态机 ───

interface ScanState {
  lastSignature: string | null;
  lastRun: number;
  noEffectStreak: number;
}

interface Calibration {
  weights: ChannelWeights;
  threshold: number;
  lateBias: number;
}

function resolveCalibration(opts: ScoreOptions = {}): Calibration {
  return {
    weights: resolveWeights(opts.weights),
    threshold: numIn(opts.lowStepThreshold, DEFAULT_LOW_STEP_THRESHOLD, 0, 1),
    lateBias: numIn(opts.lateBias, DEFAULT_LATE_BIAS, 0, 1),
  };
}

/**
 * 单步四通道评分(纯函数;state 为入参快照,调用方持有演进)。
 * 口径:缺席 ⇒ 0.5 中性 + absent 标记(计数归聚合层)。
 */
function stepChannels(
  entry: Record<string, unknown>,
  tool: string,
  args: Record<string, unknown>,
  st: ScanState,
): { channels: ChannelValues; absent: ChannelFlags; evidence: StepEvidence } {
  // ── 证据提取(全部宽容:类型不符 = 缺席)──
  const detected = typeof entry.effect_detected === 'boolean' ? entry.effect_detected : null;
  const scale = typeof entry.scale === 'string' ? entry.scale : null;
  const rawIntent = entry.intent;
  const intentSatisfied = isPlainObject(rawIntent) && typeof rawIntent.satisfied === 'boolean'
    ? rawIntent.satisfied : null;
  const phash = typeof entry.phashCorroborates === 'boolean' ? entry.phashCorroborates : null;
  const thought = typeof entry.thought === 'string' && entry.thought.trim() ? entry.thought : null;
  const observe = typeof entry.observe === 'string' && entry.observe.trim() ? entry.observe : null;

  // ── 通道 1:effect(detected × scale)──
  let effect: number;
  if (detected === null) effect = 0.5;                       // 缺席 = 中性
  else if (!detected) effect = 0;                            // 链上明示无效果(盲点/noop)
  else effect = scale === 'page-level' ? SCALE_VALUE_PAGE
    : scale === 'element-level' ? SCALE_VALUE_ELEMENT
      : SCALE_VALUE_UNKNOWN;                                 // 缺席/'none' 矛盾 ⇒ 中点

  // ── 通道 2:intent(证据阶梯:intent > phash > thought)──
  let intent: number;
  if (intentSatisfied !== null) intent = intentSatisfied ? INTENT_VALUE_SATISFIED : INTENT_VALUE_UNSATISFIED;
  else if (phash !== null) intent = phash ? INTENT_VALUE_PHASH_AGREE : INTENT_VALUE_PHASH_DISSENT;
  else if (thought !== null) intent = INTENT_VALUE_THOUGHT_ONLY;
  else intent = 0.5;                                         // 全缺席 = 中性

  // ── 通道 3:oscillation(连续同签名 run)──
  const signature = actionSignature(tool, args);
  const run = signature === st.lastSignature ? st.lastRun + 1 : 1;
  const oscillation = run === 1 ? 1.0 : run === 2 ? OSC_RUN2 : 0;

  // ── 通道 4:wait(连续无效果 streak;缺席步不累积不清零)──
  let wait: number;
  if (detected === null) wait = 0.5;                         // 无效果信息 = 中性
  else if (detected) { st.noEffectStreak = 0; wait = 1; }
  else {
    st.noEffectStreak += 1;
    wait = Math.max(0, 1 - WAIT_STREAK_DECAY * st.noEffectStreak);
  }

  // 状态演进(签名 run;streak 已在上面就地演进)
  st.lastSignature = signature;
  st.lastRun = run;

  return {
    channels: {
      effect: r3(effect), intent: r3(intent),
      oscillation: r3(oscillation), wait: r3(wait),
    },
    absent: {
      effect: detected === null,
      intent: intentSatisfied === null && phash === null && thought === null,
      oscillation: false,       // 签名由 tool+args 派生,永可得(缺席概念不适用)
      wait: detected === null,
    },
    evidence: {
      ts: typeof entry.ts === 'number' && Number.isFinite(entry.ts) ? entry.ts : null,
      status: strField(entry.status),
      detected, scale,
      intent_satisfied: intentSatisfied,
      phash_corroborates: phash,
      has_thought: thought !== null,
      has_observe: observe !== null,
      signature: signature.length > 60 ? signature.slice(0, 57) + '...' : signature,
      repeat_run: run,
      no_effect_streak: st.noEffectStreak,
    },
  };
}

// ─── W3-8 主评分管线 ───

function scoreParsed(lines: readonly unknown[], cal: Calibration): ProcessScoreReport {
  const st: ScanState = { lastSignature: null, lastRun: 0, noEffectStreak: 0 };
  const steps: StepScore[] = [];
  const absence = { effect: 0, intent: 0, oscillation: 0, wait: 0 };
  let garbage = 0, unscored = 0, markers = 0;
  let objective: string | null = null;
  let finalStatus: string | null = null;

  for (const raw of lines) {
    if (!isPlainObject(raw)) { garbage++; continue; }
    const tool = raw.tool;
    if (typeof tool !== 'string') { garbage++; continue; } // 缺 tool = 垃圾行(计数,不抛)
    const entry = raw;
    const args = isPlainObject(entry.args) ? entry.args : {};

    // 标记行:不入步分;AGENT_END 提供终局分;环境 marker 重置签名 run
    if (MARKER_TOOLS.has(tool) || entry.status === 'MARKER') {
      markers++;
      if (tool === 'AGENT_BEGIN' && objective === null) {
        objective = strField(args.objective)?.slice(0, 200) ?? null; // 首个 = 轨迹头语境
      }
      if (tool === 'AGENT_END') {
        finalStatus = strField(args.status); // 最后一个 AGENT_END 为准(多任务轨迹)
      }
      if (OSC_RESET_MARKERS.has(tool)) { st.lastSignature = null; st.lastRun = 0; }
      continue;
    }

    if (!SCORED_TOOLS.has(tool)) { unscored++; continue; } // 观察类工具无动作语义

    const { channels, absent, evidence } = stepChannels(entry, tool, args, st);
    if (absent.effect) absence.effect++;
    if (absent.intent) absence.intent++;
    if (absent.oscillation) absence.oscillation++;
    if (absent.wait) absence.wait++;
    const score = r3(Math.min(1, Math.max(0,
      cal.weights.effect * channels.effect +
      cal.weights.intent * channels.intent +
      cal.weights.oscillation * channels.oscillation +
      cal.weights.wait * channels.wait,
    )));
    steps.push({
      index: steps.length, tool,
      ts: evidence.ts,
      score, channels, absent,
      args_summary: argsSummary(args),
      evidence,
    });
  }

  // ── 聚合:均值 + PBR 晚期加权 ──
  const n = steps.length;
  let plain: number | null = null;
  let weighted: number | null = null;
  let blended: number | null = null;
  const finalScore = parseFinalScore(finalStatus);
  if (n > 0) {
    plain = r3(steps.reduce((s, x) => s + x.score, 0) / n);
    if (n === 1 || cal.lateBias <= 0) weighted = plain;
    else {
      let sw = 0, sumW = 0;
      for (let i = 0; i < n; i++) {
        const w = (1 - cal.lateBias) + 2 * cal.lateBias * (i / (n - 1));
        sw += w * steps[i].score; sumW += w;
      }
      weighted = r3(sw / sumW);
    }
    if (finalScore !== null && weighted !== null) {
      blended = r3(BLEND_PROCESS * weighted + BLEND_FINAL * finalScore);
    }
  }

  // ── 首低分步锚定(低于阈值的首步 + 前后文) ──
  let firstLow: LowStepAnchor | null = null;
  for (let i = 0; i < n; i++) {
    if (steps[i].score >= cal.threshold) continue;
    const s = steps[i];
    const reasons: string[] = [];
    if (s.evidence.detected === false) reasons.push('detected=false (no visual effect)');
    if (s.evidence.intent_satisfied === false) reasons.push('intent unsatisfied');
    if (s.evidence.repeat_run >= 2) reasons.push(`signature repeat run=${s.evidence.repeat_run}`);
    if (s.evidence.no_effect_streak >= 2) reasons.push(`no-effect streak=${s.evidence.no_effect_streak}`);
    if (reasons.length === 0) reasons.push('below threshold (no single dominant cause)');
    firstLow = {
      index: s.index, score: s.score, threshold: cal.threshold,
      tool: s.tool, args_summary: s.args_summary,
      reasons, channels: s.channels,
      prev: i > 0 ? { index: steps[i - 1].index, tool: steps[i - 1].tool, score: steps[i - 1].score } : null,
      next: i + 1 < n ? { index: steps[i + 1].index, tool: steps[i + 1].tool, score: steps[i + 1].score } : null,
    };
    break;
  }

  return {
    ok: true,
    caliber_version: SCORE_CALIBER_VERSION,
    generated_by: 'W3-8 processScore',
    internal_error: null,
    totals: {
      lines_total: lines.length, lines_blank: 0, lines_garbage: garbage,
      lines_unscored_tool: unscored, action_steps: n, marker_lines: markers,
    },
    channel_absence: absence,
    steps,
    task: {
      objective, step_count: n,
      plain_mean: plain, weighted_mean: weighted,
      final_score: finalScore, final_status: finalStatus, blended,
    },
    first_low_step: firstLow,
    calibration: {
      weights: {
        effect: r3(cal.weights.effect), intent: r3(cal.weights.intent),
        oscillation: r3(cal.weights.oscillation), wait: r3(cal.weights.wait),
      },
      low_step_threshold: cal.threshold,
      late_bias: cal.lateBias,
      caliber_version: SCORE_CALIBER_VERSION,
    },
  };
}

/**
 * W3-8 对象数组入口(已 parse 的 journal 行):评分器 API 面。
 * 病态元素跳过计数;绝不抛(最外层兜底捕获 → ok=false 报告)。
 */
export function scoreJournalLines(lines: readonly unknown[], opts: ScoreOptions = {}): ProcessScoreReport {
  try {
    return scoreParsed(lines, resolveCalibration(opts));
  } catch (e: unknown) {
    return fallbackReport(`internal: ${String((e as { message?: string })?.message ?? e)}`);
  }
}

/**
 * W3-8 主入口:journal JSONL 文本 → 过程评分报告(纯函数,离线确定性)。
 * 垃圾行(非 JSON/非对象/缺 tool)跳过并计数;空轨迹诚实报空;绝不抛。
 */
export function scoreJournalText(text: string, opts: ScoreOptions = {}): ProcessScoreReport {
  try {
    const parsed: unknown[] = [];
    let blank = 0, garbage = 0;
    const lines = typeof text === 'string' ? text.split(/\r?\n/) : [];
    for (const raw of lines) {
      if (!raw || !raw.trim()) { blank++; continue; } // 空白行(尾部换行等)不算垃圾
      try {
        const v = JSON.parse(raw);
        if (isPlainObject(v)) parsed.push(v);
        else garbage++; // number/null/array 等合法 JSON 非行对象
      } catch {
        garbage++;
      }
    }
    const rep = scoreJournalLines(parsed, opts);
    // 文本层的行统计并入(对象入口的 lines_total 只数对象)
    rep.totals.lines_total += blank + garbage;
    rep.totals.lines_blank += blank;
    rep.totals.lines_garbage += garbage;
    return rep;
  } catch (e: unknown) {
    return fallbackReport(`internal: ${String((e as { message?: string })?.message ?? e)}`);
  }
}

/** W3-8 人类可读渲染(CLI stdout;与 telemetry.render 同风格的观测面) */
export function renderProcessScore(rep: ProcessScoreReport): string {
  const t = rep.totals;
  const L: string[] = [
    `[ProcessScore] caliber=${rep.caliber_version} steps=${t.action_steps} lines=${t.lines_total}` +
    ` (blank=${t.lines_blank} garbage=${t.lines_garbage} unscored=${t.lines_unscored_tool} markers=${t.marker_lines})`,
  ];
  if (!rep.ok) {
    L.push(`internal-error: ${rep.internal_error} (defensive fallback — nothing thrown)`);
    return L.join('\n');
  }
  if (rep.task.step_count === 0) {
    L.push('task: EMPTY — no scoreable action steps in trajectory (honest empty report)');
    return L.join('\n');
  }
  const f3 = (x: number | null): string => x === null ? '-' : x.toFixed(3);
  if (rep.task.objective) L.push(`objective: ${rep.task.objective}`);
  L.push(
    `task : plain=${f3(rep.task.plain_mean)} weighted=${f3(rep.task.weighted_mean)}` +
    ` (late_bias=${rep.calibration.late_bias}) final=${f3(rep.task.final_score)}` +
    ` (${rep.task.final_status ?? 'no-end-marker'}) blended=${f3(rep.task.blended)}`,
  );
  const a = rep.channel_absence;
  const n = rep.task.step_count;
  L.push(
    `absent(neutral=0.5): effect=${a.effect}/${n} intent=${a.intent}/${n}` +
    ` oscillation=${a.oscillation}/${n} wait=${a.wait}/${n}`,
  );
  const fl = rep.first_low_step;
  if (fl) {
    L.push(
      `low  : first low step #${fl.index} score=${fl.score.toFixed(3)} < ${fl.threshold}` +
      ` — ${fl.tool} ${fl.args_summary}`,
    );
    L.push(
      `       evidence: ${fl.reasons.join('; ')} | channels(e/i/o/w)=` +
      `${fl.channels.effect}/${fl.channels.intent}/${fl.channels.oscillation}/${fl.channels.wait}`,
    );
    const p = fl.prev ? `#${fl.prev.index} ${fl.prev.tool} ${fl.prev.score.toFixed(3)}` : 'none';
    const nx = fl.next ? `#${fl.next.index} ${fl.next.tool} ${fl.next.score.toFixed(3)}` : 'none';
    L.push(`       context: prev ${p} | next ${nx}`);
  } else {
    L.push(`low  : no step below ${rep.calibration.low_step_threshold}`);
  }
  L.push('steps: ' + rep.steps.map(s => `${s.index}=${s.score.toFixed(3)}`).join(' '));
  return L.join('\n');
}

// ─── W6-5：多任务分段评分（AGENT_BEGIN 边界切分 —— W3-8 遗留「多任务轨迹仅取
//     最后 AGENT_END」的补全）───
//
// 边界语义：每个 AGENT_BEGIN 行开启一个任务段（行本身归入该段 —— objective 由此
// 提取；AGENT_BEGIN 本就是 OSC_RESET_MARKERS，段起点即签名连续性的物理断点，各段
// 独立状态机与此自洽）。首段 BEGIN 之前的散步行（无任务语境的头部）成独立
// 「prologue 段」（objective=null —— 诚实缺席）；空 prologue 不成段。无任何
// BEGIN 边界 ⇒ 单段（与旧口径同一覆盖，只是套了段壳）。
//
// 汇总口径（summary.method 注明，报告自解释）：
//   · weighted_mean（主口径）= Σ(nᵢ·wᵢ)/Σnᵢ —— 段间按步数加权；wᵢ 为段内
//     PBR 晚期加权均值（late_bias 段内独立生效：每任务的「后期步」是它自己的
//     后期，不是整条轨迹的后期 —— 这正是多任务该有的刻度）；
//   · plain_mean（并列口径）= 全步简单均值（Σnᵢ·pᵢ/Σnᵢ，与单任务口径可直接对比）；
//   · final_mean = 非 null 段终局分的均值（无 AGENT_END 的段不计入 —— 缺席
//     不是 0 分，与单任务「终局缺席 = null」同律）；
//   · blended = 0.7×weighted + 0.3×final_mean（两口径齐备才有，否则 null）。
// 旧行为零触碰：scoreJournalText/scoreJournalLines 原样保留（无 BEGIN 边界 =
// 现状；单 BEGIN 也 = 现状 —— 自动切型会破坏既有消费方的返回类型契约，故新
// 能力走独立入口 opt-in）。防御式绝不抛：最外层兜底捕获产出 ok=false 段报告。

/** W6-5：单段报告（每任务一段：过程分 + 终局分 + 首低分步都在段报告里） */
export interface SegmentScoreReport {
  /** 段序号（0-based；prologue 段在前，objective=null） */
  index: number;
  /** 该段 AGENT_BEGIN 的任务目标（prologue 段 = null —— 诚实缺席） */
  objective: string | null;
  /** 段内过程评分报告（与单任务 ProcessScoreReport 同构 —— 每段独立状态机） */
  report: ProcessScoreReport;
}

/** W6-5：多任务分段报告（整体 = 段数组 + 汇总） */
export interface SegmentedScoreReport {
  ok: boolean;
  caliber_version: string;
  generated_by: string;
  internal_error: string | null;
  segment_count: number;
  segments: SegmentScoreReport[];
  summary: {
    /** 汇总口径注明（消费方可复算的锚）：段间步数加权，段内 late-bias */
    method: 'step-weighted';
    total_steps: number;
    plain_mean: number | null;              // 并列口径：全步简单均值
    weighted_mean: number | null;           // 主口径：Σ(nᵢ·wᵢ)/Σnᵢ
    final_scores: Array<number | null>;     // 并列：各段终局分（缺 AGENT_END = null）
    final_mean: number | null;              // 非 null 段终局分均值（缺席段不计入）
    blended: number | null;                 // 0.7×weighted + 0.3×final_mean
  };
  /** 全轨迹行统计（Σ 段 —— 文本入口另并入 blank/garbage 层计数） */
  totals: ProcessScoreReport['totals'];
}

/** W6-5：AGENT_BEGIN 边界切分（纯函数）。BEGIN 行归入其后段；头部散步成
 *  prologue 段（仅当非空）；无 BEGIN ⇒ [全轨迹] 单段。 */
function splitAtAgentBegin(lines: readonly unknown[]): unknown[][] {
  const begins: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (isPlainObject(l) && l.tool === 'AGENT_BEGIN') begins.push(i);
  }
  if (begins.length === 0) return [lines.slice()];
  const segs: unknown[][] = [];
  if (begins[0] > 0) segs.push(lines.slice(0, begins[0])); // prologue 段
  for (let k = 0; k < begins.length; k++) {
    const end = k + 1 < begins.length ? begins[k + 1] : lines.length;
    segs.push(lines.slice(begins[k], end));
  }
  return segs;
}

function emptyTotals(): ProcessScoreReport['totals'] {
  return {
    lines_total: 0, lines_blank: 0, lines_garbage: 0,
    lines_unscored_tool: 0, action_steps: 0, marker_lines: 0,
  };
}

function fallbackSegmented(msg: string): SegmentedScoreReport {
  return {
    ok: false,
    caliber_version: SCORE_CALIBER_VERSION,
    generated_by: 'W6-5 processScore.segments',
    internal_error: msg,
    segment_count: 0,
    segments: [],
    summary: {
      method: 'step-weighted',
      total_steps: 0, plain_mean: null, weighted_mean: null,
      final_scores: [], final_mean: null, blended: null,
    },
    totals: emptyTotals(),
  };
}

/** W6-5：分段核心（已 parse 的行对象）。每段独立调 scoreParsed —— 段内
 *  AGENT_END 取该段最后一个（多 END 段以末为准，与单任务口径同律）。 */
function scoreParsedSegments(lines: readonly unknown[], cal: Calibration): SegmentedScoreReport {
  const totals = emptyTotals();
  const segments: SegmentScoreReport[] = splitAtAgentBegin(lines).map((seg, index) => {
    const rep = scoreParsed(seg, cal);
    totals.lines_total += seg.length;
    totals.lines_blank += rep.totals.lines_blank;
    totals.lines_garbage += rep.totals.lines_garbage;
    totals.lines_unscored_tool += rep.totals.lines_unscored_tool;
    totals.action_steps += rep.totals.action_steps;
    totals.marker_lines += rep.totals.marker_lines;
    return { index, objective: rep.task.objective, report: rep };
  });
  // 汇总：步数加权（段内 late-bias 独立；缺席段按其 null 语义跳过）
  const withSteps = segments.filter(s => s.report.task.step_count > 0);
  const totalSteps = withSteps.reduce((n, s) => n + s.report.task.step_count, 0);
  let plain: number | null = null;
  let weighted: number | null = null;
  if (totalSteps > 0) {
    plain = r3(withSteps.reduce(
      (acc, s) => acc + s.report.task.step_count * (s.report.task.plain_mean ?? 0), 0) / totalSteps);
    weighted = r3(withSteps.reduce(
      (acc, s) => acc + s.report.task.step_count * (s.report.task.weighted_mean ?? 0), 0) / totalSteps);
  }
  const finalScores = segments.map(s => s.report.task.final_score);
  const finals = finalScores.filter((x): x is number => x !== null);
  const finalMean = finals.length > 0 ? r3(finals.reduce((a, b) => a + b, 0) / finals.length) : null;
  const blended = weighted !== null && finalMean !== null
    ? r3(BLEND_PROCESS * weighted + BLEND_FINAL * finalMean)
    : null;
  return {
    ok: true,
    caliber_version: SCORE_CALIBER_VERSION,
    generated_by: 'W6-5 processScore.segments',
    internal_error: null,
    segment_count: segments.length,
    segments,
    summary: {
      method: 'step-weighted',
      total_steps: totalSteps,
      plain_mean: plain,
      weighted_mean: weighted,
      final_scores: finalScores,
      final_mean: finalMean,
      blended,
    },
    totals,
  };
}

/**
 * W6-5：多任务分段入口（对象数组 —— 已 parse 的 journal 行）。
 * AGENT_BEGIN 边界切分为段数组 + 步数加权汇总；绝不抛（兜底 → ok=false）。
 * 旧单任务入口（scoreJournalLines）原样保留 —— 本入口是新能力的 opt-in 面。
 */
export function scoreJournalSegmentsLines(
  lines: readonly unknown[],
  opts: ScoreOptions = {},
): SegmentedScoreReport {
  try {
    const arr = Array.isArray(lines) ? lines : [];
    return scoreParsedSegments(arr, resolveCalibration(opts));
  } catch (e: unknown) {
    return fallbackSegmented(`internal: ${String((e as { message?: string })?.message ?? e)}`);
  }
}

/**
 * W6-5：多任务分段主入口（journal JSONL 文本）。
 * 文本层与 scoreJournalText 同律：空白行不算垃圾、非行对象计垃圾；
 * blank/garbage 计数并入整体 totals（段 totals 只数对象行）。
 */
export function scoreJournalSegmentsText(text: string, opts: ScoreOptions = {}): SegmentedScoreReport {
  try {
    const parsed: unknown[] = [];
    let blank = 0, garbage = 0;
    const lines = typeof text === 'string' ? text.split(/\r?\n/) : [];
    for (const raw of lines) {
      if (!raw || !raw.trim()) { blank++; continue; }
      try {
        const v = JSON.parse(raw);
        if (isPlainObject(v)) parsed.push(v);
        else garbage++;
      } catch {
        garbage++;
      }
    }
    const rep = scoreParsedSegments(parsed, resolveCalibration(opts));
    rep.totals.lines_total += blank + garbage;
    rep.totals.lines_blank += blank;
    rep.totals.lines_garbage += garbage;
    return rep;
  } catch (e: unknown) {
    return fallbackSegmented(`internal: ${String((e as { message?: string })?.message ?? e)}`);
  }
}

/** W6-5：分段报告的人类可读渲染（renderProcessScore 同风格） */
export function renderSegmentedScore(rep: SegmentedScoreReport): string {
  const f3 = (x: number | null): string => x === null ? '-' : x.toFixed(3);
  const L: string[] = [
    `[ProcessScore.segments] caliber=${rep.caliber_version} segments=${rep.segment_count}` +
    ` steps=${rep.summary.total_steps} lines=${rep.totals.lines_total}` +
    ` (blank=${rep.totals.lines_blank} garbage=${rep.totals.lines_garbage}` +
    ` unscored=${rep.totals.lines_unscored_tool} markers=${rep.totals.marker_lines})`,
  ];
  if (!rep.ok) {
    L.push(`internal-error: ${rep.internal_error} (defensive fallback — nothing thrown)`);
    return L.join('\n');
  }
  for (const s of rep.segments) {
    const t = s.report.task;
    L.push(
      `seg#${s.index} : ${s.objective ?? '(no-begin / prologue)'}` +
      ` steps=${t.step_count} plain=${f3(t.plain_mean)} weighted=${f3(t.weighted_mean)}` +
      ` final=${f3(t.final_score)} (${t.final_status ?? 'no-end-marker'})` +
      ` low=${s.report.first_low_step ? `#${s.report.first_low_step.index}@${s.report.first_low_step.score.toFixed(3)}` : 'none'}`,
    );
  }
  const sm = rep.summary;
  L.push(
    `summary: method=${sm.method} (段间步数加权,段内 late_bias)` +
    ` plain=${f3(sm.plain_mean)} weighted=${f3(sm.weighted_mean)}` +
    ` final=[${sm.final_scores.map(f3).join(',')}]→${f3(sm.final_mean)} blended=${f3(sm.blended)}`,
  );
  return L.join('\n');
}
