// src/knowledge/persistence.ts
// 跨会话记忆（Anti-Amnesia）：隐知识库 + 世界模型的原子落盘与水合。
//
// 为什么这是认知架构的地基：无持久化的学习系统是逆行性遗忘症患者 ——
// 「越用越懂宿主」的前提是经验能活过进程边界。本模块是那道边界。
//
// 异常诚实铁律：
//   - save/load 一切 Result 降级，绝不 throw（旁路义务：落盘失败绝不击穿流水线）
//   - 原子写：tmp 文件 + rename（半写的状态文件 = 损坏的脑，宁可没有）
//   - 水合先验后写（器官内 restoreSnapshot 执法）：任一非法 ⇒ 整体拒绝，
//     绝不把半具尸体接活
//   - load 缺席/损坏 ⇒ 空脑开局（诚实的新生儿，不是崩溃的病人）
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Result } from './contracts';
import { InMemoryKnowledgeBase } from './knowledgeBase';
import { InMemoryWorldModel } from './worldModel';

/** 状态文件名（stateDir 内布局 —— 器官各一文件，损坏隔离不传染） */
const KNOWLEDGE_FILE = 'knowledge.json';
const WORLD_MODEL_FILE = 'world-model.json';

/** 原子写（tmp + rename：读者要么看到完整旧态，要么看到完整新态） */
function atomicWriteJson(path: string, data: unknown): Result<void, Error> {
  try {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), 'utf8');
    renameSync(tmp, path);
    return { ok: true, value: undefined };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: new Error(`atomic write failed for ${path}: ${msg}`) };
  }
}

/** 读 + 解析（缺席 ⇒ null；损坏 ⇒ 保留原文交上层诚实处置） */
function readJson(path: string): { ok: true; value: unknown } | { ok: false; error: Error } {
  try {
    if (!existsSync(path)) return { ok: true, value: null };
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: new Error(`read/parse failed for ${path}: ${msg}`) };
  }
}

/**
 * 状态仓（两个器官 + 一个账本的守护者）。
 * 与 MetricsLedger 分治：本类管「脑」（可水合的状态），账本管「史」
 * （append-only 的观测记录 —— 历史不可改写，不需要水合回内存）。
 */
export class KnowledgePersistence {
  private readonly stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  /** 保存两器官（各自独立成败：知识库写失败不阻断世界模型落盘） */
  save(kb: InMemoryKnowledgeBase, wm: InMemoryWorldModel): Result<{ saved: Array<'knowledge' | 'world-model'> }, Error> {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      const saved: Array<'knowledge' | 'world-model'> = [];
      const kbR = atomicWriteJson(join(this.stateDir, KNOWLEDGE_FILE), kb.exportSnapshot());
      if (!kbR.ok) return kbR;
      saved.push('knowledge');
      const wmR = atomicWriteJson(join(this.stateDir, WORLD_MODEL_FILE), wm.exportSnapshot());
      if (!wmR.ok) return wmR;
      saved.push('world-model');
      return { ok: true, value: { saved } };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: new Error(`persistence save fault: ${msg}`) };
    }
  }

  /**
   * 水合两器官（in-place：调用方持有的实例被换脑）。
   * 缺席 ⇒ 空脑开局；损坏 ⇒ 诚实错误（上层决定重置还是停机）——
   * 绝不把损坏文件静默吞掉当空脑（那是数据丢失的伪装）。
   */
  load(kb: InMemoryKnowledgeBase, wm: InMemoryWorldModel): Result<{ loaded: Array<'knowledge' | 'world-model'> }, Error> {
    try {
      const loaded: Array<'knowledge' | 'world-model'> = [];
      const kbRaw = readJson(join(this.stateDir, KNOWLEDGE_FILE));
      if (!kbRaw.ok) return { ok: false, error: kbRaw.error };
      if (kbRaw.value !== null) {
        const r = kb.restoreSnapshot(kbRaw.value);
        if (!r.ok) return { ok: false, error: new Error(`knowledge snapshot corrupt: ${r.error.field}: ${r.error.reason}`) };
        loaded.push('knowledge');
      }
      const wmRaw = readJson(join(this.stateDir, WORLD_MODEL_FILE));
      if (!wmRaw.ok) return { ok: false, error: wmRaw.error };
      if (wmRaw.value !== null) {
        const r = wm.restoreSnapshot(wmRaw.value);
        if (!r.ok) return { ok: false, error: new Error(`world-model snapshot corrupt: ${r.error.field}: ${r.error.reason}`) };
        loaded.push('world-model');
      }
      return { ok: true, value: { loaded } };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: new Error(`persistence load fault: ${msg}`) };
    }
  }
}
