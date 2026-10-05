// src/guards/hostToolPolicy.ts
// ΑΝΒ-7（决策 D9 升维）：考核纪律 fail-closed 事前拦截 —— 把 R3-4 的
// 「提示词纪律 + anti-cheat 事后检测」升维为宿主通道上的**事前**工具面闭集。
//
// 立法位（DECISIONS.md §D9 / R3-4.md §3c）：宿主 ToolRegistry 的
// `ctx.tools.guard(exec => string | undefined)` 通道实证存在（dsh-tools
// 0.0.1-rc.1 源码实证，R3-4 §3c）—— 返回字符串即拒该次执行，undefined 放行，
// 全局生效，返回 disposer 可回收。D9 当役推荐 B（维持现状）的根因是「启用会
// 改变宿主会话行为 + 133 拍零实锤不支持紧迫性」；本模块把能力铸成成品而以
// opt-in 缺省关立法：**能力现在就有、语义零变更、启用权在配置**
//（config.benchDiscipline，缺省 false ⇒ 本模块零行为）。
//
// 纪律（与全守卫族同律）：
//   · 绝不抛 —— 通道缺席/通道故障一律诚实降级（log 一行），不炸插件装载；
//   · fail-closed 拦截语义 —— 白名单外（宿主 shell/文件/代码执行/未知）一律拒
//     （D9 选项 C 的「只挡白名单外，不挡内」）；
//   · 缺省关零回归 —— benchDiscipline !== true 时本模块对 ctx 零调用。
//
// 接线（归 ΑΝΒ-4，本工位不碰 src/index.ts）：见文件尾「一行接线说明书」。
// ─── ΑΝΒ-7: 插件工具闭集（白名单之本体） ───
/** ΑΝΒ-7: barrel 外注册面 —— 不经 buildAllTools 装配、由组合根/沙箱栈直注册的
 *  插件自有工具（index.ts 的 start_complex_task + sandbox/apply.ts 的演武四件；
 *  replay_on_host 同时在 barrel 二分类名册内 —— Set 去重后闭集仍 50 件）。
 *  漏列任何一件 = 启用纪律后误拦自家工具（D9-A 的回归风险面）—— 同源测试
 *  锁 ② 以「全开配置装配面 + 本名单 ⊆ 放行闭集」把住（barrel 全开实配 45 件
 *  + 本名单 5 件 = 50 件闭集全覆盖）。 */
export const NON_BARREL_PLUGIN_TOOLS = Object.freeze([
    'start_complex_task', // src/index.ts 第 4 步直注册的元工具（Planner-Actor 编排入口）
    'rehearse_chain', // ΤΕΛ-8a 沙箱栈：链排练
    'recall_muscle', // ΤΕΛ-8a 沙箱栈：肌肉记忆召回
    'replay_on_host', // ΤΕΛ-8a 沙箱栈：宿主重放（在 barrel 名册 ∈ MUTATING，但实配注册在沙箱面）
    'verify_sandbox_log', // ΤΕΛ-8a 沙箱栈：演武账本核验
]);
/**
 * ΑΝΒ-7: 插件工具白名单（闭集本体）—— bench/anti-cheat.mjs PLUGIN_TOOL_NAMES
 * 的 src 侧逐名镜像（50 件：barrel 二分类名册 46 名 ∪ NON_BARREL_PLUGIN_TOOLS
 * 5 名，replay_on_host 两处交叠去重）。与 anti-cheat 七分类的 'plugin' 面
 * 同一词表：本闭集内的名字 = 纯插件作业步，anti-cheat 侧判 pure 的分子。
 */
