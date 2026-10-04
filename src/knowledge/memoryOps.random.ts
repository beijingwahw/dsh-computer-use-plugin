// src/knowledge/memoryOps.random.ts
// W6-2（doctor smell.over-engineering 清偿）：自 memoryOps.ts 低风险分区提取
// （>500 行拆分信号）—— 确定性 RNG（xmur3 播种 + mulberry32 流）与 Beta 后验
// 采样（Marsaglia–Tsang Gamma 桥）整体搬迁。纯数学零外部依赖，行为零变化；
// memoryOps.ts 以再导出保持导入面不变。

// ─── W2-6：确定性 RNG（种子流 —— xmur3 播种 + mulberry32 流，重放一致的地基）───

/** RNG 面：() ∈ [0,1)（注入缝 —— 测试与收敛器共用同一确定性契约） */
export type SeededRng = () => number;

/** xmur3 字符串散列播种器（公共域参考实现 —— 种子流的字符串入口语义） */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/** mulberry32（32 位乘法流 —— 确定性、快、周期 2^32 对阈值采样充裕） */
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 种子流铸造：number 直播种，string 经 xmur3 播种 —— 同种子 ⇒ 逐位同流 */
export function seededRng(seed: string | number): SeededRng {
  const s = typeof seed === 'number'
    ? (Number.isFinite(seed) ? Math.floor(Math.abs(seed)) : 0)
    : xmur3(String(seed))();
  return mulberry32(s >>> 0);
}

// ─── W2-6：Beta 后验与采样（统计正确律：Marsaglia–Tsang Gamma 桥）───

/** Beta(s+1, f+1)：均匀先验 Beta(1,1) + s 成 f 败的后验（手算可回验的纯函数） */
export function betaPosterior(successes: number, failures: number): { alpha: number; beta: number } {
  const s = Number.isFinite(successes) && successes > 0 ? successes : 0;
  const f = Number.isFinite(failures) && failures > 0 ? failures : 0;
  return { alpha: s + 1, beta: f + 1 };
}

/** 账本统计 → 后验：stats {n, successRate} ⇒ s = round(n×rate)、f = n−s（整数恢复） */
export function betaPosteriorFromStats(n: number, successRate: number): { alpha: number; beta: number } {
  const N = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  const rate = Number.isFinite(successRate) ? Math.min(1, Math.max(0, successRate)) : 0;
  const s = Math.min(N, Math.round(N * rate));
  return betaPosterior(s, N - s);
}

/** 标准正态（Box–Muller）：坏流（恒 0 / NaN）8 次内不产出 ⇒ 常数回退 —— 不悬挂 */
function standardNormal(rng: SeededRng): number {
  let u = 0;
  for (let i = 0; i < 8; i++) {
    const draw = rng();
    if (Number.isFinite(draw) && draw > 0) { u = draw; break; }
  }
  if (!(u > 0)) u = 0.5; // 坏流回退：有限常数优于无限循环
  let v = rng();
  if (!Number.isFinite(v)) v = 0.5;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Gamma 采样（Marsaglia–Tsang 2000；shape<1 走 Boost 提升）。迭代上限 256 + 均值回退 */
function gammaSample(shape: number, rng: SeededRng): number {
  if (!Number.isFinite(shape) || shape <= 0) return 0; // 域外诚实归零（Beta 桥有后验均值兜底）
  if (shape < 1) {
    const raw = rng();
    const u = Number.isFinite(raw) && raw > 0 ? Math.min(0.999999999999, raw) : 0.5;
    return gammaSample(shape + 1, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 256; i++) {
    const x = standardNormal(rng);
    const base = 1 + c * x;
    if (!(base > 0)) continue; // 拒绝域（含 NaN 流 —— base>0 对 NaN 恒假）
    const v = base * base * base;
    const u = rng();
    if (!Number.isFinite(u)) continue;
    if (u < 1 - 0.0331 * x * x * x * x) return d * v; // 快接受（Marsaglia–Tsang 魔数）
    if (v > 0 && Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v; // 慢接受
  }
  return shape; // 迭代上限回退：分布均值（诚实降级，绝不悬挂）
}

/**
 * Beta(α, β) 采样：g1/(g1+g2) Gamma 桥。退化护栏：和为 0 / 非有限 ⇒ 后验均值
 * α/(α+β) 回退 —— 输出恒有限、恒 ∈ [0,1]（下游插值的定义域结构保证）。
 */
export function betaSample(alpha: number, beta: number, rng: SeededRng): number {
  if (!Number.isFinite(alpha) || !Number.isFinite(beta) || alpha <= 0 || beta <= 0) {
    return 0.5; // 域外：Beta(1,1) 均值（无偏中点）
  }
  const g1 = gammaSample(alpha, rng);
  const g2 = gammaSample(beta, rng);
  const sum = g1 + g2;
  if (!Number.isFinite(sum) || sum <= 0) return alpha / (alpha + beta);
  const v = g1 / sum;
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : alpha / (alpha + beta);
}
