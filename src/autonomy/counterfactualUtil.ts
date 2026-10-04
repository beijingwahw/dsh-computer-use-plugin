// src/autonomy/counterfactualUtil.ts
// W6-1（doctor 债清偿·smell.over-engineering）：从 counterfactual.ts 提取的内部纯函数
// 工具区与配套常量 —— 逐字节搬运（零逻辑/零数值变更），counterfactual.ts 保留契约
// 类型与导出面（评分内核/择优律/Top-K 出口），导入面不变。
// ΑΩ-R10（方言三重复制单源化）：本地 tokenize 副本（连同 CJK_RE/停用词表）已迁出
// 至 ../dialects/tokenizer 单源模块 —— 本文件改为 import + 原位再导出，行为逐字节等价。
import type { PolicyAction } from './policyEngine';
import type { SnapshotElement, WorldSnapshot } from './worldSnapshot';
import { tokenizeText } from '../dialects/tokenizer';
import { kernelRegistry } from '../kernel/registry';

// ─── 常量（随工具区同迁 —— 仅被本区函数消费） ───

/** 效用权重缺省：进展 0.5 / 信息 0.3 / 风险 0.2（推进为主、信息次之、风险惩罚必在） */
export const DEFAULT_WEIGHTS = { progress: 0.5, info: 0.3, risk: 0.2 } as const;
/** 风险分层 → 风险分映射：benign=0.05 / sensitive=0.5 / destructive=1 */
export const RISK_SCORES: Record<string, number> = { benign: 0.05, sensitive: 0.5, destructive: 1 };
/** 未知风险分层的保守记法（证据不足按需留意档） */
export const RISK_UNKNOWN = 0.5;
/** 中日韩统一表意字符（含扩展 A / 兼容区）—— 2-gram 切分对象。
 *  ΑΩ-R10：本体已单源化至 ../dialects/tokenizer —— 此处原位再导出，导入面不变。 */
export { CJK_RE, STOPWORDS } from '../dialects/tokenizer';

// ─── 内部纯函数工具（零副作用、零异常） ───

/** 空白折叠 + 小写化 —— 一切文本匹配/签名的前置归一 */
export function normalizeText(s: unknown): string {
  return typeof s === 'string' ? s.toLowerCase().replace(/\s+/g, ' ').trim() : '';
}

/** 数值夹 [0,1]；非有限数按 0 记（本器官一切产出都是有界概率） */
export function clamp01(v: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return Math.min(1, Math.max(0, n));
}

/** 保留两位小数（仅用于落选理由的展示，避免浮点尾噪；评分本体不取整） */
export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * 轻量分词：中文连续段按字符 2-gram（单字段保留单字）；英文/数字段按非字母数字
 * 切开取词；滤除停用词、纯数字与单个英文字母。输出按原文字符顺序（确定性）。
 * ΑΩ-R10：实现已单源化至 ../dialects/tokenizer 的 tokenizeText —— 本名保留为
 * 薄委托（导入面不变），行为与迁移前逐字节等价。
 */
export function tokenize(text: unknown): string[] {
  return tokenizeText(text);
}

/**
 * 目标关键词重合率 = |目标词 ∩ 动作词| / |目标词|（目标词为空 ⇒ 0）。
 * 关键词逐条再分词（短语关键词分解为 2-gram 后可与元素标签逐克相撞）；
 * 分母取目标词 —— 语义是「目标被该动作覆盖了几成」，而非「标签几成命中目标」。
 */
export function overlapRate(goalKeywords: unknown, text: unknown): number {
  const kws = Array.isArray(goalKeywords) ? goalKeywords : [];
  const goalTokens = new Set<string>();
  for (const k of kws) for (const t of tokenize(k)) goalTokens.add(t);
  if (goalTokens.size === 0) return 0;
  const textTokens = new Set(tokenize(text));
  let hit = 0;
  for (const t of goalTokens) if (textTokens.has(t)) hit += 1;
  return clamp01(hit / goalTokens.size);
}

/** 快照元素表卫兵：缺席/脏值 ⇒ 空表 */
export function elementsOf(snapshot: WorldSnapshot | null | undefined): SnapshotElement[] {
  return snapshot && Array.isArray(snapshot.elements) ? (snapshot.elements as SnapshotElement[]) : [];
}

