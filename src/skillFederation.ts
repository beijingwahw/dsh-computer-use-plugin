// src/skillFederation.ts
// W4-2（创新提案 G3：策略联邦）—— 联邦从「评价计数」升级为「联邦怎么走」。
// 纪元 Μ 联邦的是认知器官的成败水位（「这条路走得通吗」）；本模块把联邦对象
// 提升为**技能本身**：「同一场景 + 同一参数形状的工作流，万机各自怎么走」。
//
// 世界级纪律（一字不违）：
//   · 差分隐私红线 —— 上传载荷只含 (技能指纹, 数值槽统计中位数+IQR, reliability,
//     使用计数) + Laplace 噪声；**绝不上传原始文本 / 坐标序列 / 截图引用 / 技能 id**。
//     指纹 = 场景指纹前 8 位 + 参数 LSH 桶（与 swarm 晶体键同律的匿名锚点）；
//   · 鲁棒聚合 —— robustMergeDigests 风格：同指纹多实例**逐格（逐数值槽）中位数**
//     + IQR 离群检疫；k ≥ 3 同指纹才聚合（少源是噪声不是共识）。聚合产物是
//     「参数分布摘要」—— 结构上不含任何可执行步骤（不可执行是类型保证，不是约定）；
//   · dormant 安全律（注入三律）—— ① 接收端 Thompson/Beta 采样决定是否注入尝试；
//     ② 候选默认 **dormant**（只登记，绝不进匹配池）；③ 本地命中 2 次（本地证据）
//     才激活，且激活只经 skillLibrary 端口 addDormantSkill 登记为 dormant 技能
//     （联邦没有任何直达匹配池的写径 —— 与 Μ「绝不直接写 kernelRegistry 值」同律）；
//   · 信任与份额 —— 沿用 federation 三道闸（零证据不掺 / 份额帽 / 信任函数
//     1/(1+regressed)），技能联邦的掺入独立记账（不动证据账本一分）；
//   · 防御式绝不抛 —— 一切端口调用、一切公开面全程 try/catch，失败 = 诚实
//     跳过/降级（联邦是纯增益旁路，绝不炸宿主）。peer 缺席 / 聚合数据不足 ⇒
//     诚实跳过。
//
// 端口纪律（对 W4-1 领地零侵入）：本地技能经**结构化类型端口**消费（与
// skillLibrary 正在实现的契约 listSkillDigests / addDormantSkill 同形状），
// 不 import 其内部 —— 生产接线由宿主一次 wireSwarmSkillFederation 完成，
// 测试注入桩。全模块随机源/时钟/端口可注入，resetSkillFederation 供测试隔离。

import { Telemetry } from './telemetry';
import { iqrOf } from './federation/aggregate';
import {
  laplaceNoise,
  mulberry32,
  federationTrustOf,
  DEFAULT_FEDERATION_EPSILON,
  DEFAULT_MAX_REMOTE_SHARE,
} from './federation/index';
import { swarm } from './swarm';

// ─── 算法形状字面量（模块常量 —— 一切数值在此审计，绝无内联魔数） ───

/** 技能联邦上传段 schema 版本（v≠1 的份额按坏源缺席处理） */
export const SKILL_FED_VERSION = 1;

/** 技能指纹的场景前缀长度：8 位 —— 与 swarm 晶体键 `${hash.slice(0,8)}` 同律
 *  （匿名锚点：8 位十六进制已是 2^32 级命名空间，且与本仓库既有上传口径一致） */
export const SKILL_FP_SCENE_PREFIX = 8;

/** 参数 LSH 量化网格：数值参数按 0.05 网格取整 —— 与 skillLibrary 的 motif 量化
 *  同律（坐标抖动 <0.025 ⇒ 同桶 ⇒ 同指纹：LSH 的碰撞即「同一个工作流的微差」） */
export const SKILL_LSH_GRID = 0.05;

/** 数值槽对称裁剪域 [-CLIP, +CLIP]：屏域坐标 / 长度 / 位移的宽界（margin 裁剪
 *  [-1,1] 的 DIGEST_MARGIN_CLIP 同律思想 —— 域外夹到边界，分布尾保守收拢） */
export const SKILL_SLOT_CLIP = 4096;

/** 聚合最低同指纹源数：k < 3 拒聚（两源的「共识」无鲁棒性 —— 中位数需要
 *  ≥3 才有 50% 崩溃点的语义；与 robustMergeDigests 的 k≥3 中位数同律） */
export const SKILL_MIN_AGGREGATE_SOURCES = 3;

/** 检疫阈地板（桶宽倍数）：|源值−鲁棒值| ≤ 3×桶宽 恒不检疫 —— OUTLIER_FLOOR=3
 *  的技能域口径（计数的阈是 3 格；技能统计的格是 LSH 桶，噪声尺度=桶宽/ε） */
export const SKILL_OUTLIER_FLOOR_BUCKETS = 3;

/** 检疫阈的格间尺度：T = max(地板, 2×该槽中位数表的 IQR) —— OUTLIER_IQR_SCALE 同值 */
export const SKILL_OUTLIER_IQR_SCALE = 2;

/** Thompson 注入采样门：Beta(α,β) 单样本 ≥ 0.5 才注入尝试（「后验过半才出手」——
 *  高可靠候选几乎必过、低可靠候选偶获探索机会，与 0.5 多数表决同形的保守门） */
export const SKILL_INJECT_SAMPLE_GATE = 0.5;

