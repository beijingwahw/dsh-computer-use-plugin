import { defineTool } from '@deepseek-ai/dsh-tools';
import { onCognitionPlanReady, onDoctorVerdict, onHostToolPost, sniffFingerprint, } from './events.js';
import { sandboxLog } from './log.js';
import { SandboxEngineImpl } from './engine.js';
import { validateActionChainInput } from './actionSchema.js';
import { muscleReliability, } from './types.js';
export { SandboxEngineImpl } from './engine.js';
export { muscleReliability, resolveConsolidation, hasVerificationLayer } from './types.js';
// ΝΩ-1：宿主执行器适配层公开（装配产物可独立执法测试 —— dryRun 拒绝/黑名单
// 拦截/存证 marker 均在适配层执法，不依赖 cordis 宿主在场）。
export { physicalBackendHostExecutor };
export const name = 'sandbox-execution-plugin';
// 可选依赖 '?' 语法：缺席不阻断加载，相关能力诚实降级
export const inject = ['tools', 'dsh.cognition?', 'dsh.quality-doctor?'];
// D-5 替身人格（三正交段内嵌于工具描述 —— DSH 模式：工具即角色的躯壳）
const SHADOW_DOCTRINE = 'You are the Sandbox Execution Engine — the safe avatar of this digital organism in the physical world. ' +
    'THE HOST IS SACRED: everything here is virtual; replay_on_host is the ONLY exit and only passes ' +
    'the five gates (token / doctor / reliability / fingerprint / step-level safety scan — ' +
    'replays are never exempt from the approval and risk gates). ' +
    'DRILL, THEN DELIVER: errors are nutrients — captured, diagnosed, corrected, repeated; ' +
    'the conversation sees results, never sweat. ' +
    'TRUST IS A FINGERPRINT: replay starts only when the host state matches the rehearsal state; ' +
    'a stale rehearsal is a lie.';
/** ΝΩ-1：guardDryRun 在场探测。system 层的 dryRun 守卫不抛不返错（静默吞派发
 *  —— 提示词调试语义），宿主重放若把静默吞当成派发成功即是谎言，故须显式拒绝。
 *  探测原语：零量滚动 —— dryRun 在场 ⇒ guardDryRun 在 system.scroll 同步入口
 *  打印 '[dry-run] …' 后早退（零服务接触、零世界触碰）；dryRun 缺席 ⇒
 *  scrollPage(down, 0) 物理零位移（或服务报错 ⇒ 探测不可判定，如实放行，交由
 *  真实派发自己诚实归因）。'[dry-run]' 前缀全库唯一（system.ts guardDryRun 的
 *  唯一打印点）。侦听只覆盖同步调用窗（JS 单线程，无异步交错窗口）；转发原
 *  console.log，日志零丢失。纯探测、永不抛。 */
function guardDryRunPresent(sys) {
    let hit = false;
    const orig = console.log;
    console.log = (...args) => {
        if (typeof args[0] === 'string' && args[0].startsWith('[dry-run]'))
            hit = true;
        return orig(...args);
    };
    try {
        sys.system.scroll('down', 0).catch(() => { });
    }
    catch {
        /* 同步抛 = 不可判定：后续真实派发自会诚实归因 */
    }
    finally {
        console.log = orig;
    }
    return hit;
}
/** ΝΩ-1：无机械动作的步（noop / dismiss_popup 模型侧占位）—— 无派发即无
 *  guardDryRun 吞没风险，免探测免审计（与宿主 replayOne 的无害占位同律）。 */
