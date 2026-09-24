// src/tools/switchWindow.ts
// 参数设计与模型实际拥有的信息粒度对齐：模型只能从截图读到部分标题 -> 关键词模糊匹配。
// system 层无窗口管理能力时诚实失败，并给出 press_hotkey 降级路径 ——
// 错误消息里写好 Plan B，工具的失败也设计成可恢复的路由节点。
// B-4：返回值统一走 toolResult 工厂（反幻觉锚点全覆盖）。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { system } from '../system.js';
import { sleep } from '../actionVerifier.js';
import { readTextAny } from '../textReader.js';
import { fuzzyIncludes } from '../fuzzy.js';
import { toolOk, toolErr } from '../toolResult.js';
// Y-5 焦点交接取证：切窗不是「调了 API」而是「目标窗口真的到了前台」。
// 证据 = 前台窗口标题条（顶部带 OCR）与关键词的模糊包含（fuzzy 容忍 OCR
// 形变）。失败/OCR 缺席诚实降级为旧行为（API 成功 + 截图建议）。
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
            const r = await system.switchWindowByTitle(args.titleKeyword);
            // ── Y-5 焦点交接取证（Y6 加固）：证据阶梯 = 原生命中标题 → OCR 标题带 ──
            // 旧实现只 OCR 屏幕顶部 0.08 条带：标题栏小字在 1440 宽截图里对 OCR 引擎
            // 太小，取证静默缺席（真机战果：focus_handoff 从不出现）。原生后端本身
            // 返回实际激活窗口的标题 —— 那是第一手证据，直接用；OCR 降级为后备。
            await sleep(400); // 前台切换的绘制窗口
            let proof;
            if (r.matched) {
                const needle = args.titleKeyword.toLowerCase().trim();
                const hay = r.matched.toLowerCase();
                proof = {
                    verified: hay.includes(needle) || fuzzyIncludes(needle, hay),
                    foreground_title: r.matched.replace(/\s+/g, ' ').trim().slice(0, 80),
                    evidence: 'native-title',
                };
            }
            else {
                try {
                    const strip = await readTextAny({ x: 0.0, y: 0.0, width: 1.0, height: 0.08 });
                    const title = strip.text.replace(/[\s]+/g, ' ').trim().slice(0, 80);
                    if (title) {
                        const needle = args.titleKeyword.toLowerCase().trim();
                        const hay = title.toLowerCase();
                        proof = { verified: hay.includes(needle) || fuzzyIncludes(needle, hay), foreground_title: title, evidence: 'ocr-titlebar' };
                    }
                }
                catch { /* OCR 缺席：诚实降级为 API 成功语义 */ }
            }
            if (proof && !proof.verified) {
                return toolErr(`Window switch API succeeded, but the foreground title does NOT contain "${args.titleKeyword}".`, `Foreground title bar reads: "${proof.foreground_title}"`, 'The switch may have landed on the wrong window, or the keyword does not match the localized title ' +
                    '(e.g. Chinese Windows uses 记事本/计算器). Retry switch_window with the localized keyword, ' +
                    'or fall back to press_hotkey ["alt","tab"].');
            }
            return toolOk(`Switched to window containing "${args.titleKeyword}".`, {
                matched_keyword: args.titleKeyword,
                ...(proof ? { focus_handoff: proof } : {}),
            }, "Call 'take_screenshot' to confirm the expected window is now in the foreground.");
        }
        catch (error) {
            return toolErr(`Window switch ("${args.titleKeyword}") failed.`, error.message, "Fallback: use 'press_hotkey' with [\"alt\", \"tab\"] (Windows/Linux) or [\"cmd\", \"tab\"] (macOS) " +
                'to cycle windows, then verify with take_screenshot.');
        }
    },
});
