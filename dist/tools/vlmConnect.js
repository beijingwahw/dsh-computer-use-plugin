// src/tools/vlmConnect.ts
// 纪元 Λ（Λ-3 开箱即亮）：switch_vision_model —— 手动换脑。
// vlm_platforms 负责「看花名册」，本工具负责「当场换脑」：模型本人报一个平台 id
// （+ 可选 key/baseUrl/model），先探活（probeProvider 1x1 白图一句「回复 ok」）
// 再落档（ConnectionStore，via:'tool'）再热应用（resetGlmClient + getGlmClient
// 按新平台重铸单例 —— ask_screen 等云脑器官即刻跟脑）。
// 诚实律：探活不通绝不落档绝不报成功；热应用失败 ⇒ toolErr 且 JSDoc/错误面如实
// 注明「连接档案已写入但未生效」—— 切换失败不该谎报成功。
// 铁律：锚点一律走 toolResult 工厂；密钥只以 maskKey 打码形出现在锚点。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { toolOk, toolErr } from '../toolResult.js';
import { getGlmClient, resetGlmClient } from '../vlm/glmClient.js';
import { ConnectionStore, maskKey } from '../vlm/connection.js';
import { getPreset, PLATFORM_PRESETS, resolveProviderConfig, } from '../vlm/providers/registry.js';
import { probeProvider } from '../vlm/providers/probe.js';
import { createOpenAiProvider } from '../vlm/providers/openai.js';
import { createAnthropicProvider } from '../vlm/providers/anthropic.js';
import { createGeminiProvider } from '../vlm/providers/gemini.js';
/** 合法平台 id 清单（错误面展示用 —— 未知 id 时列出全部，绝不静默换脑） */
const LEGAL_PLATFORM_IDS = PLATFORM_PRESETS.map(p => p.id).join(', ');
/** 缺省连接档案存储（懒铸单例 —— 与 glmClient 单例同款纪律） */
let defaultStore = null;
function getDefaultStore() {
    if (defaultStore === null)
        defaultStore = new ConnectionStore();
    return defaultStore;
}
/**
 * 按预设协议铸探活用 provider —— 三家工厂的分发面（与 probe.ts 的铸法同调：
 * id/idPreset 取平台 id，defaultBaseUrl/defaultModel 取预设值，fetchImpl 可注入）。
 * 纯铸造零网络 —— 真正的探活请求由 probeProvider 发出（本地免 key 平台
 * apiKey 为空亦可铸，configured 由适配器按「key 或本地基址」判定）。
 */