const NON_PHYSICAL_KINDS = new Set(['noop', 'dismiss_popup']);
function physicalBackendHostExecutor(sys, markerSink) {
    const S = sys.system; // 宿主系统层唯一事实源（黑名单/dryRun/ioMutex 全在內）
    const fail = (note) => ({ ok: false, note });
    const done = (note) => ({ ok: true, note });
    const num01 = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
    /** ΝΩ-1：单步派发的宿主账本存证（三态 + 脱敏；fail-open 绝不抛） */
    const audit = (action, result, redacted = {}) => {
        try {
            const p = markerSink.appendMarker({
                kind: 'SANDBOX_HOST_REPLAY', action, result,
                ...(redacted.point !== undefined ? { point: redacted.point } : {}),
                ...(redacted.charCount !== undefined ? { charCount: redacted.charCount } : {}),
            });
            if (p && typeof p.catch === 'function')
                p.catch(() => { });
        }
        catch { /* fail-open：审计通道故障绝不拦截已过五门的重放派发 */ }
    };
    return {
        async executeAction(action) {
            const a = action.args ?? {};
            const kindLabel = typeof action?.kind === 'string'
                ? action.kind : 'unknown';
            // 脱敏参数面（GUARD_PROBE 同律）：归一化坐标（沙箱方言的区域定位事实）+
            // 字符计数（长度事实）；文本/关键词/热键和弦/令牌零明文。
            const redacted = {};
            let ret;
            let result;
            try {
                // ΝΩ-1 dryRun 前置拒绝（诚实报错）：物理步在 dryRun 宿主上派发必被
                // guardDryRun 静默吞没 —— 拒绝并归因，绝不把"被吞"报告成"已交付"。
                if (!NON_PHYSICAL_KINDS.has(kindLabel) && guardDryRunPresent(sys)) {
                    ret = fail('host replay refused: host is in dry-run mode (guardDryRun would '
                        + 'silently swallow the dispatch) — rehearsal must not be reported as delivery');
                    result = 'failed';
                }
                else {
                    switch (kindLabel) {
                        case 'click_mouse': {
                            const x = num01(a.x), y = num01(a.y);
                            if (x === null || y === null) {
                                ret = fail('click_mouse requires finite x/y in [0,1]');
                                break;
                            }
                            const button = a.button === 'right' || a.button === 'middle' ? a.button : 'left';
                            redacted.point = { x, y };
                            // 尺寸只取一次（replayOneTraced 同律：两次独立异步读在分辨率切换
                            // 间隙会用不同比例映射 x/y）；像素域换算后由 system 内部再归一化
                            const s = await S.getScreenSize();
                            await S.clickMouse(x * s.width, y * s.height, button);
                            ret = done(`clicked (${x.toFixed(3)},${y.toFixed(3)}) ${button}`);
                            break;
                        }
                        case 'type_text': {
                            if (typeof a.text !== 'string') {
                                ret = fail('type_text requires string text');
                                break;
                            }
                            redacted.charCount = a.text.length; // 只记长度，内容零明文（脱敏纪律）
                            await S.typeText(a.text, a.clearFirst === true);
                            ret = done(`typed ${a.text.length} char(s)${a.clearFirst === true ? ' (cleared first)' : ''}`);
                            break;
                        }
                        case 'scroll_page': {
                            const amount = typeof a.amount === 'number' && Number.isFinite(a.amount) && a.amount > 0
                                ? a.amount : null;
                            if (amount === null) {
                                ret = fail('scroll_page requires finite positive amount');
                                break;
                            }
                            const direction = a.direction === 'up' || a.direction === 'left' || a.direction === 'right'
                                ? a.direction : 'down';
                            await S.scroll(direction, amount);
                            ret = done(`scrolled ${direction} x${amount}`);
                            break;
                        }
                        case 'press_hotkey': {
                            if (!Array.isArray(a.keys) || a.keys.length === 0
                                || !a.keys.every(k => typeof k === 'string')) {
                                ret = fail('press_hotkey requires non-empty string array keys');
                                break;
                            }
                            // ΝΩ-1：黑名单执法在 system 层（两条躯体之前拦截）—— 命中即抛
                            // HOTKEY_BLACKLIST_MARKER 错误，下方 catch 收敛为 ok:false 归因。
                            await S.pressHotkey(a.keys);
                            ret = done(`hotkey ${a.keys.join('+')}`);
                            break;
                        }
                        case 'drag_mouse': {
                            const sx = num01(a.startX), sy = num01(a.startY);
                            const ex = num01(a.endX), ey = num01(a.endY);
                            if (sx === null || sy === null || ex === null || ey === null) {
                                ret = fail('drag_mouse requires finite startX/startY/endX/endY in [0,1]');
                                break;
                            }
                            redacted.point = { x: ex, y: ey };
                            const s = await S.getScreenSize();
                            await S.dragMouse({ x: sx * s.width, y: sy * s.height }, { x: ex * s.width, y: ey * s.height });
                            ret = done(`dragged (${sx.toFixed(3)},${sy.toFixed(3)})→(${ex.toFixed(3)},${ey.toFixed(3)})`);
                            break;
                        }
                        case 'switch_tab': {
                            const keys = a.direction === 'previous' ? ['ctrl', 'shift', 'tab'] : ['ctrl', 'tab'];
                            await S.pressHotkey(keys);
                            ret = done(`tab switched ${a.direction === 'previous' ? 'previous' : 'next'}`);
                            break;
                        }
                        case 'switch_window': {
                            const kw = typeof a.titleKeyword === 'string' ? a.titleKeyword : '';
                            if (!kw) {
                                ret = fail('switch_window requires non-empty titleKeyword');
                                break;
                            }
                            const r = await S.switchWindowByTitle(kw);
                            if (!r || r.matched === null || r.matched === undefined) {
                                ret = fail(`no window title matched "${kw.slice(0, 60)}"`);
                                break;
                            }
                            ret = done(`window switched to ${String(r.matched).slice(0, 60)}`);
                            break;
                        }
                        case 'dismiss_popup':
                            // 纯模型侧恢复指令（无机械动作）—— 宿主 replayOne 同律：无害占位不作失败
                            ret = done('model-side recovery instruction; nothing to execute');
                            break;
                        case 'noop':
                            ret = done('noop');
                            break;
                        default:
                            ret = fail(`unsupported kind ${JSON.stringify(kindLabel)} — executor vocabulary closed`);
                    }
                    result = ret.ok ? 'ok' : 'failed';
                }
            }
            catch (e) {
                // 三态归因：黑名单拦截是政策拒绝（世界未被触碰）⇒ failed；其余派发通道
                // 异常 ⇒ threw（防御式收口，端口契约本就永不抛 —— 这是双保险层）。
                result = sys.isHotkeyBlacklistError(e) ? 'failed' : 'threw';
                ret = fail(`dispatch error: ${e?.message ?? 'unknown'}`);
            }
            if (!NON_PHYSICAL_KINDS.has(kindLabel))
                audit(kindLabel, result, redacted);
            return ret;
        },
    };
}
export async function apply(ctx, config) {
    console.log('[Sandbox] Initializing Sandbox Execution Engine (D-5)...');
    const engine = new SandboxEngineImpl(ctx);
    // 《异常诚实分层契约》第一条（加载层）：配置非法 throw —— 拒绝带病上线；
    // 此后第二条（运行层）：一切运行时永不抛错（Result/verdict 降级）
    engine.configure(config);
    // ΑΩ-R19：宿主执行器接线（config 开关，缺省关闭 = 开发者预览语义零回归 ——
    // 四门全过仍诚实 failed "no host executor wired"）。懒导入根层模块：开关关闭
    // 时模块图与现状一致（装配失败也诚实降级为未接线，不阻断插件加载）。
    // ΝΩ-1：装配改经 system 安全链（黑名单 + guardDryRun + ioMutex serialize）
    // + journal（SANDBOX_HOST_REPLAY 派发存证）—— 第四条物理派发通道收编。
    if (config.enableHostReplayExecution === true) {
        try {
            const sys = await import('../system.js');
            const { journal } = await import('../journal.js');
            engine.wireHostExecutor(physicalBackendHostExecutor(sys, journal));
            console.log('[Sandbox] Host executor wired via system safety chain (hotkey blacklist '
                + '+ dryRun + ioMutex + SANDBOX_HOST_REPLAY audit markers) — five-gate replays now end in real dispatch.');
        }
        catch (e) {
            console.warn(`[Sandbox] Host executor wiring failed (${e?.message ?? e}) — `
                + 'replay stays in developer preview (honest failure).');
        }
    }
    // L 纪元（服务归属决策）：D-5 是 'dsh.sandbox' 的天然属主 —— 向总线自荐注册
    // 引擎视图（rehearse/recall/replay 面由 SandboxStationView 等消费方言定义）。
    // 宿主无 set 面 ⇒ 注册不成立，消费方（D-6 探测）保持既有诚实降级；决策成文。
    try {
        ctx.set?.('dsh.sandbox', {
            rehearse: (chain) => engine.rehearse(chain),
            recall: (q) => engine.recallMuscleMemory(q),
            replayOnHost: (id, o) => engine.replayOnHost(id, o),
        });
        console.log('[Sandbox] service self-registered as dsh.sandbox (host bus accepted).');
    }
    catch { /* 注册失败 = 旁路义务：消费方降级路径不变 */ }
    sandboxLog.configure(config.reportDir ? `${config.reportDir}/sandbox-log.jsonl` : '', 2000);
    // ── 事件总线接线（与 D-1/D-4/宿主管线的唯一咬合通道）──
    // D-1 计划投喂：候选链到达即入排练（DRILL）。
    // P0-3 联合方言纪律：plan-ready 载荷可能是 chain（D-5 需求）或 intent 双方言
    // （D-6/D-7 主权）—— D-5 只排练链臂，意图臂静默让渡（主权边界，不是故障）。
    onCognitionPlanReady(ctx, payload => {
        if (!('chain' in payload) || !payload.chain)
            return;
        void engine.receivePlan(payload.chain).then(outcome => {
            console.log(`[Sandbox] Rehearsed plan ${outcome.chainId}: verdict=${outcome.verdict} ` +
                `steps=${outcome.steps.length} latency=${outcome.totalLatencyMs}ms report=${outcome.reportPath}`);
        }).catch(e => {
            // 观察者义务：排练崩溃不得变成 unhandled rejection 击穿宿主进程
            console.warn(`[Sandbox] Plan rehearsal crashed: ${e?.message ?? e}`);
        });
    });
    // D-4 判决回执：入缓存（双闸门复核 + 重放时刻否决源）+ 与最近排练结果
    // 配对走 consolidate（肌肉记忆写入路径：passed + approved ⇒ 固化入库）
    onDoctorVerdict(ctx, payload => {
        engine.noteDoctorVerdict(payload);
        const r = engine.tryConsolidate(payload);
        if (r.ok && r.value) {
            console.log(`[Sandbox] Muscle memory consolidated: ${r.value.id} ` +
                `(${r.value.steps.length} steps, trigger="${r.value.trigger.slice(0, 60)}")`);
        }
    });
    // 宿主管线观察（纯观察透传）：嗅探屏指纹 —— TRUST IS A FINGERPRINT 的镜像源头
    onHostToolPost(ctx, (_call, result) => {
        engine.noteHostObservation(sniffFingerprint(result));
    });
    // 可选服务在场探测（dsh.quality-doctor：只持句柄不读全文 —— Token 纪律）
    const doctor = ctx.get('dsh.quality-doctor');
    console.log(doctor
        ? '[Sandbox] Quality doctor service detected — verdicts will be honored.'
        : '[Sandbox] Quality doctor service absent — consolidation defaults to freeze-for-review (honest degradation).');
    // ── 演武工具面（对话流只见紧凑数字）──
    ctx.tools.register(defineTool({
        name: 'rehearse_chain',
        description: SHADOW_DOCTRINE + ' Rehearse an action chain in the virtual sandbox. ' +
            'Returns compact numbers only (verdict, steps, latency, score); full evidence goes to reportPath.',
        parameters: {
            actions: {
                type: 'string', required: true,
                description: 'JSON array of actions: [{"kind":"click_mouse","args":{"x":0.5,"y":0.5},'
                    + '"expect":{"scale":"element-level","expectedText":"Sign in"}}] '
                    + '(kinds: click_mouse|type_text|scroll_page|press_hotkey|drag_mouse|switch_tab|switch_window|dismiss_popup|noop)',
            },
            budget_ms: {
                type: 'number',
                description: 'Optional wall-clock budget; on expiry the rehearsal aborts gracefully with partial trajectory.',
            },
        },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: "text", text: v }] },
        async execute(args) {
            try {
                // ΑΩ-R19：入参执法升级 —— JSON 合法性 + 动作 schema（kind 闭集 / 坐标
                // 值域 [0,1] / 字符串与数量上限）双闸。非法条目整链拒绝，拒绝原因如实
                // 入结果（运行层铁律：不抛 —— 校验器本身也永不抛）。
                const parsed = JSON.parse(args.actions);
                const schema = validateActionChainInput(parsed);
                if (!schema.ok) {
                    return JSON.stringify({ status: 'FAILED', reason: `actions schema rejected: ${schema.reason}` });
                }
                const actions = schema.actions;
                const chain = {
                    id: `chain-manual-${Date.now().toString(36)}`,
                    actions,
                    budgetMs: typeof args.budget_ms === 'number' ? args.budget_ms : undefined,
                    origin: 'manual',
                };
                const o = await engine.rehearse(chain);
                // 紧凑数字战报（Token 纪律）：全量证据在 reportPath
                return JSON.stringify({
                    status: 'SUCCESS',
                    verdict: o.verdict,
                    chain_id: o.chainId,
                    steps: o.steps.length,
                    failed_at: o.failedAtIndex,
                    total_latency_ms: o.totalLatencyMs,
                    budget_ms: o.budgetMs,
                    score: o.score,
                    verification_layers: o.verificationLayers,
                    chain_tip: o.chainTip,
                    report: o.reportPath,
                });
            }
            catch (e) {
                return JSON.stringify({ status: 'FAILED', reason: `malformed input: ${e.message}` });
            }
        },
    }));
    ctx.tools.register(defineTool({
        name: 'recall_muscle',
        description: 'Recall muscle memory entries by natural-language query (prior, not guarantee — '
            + 'every replay still passes the four gates). Ranked by text overlap × reliability + scene bonus + recency.',
        parameters: {
            query: { type: 'string', required: true, description: 'Natural language query.' },
        },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: "text", text: v }] },
        async execute(args) {
            const r = engine.recallMuscleMemory(String(args.query ?? ''));
            if (!r.ok)
                return JSON.stringify({ status: 'FAILED', reason: r.reason });
            return JSON.stringify({
                status: 'SUCCESS',
                hits: r.value.map(e => ({
                    id: e.id,
                    trigger: e.trigger,
                    steps: e.steps.length,
                    reliability: Number(muscleReliability(e).toFixed(3)),
                    rehearsal_passes: e.rehearsalPassCount,
                    host_replays: e.hostReplayCount,
                })),
            });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'replay_on_host',
        description: SHADOW_DOCTRINE + ' Request host replay of a muscle-memory entry. '
            + 'Phase 1: omit confirm_token to obtain a pending token. Phase 2: re-call with the token. '
            + 'Five gates: token / doctor verdict / reliability threshold / entry-scene fingerprint match / '
            + 'step-level safety scan (dangerous steps need a granted approval_token in step args).',
        parameters: {
            entry_id: { type: 'string', required: true, description: 'Muscle memory entry id.' },
            confirm_token: {
                type: 'string',
                description: 'Omit in phase 1 to get a token; include in phase 2 to attempt the replay.',
            },
        },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: "text", text: v }] },
        async execute(args) {
            const entryId = String(args.entry_id ?? '');
            if (!args.confirm_token) {
                const token = engine.requestReplayToken(entryId);
                return JSON.stringify({
                    status: 'PENDING_USER_CONSENT',
                    entry_id: entryId,
                    token,
                    note: 'Re-call replay_on_host with confirm_token to pass the gates (TTL 120s).',
                });
            }
            const outcome = await engine.replayOnHost(entryId, { confirmToken: String(args.confirm_token) });
            return JSON.stringify({
                status: outcome.verdict === 'confirmed' ? 'SUCCESS' : 'FAILED',
                verdict: outcome.verdict,
                muscle_memory_id: outcome.muscleMemoryId,
                divergences: outcome.divergences.length,
                reliability_after: Number(outcome.reliabilityAfter.toFixed(3)),
                journal_refs: outcome.journalRefs.length,
                report: outcome.reportPath,
            });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'verify_sandbox_log',
        description: 'Verify the append-only hash chain of the sandbox session log (tamper-evidence audit).',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: "text", text: v }] },
        async execute() {
            // L 纪元：hasVerificationLayer 从死导出升级为活引用 —— 审计面携带四层
            // 在场性判据说明（该函数对任意 RehearsalOutcome 可用；此处声明判据就绪性）。
            const layerGuide = ['L1-pixel', 'L2-diff', 'L3-semantic', 'L4-expectation']
                .map(l => `${l}: 判据就绪(hasVerificationLayer)`).join(' | ');
            const r = engine.verifyLog();
            if (!r.ok)
                return JSON.stringify({ status: 'FAILED', reason: r.reason });
            return JSON.stringify({
                status: 'SUCCESS',
                chain_intact: r.value.ok,
                entries: r.value.length,
                broken_at: r.value.brokenAt,
                verification_layers: layerGuide,
            });
        },
    }));
    console.log('[Sandbox] 4 rehearsal tools registered (rehearse_chain / recall_muscle / replay_on_host / verify_sandbox_log).');
    // ── 可逆注册：一切资源登记清理（Cordis 注册即效果模型）──
    ctx.effect(() => {
        console.log('[Sandbox] Unloading, rolling back resources...');
        return () => {
            // 持久化资产先行落盘（肌肉记忆的寿命长于会话）；账本随 JSONL 已增量落盘
            engine.persistMemory(); // 必须先于 reset（内存态归零后无可存）
            engine.reset(); // 内存态归零：记忆/令牌/判决缓存/待配对面/观察缓存/账本窗口
            console.log('[Sandbox] Unloaded. Zero residue.');
        };
    });
    console.log('[Sandbox] Initialization complete! The host remains untouched until all gates open.');
}
