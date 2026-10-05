// src/focusTracker.ts
// 第三轮创新：焦点追踪器 —— 连接「点击」与「输入」的隐式上下文。
// 现实语义：type_text 作用的位置几乎总是「最近一次点击的位置」。工具间没有对话，
// 但共享这个微状态后，输入验证就能获得区域级坐标 —— 无需模型显式传递。
// 带过期时间：点击后太久未输入，焦点假设失效，优雅回退全屏验证。
//
// ΑΝΒ-2（W-07 · D2-c）：窗口中心伪锚 —— 「光标」概念的诚实代理。
// 结构盲区（R5-2 §4.2-2，T8 直建成因）：agent 经 switch_window + 键盘导航
// （ctrl+home/down/shift+end）到达编辑位时**全程无点击** ⇒ 本追踪器无光标概念
// ⇒ type_text 兜底取鼠标位（停在任务栏/资源管理器）⇒ 验证区域恒不变 ⇒
// sim 100% ⇒ WARNING 诱导盲重打 ⇒ 三段拼接畸形行。修法（DECISIONS D2-c）：
// switch_window 成功记账（windowFocusGuard 的目标窗账本）在场时，把「目标窗
// 中心」记为伪锚 —— 劣于真光标/真点击，但远优于任务栏鼠标位（最大化/居中窗
// 的窗口中心 = 屏幕中心）。诚实性铁律：伪锚≠真光标，anchorKind 恒标注
// 'window-center-pseudo'，消费方回执必须如实披露（绝不冒充点击记账）。
import { peekTargetWindow } from './windowFocusGuard';

export interface FocusPoint {
  x: number; y: number; at: number; sensitive?: boolean; origin?: string;
  /** ΑΝΒ-2（W-07）：在场 = 窗口中心伪锚（非点击/鼠标实测位）；缺席 = 旧语义（点击记账） */
  anchorKind?: 'window-center-pseudo';
}

/** ΑΝΒ-2（W-07）：伪锚坐标 = 屏幕中心 —— 目标窗中心的最优无信息代理
 *  （python 窗口后端只回标题无边界矩形；最大化窗（套件任务常态）两者重合）。 */
export const WINDOW_CENTER_PSEUDO: Readonly<{ x: number; y: number }> = Object.freeze({ x: 0.5, y: 0.5 });

/** ΑΝΒ-2（W-07）：光标锚的统一视图 —— 消费方（type_text 验证区域 / press_hotkey
 *  选族验证区域）的唯一锚定事实源。kind 即诚实标签：click-tracked 是实测交互位，
 *  window-center-pseudo 是无信息代理（回执必须申报后者非真光标）。 */
export type CaretAnchor =
  | { kind: 'click-tracked'; x: number; y: number }
  | { kind: 'window-center-pseudo'; x: number; y: number };

let focus: FocusPoint | null = null;

let prevFocus: FocusPoint | null = null; // Q 纪元（Q-8）：上一焦点（速度估计的一阶差分）

// ─── ΑΝΒ-2（W-08）：选族效果验证账本（press_hotkey → type_text 的共享微状态）───
// 本追踪器的立身哲学（文件头）：工具间没有对话，但共享微状态即隐式上下文。
// W-08 落地同律：press_hotkey 选族和弦（shift+home/end/方向键）派发后的区域
// dHash 效果验证结论记在这里，type_text 回执消费（VERIFIED ⇒ 覆盖语义）。
// 失效律（保守方向 —— 假 UNVERIFIED 只是多一句防盲打话术，假 VERIFIED 会把
// type_text 变成盲插入（T8 危害方向））：① 点击/拖拽记账（光标移动大概率
// 折叠选区）；② 非选族 press_hotkey 派发（裸导航键折叠选区、其他键可能消费
// 选区）；③ type_text 消费后一次性清账（打字即覆盖/消费选区）；④ 年龄过期。

/** ΑΝΒ-2（W-08）：选族验证记录 —— verdict 三态诚实分离。 */
export interface SelectionVerifyRecord {
  /** verified = 区域差分超阈（选区蓝条可见）；unverified = 已测量但未达阈（附实测值）；blind = 无验证面（旧 R5-2 盲态） */
  verdict: 'verified' | 'unverified' | 'blind';
  /** 区域相似度实测（%，越低变化越大；blind = null） */
  region_similarity_pct: number | null;
  /** 触发本记录的选族和弦键序（取证） */
  keys: string[];
  /** 验证区域锚定的种类（blind 时也可能有锚 —— 派发前有锚但快照/比对失败） */
  anchor: 'click-tracked' | 'window-center-pseudo' | null;
  at: number;
}

