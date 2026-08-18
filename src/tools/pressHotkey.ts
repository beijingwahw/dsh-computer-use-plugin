// src/tools/pressHotkey.ts
// 薄委托层：白名单、数量对账、对称时序全部下沉 system.pressHotkey，工具层只做锚点。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { system } from '../system';

export function createPressHotkeyTool() {
  return defineTool({
    name: 'press_hotkey',
    description:
      'Presses a combination of keyboard keys simultaneously. ' +
      'Useful for shortcuts (e.g., ctrl+c, ctrl+shift+t).',
    parameters: {
      keys: {
        type: 'array',
        required: true,
        description: 'An array of key names to press. Examples: ["ctrl", "c"], ["cmd", "shift", "t"].',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const { keys } = args;
      try {
        // 白名单外的键名会被 system 层拒绝 —— 模型无法注入白名单之外的任何键
        await system.pressHotkey(keys);
        return `[System]: Successfully pressed hotkey: ${keys.join(' + ')}. ` +
          `[Next Step]: Call 'take_screenshot' to verify the result.`;
      } catch (error: any) {
        return `[Error]: Hotkey press failed. ${error.message}`;
      }
    },
  });
}
