import { isGlmConfigured } from '../vlm/glmClient.js';
import { createTakeScreenshotTool } from './takeScreenshot.js';
import { createClickMouseTool } from './clickMouse.js';
import { createTypeTextTool } from './typeText.js';
import { createScrollPageTool } from './scrollPage.js';
import { createPressHotkeyTool } from './pressHotkey.js';
import { createDragMouseTool } from './dragMouse.js';
import { dismissPopupTool } from './dismissPopup.js';
import { switchTabTool } from './switchTab.js';
import { switchWindowTool } from './switchWindow.js';
import { createClickElementTool } from './clickElement.js';
import { createExtractUiVisionTool } from './extractUiVision.js';
import { createZoomInspectTool } from './zoomInspect.js';
import { createRememberUiTool, createRecallUiTool } from './uiMemoryTools.js';
import { createReplayActionsTool } from './replayActions.js';
import { createReadTextTool, createFindTextTool } from './textTools.js';
import { createProbeInteractivityTool } from './probeInteractivity.js';
import { createOpenUrlTool } from './openUrl.js';
import { createDiffViewTool } from './diffView.js';
import { createSaveSkillTool, createMatchSkillTool, createRunSkillTool } from './skillTools.js';
import { createRequestApprovalTool, createGrantApprovalTool, createAdjudicateApprovalQueueTool } from './approvalTools.js';
import { createGetMetricsTool, createVerifyJournalTool, createSelfDiagnoseTool, createSaveCheckpointTool } from './observabilityTools.js';
import { createWhatIfTool, createSwarmReportTool } from './cognitions.js';
import { createQualityCheckupTool } from './qualityCheckup.js';
import { createSwarmDispatchTool } from './swarmDispatch.js';
import { createShapeEnvironmentTool } from './shapeEnvironment.js';
import { createAskScreenTool } from './askScreen.js';
import { createAutonomousRunTool } from './autonomousRun.js';
import { createAutonomyResumeTool } from './autonomyResume.js';
import { createVlmPlatformsTool } from './vlmPlatforms.js';
import { createSwitchVisionModelTool } from './vlmConnect.js';
import { createVlmWizardTool } from './vlmWizard.js';
import { createMetricsDashboardTool } from './metricsDashboard.js';
import { createFederationSyncTool } from './federationTools.js';
// W4-0（A 接线）：活意图漂移工具（W3-5 交付工厂）+ 在役会话转发面 —— 会话本体
// 由 driveLoop 在 steer 端点点亮时铸造（绑定当轮 goal），此处只做工具注册与
// 会话转发（无在役会话 ⇒ 诚实空转 NO_PENDING_STEER，绝不伪造问题）。
import { createSteerChoiceTool, createSteerAnswerTool } from './steerTools.js';
import { activeSteerSession } from '../autonomy/autoPilot.js';
/**
 * W4-0（A）：steer 会话转发器 —— 把工具调用转交给 driveLoop 铸造的在役会话
 *（跨环存续到下一环替换：出题升级后用户的单字符应答正是环外经工具回流的）。
 * 无在役会话（steer 未点亮 / 尚未跑环）⇒ 永不出题的空转面：maybeCheckAndAsk
 * 恒 null、answer 恒 no-pending（诚实缺席）。goal 出口仅在役时回真值（工具
 * 执行面不触达；空对象兜底防误用炸裂）。
 * W7-0（W5-5 接线收尾）：转发面补齐 4 个可选方法（drainAmendments /
 * holdBranchCard / branchCard / takeBranchBias —— steerTools 的 W5-5 扩展面）。
 * 守卫式转发：无在役会话 / 会话未实现该可选面 / 任何故障 ⇒ 各自的缺席语义
 * （空数组 / no-op / null / null —— runPilotLoop 消费方按零执行处理），
 * 缺省跳过语义与接前逐字节一致。sessionSource 注入缝：缺省 activeSteerSession
 *（生产血脉不变），测试可注入假源离线断言转发语义。
 */
