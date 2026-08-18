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
import { createDiffViewTool } from './diffView.js';
import { createSaveSkillTool, createMatchSkillTool, createRunSkillTool } from './skillTools.js';
import { createRequestApprovalTool, createGrantApprovalTool } from './approvalTools.js';
import { createGetMetricsTool, createVerifyJournalTool, createSelfDiagnoseTool, createSaveCheckpointTool } from './observabilityTools.js';
import { createWhatIfTool, createSwarmReportTool } from './cognitions.js';
import { createQualityCheckupTool } from './qualityCheckup.js';
import { createSwarmDispatchTool } from './swarmDispatch.js';
import { createShapeEnvironmentTool } from './shapeEnvironment.js';
export function buildAllTools(config) {
    const tools = [
        createTakeScreenshotTool(config),
        createClickMouseTool(config),
        createTypeTextTool(config),
        createScrollPageTool(),
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
    if (config.enableElementIdMode)
        tools.push(createClickElementTool());
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
    // 第七轮创新：工程卓越（可观测/可审计/可恢复）
    if (config.enableTelemetry) {
        tools.push(createGetMetricsTool(), createVerifyJournalTool(), createSelfDiagnoseTool(config));
    }
    if (config.checkpointPath) {
        tools.push(createSaveCheckpointTool(config));
    }
    return tools;
}
