// src/tools/clickMouse.ts
// 锚点定型版：三组坐标形成换算可验证三元组（normalized / absolute_pixels / resolution），
// 模型每次点击都看到一次换算实例 —— 反馈即教学。MANDATORY 大写：验证从建议升级为指令。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { system } from '../system';

export function createClickMouseTool() {
  return defineTool({
    name: 'click_mouse',
    description: 'Clicks the mouse at normalized coordinates (0.0 to 1.0).',
    parameters: {
      x: { type: 'number', required: true, description: 'X coordinate (0.0-1.0)' },
      y: { type: 'number', required: true, description: 'Y coordinate (0.0-1.0)' },
      button: { type: 'string', required: false, description: 'left, right, or middle' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const { x, y, button = 'left' } = args;

      // 双保险校验（Guard 已在前线，工具自查兜底）
      if (x < 0 || x > 1 || y < 0 || y > 1) {
        return `[Error]: Invalid normalized coordinates. X and Y must be between 0.0 and 1.0.`;
      }

      try {
        // 动态获取真实分辨率（修复原版幽灵方法 getScreenSize）
        const size = await system.getScreenSize();
        const px = Math.round(x * size.width);
        const py = Math.round(y * size.height);

        await system.clickMouse(px, py, button);

        return JSON.stringify({
          status: 'SUCCESS',
          action: `Mouse ${button} clicked.`,
          state_anchor: {
            normalized: { x, y },
            absolute_pixels: { x: px, y: py },
            screen_resolution: `${size.width}x${size.height}`,
          },
          next_step: "MANDATORY: Call 'take_screenshot' immediately to verify the UI state change.",
        }, null, 2);

      } catch (error: any) {
        return JSON.stringify({
          status: 'FAILED',
          error: error.message,
          next_step: 'Analyze the error and try a different approach or re-evaluate the screen.',
        }, null, 2);
      }
    },
  });
}
