// src/tools/probeInteractivity.ts
// Z 纪元（Z-1 世界行动引擎）的工具面：对任意坐标做交互性判决。
//
// 三通道按判别力降序：UIA 点查询（结构层官方登记，零物理副作用）→
// 悬停光标本体感觉（hand/ibeam）→ 悬停重绘。大多数点在第一通道即被
// 判决，鼠标根本不动；只有 UIA 拿不到证据时才做悬停实验（结束后复位）。
// 纪元 Ν（探索经济学）：通道序可按学习到的 bitsPerMs 后验自适应（关闭 =
// 固定降序）；判决附带经济学透明注记（通道序/各通道 bitsPerMs/是否提前停）。
// 使用时机：拿不准某处文字/区域是不是可点击入口时 —— 尤其在聊天/文档
// 界面里，正文提到目标关键词与真入口像素等价。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { probeInteractivity } from '../interactivityProbe.js';
import { toolOkNoAction } from '../toolResult.js';
export function createProbeInteractivityTool(config) {
    return defineTool({
        name: 'probe_interactivity',
        description: 'Reports whether a point is a real interactive element, using the strongest ' +
            'available evidence channel, cheapest first: (0) scene-matched verdict memory — ' +
            'if this exact scene was probed before, the cached verdict returns instantly with ' +
            'zero side effects; (1) Windows UI Automation point hit-test — the officially ' +
            'registered control type at the point, zero side effects; (2) a zero-impact hover ' +
            'experiment — the mouse MOVES there (never clicks), the OS cursor shape is read ' +
            '(hand = clickable, I-beam = selectable text), hover repaint is measured, then the ' +
            'mouse is restored. Use before clicking any text you are not sure about — especially ' +
            'in chat or document UIs where message text can mention the same keyword as a real button.',
        parameters: {
            x: { type: 'number', required: true, description: 'X coordinate to probe (0.0-1.0).' },
            y: { type: 'number', required: true, description: 'Y coordinate to probe (0.0-1.0).' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
            try {
                if (args.x < 0 || args.x > 1 || args.y < 0 || args.y > 1) {
                    return '[Error]: Coordinates must be in 0.0-1.0 (normalized).';
                }
                const r = await probeInteractivity(config, args.x, args.y);
                const explain = {
                    control: 'The OS confirms this is an interactive element (hand cursor and/or hover repaint). Safe to click.',
                    text: 'This is selectable TEXT (I-beam cursor) — static content such as a chat message or document body, NOT a clickable entry. Do not click it when looking for a button. (Exception: if you intended to focus a text input, clicking is fine — verify focus afterwards.)',
                    inconclusive: 'Channels were inconclusive (native controls often keep the arrow cursor and some have no hover effect). Fall back to visual affordance: zoom_inspect for button chrome (border/background) before clicking.',
                };
                // 纪元 Ν（探索经济学）透明律：经济模式开启时，判决附带通道经济学注记
                // —— 花钱的序（channel_order）、各通道的 bitsPerMs 后验（bits_per_ms）、
                // 是否熵减足额提前停（stopped_early）、已花成本（spent_ms）。
                // 既有字段一字不动；经济关闭/记忆召回的判决无此注记（Z 纪元原形状）。
                const economicsNote = r.economics ? {
                    economics: {
                        channel_order: r.economics.channel_order,
                        bits_per_ms: r.economics.bits_per_ms,
                        stopped_early: r.economics.stopped_early,
                        spent_ms: r.economics.spent_ms,
                    },
                } : {};
                // W8/B-4：回执走工厂（toolOkNoAction —— 历史无 action 形状，逐字节同构）
                return toolOkNoAction({
                    probed_point: `(${args.x}, ${args.y})`,
                    verdict: r.verdict,
                    confidence: r.confidence,
                    evidence: r.evidence,
                    ...(r.note ? { note: r.note } : {}),
                    ...economicsNote,
                }, explain[r.verdict]);
            }
            catch (error) {
                return `[Error]: Probe failed (${error.message}). The physical service may be an older version without /move_mouse and /cursor_kind — restart it, or fall back to zoom_inspect for visual affordance.`;
            }
        },
    });
}
