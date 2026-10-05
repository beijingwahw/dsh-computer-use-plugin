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

// ─── ΠΑΝ-108（前缀协议行首锚定 + 转义规则）───
//
// 病灶（C1-2 M11）：旧回退通道用 `raw.includes('[Error]')` —— 任意位置含
// 该字面即判 FAILED。read_text / OCR 类工具返回的正文（错误对话框截图的
// 文字、日志摘录）极易含 "[Error]" 字样 ⇒ 误计熔断失败、误进失败记忆 ——
// 「内容里有」被当成「结果是」。前缀协议的本意是**标记**，不是子串。
//
// 执法（三层）：
//   ① 行首锚定：只有**首个非空行**以 `[Error]` / `[System]` 开头才判
//      FAILED/SUCCESS —— 全部生产发射点（guards/hooks.ts、各工具的
//      return `[Error]: ...`）都把标记放在结果串首，正文里再现同字样是
//      内容巧合，不是协议判决；
//   ② 转义规则：正文若必须以该字面开头（如 read_text 读到一份以
//      "[Error]" 开头的日志），发射侧在首行标记前加单个反斜杠转义
//      （`\[Error]`）—— 判定侧见转义即视为内容（UNKNOWN），绝不折叠为
//      失败。转义由导出的 escapeContractPrefix 提供，双端同源；
//   ③ 零漂移：锚定+转义只收紧误判面 —— 首行即标记的旧输入判定结果
//      与旧 includes 完全一致（既有工具的回执全部首行发射）。

/** ΠΑΝ-108：前缀协议标记（行首锚定判定的字面） */
const CONTRACT_PREFIX_ERROR = '[Error]';
const CONTRACT_PREFIX_SYSTEM = '[System]';

/** ΠΑΝ-108：转义规则 —— 首个非空行以协议标记开头的内容串，在标记前加 `\` 转义。
 *  判定侧见转义即按内容处理（UNKNOWN），发射侧（正文以 [Error]/[System]
 *  开头的工具）用本函数包一层即安全。空串/无需转义 ⇒ 原样返回（纯函数）。 */
export function escapeContractPrefix(content: string): string {
  const s = typeof content === 'string' ? content : String(content ?? '');
  const wsLen = s.length - s.trimStart().length; // 前导空白长度（转义不吞缩进）
  const rest = s.slice(wsLen);
  if (rest.startsWith(CONTRACT_PREFIX_ERROR) || rest.startsWith(CONTRACT_PREFIX_SYSTEM)) {
    return `${s.slice(0, wsLen)}\\${rest}`;
  }
  return s;
}

/** ΠΑΝ-108：首个非空行的行首锚定判定（trimStart 后 startsWith —— 多行正文
 *  中部/次行出现的标记字样是内容，不是协议） */
function firstLineHasPrefix(raw: string, prefix: string): boolean {
  const body = raw.trimStart();
  // 转义规则：首行以 `\[Error]` / `\[System]` 开头 ⇒ 内容巧合，已转义申报
  if (body.startsWith(`\\${prefix}`)) return false;
  return body.startsWith(prefix);
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
  // ΠΑΝ-108：行首锚定 —— OCR/读文本正文里的 "[Error]" 字样不再折叠为错误
  if (firstLineHasPrefix(raw, CONTRACT_PREFIX_ERROR)) return { status: 'FAILED', noop: false };
  if (firstLineHasPrefix(raw, CONTRACT_PREFIX_SYSTEM)) return { status: 'SUCCESS', noop: false };
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
