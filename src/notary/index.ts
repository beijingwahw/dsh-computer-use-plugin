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
//   auxChains  —— ΑΩ-R42 双账覆盖：在场旁链（当前唯一 = sandboxLog 学习史链）的
//                 (chainName, seq, chainTip) 三元组快照 —— 主账之外独立哈希链的
//                 旁证随锚入册；沙箱未启用 ⇒ 字段缺席（不伪造空链）
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
import { requestRfc3161Timestamp, verifyTimestampToken, extractGenTime, GEN_TIME_SKEW_TOLERANCE_MS, type SignatureVerdict } from './rfc3161';
import { deterministicReplay } from '../sandbox/engine';
import { sandboxLog, type SandboxLog } from '../sandbox/log';
import type { SandboxAction } from '../sandbox/types';

// W6-2（doctor smell.over-engineering 清偿）：锚记录+密码学原语 → primitives、重放一致性 → replay（行为零变化）；导入面不变。
// D-G5（W8 第 2 批）：回放轨迹见证 → replayWitness（数据面在 primitives 同册）。
import { attestReplayConsistency } from './replay';
import type { AnchorRecord, AnchorTimestamp, NotaryReport, BadgeStatus, ReplayTrajectoryWitness, AuxChainSnapshot } from './primitives';
export { attestReplayConsistency, type ReplayConsistencyOptions } from './replay';
export { canonical, sha256Hex, journalChainHash, anchorHash, errText, copyRecord, type AnchorRecord, type AnchorTimestamp, type BadgeStatus, type NotaryReport, type ReplayStepOutcome, type ReplayStepWitness, type ReplayTrajectoryWitness, type AuxChainSnapshot } from './primitives';
export {
  replayStepFingerprint, anchorReplayTrajectoryOn,
  type NotaryTarget, type ReplayAnchorOptions, type ReplayAnchorResult,
} from './replayWitness';
import { canonical, sha256Hex, journalChainHash, anchorHash, errText, copyRecord } from './primitives';
import { anchorReplayTrajectoryOn, type ReplayAnchorOptions, type ReplayAnchorResult } from './replayWitness';

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
  /**
   * 可选过程证据载荷（D-G5 回放见证）：在场 ⇒ 进锚记录（anchorHash 覆盖）与
   * 时间戳摘要域（RFC 3161 imprint 绑定）；缺席 ⇒ 两域逐字节旧形态。
   */
  witness?: ReplayTrajectoryWitness;
  /**
   * ΑΩ-R42：注入旁链账本（缺省沙箱单例 sandboxLog —— 旁链快照的确定性测试缝；
   * 与 verifyNotary.sandboxLedger 同一账本的两个名字：铸端取快照、核端重算比对）。
   */
  auxLedger?: SandboxLog;
  /**
   * ΝΩ-21：journal 磁盘 JSONL 指纹的取径（journalDisk 旁链的登记源）。注入 ⇒
   * 测试/宿主可指向任一账本磁盘文件（确定性缝）；缺省用 configure 登记的
   * journalDiskPath；两皆缺席 ⇒ journalDisk 旁链不登记（诚实缺席，不伪造）。
   * 核验端 verifyNotary.journalDiskPath 同名注入 —— 铸核两端同一文件的重算对照。
   */
  journalDiskPath?: string;
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

/**
 * 锚载荷摘要（sha256 原始 32 字节）：时间戳背书所绑定的「账本状态」指纹。
 * D-G5：witness 在场 ⇒ 一并入摘要域（第三方回执连同回放见证一起绑定）；
 * 缺席 ⇒ canonical 过滤 undefined —— 摘要与旧形态逐字节一致（向后兼容）。
 * ΑΩ-R42：auxChains 同律入摘要域 —— 第三方回执连同旁链快照（学习史链尖）
 * 一起绑定；缺席 ⇒ 逐字节旧形态。铸造端（anchorOnce）与复核端（章③-c 重走
 * token）共用本函数 —— 两端同域，自证一致。
 */
