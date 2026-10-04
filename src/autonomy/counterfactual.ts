// src/autonomy/counterfactual.ts
// 纪元 Φ（Φ-9 反事实规划器）：行动前预演 —— 给每个候选动作打「预期进展/信息增益/风险」三围分，择优。
//
// 定位：自主智能环的「沙盘」。Φ-3 裁决出候选动作之后、执行层落地之前，本器官对
// 每个候选做一次反事实推演：若做了它，目标能推进多少（progressProbability）、能
// 让多少「未见过的东西」进入视野（informationGain）、可能捅多大娄子（risk），
// 再按总效用公式择优：
//   U = w_p·progressProbability + w_i·informationGain − w_r·risk
//   （w_p/w_i/w_r 缺省 0.5/0.3/0.2，ScoringContext.weights 可逐项覆盖）
//   择优律：先取 U 最大者；与最大者差 <0.01 视为并列，并列取信息增益高者
//   （同等推进下优先「看见更多」）；信息增益亦并列则取输入次序在前者（全确定性）。
//
// 纪律：纯函数、零网络、零 IO、零运行时依赖 —— 连 policyEngine 的分词也不 import
// （自带中文 2-gram + 英文单词的轻量重合打分副本）；对一切脏输入卫兵式收敛，
// 绝不抛异常；空候选集不伪造计划，如实返回 null。
//
// W3-6（H3 反事实岔路卡 · Ghost Replay 纠偏）增量：
//   · rankTopK —— Top-K 候选排序出口（含诚实预测效用）：既有实现择优后即弃
//     全部落选者，是效用账的浪费；岔路账（src/branchCards.ts）按 Top-3 落盘，
//     goal 失败/中止后铸岔路卡供用户一键换支重放。rank 1 与 scoreOptions 的
//     chosen 严格同律（同一择优引擎逐名抽取），效用账面恒为诚实预测值。
//   · ScoringContext.preferredActionKeys —— 改选偏置注入缝：换支重放期间把
//     「改选候选 k」的签名注入此缝，被命中候选的择优效用获得决定性加成
//     （STEER_BIAS_UTILITY，见其注释的值即边界论证）；偏置只改选择，绝不
//     进 rawU —— 效用账（rankTopK.utility / 岔路账 / 落选理由的原始数值）
//     永远是未偏置的诚实预测。无偏置时本模块行为与既有测试逐字节一致。
import type { PolicyAction } from './policyEngine';
import type { SnapshotElement, WorldSnapshot } from './worldSnapshot';
// W6-1（doctor 债清偿·smell.over-engineering）：内部纯函数工具区与配套常量
// （分词/重合打分/风险映射/先验/效果推导/权重卫兵）逐字节搬至 ./counterfactualUtil —— 纯函数零状态，导入面不变。
import {
  DEFAULT_WEIGHTS, RISK_SCORES, RISK_UNKNOWN, clamp01, deriveEffects, elementsOf,
  normalizeText, progressPrior, resolveWeights, riskOf, round2, targetLabelRaw,
} from './counterfactualUtil';

// ─── 契约类型（Φ-9 行动沙盘词汇表） ───

/** 一个候选动作的反事实预演结果 —— 三围分 + 从快照推导的预期效果清单 */
export interface CounterfactualOption {
  action: PolicyAction;
  /** 预期效果清单（元素 label/滚动/弹窗消失等，从快照推导） */
  predictedEffects: string[];
  /** 0..1：与目标关键词的语义重合度 */
  progressProbability: number;
  /** 0..1：该动作能让「未见过的东西」进入视野的概率 */
  informationGain: number;
  /** 0..1：benign=0.05 sensitive=0.5 destructive=1 */
  risk: number;
}

/** 一次反事实规划的产出：胜者 + 全部落选者（各带一句中文落选理由） */
export interface CounterfactualPlan {
  chosen: CounterfactualOption;
  rejected: Array<{ option: CounterfactualOption; why: string }>;  // 一句中文
}

