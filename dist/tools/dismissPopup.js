// src/tools/dismissPopup.ts
// 零副作用元工具：什么都不做恰恰是设计 —— 不猜关闭按钮位置（会点错），
// 只返回强制重分析指令，把「我发现自己被挡住了」外化为可调用的 ReAct 暂停键。
// 引入第三种状态 ACTION_REQUIRED：不是成功也不是失败，而是「需要你重新介入」。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TACTICAL_PAUSE } from '../guards/popupGuard.js';
export const dismissPopupTool = defineTool({
    name: 'dismiss_popup',
    description: 'Use this as a fallback when the screen is blocked by an unexpected popup, modal, or overlay. ' +
        'It forces a re-evaluation of the screen to find the close/cancel button.',
    parameters: {},
    output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
        // 与 popupGuard 共享同一常量：拦截路径与自救路径收到逐字一致的指令
        return TACTICAL_PAUSE;
    },
});
