// src/skillLibrary.ts
// 第五轮创新之一：自进化技能库（Trajectory -> Skill）。
// 日志记录「做了什么」，重放能「再做一次」，但都缺一块：成功经验不会自动沉淀。
// 本模块把成功轨迹归纳为「技能」—— 带触发描述、入口场景指纹、可靠度统计的宏，
// 持久化到磁盘后跨会话存活：Agent 第一次学会你的工作流，第二次直接复用。
// 可靠度闭环：每次 run_skill 的成败回写 successCount/attemptCount，
// 匹配排序时「历史验证过的技能」天然优先 —— 越用越准的肌肉记忆。
// W3-2（创新提案 M2）：参数化通用技能 —— DTW 对齐 + 参数槽反统一把同骨架
// 字面量技能蒸馏为带洞模板（纯符号、确定性、抗过拟合门），洞由当前世界
// 读取绑定，绑定失败回退字面量技能 —— 见下方「W3-2」段与 distillTemplates。
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'fs';
import path from 'path';
import { journal } from './journal';
import { similarity } from './perceptualHash';
import { tokenize, overlapCoefficient } from './uiMemory';
import { embed, cosine, type SparseVector } from './semanticHash';
import { sequitur, expandSymbols } from './sequitur';
import { kernelRegistry } from './kernel/registry';
import { sanitizeActionShape, type ActionShape, type DemonstrationEvent } from './approval';

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
const REPLAYABLE = new Set([
  'click_mouse', 'type_text', 'scroll_page', 'press_hotkey',
  'drag_mouse', 'switch_tab', 'switch_window', 'dismiss_popup',
]);

const stepSignature = (steps: SkillStep[]): string =>
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
function canonicalStringify(v: unknown): string {
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
function hashArgsFuzzy(args: Record<string, any>): string {
  return hashArgs(quantizeArgs(args) as Record<string, any>);
}

// ─── Τ 纪元（干预即教育）：审批事件的蒸馏面（纯增量 —— 主路径零触碰） ───
//
// 审批事件是现成却全行业被扔掉的监督信号：验收式消费成功 = 用户亲自背书且
// 世界验证成功的动作模式（特权正示范）；用户拒绝 = 这条路用户不让走（负示范）。
// 蒸馏规则：
//   正示范命中既有技能（签名/文本通道）⇒ 可靠度 +β 特权加成（封顶 0.95 ——
//     「用户背书+世界验证」的双重证据等级高于自动归纳）；
//   正示范无匹配 ⇒ 不伪造新技能（诚实 —— 单例不足以成技），仅计数；
//   负示范命中 ⇒ 可靠度 −β 并打 denied 标记；形状入回避注记（LRU 32）——
//     match 时命中回避清单的技能降序（用户不让走的路排后面）。

/** 特权加成 β：双重证据（用户背书+世界验证）的信任增量 */
const DEMO_BETA = 0.15;
/** 示范加成后的可靠度封顶：β 只增信任到 0.95，绝不给「免验收」的满分 */
const DEMO_RELIABILITY_CAP = 0.95;
/** 回避注记容量（LRU） */
const AVOID_CAPACITY = 32;

/** learnFromDemonstration 的判词（透明性：教育发生了什么，一读便知） */
export interface DemonstrationLearning {
  kind: 'approval-consumed' | 'approval-denied';
  /** reinforced：命中技能并 +β / penalized：命中技能并 −β+denied 标记 /
   *  counted-only：无匹配仅计数（不伪造新技能）/ avoidance-only：无匹配技能，
   *  形状仅入回避注记 / no-shape：事件未携带形状（诚实缺席）/
   *  library-disabled：技能库被部署关闭 */
  outcome: 'reinforced' | 'penalized' | 'counted-only' | 'avoidance-only' | 'no-shape' | 'library-disabled';
  skillId?: number;
}

/** 回避注记的形状键：带坐标用 tool@x,y（千分位量化），无坐标用 tool#长度桶 */
const shapeKey = (s: ActionShape): string =>
  typeof s.x === 'number' && typeof s.y === 'number'
    ? `${s.tool}@${s.x.toFixed(3)},${s.y.toFixed(3)}`
    : `${s.tool}#${s.text_length_bucket ?? '*'}`;

// ─── W3-2（创新提案 M2：参数化通用技能 —— 反统一）───
//
// 问题：技能库的一切归纳都停在「字面量」层 —— 同一工作流换个用户名/换个坐标，
// 签名就不同，只能另建一张卡。技能跨任务泛化缺的是反统一（anti-unification，
// ILP 的经典算子）：f(userA) 与 f(userB) 反统一为 f(?X) —— 结构常量保留，
// 变异位开洞。本段实现纯符号反统一（不靠 LLM 写代码、不靠模型猜参数）：
//   · 对齐 —— 共享工具骨架的技能对做 DTW 序列对齐（动作种类为步标签、
//     代价 = 编辑距离风格：同工具 0 / 异工具 1 / 缺口 1），回溯取同源位；
//   · 反统一 —— 同源步按参数槽逐一比对：同值 → 常量；同型异值 → 洞
//     （带类型标注 + 来源提示：OCR 读取 / 坐标 / 剪贴板 / 用户输入）；
//   · 抗过拟合门 —— 模板须 ≥2 母体支撑且每个洞位的跨母体 Beta 后验过门
//     （每个洞位在各母体绑定成功才计证据；门限模块常量）；单母体永不产模板；
//   · 运行时绑定 —— 洞由当前世界读取绑定（注入的 reader 面：OCR/元素跟踪/
//     上下文），绑定失败 ⇒ 模板不适用，回退原字面量技能（零行为损失）。
// 接缝纪律：模板住进库的新存储段（templates）；字面量技能的归纳/匹配/重组/
// 系谱主路径逐字节不变 —— 一切新面都是纯增量。

/** W3-2：洞的类型标注（参数槽的静态类型 —— 运行时绑定的类型闸） */
export type HoleType = 'number' | 'string' | 'boolean' | 'json';

/** W3-2：洞的来源提示（绑定 reader 的读取策略 —— 值应从当前世界哪里读） */
export type HoleSource = 'ocr' | 'coordinate' | 'clipboard' | 'user-input';

/** W3-2：洞槽（同型异值的反统一产物 —— 母体实值是对齐证据，绑定账本是审计面） */
export interface TemplateHoleSlot {
  kind: 'hole';
  type: HoleType;
  source: HoleSource;
  /** 洞位在各母体的实值（对齐证据 —— 蒸馏时点的跨母体观测，封顶 8 条防膨胀） */
  bindings: Array<{ skillId: number; value: unknown }>;
  /** 跨母体 Beta 后验均值（蒸馏门数值的审计面：(s+1)/(s+f+2)） */
  posteriorMean: number;
  /** 运行时绑定账本（绑定失败也计数 —— 洞可靠度的世界证据） */
  bindAttempts: number;
  bindSuccesses: number;
}

/** W3-2：模板参数槽 = 常量（各母体同值）| 洞（同型异值） */
export type TemplateSlot = { kind: 'const'; value: unknown } | TemplateHoleSlot;

/** W3-2：模板步骤（args 键序 = 母体键的字典序 —— 确定性序列化） */
export interface TemplateStep {
  tool: string;
  args: Record<string, TemplateSlot>;
}

/** W3-2：参数化模板（技能的泛化形态 —— 库新存储段的居民） */
export interface SkillTemplate {
  id: number;
  name: string;                 // tpl-N（独立发号器，与字面量技能 id 空间隔离）
  description: string;          // 蒸馏种对的描述并置（人读审计面）
  /** 工具骨架哈希（运行时匹配的粗筛键 —— hashSkeleton） */
  skeletonHash: string;
  entrySceneHash?: string;      // 种对首母体的入口指纹（场景同屏加成，match 同律）
  steps: TemplateStep[];
  /** 支撑母体（跨母体过门后仍在册的技能 id —— ≥ TEMPLATE_MIN_PARENTS） */
  parents: number[];
  /** 世代 = max(母体世代)+1（Q-5 系谱同律 —— 模板是字面量技能的后代） */
  generation: number;
  /** 洞总数（审计面） */
  holes: number;
  successCount: number;
  attemptCount: number;
  createdAt: number;
  lastUsedAt: number;
  /** 蒸馏审计：对齐代价 / 归一代价 / 同源步数 / 弃置步数（白盒可回放） */
  alignment: { cost: number; costRatio: number; homologs: number; droppedSteps: number };
}

// ─── W3-2：抗过拟合门限（模块常量 —— 一切数值在此审计，绝无内联魔数） ───

/** 模板最低母体数：单母体永不产模板（结构前提 —— 一例观测不成规律） */
export const TEMPLATE_MIN_PARENTS = 2;
/** 最低同源步数：短于 2 步的模板不构成「技能」（与 motif minLength 同律） */
export const TEMPLATE_MIN_HOMOLOGS = 2;
/** DTW 对齐归一代价上限（cost / max(lenA,lenB)）：骨架差太远的对不参加反统一 */
export const TEMPLATE_MAX_ALIGN_COST_RATIO = 0.35;
/** 洞位跨母体 Beta 后验门：mean = (s+1)/(s+f+2) ≥ 0.75 ⇔ s ≥ 3f+2
 *  （f=0 时 s≥2 —— 与最低母体数自洽；一个反证母体即要求 5 个支撑母体） */
export const TEMPLATE_HOLE_POSTERIOR_GATE = 0.75;
/** 模板容量（可靠度×新近度驱逐，与技能容量驱逐同律） */
export const TEMPLATE_CAPACITY = 16;
/** 蒸馏预算护栏：参加配对的技能数上限（O(N²) 配对 × O(nm) DTW 的诚实上限） */
export const TEMPLATE_MAX_SKILLS = 64;

/** W3-2：工具骨架哈希（FNV-1a，hashArgs 同源密码学原语 —— 匹配粗筛键） */
export function hashSkeleton(tools: readonly string[]): string {
  let h = 0x811c9dc5;
  const s = tools.join('\u0001');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** W3-2：单步对齐代价（编辑距离风格）：同工具 0 / 异工具 1（缺口代价同 1） */
const alignStepCost = (toolA: string, toolB: string): number => (toolA === toolB ? 0 : 1);

/**
 * W3-2：DTW 序列对齐（纯符号、确定性）。步标签 = 动作种类（tool 名），
 * dp[i][j] = 对齐 a[0..i) 与 b[0..j) 的最小总代价；回溯取对齐路径，
 * 平局裁决固定 diag > up > left（确定性铁律 —— 同输入逐位同路径）。
 * 返回 pairs：已对齐位 [i, j]（j=-1 / i=-1 为缺口列），cost 为总代价。
 * 导出纯函数：与 olcOverlap / betaReliability 同律（数学原子的测试面）。
 */
export function dtwAlignTools(a: readonly string[], b: readonly string[]):
  { pairs: Array<[number, number]>; cost: number } {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(Infinity));
  dp[0][0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (i === 0 && j === 0) continue;
      let best = Infinity;
      if (i > 0 && j > 0) best = Math.min(best, dp[i - 1][j - 1] + alignStepCost(a[i - 1], b[j - 1]));
      if (i > 0) best = Math.min(best, dp[i - 1][j] + 1); // 缺口（b 侧插入）
      if (j > 0) best = Math.min(best, dp[i][j - 1] + 1); // 缺口（a 侧插入）
      dp[i][j] = best;
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + alignStepCost(a[i - 1], b[j - 1])) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      pairs.push([i - 1, -1]);
      i--;
    } else if (j > 0 && dp[i][j] === dp[i][j - 1] + 1) {
      pairs.push([-1, j - 1]);
      j--;
    } else {
      break; // 防御带（dp 构造保证不可达）
    }
  }
  pairs.reverse();
  return { pairs, cost: dp[n][m] };
}

