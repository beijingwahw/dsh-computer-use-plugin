// src/prophecy/index.ts
// 纪元 Ε（预言引擎）：自主环的动作前预言 + 动作后对账 —— 可审计的 Dyna 旁路。
//
// 立意（世界级 novelty）：业界 agent 全部「先做后看」；Dyna-Think 类研究停在
// 提示词层面。Ε 给自主环装上**可审计的预言引擎**：每个动作执行前，世界模型按
// (当前屏型, 动作键) 铸预言（期望下一屏型 + 转移概率）；执行后对账 —— 预言
// 命中/失手/模型无知三态入账，失手的惊异差值入册。agent 的世界观第一次有了
// 「考试」：每个动作都是一次预言测验，错题本（最常失手的 (屏型,动作) TopK）
// 自动生成。
//
// 与 D-7 预测编码回路的分工：知识管线里 surprise 先于 observe（先测误差再入账，
// 那是学习回路）；本模块是**审计回路** —— 只读地考世界模型（predict 读面 +
// surprise 读面），考完经 observe 把真实转移回灌（Dyna 式：真实经验喂模型，
// 模型逐步走出无知），但绝不反过来影响动作选择。运行层铁律：预言是纯审计
// 旁路 —— 任何故障只丢预言，绝不抛异常、绝不阻断动作、绝不伪造结算。
//
// 诚实三律（与 worldModel 同源）：
//   1. 模型无该转移 ⇒ outcome 'no-model'（诚实的无知，不是均匀分布的伪装）；
//   2. 执行后屏型取不到 ⇒ 预言挂起，60s 后诚实作废（expired 计数）——
//      绝不伪造 actualType，绝不把失明结算成真空屏；
//   3. 结算前有预言的记录 outcome='pending'（铸而未验）—— 账本与统计面
//      只见 hit/miss/no-model 三态终值，pending 绝不入账。
//
// 异常诚实铁律：本模块一切公开面永不抛异常（坏模型 throw 全吸收 ⇒ 按无知识
// 处理；坏参数 ⇒ 域外拒绝式静默吸收）。
import type { TransitionPrediction, WorldModel } from '../knowledge/contracts';
import { InMemoryWorldModel } from '../knowledge/worldModel';

// ─── 算法形状字面量（出册常数） ───

/** 账本环形容量（条）：错题本的物理上限 —— 审计史是滚动窗，不是无限账 */
const LEDGER_CAPACITY = 500;
/** 容量夹取上限（防注入式爆内存：账本是旁路，不值得无界） */
const CAPACITY_MAX = 10_000;
/** 挂起预言的诚实作废时限（ms）：60s 内取不到真实下一屏型 ⇒ 作废（绝不伪造） */
const PENDING_TTL_MS = 60_000;
/**
 * 有界 keyed pending 缺省槽数（ΑΩ-R18）：闭环 mint→settle 严格交替（单槽即
 * 足），富余只兜并发/跨 run 边界的滞留铸造 —— 8 槽 ≈ 8 条并发 run 的在途预
 * 言，是「审计丢件有痕」与「挂起集有界」的折中。
 */
const PENDING_SLOTS = 8;
/** 挂起槽数夹取上限（防注入式爆内存：挂起集与账本同律不值得无界） */
const PENDING_SLOTS_MAX = 64;

/** 预言结算三态 + 铸造暂态（pending 只存在于铸造与结算之间，绝不入账） */
export type ProphecyOutcome = 'hit' | 'miss' | 'no-model' | 'pending';

