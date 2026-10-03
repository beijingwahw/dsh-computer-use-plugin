// bench/sprtCore.mjs — W2-3 E3:方差感知 SPRT 回归门(纯统计核心,零 IO,可离线自检)
//
// 设计原则(世界级标准 = 统计诚实):
//   1. FAIL 触发复跑,序贯收口三态:deterministic-pass / flaky(p̂+置信区间) / deterministic-fail;
//   2. 停止规则用 Wald SPRT(似然比序贯检验,Wald 1945;Wald–Wolfowitz 1948 最优性:
//      同等 (α,β) 下期望样本量全类最小 —— 复跑预算敏感场景的教科书选择);
//   3. 边界公式与 src/popupDetector.ts 的 SprtPopupFilter **严格一致**:
//        A = ln((1−β)/α)(接受 H1),B = ln(β/(1−α))(接受 H0,非对称时 ≠ −A)。
//      为何不直接 import 它:popupDetector 的证据模型是弹窗传感似然表
//      (semantic/geometric 帧,P(hit|popup)=0.90 等),非伯努利通过率;且 bench/
//      是纯 Node .mjs 工作台(无 TS register hook),不能加载 src/*.ts —— 按任务
//      指示「在 bench 内实现等价小 SPRT 并注明」,此处即等价实现。
//   4. 假设(模块常量,可注入覆盖):
//        H0: 通过率 p ≤ P0=0.30(回归侧)   H1: 通过率 p ≥ P1=0.80(健康侧)
//      无差别区 (P0,P1) = flaky 领地。P0=0.30 保证单次失败不会立即收口
//      (单失败 LLR = ln(0.2/0.7) ≈ −1.25 > B ≈ −2.94)——复跑通道必须有机会开口。
//
// 三态判定语义(统计诚实是硬约束):
//   deterministic-pass ⇔ 零失败观测。SPRT 对 p=p1<1 的 H1 接受**不能**证明确定性
//     (p̂=0.8 仍是间歇失败)——凡有失败观测,一律不入 deterministic-pass;
//   deterministic-fail ⇔ SPRT 接受 H0(p ≤ P0,第一类错误 α 水准下确信);
//   flaky ⇔ 其余一切:SPRT 接受 H1(高通过率间歇失败,flavor='high-rate')
//     或复跑预算耗尽未收口(无差别区,flavor='indifference-zone');
//     两种 flaky 均附 p̂ 点估 + Wilson 95% 置信区间,绝不吞掉不确定度。
//
// 另含跨版本对比检验(比例差):两比例合并 z 检验(主,任务规格字面要求)+
// 配对 McNemar 精确检验(同任务集跨版本时的诚实补充,免费附赠)。

// ─── 模块常量(α=0.05 类水准;全部可被工厂参数覆盖) ───
export const SPRT_ALPHA = 0.05; // 第一类错误:H0 真时误判 H1 的概率上界
export const SPRT_BETA = 0.05;  // 第二类错误:H1 真时误判 H0 的概率上界
export const SPRT_P0 = 0.30;    // H0:通过率 ≤ P0(deterministic-fail 侧)
export const SPRT_P1 = 0.80;    // H1:通过率 ≥ P1(健康侧)
export const MAX_RERUNS = 5;    // 复跑上限(不含首发)—— 防预算爆炸
export const WILSON_Z = 1.959963984540054; // 95% 置信区间 z 值

const round4 = (x) => Math.round(x * 10000) / 10000;

// ─── Wald SPRT(伯努利通过率版) ───
export class BernoulliSprt {
  constructor({ alpha = SPRT_ALPHA, beta = SPRT_BETA, p0 = SPRT_P0, p1 = SPRT_P1 } = {}) {
    if (!(0 < alpha && alpha < 1) || !(0 < beta && beta < 1)) throw new Error('sprt: alpha/beta 须在 (0,1)');
    if (!(0 < p0 && p0 < p1 && p1 < 1)) throw new Error(`sprt: 需 0<p0<p1<1,得 p0=${p0} p1=${p1}`);
    this.alpha = alpha;
    this.beta = beta;
    this.p0 = p0;
    this.p1 = p1;
    this.reset();
  }

  /** 上界 A = ln((1−β)/α) —— 与 popupDetector.SprtPopupFilter.acceptBound 同式 */
  get acceptBound() { return Math.log((1 - this.beta) / this.alpha); }
  /** 下界 B = ln(β/(1−α)) —— 非对称 (α,β) 下与 −A 不重合(popupDetector P 纪元修过的同一细节) */
  get rejectBound() { return Math.log(this.beta / (1 - this.alpha)); }

  reset() {
    this.llr = 0;
    this.n = 0;
    this.decidedAt = null;
    this.decision = null; // 'H1' | 'H0' | null
  }

  /** 单次运行结果喂入;终判后恒返回原判(SPRT 停止语义,判过即停) */
  update(pass) {
    if (this.decision) return this.state();
    this.llr += pass ? Math.log(this.p1 / this.p0) : Math.log((1 - this.p1) / (1 - this.p0));
    this.n += 1;
    if (this.llr >= this.acceptBound) { this.decision = 'H1'; this.decidedAt = this.n; }
    else if (this.llr <= this.rejectBound) { this.decision = 'H0'; this.decidedAt = this.n; }
    return this.state();
  }

  state() {
    return {
      decision: this.decision,
      logLikelihoodRatio: round4(this.llr),
      runs: this.n,
      decidedAt: this.decidedAt,
      bounds: { accept: round4(this.acceptBound), reject: round4(this.rejectBound) },
      hypotheses: { h0: `p<=${this.p0}`, h1: `p>=${this.p1}`, alpha: this.alpha, beta: this.beta },
    };
  }
}

// ─── 置信区间与检验统计量(纯函数) ───

