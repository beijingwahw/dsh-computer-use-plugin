// src/tools/dragMouse.ts
// 四拍时序（移->按->移->放）下沉 system.dragMouse；本层负责校验与换算锚点。
// 修复原版：Button 未导入的编译错误；四个坐标各自独立校验与换算。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { system } from '../system';

export function createDragMouseTool() {
  return defineTool({
    name: 'drag_mouse',
    description:
      'Clicks and holds the mouse at a starting point, drags to an ending point, and releases. ' +
      'Used for moving files, resizing windows, or dragging sliders.',
    parameters: {
      startX: { type: 'number', required: true, description: 'Start X coordinate (0.0 to 1.0).' },
      startY: { type: 'number', required: true, description: 'Start Y coordinate (0.0 to 1.0).' },
      endX: { type: 'number', required: true, description: 'End X coordinate (0.0 to 1.0).' },
      endY: { type: 'number', required: true, description: 'End Y coordinate (0.0 to 1.0).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const { startX, startY, endX, endY } = args;

      if (startX < 0 || startX > 1 || startY < 0 || startY > 1 ||
          endX < 0 || endX > 1 || endY < 0 || endY > 1) {
        return `[Error]: Invalid drag coordinates. All four values must be between 0.0 and 1.0.`;
      }

      try {
        const size = await system.getScreenSize();
        const startPixel = { x: Math.round(startX * size.width), y: Math.round(startY * size.height) };
        const endPixel = { x: Math.round(endX * size.width), y: Math.round(endY * size.height) };

        await system.dragMouse(startPixel, endPixel);

        return JSON.stringify({
          status: 'SUCCESS',
          action: 'Mouse dragged.',
          state_anchor: {
            normalized: { start: { x: startX, y: startY }, end: { x: endX, y: endY } },
            absolute_pixels: { start: startPixel, end: endPixel },
            screen_resolution: `${size.width}x${size.height}`,
          },
          next_step: "MANDATORY: Call 'take_screenshot' to verify the drag result.",
        }, null, 2);

      } catch (error: any) {
        return `[Error]: Drag operation failed. ${error.message}`;
      }
    },
  });
}