// ─── D-G2 细化（W8 第 2 批）：屏型身份粗层桥 + 惊异喂养通道 ───
//
// 台账原文（DEBTS D-G2）：「屏型身份用 dhash 指纹（粒度粗于世界模型聚类 ⇒
// no-model 偏多——诚实但待细化）+ 惊异喂 EvolutionEngine 通道未接」。两处细化：
//   1. 身份桥：闭环屏型身份是整幅 dhash 指纹（hex 方言）—— 像素级抖动（光标
//      闪烁/任务栏时钟/广告位轮换）翻掉任意比特 ⇒ 新指纹 ⇒ 转移表精确键查无
//      ⇒ no-model 偏多。细化 = 铸造时精确键优先、无证据则粗层回退一问（dhash
//      前 8 hex 字 = 上 32 位梯度的汇聚格）；结算回灌双写（精细格 + 粗格，
//      粗格只粗化 from 侧 —— to 侧保持精细身份，结算比对 fine↔fine 方言不串）。
//      非 hex / 短于前缀的屏型（世界模型聚类 id 'screen-12' 等）不经此桥 ——
//      旧方言逐字节零漂移。粗层预言在记录上诚实标注 predictedVia:'coarse'
//      （统计面 coarseAssisted 可观测 —— 回退的收益不掺水分）。
//   2. 惊异喂养：错题本的消费面 —— 失手记录（含惊异 bits）经结构性端口
//      surpriseFeed.ingest 喂给进化引擎（EvolutionEngine 结构性满足，与
//      sleep/dreamReplay 的 DreamEvolutionLike 同律；autonomy 栈侧接线属
//      autonomy 产权域，本模块只出通道与执法面）。
//
// ─── ΑΩ-R18 两修：量化屏型主键 + 有界 keyed pending ───
//
// R18-1 屏型键过细：D-G2 之后 mint 主键仍是原始 64 位 dhash（几乎每屏唯一 ⇒
//   精确通道的转移证据每指纹至多一笔、永不再逢 ⇒ 预言结构性 no-model、命中
//   率趋零）。修法：主键改量化屏型 —— quantizedScreenType（internal.ts）：恰
//   16 hex 字的 dhash 保留上 12 字、低 16 位（dhash 网格下 2 行 = 屏幕下 1/4
//   条带 —— 任务栏时钟/托盘动画等抖动正源）掩没为 '0'。铸造梯级三层：
//   原始指纹（predictedVia:'exact'，字节级复现）→ 量化格（'quant'，抖动吸收
//   主力）→ D-G2 粗格（'coarse'，上 32 位回退）—— 层级序 exact > quant >
//   coarse 恒成立（档位夹取 [8,16]，16 = 关量化回到旧行为；内核键
//   'prophecy.quantKeepHex' 可调）。结算回灌三写 {原始, 量化, 粗格}（去重），
//   目的地一律量化身份入表 ⇒ 结算比对 predictedType === 量化(actual) 两侧键
//   粒度恒一致（不 fine↔coarse 串味）；记录上的 screenType/actualType 保持
//   原始精细身份（见证不粗化）。stats/错题本/惊异语义不动（coarseAssisted
//   仍只计粗层 —— 量化层收益不掺进粗层账）。
// R18-2 单条 pending 覆盖：mint 的挂起原是单槽 —— 并发/跨 run 边界的铸造静默
//   覆盖未结算预言（审计丢件无痕）。修法：有界 keyed pending（按铸造序 Map，
//   缺省 8 槽、可注入夹 [1,64]）：结算配对最近铸造（LIFO —— 结算见证恒属最近
//   执行的动作，早铸预言不被后来者顶掉）；容量溢出最旧作废、TTL 60s 超时作废
//   两者同律计入 expired（作废绝不伪造结算 —— 铁律不动）。

/** 一条预言的完整生命（铸造 ⇒ 结算）：账本里的最小审计单元 */
export interface ProphecyRecord {
  /** 铸造时的屏型身份（闭环语境 = 快照 dhash 指纹） */
  screenType: string;
  /** 动作键（prophecyActionKey 的方言：kind 或 kind@量化区域） */
  actionKey: string;
  /** 预言的期望下一屏型（无历史 ⇒ 缺席 —— 诚实无知） */
  predictedType?: string;
  /** 预言的转移概率（predict 首名概率） */
  predictedProb?: number;
  /**
   * 预言来源层：'exact' 原始指纹字节级复现 / 'quant' 量化格（ΑΩ-R18 主键层，
   * 低 16 位抖动吸收主力）/ 'coarse' D-G2 粗层回退键；缺席 = 旧记录
   */
  predictedVia?: 'exact' | 'quant' | 'coarse';
  /** 结算惊异差值（bits）：模型对实际到达的平滑惊讶 —— 命中小、失手大 */
  surpriseBits?: number;
  /** 结算判定：hit 命中 / miss 失手 / no-model 模型无知（pending = 铸而未验） */
  outcome: ProphecyOutcome;
  /** 实际到达的屏型（结算见证；挂起/作废 ⇒ 缺席） */
  actualType?: string;
  /** 铸造时刻（注入时钟） */
  ts: number;
}

/** 统计面（错题本）：账本的聚合读数 */
export interface ProphecyStats {
  /** 已结算入账条数（≤ 容量） */
  settled: number;
  /** 命中数（有预言且言中） */
  hits: number;
  /** 失手数（有预言而不符） */
  misses: number;
  /** 模型无知数（无历史直通） */
  noModel: number;
  /** 命中率 = hits/(hits+misses)（有预言的分母；no-model 不掺水；无 ⇒ 0） */
  hitRate: number;
  /** 失手率 = misses/(hits+misses)（同上口径） */
  missRate: number;
  /** 失手平均惊异 bits（无失手 ⇒ 0） */
  avgMissSurpriseBits: number;
  /** 粗层助攻数（D-G2）：predictedVia='coarse' 的已结算预言 —— 粗格让抖动变体免于无知 */
  coarseAssisted: number;
  /** 错题本：最常失手的 (屏型, 动作) TopK（count 降序、键字典序破平 —— 确定序） */
  topMisses: Array<{ screenType: string; actionKey: string; count: number }>;
}

/** 账本快照（dump/restore 的序列化真相） */
export interface ProphecyLedgerSnapshot {
  version: 1;
  /** 已结算记录（入账序） */
  records: ProphecyRecord[];
  /** 挂起作废累计数 */
  expired: number;
}

