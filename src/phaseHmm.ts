// src/phaseHmm.ts
// I 纪元（第八维·判决与隐态）：离散 HMM 相态透视 —— Baum-Welch + Viterbi 全套。
//
// 理论根基：隐马尔可夫模型的三个经典问题（Rabiner 1989 教程的完全体）：
//   前向-后向（评估/期望）、Baum-Welch（EM 参数学习）、Viterbi（最大后验解码）。
// 行动日志的发射 = 工具名；隐态 = 行为相态（进度/重试/探索/卡死）—— 表层看不见、
// 转移结构里藏着的心智相位。Viterbi 解码把「它现在处于什么相态」从猜测变成推断。
//
// 确定性承诺：EM 从固定结构先验出发（无随机初始化），固定数据 ⇒ 固定参数 ——
// 可复现的科学，不是抽签。诚实边界：EM 只保证局部最优；相态标签是事后语义
// 赋予（按转移结构排序 —— 自转移最高者 = STUCK），标签交换风险由此消解。
// 对数域实现（log-sum-exp）防下溢 —— 长迹数值稳定的工程铁律。

export type PhaseLabel = 'progress' | 'retry' | 'explore' | 'stuck';
export const PHASE_LABELS: PhaseLabel[] = ['progress', 'retry', 'explore', 'stuck'];

export interface PhaseHmmResult {
  /** 当前相态（Viterbi 路径末端） */
  current: PhaseLabel;
  /** 各相态占用率（解码路径上的占比） */
  occupancy: Record<PhaseLabel, number>;
  /** 最长连续卡死段（位） */
  longestStuckRun: number;
  /** EM 每轮对数似然（单调不减 —— Baum-Welch 收敛性的运行时证据） */
  logLikelihoods: number[];
  /** 参与解码的迹长度（<最小迹长 ⇒ null 结果由调用方处理） */
  traceLength: number;
}

const N_STATES = 4;
const MIN_TRACE = 8;
const MAX_ITERS = 40;
const TOL = 1e-4;

/** log-sum-exp（数值稳定的对数域加法） */
function logSumExp(arr: number[]): number {
  const m = Math.max(...arr);
  if (!Number.isFinite(m)) return -Infinity;
  return m + Math.log(arr.reduce((s, x) => s + Math.exp(x - m), 0));
}

/** 结构先验：四个相态的自转移倾向（STUCK > RETRY > PROGRESS > EXPLORE）——
 *  相态的语义先验注入转移矩阵初始化（EM 的确定性起点） */
const SELF_BIAS: Record<PhaseLabel, number> = { stuck: 0.85, retry: 0.70, progress: 0.40, explore: 0.15 };

/**
 * 拟合 + 解码（纯函数，确定性）。tools：行动日志的工具名序列（时间序）。
 * 发射字母表 = 出现频率前 9 的工具 + '⟨unk⟩'（预算纪律 —— 字母表不随迹增长）。
 */
