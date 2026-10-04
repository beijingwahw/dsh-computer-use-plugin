// src/guards/popupGuard.ts
// 弹窗联动守卫（融合 v2 完成版）。
// 单一事实源（ΑΩ-R24 起按会话分键）+ 唯一写入口 updatePopupState：
// 传感器（take_screenshot）与执行器（本守卫）通过共享状态解耦，互不 import 对方。
// 白名单永远给自己的传感器和处理器留生命通道；拦截话术与 dismiss_popup 工具逐字一致，
// 保证模型在任何路径下收到统一的战术暂停指令。
import type { Context } from '@deepseek-ai/cordis';
import { onToolPre } from './hooks';

// ─── ΑΩ-R24：弹窗态的会话隔离（Y6 立法补全）────────────────────────────
// 旧实现 isPopupActive 是进程级单例，未随 hooks 的 sessionId 隔离：守卫挂在
// 进程级管线上看见所有会话，会话 A 的弹窗态会拦住会话 B 的一切动作（B 的
// 屏幕上根本没有那个弹窗）—— 与 repeatActionGuard/circuitBreakerGuard 的
// Y6 会话隔离同律，此处补全立法。
//
// 键选取（读/写同律）：显式 sessionId，缺席回落 'default' 单例键 —— 无会话
// 上下文的旧调用方（index.ts 卸载复位、w2canary 等测试）行为不变。
//
// 'default' 同时是「无会话读者」的全局视图：canaryGuard / interactivityProbe
// 等读点（本工单文件范围外，不可传 sessionId）读到的是「全局最新一次传感器
// 读数」—— 与旧进程级单例逐字节同语义；故带会话的写入镜像一份到 'default'
// （盲化它们 = 回归）。
//
// 会话结束清理（方案论证，最小侵入取舍）：guards/hooks 只暴露 onToolPre /
// onToolPost / onLlmPreRequest 三个挂载点，没有会话生命周期事件可挂惰性
// 清理；index.ts 的卸载复位 updatePopupState(false) 无会话身份（只复位
// 'default'）且属插件卸载而非会话边界。故取自管理卫生双保险：
//   ① LRU 上限 32 会话键（repeatActionGuard 同款 Map 插入序逐出，写入时
//      delete+set 刷新热度；32 并发会话已远超本插件真实部署形态）；
//   ② 读取时惰性过期：10 分钟无写入视为陈旧并物理清除 —— 弹窗态本就短命
//      （每次 take_screenshot 全量覆写），10 分钟无传感器证据的弹窗信念不
//      应继续拦动作（写路径也顺带清过期，读长期缺席的会话不只靠 LRU 兜底）。
//      时钟读数仅作 TTL 运算（陈旧判据），绝不作身份 id。
interface PopupCell {
  active: boolean;
  /** 最后一次写入的时钟读数（毫秒；TTL 判据，非 id） */
  updatedAt: number;
}

/** 无会话上下文时的回落键（旧单例键；兼作全局最新读数视图） */
const DEFAULT_SESSION_KEY = 'default';
/** LRU 容量：在册会话键上限（'default' 基础设施键不计入、免逐出） */
const MAX_TRACKED_SESSIONS = 32;
/** 惰性过期阈值：10 分钟无传感器写入 ⇒ 陈旧清除 */
const POPUP_STALE_MS = 10 * 60 * 1000;

const popupBySession = new Map<string, PopupCell>();

/** 键归一：非空字符串 sessionId 原样，缺席回落 'default'（旧单例键） */
function sessionKey(sessionId: string | undefined): string {
  return typeof sessionId === 'string' && sessionId !== '' ? sessionId : DEFAULT_SESSION_KEY;
}

/** 陈旧判据：活跃态且超过 TTL 无更新（false 态陈旧与缺席同值，无需特判） */
function isStale(cell: PopupCell, now: number): boolean {
  return cell.active && now - cell.updatedAt > POPUP_STALE_MS;
}

