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
//
// ΝΩ-39(基准统计功效)追加三件纯函数:
//   · mder(n1,n2,α,power) —— 双比例最小可检差异(正态近似闭式,方差取最保守
//     p(1−p)=1/4,夹 [0,1]):跑之前先回答「这个 suite 尺寸能看见多大的差异」,
//     n<20 时 battery 拒判(样本不足,仅记录);
//   · normalInv —— 正态分位函数(Acklam 有理逼近,|ε|≤1.15e-9),MDER 的 z 值源;
//   · betaTailProb —— 共轭 Beta 后验上尾 P(p>threshold|k/n)(均匀先验
//     Beta(1,1) ⇒ Beta(k+1,n−k+1);logGamma Lanczos + 正则化不完全 Beta 连分式,
//     手写零依赖),flaky 态附 P(p>0.8|data) 一行 —— 点估之外不假装知道更多。

// ─── 模块常量(α=0.05 类水准;全部可被工厂参数覆盖) ───
export const SPRT_ALPHA = 0.05; // 第一类错误:H0 真时误判 H1 的概率上界
export const SPRT_BETA = 0.05;  // 第二类错误:H1 真时误判 H0 的概率上界
export const SPRT_P0 = 0.30;    // H0:通过率 ≤ P0(deterministic-fail 侧)
export const SPRT_P1 = 0.80;    // H1:通过率 ≥ P1(健康侧)
export const MAX_RERUNS = 5;    // 复跑上限(不含首发)—— 防预算爆炸
export const WILSON_Z = 1.959963984540054; // 95% 置信区间 z 值
export const MDER_MIN_N = 20;   // ΝΩ-39:跨版本比例差检验的最小可信样本(任一侧 n<20 ⇒ battery 拒判,仅记录)

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

// ─── ΝΩ-39 基准统计功效(纯函数:正态分位 / MDER / Beta 共轭后验) ───

