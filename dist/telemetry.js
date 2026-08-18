// src/telemetry.ts
// 第七轮创新之一：零依赖指标引擎（可观测性支柱）。
// 世界级系统的共识：没有度量就没有优化 —— 你无法改进你看不见的东西。
// 三层指标，全部本地实时、零外部依赖：
//   1. 工具层：per-tool 调用数 / 成败 / 疑似无效(noop) / 延迟分位数（环形缓冲精确 P50/P95/P99）
//   2. 命中层：UI 记忆命中、技能命中、失败记忆命中（记忆系统的投资回报率）
//   3. 汇总层：全局成功率、noop 率、最慢工具 —— 一眼定位系统瓶颈
// 接线：guards 的 post-execute 观察位纯旁路记录；暴露 get_metrics 工具给模型自省
// （模型能看到「我最近 20% 的点击疑似无效」并主动换策略 —— 自观测的 Agent）。
const LATENCY_RING = 512; // 每工具延迟样本环形缓冲；世界级标准：精确分位而非桶近似
/** 环形缓冲分位数：线性插入 O(1)，快照时一次性排序（读取频率远低于写入） */
function percentile(sorted, p) {
    if (sorted.length === 0)
        return 0;
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
}
class Telemetry {
    tools = new Map();
    counters = new Map();
    startedAt = Date.now();
    enabled = true;
    configure(enabled) {
        this.enabled = enabled;
    }
    slot(tool) {
        let s = this.tools.get(tool);
        if (!s) {
            s = { calls: 0, successes: 0, failures: 0, noops: 0, totalMs: 0, latencies: [] };
            this.tools.set(tool, s);
        }
        return s;
    }
    /**
     * 工具调用观测（guards post-execute 挂载点调用）。
     * status 语义与 journal/熔断共享同一字符串契约：SUCCESS / FAILED / UNKNOWN。
     */
    observe(tool, status, ms, noop = false) {
        if (!this.enabled)
            return;
        const s = this.slot(tool);
        s.calls++;
        s.totalMs += ms;
        if (status === 'SUCCESS')
            s.successes++;
        else if (status === 'FAILED')
            s.failures++;
        // noop 语义自我一致：只统计「报成功但无效果」—— 失败已单独计数，避免双重惩罚
        if (noop && status === 'SUCCESS')
            s.noops++;
        s.latencies.push(Math.round(ms));
        if (s.latencies.length > LATENCY_RING)
            s.latencies.shift();
    }
    /** 命中率计数（记忆系统投资回报）：hit=true 命中 / false 未命中 */
    note(counter, hit) {
        if (!this.enabled)
            return;
        let c = this.counters.get(counter);
        if (!c) {
            c = { hits: 0, misses: 0 };
            this.counters.set(counter, c);
        }
        hit ? c.hits++ : c.misses++;
    }
    /** 结构化快照：机器可读（checkpoint / 上报） */
    snapshot() {
        const tools = [...this.tools.entries()].map(([name, s]) => {
            const sorted = [...s.latencies].sort((a, b) => a - b);
            return {
                tool: name,
                calls: s.calls,
                success_rate: s.calls ? Math.round((s.successes / s.calls) * 1000) / 10 : null,
                noop_rate: s.calls ? Math.round((s.noops / s.calls) * 1000) / 10 : null,
                avg_ms: s.calls ? Math.round(s.totalMs / s.calls) : null,
                p50_ms: percentile(sorted, 50),
                p95_ms: percentile(sorted, 95),
                p99_ms: percentile(sorted, 99),
            };
        }).sort((a, b) => b.calls - a.calls);
        const counters = [...this.counters.entries()].map(([name, c]) => {
            const total = c.hits + c.misses;
            return { counter: name, hits: c.hits, misses: c.misses, hit_rate: total ? Math.round((c.hits / total) * 1000) / 10 : null };
        });
        const calls = [...this.tools.values()].reduce((n, s) => n + s.calls, 0);
        const successes = [...this.tools.values()].reduce((n, s) => n + s.successes, 0);
        const failures = [...this.tools.values()].reduce((n, s) => n + s.failures, 0);
        const noops = [...this.tools.values()].reduce((n, s) => n + s.noops, 0);
        return {
            uptime_sec: Math.round((Date.now() - this.startedAt) / 1000),
            global: {
                calls, successes, failures, noops,
                success_rate: calls ? Math.round((successes / calls) * 1000) / 10 : null,
                noop_rate: calls ? Math.round((noops / calls) * 1000) / 10 : null,
            },
            tools,
            counters,
        };
    }
    /** 人类可读渲染（get_metrics 工具输出） */
    render() {
        const snap = this.snapshot();
        const lines = [
            `[Metrics] uptime=${snap.uptime_sec}s | global: ${snap.global.calls} calls, ` +
                `success=${snap.global.success_rate ?? '-'}%, noop=${snap.global.noop_rate ?? '-'}%`,
            'tool                 calls  success  noop   p50ms  p95ms',
            '----                 -----  -------  ----   -----  -----',
        ];
        for (const t of snap.tools) {
            lines.push(`${t.tool.padEnd(20)} ${String(t.calls).padStart(5)}  ` +
                `${String(t.success_rate ?? '-').padStart(7)}  ${String(t.noop_rate ?? '-').padStart(4)}  ` +
                `${String(t.p50_ms).padStart(5)}  ${String(t.p95_ms).padStart(5)}`);
        }
        for (const c of snap.counters) {
            lines.push(`counter ${c.counter}: ${c.hits}/${c.hits + c.misses} hit (${c.hit_rate ?? '-'}%)`);
        }
        return lines.join('\n');
    }
    /** 模型自省指引：最值得警惕的信号直接给结论，不给原始数据让模型自己算 */
    insights() {
        const out = [];
        for (const [name, s] of this.tools) {
            if (s.calls >= 5) {
                const noopRate = s.noops / s.calls;
                if (noopRate >= 0.4) {
                    out.push(`HIGH NO-OP: ${Math.round(noopRate * 100)}% of ${name} calls changed nothing on screen — ` +
                        'coordinates are likely wrong. Use zoom_inspect or recall_ui before the next attempt.');
                }
                const failRate = s.failures / s.calls;
                if (failRate >= 0.5) {
                    out.push(`LOW SUCCESS: ${name} succeeds only ${100 - Math.round(failRate * 100)}% of the time — ` +
                        'switch modality (keyboard via press_hotkey) or consult match_skill for a verified route.');
                }
            }
        }
        return out;
    }
    /** dump/restore：checkpoint 崩溃恢复用（保留计数，延迟样本不必跨会话携带） */
    dump() {
        const tools = [...this.tools.entries()].map(([name, s]) => ({
            tool: name, calls: s.calls, successes: s.successes, failures: s.failures,
            noops: s.noops, totalMs: s.totalMs,
        }));
        const counters = [...this.counters.entries()].map(([name, c]) => ({ counter: name, ...c }));
        return { tools, counters };
    }
    restore(data) {
        if (!data)
            return;
        for (const t of data.tools ?? []) {
            const s = this.slot(t.tool);
            Object.assign(s, {
                calls: t.calls ?? 0, successes: t.successes ?? 0, failures: t.failures ?? 0,
                noops: t.noops ?? 0, totalMs: t.totalMs ?? 0,
            });
        }
        for (const c of data.counters ?? []) {
            this.counters.set(c.counter, { hits: c.hits ?? 0, misses: c.misses ?? 0 });
        }
    }
    reset() {
        this.tools.clear();
        this.counters.clear();
        this.startedAt = Date.now();
    }
}
export const telemetry = new Telemetry();
