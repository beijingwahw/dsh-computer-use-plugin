// src/tools/switchWindow.ts
// 参数设计与模型实际拥有的信息粒度对齐：模型只能从截图读到部分标题 -> 关键词模糊匹配。
// system 层无窗口管理能力时诚实失败，并给出 press_hotkey 降级路径 ——
// 错误消息里写好 Plan B，工具的失败也设计成可恢复的路由节点。
// B-4：返回值统一走 toolResult 工厂（反幻觉锚点全覆盖）。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { system } from '../system.js';
import { toolOk, toolErr } from '../toolResult.js';
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
            return toolOk(`Switched to window containing "${args.titleKeyword}".`, { matched_keyword: args.titleKeyword }, "Call 'take_screenshot' to confirm the expected window is now in the foreground.");
        }
        catch (error) {
            return toolErr(`Window switch ("${args.titleKeyword}") failed.`, error.message, "Fallback: use 'press_hotkey' with [\"alt\", \"tab\"] (Windows/Linux) or [\"cmd\", \"tab\"] (macOS) " +
                'to cycle windows, then verify with take_screenshot.');
        }
    },
});
