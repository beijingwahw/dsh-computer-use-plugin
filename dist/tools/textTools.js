// src/tools/textTools.ts
// 第四轮创新的工具面（OCR）：
//   read_text  — 区域文字读取：文本替代截图，Token 数量级下降
//   find_text  — 文字→坐标定位：带文字标签的元素获得精确 ground truth，
//                彻底消灭「按按钮文字估坐标」的幻觉源
// 本轮接线：OCR 双路径 —— D-5 服务端 L2（RapidOCR）优先，tesseract.js 兜底。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { readTextAny } from '../textReader.js';
export function createReadTextTool(config) {
    return defineTool({
        name: 'read_text',
        description: 'Reads text from the screen (or a region around a point) via local OCR. ' +
            'Use this instead of take_screenshot when you only need TEXT content — it costs far fewer tokens. ' +
            'Returned coordinates are full-screen normalized (0.0-1.0).',
        parameters: {
            x: { type: 'number', description: 'Optional center X of the region to read (0.0-1.0). Default: full screen.' },
            y: { type: 'number', description: 'Optional center Y of the region to read (0.0-1.0).' },
            half_size: { type: 'number', description: 'Optional region half-size (fraction). Default 0.25.' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
            try {
                // J 纪元修正：单坐标（只传 x 或只传 y）不再被静默忽略 —— 参数语义
                // 是"区域中心"，半指定即无意义；诚实报错好过全屏兜底（调用方以为
                // 读的是局部，拿到的是全屏）。
                if ((args.x !== undefined || args.y !== undefined) &&
                    !(typeof args.x === 'number' && typeof args.y === 'number')) {
                    return `[Error]: Region requires BOTH x and y (got x=${JSON.stringify(args.x)}, y=${JSON.stringify(args.y)}). Omit both for a full-screen read.`;
                }
                let region;
                let cropNote = 'full_screen';
                if (typeof args.x === 'number' && typeof args.y === 'number') {
                    const half = args.half_size ?? 0.25;
                    if (args.x < 0 || args.x > 1 || args.y < 0 || args.y > 1 || half <= 0 || half > 0.5) {
                        return `[Error]: Invalid region. x/y in 0.0-1.0, half_size in (0, 0.5].`;
                    }
                    // 双侧夹取（与 zoomInspect 同律）：越界侧归边，另一侧以 x±half 为界
                    const x0 = Math.max(0, args.x - half);
                    const y0 = Math.max(0, args.y - half);
                    const x1 = Math.min(1, args.x + half);
                    const y1 = Math.min(1, args.y + half);
                    region = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
                    cropNote = `region_center=(${args.x}, ${args.y}) half=${half}`;
                }
                const { text } = await readTextAny(region, config.ocrLang);
                const clean = text.replace(/\n{3,}/g, '\n\n').trim();
                if (!clean) {
                    return JSON.stringify({
                        status: 'SUCCESS',
                        state_anchor: { scope: cropNote, text_found: false },
                        next_step: 'No readable text in scope. If the area contains text, it may be too small — try zoom_inspect or a larger half_size.',
                    }, null, 2);
                }
                return JSON.stringify({
                    status: 'SUCCESS',
                    state_anchor: {
                        scope: cropNote,
                        text_found: true,
                        char_count: clean.length,
                        // 文本本身也做预算：超长截断
                        text: clean.length > 1500 ? clean.slice(0, 1500) + '...[truncated]' : clean,
                    },
                    next_step: 'Use the text content for your reasoning. Call find_text when you need clickable coordinates for any label.',
                }, null, 2);
            }
            catch (error) {
                return `[Error]: OCR failed (${error.message}). The OCR engine may be unavailable (rapidocr for the service path, tesseract.js for the legacy path); fall back to take_screenshot.`;
            }
        },
    });
}
export function createFindTextTool(config) {
    return defineTool({
        name: 'find_text',
        description: 'Locates on-screen text and returns PRECISE normalized coordinates for each match. ' +
            'This is the most reliable way to ground any element that has a visible text label — ' +
            'prefer it over estimating coordinates from a screenshot.',
        parameters: {
            keyword: {
                type: 'string', required: true,
                description: 'The text to find (case-insensitive), e.g., "登录", "Sign in", "Submit".',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
            try {
                const { words } = await readTextAny(undefined, config.ocrLang);
                const needle = args.keyword.toLowerCase().trim();
                const hits = words.filter(w => w.text.toLowerCase().includes(needle));
                if (hits.length === 0) {
                    return JSON.stringify({
                        status: 'SUCCESS',
                        state_anchor: { keyword: args.keyword, matches: 0 },
                        next_step: 'No match on screen. The text may be off-screen (scroll_page), inside an unopened menu, or rendered as an image/icon. Fall back to visual search via take_screenshot.',
                    }, null, 2);
                }
                const lines = hits.slice(0, 8).map(w => `- "${w.text}" center=(${w.center_normalized.x.toFixed(3)}, ${w.center_normalized.y.toFixed(3)}) confidence=${Math.round(w.confidence)}`);
                return JSON.stringify({
                    status: 'SUCCESS',
                    state_anchor: {
                        keyword: args.keyword,
                        matches: hits.length,
                        locations: lines,
                    },
                    next_step: `Click the most relevant match with click_mouse using its EXACT center coordinates. ` +
                        `If multiple matches exist, disambiguate by their vertical/horizontal position before clicking.`,
                }, null, 2);
            }
            catch (error) {
                return `[Error]: OCR failed (${error.message}). Fall back to visual grounding via take_screenshot + zoom_inspect.`;
            }
        },
    });
}
