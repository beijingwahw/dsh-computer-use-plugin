// src/tools/textTools.ts
// 第四轮创新的工具面（OCR）：
//   read_text  — 区域文字读取：文本替代截图，Token 数量级下降
//   find_text  — 文字→坐标定位：带文字标签的元素获得精确 ground truth，
//                彻底消灭「按按钮文字估坐标」的幻觉源
// 本轮接线：OCR 双路径 —— D-5 服务端 L2（RapidOCR）优先，tesseract.js 兜底。
// Z 纪元（Z-1）：find_text 集成交互性探针 —— OCR 命中先过悬停物理实验
// （光标形态 + 悬停重绘），标注 interactivity=control/text/unprobed。
// 对症：「对话文本被误识别为可点击的入口」——聊天记录里写着「点击登录」
// 的文字与真按钮像素等价，但悬停上去 OS 会给出 ibeam 与 hand 两种
// 截然不同的回答。文字坐标从此携带交互性判决，不再是裸坐标。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { readTextAny } from '../textReader.js';
import { classifyWordShape, probePoints } from '../interactivityProbe.js';
import { extractUrls } from '../urlSense.js';
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
                // AA-1 URL 感知：正文里的链接自动浮出 —— 「自动跳转」的感知面。
                // 屏幕上的 URL 不是控件（点击被 Z-2 闸门否决），跳转的正确出口是
                // open_url；read_text 顺手把燃料备好，模型不必再手抄。
                const urls = extractUrls(clean);
                return JSON.stringify({
                    status: 'SUCCESS',
                    state_anchor: {
                        scope: cropNote,
                        text_found: true,
                        char_count: clean.length,
                        // 文本本身也做预算：超长截断
                        text: clean.length > 1500 ? clean.slice(0, 1500) + '...[truncated]' : clean,
                        ...(urls.length > 0 ? { urls_detected: urls } : {}),
                    },
                    next_step: urls.length > 0
                        ? `URLs detected in the text. To FOLLOW one, call 'open_url' with it — do NOT click the text ` +
                            `(it is static content; the interactivity gate will refuse). ` +
                            `Use the text content for your reasoning; call find_text when you need clickable coordinates for any label.`
                        : 'Use the text content for your reasoning. Call find_text when you need clickable coordinates for any label.',
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
        description: 'Locates on-screen text and returns PRECISE normalized coordinates for each match, ' +
            'annotated with an INTERACTIVITY verdict from a zero-impact hover experiment ' +
            '(cursor shape + hover repaint): interactivity=control means the OS confirms it is a ' +
            'clickable element (hand cursor / hover highlight); interactivity=text means it is ' +
            'static selectable text (chat messages, documents) — NOT a clickable entry. ' +
            'IMPORTANT: a match is a LOCATION, not a permission to click — never click a match ' +
            'marked text when you are looking for a button/entry.',
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
                // Z-1：几何先验分类 + 悬停物理实验。探针优先级：ambiguous（最需实验）
                // > content-like（本 bug 的危险形态）> control-like（先验已足）。
                const shaped = hits.slice(0, 8).map(w => ({ word: w, shape: classifyWordShape(w) }));
                const probeOrder = { 'ambiguous': 0, 'content-like': 1, 'control-like': 2 };
                let probes = new Map();
                if (config.enableInteractivityProbe) {
                    const targets = [...shaped]
                        .sort((a, b) => probeOrder[a.shape] - probeOrder[b.shape])
                        .slice(0, config.probeMaxTargets);
                    const results = await probePoints(config, targets.map(t => ({
                        x: t.word.center_normalized.x, y: t.word.center_normalized.y,
                    })));
                    targets.forEach((t, i) => probes.set(`${t.word.center_normalized.x.toFixed(4)},${t.word.center_normalized.y.toFixed(4)}`, results[i]));
                }
                const lines = shaped.map(({ word: w, shape }) => {
                    const key = `${w.center_normalized.x.toFixed(4)},${w.center_normalized.y.toFixed(4)}`;
                    const p = probes.get(key);
                    let tag = `shape=${shape}`;
                    if (p) {
                        // 通道透明律：判决来自哪个世界通道，证据链可追溯
                        const viaTag = p.evidence.via === 'uia'
                            ? `via=uia(${p.evidence.hit_test?.control_type ?? '?'}`
                                + (p.evidence.hit_test?.matched_depth ? `, ancestor+${p.evidence.hit_test.matched_depth}` : '') + ')'
                            : p.evidence.via === 'memory'
                                ? 'via=memory(scene-matched recall)'
                                : `via=hover(cursor=${p.evidence.cursor_kind}`
                                    + (p.evidence.repaint_similarity != null ? `, repaint=${p.evidence.hover_repaint}` : '') + ')';
                        tag += ` interactivity=${p.verdict} [${viaTag}, conf=${p.confidence.toFixed(2)}]`;
                    }
                    else {
                        tag += ' interactivity=unprobed (budget; trust shape with caution)';
                    }
                    return `- "${w.text}" center=(${w.center_normalized.x.toFixed(3)}, ${w.center_normalized.y.toFixed(3)}) confidence=${Math.round(w.confidence)} ${tag}`;
                });
                const anyControl = [...probes.values()].some(p => p.verdict === 'control');
                const anyText = [...probes.values()].some(p => p.verdict === 'text');
                return JSON.stringify({
                    status: 'SUCCESS',
                    state_anchor: {
                        keyword: args.keyword,
                        matches: hits.length,
                        probed: probes.size,
                        locations: lines,
                    },
                    next_step: 'ONLY click a match with interactivity=control (OS-confirmed clickable). ' +
                        'Matches with interactivity=text are static content — chat messages or document ' +
                        'text that merely MENTIONS the keyword; clicking them is always a mistake. ' +
                        'unprobed matches: rely on shape (content-like full-width rows are text; ' +
                        'compact labels are likely controls) and verify with zoom_inspect or ' +
                        'probe_interactivity before clicking. If NO match is a control, the real entry ' +
                        'is elsewhere: scroll_page, open the right menu, or take_screenshot and search visually.' +
                        (anyControl ? ' A control match exists in this result.' : anyText ? ' WARNING: only text matches were found — do not click any of them.' : ''),
                }, null, 2);
            }
            catch (error) {
                return `[Error]: OCR failed (${error.message}). Fall back to visual grounding via take_screenshot + zoom_inspect.`;
            }
        },
    });
}
