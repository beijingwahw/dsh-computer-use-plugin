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
