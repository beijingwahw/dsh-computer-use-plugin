// src/tools/clickElement.ts
// ID 寻址协议：take_screenshot 发 ID，本工具用 ID —— 两工具间的引用机制（语言级指针）。
// 修复原版 ID 漂移缺陷：从 uiExtractor 的短时缓存读取，而非重新提取导致 ID 全变。
// 精华保留：几何中心点击 —— 不信任元素边缘，永远点最稳的质心。
// B-4：返回值统一走 toolResult 工厂（反幻觉锚点全覆盖）。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { system } from '../system';
import { extractInteractiveElements } from '../uiExtractor';
import { toolOk, toolErr } from '../toolResult';

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
          return toolErr(
            `Element [${args.id}] click failed.`,
            'Element ID not found in the current cache.',
            "The element cache may be stale. Call 'take_screenshot' to refresh element IDs, then retry.",
          );
        }

        // 几何中心点击：元素 rect 中心即最稳的质心
        const centerX = target.rect.x + target.rect.width / 2;
        const centerY = target.rect.y + target.rect.height / 2;

        await system.clickMouse(Math.round(centerX), Math.round(centerY), 'left');
        return toolOk(
          `Clicked [${target.id}] [${target.role}] "${target.name}".`,
          {
            element_id: target.id,
            role: target.role,
            name: target.name,
            clicked_center_px: { x: Math.round(centerX), y: Math.round(centerY) },
          },
          "Call 'take_screenshot' to verify the interaction took effect.",
        );
      } catch (error: any) {
        return toolErr(`Element [${args.id}] click failed.`, error.message,
          "Call 'take_screenshot' to refresh the element list and retry, or fall back to 'click_mouse' with visual coordinates.");
      }
    },
  });
}