/** 评分上下文 —— 目标关键词、世界快照、已试动作签名与效用权重（全可缺席） */
export interface ScoringContext {
  goalKeywords: string[];
  snapshot: WorldSnapshot;
  /** 已试过动作签名清单（kind+target label 归一），重复者降权 */
  triedActionKeys?: string[];
  /** 默认 0.5/0.3/0.2 */
  weights?: { progress?: number; info?: number; risk?: number };
  /** W3-6（H3 换支重放）：改选偏置注入缝 —— 命中签名的候选在**择优**中获得
   *  STEER_BIAS_UTILITY 决定性加成（branchCards.applyBranchChoice 的 bias 载荷
   *  经 withSteerBias 铸入此处）。偏置只改选择，不进 rawU（效用账保持诚实）；
   *  缺席/空 ⇒ 行为与既有语义逐字节一致（向后兼容）。 */
  preferredActionKeys?: string[];
}

// ─── 常量 ───

/** 并列判定阈值：总效用差小于此值视为并列，取信息增益高者 */
const TIE_EPSILON = 0.01;
/**
 * W3-6（H3 换支重放）：改选偏置的择优效用加成。值即边界论证：三围 ∈ [0,1]、
 * 权重逐项夹 [0,1] ⇒ 诚实效用 U = w_p·p + w_i·i − w_r·r ∈ [−1, 2]，任意两候选
 * 的最大效用差严格小于 3；加成 3.5 > 3 ⇒ 只要被偏置候选在场，择优必被其决定
 * （偏好决定性 —— 「改选候选 k」的语义就是 k 被重放决策采纳）。偏置只进择优
 * 用力，绝不进 rawU：效用账面（rankTopK 的 utility、岔路账、落选理由数值）
 * 永远是未偏置的诚实预测。
 */
const STEER_BIAS_UTILITY = 3.5;
/**
 * W3-6（H3）：Top-K 排序的缺省深度 —— 岔路卡的三候选（Top-3）。
 * 值即边界：三支岔路覆盖「原路 + 两条最有竞争力的替代路」，再深则边际信息
 * 递减而卡面噪声明升（steer 一键三选的交互上限）。
 */
export const DEFAULT_TOP_K = 3;
/** actionSignature 截断上限（字符数） */
const SIGNATURE_MAX = 60;
/** 空快照兜底 —— ctx.snapshot 缺席/脏值时的合成替身（零证据不伪造） */
const EMPTY_SNAPSHOT: WorldSnapshot = {
  takenAt: 0,
  width: 0,
  height: 0,
  dhash: null,
  elements: [],
  textDigest: '',
  popups: [],
  focusedRegion: null,
  sceneLabel: '',
  degraded: [],
};
// ─── 导出纯函数 ───

// ── W3-6（H3）：评分内核与择优律的共享底座（scoreOptions / rankTopK 同源）──

/** 评分内核的单条产出：诚实效用 rawU + 改选偏置标记 + 择优效用 utility */
interface ScoredEntry {
  option: CounterfactualOption;
  /** 输入序（确定性平手序的最终仲裁） */
  index: number;
  /** 诚实预测效用（未含 W3-6 改选偏置 —— 效用账面） */
  rawU: number;
  /** 本候选是否被改选偏置命中 */
  steered: boolean;
  /** 择优效用 = rawU + (steered ? STEER_BIAS_UTILITY : 0)（只用于排序/择优） */
  utility: number;
}

/**
 * 评分内核（W3-6 从 scoreOptions 提取的共享底座，语义零变更）：
 * 三围计分律与原实现逐条相同（重复折价 / tried click 信息 0.1 / 风险映射），
 * 唯一增量是改选偏置 —— preferredActionKeys 命中者择优效用加 STEER_BIAS_UTILITY。
 */
