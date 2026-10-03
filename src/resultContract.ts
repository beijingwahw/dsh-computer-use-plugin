// src/resultContract.ts
// B-2 统一结果契约解析器：全系统唯一的工具成败判定入口。
//
// 根因（诊断书 F-2）：熔断/遥测/日志三处曾用 `result.includes('"status": "FAILED"')`
// 嗅探字符串 —— 依赖 JSON.stringify(x, null, 2) 的缩进空格这一「格式巧合」。
// 任何工具改用紧凑格式，三个守卫将静默失明（不报错，只是不再计数）。
//
// 本模块把契约从「字符串巧合」升格为「类型事实」：
//   1. 优先 JSON.parse 读取强类型 obj.status 字段（锚点协议，B-4 起全工具覆盖）；
//   2. 解析失败回退前缀协议（[Error] / [System]，历史遗留工具的过渡通道）；
//   3. noop 判定：报 SUCCESS 且 effect.detected === false（动作完成但屏幕无变化）。
//
// 消费者：circuitBreakerGuard / telemetryGuard / journal(registerJournalGuard)。
// 新增状态枚举（如 PENDING_USER_CONSENT）只需在此登记映射，三消费者自动兼容。
//
// Δ 纪元（安全外围#4）：未登记状态致熔断失明。工具面已存在的三个线上状态
// 一直被判 UNKNOWN —— 既不计失败也不计成功（熔断/遥测对它们完全失明）：
//   PARTIAL_FAILURE（replay_actions / run_skill：宏内部分步失败）→ 失败语义
//     （部分步失败就是失败 —— 熔断必须看得见重放/技能路线的坏步）；
//   GRANTED / REVOKED（grant_approval：授予/作废审批令牌的动作回执）→ 成功语义
//     （grant/revoke 本身执行成功了 —— 计成功重置连续失败计数）。

import { approval, approvalBudget } from './approval';

export type ToolStatus = 'SUCCESS' | 'FAILED' | 'ACTION_REQUIRED' | 'PENDING_USER_CONSENT' | 'UNKNOWN';

export interface ClassifyResult {
  status: ToolStatus;
  /** SUCCESS 且无屏幕效果（疑似点空）—— 遥测 noop 率与自省洞见的数据源 */
  noop: boolean;
  /** effect.detected 原始值（journal 记录用；undefined = 未验证） */
  effectDetected?: boolean;
  /** 线上原始状态字面（仅当登记映射折叠了它才在场 —— 如 'PARTIAL_FAILURE'；
   *  journal/调试面据此追溯工具方言，语义折叠不吞血缘） */
  rawStatus?: string;
  /** Δ#4：拒绝真实成因精化 —— grant_approval 的 FAILED 携带字面
   *  'invalid-or-expired-token'，但 Y-10 令牌桶耗尽时真实成因是**限流拒绝**
   *  （approval.grant 对缺席/过期/限流三种情况一律返回 false，工具层共用同一
   *  误导性字面）。契约层据 approval 现势精化：令牌在场、未过期、且未授予
   *  ⇒ 唯一剩余成因就是限流 ⇒ 透出 'rateLimited'（写侧 approvalTools 归别簇
   *  所有不可改，契约是唯一获准的读侧纠正点） */
  reason?: 'rateLimited';
  /** reason='rateLimited' 时的同意预算余量（限流拒绝的透明化锚点） */
  approvalBudgetRemaining?: number;
}

/** 判定结果是否代表「执行失败」（熔断计数、失败记忆的语义） */
export function isFailure(c: ClassifyResult): boolean {
  return c.status === 'FAILED';
}

/** 判定结果是否代表「执行成功」（熔断重置、遥测计数的语义） */
export function isSuccess(c: ClassifyResult): boolean {
  return c.status === 'SUCCESS';
}

export function classifyResult(raw: unknown): ClassifyResult {
  if (typeof raw !== 'string') return { status: 'UNKNOWN', noop: false };

  // 主通道：锚点 JSON 的强类型 status 字段（不依赖任何序列化格式细节）
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && typeof obj.status === 'string') {
      const status = normalizeStatus(obj.status);
      const effectDetected = obj?.state_anchor?.effect?.detected ??
        obj?.effect?.detected;
      const noop = status === 'SUCCESS' && effectDetected === false;
      const out: ClassifyResult = { status, noop };
      if (effectDetected !== undefined) out.effectDetected = effectDetected;
      if (status !== obj.status) out.rawStatus = obj.status; // 折叠前的线上字面
      refineGrantRejection(out, obj); // Δ#4：限流拒绝的真实成因透出
      return out;
    }
  } catch { /* 非 JSON，走前缀协议回退 */ }

  // 回退通道：前缀协议（B-4 改造完成前的历史工具格式）
  if (raw.includes('[Error]')) return { status: 'FAILED', noop: false };
  if (raw.includes('[System]')) return { status: 'SUCCESS', noop: false };
  return { status: 'UNKNOWN', noop: false };
}

/** 线上状态 → 契约语义的登记表（唯一登记点：新增状态只需加一行） */
const STATUS_FOLD: Record<string, ToolStatus> = {
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  ACTION_REQUIRED: 'ACTION_REQUIRED',
  PENDING_USER_CONSENT: 'PENDING_USER_CONSENT',
  // Δ#4 登记（语义折叠，rawStatus 保留字面血缘）：
  PARTIAL_FAILURE: 'FAILED', // replay_actions / run_skill 的部分失败 —— 计熔断
  GRANTED: 'SUCCESS',        // grant_approval 授予回执 —— 动作本身成功
  REVOKED: 'SUCCESS',        // grant_approval 作废回执 —— 动作本身成功
};

function normalizeStatus(s: string): ToolStatus {
  return STATUS_FOLD[s] ?? 'UNKNOWN';
}

/** Δ#4：grant 失败结果的真实成因精化（见 ClassifyResult.reason 注释）。
 *  approval.grant 返回 false 仅三种成因：令牌缺席 / 已过期 / Y-10 限流。
 *  前两者发生时令牌已不在簿（或已过期）⇒ status() 呈缺席/过期；唯独限流
 *  拒绝会把令牌留在簿上（在场、未过期、未授予）—— 这就是可判别的指纹。 */
function refineGrantRejection(out: ClassifyResult, obj: any): void {
  if (out.status !== 'FAILED') return;
  if (obj?.state_anchor?.reason !== 'invalid-or-expired-token') return;
  const token = obj?.state_anchor?.token;
  if (typeof token !== 'string' || !token) return;
  const st = approval.status(token);
  if (st.present && !st.granted && !st.expired) {
    out.reason = 'rateLimited';
    out.approvalBudgetRemaining = approvalBudget();
  }
}
