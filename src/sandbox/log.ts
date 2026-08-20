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
      try {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        await appendFile(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
      } catch (e: any) {
        console.warn(`[SandboxLog] write failed: ${e.message}`);
      }
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
}

/** 模块级单例（对齐 journal 的导出方言；生命周期随 ctx.effect 清理复位） */
export const sandboxLog = new SandboxLog();
