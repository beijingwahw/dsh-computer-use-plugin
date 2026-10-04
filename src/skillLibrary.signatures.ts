// src/skillLibrary.signatures.ts
// W9-3（D-F4 拆分·检索/签名分区）：自 skillLibrary.ts 低风险提取 —— 技能域类型
// （SkillStep/SkillGene/Skill）+ 签名/哈希/量化纯函数面（OLC 重叠/Beta 可靠度/
// FNV 规范化哈希/G-3 模糊量化）+ 联邦摘要契约（W4-1 SkillDigest/休眠登记）。
// 逐字节搬运（零逻辑变更）；skillLibrary.ts 原位再导出 —— 导入面不变（消费方零改动）。
// 原模块私有面（REPLAYABLE/stepSignature/canonicalStringify/hashArgsFuzzy/hashArgsNumeric）
// 在本文件升为导出（卫星件间供给）；skillLibrary.ts 不再转发它们 —— 公共面零新增。
import type { SparseVector } from './semanticHash';

export interface SkillStep {
  tool: string;
  args: Record<string, any>;
}

/** C-2 基因片段：技能的可拆解单元。普通技能 = 单基因；重组技能 = 多基因链 */
export interface SkillGene {
  steps: SkillStep[];
  /** 该基因执行时的入口场景指纹 */
  entrySceneHash?: string;
  /** 该基因执行完毕后的离场场景指纹（基因链式拼接的依据：A.exit ≈ B.entry ⇒ 可拼接） */
  exitSceneHash?: string;
  /** 溯源：来自哪个母体技能（合成技能的族谱） */
  sourceSkillId?: number;
}

export interface Skill {
  id: number;
  name: string;                 // 短名（自动生成或模型指定）
  description: string;          // 触发描述：什么任务该用这个技能
  entrySceneHash?: string;      // 归纳时的入口场景指纹（同屏加成）
  steps: SkillStep[];
  successCount: number;
  attemptCount: number;
  createdAt: number;
  lastUsedAt: number;
  // ── C-2 概念技能图谱（全部可选：缺省即旧形态，磁盘 JSON 自动兼容） ──
  /** description 的缓存嵌入（induce/restore 时懒计算，匹配微秒级） */
  embedding?: SparseVector;
  /** DNA 分解（普通技能 = 单基因；缺省时按 steps 整体视为单基因） */
  genes?: SkillGene[];
  /** 重组合成标记：合成技能可靠度从谨慎起步（Laplace 先验天然处理） */
  synthesized?: boolean;
  // ── Q 纪元（Q-5 记忆层）：技能系谱（演化谱系 —— 可选字段，旧档自动兼容） ──
  /** 母体技能 id 列表（归纳技能无母体 = 谱系根；合成技能 = 其基因供体） */
  parents?: number[];
  /** 世代（根 = 0；合成 = max(母体世代)+1 —— 谱系深度即组合复杂度） */
  generation?: number;
  // ── Τ 纪元（干预即教育）：示范蒸馏的注记（全部可选：缺省即旧形态，磁盘 JSON 自动兼容） ──
  /** 特权加成净值：approval-consumed 命中 +β / approval-denied 命中 −β。
   *  证据等级注记：用户背书+世界验证（双重证据）> 自动归纳（单重）—— β 只能
   *  来自这两种人机协同事件，自动路径永不写入此字段。match 可靠度项消费之；
   *  缺省（无示范）⇒ 行为逐字节不变。 */
  demoBonus?: number;
  /** 正示范计数（来源注记在册 —— 「谁背书过它」的账本） */
  demoEndorsed?: number;
  /** 用户否决计数（>0 即 denied 标记） */
  demoDenied?: number;
}

/** 可重放的工具白名单：click_element 依赖运行时元素缓存，不进技能 */
export const REPLAYABLE = new Set([
  'click_mouse', 'type_text', 'scroll_page', 'press_hotkey',
  'drag_mouse', 'switch_tab', 'switch_window', 'dismiss_popup',
]);

export const stepSignature = (steps: SkillStep[]): string =>
  steps.map(s => `${s.tool}:${JSON.stringify(s.args)}`).join('|');

// ─── E-2 基因组组装（第五维·信息热力学）：OLC 重叠对齐 ───

/** 单步签名（对齐原子）与序列签名（stepSignature 的切片版） */
const stepSig1 = (s: SkillStep): string => `${s.tool}:${JSON.stringify(s.args)}`;
const stepsSig = (ss: readonly SkillStep[]): string => ss.map(stepSig1).join('|');

/**
 * OLC（Overlap-Layout-Consensus）最长尾头重叠：求 merged 尾部与 next 头部的
 * 最长精确重叠 k（签名逐字节相等），返回 k。合成律：merged + next[k:] ——
 * 共享子序列只保留一份（基因组组装的 contig 缝合：粘性末端对齐后拼接）。
 * 保底约束：k ≤ next.length - 1（新基因必须贡献 ≥1 步新物质 —— 全包含基因
 * 是强化不是合成，走签名撞车路径）。精确匹配语义：确定性、可审计；
 * 模糊对齐（参数近似 + 场景指纹锚定）是留白。导出仅供测试（_forTest 先例）。
 */
