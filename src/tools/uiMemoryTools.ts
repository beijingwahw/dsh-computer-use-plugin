// src/tools/uiMemoryTools.ts
// 突破二的工具面：remember_ui / recall_ui。
// remember 在「验证生效的点击」后自动调用（或模型手动调用）；
// recall 用自然语言召回历史位置先验 —— 注意先验≠事实，锚点强制要求截图复核。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { uiMemory } from '../uiMemory';
import { contextManager } from '../contextManager';

export function createRememberUiTool() {
  return defineTool({
    name: 'remember_ui',
    description:
      'Saves a verified UI location as a reusable landmark (e.g., "GitHub 搜索框"). ' +
      'Call this after a successful, verified interaction with an important element.',
    parameters: {
      description: {
        type: 'string', required: true,
        description: 'Natural-language description of the UI element (short and recognizable).',
      },
      x: { type: 'number', required: true, description: 'Verified normalized X (0.0-1.0).' },
      y: { type: 'number', required: true, description: 'Verified normalized Y (0.0-1.0).' },
      app_hint: { type: 'string', required: false, description: 'Optional app/context hint (e.g., "Chrome", "VS Code").' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const lm = uiMemory.remember(args.description, args.x, args.y, args.app_hint);
      return `[System]: Landmark #${lm.id} "${lm.description}" saved at (${lm.normalized.x}, ${lm.normalized.y}), ` +
        `verified ${lm.successCount} time(s). Recall it later via recall_ui.`;
    },
  });
}

export function createRecallUiTool() {
  return defineTool({
    name: 'recall_ui',
    description:
      'Recalls previously verified UI locations by natural-language query. ' +
      'Use this before searching the screen for a known element — remembered coordinates are strong priors.',
    parameters: {
      query: {
        type: 'string', required: true,
        description: 'What are you looking for? e.g., "设置按钮", "search box".',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      // 场景感知召回：用当前窗口内最新截图的指纹做场景匹配加成
      const currentScene = contextManager.lastImageRecord()?.hash;
      const hits = uiMemory.recall(args.query, 5, currentScene);
      if (hits.length === 0) {
        return `[System]: No matching landmarks. Locate the element visually via take_screenshot / zoom_inspect.`;
      }
      const lines = hits.map(h =>
        `- [${h.id}] "${h.description}"${h.appHint ? ` @${h.appHint}` : ''} ` +
        `-> (${h.normalized.x}, ${h.normalized.y}) score=${h.score} verified=${h.successCount}x`,
      );
      return `[System]: Top ${hits.length} landmark(s):\n${lines.join('\n')}\n` +
        `[Next Step]: These are PRIORS, not facts. Call 'take_screenshot' to confirm the element is still there before clicking.`;
    },
  });
}
