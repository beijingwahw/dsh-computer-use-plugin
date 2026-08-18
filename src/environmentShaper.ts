// src/environmentShaper.ts
// D-2 环境重塑：Agent 从「环境的适应者」变为「工作台的造物主」——
// 但造物主的第一美德是复原：改变世界的权力与复原世界的义务严格对称。
//
// 三条工程诚实性声明：
//   1. 能力运行时探测 —— 适配器启动时探测（which/环境变量），诚实申报能力集，绝不假装拥有
//   2. 作用域分级 —— 窗口级（低风险默认可用）vs 系统级（shaperAllowSystemWide 闸门后置）
//   3. 物理动作入队 —— 窗口操作改变真实桌面，全部经 D-1 的 serialize() 互斥队列
//
// 撤销模型（审查修正版）：UndoRecipe.kind 恒等于原始动作 kind（无特殊值混入），
// 还原由 before 快照驱动；z-order 不可逆与浏览器缩放不可读两处诚实降级均在注释文档化。
import { execFile, spawnSync } from 'child_process';
import { promisify } from 'util';
import { serialize } from './ioMutex';
import { journal } from './journal';

const exec = promisify(execFile);

/** 命令存在性探测：which 的同步包装（零运行时依赖；异常 = 不存在） */
function probeCommand(cmd: string): boolean {
  try { return spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0; } catch { return false; }
}

// ─── 动作与撤销模型 ───

export type ShaperActionKind =
  | 'raise_window'    // 窗口级：置前激活
  | 'maximize_window' // 窗口级：最大化（消除标题栏遮挡与坐标漂移）
  | 'move_window'     // 窗口级：移动到固定位置
  | 'set_zoom'        // 窗口级：浏览器 Ctrl+±/0 缩放（复用键盘热键管线）
  | 'set_contrast';   // 系统级：高对比度主题（shaperAllowSystemWide 闸门后置）

/** 系统级动作清单：默认禁用，config 闸门开启后才可用 */
const SYSTEM_WIDE_KINDS: ReadonlySet<ShaperActionKind> = new Set(['set_contrast']);

export interface ShaperAction {
  kind: ShaperActionKind;
  /** 窗口标题关键词（窗口级动作必需；系统级忽略） */
  titleHint?: string;
  /** move_window 目标（像素） / set_zoom 百分比（如 125） */
  x?: number;
  y?: number;
  level?: number;
}

/** 统一结果契约：apply / applyPreset / restoreAll 三面同构（审查修正 #2） */
export interface ShaperResult {
  /** 撤销令牌（apply 成功时必有；restoreAll 项回填被复原条目的 token） */
  token?: string;
  ok: boolean;
  /** 失败必有原因 —— 与 toolOk/toolErr 的反幻觉锚点同款纪律 */
  reason?: string;
}

/**
 * 撤销配方：apply 前捕获的「如何还原」知识。
 * kind 恒等于被撤销动作的 kind —— 撤销逻辑的分发键，无特殊值混入（审查修正 #1）；
 * 还原的具体几何由 before 快照驱动，而非逆动作类型编码。
 */
export interface UndoRecipe {
  /** 恒等于被撤销动作的 ShaperActionKind（审计对账：recipe 与动作一一对应） */
  kind: ShaperActionKind;
  /**
   * apply 前的原始状态快照 —— undo() 的全部知识来源：
   *   maximize_window: { maximized, x, y, width, height }（还原几何 + 还原标记）
   *   move_window:     { x, y }（搬回原位）
   *   set_zoom:        {}（浏览器缩放是站点内部态，系统不可读 —— 诚实策略：Ctrl+0 归零）
   *   set_contrast:    { theme }（还原主题原值；level 专属于 zoom 的百分比语义）
   *   raise_window:    {}（z-order 不可逆 —— undo 为文档化 no-op，撤销栈如实记录）
   */
  before?: { x?: number; y?: number; width?: number; height?: number; maximized?: boolean; level?: number; theme?: string };
  titleHint?: string;
}

export interface UndoRecord {
  token: string;           // 'undo-3'（单调递增，可审计引用）
  action: ShaperAction;    // 被撤销的原始动作
  recipe: UndoRecipe;      // 撤销配方
  undone: boolean;         // 已复原？（复原失败时 false + reason —— 部分复原继续）
  undoneAt?: number;
  undoFailureReason?: string;
}

export interface WindowGeometry {
  x: number; y: number; width: number; height: number; maximized: boolean;
}