export const PLUGIN_TOOL_ALLOWLIST = new Set([
    // ── 变更类镜像（src/tools/index.ts MUTATING_TOOL_NAMES，19 件）──
    'click_mouse', 'click_element', 'drag_mouse', 'scroll_page', 'type_text', 'press_hotkey',
    'switch_tab', 'switch_window', 'open_url', 'replay_actions', 'run_skill',
    'shape_environment', 'autonomous_run', 'autonomy_resume', 'save_skill',
    'save_checkpoint', 'switch_vision_model', 'vlm_wizard', 'replay_on_host',
    // ── 只读/控制面镜像（src/tools/index.ts KNOWN_READ_ONLY_TOOL_NAMES，27 件）──
    'take_screenshot', 'zoom_inspect', 'diff_view', 'extract_ui_vision',
    'read_text', 'find_text', 'ask_screen', 'vlm_platforms', 'probe_interactivity',
    'metrics_dashboard', 'verify_journal', 'get_metrics', 'self_diagnose',
    'quality_checkup', 'recall_ui', 'remember_ui', 'match_skill', 'what_if',
    'swarm_report', 'swarm_dispatch', 'dismiss_popup',
    'request_approval', 'grant_approval', 'adjudicate_approval_queue',
    'steer_choice', 'steer_answer', 'federation_sync',
    // ── barrel 外注册面（NON_BARREL_PLUGIN_TOOLS，4 件）──
    ...NON_BARREL_PLUGIN_TOOLS,
]);
// ─── ΑΝΒ-7: 宿主工具七分类镜像（anti-cheat HOST_TOOL_CLASSES 同源） ───
/**
 * ΑΝΒ-7: 宿主原生工具分类表 —— bench/anti-cheat.mjs HOST_TOOL_CLASSES 的
 * src 侧逐类镜像（名册实锚：R1-8 九次跑 hist 实测 + dsh-tools 文档面推断）。
 * 拦截语义按分类裁剪（fail-closed）：
 *   · host-meta（问人/记账元面）+ host-job（作业管理 = 「session 类」只读控制面）
 *     ⇒ **放行** —— 与 anti-cheat 判定档对齐（host-meta 档「记账不判污」）；
 *   · host-shell / host-file / host-run-code ⇒ **拒** —— 反作弊的污染/实锤面
 *     （纪律前缀点名禁用的三类：命令执行、文件读写、代码执行）；宿主文件
 *     **只读**工具（read/glob/grep/list_dir）同样拒 —— 严格档口径（anti-cheat
 *     对套纪律前缀的 suite 自动切严格档，shell 只读也算污染，同律）；
 *   · 两册皆不在（host-unknown）⇒ **拒** —— 新增宿主工具/拼写变体按可疑处理
 *     （fail-closed：宁可误拦考核会话里的一次调用，绝不静默漏放一个未知面）。
 */
export const HOST_TOOL_CLASS_MIRROR = Object.freeze({
    'host-shell': Object.freeze(['pwsh', 'shell', 'exec', 'execute_command', 'run_command', 'command', 'bash', 'powershell']),
    'host-file': Object.freeze(['read', 'write', 'edit', 'multiedit', 'notebook_edit', 'apply_patch', 'list_dir', 'glob', 'grep']),
    'host-job': Object.freeze(['job_start', 'job_output', 'job_kill', 'job_wait']),
    'host-run-code': Object.freeze(['run_code']),
    'host-meta': Object.freeze(['ask_user_question', 'ask_followup_question', 'todo_write', 'task_complete']),
});
/** ΑΝΒ-7: 分类索引（名 → 类），镜像 anti-cheat 的 HOST_NAME_TO_CLASS 派生。 */
const HOST_NAME_TO_CLASS = new Map(Object.entries(HOST_TOOL_CLASS_MIRROR).flatMap(([cls, names]) => names.map((n) => [n, cls])));
/**
 * ΑΝΒ-7: 考核会话放行的宿主「session 类」只读/控制面工具 —— host-meta ∪
 * host-job 两分类的全量名（问人、任务记账、作业管理：不触任务产物面，
 * anti-cheat 对应 host-meta 判定档 —— 记账不判污）。放行名单**只经分类表
 * 派生**，不手抄：分类表变 ⇒ 放行面同步变（单源）。
 */
