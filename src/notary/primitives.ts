// src/notary/primitives.ts
// W6-2（doctor smell.over-engineering 清偿）：自 notary/index.ts 低风险分区提取
// （>500 行拆分信号）—— 锚记录数据面（可序列化类型）与密码学原语复刻
// （canonical/sha256/链哈希）整体搬迁。行为零变化；notary/index.ts 以再导出
// 保持导入面不变（epochPi/R 公证测试零改动）。
import { createHash } from 'crypto';
import type { JournalEntry } from '../journal';
// ΑΩ-R5：TSA 签名判决类型（rfc3161.ts 单一事实源 —— 纯类型导入，零运行时耦合）
import type { SignatureVerdict } from './rfc3161';
// ΠΑΝ-49：canonical 单源消费（dialects/canonical.ts —— ΝΩ-24 守卫形态唯一出处）
import { canonicalJson } from '../dialects';

// ─── 锚记录（可序列化数据面 —— 跨进程/跨会话可独立复核） ───

/** 时间背书：rfc3161（第三方回执）或 local（本地时钟，诚实降级） */
export interface AnchorTimestamp {
  source: 'rfc3161' | 'local';
  /** 铸锚时刻（本地钟；RFC 3161 的权威时刻在 token 的 genTime 里 —— 留存原样） */
  anchoredAt: number;
  /** TimeStampToken 原始 DER 字节（base64；仅 rfc3161 源在场 —— 离线导出/复核物证） */
  token?: string;
  /** 回执核验标志：imprint+nonce 均已对上（仅 rfc3161 源为 true；绝不虚标） */
  imprintVerified?: boolean;
  /**
   * ΑΩ-R5：领取时的 TSA 签名离线判决（随锚入册 —— anchorHash 哈希域覆盖，防篡改
   * 同律）。true=内嵌签名者密钥对 TSTInfo 的签名验过且成立；false=验过而败（伪造/
   * 损坏 —— 第三方背书未证）；'unsupported-alg'/'unparseable'=诚实边界（没验成）；
   * 'unpinned-key'（ΝΩ-21）=签名数学成立但签名者 SPKI 指纹不在 DSH_TSA_PIN_SHA256
   * pin 表（信任锚拒绝 —— 只在 pin 部署在场时出现）。
   * 仅 rfc3161 源在场；旧锚缺席该键 ⇒ 复核面如实报 null（不追溯、不误判）。
   */
  signatureVerified?: SignatureVerdict;
  /** 请求 nonce（base64，CSPRNG 16 字节、正号位已保证） */
  nonce: string;
  /** 降级注记（如「rfc3161 失败原因 —— 本地回退，非第三方背书」；诚实留痕） */
  note?: string;
}

// ─── 回放轨迹见证（D-G5 · W8 第 2 批）：重放层的过程证据载荷 ───
//
// 台账原文（DEBTS D-G5）：「replayOne 重放层不采集公证证据（走 degraded 旧语义
// ——有意留白）」/ INNOVATION 六「本波已知诚实边界」①。细化 = 回放完成时把
// 轨迹摘要（步骤指纹序列 + 成败）作为可选载荷随锚铸入：哈希域（anchorHash）
// 与时间戳摘要域（anchorPayloadDigest ⇒ RFC 3161 imprint）双双覆盖 —— 见证
// 与锚同律防篡改、同律受时间背书。缺席 ⇒ 两域逐字节旧形态（向后兼容律与
// journal 可选字段同源：旧锚不重算、旧核验不误红）。

/** 回放步结局（诚实三态）：true=已执行 / false=失败（含闸门拦截、派发异常）/ null=跳过（未执行非失败） */
export type ReplayStepOutcome = true | false | null;

/** 回放轨迹中的一步：工具 + 步指纹 + 三态结局 */
export interface ReplayStepWitness {
  /** 步序（重放窗口内 0 起） */
  index: number;
  /** 工具名（journal 方言） */
  tool: string;
  /** 步指纹（journal 链哈希优先；缺席 ⇒ canonical({tool,args}) 的 sha256 —— 全量身份留锚上） */
  fingerprint: string;
  /** 三态结局 */
  executed: ReplayStepOutcome;
}

/** 一次重放的完整轨迹见证（随锚铸入的可选载荷） */
export interface ReplayTrajectoryWitness {
  kind: 'replay-trajectory';
  version: 1;
  /** 证据源（'replay_actions'；run_skill 等后续源留白 —— 源缺席不猜） */
  source: string;
  /** 已执行步数（executed=true 的步 —— 跳过/失败不计） */
  replayedSteps: number;
  /** 重放窗口总步数 */
  totalSteps: number;
  /** 整体成败：true=全程走完无中止 / false=halt 诚实中止（中止也是结局，照铸） */
  success: boolean;
  /** 中止事实（gate: dead-step/safety-gate/step-failure；无中止 ⇒ null） */
  halt: { gate: string; index: number; tool: string } | null;
  /** 步骤指纹序列（轨迹主体） */
  steps: ReplayStepWitness[];
}

