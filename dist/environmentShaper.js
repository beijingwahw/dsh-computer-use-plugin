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
import { serialize } from './ioMutex.js';
import { journal } from './journal.js';
const exec = promisify(execFile);
/** 命令存在性探测：which 的同步包装（零运行时依赖；异常 = 不存在） */
function probeCommand(cmd) {
    try {
        return spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
    }
    catch {
        return false;
    }
}
/** 系统级动作清单：默认禁用，config 闸门开启后才可用 */
const SYSTEM_WIDE_KINDS = new Set(['set_contrast']);
/** gsettings 高对比度主题键：GNOME 标准位置（非 GNOME 桌面写入无害失败） */
const GTK_THEME_KEY = 'org.gnome.desktop.interface';
const GTK_THEME_PROP = 'gtk-theme';
const HIGH_CONTRAST = 'HighContrast';
export class LinuxAdapter {
    platform = 'linux';
    probe;
    execFn;
    env;
    constructor(deps = {}) {
        this.probe = deps.probe ?? probeCommand;
        this.execFn = deps.exec ?? exec;
        this.env = deps.env ?? process.env;
    }
    /** 能力探测：wmctrl→窗口三动作；DISPLAY→键盘缩放；gsettings+DISPLAY→对比度 */
    async capabilities() {
        const caps = new Set();
        try {
            const hasWmctrl = this.probe('wmctrl');
            const hasDisplay = !!this.env.DISPLAY; // 无 X 会话则键盘/窗口管线整体不可用
            if (hasWmctrl && hasDisplay) {
                caps.add('raise_window').add('maximize_window').add('move_window');
            }
            if (hasDisplay)
                caps.add('set_zoom');
            if (hasWmctrl && hasDisplay && this.probe('gsettings')) {
                caps.add('set_contrast');
            }
        }
        catch { /* 探测失败 = 能力空集：诚实世界（initialize 契约：永不抛错） */ }
        return caps;
    }
    async apply(action) {
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
                const { system } = await import('./system.js');
                await system.pressHotkey(['ctrl', '0']);
                for (let i = 0; i < presses; i++)
                    await system.pressHotkey(['ctrl', '+']);
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
    async undo(recipe) {
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
                const { system } = await import('./system.js');
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
    async getWindowGeometry(titleHint) {
        try {
            // xdotool shell 输出：WINDOW/X/Y/WIDTH/HEIGHT/SCREEN 各一行
            const { stdout: idOut } = await this.execFn('xdotool', ['search', '--name', titleHint]);
            const id = idOut.trim().split('\n').pop()?.trim();
            if (!id)
                return null;
            const { stdout } = await this.execFn('xdotool', ['getwindowgeometry', '--shell', id]);
            const g = {};
            for (const line of stdout.trim().split('\n')) {
                const [k, v] = line.split('=');
                if (k && v !== undefined && !Number.isNaN(Number(v)))
                    g[k.trim()] = Number(v);
            }
            return {
                x: g.X ?? 0, y: g.Y ?? 0, width: g.WIDTH ?? 0, height: g.HEIGHT ?? 0,
                maximized: false, // xdotool 不报最大化标记：undo 先 remove 再归位，标记恒被正确还原
            };
        }
        catch {
            return null; // 无 xdotool/未命中窗口：before 快照缺失，undo 降级（诚实记录）
        }
    }
}
/** Windows：DWM/UIA 接口签名就位（能力预留 —— 架构留白，实现待真实环境） */
export class WindowsAdapter {
    platform = 'win32';
    async capabilities() { return new Set(); }
    async apply(_action) {
        throw new Error('WindowsAdapter is a reserved capability slot (not yet implemented)');
    }
    async undo(_recipe) { }
    async getWindowGeometry(_titleHint) { return null; }
}
/** Null：capabilities 恒空 —— 优雅降级（swarmEndpoint 同款姿态） */
export class NullAdapter {
    platform = 'null';
    async capabilities() { return new Set(); }
    async apply(_action) {
        throw new Error('NullAdapter has no capabilities');
    }
    async undo(_recipe) { }
    async getWindowGeometry(_titleHint) { return null; }
}
class Shaper {
    adapter = new NullAdapter();
    caps = new Set();
    undoLog = [];
    tokenSeq = 0;
    allowSystemWide = false;
    dryRun = false;
    initialized = false;
    /** 配置注入（index.ts 启动时调用；测试隔离亦可直呼） */
    configure(allowSystemWide, dryRun) {
        this.allowSystemWide = allowSystemWide;
        this.dryRun = dryRun;
    }
    async initialize() {
        // 永不抛错契约：任何探测异常 ⇒ NullAdapter 语义（空能力集），启动继续
        try {
            if (process.platform === 'linux')
                this.adapter = new LinuxAdapter();
            else if (process.platform === 'win32')
                this.adapter = new WindowsAdapter();
            else
                this.adapter = new NullAdapter();
            this.caps = await this.adapter.capabilities();
        }
        catch (e) {
            console.warn(`[Shaper] capability probe failed (${e.message}); continuing with empty capability set.`);
            this.adapter = new NullAdapter();
            this.caps = new Set();
        }
        this.initialized = true;
    }
    /** 懒初始化保险：未 initialize 即被调用时以空能力集应答（防御性，不替代正常接线） */
    ensure() {
        if (!this.initialized) {
            this.caps = new Set();
            this.initialized = true;
        }
    }
    capabilities() {
        this.ensure();
        return this.caps;
    }
    platform() {
        this.ensure();
        return this.adapter.platform;
    }
    async apply(action) {
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
        }
        catch (e) {
            return { ok: false, reason: e.message };
        }
    }
    async applyPreset(preset, titleHint) {
        const kinds = preset.split(',').map(s => s.trim()).filter(Boolean);
        if (kinds.length === 0)
            return [{ ok: false, reason: 'preset is empty' }];
        const results = [];
        for (const kind of kinds) {
            if (!this.capabilities().has(kind) &&
                !['set_zoom', 'set_contrast'].includes(kind)) {
                // 伪动作 kind：直接拒（不进 adapter 抛错路径）
                results.push({ ok: false, reason: `unknown preset step "${kind}"` });
                continue;
            }
            const action = { kind: kind, ...(titleHint ? { titleHint } : {}) };
            results.push(await this.apply(action));
        }
        return results;
    }
    async restoreAll() {
        this.ensure();
        const results = [];
        // LIFO：后做的先还原 —— 依赖序天然正确（先 move 后 maximize 的逆序复原）
        for (let i = this.undoLog.length - 1; i >= 0; i--) {
            const rec = this.undoLog[i];
            if (rec.undone)
                continue;
            try {
                await serialize(() => this.adapter.undo(rec.recipe));
                rec.undone = true;
                rec.undoneAt = Date.now();
                results.push({ token: rec.token, ok: true });
            }
            catch (e) {
                rec.undoFailureReason = e.message;
                results.push({ token: rec.token, ok: false, reason: e.message });
                // 部分复原优于中止：失败记录后继续弹栈
            }
        }
        return results;
    }
    dumpUndoLog() {
        return this.undoLog.map(r => ({ ...r, action: { ...r.action }, recipe: { ...r.recipe, before: r.recipe.before ? { ...r.recipe.before } : undefined } }));
    }
    restoreUndoLog(records) {
        if (!Array.isArray(records))
            return;
        // 防御性恢复：结构非法条目跳过；只认领未复原条目的复原义务
        this.undoLog = records.filter(r => r && typeof r.token === 'string' && r.recipe && typeof r.recipe.kind === 'string');
        this.tokenSeq = this.undoLog.length; // 后续发号不撞已存在令牌
    }
    undoDepth() {
        return this.undoLog.filter(r => !r.undone).length;
    }
    clearUndoLog() {
        this.undoLog = [];
        this.tokenSeq = 0;
    }
}
// 单例是正确的：一台躯体只有一个工作台；物理唯一性由 serialize 保证
export const shaper = new Shaper();
