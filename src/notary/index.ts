// src/notary/index.ts
// 纪元 Π（可公证行为账本）：让 agent 的行为史可对外公证。
//
// 一枚锚（AnchorRecord）= 「某时刻，行为日志（journal）长这个样子」的宣誓快照：
//   seq        —— 锚定时刻 journal 条数（被宣誓覆盖的行动流前缀长度）
//   chainTip   —— journal 哈希链尖（顺序与连续性的指纹）
//   mmrRoot    —— journal 行动流的 MMR 根（单条在册证明的验证锚，proof.ts 原语）
//   timestamp  —— 时间背书：RFC 3161 第三方回执（endpoint 配置时）或本地时钟
//                 （诚实标注 source:'local'，绝不谎称第三方）
//   prevAnchorHash —— 锚自链前链接（锚与锚之间同样成链 —— 抽走一枚锚即断链）
//   hash       —— sha256(canonical(记录去掉自身 hash))：整枚锚的防篡改指纹
//
// 先例致敬：v4 的「MMR 证据锚」（checkpoint.ts，恢复后重算根与锚对照）验证了
// 「快照 + 重算对照」的取证形态；本纪元把它升格为可对外的公证账本：
// verifyNotary() 四绿章 = 链完整 / MMR 在册 / 时间锚 / 重放一致性。
//
// 运行铁律（与 pilotStore/sandboxLog 同源）：公共面永不抛异常 —— 公证是旁路
// 仪式，失败 = 诚实红章或降级注记，绝不炸宿主；now/fetch/crypto 全注入（确定性
// 测试）；notaryTracePath 非空时 JSONL 追加落盘（断尾行容忍读 + 断尾治疗写）。
import { readFileSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import path from 'path';
import { journal, type JournalEntry } from '../journal';
import { mmrVerify, type InclusionProof } from '../proof';
import { requestRfc3161Timestamp, verifyTimestampToken } from './rfc3161';
import { deterministicReplay } from '../sandbox/engine';
import { sandboxLog, type SandboxLog } from '../sandbox/log';
import type { SandboxAction } from '../sandbox/types';

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

/** 一枚行为公证锚（字段集即宣誓域 —— hash 覆盖除自身外的全部字段） */
export interface AnchorRecord {
  seq: number;
  chainTip: string;
  mmrRoot: string | null;
  timestamp: AnchorTimestamp;
  /** 首锚为 null 哨兵（canonical 序列化保 null —— 与缺键可区分，链语义明确） */
  prevAnchorHash: string | null;
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
function canonical(obj: any): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  return '{' + Object.keys(obj).sort()
    .filter(k => obj[k] !== undefined)
    .map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** journal 条目的链式哈希（与 journal.chainHash 逐字节一致 —— 前缀重走的原语） */
function journalChainHash(prev: string, entry: JournalEntry): string {
  const domain: Record<string, unknown> = { ...entry };
  delete domain.hash; // 哈希域不含自身
  return sha256Hex(prev + canonical(domain));
}

/** 锚记录哈希：sha256(canonical(记录去掉自身 hash)) —— 锚自链的链式指纹 */
function anchorHash(record: Omit<AnchorRecord, 'hash'>): string {
  return sha256Hex(canonical(record));
}

/** 异常归因为安全字符串（绝不二次抛出 —— pilotStore 同律） */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    const text = String(err);
    return text === '' ? '未知异常' : text;
  } catch {
    return '未知异常';
  }
}

/** 记录防御性深拷贝（记录恒为 JSON 安全数据 —— JSON 往返即深拷贝） */
function copyRecord<T>(rec: T): T {
  try {
    return JSON.parse(JSON.stringify(rec)) as T;
  } catch {
    return rec;
  }
}

// ─── 账本面（journal 公开面的最小契约 —— 默认绑真 journal 单例，测试可注入假账本） ───

