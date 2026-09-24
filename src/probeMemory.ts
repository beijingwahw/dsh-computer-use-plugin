// src/probeMemory.ts
// ─── Z 纪元（Z-1d）：探针判决记忆化 —— 实验成本摊销到每个场景一次 ───
//
// 世界行动引擎的实验要花时间（悬停 dwell + 指纹往返）；但同一个界面
// 反复 find_text 时，同一批点的判决几乎不变：聊天正文悬停一万次也还是
// ibeam，按钮悬停一万次也还是 Button。判决记忆律：
//
//   判决性结论（control/text）随形成时的整屏指纹一起入册；
//   同场景（指纹相似度 ≥ 阈值）再遇到邻近点（距离 ≤ 半径）⇒ 直接复用，
//   不再动鼠标、不再发实验。
//
// 与 uiMemory（landmark）的关系：landmark 记「成功点击的位置」，是正向
// 记忆；本模块记「交互性判决」，**负向记忆（text 拒判）恰是最有价值的
// 一半** —— 聊天文本的拒判稳定且每次 find_text 都会重遇。两库同用
// 感指纹机制、同置信律（召回降一等），但语义正交，故独立成册。
//
// 不记什么（诚实律）：
//   - inconclusive 不记 —— 「不知道」不是证据；环境微变后的重实验是对的
//   - 无指纹（截图失败）不记 —— 无场景锚的判决无法安全复用
//
// 召回降级律：via=memory、confidence -0.03 且封顶 0.9 —— 记忆是先验，
// 永不冒充新鲜实验。
import { similarity } from './perceptualHash';
import type { ProbeResult, InteractivityVerdict, ProbeEvidence } from './interactivityProbe';

export interface ProbeMemoryEntry {
  /** 判决形成时的整屏指纹（场景锚） */
  sceneHash: string;
  point: { x: number; y: number };
  verdict: InteractivityVerdict;
  confidence: number;
  /** 判决通道与核心证据（召回时透传给锚点） */
  via: ProbeEvidence['via'];
  controlType: string | null;
  cursorKind: string;
  /** 命中次数（复用即 +1 —— 记忆价值的度量） */
  hits: number;
  /** 最近使用时间（TTL + LRU 驱逐的事实源） */
  lastUsedAt: number;
}

export interface ProbeMemoryConfigLike {
  probeMemoryTtlMs: number;
  probeMemoryCapacity: number;
  probeMemorySceneSimilarity: number;
  probeRecallRadius: number;
}

/** 判决性检验：只有 control/text 值得记忆 */
export function isDecisive(verdict: InteractivityVerdict): boolean {
  return verdict === 'control' || verdict === 'text';
}

class ProbeMemory {
  private entries: ProbeMemoryEntry[] = [];
  private capacity = 128;

  configure(capacity: number) {
    this.capacity = Math.max(1, capacity);
  }

  reset() {
    this.entries = [];
  }

  get size(): number {
    return this.entries.length;
  }

  /** 入册：判决性结论 + 场景指纹。同场景邻近点就近强化（hits 滚动）而非重复入册 */
  store(sceneHash: string, result: ProbeResult, cfg: ProbeMemoryConfigLike): void {
    if (!isDecisive(result.verdict)) return;
    const near = this.entries.find(e =>
      Math.abs(e.point.x - result.point.x) <= cfg.probeRecallRadius &&
      Math.abs(e.point.y - result.point.y) <= cfg.probeRecallRadius &&
      similarity(sceneHash, e.sceneHash) >= cfg.probeMemorySceneSimilarity,
    );
    if (near) {
      // 就近强化：滚动到最新事实（场景指纹/证据更新，判决以新覆旧）
      near.verdict = result.verdict;
      near.confidence = result.confidence;
      near.via = result.evidence.via;
      near.controlType = result.evidence.hit_test?.control_type ?? null;
      near.cursorKind = result.evidence.cursor_kind;
      near.hits++;
      near.lastUsedAt = Date.now();
      near.point = result.point;
      near.sceneHash = sceneHash;
      return;
    }
    this.entries.push({
      sceneHash,
      point: { ...result.point },
      verdict: result.verdict,
      confidence: result.confidence,
      via: result.evidence.via,
      controlType: result.evidence.hit_test?.control_type ?? null,
      cursorKind: result.evidence.cursor_kind,
      hits: 1,
      lastUsedAt: Date.now(),
    });
    // 容量驱逐：LRU（最近最少使用先走）
    if (this.entries.length > this.capacity) {
      this.entries.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
      this.entries = this.entries.slice(0, this.capacity);
    }
  }

  /**
   * 召回：TTL 内 + 场景指纹相似度 ≥ 阈值 + 点距 ≤ 半径。
   * 多命中取场景相似度最高者（并列取距离更近者）。
   */
  recall(
    sceneHash: string,
    point: { x: number; y: number },
    cfg: ProbeMemoryConfigLike,
  ): ProbeResult | null {
    const now = Date.now();
    let best: { entry: ProbeMemoryEntry; sim: number; dist: number } | null = null;
    for (const e of this.entries) {
      if (now - e.lastUsedAt > cfg.probeMemoryTtlMs) continue;
      const sim = similarity(sceneHash, e.sceneHash);
      if (sim < cfg.probeMemorySceneSimilarity) continue;
      const dist = Math.hypot(e.point.x - point.x, e.point.y - point.y);
      if (dist > cfg.probeRecallRadius) continue;
      if (!best || sim > best.sim + 1e-9 ||
          (Math.abs(sim - best.sim) <= 1e-9 && dist < best.dist)) {
        best = { entry: e, sim, dist };
      }
    }
    if (!best) return null;
    const e = best.entry;
    e.hits++;
    e.lastUsedAt = now; // 命中即续期（LRU 活性）
    return {
      point: { ...point },
      verdict: e.verdict,
      // 召回降级律：记忆是先验，降一等且封顶 —— 永不冒充新鲜实验
      confidence: Math.min(0.9, e.confidence - 0.03),
      evidence: {
        via: 'memory',
        cursor_kind: e.cursorKind,
        hover_repaint: false,
        repaint_similarity: null,
        dwell_ms: 0,
        ...(e.controlType != null || e.via === 'uia'
          ? {
            hit_test: {
              control_type: e.controlType,
              name: '',
              classification: e.verdict === 'control' ? 'control' : 'text',
              matched_depth: null,
            },
          }
          : {}),
      },
      note: `recalled from scene memory (scene_similarity=${best.sim.toFixed(3)}, hits=${e.hits})`,
    };
  }

  /** checkpoint 序列化面（与 uiMemory.dump 同律） */
  dump(): { entries: ProbeMemoryEntry[] } {
    return { entries: this.entries };
  }

  restore(data: { entries?: ProbeMemoryEntry[] } | undefined): void {
    if (!data?.entries) return;
    this.entries = data.entries.slice(-this.capacity);
  }
}

// 单例：会话内的判决肌肉记忆
export const probeMemory = new ProbeMemory();
