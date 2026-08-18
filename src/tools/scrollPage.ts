// src/tools/scrollPage.ts
// dirMap 一石二鸟：合法值枚举 + 方向翻译表，!dirMap[direction] 一行完成校验。
// 修复原版「四方向全部 scrollDown」bug；滚动结果不可见 -> 回显自带复查指令。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { system } from '../system';

export function createScrollPageTool() {
  return defineTool({
    name: 'scroll_page',
    description:
      'Scrolls the page up/down/left/right to reveal hidden content. ' +
      'Use this when the target UI element is not currently visible on the screen.',
    parameters: {
      direction: {
        type: 'string',
        required: true,
        description: 'The scroll direction. Options: "up", "down", "left", "right".',
      },
      amount: {
        type: 'number',
        required: false,
        description: 'The scroll distance (number of scroll lines). Defaults to 5.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const { direction, amount = 5 } = args;
      const dirMap: Record<string, 'up' | 'down' | 'left' | 'right'> = {
        up: 'up', down: 'down', left: 'left', right: 'right',
      };

      if (!dirMap[direction]) {
        return `[Error]: Invalid scroll direction. Options: up, down, left, right.`;
      }

      try {
        await system.scroll(dirMap[direction], amount);
        return `[System]: Scrolled '${direction}' by ${amount} lines. ` +
          `[Next Step]: Call 'take_screenshot' to check if the target element is now visible.`;
      } catch (error: any) {
        return `[Error]: Scroll failed. ${error.message}`;
      }
    },
  });
}
