import { onToolPre } from './hooks.js';
const isNormalized = (v) => typeof v === 'number' && v >= 0 && v <= 1;
export function registerBoundsGuard(ctx) {
    onToolPre(ctx, async (toolCall, next) => {
        const { name, args } = toolCall;
        if (name === 'click_mouse') {
            const { x, y } = args;
            if (!isNormalized(x) || !isNormalized(y)) {
                return `[Guard Blocked]: Invalid coordinates detected (x: ${args.x}, y: ${args.y}). ` +
                    `Coordinates must be strictly between 0.0 and 1.0. Please re-evaluate the screen grid.`;
            }
        }
        if (name === 'drag_mouse') {
            const { startX, startY, endX, endY } = args;
            const invalid = [startX, startY, endX, endY].find(v => !isNormalized(v));
            if (invalid !== undefined) {
                return `[Guard Blocked]: Invalid drag coordinates (start: ${startX},${startY} end: ${endX},${endY}). ` +
                    `All four values must be normalized between 0.0 and 1.0.`;
            }
        }
        // 校验通过，放行给下一个拦截器或实际执行
        return next();
    });
}
