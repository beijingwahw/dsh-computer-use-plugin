// src/skillLibrary.templates.ts
// W9-3（D-F4 拆分·模板/蒸馏分区）：W3-2 参数化通用技能（M2 反统一）的纯函数面 —
// — 洞类型契约/DTW 对齐/参数槽反统一/洞位证据扫（跨母体 Beta 门）+ 抗过拟合门限
// 常数。逐字节搬运（零逻辑变更；sweepHoleEvidence 自类私有方法升为自由函数 —— 纯
// 函数视角，零 this 依赖）；skillLibrary.ts 原位再导出 —— 导入面不变（消费方零改动）。
import type { Skill, SkillStep } from './skillLibrary.signatures';
import { canonicalStringify } from './skillLibrary.signatures';

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
  /** W6-5：模板版本号（首酿 = 1；同骨架新证据回流合并 ⇒ +1）。旧绑定产物按
   *  模板 id 继续命中 —— 版本演进不失效任何既有消费（bindTemplate/matchTemplates
   *  只认 id，不认版本）。缺省 = 1（旧档自动兼容）。 */
  version?: number;
  /** W6-5：最近一次回流合并的墙钟（审计面；缺席 = 未经历过合并） */
  revisedAt?: number;
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

/** W6-5：蒸馏选项（全部缺省 = 旧行为，逐字节不变 —— 新能力 opt-in） */
export interface DistillOptions {
  /** 合并模式：同骨架哈希的新证据**回流**既有模板（重跑洞证据扫描 + parents
   *  集合并 + Beta 门重算 + 版本号+1）。自动安全：门不过 ⇒ 不合并，证据保留池
   *  （字面量技能原样在库，后续蒸馏可再试）。 */
  merge?: boolean;
}

/** W6-5：回流合并账（distillTemplates.merged 的元素 —— 白盒审计面） */
export interface TemplateMergeRecord {
  templateId: number;
  /** 合并后的版本号（合并前 +1） */
  version: number;
  /** 本次回流新增的支撑母体 id（parents 并集的增量部分） */
  addedParents: number[];
  /** 合并后的全量 parents */
  parents: number[];
  /** 重算后最弱洞位 Beta 后验（过门数值的审计面） */
  worstPosterior: number;
}

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
export function sweepHoleEvidence(candSteps: readonly TemplateStep[], pool: readonly Skill[]): {
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
