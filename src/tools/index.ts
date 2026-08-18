// src/tools/index.ts
// 工具桶文件 + 注册工厂（修复原版桶文件缺失导致 index.ts 导入断裂）。
// 日志数字来自数组 length —— 日志永远与注册表同步，不会说谎。
// 条件工具：元素 ID 模式与本地视觉模型按配置启用 —— 能力由 cordis.yml 决定。
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

export function buildAllTools(config: Config) {
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

  // 第五轮创新：自进化技能库（轨迹归纳 / 匹配 / 一键执行）
  if (config.enableSkillLibrary) {
    tools.push(createSaveSkillTool(), createMatchSkillTool(), createRunSkillTool(config));
  }

  return tools;
}