/** dormant 激活所需本地命中数：2（本地证据门槛 —— 单次巧合不成技，与晶体
 *  attempts≥2 才上报/入反事实的「单次经验是噪声不是信号」同律） */
export const SKILL_ACTIVATE_LOCAL_HITS = 2;

/** 单次上传的技能数上限（swarm 晶体 100 条同律的载荷护栏） */
export const SKILL_MAX_UPLOADS = 100;

/** 数值护栏：x 非有限或越界 ⇒ 缺省（federation.numOr 同律，绝不抛） */
function numOr(x: number | undefined, dflt: number, min: number, max: number): number {
  return typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max ? x : dflt;
}

// ─── 契约端口（结构化类型 —— 与 W4-1 skillLibrary 契约同形状，零 import 侵入） ───

/** W4-2：技能摘要记录（listSkillDigests 契约形状）。stepsDigest 是纯数值参数槽
 *  （dx/dy/文本长度……）—— 文本与坐标序列在端口上游就被 W4-1 的摘要律剥掉，
 *  本模块从结构上只会见到数字（隐私红线的第一道结构性保证）。 */
export interface SkillDigestRecord {
  skillId: number | string;
  sceneFingerprint: string;
  stepsDigest: Array<Record<string, number>>;
  reliability: number;
  /** 可选使用计数（契约允许缺席 ⇒ 按 1 记 —— 保守的最小证据规模） */
  useCount?: number;
}

/** W4-2：dormant 技能登记草案（addDormantSkill 契约的入参形状 —— 联邦聚合产物
 *  的最小登记面：参数分布摘要 + 溯源，不可执行） */
export interface DormantSkillDraft {
  /** 技能指纹（场景前缀 + 参数 LSH 桶 —— 上传/聚合/激活三面同键） */
  fingerprint: string;
  /** 场景指纹匿名前缀（联邦候选只知道前 8 位 —— 全指纹从未离开本机） */
  sceneFingerprint: string;
  /** 参数分布摘要（每数值槽的中位数与 IQR —— 不可执行的联邦聚合产物） */
  slotStats: Record<string, SkillSlotStat>;
  reliability: number;
  useCount: number;
  /** 溯源注记：联邦候选（k 源聚合 + 本地命中激活 —— 审计面） */
  provenance: 'federated';
  aggregatedFrom: number;
}

/** W4-2：skillLibrary 结构化端口（方法签名与契约同形状 —— 真库/桩皆结构性满足） */
export interface SkillLibraryPort {
  listSkillDigests(): SkillDigestRecord[];
  addDormantSkill(draft: DormantSkillDraft): boolean;
}

// ─── 技能指纹（场景前 8 位 + 参数 LSH 桶） ───

/** FNV-1a 稳定哈希 → base36（skillLibrary.hashSkeleton 同源密码学原语的本地实现
 *  —— 零依赖纪律：不跨模块 import 私有原语） */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * W4-2：技能指纹（纯函数、确定性、绝不抛）。
 *   · 场景锚：sceneFingerprint 前 8 位小写（swarm 晶体键同律 —— 匿名且稳定）；
 *   · 参数 LSH 桶：每步每数值槽按 0.05 网格量化取桶（键字典序 + 步序确定
 *     枚举序 ⇒ 键序无关、抖动 <半网格宽即碰撞 —— LSH 的 locality），序列化后
 *     FNV-1a 哈希成 base36 短串。**只留桶号，不留原值** —— 指纹本身是匿名件。
 * 场景指纹缺席 ⇒ 'noscene' 占位（诚实：无锚点的技能仍可按参数形状聚合）。
 */
export function skillFingerprintOf(sceneFingerprint: unknown, stepsDigest: unknown): string {
  try {
    const scene =
      typeof sceneFingerprint === 'string' && sceneFingerprint !== ''
        ? sceneFingerprint.slice(0, SKILL_FP_SCENE_PREFIX).toLowerCase()
        : 'noscene';
    const tokens: string[] = [];
    if (Array.isArray(stepsDigest)) {
      stepsDigest.forEach((step, i) => {
        if (!step || typeof step !== 'object' || Array.isArray(step)) return; // 坏步缺席
        for (const key of Object.keys(step as Record<string, unknown>).sort()) {
          const v = (step as Record<string, unknown>)[key];
          if (typeof v !== 'number' || !Number.isFinite(v)) continue; // 非数值槽不进指纹
          const clipped = Math.min(SKILL_SLOT_CLIP, Math.max(-SKILL_SLOT_CLIP, v));
          const bucket = Math.round(clipped / SKILL_LSH_GRID);
          tokens.push(`${i}.${key}.${bucket}`);
        }
      });
    }
    return `${scene}:${fnv1a(tokens.join('|'))}`;
  } catch {
    return 'noscene:err'; // 防御带（理论不可达）：确定性降级键，绝不抛
  }
}

// ─── 数值槽统计（中位数 + IQR —— 上传载荷的唯一实体） ───

/** W4-2：单数值槽的分布摘要（中位数 + 四分位距 —— 联邦技能的全部「怎么走」） */
export interface SkillSlotStat {
  median: number;
  iqr: number;
}

/** 浮点中位数（奇数取正中；偶数取中间两数均值 —— **不取整**：与 aggregate.ts 的
 *  计数中位数不同域，技能参数是连续量，取整会吃掉 0.05 网格以下的分辨率） */
