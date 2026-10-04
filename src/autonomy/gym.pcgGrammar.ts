// src/autonomy/gym.pcgGrammar.ts
// W8-B1（DEBTS D-F1 拆分潮）：自 gym.ts 低风险分区提取（对齐 actionVerifier.*
// 兄弟文件先例）—— W4-4 PCFG 场景文法立法面整体搬迁：产生式类型词表、16 条
// 产生式全表（PCG_PRODUCTIONS，缺省权重即文法自然先验）、权重合成
// （pcgBaseWeights / pcgEffectiveWeights：缺省表 ⊕ 合法覆盖）、推导契约
// （GymGrammarOptions / PcgSceneNode / PcgOverlayTruth / PcgStageTruth /
// PcgDerivation / PcgRoundTrace）与文法级课程（updatePcgCurriculum —— POET 式
// 任务-智能体共进化）。行为零变化（纯搬运，逐字节不改）；gym.ts 以再导出保持
// 导入面不变。本件零运行时依赖（仅类型导入）—— 文法是纯立法面，不触碰世界。
import type { GymNoiseSpec } from './gym.noise';
import type { EvidenceLedger } from '../kernel/registry';

// ─── W4-4：PCFG 场景文法立法 ───

/** 屏幕层产生式（侧栏在场与否） */
export type PcgScreenRule = 'screen:sidebar' | 'screen:nosidebar';
/** 主体层产生式（表单/树形/列表/折叠区组） */
export type PcgMainRule = 'main:form' | 'main:tree' | 'main:list' | 'main:collapse';
/** 元素层产生式（场景内的家具元素种类） */
export type PcgElementRule = 'el:button' | 'el:input' | 'el:checkbox' | 'el:link' | 'el:menuItem';
/** 装饰层产生式（无/弹窗/付费陷阱/Cookie横幅/加载遮罩） */
export type PcgDecorRule = 'decor:none' | 'decor:popup' | 'decor:payTrap' | 'decor:cookie' | 'decor:loading';
/** 全部产生式 id（课程权重与推导链的词表） */
export type PcgProductionId = PcgScreenRule | PcgMainRule | PcgElementRule | PcgDecorRule;

/** 一条产生式的立法：id + 家族 + 缺省权重 + 中文注记 */
export interface PcgProductionSpec {
  id: PcgProductionId;
  family: 'screen' | 'main' | 'element' | 'decor';
  weight: number;
  note: string;
}

/**
 * W4-4 桌面场景文法全表（16 条产生式）。缺省权重即文法的「自然先验」——各类
 * 大致均衡、装饰略偏无（简单场景为先）；课程权重（updatePcgCurriculum 的产
 * 出）按此表为基线做 [0.25×, 4×] 的乘性偏置。
 */
export const PCG_PRODUCTIONS: ReadonlyArray<PcgProductionSpec> = [
  { id: 'screen:sidebar', family: 'screen', weight: 1.0, note: '屏幕 → [标题栏, 主体, 侧栏]' },
  { id: 'screen:nosidebar', family: 'screen', weight: 1.0, note: '屏幕 → [标题栏, 主体]（无侧栏）' },
  { id: 'main:form', family: 'main', weight: 1.0, note: '主体 → 表单（网格 3 列，直通前进）' },
  { id: 'main:tree', family: 'main', weight: 1.0, note: '主体 → 树形（网格 2 列，直通前进）' },
  { id: 'main:list', family: 'main', weight: 1.0, note: '主体 → 列表（网格 3 列，直通前进）' },
  { id: 'main:collapse', family: 'main', weight: 1.0, note: '主体 → 折叠区组（目标藏深部，须滚动暴露）' },
  { id: 'el:button', family: 'element', weight: 1.0, note: '元素 → 按钮（可交互，落空不推进）' },
  { id: 'el:input', family: 'element', weight: 0.8, note: '元素 → 输入框（本训练营为展示性文本）' },
  { id: 'el:checkbox', family: 'element', weight: 0.6, note: '元素 → 复选框（展示性文本）' },
  { id: 'el:link', family: 'element', weight: 0.6, note: '元素 → 链接（可交互，落空不推进）' },
  { id: 'el:menuItem', family: 'element', weight: 0.5, note: '元素 → 菜单项（可交互，落空不推进）' },
  { id: 'decor:none', family: 'decor', weight: 1.2, note: '装饰 → 无（干净场景）' },
  { id: 'decor:popup', family: 'decor', weight: 0.8, note: '装饰 → 升级弹窗（中途遮幕，须确认或 Esc）' },
  { id: 'decor:payTrap', family: 'decor', weight: 0.6, note: '装饰 → 付费陷阱（立即支付为破坏性诱饵，须绕开）' },
  { id: 'decor:cookie', family: 'decor', weight: 0.6, note: '装饰 → Cookie 横幅（中途遮幕，须同意）' },
  { id: 'decor:loading', family: 'decor', weight: 0.6, note: '装饰 → 加载遮罩（不遮幕的展示性条带）' },
];

