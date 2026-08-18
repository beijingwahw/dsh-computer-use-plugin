// src/guards/boundsGuard.ts
// 坐标边界守卫。按工具名单精准拦截（防线按威胁形状裁剪）；
// 拦截消息本身就是教学 —— 拒绝的同时指出改正方向。
// 融合修复：原版对 drag_mouse 解构 {x,y} 导致校验形同虚设 -> 按 drag 的真实参数校验。
import type { Context } from '@deepseek-ai/cordis';
import { onToolPre } from './hooks';

const isNormalized = (v: any): boolean =>
  typeof v === 'number' && v >= 0 && v <= 1;

export function registerBoundsGuard(ctx: Context): void {
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