function anchorPayloadDigest(a: {
  seq: number; chainTip: string; mmrRoot: string | null; prevAnchorHash: string | null;
  witness?: ReplayTrajectoryWitness;
  auxChains?: AuxChainSnapshot[];
}): Uint8Array {
  return createHash('sha256')
    .update(canonical({
      seq: a.seq, chainTip: a.chainTip, mmrRoot: a.mmrRoot,
      prevAnchorHash: a.prevAnchorHash, witness: a.witness, auxChains: a.auxChains,
    }), 'utf8')
    .digest();
}

// ─── ΝΩ-21：journal 磁盘 JSONL 指纹（容量驱逐盲区的取证面） ───
//
// 攻击面（工单原文）：锚记录已含 seq，但容量驱逐把 journal 内存窗口的链基前滚
// 后，章②③ 对历史前缀诚实 n/a —— 攻击者灌满 journal 触发驱逐、再在存活窗口内
// 重写条目，四章无一处可举证。磁盘 JSONL 是 append-only 的全史（journal 只追加
// 不改写不截断），把它在锚定时刻的**整体指纹**（完整行数 + 行字节整体 sha256）
// 钉进锚哈希域（ΑΩ-R42 auxChains 同律的第二条旁链 journalDisk），磁盘史锚后被
// 重写 ⇒ 复核端对前 seq 行重算比对即漂移（注记 disk-chain-drift）。文件千行级
// 的 sha256 成本可接受（单次读 + 单次哈希 —— 与链上逐条重走的 ③-b 同量级）。

/** 数完整行（'\n' 收尾 —— 与 journal 逐条 JSON 行 + '\n' 的落盘形态对齐；断尾半行不计） */
function countCompleteLines(bytes: Buffer): number {
  let n = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a) n++;
  return n;
}

/** 前 n 行字节（含第 n 个换行）的 sha256 hex；完整行不足 n ⇒ null（誓言的前缀已不在盘上） */
function sha256OfFirstLines(bytes: Buffer, n: number): string | null {
  if (n < 0) return null;
  if (n === 0) return createHash('sha256').update('').digest('hex');
  let seen = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a && ++seen === n) {
      return createHash('sha256').update(bytes.subarray(0, i + 1)).digest('hex');
    }
  }
  return null;
}

/** 读磁盘账本铸整体指纹（完整行数 + 全部完整行字节 sha256）；读不得/无完整行 ⇒ null（诚实缺席） */
function journalDiskFingerprint(filePath: string): { seq: number; chainTip: string } | null {
  try {
    const bytes = readFileSync(filePath);
    const lines = countCompleteLines(bytes);
    if (lines === 0) return null; // 空文件/仅断尾 ⇒ 旁链缺席（不伪造空链 —— R42 同律）
    const chainTip = sha256OfFirstLines(bytes, lines);
    return chainTip === null ? null : { seq: lines, chainTip };
  } catch {
    return null; // 读不得 ⇒ 缺席不是故障（旁链仪式绝不炸铸锚主路径）
  }
}

/**
 * ΑΩ-R42：在场旁链登记处 —— 锚定时收集 (chainName, seq, chainTip) 三元组。
 * 旁链一 = sandboxLog（knowledge 学习史链）；旁链二（ΝΩ-21）= journalDisk
 * （journal 磁盘 JSONL 整体指纹 —— journalDiskPath 在场且可读时登记）。
 * 在场判据 = 账本有条目/文件可读且有完整行（真实在场的痕迹）；空 ⇒ 该旁链缺席
 * （不伪造空快照，宣誓域只收真实在场的内容）；读取崩溃 ⇒ 同缺席。登记顺序固定
 * [sandboxLog, journalDisk]（数组序入哈希域 —— 稳定序保证铸核两端同域）。
 */