/** W3-2：值的洞类型标注（number 须有限 —— NaN/Infinity 归 json 由绑定闸拒绝） */
export function holeTypeOf(v: unknown): HoleType {
  if (typeof v === 'number') return Number.isFinite(v) ? 'number' : 'json';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'boolean';
  return 'json';
}

/** W3-2：来源提示的键形判据（确定性正则 —— 绝无模型猜测） */
const HOLE_COORD_KEY = /(^|_)(x|y|dx|dy)(_|$|\d)/i;   // x / y / from_x / to_y2 …
const HOLE_CLIP_KEY = /(url|link|site|domain|address|href|path)/i; // 长串惯走粘贴
const HOLE_TEXT_KEY = /(text|content|desc|query|search|keyword|message|prompt|title|label|value|input|answer|reply)/i;

/**
 * W3-2：洞的来源提示推断（纯函数，键形 + 类型 → 读取策略）：
 * 数值且坐标形键 → coordinate；字符串且 URL 形键 → clipboard；
 * 字符串且文本形键 → ocr（屏上读到的值）；其余 → user-input（问用户/任务上下文）。
 * 提示是给绑定 reader 的路由建议，不是断言 —— 绑定失败回退字面量技能。
 */
export function inferHoleSource(key: string, type: HoleType): HoleSource {
  if (type === 'number' && HOLE_COORD_KEY.test(key)) return 'coordinate';
  if (type === 'string' && HOLE_CLIP_KEY.test(key)) return 'clipboard';
  if (type === 'string' && HOLE_TEXT_KEY.test(key)) return 'ocr';
  return 'user-input';
}

/** W3-2：绑定值的类型闸（洞类型 ↔ 运行时值的守卫 —— 类型不符即绑定失败） */
export function valueMatchesHoleType(v: unknown, type: HoleType): boolean {
  switch (type) {
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'string': return typeof v === 'string';
    case 'boolean': return typeof v === 'boolean';
    case 'json': return v !== null && typeof v === 'object';
  }
}

/** W3-2：反统一产物（种对级 —— 跨母体证据扫之前的候选） */
export type AntiUnifyOutcome =
  | {
    ok: true;
    steps: TemplateStep[];
    holes: number;
    alignment: { cost: number; costRatio: number; homologs: number; droppedSteps: number };
  }
  | {
    ok: false;
    reason: 'align-cost' | 'insufficient-homologs' | 'structure-divergent' | 'no-holes' | 'too-few-steps';
    detail: string;
    alignment: { cost: number; costRatio: number; homologs: number; droppedSteps: number };
  };

/**
 * W3-2：DTW 对齐 + 参数槽反统一（纯函数，手算可回验）。
 * 步骤：① 工具骨架 DTW（归一代价过门）；② 同源步（同工具对齐位）逐槽比对 ——
 * 同值 → 常量槽、同型异值 → 洞槽（类型 + 来源提示 + 双母体实值绑定）；
 * 键集不一致或异型 ⇒ 该步结构分歧，弃置（保守：结构不稳的步不泛化）；
 * ③ 全常量（零洞）⇒ 拒绝 —— 那是字面量重复，不是泛化；④ 弃置后步数
 * < TEMPLATE_MIN_HOMOLOGS ⇒ 拒绝。洞槽的 posteriorMean 此处记 NaN 占位，
 * 由调用方（distillTemplates 的跨母体证据扫）回填真值。
 */
export function antiUnifyPair(
  a: { id: number; steps: readonly SkillStep[] },
  b: { id: number; steps: readonly SkillStep[] },
): AntiUnifyOutcome {
  const { pairs, cost } = dtwAlignTools(a.steps.map(s => s.tool), b.steps.map(s => s.tool));
  const maxLen = Math.max(1, Math.max(a.steps.length, b.steps.length));
  const costRatio = cost / maxLen;
  const homologPairs = pairs.filter(([i, j]) => i >= 0 && j >= 0 && a.steps[i].tool === b.steps[j].tool);
  const alignment = { cost, costRatio: Math.round(costRatio * 1000) / 1000, homologs: homologPairs.length, droppedSteps: 0 };
  if (costRatio > TEMPLATE_MAX_ALIGN_COST_RATIO) {
    return { ok: false, reason: 'align-cost', detail: `costRatio=${alignment.costRatio}`, alignment };
  }
  if (homologPairs.length < TEMPLATE_MIN_HOMOLOGS) {
    return { ok: false, reason: 'insufficient-homologs', detail: `homologs=${homologPairs.length}`, alignment };
  }
  const steps: TemplateStep[] = [];
  let holes = 0;
  for (const [i, j] of homologPairs) {
    const sa = a.steps[i];
    const sb = b.steps[j];
    const keysA = Object.keys(sa.args ?? {}).sort();
    const keysB = Object.keys(sb.args ?? {}).sort();
    if (JSON.stringify(keysA) !== JSON.stringify(keysB)) {
      alignment.droppedSteps++; // 键集分歧：参数结构不稳，该步不泛化（保守）
      continue;
    }
    const args: Record<string, TemplateSlot> = {};
    let divergent = false;
    for (const k of keysA) {
      const va = sa.args[k];
      const vb = sb.args[k];
      if (canonicalStringify(va) === canonicalStringify(vb)) {
        args[k] = { kind: 'const', value: va }; // 同值 → 常量
        continue;
      }
      const ta = holeTypeOf(va);
      const tb = holeTypeOf(vb);
      if (ta !== tb || ta === 'json') {
        divergent = true; // 异型（或双方皆非基元）⇒ 反统一非法 —— 弃置该步
        break;
      }
      args[k] = {
        kind: 'hole', type: ta, source: inferHoleSource(k, ta),
        bindings: [{ skillId: a.id, value: va }, { skillId: b.id, value: vb }],
        posteriorMean: Number.NaN, // 占位：跨母体证据扫回填（见 distillTemplates）
        bindAttempts: 0, bindSuccesses: 0,
      };
      holes++;
    }
    if (divergent) {
      alignment.droppedSteps++;
      continue;
    }
    steps.push({ tool: sa.tool, args });
  }
  if (holes === 0) {
    return { ok: false, reason: 'no-holes', detail: 'args 全同值 —— 字面量重复，非泛化', alignment };
  }
  if (steps.length < TEMPLATE_MIN_HOMOLOGS) {
    return { ok: false, reason: 'too-few-steps', detail: `steps=${steps.length}`, alignment };
  }
  return { ok: true, steps, holes, alignment };
}