function scoreAll(actions: PolicyAction[], c: Partial<ScoringContext>): ScoredEntry[] {
  const snapshot =
    c.snapshot && typeof c.snapshot === 'object' ? (c.snapshot as WorldSnapshot) : EMPTY_SNAPSHOT;
  const goalKeywords = Array.isArray(c.goalKeywords)
    ? (c.goalKeywords.filter(k => typeof k === 'string') as string[])
    : [];
  const tried = new Set(
    Array.isArray(c.triedActionKeys) ? (c.triedActionKeys.filter(k => typeof k === 'string') as string[]) : [],
  );
  // W3-6：改选偏置集合（空串剔除 —— 空签名会误伤无标签动作）
  const preferred = new Set(
    Array.isArray(c.preferredActionKeys)
      ? (c.preferredActionKeys.filter(k => typeof k === 'string' && k !== '') as string[])
      : [],
  );
  const w = resolveWeights(c.weights);

  return actions.map((action, index) => {
    const isTried = tried.has(actionSignature(action));
    const progress = clamp01(progressPrior(action, goalKeywords) * (isTried ? 0.6 : 1));
    const informationGain =
      action.kind === 'click' && isTried ? 0.1 : clamp01(expectedInformationGain(action, snapshot));
    const risk = riskOf(action.riskTier);
    const option: CounterfactualOption = {
      action,
      predictedEffects: deriveEffects(action, snapshot),
      progressProbability: progress,
      informationGain,
      risk,
    };
    const rawU = w.progress * progress + w.info * informationGain - w.risk * risk;
    const steered = preferred.size > 0 && preferred.has(actionSignature(action));
    return { option, index, rawU, steered, utility: rawU + (steered ? STEER_BIAS_UTILITY : 0) };
  });
}

/**
 * 择优律本体（W3-6 提取，与既有 scoreOptions 内联实现逐字节同律）：
 * 先取择优效用最大者；与最大者差 < TIE_EPSILON 视为并列，并列取信息增益高者；
 * 信息增益亦并列取输入次序在前者 —— 全确定性、可回放。
 */
function pickWinner(entries: ScoredEntry[]): ScoredEntry {
  let bestU = Number.NEGATIVE_INFINITY;
  for (const s of entries) if (s.utility > bestU) bestU = s.utility;
  const contenders = entries.filter(s => bestU - s.utility < TIE_EPSILON);
  let winIdx = 0;
  for (let i = 1; i < contenders.length; i += 1) {
    if (contenders[i].option.informationGain > contenders[winIdx].option.informationGain) winIdx = i;
  }
  return contenders[winIdx];
}

/**
 * 动作签名（纯函数、绝不抛异常）：`${kind}:${normalize(target.label)}` 截 60 字符。
 * 归一律 = 小写化 + 连续空白折叠单空格 + 去首尾；无 target 的动作 label 记空串
 * （如 'scroll:' —— 方向不参与签名，同向异向视为同族）。脏动作（null/非对象）⇒ ''。
 * triedActionKeys 清单与其同律生成，方能对得上号。
 */
export function actionSignature(action: PolicyAction): string {
  if (action === null || action === undefined || typeof action !== 'object') return '';
  const a = action as Partial<PolicyAction>;
  const kind = typeof a.kind === 'string' ? a.kind : '';
  const sig = `${kind}:${normalizeText(targetLabelRaw(a))}`;
  return sig.length > SIGNATURE_MAX ? sig.slice(0, SIGNATURE_MAX) : sig;
}

/**
 * 信息增益先验（纯函数、绝不抛异常）：该动作能让「未见过的东西」进入视野的概率。
 *   scroll ⇒ 0.8（新视野是最稳的信息源）；inspect ⇒ 0.7（放大细察现视野的盲区）；
 *   ask_vlm ⇒ 0.6（云脑整屏观察补盲）；
 *   click ⇒ 0.3 起：target.label 归一后未恒等见于快照 elements 任一 label（陌生
 *   目标）⇒ +0.1 = 0.4 —— 快照账本之外的东西多半牵出新界面；无标签目标无陌生度
 *   可谈，仍 0.3；
 *   declare / escalate / wait ⇒ 0（既不动视野也不动世界）；
 *   其余种类（type/hotkey/drag/recall_skill）⇒ 0.2（中性先验）。
 * 「已试过」的折价（tried click ⇒ 0.1）由 scoreOptions 执法 —— 本函数只看动作与
 * 世界快照本身，不携带行动史。
 */