function writeCell(key: string, active: boolean): void {
  const now = Date.now();
  // 先惰性清过期（map 容量 ≤ 33，全扫廉价且永不抛）
  for (const [k, cell] of popupBySession) {
    if (isStale(cell, now)) popupBySession.delete(k);
  }
  // LRU：新会话键入场且会话键已满 ⇒ 按插入序逐出最旧会话（'default' 免逐）
  if (key !== DEFAULT_SESSION_KEY && !popupBySession.has(key)) {
    let sessions = 0;
    for (const k of popupBySession.keys()) if (k !== DEFAULT_SESSION_KEY) sessions++;
    if (sessions >= MAX_TRACKED_SESSIONS) {
      for (const k of popupBySession.keys()) {
        if (k === DEFAULT_SESSION_KEY) continue;
        popupBySession.delete(k);
        break;
      }
    }
  }
  popupBySession.delete(key); // 重插 = 写入热度刷新（读不刷，与 repeatActionGuard 同取舍）
  popupBySession.set(key, { active, updatedAt: now });
}

/**
 * 供 take_screenshot（或本地视觉模型）更新弹窗状态。
 * ΑΩ-R24：可选 sessionId —— 会话内传感按会话分键；缺席回落 'default'
 * （旧单例键，无会话上下文的旧调用方行为不变）。带会话的写入同时镜像到
 * 'default'：无会话读者（canaryGuard/interactivityProbe）继续看到全局最新
 * 读数 —— 与旧进程级单例逐字节同语义。
 */
export function updatePopupState(state: boolean, sessionId?: string): void {
  const key = sessionKey(sessionId);
  writeCell(key, state);
  if (key !== DEFAULT_SESSION_KEY) writeCell(DEFAULT_SESSION_KEY, state);
}

/** ΑΩ-R24：读态同样按会话分键（缺席回落 'default'）；陈旧活跃态读取时清除 */
export function getPopupState(sessionId?: string): boolean {
  const key = sessionKey(sessionId);
  const cell = popupBySession.get(key);
  if (!cell) return false;
  if (isStale(cell, Date.now())) {
    popupBySession.delete(key); // 物理清除：回拨时钟也不复活（防僵尸拦截）
    return false;
  }
  return cell.active;
}

/** ΑΩ-R24 测试观察面：在册键数（LRU/过期断言用；运行层零消费） */
export function popupSessionCount(): number {
  return popupBySession.size;
}

/** ΑΩ-R24 测试隔离面：清空全部会话键（运行层零消费，resetCanaryGuard 同律） */
export function resetPopupState(): void {
  popupBySession.clear();
}

// 战术暂停指令：单一事实源，popupGuard 与 dismiss_popup 工具共享 —— 保证统一话术
// B-4：status 对齐锚点协议枚举（ACTION_REQUIRED = 需模型重新介入，非失败非成功，
// 熔断/遥测不计入失败统计 —— 语义正确的拦截态）
export const TACTICAL_PAUSE = JSON.stringify({
  status: 'ACTION_REQUIRED',
  state_anchor: {
    current_state: 'Screen is blocked by an unexpected popup or modal.',
    required_action: 'Re-analyze the current screenshot.',
  },
  next_step: "MANDATORY: Look closely at the screenshot. Locate the popup's close button " +
    "(e.g., 'X', 'Close', 'Cancel', or 'Accept') and call 'click_mouse' with its normalized coordinates.",
}, null, 2);

export function registerPopupGuard(ctx: Context): void {
  onToolPre(ctx, async (toolCall, next) => {
    // 1. 传感器放行：截图必须工作，它负责更新弹窗状态
    if (toolCall.name === 'take_screenshot') return next();

    // 2. 处理器放行：dismiss_popup 是官方指定的处理路径
    if (toolCall.name === 'dismiss_popup') return next();

    // 3. 核心联动：弹窗活跃时拦截一切其他操作 —— 不调 next() 即短路
    //    ΑΩ-R24：按本会话读态（hooks 归一化的 sessionId；缺席回落 'default'
    //    全局视图）—— 会话 A 的弹窗不再拦会话 B 的动作；拦截话术逐字不变
    if (getPopupState(toolCall.sessionId)) {
      console.warn(`[Popup Guard] Blocked action: ${toolCall.name}. Popup is active!`);
      return TACTICAL_PAUSE;
    }

    // 4. 安全放行
    return next();
  });
}
