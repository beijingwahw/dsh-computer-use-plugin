// src/approval.ts
// 第六轮创新之一：一次性审批令牌（One-shot Approval Token）。
// 不可逆操作（发送/删除/支付/提交订单…）需要显式授权：模型先 request_approval
// 生成令牌并告知用户，用户在对话中同意后，模型携令牌重试动作。
// 令牌三性质：一次性（用后即焚）、短时效（默认 120s）、带用途（描述随行）。
export interface PendingApproval {
  token: string;
  description: string;
  expiresAt: number;
}

const pending = new Map<string, PendingApproval>();
const TTL_MS = 120_000;

function newToken(): string {
  return 'APR-' + Math.random().toString(36).slice(2, 10).toUpperCase();
}

export const approval = {
  /** 发起审批：返回待确认的令牌（未生效） */
  request(description: string): PendingApproval {
    const pa: PendingApproval = { token: newToken(), description, expiresAt: Date.now() + TTL_MS };
    pending.set(pa.token, pa);
    return pa;
  },

  /**
   * 阶段一：校验但不消费（B-3 两阶段语义）。
   * 动作执行「前」的闸门检查用 —— 点击抛异常时令牌不被白白烧毁，
   * 用户一次授权即可覆盖「失败重试」场景。
   */
  validate(token: string): boolean {
    const pa = pending.get((token || '').trim());
    return !!pa && Date.now() <= pa.expiresAt;
  },

  /**
   * 阶段二：校验并消费（用后即焚）。
   * 动作执行「成功后」才调用 —— 「用户授权」与「动作成功」解耦。
   * 滥用窗口仍被 TTL 硬顶（120s）。
   */
  consume(token: string): boolean {
    const pa = pending.get((token || '').trim());
    if (!pa) return false;
    pending.delete(pa.token); // 用后即焚：即使校验失败也不留第二次机会
    return Date.now() <= pa.expiresAt;
  },

  /** 作废令牌：用户拒绝（grant=false）时立即调用，防止误用 */
  revoke(token: string): void {
    pending.delete((token || '').trim());
  },

  /** 清理过期令牌（防内存缓慢泄漏） */
  sweep(): void {
    const now = Date.now();
    for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
  },
};
