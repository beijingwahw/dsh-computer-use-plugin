// src/focusTracker.ts
// 第三轮创新：焦点追踪器 —— 连接「点击」与「输入」的隐式上下文。
// 现实语义：type_text 作用的位置几乎总是「最近一次点击的位置」。工具间没有对话，
// 但共享这个微状态后，输入验证就能获得区域级坐标 —— 无需模型显式传递。
// 带过期时间：点击后太久未输入，焦点假设失效，优雅回退全屏验证。
export interface FocusPoint { x: number; y: number; at: number; sensitive?: boolean }

let focus: FocusPoint | null = null;

let prevFocus: FocusPoint | null = null; // Q 纪元（Q-8）：上一焦点（速度估计的一阶差分）

export const focusTracker = {
  /** 记录焦点（点击/拖拽终点后调用）；sensitive 标记凭据类输入区 */
  set(x: number, y: number, sensitive = false): void {
    prevFocus = focus; // Q-8：焦点轨迹保留一阶 —— 速度外推的证据
    focus = { x, y, at: Date.now(), sensitive };
  },

  /**
   * Q 纪元（Q-8）：焦点速度外推 —— 两点一阶差分估计漂移速度，外推到 now。
   * 消费语义：长延迟后回到输入（焦点可能已被动画/滚动带走），区域验证中心
   * 用外推点比用陈旧原点更贴近真值；外推距离钳半屏（速度估计是粗楷 ——
   * 外推过头比不用更糟）。证据不足（无前点/间隔 >5s/时间倒流）⇒ 原点（诚实回退）。
   */
  predicted(now = Date.now()): { x: number; y: number; extrapolated: boolean } {
    if (!focus) return { x: 0.5, y: 0.5, extrapolated: false };
    const dtMs = prevFocus ? focus.at - prevFocus.at : 0;
    const ageMs = now - focus.at;
    if (!prevFocus || dtMs <= 0 || dtMs > 5_000 || ageMs <= 0) {
      return { x: focus.x, y: focus.y, extrapolated: false };
    }
    const vx = (focus.x - prevFocus.x) / dtMs; // 归一化坐标/ms
    const vy = (focus.y - prevFocus.y) / dtMs;
    let px = focus.x + vx * ageMs;
    let py = focus.y + vy * ageMs;
    // 钳半屏：外推不确定度随时间超线性增长 —— 保守上限
    px = Math.max(focus.x - 0.5, Math.min(focus.x + 0.5, px));
    py = Math.max(focus.y - 0.5, Math.min(focus.y + 0.5, py));
    return { x: px, y: py, extrapolated: true };
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
    prevFocus = null;
  },
};