// W8-B4（破环装配）：activeSteerSession 的持有面已收窄为结构端口（PilotSteerSession
// —— autoPilot 对 tools 零 import）。会话真身由注册进闭环的工厂铸造（本桶装载
// steerTools 即注册），运行时恒为完整 SteerSession —— 装配点收窄还原（结构镜像
// 只减成员，真身满足全成员面）。
export function w4ForwardingSteerSession(sessionSource = activeSteerSession) {
    return {
        get goal() {
            return sessionSource()?.goal ?? {};
        },
        maybeCheckAndAsk(stepIndex, entropy) {
            const s = sessionSource();
            if (s === null)
                return null;
            try {
                return s.maybeCheckAndAsk(stepIndex, entropy);
            }
            catch {
                return null; // 会话故障吞掉 —— 工具面绝不抛
            }
        },
        pending() {
            const s = sessionSource();
            if (s === null)
                return null;
            try {
                return s.pending();
            }
            catch {
                return null;
            }
        },
        answer(raw) {
            const s = sessionSource();
            if (s === null) {
                return { status: 'no-pending', hint: '当前无在役 steer 会话（漂移检查未点亮或尚未跑环）' };
            }
            try {
                return s.answer(raw);
            }
            catch {
                return { status: 'no-pending', hint: 'steer 会话异常收敛为无待答题目' };
            }
        },
        lastDrift() {
            const s = sessionSource();
            if (s === null)
                return null;
            try {
                return s.lastDrift();
            }
            catch {
                return null;
            }
        },
        // ── W7-0（W5-5 接线收尾）：4 个可选面的守卫式转发 ──
        /** 缝1（B 应答回灌账）：在役会话的修订判据一次性移交（缺席 ⇒ 空数组 = 回灌零执行） */
        drainAmendments() {
            const s = sessionSource();
            if (s === null || typeof s.drainAmendments !== 'function')
                return [];
            try {
                const out = s.drainAmendments();
                return Array.isArray(out) ? out : [];
            }
            catch {
                return []; // 会话故障 ⇒ 空账（绝不炸工具面）
            }
        },
        /** 缝3（岔路卡持有面）：注入/清除会话持卡（缺席 ⇒ no-op） */
        holdBranchCard(card) {
            const s = sessionSource();
            if (s === null || typeof s.holdBranchCard !== 'function')
                return;
            try {
                s.holdBranchCard(card);
            }
            catch {
                /* 持卡是旁路义务：故障吞掉 */
            }
        },
        /** 缝3（持卡读回）：防御浅拷贝（缺席 ⇒ null） */
        branchCard() {
            const s = sessionSource();
            if (s === null || typeof s.branchCard !== 'function')
                return null;
            try {
                const c = s.branchCard();
                return c !== null && typeof c === 'object' ? c : null;
            }
            catch {
                return null;
            }
        },
        /** 缝3（偏置步进面移交）：一次性取走重放预算执法权（缺席 ⇒ null = 无偏置原路） */
        takeBranchBias() {
            const s = sessionSource();
            if (s === null || typeof s.takeBranchBias !== 'function')
                return null;
            try {
                const b = s.takeBranchBias();
                return b !== null && typeof b === 'object' ? b : null;
            }
            catch {
                return null;
            }
        },
    };
}
// ─── ΑΩ-R28（注册处单源 + 完备性执法）：变更类工具登记处 ───
// 本桶是工具装配的唯一事实源 —— 先行审计（W2-2 fail-closed WAL）的变更类
// 名单也以此为准：单源导出，auditGuard 只读引入（guards→tools 单向依赖，
// 无环）。历史病灶：名单在 guard 侧硬编码 ⇒ fail-open 于名单维护 —— 新增
// 变更类工具忘登记则静默漏审计（W6R-A9 曾因此补齐 12 件）。
// **立法：新增变更类工具必须在此登记**；观察/控制面工具登记进
// KNOWN_READ_ONLY_TOOL_NAMES；两者都不落 ⇒ 装配期断言如实炸出
// （assertToolAuditClassification —— fail-open 变 fail-fast）。
// 判定标准（W6R-A9 同律）：该工具派发后，用户机器的桌面状态 / 文件系统 /
// 后续物理动作面将被改变。纯观察类（截图/读取/探针/问答）不入列。
export const MUTATING_TOOL_NAMES = new Set([
    // ── 直接物理动作面（原 6 件，W2-2 铁律）──
    'click_mouse', 'click_element', 'drag_mouse',
    'scroll_page', 'type_text', 'press_hotkey',
    // ── W6R-A9 补齐：直接物理动作面（漏网的键鼠/窗口/跳转族）──
    // switch_tab：真实键击 ctrl(+shift)+tab（switchTab.ts 调 system.pressHotkey）
    //   —— 浏览器前台标签被切换，世界状态改变
    'switch_tab',
    // switch_window：按标题把窗口调到前台（switchWindow.ts 调
    //   system.switchWindowByTitle）—— 焦点窗口被改变
    'switch_window',
    // open_url：经 OS 壳层打开默认浏览器（openUrl.ts 调 system.openUrl）——
    //   世界跳转；ACTION_TOOLS 已在册（journal.ts）
    'open_url',
    // replay_actions：宏重放 = 把日志里的 click/type/drag 序列原样打到真实
    //   桌面（replayActions.ts 自述 real-world side-effect operation）
    'replay_actions',
    // run_skill：技能执行 = 经 replayOne 逐步重放物理步骤（skillTools.ts）
    'run_skill',
    // shape_environment：raise/maximize/move_window、set_zoom/set_contrast ——
    //   直接重塑物理工作台。D-D12 子动作分流在 auditGuard 侧执法：
    //   capabilities/undo_log 两个只读子动作免派发（闭集），apply/restore 及
    //   未知 action 仍按本名单执法（fail-closed 闭集）
    'shape_environment',
    // ── W6R-A9 补齐：绕过宿主管线的物理动作批次（入口审计是唯一机会）──
    // autonomous_run：自主环内 PolicyAction 经 runtime.createExecute 直接驱
    //   system 键鼠（autonomy/runtime.ts）—— 不经过宿主工具管线，环内逐步
    //   动作永远不路过守卫；入口处的先行审计是整批动作唯一的 WAL 机会
    'autonomous_run',
    // autonomy_resume：同一引擎续跑（autonomyResume.ts 复用 runPilotLoop）
    'autonomy_resume',
    // ── W6R-A9 补齐：文件系统写入族（变更用户机器上的持久状态）──
    // save_skill：技能库落盘（skillLibrary.ts writeFileSync 原子写）
    'save_skill',
    // save_checkpoint：认知态快照写盘（checkpoint.ts，config.checkpointPath）
    'save_checkpoint',
    // switch_vision_model：连接档案持久化到 ~/.dsh/vlm-connection.json
    //   （vlm/connection.ts writeFileSync）并热替换全局 VLM 单例
    'switch_vision_model',
    // vlm_wizard：起回环服务 + system.openUrl 打开浏览器窗口（vlmWizard.ts）
    //   —— 浏览器被打开是世界可见动作
    'vlm_wizard',
    // replay_on_host（ΝΩ-1）：沙箱肌肉记忆宿主重放 = 四/五门全过后逐步真派发
    //   键鼠（sandbox/index.ts 经 system 层）—— 与 replay_actions 同族的物理动作面
    'replay_on_host',
]);
/** ΑΩ-R28：已知只读/控制面白名单 —— 显式不入先行审计面的注册工具（二分类
 *  的另一翼）。不入列 ≠ 漏网：每项都是有理由的缺席（W6R-A9 盘点同律）：
 *   · take_screenshot / zoom_inspect / diff_view / extract_ui_vision /
 *     read_text / find_text / ask_screen / vlm_platforms / probe_interactivity /
 *     metrics_dashboard / verify_journal / get_metrics / self_diagnose /
 *     quality_checkup / recall_ui / match_skill / what_if —— 观察探针/问答/
 *     体检（纯读取，世界不被打改）；
 *   · dismiss_popup —— 零副作用元工具（只返回 TACTICAL_PAUSE 字符串）；
 *   · swarm_dispatch / swarm_report —— 控制面记账（物理 IO 走常规动作工具，
 *     逐次被守卫审计）；
 *   · request_approval / grant_approval / adjudicate_approval_queue —— 审批
 *     控制面（令牌簿自有留痕；物理动作在消费令牌的动作工具处被审计）；
 *   · remember_ui —— 会话内存笔记本（UIMemory 无磁盘持久化）；
 *   · steer_choice / steer_answer —— 瞬态控制面（在役会话的问答回流）；
 *   · federation_sync —— 联邦记账面（离线摘要铸造/合并；世界动作零派发）。 */
