import { shortId } from './internal.js';
/** 统计 top-K 缺省（算法形状字面量 —— 随统计面搬迁，数值逐位不变） */
export const DEFAULT_TOP_K = 5;
// ─── 统计面（纯函数 + 引擎委托） ───
/**
 * 错题本统计（纯函数，永不抛）：对已结算记录聚合。
 * 命中/失手率只以**有预言**的结算为分母（no-model 是无知不是错误 —— 掺水
 * 会让新模型看起来「永远全错」，不诚实）。topMisses 按失手计数降序、
 * (屏型|动作) 字典序破平 —— 全序确定，绝不掷硬币。
 * D-G2：coarseAssisted = predictedVia='coarse' 的已结算预言数（粗层让抖动
 * 变体免于无知 —— 回退收益的可观测面，不掺进命中率分母）。
 */
export function prophecyStats(records, topK = DEFAULT_TOP_K) {
    try {
        let hits = 0;
        let misses = 0;
        let noModel = 0;
        let coarseAssisted = 0;
        let missBits = 0;
        let missBitsN = 0;
        const missCells = new Map();
        for (const r of records) {
            if (!r || typeof r !== 'object')
                continue;
            if (r.outcome === 'hit') {
                hits++;
                if (r.predictedVia === 'coarse')
                    coarseAssisted++;
            }
            else if (r.outcome === 'miss') {
                misses++;
                if (r.predictedVia === 'coarse')
                    coarseAssisted++;
                if (typeof r.surpriseBits === 'number' && Number.isFinite(r.surpriseBits)) {
                    missBits += r.surpriseBits;
                    missBitsN++;
                }
                const key = `${String(r.screenType)}|${String(r.actionKey)}`;
                const cell = missCells.get(key) ?? { screenType: String(r.screenType), actionKey: String(r.actionKey), count: 0 };
                cell.count++;
                missCells.set(key, cell);
            }
            else if (r.outcome === 'no-model') {
                noModel++;
            } // pending / 垃圾值不入统计（账本不该有 pending —— 防御式忽略）
        }
        const denom = hits + misses;
        const k = typeof topK === 'number' && Number.isFinite(topK) && topK >= 1 ? Math.floor(topK) : DEFAULT_TOP_K;
        const topMisses = [...missCells.values()]
            .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.screenType < b.screenType ? -1 : a.screenType > b.screenType ? 1 : a.actionKey < b.actionKey ? -1 : a.actionKey > b.actionKey ? 1 : 0))
            .slice(0, k)
            .map(c => ({ screenType: c.screenType, actionKey: c.actionKey, count: c.count }));
        const round6 = (x) => Math.round(x * 1e6) / 1e6;
        return {
            settled: records.length,
            hits,
            misses,
            noModel,
            hitRate: denom > 0 ? round6(hits / denom) : 0,
            missRate: denom > 0 ? round6(misses / denom) : 0,
            avgMissSurpriseBits: missBitsN > 0 ? round6(missBits / missBitsN) : 0,
            coarseAssisted,
            topMisses,
        };
    }
    catch {
        return {
            settled: 0, hits: 0, misses: 0, noModel: 0,
            hitRate: 0, missRate: 0, avgMissSurpriseBits: 0, coarseAssisted: 0, topMisses: [],
        }; // 统计绝不抛（运行层铁律）
    }
}
/**
 * 置信校准面（纯函数，永不抛）：把对账历史与铸造时自报置信并排 —— 自报 p 与
 * 实测命中率的落差就是校准缺口（过信/欠信一目了然）。只读派生：**不回写铸造**
 * （predictedProb 保持世界模型单一真相 —— 预言是审计旁路，校准是审计的审计；
 * 消费方读数自决，模块铁律「绝不影响动作选择」不动分毫）。
 * no-model 不入分母（无知无置信）；缺概率读数的预言计入 prophecies/hits 但
 * 不入 avgPredictedProb/brier（诚实缺席，不按 0.5 假充）。
 */
