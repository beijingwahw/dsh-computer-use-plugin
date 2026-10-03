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
 */
function w4ForwardingSteerSession() {
    return {
        get goal() {
            return activeSteerSession()?.goal ?? {};
        },
        maybeCheckAndAsk(stepIndex, entropy) {
            const s = activeSteerSession();
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
            const s = activeSteerSession();
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
            const s = activeSteerSession();
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
            const s = activeSteerSession();
            if (s === null)
                return null;
            try {
                return s.lastDrift();
            }
            catch {
                return null;
            }
        },
    };
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
    return tools;
}
