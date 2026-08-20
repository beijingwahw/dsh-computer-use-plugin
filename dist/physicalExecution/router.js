import { PhysicalErrorKind } from './contracts.js';
import { CapabilityCache, syncCapabilityFromSwitchWindowResult, } from './capabilityCache.js';
/** 默认操作延迟（用于 noop 与延迟路径） */
const NOOP_LATENCY_MS = 0;
/** D-5 物理执行路由器实现 */
export class PhysicalActionRouterImpl {
    _capability;
    adapter;
    constructor(adapter, capability) {
        this.adapter = adapter;
        this._capability = capability ?? new CapabilityCache();
    }
    /** 暴露 capability cache 给调用方（启动期探活后 sync） */
    get capability() {
        return this._capability;
    }
    /** 运行层方法：永不抛错 —— 失败入 ExecutionResult.failure */
    async dispatch(action, seq) {
        const startedAt = Date.now();
        // noop：直接返回，不调用微服务
        if (action.kind === 'noop') {
            return {
                seq,
                effectDetected: null,
                latencyMs: NOOP_LATENCY_MS,
                rehearsed: false,
            };
        }
        try {
            const result = await this.route(action);
            const latencyMs = Date.now() - startedAt;
            if (!result.ok) {
                return this.toFailureResult(seq, latencyMs, result.error);
            }
            return {
                seq,
                effectDetected: null,
                latencyMs,
                rehearsed: false, // 真 deliver，非预演
            };
        }
        catch (e) {
            // 理论不可达：adapter 已是 Result 降级；此处仅兜底
            const latencyMs = Date.now() - startedAt;
            return {
                seq,
                effectDetected: false,
                latencyMs,
                rehearsed: false,
                failure: {
                    kind: 'host-error',
                    detail: `router unexpected error: ${e?.message ?? 'unknown'}`,
                },
            };
        }
    }
    /** 单动作路由 —— 派发到对应 adapter 方法 */
    async route(action) {
        switch (action.kind) {
            case 'click_mouse': {
                const args = action.args ?? {};
                return this.adapter.clickMouse({
                    x: num(args.x, 0.5),
                    y: num(args.y, 0.5),
                    button: asButton(args.button),
                    dryRun: bool(args.dry_run),
                });
            }
            case 'type_text': {
                const args = action.args ?? {};
                return this.adapter.typeText({
                    text: typeof args.text === 'string' ? args.text : '',
                    clearFirst: bool(args.clear_first ?? args.clearFirst),
                    dryRun: bool(args.dry_run),
                });
            }
            case 'scroll_page': {
                const args = action.args ?? {};
                return this.adapter.scrollPage({
                    direction: asDirection(args.direction),
                    amount: num(args.amount, 3),
                    dryRun: bool(args.dry_run),
                });
            }
            case 'press_hotkey': {
                const args = action.args ?? {};
                const keys = Array.isArray(args.keys) ? args.keys.filter((k) => typeof k === 'string') : [];
                return this.adapter.pressHotkey({ keys, dryRun: bool(args.dry_run) });
            }
            case 'drag_mouse': {
                const args = action.args ?? {};
                const start = args.start ?? { x: args.startX, y: args.startY };
                const end = args.end ?? { x: args.endX, y: args.endY };
                return this.adapter.dragMouse({
                    start: { x: num(start?.x, 0), y: num(start?.y, 0) },
                    end: { x: num(end?.x, 0), y: num(end?.y, 0) },
                    dryRun: bool(args.dry_run),
                });
            }
            case 'switch_tab': {
                // 降级为 Ctrl+Tab（Mac 上 Cmd+Tab 切换应用，Ctrl+Tab 切换标签页）
                const mod = process.platform === 'darwin' ? 'cmd' : 'ctrl';
                return this.adapter.pressHotkey({ keys: [mod, 'tab'] });
            }
            case 'switch_window': {
                const args = action.args ?? {};
                const keyword = typeof args.keyword === 'string' ? args.keyword : '';
                const route = this._capability.switchWindowRoute();
                // 路径 1：hotkey_only 或缺 keyword —— 直接走 hotkey 快速路径（跳过一次网络往返）
                if (route === 'hotkey_only' || !keyword) {
                    const mod = process.platform === 'darwin' ? 'cmd' : 'alt';
                    return this.adapter.pressHotkey({ keys: [mod, 'tab'] });
                }
                // 路径 2：unavailable —— 直接返回错误，不发请求
                if (route === 'unavailable') {
                    return {
                        ok: false,
                        error: {
                            kind: PhysicalErrorKind.WINDOW_UNAVAILABLE,
                            detail: 'window management is unavailable (check health)',
                        },
                    };
                }
                // 路径 3：native 或 unknown —— 调 /v1/switch_window，让 Python 端处理失败降级
                const result = await this.adapter.switchWindow({ keyword });
                if (result.ok) {
                    // Reactive 同步：Python 端可能 fallback 到 hotkey_only（method 变化时立即更新缓存）
                    syncCapabilityFromSwitchWindowResult(this._capability, result.value);
                    return result;
                }
                // 请求失败：若是 capability 探测过的 native 失败，回退到 hotkey（防硬阻塞）
                if (route === 'native' && result.error.kind !== PhysicalErrorKind.WINDOW_UNAVAILABLE) {
                    const mod = process.platform === 'darwin' ? 'cmd' : 'alt';
                    const hotkeyResult = await this.adapter.pressHotkey({ keys: [mod, 'tab'] });
                    if (hotkeyResult.ok) {
                        // 降级成功：标记能力为 hotkey_only（Reactive 同步）
                        this._capability.updateSwitchWindowMethod('hotkey_only');
                    }
                    return hotkeyResult;
                }
                return result;
            }
            case 'dismiss_popup': {
                // 降级为 Esc
                return this.adapter.pressHotkey({ keys: ['esc'] });
            }
            case 'noop':
                return { ok: true, value: undefined };
            default:
                return {
                    ok: false,
                    error: {
                        kind: PhysicalErrorKind.INVALID_ARGS,
                        detail: `unknown action kind: ${action.kind}`,
                    },
                };
        }
    }
    /** PhysicalError → ExecutionResult.failure 映射 */
    toFailureResult(seq, latencyMs, error) {
        return {
            seq,
            effectDetected: false,
            latencyMs,
            rehearsed: false,
            failure: {
                kind: this.mapErrorKind(error.kind),
                detail: `[${error.kind}] ${error.detail}`,
            },
        };
    }
    /** PhysicalErrorKind → ExecutionFailureKind 映射（对齐 D-7 §173） */
    mapErrorKind(kind) {
        switch (kind) {
            case 'client_timeout':
            case 'action_timeout':
                return 'timeout';
            case 'transport_error':
            case 'internal_error':
            case 'unauthorized':
            case 'invalid_args':
            case 'out_of_bounds':
            case 'unknown_button':
            case 'unknown_key':
            case 'element_not_found':
            case 'screen_capture_failed':
            case 'ocr_unavailable':
            case 'vlm_unavailable':
            case 'window_unavailable':
                return 'host-error';
            default:
                return 'host-error';
        }
    }
}
// ─── 类型守卫 / 安全转换（容错的 args 解析）───
function num(v, fallback) {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function bool(v) {
    return typeof v === 'boolean' ? v : undefined;
}
function asButton(v) {
    return v === 'left' || v === 'right' || v === 'middle' ? v : undefined;
}
function asDirection(v) {
    return v === 'up' || v === 'down' || v === 'left' || v === 'right' ? v : 'down';
}