function medianF(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 技能上传载荷（隐私红线的白名单形状：v/指纹/槽统计/reliability/使用计数 ——
 *  再无别的字段；测试面对此做穷举断言） */
export interface SkillFederationUpload {
  v: typeof SKILL_FED_VERSION;
  fingerprint: string;
  slotStats: Record<string, SkillSlotStat>;
  reliability: number;
  useCount: number;
}

/** 上传铸造选项（ε / 种子 / 随机源 / 上限全可注入 —— 确定性测试的完整缝） */
export interface BuildSkillUploadsOptions {
  /** 差分隐私 ε（>0 有限；非法回落联邦缺省 1 —— 与 DEFAULT_FEDERATION_EPSILON 同源） */
  epsilon?: number;
  /** rng 种子（缺省 0 ⇒ 确定性预览；生产由宿主喂 now 派生，跨次不复用噪声流） */
  seed?: number;
  /** 完全接管随机源（给出则忽略 seed —— 直注均匀流的测试缝） */
  rng?: () => number;
  /** 上传条数上限（缺省 100 —— 载荷护栏） */
  maxUploads?: number;
}

/** 单槽值的收集与量化：有限数值 ⇒ 裁剪进对称域再按 LSH 网格量化；其余缺席 */
function collectQuantized(stepsDigest: unknown): Map<string, number[]> {
  const slotValues = new Map<string, number[]>();
  if (!Array.isArray(stepsDigest)) return slotValues;
  for (const step of stepsDigest) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) continue;
    for (const key of Object.keys(step as Record<string, unknown>)) {
      const v = (step as Record<string, unknown>)[key];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const clipped = Math.min(SKILL_SLOT_CLIP, Math.max(-SKILL_SLOT_CLIP, v));
      const q = Math.round(clipped / SKILL_LSH_GRID) * SKILL_LSH_GRID;
      const arr = slotValues.get(key) ?? [];
      arr.push(q);
      slotValues.set(key, arr);
    }
  }
  return slotValues;
}

/**
 * W4-2：铸造技能上传段（纯函数、确定性（注入 rng/seed）、绝不抛 —— 端口故障 ⇒
 * 空数组诚实跳过）。隐私机制（沿用联邦现有纪律，逐字面声明）：
 *   · 槽统计（中位数/IQR）：值先裁剪进 [-4096,4096] 再按 0.05 网格量化 —— 分位数
 *     在桶化域上单记录的典型位移是一个桶宽 ⇒ Laplace 尺度 = 桶宽/ε（工程口径的
 *     分位数敏感度；诚实注记：序统计的严格敏感度是数据相关的，此处按桶宽计是
 *     「量化域上单桶位移」的保守实用口径，与计数域 Δ=1 ⇒ 1/ε 同构）；
 *   · reliability：敏感度 = 1/useCount（单次成败翻转幅度 —— swarm.buildPacket 对
 *     successRate 的同律）⇒ 尺度 = 1/(ε·useCount)；
 *   · useCount：计数明文上报（swarm 上报 attempts 明文同律 —— 敏感统计已加噪）。
 * 输出面：每技能一条，键 = 技能指纹（skillId 与一切本地身份不出港）。
 */
export function buildSkillUploads(
  port: SkillLibraryPort | null | undefined,
  opts?: BuildSkillUploadsOptions,
): SkillFederationUpload[] {
  try {
    if (!port || typeof port.listSkillDigests !== 'function') return []; // 端口非法：诚实空手
    const epsilon = numOr(opts?.epsilon, DEFAULT_FEDERATION_EPSILON, Number.MIN_VALUE, Infinity);
    const rng =
      typeof opts?.rng === 'function'
        ? opts.rng
        : mulberry32(typeof opts?.seed === 'number' && Number.isFinite(opts.seed) ? opts.seed : 0);
    const maxUploads = numOr(opts?.maxUploads, SKILL_MAX_UPLOADS, 1, 10_000);
    let records: SkillDigestRecord[] = [];
    try {
      records = port.listSkillDigests() ?? [];
    } catch {
      return []; // 端口读故障：诚实空手（绝不炸宿主）
    }
    const uploads: SkillFederationUpload[] = [];
    for (const rec of Array.isArray(records) ? records : []) {
      try {
        if (!rec || typeof rec !== 'object') continue; // 垃圾记录缺席
        if (typeof rec.sceneFingerprint !== 'string' || !Array.isArray(rec.stepsDigest)) continue;
        const fingerprint = skillFingerprintOf(rec.sceneFingerprint, rec.stepsDigest);
        const slotValues = collectQuantized(rec.stepsDigest);
        const slotStats: Record<string, SkillSlotStat> = {};
        for (const key of [...slotValues.keys()].sort()) { // 键字典序 ⇒ 序列化确定性
          const values = slotValues.get(key)!;
          // 噪声尺度：桶宽/ε（见 JSDoc 隐私机制注记）；后处理夹回裁剪域（多掩蔽方向）
          const scale = SKILL_LSH_GRID / epsilon;
          const med = Math.min(
            SKILL_SLOT_CLIP,
            Math.max(-SKILL_SLOT_CLIP, medianF(values) + laplaceNoise(scale, rng())),
          );
          const spr = Math.min(
            SKILL_SLOT_CLIP,
            Math.max(0, iqrOf(values) + laplaceNoise(scale, rng())),
          );
          slotStats[key] = {
            median: Math.round(med * 1000) / 1000,
            iqr: Math.round(spr * 1000) / 1000,
          };
        }
        const useCount = Math.max(1, Math.floor(numOr(rec.useCount, 1, 0, 1e9)));
        const relRaw = numOr(rec.reliability, 0.5, 0, 1);
        // reliability 噪声：1/(ε·useCount)（单次成败的翻转幅度 —— swarm 同律）
        const relScale = 1 / (epsilon * useCount);
        const rel = Math.min(1, Math.max(0, relRaw + laplaceNoise(relScale, rng())));
        uploads.push({
          v: SKILL_FED_VERSION,
          fingerprint,
          slotStats,
          reliability: Math.round(rel * 1000) / 1000,
          useCount,
        });
        if (uploads.length >= maxUploads) break; // 载荷护栏
      } catch {
        continue; // 单条读取故障（陷阱属性等）：该条缺席，其余不受牵连
      }
    }
    return uploads;
  } catch {
    return []; // 绝不抛纪律的兜底臂
  }
}

