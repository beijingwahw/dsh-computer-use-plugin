// src/system.ts
// 系统层：所有平台差异与底层 IO 的唯一归宿（防腐层）。
// 融合两个地层：IO 基石层（click/type/跨平台清空）+ 多显示器层（getAllDisplays/getActiveDisplay）。
// 修复原版缺陷：补齐下游工具曾调用的 getScreenSize；键位白名单从工具层下沉到此处。
import { mouse, keyboard, screen, Button, Key } from '@nut-tree/nut-js';
import screenshot from 'screenshot-desktop';
import type { Config } from './config';

// 键位白名单：模型只能命中这里列出的键 —— 白名单即安全边界（来自 pressHotkey 地层）
const keyMap: Record<string, Key> = {
  ctrl: Key.LeftControl, cmd: Key.LeftSuper, alt: Key.LeftAlt, shift: Key.LeftShift,
  enter: Key.Enter, tab: Key.Tab, space: Key.Space, backspace: Key.Backspace,
  delete: Key.Delete, esc: Key.Escape, f1: Key.F1, f2: Key.F2, f3: Key.F3, f4: Key.F4,
  f5: Key.F5, f11: Key.F11, f12: Key.F12, a: Key.A, c: Key.C, v: Key.V, z: Key.Z,
};

// 业务语义 -> nut-js 枚举的翻译表：换底层库时只改这张表（防腐层核心）
const btnMap: Record<string, Button> = {
  left: Button.LEFT, right: Button.RIGHT, middle: Button.MIDDLE,
};

export interface DisplayInfo {
  name: string;
  x: number; y: number;
  width: number; height: number;
}

export const system = {
  /** 应用插件配置。鼠标速度等人性化参数在此注入（来自「双手纪元」的模块级副作用，改为显式配置） */
  configure(config: Config) {
    mouse.config.mouseSpeed = config.mouseSpeed;
  },

  /** 屏幕截取：screenshot-desktop 返回 PNG Buffer */
  async captureScreen(): Promise<Buffer> {
    return await screenshot();
  },

  /** 修复原版「幽灵方法」：下游工具一直调用却从未存在 */
  async getScreenSize(): Promise<{ width: number; height: number }> {
    // 注意：nut-js 的宽高是异步方法而非属性（原版地层注释留下的坑位知识）
    return { width: await screen.width(), height: await screen.height() };
  },

  async getMousePosition(): Promise<{ x: number; y: number }> {
    return await mouse.getPosition();
  },

  /** 多显示器：全部虚拟屏幕信息（来自「多显示器纪元」） */
  async getAllDisplays(): Promise<DisplayInfo[]> {
    const raw = await screen.getAllDisplays();
    return raw.map((d: any) => ({
      name: d.name ?? `Display@${d.x},${d.y}`,
      x: d.x, y: d.y, width: d.width, height: d.height,
    }));
  },

  /** 「Agent 正在操作哪个次元」：以鼠标位置做点包含测试，兜底主屏 */
  async getActiveDisplay(): Promise<DisplayInfo> {
    const [pos, displays] = await Promise.all([mouse.getPosition(), this.getAllDisplays()]);
    return displays.find(d =>
      pos.x >= d.x && pos.x <= d.x + d.width &&
      pos.y >= d.y && pos.y <= d.y + d.height,
    ) ?? displays[0];
  },

  async clickMouse(x: number, y: number, button: string = 'left'): Promise<void> {
    const btn = btnMap[button];
    if (!btn) throw new Error(`Unknown mouse button: ${button}`);
    await mouse.move([{ x, y }]);
    await mouse.click(btn);
  },

  /** 键盘输入：clearFirst 跨平台全选-删除时序（来自「双手纪元」） */
  async typeText(text: string, clearFirst: boolean = false): Promise<void> {
    if (clearFirst) {
      // Windows/Linux 用 Ctrl+A，Mac 用 Cmd+A；全选必须先释放再按 Backspace（时序细节）
      const isMac = process.platform === 'darwin';
      const mod = isMac ? Key.LeftSuper : Key.LeftControl;
      await keyboard.pressKey(mod, Key.A);
      await keyboard.releaseKey(mod, Key.A);
      await keyboard.pressKey(Key.Backspace);
      await keyboard.releaseKey(Key.Backspace);
    }
    await keyboard.type(text);
  },

  /** 拖拽四拍时序：移->按->移->放，每拍 await（来自 dragMouse 地层） */
  async dragMouse(start: { x: number; y: number }, end: { x: number; y: number }): Promise<void> {
    await mouse.move([{ x: start.x, y: start.y }]);
    await mouse.pressButton(Button.LEFT);
    await mouse.move([{ x: end.x, y: end.y }]);
    await mouse.releaseButton(Button.LEFT);
  },

  /** 修复原版「四方向全部 scrollDown」的 bug：按方向分派 */
  async scroll(direction: 'up' | 'down' | 'left' | 'right', amount: number): Promise<void> {
    switch (direction) {
      case 'up': await mouse.scrollUp(amount); break;
      case 'down': await mouse.scrollDown(amount); break;
      case 'left': await mouse.scrollLeft(amount); break;
      case 'right': await mouse.scrollRight(amount); break;
    }
  },

  /**
   * 组合键：白名单映射 + 数量对账 + 对称按下/释放。
   * 「全部识别或全部拒绝」的原子语义（来自 pressHotkey 地层）。
   */
  async pressHotkey(keys: string[]): Promise<void> {
    const mapped = keys.map(k => keyMap[k.toLowerCase()]).filter(Boolean);
    if (mapped.length !== keys.length) {
      throw new Error(`Unrecognized key names in combination: [${keys.join(', ')}]`);
    }
    await keyboard.pressKey(...mapped);
    await keyboard.releaseKey(...mapped);
  },

  /**
   * 按标题关键词激活窗口。nut-js 开源版不含窗口管理 —— 诚实抛出可操作的错误，
   * 由上层工具给出 press_hotkey 降级路径（失败也设计成可恢复的路由节点）。
   */
  async switchWindowByTitle(_keyword: string): Promise<void> {
    throw new Error(
      'Window management is not available in this environment. ' +
      'Install a window-management provider, or switch windows via the press_hotkey tool.',
    );
  },
};