/** 动作落点的原始标签（未归一，供展示）；无 target / 无标签 ⇒ '' */
export function targetLabelRaw(action: unknown): string {
  const a = action as Partial<PolicyAction> | null | undefined;
  const t = a?.target;
  return t && typeof t === 'object' && typeof t.label === 'string' ? t.label : '';
}

/** 动作文本：click/declare 重合打分的语料 —— target.label 优先，空标签回退 expectedEffect */
export function actionText(action: Partial<PolicyAction> | null | undefined): string {
  const label = targetLabelRaw(action);
  if (normalizeText(label) !== '') return label;
  return typeof action?.expectedEffect === 'string' ? action.expectedEffect : '';
}

/** 风险分层 → 风险分：benign=0.05 / sensitive=0.5 / destructive=1；未知 ⇒ 0.5 保守记 */
export function riskOf(tier: unknown): number {
  return typeof tier === 'string' && Number.isFinite(RISK_SCORES[tier]) ? RISK_SCORES[tier] : RISK_UNKNOWN;
}

/**
 * 进展先验（未乘重复折价的基础值）：
 * click/declare ⇒ 目标关键词重合度（见 overlapRate）；scroll/inspect ⇒ 0.25（探索性
 * 固定先验）；ask_vlm ⇒ 0.35；escalate ⇒ 0.1；recall_skill ⇒ 0.5；
 * 其余种类（type/hotkey/drag/wait）⇒ 0.2（保守中性先验）。
 */
export function progressPrior(action: Partial<PolicyAction> | null | undefined, goalKeywords: string[]): number {
  const kind = action?.kind;
  if (kind === 'click' || kind === 'declare') return overlapRate(goalKeywords, actionText(action));
  if (kind === 'scroll' || kind === 'inspect') return 0.25;
  if (kind === 'ask_vlm') return 0.35;
  if (kind === 'escalate') return 0.1;
  if (kind === 'recall_skill') return 0.5;
  return 0.2;
}