// ─── 联邦侧聚合（robustMergeDigests 风格：k≥3 逐槽中位数 + IQR 检疫） ───

/** W4-2：聚合产物 —— 参数分布摘要（**不可执行**：结构上只有指纹与槽统计，
 *  没有步骤、没有工具名、没有文本 —— 「联邦怎么走」的统计共识，不是技能本体） */
export interface AggregatedSkillDigest {
  fingerprint: string;
  /** 同指纹源数（k ≥ 3 才在场 —— 聚合门的审计面） */
  aggregatedFrom: number;
  slotStats: Record<string, SkillSlotStat>;
  reliability: number;
  useCount: number;
}

/** W4-2：聚合报告（诚实全量注记 —— 拒聚指纹 / 检疫票 / 坏源序号 / notes） */
export interface SkillAggregateResult {
  aggregated: AggregatedSkillDigest[];
  /** 源标签 → 检疫票数（逐槽计票：一槽一票 —— 与 robustMergeDigests 同律） */
  quarantined: Record<string, number>;
  /** 拒聚指纹表（k < 3：少源是噪声不是共识 —— 诚实跳过不臆造） */
  skipped: string[];
  /** 坏源（形状坏 / 版本错配 / 陷阱属性）按缺席处理的原序号 */
  excluded: number[];
  notes: string[];
}

/** 单份额的资格甄别（纯函数、含单源 try 隔离 —— 坏源只能缺席，不能否决聚合） */
function validShareOf(raw: unknown): SkillFederationUpload | null {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const s = raw as Partial<SkillFederationUpload>;
    if (s.v !== SKILL_FED_VERSION) return null; // 版本错配：源级事件
    if (typeof s.fingerprint !== 'string' || s.fingerprint === '') return null;
    if (!s.slotStats || typeof s.slotStats !== 'object' || Array.isArray(s.slotStats)) return null;
    return s as SkillFederationUpload;
  } catch {
    return null; // 陷阱属性：按缺席处理
  }
}

/**
 * W4-2：联邦侧技能聚合（纯函数、确定性、绝不抛 —— robustMergeDigests 的技能域
 * 同律实现）：
 *   · 源甄别：坏份额按缺席处理（excluded）；
 *   · 按指纹分组（首现序），k < SKILL_MIN_AGGREGATE_SOURCES(3) ⇒ 拒聚进 skipped
 *     （诚实跳过：两源的均值没有鲁棒性，不冒充共识）；
 *   · 逐槽聚合：各源该槽中位数 → 再取中位数（中位数的中位数 —— 毒源 < 一半时被
 *     结构性隔离）；槽缺席的源不参与该槽（也不参与该槽检疫 —— 缺席没有离群资格）；
 *   · 逐槽检疫：|源值−鲁棒值| > T ⇒ 该源 1 票；T = max(3×桶宽, 2×该槽源值表的
 *     IQR)（阈值基于鲁棒值 ⇒ 毒源拉不动阈）；
 *   · IQR 聚合取各源 IQR 的中位数（离散度共识）；reliability/useCount 同取中位数
 *     （真值规模的诚实注记，非求和 —— 求和会被洪泛拉爆）。
 */
