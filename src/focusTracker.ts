// src/focusTracker.ts
// 第三轮创新：焦点追踪器 —— 连接「点击」与「输入」的隐式上下文。
// 现实语义：type_text 作用的位置几乎总是「最近一次点击的位置」。工具间没有对话，
// 但共享这个微状态后，输入验证就能获得区域级坐标 —— 无需模型显式传递。
// 带过期时间：点击后太久未输入，焦点假设失效，优雅回退全屏验证。
export interface FocusPoint { x: number; y: number; at: number; sensitive?: boolean; origin?: string }

let focus: FocusPoint | null = null;

let prevFocus: FocusPoint | null = null; // Q 纪元（Q-8）：上一焦点（速度估计的一阶差分）

export const focusTracker = {
  /**
   * 记录焦点（点击/拖拽终点后调用）；sensitive 标记凭据类输入区。
   * W1-1（A3）：可选 origin 来源标签 —— 焦点短路只认自家标签的记录
   * （见 predictedFresh），工具层的无标签记录绝不触发执行层短路。
   */
  set(x: number, y: number, sensitive = false, origin?: string): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return; // W1-1：脏坐标不入账
    prevFocus = focus; // Q-8：焦点轨迹保留一阶 —— 速度外推的证据
    focus = { x, y, at: Date.now(), sensitive, ...(origin !== undefined ? { origin } : {}) };
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

// ─── W1-1（A3 焦点短路）：新鲜度门槛 + 来源标签的执行层焦点源 ───

/**
 * W1-1：无新鲜焦点哨兵 —— 归一化远点（-9,-9），绝不落在任何合法目标上。
 * 消费方以「坐标 ≥ 0」区分真焦点与哨兵（哨兵距离恒大于短路半径）。
 */
export const NO_FOCUS: Readonly<{ x: number; y: number; extrapolated: boolean }> = Object.freeze({
  x: -9, y: -9, extrapolated: false,
});

/**
 * W1-1（A3）：带新鲜度门槛与来源标签的外推焦点。
 * 三重资格闸（缺一即哨兵）：① 有焦点；② origin 标签与调用方一致（执行层短路
 * 只信自家记录 —— 工具层/别处的焦点不构成「我已点过这里」的证据）；③ 未过期。
 * 通过后走 predicted 的速度外推（Q-8 同一数学）。
 */
export function predictedFresh(
  origin: string,
  maxAgeMs = 10_000,
  now = Date.now(),
): { x: number; y: number; extrapolated: boolean } {
  try {
    if (!focus || focus.origin !== origin) return { ...NO_FOCUS };
    if (now - focus.at > maxAgeMs) return { ...NO_FOCUS };
    return focusTracker.predicted(now);
  } catch {
    return { ...NO_FOCUS }; // 防御式：任何意外收敛为哨兵，绝不抛出
  }
}

/** W1-1（A3）：执行层焦点源 —— runtime 焦点短路/键入 ROI 的注入躯体 */
export interface ExecFocusSource {
  /** 外推焦点（归一化）；无新鲜焦点 ⇒ NO_FOCUS 哨兵 */
  predicted(): { x: number; y: number; extrapolated: boolean };
  /** 登记点击落点（归一化）；绝不抛异常 */
  set(nx: number, ny: number): void;
}

/**
 * W1-1（A3）：铸造基于全局 focusTracker 的执行层焦点源（生产接线位 —— 集成
 * 阶段注入 runtime：`createExecute({ ..., focus: createExecFocusSource() })`）。
 * 禁用态（不注入）由 runtime 自备哨兵源 —— 零全局读写，行为与接线前一致。
 */
export function createExecFocusSource(origin = 'w1-exec', maxAgeMs = 10_000): ExecFocusSource {
  return {
    predicted: (): { x: number; y: number; extrapolated: boolean } =>
      predictedFresh(origin, maxAgeMs),
    set: (nx: number, ny: number): void => {
      try {
        focusTracker.set(nx, ny, false, origin);
      } catch {
        /* 登记是观察性旁路 —— 失败绝不抛 */
      }
    },
  };
}