export interface NotarizableLedger {
  entries(): JournalEntry[];
  tip(): string;
  base(): string;
  verify(): { ok: boolean; length: number; brokenAt: number | null };
  mmrRoot(): string | null;
  mmrProof(index: number): InclusionProof | null;
}

/** 真 journal 单例的适配面（只用 journal 导出的公开 API —— 不复制其实现） */
const journalLedger: NotarizableLedger = {
  entries: () => journal.list(false),
  tip: () => journal.tip,
  base: () => journal.base,
  verify: () => journal.verify(),
  mmrRoot: () => journal.mmrRoot(),
  mmrProof: (index) => journal.mmrProof(index),
};

// ─── Χ 纪元（沙箱重放证词）：第四章 replay-consistency 的执法体 ───
// Π 在此章诚实 n/a 并留言「沙箱段重放证词留给后续」—— 本纪元兑现该承诺：
// 沙箱排练链是确定性世界（virtualScreen：命中测试/输入缓冲/滚动/esc 关弹窗），
// 同动作链重入必同屏 —— 重放因此**可执法**：链上在册的屏指纹序列 vs 重演重算
// 序列逐位一致 ⇒ green「重放一致」（agent 行为的复现性证明）。
// 威胁模型补位：无密钥哈希链只证「未被无痕篡改」，不证「内容为真」—— 攻击者
// 持整链重写权（改内容后重算全部哈希）可保章①绿。重放章补的就是这个缺口：
// 内容必须仍与确定性世界重演的产物逐位一致，否则 red —— 链完整而史不可复现。

/** 重放章注入面：沙箱账本可注入（缺省自动发现沙箱单例 —— 注入优先） */
export interface ReplayConsistencyOptions {
  sandboxLedger?: SandboxLog;
}

/**
 * 重放一致性章（独立可调；永不抛 —— 内部异常吞为红章，绝不炸调用方）：
 *   沙箱段在场且带屏指纹 ⇒ 逐段 deterministicReplay 重演比对（逐位）；
 *   无沙箱段 ⇒ n/a（真机 journal 段不可复现 —— 理由在场，诚实）；
 *   旧格式无指纹 ⇒ n/a(legacy)；
 *   分歧 ⇒ red（注记首个分歧步）。
 */
export function attestReplayConsistency(opts: ReplayConsistencyOptions = {}): BadgeStatus {
  try {
    const ledger = opts.sandboxLedger ?? sandboxLog; // 注入优先，缺省沙箱单例
    const entries = ledger.list();
    const isRehearsal = (kind: string) => kind === 'rehearsal-begin' || kind === 'rehearsal-step';
    if (!entries.some(e => isRehearsal(e.kind))) {
      return {
        status: 'n/a',
        detail: 'no sandbox rehearsal segment on the sandbox ledger — real-machine journal '
          + 'segments stay honestly unattested (world non-determinism: screens/timings); '
          + 'nothing replayable in scope',
      };
    }
    const newFormat = entries.some(e => isRehearsal(e.kind) && e.data?.fpFormat !== undefined);
    const segments = ledger.exportRehearsalSegments();
    if (segments.length === 0) {
      if (!newFormat) {
        return {
          status: 'n/a(legacy)',
          detail: `sandbox ledger holds ${entries.length} pre-Χ entr${entries.length === 1 ? 'y' : 'ies'} `
            + 'with rehearsal records but no screen fingerprints (legacy format) — bit-level '
            + 'replay attestation requires Χ-format records; honest n/a(legacy), not a false green',
        };
      }
      return {
        status: 'n/a',
        detail: 'rehearsal records present but no reconstructable replay segment '
          + '(virtual scene absent from the records, or segment head evicted by capacity) — honest n/a',
      };
    }

    let totalSteps = 0;
    let firstDivergence: string | null = null;
    for (const seg of segments) {
      const actions = seg.steps.map(s => s.action as SandboxAction);
      const r = deterministicReplay(actions, { scene: seg.scene });
      if (r.fingerprints.length !== seg.steps.length) {
        firstDivergence ??= `segment ${seg.chainId}: replay produced ${r.fingerprints.length} `
          + `fingerprint(s) for ${seg.steps.length} recorded step(s)`;
        continue;
      }
      for (let i = 0; i < seg.steps.length; i++) {
        if (r.fingerprints[i] !== seg.steps[i].fingerprint) {
          firstDivergence ??= `segment ${seg.chainId}: FIRST DIVERGENCE at step ${i} `
            + `(chain index ${seg.steps[i].index}) — recorded ${seg.steps[i].fingerprint.slice(0, 12)}… `
            + `vs replayed ${r.fingerprints[i].slice(0, 12)}…`;
          break;
        }
      }
      totalSteps += seg.steps.length;
    }
    if (firstDivergence) {
      return {
        status: 'red',
        detail: `${firstDivergence}; attested ${segments.length} segment(s) / ${totalSteps} step(s) — `
          + 'history NOT reproducible: the chain may verify intact yet its content diverges '
          + 'from what the deterministic world produces',
      };
    }
    return {
      status: 'green',
      detail: `replayed ${segments.length} sandbox segment(s) / ${totalSteps} step(s) — every post-step `
        + 'screen fingerprint recomputed by re-entering the virtual screen matches the ledger '
        + 'bit-for-bit (deterministic world reproduces the history); real-machine journal segments '
        + 'remain honestly outside replay scope',
    };
  } catch (e) {
    return { status: 'red', detail: `replay attestation crashed: ${errText(e)}` };
  }
}

