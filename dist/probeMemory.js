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
import { similarity } from './perceptualHash.js';
/** 判决性检验：只有 control/text 值得记忆 */
export function isDecisive(verdict) {
    return verdict === 'control' || verdict === 'text';
}
/** 通道全集：canonical 顺序即先验序 */
export const PROBE_ECON_CHANNELS = ['uia', 'cursor', 'repaint'];
function freshEcon() {
    return { uia: { trials: 0, flips: 0, totalMs: 0 }, cursor: { trials: 0, flips: 0, totalMs: 0 }, repaint: { trials: 0, flips: 0, totalMs: 0 } };
}
/** 伯努利熵 H₂(p)（比特）；p∈{0,1} 取 0（退化分布无不确定性） */
export function bernoulliBits(p) {
    if (!Number.isFinite(p) || p <= 0 || p >= 1)
        return 0;
    return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}
class ProbeMemory {
    entries = [];
    capacity = 128;
    /** 纪元 Ν：通道经济学账（会话内自适应状态，不入 checkpoint） */
    econ = freshEcon();
    configure(capacity) {
        this.capacity = Math.max(1, capacity);
    }
    reset() {
        this.entries = [];
        this.econ = freshEcon();
    }
    get size() {
        return this.entries.length;
    }
    /** 入册：判决性结论 + 场景指纹。同场景邻近点就近强化（hits 滚动）而非重复入册 */
    store(sceneHash, result, cfg) {
        if (!isDecisive(result.verdict))
            return;
        const near = this.entries.find(e => Math.abs(e.point.x - result.point.x) <= cfg.probeRecallRadius &&
            Math.abs(e.point.y - result.point.y) <= cfg.probeRecallRadius &&
            similarity(sceneHash, e.sceneHash) >= cfg.probeMemorySceneSimilarity);
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
    recall(sceneHash, point, cfg) {
        const now = Date.now();
        let best = null;
        for (const e of this.entries) {
            if (now - e.lastUsedAt > cfg.probeMemoryTtlMs)
                continue;
            const sim = similarity(sceneHash, e.sceneHash);
            if (sim < cfg.probeMemorySceneSimilarity)
                continue;
            const dist = Math.hypot(e.point.x - point.x, e.point.y - point.y);
            if (dist > cfg.probeRecallRadius)
                continue;
            if (!best || sim > best.sim + 1e-9 ||
                (Math.abs(sim - best.sim) <= 1e-9 && dist < best.dist)) {
                best = { entry: e, sim, dist };
            }
        }
        if (!best)
            return null;
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
    noteChannel(channel, ms, verdictBefore, verdictAfter) {
        const slot = this.econ[channel];
        if (!slot)
            return; // 未知通道名：静默忽略（运行层永不抛）
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
    channelEconomics() {
        const valid = PROBE_ECON_CHANNELS.every(ch => {
            const s = this.econ[ch];
            return Number.isFinite(s.trials) && Number.isFinite(s.flips) && Number.isFinite(s.totalMs) &&
                s.trials >= 0 && s.flips >= 0 && s.totalMs >= 0 && s.flips <= s.trials;
        });
        if (!valid)
            this.econ = freshEcon();
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
    dump() {
        return { entries: this.entries };
    }
    restore(data) {
        if (!data?.entries)
            return;
        this.entries = data.entries.slice(-this.capacity);
    }
}
// 单例：会话内的判决肌肉记忆
export const probeMemory = new ProbeMemory();
