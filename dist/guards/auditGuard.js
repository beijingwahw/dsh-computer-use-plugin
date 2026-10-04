import { onToolPre } from './hooks.js';
import { matchesRiskPatterns } from '../riskGate.js';
import { journal } from '../journal.js';
/** 审计日志脱敏：type_text 的 args 可能含凭据/验证码 —— 与 typeText 工具的
 *  [REDACTED] 锚点同律，宿主控制台不落明文秘密 */
const REDACT_KEYS = /^(text|typed_content|content|password|passwd|secret|token|api_?key)$/i;
/** 嵌套脱敏限深：环/超深结构不得把审计行炸成栈溢出；越深整体脱敏（宁过度） */
const REDACT_MAX_DEPTH = 3;
function redactArgs(args, depth = 0) {
    if (!args || typeof args !== 'object' || Array.isArray(args))
        return args;
    const out = {};
    for (const [k, v] of Object.entries(args)) {
        if (REDACT_KEYS.test(k)) {
            out[k] = '[REDACTED]'; // 敏感键：无论标量/数组/对象，整值脱敏（J 纪元：数组不再原样放行）
        }
        else if (v && typeof v === 'object' && !Array.isArray(v)) {
            out[k] = depth < REDACT_MAX_DEPTH ? redactArgs(v, depth + 1) : '[REDACTED]';
        }
        else {
            out[k] = v;
        }
    }
    return out;
}
/** W2-2（S4）：先行审计覆盖面 —— 全部变更类工具（触达物理世界的动作面）。
 *  观察/只读工具（take_screenshot 等）不入列：审计的是「世界将被打改」的意图。
 *
 * W6R-A9（覆盖面修复）：旧名单只收 6 个直接键鼠工具 —— 对照 src/tools/index.ts
 * 注册面与 README 工具表逐个盘点后补齐漏网的世界变更工具。判定标准：该工具
 * 派发后，用户机器的桌面状态 / 文件系统 / 后续物理动作面将被改变。纯观察类
 * （截图/读取/探针/问答）不入列。每项附文件证据。
 *  已核查不入列的边界项（理由见 README 工具表 + 源码）：
 *   · dismiss_popup —— 零副作用元工具（src/tools/dismissPopup.ts：只返回
 *     TACTICAL_PAUSE 字符串，不碰任何状态）；
 *   · swarm_dispatch —— 控制面记账（spawn/report/arbitrate 只动内存花名册，
 *     子代理的物理 IO 仍走常规动作工具 → 逐次被本守卫审计）；
 *   · grant_approval / request_approval / adjudicate_approval_queue —— 审批
 *     控制面（令牌簿自有留痕；物理动作在消费令牌的动作工具处被审计）；
 *   · remember_ui —— 会话内存笔记本（src/uiMemory.ts 的 UIMemory 类无任何
 *     磁盘持久化，不构成世界状态变更）；
 *   · probe_interactivity / zoom_inspect / diff_view / read_text / find_text /
 *     ask_screen / vlm_platforms / metrics_dashboard / recall_ui / match_skill /
 *     what_if / swarm_report / get_metrics / verify_journal / self_diagnose /
 *     steer_choice / steer_answer —— 观察探针或瞬态控制面。
 *  D-D12（子动作精化）：具名名单面的工具若自带混合读写子动作（唯
 *  shape_environment），按参数子动作分流执法 —— 只读子动作（capabilities/
 *  undo_log）免派发，变更子动作（apply/restore）与未知 action 保持执法
 *  （SHAPE_ENV_READ_ONLY_ACTIONS 闭集，fail-closed）。名单计数不变（18）。 */