export function expectedInformationGain(action: PolicyAction, snapshot: WorldSnapshot): number {
  const a = action as Partial<PolicyAction> | null | undefined;
  if (a === null || a === undefined || typeof a !== 'object') return 0;
  switch (a.kind) {
    case 'scroll':
      return 0.8;
    case 'inspect':
      return 0.7;
    case 'ask_vlm':
      return 0.6;
    case 'click': {
      const label = normalizeText(targetLabelRaw(a));
      if (label === '') return 0.3;
      const known = elementsOf(snapshot).some(
        el => normalizeText((el as Partial<SnapshotElement>)?.label) === label,
      );
      return known ? 0.3 : 0.4;
    }
    case 'declare':
    case 'escalate':
    case 'wait':
      return 0;
    default:
      return 0.2;
  }
}

/**
 * 反事实评分主入口（纯函数、绝不抛异常）。
 *
 * 三围计分律：
 *  · progressProbability（与目标关键词的语义重合度，0..1）：
 *    - click / declare ⇒ 目标关键词与动作文本（target.label，空标签回退
 *      expectedEffect）的重合率 = |目标词 ∩ 动作词| / |目标词|（自带中文 2-gram +
 *      英文单词分词，去停用词/纯数字；目标词为空 ⇒ 0）；
 *    - scroll / inspect ⇒ 0.25（探索性固定先验）；ask_vlm ⇒ 0.35；
 *      escalate ⇒ 0.1；recall_skill ⇒ 0.5；
 *    - 其余种类（type/hotkey/drag/wait）⇒ 0.2（保守中性先验）；
 *    - 已试过（actionSignature ∈ triedActionKeys）⇒ progressProbability ×0.6
 *      （重复折价，对一切种类生效）。
 *  · informationGain（让「未见过的东西」进入视野的概率，0..1）：先验见
 *    expectedInformationGain 的 JSDoc；scoreOptions 额外执法 —— 已试过的 click
 *    ⇒ 0.1（重复点同一处，再见新物的概率骤降；其余种类不因 tried 折信息分）。
 *  · risk（0..1）：按 riskTier 映射 benign=0.05 / sensitive=0.5 / destructive=1，
 *    未知分层按 0.5 保守记。
 *
 * 总效用与择优律：
 *   U = w_p·progressProbability + w_i·informationGain − w_r·risk
 *   （w_p/w_i/w_r 缺省 0.5/0.3/0.2，ctx.weights 逐项覆盖，非有限数按缺省记）；
 *   先取 U 最大者；与最大者差 <0.01 视为并列，并列取 informationGain 高者；
 *   信息增益亦并列取输入次序在前者 —— 全确定性、可回放。
 *   W3-6（H3）注入缝：ctx.preferredActionKeys 命中的候选在择优中获得
 *   STEER_BIAS_UTILITY 决定性加成（换支重放的「改选候选 k」偏置）—— 偏置只
 *   改选择，rawU 与落选理由的数值仍是诚实预测；缝缺席时本函数行为与既有
 *   语义逐字节一致。
 *
 * 防御律：options 非数组或滤除脏条目（null/非对象）后为空 ⇒ 返回 null（空输入不
 * 伪造计划）；ctx / ctx.snapshot / goalKeywords 脏值按空上下文（空快照 + 零关键
 * 词）处理。rejected 按输入次序收录全部落选者，各带一句中文理由。
 */
