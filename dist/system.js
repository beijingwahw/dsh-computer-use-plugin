import { Config as ConfigSchema } from './config.js';
import { serialize } from './ioMutex.js';
import * as backend from './physicalBackend.js';
export { serialize };
// ─── legacy 路径（DSH_FORCE_LEGACY_SYSTEM=1 时启用）───
const MIGRATION_NOTICE = 'Legacy native dependency (@nut-tree/nut-js / screenshot-desktop / sharp / tesseract.js) ' +
    'removed in batch E. The default execution path is now the D-5 Python microservice ' +
    '(physicalBackend). If you must use the old D-1 native stack, reinstall the 4 removed ' +
    'packages and set DSH_FORCE_LEGACY_SYSTEM=1 as environment variable.';
function legacyError(dep, extraHint) {
    const envOk = process.env.DSH_FORCE_LEGACY_SYSTEM === '1';
    if (envOk) {
        return new Error(`[system.ts] Lazy import of '${dep}' failed (it's not installed). ` +
            `DSH_FORCE_LEGACY_SYSTEM=1 is set but package is absent. Install it via npm.`);
    }
    return new Error(`[system.ts] '${dep}' is removed (batch-E migration). ${MIGRATION_NOTICE}` +
        (extraHint ? ` Hint: ${extraHint}` : ''));
}
function forceLegacy() {
    return process.env.DSH_FORCE_LEGACY_SYSTEM === '1';
}
let _nutJS = null;
let _nutJSError = null;
async function _getNutJS() {
    if (_nutJS)
        return _nutJS;
    if (_nutJSError)
        throw _nutJSError;
    try {
        const mod = await import('@nut-tree/nut-js');
        const api = {
            mouse: mod.mouse,
            keyboard: mod.keyboard,
            screen: mod.screen,
            Button: mod.Button,
            Key: mod.Key,
        };
        if (api.mouse && typeof api.mouse.config !== 'undefined') {
            try {
                api.mouse.config.FAILSAFE = true;
            }
            catch { /* noop */ }
        }
        _nutJS = api;
        return api;
    }
    catch (e) {
        _nutJSError = legacyError('@nut-tree/nut-js', 'Mouse/keyboard actions now route through D-5 Python microservice by default.');
        _nutJSError.cause = e;
        throw _nutJSError;
    }
}
let _screenshotFn = null;
let _screenshotError = null;
async function _getScreenshotFn() {
    if (_screenshotFn)
        return _screenshotFn;
    if (_screenshotError)
        throw _screenshotError;
    try {
        const mod = await import('screenshot-desktop');
        const fn = mod.default ?? mod;
        _screenshotFn = () => fn();
        return _screenshotFn;
    }
    catch (e) {
        _screenshotError = legacyError('screenshot-desktop', 'The default path uses the D-5 service for capture + overlay + hashes.');
        _screenshotError.cause = e;
        throw _screenshotError;
    }
}
async function _getKey(keyName) {
    const fallbackMap = {
        ctrl: 'LeftControl', cmd: 'LeftSuper', alt: 'LeftAlt', shift: 'LeftShift',
        enter: 'Enter', tab: 'Tab', space: 'Space', backspace: 'Backspace',
        delete: 'Delete', esc: 'Escape',
        f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', f5: 'F5',
        f6: 'F6', f7: 'F7', f8: 'F8', f9: 'F9', f10: 'F10',
        f11: 'F11', f12: 'F12',
        a: 'A', c: 'C', v: 'V', z: 'Z',
    };
    const name = keyName.toLowerCase();
    try {
        const nj = await _getNutJS();
        // fallbackMap 的值是 nut-js 枚举成员名（PascalCase）—— 必须经 nj.Key 再索引
        // 取枚举值；直接回传字符串名，pressKey 收到的是非法键（legacy 热键全灭的隐形根因）
        return nj.Key[name] ?? nj.Key[fallbackMap[name]] ?? keyName;
    }
    catch {
        return fallbackMap[name] ?? keyName;
    }
}
// ─── 模块级状态（保持原有可变模式 —— 插件单例）───
let dryRun = false;
let windowDelegate = null;
// ─── P1-3（地基速修）：系统级热键黑名单 ───
// Alt+F4 关窗、Meta/Win 唤起系统壳层、Ctrl+Alt+Delete —— 这些和弦不是「在应用内
// 操作」，而是把动作射向 OS 壳层/会话管理器：逃逸出纯视觉闭环的验证范围
//（点了之后桌面发生了什么，模型看不见也验证不了），且多数不可逆。执法点放在
// system.pressHotkey（全部热键调用方的唯一漏斗：工具层/shaper/autonomy/replay），
// 拒绝 = 直接 throw（与「白名单外的键名被拒绝」同方言，由各调用方 catch 降级）。
/** config.hotkeyBlacklist 缺省镜像：schema 不可载时的降级值（单一事实源仍是 config.ts） */
const FALLBACK_HOTKEY_BLACKLIST = 'alt+f4,meta,meta+l,meta+r,meta+d,win,cmd+q,ctrl+alt+delete';
/** 缺省黑名单：单一事实源是 config schema 声明的 hotkeyBlacklist 缺省 */
let hotkeyBlacklistCsv = (() => {
    try {
        const v = ConfigSchema({}).hotkeyBlacklist;
        return typeof v === 'string' ? v : FALLBACK_HOTKEY_BLACKLIST;
    }
    catch {
        return FALLBACK_HOTKEY_BLACKLIST; // schema 调用失败：降级镜像值，绝不阻断装载
    }
})();
/** P1-3 拒绝标记（工具层据此区分黑名单拦截与白名单拒绝/底层故障） */
export const HOTKEY_BLACKLIST_MARKER = '[SYSTEM_HOTKEY_BLOCKED]';
/** 键名等价归一表：win/meta/cmd/cmdsuper/super 同指 OS 壳层修饰键；长名折叠为白名单短名 */
const HOTKEY_ALIASES = {
    win: 'meta', meta: 'meta', cmd: 'meta', command: 'meta', super: 'meta', cmdsuper: 'meta',
    escape: 'esc', control: 'ctrl', del: 'delete', return: 'enter',
};
/** 单键归一：小写 + 去空白 + 别名折叠（'Win'/'CMD'/'Escape' → 'meta'/'meta'/'esc'） */
function normalizeHotkeyKey(k) {
    const n = String(k ?? '').trim().toLowerCase();
    return HOTKEY_ALIASES[n] ?? n;
}
/**
 * 黑名单命中裁决（纯函数，测试直测）：命中返回触发的黑名单条目原文，未命中返回 null。
 * 两条判定律（与 config.hotkeyBlacklist 描述一致）：
 *   1) 和弦整体归一（小写+别名折叠+排序无关）后与含 '+' 的条目全等 —— 如 'alt+f4'；
 *   2) 和弦包含任一单键条目 —— 如 'meta'/'win'（任何含 OS 壳层修饰键的组合都拒）。
 * 空黑名单（空串/全空白条目）= 全放行（部署明示不设防）。
 */