/**
 * 闭环消费面（结构性端口）：真实 ProphecyEngine 天然满足，测试桩只须实现
 * 同名两面（与 PolicyPort/ConstitutionPort/SelfModelPort 同律）。
 */
export interface ProphecyPort {
  /** 动作执行前铸预言（屏型指纹缺席 ⇒ 不铸 —— 盲屏不可预言） */
  mint(screenType: string | null | undefined, actionKey: string): void;
  /** 动作执行后拿真实下一屏型结算；返回结算记录（null = 无待结算/仍挂起） */
  settle(actualType: string | null | undefined, success?: boolean): ProphecyRecord | null;
}

// W6-2（doctor smell.over-engineering 清偿）：内部纯工具已分区提取至 internal.ts
// （行为零变化；PROB_EPSILON 随迁 —— 仅 settleSurpriseBits 消费）。
// ΑΩ-R18：屏型量化/粗层方言（quantizedScreenType/coarseScreenType）定义于
// internal.ts（惊异读面的层级匹配需要它们，值定义在 internal 内避免值环）；
// 此处消费 + 再分发 —— 公开导入面与 W8 逐字节不变。
import {
  nonEmptyStr, safeNow, shortId, resultValue, settleSurpriseBits,
  coarseScreenType, quantizedScreenType,
} from './internal';
export {
  coarseScreenType, COARSE_PREFIX_HEX,
  quantizedScreenType, QUANT_KEEP_HEX, QUANT_MIN_KEEP_HEX, QUANT_MAX_KEEP_HEX,
  PROPHECY_QUANT_KERNEL_KEY,
  // ΝΩ-11：惊异夹帽（错题本排序防单条拉爆）—— 常量与夹取函数随迁公开面
  SURPRISE_MAX_BITS, clampSurpriseBits,
} from './internal';

// ─── 铸造与结算（纯函数面） ───

/**
 * 铸预言（纯函数，永不抛）：按 (屏型, 动作键) 问世界模型 predict 读面。
 *   · 无历史 / 模型缺席 / 模型抛错 / 坏形状 ⇒ outcome 'no-model'（诚实无知，
 *     绝不把「没见过」伪装成任何预测）；
 *   · 有历史 ⇒ 取分布首名（typeId + prob），outcome 'pending'（铸而未验 ——
 *     三态终值只由 settleProphecy 落锤）。
 *   · ΑΩ-R18 三层梯级（细 → 粗，先到先得，来源层如实入账）：
 *       ① 原始指纹（'exact'）—— 字节级复现的旧通道（非 hex 方言的唯一通道，
 *          旧方言零漂移）；
 *       ② 量化格（'quant'）—— quantizedScreenType：dhash 低 16 位（屏幕下
 *          1/4 条带抖动正源）掩没 ⇒ 同场景抖动变体命中同键（R18 主诉的
 *          结构性修法）；
 *       ③ 粗格（'coarse'）—— D-G2 coarseScreenType（上 32 位）回退。
 *     各层查无 ⇒ 仍诚实 no-model。非 hex 屏型三键合一 ⇒ 逐字节旧路径。
 * @param ts 铸造时刻（缺省 Date.now —— 引擎注入闭环时钟）
 */
export function mintProphecy(
  worldModel: WorldModel | null | undefined,
  screenType: string,
  actionKey: string,
  ts?: number,
): ProphecyRecord {
  const t = typeof ts === 'number' && Number.isFinite(ts) ? ts : Date.now();
  const s = nonEmptyStr(screenType) ? screenType : String(screenType ?? '');
  const k = nonEmptyStr(actionKey) ? actionKey : String(actionKey ?? '');
  const base = { screenType: s, actionKey: k, ts: t };
  const ask = (key: string): { typeId: string; prob?: number } | null => {
    try {
      if (!worldModel || typeof worldModel.predict !== 'function' || !nonEmptyStr(key) || !nonEmptyStr(k)) {
        return null;
      }
      const pred = resultValue<TransitionPrediction | null>(worldModel.predict(key, k));
      const nextTypes = pred && Array.isArray((pred as TransitionPrediction).nextTypes)
        ? (pred as TransitionPrediction).nextTypes
        : [];
      const top = nextTypes[0] as { typeId?: unknown; prob?: unknown } | undefined;
      if (!top || !nonEmptyStr(top.typeId)) return null;
      const hit = { typeId: String(top.typeId) };
      if (typeof top.prob === 'number' && Number.isFinite(top.prob)) {
        (hit as { prob?: number }).prob = Math.min(1, Math.max(0, top.prob));
      }
      return hit;
    } catch {
      return null; // 模型故障 = 无知识（诚实吞掉，绝不炸，绝不伪造）
    }
  };
  // ΑΩ-R18：梯级去重（量化格与原始键相同时不重问；粗格亦然 —— 键相同即同格）
  const quant = quantizedScreenType(s);
  const coarse = coarseScreenType(s);
  const tiers: Array<{ key: string; via: 'exact' | 'quant' | 'coarse' }> = [{ key: s, via: 'exact' }];
  if (quant !== s) tiers.push({ key: quant, via: 'quant' });
  if (coarse !== s && coarse !== quant) tiers.push({ key: coarse, via: 'coarse' });
  for (const tier of tiers) {
    const hit = ask(tier.key);
    if (hit !== null) {
      const rec: ProphecyRecord = { ...base, predictedType: hit.typeId, predictedVia: tier.via, outcome: 'pending' };
      if (typeof hit.prob === 'number') rec.predictedProb = hit.prob;
      return rec;
    }
  }
  return { ...base, outcome: 'no-model' };
}

