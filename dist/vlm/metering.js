// src/vlm/metering.ts
// 纪元 Ω（Ω-10 云脑皮层计量）：VLM 调用计量 / 双桶滑动窗限流 / API 熔断 / 全抖动退避。
// 纯离线器官 —— 零网络零 sharp：时间轴全部可注入（构造/方法传 now），云脑的每一次
// 心跳都可被测试离线复算。数学传统延续：全抖动退避 uniform(0, b·2^n)（AWS 架构
// 博客同源）、延迟分位数最近邻秩法（与 telemetry.percentile 同律）、熔断遵循
// guards 的「拒绝优于谎言」—— 全部具名导出、绝不抛异常（垃圾输入诚实降级）。
import { kernelRegistry } from '../kernel/registry.js';
/** 延迟分位窗口：只看最近 1000 个样本（最近邻秩法精确分位，无桶近似） */
const LATENCY_WINDOW = 1000;
/** 最近邻秩分位：sorted 升序，index = min(n−1, floor(q·n))；空样本诚实回 0 */
function rankPercentile(sorted, q) {
    if (sorted.length === 0)
        return 0;
    const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
    return sorted[idx];
}
/**
 * VLM 调用计量器：append-only 台账 + 窗口化分位快照。
 * 写入 O(1)、读取时排序（读写频率不对称 —— 与 telemetry 的延迟环同一取舍，
 * 但此处保留全量台账供 exportJsonl 审计，分位数只取最近 1000 个样本）。
 */
export class VlmMeter {
    records = [];
    /** 记入一次调用：非对象输入直接丢弃（诚实降级，绝不抛异常）；字段做有限性消毒 */
    record(rec) {
        if (!rec || typeof rec !== 'object')
            return;
        // 消毒副本：外部对象后续突变不污染台账；非有限数值归零，未知类别归 'unknown'
        const copy = {
            ts: Number.isFinite(rec.ts) ? rec.ts : 0,
            kind: typeof rec.kind === 'string' ? rec.kind : 'unknown',
            model: typeof rec.model === 'string' ? rec.model : 'unknown',
            latencyMs: Number.isFinite(rec.latencyMs) ? rec.latencyMs : 0,
            ok: rec.ok === true,
        };
        if (Number.isFinite(rec.promptTokens))
            copy.promptTokens = rec.promptTokens;
        if (Number.isFinite(rec.completionTokens))
            copy.completionTokens = rec.completionTokens;
        if (typeof rec.error === 'string')
            copy.error = rec.error;
        this.records.push(copy);
    }
    /** 结构化快照：计数 / 令牌 / byKind 分桶 / 窗口化 p50·p95（最近邻秩法） */
    summary() {
        let failures = 0, totalLatencyMs = 0, promptTokens = 0, completionTokens = 0;
        const byKind = {};
        for (const r of this.records) {
            if (!r.ok)
                failures++;
            totalLatencyMs += r.latencyMs;
            promptTokens += r.promptTokens ?? 0;
            completionTokens += r.completionTokens ?? 0;
            byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
        }
        const recent = this.records.slice(-LATENCY_WINDOW)
            .map(r => r.latencyMs)
            .sort((a, b) => a - b);
        return {
            calls: this.records.length,
            failures,
            totalLatencyMs,
            p50LatencyMs: rankPercentile(recent, 0.5),
            p95LatencyMs: rankPercentile(recent, 0.95),
            promptTokens,
            completionTokens,
            byKind,
        };
    }
    /** JSONL 审计导出：每行一个 JSON（空台账返回空串）；消费方可直接落盘/回放 */
    exportJsonl() {
        return this.records.map(r => JSON.stringify(r)).join('\n');
    }
    /** 清空台账（计量归零 —— 会话切换 / 测试隔离用） */
    reset() {
        this.records = [];
    }
}
/** 模块级单例：云脑皮层的全局心跳账本（插件生命周期内唯一） */
export const vlmMeter = new VlmMeter();
// ─── 限流：双桶滑动窗（分钟桶 × 小时桶） ───
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/**
 * VLM 限流器：滑动窗双桶 —— 分钟桶容量 maxPerMinute、小时桶容量 maxPerHour
 * （缺省 = 分钟 × 60，即「允许持续满速一小时」的保守缺省）。now 可注入，
 * 测试零墙钟。语义要点：
 *   - 获批须**两桶同时有空位**（分钟桶防突发，小时桶防日预算耗尽）；
 *   - 被拒不占配额（denied 的戳不入账）；
 *   - retryAfterMs = 到最近**可获批**释放边界的毫秒数：若两桶皆满，
 *     须等较晚释放的那个（只等较早的桶边界处重试必再被拒 —— 诚实值取 max）；
 *   - 桶容量为 0 的退化配置 ⇒ 永拒（降级方向为「拒绝优于超支」），等待期以整窗计。
 */
