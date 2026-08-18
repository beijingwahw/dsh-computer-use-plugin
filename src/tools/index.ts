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

export function buildAllTools(config: Config) {
  const tools = [
    createTakeScreenshotTool(config),
    createClickMouseTool(),
    createTypeTextTool(config),
    createScrollPageTool(),
    createPressHotkeyTool(),
    createDragMouseTool(),
    dismissPopupTool,
    switchTabTool,
    switchWindowTool,
  ];

  // 混合模式：ID 寻址（需在入口注入无障碍 Provider）
  if (config.enableElementIdMode) tools.push(createClickElementTool());

  // 混合模式：本地视觉模型精确定位
  if (config.localVisionApi) tools.push(createExtractUiVisionTool(config));

  return tools;
}