export function aggregateSkillShares(
  shares: unknown,
  opts?: { sourceIds?: string[] },
): SkillAggregateResult {
  try {
    const empty: SkillAggregateResult = { aggregated: [], quarantined: {}, skipped: [], excluded: [], notes: [] };
    if (!Array.isArray(shares) || shares.length === 0) {
      empty.notes.push('输入非数组或为空：无可聚合源（诚实空手）');
      return empty;
    }
    const sourceIds = Array.isArray(opts?.sourceIds) ? (opts!.sourceIds as unknown[]) : [];
    const labelOf = (i: number): string => {
      const s = sourceIds[i];
      return typeof s === 'string' && s !== '' ? s : String(i);
    };
    // 源甄别 + 按指纹分组（首现序 ⇒ 确定性）
    interface Group {
      sources: Set<number>;
      reliability: number[];
      useCount: number[];
      /** 槽 → 各源中位数表（源序号 + 值）；槽 IQR 另账 */
      slots: Map<string, { i: number; median: number }[]>;
      iqrs: Map<string, number[]>;
    }
    const groups = new Map<string, Group>();
    const excluded: number[] = [];
    shares.forEach((raw, i) => {
      const s = validShareOf(raw);
      if (!s) {
        excluded.push(i);
        return;
      }
      let g = groups.get(s.fingerprint);
      if (!g) {
        g = { sources: new Set(), reliability: [], useCount: [], slots: new Map(), iqrs: new Map() };
        groups.set(s.fingerprint, g);
      }
      g.sources.add(i);
      if (typeof s.reliability === 'number' && Number.isFinite(s.reliability)) {
        g.reliability.push(Math.min(1, Math.max(0, s.reliability)));
      }
      if (typeof s.useCount === 'number' && Number.isFinite(s.useCount) && s.useCount > 0) {
        g.useCount.push(Math.floor(s.useCount));
      }
      for (const key of Object.keys(s.slotStats ?? {})) {
        const st = s.slotStats[key];
        const med = st && typeof st.median === 'number' && Number.isFinite(st.median) ? st.median : null;
        const iqr = st && typeof st.iqr === 'number' && Number.isFinite(st.iqr) && st.iqr >= 0 ? st.iqr : null;
        if (med === null) continue; // 坏槽：缺席（不参与聚合也不参与检疫）
        const arr = g.slots.get(key) ?? [];
        arr.push({ i, median: med });
        g.slots.set(key, arr);
        if (iqr !== null) {
          const ia = g.iqrs.get(key) ?? [];
          ia.push(iqr);
          g.iqrs.set(key, ia);
        }
      }
    });
    const aggregated: AggregatedSkillDigest[] = [];
    const skipped: string[] = [];
    const quarantined: Record<string, number> = {};
    const notes: string[] = [];
    for (const [fingerprint, g] of groups) {
      const k = g.sources.size;
      if (k < SKILL_MIN_AGGREGATE_SOURCES) {
        skipped.push(fingerprint);
        continue; // k<3 拒聚：少源是噪声不是共识
      }
      const slotStats: Record<string, SkillSlotStat> = {};
      for (const key of [...g.slots.keys()].sort()) {
        const entries = g.slots.get(key)!;
        const values = entries.map(e => e.median);
        const robust = medianF(values);
        const T = Math.max(
          SKILL_OUTLIER_FLOOR_BUCKETS * SKILL_LSH_GRID,
          SKILL_OUTLIER_IQR_SCALE * iqrOf(values),
        );
        for (const { i, median } of entries) {
          if (Math.abs(median - robust) > T) {
            const label = labelOf(i);
            quarantined[label] = (quarantined[label] ?? 0) + 1;
          }
        }
        const iqrConsensus = medianF(g.iqrs.get(key) ?? [0]);
        slotStats[key] = {
          median: Math.round(robust * 1000) / 1000,
          iqr: Math.round(iqrConsensus * 1000) / 1000,
        };
      }
      aggregated.push({
        fingerprint,
        aggregatedFrom: k,
        slotStats,
        reliability: Math.round(medianF(g.reliability.length > 0 ? g.reliability : [0.5]) * 1000) / 1000,
        useCount: Math.round(medianF(g.useCount.length > 0 ? g.useCount : [1])),
      });
    }
    if (excluded.length > 0) notes.push(`坏源按缺席处理：${excluded.join(', ')}（序号）`);
    if (skipped.length > 0) notes.push(`k<${SKILL_MIN_AGGREGATE_SOURCES} 拒聚 ${skipped.length} 个指纹（少源是噪声不是共识 —— 诚实跳过）`);
    const voteTotal = Object.values(quarantined).reduce((s, v) => s + v, 0);
    if (voteTotal > 0) notes.push(`离群检疫共 ${voteTotal} 票（逐槽计票 —— 与 robustMergeDigests 同律）`);
    return { aggregated, quarantined, skipped, excluded, notes };
  } catch {
    return { aggregated: [], quarantined: {}, skipped: [], excluded: [], notes: ['聚合过程异常：诚实空手（绝不炸宿主）'] };
  }
}

// ─── 注入三律之一：Thompson/Beta 采样决策（纯函数） ───

/** Beta 采样器实例（H-3 的 Marsaglia–Tsang 实现 —— 复用不复制；swarm.thompsonTopRoutes 同律） */
const betaSampler = new Telemetry();

/**
 * W4-2：Thompson 注入决策（绝不抛）：Beta(α, β) 单样本 ≥ 0.5 才注入尝试。
 *   α = reliability·useCount + 1，β = (1−reliability)·useCount + 1 —— 把聚合面的
 *   (可靠度, 使用计数) 还原成 Beta 后验（swarm 晶体的 Beta(s+1, f+1) 同构：
 *   reliability 即后验均值、useCount 即证据量）。价值：低证据候选后验宽，偶被
 *   抽高而获一次尝试机会（按证据不足程度成比例探索）；高证据候选分布窄，
 *   长期由真值主导。uniform 流注入 ⇒ 确定性可测；采样器故障 ⇒ false（保守臂）。
 */
export function shouldAttemptInjection(
  reliability: number,
  useCount: number,
  uniform: () => number,
): boolean {
  try {
    const r = numOr(reliability, 0.5, 0, 1);
    const n = Math.max(1, Math.floor(numOr(useCount, 1, 0, 1e9)));
    const sample = betaSampler.sampleBeta(r * n + 1, (1 - r) * n + 1, uniform);
    return Number.isFinite(sample) && sample >= SKILL_INJECT_SAMPLE_GATE;
  } catch {
    return false; // 绝不抛：保守不注入
  }
}