/** 产生式 id 集（文法合法性检验的词表面） */
const PCG_RULE_IDS: ReadonlySet<string> = new Set(PCG_PRODUCTIONS.map(p => p.id));

/** W4-4：缺省权重表（id → weight；防御副本） */
export function pcgBaseWeights(): Record<string, number> {
  const w: Record<string, number> = {};
  for (const p of PCG_PRODUCTIONS) w[p.id] = p.weight;
  return w;
}

/**
 * W4-4：有效权重合成 = 缺省表 ⊕ 合法覆盖（数值有限且 ≥0 才收；垃圾值静默回落
 * 缺省 —— 与全仓防御纪律同律）。纯函数。
 */
export function pcgEffectiveWeights(raw: unknown): Record<string, number> {
  const w = pcgBaseWeights();
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const p of PCG_PRODUCTIONS) {
      const v = (raw as Record<string, unknown>)[p.id];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) w[p.id] = v;
    }
  }
  return w;
}

// ─── W4-4：文法推导契约 ───

/** 文法选项（推导 + 世界铸造的统一入参；全部可缺席） */
export interface GymGrammarOptions {
  /** 产生式权重覆盖（课程权重在此接入；合法值 ⊕ 缺省表） */
  weights?: Partial<Record<PcgProductionId, number>> | Record<string, number>;
  /** 采样温度 β（P ∝ exp(β·w)；缺省 1；非有限回落 1） */
  beta?: number;
  /** 场景难度 1..3（幕数 = 难度 + 2；折叠深度同难度；缺省 1） */
  difficulty?: number;
  /** W1-4 噪声谱（只坏传感器读出，ground truth 分毫不动 —— 诊所律沿用） */
  noise?: GymNoiseSpec;
  /** 实验室证据台账（在场 ⇒ 推导时同步写世界真值入账 —— Θ-3 对账通道） */
  ledger?: EvidenceLedger;
  /** 确定性时钟（真值入账 ts 之源；缺省 ts=0 —— 重放一致） */
  now?: () => number;
}

/**
 * 场景图节点：文法推导的最小产物（标签 + 产生式回链 + 像素几何 + 可交互真值）。
 * 布局在推导期一次铸定（网格/锚定，整数像素）—— 渲染与命中判定共用同一真相。
 */
