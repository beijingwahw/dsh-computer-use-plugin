// src/tools/switchTab.ts
// 修复原版两 bug：defineTool 未导入、direction 参数被解析后丢弃。
// 用 ctrl+tab / ctrl+shift+tab：Mac 浏览器同样接受 ctrl 系标签切换，规避 cmd+tab 的 OS 语义。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { system } from '../system';

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
      return `[Error]: Invalid direction. Options: "next", "previous".`;
    }

    try {
      // 平台分叉在 system 层抽象；方向真正参与按键组合（原版丢弃了此参数）
      await system.pressHotkey(direction === 'next' ? ['ctrl', 'tab'] : ['ctrl', 'shift', 'tab']);
      return `[System]: Switched to the ${direction} tab. ` +
        `[Next Step]: Call 'take_screenshot' to verify the new tab content.`;
    } catch (error: any) {
      return `[Error]: Tab switching failed. ${error.message}`;
    }
  },
});
