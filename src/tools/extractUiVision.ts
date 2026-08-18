// src/tools/extractUiVision.ts
// 云-端混合定位：云端大模型负责理解任务，本地小模型（OmniParser 类）负责精确坐标。
// 修复原版：未导入 system、硬编码 1920/1080、依赖 axios —— 改用动态分辨率 + 原生 fetch。
// B-5：fetch 超时护栏（AbortSignal.timeout）—— 本地视觉服务挂起时快速失败而非永挂；
//      未配置端点时零网络请求直接降级。保留：Token 预算(slice 10) + 失败降级路由。
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Config } from '../config';
import { system } from '../system';
import { toolErr } from '../toolResult';

export function createExtractUiVisionTool(config: Config) {
  return defineTool({
    name: 'extract_ui_vision',
    description:
      'Extracts interactive UI elements and their normalized centers from the current screen ' +
      'using a local lightweight vision model. Use this to get precise coordinates ' +
      'without relying on the cloud LLM.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      // 空配置快速失败：不发起网络请求，直接给出降级路径
      if (!config.localVisionApi) {
        return toolErr(
          'Local vision extraction unavailable.',
          'localVisionApi is not configured.',
          "Use standard 'take_screenshot' + visual grounding, or configure localVisionApi to enable this tool.",
        );
      }
      try {
        // 1. 截屏 + 动态获取真实分辨率（修复硬编码除数）
        const rawBuffer = await system.captureScreen();
        const size = await system.getScreenSize();

        // 2. 调用本地视觉模型（Node >= 18 全局 fetch/FormData/Blob，免 axios 依赖）
        //    B-5：超时护栏 —— 服务挂起时 AbortError 快速失败，agent 不永挂
        const formData = new FormData();
        formData.append('image', new Blob([new Uint8Array(rawBuffer)]), 'screen.png');

        const response = await fetch(config.localVisionApi, {
          method: 'POST',
          body: formData,
          signal: AbortSignal.timeout(config.visionApiTimeoutMs),
        });
        if (!response.ok) throw new Error(`Local vision API responded ${response.status}`);
        const data: any = await response.json();

        // 3. bbox -> 归一化中心
        const elements = (data.elements ?? []) as Array<{ label: string; bbox: [number, number, number, number] }>;
        const normalizedElements = elements.map(el => {
          const [x1, y1, x2, y2] = el.bbox;
          return {
            label: el.label,
            center_normalized: {
              x: parseFloat(((x1 + x2) / 2 / size.width).toFixed(3)),
              y: parseFloat(((y1 + y2) / 2 / size.height).toFixed(3)),
            },
          };
        });

        // 4. 状态锚点：只回传前 10 个关键元素 —— 返回值也做 Token 预算
        return JSON.stringify({
          status: 'SUCCESS',
          action: `Extracted ${normalizedElements.length} element(s) via local vision model.`,
          state_anchor: {
            screen_resolution: `${size.width}x${size.height}`,
            extracted_count: normalizedElements.length,
            elements: normalizedElements.slice(0, 10),
          },
          next_step: "Review the extracted elements. If the target is found, use its 'center_normalized' to call 'click_mouse'.",
        }, null, 2);

      } catch (error: any) {
        // 失败路径即降级指南：错误消息里写好 Plan B
        const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        return toolErr(
          'Local vision extraction failed.',
          timedOut
            ? `Local vision API timed out after ${config.visionApiTimeoutMs}ms.`
            : error.message,
          "Local vision model failed. Fallback to standard 'take_screenshot' and estimate coordinates manually." +
          (timedOut ? ' (The service may be down — avoid retrying immediately.)' : ''),
        );
      }
    },
  });
}
