// src/tools/vlmPlatforms.ts
// 纪元 Ψ（万脑归一工具面）：vlm_platforms —— 平台花名册与体检。
// 把 registry 的十三平台挂号表（云脑十家 + 本地三家）对模型本人开放：
// 无参 = 离线清单（id/label/protocol/configured/defaultModel）；
// probe=true = 对 configured 平台并行 probeProvider（1x1 白图一句「回复 ok」，
// 15s 超时）附健康；另附当前生效平台（只读窥探，绝不铸造单例）与备选池健康。
// 铁律：锚点一律走 toolResult 工厂；体检失败诚实 toolErr —— 绝不抛、绝不伪报。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { toolOk, toolErr } from '../toolResult.js';
import { peekGlmPlatform } from '../vlm/glmClient.js';
import { getProviderPool } from '../vlm/index.js';
import { listPlatforms } from '../vlm/providers/registry.js';
import { probeAllPlatforms } from '../vlm/providers/probe.js';
export function createVlmPlatformsTool(_config, deps = {}) {
    return defineTool({
        name: 'vlm_platforms',
        description: 'Lists all supported vision-model platforms (13 brains: 10 cloud + 3 local) with protocol, ' +
            'configured state (env keys present) and default model. Set probe=true to health-check the ' +
            'CONFIGURED platforms in parallel (one tiny 1x1-image chat each, 15s timeout) and also report ' +
            'the currently active platform and the fallback-pool health. Use it to pick or verify a brain ' +
            'before relying on ask_screen. Read-only — probing never sends real screen content, only a blank pixel.',
        parameters: {
            probe: {
                type: 'boolean',
                description: 'Health-probe configured platforms (parallel, ~15s timeout each, real network). ' +
                    'Default false = offline listing only (zero network).',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
            try {
                const probe = args.probe === true;
                const lister = deps.lister ?? listPlatforms;
                const platforms = lister().map(p => ({
                    id: p.id,
                    label: p.label,
                    protocol: p.protocol,
                    default_model: p.defaultModel,
                    configured: p.configured === true,
                    ...(p.notes ? { notes: p.notes } : {}),
                }));
                const configuredCount = platforms.filter(p => p.configured).length;
                // 当前生效平台（只读窥探 —— 不铸造单例）+ 备选池健康（未铸池则缺省）
                const active = peekGlmPlatform();
                const pool = getProviderPool();
                const anchor = {
                    platform_count: platforms.length,
                    platforms,
                    active_platform: {
                        platform: active.platform,
                        configured: active.configured,
                        minted: active.minted,
                    },
                    ...(pool !== null
                        ? { fallback_pool: { ids: pool.ids, health: pool.health() } }
                        : {}),
                };
                if (probe) {
                    const prober = deps.prober ?? probeAllPlatforms;
                    const results = await prober(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : undefined);
                    const healthy = results.filter(r => r.ok).length;
                    anchor.probe = results.map(r => ({
                        id: r.id,
                        label: r.label,
                        ok: r.ok,
                        latency_ms: r.latencyMs,
                        vision_guessed: r.visionGuessed,
                        detail: r.detail,
                    }));
                    return toolOk(`vlm_platforms: probed ${results.length} configured platform(s), ${healthy} healthy.`, { ...anchor, probed: results.length, healthy }, results.length === 0
                        ? 'No configured platform was probed (no env keys, local platforms included) — set a platform API key in env ' +
                            '(e.g. OPENAI_API_KEY / ANTHROPIC_API_KEY / GLM_API_KEY) or configure vlmProvider, then re-probe.'
                        : 'Healthy platforms can serve ask_screen / grounding now. For unhealthy ones read "detail" (timeout/HTTP/未配置), ' +
                            'fix the key or baseUrl, then re-probe. Probing sends only a blank 1x1 pixel, never real screen content.');
                }
                return toolOk(`vlm_platforms: listed ${platforms.length} platform(s), ${configuredCount} configured.`, { ...anchor, configured: configuredCount }, 'This is an offline listing (zero network). To verify a brain actually answers, call again with probe=true. ' +
                    'To switch brains, set vlmProvider (or the platform env key) and re-configure — ask_screen and the VLM organs ' +
                    'follow the active platform automatically.');
            }
            catch (error) {
                return toolErr('vlm_platforms failed.', error?.message ?? 'unknown error', 'The listing/probe pipeline failed — fall back to env inspection (GLM_API_KEY / OPENAI_API_KEY / ...) and retry once.');
            }
        },
    });
}
