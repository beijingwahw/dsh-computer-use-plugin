// src/tools/switchTab.ts
// 修复原版两 bug：defineTool 未导入、direction 参数被解析后丢弃。
// 用 ctrl+tab / ctrl+shift+tab：Mac 浏览器同样接受 ctrl 系标签切换，规避 cmd+tab 的 OS 语义。
// B-4：返回值统一走 toolResult 工厂（反幻觉锚点全覆盖）。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { system } from '../system.js';
import { toolOk, toolErr } from '../toolResult.js';
export const switchTabTool = defineTool({
    name: 'switch_tab',
    description: 'Switches to the next or previous browser tab. Useful for multitasking within the browser.',
    parameters: {
        direction: {
            type: 'string',
            required: true,
            description: 'Direction to switch tabs. Options: "next", "previous".',
        },
    },
    output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
        const { direction } = args;
        if (direction !== 'next' && direction !== 'previous') {
            return toolErr('Tab switch validation failed.', 'Invalid direction.', 'Retry with direction "next" or "previous".');
        }
        try {
            // 平台分叉在 system 层抽象；方向真正参与按键组合（原版丢弃了此参数）
            await system.pressHotkey(direction === 'next' ? ['ctrl', 'tab'] : ['ctrl', 'shift', 'tab']);
            return toolOk(`Switched to the ${direction} tab.`, { direction, shortcut: direction === 'next' ? 'ctrl+tab' : 'ctrl+shift+tab' }, "Call 'take_screenshot' to verify the new tab content matches your expectation.");
        }
        catch (error) {
            return toolErr(`Tab switch (${direction}) failed.`, error.message, "The browser may not be focused. Click inside the browser area first, or retry after 'take_screenshot'.");
        }
    },
});
