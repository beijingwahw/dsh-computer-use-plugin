// src/ltlf.ts
// I 纪元（第八维·判决与隐态）：LTLf —— 有限迹时序逻辑的形式验证。
//
// 理论根基（LTL on Finite Traces，De Giacomo & Vardi 2013）：标准 LTL 语义假定
// 无限迹；智能体的行动日志是天然有限迹。LTLf 的算子语义（在长度 n 的迹上）：
//   G φ（always）  ：迹上每一位置 φ 成立
//   F φ（eventually）：存在位置 φ 成立
//   X φ（next）    ：i+1 < n 且 φ(i+1)（强下一 —— 末位无下一，诚实为假）
//   φ U ψ（until） ：∃j≥i: ψ(j) ∧ ∀k∈[i,j): φ(k)
// 这是形式化方法（formal methods）界的验证原语 —— 本模块把它带到行动日志上：
// ReAct 教义（「行动前必观察、行动后必验证」）从提示词里的软约束，升格为
// 可机检的时序性质，违例逐位定位。
//
// 实现形态：组合子 API（非字符串解析器 —— 算子即函数，类型即文法）。
// 永不抛错：空迹上 G 为真（空真）、F/X/U 为假（诚实缺席）。

/** 谓词：迹上第 i 位的真值 */
export type TracePred = (i: number) => boolean;

/** always：全位置成立 */
export function ltlG(p: TracePred, n: number): boolean {
  for (let i = 0; i < n; i++) if (!p(i)) return false;
  return true;
}

/** eventually：存在位置成立 */
export function ltlF(p: TracePred, n: number): boolean {
  for (let i = 0; i < n; i++) if (p(i)) return true;
  return false;
}

/** 强 next：存在下一位置且成立（末位为假 —— 有限迹的诚实语义） */
export function ltlX(p: TracePred, n: number, i = 0): boolean {
  return i + 1 < n && p(i + 1);
}

/** until：∃j≥i ψ(j) ∧ 前段全 φ */
export function ltlU(phi: TracePred, psi: TracePred, n: number, i = 0): boolean {
  for (let j = i; j < n; j++) {
    if (psi(j)) return true;
    if (!phi(j)) return false;
  }
  return false;
}

/**
 * 有界响应（bounded response）：q 发生的每个位置，k 步内必有 p 响应 ——
 * 「行动后 ≤k 步必须验证」这类服务级性质的直接表达。
 */
export function boundedResponse(p: TracePred, q: TracePred, n: number, k: number): boolean {
  for (let i = 0; i < n; i++) {
    if (!q(i)) continue;
    let responded = false;
    for (let j = i + 1; j <= Math.min(i + k, n - 1); j++) {
      if (p(j)) { responded = true; break; }
    }
    if (!responded) return false;
  }
  return true;
}

/** G φ 的违例位清单（判决书的逐位证据） */
export function violationsOf(p: TracePred, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (!p(i)) out.push(i);
  return out;
}

// ─── 行动日志上的 ReAct 形式性质（预铸性质库）───

/** 迹的最小投影：工具名 + 观察在场 + 效果证据 */
export interface TraceEntry {
  tool: string;
  /** 动作前是否携带观察（journal.observe 在场 = 最近有截图锚点） */
  observed?: boolean;
  /** 效果证据：true 验证生效 / false 验证无效 / undefined 未验证 */
  effect?: boolean;
}

export interface TraceProperty {
  id: string;
  /** 性质的 LTLf 表达（人类可读 —— 判决书的事实引用） */
  formula: string;
  description: string;
  /** 违例位置索引（空 = 性质成立） */
  violations: number[];
}

/**
 * ReAct 教义的性质化（纯函数）：三条铁律从提示词升格为可机检判据。
 *   blind-start      ：首动作前无观察 —— G(¬first∨observed) 的对偶违例
 *   observe-starve   ：连续 ≥4 动作无观察 —— 「先看后动」的有界响应缺口
 *   unverified-streak：连续 ≥4 验证无效 —— 盲区连击（效果回击世界而未被听见）
 */
export function reactTraceProperties(entries: readonly TraceEntry[]): TraceProperty[] {
  const n = entries.length;
  const observed = (i: number) => entries[i].observed === true;
  const failed = (i: number) => entries[i].effect === false;

  // blind-start：首个动作缺乏观察
  const blindStart: number[] = n > 0 && !observed(0) ? [0] : [];

  // observe-starve：滑窗找「连续 4 个动作均无观察」的窗口证据位
  const starve: number[] = [];
  for (let i = 0; i + 3 < n; i++) {
    if (!observed(i) && !observed(i + 1) && !observed(i + 2) && !observed(i + 3)) {
      starve.push(i);
    }
  }

  // unverified-streak：连续 4 个 effect===false（验证无效连击）
  const streak: number[] = [];
  for (let i = 0; i + 3 < n; i++) {
    if (failed(i) && failed(i + 1) && failed(i + 2) && failed(i + 3)) {
      streak.push(i);
    }
  }

  return [
    {
      id: 'blind-start',
      formula: 'observed(0)',
      description: 'First action must be preceded by an observation (ReAct: OBSERVE before ACT).',
      violations: blindStart,
    },
    {
      id: 'observe-starvation',
      formula: 'G(¬(¬obs ∧ X ¬obs ∧ XX ¬obs ∧ XXX ¬obs))',
      description: 'No window of 4 consecutive actions without any observation.',
      violations: starve,
    },
    {
      id: 'unverified-streak',
      formula: 'G(¬(fail ∧ X fail ∧ XX fail ∧ XXX fail))',
      description: 'No window of 4 consecutive verified-ineffective actions (blind persistence).',
      violations: streak,
    },
  ];
}
