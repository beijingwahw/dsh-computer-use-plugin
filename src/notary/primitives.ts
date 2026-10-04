// src/notary/primitives.ts
// W6-2（doctor smell.over-engineering 清偿）：自 notary/index.ts 低风险分区提取
// （>500 行拆分信号）—— 锚记录数据面（可序列化类型）与密码学原语复刻
// （canonical/sha256/链哈希）整体搬迁。行为零变化；notary/index.ts 以再导出
// 保持导入面不变（epochPi/R 公证测试零改动）。
import { createHash } from 'crypto';
import type { JournalEntry } from '../journal';

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
  hash: string;
}

/** 公证章：green=已验 / red=发现不一致（篡改或损坏）/ n/a=诚实降级（无法核验，
 *  绝不虚绿）/ n/a(legacy)=旧格式记录在场但取证字段缺席（Χ 纪元重放章专用 ——
 *  无屏指纹的旧排练行不可重放，诚实标注而非误红） */
export interface BadgeStatus {
  status: 'green' | 'red' | 'n/a' | 'n/a(legacy)';
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
  } | null;
}

// ─── 密码学原语复刻（journal.ts 模块私有 —— 复刻非复制实现，先例：sandbox/log.ts） ───
// 前缀重走（章③）必须逐字节复算 journal 的链哈希：canonical 键排序 + 过滤
// undefined 值（journal 的哈希域语义：值为 undefined 的自有键与缺键同域）。
// 若两者漂移，重走必然误报断链 —— 此处的逐字节一致是公证有效性的前提。

/** 稳定序列化：键排序 + undefined 值过滤（与 journal.canonical 同律） */
export function canonical(obj: any): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  return '{' + Object.keys(obj).sort()
    .filter(k => obj[k] !== undefined)
    .map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
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