/**
 * 结预言（纯函数，永不抛）：命中律三态落锤。
 *   · ΑΩ-R18 键粒度两侧一致：比对一律经量化折算 —— predictedType ===
 *     quantizedScreenType(actualType) ⇒ 'hit'。引擎回灌的目的地恒为量化身份
 *     （见 ProphecyEngine.settle 三写），预言侧与见证侧在同一把量化尺上对账
 *     （不得 fine↔coarse 串味）；非 hex 方言量化恒等 ⇒ 逐字节旧判律。记录上
 *     的 actualType 保持原始精细见证（只作记录，比对经折算）。
 *   · 有预言而不符 ⇒ 'miss' + 惊异差值（settleSurpriseBits 口径 —— 同按来源
 *     层对键、目的地量化，读写同方言）；
 *   · 无预言（no-model 铸造）⇒ 直通 —— 无知就是无知，actualType 只作见证记录。
 * actualType 非非空字符串 ⇒ 原样直通（不结算 —— 挂起由引擎的 60s 作废律收口，
 * 绝不在这里伪造见证）。返回结算后的**新记录**（入参不可变）。
 */
export function settleProphecy(
  record: ProphecyRecord,
  actualType: string,
  worldModel?: WorldModel | null,
): ProphecyRecord {
  try {
    if (!record || typeof record !== 'object') return record; // 垃圾记录直通
    if (!nonEmptyStr(actualType)) return record; // 无真实见证 ⇒ 不结算
    const out: ProphecyRecord = { ...record, actualType };
    if (!nonEmptyStr(out.predictedType)) {
      out.outcome = 'no-model'; // 直通：模型无知
      return out;
    }
    if (out.predictedType === quantizedScreenType(actualType)) {
      out.outcome = 'hit';
      out.surpriseBits = settleSurpriseBits(out, actualType, 'hit', worldModel);
      return out;
    }
    out.outcome = 'miss';
    out.surpriseBits = settleSurpriseBits(out, actualType, 'miss', worldModel);
    return out;
  } catch {
    return record; // 结算绝不抛（运行层铁律）
  }
}

/**
 * 动作键方言（纯函数，永不抛）：PolicyAction → 世界模型转移表的键。
 * 指针动作 ⇒ kind + 量化区域（'click@22'）—— 与 worldModel.transitionActionKey
 * 的 TYPE_QUANTIZE=4 同门方言（「在什么样的屏上点哪个区」，精确坐标是噪声、
 * 区域是信号）；落点先从快照像素折算归一化（闭环坐标是像素，D-7 是归一化 ——
 * 折算在此收口）。无落点/坏几何 ⇒ kind 本身。
 */
export function prophecyActionKey(
  action: { kind?: unknown; target?: unknown } | null | undefined,
  refWidth?: number,
  refHeight?: number,
): string {
  try {
    const kind =
      action && typeof action === 'object' && nonEmptyStr(action.kind) ? String(action.kind) : 'unknown';
    const target = action && typeof action === 'object' ? (action as { target?: unknown }).target : null;
    const center = target && typeof target === 'object' ? (target as { center?: unknown }).center : null;
    const cx = center && typeof center === 'object' ? (center as { x?: unknown }).x : undefined;
    const cy = center && typeof center === 'object' ? (center as { y?: unknown }).y : undefined;
    const hasGeom =
      typeof refWidth === 'number' && Number.isFinite(refWidth) && refWidth > 0 &&
      typeof refHeight === 'number' && Number.isFinite(refHeight) && refHeight > 0;
    if (typeof cx === 'number' && Number.isFinite(cx) && typeof cy === 'number' && Number.isFinite(cy) && hasGeom) {
      const nx = Math.min(1, Math.max(0, cx / refWidth!));
      const ny = Math.min(1, Math.max(0, cy / refHeight!));
      const qx = Math.min(3, Math.max(0, Math.floor(nx * 4)));
      const qy = Math.min(3, Math.max(0, Math.floor(ny * 4)));
      return `${kind}@${qx}${qy}`;
    }
    return kind;
  } catch {
    return 'unknown'; // 键铸造绝不抛
  }
}

/**
 * 步 journal 注记（一行，纯函数）：`prophecy:hit|miss|no-model（…）` ——
 * 闭环唯一的留痕差量（不扩 StepRecord 字段结构）。指纹截 16 字符（Token 纪律，
 * 全量身份留在账本）。
 */
