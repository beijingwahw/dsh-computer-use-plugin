// src/focusTracker.ts
// 第三轮创新：焦点追踪器 —— 连接「点击」与「输入」的隐式上下文。
// 现实语义：type_text 作用的位置几乎总是「最近一次点击的位置」。工具间没有对话，
// 但共享这个微状态后，输入验证就能获得区域级坐标 —— 无需模型显式传递。
// 带过期时间：点击后太久未输入，焦点假设失效，优雅回退全屏验证。
export interface FocusPoint { x: number; y: number; at: number; sensitive?: boolean }

let focus: FocusPoint | null = null;

export const focusTracker = {
  /** 记录焦点（点击/拖拽终点后调用）；sensitive 标记凭据类输入区 */
  set(x: number, y: number, sensitive = false): void {
    focus = { x, y, at: Date.now(), sensitive };
  },

  /** 读取未过期的焦点；过期或不存在返回 null */
  get(maxAgeMs = 30_000): { x: number; y: number } | null {
    if (!focus) return null;
    if (Date.now() - focus.at > maxAgeMs) return null;
    return { x: focus.x, y: focus.y };
  },

  /** 焦点是否为敏感区（凭据输入将被人机协同闸门拦截） */
  isSensitive(maxAgeMs = 30_000): boolean {
    if (!focus || !focus.sensitive) return false;
    return Date.now() - focus.at <= maxAgeMs;
  },

  clear(): void {
    focus = null;
  },
};