export function fitReactPhases(tools: readonly string[]): PhaseHmmResult | null {
  const T = tools.length;
  if (T < MIN_TRACE) return null;

  // 字母表：频率前 9（并列按名稳定排序 —— 确定性）
  const freq = new Map<string, number>();
  for (const t of tools) freq.set(t, (freq.get(t) ?? 0) + 1);
  const alphabet = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 9)
    .map(e => e[0]);
  const M = alphabet.length + 1; // + ⟨unk⟩
  const obs = tools.map(t => {
    const idx = alphabet.indexOf(t);
    return idx >= 0 ? idx : M - 1;
  });

  // 初始化（确定性）：A = 自转移偏向 + 均匀扩散；B = 均匀 + 微弱领域先验
  let A: number[][] = PHASE_LABELS.map(l => {
    const row = new Array(N_STATES).fill((1 - SELF_BIAS[l]) / (N_STATES - 1));
    row[PHASE_LABELS.indexOf(l)] = SELF_BIAS[l];
    return row;
  });
  // 发射先验：explore 相态偏好切换类工具（switch/hotkey），act 类偏好点击/输入
  let B: number[][] = PHASE_LABELS.map(l => {
    const row = new Array(M).fill(0);
    let total = 0;
    alphabet.forEach((t, j) => {
      let w = 1;
      if (l === 'explore' && /switch|hotkey/.test(t)) w = 3;
      if (l === 'progress' && /click|type/.test(t)) w = 3;
      if (l === 'stuck' && /click/.test(t)) w = 2;
      row[j] = w; total += w;
    });
    row[M - 1] = 1; total += 1;
    return row.map(w => w / total);
  });
  let pi = new Array(N_STATES).fill(1 / N_STATES);

  const lls: number[] = [];
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    // ── 前向（log 域）──
    const logA = A.map(r => r.map(Math.log));
    const logB = B.map(r => r.map(Math.log));
    const alpha: number[][] = Array.from({ length: T }, () => new Array(N_STATES).fill(0));
    for (let s = 0; s < N_STATES; s++) {
      alpha[0][s] = Math.log(pi[s]) + logB[s][obs[0]];
    }
    for (let t = 1; t < T; t++) {
      for (let s = 0; s < N_STATES; s++) {
        alpha[t][s] = logSumExp(
          Array.from({ length: N_STATES }, (_, k) => alpha[t - 1][k] + logA[k][s]),
        ) + logB[s][obs[t]];
      }
    }
    const ll = logSumExp(alpha[T - 1]);
    lls.push(ll);

    // ── 后向（log 域）──
    const beta: number[][] = Array.from({ length: T }, () => new Array(N_STATES).fill(0));
    for (let s = 0; s < N_STATES; s++) beta[T - 1][s] = 0; // log(1)
    for (let t = T - 2; t >= 0; t--) {
      for (let s = 0; s < N_STATES; s++) {
        beta[t][s] = logSumExp(
          Array.from({ length: N_STATES }, (_, k) => logA[s][k] + logB[k][obs[t + 1]] + beta[t + 1][k]),
        );
      }
    }

    // ── E 步：gamma（状态后验）与 xi（转移后验）──
    const gamma: number[][] = Array.from({ length: T }, () => new Array(N_STATES).fill(0));
    const xiSum: number[][] = Array.from({ length: N_STATES }, () => new Array(N_STATES).fill(0));
    for (let t = 0; t < T; t++) {
      const logs = Array.from({ length: N_STATES }, (_, s) => alpha[t][s] + beta[t][s]);
      const norm = logSumExp(logs);
      for (let s = 0; s < N_STATES; s++) gamma[t][s] = Math.exp(logs[s] - norm);
    }
    for (let t = 0; t < T - 1; t++) {
      const logs: number[][] = Array.from({ length: N_STATES }, () => new Array(N_STATES).fill(0));
      for (let i = 0; i < N_STATES; i++) {
        for (let j = 0; j < N_STATES; j++) {
          logs[i][j] = alpha[t][i] + logA[i][j] + logB[j][obs[t + 1]] + beta[t + 1][j];
        }
      }
      const norm = logSumExp(logs.flat());
      for (let i = 0; i < N_STATES; i++) {
        for (let j = 0; j < N_STATES; j++) xiSum[i][j] += Math.exp(logs[i][j] - norm);
      }
    }

    // ── M 步：重估 A / B / pi ──
    const newA = xiSum.map((row, i) => {
      const denom = row.reduce((a, b) => a + b, 0);
      return denom > 0 ? row.map(v => v / denom) : A[i];
    });
    const newB: number[][] = Array.from({ length: N_STATES }, () => new Array(M).fill(0));
    for (let s = 0; s < N_STATES; s++) {
      for (let t = 0; t < T; t++) newB[s][obs[t]] += gamma[t][s];
      const denom = newB[s].reduce((a, b) => a + b, 0);
      for (let j = 0; j < M; j++) newB[s][j] = denom > 0 ? newB[s][j] / denom : B[s][j];
    }
    const newPi = gamma[0].slice();

    // 收敛检查（LL 单调不减是 EM 定理 —— 违反即数值错误）
    const prev = lls[lls.length - 2];
    A = newA; B = newB; pi = newPi;
    if (lls.length >= 2 && ll - prev < TOL && ll - prev >= -1e-9) break;
    if (lls.length >= 2 && ll < prev - 1e-9) break; // 数值防御（理论不可达）
  }

  // ── Viterbi（log 域最大后验路径）──
  const logA = A.map(r => r.map(Math.log));
  const logB = B.map(r => r.map(Math.log));
  const delta: number[][] = Array.from({ length: T }, () => new Array(N_STATES).fill(0));
  const back: number[][] = Array.from({ length: T }, () => new Array(N_STATES).fill(0));
  for (let s = 0; s < N_STATES; s++) delta[0][s] = Math.log(pi[s]) + logB[s][obs[0]];
  for (let t = 1; t < T; t++) {
    for (let s = 0; s < N_STATES; s++) {
      let bestK = 0, bestV = -Infinity;
      for (let k = 0; k < N_STATES; k++) {
        const v = delta[t - 1][k] + logA[k][s];
        if (v > bestV) { bestV = v; bestK = k; }
      }
      delta[t][s] = bestV + logB[s][obs[t]];
      back[t][s] = bestK;
    }
  }
  const path: number[] = new Array(T);
  path[T - 1] = delta[T - 1].indexOf(Math.max(...delta[T - 1]));
  for (let t = T - 2; t >= 0; t--) path[t] = back[t + 1][path[t + 1]];

  // ── 事后语义标签（消解 EM 的标签交换）：自转移降序 = stuck > retry > progress/explore；
  //    progress 与 explore 按发射熵分（探索的发射更分散）── 结构即语义。
  const selfP = A.map((row, i) => row[i]);
  const order = [0, 1, 2, 3].sort((a, b) => selfP[b] - selfP[a]);
  const labelOf: Record<number, PhaseLabel> = {};
  labelOf[order[0]] = 'stuck';
  labelOf[order[1]] = 'retry';
  const ent = (row: number[]): number =>
    -row.reduce((s, p) => s + (p > 0 ? p * Math.log(p) : 0), 0);
  const eA = ent(B[order[2]]), eB = ent(B[order[3]]);
  labelOf[order[2]] = eA >= eB ? 'explore' : 'progress';
  labelOf[order[3]] = eA >= eB ? 'progress' : 'explore';

  const occupancy: Record<PhaseLabel, number> = { progress: 0, retry: 0, explore: 0, stuck: 0 };
  for (const s of path) occupancy[labelOf[s]]++;
  for (const l of PHASE_LABELS) occupancy[l] = Math.round((occupancy[l] / T) * 1000) / 1000;

  let longestStuckRun = 0, run = 0;
  for (const s of path) {
    if (labelOf[s] === 'stuck') { run++; longestStuckRun = Math.max(longestStuckRun, run); }
    else run = 0;
  }

  return {
    current: labelOf[path[T - 1]],
    occupancy,
    longestStuckRun,
    logLikelihoods: lls.map(v => Math.round(v * 1000) / 1000),
    traceLength: T,
  };
}