// ─── anchorOnce 的注入面（now/fetch/crypto 全注入 —— 确定性测试） ───

export interface AnchorOptions {
  /** 覆盖单例端点（'' = 本地时间锚；undefined = 用单例配置） */
  endpoint?: string;
  /** 注入时钟（缺省 Date.now） */
  now?: () => number;
  /** 注入 fetch（缺省 Node 全局 fetch —— 仅 rfc3161 路径触网） */
  fetchImpl?: typeof fetch;
  /** 注入 CSPRNG（缺省 crypto.randomBytes；nonce 8~16 字节需求的确定性测试缝） */
  random?: (n: number) => Uint8Array;
  /** rfc3161 超时毫秒（缺省 5000 —— swarm.fireUpload 同律） */
  timeoutMs?: number;
  /** 注入账本面（缺省真 journal 单例） */
  ledger?: NotarizableLedger;
}

/** 铸 nonce：CSPRNG 16 字节；首字节 MSB 清零 + 置低位（DER INTEGER 正号位且无前导零剥除歧义） */
function mintNonce(random: (n: number) => Uint8Array): Uint8Array {
  const raw = random(16);
  raw[0] = (raw[0] & 0x7f) | 0x01;
  return raw;
}

function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/** 锚载荷摘要（sha256 原始 32 字节）：时间戳背书所绑定的「账本状态」指纹 */
function anchorPayloadDigest(a: { seq: number; chainTip: string; mmrRoot: string | null; prevAnchorHash: string | null }): Uint8Array {
  return createHash('sha256')
    .update(canonical({ seq: a.seq, chainTip: a.chainTip, mmrRoot: a.mmrRoot, prevAnchorHash: a.prevAnchorHash }), 'utf8')
    .digest();
}

// ─── 公证账本本体 ───

/** configure 面（index.ts 接线用；测试经 reset+configure 反复重铸） */
export interface NotaryConfigInput {
  endpoint?: string;
  tracePath?: string;
}

class Notary {
  private endpoint = '';
  private tracePath = '';
  private anchors: AnchorRecord[] = [];
  /** 追加写前是否需要「治疗换行」（断尾半行的封口 —— 见 appendAnchor） */
  private traceEndsClean = true;
  /** 是否已被 configure 过（ensureConfigured 的兜底语义锚点） */
  private configuredOnce = false;
  private dirEnsured = false;
  /** 磁盘镜像可用性（写失败 ⇒ 永久降级纯内存 —— pilotStore 降级律） */
  private traceWritable = true;
  private _lastError: string | null = null;