/** 正态分位函数 Φ⁻¹(p)(Acklam 有理逼近,相对误差 ≤1.15e-9)—— MDER 的 z 值源 */
export function normalInv(p) {
  if (!(0 < p && p < 1)) throw new Error(`normalInv: p 须在开区间 (0,1),得 ${p}`);
  const A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const PLOW = 0.02425, PHIGH = 1 - PLOW;
  let q, r;
  if (p < PLOW) { // 下尾:拒绝域用补对称翻转
    q = Math.sqrt(-2 * Math.log(p));
    return (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  }
  if (p <= PHIGH) { // 中央区:有理逼近
    q = p - 0.5; r = q * q;
    return (((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p)); // 上尾:对称
  return -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
}

/**
 * mder —— 双比例最小可检差异(ΜDER,正态近似闭式):
 *   |p1−p2|_min = (z_{1−α/2} + z_{power}) · sqrt( p̄(1−p̄)·(1/n1 + 1/n2) )
 * 规划期 p̄ 未知 ⇒ 取最保守方差 p̄(1−p̄)=1/4(样本量公式同式反解;双侧 α、
 * 目标功效 power)。结果夹 [0,1](比例差异的值域),4 位小数。
 * 语义:真实差异小于该值的版本对比,本 suite 尺寸大概率检不出 —— 跑之前先知道
 * 自己看不见什么,是统计诚实的前置件(ΝΩ-39)。
 */
export function mder(n1, n2, alpha = 0.05, power = 0.8) {
  if (!Number.isInteger(n1) || !Number.isInteger(n2) || n1 < 1 || n2 < 1) {
    throw new Error(`mder: n1/n2 须为正整数,得 n1=${n1} n2=${n2}`);
  }
  if (!(0 < alpha && alpha < 1)) throw new Error(`mder: alpha 须在 (0,1),得 ${alpha}`);
  if (!(0.5 < power && power < 1)) throw new Error(`mder: power 须在 (0.5,1)(≤0.5 的检验无意义),得 ${power}`);
  const z = normalInv(1 - alpha / 2) + normalInv(power);
  const se = Math.sqrt(0.25 * (1 / n1 + 1 / n2)); // 最保守方差 p(1−p)=1/4
  return round4(Math.min(1, Math.max(0, z * se)));
}

/** Lanczos 近似 logΓ(g=7, 9 系数),相对误差 <1e-13 —— Beta 函数的原料 */
export function logGamma(x) {
  if (!(x > 0)) throw new Error(`logGamma: x 须为正,得 ${x}`);
  const G = 7;
  const C = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x); // 反射公式
  x -= 1;
  let a = C[0];
  const t = x + G + 0.5;
  for (let i = 1; i < G + 2; i++) a += C[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** log B(a,b) = logΓ(a)+logΓ(b)−logΓ(a+b) */
export function logBetaFn(a, b) {
  if (!(a > 0) || !(b > 0)) throw new Error(`logBetaFn: a/b 须为正,得 a=${a} b=${b}`);
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

/** 不完全 Beta 连分式(Numerical Recipes betacf,改进 Lentz 稳定化) */
function betacf(a, b, x) {
  const MAXIT = 300, EPS = 3e-16, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) return h; // 收敛
  }
  return h; // MAXIT 未收敛:返回当前值(调用方结果仍受 round4 约束,且已知值断言守护)
}

/** 正则化不完全 Beta 函数 I_x(a,b)(Beta CDF)—— 纯函数,零依赖 */
export function betaInc(x, a, b) {
  if (!(a > 0) || !(b > 0)) throw new Error(`betaInc: a/b 须为正,得 a=${a} b=${b}`);
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(a * Math.log(x) + b * Math.log1p(-x) - logBetaFn(a, b));
  // 连分式在 x<(a+1)/(a+b+2) 收敛快;否则用对称式 I_x(a,b)=1−I_{1−x}(b,a)
  if (x < (a + 1) / (a + b + 2)) return front * betacf(a, b, x) / a;
  return 1 - front * betacf(b, a, 1 - x) / b;
}

/**
 * betaTailProb —— 共轭 Beta 后验上尾 P(p>threshold | k 过 / n 跑):
 * 均匀先验 Beta(1,1) ⇒ 后验 Beta(k+1, n−k+1)。flaky 态附
 * P(p>0.8|data) 一行:点估 + CI 之外再给一个「健康侧假设的后验质量」读数,
 * 闭式共轭、无 MCMC、无外部依赖(ΝΩ-39)。
 */
export function betaTailProb(threshold, k, n) {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n < 1 || k < 0 || k > n) {
    throw new Error(`betaTailProb: 需 0≤k≤n 的整数,得 k=${k} n=${n}`);
  }
  if (!(0 < threshold && threshold < 1)) throw new Error(`betaTailProb: threshold 须在 (0,1),得 ${threshold}`);
  return round4(1 - betaInc(threshold, k + 1, n - k + 1));
}

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
    // ΝΩ-39:flaky 态附 Beta 共轭后验一行 P(p>p1|data) —— 「健康侧假设的后验质量」,
    // 与 p̂/CI 同源同诚实(均匀先验 Beta(1,1) ⇒ Beta(passes+1, failures+1))
    const posterior = verdict === 'flaky'
      ? {
          threshold: sprt.p1,
          pAbove: betaTailProb(sprt.p1, passes, n),
          note: `P(p>${sprt.p1}|data):均匀先验共轭后验 Beta(${passes + 1},${failures + 1}) 上尾`,
        }
      : undefined;
    return {
      schema: 'w2bench-gate-verdict/1',
      verdict, flavor, rationale,
      runs: n, passes, failures, pHat, ci,
      posterior,
      sprt: s,
      rerunBudget: { maxReruns, usedReruns: Math.max(0, n - 1) },
    };
  }

  return { push, status, settle, sprtState: () => sprt.state(), runCount: () => runs.length };
}