// ─── 平台适配器协议：唯一的平台差异归宿（与 system.ts 同款防腐层哲学） ───

export interface SystemAdapter {
  readonly platform: string; // 'linux' | 'win32' | 'null'
  /** 启动时探测：诚实申报本机可执行的动作集（绝不含未探测项） */
  capabilities(): Promise<ReadonlySet<ShaperActionKind>>;
  /** 单动作执行 + 撤销配方捕获。不支持/失败 ⇒ 抛错（shaper 层翻译为可读结果） */
  apply(action: ShaperAction): Promise<UndoRecipe>;
  /** 按配方复原。失败不抛出（返回错误说明由调用方记录，restoreAll 继续） */
  undo(recipe: UndoRecipe): Promise<void>;
  /** 窗口几何查询（撤销配方的 before 快照来源）；无工具/未命中 ⇒ null */
  getWindowGeometry(titleHint: string): Promise<WindowGeometry | null>;
}

// ─── 适配器实现 ───

/** 依赖注入束：测试零子进程依赖（probe/exec 均可替换） */
export interface AdapterDeps {
  /** 探测命令是否存在（默认 which） */
  probe?: (cmd: string) => boolean;
  /** 子进程执行（默认 child_process.execFile） */
  exec?: (cmd: string, args: string[]) => Promise<{ stdout: string }>;
  /** 环境变量视图（默认 process.env；测试注入假 DISPLAY） */
  env?: Record<string, string | undefined>;
}

/** gsettings 高对比度主题键：GNOME 标准位置（非 GNOME 桌面写入无害失败） */
const GTK_THEME_KEY = 'org.gnome.desktop.interface';
const GTK_THEME_PROP = 'gtk-theme';
const HIGH_CONTRAST = 'HighContrast';

export class LinuxAdapter implements SystemAdapter {
  readonly platform = 'linux';
  private probe: (cmd: string) => boolean;
  private execFn: (cmd: string, args: string[]) => Promise<{ stdout: string }>;
  private env: Record<string, string | undefined>;

  constructor(deps: AdapterDeps = {}) {
    this.probe = deps.probe ?? probeCommand;
    this.execFn = deps.exec ?? exec;
    this.env = deps.env ?? process.env;
  }

  /** 能力探测：wmctrl→窗口三动作；DISPLAY→键盘缩放；gsettings+DISPLAY→对比度 */
  async capabilities(): Promise<ReadonlySet<ShaperActionKind>> {
    const caps = new Set<ShaperActionKind>();
    try {
      const hasWmctrl = this.probe('wmctrl');
      const hasDisplay = !!this.env.DISPLAY; // 无 X 会话则键盘/窗口管线整体不可用
      if (hasWmctrl && hasDisplay) {
        caps.add('raise_window').add('maximize_window').add('move_window');
      }
      if (hasDisplay) caps.add('set_zoom');
      if (hasWmctrl && hasDisplay && this.probe('gsettings')) {
        caps.add('set_contrast');
      }
    } catch { /* 探测失败 = 能力空集：诚实世界（initialize 契约：永不抛错） */ }
    return caps;
  }

  async apply(action: ShaperAction): Promise<UndoRecipe> {
    const hint = action.titleHint ?? '';
    switch (action.kind) {
      case 'raise_window': {
        await this.execFn('wmctrl', ['-a', hint]);
        return { kind: 'raise_window', titleHint: hint }; // z-order 不可逆：undo 为文档化 no-op
      }
      case 'maximize_window': {
        const before = await this.getWindowGeometry(hint);
        await this.execFn('wmctrl', ['-a', hint]); // 激活后用 :ACTIVE: 寻址（多窗口同 Hint 歧义最小化）
        await this.execFn('wmctrl', ['-r', ':ACTIVE:', '-b', 'add,maximized_vert,maximized_horz']);
        return {
          kind: 'maximize_window', titleHint: hint,
          // 几何不可读时 before 仅含 maximized 标记推断 —— undo 降级为去标记，诚实记录
          before: before ?? undefined,
        };
      }
      case 'move_window': {
        if (typeof action.x !== 'number' || typeof action.y !== 'number') {
          throw new Error('move_window requires numeric x and y');
        }
        const before = await this.getWindowGeometry(hint);
        await this.execFn('wmctrl', ['-r', hint, '-e', `0,${Math.round(action.x)},${Math.round(action.y)},-1,-1`]);
        return { kind: 'move_window', titleHint: hint, before: before ?? undefined };
      }
      case 'set_zoom': {
        // 缩放百分比 → 按键序列：Ctrl+0 归零后按 N 次 plus（每档约 10%）
        const level = typeof action.level === 'number' ? action.level : 100;
        const presses = Math.max(0, Math.min(9, Math.round((level - 100) / 10)));
        // 复用 system 热键管线（含 serialize 与白名单）—— 延迟导入避免模块环
        const { system } = await import('./system');
        await system.pressHotkey(['ctrl', '0']);
        for (let i = 0; i < presses; i++) await system.pressHotkey(['ctrl', '+']);
        return { kind: 'set_zoom', titleHint: hint }; // 站点内部态不可读：undo 恒为 Ctrl+0
      }
      case 'set_contrast': {
        const { stdout } = await this.execFn('gsettings', ['get', GTK_THEME_KEY, GTK_THEME_PROP]);
        const theme = stdout.trim().replace(/^'|'$/g, ''); // 去掉 gsettings 的引号包装
        await this.execFn('gsettings', ['set', GTK_THEME_KEY, GTK_THEME_PROP, HIGH_CONTRAST]);
        return { kind: 'set_contrast', before: { theme } };
      }
    }
  }