// ─── 旁链快照（ΑΩ-R42 · 双账覆盖） ───
//
// 台账背景：AnchorRecord 只宣誓 journal（行动账本），而 knowledge 学习史写的是
// sandboxLog（另一条独立哈希链）—— 两本账的公证覆盖面不重叠。细化 = 锚定时顺带
// 收集**在场旁链**的三元组快照：主账宣誓面零变化，旁链以「锚定时刻长这个样子」
// 的旁证身份随锚入册（anchorHash 哈希域 + TSA 摘要域双覆盖 —— D-G5 witness 同律）。
//
// ΝΩ-21（驱逐盲区清偿）：登记第二条旁链 journalDisk —— journal 磁盘 JSONL 的
// 整体指纹。攻击面：锚记录只含内存窗口的 seq/chainTip，容量驱逐前滚链基后
// 章②③ 对历史前缀诚实 n/a，攻击者灌满 journal 触发驱逐再在窗口内重写条目时，
// 内存取证面无证可举。journalDisk 把「锚定时刻磁盘文件长这个样子」（前缀行数 +
// 行字节整体 sha256）钉进锚哈希域与 TSA 摘要域 —— 磁盘史被重写 ⇒ 复核注记
// disk-chain-drift（注记级不翻章，与 sandboxLog 同律：锚定 ≠ 内容为真）。

/** 一条在场旁链的快照三元组（随锚宣誓 —— 双账覆盖的最小证词面） */
export interface AuxChainSnapshot {
  /**
   * 旁链名。'sandboxLog' = knowledge 学习史链（seq = 条数，chainTip = 链尖）；
   * 'journalDisk'（ΝΩ-21）= journal 磁盘 JSONL 整体指纹（seq = 完整行数，
   * chainTip = 前缀行字节的 sha256 hex —— append-only 语义下的前缀重算锚）。
   * 后续旁链在 notary 的收集登记处追加。
   */
  chainName: string;
  /**
   * 锚定时刻旁链进度：sandboxLog ⇒ 存活窗口条数（与主账 seq 同律）；
   * journalDisk ⇒ 磁盘文件完整行数（不含断尾半行）。
   */
  seq: number;
  /**
   * 顺序/连续性指纹：sandboxLog ⇒ 哈希链尖；journalDisk ⇒ 前 seq 行字节整体
   * sha256（hex）—— 复核端对磁盘文件前 seq 行重算比对。
   */
  chainTip: string;
}

/** 一枚行为公证锚（字段集即宣誓域 —— hash 覆盖除自身外的全部字段） */
export interface AnchorRecord {
  seq: number;
  chainTip: string;
  mmrRoot: string | null;
  timestamp: AnchorTimestamp;
  /** 首锚为 null 哨兵（canonical 序列化保 null —— 与缺键可区分，链语义明确） */
  prevAnchorHash: string | null;
  /** 可选过程证据载荷（D-G5 回放见证；canonical 过滤 undefined ⇒ 缺席时哈希域不含该键，旧锚逐字节不变） */
  witness?: ReplayTrajectoryWitness;
  /**
   * ΑΩ-R42：在场旁链快照（当前唯一 = sandboxLog 学习史链）。在场 ⇒ 入哈希域
   * （anchorHash 覆盖 —— 防篡改同律）与 TSA 摘要域；缺席（沙箱未启用/空链）⇒
   * 键不落（诚实，不伪造 {seq:0,tip:GENESIS} 的空链 —— canonical 过滤 undefined
   * ⇒ 旧锚逐字节不变，恢复/复核面旧锚 ⇒ n/a）。
   */
  auxChains?: AuxChainSnapshot[];
  hash: string;
}

/** 公证章：green=已验 / red=发现不一致（篡改或损坏）/ n/a=诚实降级（无法核验，
 *  绝不虚绿）/ n/a(legacy)=旧格式记录在场但取证字段缺席（Χ 纪元重放章专用 ——
 *  无屏指纹的旧排练行不可重放，诚实标注而非误红）。
 *  ΠΑΝ-53（分级执法）：新增 degraded=黄章 —— 章的可核验主体成立，但第三方
 *  信任维度（TSA 签名验证失败 / pin 不命中）未证：绑定事实（imprint+nonce）
 *  依旧在场，背书维度如实降级。黄 ≠ 红（不指控篡改），黄 ≠ 绿（「可公证」的
 *  表达不得再对持写权限者全绿 —— C1-9 H2 的 ok 聚合面落差就此分级披露）。 */
export interface BadgeStatus {
  status: 'green' | 'red' | 'n/a' | 'n/a(legacy)' | 'degraded';
  detail: string;
}