// ─── W3-2：运行时绑定的注入面（世界读取 —— OCR/元素跟踪/上下文的宿主接线） ───

/** W3-2：洞绑定请求（reader 的入参 —— 路由所需的全部静态信息） */
export interface HoleBindingRequest {
  templateId: number;
  stepIndex: number;
  key: string;
  tool: string;
  type: HoleType;
  source: HoleSource;
}

/** W3-2：洞读取器（注入缝 —— 生产由宿主接 OCR/元素跟踪/上下文，测试传纯函数） */
export type TemplateHoleReader = (req: HoleBindingRequest) => unknown;

/** W3-2：绑定判词（失败 ⇒ 模板不适用 —— 回退字面量技能，零行为损失） */
export type TemplateBindResult =
  | { ok: true; templateId: number; steps: SkillStep[] }
  | {
    ok: false;
    templateId?: number;
    reason: 'library-disabled' | 'not-found' | 'hole-read-failed' | 'hole-type-mismatch';
    failed?: { stepIndex: number; key: string; source: HoleSource };
  };

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
function hashArgsNumeric(args: Record<string, any>): number {
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

class SkillLibrary {
  private skills: Skill[] = [];
  private nextId = 1;
  private enabled = true;
  private filePath = '';
  private capacity = 50;
  private nextSynthId = 1;        // C-2：合成技能发号器（syn-N 命名，跨会话不冲突）
  // ── Τ 纪元（干预即教育）：蒸馏簿记（内存态 —— 回避注记是会话级轻量清单） ──
  private avoidShapes: ActionShape[] = []; // 回避注记（LRU，容量 AVOID_CAPACITY）
  private demoUnmatched = 0;                // 无匹配正示范的诚实计数（单例不成技）
  // ── W3-2（M2 参数化通用技能）：模板存储段（新居民 —— 字面量技能主路径零触碰） ──
  private templates: SkillTemplate[] = [];
  private nextTemplateId = 1;               // tpl-N 发号器（独立号段，跨会话不冲突）
  // ── W4-1（G3 契约）：休眠技能段（联邦对接口 —— 隔离登记区，不入 match 主池） ──
  private dormant: Array<DormantSkillInput & { receivedAt: number }> = [];

  configure(enabled: boolean, filePath: string, capacity = 50): void {
    this.enabled = enabled;
    this.filePath = filePath;
    this.capacity = capacity;
  }

  /** 从磁盘载入（跨会话学习的关键）。文件损坏/不存在 ⇒ 从空库开始，不致命 */
  load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(data.skills)) {
        this.skills = data.skills;
        // J 纪元修正（nextId 撞号）：历史档案经历过容量驱逐后 ids 稀疏，
        // `length + 1` 可能小于 max(id)+1 ⇒ 新技能撞旧 id。取两者最大值。
        const maxId = this.skills.reduce((m, s) => Math.max(m, Number(s.id) || 0), 0);
        this.nextId = Math.max(data.nextId ?? 0, maxId + 1);
        this.nextSynthId = data.nextSynthId ?? this.nextSynthId;
        // W3-2：模板段载入（旧档无此键 ⇒ 空段 —— 磁盘 JSON 自动兼容）
        if (Array.isArray(data.templates)) {
          this.templates = data.templates;
          const maxTid = this.templates.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
          this.nextTemplateId = Math.max(data.nextTemplateId ?? 1, maxTid + 1);
        }
        // W4-1：休眠段载入（联邦登记的持久形态；旧档无此键 ⇒ 空段）
        if (Array.isArray(data.dormant)) {
          this.dormant = data.dormant.filter(
            (d: any) => d && typeof d.skillId === 'string' && Array.isArray(d.stepsDigest),
          );
        }
      }
      console.log(`[Skill] Loaded ${this.skills.length} skill(s) from ${this.filePath}`);
    } catch (e: any) {
      console.warn(`[Skill] Load failed (${e.message}); starting with empty library.`);
    }
  }

  /**
   * C-2 原子落盘（工程约束兑现）：tmp + rename —— 合成过程中崩溃 ⇒ 磁盘永远是完整旧库。
   * 与 checkpoint.ts 的 saveCheckpoint 同一原子写律。
   */
  save(): void {
    if (!this.filePath) return;
    const tmp = this.filePath + '.tmp';
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileSync(tmp, JSON.stringify({
        skills: this.skills, nextId: this.nextId, nextSynthId: this.nextSynthId,
        // W3-2：模板段（追加键 —— 旧读方按 skills/nextId 消费不受影响）
        templates: this.templates, nextTemplateId: this.nextTemplateId,
        // W4-1：休眠段（追加键 —— 联邦登记的落盘形态）
        dormant: this.dormant,
      }, null, 2), 'utf8');
      renameSync(tmp, this.filePath); // 原子换名：要么完整旧档，要么完整新档，绝无半档
    } catch (e: any) {
      try { unlinkSync(tmp); } catch { /* tmp 可能未创建 */ }
      console.warn(`[Skill] Save failed: ${e.message}`);
    }
  }

  /** 插件卸载：仅清内存，磁盘保留 —— 技能的寿命长于会话。
   *  Τ 纪元：蒸馏簿记（回避注记+无匹配计数）随库归零 —— 隔离缝不漏全局态。 */
  reset(): void {
    this.skills = [];
    this.avoidShapes = [];
    this.demoUnmatched = 0;
    // W3-2：模板簿记随库归零（磁盘保留 —— 模板的寿命长于会话，同技能律）
    this.templates = [];
    this.nextTemplateId = 1;
    // W4-1：休眠段随库归零（磁盘保留 —— 联邦登记的寿命长于会话，同律）
    this.dormant = [];
  }

  /**
   * 归纳技能。签名去重：完全相同的步骤序列不重复建卡，只 bump 可靠度 ——
   * 同一工作流做三遍 = 一个技能验证三次，而非三张卡。
   * C-2：归纳时缓存语义嵌入 + 默认单基因化（steps 整体为一个 DNA 片段）。
   */
  induce(description: string, steps: SkillStep[], entrySceneHash?: string, exitSceneHash?: string): Skill | null {
    if (!this.enabled || steps.length === 0) return null;
    const sig = stepSignature(steps);
    const existing = this.skills.find(s => stepSignature(s.steps) === sig);
    if (existing) {
      existing.attemptCount++;
      existing.successCount++;
      existing.lastUsedAt = Date.now();
      existing.description = description || existing.description;
      this.save();
      return existing;
    }

    const skill: Skill = {
      id: this.nextId++,
      name: `skill-${this.nextId - 1}`,
      description,
      entrySceneHash,
      steps,
      successCount: 1,
      attemptCount: 1,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      // C-2：嵌入缓存 + 单基因（整个轨迹一个片段；未来可按场景断点细拆）
      embedding: embed(description || sig),
      genes: [{ steps, entrySceneHash, exitSceneHash }],
    };
    this.skills.push(skill);

    // 容量驱逐：可靠度 × 新近度 × 系谱存续 综合最低者出局
    // Q 纪元（Q-5）：灭绝剪枝感知 —— 是活跃谱系祖先的技能获得存续加成
    //（×1.5：其基因仍在后代中表达 = 谱系信息未死）；孤儿技能按原律竞争。
    if (this.skills.length > this.capacity) {
      const now = Date.now();
      const hasDescendant = new Set<number>();
      for (const sk of this.skills) {
        for (const pid of sk.parents ?? []) hasDescendant.add(pid);
      }
      const survival = (x: Skill): number =>
        ((x.successCount / x.attemptCount) * Math.exp(-(now - x.lastUsedAt) / 7_200_000)) *
        (hasDescendant.has(x.id) ? 1.5 : 1);
      this.skills.sort((a, b) => survival(b) - survival(a));
      this.skills = this.skills.slice(0, this.capacity);
    }
    this.save();
    return skill;
  }

  /** 从日志归纳：取最近一次 markTaskStart 之后的可重放动作 */
  induceFromJournal(description: string, entrySceneHash?: string): Skill | null {
    const steps = journal.sinceTaskStart()
      .filter(e => REPLAYABLE.has(e.tool))
      .map(e => ({ tool: e.tool, args: e.args ?? {} }));
    return this.induce(description, steps, entrySceneHash);
  }

  /**
   * F-1 文法归纳动机挖掘（压缩即学习）：对行动日志跑 SEQUITUR 文法归纳，
   * 重复 ≥minUsage 次的规则（子序列）即「行为中重复着自己却未被固化的技能」。
   * 与 induceFromJournal 的分工：后者只切任务边界内的整段轨迹；本方法发现
   * 跨任务重复的子序列动机（MDL：能被短文法压缩的部分就是结构）。
   * 消费方：match_skill 落空时提示「日志里已重复 N 次的序列可 save_skill 固化」。
   * 预算：maxSteps 上限（O(n²) 批处理文法归纳的诚实护栏）；零重复 ⇒ 空数组。
   */
  mineMotifs(minUsage = 2, minLength = 2, maxMotifs = 3, maxSteps = 400):
    Array<{ steps: SkillStep[]; usage: number; motifLength: number }> {
    if (!this.enabled) return [];
    const entries = journal.list(true).slice(-maxSteps);
    if (entries.length < minLength * minUsage) return [];
    // 符号化：G-3 模糊量化（tool#fnv(quantized-args)）—— 坐标抖动 <0.025 归同符号；
    // 同一工作流重做时总有微差，精确签名会漏掉全部重复（量化等价类 = 抖动容忍）
    const dict = new Map<string, SkillStep>();
    const seq: string[] = [];
    for (const e of entries) {
      const sym = `${e.tool}#${hashArgsFuzzy(e.args ?? {})}`;
      if (!dict.has(sym)) dict.set(sym, { tool: e.tool, args: e.args ?? {} });
      seq.push(sym);
    }
    const grammar = sequitur(seq);
    const motifs: Array<{ steps: SkillStep[]; usage: number; motifLength: number }> = [];
    for (const rule of grammar.rules.values()) {
      if (rule.usage < minUsage || rule.expandedLength < minLength) continue;
      // 解码：规则体展开回叶符号 → 步骤序列
      const syms = expandSymbols(grammar, rule.symbols);
      const steps = syms.map(s => dict.get(s)).filter((x): x is SkillStep => x !== undefined);
      if (steps.length === syms.length && steps.length >= minLength) {
        motifs.push({ steps, usage: rule.usage, motifLength: steps.length });
      }
    }
    // 最长且最常重复的动机优先（信息量 = 长度 × 重复度的乘积排序）
    return motifs
      .sort((x, y) => (y.motifLength * y.usage) - (x.motifLength * x.usage))
      .slice(0, maxMotifs);
  }

  /**
   * 匹配：文本重合 + 可靠度 + 入口场景同屏加成 + 新近度。
   * C-2 语义泛化：文本项取 max(overlap, semanticCosine) ——
   *   精确匹配零回归（overlap 主导）；「整理数据」经向量命中「筛选数据」（零样本泛化）。
   */
  match(query: string, currentSceneHash?: string, k = 3): Array<Skill & { score: number }> {
    const q = tokenize(query);
    const qVec = embed(query);
    const now = Date.now();
    // 纪元 Θ（Θ-4 生产接线）：入口场景同屏判据读内核注册表 ——
    //   skill.sceneGate（指纹相似门，缺省 0.9）/ skill.sceneBonus（同屏加成，缺省 0.3）
    // 未注册 ⇒ getOrDefault 回声字面量，排序行为逐字节不变；每次 match 单次读取。
    const sceneGate = kernelRegistry.getOrDefault('skill.sceneGate', 0.9);
    const sceneBonus = kernelRegistry.getOrDefault('skill.sceneBonus', 0.3);
    // 纪元 Ξ（Ξ-D 生产接线）：评分四常量同律入表 —— skill.scoreFloor（入选
    // 地板，缺省 0.15）/ skill.reliabilityWeight（可靠度权重，缺省 0.3）/
    // skill.ciDiscount（CI 不确定度折扣，缺省 0.1）/ skill.recencyHalfLifeH
    //（新近度半衰期，缺省 72h，区间 1..720）。未注册 ⇒ 回声字面量，零行为变化。
    const scoreFloor = kernelRegistry.getOrDefault('skill.scoreFloor', 0.15);
    const reliabilityWeight = kernelRegistry.getOrDefault('skill.reliabilityWeight', 0.3);
    const ciDiscount = kernelRegistry.getOrDefault('skill.ciDiscount', 0.1);
    const recencyHalfLifeH = Math.max(1, kernelRegistry.getOrDefault('skill.recencyHalfLifeH', 72));
    const scored = this.skills
      .map(s => {
        const overlap = overlapCoefficient(q, tokenize(s.description));
        // 懒嵌入：旧档技能无 embedding 时现场补算（restore 后首次匹配付一次微秒级成本）
        const vec = s.embedding ?? embed(s.description || stepSignature(s.steps));
        if (!s.embedding) s.embedding = vec;
        const semantic = cosine(qVec, vec);
        const text = Math.max(overlap, semantic);
        // E-5 贝叶斯可靠度：Beta(1,1) 后验均值（= Laplace 平滑，逐字一致 —— 零回归）
        // − 0.1 × 95% CI 半宽（不确定度折扣：同均值下证据多者胜 —— 「8/12 的老技能」
        // 排在「0/0 的新直觉」之前，因为后者可能只是运气）。0.1 是算法形状字面量：
        // 折扣只做同均值平票的裁决者，绝不做主排序信号。（Ξ-D 起 0.1/0.3/72 读内核表。）
        const post = betaReliability(s.successCount, s.attemptCount);
        // Τ 纪元（干预即教育）：示范背书 —— demoBonus 缺省 0 ⇒ effMean === post.mean
        // 逐字节不变；正加成封顶 0.95（β 只增信任，绝不给免验收的满分）；负加成
        //（用户否决）如实下压。证据等级：用户背书+世界验证（双重）> 自动归纳（单重）。
        const demoBonus = s.demoBonus ?? 0;
        const effMean = demoBonus > 0 ? Math.min(DEMO_RELIABILITY_CAP, post.mean + demoBonus) : post.mean + demoBonus;
        const reliability = effMean - ciDiscount * post.hw;
        let scene = 0;
        if (currentSceneHash && s.entrySceneHash && similarity(currentSceneHash, s.entrySceneHash) >= sceneGate) {
          scene = sceneBonus;
        }
        const ageH = (now - s.lastUsedAt) / 3_600_000;
        const recency = 0.1 * Math.exp(-ageH / recencyHalfLifeH);
        return {
          ...s, score: Math.round((text + reliabilityWeight * reliability + scene + recency) * 1000) / 1000,
          // C-2 归因：命中通道对模型透明。overlap>=0.5 才算真正词面命中；
          // 零星共享字（CJK 单字/二元组）是子词噪声，此时排序信号实为语义向量。
          matched_via: overlap >= 0.5 && overlap >= semantic ? 'exact-tokens' : 'semantic-vector',
          // E-5 透明面：后验均值 + 95% 可信区间（模型看得见「可靠度 0.67±0.46」
          // 与「0.67±0.09」的区别 —— 不确定性与结论同等可见，决策才有质地）
          posterior_mean: Math.round(post.mean * 1000) / 1000,
          ci95: [
            Math.max(0, Math.round((post.mean - post.hw) * 1000) / 1000),
            Math.min(1, Math.round((post.mean + post.hw) * 1000) / 1000),
          ],
          // Τ 透明面：示范加成与 denied 标记对模型可见（教育的账目公开）
          demo_bonus: Math.round(demoBonus * 1000) / 1000,
          demo_denied: (s.demoDenied ?? 0) > 0,
          // G-5 Pareto 轴（内部暂存，判定后剥离）：三目标各自合法但互相冲突，
          // 加权和排序是仲裁 —— 非支配标注让模型看见「为什么是它」的另一面
          _axes: { text, rel: post.mean, rec: recency },
        } as Skill & { score: number; matched_via: string };
      })
      .filter(s => s.score > scoreFloor)
      .sort((a, b) => b.score - a.score);
    // Τ 纪元（干预即教育）：回避降序 —— 命中回避清单的技能稳定降档到分区末尾
    //（用户不让走的路排后面；稳定排序保各分区内既有的分数序）。空清单/无命中 ⇒
    // 恒等传递（既有主路径逐字节不变 —— avoidedSkillIds 空清单时零成本短路）。
    const avoided = this.avoidedSkillIds();
    const ranked = avoided.size > 0
      ? [...scored].sort((a, b) => (avoided.has(a.id) ? 1 : 0) - (avoided.has(b.id) ? 1 : 0))
      : scored;
    return ranked
      .slice(0, k)
      // G-5 非支配标注：A 支配 B ⇔ 三轴全 ≥ 且至少一轴 >。非支配者标
      // pareto_optimal —— 「没有任何别的候选在所有维度都不差于它且有一维更好」。
      // 两遍式（先全量判支配，后全量剥离轴）—— 单遍变异会破坏后续判读
      .map((hit, _i, all) => {
        const axesA = (hit as any)._axes;
        const dominated = all.some(other => {
          if (other === hit) return false;
          const axesB = (other as any)._axes;
          // 轴名对齐 _axes 的 { text, rel, rec } —— 此前误写 axesA.recency
          //（undefined），比较恒 false 导致 pareto_optimal 恒 true
          const ge = axesB.text >= axesA.text && axesB.rel >= axesA.rel && axesB.rec >= axesA.rec;
          const gt = axesB.text > axesA.text || axesB.rel > axesA.rel || axesB.rec > axesA.rec;
          return ge && gt;
        });
        return { hit, dominated };
      })
      .map(({ hit, dominated }) => {
        delete (hit as any)._axes;
        return { ...hit, pareto_optimal: !dominated };
      });
  }

  /**
   * C-2 DNA 重组引擎：从既有技能的基因链中实时合成新技能。
   * 拼接律：基因 A 的离场指纹 ≈ 基因 B 的入场指纹（dHash 相似度 ≥ 0.85）⇒ 可链式拼接；
   * 或语义相邻（查询向量同时高余弦命中两母体技能）⇒ 按匹配序拼接。
   * 合成技能 synthesized=true：成功 0/尝试 0，Laplace 先验 1/2 —— 谨慎起步，用一次校准一次。
   * 原子性：合成 → 内存登记 → save() 原子落盘，中途崩溃磁盘保持完整旧库。
   */
  recombine(query: string, currentSceneHash?: string): { skill: Skill | null; plan: Array<{ skillId: number; geneIndex: number; reason: string }> } {
    if (!this.enabled) return { skill: null, plan: [] };
    // 候选母体：语义 top-k（k=4 —— 太少没得拼，太多拼出长蛇）
    const candidates = this.match(query, currentSceneHash, 4).filter(c => c.score > 0.25);
    if (candidates.length < 2) return { skill: null, plan: [] };

    const plan: Array<{ skillId: number; geneIndex: 0; reason: string }> = [];
    const genes: SkillGene[] = [];
    const chain: Array<Skill & { score: number }> = [];

    // 贪心链式拼接：从最强候选出发，尝试把后续基因接到链尾
    for (const cand of candidates) {
      const gene = cand.genes?.[0];
      if (!gene || gene.steps.length === 0) continue;
      const tail = chain[chain.length - 1];
      // 拼接判据：首基因无条件入链；后续基因需 指纹衔接 或 语义相邻
      if (!tail) {
        chain.push(cand);
        genes.push({ ...gene, sourceSkillId: cand.id });
        plan.push({ skillId: cand.id, geneIndex: 0, reason: `best match (score ${cand.score})` });
        continue;
      }
      const tailExit = tail.genes?.at(-1)?.exitSceneHash;
      const fingerprintLink = tailExit && gene.entrySceneHash
        && similarity(tailExit, gene.entrySceneHash) >= 0.85;
      const semanticLink = cand.score > 0.3; // 语义相邻阈值：两母体都与查询强相关
      if (fingerprintLink || semanticLink) {
        chain.push(cand);
        genes.push({ ...gene, sourceSkillId: cand.id });
        plan.push({
          skillId: cand.id, geneIndex: 0,
          reason: fingerprintLink
            ? 'exit→entry scene fingerprint linked'
            : `semantically adjacent (score ${cand.score})`,
        });
      }
    }

    if (genes.length < 2) return { skill: null, plan: [] }; // 单基因 = 已有技能，无需合成

    // 合成步骤 = E-2 OLC 重叠布局：逐基因折叠，尾头最长精确重叠缝合（共享子序列
    // 只保留一份）。旧「相邻重复步骤剪除」是本对齐的 k=1 特例 —— 被最长重叠自然包含。
    const merged: SkillStep[] = [];
    const splices: number[] = [];
    for (const g of genes) {
      const k = merged.length > 0 ? olcOverlap(merged, g.steps) : 0;
      splices.push(k);
      for (const st of g.steps.slice(k)) merged.push(st);
    }
    // 族谱透明：每个接缝的重叠长度写进 plan 的归因（审计可回放 —— 白盒合成）
    plan.forEach((p, i) => {
      if (i > 0 && splices[i] > 0) {
        p.reason += `; OLC spliced ${splices[i]} overlapping step(s)`;
      }
    });
    const sig = stepSignature(merged);
    const existing = this.skills.find(s => stepSignature(s.steps) === sig);
    // J 纪元修正：注释宣称"撞已有技能 = 强化"，旧实现直接 return 不 bump 计数 ——
    // 所谓强化并不发生。对齐 induce 的去重路径（attemptCount/successCount/lastUsedAt）。
    if (existing) {
      existing.attemptCount++;
      existing.successCount++;
      existing.lastUsedAt = Date.now();
      this.save(); // P 纪元修正（第十三只 bug）：计数 bump 即落盘 —— 崩溃窗口内
                   // 的强化不再静默丢失（对齐 induce 去重路径的持久化语义）
      return { skill: existing, plan };
    }

    const skill: Skill = {
      id: this.nextId++,
      name: `syn-${this.nextSynthId++}`,
      description: query, // 合成技能的触发描述 = 原始查询（下次同型任务直接命中）
      entrySceneHash: genes[0].entrySceneHash,
      steps: merged,
      successCount: 0,
      attemptCount: 0,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      embedding: embed(query),
      genes,
      synthesized: true,
      // Q 纪元（Q-5）：系谱登记 —— 母体 = 基因供体；世代 = 最深母体 + 1
      parents: plan.map(p => p.skillId),
      generation: 1 + Math.max(0, ...plan.map(p => this.skills.find(x => x.id === p.skillId)?.generation ?? 0)),
    };
    this.skills.push(skill);
    this.save(); // 原子落盘：合成中途崩溃 ⇒ 磁盘保持完整旧库
    return { skill, plan };
  }

  /**
   * Q 纪元（Q-5）：技能谱系 —— 自此技能向上回溯母体链（含旁支同胞）。
   * 返回：根到本技能的祖先链（深先）、同世代同胞数、总家族规模。
   * 环守卫：parents 环（数据损坏）⇒ 在访问栈处截断（诚实降级，绝不死循环）。
   */
  lineage(id: number): { chain: Skill[]; siblings: number; familySize: number } | null {
    const target = this.skills.find(x => x.id === id);
    if (!target) return null;
    const chain: Skill[] = [];
    const visiting = new Set<number>([id]);
    let cursor: Skill | undefined = target;
    while (cursor) {
      const parentList: Skill[] = (cursor.parents ?? [])
        .map(pid => this.skills.find(x => x.id === pid))
        .filter((x): x is Skill => !!x);
      if (parentList.length === 0) break; // 谱系根
      const ancestor: Skill = parentList[0];
      if (visiting.has(ancestor.id)) break; // 环守卫：损坏数据诚实截断
      visiting.add(ancestor.id);
      chain.push(ancestor);
      cursor = ancestor;
    }
    const sameGen = this.skills.filter(x => (x.generation ?? 0) === (target.generation ?? 0)).length;
    return { chain, siblings: sameGen - 1, familySize: visiting.size };
  }

  /** 执行结果回写：技能的可靠度随真实使用持续校准 */
  recordOutcome(id: number, success: boolean): void {
    const s = this.skills.find(x => x.id === id);
    if (!s) return;
    s.attemptCount++;
    if (success) s.successCount++;
    s.lastUsedAt = Date.now();
    this.save();
  }

  // ── W3-2（M2 参数化通用技能）：反统一蒸馏 / 模板召回 / 运行时绑定 ──

  /**
   * W3-2：洞位证据扫（跨母体 Beta 门的证据源 —— 纯符号，确定性）。
   * 证据池 = 全库能**完整实现**模板骨架的技能（DTW 对齐过门 + 每个模板步
   *  都映射到同工具步；多余步是缺口、缺步即排除 —— 部分实现不构成反证源，
   *  也不构成支撑源）。逐洞判定：键在且类型相符 ⇒ s（支撑证据）；键缺/异型
   *  ⇒ f（反证 —— 同骨架的工作流在这个槽位上不守恒，洞就是过拟合）。
   *  「每个洞位在各母体绑定成功才计证据」：只有全洞皆成的技能才入 supporters
   *  —— 任何一洞失败即整技出局（单母体永不产模板的结构执法在 supporters
   *  长度门）。返回值含逐洞后验均值 (s+1)/(s+f+2) 与支撑母体实值（审计面）。
   */
  private sweepHoleEvidence(candSteps: readonly TemplateStep[], pool: readonly Skill[]): {
    supporters: Skill[];
    holeStats: Array<{ stepIndex: number; key: string; s: number; f: number; posteriorMean: number }>;
    supporterValues: Map<string, Array<{ skillId: number; value: unknown }>>;
  } {
    // 洞清单（步序 × 键字典序 —— 确定性枚举）
    const holeList: Array<{ stepIndex: number; key: string; type: HoleType }> = [];
    candSteps.forEach((st, si) => {
      for (const k of Object.keys(st.args).sort()) {
        const slot = st.args[k];
        if (slot.kind === 'hole') holeList.push({ stepIndex: si, key: k, type: slot.type });
      }
    });
    const stats = holeList.map(h => ({ stepIndex: h.stepIndex, key: h.key, s: 0, f: 0, posteriorMean: 0 }));
    const supporterValues = new Map<string, Array<{ skillId: number; value: unknown }>>();
    const supporters: Skill[] = [];
    const candTools = candSteps.map(st => st.tool);
    for (const sk of pool) {
      const { pairs, cost } = dtwAlignTools(sk.steps.map(x => x.tool), candTools);
      const ratio = cost / Math.max(1, Math.max(sk.steps.length, candTools.length));
      if (ratio > TEMPLATE_MAX_ALIGN_COST_RATIO) continue; // 骨架不同：既非证据亦非反证
      // 模板步 → 技能步 的同源映射（缺口/异工具 ⇒ 缺映射）
      const map = new Map<number, number>();
      for (const [j, i] of pairs) {
        if (j >= 0 && i >= 0 && sk.steps[j].tool === candTools[i]) map.set(i, j);
      }
      if (map.size < candSteps.length) continue; // 未完整实现骨架 —— 不入证据池
      let allBound = true;
      holeList.forEach((h, hi) => {
        const bound = map.get(h.stepIndex);
        const v = bound !== undefined ? sk.steps[bound].args?.[h.key] : undefined;
        if (bound === undefined || !(h.key in (sk.steps[bound].args ?? {})) || holeTypeOf(v) !== h.type) {
          stats[hi].f++; // 反证：同骨架在此槽位不守恒
          allBound = false;
        } else {
          stats[hi].s++; // 支撑：该母体在此洞位绑定成功
        }
      });
      if (!allBound) continue;
      supporters.push(sk);
      holeList.forEach((h, hi) => {
        const bound = map.get(h.stepIndex)!;
        const v = sk.steps[bound].args[h.key];
        const mk = `${h.stepIndex}#${h.key}`;
        const arr = supporterValues.get(mk) ?? [];
        arr.push({ skillId: sk.id, value: v });
        supporterValues.set(mk, arr);
      });
    }
    for (const st of stats) st.posteriorMean = (st.s + 1) / (st.s + st.f + 2);
    return { supporters, holeStats: stats, supporterValues };
  }

  /**
   * W3-2：反统一蒸馏入口（纯符号 —— 无 LLM、无网络、无模型调用）。
   * 对库内字面量技能的两两组合（插入序、i<j —— 确定性）执行 DTW 对齐 +
   * 参数槽反统一（antiUnifyPair），候选再过跨母体证据扫（sweepHoleEvidence）
   * 与抗过拟合门：
   *   · 支撑母体 ≥ TEMPLATE_MIN_PARENTS（单母体永不产模板）；
   *   · 每个洞位 Beta 后验 mean ≥ TEMPLATE_HOLE_POSTERIOR_GATE；
   *   · 骨架哈希去重（同骨架模板已存在 ⇒ 跳过，首酿优先）。
   * 拒绝判词全量返回（可审计）；created 非空才落盘（原子写）。
   * 消费面：sleep 第②幕蒸馏（SleepDeps.skillLibrary.distillTemplates 可选面）。
   */
  distillTemplates(maxSkills = TEMPLATE_MAX_SKILLS): {
    created: SkillTemplate[];
    rejected: Array<{ a: number; b: number; reason: string; detail?: string }>;
  } {
    const created: SkillTemplate[] = [];
    const rejected: Array<{ a: number; b: number; reason: string; detail?: string }> = [];
    if (!this.enabled) return { created, rejected };
    const pool = this.skills.filter(s => s.steps.length > 0).slice(0, maxSkills);
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        const A = pool[i];
        const B = pool[j];
        const uni = antiUnifyPair(A, B);
        if (!uni.ok) {
          rejected.push({ a: A.id, b: B.id, reason: uni.reason, detail: uni.detail });
          continue;
        }
        const skeletonHash = hashSkeleton(uni.steps.map(st => st.tool));
        if (this.templates.some(t => t.skeletonHash === skeletonHash)) {
          rejected.push({ a: A.id, b: B.id, reason: 'skeleton-exists', detail: '同骨架模板已在册（首酿优先）' });
          continue;
        }
        const ev = this.sweepHoleEvidence(uni.steps, pool);
        if (ev.supporters.length < TEMPLATE_MIN_PARENTS) {
          rejected.push({ a: A.id, b: B.id, reason: 'insufficient-parents', detail: `supporters=${ev.supporters.length}` });
          continue;
        }
        const worst = Math.min(...ev.holeStats.map(h => h.posteriorMean));
        if (worst < TEMPLATE_HOLE_POSTERIOR_GATE) {
          rejected.push({
            a: A.id, b: B.id, reason: 'hole-gate',
            detail: `worstPosterior=${Math.round(worst * 1000) / 1000} < ${TEMPLATE_HOLE_POSTERIOR_GATE}`,
          });
          continue;
        }
        // 回填逐洞后验 + 支撑母体实值（封顶 8 —— 审计面防膨胀；支撑母体集
        // 天然含种对 A/B，故以证据扫的支撑值覆盖种对种子值，避免重复记账）
        for (const h of ev.holeStats) {
          const slot = uni.steps[h.stepIndex].args[h.key];
          if (slot.kind !== 'hole') continue; // 防御带（holeList 只收洞槽）
          slot.posteriorMean = Math.round(h.posteriorMean * 1000) / 1000;
          const vals = ev.supporterValues.get(`${h.stepIndex}#${h.key}`) ?? [];
          slot.bindings = vals.length > 0 ? vals.slice(0, 8) : slot.bindings;
        }
        const tpl: SkillTemplate = {
          id: this.nextTemplateId++,
          name: `tpl-${this.nextTemplateId - 1}`,
          description: `参数化模板: ${A.description} ∥ ${B.description}`.slice(0, 200),
          entrySceneHash: A.entrySceneHash,
          skeletonHash,
          steps: uni.steps,
          parents: ev.supporters.map(s => s.id),
          generation: 1 + Math.max(0, ...ev.supporters.map(s => s.generation ?? 0)),
          holes: uni.holes,
          successCount: 0,
          attemptCount: 0,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          alignment: uni.alignment,
        };
        this.templates.push(tpl);
        created.push(tpl);
      }
    }
    // 容量驱逐（可靠度 × 新近度 —— 技能驱逐同律；0/0 新模板按 Laplace 0.5 起步）
    if (this.templates.length > TEMPLATE_CAPACITY) {
      const now = Date.now();
      const survival = (t: SkillTemplate): number =>
        (t.attemptCount > 0 ? t.successCount / t.attemptCount : 0.5) * Math.exp(-(now - t.lastUsedAt) / 7_200_000);
      this.templates.sort((x, y) => survival(y) - survival(x));
      this.templates = this.templates.slice(0, TEMPLATE_CAPACITY);
    }
    if (created.length > 0) this.save(); // 原子落盘（tmp+rename —— 蒸馏中途崩溃保旧档）
    return { created, rejected };
  }

  /**
   * W3-2：模板召回（骨架哈希 + 场景指纹 —— match 的非文本通道同律）。
   * skeleton 在场 ⇒ 精确骨架哈希过滤（matched_via='skeleton-hash'）；场景指纹
   * 与 entrySceneHash 相似度过门 ⇒ 同屏加成（'scene-fingerprint'）；可靠度 =
   * Beta 后验均值 − CI 折扣（与字面量技能 match 完全同一执法面）。对字面量
   * 技能的 match() 零触碰 —— 两套召回并行，模型自选。
   */
  matchTemplates(opts: { sceneHash?: string; skeleton?: readonly string[]; k?: number } = {}):
    Array<SkillTemplate & { score: number; matched_via: string }> {
    if (!this.enabled) return [];
    const k = Math.max(1, opts.k ?? 3);
    const sceneGate = kernelRegistry.getOrDefault('skill.sceneGate', 0.9);
    const sceneBonus = kernelRegistry.getOrDefault('skill.sceneBonus', 0.3);
    const reliabilityWeight = kernelRegistry.getOrDefault('skill.reliabilityWeight', 0.3);
    const ciDiscount = kernelRegistry.getOrDefault('skill.ciDiscount', 0.1);
    const recencyHalfLifeH = Math.max(1, kernelRegistry.getOrDefault('skill.recencyHalfLifeH', 72));
    let via = 'reliability-only';
    let pool = [...this.templates];
    if (Array.isArray(opts.skeleton) && opts.skeleton.length > 0) {
      const want = hashSkeleton(opts.skeleton);
      pool = pool.filter(t => t.skeletonHash === want);
      via = 'skeleton-hash';
    }
    const now = Date.now();
    return pool
      .map(t => {
        const post = betaReliability(t.successCount, t.attemptCount);
        let scene = 0;
        let matchedVia = via;
        if (opts.sceneHash && t.entrySceneHash && similarity(opts.sceneHash, t.entrySceneHash) >= sceneGate) {
          scene = sceneBonus;
          if (via === 'reliability-only') matchedVia = 'scene-fingerprint';
        }
        const ageH = (now - t.lastUsedAt) / 3_600_000;
        const recency = 0.1 * Math.exp(-ageH / recencyHalfLifeH);
        return {
          ...t,
          score: Math.round((reliabilityWeight * (post.mean - ciDiscount * post.hw) + scene + recency) * 1000) / 1000,
          matched_via: matchedVia,
        };
      })
      .sort((x, y) => y.score - x.score)
      .slice(0, k);
  }

  /**
   * W3-2：运行时绑定 —— 洞由当前世界读取（reader 注入面：OCR/元素跟踪/上下文
   * 的宿主接线），常量槽逐字面回放。reader 抛错/缺席值 ⇒ hole-read-failed；
   * 类型不符 ⇒ hole-type-mismatch —— 两种失败都判「模板不适用」，调用方回退
   * 原字面量技能（零行为损失）。绑定账本逐洞回写（成败皆计 —— 审计面）并落盘。
   */
  bindTemplate(id: number, reader: TemplateHoleReader): TemplateBindResult {
    if (!this.enabled) return { ok: false, reason: 'library-disabled' };
    const t = this.templates.find(x => x.id === id);
    if (!t) return { ok: false, reason: 'not-found' };
    const steps: SkillStep[] = [];
    for (let si = 0; si < t.steps.length; si++) {
      const ts = t.steps[si];
      const args: Record<string, unknown> = {};
      for (const key of Object.keys(ts.args).sort()) {
        const slot = ts.args[key];
        if (slot.kind === 'const') {
          args[key] = slot.value;
          continue;
        }
        slot.bindAttempts++; // 绑定账本：尝试即计（失败也是洞可靠度的世界证据）
        let raw: unknown;
        try {
          raw = reader({ templateId: t.id, stepIndex: si, key, tool: ts.tool, type: slot.type, source: slot.source });
        } catch {
          this.save();
          return {
            ok: false, templateId: t.id, reason: 'hole-read-failed',
            failed: { stepIndex: si, key, source: slot.source },
          };
        }
        if (raw === undefined || raw === null || !valueMatchesHoleType(raw, slot.type)) {
          this.save();
          return {
            ok: false, templateId: t.id,
            reason: raw === undefined ? 'hole-read-failed' : 'hole-type-mismatch',
            failed: { stepIndex: si, key, source: slot.source },
          };
        }
        slot.bindSuccesses++;
        args[key] = raw;
      }
      steps.push({ tool: ts.tool, args });
    }
    t.lastUsedAt = Date.now(); // 召回新鲜化（执行成败的回写归 recordTemplateOutcome）
    this.save();
    return { ok: true, templateId: t.id, steps };
  }

  /** W3-2：模板执行结果回写（recordOutcome 的模板同律 —— 越用越准） */
  recordTemplateOutcome(id: number, success: boolean): void {
    const t = this.templates.find(x => x.id === id);
    if (!t) return;
    t.attemptCount++;
    if (success) t.successCount++;
    t.lastUsedAt = Date.now();
    this.save();
  }

  /** W3-2：模板观测面 */
  getTemplate(id: number): SkillTemplate | undefined {
    return this.templates.find(x => x.id === id);
  }

  /** W3-2：模板清单（新近优先 —— list() 同律） */
  listTemplates(): SkillTemplate[] {
    return [...this.templates].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  // ── W4-1（G3 契约）：联邦摘要与休眠登记（签名逐字对齐契约，绝不抛） ──

  /**
   * W4-1（G3 契约）：本机技能摘要清单 —— 联邦交换的最小充分统计量。
   * skillId = 技能名（skill-N / syn-N —— 跨档案稳定的人类可读标识）；
   * sceneFingerprint = entrySceneHash（缺席诚实空串）；stepsDigest 每步
   * { 工具名: argsFNV数值哈希 }；reliability = Beta 后验均值（round3）。
   * 库禁用 ⇒ 空数组（诚实缺席）。纯读 —— 无副作用。
   */
  listSkillDigests(): Array<{ skillId: string; sceneFingerprint: string; stepsDigest: Array<Record<string, number>>; reliability: number }> {
    if (!this.enabled) return [];
    try {
      return this.skills.map(s => ({
        skillId: String(s.name ?? s.id),
        sceneFingerprint: typeof s.entrySceneHash === 'string' ? s.entrySceneHash : '',
        stepsDigest: (Array.isArray(s.steps) ? s.steps : []).map(st => ({
          [String(st?.tool ?? 'unknown')]: hashArgsNumeric((st?.args ?? {}) as Record<string, any>),
        })),
        reliability: Math.round(betaReliability(s.successCount, s.attemptCount).mean * 1000) / 1000,
      }));
    } catch {
      return []; // 防御带：脏档案绝不让摘要面炸调用方
    }
  }

  /**
   * W4-1（G3 契约）：休眠技能登记（他方技能的隔离入境口）。
   * 校验失败 / 库禁用 / 同 skillId 重复 ⇒ false（幂等拒绝，绝不抛）；
   * 成功 ⇒ 入隔离登记区（FIFO 容量 DORMANT_CAPACITY），原子落盘。
   * 休眠语义：不入 match 主池、不参与归纳 —— 外来技能未经本机验证，
   * 唤醒（转正为可执行技能）是联邦消费方（W4-2）的职权，本库只管登记与溯源。
   */
  addDormantSkill(d: {
    skillId: string;
    sceneFingerprint: string;
    stepsDigest: Array<Record<string, number>>;
    reliability: number;
    origin: string;
  }): boolean {
    try {
      if (!this.enabled) return false;
      if (!d || typeof d !== 'object') return false;
      if (typeof d.skillId !== 'string' || d.skillId.trim() === '') return false;
      if (typeof d.sceneFingerprint !== 'string') return false;
      if (typeof d.origin !== 'string' || d.origin.trim() === '') return false;
      if (typeof d.reliability !== 'number' || !Number.isFinite(d.reliability) || d.reliability < 0 || d.reliability > 1) return false;
      if (!Array.isArray(d.stepsDigest) || d.stepsDigest.length === 0) return false;
      for (const step of d.stepsDigest) {
        if (!step || typeof step !== 'object' || Array.isArray(step)) return false;
        const keys = Object.keys(step);
        if (keys.length === 0) return false;
        for (const k of keys) {
          if (typeof step[k] !== 'number' || !Number.isFinite(step[k])) return false;
        }
      }
      if (this.dormant.some(x => x.skillId === d.skillId)) return false; // 幂等：同 id 只登记一次
      this.dormant.push({
        skillId: d.skillId,
        sceneFingerprint: d.sceneFingerprint,
        stepsDigest: d.stepsDigest,
        reliability: d.reliability,
        origin: d.origin,
        receivedAt: Date.now(),
      });
      if (this.dormant.length > DORMANT_CAPACITY) this.dormant.shift(); // FIFO 驱逐最老
      this.save();
      return true;
    } catch {
      return false; // 防御式绝不抛（登记是增益不是依赖）
    }
  }

  /** W4-1：休眠段观测面（联邦消费方的唤醒候选清单 —— 拷贝，调用方改写不触库） */
  listDormantSkills(): Array<DormantSkillInput & { receivedAt: number }> {
    return this.dormant.map(d => ({ ...d, stepsDigest: d.stepsDigest.map(s => ({ ...s })) }));
  }

  /**
   * Τ 纪元（干预即教育）：示范蒸馏 —— 审批事件的技能库落点。
   *   approval-consumed（验收式消费成功 = 用户背书+世界验证）：命中既有技能
   *     （签名/文本通道）⇒ 可靠度 +β 特权加成（封顶 0.95）+ 来源注记（demoEndorsed）；
   *     无匹配 ⇒ 不伪造新技能（诚实 —— 单例不足以成技），仅计数。
   *   approval-denied（用户拒绝 = 负示范）：形状入回避注记（LRU 32）；命中既有技能
   *     ⇒ 可靠度 −β 并打 denied 标记。
   * 旁路义务：本方法自身不抛（蒸馏失败最多返回 no-shape/library-disabled 判词）；
   * 既有归纳/匹配主路径零触碰 —— demoBonus 缺省、回避清单空的库行为逐字节不变。
   */
  learnFromDemonstration(ev: DemonstrationEvent): DemonstrationLearning {
    if (!this.enabled) return { kind: ev.kind, outcome: 'library-disabled' };
    // 二次脱敏（防御直调调用方）：铸造点已脱敏的形状再过一次幂等不变
    const shape = ev.actionShape ? sanitizeActionShape(ev.actionShape) : undefined;
    if (ev.kind === 'approval-consumed') {
      const hit = shape ? this.findSkillByShape(shape) : undefined;
      if (!hit) {
        this.demoUnmatched += 1; // 仅计数：单例不足以成技
        return { kind: ev.kind, outcome: shape ? 'counted-only' : 'no-shape' };
      }
      hit.demoBonus = Math.min(DEMO_RELIABILITY_CAP, (hit.demoBonus ?? 0) + DEMO_BETA);
      hit.demoEndorsed = (hit.demoEndorsed ?? 0) + 1; // 来源注记在册
      this.save();
      return { kind: ev.kind, outcome: 'reinforced', skillId: hit.id };
    }
    // approval-denied：这条路用户不让走
    if (shape) this.rememberAvoidedShape(shape);
    const hit = shape ? this.findSkillByShape(shape) : undefined;
    if (!hit) return { kind: ev.kind, outcome: shape ? 'avoidance-only' : 'no-shape' };
    hit.demoBonus = (hit.demoBonus ?? 0) - DEMO_BETA;
    hit.demoDenied = (hit.demoDenied ?? 0) + 1;
    this.save();
    return { kind: ev.kind, outcome: 'penalized', skillId: hit.id };
  }

  /** 回避注记观测面（脱敏形状的拷贝 —— 调用方改写不触库内清单） */
  deniedShapes(): ActionShape[] {
    return this.avoidShapes.map(s => ({ ...s }));
  }

  /** 蒸馏统计（观测面）：reinforced/penalized 从技能账本汇总，unmatched/avoided
   *  为会话级内存计数（回避注记是轻量清单，不落盘） */
  demonstrationStats(): { reinforced: number; unmatched: number; penalized: number; avoided: number } {
    return {
      reinforced: this.skills.reduce((n, s) => n + (s.demoEndorsed ?? 0), 0),
      unmatched: this.demoUnmatched,
      penalized: this.skills.reduce((n, s) => n + (s.demoDenied ?? 0), 0),
      avoided: this.avoidShapes.length,
    };
  }

  /** 形状→技能匹配：签名通道（步骤工具+坐标近邻）优先，文本通道（目标描述与技能
   *  触发描述词面重合 ≥0.5，与 matched_via='exact-tokens' 同阈）次之。
   *  确定性：签名按库序取首；文本取重合最高者（同分取后者 —— 罕见且无副作用）。 */
  private findSkillByShape(shape: ActionShape): Skill | undefined {
    for (const s of this.skills) {
      if (s.steps.some(st => this.stepMatchesShape(st, shape))) return s;
    }
    if (shape.target_description) {
      const q = tokenize(shape.target_description);
      let best: Skill | undefined;
      let bestOv = 0.5; // 文本通道阈值（含）
      for (const s of this.skills) {
        const ov = overlapCoefficient(q, tokenize(s.description));
        if (ov >= bestOv) { best = s; bestOv = ov; }
      }
      if (best) return best;
    }
    return undefined;
  }

  /** 步骤-形状签名匹配：同工具 + 坐标近邻（±0.025 —— G-3 量化网格半宽的抖动
   *  容忍带）；形状无坐标（type_text 长度桶形态）⇒ 同工具即命中（文本类签名
   *  退化为工具名 —— 隐私铁律削掉了可区分的其余维度）。 */
  private stepMatchesShape(step: SkillStep, shape: ActionShape): boolean {
    if (step.tool !== shape.tool) return false;
    if (typeof shape.x !== 'number' || typeof shape.y !== 'number') return true;
    const sx = step.args?.x;
    const sy = step.args?.y;
    if (typeof sx !== 'number' || typeof sy !== 'number') return false;
    return Math.abs(sx - shape.x) <= 0.025 && Math.abs(sy - shape.y) <= 0.025;
  }

  /** 回避注记入册（LRU：重复触达即新鲜化；容量 32，最老出局） */
  private rememberAvoidedShape(shape: ActionShape): void {
    const key = shapeKey(shape);
    const idx = this.avoidShapes.findIndex(s => shapeKey(s) === key);
    if (idx >= 0) this.avoidShapes.splice(idx, 1);
    this.avoidShapes.push({ ...shape });
    if (this.avoidShapes.length > AVOID_CAPACITY) this.avoidShapes.shift();
  }

  /** 命中回避清单的技能 id 集：签名通道（步骤工具+坐标）或文本通道（目标描述
   *  重合 ≥0.5）任一命中即入。空清单 ⇒ 空集 —— match 主路径零成本短路。 */
  private avoidedSkillIds(): Set<number> {
    const ids = new Set<number>();
    if (this.avoidShapes.length === 0) return ids;
    for (const s of this.skills) {
      for (const shape of this.avoidShapes) {
        if (s.steps.some(st => this.stepMatchesShape(st, shape))) { ids.add(s.id); break; }
        if (shape.target_description
          && overlapCoefficient(tokenize(shape.target_description), tokenize(s.description)) >= 0.5) {
          ids.add(s.id); break;
        }
      }
    }
    return ids;
  }

  get(id: number): Skill | undefined {
    return this.skills.find(x => x.id === id);
  }

  /** checkpoint 序列化：与磁盘 JSON 同构（skills + 发号器进度） */
  /** checkpoint 序列化 —— J 纪元修正：补齐 nextSynthId（磁盘 save 有、
   *  快照没有 ⇒ 崩溃恢复后合成技能重复命名 syn-1，模型可见面撞名）。
   *  W3-2：模板段同律入快照（templates + nextTemplateId —— 崩溃恢复后
   *  tpl-N 不撞号、蒸馏成果不丢）。 */
  dump(): { skills: Skill[]; nextId: number; nextSynthId: number; templates: SkillTemplate[]; nextTemplateId: number; dormant: Array<DormantSkillInput & { receivedAt: number }> } {
    return {
      skills: this.skills, nextId: this.nextId, nextSynthId: this.nextSynthId,
      templates: this.templates, nextTemplateId: this.nextTemplateId,
      // W4-1：休眠段入快照（联邦登记不随崩溃丢失）
      dormant: this.dormant,
    };
  }

  restore(data: { skills?: Skill[]; nextId?: number; nextSynthId?: number; templates?: SkillTemplate[]; nextTemplateId?: number; dormant?: Array<DormantSkillInput & { receivedAt: number }> } | undefined): void {
    if (!data?.skills && !Array.isArray(data?.templates) && !Array.isArray(data?.dormant)) return;
    this.skills = data?.skills ?? this.skills;
    // 同 load 的撞号防线：ids 稀疏档案下 at(-1).id+1 不保证大于 max(id)+1
    const maxId = this.skills.reduce((m, s) => Math.max(m, Number(s.id) || 0), 0);
    this.nextId = Math.max(data?.nextId ?? 0, (this.skills.at(-1)?.id ?? 0) + 1, maxId + 1);
    this.nextSynthId = data?.nextSynthId ?? this.nextSynthId;
    // W3-2：模板段恢复（缺席 ⇒ 保持现段 —— 旧快照兼容）
    if (Array.isArray(data?.templates)) {
      this.templates = data!.templates!;
      const maxTid = this.templates.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
      this.nextTemplateId = Math.max(data?.nextTemplateId ?? 1, maxTid + 1);
    }
    // W4-1：休眠段恢复（缺席 ⇒ 保持现段 —— 旧快照兼容）
    if (Array.isArray(data?.dormant)) {
      this.dormant = data!.dormant!;
    }
  }

  list(): Skill[] {
    return [...this.skills].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }
}

export const skillLibrary = new SkillLibrary();