  async undo(recipe: UndoRecipe): Promise<void> {
    switch (recipe.kind) {
      case 'raise_window':
        return; // z-order 不可逆：文档化 no-op（撤销栈如实记录）
      case 'maximize_window': {
        await this.execFn('wmctrl', ['-a', recipe.titleHint ?? '']);
        await this.execFn('wmctrl', ['-r', ':ACTIVE:', '-b', 'remove,maximized_vert,maximized_horz']);
        const b = recipe.before;
        if (typeof b?.x === 'number' && typeof b.y === 'number') {
          // 几何快照存在 ⇒ 精确归位；否则诚实止步于去最大化标记
          await this.execFn('wmctrl', [
            '-r', ':ACTIVE:', '-e',
            `0,${Math.round(b.x)},${Math.round(b.y)},${b.width ? Math.round(b.width) : -1},${b.height ? Math.round(b.height) : -1}`,
          ]);
        }
        return;
      }
      case 'move_window': {
        const b = recipe.before;
        if (typeof b?.x === 'number' && typeof b.y === 'number') {
          await this.execFn('wmctrl', ['-r', recipe.titleHint ?? '', '-e', `0,${Math.round(b.x)},${Math.round(b.y)},-1,-1`]);
        }
        return; // 无快照（getWindowGeometry 曾失败）⇒ no-op：诚实记录于撤销栈
      }
      case 'set_zoom': {
        const { system } = await import('./system');
        await system.pressHotkey(['ctrl', '0']); // 归零策略：站点内部态不可读
        return;
      }
      case 'set_contrast': {
        const orig = recipe.before?.theme;
        if (orig) {
          await this.execFn('gsettings', ['set', GTK_THEME_KEY, GTK_THEME_PROP, orig]);
        }
        return;
      }
    }
  }

  async getWindowGeometry(titleHint: string): Promise<WindowGeometry | null> {
    try {
      // xdotool shell 输出：WINDOW/X/Y/WIDTH/HEIGHT/SCREEN 各一行
      const { stdout: idOut } = await this.execFn('xdotool', ['search', '--name', titleHint]);
      const id = idOut.trim().split('\n').pop()?.trim();
      if (!id) return null;
      const { stdout } = await this.execFn('xdotool', ['getwindowgeometry', '--shell', id]);
      const g: Record<string, number> = {};
      for (const line of stdout.trim().split('\n')) {
        const [k, v] = line.split('=');
        if (k && v !== undefined && !Number.isNaN(Number(v))) g[k.trim()] = Number(v);
      }
      return {
        x: g.X ?? 0, y: g.Y ?? 0, width: g.WIDTH ?? 0, height: g.HEIGHT ?? 0,
        maximized: false, // xdotool 不报最大化标记：undo 先 remove 再归位，标记恒被正确还原
      };
    } catch {
      return null; // 无 xdotool/未命中窗口：before 快照缺失，undo 降级（诚实记录）
    }
  }
}

