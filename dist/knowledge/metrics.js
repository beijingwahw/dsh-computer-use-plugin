// src/knowledge/metrics.ts
// 认知仪表盘（证据先于修辞的账本）：每 run 一行 JSONL，append-only。
//
// 设计哲学：历史不可改写（append-only，与 sandboxLog 哈希链同精神）；
// 汇总是纯函数（summarizeRuns）—— 同一批记录可以反复重算出同一张仪表盘。
// 这是「学习曲线 / 消融对照」的最小可信数据源：不 beautiful，但 honest。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';
/** 聚合（纯函数）：空批 ⇒ 全零表（诚实的「还没数据」而非 NaN） */
export function summarizeRuns(records) {
    if (records.length === 0) {
        return {
            runs: 0, successRate: 0, avgRounds: 0, avgExecutions: 0, avgDurationMs: 0,
            totalL3Rounds: 0, l3RoundRate: 0, avgKnowledgeRounds: 0,
        };
    }
    const n = records.length;
    const successes = records.filter(r => r.verdict === 'completed').length;
    const rounds = records.reduce((s, r) => s + r.rounds, 0);
    const executions = records.reduce((s, r) => s + r.executions, 0);
    const l3 = records.reduce((s, r) => s + r.l3Rounds, 0);
    const kRounds = records.reduce((s, r) => s + r.knowledgeRounds, 0);
    const round2 = (x) => Math.round(x * 100) / 100;
    return {
        runs: n,
        successRate: round2(successes / n),
        avgRounds: round2(rounds / n),
        avgExecutions: round2(executions / n),
        avgDurationMs: round2(records.reduce((s, r) => s + r.durationMs, 0) / n),
        totalL3Rounds: l3,
        l3RoundRate: rounds > 0 ? round2(l3 / rounds) : 0,
        avgKnowledgeRounds: round2(kRounds / n),
    };
}
/**
 * 学习曲线（纯函数）：把记录按时间序二分前后两半 ——
 * 「越用越好」的证据形态 = 后半 successRate ↑ 或 avgExecutions ↓（学习少烧钱）。
 * 少于 2 条 ⇒ null（切半需要至少每边一条 —— 统计的诚实下限）。
 */
export function learningCurve(records) {
    if (records.length < 2)
        return null;
    const sorted = [...records].sort((a, b) => a.ts - b.ts);
    const mid = Math.floor(sorted.length / 2);
    return {
        firstHalf: summarizeRuns(sorted.slice(0, mid)),
        secondHalf: summarizeRuns(sorted.slice(mid)),
    };
}
/**
 * 指标账本（append-only JSONL）。写失败 = 旁路义务（记 console.warn，
 * 绝不阻断流水线）：仪表盘的缺席不该让机器人失能。
 */
export class MetricsLedger {
    filePath;
    constructor(filePath) {
        this.filePath = filePath;
    }
    /** 追加一行（mkdir -p + appendFileSync —— 单行原子性由行缓冲保证） */
    record(rec) {
        try {
            mkdirSync(dirname(this.filePath), { recursive: true });
            appendFileSync(this.filePath, `${JSON.stringify(rec)}\n`, 'utf8');
            return { ok: true };
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`[MetricsLedger] record degraded: ${msg}`);
            return { ok: false, error: msg };
        }
    }
    /** 全量读回（损坏行跳过并计数 —— append-only 账本对坏行宽容，对历史忠实） */
    readAll() {
        try {
            if (!existsSync(this.filePath))
                return { records: [], corruptLines: 0 };
            const lines = readFileSync(this.filePath, 'utf8').split('\n').filter(l => l.trim());
            const records = [];
            let corruptLines = 0;
            for (const line of lines) {
                try {
                    const obj = JSON.parse(line);
                    if (typeof obj.ts === 'number' && typeof obj.intentId === 'string' && typeof obj.verdict === 'string') {
                        records.push(obj);
                    }
                    else {
                        corruptLines += 1;
                    }
                }
                catch {
                    corruptLines += 1;
                }
            }
            return { records, corruptLines };
        }
        catch {
            return { records: [], corruptLines: 0 };
        }
    }
}
// ─── Q 纪元（Q-6 证据层）：效应量 —— 「主张要有数字」升格为「数字要有效应量与检验」───
/**
 * Cohen's h（两比例的反正弦效应量）：h = 2·[arcsin√p₁ − arcsin√p₂]。
 * 惯例：|h| ≥ 0.2 小 / ≥ 0.5 中 / ≥ 0.8 大。与百分比差不同，h 在比例
 * 接近 0/1 时不虚胀（p₁=1.0 vs p₂=0.85：差 15% 但 h=1.056 —— 极端域的
 * 15% 是巨大效应）。消融对照的成功率主张用它，而非裸差。
 */