  /** 最近一次内部故障（降级取证；null = 无故障） */
  get lastError(): string | null { return this._lastError; }

  /** 内存锚链长度 */
  get anchorCount(): number { return this.anchors.length; }

  /**
   * 装配：endpoint/tracePath。tracePath 变更（或首配）⇒ 重放 JSONL 铸回内存锚链
   * （断尾行容忍 —— 被杀进程的半行跳过，之前的完好行照常铸态）。永不抛。
   */
  configure(cfg: NotaryConfigInput): void {
    try {
      if (typeof cfg.endpoint === 'string') this.endpoint = cfg.endpoint.trim();
      const tp = typeof cfg.tracePath === 'string' ? cfg.tracePath.trim() : this.tracePath;
      if (tp !== this.tracePath) {
        this.tracePath = tp;
        this.reloadTrace();
      }
      this.configuredOnce = true;
    } catch (e) {
      this._lastError = `configure: ${errText(e)}`;
    }
  }

  /** 惰性兜底装配（仅在从未 configure 过时生效 —— index.ts 的显式接线优先） */
  ensureConfigured(cfg: NotaryConfigInput): void {
    if (this.configuredOnce) return;
    this.configure(cfg);
  }

  /** 测试缝：清内存锚链与配置归零（磁盘文件不删 —— 文件清理属宿主运维职权） */
  reset(): void {
    this.endpoint = '';
    this.tracePath = '';
    this.anchors = [];
    this.traceEndsClean = true;
    this.configuredOnce = false;
    this.dirEnsured = false;
    this.traceWritable = true;
    this._lastError = null;
  }

  /** 末锚（防御性深拷贝；无锚 ⇒ null） */
  lastAnchor(): AnchorRecord | null {
    const last = this.anchors.at(-1);
    return last ? copyRecord(last) : null;
  }

  /**
   * 铸一枚锚（永不抛：任何内部异常吞为 lastError 并返回 null —— 公证是旁路仪式）。
   * 流程：账本快照（seq/链尖/MMR 根，journal 公开面）→ nonce → RFC 3161（endpoint
   * 非空；失败诚实回退 local + 注记）或本地时间锚（endpoint 空，零网络）→ 记录
   * 哈希封存 → 内存锚链 + JSONL 追加（若配置且可写）。
   */
  async anchorOnce(opts: AnchorOptions = {}): Promise<AnchorRecord | null> {
    try {
      const ledger = opts.ledger ?? journalLedger;
      const now = opts.now ?? Date.now;
      const random = opts.random ?? ((n: number) => new Uint8Array(randomBytes(n)));
      const t = now();
      // 账本快照：同刻取三件套（seq = 条数；链尖与 MMR 根各自来自 journal 公开面）
      const seq = ledger.entries().length;
      const chainTip = ledger.tip();
      const mmrRoot = ledger.mmrRoot();
      const prevAnchorHash = this.anchors.at(-1)?.hash ?? null; // 首锚 null 哨兵
      const nonce = mintNonce(random);
      const digest = anchorPayloadDigest({ seq, chainTip, mmrRoot, prevAnchorHash });
      const endpoint = (opts.endpoint !== undefined ? opts.endpoint : this.endpoint).trim();

      let timestamp: AnchorTimestamp;
      if (endpoint === '') {
        // 本地时间锚：诚实标注 source:'local' —— 绝不谎称第三方背书（零网络）
        timestamp = { source: 'local', anchoredAt: t, nonce: toB64(nonce) };
      } else {
        const r = await requestRfc3161Timestamp({
          endpoint, digest, nonce,
          fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs,
        });
        if (r.ok) {
          timestamp = {
            source: 'rfc3161', anchoredAt: t,
            token: toB64(r.token), imprintVerified: true, nonce: toB64(nonce),
          };
        } else {
          // 诚实回退 + 注记：回执未取得，本地钟顶上，失败事实留在锚上（不掩盖）
          timestamp = {
            source: 'local', anchoredAt: t, nonce: toB64(nonce),
            note: `rfc3161 fallback (${r.error}) — local clock only, NOT third-party attestation`,
          };
        }
      }

      const seed = { seq, chainTip, mmrRoot, timestamp, prevAnchorHash };
      const record: AnchorRecord = { ...seed, hash: anchorHash(seed) };
      this.anchors.push(record);
      this.appendAnchor(record);
      return copyRecord(record);
    } catch (e) {
      this._lastError = `anchorOnce: ${errText(e)}`;
      return null;
    }
  }