function castProbeProvider(args) {
    const cfg = {
        id: args.preset.id,
        idPreset: args.preset.id,
        apiKey: args.apiKey,
        baseUrl: args.baseUrl,
        model: args.model !== '' ? args.model : undefined,
        defaultBaseUrl: args.preset.baseUrl,
        defaultModel: args.preset.defaultModel,
        fetchImpl: args.fetchImpl,
    };
    if (args.preset.protocol === 'anthropic')
        return createAnthropicProvider(cfg);
    if (args.preset.protocol === 'gemini')
        return createGeminiProvider(cfg);
    return createOpenAiProvider(cfg);
}
/** 安全取字符串入参（非字符串/缺席 ⇒ ''） */
function str(v) {
    return typeof v === 'string' ? v.trim() : '';
}
export function createSwitchVisionModelTool(_config, deps = {}) {
    return defineTool({
        name: 'switch_vision_model',
        description: 'Switches the active vision model (the "brain" behind ask_screen and VLM organs) to another platform, ' +
            'with a live health probe FIRST: the platform is pinged with one tiny 1x1-image chat before anything changes. ' +
            'Only a platform that answers is adopted — the connection profile is persisted (via:"tool") and the global ' +
            'client is re-minted hot, so ask_screen follows the new brain immediately. Use it after vlm_platforms shows ' +
            'a healthy candidate, or to pin a specific model/baseUrl. Call vlm_wizard instead when the user has no key yet.',
        parameters: {
            platform: {
                type: 'string', required: true,
                description: 'Platform id to switch to — one of: ' + LEGAL_PLATFORM_IDS +
                    ' (see vlm_platforms for labels). Unknown ids are refused with the legal list.',
            },
            api_key: {
                type: 'string',
                description: 'API key for the platform. Optional: falls back to the platform\'s env key ' +
                    '(e.g. OPENAI_API_KEY) when omitted; local platforms (ollama/lmstudio/vllm) need none. ' +
                    'Never echoed back in full — the anchor shows a masked form only.',
            },
            base_url: {
                type: 'string',
                description: 'Custom service base URL (e.g. a self-hosted gateway). Optional: defaults to the ' +
                    'platform preset URL.',
            },
            model: {
                type: 'string',
                description: 'Model name to pin (e.g. "gpt-4o", "qwen-vl-max"). Optional: defaults to the ' +
                    'platform preset model; runtime discovery platforms (lmstudio/vllm) resolve it server-side.',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
            try {
                const platformArg = str(args.platform);
                if (platformArg === '') {
                    return toolErr('switch_vision_model validation failed.', 'Empty platform argument.', `Provide one of: ${LEGAL_PLATFORM_IDS}.`);
                }
                // 1) 校验：getPreset 查表，未知 id 诚实列出全部合法 id（绝不静默换脑）
                const preset = getPreset(platformArg);
                if (!preset) {
                    return toolErr(`switch_vision_model refused: unknown platform '${platformArg}'.`, `Unknown platform id '${platformArg}'. Legal ids: ${LEGAL_PLATFORM_IDS}.`, 'Call vlm_platforms (no args, offline listing) to see the roster with labels and default models, then retry with a legal id.');
                }
                // 2) 物料解析：opts 显式值 > 平台 env 键 > 预设缺省（resolveProviderConfig
                //    路 1 —— 单一仲裁源；本地免 key 平台 apiKey 合法为空）
                const resolved = resolveProviderConfig({
                    provider: platformArg,
                    apiKey: str(args.api_key),
                    baseUrl: str(args.base_url),
                    model: str(args.model),
                });
                if (!resolved) {
                    // 理论不可达（preset 已校验）；守不抛铁律仍诚实收敛
                    return toolErr('switch_vision_model failed.', 'provider config resolution returned null.', 'Retry once; if it persists, report the platform id and call vlm_wizard to configure via the browser wizard.');
                }
                // 3) 探活：按 preset.protocol 铸 provider（fetchImpl 可注入）→ probeProvider
                //    （1x1 白图一句「回复 ok」，15s 超时；本地免 key 平台直探回环）
                const provider = castProbeProvider({
                    preset,
                    apiKey: resolved.apiKey,
                    baseUrl: resolved.baseUrl,
                    model: resolved.model,
                    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
                });
                const prober = deps.probe ?? ((p) => probeProvider(p));
                const probe = await prober(provider);
                if (!probe.ok) {
                    return toolErr('switch_vision_model failed.', `probe of '${preset.id}' failed: ${probe.detail}`, 'Nothing was switched. Fix the api_key/base_url/model and retry; if the user has no working key yet, ' +
                        'call vlm_wizard to open the browser connection wizard (it walks the user through platform + key setup).');
                }
                // 4) 落档：ConnectionStore 持久化（via:'tool' —— 与 wizard/auto-adopt 同册）
                const store = deps.store ?? getDefaultStore();
                const conn = {
                    platform: preset.id,
                    ...(resolved.apiKey !== '' ? { apiKey: resolved.apiKey } : {}),
                    baseUrl: resolved.baseUrl,
                    ...(resolved.model !== '' ? { model: resolved.model } : {}),
                    updatedAt: Date.now(),
                    via: 'tool',
                };
                const saved = store.save(conn);
                if (!saved.ok) {
                    return toolErr('switch_vision_model failed.', `persisting the connection profile failed: ${saved.error ?? 'unknown error'}`, 'The platform probed OK but the profile was not written — nothing was switched. Check disk/permissions ' +
                        'and retry, or call vlm_wizard to configure via the browser wizard.');
                }
                // 5) 热应用：重铸全局单例 —— 缺省 resetGlmClient + getGlmClient（按平台铸
                //    新脑；apiKey/baseUrl/model 缺席字段由 getGlmClient 内部走 env/预设回退）。
                //    序：save → apply → toolOk。apply 抛错 ⇒ toolErr 且如实注明存档已写
                //    （诚实律：切换失败不该谎报成功）。
                const applyOpts = {
                    platform: preset.id,
                    ...(str(args.api_key) !== '' ? { apiKey: str(args.api_key) } : {}),
                    ...(str(args.base_url) !== '' ? { baseUrl: str(args.base_url) } : {}),
                    ...(str(args.model) !== '' ? { model: str(args.model) } : {}),
                };
                const apply = deps.apply ?? ((o) => {
                    resetGlmClient();
                    getGlmClient(o);
                });
                try {
                    await apply(applyOpts);
                }
                catch (error) {
                    return toolErr('switch_vision_model failed.', `hot-apply failed after the profile was persisted: ${error?.message ?? 'unknown error'}`, 'The connection profile IS saved (it will be adopted on next start), but the live client was not switched ' +
                        '— retry switch_vision_model once; if it persists, restart the session or call vlm_wizard to reconfigure.');
                }
                // 6) 回执：实际生效模型 = 显式 model || 预设缺省（运行时发现平台可为 ''）
                const effModel = resolved.model !== '' ? resolved.model : preset.defaultModel;
                return toolOk(`switch_vision_model: active vision brain switched to ${preset.label} (${preset.id}` +
                    (effModel !== '' ? `, model ${effModel}` : ', model runtime-discovered') +
                    `) — probed ok in ${probe.latencyMs}ms, profile persisted, applied hot.`, {
                    platform: preset.id,
                    model: effModel,
                    latency_ms: probe.latencyMs,
                    masked_key: maskKey(resolved.apiKey !== '' ? resolved.apiKey : undefined),
                    persisted: true,
                }, 'Verify the new brain answers: call vlm_platforms with probe=true (active_platform should now be ' +
                    `${preset.id}), or ask_screen a question about the current screen. To change brains again just call ` +
                    'switch_vision_model with another platform id.');
            }
            catch (error) {
                return toolErr('switch_vision_model failed.', error?.message ?? 'unknown error', 'The switch pipeline failed before anything was changed — check the arguments and retry once; ' +
                    'if the user has no key yet, call vlm_wizard to configure via the browser wizard.');
            }
        },
    });
}