/** 四绿章核验报告（quality_checkup notarize 动作的四章面） */
export interface NotaryReport {
  ok: boolean;
  badges: {
    'chain-integrity': BadgeStatus;
    'mmr-membership': BadgeStatus;
    'timestamp-anchor': BadgeStatus;
    'replay-consistency': BadgeStatus;
  };
  anchors: number;
  lastAnchor: {
    seq: number; chainTip: string; mmrRoot: string | null; source: 'rfc3161' | 'local';
    anchoredAt: number; imprintVerified: boolean | null; hash: string; prevAnchorHash: string | null;
    /** ΑΩ-R5：末锚的 TSA 签名判决（随锚在册的领取时结论；旧锚/local ⇒ null 诚实标注） */
    signatureVerified: SignatureVerdict | null;
    /** ΑΩ-R42：末锚的旁链快照投影（在场 ⇒ 如实呈现供下游独立复核；旧锚/沙箱缺席 ⇒ null 诚实标注） */
    auxChains: AuxChainSnapshot[] | null;
    /**
     * ΝΩ-21：末锚 token 的 TSA 权威时刻 genTime（epoch ms，离线提取自留存物证）。
     * rfc3161 源且可解 ⇒ 数值；local 源 / 旧锚 / genTime 畸形不可解 ⇒ null 诚实标注。
     * 与 anchoredAt（本地钟）的偏差执法在章③注记（genTime-skew）—— 此处透传字段
     * 供下游独立复核。
     */
    genTime: number | null;
  } | null;
  /**
   * ΝΩ-21（NO-3 自适应锚频注记）：journal 自上锚的增量观测（entriesSinceLastAnchor
   * = 当前条数 − 末锚 seq；threshold = ADAPTIVE_ANCHOR_THRESHOLD 缺省 50；due =
   * shouldAnchor(增量)）。无锚 ⇒ null。注记级提示 —— 超阈时章③ detail 追加补锚
   * 提示（quality_checkup notarize 输出面即可见），判据面不动。
   */
  anchorCadence?: { entriesSinceLastAnchor: number; threshold: number; due: boolean } | null;
  /**
   * ΠΑΝ-53：时间回拨检测的顶层披露（章③注记之上的 verdict 字段 —— 下游不读
   * detail 也能看到）。某枚 rfc3161 锚的 TSA 权威时刻 genTime 与本地铸锚钟
   * anchoredAt 的偏差超容差（GEN_TIME_SKEW_TOLERANCE_MS）**且方向为倒退**
   * （genTime 落后 anchoredAt ⇒ 本地钟被前拨/回拨的时钟证据）⇒ 在场披露该锚
   * 的三方读数（genTime / anchoredAt / skewMs）。未检出 / 无 rfc3161 锚 ⇒ null。
   * 注记级不翻章（回拨否定的是「本地钟与 TSA 钟一致」维度，不是物证绑定 ——
   * 但顶行披露使「不读 detail 的下游」不再盲区）。
   */
  clockRollback?: { anchorIndex: number; genTime: number; anchoredAt: number; skewMs: number } | null;
}

// ─── 密码学原语（canonical 已收编单源，ΠΑΝ-49）───
// 前缀重走（章③）必须逐字节复算 journal 的链哈希：canonical 键排序 + 过滤
// undefined 值（journal 的哈希域语义：值为 undefined 的自有键与缺键同域）。
// 若两者漂移，重走必然误报断链 —— 逐字节一致是公证有效性的前提。
// ΠΑΝ-49：本件曾是 journal.canonical 的无守卫复刻（C1-9 H1 实证漂移：journal
// 的 ΝΩ-24 病态载荷守卫未随迁 ⇒ 深/环 args 在此重算出不同字节 ⇒ 章③永久误红）。
// 现收编为 dialects/canonical.ts 单源的薄再导出 —— 守卫（深度上限+环检测）随
// 单源自动到位，且未来加固只落一处。

// ΠΑΝ-49：canonical 单源消费（见文件头 import —— dialects/canonical.ts）

/** 稳定序列化：键排序 + undefined 值过滤 + 病态载荷守卫（dialects 单源薄代理） */
export function canonical(obj: any): string {
  return canonicalJson(obj);
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** journal 条目的链式哈希（与 journal.chainHash 逐字节一致 —— 前缀重走的原语） */
export function journalChainHash(prev: string, entry: JournalEntry): string {
  const domain: Record<string, unknown> = { ...entry };
  delete domain.hash; // 哈希域不含自身
  return sha256Hex(prev + canonical(domain));
}

/** 锚记录哈希：sha256(canonical(记录去掉自身 hash)) —— 锚自链的链式指纹 */
export function anchorHash(record: Omit<AnchorRecord, 'hash'>): string {
  return sha256Hex(canonical(record));
}

/** 异常归因为安全字符串（绝不二次抛出 —— pilotStore 同律） */
export function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    const text = String(err);
    return text === '' ? '未知异常' : text;
  } catch {
    return '未知异常';
  }
}

/** 记录防御性深拷贝（记录恒为 JSON 安全数据 —— JSON 往返即深拷贝） */
export function copyRecord<T>(rec: T): T {
  try {
    return JSON.parse(JSON.stringify(rec)) as T;
  } catch {
    return rec;
  }
}