  /**
   * 四绿章核验（纯本地零网络；任何一章崩溃吞为红章 —— 绝不抛）：
   *   ① chain-integrity   journal.verify() 全链校验（篡改任何历史字节 ⇒ 红）
   *   ② mmr-membership    末锚条目的 MMR 包含证明有效（proof.ts 公开原语铸证）
   *   ③ timestamp-anchor  锚自链完整 + journal 前缀重走至 seq 复算链尖 + token 复核
   *   ④ replay-consistency Χ 纪元三态升级：沙箱段在场 ⇒ deterministicReplay 重演
   *      逐位比对（绿=可复现 / 红=链完整但内容与确定性世界不符）；无沙箱段 ⇒
   *      诚实 n/a（真机 journal 段不可复现）；旧格式无指纹 ⇒ n/a(legacy)。
   *      沙箱账本可经 opts.sandboxLedger 注入（缺省自动发现沙箱单例）。
   */
  verifyNotary(opts: { ledger?: NotarizableLedger; sandboxLedger?: SandboxLog } = {}): NotaryReport {
    const ledger = opts.ledger ?? journalLedger;
    const badges = {} as NotaryReport['badges'];
    // 章级隔离：单章崩溃降级为红章 detail，其余章照常出结论（绝不整体炸）
    const guard = (name: keyof NotaryReport['badges'], fn: () => BadgeStatus): void => {
      try {
        badges[name] = fn();
      } catch (e) {
        badges[name] = { status: 'red', detail: `verifier crashed: ${errText(e)}` };
      }
    };

    // ① 链完整：journal 全链校验（哈希链 —— 顺序与连续性；篡改即断，断点即证物）
    guard('chain-integrity', () => {
      const v = ledger.verify();
      if (v.ok) {
        return { status: 'green', detail: `journal hash-chain intact over ${v.length} live entr${v.length === 1 ? 'y' : 'ies'} (chainBase → tip)` };
      }
      return { status: 'red', detail: `journal chain broken at entry ${v.brokenAt} — history tampered (add/delete/modify)` };
    });

    // ② MMR 在册：末锚覆盖的最后一条 journal 条目铸造包含证明并验证（免整链重放 —— O(log n)）
    guard('mmr-membership', () => {
      const last = this.anchors.at(-1);
      if (!last) return { status: 'n/a', detail: 'no anchors minted yet — nothing to prove membership of' };
      if (last.seq === 0) return { status: 'n/a', detail: 'anchor covers an empty journal (seq=0) — no entry to include' };
      const entries = ledger.entries();
      if (entries.length < last.seq) {
        return { status: 'n/a', detail: `anchored entry #${last.seq - 1} evicted from the live window (${entries.length} entries left) — membership forensics live on the disk JSONL` };
      }
      const proof = ledger.mmrProof(last.seq - 1);
      if (!proof) {
        return { status: 'red', detail: `cannot mint an MMR inclusion proof for anchored entry #${last.seq - 1}` };
      }
      if (entries.length === last.seq && last.mmrRoot !== null) {
        // 静止世界（锚后无增长）：证明对「锚根」验证 —— 锚根覆盖被锚条目的最强形态
        return mmrVerify(proof, last.mmrRoot)
          ? { status: 'green', detail: `entry #${last.seq - 1} inclusion proof verifies against the ANCHOR's MMR root (journal ungrown since anchoring)` }
          : { status: 'red', detail: `inclusion proof for entry #${last.seq - 1} fails against the anchor MMR root — journal prefix rewritten` };
      }
      // 增长世界：证明对「当前根」验证 —— MMR 追加型，旧叶不可能从袋中消失；
      // 旧叶还在 + 章①（顺序完整）共同构成增长世界下的在册证词
      const rootNow = ledger.mmrRoot();
      return rootNow !== null && mmrVerify(proof, rootNow)
        ? { status: 'green', detail: `entry #${last.seq - 1} inclusion proof verifies against the CURRENT MMR root (journal grew ${last.seq} → ${entries.length} after anchoring)` }
        : { status: 'red', detail: `inclusion proof for entry #${last.seq - 1} fails against the current MMR root` };
    });

    // ③ 时间锚：锚自链 + journal 前缀重走 + rfc3161 token 离线复核
    guard('timestamp-anchor', () => this.verifyTimestampAnchor(ledger));

    // ④ 重放一致性（Χ 纪元升级：Π 的 n/a 承诺兑现为可执法的三态）。沙箱段在
    //    场 ⇒ 确定性重放逐位执法；真机段保持诚实 n/a（世界不可复现）；旧格式
    //    无指纹 ⇒ n/a(legacy)。attestReplayConsistency 自身永不抛 —— guard 双保险
    //    同律（章级隔离：此章崩溃不炸其余三章与总报告）。
    guard('replay-consistency', () =>
      attestReplayConsistency({ sandboxLedger: opts.sandboxLedger }));

    const ok = (Object.values(badges) as BadgeStatus[]).every(b => b.status !== 'red');
    const last = this.anchors.at(-1) ?? null;
    return {
      ok,
      badges,
      anchors: this.anchors.length,
      lastAnchor: last ? {
        seq: last.seq,
        chainTip: last.chainTip,
        mmrRoot: last.mmrRoot,
        source: last.timestamp.source,
        anchoredAt: last.timestamp.anchoredAt,
        imprintVerified: last.timestamp.imprintVerified ?? null,
        hash: last.hash,
        prevAnchorHash: last.prevAnchorHash,
      } : null,
    };
  }