// ─── 注入三律之二/三 + 信任与份额：接收端登记与 dormant 两段激活 ───

/** W4-2：联邦技能候选（接收端账本条目 —— 默认 dormant，绝不进匹配池） */
export interface FederatedSkillCandidate {
  fingerprint: string;
  slotStats: Record<string, SkillSlotStat>;
  reliability: number;
  useCount: number;
  aggregatedFrom: number;
  receivedAt: number;
  /** dormant = 只登记；active = 本地命中 2 次后激活（已登记为库的 dormant 技能） */
  state: 'dormant' | 'active';
  /** 本地命中计数（激活证据 —— 激活后继续累积为审计面） */
  localHits: number;
}

/** W4-2：联邦技能账（swarm report 的观测面 —— 晶体层新增的技能联邦账目） */
export interface SkillFederationLedgerStats {
  /** skillLibrary 端口是否已接线（false = 空转：一切面诚实为零） */
  wired: boolean;
  candidates: number;
  dormant: number;
  active: number;
  /** 累计本地命中（激活证据总量） */
  localHits: number;
  /** 累计激活成功数（addDormantSkill 返回 true 的次数） */
  activations: number;
  /** 累计 Thompson 注入尝试数（采样通过并登记的候选次数） */
  thompsonAttempts: number;
  lastReceivedAt: number;
}

/** 接收选项（信任源 / 份额 / 本地技能规模 / 时钟 / 随机源全可注入） */
export interface ReceiveSkillOptions {
  /** 信任源 id（缺省匿名 ⇒ trust=1；给了则查 federation 信任账 1/(1+regressed)） */
  sourceId?: string;
  /** 显式信任权重 ∈ (0,1]（优先于信任账） */
  trust?: number;
  /** 远端份额上限 ∈ [0,1]（非法回落 0.5 —— DEFAULT_MAX_REMOTE_SHARE 同源） */
  maxRemoteShare?: number;
  /** 本地技能数（闸①的本地证据面；缺省从端口实读 —— 端口缺席 ⇒ 0 即不掺） */
  localSkillCount?: number;
  now?: () => number;
  rng?: () => number;
}

/** 接收报告（诚实全量注记：三道闸决算 + 逐指纹判定） */
export interface SkillReceiveReport {
  ok: boolean;
  /** Thompson 采样通过并登记的候选数（≤ quota ≤ cap —— 份额上限的全局面） */
  injected: number;
  cap: number;
  quota: number;
  trust: number;
  localSkillCount: number;
  perFingerprint: Array<{ fingerprint: string; decision: string }>;
  notes: string[];
}

/**
 * W4-2：技能联邦接收端（防御式绝不抛 —— 一切故障诚实跳过）。
 * 三道闸（federation.applyFederatedEvidence 同律的技能域移植）：
 *   ① 本地零证据不掺：本地技能数为 0 ⇒ 全跳过（本地没有技能生态就不引入
 *      外源候选 —— 防外源漂移）；
 *   ② 份额帽：cap = floor(maxRemoteShare × 本地技能数)，防远端候选洪泛；
 *   ③ 信任折减：quota = floor(cap × trust)（信任账 1/(1+regressed) —— 检疫票
 *      经 applyQuarantineToTrust 折算过的源在此被折减）。
 * 注入律：配额内逐候选 Thompson 采样（shouldAttemptInjection）—— 采样通过才
 * 登记，且登记的候选一律 **dormant**（只进本账本，绝不进匹配池）。
 * 独立记账：本账本只动自己的计数器，不触碰 evidenceLedger / kernelRegistry。
 */
class SkillFederation {
  private port: SkillLibraryPort | null = null;
  private candidates = new Map<string, FederatedSkillCandidate>();
  private totals = { localHits: 0, activations: 0, thompsonAttempts: 0 };
  private lastReceivedAt = 0;

  /** 接线 skillLibrary 端口（null = 摘线 —— 一切面诚实归零语义） */
  configure(port: SkillLibraryPort | null): void {
    try {
      this.port = port && typeof port.listSkillDigests === 'function' && typeof port.addDormantSkill === 'function'
        ? port
        : null; // 形状不合法的端口按未接线处理（绝不抛）
    } catch {
      this.port = null;
    }
  }