export const HOST_SESSION_CLASS_TOOLS = new Set([
    ...HOST_TOOL_CLASS_MIRROR['host-meta'],
    ...HOST_TOOL_CLASS_MIRROR['host-job'],
]);
/**
 * ΑΝΒ-7: benchToolVerdict —— 单个工具名 → 考核纪律判决（纯函数，镜像
 * anti-cheat classifyToolName 的分类口径 + 本模块的放行/拒绝立法）：
 *   plugin                                    ⇒ 放行（插件 50 件闭集）
 *   host-meta / host-job（session 类控制面）  ⇒ 放行（记账不判污，同源对齐）
 *   host-shell / host-file / host-run-code    ⇒ 拒（纪律前缀点名三类禁面）
 *   host-unknown（两册皆不在）                ⇒ 拒（fail-closed）
 *   空名/非字符串                             ⇒ 拒（surface 'none' —— 与
 *     anti-cheat judgeCall 把空名归 plugin 的 hist 口径**有意分歧**：那是
 *     事后记账（空名行无害），这是事前闸门（放行空名 = 放行不可判调用）。
 *     分歧在此成文，测试册锁死本侧语义）。
 */
export function benchToolVerdict(toolName) {
    const name = typeof toolName === 'string' ? toolName : '';
    if (name === '') {
        return {
            allow: false, surface: 'none',
            reason: 'bench discipline: empty tool name refused (fail-closed) — benchmarked sessions allow plugin tools and host session/meta tools only',
        };
    }
    if (PLUGIN_TOOL_ALLOWLIST.has(name))
        return { allow: true, surface: 'plugin' };
    const cls = HOST_NAME_TO_CLASS.get(name);
    if (cls === 'host-meta' || cls === 'host-job')
        return { allow: true, surface: cls };
    const surface = cls ?? 'host-unknown';
    return {
        allow: false, surface,
        reason: `bench discipline: ${surface} tool "${name}" denied — benchmarked sessions allow plugin tools + host session/meta tools only ` +
            `(host shell / file / code-execution / unknown are pre-blocked; use the plugin vision & physical tools instead)`,
    };
}
/**
 * ΑΝΒ-7: 拦截回调里读 exec 的工具名 —— R3-4 §3c 实证的宿主签名是
 * `guard(exec => exec.toolName)`；本项目既有 tools/pre-execute 事件面
 * （hooks.ts normalizeExec）用 `exec.name`。宿主版本面在演进，此处防御性
 * 三读（toolName → name → tool.name），缺席归 ''（fail-closed 拒）。
 */
function execToolName(exec) {
    const e = (exec ?? {});
    const n = e.toolName ?? e.name ?? e.tool?.name;
    return typeof n === 'string' ? n : '';
}
/**
 * ΑΝΒ-7: applyBenchDiscipline —— 考核纪律接线（组合根一行调用即成品）。
 *
 * 语义（缺省关立法 —— 语义零变更的机械保证）：
 *   · config.benchDiscipline !== true ⇒ 立即返回 disabled，**对 ctx 零调用**
 *     （不探测、不 log、不注册）—— 接线后不开启 = 与接线前逐字节等价；
 *   · true 且宿主 ctx.tools.guard 在场 ⇒ 注册 fail-closed 全局守卫
 *     （undefined 放行 / 字符串拒），disposer 经 ctx.effect 登记回收
 *     （cordis 注册即效果模型），enforced 概要一行 log（审计可见性）；
 *   · true 但通道缺席（宿主无 guard 面）⇒ 诚实降级：log 一行
 *     「benchDiscipline requested but host guard channel absent」，**绝不抛**
 *     —— 无宿主版本的部署不受罚，执法回落到提示词纪律 + anti-cheat 事后检测；
 *   · guard() 自身抛错 ⇒ 同律诚实降级（threw 档），绝不抛。
 *
 * 拦截回调自身的故障纪律：回调体内**绝不抛**（抛进宿主瀑布 = 语义不可论），
 * 分类故障 ⇒ 拒 + reason 如实注记（fail-closed：纪律闸门的故障臂关闸而非开闸
 * —— 与既有守卫族的 fail-open（可用性优先）**有意分歧**并在此成文：那些守卫
 * 守的是「别误伤正常作业」，本闸守的是「考核公正性」，两个失败方向代价不对称）。
 */