const KNOWN_READ_ONLY_TOOL_NAMES = new Set([
    'take_screenshot', 'zoom_inspect', 'diff_view', 'extract_ui_vision',
    'read_text', 'find_text', 'ask_screen', 'vlm_platforms', 'probe_interactivity',
    'metrics_dashboard', 'verify_journal', 'get_metrics', 'self_diagnose',
    'quality_checkup', 'recall_ui', 'remember_ui', 'match_skill', 'what_if',
    'swarm_report', 'swarm_dispatch', 'dismiss_popup',
    'request_approval', 'grant_approval', 'adjudicate_approval_queue',
    'steer_choice', 'steer_answer', 'federation_sync',
]);
/** ΑΩ-R28（完备性执法）：装配期断言 —— 每个注册进工具表的名字必须被二分类
 *  （MUTATING_TOOL_NAMES 或 KNOWN_READ_ONLY_TOOL_NAMES 之一）；出现未分类
 *  名字 ⇒ 如实 throw。这是配置期而非运行期（加载层可 throw 的纪律）：新
 *  工具加入装配时漏分类立即炸出，名单维护遗漏从静默漏审计（fail-open）变
 *  装配即炸（fail-fast）。独立导出以便测试注入假工具名直驱断言路径。 */
export function assertToolAuditClassification(tools) {
    const unclassified = tools
        .map(t => t.name)
        .filter(n => !MUTATING_TOOL_NAMES.has(n) && !KNOWN_READ_ONLY_TOOL_NAMES.has(n));
    if (unclassified.length > 0) {
        throw new Error('ΑΩ-R28 audit classification incomplete: unclassified tool name(s) [' + unclassified.join(', ') + '] ' +
            '— every tool registered by buildAllTools must be classified in src/tools/index.ts: ' +
            'world-changing tools in MUTATING_TOOL_NAMES (pre-dispatch audit WAL), ' +
            'observation/control-plane tools in KNOWN_READ_ONLY_TOOL_NAMES. ' +
            'An unclassified name would dispatch without a pre-dispatch audit trail (fail-open) — refused at assembly time.');
    }
}
export function buildAllTools(config) {
    const tools = [
        createTakeScreenshotTool(config),
        createClickMouseTool(config),
        createTypeTextTool(config),
        createScrollPageTool(config),
        createPressHotkeyTool(),
        createDragMouseTool(config),
        // 突破四：二阶段精定位（coarse -> zoom -> precise）
        createZoomInspectTool(config),
        // 第四轮创新：视觉差分（what-changed-where，纯 sharp 无额外依赖）
        createDiffViewTool(),
        dismissPopupTool,
        switchTabTool,
        switchWindowTool,
    ];
    // 混合模式：ID 寻址（需在入口注入无障碍 Provider）
    // 纪元 Ρ：createClickElementTool 收编入闸（审批/公证），需读配置
    if (config.enableElementIdMode)
        tools.push(createClickElementTool(config));
    // 混合模式：本地视觉模型精确定位
    if (config.localVisionApi)
        tools.push(createExtractUiVisionTool(config));
    // 突破二：场景式 UI 记忆
    if (config.enableUIMemory) {
        tools.push(createRememberUiTool(), createRecallUiTool());
    }
    // 突破三：行动重放（宏）
    if (config.enableJournal)
        tools.push(createReplayActionsTool(config));
    // 第四轮创新：文字感知（OCR 定位与读取）
    if (config.enableOcr) {
        tools.push(createReadTextTool(config), createFindTextTool(config));
    }
    // 纪元 Ω（云脑皮层）：自由视觉问答 —— 仅在 VLM 可用时挂载
    //（config.vlmApiKey 已铸/环境变量已配置；无 Key 用户不见此工具，行为零变化）
    if (config.vlmApiKey || isGlmConfigured()) {
        tools.push(createAskScreenTool(config));
    }
    // 纪元 Ψ（万脑归一）：vlm_platforms 平台花名册与体检 —— 挂载谓词与 ask_screen
    // 同源（vlmApiKey 已铸或任一云脑 env 就绪即挂载）。另起新块：上方 Ω 纪元挂载门
    // 的原行保持原样（vlm.integration.test.ts 源码正则锁定该立法文本）。
    if (config.vlmApiKey || isGlmConfigured()) {
        tools.push(createVlmPlatformsTool(config));
    }
    // 纪元 Λ（Λ-3 开箱即亮）：switch_vision_model / vlm_wizard —— 恒注册，不设门
    //（向导与手动换脑在「无模型」时恰是最需要的：无 Key 用户也要能打开 vlm_wizard
    // 走浏览器连接向导、能在拿到 Key 后当场 switch；有门反而卡死第 0 步）。另起新块：
    // 上方 Ω/Ψ 纪元挂载门的原行保持原样（vlm.integration.test.ts 源码正则锁定该立法文本）。
    tools.push(createSwitchVisionModelTool(config));
    tools.push(createVlmWizardTool(config));
    // 纪元 Φ（自主智能环）：autonomous_run 元工具 —— 显式开启才挂载
    //（识别→判断→宪法→执行→验证→进化全闭环；默认关闭，无感用户行为零变化）
    if (config.autonomyEnabled) {
        tools.push(createAutonomousRunTool(config));
    }
    // 纪元 Σ（Σ-3 断点续跑）：autonomy_resume 元工具 —— 与 autonomous_run 同门
    // 挂载（凭 resume_token 续跑中断任务：档案重载 + 判据回放 + 原栈重铸；
    // 默认关闭，无感用户行为零变化。另起新块：上方 Φ 纪元挂载门原行保持原样）
    if (config.autonomyEnabled) {
        tools.push(createAutonomyResumeTool(config));
    }
    // Z 纪元（Z-1 世界行动引擎）：交互性探针 —— 对话文本 ≠ 可点击入口
    if (config.enableInteractivityProbe) {
        tools.push(createProbeInteractivityTool(config));
    }
    // AA 纪元（AA-1 世界跳转引擎）：URL 安检 + 默认浏览器跳转 —— 屏幕上的
    // 链接不靠点击，交给 OS 壳层（Z-2 闸门拒绝点击正文时的正确出口）
    if (config.enableOpenUrl) {
        tools.push(createOpenUrlTool(config));
    }
    // 第五轮创新：自进化技能库（轨迹归纳 / 语义匹配 / DNA 重组 / 一键执行）
    if (config.enableSkillLibrary) {
        tools.push(createSaveSkillTool(), createMatchSkillTool(config), createRunSkillTool(config));
    }
    // 认知升维 C-3/C-5：反事实推理 + 群体智慧报告
    if (config.enableJournal)
        tools.push(createWhatIfTool());
    tools.push(createSwarmReportTool());
    // 第四维 D-4：质量医生（免疫系统 —— 代码基因 + 因果链合法性审查）
    if (config.enableQualityDoctor)
        tools.push(createQualityCheckupTool(config));
    // 第四维 D-1：多智能体协同（一台躯体，多重心智）
    if (config.enableSubAgents)
        tools.push(createSwarmDispatchTool(config));
    // 第四维 D-2：环境重塑（权力与复原义务对称；能力集空时工具在但诚实拒绝）
    if (config.enableEnvironmentShaper)
        tools.push(createShapeEnvironmentTool());
    // 第六轮创新：人机协同审批（不可逆操作的一次性令牌闸门）
    if (config.enableApprovalGate) {
        tools.push(createRequestApprovalTool(config), createGrantApprovalTool(config));
    }
    // W3-0（W2-1 H4 接线）：adjudicate_approval_queue —— 暂存式离线批准队列的
    // 批注式批量裁决面（晨报列出待批清单后用户一次裁决多项；grant 复用 W1-2
    // amendment 批注协议，每项各铸一份修正、续跑令牌原样携带）。与 request/grant
    // 同门挂载（enableApprovalGate —— 队列本身只在审批域激活语境下有意义；工具
    // 内部另有开关守卫作纵深防御）。另起新块：上方第六轮挂载门原行保持原样。
    if (config.enableApprovalGate) {
        tools.push(createAdjudicateApprovalQueueTool(config));
    }
    // 第七轮创新：工程卓越（可观测/可审计/可恢复）
    if (config.enableTelemetry) {
        tools.push(createGetMetricsTool(), createVerifyJournalTool(), createSelfDiagnoseTool(config));
    }
    if (config.checkpointPath) {
        tools.push(createSaveCheckpointTool(config));
    }
    // 纪元 Σ（Σ-7 遥测仪表盘）：metrics_dashboard —— 四分区文本仪表盘
    //（工具/云脑/自主/守卫全系统健康透视；纯只读、无配置依赖 ⇒ 恒挂载。另起新块：
    // 上方 ask_screen 挂载门原行与 autonomy 各块均不动）
    tools.push(createMetricsDashboardTool());
    // 纪元 Μ（万脑联邦进化）：federation_sync —— 内核证据账本的差分隐私联邦。
    // 挂载门：kernelEvolutionEnabled 开启（进化语境）或 federationEndpoint 已配置
    //（显式 opt-in 联邦）；缺省两臂皆关 ⇒ 工具不挂载，无感用户行为零变化。
    // 摘要铸造/合并/掺入全链离线可用，endpoint 空 = 零网络缺省（工具描述已写明）。
    if (config.kernelEvolutionEnabled || config.federationEndpoint !== '') {
        tools.push(createFederationSyncTool(config));
    }
    // W4-0（A 接线 · 纪元 W3/H2 活意图漂移）：steer_choice / steer_answer —— 与
    // autonomous_run 同门挂载（config.autonomyEnabled：漂移检查绑定自主环的目标机，
    // 环未启用则工具无语义）。会话转发面在环外诚实空转（无在役会话 ⇒
    // NO_PENDING_STEER），环内出题升级后模型经本对工具转述题面并结算单字符应答。
    // 另起新块：上方各纪元挂载门原行保持原样。
    if (config.autonomyEnabled) {
        const w4SteerSession = w4ForwardingSteerSession();
        tools.push(createSteerChoiceTool(w4SteerSession), createSteerAnswerTool(w4SteerSession));
    }
    // ΑΩ-R28（完备性执法）：装配收尾断言 —— 注册面全员二分类（变更类名单 /
    // 显式只读白名单，二选一）。新工具漏分类 ⇒ 此处如实炸（配置期 fail-fast，
    // 非运行期），杜绝「新增变更类工具忘登记 ⇒ 静默漏审计」的 fail-open 病灶。
    assertToolAuditClassification(tools);
    return tools;
}
