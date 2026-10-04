// src/vlm/providers/probe.presets.ts
// W6-2（doctor smell.over-engineering 清偿）：自 probe.ts 低风险分区提取
// （>500 行拆分信号）—— 平台预设视图（registry 收编版：单一数据源 + 探针展示
// 标签叠层）整体搬迁。行为零变化；probe.ts 导入消费并以再导出保持导入面不变。
import { PLATFORM_PRESETS as REGISTRY_PRESETS } from './registry';
import type { PlatformPreset as RegistryPreset } from './registry';
import type { ProviderProtocol, VisionProvider } from './types';
import { createAnthropicProvider } from './anthropic';
import { createGeminiProvider } from './gemini';
import { createOpenAiProvider } from './openai';

// ─── 平台预设视图（registry 收编版：单一数据源 + 探针展示标签叠层） ───


/**
 * 探针报告展示标签叠层 —— registry label 的体检报告方言（含部署形态括注）。
 * 仅是展示字符串，不参与任何连接决策；协议/基址/模型/env 键等物料全部
 * 单一来源自 registry（删桩不留重复源 —— 换脑只改 registry 一处）。
 */
const PROBE_LABELS: Readonly<Record<string, string>> = {
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

/**
 * 平台预设（探针视图）—— 一台平台一条：换脑只需 env 放 key（或本地平台零配置直探）。
 * 本接口是 registry.PlatformPreset 的探针投影：云端平台须 env 有 key 才探；本地三平台
 * （Ollama/LM Studio/vLLM）localAuthOptional —— 无 key 也探（127.0.0.1 直连）。
 */
export interface PlatformPreset {
  /** 人读标签（体检报告展示面 —— PROBE_LABELS 叠层，缺省回退 registry label） */
  label: string;
  /** providerId 预设（透传工厂 idPreset） */
  id: string;
  /** 线协议方言 —— 决定铸哪个工厂 */
  protocol: ProviderProtocol;
  /** 缺省服务基址 */
  baseUrl: string;
  /** 缺省模型（探针 POST chat 用；空 = 依赖运行时发现） */
  model?: string;
  /** API Key 的环境变量候选（首个非空者胜出；云端平台至少一个） */
  envKeys?: string[];
  /** 基址覆盖的环境变量（registry 无此概念 —— 恒缺省；字段保留供消费面类型兼容） */
  envBase?: string;
  /** 模型覆盖的环境变量（同上，恒缺省） */
  envModel?: string;
  /** true = 本地平台（无 key 也探；includeLocal=false 时跳过） */
  localAuthOptional?: boolean;
}

/** 万脑平台预设表 —— 云端十家 + 本地三家（探针遍历此表体检）；
 *  数据单一来源投影自 registry.PLATFORM_PRESETS（十三平台花名册）。 */
export const PLATFORM_PRESETS: readonly PlatformPreset[] = REGISTRY_PRESETS.map(
  (p: RegistryPreset): PlatformPreset => ({
    label: PROBE_LABELS[p.id] ?? p.label,
    id: p.id,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    ...(p.defaultModel !== '' ? { model: p.defaultModel } : {}),
    envKeys: [...p.envKeys],
    ...(p.localAuthOptional === true ? { localAuthOptional: true } : {}),
  }),
);

/** 取首个非空环境变量（trim 后比对；全空 ⇒ ''） */
export function firstEnv(names: string[]): string {
  for (const n of names) {
    try {
      const v = process.env[n];
      if (typeof v === 'string' && v.trim() !== '') return v.trim();
    } catch { /* 环境面故障视为未设置 */ }
  }
  return '';
}

/** 按预设协议铸 provider —— 云脑三家工厂的分发面（全字段可注入，测试零联网） */
export function castPlatformProvider(args: {
  preset: PlatformPreset;
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
}): VisionProvider {
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
  if (preset.protocol === 'anthropic') return createAnthropicProvider(cfg);
  if (preset.protocol === 'gemini') return createGeminiProvider(cfg);
  return createOpenAiProvider(cfg);
}