export interface PcgSceneNode {
  /** 确定性节点 id（幕内路径式：m0-e1 / m0-deadlink / o-dismiss …） */
  id: string;
  /** 产生式回链（产生式 id 或固定家具记号 fixed:* / main:advance / main:collapse:deadlink） */
  rule: string;
  /** 节点种类（titleBar/sidebar/advance/element/deadLink/foldNote/bottomNote/loading/overlayText/overlayDismiss/overlayTrap/banner） */
  kind: string;
  label: string;
  /** 可交互真值（可点 ⇒ true；展示性文本 ⇒ false） */
  interactive: boolean;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 遮罩层真值（弹窗/付费陷阱/Cookie 横幅 —— 中途遮幕，dismiss 前主界面不可达） */
export interface PcgOverlayTruth {
  kind: 'popup' | 'payTrap' | 'cookie';
  /** 遮幕登场幕（进入该幕即遮；恒 ∈ [1, 幕数-2] —— 永不压首末幕） */
  atStage: number;
  /** 遮幕态的全部节点（遮幕态 = 世界唯一可见面 —— 与 popup-maze 同律） */
  nodes: PcgSceneNode[];
  /** 正确解除标签（popup=确认 / payTrap=稍后提醒 / cookie=同意Cookie；Esc 同效） */
  dismissLabel: string;
  /** 破坏性诱饵标签（仅 payTrap 在场：立即支付 —— 宪法 destructive 恒须审批） */
  trapLabel: string | null;
}

/** 一幕的真值：场景图（顶/底视口）+ 前进按钮 + 立法正确动作 */
export interface PcgStageTruth {
  index: number;
  /** 折叠幕（顶视口只见死链预览，须 scroll 暴露底视口真目标） */
  needScroll: boolean;
  /** 前进按钮（非末幕=下一步 / 末幕=完成）—— 点击推进幕序 */
  target: { label: string; bbox: { x0: number; y0: number; x1: number; y1: number } };
  /** 顶视口节点表（折叠幕 = 死链 + 提示；常规幕 = 全量） */
  top: PcgSceneNode[];
  /** 底视口节点表（仅折叠幕非空：滚动后目标入读） */
  bottom: PcgSceneNode[] | null;
  /** 本幕立法正确动作（遮幕/折叠已在前序幕展开 —— 见 correctSequence） */
  correct: { kind: 'click' | 'scroll'; label?: string };
}

/** 一次完整推导：产生式链 + 场景真值 + 正确动作序列 + 目标/判据 + 指纹 */
export interface PcgDerivation {
  seed: number;
  difficulty: number;
  /** 推导链（按选择序：屏幕→主体→装饰→首幕元素……）—— 同 seed 恒同链 */
  chain: PcgProductionId[];
  /** 推导指纹（真值规范形的 fnv1a 十六进制 —— 同 seed 字节级一致的锚） */
  fingerprint: string;
  stages: PcgStageTruth[];
  overlay: PcgOverlayTruth | null;
  goal: string;
  successCriteria: string[];
  /** 全程正确动作序列（遮幕解除 → 滚动暴露 → 前进点击，逐幕展开） */
  correctSequence: Array<{ kind: 'click' | 'scroll'; label?: string }>;
}

/** GymRoundResult 的文法可观测面（缺席 = 四世界旧路径） */
export interface PcgRoundTrace {
  seed: number;
  fingerprint: string;
  stages: number;
  chain: PcgProductionId[];
}

// ─── W4-4：文法级课程（POET 式任务-智能体共进化） ───

/** 一条课程反馈：一次运行的推导链 + 成败（+ 可选惊异 bits） */
export interface PcgCurriculumFeedback {
  chain: ReadonlyArray<string>;
  success: boolean;
  /** 惊异 bits（surpriseSpectrum 谱值复用面；缺席按 0 —— 无惊异的诚实读数） */
  surprise?: number;
}

/**
 * W4-4 文法课程权重更新（确定性、纯函数、绝不抛）：
 *   · 方向律：失败 ⇒ 升权（多练弱项：delta = +lr·(1 + surprise/8)）；成功 ⇒ 缓降
 *     （已掌握让位：delta = −lr·0.5）；链外产生式不动；
 *   · 夹取律：每条产生式权重恒 ∈ [0.25×基线, 4×基线]（永不归零/爆炸）；
 *   · 网格律：1e-6 网格取整（防浮点尾噪累积 —— 权重更新可重放）；
 *   · 防弹：垃圾权重/垃圾反馈静默按缺省/跳过处理，返回全量合法权重表。
 */
export function updatePcgCurriculum(
  weights: unknown,
  feedback: unknown,
  opts?: { learnRate?: number },
): Record<string, number> {
  const base = pcgBaseWeights();
  const w = pcgEffectiveWeights(weights);
  const lrRaw = Number(opts?.learnRate);
  const lr = Number.isFinite(lrRaw) ? Math.min(1, Math.max(0, lrRaw)) : 0.25;
  const list = Array.isArray(feedback) ? feedback : [];
  for (const raw of list) {
    const f = raw !== null && typeof raw === 'object' ? (raw as Partial<PcgCurriculumFeedback>) : null;
    if (!f || typeof f.success !== 'boolean' || !Array.isArray(f.chain)) continue;
    const sRaw = Number(f.surprise);
    const surprise = Number.isFinite(sRaw) ? Math.min(64, Math.max(0, sRaw)) : 0;
    const seen = new Set<string>();
    for (const id of f.chain) {
      if (typeof id !== 'string' || seen.has(id) || !PCG_RULE_IDS.has(id)) continue;
      seen.add(id);
      const b = base[id];
      const delta = f.success ? -lr * 0.5 : lr * (1 + surprise / 8);
      const lo = b * 0.25;
      const hi = b * 4;
      const next = Math.min(hi, Math.max(lo, w[id] * (1 + delta)));
      w[id] = Math.round(next * 1e6) / 1e6;
    }
  }
  return w;
}