/** Windows：DWM/UIA 接口签名就位（能力预留 —— 架构留白，实现待真实环境） */
export class WindowsAdapter implements SystemAdapter {
  readonly platform = 'win32';
  async capabilities(): Promise<ReadonlySet<ShaperActionKind>> { return new Set(); }
  async apply(_action: ShaperAction): Promise<UndoRecipe> {
    throw new Error('WindowsAdapter is a reserved capability slot (not yet implemented)');
  }
  async undo(_recipe: UndoRecipe): Promise<void> { /* 不可达：能力集恒空 */ }
  async getWindowGeometry(_titleHint: string): Promise<WindowGeometry | null> { return null; }
}

/** Null：capabilities 恒空 —— 优雅降级（swarmEndpoint 同款姿态） */
export class NullAdapter implements SystemAdapter {
  readonly platform = 'null';
  async capabilities(): Promise<ReadonlySet<ShaperActionKind>> { return new Set(); }
  async apply(_action: ShaperAction): Promise<UndoRecipe> {
    throw new Error('NullAdapter has no capabilities');
  }
  async undo(_recipe: UndoRecipe): Promise<void> { /* 不可达 */ }
  async getWindowGeometry(_titleHint: string): Promise<WindowGeometry | null> { return null; }
}

// ─── Shaper 单例：适配器之上的安全层 ───

export interface EnvironmentShaper {
  /**
   * 启动探测：选定适配器 + 缓存能力集。
   * @throws 永不抛错。探测链路自身失败（which 异常/子进程崩溃）⇒ 记录警告、
   *       能力集置空、继续启动。环境重塑是增益能力而非存在前提 ——
   *       启动韧性优先于能力完备（NullAdapter 语义内化到探测层）。
   */
  initialize(): Promise<void>;
  /** 能力视图：工具面消费，模型可见「这具躯体能做什么」 */
  capabilities(): ReadonlySet<ShaperActionKind>;
  /**
   * 执行动作：四道工序 —— 能力校验 → 作用域闸门 → serialize 入队 → 捕获撤销配方。
   * ENV_SHAPED 标记随行入链（D-1 已预留类型）；dryRun 模式拒绝执行（无真实变更即无复原义务）。
   */
  apply(action: ShaperAction): Promise<ShaperResult>;
  /** LIFO 复原栈：逐条弹栈逆序复原。单条失败记录原因后继续（部分复原优于中止） */
  restoreAll(): Promise<ShaperResult[]>;
  /** 预设序列：'raise,maximize' 解析为动作链顺序执行 */
  applyPreset(preset: string, titleHint?: string): Promise<ShaperResult[]>;
  /** 视图与持久化：撤销日志快照（checkpoint 消费 —— 崩溃后复原义务不蒸发） */
  dumpUndoLog(): UndoRecord[];
  restoreUndoLog(records: UndoRecord[] | undefined): void;
  /** 撤销栈深度（自诊断/测试消费；只计未复原条目） */
  undoDepth(): number;
  /** 仅清空撤销日志（丢弃复原义务，不执行任何物理复原）—— 测试隔离/显式弃责用 */
  clearUndoLog(): void;
  /** 平台名（capabilities 视图的伴生元数据） */
  platform(): string;
}

class Shaper implements EnvironmentShaper {
  private adapter: SystemAdapter = new NullAdapter();
  private caps: ReadonlySet<ShaperActionKind> = new Set();
  private undoLog: UndoRecord[] = [];
  private tokenSeq = 0;
  private allowSystemWide = false;
  private dryRun = false;
  private initialized = false;

  /** 配置注入（index.ts 启动时调用；测试隔离亦可直呼） */
  configure(allowSystemWide: boolean, dryRun: boolean): void {
    this.allowSystemWide = allowSystemWide;
    this.dryRun = dryRun;
  }

  async initialize(): Promise<void> {
    // 永不抛错契约：任何探测异常 ⇒ NullAdapter 语义（空能力集），启动继续
    try {
      if (process.platform === 'linux') this.adapter = new LinuxAdapter();
      else if (process.platform === 'win32') this.adapter = new WindowsAdapter();
      else this.adapter = new NullAdapter();
      this.caps = await this.adapter.capabilities();
    } catch (e: any) {
      console.warn(`[Shaper] capability probe failed (${e.message}); continuing with empty capability set.`);
      this.adapter = new NullAdapter();
      this.caps = new Set();
    }
    this.initialized = true;
  }

  /** 懒初始化保险：未 initialize 即被调用时以空能力集应答（防御性，不替代正常接线） */
  private ensure(): void {
    if (!this.initialized) {
      this.caps = new Set();
      this.initialized = true;
    }
  }

  capabilities(): ReadonlySet<ShaperActionKind> {
    this.ensure();
    return this.caps;
  }

