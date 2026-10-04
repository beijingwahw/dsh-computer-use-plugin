// src/vlm/providers/probe.presets.ts
// W6-2（doctor smell.over-engineering 清偿）：自 probe.ts 低风险分区提取
// （>500 行拆分信号）—— 平台预设视图（registry 收编版：单一数据源 + 探针展示
// 标签叠层）整体搬迁。行为零变化；probe.ts 导入消费并以再导出保持导入面不变。
import { PLATFORM_PRESETS as REGISTRY_PRESETS } from './registry.js';
import { createAnthropicProvider } from './anthropic.js';
import { createGeminiProvider } from './gemini.js';
import { createOpenAiProvider } from './openai.js';
// ─── 平台预设视图（registry 收编版：单一数据源 + 探针展示标签叠层） ───
/**
 * 探针报告展示标签叠层 —— registry label 的体检报告方言（含部署形态括注）。
 * 仅是展示字符串，不参与任何连接决策；协议/基址/模型/env 键等物料全部
 * 单一来源自 registry（删桩不留重复源 —— 换脑只改 registry 一处）。
 */
const PROBE_LABELS = {
    glm: '智谱 GLM（bigmodel）',
    openai: 'OpenAI 官方云',
    anthropic: 'Anthropic Claude',
    gemini: 'Google Gemini',
    qwen: '通义千问（DashScope 兼容模式）',
    moonshot: '月之暗面 Kimi（Moonshot）',
    doubao: '火山方舟 豆包',
    xai: 'xAI Grok',
    siliconflow: '硅基流动 SiliconFlow',
    openrouter: 'OpenRouter',
    ollama: 'Ollama 本地',
    lmstudio: 'LM Studio 本地',
    vllm: 'vLLM 本地',
};
/** 万脑平台预设表 —— 云端十家 + 本地三家（探针遍历此表体检）；
 *  数据单一来源投影自 registry.PLATFORM_PRESETS（十三平台花名册）。 */
export const PLATFORM_PRESETS = REGISTRY_PRESETS.map((p) => ({
    label: PROBE_LABELS[p.id] ?? p.label,
    id: p.id,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    ...(p.defaultModel !== '' ? { model: p.defaultModel } : {}),
    envKeys: [...p.envKeys],
    ...(p.localAuthOptional === true ? { localAuthOptional: true } : {}),
}));
/** 取首个非空环境变量（trim 后比对；全空 ⇒ ''） */
export function firstEnv(names) {
    for (const n of names) {
        try {
            const v = process.env[n];
            if (typeof v === 'string' && v.trim() !== '')
                return v.trim();
        }
        catch { /* 环境面故障视为未设置 */ }
    }
    return '';
}
/** 按预设协议铸 provider —— 云脑三家工厂的分发面（全字段可注入，测试零联网） */
export function castPlatformProvider(args) {
    const { preset, apiKey, baseUrl, model, fetchImpl } = args;
    const cfg = {
        id: preset.id,
        idPreset: preset.id,
        apiKey,
        baseUrl,
        model: model !== '' ? model : undefined,
        defaultBaseUrl: preset.baseUrl,
        defaultModel: preset.model,
        fetchImpl,
    };
    if (preset.protocol === 'anthropic')
        return createAnthropicProvider(cfg);
    if (preset.protocol === 'gemini')
        return createGeminiProvider(cfg);
    return createOpenAiProvider(cfg);
}
