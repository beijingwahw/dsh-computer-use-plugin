// src/approval.ts
// 第六轮创新之一：一次性审批令牌（One-shot Approval Token）。
// 不可逆操作（发送/删除/支付/提交订单…）需要显式授权：模型先 request_approval
// 生成令牌并告知用户，用户在对话中同意后，模型携令牌重试动作。
// 令牌四性质：一次性（用后即焚）、短时效（默认 120s）、带用途（描述随行）、
// **须授予**（J 纪元：grant_approval(token, true) 是执行的必要条件 ——
// 旧协议"从未 grant"与"grant=true"对执行层无区别，审批闸门的同意环节形同虚设）。
//
// Y 纪元（Y-10）：审批令牌桶 —— 同意本身也是有限资源。
import { randomBytes } from 'node:crypto';
const pending = new Map();
const TTL_MS = 120000;
function newToken() {
    // CSPRNG（对齐 capToken.ensureKey 的密钥强度标准）：令牌门禁的是不可逆操作，
    // Math.random 可预测且 8 字符 base36 空间在高频下可碰撞（静默顶掉待审批项）
    return 'APR-' + randomBytes(8).toString('hex').toUpperCase();
}
// ─── Y-10 审批令牌桶（Epoch Y：不可逆操作的同意也有速率上限）───
//
// 数学：令牌桶限流 —— 容量 C=3、回填周期 R=10min（每 10 分钟回填 1 枚，
// 桶满不累积）。grant=true 消费一枚令牌；桶空 ⇒ 拒绝授予并进入冷静期。
// 威胁模型：被劫持/被诱导的模型可以在短时间内对用户施压获取一连串「同意」
// （click-fatigue 攻击）—— 速率上限把单会话的最大不可逆操作数压到常数，
// 且强制两次危险操作之间至少间隔一个回填周期，给人类留出反悔的时间窗。
export class TokenBucket {
    tokens;
    lastRefillAt;
    now;
    // P 纪元律：构造器参数属性是 transform 语法 —— Node strip-only 拒载。显式字段。
    capacity;
    refillIntervalMs;
    constructor(capacity = 3, refillIntervalMs = 10 * 60 * 1000, initialTokens, now = Date.now) {
        this.capacity = capacity;
        this.refillIntervalMs = refillIntervalMs;
        this.tokens = initialTokens ?? capacity;
        this.lastRefillAt = now();
        this.now = now;
    }
    refill() {
        const elapsed = this.now() - this.lastRefillAt;
        const accrued = Math.floor(elapsed / this.refillIntervalMs);
        if (accrued > 0) {
            this.tokens = Math.min(this.capacity, this.tokens + accrued);
            this.lastRefillAt += accrued * this.refillIntervalMs;
        }
    }
    /** 取一枚令牌；桶空返回冷静期毫秒数（拒绝提示的事实源） */
    tryTake() {
        this.refill();
        if (this.tokens >= 1) {
            this.tokens -= 1;
            return { ok: true };
        }
        return { ok: false, retryInMs: this.refillIntervalMs - (this.now() - this.lastRefillAt) };
    }
    /** 余量（遥测/锚点透明化） */
    available() {
        this.refill();
        return this.tokens;
    }
    reset() {
        this.tokens = this.capacity;
        this.lastRefillAt = this.now();
    }
}
/** 审批同意的速率闸门（模块单例 —— 插件卸载随闭包消亡） */
const grantBucket = new TokenBucket();
/** 令牌桶余量（锚点透明化 —— 模型/用户可见的「同意预算」） */
export function approvalBudget() {
    return grantBucket.available();
}
export const approval = {
    /** 发起审批：返回待确认的令牌（未生效 —— granted=false 直到 grant） */
    request(description) {
        const pa = { token: newToken(), description, expiresAt: Date.now() + TTL_MS, granted: false };
        pending.set(pa.token, pa);
        return pa;
    },
    /** 用户裁决（grant_approval 工具的落点）：
     *  grant=true ⇒ 令牌激活（在 TTL 内可被动作消费）；
     *  grant=false ⇒ 立即作废（等价 revoke）。返回令牌是否在场。
     *  Y-10：grant=true 须同时通过令牌桶 —— 同意的速率上限。 */
    grant(token, g) {
        const pa = pending.get((token || '').trim());
        if (!pa)
            return false;
        if (!g) {
            pending.delete(pa.token);
            return true;
        }
        if (Date.now() > pa.expiresAt) {
            pending.delete(pa.token);
            return false;
        }
        const rate = grantBucket.tryTake();
        if (!rate.ok) {
            pa.rateLimitedForMs = rate.retryInMs;
            return false;
        }
        pa.granted = true;
        return true;
    },
    /** 令牌状态（未消费）：granted 且未过期才有效。 */
    status(token) {
        const pa = pending.get((token || '').trim());
        if (!pa)
            return { present: false, granted: false, expired: false };
        return { present: true, granted: pa.granted, expired: Date.now() > pa.expiresAt };
    },
    /** 非消费校验（阶段一 validate）：granted 且未过期才有效，令牌保留可重试。 */
    validate(token) {
        const pa = pending.get((token || '').trim());
        return !!pa && pa.granted && Date.now() <= pa.expiresAt;
    },
    /** 消费令牌（click_mouse 成功路径调用）：granted 且未过期才放行，用后即焚。 */
    consume(token) {
        const pa = pending.get((token || '').trim());
        if (!pa)
            return false;
        pending.delete(pa.token); // 用后即焚：即使校验失败也不留第二次机会
        return pa.granted && Date.now() <= pa.expiresAt;
    },
    /** 作废令牌：用户拒绝（grant=false）时立即调用，防止误用 */
    revoke(token) {
        pending.delete((token || '').trim());
    },
    /** 清理过期令牌（防内存缓慢泄漏） */
    sweep() {
        const now = Date.now();
        for (const [k, v] of pending)
            if (v.expiresAt < now)
                pending.delete(k);
    },
};
/** W 纪元（W-1 隔离缝）：审批簿记归零 —— 测试隔离与插件卸载共用 */
export function resetApproval() {
    pending.clear();
    grantBucket.reset();
}