  /** 章③实现：三段核验 —— 任一段硬失败 ⇒ 红；前缀重走不可得（驱逐）⇒ 整章诚实 n/a */
  private verifyTimestampAnchor(ledger: NotarizableLedger): BadgeStatus {
    if (this.anchors.length === 0) {
      return { status: 'n/a', detail: 'no anchors on the notarial chain' };
    }
    const details: string[] = [];
    let red: string | null = null;

    // ③-a 锚自链：逐锚重算 hash + prev 链接（篡改锚记录/抽锚/插锚 ⇒ 红）
    for (let i = 0; i < this.anchors.length; i++) {
      const a = this.anchors[i];
      const domain = { ...a } as Partial<AnchorRecord>;
      delete domain.hash;
      if (anchorHash(domain as Omit<AnchorRecord, 'hash'>) !== a.hash) {
        red ??= `anchor #${i} hash mismatch (record tampered)`;
      }
      const expectPrev = i === 0 ? null : this.anchors[i - 1].hash;
      if (a.prevAnchorHash !== expectPrev) {
        red ??= `anchor #${i} prevAnchorHash broken (anchor chain forked/spliced)`;
      }
    }
    if (!red) details.push(`anchor self-chain intact (${this.anchors.length} link${this.anchors.length === 1 ? '' : 's'})`);

    // ③-b journal 前缀重走：从链基复算前 seq 条至锚定时刻的链尖，与锚上的 chainTip 对照。
    // 驱逐警戒：chainBase ≠ GENESIS 说明容量驱逐发生过 —— 存活窗口起点与历史序号
    // 失去映射（诚实不可判），整段降级 n/a（磁盘 JSONL 承载取证，不虚绿也不误红）。
    const entries = ledger.entries();
    const base = ledger.base();
    if (base !== 'GENESIS') {
      details.push('journal capacity eviction advanced the chain base — historical seq→live-index mapping unavailable, prefix re-walk honestly skipped (disk JSONL holds forensics)');
      if (!red) return { status: 'n/a', detail: details.join('; ') };
    } else {
      for (let i = 0; i < this.anchors.length && !red; i++) {
        const a = this.anchors[i];
        if (a.seq === 0) {
          if (a.chainTip !== 'GENESIS') red = `anchor #${i} claims tip ${a.chainTip.slice(0, 16)}… over an empty journal (expected GENESIS)`;
          else details.push(`anchor #${i}: empty-journal anchor consistent (tip=GENESIS)`);
          continue;
        }
        if (entries.length < a.seq) {
          // 窗口未驱逐（base=GENESIS）却条数少于 seq ⇒ 账本被清空/回滚 —— 硬失败
          red = `journal holds ${entries.length} entries but anchor #${i} swears over ${a.seq} — ledger rolled back or reset`;
          break;
        }
        let prev = base;
        for (let k = 0; k < a.seq; k++) {
          const e = entries[k];
          const expect = journalChainHash(prev, e);
          if (e.hash !== expect) {
            red = `re-walk diverges at entry ${k} before anchor #${i}'s seq ${a.seq} — entry tampered after anchoring`;
            break;
          }
          prev = expect;
        }
        if (!red) {
          if (prev !== a.chainTip) {
            red = `anchor #${i} chainTip mismatch — re-walk recomputes a different tip than the anchor swears`;
          } else {
            details.push(`anchor #${i}: re-walk over ${a.seq} entries reproduces its chainTip`);
          }
        }
      }
    }

    // ③-c rfc3161 token 离线复核：重算锚载荷摘要 + nonce，重走 token 内的
    // imprint/nonce（零网络 —— 回执是留存物证，复核不依赖 TSA 在线；token 是
    // ContentInfo 不含 PKIStatusInfo —— 信封级结论在领取时已下，此处只核物证）
    let sawRfc = false;
    for (let i = 0; i < this.anchors.length && !red; i++) {
      const a = this.anchors[i];
      if (a.timestamp.source !== 'rfc3161') continue;
      sawRfc = true;
      if (!a.timestamp.token) {
        red = `anchor #${i} claims rfc3161 but stores no token`;
        break;
      }
      const token = Buffer.from(a.timestamp.token, 'base64');
      const digest = anchorPayloadDigest(a);
      const nonce = Buffer.from(a.timestamp.nonce, 'base64');
      let verified: { ok: boolean; error?: string };
      try {
        const v = verifyTimestampToken(
          new Uint8Array(token),
          { digest: new Uint8Array(digest), nonce: new Uint8Array(nonce) },
        );
        verified = v.ok ? { ok: true } : { ok: false, error: v.error };
      } catch (e) {
        verified = { ok: false, error: errText(e) }; // 双保险：复核崩溃不炸核验面
      }
      if (verified.ok) {
        details.push(`anchor #${i}: token imprint+nonce re-verified offline (receipt on record)`);
      } else {
        red = `anchor #${i} token re-verification failed: ${verified.error ?? 'unparsed'}`;
      }
    }
    if (!sawRfc) {
      details.push('no rfc3161 anchors — token recheck vacuous (local-time anchors honestly carry no third-party receipt)');
    }

    if (red) return { status: 'red', detail: `${red}; ${details.join('; ')}` };
    return { status: 'green', detail: details.join('; ') };
  }

