// src/tools/index.ts
// 工具桶文件 + 注册工厂（修复原版桶文件缺失导致 index.ts 导入断裂）。
// 日志数字来自数组 length —— 日志永远与注册表同步，不会说谎。
// 条件工具：元素 ID 模式与本地视觉模型按配置启用 —— 能力由 cordis.yml 决定。
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Config } from '../config';
import { createTakeScreenshotTool } from './takeScreenshot';
import { createClickMouseTool } from './clickMouse';
import { createTypeTextTool } from './typeText';
import { createScrollPageTool } from './scrollPage';
import { createPressHotkeyTool } from './pressHotkey';
import { createDragMouseTool } from './dragMouse';
import { dismissPopupTool } from './dismissPopup';
import { switchTabTool } from './switchTab';
import { switchWindowTool } from './switchWindow';
import { createClickElementTool } from './clickElement';
import { createExtractUiVisionTool } from './extractUiVision';
import { createZoomInspectTool } from './zoomInspect';
import { createRememberUiTool, createRecallUiTool } from './uiMemoryTools';
import { createReplayActionsTool } from './replayActions';
import { createReadTextTool, createFindTextTool } from './textTools';
import { createDiffViewTool } from './diffView';
import { createSaveSkillTool, createMatchSkillTool, createRunSkillTool } from './skillTools';
import { createRequestApprovalTool, createGrantApprovalTool } from './approvalTools';
import { createGetMetricsTool, createVerifyJournalTool, createSelfDiagnoseTool, createSaveCheckpointTool } from './observabilityTools';
import { createWhatIfTool, createSwarmReportTool } from './cognitions';
import { createQualityCheckupTool } from './qualityCheckup';
import { createSwarmDispatchTool } from './swarmDispatch';
import { createShapeEnvironmentTool } from './shapeEnvironment';

export function buildAllTools(config: Config): ToolDefinition[] {
  const tools: ToolDefinition[] = [
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
  if (config.enableElementIdMode) tools.push(createClickElementTool());

  // 混合模式：本地视觉模型精确定位
  if (config.localVisionApi) tools.push(createExtractUiVisionTool(config));

  // 突破二：场景式 UI 记忆
  if (config.enableUIMemory) {
    tools.push(createRememberUiTool(), createRecallUiTool());
  }

  // 突破三：行动重放（宏）
  if (config.enableJournal) tools.push(createReplayActionsTool(config));

  // 第四轮创新：文字感知（OCR 定位与读取）
  if (config.enableOcr) {
    tools.push(createReadTextTool(config), createFindTextTool(config));
  }

  // 第五轮创新：自进化技能库（轨迹归纳 / 语义匹配 / DNA 重组 / 一键执行）
  if (config.enableSkillLibrary) {
    tools.push(createSaveSkillTool(), createMatchSkillTool(config), createRunSkillTool(config));
  }

  // 认知升维 C-3/C-5：反事实推理 + 群体智慧报告
  if (config.enableJournal) tools.push(createWhatIfTool());
  tools.push(createSwarmReportTool());

  // 第四维 D-4：质量医生（免疫系统 —— 代码基因 + 因果链合法性审查）
  if (config.enableQualityDoctor) tools.push(createQualityCheckupTool(config));

  // 第四维 D-1：多智能体协同（一台躯体，多重心智）
  if (config.enableSubAgents) tools.push(createSwarmDispatchTool(config));

  // 第四维 D-2：环境重塑（权力与复原义务对称；能力集空时工具在但诚实拒绝）
  if (config.enableEnvironmentShaper) tools.push(createShapeEnvironmentTool());

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