let selectionLedger: SelectionVerifyRecord | null = null;

export const focusTracker = {
  /**
   * 记录焦点（点击/拖拽终点后调用）；sensitive 标记凭据类输入区。
   * W1-1（A3）：可选 origin 来源标签 —— 焦点短路只认自家标签的记录
   * （见 predictedFresh），工具层的无标签记录绝不触发执行层短路。
   * ΑΝΒ-2（W-08）：实测交互位入账 ⇒ 选区验证账本失效（点击移动光标/折叠
   * 选区 —— 保守方向，绝不携带陈旧 VERIFIED 进新上下文）。
   */
  set(x: number, y: number, sensitive = false, origin?: string): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return; // W1-1：脏坐标不入账
    prevFocus = focus; // Q-8：焦点轨迹保留一阶 —— 速度外推的证据
    focus = { x, y, at: Date.now(), sensitive, ...(origin !== undefined ? { origin } : {}) };
    selectionLedger = null; // ΑΝΒ-2：真交互推翻选区在场假设
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

  /**
   * 读取未过期的焦点；过期或不存在返回 null。
   * ΑΝΒ-2（W-07）：伪锚记录额外携带 anchorKind='window-center-pseudo' ——
   * 消费方据此区分「点击实测位」与「窗口中心代理」（诚实标签，加法式键）。
   */
  get(maxAgeMs = 30_000): { x: number; y: number; anchorKind?: 'window-center-pseudo' } | null {
    if (!focus) return null;
    if (Date.now() - focus.at > maxAgeMs) return null;
    return {
      x: focus.x, y: focus.y,
      ...(focus.anchorKind !== undefined ? { anchorKind: focus.anchorKind } : {}),
    };
  },

  /** 焦点是否为敏感区（凭据输入将被人机协同闸门拦截） */
  isSensitive(maxAgeMs = 30_000): boolean {
    if (!focus || !focus.sensitive) return false;
    return Date.now() - focus.at <= maxAgeMs;
  },

  clear(): void {
    focus = null;
    prevFocus = null;
    selectionLedger = null; // ΑΝΒ-2：会话卸载显式归零（index.ts 的 focusTracker.clear 钩子同点清账）
  },
};

// ─── ΑΝΒ-2（W-07）：光标伪锚解析 / 导航键保鲜 ───

/**
 * ΑΝΒ-2（W-07）：把伪锚写入 focus 槽（内部唯一写点）。
 * prevFocus 置 null —— 伪锚是语义声明（「光标在目标窗内」）不是实测轨迹，
 * 对它做 Q-8 速度外推是伪科学（无前点可差分，predicted 自然回退原点）。
 * 绝不带 origin：predictedFresh 的执行层短路只认自家点击记录，伪锚不构成
 * 「我已点过这里」的证据（W1-1 三重资格闸 ② 同律）。
 */
function writePseudoAnchor(at: number): void {
  prevFocus = null;
  focus = { x: WINDOW_CENTER_PSEUDO.x, y: WINDOW_CENTER_PSEUDO.y, at, anchorKind: 'window-center-pseudo' };
}

/**
 * ΑΝΒ-2（W-07）：解析当前光标锚 —— type_text / press_hotkey 验证区域的
 * 统一锚定阶梯：① 新鲜点击记账（实测位，最高优先）＞ ② 窗口中心伪锚
 * （目标窗记账在场时物化/复用 —— 「switch_window 成功后伪锚在场」的落地：
 * 物化发生在消费点而非切窗点，观察语义等价，且无需改切窗工具本体）。
 * 两者皆无 ⇒ null（消费方回退鼠标兜底/全屏 —— 旧路径逐字节不变）。
 * 防御式：任何意外收敛为 null，绝不抛。
 */
export function resolveCaretAnchor(maxAgeMs = 30_000, now = Date.now()): CaretAnchor | null {
  try {
    if (focus && now - focus.at <= maxAgeMs) {
      return focus.anchorKind === 'window-center-pseudo'
        ? { kind: 'window-center-pseudo', x: focus.x, y: focus.y }
        : { kind: 'click-tracked', x: focus.x, y: focus.y };
    }
    // 点击记账过期/缺席：目标窗记账新鲜 ⇒ 物化伪锚（窗口中心代理）
    const target = peekTargetWindow();
    if (target && now - target.at <= maxAgeMs) {
      writePseudoAnchor(now);
      return { kind: 'window-center-pseudo', x: WINDOW_CENTER_PSEUDO.x, y: WINDOW_CENTER_PSEUDO.y };
    }
    return null;
  } catch {
    return null; // 防御式：锚解析绝不抛
  }
}