/** Wilson 得分区间(小样本不塌缩到 [0,0]/[1,1] 的诚实区间) */
export function wilsonCI(k, n, z = WILSON_Z) {
  if (n <= 0) return { low: 0, high: 1, level: 'wilson-95', n, k };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / denom;
  return { low: round4(Math.max(0, center - half)), high: round4(Math.min(1, center + half)), level: 'wilson-95', n, k };
}

/** A&S 7.1.26 有理逼近(|ε|≤1.5e-7)—— 离线正态 CDF,无外部依赖 */
export function erf(x) {
  const s = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return s * y;
}

export function normalCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }

/** 两比例差 z 检验(合并方差,双侧)—— 跨版本通过率对比的主检验 */
export function twoProportionTest(x1, n1, x2, n2) {
  if (n1 <= 0 || n2 <= 0) throw new Error('twoProportionTest: n 须为正');
  const p1 = x1 / n1, p2 = x2 / n2;
  const pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, p: 1, p1Hat: round4(p1), p2Hat: round4(p2), pooledP: round4(pooled), note: 'se=0(双侧全同或全异退化,比例差检验不适用)' };
  const z = (p1 - p2) / se;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { z: round4(z), p: p < 1e-12 ? 0 : round6(p), p1Hat: round4(p1), p2Hat: round4(p2), pooledP: round4(pooled) };
}

const round6 = (x) => Math.round(x * 1e6) / 1e6;

/** McNemar 精确检验(配对二值:同任务集跨版本时的正确检验;二项精确双侧) */
export function mcNemarExact(b, c) {
  const n = b + c;
  if (n === 0) return { b, c, p: 1, note: '无不一致对(所有任务两版本同 verdict)' };
  const k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += binomCoef(n, i);
  tail /= 2 ** n;
  const p = Math.min(1, 2 * tail);
  return { b, c, p: round6(p) };
}

function binomCoef(n, k) {
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

// ─── 回归门控制器(纯逻辑:运行结果注入,复跑调度方执行真实 IO) ───

/**
 * createRegressionGate —— FAIL 触发复跑后的序贯收口器。
 * 用法:
 *   const gate = createRegressionGate();
 *   let st = gate.push(firstRunPassed);        // 首发结果(通常 false,因 FAIL 才触发)
 *   while (st.action === 'continue') {         // 调度方复跑一次,push 新结果
 *     const r = await rerunTask(); st = gate.push(r);
 *   }
 *   const verdict = gate.settle();             // 三态终判 + p̂ + CI + SPRT 轨迹
 */
export function createRegressionGate({ maxReruns = MAX_RERUNS, alpha, beta, p0, p1 } = {}) {
  if (!Number.isInteger(maxReruns) || maxReruns < 1) throw new Error(`gate: maxReruns 须 ≥1,得 ${maxReruns}`);
  const sprt = new BernoulliSprt({ alpha, beta, p0, p1 });
  const runs = [];

  function push(pass) {
    runs.push(!!pass);
    sprt.update(!!pass);
    return status();
  }

  /** 当前应继续复跑还是已收口(预算边界也在此强制 —— 调度方只需服从 action) */
  function status() {
    const failures = runs.filter((r) => !r).length;
    if (runs.length > 0 && failures === 0) return { action: 'settled', verdict: settle() };
    if (sprt.decision) return { action: 'settled', verdict: settle() };
    if (runs.length >= 1 + maxReruns) return { action: 'settled', verdict: settle() };
    return { action: 'continue', sprt: sprt.state(), runsUsed: runs.length, rerunBudgetLeft: maxReruns - (runs.length - 1) };
  }

  /** 终判(幂等;三态语义见模块头注释 —— 统计诚实硬约束) */
  function settle() {
    const n = runs.length;
    const passes = runs.filter(Boolean).length;
    const failures = n - passes;
    const pHat = n === 0 ? null : round4(passes / n);
    const ci = n === 0 ? null : wilsonCI(passes, n);
    const s = sprt.state();
    let verdict, flavor, rationale;
    if (n > 0 && failures === 0) {
      verdict = 'deterministic-pass';
      flavor = 'zero-failure';
      rationale = `零失败观测(${n}/${n} 通过)—— 与 p=1 一致的最强可观测证据;SPRT 无法证明 p=1(H1:p≥${sprt.p1} 只是下界主张),故确定性以观测为准`;
    } else if (s.decision === 'H0') {
      verdict = 'deterministic-fail';
      rationale = `Wald SPRT 接受 H0(p≤${sprt.p0},α=${sprt.alpha}):LLR=${s.logLikelihoodRatio} ≤ B=${s.bounds.reject}(第 ${s.decidedAt} 次运行收口)`;
    } else if (s.decision === 'H1') {
      verdict = 'flaky';
      flavor = 'high-rate';
      rationale = `SPRT 接受 H1(p≥${sprt.p1}:LLR=${s.logLikelihoodRatio} ≥ A=${s.bounds.accept})但存在 ${failures} 次失败观测 —— 高通过率间歇失败,按统计诚实不得判 deterministic-pass`;
    } else {
      verdict = 'flaky';
      flavor = 'indifference-zone';
      rationale = `复跑预算耗尽(${n} 次运行)SPRT 未收口 —— 通过率落在无差别区 [${sprt.p0},${sprt.p1}],以 p̂ + Wilson 95% CI 报告,不假装知道更多`;
    }
    return {
      schema: 'w2bench-gate-verdict/1',
      verdict, flavor, rationale,
      runs: n, passes, failures, pHat, ci,
      sprt: s,
      rerunBudget: { maxReruns, usedReruns: Math.max(0, n - 1) },
    };
  }

  return { push, status, settle, sprtState: () => sprt.state(), runCount: () => runs.length };
}