export function olcOverlap(merged: readonly SkillStep[], next: readonly SkillStep[]): number {
  const maxK = Math.min(merged.length, next.length - 1);
  for (let k = maxK; k > 0; k--) {
    if (stepsSig(merged.slice(merged.length - k)) === stepsSig(next.slice(0, k))) return k;
  }
  return 0;
}

// ─── E-5 贝叶斯可靠度（Beta-Bernoulli 共轭后验）───

/** 后验可靠度：Beta(1,1) 均匀先验 + (s 胜 n 试) ⇒ Beta(s+1, n-s+1)。
 *  mean = (s+1)/(n+2) —— 与既有 Laplace 平滑逐字一致（零回归的结构保证）；
 *  hw = 1.96√(αβ/((α+β)²(α+β+1))) —— 95% 可信区间半宽，随证据量 n 收缩。
 *  导出纯函数：与 riskGate.matchesRiskPatterns 同律（数学原子的测试面）。 */
export function betaReliability(successCount: number, attemptCount: number): { mean: number; hw: number } {
  const alpha = successCount + 1;
  const beta = attemptCount - successCount + 1;
  const mean = alpha / (alpha + beta);
  const hw = 1.96 * Math.sqrt((alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1)));
  return { mean, hw };
}

/** 递归键排序的稳定字符串化：replacer 数组只在顶层过滤键、嵌套对象的键
 *  会被整层丢弃（JSON.stringify({a:{x:1}}, ['a']) → {"a":{}}）——
 *  drag_mouse 这类嵌套 args 会全部坍缩成同一符号。排序保证键序无关性。 */
export function canonicalStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** F-1 符号化：args → 稳定短哈希（FNV-1a —— semanticHash 同源密码学原语） */
function hashArgs(args: Record<string, any>): string {
  let h = 0x811c9dc5;
  const s = canonicalStringify(args);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// ─── G-3 模糊量化文法归纳（第七维·过程感知）───

/** 量化网格：数值参数按 0.05 网格取整（坐标抖动 <0.025 ⇒ 同符号）。
 *  动机：同一工作流重做时坐标总有微差（0.50 vs 0.52）—— 精确签名下 SEQUITUR
 *  看不见重复。量化等价类让「同一个按钮，稍微偏一点」仍归同一符号。
 *  仅用于 mineMotifs（建议性）；OLC 重组合成（E-2）保持精确 ——
 *  建议可模糊，执行必须精确。 */
const MOTIF_QUANT = 0.05;

/** 深层数值量化（递归；数组与嵌套对象同律）—— 模糊符号化的铸造点 */
function quantizeArgs(v: unknown): unknown {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return Math.round(v / MOTIF_QUANT) * MOTIF_QUANT;
  }
  if (Array.isArray(v)) return v.map(quantizeArgs);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = quantizeArgs((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/** 模糊符号：量化后的 args 哈希（mineMotifs 专用） */
export function hashArgsFuzzy(args: Record<string, any>): string {
  return hashArgs(quantizeArgs(args) as Record<string, any>);
}

// ─── W4-1（G3 契约：策略联邦的结构化对接面） ───
//
// 联邦（同批 W4-2）不 import 本文件内部 —— 它按「结构化契约」对接：
//   · listSkillDigests：本机技能的轻量摘要（不含 steps 明文 —— 摘要是指纹
//     不是剧本：跨节点共享的最小充分统计量）。stepsDigest 每步一个
//     Record<string, number>（键 = 工具名、值 = args 的 FNV-1a 数值哈希 ——
//     hashArgs 同源密码学原语的数值形态）；
//   · addDormantSkill：接收他方休眠技能。休眠 = 不入 match 主池（外来技能
//     未经本机验证 —— 诚实隔离，唤醒是联邦消费方的职权），同 skillId 幂等
//     拒绝，容量驱逐按接收序 FIFO。origin 是溯源账（谁送来的）。

/** W4-1（G3 契约）：技能摘要 —— 联邦交换的最小单元（签名逐字对齐契约） */
export interface SkillDigest {
  skillId: string;
  sceneFingerprint: string;
  stepsDigest: Array<Record<string, number>>;
  reliability: number;
}

/** W4-1：休眠技能登记的入参（摘要 + 溯源） */
export interface DormantSkillInput extends SkillDigest {
  origin: string;
}

/** W4-1：args 的 FNV-1a 数值哈希（hashArgs 的数值形态 —— 摘要的铸造原子） */
export function hashArgsNumeric(args: Record<string, any>): number {
  let h = 0x811c9dc5;
  const s = canonicalStringify(args);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** W4-1：休眠段容量（外来技能的隔离登记区上限 —— FIFO 驱逐） */
export const DORMANT_CAPACITY = 32;