export function cohensH(p1, p2) {
    if (![p1, p2].every(p => Number.isFinite(p) && p >= 0 && p <= 1))
        return null;
    const h = 2 * (Math.asin(Math.sqrt(p1)) - Math.asin(Math.sqrt(p2)));
    return Math.round(h * 1000) / 1000;
}
/**
 * Mann–Whitney U（两独立样本的秩和检验统计量，非参 —— 不假设正态）：
 *   U₁ = R₁ − n₁(n₁+1)/2（R₁ = 样本 1 的秩和，并列取平均秩）。
 * 返回 { u1, u2, p } —— p 为精确正态近似（含并列校正与连续性修正的双侧值；
 * 小样本（n₁·n₂ < 8）返回 null p（诚实缺席 —— 查表域）。
 * 消费语义：延迟分布的 A/B 对照不配 t 检验（延迟是重尾 —— GPD 纪元的
 * 教训），配秩检验。
 */
export function mannWhitney(a, b) {
    const xs = [...a, ...b].filter(Number.isFinite);
    if (xs.length !== a.length + b.length || a.length < 2 || b.length < 2)
        return null;
    const n1 = a.length, n2 = b.length;
    // 合并排序 + 平均秩（并列取中位秩）
    const all = [
        ...a.map(v => ({ v, g: 0 })), ...b.map(v => ({ v, g: 1 })),
    ].sort((x, y) => x.v - y.v);
    const ranks = new Array(all.length);
    let i = 0;
    while (i < all.length) {
        let j = i;
        while (j + 1 < all.length && all[j + 1].v === all[i].v)
            j++;
        const avgRank = (i + 1 + j + 1) / 2;
        for (let k = i; k <= j; k++)
            ranks[k] = avgRank;
        i = j + 1;
    }
    let r1 = 0;
    all.forEach((x, idx) => { if (x.g === 0)
        r1 += ranks[idx]; });
    const u1 = r1 - (n1 * (n1 + 1)) / 2;
    const u2 = n1 * n2 - u1;
    if (n1 * n2 < 8)
        return { u1, u2, p: null }; // 小样本查表域：诚实缺席
    // 正态近似（并列校正 σ + 连续性修正）
    const muU = n1 * n2 / 2;
    const N = n1 + n2;
    let tieTerm = 0;
    {
        let k = 0;
        while (k < all.length) {
            let j = k;
            while (j + 1 < all.length && all[j + 1].v === all[k].v)
                j++;
            const t = j - k + 1;
            if (t > 1)
                tieTerm += t ** 3 - t;
            k = j + 1;
        }
    }
    const sigmaU = Math.sqrt((n1 * n2 / (N * (N - 1))) * ((N ** 3 - N - tieTerm) / 12));
    const z = (Math.min(u1, u2) - muU + 0.5) / Math.max(1e-9, sigmaU);
    const p = 2 * (1 - normalCdf(Math.abs(z)));
    return { u1, u2, p: Math.round(p * 10000) / 10000 };
}
/** 标准正态 CDF（Abramowitz–Stegun 7.1.26 有理逼近，|ε| < 7.5e-8） */
function normalCdf(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    const cdf = 1 - (Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI)) * poly;
    return z >= 0 ? cdf : 1 - cdf;
}
