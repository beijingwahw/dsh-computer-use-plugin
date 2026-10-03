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

// ─── 纪元 Ν（探索经济学）：通道经济学账 —— 交互性探针的「比特/成本」后验 ───
//
// Z 纪元把三通道按**先验**判别力降序固定（UIA > 光标 > 重绘）。但判别力是世界
// 的属性，不是探针的属性：在「光标多半是手型/工型」的网页世界，光标通道每秒
// 比特远超 UIA（UIA 对 canvas/Web 主动无结构层登记，点查询只花钱不翻案）；
// 在原生 Win32 应用反过来。Ν 让探针学会花钱：每通道记账 {trials, flips,
// totalMs}，flips = 该通道执行后**改写此前判决**的次数（含把 standing 的
// inconclusive 改写为 control/text 的首判——弃权与维持原判不计），由此得
// 每通道的 bitsPerMs 后验，供探针按期望信息增益每毫秒排序通道（排序与停止
// 决策在 interactivityProbe.ts；本模块只管账）。
//
// 与判决记忆（entries）的关系：entries 记「世界的答案」（可跨会话复用），
// 经济账记「问世界的成本结构」（会话内自适应状态——通道成本随机器/服务版本
// 漂移，持久化无意义），故不入 dump/restore，随 reset() 清零。

/** 交互性探针的三个证据通道（顺序 = Z 纪元先验判别力降序，即经济学的先验序） */
export type ProbeChannel = 'uia' | 'cursor' | 'repaint';

/** 通道全集：canonical 顺序即先验序 */
export const PROBE_ECON_CHANNELS: readonly ProbeChannel[] = ['uia', 'cursor', 'repaint'] as const;

/** 单通道经济账的查询面（bitsPerMs = bitsEstimate / meanMs） */
export interface ChannelEcon {
  channel: ProbeChannel;
  /** 执行次数（含失败/弃权的执行——成本真实发生了） */
  trials: number;
  /** 改写此前判决的次数（弃权/维持不计） */
  flips: number;
  /** 累计执行耗时 ms */
  totalMs: number;
  /** 平均单次耗时 ms（totalMs 有 1ms 地板防零除） */
  meanMs: number;
  /**
   * 每次执行的平均熵减近似（bits/trial）：
   *
   *   bitsEstimate = r · H₂(0.5) = r bits，其中 r = flips/trials。
   *
   * 近似式：试前对「该通道是否会改写判决」一无所知——先验 0.5，判决问题
   * （control vs text）的全部不确定性 = 伯努利熵 H₂(0.5) = 1 bit。一次通道
   * 执行以概率 r（试后判别率的极大似然估计）完全改写判决问题（残余熵 0）、
   * 以概率 1−r 弃权/维持（残余熵不变 H₂(0.5)）⇒ 期望残余熵 =
   * (1−r)·H₂(0.5)，熵减 = H₂(0.5) − (1−r)·H₂(0.5) = r·H₂(0.5) = r bits。
   * （不直接取伯努利熵 H₂(r) 的原因：H₂ 对 r 与 1−r 对称，「从不改写」与
   *   「总是改写」会同分，而后者恰是最强判别通道——改写率对通道价值单调，
   *   故以改写率乘先验熵上界为单调近似。）
   */
  bitsEstimate: number;
  /** bitsPerMs = bitsEstimate / meanMs（trials=0 ⇒ 0；除数有 1ms 地板） */
  bitsPerMs: number;
}

interface EconSlot {
  trials: number;
  flips: number;
  totalMs: number;
}

function freshEcon(): Record<ProbeChannel, EconSlot> {
  return { uia: { trials: 0, flips: 0, totalMs: 0 }, cursor: { trials: 0, flips: 0, totalMs: 0 }, repaint: { trials: 0, flips: 0, totalMs: 0 } };
}

/** 伯努利熵 H₂(p)（比特）；p∈{0,1} 取 0（退化分布无不确定性） */
export function bernoulliBits(p: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}

class ProbeMemory {
  private entries: ProbeMemoryEntry[] = [];
  private capacity = 128;
  /** 纪元 Ν：通道经济学账（会话内自适应状态，不入 checkpoint） */
  private econ: Record<ProbeChannel, EconSlot> = freshEcon();

  configure(capacity: number) {
    this.capacity = Math.max(1, capacity);
  }

  reset() {
    this.entries = [];
    this.econ = freshEcon();
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

  // ── 纪元 Ν：通道经济学账 ──

  /**
   * 记一次通道执行（probePoints 经济路径逐通道调用；被记忆召回短路的点
   * 无通道执行，不记）。flip 语义：verdictAfter 是决定性判决（control/text）
   * **且** ≠ 执行前的 standing 判决——即该通道改写了此前判决（standing 的
   * 初始值是探针的诚实默认 inconclusive，故首判「无判 → 有判」也是改写）。
   * 弃权（verdictAfter=null，通道缺席/unknown/无判决力证据）与维持原判不计。
   * 输入不在此处净化：坏值（NaN 等）原样入账，由 channelEconomics() 的
   * 账本体检发现并整体清零（见下）。
   */
  noteChannel(
    channel: ProbeChannel,
    ms: number,
    verdictBefore: InteractivityVerdict | null,
    verdictAfter: InteractivityVerdict | null,
  ): void {
    const slot = this.econ[channel];
    if (!slot) return; // 未知通道名：静默忽略（运行层永不抛）
    slot.trials++;
    slot.totalMs += ms;
    if ((verdictAfter === 'control' || verdictAfter === 'text') && verdictAfter !== verdictBefore) {
      slot.flips++;
    }
  }

  /**
   * 通道经济学账查询面（canonical 顺序 = 先验序）。坏账本 = 清零重来：
   * 任一通道出现非有限值/负数/翻转数超试验数 ⇒ 视为账本损坏（注入损坏或
   * 数值漂移），整体归零回先验——运行层永不抛，排序退回先验序。
   */
  channelEconomics(): ChannelEcon[] {
    const valid = PROBE_ECON_CHANNELS.every(ch => {
      const s = this.econ[ch];
      return Number.isFinite(s.trials) && Number.isFinite(s.flips) && Number.isFinite(s.totalMs) &&
        s.trials >= 0 && s.flips >= 0 && s.totalMs >= 0 && s.flips <= s.trials;
    });
    if (!valid) this.econ = freshEcon();
    return PROBE_ECON_CHANNELS.map(ch => {
      const s = this.econ[ch];
      const safeMs = Math.max(1, s.totalMs); // 1ms 地板：瞬时执行不得造成无穷 bits/ms
      const bitsEstimate = s.trials > 0 ? s.flips / s.trials : 0;
      const meanMs = s.trials > 0 ? safeMs / s.trials : 0;
      return {
        channel: ch,
        trials: s.trials,
        flips: s.flips,
        totalMs: s.totalMs,
        meanMs,
        bitsEstimate,
        bitsPerMs: bitsEstimate > 0 && meanMs > 0 ? bitsEstimate / meanMs : 0,
      };
    });
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