export function prophecyJournalTag(record: ProphecyRecord): string {
  try {
    const cell = `${shortId(record.screenType)}|${record.actionKey}`;
    const to = nonEmptyStr(record.actualType) ? shortId(String(record.actualType)) : '?';
    // D-G2/ΑΩ-R18：回退/量化层铸出的预言在注记上如实标注 —— 精确层注记逐字节旧方言
    const via = record.predictedVia === 'coarse' ? '，via 粗层' : record.predictedVia === 'quant' ? '，via 量化层' : '';
    if (record.outcome === 'hit') {
      const p = typeof record.predictedProb === 'number' && Number.isFinite(record.predictedProb)
        ? Math.round(record.predictedProb * 1000) / 1000
        : '?';
      return `prophecy:hit（${cell} → ${to}，p=${p}${via}）`;
    }
    if (record.outcome === 'miss') {
      const bits = typeof record.surpriseBits === 'number' && Number.isFinite(record.surpriseBits)
        ? Math.round(record.surpriseBits * 1000) / 1000
        : '?';
      return `prophecy:miss（${cell} → ${to}，惊异 ${bits} bits${via}）`;
    }
    return `prophecy:no-model（${cell} → ${to}，模型无知直通）`;
  } catch {
    return 'prophecy:no-model（注记铸造故障，账本为准）'; // 注记绝不抛
  }
}

// W6-2（doctor smell.over-engineering 清偿）：统计面已分区提取至 stats.ts（行为零变化）；
// 导入面不变 —— 再分发。
export { prophecyStats } from './stats';
export { prophecyCalibration, prophecyPostmortem, prophecyPostmortemLines } from './stats';
export type {
  ProphecyCalibration, ProphecyCalibrationCell, ProphecyPostmortemCell,
} from './stats';
import { prophecyStats } from './stats';

// ─── 惊异喂养通道（D-G2 细化：错题本的消费面 → EvolutionEngine） ───

// 类型单进口（编译期擦除 —— 与 sleep/dreamReplay 的 DreamEvolutionLike 同律）：
// EvolutionEngine 住在 autonomy 产权域（本批禁改），其 ingest 面经此结构子集
// 被满足 —— 真引擎可直接接，测试桩只须实现同名一面。
import type { RunRecord } from '../autonomy/evolutionEngine';

/**
 * 惊异喂养端口（结构性）：`{ ingest(run) }` —— EvolutionEngine.ingest 天然满足。
 * 喂养方向是单向的（预言错题 → 进化史册）；端口故障由喂养面吞掉（旁路铁律）。
 */
export interface SurpriseFeedTarget {
  ingest(run: RunRecord): void;
}

/**
 * 失手记录 → 惊异喂养记录（纯函数，永不抛）：只有 miss 有惊异可喂 ——
 * hit / no-model 返回 null（命中不是教训、无知没有 bits —— 诚实 null，
 * 绝不伪造喂养载荷）。方言对齐 RunRecord 必填面（goal/success/steps/
 * durationMs/strategies），failureRootCause 携带失手注记（复盘线索）。
 */
export function surpriseRunRecord(rec: ProphecyRecord | null | undefined): RunRecord | null {
  try {
    if (!rec || typeof rec !== 'object' || rec.outcome !== 'miss') return null;
    const bits = typeof rec.surpriseBits === 'number' && Number.isFinite(rec.surpriseBits)
      ? Math.round(rec.surpriseBits * 1000) / 1000
      : null;
    return {
      goal: `prophecy:miss ${shortId(rec.screenType)}|${rec.actionKey}`,
      success: false,
      steps: 1,
      durationMs: 0,
      strategies: [rec.actionKey],
      failureRootCause: `prophecy-miss → ${nonEmptyStr(rec.actualType) ? shortId(String(rec.actualType)) : '?'}`
        + (bits !== null ? `（惊异 ${bits} bits）` : '（惊异缺席）'),
    };
  } catch {
    return null; // 喂养载荷铸造绝不抛
  }
}

// ─── 引擎（账本 + 挂起律 + Dyna 回灌） ───

/** 引擎构造选项（全部可缺席） */
export interface ProphecyEngineOptions {
  /** 世界模型（predict/surprise 读面 + observe 回灌写面；缺席 ⇒ 恒 no-model） */
  worldModel?: WorldModel | null;
  /** 注入时钟（缺省 Date.now —— 测试确定性生命线） */
  now?: () => number;
  /** 挂起作废时限 ms（缺省 60_000） */
  pendingTtlMs?: number;
  /**
   * 挂起槽数（ΑΩ-R18，缺省 8，夹 [1, 64]）：有界 keyed pending 的容量 ——
   * mint 各占一槽（按铸造序键控），溢出最旧作废计入 expired（作废有痕，
   * 不再静默覆盖）。
   */
  pendingSlots?: number;
  /** 账本容量（缺省 500，夹 [1, 10000]） */
  capacity?: number;
  /** 结算后回灌世界模型（observe —— Dyna 式学习；缺省 true；false ⇒ 纯只读审计） */
  learn?: boolean;
  /**
   * 惊异喂养通道（D-G2）：在场 ⇒ 每次结算入账后自动把新失手记录喂给
   * target.ingest（EvolutionEngine 结构性满足）；缺席 ⇒ 零行为。喂养是
   * 旁路仪式：端口任何故障只丢该条喂养，绝不炸环。
   */
  surpriseFeed?: SurpriseFeedTarget | null;
}