/**
 * ΑΝΒ-2（W-07）：导航键（home/end/pageup/方向键及其组合）派发**成功后**调用 ——
 * 键击落在当时前台窗（= 目标窗记账的窗），光标仍在其内 ⇒ 伪锚保鲜（bump at）。
 * 纪律：绝不覆盖新鲜点击记账（实测位永远优先于代理位 —— 点击后按导航键只是
 * 光标离开点击位，区域验证用旧点击位仍是窗内合理邻域，篡改反而丢实测信息）；
 * 无伪锚也无点击但目标窗记账新鲜 ⇒ 就地物化（首个导航键即建锚）。
 */
export function refreshCaretPseudoAnchorAfterNavKey(maxAgeMs = 30_000, now = Date.now()): boolean {
  try {
    if (focus) {
      if (now - focus.at > maxAgeMs) {
        // 槽内记录过期：点击/伪锚 alike —— 过期点击位不得因导航键复活为「新鲜」；
        // 降级走目标窗物化路径（窗口中心代理）
      } else if (focus.anchorKind === 'window-center-pseudo') {
        writePseudoAnchor(now); // 保鲜：导航键后光标仍在目标窗内
        return true;
      } else {
        return false; // 新鲜点击记账在场：不覆盖（实测位优先）
      }
    }
    const target = peekTargetWindow();
    if (target && now - target.at <= maxAgeMs) {
      writePseudoAnchor(now);
      return true;
    }
    return false;
  } catch {
    return false; // 防御式：记账是观察性旁路，失败绝不抛
  }
}

// ─── ΑΝΒ-2（W-08）：选族效果验证账本（press_hotkey 写、type_text 消费）───

/** ΑΝΒ-2（W-08）：记录选族验证结论（press_hotkey 派发后调用；脏输入不入账）。 */
export function recordSelectionVerification(rec: {
  verdict: SelectionVerifyRecord['verdict'];
  region_similarity_pct: number | null;
  keys: unknown;
  anchor: SelectionVerifyRecord['anchor'];
}): void {
  try {
    if (rec.verdict !== 'verified' && rec.verdict !== 'unverified' && rec.verdict !== 'blind') return;
    selectionLedger = {
      verdict: rec.verdict,
      region_similarity_pct: typeof rec.region_similarity_pct === 'number' && Number.isFinite(rec.region_similarity_pct)
        ? rec.region_similarity_pct
        : null,
      keys: Array.isArray(rec.keys) ? rec.keys.map((k) => (typeof k === 'string' ? k : String(k))) : [],
      anchor: rec.anchor ?? null,
      at: Date.now(),
    };
  } catch {
    /* 观察性旁路：绝不抛 */
  }
}

/** ΑΝΒ-2（W-08）：读取未过期的选区验证记录（只读，不消费）。 */
export function peekSelectionVerification(
  maxAgeMs = 30_000, now = Date.now(),
): Readonly<SelectionVerifyRecord> | null {
  if (!selectionLedger) return null;
  if (now - selectionLedger.at > maxAgeMs) return null;
  return { ...selectionLedger };
}

/**
 * ΑΝΒ-2（W-08）：一次性消费 —— type_text 派发成功后调用（打字即覆盖/消费
 * 选区，VERIFIED 语义不得跨打字存活 —— 第二次 type_text 不得宣称替换选区）。
 */
export function consumeSelectionVerification(
  maxAgeMs = 30_000, now = Date.now(),
): Readonly<SelectionVerifyRecord> | null {
  const rec = peekSelectionVerification(maxAgeMs, now);
  selectionLedger = null; // 无论读没读到都清账：消费动作本身就是失效事件
  return rec;
}

/** ΑΝΒ-2（W-08）：显式失效（非选族 press_hotkey 派发后调用 —— 裸导航键折叠
 *  选区、其他键可能消费选区；保守方向：宁失 VERIFIED 勿造盲插入）。 */
export function invalidateSelectionVerification(): void {
  selectionLedger = null;
}

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
