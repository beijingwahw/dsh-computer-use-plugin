import { onToolPre } from './hooks.js';
const isNormalized = (v) => typeof v === 'number' && v >= 0 && v <= 1;
/**
 * 归一化 x/y 坐标的执法名单（防线按威胁形状统一：所有派发坐标的工具同一律）。
 * - 必填组：坐标缺失/非法即拦截（NaN 会通过一切比较，必须显式 typeof 判定）
 * - 可选组（read_text 的区域中心）：在场才校验，缺席不拦（缺省全屏是合法形态）
 */
const XY_TOOLS_REQUIRED = new Set([
    'click_mouse', 'probe_interactivity', 'remember_ui', 'zoom_inspect',
]);
const XY_TOOLS_OPTIONAL = new Set(['read_text', 'find_text']);
export function registerBoundsGuard(ctx) {
    onToolPre(ctx, async (toolCall, next) => {
        const { name, args } = toolCall;
        if (name === 'drag_mouse') {
            const { startX, startY, endX, endY } = args;
            const invalid = [startX, startY, endX, endY].find(v => !isNormalized(v));
            if (invalid !== undefined) {
                return `[Guard Blocked]: Invalid drag coordinates (start: ${startX},${startY} end: ${endX},${endY}). ` +
                    `All four values must be normalized between 0.0 and 1.0.`;
            }
        }
        const xyRequired = XY_TOOLS_REQUIRED.has(name);
        if (xyRequired || XY_TOOLS_OPTIONAL.has(name)) {
            const { x, y } = args;
            const xPresent = x !== undefined && x !== null;
            const yPresent = y !== undefined && y !== null;
            // 可选坐标的成对律：只给一半 = 区域中心残缺，同样拦截（诚实拒绝优于猜测意图）
            if ((xyRequired || xPresent || yPresent) && (!isNormalized(x) || !isNormalized(y))) {
                return `[Guard Blocked]: Invalid coordinates detected (x: ${args.x}, y: ${args.y}). ` +
                    `Coordinates must be normalized between 0.0 and 1.0 (inclusive). Please re-evaluate the screen grid.`;
            }
        }
        // 校验通过，放行给下一个拦截器或实际执行
        return next();
    });
}
