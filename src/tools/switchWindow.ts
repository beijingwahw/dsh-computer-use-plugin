// src/tools/switchWindow.ts
// 参数设计与模型实际拥有的信息粒度对齐：模型只能从截图读到部分标题 -> 关键词模糊匹配。
// system 层无窗口管理能力时诚实失败，并给出 press_hotkey 降级路径 ——
// 错误消息里写好 Plan B，工具的失败也设计成可恢复的路由节点。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { system } from '../system';

export const switchWindowTool = defineTool({
  name: 'switch_window',
  description: 'Brings a specific application window to the foreground based on its title.',
  parameters: {
    titleKeyword: {
      type: 'string',
      required: true,
      description: 'A keyword in the window title to search for (e.g., "Chrome", "Word", "Terminal").',
    },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args) {
    try {
      await system.switchWindowByTitle(args.titleKeyword);
      return `[System]: Successfully switched to window containing "${args.titleKeyword}". ` +
        `[Next Step]: Call 'take_screenshot' to see the new active window.`;
    } catch (error: any) {
      return `[Error]: ${error.message} ` +
        `[Next Step]: Fallback: use 'press_hotkey' with ["alt", "tab"] (Windows/Linux) to cycle windows, then verify with 'take_screenshot'.`;
    }
  },
});