export function hotkeyBlacklistHit(keys, blacklistCsv) {
    const csv = String(blacklistCsv ?? '').trim();
    if (!csv)
        return null; // 空黑名单 = 全放行
    const normKeys = (Array.isArray(keys) ? keys : []).map(normalizeHotkeyKey).filter(Boolean);
    const chordSig = [...normKeys].sort().join('+');
    const keySet = new Set(normKeys);
    for (const raw of csv.split(',')) {
        const entry = raw.trim().toLowerCase();
        if (!entry)
            continue;
        if (entry.includes('+')) {
            // 整体和弦条目：同律归一后全等比较（'cmd+q' 与 ['meta','Q'] 命中）
            const sig = entry.split('+').map(normalizeHotkeyKey).filter(Boolean).sort().join('+');
            if (sig && sig === chordSig)
                return raw.trim();
        }
        else {
            // 单键条目：和弦含此键即拒（'meta' ⇒ ['ctrl','shift','meta'] 也拒）
            const single = normalizeHotkeyKey(entry);
            if (single && keySet.has(single))
                return raw.trim();
        }
    }
    return null;
}
/** 程序化判别：这次 pressHotkey 失败是不是黑名单拦截（工具层据此给出针对性 next_step） */
export function isHotkeyBlacklistError(e) {
    return e instanceof Error && e.message.includes(HOTKEY_BLACKLIST_MARKER);
}
function guardDryRun(action, detail) {
    if (!dryRun)
        return false;
    console.log(`[dry-run] ${action}`, detail);
    return true;
}
export const system = {
    /** 应用插件配置；D-5 路径下仅 dryRun 生效（服务端无鼠标速度概念） */
    async configure(config) {
        dryRun = config.dryRun;
        // P1-3：热键黑名单随配置接线（cordis.yml 的 hotkeyBlacklist 直达执法点）
        if (typeof config.hotkeyBlacklist === 'string')
            hotkeyBlacklistCsv = config.hotkeyBlacklist;
        if (forceLegacy()) {
            try {
                const nj = await _getNutJS();
                if (nj.mouse?.config?.mouseSpeed != null) {
                    nj.mouse.config.mouseSpeed = config.mouseSpeed;
                }
            }
            catch { /* 无 nut-js：静默跳过，执行时会给出清晰错误 */ }
        }
    },
    /** 屏幕截图（纯净 PNG，无叠加层）—— OCR/记忆预验等下游消费 */
    async captureScreen() {
        if (forceLegacy()) {
            const fn = await _getScreenshotFn();
            return await fn();
        }
        return backend.captureCleanPng();
    },
    /**
     * 处理截图（D-5 默认路径主入口）：服务端一次往返完成
     * SoM 叠加（网格/准星/元素框）+ 缩放 + JPEG 编码 + 指纹 + 变化门控。
     */
    async captureScreenWithOverlay(opts = {}) {
        return backend.captureProcessed(opts);
    },
    /** 屏幕尺寸 */
    async getScreenSize() {
        if (forceLegacy()) {
            const nj = await _getNutJS();
            return {
                width: typeof nj.screen.width === 'function' ? await nj.screen.width() : nj.screen.width,
                height: typeof nj.screen.height === 'function' ? await nj.screen.height() : nj.screen.height,
            };
        }
        return backend.getScreenSize();
    },
    async getMousePosition() {
        if (forceLegacy()) {
            const nj = await _getNutJS();
            return await nj.mouse.getPosition();
        }
        // 像素域（与旧 nut-js 语义一致 —— crosshair/多屏感知的调用方都按像素消费）
        return backend.getCursor();
    },
    async getAllDisplays() {
        if (forceLegacy()) {
            const nj = await _getNutJS();
            const raw = await nj.screen.getAllDisplays();
            return raw.map((d) => ({
                name: d.name ?? `Display@${d.x},${d.y}`,
                x: d.x, y: d.y, width: d.width, height: d.height,
            }));
        }
        const displays = await backend.getDisplays();
        return displays.map(d => ({
            name: d.name, x: d.x, y: d.y, width: d.width, height: d.height,
        }));
    },
    async getActiveDisplay() {
        const [pos, displays] = await Promise.all([this.getMousePosition(), this.getAllDisplays()]);
        // pos 与 displays 均为像素域（与旧 nut-js 语义一致）
        return displays.find(d => pos.x >= d.x && pos.x <= d.x + d.width &&
            pos.y >= d.y && pos.y <= d.y + d.height) ?? displays[0];
    },
    async clickMouse(x, y, button = 'left') {
        if (guardDryRun('clickMouse', { x, y, button }))
            return;
        if (forceLegacy()) {
            const [nj, btn] = await Promise.all([_getNutJS(), _getButton(button)]);
            if (!btn)
                throw new Error(`Unknown mouse button: ${button}`);
            await serialize(async () => {
                await nj.mouse.move([{ x, y }]);
                await nj.mouse.click(btn);
            });
            return;
        }
        // 像素 → 归一化（D-5 契约域）；越界夹取防微浮点溢出
        const size = await backend.getScreenSize();
        const nx = Math.min(1, Math.max(0, x / size.width));
        const ny = Math.min(1, Math.max(0, y / size.height));
        // D-1 物理躯体公理：动作派发入互斥队列（legacy 路径与 typeText/drag 同律；
        // pressHotkey 例外 —— shaper 的 set_zoom 在 serialize 内复用本管线，嵌套即死锁）
        await serialize(() => backend.clickMouse(nx, ny, button, dryRun));
    },
    /**
     * 移动鼠标（无点击）—— Z-1 交互性探针的悬停动作。
     * 零破坏语义：绝不按下；探针调用方负责 dwell 观察与位置复位。
     */
    async moveMouse(x, y, durationMs = 0) {
        if (guardDryRun('moveMouse', { x, y }))
            return;
        if (forceLegacy()) {
            const nj = await _getNutJS();
            await serialize(() => nj.mouse.move([{ x, y }]));
            return;
        }
        const size = await backend.getScreenSize();
        const nx = Math.min(1, Math.max(0, x / size.width));
        const ny = Math.min(1, Math.max(0, y / size.height));
        await serialize(() => backend.moveMouse(nx, ny, durationMs, dryRun));
    },
    async typeText(text, clearFirst = false) {
        if (guardDryRun('typeText', { text: text.substring(0, 30), clearFirst }))
            return;
        if (forceLegacy()) {
            const nj = await _getNutJS();
            const isMac = process.platform === 'darwin';
            const modKey = await _getKey(isMac ? 'cmd' : 'ctrl');
            const keyA = await _getKey('a');
            const keyBack = await _getKey('backspace');
            await serialize(async () => {
                if (clearFirst) {
                    await nj.keyboard.pressKey(modKey, keyA);
                    await nj.keyboard.releaseKey(modKey, keyA);
                    await nj.keyboard.pressKey(keyBack);
                    await nj.keyboard.releaseKey(keyBack);
                }
                await nj.keyboard.type(text);
            });
            return;
        }
        await serialize(() => backend.typeText(text, clearFirst, dryRun));
    },
    async dragMouse(start, end) {
        if (guardDryRun('dragMouse', { start, end }))
            return;
        if (forceLegacy()) {
            const [nj, btnLeft] = await Promise.all([_getNutJS(), _getButton('left')]);
            await serialize(async () => {
                await nj.mouse.move([{ x: start.x, y: start.y }]);
                await nj.mouse.pressButton(btnLeft);
                await nj.mouse.move([{ x: end.x, y: end.y }]);
                await nj.mouse.releaseButton(btnLeft);
            });
            return;
        }
        // 像素 → 归一化（D-5 契约域）
        const size = await backend.getScreenSize();
        const clamp01 = (v, max) => Math.min(1, Math.max(0, v / max));
        await serialize(() => backend.dragMouse({ x: clamp01(start.x, size.width), y: clamp01(start.y, size.height) }, { x: clamp01(end.x, size.width), y: clamp01(end.y, size.height) }, dryRun));
    },
    async scroll(direction, amount) {
        if (guardDryRun('scroll', { direction, amount }))
            return;
        if (forceLegacy()) {
            const nj = await _getNutJS();
            await serialize(async () => {
                switch (direction) {
                    case 'up':
                        await nj.mouse.scrollUp(amount);
                        break;
                    case 'down':
                        await nj.mouse.scrollDown(amount);
                        break;
                    case 'left':
                        await nj.mouse.scrollLeft(amount);
                        break;
                    case 'right':
                        await nj.mouse.scrollRight(amount);
                        break;
                }
            });
            return;
        }
        await serialize(() => backend.scrollPage(direction, amount, dryRun));
    },
    async pressHotkey(keys) {
        // P1-3：dryRun 照旧只记录（不执行 = 无拦截必要；提示词调试要能看到完整热键轨迹）
        if (guardDryRun('pressHotkey', { keys }))
            return;
        // P1-3：系统级热键黑名单执法 —— 归一和弦命中条目 / 含黑名单单键 ⇒ 拒绝。
        // 在 legacy 与 D-5 两条路径之前拦截（逃逸动作哪条躯体都不许碰）
        const hit = hotkeyBlacklistHit(keys, hotkeyBlacklistCsv);
        if (hit !== null) {
            throw new Error(`${HOTKEY_BLACKLIST_MARKER} 系统级热键被黑名单拦截: chord "${keys.join('+')}" ` +
                `hits blacklist entry "${hit}" — system-level hotkeys (window close / OS shell) are ` +
                `rejected outright; use regular channels (click UI controls / switch_window / open_url)`);
        }
        if (forceLegacy()) {
            const [nj, ...mapped] = await Promise.all([
                _getNutJS(),
                ...keys.map(k => _getKey(k)),
            ]);
            if (mapped.some(m => m == null)) {
                throw new Error(`Unrecognized key names in combination: [${keys.join(', ')}]`);
            }
            await serialize(async () => {
                await nj.keyboard.pressKey(...mapped);
                await nj.keyboard.releaseKey(...mapped);
            });
            return;
        }
        await backend.pressHotkey(keys, dryRun);
    },
    setWindowDelegate(fn) {
        windowDelegate = fn;
    },
    async switchWindowByTitle(keyword) {
        // Y6 通道仲裁修正：原生 python 后端优先，D-2 委托降为后备。
        // 旧实现委托一经注入即独占 —— 而 raise_window 委托（PowerShell）无标题
        // 回执（focus_handoff 取证因此永远缺席）、无本地化别名、失败时不给可用
        // 窗口清单。原生路径（pygetwindow）三样俱全。委托保留给"无 python 后端"
        // 的环境 —— 那才是 D-2 设计它的场景。
        const ABSENCE = /window_unavailable|spawn_failed|startup_timeout|adapter unavailable|ECONNREFUSED/;
        if (!forceLegacy()) {
            try {
                const r = await backend.switchWindow(keyword);
                if (r.method !== 'hotkey_only') {
                    return { method: r.method, matched: r.matched ?? null };
                }
            }
            catch (e) {
                // 后端缺席（无 python 服务/窗口后端不可用）→ 委托接管；
                // element_not_found 是真实未命中 → 如实上抛（错误里带可用窗口清单）。
                if (!ABSENCE.test(String(e?.message ?? '')))
                    throw e;
            }
        }
        if (windowDelegate) {
            const r = await windowDelegate(keyword);
            // 委托方言无标题回执时 matched=null —— 取证降级到工具层 OCR 路径
            return { method: 'delegate', matched: r?.matched ?? null };
        }
        if (forceLegacy()) {
            throw new Error('Window management is not available in this environment. ' +
                'Install a window-management provider, or switch windows via the press_hotkey tool.');
        }
        throw new Error('native window switch unavailable; use press_hotkey alt+tab');
    },
    /**
     * 用操作系统默认浏览器打开 URL（AA-1 世界跳转引擎的躯体）。
     *
     * 壳层动作，非屏幕交互 —— 不经 D-5 物理微服务（那里是键鼠/截图的躯体），
     * 直接调用平台 opener：win=cmd start / darwin=open / linux=xdg-open。
     * 调用方（open_url 工具）负责 URL 安检（scheme 白名单）；本层只管
     * 忠实把已安检的 URL 交给壳层并报告启动方式。fire-and-forget：浏览器
     * 的启动成败由世界回击（take_screenshot / switch_window）验证，本层
     * 不伪造「已打开」。
     */
    async openUrl(url) {
        if (guardDryRun('openUrl', { url }))
            return { method: 'dry-run' };
        const { spawn } = await import('child_process');
        // fire-and-forget 的另一半：spawn 失败（ENOENT/EACCES，如缺失 xdg-open）经
        // 异步 'error' 事件到达 —— 无监听即 uncaught exception 炸宿主进程。启动成败
        // 本就由世界回击验证（见 JSDoc），此处只封崩溃面
        if (process.platform === 'win32') {
            // windowsVerbatimArguments：URL 由本层手工加引号 —— Node 默认的 argv
            // 引用只在含空格时触发，`&`（查询参数常态）裸露会被 cmd 当命令分隔符
            const quoted = `"${url.replace(/"/g, '')}"`;
            const child = spawn('cmd.exe', ['/c', 'start', '""', quoted], {
                detached: true, stdio: 'ignore',
                windowsVerbatimArguments: true,
            });
            child.on('error', () => { });
            child.unref();
            return { method: 'shell:start' };
        }
        if (process.platform === 'darwin') {
            const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
            child.on('error', () => { });
            child.unref();
            return { method: 'open' };
        }
        const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
        child.on('error', () => { });
        child.unref();
        return { method: 'xdg-open' };
    },
};
async function _getButton(button) {
    const fallbackMap = {
        left: 'LEFT', right: 'RIGHT', middle: 'MIDDLE',
    };
    try {
        const nj = await _getNutJS();
        // 同 _getKey：fallbackMap 的值须再经 nj.Button 索引取枚举值，不能回传字符串名
        return nj.Button[button] ?? nj.Button[fallbackMap[button]] ?? fallbackMap[button];
    }
    catch {
        return fallbackMap[button] ?? button;
    }
}