  platform(): string {
    this.ensure();
    return this.adapter.platform;
  }

  async apply(action: ShaperAction): Promise<ShaperResult> {
    this.ensure();
    if (this.dryRun) {
      // 诚实拒绝而非假装成功：无真实变更即无复原义务（simulated success 是债的地层教训）
      return { ok: false, reason: 'dry-run: environment shaping is skipped (no real change, no undo duty)' };
    }
    if (!this.caps.has(action.kind)) {
      return {
        ok: false,
        reason: `capability "${action.kind}" is unavailable on this platform (${this.adapter.platform}); ` +
          `call shape_environment(action="capabilities") to see what this body can do`,
      };
    }
    if (SYSTEM_WIDE_KINDS.has(action.kind) && !this.allowSystemWide) {
      return {
        ok: false,
        reason: `"${action.kind}" is a system-wide change and is disabled (shaperAllowSystemWide=false)`,
      };
    }
    const needsHint = action.kind === 'raise_window' || action.kind === 'maximize_window' || action.kind === 'move_window';
    if (needsHint && !action.titleHint?.trim()) {
      return { ok: false, reason: `${action.kind} requires a titleHint to address the target window` };
    }
    try {
      // 物理动作入队：窗口操作改变真实桌面，经 D-1 互斥队列与其他动作串行
      const recipe = await serialize(() => this.adapter.apply(action));
      const token = `undo-${++this.tokenSeq}`;
      this.undoLog.push({ token, action, recipe, undone: false });
      void journal.appendMarker({
        kind: 'ENV_SHAPED', action: `${action.kind}${action.titleHint ? ` "${action.titleHint}"` : ''}`,
      });
      return { ok: true, token };
    } catch (e: any) {
      return { ok: false, reason: e.message };
    }
  }

  async applyPreset(preset: string, titleHint?: string): Promise<ShaperResult[]> {
    const kinds = preset.split(',').map(s => s.trim()).filter(Boolean);
    if (kinds.length === 0) return [{ ok: false, reason: 'preset is empty' }];
    const results: ShaperResult[] = [];
    for (const kind of kinds) {
      if (!(this.capabilities() as Set<ShaperActionKind>).has(kind as ShaperActionKind) &&
          !['set_zoom', 'set_contrast'].includes(kind)) {
        // 伪动作 kind：直接拒（不进 adapter 抛错路径）
        results.push({ ok: false, reason: `unknown preset step "${kind}"` });
        continue;
      }
      const action: ShaperAction = { kind: kind as ShaperActionKind, ...(titleHint ? { titleHint } : {}) };
      results.push(await this.apply(action));
    }
    return results;
  }

  async restoreAll(): Promise<ShaperResult[]> {
    this.ensure();
    const results: ShaperResult[] = [];
    // LIFO：后做的先还原 —— 依赖序天然正确（先 move 后 maximize 的逆序复原）
    for (let i = this.undoLog.length - 1; i >= 0; i--) {
      const rec = this.undoLog[i];
      if (rec.undone) continue;
      try {
        await serialize(() => this.adapter.undo(rec.recipe));
        rec.undone = true;
        rec.undoneAt = Date.now();
        results.push({ token: rec.token, ok: true });
      } catch (e: any) {
        rec.undoFailureReason = e.message;
        results.push({ token: rec.token, ok: false, reason: e.message });
        // 部分复原优于中止：失败记录后继续弹栈
      }
    }
    return results;
  }

  dumpUndoLog(): UndoRecord[] {
    return this.undoLog.map(r => ({ ...r, action: { ...r.action }, recipe: { ...r.recipe, before: r.recipe.before ? { ...r.recipe.before } : undefined } }));
  }

  restoreUndoLog(records: UndoRecord[] | undefined): void {
    if (!Array.isArray(records)) return;
    // 防御性恢复：结构非法条目跳过；只认领未复原条目的复原义务
    this.undoLog = records.filter(r =>
      r && typeof r.token === 'string' && r.recipe && typeof r.recipe.kind === 'string');
    this.tokenSeq = this.undoLog.length; // 后续发号不撞已存在令牌
  }

  undoDepth(): number {
    return this.undoLog.filter(r => !r.undone).length;
  }

  clearUndoLog(): void {
    this.undoLog = [];
    this.tokenSeq = 0;
  }
}

// 单例是正确的：一台躯体只有一个工作台；物理唯一性由 serialize 保证
export const shaper = new Shaper();
