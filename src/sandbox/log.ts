// src/sandbox/log.ts
// D-5 沙箱会话日志：append-only 哈希链账本（DSH 可观测性铁律）。
// 规范对齐 journal.ts（sha256 链式防篡改），但独立成链 —— 零侵入红线：
// journal 的 JournalMarker 是封闭联合类型，沙箱事件不越权注入宿主账本；
// D-4 审查沙箱链时以 doctor/verdict 的 chainTip 锚点定位本账本。
// canonical/chainHash 是 journal.ts 的模块私有纯函数，此处按同一密码学规范复刻
// （纯密码学原语复刻 ≠ 业务逻辑越权；哈希域构造必须逐字节一致才能保持链语义）。
import { appendFile, mkdir } from 'fs/promises';
import { createHash } from 'crypto';
import path from 'path';
import { mmrRoot, mmrInclusionProof, type InclusionProof } from '../proof';

/** 沙箱账本条目：语义事件（非宿主工具镜像）。kind 即事件分类学。
 *  链段扩展（P1-5 可观测性对齐）：D-6 流水线（'pipeline-*'）与 D-7 隐知识中枢
 *  （'knowledge-*'）复用本账本 —— 单链多器官段，append-only 哈希链统一防篡改；
 *  D-6 此前经 as any 越权注入，现收编为显式契约（消灭类型逃逸）。 */
export type SandboxLogKind =
  | 'snapshot-created'
  | 'rehearsal-begin'
  | 'rehearsal-step'
  | 'rehearsal-end'
  | 'verdict-received'
  | 'consolidation'
  | 'recall'
  | 'host-replay-gate'
  | 'host-replay-end'
  | 'observation'
  // ── D-6 编排链段（orchestration/pipeline.ts）──
  | 'pipeline-attempt'
  | 'pipeline-retry'
  | 'pipeline-grounding'
  | 'pipeline-grounding-denied'
  | 'pipeline-grounding-review'
  | 'pipeline-vision-breach'
  | 'pipeline-internal-fault'
  | 'pipeline-run-end'
  // ── D-7 隐知识链段（knowledge/pipeline.ts —— P1-5 新增）──
  | 'knowledge-retrieval'
  | 'knowledge-attempt'
  | 'knowledge-learned'
  | 'knowledge-internal-fault'
  | 'knowledge-run-end'
  // ── D-7 神经纪元（睡眠整合：海马体→皮层的 run-end 蒸馏报告）──
  | 'knowledge-consolidated'
  // ── D-7 预测编码纪元（世界模型：转移结算 + 惊讶计费 —— L3 花钱权的审计面）──
  | 'world-transition';

export interface SandboxLogEntry {
  ts: number;
  kind: SandboxLogKind;
  data: Record<string, any>;
  /** 链上哈希：sha256(prevHash + canonical(entry without hash)) */
  hash?: string;
}

const GENESIS = 'GENESIS';

// ── Χ 纪元（沙箱重放证词）：链上记录面补齐屏指纹（纯增量，旧行结构零破坏）──
// Π 公证了「行为史未被篡改」；Χ 进一步公证「行为史可复现」—— 对确定性沙箱段
// （排练链），重放是可执法的。前提是链上在册：完整动作 + 每步后的虚拟屏状态
// 指纹。既有 rehearsal-step 只记 kind/证据布尔 —— 本纪元以**可选字段**补记：
// 旧格式行无指纹 ⇒ 消费方（notary 重放章）诚实 n/a(legacy)，绝不炸既有读者。

/** Χ 指纹格式标记：Χ 后代码写入的 rehearsal-begin/step 携带（旧账本无此字段）。
 *  消费方据此区分「旧格式不可重放」与「新格式但无场景」—— 两者证词语义不同。 */
export const REHEARSAL_FP_FORMAT = 1;

/** 可重放排练段（Χ 取证面投影）：begin 的入口场景 + 逐步的动作与屏指纹。
 *  scene 是 asVirtualWidget 规范形（与 VirtualScreen 内部世界逐位同源 —— 引擎
 *  铸造点保证；此处只做防御性深拷贝，调用方改写不污染链上视图）。 */
export interface RehearsalForensicSegment {
  chainId: string;
  scene: unknown;
  /** 逐步证词：链上 index / 完整动作 / 该步后屏状态指纹 */
  steps: Array<{ index: number; action: unknown; fingerprint: string }>;
}

/** 记录防御性深拷贝（JSON 安全数据 —— 往返即拷贝；异值原样奉还） */
function forensicClone<T>(v: T): T {
  try {
    return JSON.parse(JSON.stringify(v)) as T;
  } catch {
    return v;
  }
}

/** 稳定序列化：键排序 —— 同一对象永远产生同一字符串（哈希链的前提；对齐 journal.canonical） */
function canonical(obj: any): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  return '{' + Object.keys(obj).sort()
    .map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** 链式哈希：entry 的指纹 = sha256(前条哈希 + 本条内容哈希域)，哈希域不含自身 */
function chainHash(prev: string, entry: SandboxLogEntry): string {
  const { hash: _omit, ...domain } = entry;
  return sha256(prev + canonical(domain));
}

/**
 * 沙箱账本：内存窗口 + 可选 JSONL 落盘 + 哈希链防篡改。
 * 抛错契约：一切方法永不抛错 —— 落盘失败 console.warn（旁路义务不阻断主流程）。
 */
