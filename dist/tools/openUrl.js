// src/tools/openUrl.ts
// AA 纪元（AA-1 世界跳转引擎）：URL 安检 + 系统默认浏览器跳转。
//
// 对症需求：「自动跳转网页链接」。屏幕上的 URL（聊天正文/文档/OCR 噪声）
// 不是控件 —— 点它要么被 Z-2 闸门否决（正文），要么点不中；世界行动律的
// 答案是把 URL 交给 OS 壳层。本工具是跳转的唯一门面：
//
//   1. 安检前置（urlSense）：scheme 白名单 [http, https] —— file:// 是本地
//      文件系统、javascript: 是脚本执行、data: 是数据载荷，全拒绝。跳转
//      引擎只把模型带向公开网页，不做任意协议启动器。
//   2. 噪声容忍：入参可以是含 URL 的自由文本（OCR 结果直接粘贴），提取
//      精确无损；多候选歧义 ⇒ 结构化拒绝（绝不掷硬币选一个打开）。
//   3. 诚实回执：spawn 是 fire-and-forget，本工具不伪造「页面已加载」——
//      next_step 强制世界核对（take_screenshot / switch_window）。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { system } from '../system.js';
import { normalizeUrlCandidate, extractUrls } from '../urlSense.js';
import { toolOk, toolErr } from '../toolResult.js';
/** 候选歧义时列出的上限（防爆量；多余者提示用 read_text 重看） */
const AMBIGUOUS_LIST_MAX = 5;
export function createOpenUrlTool(config) {
    return defineTool({
        name: 'open_url',
        description: 'Opens a web URL (http/https only) in the OS default browser — the correct way to follow links found in ' +
            'chat messages, documents, or OCR text (clicking static text is refused by the interactivity gate). ' +
            'Accepts either a bare URL or free text containing one (the URL is extracted losslessly; OCR noise tolerated). ' +
            'Non-web schemes (file://, javascript:, data:) are refused. Opening is asynchronous — verify with take_screenshot.',
        parameters: {
            url: {
                type: 'string', required: true,
                description: 'The URL to open, e.g. "https://example.com/docs" — or free text containing it ' +
                    '(e.g. an OCR line like "详见 https://example.com/a?x=1 即可")。 The first unambiguous URL is used.',
            },
            reasoning: {
                type: 'string',
                description: 'Why you are opening this URL (one sentence). Recorded into the causal journal for counterfactual analysis.',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
            const raw = typeof args.url === 'string' ? args.url.trim() : '';
            if (!raw) {
                return toolErr('open_url validation failed.', 'Empty url argument.', 'Provide the URL (http/https) or text containing it.');
            }
            // 安检阶梯：裸 URL 直判 → 自由文本提取 → 歧义/缺席结构化拒绝
            let verdict = normalizeUrlCandidate(raw);
            if (verdict.kind === 'refused') {
                const candidates = extractUrls(raw);
                if (candidates.length === 1) {
                    verdict = { kind: 'ok', url: candidates[0] };
                }
                else if (candidates.length > 1) {
                    return toolErr('open_url refused: multiple URL candidates.', `Found ${candidates.length} URLs: ${candidates.slice(0, AMBIGUOUS_LIST_MAX).join(' | ')}` +
                        (candidates.length > AMBIGUOUS_LIST_MAX ? ' …' : ''), 'Ambiguity is never resolved by coin flip — re-invoke with exactly ONE of these URLs.');
                }
            }
            if (verdict.kind === 'refused') {
                return toolErr('open_url refused: URL validation failed.', verdict.reason, 'Only http/https URLs are opened (scheme allowlist). If the text on screen contains a link, ' +
                    "re-read it with 'read_text' and pass the exact URL; bare domains without a scheme are not guessed.");
            }
            try {
                const { method } = await system.openUrl(verdict.url);
                return toolOk(`OS asked to open ${verdict.url} (via ${method}).`, {
                    url: verdict.url,
                    transport: method,
                    note: 'fire-and-forget: the browser may take a moment; this receipt proves the shell request, not the loaded page',
                }, "Verify the jump: call 'take_screenshot' to see the page (the browser may open in the background — " +
                    "use 'switch_window' with the browser name to bring it forward). Then continue the task on the loaded page.");
            }
            catch (error) {
                return toolErr(`open_url failed for ${verdict.url}.`, error.message, 'The platform opener failed. Check the URL, or open the browser manually via press_hotkey (win/meta) and type the URL into the address bar.');
            }
        },
    });
}