export class VlmRateLimiter {
    maxPerMinute;
    maxPerHour;
    /** 已获批的时间戳（升序不假设 —— 注入时间可回拨，扫描时动态取最老） */
    stamps = [];
    constructor(opts) {
        const m = Number.isFinite(opts?.maxPerMinute) ? Math.max(0, Math.floor(opts.maxPerMinute)) : 0;
        this.maxPerMinute = m;
        const h = opts?.maxPerHour;
        // 缺省小时桶 = 分钟桶 × 60；显式注入可以为任意值（含比分钟桶更紧的日预算）
        this.maxPerHour = Number.isFinite(h) ? Math.max(0, Math.floor(h)) : m * 60;
    }
    /** 尝试获取一个配额：获批则入账并放行；被拒则给出到最近可获批边界的毫秒数 */
    tryAcquire(now) {
        const t = Number.isFinite(now) ? now : Date.now();
        // 单遍扫描：滑出小时窗的戳出账（内存有界），窗内计数 + 各桶最老戳（释放边界锚）
        let minuteCount = 0, hourCount = 0;
        let minuteOldest = Infinity, hourOldest = Infinity;
        const kept = [];
        for (const s of this.stamps) {
            if (!(s > t - HOUR_MS))
                continue;
            kept.push(s);
            hourCount++;
            if (s < hourOldest)
                hourOldest = s;
            if (s > t - MINUTE_MS) {
                minuteCount++;
                if (s < minuteOldest)
                    minuteOldest = s;
            }
        }
        this.stamps = kept;
        let wait = 0;
        if (minuteCount >= this.maxPerMinute) {
            // 最老戳 + 窗宽 = 该桶释放边界；空桶且容量 0 ⇒ 无戳可滑出，以整窗为等待期
            const boundary = Number.isFinite(minuteOldest) ? minuteOldest + MINUTE_MS : t + MINUTE_MS;
            wait = Math.max(wait, boundary - t);
        }
        if (hourCount >= this.maxPerHour) {
            const boundary = Number.isFinite(hourOldest) ? hourOldest + HOUR_MS : t + HOUR_MS;
            wait = Math.max(wait, boundary - t);
        }
        if (wait > 0)
            return { allowed: false, retryAfterMs: wait };
        this.stamps.push(t);
        return { allowed: true, retryAfterMs: 0 };
    }
}
// ─── 熔断：连续失败计数 + 冷却期 ───
/**
 * VLM API 熔断器：连续失败 ≥ failureThreshold（缺省 5）⇒ open（拒绝一切）；
 * cooldownMs（缺省 60000）期满自动回 closed —— 半开语义在 state()/retryAt()
 * 内惰性判定（无需后台定时器，纯函数式时间注入）；成功清零连续失败。
 * open 态再遭失败 ⇒ 冷却期自该失败重新起算（API 仍在病中，冷静期不缩水）。
 *
 * 纪元 Ξ（Ξ-D 生产接线）：缺省参读内核注册表 —— vlm.breakerFailures（缺省 5）
 * / vlm.breakerCooldownMs（缺省 60000）。读点在构造器的缺省表达式：每次
 * new 求值一次 ⇒ set 后新实例即时生效（显式入参恒压过注册表，调用方主权）；
 * 未注册 ⇒ getOrDefault 回声字面量，行为逐字节不变。
 */
export class VlmApiBreaker {
    failureThreshold;
    cooldownMs;
    consecutive = 0;
    openedAt = null;
    constructor(opts) {
        const ft = opts?.failureThreshold;
        this.failureThreshold = Number.isFinite(ft)
            ? Math.max(1, Math.floor(ft))
            : Math.max(1, Math.floor(kernelRegistry.getOrDefault('vlm.breakerFailures', 5)));
        const cd = opts?.cooldownMs;
        this.cooldownMs = Number.isFinite(cd)
            ? Math.max(0, Math.floor(cd))
            : Math.max(0, Math.floor(kernelRegistry.getOrDefault('vlm.breakerCooldownMs', 60000)));
    }
    /** 惰性半开判定：open 且冷静期满 ⇒ 回 closed（连续失败清零，还给完整机会） */
    refresh(t) {
        if (this.openedAt !== null && t - this.openedAt >= this.cooldownMs) {
            this.openedAt = null;
            this.consecutive = 0;
        }
    }
    /** 一次成功：无论 closed（清零连败）还是 open/半开（试探成功即治愈）都闭合 */
    onSuccess(now) {
        this.refresh(Number.isFinite(now) ? now : Date.now());
        this.openedAt = null;
        this.consecutive = 0;
    }
    /** 一次失败：连败 +1，越阈 ⇒ open；open 态失败 ⇒ 冷却期重燃（自此刻重新起算） */
    onFailure(now) {
        const t = Number.isFinite(now) ? now : Date.now();
        this.refresh(t);
        this.consecutive++;
        if (this.consecutive >= this.failureThreshold)
            this.openedAt = t;
    }
    /** 当前状态（半开语义在此判定：冷静期满即视为 closed） */
    state(now) {
        this.refresh(Number.isFinite(now) ? now : Date.now());
        return this.openedAt === null ? 'closed' : 'open';
    }
    retryAt(now) {
        this.refresh(Number.isFinite(now) ? now : Date.now());
        return this.openedAt === null ? null : this.openedAt + this.cooldownMs;
    }
}
/**
 * 全抖动退避（Full Jitter，AWS 架构博客同源）：返回 uniform(0, min(cap, base·2^attempt))。
 * 纯函数、直接用 Math.random（测试只断言范围与上界单调，不播种）；base 缺省 500ms、
 * cap 缺省 8000ms；attempt 非有限值按 0 计，指数溢出（2^attempt → ∞）由 cap 兜底。
 */
export function jitterBackoff(attempt, baseMs = 500, capMs = 8000) {
    const a = Number.isFinite(attempt) ? Math.max(0, attempt) : 0;
    const b = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 500;
    const c = Number.isFinite(capMs) && capMs > 0 ? capMs : 8000;
    const upper = Math.min(c, b * 2 ** a);
    return Math.random() * upper;
}