export function scoreOptions(options: PolicyAction[], ctx: ScoringContext): CounterfactualPlan | null {
  const raw = Array.isArray(options) ? options : [];
  const actions = raw.filter(a => a !== null && a !== undefined && typeof a === 'object') as PolicyAction[];
  if (actions.length === 0) return null;

  const scored = scoreAll(actions, (ctx ?? {}) as Partial<ScoringContext>);
  const winner = pickWinner(scored);

  const rejected = scored
    .filter(s => s !== winner)
    .map(s => ({
      option: s.option,
      why: winner.steered
        // W3-6：胜者由改选偏置提升 ⇒ 落选理由如实申报偏置在场，数值用诚实 rawU
        ? `用户改选偏置将「${actionSignature(winner.option.action)}」定为胜者（其原始总效用 ${round2(winner.rawU)}，本候选 ${round2(s.rawU)}；偏置只改选择，不改预测）`
        : winner.utility - s.utility < TIE_EPSILON
          ? `总效用 ${round2(s.utility)} 与胜者 ${round2(winner.utility)} 并列（差 <0.01），信息增益 ${round2(s.option.informationGain)} 较低而落选`
          : `总效用 ${round2(s.utility)} 低于胜者 ${round2(winner.utility)}（进展 ${round2(s.option.progressProbability)}/信息 ${round2(s.option.informationGain)}/风险 ${round2(s.option.risk)}）`,
    }));

  return { chosen: winner.option, rejected };
}

// ─── W3-6（H3 反事实岔路账）：Top-K 排序出口 ───

/** Top-K 排序的单条产出：候选 + 诚实预测效用 + 偏置标记 + 名次（1 起） */
export interface RankedCounterfactual {
  /** 名次（1 起；rank 1 ≡ scoreOptions 的 chosen —— 同一择优引擎） */
  rank: number;
  option: CounterfactualOption;
  /** 诚实预测效用（未含改选偏置 —— 岔路账的效用账面） */
  utility: number;
  /** 本名次是否被改选偏置提升（偏置在场时的审计标记） */
  steered: boolean;
}

/**
 * W3-6（H3）：Top-K 候选排序（纯函数、绝不抛异常；空候选集 ⇒ null 不伪造）。
 *
 * 排序律与择优律同源（同一 scoreAll 内核 + pickWinner 逐名抽取）：每轮在剩余
 * 候选中按「择优效用最大 → ε 并列取信息增益高 → 最早输入序」抽出一名，抽满
 * k 名或候选耗尽为止 ⇒ rank 1 与 scoreOptions(同输入).chosen 严格一致（择优
 * 单点 = 排序序列的头部，效用账与决策账互证）。
 *
 * 效用纪律：utility 字段恒为 rawU（诚实预测，未含 STEER_BIAS）；改选偏置只
 * 影响**名次**（被偏置者升到 rank 1），不污染账面 —— 岔路卡展示给用户的是
 * 未偏置的预测值，重放后的复盘与原决策可直接对照。
 *
 * 防御律：options 非数组 / 滤脏后为空 ⇒ null；k 非法（非有限数）⇒ 缺省
 * DEFAULT_TOP_K，<1 夹 1；ctx 脏值按空上下文处理（与 scoreOptions 同律）。
 */
export function rankTopK(
  options: PolicyAction[],
  ctx: ScoringContext,
  k?: number,
): RankedCounterfactual[] | null {
  const raw = Array.isArray(options) ? options : [];
  const actions = raw.filter(a => a !== null && a !== undefined && typeof a === 'object') as PolicyAction[];
  if (actions.length === 0) return null;
  const depth = typeof k === 'number' && Number.isFinite(k) ? Math.max(1, Math.floor(k)) : DEFAULT_TOP_K;

  const remaining = scoreAll(actions, (ctx ?? {}) as Partial<ScoringContext>);
  const ranked: RankedCounterfactual[] = [];
  while (ranked.length < depth && remaining.length > 0) {
    const winner = pickWinner(remaining);
    ranked.push({ rank: ranked.length + 1, option: winner.option, utility: winner.rawU, steered: winner.steered });
    remaining.splice(remaining.indexOf(winner), 1);
  }
  return ranked;
}
