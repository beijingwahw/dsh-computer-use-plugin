// src/tools/askScreen.ts
// 纪元 Ω（云脑皮层工具面）：ask_screen —— 自由视觉问答。
// 纯视觉架构的「云脑」对模型本人开放：截当前干净屏（无 SoM 网格/准星叠加 ——
// 问的是世界本身，不是导航辅助层）+ 自然语言问题 → GLM-5.3-Flash 看屏作答。
// 分工：本地反射弧（OCR/模糊/探针，毫秒级）回答确定性事实；开放语义
// （整屏理解 / 状态推断 / 图文混读 / 未见过的界面形态）走本工具（秒级）。
// 铁律：锚点一律走 toolResult 工厂；未配置/失败诚实 toolErr —— 绝不抛、绝不伪造答案。
import { defineTool } from '@deepseek-ai/dsh-tools';
import * as backend from '../physicalBackend.js';
import { toolOk, toolErr } from '../toolResult.js';
import { getGlmClient, isGlmConfigured } from '../vlm/glmClient.js';
import { encodeForVlm } from '../vlm/codec.js';
/** 回答字符预算（Token 纪律：问答是状态锚点，不是整屏转录） */
const ANSWER_MAX_CHARS = 1500;
/** 问题字符预算（防超长注入烧 Token） */
const QUESTION_MAX_CHARS = 500;
/** 云脑角色设定：看屏作答的诚实描述员 —— 只描述所见，不猜屏外，不编事实 */
const ASK_SYSTEM_PROMPT = '你是屏幕观察员。用户给出一张当前屏幕截图和一个问题，请只依据截图中的可见内容作答：' +
    '简洁、直接、事实优先；引用屏幕上的原文时保持原文。截图之外的信息不要臆测；' +
    '看不清/不确定时如实说明。用提问所用的语言回答。';
export function createAskScreenTool(_config, deps = {}) {
    return defineTool({
        name: 'ask_screen',
        description: 'Ask the GLM vision model a free-form question about the CURRENT screen (captured fresh, without overlays). ' +
            'Use it when local tools are not enough: overall page state, purpose of unfamiliar UI, mixed text-and-image ' +
            'content, or anything requiring open semantic understanding. Read-only — it never touches the world. ' +
            'For precise text coordinates use find_text; for plain text extraction use read_text.',
        parameters: {
            question: {
                type: 'string', required: true,
                description: 'The question about the current screen, in any language, e.g. "哪个输入框当前获得焦点？" ' +
                    'or "Is this a login page and is any form field filled?"',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
            const question = typeof args.question === 'string' ? args.question.trim().slice(0, QUESTION_MAX_CHARS) : '';
            if (!question) {
                return toolErr('ask_screen validation failed.', 'Empty question argument.', 'Ask a concrete question about the visible screen, e.g. "What dialog is currently open?"');
            }
            // 配置哨兵：未注入 client 且云脑未配置 ⇒ 零截屏零网络诚实降级（无 Key 用户不伪答）
            if (!deps.client && !isGlmConfigured()) {
                return toolErr('ask_screen unavailable.', 'VLM not configured (set vlmApiKey in config, or GLM_API_KEY / ZHIPUAI_API_KEY / ZAI_API_KEY in env).', 
                // 纪元 Λ：无模型时给模型指路 —— vlm_wizard 是零门槛出口（用户页面上贴一次密钥即亮）
                'Use take_screenshot and your own vision, or read_text / find_text for text-level sensing — ' +
                    'or call vlm_wizard to open the connection wizard so the user can connect a vision model.');
            }
            try {
                const capture = deps.capture ?? (() => backend.captureCleanPng());
                const buffer = await capture();
                if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
                    return toolErr('ask_screen failed.', 'Screen capture returned an empty buffer.', 'The capture pipeline may be unavailable — try take_screenshot to check the vision channel.');
                }
                const enc = await encodeForVlm(buffer);
                if (!enc.ok || !enc.value) {
                    return toolErr('ask_screen failed.', enc.error ?? 'screenshot encoding failed', 'Retry once; if it persists, fall back to take_screenshot + local text tools.');
                }
                const client = deps.client ?? getGlmClient();
                const res = await client.chat({
                    images: [{ base64: enc.value.base64, mime: enc.value.mime }],
                    system: ASK_SYSTEM_PROMPT,
                    prompt: question,
                    temperature: 0.2, // 读屏问答要忠实，不要发散
                    maxTokens: 1024,
                });
                if (!res.ok) {
                    return toolErr('ask_screen failed.', res.error ?? 'unknown VLM error', 'The cloud cortex did not answer — fall back to take_screenshot + read_text / find_text.');
                }
                const answer = res.text.trim();
                if (!answer) {
                    return toolErr('ask_screen failed.', 'Vision model returned an empty answer.', 'Rephrase the question more concretely, or fall back to take_screenshot.');
                }
                return toolOk(`ask_screen: "${question.slice(0, 80)}" answered by ${res.model}.`, {
                    answer: answer.length > ANSWER_MAX_CHARS ? answer.slice(0, ANSWER_MAX_CHARS) + '...[truncated]' : answer,
                    latency_ms: res.latencyMs,
                    model: res.model,
                }, 'The answer describes the screen AT CAPTURE TIME — it may be stale now. ' +
                    'Before acting on it, ground coordinates yourself: take_screenshot (visual grounding) or find_text; ' +
                    'ask_screen is read-only and never justifies clicking guessed coordinates.');
            }
            catch (error) {
                return toolErr('ask_screen failed.', error?.message ?? 'unknown error', 'Capture or the VLM pipeline failed — fall back to take_screenshot + local text tools.');
            }
        },
    });
}