const MUTATING_TOOLS = new Set([
    // ── 直接物理动作面（原 6 件，W2-2 铁律）──
    'click_mouse', 'click_element', 'drag_mouse',
    'scroll_page', 'type_text', 'press_hotkey',
    // ── W6R-A9 补齐：直接物理动作面（漏网的键鼠/窗口/跳转族）──
    // switch_tab：真实键击 ctrl(+shift)+tab（src/tools/switchTab.ts 调
    //   system.pressHotkey）—— 浏览器前台标签被切换，世界状态改变
    'switch_tab',
    // switch_window：按标题把窗口调到前台（src/tools/switchWindow.ts 调
    //   system.switchWindowByTitle）—— 焦点窗口被改变
    'switch_window',
    // open_url：经 OS 壳层打开默认浏览器（src/tools/openUrl.ts 调
    //   system.openUrl）—— 世界跳转；ACTION_TOOLS 已在册（src/journal.ts）
    'open_url',
    // replay_actions：宏重放 = 把日志里的 click/type/drag 序列原样打到真实
    //   桌面（src/tools/replayActions.ts 自述 "real-world side-effect
    //   operation"）—— 一次调用含多次物理动作
    'replay_actions',
    // run_skill：技能执行 = 经 replayOne 逐步重放物理步骤（src/tools/skillTools.ts）
    'run_skill',
    // shape_environment：raise/maximize/move_window、set_zoom/set_contrast ——
    //   直接重塑物理工作台（src/tools/shapeEnvironment.ts）。D-D12 子动作分流：
    //   capabilities/undo_log 两个只读子动作免派发（见 SHAPE_ENV_READ_ONLY_ACTIONS），
    //   apply/restore 及未知 action 仍按本名单执法（fail-closed 闭集）
    'shape_environment',
    // ── W6R-A9 补齐：绕过宿主管线的物理动作批次（入口审计是唯一机会）──
    // autonomous_run：自主环内 PolicyAction 经 runtime.createExecute 直接驱
    //   system 键鼠（src/autonomy/runtime.ts）—— **不经过宿主工具管线**，环内
    //   逐步动作永远不会路过本守卫；入口处的先行审计是整批动作唯一的 WAL 机会
    'autonomous_run',
    // autonomy_resume：同一引擎续跑（src/tools/autonomyResume.ts 复用 runPilotLoop）
    'autonomy_resume',
    // ── W6R-A9 补齐：文件系统写入族（变更用户机器上的持久状态）──
    // save_skill：技能库落盘（src/skillLibrary.ts writeFileSync 原子写）
    'save_skill',
    // save_checkpoint：认知态快照写盘（src/checkpoint.ts，config.checkpointPath）
    'save_checkpoint',
    // switch_vision_model：连接档案持久化到 ~/.dsh/vlm-connection.json
    //   （src/vlm/connection.ts writeFileSync）并热替换全局 VLM 单例
    'switch_vision_model',
    // vlm_wizard：起回环服务 + system.openUrl 打开浏览器窗口（src/tools/
    //   vlmWizard.ts）—— 浏览器被打开是世界可见动作
    'vlm_wizard',
]);
/** D-D12（子动作精化）：shape_environment 的只读子动作闭集 —— 源自
 *  src/tools/shapeEnvironment.ts 的 action 枚举（capabilities | apply |
 *  restore | undo_log）。仅 capabilities（能力申报，纯查询）与 undo_log
 *  （复原账本视图，纯查询）不触达桌面状态；apply（raise_window /
 *  maximize_window / move_window / set_zoom / set_contrast 五 kind 全是
 *  窗口整形）与 restore（LIFO 重放复原配方 = 再次物理整形）是变更子动作。
 *  闭集立法：只豁免显式列名的只读子动作 —— 未知/缺席 action 不可证明只读
 *  ⇒ 仍按变更类审计（fail-closed 语义在分流面上原样保持）。 */
const SHAPE_ENV_READ_ONLY_ACTIONS = new Set(['capabilities', 'undo_log']);
/** 该调用是否落入先行审计面（W2-2）：MUTATING_TOOLS 具名 + shape_environment
 *  按 D-D12 参数子动作分流（只读子动作免派发审计 WAL 行）。 */
