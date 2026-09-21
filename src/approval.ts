// src/approval.ts
// 第六轮创新之一：一次性审批令牌（One-shot Approval Token）。
// 不可逆操作（发送/删除/支付/提交订单…）需要显式授权：模型先 request_approval
// 生成令牌并告知用户，用户在对话中同意后，模型携令牌重试动作。
// 令牌四性质：一次性（用后即焚）、短时效（默认 120s）、带用途（描述随行）、
// **须授予**（J 纪元：grant_approval(token, true) 是执行的必要条件 ——
// 旧协议"从未 grant"与"grant=true"对执行层无区别，审批闸门的同意环节形同虚设）。
import { randomBytes } from 'node:crypto';

export interface PendingApproval {
  token: string;
  description: string;
  expiresAt: number;
  /** J 纪元：用户是否已通过 grant_approval 授予（缺省 false —— 请求≠同意） */
  granted: boolean;
}

const pending = new Map<string, PendingApproval>();
const TTL_MS = 120_000;

function newToken(): string {
  // CSPRNG（对齐 capToken.ensureKey 的密钥强度标准）：令牌门禁的是不可逆操作，
  // Math.random 可预测且 8 字符 base36 空间在高频下可碰撞（静默顶掉待审批项）
  return 'APR-' + randomBytes(8).toString('hex').toUpperCase();
}

export const approval = {
  /** 发起审批：返回待确认的令牌（未生效 —— granted=false 直到 grant） */
  request(description: string): PendingApproval {
    const pa: PendingApproval = { token: newToken(), description, expiresAt: Date.now() + TTL_MS, granted: false };
    pending.set(pa.token, pa);
    return pa;
  },

  /** 用户裁决（grant_approval 工具的落点）：
   *  grant=true ⇒ 令牌激活（在 TTL 内可被动作消费）；
   *  grant=false ⇒ 立即作废（等价 revoke）。返回令牌是否在场。 */
  grant(token: string, g: boolean): boolean {
    const pa = pending.get((token || '').trim());
    if (!pa) return false;
    if (!g) {
      pending.delete(pa.token);
      return true;
    }
    if (Date.now() > pa.expiresAt) {
      pending.delete(pa.token);
      return false;
    }
    pa.granted = true;
    return true;
  },

  /** 令牌状态（未消费）：granted 且未过期才有效。 */
  status(token: string): { present: boolean; granted: boolean; expired: boolean } {
    const pa = pending.get((token || '').trim());
    if (!pa) return { present: false, granted: false, expired: false };
    return { present: true, granted: pa.granted, expired: Date.now() > pa.expiresAt };
  },

  /**
   * 阶段一：校验但不消费（B-3 两阶段语义 + J 纪元授予门）。
   * 动作执行「前」的闸门检查用 —— 点击抛异常时令牌不被白白烧毁，
   * 用户一次授权即可覆盖「失败重试」场景。有效 = 在场 ∧ 未过期 ∧ **已授予**。
   */
  validate(token: string): boolean {
    const pa = pending.get((token || '').trim());
    return !!pa && pa.granted && Date.now() <= pa.expiresAt;
  },

  /**
   * 阶段二：校验并消费（用后即焚）。同样要求已授予。
   * 动作执行「成功后」才调用 —— 「用户授权」与「动作成功」解耦。
   * 滥用窗口仍被 TTL 硬顶（120s）。
   */
  consume(token: string): boolean {
    const pa = pending.get((token || '').trim());
    if (!pa) return false;
    pending.delete(pa.token); // 用后即焚：即使校验失败也不留第二次机会
    return pa.granted && Date.now() <= pa.expiresAt;
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


/** W 纪元（W-1 隔离缝）：审批簿记归零 —— 测试隔离与插件卸载共用 */
export function resetApproval(): void {
  pending.clear();
}