  /** 接收聚合产物（见类 JSDoc 三道闸 + 注入律） */
  receive(aggregated: unknown, opts: ReceiveSkillOptions = {}): SkillReceiveReport {
    const base: SkillReceiveReport = {
      ok: true, injected: 0, cap: 0, quota: 0, trust: 1, localSkillCount: 0, perFingerprint: [], notes: [],
    };
    try {
      let nowMs = Date.now();
      if (typeof opts.now === 'function') {
        try {
          const t = opts.now();
          if (Number.isFinite(t)) nowMs = t;
        } catch { /* 时钟故障保持 Date.now */ }
      }
      this.lastReceivedAt = nowMs;
      // 本地证据面：显式注入优先；否则端口实读（端口故障 ⇒ 0 —— 安全方向）
      let localN = 0;
      if (typeof opts.localSkillCount === 'number' && Number.isFinite(opts.localSkillCount) && opts.localSkillCount >= 0) {
        localN = Math.floor(opts.localSkillCount);
      } else if (this.port) {
        try {
          localN = Array.isArray(this.port.listSkillDigests()) ? this.port.listSkillDigests().length : 0;
        } catch {
          localN = 0;
        }
      }
      // 信任解析：显式 trust 优先；否则查信任账；再否则初见全信
      let trust = 1;
      if (typeof opts.trust === 'number' && Number.isFinite(opts.trust) && opts.trust > 0) {
        trust = Math.min(1, opts.trust);
      } else if (typeof opts.sourceId === 'string' && opts.sourceId !== '') {
        trust = federationTrustOf(opts.sourceId);
      }
      const share = numOr(opts.maxRemoteShare, DEFAULT_MAX_REMOTE_SHARE, 0, 1);
      const cap = Math.floor(share * localN);
      const quota = Math.floor(cap * trust);
      const report: SkillReceiveReport = { ...base, trust, localSkillCount: localN, cap, quota };
      const items = Array.isArray(aggregated) ? aggregated : [];
      if (items.length === 0) {
        report.notes.push('聚合产物为空：无可接收者（诚实空手 —— peer 缺席/数据不足是常态不是错误）');
        return report;
      }
      if (localN <= 0) {
        report.notes.push('闸①：本地零技能证据不掺入（防外源漂移 —— 本地没有技能生态）');
        return report;
      }
      if (cap <= 0) {
        report.notes.push(`闸②：份额上限折没（share=${share} × 本地 ${localN} 技 ⇒ cap=0）`);
        return report;
      }
      if (quota <= 0) {
        report.notes.push(`闸③：信任折没（trust=${Math.round(trust * 1000) / 1000} × cap=${cap} ⇒ quota=0）`);
        return report;
      }
      const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
      let injected = 0;
      for (const raw of items) {
        try {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue; // 坏条目缺席
          const a = raw as Partial<AggregatedSkillDigest>;
          if (typeof a.fingerprint !== 'string' || a.fingerprint === '') continue;
          if (typeof a.aggregatedFrom !== 'number' || a.aggregatedFrom < SKILL_MIN_AGGREGATE_SOURCES) {
            report.perFingerprint.push({ fingerprint: String(a.fingerprint), decision: 'reject-k-lt-3' });
            continue; // 聚合门防御性复审：k<3 的聚合产物不收
          }
          if (injected >= quota) {
            report.perFingerprint.push({ fingerprint: a.fingerprint, decision: 'quota-exhausted' });
            continue; // 配额用尽：诚实出局
          }
          // 注入律①：Thompson/Beta 采样决定是否注入尝试
          const rel = numOr(a.reliability, 0.5, 0, 1);
          const use = Math.max(1, Math.floor(numOr(a.useCount, 1, 0, 1e9)));
          let sampled = false;
          try {
            sampled = shouldAttemptInjection(rel, use, rng);
          } catch {
            sampled = false; // 采样故障：保守不注入
          }
          if (!sampled) {
            report.perFingerprint.push({ fingerprint: a.fingerprint, decision: 'thompson-reject' });
            continue;
          }
          injected += 1;
          this.totals.thompsonAttempts += 1;
          // 注入律②：候选默认 dormant —— 只登记，绝不进匹配池。已有候选 ⇒ 刷新
          // 统计但**保留 localHits 与 state**（本地证据只增不减，联邦刷新不清账）
          const existing = this.candidates.get(a.fingerprint);
          const slotStats: Record<string, SkillSlotStat> = {};
          if (a.slotStats && typeof a.slotStats === 'object' && !Array.isArray(a.slotStats)) {
            for (const key of Object.keys(a.slotStats).sort()) {
              const st = a.slotStats[key];
              const med = st && typeof (st as SkillSlotStat).median === 'number' && Number.isFinite((st as SkillSlotStat).median)
                ? (st as SkillSlotStat).median : 0;
              const iqr = st && typeof (st as SkillSlotStat).iqr === 'number' && Number.isFinite((st as SkillSlotStat).iqr) && (st as SkillSlotStat).iqr >= 0
                ? (st as SkillSlotStat).iqr : 0;
              slotStats[key] = { median: med, iqr: iqr };
            }
          }
          this.candidates.set(a.fingerprint, {
            fingerprint: a.fingerprint,
            slotStats,
            reliability: rel,
            useCount: use,
            aggregatedFrom: Math.floor(a.aggregatedFrom),
            receivedAt: nowMs,
            state: existing?.state ?? 'dormant',
            localHits: existing?.localHits ?? 0,
          });
          report.perFingerprint.push({ fingerprint: a.fingerprint, decision: existing ? 'refreshed-dormant-ledger' : 'registered-dormant' });
        } catch {
          continue; // 单条读取故障：缺席，其余不受牵连
        }
      }
      report.injected = injected;
      if (injected === 0) report.notes.push('配额在场但零候选通过 Thompson 采样（保守臂 —— 诚实注记）');
      return report;
    } catch {
      return { ...base, ok: false, notes: ['接收过程异常：诚实全跳（绝不炸宿主）'] };
    }
  }