/**
 * 预言引擎（ProphecyPort 的真实实现）：铸造 → 挂起 → 结算 → 入账 的账本主人。
 *   · mint（ΑΩ-R18 有界 keyed pending）：先作废超时挂起，再铸新预言（盲屏
 *     指纹 ⇒ 不铸）；各铸造各占一槽（按铸造序键控，缺省 8 槽）—— 并发/跨
 *     run 边界的铸造不再静默覆盖未结算预言，溢出最旧作废计入 expired（作废
 *     有痕，绝不无痕丢件）；
 *   · settle（ΑΩ-R18 LIFO 配对）：结算见证恒属最近执行的动作 ⇒ 配对最近铸造
 *     （后进先出）；actualType 缺席 ⇒ 挂起保持（60s 后作废计数，绝不伪造
 *     见证）；结算成功 ⇒ 记录入环形账本（500 封顶，逐出最旧）+（learn 时）
 *     observe 回灌世界模型三写 {原始, 量化, 粗格}（先 surprise 后 observe ——
 *     与 D-7 回路同序，误差先于学习；目的地一律量化身份 ⇒ 表内键与目的地
 *     粒度同律，结算比对两侧一致不串味）；
 *   · 一切公开面永不抛异常。
 */
export class ProphecyEngine implements ProphecyPort {
  private readonly worldModel: WorldModel | null;
  private readonly now: (() => number) | undefined;
  private readonly pendingTtlMs: number;
  private readonly pendingSlots: number;
  private readonly capacity: number;
  private readonly learn: boolean;
  /** 惊异喂养通道（D-G2；缺席 ⇒ 零行为） */
  private readonly surpriseFeedTarget: SurpriseFeedTarget | null;
  /** 环形账本（入账序；超容量逐出最旧） */
  private ledger: ProphecyRecord[] = [];
  /**
   * 挂起中的预言（ΑΩ-R18 有界 keyed pending）：铸造序 → 记录（插入序 = 铸
   * 造序 ⇒ 首 key = 最旧、末 key = 最近；Map 有界 pendingSlots 槽）
   */
  private pending = new Map<number, ProphecyRecord>();
  /** 铸造序发号器（单调计数 —— 挂起键的身份源；绝不用时钟充当 id） */
  private mintSeq = 0;
  /** 挂起作废累计（诚实计数 —— TTL 超时与容量逐出同律入账：取不到真实下一屏型的预言归宿） */
  private expiredCount = 0;
  /** 已扫视入账总数（喂养水位线 —— 与 evictedTotal 的差即当前未扫视起点） */
  private fedCursor = 0;
  /** 环形逐出累计（水位线的驱逐补偿 —— 索引平移不改扫视史） */
  private evictedTotal = 0;

  constructor(opts: ProphecyEngineOptions = {}) {
    this.worldModel = opts.worldModel ?? null;
    this.now = typeof opts.now === 'function' ? opts.now : undefined;
    this.pendingTtlMs =
      typeof opts.pendingTtlMs === 'number' && Number.isFinite(opts.pendingTtlMs) && opts.pendingTtlMs > 0
        ? opts.pendingTtlMs
        : PENDING_TTL_MS;
    this.pendingSlots =
      typeof opts.pendingSlots === 'number' && Number.isFinite(opts.pendingSlots)
        ? Math.min(PENDING_SLOTS_MAX, Math.max(1, Math.floor(opts.pendingSlots)))
        : PENDING_SLOTS;
    this.capacity =
      typeof opts.capacity === 'number' && Number.isFinite(opts.capacity)
        ? Math.min(CAPACITY_MAX, Math.max(1, Math.floor(opts.capacity)))
        : LEDGER_CAPACITY;
    this.learn = opts.learn !== false;
    this.surpriseFeedTarget =
      opts.surpriseFeed && typeof opts.surpriseFeed.ingest === 'function' ? opts.surpriseFeed : null;
  }

  /** 挂起超时作废（内部件）：逐槽扫视，now − ts 越过 TTL ⇒ expired 计数 + 丢弃 */
  private voidStalePending(): void {
    if (this.pending.size === 0) return;
    const t = safeNow(this.now);
    for (const [seq, rec] of [...this.pending.entries()]) { // 快照遍历（作废中改 Map）
      const age = t - rec.ts;
      if (Number.isFinite(age) && age > this.pendingTtlMs) {
        this.expiredCount++;
        this.pending.delete(seq);
      }
    }
  }

