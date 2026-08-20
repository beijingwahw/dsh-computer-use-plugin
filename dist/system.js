import { serialize } from './ioMutex.js';
export { serialize };
// ─── 迁移常量：错误消息集中管理，保证所有路径给出一致指引 ───
const MIGRATION_NOTICE = 'Legacy native dependency (@nut-tree/nut-js / screenshot-desktop / sharp / tesseract.js) ' +
    'removed in batch E. Use the D-7 default execution path (KnowledgePipelineOrchestrator → ' +
    'StubExecutionStation → D7PhysicalHostPort → D-5 Python microservice) instead. If you must ' +
    'use the old D-1 tools layer, reinstall the 4 removed packages and set ' +
    'DSH_FORCE_LEGACY_SYSTEM=1 as environment variable.';
function legacyError(dep, extraHint) {
    const envOk = process.env.DSH_FORCE_LEGACY_SYSTEM === '1';
    if (envOk) {
        return new Error(`[system.ts] Lazy import of '${dep}' failed (it's not installed). ` +
            `DSH_FORCE_LEGACY_SYSTEM=1 is set but package is absent. Install it via npm.`);
    }
    return new Error(`[system.ts] '${dep}' is removed (batch-E migration). ${MIGRATION_NOTICE}` +
        (extraHint ? ` Hint: ${extraHint}` : ''));
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
        throw _nutJSError;
    }
}
// ─── 懒加载辅助：screenshot-desktop ───
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
        _screenshotError = legacyError('screenshot-desktop', 'Use D-5 adapter.takeScreenshotHandle() for screenshots (mmap-file zero-copy transport).');
        throw _screenshotError;
    }
}
// ─── 键位白名单 / 按钮翻译：动态从 nut-js Key / Button 取枚举，缺省回退字符串字面量 ───
async function _getKey(keyName) {
    const fallbackMap = {
        ctrl: 'LeftControl', cmd: 'LeftSuper', alt: 'LeftAlt', shift: 'LeftShift',
        enter: 'Enter', tab: 'Tab', space: 'Space', backspace: 'Backspace',
        delete: 'Delete', esc: 'Escape',
        f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', f5: 'F5',
        f11: 'F11', f12: 'F12',
        a: 'A', c: 'C', v: 'V', z: 'Z',
    };
    const name = keyName.toLowerCase();
    try {
        const nj = await _getNutJS();
        // NutJs Key 枚举
        return nj.Key[name] ?? fallbackMap[name] ?? keyName;
    }
    catch {
        return fallbackMap[name] ?? keyName;
    }
}
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
    /** 应用插件配置 —— 兼容老调用；无 nut-js 时仅设置 dryRun，不抛错 */
    async configure(config) {
        dryRun = config.dryRun;
        try {
            const nj = await _getNutJS();
            if (nj.mouse?.config?.mouseSpeed != null) {
                nj.mouse.config.mouseSpeed = config.mouseSpeed;
            }
        }
        catch { /* 无 nut-js：静默跳过，执行时会给出清晰错误 */ }
    },
    /** 屏幕截图 —— 优先 screenshot-desktop，失败给迁移指引 */
    async captureScreen() {
        const fn = await _getScreenshotFn();
        return await fn();
    },
    /** 屏幕尺寸 —— 无 nut-js 时给出清晰错误 */
    async getScreenSize() {
        const nj = await _getNutJS();
        return {
            width: typeof nj.screen.width === 'function' ? await nj.screen.width() : nj.screen.width,
            height: typeof nj.screen.height === 'function' ? await nj.screen.height() : nj.screen.height,
        };
    },
    async getMousePosition() {
        const nj = await _getNutJS();
        return await nj.mouse.getPosition();
    },
    async getAllDisplays() {
        const nj = await _getNutJS();
        const raw = await nj.screen.getAllDisplays();
        return raw.map((d) => ({
            name: d.name ?? `Display@${d.x},${d.y}`,
            x: d.x, y: d.y, width: d.width, height: d.height,
        }));
    },
    async getActiveDisplay() {
        const [pos, displays] = await Promise.all([this.getMousePosition(), this.getAllDisplays()]);
        return displays.find(d => pos.x >= d.x && pos.x <= d.x + d.width &&
            pos.y >= d.y && pos.y <= d.y + d.height) ?? displays[0];
    },
    async clickMouse(x, y, button = 'left') {
        if (guardDryRun('clickMouse', { x, y, button }))
            return;
        const [nj, btn] = await Promise.all([_getNutJS(), _getButton(button)]);
        if (!btn)
            throw new Error(`Unknown mouse button: ${button}`);
        await serialize(async () => {
            await nj.mouse.move([{ x, y }]);
            await nj.mouse.click(btn);
        });
    },
    async typeText(text, clearFirst = false) {
        if (guardDryRun('typeText', { text: text.substring(0, 30), clearFirst }))
            return;
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
    },
    async dragMouse(start, end) {
        if (guardDryRun('dragMouse', { start, end }))
            return;
        const [nj, btnLeft] = await Promise.all([_getNutJS(), _getButton('left')]);
        await serialize(async () => {
            await nj.mouse.move([{ x: start.x, y: start.y }]);
            await nj.mouse.pressButton(btnLeft);
            await nj.mouse.move([{ x: end.x, y: end.y }]);
            await nj.mouse.releaseButton(btnLeft);
        });
    },
    async scroll(direction, amount) {
        if (guardDryRun('scroll', { direction, amount }))
            return;
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
    },
    async pressHotkey(keys) {
        if (guardDryRun('pressHotkey', { keys }))
            return;
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
    },
    setWindowDelegate(fn) {
        windowDelegate = fn;
    },
    async switchWindowByTitle(keyword) {
        if (windowDelegate)
            return await windowDelegate(keyword);
        throw new Error('Window management is not available in this environment. ' +
            'Install a window-management provider, or switch windows via the press_hotkey tool.');
    },
};
