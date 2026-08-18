// src/tools/clickElement.ts
// ID 寻址协议：take_screenshot 发 ID，本工具用 ID —— 两工具间的引用机制（语言级指针）。
// 修复原版 ID 漂移缺陷：从 uiExtractor 的短时缓存读取，而非重新提取导致 ID 全变。
// 精华保留：几何中心点击 —— 不信任元素边缘，永远点最稳的质心。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { system } from '../system';
import { extractInteractiveElements } from '../uiExtractor';

export function createClickElementTool() {
  return defineTool({
    name: 'click_element',
    description: 'Clicks a UI element by its ID. The ID is obtained from the take_screenshot tool output.',
    parameters: {
      id: {
        type: 'number',
        required: true,
        description: 'The ID of the UI element to click (e.g., 5 for element [5]).',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        // 缓存窗口内命中：ID 与最近一次 take_screenshot 报告的完全一致
        const elements = await extractInteractiveElements();
        const target = elements.find(el => el.id === args.id);

        if (!target) {
          return `[Error]: Element [${args.id}] not found. Call 'take_screenshot' to refresh the element list.`;
        }

        // 几何中心点击：元素 rect 中心即最稳的质心
        const centerX = target.rect.x + target.rect.width / 2;
        const centerY = target.rect.y + target.rect.height / 2;

        await system.clickMouse(Math.round(centerX), Math.round(centerY), 'left');
        return `[System]: Clicked [${target.id}] [${target.role}] "${target.name}". ` +
          `[Next Step]: Call 'take_screenshot' to verify.`;
      } catch (error: any) {
        return `[Error]: Element click failed. ${error.message}`;
      }
    },
  });
}