  /** 铸造面（ProphecyPort）：盲屏不铸；任何故障只丢预言。永不抛。 */
  mint(screenType: string | null | undefined, actionKey: string): void {
    try {
      this.voidStalePending();
      if (!nonEmptyStr(screenType) || !nonEmptyStr(actionKey)) return; // 盲屏/空键不可预言
      // ΑΩ-R18：容量律 —— 溢出最旧作废（expired 有痕），铸造各占一槽不覆盖
      while (this.pending.size >= this.pendingSlots) {
        const oldest = this.pending.keys().next();
        if (oldest.done) break;
        this.pending.delete(oldest.value);
        this.expiredCount++;
      }
      const seq = ++this.mintSeq;
      this.pending.set(seq, mintProphecy(this.worldModel, String(screenType), String(actionKey), safeNow(this.now)));
    } catch {
      this.pending.clear(); // 铸造故障吞掉 —— 丢预言不炸环
    }
  }

  /**
   * 结算面（ProphecyPort）：新屏型指纹 = actualType（结算见证）。
   * ΑΩ-R18 LIFO 配对：见证恒属最近执行的动作 ⇒ 结算最近铸造（早铸预言留待
   * 各自结算或作废律收口 —— 并发双预言各得其所，绝不互相顶掉）。
   * 返回结算记录（null = 无待结算 / 见证缺席仍挂起 / 已作废）。永不抛。
   * learn 时结算后回灌 observe（success 由闭环传执行结局 —— 缺省按成功入账）。
   */
  settle(actualType: string | null | undefined, success?: boolean): ProphecyRecord | null {
    try {
      this.voidStalePending();
      // LIFO：插入序末位 = 最近铸造（Map 迭代序保证）
      let lastSeq: number | null = null;
      for (const seq of this.pending.keys()) lastSeq = seq;
      if (lastSeq === null) return null;
      const pending = this.pending.get(lastSeq) ?? null;
      if (pending === null) return null;
      if (!nonEmptyStr(actualType)) return null; // 见证缺席 ⇒ 挂起（60s 作废律收口）
      const settled = settleProphecy(pending, String(actualType), this.worldModel);
      // Dyna 回灌：真实转移喂模型（先 surprise 后 observe —— settleProphecy 已读
      // 惊异，此处才入账学习；回灌故障吞掉 —— 审计绝不为学习停摆）。
      // ΑΩ-R18 三写：from 侧 {原始, 量化格, 粗格}（去重 —— 非 hex/短屏型三键
      // 合一即单写，旧方言观察计数不翻倍）；to 侧一律量化身份 —— 表内目的地
      // 与铸造梯级、结算比对共用同一把量化尺（键粒度两侧一致，方言不串）。
      // 原始键一写是 D-G2 既有积累面的延续（字节级复现通道的证据源）。
      if (this.learn && this.worldModel && typeof this.worldModel.observe === 'function') {
        try {
          const witness = quantizedScreenType(String(actualType));
          const fromKeys = new Set([
            settled.screenType,
            quantizedScreenType(settled.screenType),
            coarseScreenType(settled.screenType),
          ]);
          for (const key of fromKeys) {
            this.worldModel.observe(key, settled.actionKey, witness, success !== false);
          }
        } catch { /* 回灌故障吞掉 */ }
      }
      this.pending.delete(lastSeq);
      this.ledger.push(settled);
      if (this.ledger.length > this.capacity) {
        const evicted = this.ledger.length - this.capacity;
        this.ledger.splice(0, evicted); // 环形逐出最旧
        this.evictedTotal += evicted; // 水位线的驱逐补偿
      }
      if (this.surpriseFeedTarget !== null) {
        this.feedSurprise(this.surpriseFeedTarget); // D-G2：新入账失手即喂（旁路吞错）
      }
      return settled;
    } catch {
      this.pending.clear(); // 结算故障吞掉 —— 丢预言不炸环
      return null;
    }
  }

  /**
   * 惊异喂养通道（D-G2；拉取面）：把水位线之后新入账的失手记录逐条喂给
   * target.ingest，返回实喂条数。水位线 = 已扫视入账总数（环形驱逐由
   * evictedTotal 补偿 —— 逐出只平移索引，不改扫视史）；重复调用零重喂。
   * target 缺席/坏形状 ⇒ 0；单条 ingest 抛错 ⇒ 吞掉（该条计丢不计喂），
   * 绝不炸环。命中/无知记录跳过但仍记扫视（surpriseRunRecord 的 null 面）。
   * 永不抛。
   */
  feedSurprise(target: SurpriseFeedTarget | null | undefined): number {
    try {
      if (!target || typeof target.ingest !== 'function') return 0;
      let fed = 0;
      // 水位线是绝对入账位（自构造起单调）；当前索引 = 绝对位 − 累计逐出。
      // 逐出先于扫视的记录已不在账上 —— 越过（诚实跳过：证据被环形律逐出，
      // 喂养面不回捞磁盘外历史）。
      let i = this.fedCursor - this.evictedTotal;
      if (i < 0) {
        this.fedCursor = this.evictedTotal;
        i = 0;
      }
      for (; i < this.ledger.length; i++) {
        this.fedCursor++; // 先记扫视（喂失败也不重扫 —— 旁路不重试）
        const run = surpriseRunRecord(this.ledger[i]);
        if (run === null) continue;
        try {
          target.ingest(run);
          fed++;
        } catch { /* 喂养通道故障吞掉 —— 绝不为喂养炸审计主体 */ }
      }
      return fed;
    } catch {
      return 0; // 喂养绝不抛（运行层铁律）
    }
  }