export function applyBenchDiscipline(ctx, config) {
    // ΑΝΒ-7: 缺省关零回归 —— 唯一的早退门（不开启 = 零行为）。
    if (config.benchDiscipline !== true) {
        return { status: 'disabled', note: 'benchDiscipline off (default) — prompt discipline + post-hoc anti-cheat remain the enforcement' };
    }
    // ΑΝΒ-7: 通道探测 —— stub Context 无 guard 面（宿主版本能力差），防御性探测。
    const tools = ctx.tools;
    const guardFn = tools?.guard;
    if (typeof guardFn !== 'function') {
        console.warn('[BenchDiscipline] benchDiscipline requested but host guard channel (ctx.tools.guard) is absent — honest degradation, no pre-hoc interception active (prompt discipline + anti-cheat post-hoc remain).');
        return { status: 'degraded', reason: 'host-guard-channel-absent', note: 'ctx.tools.guard not a function on this host build' };
    }
    try {
        // ΑΝΒ-7: fail-closed 判决回调 —— undefined 放行 / 字符串拒（R3-4 §3c 实证语义）。
        const decider = (exec) => {
            try {
                const verdict = benchToolVerdict(execToolName(exec));
                return verdict.allow ? undefined : verdict.reason;
            }
            catch {
                return 'bench discipline: internal classification error — refused fail-closed (please report; plugin tools and host session tools are unaffected)';
            }
        };
        const dispose = guardFn.call(tools, decider);
        // ΑΝΒ-7: disposer 回收登记（cordis 注册即效果模型；宿主未返 disposer ⇒ null 诚实申报）。
        const disposer = typeof dispose === 'function'
            ? () => { try {
                dispose();
            }
            catch { /* 卸载臂故障吞掉 —— 绝不因回收失败炸 unload */ } }
            : null;
        if (disposer !== null) {
            try {
                ctx.effect?.(() => disposer);
            }
            catch { /* effect 面缺席/故障 ⇒ 不登记回收（守卫随会话存续，非正确性问题） */ }
        }
        console.log(`[BenchDiscipline] Enforced (fail-closed): ${PLUGIN_TOOL_ALLOWLIST.size} plugin tools + ${HOST_SESSION_CLASS_TOOLS.size} host session/meta tools allowed; host shell/file/run-code and unknown tools denied for this session.`);
        return {
            status: 'enforced',
            allowedPluginTools: PLUGIN_TOOL_ALLOWLIST.size,
            allowedHostSessionTools: HOST_SESSION_CLASS_TOOLS.size,
            dispose: disposer,
        };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[BenchDiscipline] host guard channel threw during registration (${msg}) — honest degradation, no pre-hoc interception active.`);
        return { status: 'degraded', reason: 'host-guard-channel-threw', note: msg };
    }
}
// ══════════════════════════════════════════════════════════════════════
// ΑΝΒ-7: 一行接线说明书（挂线归 ΑΝΒ-4 / src/index.ts 不归本工位）——
//
//   在 src/index.ts 第 5 步「挂载守卫」块（registerAllGuards(ctx, config); 行后）加：
//
//     applyBenchDiscipline(ctx, config); // ΑΝΒ-7（D9 升维）：考核纪律 fail-closed
//                                         // 事前拦截 —— 缺省关零行为（见
//                                         // guards/hostToolPolicy.ts 头注与
//                                         // ANAB-7-review.md 启用前检查单）
//
//   并在文件头 import 区加：import { applyBenchDiscipline } from './guards/hostToolPolicy';
//
//   挂线后 wiring-census 豁免册中本模块的 applyBenchDiscipline 条目须删除
//   （幽灵即红，r29 同律 —— 挂线即删条）。
// ══════════════════════════════════════════════════════════════════════