function snapshotAuxChains(aux?: SandboxLog, journalDiskPath?: string): AuxChainSnapshot[] | undefined {
  const out: AuxChainSnapshot[] = [];
  try {
    const ledger = aux ?? sandboxLog;
    const seq = ledger.list().length;
    if (seq > 0) out.push({ chainName: 'sandboxLog', seq, chainTip: ledger.tip });
  } catch {
    /* 旁链快照缺席不是故障 —— 诚实缺位于优 */
  }
  if (journalDiskPath) {
    const fp = journalDiskFingerprint(journalDiskPath);
    if (fp) out.push({ chainName: 'journalDisk', seq: fp.seq, chainTip: fp.chainTip });
  }
  return out.length > 0 ? out : undefined;
}

// ─── 公证账本本体 ───

/** configure 面（index.ts 接线用；测试经 reset+configure 反复重铸） */
export interface NotaryConfigInput {
  endpoint?: string;
  tracePath?: string;
  /**
   * ΝΩ-21：journal 磁盘 JSONL 的路径（journalDisk 旁链的登记源 —— 宿主接线时
   * 传 config.journalPath 同一文件；铸端快照与核端重算共用，见 AnchorOptions。
   * journal 不公开私有 filePath —— 公证侧只认显式登记的路径，缺省旁链缺席）。
   */
  journalDiskPath?: string;
}

class Notary {
  private endpoint = '';
  private tracePath = '';
  private anchors: AnchorRecord[] = [];
  /** ΝΩ-21：journal 磁盘 JSONL 路径（journalDisk 旁链 —— 空 = 未登记） */
  private diskPath = '';
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
   * 宿主装配状态（D-G5 公证缺席判据）：configure 是否发生过（显式接线或
   * ensureConfigured 兜底均计）。未装配 ⇒ 重放铸证等便捷面诚实降级 ——
   * 公证纪律由宿主开闸，缺省零行为。
   */
  isConfigured(): boolean { return this.configuredOnce; }