  /** 账本只读副本（入账序；外部不得原地改 —— 副本隔离） */
  records(): ProphecyRecord[] {
    try {
      return this.ledger.map(r => ({ ...r }));
    } catch {
      return [];
    }
  }

  /** 统计面 = prophecyStats(账本) + 引擎生命体征（挂起/作废/容量） */
  stats(): ProphecyStats & { pending: number; expired: number; capacity: number } {
    try {
      this.voidStalePending();
      return {
        ...prophecyStats(this.ledger),
        pending: this.pending.size,
        expired: this.expiredCount,
        capacity: this.capacity,
      };
    } catch {
      return {
        settled: 0, hits: 0, misses: 0, noModel: 0,
        hitRate: 0, missRate: 0, avgMissSurpriseBits: 0, coarseAssisted: 0, topMisses: [],
        pending: 0, expired: 0, capacity: this.capacity,
      };
    }
  }

  /** 账本快照（checkpoint 消费面）：记录 + 作废计数。永不抛。 */
  dump(): ProphecyLedgerSnapshot {
    try {
      this.voidStalePending();
      return {
        version: 1,
        records: this.ledger.map(r => ({ ...r })),
        expired: this.expiredCount,
      };
    } catch {
      return { version: 1, records: [], expired: 0 };
    }
  }

  /**
   * 快照水合（防御式整体替换）：任一行非法即跳过该行（半水合诚实 —— 好行
   * 入账、坏行弃置）；快照整体非法 ⇒ 原账本保持不动。永不抛。
   */
  restore(snapshot: unknown): void {
    try {
      if (!snapshot || typeof snapshot !== 'object') return;
      const s = snapshot as { records?: unknown; expired?: unknown };
      if (!Array.isArray(s.records)) return;
      const next: ProphecyRecord[] = [];
      for (const row of s.records) {
        const r = row as Partial<ProphecyRecord> | null;
        if (!r || typeof r !== 'object') continue;
        if (!nonEmptyStr(r.screenType) || !nonEmptyStr(r.actionKey)) continue;
        if (typeof r.ts !== 'number' || !Number.isFinite(r.ts)) continue;
        if (r.outcome !== 'hit' && r.outcome !== 'miss' && r.outcome !== 'no-model') continue; // pending 不入账
        const rec: ProphecyRecord = {
          screenType: String(r.screenType),
          actionKey: String(r.actionKey),
          outcome: r.outcome,
          ts: r.ts,
        };
        if (nonEmptyStr(r.predictedType)) rec.predictedType = String(r.predictedType);
        if (r.predictedVia === 'exact' || r.predictedVia === 'quant' || r.predictedVia === 'coarse') {
          rec.predictedVia = r.predictedVia; // D-G2/ΑΩ-R18：来源层白名单（域外值弃置）
        }
        if (typeof r.predictedProb === 'number' && Number.isFinite(r.predictedProb)) {
          rec.predictedProb = Math.min(1, Math.max(0, r.predictedProb));
        }
        if (typeof r.surpriseBits === 'number' && Number.isFinite(r.surpriseBits) && r.surpriseBits >= 0) {
          rec.surpriseBits = r.surpriseBits;
        }
        if (nonEmptyStr(r.actualType)) rec.actualType = String(r.actualType);
        next.push(rec);
      }
      this.ledger = next.slice(Math.max(0, next.length - this.capacity)); // 容量律同裁
      if (typeof s.expired === 'number' && Number.isFinite(s.expired) && s.expired >= 0) {
        this.expiredCount = Math.floor(s.expired);
      }
      this.pending.clear(); // 挂起不可序列化 —— 水合即清（诚实：跨进程的未验预言作废）
      // D-G2：水合后喂养水位线直抵账尾（已在册记录视为已消化 —— 与「挂起不可
      // 序列化 ⇒ 水合即清」同律：跨进程的喂养账不复存在，保守不重喂；重喂会使
      // 进化侧失手双计。dump/restore 消费面如需重喂自可直调 surpriseRunRecord）。
      this.fedCursor = this.ledger.length;
      this.evictedTotal = 0;
    } catch { /* 水合绝不抛（运行层铁律） */ }
  }
}

/**
 * 预言世界模型单例（纪元 Ε 生产接线）：进程内跨 run 存活 —— 每次结算的
 * observe 回灌在此累积，模型逐步走出无知（第二次遇见同一条路就有预言）。
 * 零持久化（与 InMemoryWorldModel 同律 —— 落盘是留白，checkpoint 消费
 * dump/restore 面）。
 */
export const prophecyWorldModel: WorldModel = new InMemoryWorldModel();