  // ─── JSONL 落盘（断尾容忍读 + 断尾治疗写 —— pilotStore 先例的公证版） ───

  /** 重放 trace 文件铸回内存锚链（文件不存在 = 空账本首用，合法态） */
  private reloadTrace(): void {
    this.anchors = [];
    this.traceWritable = true;
    this.dirEnsured = false;
    this.traceEndsClean = true;
    if (!this.tracePath) return;
    let text: string;
    try {
      text = readFileSync(this.tracePath, 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        // 读失败（权限/占用等）⇒ 落盘面降级，内存账本照常（绝不炸）
        this.traceWritable = false;
        this._lastError = `reloadTrace: ${errText(e)}`;
      }
      return;
    }
    // 断尾容忍：逐行解析，半行（进程被杀）跳过 —— 之前的完好行照常铸态
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line === '') continue;
      try {
        const rec = JSON.parse(line) as AnchorRecord;
        // 最小形状门（垃圾行剔除；被篡改但形状完好的行保留 —— 核验章的证物）
        if (rec && typeof rec.seq === 'number' && typeof rec.chainTip === 'string'
          && typeof rec.hash === 'string' && rec.timestamp
          && (rec.timestamp.source === 'rfc3161' || rec.timestamp.source === 'local')) {
          this.anchors.push(rec);
        }
      } catch {
        continue; // 断尾/损坏行容忍
      }
    }
    // 断尾治疗记账：文件不以换行收尾 ⇒ 下次追加先补 '\n' 封口（半行不再增长成「粘行」）
    this.traceEndsClean = text === '' || text.endsWith('\n');
  }

  /** 追加一枚锚行（目录一次保证 + fsync 崩溃一致性 + 断尾治疗；写失败 ⇒ 降级纯内存） */
  private appendAnchor(record: AnchorRecord): void {
    if (!this.tracePath || !this.traceWritable) return;
    try {
      if (!this.dirEnsured) {
        mkdirSync(path.dirname(this.tracePath), { recursive: true });
        this.dirEnsured = true;
      }
      const heal = this.traceEndsClean ? '' : '\n'; // 断尾治疗写：先封口半行
      const fh = openSync(this.tracePath, 'a');
      try {
        writeSync(fh, heal + JSON.stringify(record) + '\n', null, 'utf8');
        fsyncSync(fh); // 页缓存不算落盘（journal/checkpoint 同律的崩溃一致性）
      } finally {
        closeSync(fh);
      }
      this.traceEndsClean = true;
    } catch (e) {
      // 降级律：磁盘故障 ⇒ 此后纯内存（内存锚链仍完整），错误留痕供运维取证
      this.traceWritable = false;
      this._lastError = `appendAnchor: ${errText(e)}`;
    }
  }
}

/** 模块级单例（对齐 journal/sandboxLog 的导出方言；生命周期由 index.ts 接线管理） */
export const notary = new Notary();

/**
 * 自动锚开关面（index.ts 卸载钩子接线；本函数零侵入可重入）：
 * config.notaryAutoAnchor 为真时铸一次锚 —— fire-and-forget、吞错（公证是旁路
 * 仪式，卸载路径上任何故障都不许炸宿主）；假/缺省 ⇒ 零行为。
 * 参数取结构最小面（Config 天然满足 —— 不把 schemastery 拉进运行时依赖图）。
 */
export function notaryAutoAnchorIfConfigured(config: {
  notaryAutoAnchor?: boolean;
  notaryEndpoint?: string;
  notaryTracePath?: string;
} | null | undefined): void {
  try {
    if (!config || config.notaryAutoAnchor !== true) return;
    notary.ensureConfigured({
      endpoint: config.notaryEndpoint ?? '',
      tracePath: config.notaryTracePath ?? '',
    });
    // fire-and-forget + 双保险吞错（anchorOnce 自身已永不抛 —— 此处 belt & braces）
    void notary.anchorOnce().catch(() => { /* 公证是旁路仪式 */ });
  } catch {
    /* 绝不炸宿主 */
  }
}