/** 数字卫兵（展示用坐标）：非有限数按 0 记 */
export function n4(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * 从快照推导的预期效果清单（每条一句中文、恒非空）：
 * click ⇒ 激活目标 +（label 未见于快照账本 ⇒ 可能揭示新界面）+（弹窗在场 ⇒ 可能消失）；
 * scroll ⇒ 视口按方向滚动；inspect ⇒ 焦点区/全画面放大细察；其余按动作语义记账。
 */
export function deriveEffects(action: PolicyAction, snapshot: WorldSnapshot): string[] {
  const kind = action?.kind;
  const payload =
    action?.payload && typeof action.payload === 'object'
      ? (action.payload as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const labelRaw = targetLabelRaw(action);
  const labelNorm = normalizeText(labelRaw);
  const effects: string[] = [];
  if (kind === 'click') {
    if (labelNorm !== '') {
      effects.push(`激活元素「${labelRaw}」`);
      const known = elementsOf(snapshot).some(el => normalizeText((el as Partial<SnapshotElement>)?.label) === labelNorm);
      if (!known) effects.push(`「${labelRaw}」未见于当前快照账本，点击可能揭示新界面`);
    } else {
      effects.push('点击落点生效（目标无标签）');
    }
    const popup = (Array.isArray(snapshot?.popups) ? snapshot.popups : []).find(
      p => typeof p === 'string' && p.trim() !== '',
    );
    if (popup !== undefined) effects.push(`遮挡弹窗「${popup}」可能随之消失`);
  } else if (kind === 'scroll') {
    const dirText =
      payload.direction === 'up' ? '上'
        : payload.direction === 'left' ? '左'
          : payload.direction === 'right' ? '右'
            : '下';
    effects.push(`视口向${dirText}滚动，未见内容进入视野`);
  } else if (kind === 'inspect') {
    const fr = snapshot?.focusedRegion;
    const regionLabel =
      fr && typeof fr === 'object'
        ? `焦点区(${n4(fr.x0)},${n4(fr.y0)})-(${n4(fr.x1)},${n4(fr.y1)})`
        : '当前画面';
    effects.push(`${regionLabel}被放大细察，可能识别出更精细的元素或文本`);
  } else if (kind === 'ask_vlm') {
    effects.push('云脑观察整屏并给出下一步建议');
  } else if (kind === 'declare') {
    const criterion = typeof payload.criterion === 'string' && payload.criterion.trim() !== '' ? payload.criterion : '';
    effects.push(criterion !== '' ? `宣称判据「${criterion}」达成，交验证层核对` : '宣称判据达成，交验证层核对');
  } else if (kind === 'escalate') {
    effects.push('控制权移交上游裁决，本轮不动世界');
  } else if (kind === 'recall_skill') {
    const id = typeof payload.skillId === 'string' && payload.skillId.trim() !== '' ? payload.skillId : '';
    effects.push(`技能流程展开执行${id !== '' ? `（${id}）` : ''}`);
  } else if (kind === 'wait') {
    effects.push('静止一拍，等待世界自行变化');
  } else if (kind === 'type') {
    effects.push('向焦点元素输入文本');
  } else if (kind === 'hotkey') {
    const keys = Array.isArray(payload.keys) ? payload.keys.filter(k => typeof k === 'string') : [];
    effects.push(`按下按键组合${keys.length > 0 ? `（${keys.join('+')}）` : ''}`);
  } else if (kind === 'drag') {
    effects.push('拖拽元素至目标位置');
  }
  if (effects.length === 0) {
    const fallback = typeof action?.expectedEffect === 'string' && action.expectedEffect.trim() !== '' ? action.expectedEffect : '';
    effects.push(fallback !== '' ? fallback : '世界状态改变');
  }
  return effects;
}

// ─── ΝΩ-46（model-based 反事实）：与 prophecy 单源对齐的同律量化小函数 ───
//
// 单源纪律：本区两函数与 prophecy 的方言铸造律逐字节同律（同屏必须同键——否则
// 世界模型按 (量化屏型 × 动作键) 积累的真实转移分布对不上号，只读旁路读不到
// 证据）。autonomy 器官不 import prophecy（跨层依赖破环——prophecy 侧另有对
// autonomy/evolutionEngine 的类型引用），故在此镜像实现；**两侧方言任何改动须
// 同步改**（prophecy/internal.ts 的 quantizedScreenType 与 prophecy/index.ts 的
// prophecyActionKey 是对侧真身），autonomy.counterfactual 测试以「同屏同键」
// 断言钉死对齐。

/** ΝΩ-46：闭环 dhash 方言长度（hex 字 = 64 位）—— 与 prophecy 同律（镜像常量） */
const WM_DHASH_HEX_LEN = 16;
/** ΝΩ-46：量化档位缺省（hex 字，上 48 位 = 屏上 3/4）—— prophecy QUANT_KEEP_HEX 镜像 */
const WM_QUANT_KEEP_HEX = 12;
/** ΝΩ-46：量化档位下界（不得粗于粗层）—— prophecy QUANT_MIN_KEEP_HEX 镜像 */
const WM_QUANT_MIN_KEEP_HEX = 8;
/** ΝΩ-46：量化档位上界（16 = 不量化，旧行为逃生门）—— prophecy QUANT_MAX_KEEP_HEX 镜像 */
const WM_QUANT_MAX_KEEP_HEX = 16;
/**
 * ΝΩ-46：量化档位内核键 —— **字符串字面镜像** prophecy/internal.ts 的
 * PROPHECY_QUANT_KERNEL_KEY（同名同缺省同区间）。经同一内核键读档 ⇒ 档位旋钮
 * 拧动时两侧同格（读侧就地夹取，未注册 ⇒ getOrDefault 回声缺省 —— 零漂移）。
 */
const WM_QUANT_KERNEL_KEY = 'prophecy.quantKeepHex';

/**
 * ΝΩ-46：量化屏型（纯函数、绝不抛）—— prophecy/internal.ts quantizedScreenType
 * 的同律镜像：恰 16 hex 字的闭环 dhash ⇒ 保留上 keep（缺省 12）字、低位**掩没
 * 为 '0'**（长度保持，掩没不是截断）；其余一切（非 hex / 非 16 字）⇒ 原样返回。
 * 世界模型转移表的 from 侧主键正是量化身份（prophecy 结算回灌按 {原始, 量化,
 * 粗格} 三写）—— 本量化读的是其中「量化格」通道，与其余两通道同表不串键。
 */
export function quantizedScreenTypeOf(dhash: string): string {
  try {
    const s = typeof dhash === 'string' ? dhash : '';
    if (s.length !== WM_DHASH_HEX_LEN || !/^[0-9a-f]+$/i.test(s)) return s;
    const raw = kernelRegistry.getOrDefault(WM_QUANT_KERNEL_KEY, WM_QUANT_KEEP_HEX);
    const keep = Math.min(WM_QUANT_MAX_KEEP_HEX, Math.max(WM_QUANT_MIN_KEEP_HEX, Math.round(raw)));
    if (keep >= WM_DHASH_HEX_LEN) return s;
    return s.slice(0, keep) + '0'.repeat(WM_DHASH_HEX_LEN - keep);
  } catch {
    return typeof dhash === 'string' ? dhash : ''; // 量化绝不抛（运行层铁律）
  }
}

/**
 * ΝΩ-46：转移动作键（纯函数、绝不抛）—— prophecy/index.ts prophecyActionKey
 * 的同律镜像：指针动作（target.center 有限数 + 参考宽高有限正数）⇒ kind + 4×4
 * 量化区域（'click@22'，落点先按参考宽高折算归一——闭环坐标是像素，量化在此
 * 收口）；无落点/坏几何 ⇒ kind 本身。与 worldModel.transitionActionKey 的
 * TYPE_QUANTIZE=4 共用同一坐标方言（「在什么样的屏上点哪个区」）。
 */
export function transitionActionKeyOf(
  action: { kind?: unknown; target?: unknown } | null | undefined,
  refWidth?: number,
  refHeight?: number,
): string {
  try {
    const kind =
      action && typeof action === 'object' && typeof action.kind === 'string' && action.kind !== ''
        ? String(action.kind)
        : 'unknown';
    const target = action && typeof action === 'object' ? (action as { target?: unknown }).target : null;
    const center = target && typeof target === 'object' ? (target as { center?: unknown }).center : null;
    const cx = center && typeof center === 'object' ? (center as { x?: unknown }).x : undefined;
    const cy = center && typeof center === 'object' ? (center as { y?: unknown }).y : undefined;
    const hasGeom =
      typeof refWidth === 'number' && Number.isFinite(refWidth) && refWidth > 0 &&
      typeof refHeight === 'number' && Number.isFinite(refHeight) && refHeight > 0;
    if (typeof cx === 'number' && Number.isFinite(cx) && typeof cy === 'number' && Number.isFinite(cy) && hasGeom) {
      const nx = Math.min(1, Math.max(0, cx / (refWidth as number)));
      const ny = Math.min(1, Math.max(0, cy / (refHeight as number)));
      const qx = Math.min(3, Math.max(0, Math.floor(nx * 4)));
      const qy = Math.min(3, Math.max(0, Math.floor(ny * 4)));
      return `${kind}@${qx}${qy}`;
    }
    return kind;
  } catch {
    return 'unknown'; // 键铸造绝不抛
  }
}

/** 权重卫兵：逐项取有限数并夹 [0,1]（负权重按 0 计——负效用权重会把「推进目标」
 *  变成惩罚项、把「风险」变成奖励项，属调用方脏值；>1 压回 1）；缺席/非法 ⇒ 缺省
 *  0.5/0.3/0.2；三项夹取后全零 ⇒ 整组回退缺省（全零效用恒 0，择优退化为输入序
 *  ——纪元 Δ 设防）。
 *  ΝΩ-10（效用权重可调）：缺省三值不再直取字面量，改读内核注册表
 *  policy.progressWeight / policy.infoWeight / policy.riskWeight（与 policy.tieGap
 *  同律：未注册 ⇒ getOrDefault 回声现行字面量，行为逐字节零漂移；已注册 ⇒ 每次
 *  评分单次读取，set 即时生效）。优先序不变：调用方显式 ctx.weights > 内核键 >
 *  模块字面量；全零回退仍锚定模块字面量三元组（内核被三键全置 0 时兜住「择优
 *  退化成输入序」的纪元 Δ 设防，不随内核漂移）。 */
export function resolveWeights(w: unknown): { progress: number; info: number; risk: number } {
  const src = (w && typeof w === 'object' ? w : {}) as { progress?: unknown; info?: unknown; risk?: unknown };
  const pick = (v: unknown, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d;
  const progress = pick(src.progress, kernelRegistry.getOrDefault('policy.progressWeight', DEFAULT_WEIGHTS.progress));
  const info = pick(src.info, kernelRegistry.getOrDefault('policy.infoWeight', DEFAULT_WEIGHTS.info));
  const risk = pick(src.risk, kernelRegistry.getOrDefault('policy.riskWeight', DEFAULT_WEIGHTS.risk));
  if (progress === 0 && info === 0 && risk === 0) {
    return { progress: DEFAULT_WEIGHTS.progress, info: DEFAULT_WEIGHTS.info, risk: DEFAULT_WEIGHTS.risk };
  }
  return { progress, info, risk };
}
