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
        return nj.Key[name] ?? fallbackMap[name] ?? keyName;
    }
    catch {
        return fallbackMap[name] ?? keyName;
    }
}
// ─── 模块级状态（保持原有可变模式 —— 插件单例）───
let dryRun = false;
let windowDelegate = null;
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
        await backend.clickMouse(nx, ny, button, dryRun);
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
        await backend.scrollPage(direction, amount, dryRun);
    },
    async pressHotkey(keys) {
        if (guardDryRun('pressHotkey', { keys }))
            return;
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
};
async function _getButton(button) {
    const fallbackMap = {
        left: 'LEFT', right: 'RIGHT', middle: 'MIDDLE',
    };
    try {
        const nj = await _getNutJS();
        return nj.Button[button] ?? fallbackMap[button];
    }
    catch {
        return fallbackMap[button] ?? button;
    }
}