export function prophecyCalibration(records) {
    try {
        const cells = new Map();
        let agg = { prophecies: 0, hits: 0, probSum: 0, probN: 0, brierSum: 0 };
        for (const r of records) {
            if (!r || typeof r !== 'object')
                continue;
            if (r.outcome !== 'hit' && r.outcome !== 'miss')
                continue; // no-model/pending 不校准
            const hit = r.outcome === 'hit';
            const p = typeof r.predictedProb === 'number' && Number.isFinite(r.predictedProb)
                ? Math.min(1, Math.max(0, r.predictedProb))
                : null;
            const key = `${String(r.screenType)}|${String(r.actionKey)}`;
            const cell = cells.get(key) ?? {
                screenType: String(r.screenType), actionKey: String(r.actionKey),
                prophecies: 0, hits: 0, probSum: 0, probN: 0, brierSum: 0,
            };
            cell.prophecies++;
            if (hit)
                cell.hits++;
            if (p !== null) {
                cell.probSum += p;
                cell.probN++;
                cell.brierSum += (p - (hit ? 1 : 0)) ** 2;
            }
            cells.set(key, cell);
            agg.prophecies++;
            if (hit)
                agg.hits++;
            if (p !== null) {
                agg.probSum += p;
                agg.probN++;
                agg.brierSum += (p - (hit ? 1 : 0)) ** 2;
            }
        }
        const round6 = (x) => Math.round(x * 1e6) / 1e6;
        const mk = (c) => ({
            prophecies: c.prophecies,
            hits: c.hits,
            hitRate: c.prophecies > 0 ? round6(c.hits / c.prophecies) : 0,
            avgPredictedProb: c.probN > 0 ? round6(c.probSum / c.probN) : null,
            brier: c.probN > 0 ? round6(c.brierSum / c.probN) : null,
        });
        return {
            cells: [...cells.values()]
                .sort((a, b) => (b.prophecies !== a.prophecies ? b.prophecies - a.prophecies
                : a.screenType < b.screenType ? -1 : a.screenType > b.screenType ? 1
                    : a.actionKey < b.actionKey ? -1 : a.actionKey > b.actionKey ? 1 : 0))
                .map(c => ({ screenType: c.screenType, actionKey: c.actionKey, ...mk(c) })),
            aggregate: agg.prophecies > 0
                ? mk(agg)
                : null, // 无有预言结算 ⇒ 全局校准诚实缺席
        };
    }
    catch {
        return { cells: [], aggregate: null }; // 校准绝不抛
    }
}
/**
 * 失败复盘（纯函数，永不抛）：对最常失手的 (屏型,动作) 格，把「反复押什么」
 * 与「实际到什么」并排 —— 押注方向错（模型期望 ≠ 世界去向）与方向对但分布散
 * （同格多去向裂开）是两种不同的病，复盘面如实分诊。众数破平取字典序最小
 * （确定序）；无失手 ⇒ 空册。
 */
export function prophecyPostmortem(records, topK = DEFAULT_TOP_K) {
    try {
        const cells = new Map();
        for (const r of records) {
            if (!r || typeof r !== 'object' || r.outcome !== 'miss')
                continue;
            const key = `${String(r.screenType)}|${String(r.actionKey)}`;
            const cell = cells.get(key) ?? {
                screenType: String(r.screenType), actionKey: String(r.actionKey),
                misses: 0, bitsSum: 0, bitsN: 0, predicted: new Map(), actual: new Map(),
            };
            cell.misses++;
            if (typeof r.surpriseBits === 'number' && Number.isFinite(r.surpriseBits) && r.surpriseBits >= 0) {
                cell.bitsSum += r.surpriseBits;
                cell.bitsN++;
            }
            if (typeof r.predictedType === 'string' && r.predictedType !== '') {
                cell.predicted.set(r.predictedType, (cell.predicted.get(r.predictedType) ?? 0) + 1);
            }
            if (typeof r.actualType === 'string' && r.actualType !== '') {
                cell.actual.set(r.actualType, (cell.actual.get(r.actualType) ?? 0) + 1);
            }
            cells.set(key, cell);
        }
        const modal = (m) => {
            let best = null;
            let bestN = -1;
            for (const [k, n] of [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
                if (n > bestN) {
                    bestN = n;
                    best = k;
                } // 计数破平取字典序最小（先入序已排）
            }
            return best;
        };
        const k = typeof topK === 'number' && Number.isFinite(topK) && topK >= 1 ? Math.floor(topK) : DEFAULT_TOP_K;
        return [...cells.values()]
            .sort((a, b) => (b.misses !== a.misses ? b.misses - a.misses : a.screenType < b.screenType ? -1 : a.screenType > b.screenType ? 1 : a.actionKey < b.actionKey ? -1 : a.actionKey > b.actionKey ? 1 : 0))
            .slice(0, k)
            .map(c => ({
            screenType: c.screenType,
            actionKey: c.actionKey,
            misses: c.misses,
            avgSurpriseBits: c.bitsN > 0 ? Math.round((c.bitsSum / c.bitsN) * 1e6) / 1e6 : null,
            predictedModal: modal(c.predicted),
            actualModal: modal(c.actual),
        }));
    }
    catch {
        return []; // 复盘绝不抛
    }
}
/**
 * 失败复盘注记（纯函数，永不抛）：一行一格的 journal 方言注记（Token 纪律：
 * 指纹截 16 字符）。押注方向错 ⇒ 「押注方向错」；众数押中但格内仍失手 ⇒
 * 「分布散裂」（去向不止一处 —— 粗层/聚类该接管的信号）。无失手 ⇒ 空册。
 */
export function prophecyPostmortemLines(records, topK = DEFAULT_TOP_K) {
    try {
        return prophecyPostmortem(records, topK).map((c, i) => {
            const bits = c.avgSurpriseBits !== null ? `均惊异 ${Math.round(c.avgSurpriseBits * 1000) / 1000} bits，` : '';
            const p = c.predictedModal !== null ? shortId(c.predictedModal) : '?';
            const a = c.actualModal !== null ? shortId(c.actualModal) : '?';
            const verdict = c.predictedModal !== null && c.actualModal !== null && c.predictedModal === c.actualModal
                ? '众数押中仍失手 —— 分布散裂（去向裂开多格，粗层/聚类该接管）'
                : '押注方向错（模型期望 ≠ 世界去向）';
            return `prophecy:复盘 #${i + 1} ${shortId(c.screenType)}|${c.actionKey} —— 失手 ${c.misses} 次（${bits}反复押 ${p}，实际到 ${a}：${verdict}）`;
        });
    }
    catch {
        return []; // 注记绝不抛
    }
}