function isPreDispatchAudited(name, args) {
    if (!MUTATING_TOOLS.has(name))
        return false;
    if (name === 'shape_environment') {
        const action = args?.action;
        return !(typeof action === 'string' && SHAPE_ENV_READ_ONLY_ACTIONS.has(action));
    }
    return true;
}
export function registerAuditGuard(ctx) {
    onToolPre(ctx, async (toolCall, next) => {
        const sensitiveActions = ['type_text', 'press_hotkey'];
        if (sensitiveActions.includes(toolCall.name)) {
            // L 纪元：TODO 兑现 —— 审计行消费 J 纪元 risk/approval 体系语境：
            //   凭据语义文本 ⇒ 标注风险闸门将要求人工输入（挂起点在 typeText 工具内）；
            //   click 类危险操作的令牌核验在 click_mouse 内（grant 前置）。
            //   审计不拦截（旁路观察者），但把"安全系统接下来会做什么"写进审计轨迹。
            try {
                const args = toolCall.args;
                const text = typeof args?.text === 'string' ? args.text : '';
                const risk = matchesRiskPatterns(text, 'password,passwd,密码,验证码,verification code,2fa,otp,secret,token,api key')
                    ? ' [risk: credential-like — risk gate will demand human input]'
                    : '';
                console.warn(`[Audit Guard] Sensitive action intercepted: ${toolCall.name}${risk}`, redactArgs(args));
            }
            catch (e) {
                // 审计行丢失必须可见，但观察者自身崩溃绝不允许阻断工具调用（恒放行契约）
                console.warn(`[Audit Guard] audit line lost for ${toolCall.name}: ${e?.message ?? e}`);
            }
        }
        // ── W2-2（S4）：先行审计 WAL —— 变更类工具派发前的 fail-closed 提交 ──
        // 审计行（脱敏后）在此刻（next() 之前 = 工具 execute 之前）追加进 journal
        // 哈希链；提交失败 ⇒ 短路拒绝（不调 next 即拦截），拒绝面是结构化 JSON
        // （hooks.toPreDecision 转译为 PreToolDecision deny）。防御式：提交通道
        // 自身绝不抛（appendPreDispatch 内部捕获），此处再兜一层 —— 守卫代码的
        // 任何意外异常也走 fail-closed 拒派，绝不静默放行无审计的动作。
        // D-D12：shape_environment 的只读子动作（capabilities/undo_log）在此分流
        // 出局 —— 审计的是「世界将被打改」的意图，纯查询无此意图。
        if (isPreDispatchAudited(toolCall.name, toolCall.args)) {
            let commit;
            try {
                // 非对象载荷（数组/标量）装箱为 { value } —— 审计行的 args 域恒为纯对象
                const redacted = redactArgs(toolCall.args ?? {});
                const payload = redacted && typeof redacted === 'object' && !Array.isArray(redacted)
                    ? redacted
                    : { value: redacted };
                commit = journal.appendPreDispatch(toolCall.name, payload);
            }
            catch (e) {
                commit = { ok: false, error: `audit-guard-internal:${String(e?.message ?? e)}` };
            }
            if (!commit.ok) {
                console.warn(`[Audit Guard] FAIL-CLOSED: ${toolCall.name} refused — pre-dispatch audit commit failed: ${commit.error}`);
                return JSON.stringify({
                    status: 'ACTION_REQUIRED',
                    state_anchor: {
                        audit_gate: 'fail-closed',
                        reason: 'pre-dispatch-audit-commit-failed',
                        tool: toolCall.name,
                        detail: commit.error,
                        note: 'The action was NOT dispatched: its write-ahead audit record could not be committed ' +
                            'to the tamper-evident journal. Actions without an audit trail are refused by design.',
                    },
                    next_step: 'RETRY once (transient disk hiccup). If it persists, inspect the journal path ' +
                        '(disk space / write permissions) before attempting any further world-changing action — ' +
                        'read-only tools (take_screenshot, ask_screen) remain available for diagnosis.',
                }, null, 2);
            }
        }
        return next();
    });
}