  /**
   * 装配：endpoint/tracePath。tracePath 变更（或首配）⇒ 重放 JSONL 铸回内存锚链
   * （断尾行容忍 —— 被杀进程的半行跳过，之前的完好行照常铸态）。永不抛。
   */
  configure(cfg: NotaryConfigInput): void {
    try {
      if (typeof cfg.endpoint === 'string') this.endpoint = cfg.endpoint.trim();
      if (typeof cfg.journalDiskPath === 'string') this.diskPath = cfg.journalDiskPath.trim();
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
    this.diskPath = '';
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
      // ΑΩ-R42：旁链快照 —— 同刻顺带收集在场旁链（sandboxLog 学习史链 +
      // ΝΩ-21 journalDisk 磁盘 JSONL 整体指纹）的三元组；两皆缺席 ⇒ undefined
      // （字段缺席，诚实不伪造空链）。opts.journalDiskPath 注入优先于 configure
      // 登记（测试确定性缝；两端同文件 —— 铸端快照、核端重算）。
      const auxChains = snapshotAuxChains(
        opts.auxLedger,
        opts.journalDiskPath !== undefined ? opts.journalDiskPath : this.diskPath,
      );
      const nonce = mintNonce(random);
      // D-G5：TSA 请求摘要与锚载荷同域 —— witness 在场 ⇒ 第三方回执连回放
      // 见证一起绑定（canonical 过滤 undefined ⇒ 无见证锚的摘要逐字节旧形态）；
      // ΑΩ-R42：auxChains 同律 —— 旁链快照一并入第三方绑定域
      const digest = anchorPayloadDigest({ seq, chainTip, mmrRoot, prevAnchorHash, witness: opts.witness, auxChains });
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
            // ΑΩ-R5：领取时离线验签判决随锚入册（anchorHash 哈希域覆盖 —— 防篡改
            // 同律；四值如实，绝不因验签失败回退或抛异常 —— 绑定与背书分维度上报）
            signatureVerified: r.signatureVerified,
          };
        } else {
          // 诚实回退 + 注记：回执未取得，本地钟顶上，失败事实留在锚上（不掩盖）
          timestamp = {
            source: 'local', anchoredAt: t, nonce: toB64(nonce),
            note: `rfc3161 fallback (${r.error}) — local clock only, NOT third-party attestation`,
          };
        }
      }

      const seed: Omit<AnchorRecord, 'hash'> = {
        seq, chainTip, mmrRoot, timestamp, prevAnchorHash,
        // D-G5：见证在场 ⇒ 入哈希域（anchorHash 覆盖全部字段 —— 防篡改同律）；
        // 缺席 ⇒ 键不落（canonical 语义下 undefined 与缺键同域 —— 旧锚逐字节不变）
        ...(opts.witness !== undefined ? { witness: opts.witness } : {}),
        // ΑΩ-R42：旁链快照同律 —— 在场入哈希域（篡改三元组任一字节 ⇒ 锚 hash
        // 失配）；缺席 ⇒ 键不落（沙箱未启用不伪造空链，旧锚逐字节不变）
        ...(auxChains !== undefined ? { auxChains } : {}),
      };
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
   *      + ΑΩ-R42 旁链重算比对（auxChains 三元组 vs 旁链账本重算 —— 注记级，
   *      不一致 ⇒ 注记 aux-chain-drift 不翻章：锚定 ≠ 内容为真）
   *   ④ replay-consistency Χ 纪元三态升级：沙箱段在场 ⇒ deterministicReplay 重演
   *      逐位比对（绿=可复现 / 红=链完整但内容与确定性世界不符）；无沙箱段 ⇒
   *      诚实 n/a（真机 journal 段不可复现）；旧格式无指纹 ⇒ n/a(legacy)。
   *      沙箱账本可经 opts.sandboxLedger 注入（缺省自动发现沙箱单例）。
   */
  verifyNotary(opts: { ledger?: NotarizableLedger; sandboxLedger?: SandboxLog; journalDiskPath?: string } = {}): NotaryReport {
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

    // ③ 时间锚：锚自链 + journal 前缀重走 + rfc3161 token 离线复核 + ΑΩ-R42 旁链
    //    重算比对（注记级 —— 沙箱账本可经 opts.sandboxLedger 注入，缺省自动发现
    //    沙箱单例；与重放章④共享同一注入面）。ΝΩ-21：journalDisk 旁链同段重算
    //    （opts.journalDiskPath 注入优先，缺省 configure 登记路径）；genTime 与
    //    anchoredAt 的 |Δ| ≤ 1h 校验同章注记（genTime-skew —— 注记级不翻章）。
    guard('timestamp-anchor', () =>
      this.verifyTimestampAnchor(ledger, opts.sandboxLedger,
        opts.journalDiskPath !== undefined ? opts.journalDiskPath : this.diskPath));

    // ④ 重放一致性（Χ 纪元升级：Π 的 n/a 承诺兑现为可执法的三态）。沙箱段在
    //    场 ⇒ 确定性重放逐位执法；真机段保持诚实 n/a（世界不可复现）；旧格式
    //    无指纹 ⇒ n/a(legacy)。attestReplayConsistency 自身永不抛 —— guard 双保险
    //    同律（章级隔离：此章崩溃不炸其余三章与总报告）。
    guard('replay-consistency', () =>
      attestReplayConsistency({ sandboxLedger: opts.sandboxLedger }));

    const ok = (Object.values(badges) as BadgeStatus[]).every(b => b.status !== 'red');
    const last = this.anchors.at(-1) ?? null;
    // ΝΩ-21（NO-3 自适应锚频）：journal 自上锚增量的观测注记（shouldAnchor 判据
    // 纯函数面）。超阈 ⇒ 章③ detail 追加补锚提示 —— quality_checkup notarize 的
    // 输出面（badges 投影）即可见，「在 notarize 动作旁提示」的最小接线；判据面
    // 不动、不引入后台定时器。观测崩溃 ⇒ null（旁路注记绝不炸报告）。
    let anchorCadence: NotaryReport['anchorCadence'] = null;
    if (last) {
      try {
        const grown = ledger.entries().length - last.seq;
        anchorCadence = {
          entriesSinceLastAnchor: grown,
          threshold: ADAPTIVE_ANCHOR_THRESHOLD,
          due: shouldAnchor(grown),
        };
        if (anchorCadence.due) {
          badges['timestamp-anchor'].detail +=
            `; adaptive-anchor hint (NO-3): journal grew ${grown} entries since the last anchor (threshold ${ADAPTIVE_ANCHOR_THRESHOLD}) — mint a fresh anchor (shouldAnchor)`;
        }
      } catch {
        anchorCadence = null; // 增量不可观测 ⇒ 注记缺席（不是故障）
      }
    }
    return {
      ok,
      badges,
      anchors: this.anchors.length,
      anchorCadence,
      lastAnchor: last ? {
        seq: last.seq,
        chainTip: last.chainTip,
        mmrRoot: last.mmrRoot,
        source: last.timestamp.source,
        anchoredAt: last.timestamp.anchoredAt,
        imprintVerified: last.timestamp.imprintVerified ?? null,
        // ΑΩ-R5：随锚在册的领取时判决（timestamp 属 anchorHash 哈希域 —— 判决本身
        // 防篡改；旧锚/local 缺席 ⇒ null 诚实标注，绝不虚报 true）
        signatureVerified: last.timestamp.signatureVerified ?? null,
        // ΑΩ-R42：末锚的旁链快照投影（在场 ⇒ 下游可直接复核；旧锚/沙箱缺席 ⇒
        // null 诚实标注 —— 与 signatureVerified 的 null 语义同律）
        auxChains: last.auxChains ?? null,
        // ΝΩ-21：末锚 token 的 TSA 权威时刻（离线提取自留存物证；local/旧锚/
        // genTime 畸形 ⇒ null —— 透传供下游独立复核，偏差执法在章③注记）
        genTime: last.timestamp.source === 'rfc3161' && last.timestamp.token
          ? extractGenTime(new Uint8Array(Buffer.from(last.timestamp.token, 'base64')))
          : null,
        hash: last.hash,
        prevAnchorHash: last.prevAnchorHash,
      } : null,
    };
  }

  /** 章③实现：三段核验 —— 任一段硬失败 ⇒ 红；前缀重走不可得（驱逐）⇒ 整章诚实 n/a；
   *  ΑΩ-R42 追加 ③-d 旁链重算比对（注记级 —— 绝不翻红，判据论证见该段注释）；
   *  ΝΩ-21 追加 journalDisk 旁链重算（同 ③-d 段）与 genTime 偏差注记（③-c 段） */
  private verifyTimestampAnchor(
    ledger: NotarizableLedger,
    sandboxLedger?: SandboxLog,
    journalDiskPath?: string,
  ): BadgeStatus {
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

    // ③-d ΑΩ-R42：旁链重算比对（注记级核验 —— 绝不翻红）。对每枚锚的 auxChains
    //    三元组：从旁链账本（注入优先，缺省沙箱单例）的链基重走前 seq 条复算链尖
    //    （sandboxLog.prefixTip —— log.ts 的只读原语），与锚上宣誓的 chainTip 对照。
    //    不一致 ⇒ 注记 aux-chain-drift（证词在场、章判据不动）；不可判 ⇒ n/a 注记。
    //    ΝΩ-21 第二旁链 journalDisk：对磁盘 JSONL 的前 seq 完整行重算整体 sha256
    //    与锚上宣誓指纹对照 —— 不一致 ⇒ 注记 disk-chain-drift（同律注记级）。
    //    本段置于 ③-b 驱逐早退之前 —— 任何 return 路径都携带旁链证词（容量驱逐
    //    正是 journalDisk 要堵的盲区：③-b n/a 时磁盘史是否被动过只在此处可证）。
    //    不翻红的论证（锚定 ≠ 内容为真 —— 与 ΑΩ-R5 signatureVerified 同律的保守
    //    取舍）：章③既有判据是「锚自链完整 + journal 前缀重走 + 回执物证复核」，
    //    全部关于 journal 主账与锚记录自身；旁链漂移（学习史/磁盘史在锚后被改写/
    //    回滚）否定的是「旁链现状与锚宣誓一致」这一新增维度，不是锚记录的伪证 ——
    //    锚的哈希域覆盖 auxChains（篡改锚上三元组已被 ③-a 执法为红），此处翻红等于
    //    用新证据改判旧罪（锚定行为本身不因此变伪证）。失败绝不被静默：drift 注记 +
    //    报告 lastAnchor.auxChains 字段如实呈现，下游（宿主/外部审计）可独立执法；
    //    若未来工单决定翻红，只动此分支 —— 判据面已隔离。防御式：垃圾形状（非数组/
    //    非串 tip）⇒ n/a 注记，绝不炸章（guard 之外的第二道保险）。
    {
      const auxLedger = sandboxLedger ?? sandboxLog;
      for (let i = 0; i < this.anchors.length; i++) {
        const a = this.anchors[i];
        const aux = Array.isArray(a.auxChains) ? a.auxChains : null;
        if (!aux) {
          details.push(`anchor #${i}: no aux-chain snapshot on record (pre-ΑΩ-R42 anchor, or sandbox ledger absent at mint time) — honest n/a`);
          continue;
        }
        for (const t of aux) {
          if (!t || typeof t !== 'object' || typeof t.chainName !== 'string'
            || (t.chainName !== 'sandboxLog' && t.chainName !== 'journalDisk')) {
            details.push(`anchor #${i}: aux chain '${t && typeof t.chainName === 'string' ? t.chainName : '?'}' outside the recompute registry (registry: sandboxLog, journalDisk) — honest n/a`);
            continue;
          }
          // ΝΩ-21：journalDisk —— 磁盘 JSONL 前 seq 行的整体 sha256 重算比对
          if (t.chainName === 'journalDisk') {
            const swornLines = typeof t.seq === 'number' ? t.seq : -1;
            const swornHash = typeof t.chainTip === 'string' ? t.chainTip : String(t.chainTip);
            if (swornLines < 0) {
              details.push(`anchor #${i}: aux chain journalDisk carries a malformed line count — honest n/a`);
              continue;
            }
            if (!journalDiskPath) {
              details.push(`anchor #${i}: journalDisk chain on record but no journal disk path configured — honest n/a (cannot re-hash without the ledger file)`);
              continue;
            }
            let bytes: Buffer;
            try {
              bytes = readFileSync(journalDiskPath);
            } catch (e) {
              details.push(`anchor #${i}: journalDisk not recomputable (ledger file unreadable: ${errText(e)}) — honest n/a, forensics lost with the file`);
              continue;
            }
            const linesNow = countCompleteLines(bytes);
            if (linesNow < swornLines) {
              details.push(`anchor #${i}: disk-chain-drift — swears journalDisk@${swornLines} lines but the file now holds ${linesNow} complete lines (disk journal truncated/rewritten below the sworn watermark; badge criteria unchanged — anchoring is not a claim that content is true)`);
              continue;
            }
            const recomputed = sha256OfFirstLines(bytes, swornLines);
            if (recomputed === null || recomputed !== swornHash) {
              details.push(`anchor #${i}: disk-chain-drift — swears journalDisk@${swornLines} tip ${swornHash.slice(0, 12)}… but re-hash recomputes ${(recomputed ?? '?').slice(0, 12)}… (disk journal rewritten after anchoring; badge criteria unchanged — anchoring is not a claim that content is true)`);
            } else {
              details.push(`anchor #${i}: journalDisk re-hash over the sworn ${swornLines}-line prefix reproduces its fingerprint${linesNow > swornLines ? ` (file grew to ${linesNow} lines since — append-only, prefix intact)` : ''}`);
            }
            continue;
          }
          const recomputed = auxLedger.prefixTip(typeof t.seq === 'number' ? t.seq : -1);
          const swornTip = typeof t.chainTip === 'string' ? t.chainTip : String(t.chainTip);
          if (recomputed === null) {
            details.push(`anchor #${i}: aux chain sandboxLog@seq ${t.seq} not recomputable (capacity eviction advanced the chain base, or ledger rolled back below the sworn watermark) — honest n/a, disk JSONL holds forensics`);
          } else if (recomputed !== swornTip) {
            details.push(`anchor #${i}: aux-chain-drift — swears sandboxLog@${t.seq} tip ${swornTip.slice(0, 12)}… but re-walk recomputes ${recomputed.slice(0, 12)}… (learning history drifted from the sworn snapshot; badge criteria unchanged — anchoring is not a claim that content is true)`);
          } else {
            details.push(`anchor #${i}: aux chain sandboxLog re-walk over ${t.seq} entr${t.seq === 1 ? 'y' : 'ies'} reproduces its chainTip`);
          }
        }
      }
    }

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
    // ΑΩ-R5：物证核验升级为两维度 —— 绑定（imprint+nonce，既有判据不动）+
    // TSA 签名判决（signatureVerified，注记/报告如实上报、保守不翻红）
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
      let verified: { ok: boolean; error?: string; signatureVerified?: SignatureVerdict; signatureError?: string; genTime?: number | null };
      try {
        const v = verifyTimestampToken(
          new Uint8Array(token),
          { digest: new Uint8Array(digest), nonce: new Uint8Array(nonce) },
        );
        verified = {
          ok: v.ok,
          ...(v.ok ? {} : { error: v.error }),
          signatureVerified: v.signatureVerified,
          ...(v.signatureError !== undefined ? { signatureError: v.signatureError } : {}),
          genTime: v.genTime,
        };
      } catch (e) {
        verified = { ok: false, error: errText(e) }; // 双保险：复核崩溃不炸核验面
      }
      if (verified.ok) {
        details.push(`anchor #${i}: token imprint+nonce re-verified offline (receipt on record)`);
        // ΝΩ-21：genTime 执法 —— TSA 权威时刻（token 内被签的 GeneralizedTime）与
        // 锚本地钟 anchoredAt 的偏差校验（容差 GEN_TIME_SKEW_TOLERANCE_MS = 1h）。
        // 注记级不翻章（保守取舍，与 signatureVerified/aux-chain-drift 同律）：超差
        // 否定的是「TSA 钟与本地钟一致」这一新增旁证维度，不是物证绑定本身 —— 翻红
        // 等于用新证据改判旧罪。失败绝不静默：genTime-skew 注记 + 报告 lastAnchor.
        // genTime 字段透传，下游可独立执法。genTime 不可提取 ⇒ 诚实 n/a 注记。
        const genTime = verified.genTime ?? null;
        if (genTime !== null) {
          const skew = genTime - a.timestamp.anchoredAt;
          if (Math.abs(skew) > GEN_TIME_SKEW_TOLERANCE_MS) {
            details.push(`anchor #${i}: genTime-skew — TSA genTime ${new Date(genTime).toISOString()} vs anchoredAt ${new Date(a.timestamp.anchoredAt).toISOString()} (|Δ| ${Math.round(Math.abs(skew) / 60000)} min > ${GEN_TIME_SKEW_TOLERANCE_MS / 60000} min tolerance); badge criteria unchanged (reported, downstream may enforce)`);
          } else {
            details.push(`anchor #${i}: TSA genTime ${new Date(genTime).toISOString()} within ±${GEN_TIME_SKEW_TOLERANCE_MS / 60000}min of anchoredAt (skew ${skew >= 0 ? '+' : ''}${Math.round(skew / 1000)}s)`);
          }
        } else {
          details.push(`anchor #${i}: genTime not extractable from the retained token (non-CMS shape or malformed TSTInfo) — honest n/a`);
        }
        // ΑΩ-R5：签名判决如实入注记 —— 保守取舍：signatureVerified=false 不翻红章。
        // 理由：① 章③既有判据是「物证绑定」（imprint+nonce 对上 = 回执在册且绑定
        // 本锚）—— 签名失败否定的是「TSA 背书」这一新增维度，不是绑定事实本身，
        // 翻红等于用新证据改判旧罪（既有时序下的锚不因此变伪证）；② 判绿只认
        // true —— false/边界值都进 detail 与报告字段（lastAnchor.signatureVerified），
        // 失败绝不被静默，下游（宿主/外部审计）可据此独立执法。若未来工单决定
        // 翻红，只动此分支 —— 判据面已隔离。
        if (verified.signatureVerified === true) {
          details.push(`anchor #${i}: TSA signature verified offline against the embedded signer certificate (RSA PKCS#1 v1.5 / ECDSA over sha256/384/512)`);
        } else if (verified.signatureVerified === false) {
          details.push(`anchor #${i}: TSA signature verification FAILED (${verified.signatureError ?? 'reason unknown'}) — imprint+nonce binding holds but the third-party attestation is UNPROVEN (reported, badge criteria unchanged)`);
        } else if (verified.signatureVerified === 'unpinned-key') {
          // ΝΩ-21：pin 部署在场时的新判决 —— 签名数学成立但签名者不在 pin 表。
          // 同律注记级（不翻红）：判绿只认 true，'unpinned-key' 保守呈现供下游执法。
          details.push(`anchor #${i}: TSA signer key NOT pinned — signature math holds but the signer SPKI is outside the DSH_TSA_PIN_SHA256 pin table (${verified.signatureError ?? 'reason unknown'}); receipt binding stands, trust anchor refused (reported, badge criteria unchanged)`);
        } else {
          details.push(`anchor #${i}: TSA signature NOT verified — ${verified.signatureVerified ?? 'not attempted'} (${verified.signatureError ?? 'honest boundary'}); receipt binding stands, attestation unproven`);
        }
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

// ─── ΝΩ-21（NO-3 自适应锚频）：journal 自上锚增量超阈 ⇒ 补锚的判据与接线面 ───

/** NO-3 自适应锚频阈值（条）：journal 自上锚增量超过该值 ⇒ 建议补锚 */
export const ADAPTIVE_ANCHOR_THRESHOLD = 50;

/**
 * NO-3 自适应锚频判据（纯函数，永不抛）：增量 > 阈值 ⇒ true。
 * 观测面（不引入后台定时器 —— 锚频决策只搭既有路径的车）：
 *   · verifyNotary 的 anchorCadence 注记 + 章③ detail 补锚提示（quality_checkup
 *     notarize 动作输出的 badges 投影即可见 —— 「在 notarize 旁提示」的最小接线）；
 *   · 卸载/定期路径的接线面 notaryAutoAnchorIfDue（见下）。
 */
export function shouldAnchor(entriesSinceLastAnchor: number, threshold: number = ADAPTIVE_ANCHOR_THRESHOLD): boolean {
  return Number.isFinite(entriesSinceLastAnchor) && entriesSinceLastAnchor > threshold;
}

/**
 * NO-3 卸载/定期路径接线面（与 notaryAutoAnchorIfConfigured 同律、增量门控）：
 * 开关真 且 journal 自上锚增量超阈（shouldAnchor）⇒ 补铸一枚锚 —— 长会话只在
 * 「有足量新行为」时才在卸载时刻补锚，锚链密度自适应行为流。fire-and-forget、
 * 吞错（公证是旁路仪式）；增量不足/开关假/缺省 ⇒ 零行为。
 */
export function notaryAutoAnchorIfDue(config: {
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
    const last = notary.lastAnchor();
    const grown = journalLedger.entries().length - (last?.seq ?? 0);
    if (!shouldAnchor(grown)) return;
    // fire-and-forget + 双保险吞错（anchorOnce 自身已永不抛 —— 此处 belt & braces）
    void notary.anchorOnce().catch(() => { /* 公证是旁路仪式 */ });
  } catch {
    /* 绝不炸宿主 */
  }
}

/**
 * 把回放轨迹见证铸进 notary 单例锚（D-G5 便捷面，绑定单例 —— 永不抛）：
 * 未装配 ⇒ 诚实降级（reason 申报公证缺席）；endpoint 空 = 本地时间锚零网络
 * （既有纪律保持）。结构性注入测试走 anchorReplayTrajectoryOn（假件执法缝）。
 */
export async function anchorReplayTrajectory(
  witness: ReplayTrajectoryWitness,
  opts: ReplayAnchorOptions = {},
): Promise<ReplayAnchorResult> {
  return anchorReplayTrajectoryOn(notary, witness, opts);
}