export class SandboxLog {
  private entries: SandboxLogEntry[] = [];
  private filePath = '';
  private capacity = 2000;
  private chainTip = GENESIS;
  private chainBase = GENESIS;
  /** 落盘写串行队列：append 可并发重入（fire-and-forget 调用方在场），链推进是
   *  同步节（内存序 = 调用序），但并发 appendFile 交错会让 JSONL 行序与链序
   *  脱钩（取证重放断链）—— 单写队列保行序与链序一致 */
  private writeQueue: Promise<void> = Promise.resolve();

  configure(filePath: string, capacity: number): void {
    this.filePath = filePath;
    this.capacity = capacity;
  }

  reset(): void {
    this.entries = [];
    this.chainTip = GENESIS;
    this.chainBase = GENESIS;
  }

  /** 链尖端（快照铸造与 verdict 关联的锚点源） */
  get tip(): string {
    return this.chainTip;
  }

  async append(kind: SandboxLogKind, data: Record<string, any> = {}): Promise<void> {
    const entry: SandboxLogEntry = { ts: Date.now(), kind, data };
    entry.hash = chainHash(this.chainTip, entry);
    this.chainTip = entry.hash;
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      const evicted = this.entries.shift()!;
      this.chainBase = evicted.hash ?? GENESIS; // 链基前滚（对齐 journal B-1 语义）
    }
    if (this.filePath) {
      const filePath = this.filePath; // configure 可能在队列排空前换址 —— 逐条快照
      const line = JSON.stringify(entry) + '\n';
      const write = this.writeQueue.then(async () => {
        try {
          await mkdir(path.dirname(filePath), { recursive: true });
          await appendFile(filePath, line, 'utf8');
        } catch (e: any) {
          console.warn(`[SandboxLog] write failed: ${e.message}`);
        }
      });
      this.writeQueue = write;
      await write;
    }
  }

  /** 链完整性校验：从链基重放存活窗口，返回第一个断点（verify 语义对齐 journal） */
  verify(): { ok: boolean; length: number; brokenAt: number | null } {
    let prev = this.chainBase;
    for (let i = 0; i < this.entries.length; i++) {
      const expect = chainHash(prev, this.entries[i]);
      if (this.entries[i].hash !== expect) {
        return { ok: false, length: this.entries.length, brokenAt: i };
      }
      prev = expect;
    }
    return { ok: true, length: this.entries.length, brokenAt: null };
  }

  list(): ReadonlyArray<SandboxLogEntry> {
    return this.entries;
  }

  /** Χ 纪元取证面：提取可重放排练段（动作序列 + 屏指纹序列）—— 重放章的权威
   *  记录源。只收完整段（begin 在场 + 场景在场 + 步带指纹）；无场景段（排练
   *  未声明 virtualScene）、容量驱逐后的残段、旧格式段均不入列 —— 分类语义
   *  （legacy / 无段 / 无场景）由消费方经 fpFormat 自裁。永不抛：崩溃 = 无段
   *  可证（诚实缺席，绝不炸调用方）。 */
  exportRehearsalSegments(): RehearsalForensicSegment[] {
    try {
      const out: RehearsalForensicSegment[] = [];
      let current: RehearsalForensicSegment | null = null;
      for (const e of this.entries) {
        if (e.kind === 'rehearsal-begin') {
          current = {
            chainId: String(e.data?.chainId ?? ''),
            scene: forensicClone(e.data?.scene),
            steps: [],
          };
          out.push(current);
        } else if (e.kind === 'rehearsal-step') {
          // 同链归属防御：步的 chainId 必须与开段一致（交错写入不误归属）
          if (current && e.data?.chainId === current.chainId
            && e.data?.action && typeof e.data?.screenFingerprint === 'string') {
            current.steps.push({
              index: typeof e.data?.index === 'number' ? e.data.index : current.steps.length,
              action: forensicClone(e.data.action),
              fingerprint: e.data.screenFingerprint,
            });
          }
        } else if (e.kind === 'rehearsal-end') {
          if (!current || e.data?.chainId === current.chainId) current = null;
        }
      }
      return out.filter(s => Array.isArray(s.scene) && (s.scene as unknown[]).length > 0
        && s.steps.length > 0);
    } catch {
      return []; // 取证面崩溃 = 无段可证 —— 诚实缺席优于半段毒证
    }
  }

  // ── Q 纪元（Q-1 证明层）：MMR 包含证明面（叶值 = 链哈希；纯计算零存储）──
  /** 排练链 MMR 根（O(n) 计算 —— D-6 verify_pipeline_log 之外的取证升级面） */
  mmrRoot(): string | null {
    const leaves = this.entries.map(e => e.hash).filter((h): h is string => typeof h === 'string');
    return leaves.length > 0 ? mmrRoot(leaves) : null;
  }

  /** 第 index 条链记录的包含证明（与 mmrRoot 配对验证） */
  mmrProof(index: number): InclusionProof | null {
    const leaves = this.entries.map(e => e.hash).filter((h): h is string => typeof h === 'string');
    return mmrInclusionProof(leaves, index);
  }
}

/** 模块级单例（对齐 journal 的导出方言；生命周期随 ctx.effect 清理复位） */
export const sandboxLog = new SandboxLog();
