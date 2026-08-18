// src/tools/typeText.ts
// 三层融合：长度防御（迭代中曾丢失，此处找回）+ 平台抽象（全部委托 system）+ 输入状态锚点。
// input_state 的二值语义（Replaced / Appended）让模型在验证截图前就知道该预期什么。
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Config } from '../config';
import { system } from '../system';

export function createTypeTextTool(config: Config) {
  return defineTool({
    name: 'type_text',
    description: 'Types text into the currently focused UI element. Use this after clicking on an input field.',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: 'The exact text string to type into the focused element.',
      },
      clearFirst: {
        type: 'boolean',
        required: false,
        description: 'Set to true to select all and clear existing text before typing. Default is false.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const { text, clearFirst = false } = args;

      // 前哨闸门：工具参数是被模型控制的输入面，防注入恶意长文本
      if (text.length > config.maxTextLength) {
        return `[Error]: Text too long. Maximum length is ${config.maxTextLength} characters.`;
      }

      try {
        await system.typeText(text, clearFirst);

        return JSON.stringify({
          status: 'SUCCESS',
          action: 'Text typed successfully.',
          state_anchor: {
            // 回显也做 Token 预算：截断到 50 字符
            typed_content: text.substring(0, 50) + (text.length > 50 ? '...' : ''),
            char_count: text.length,
            cleared_existing: clearFirst,
            input_state: clearFirst ? 'Replaced all previous content' : 'Appended to existing content',
          },
          next_step: "MANDATORY: Call 'take_screenshot' immediately to verify that the text appears correctly in the input field.",
        }, null, 2);

      } catch (error: any) {
        return JSON.stringify({
          status: 'FAILED',
          error: error.message,
          next_step: 'The text input failed. Check if an input field is currently focused. Call take_screenshot to verify the UI state.',
        }, null, 2);
      }
    },
  });
}