  /**
   * W4-2 注入律③：本地命中记账 —— 命中 2 次激活。激活动作 = 经 skillLibrary 端口
   * addDormantSkill 登记 dormant 技能（登记后它仍是库的 dormant 技能 —— 两段
   * dormant 安全律：联邦登记面 + 库激活面各自把门）。未知指纹的命中诚实忽略
   * （本地巧合不臆造联邦候选）；端口故障/返回 false ⇒ 保持 dormant（下次命中重试）。
   */
  noteLocalHit(fingerprint: string, now?: () => number): {
    ok: boolean;
    state: 'dormant' | 'active' | 'unknown';
    localHits: number;
    activated: boolean;
    registered: boolean;
    reason?: string;
  } {
    try {
      const cand = this.candidates.get(fingerprint);
      if (!cand) {
        return { ok: false, state: 'unknown', localHits: 0, activated: false, registered: false, reason: 'unknown-fingerprint' };
      }
      cand.localHits += 1;
      this.totals.localHits += 1;
      if (typeof now === 'function') {
        try {
          const t = now();
          if (Number.isFinite(t)) cand.receivedAt = t; // 新鲜化（命中即最近在场证据）
        } catch { /* 时钟故障保持原值 */ }
      }
      // 已激活：只记账不重复登记（幂等律）
      if (cand.state === 'active') {
        return { ok: true, state: 'active', localHits: cand.localHits, activated: false, registered: false };
      }
      if (cand.localHits < SKILL_ACTIVATE_LOCAL_HITS) {
        return { ok: true, state: 'dormant', localHits: cand.localHits, activated: false, registered: false };
      }
      // 激活：经端口登记 dormant 技能（登记草案只含分布摘要 —— 不可执行件）
      let registered = false;
      if (this.port) {
        try {
          registered = this.port.addDormantSkill({
            fingerprint: cand.fingerprint,
            sceneFingerprint: cand.fingerprint.split(':')[0] ?? '', // 匿名前缀（全指纹从未离开本机）
            slotStats: cand.slotStats,
            reliability: cand.reliability,
            useCount: cand.useCount,
            provenance: 'federated',
            aggregatedFrom: cand.aggregatedFrom,
          }) === true;
        } catch {
          registered = false; // 端口故障：保持 dormant，下次命中重试
        }
      }
      if (registered) {
        cand.state = 'active';
        this.totals.activations += 1;
        return { ok: true, state: 'active', localHits: cand.localHits, activated: true, registered: true };
      }
      return {
        ok: true, state: 'dormant', localHits: cand.localHits, activated: false, registered: false,
        reason: this.port ? 'addDormantSkill-refused' : 'port-not-wired',
      };
    } catch {
      return { ok: false, state: 'unknown', localHits: 0, activated: false, registered: false, reason: 'internal-error' };
    }
  }

  /** 候选快照（防御副本 —— 调用方改写不触账本） */
  candidatesSnapshot(): FederatedSkillCandidate[] {
    try {
      return [...this.candidates.values()]
        .map(c => ({ ...c, slotStats: Object.fromEntries(Object.entries(c.slotStats).map(([k, v]) => [k, { ...v }])) }))
        .sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1));
    } catch {
      return [];
    }
  }

  /** 联邦技能账观测面（swarm.report 的 federatedSkills 段数据源） */
  ledgerStats(): SkillFederationLedgerStats {
    const cands = [...this.candidates.values()];
    return {
      wired: this.port !== null,
      candidates: cands.length,
      dormant: cands.filter(c => c.state === 'dormant').length,
      active: cands.filter(c => c.state === 'active').length,
      localHits: this.totals.localHits,
      activations: this.totals.activations,
      thompsonAttempts: this.totals.thompsonAttempts,
      lastReceivedAt: this.lastReceivedAt,
    };
  }

  /** 测试缝：账本归零（端口一并摘除 —— configure 重接；生产代码无理由调用） */
  reset(): void {
    this.port = null;
    this.candidates.clear();
    this.totals = { localHits: 0, activations: 0, thompsonAttempts: 0 };
    this.lastReceivedAt = 0;
  }
}

/** W4-2：技能联邦接收端单例（账本纯内存不落盘 —— federation 信任账同律） */
export const skillFederation = new SkillFederation();

// ─── swarm 接线（packet v2 的技能联邦段 + 晶体层联邦技能账） ───

/**
 * W4-2：生产接线（宿主一行完成）：① 接上 skillLibrary 结构化端口（真源由 W4-1
 * 的 listSkillDigests/addDormantSkill 契约提供）；② 把上传铸造与账本观测面挂进
 * swarm —— buildPacket 从此携带 schema v2 的技能联邦段，report 携带联邦技能账。
 * 返回 false = 接线失败（端口形状坏等 —— 诚实降级为未接线，绝不抛）。
 * 注：swarm.ts 对本模块只有 import type（编译期擦除）—— 无运行时模块环。
 */
export function wireSwarmSkillFederation(port: SkillLibraryPort | null): boolean {
  try {
    // 形状闸：非空端口必须是完整契约形状（listSkillDigests + addDormantSkill）——
    // 形状坏 ⇒ 拒绝接线（诚实 false），swarm 保持未接线行为
    if (port !== null && port !== undefined &&
      (typeof port !== 'object' ||
        typeof port.listSkillDigests !== 'function' ||
        typeof port.addDormantSkill !== 'function')) {
      return false;
    }
    const wired = port ?? null;
    skillFederation.configure(wired);
    if (!wired) {
      swarm.attachSkillFederation(null);
      return true; // 显式摘线也是成功语义
    }
    swarm.attachSkillFederation({
      uploads: (dpEpsilon: number, uniform: () => number) =>
        buildSkillUploads(wired, { epsilon: dpEpsilon, rng: uniform }),
      ledgerStats: () => skillFederation.ledgerStats(),
    });
    return true;
  } catch {
    return false; // 接线故障：诚实降级（swarm 保持无技能段行为）
  }
}
