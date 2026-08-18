// src/tools/clickMouse.ts
// 世界级升级：三坐标换算锚点 + dHash 效果验证（盲点检测）+ 置信度自报 +
// 验证生效自动写入 UI 记忆。模型第一次能「感知自己是否点中了」。
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Config } from '../config';
import { system } from '../system';
import { captureBefore, settleAndVerify, CombinedEffect } from '../actionVerifier';
import { focusTracker } from '../focusTracker';
import { semanticConfirm, SemanticConfirm } from '../textReader';
import { matchesRiskPatterns } from '../riskGate';
import { uiMemory } from '../uiMemory';

export function createClickMouseTool(config: Config) {
  return defineTool({
    name: 'click_mouse',
    description: 'Clicks the mouse at normalized coordinates (0.0 to 1.0). ' +
      'Effect verification is built-in: the result tells you whether the screen actually changed. ' +
      'Provide target_description to strengthen spatial memory.',
    parameters: {
      x: { type: 'number', required: true, description: 'X coordinate (0.0-1.0)' },
      y: { type: 'number', required: true, description: 'Y coordinate (0.0-1.0)' },
      button: { type: 'string', required: false, description: 'left, right, or middle' },
      confidence: {
        type: 'number', required: false,
        description: 'Your confidence in these coordinates (0.0-1.0). If below 0.6, consider zoom_inspect first.',
      },
      target_description: {
        type: 'string', required: false,
        description: 'Short description of what you are clicking (e.g., "GitHub 搜索框"). Used for UI memory.',
      },
      expected_change: {
        type: 'string', required: false,
        description: 'What visual change do you EXPECT if the click succeeds? e.g., "a dropdown expands", "input gains focus". Used to verify the effect semantically.',
      },
      expected_text: {
        type: 'string', required: false,
        description: 'Text you EXPECT to appear near the click point if it succeeds (requires enableOcr). The system OCR-verifies it automatically.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const { x, y, button = 'left', confidence, target_description, expected_change, expected_text } = args;

      // 双保险校验（Guard 已在前线，工具自查兜底）
      if (x < 0 || x > 1 || y < 0 || y > 1) {
        return `[Error]: Invalid normalized coordinates. X and Y must be between 0.0 and 1.0.`;
      }

      try {
        const size = await system.getScreenSize();
        const px = Math.round(x * size.width);
        const py = Math.round(y * size.height);

        // ── 效果验证（双尺度）：动作前同时取全屏 + 点击点区域指纹 ──
        // 区域指纹放大局部反馈（光标/高亮/展开），弥补全屏 dHash 的局部盲区
        const verify = config.verifyActions && !config.dryRun;
        const before = verify
          ? await captureBefore({ x, y }, config.regionVerifyRadius)
          : null;

        await system.clickMouse(px, py, button);

        // 焦点登记：后续 type_text 的区域验证将以此为中心（隐式工具间上下文）。
        // 风险感知：目标描述命中凭据语义 ⇒ 焦点标记为敏感，后续输入将被闸门拦截
        const sensitive = config.enableRiskGate
          && !!target_description
          && matchesRiskPatterns(target_description, config.riskPatterns);
        focusTracker.set(x, y, sensitive);

        let effect: CombinedEffect | null = null;
        if (before) {
          effect = await settleAndVerify(before, {
            adaptive: config.adaptiveSettle,
            settleMs: config.actionSettleMs,
            threshold: config.noopSimilarityThreshold,
            regionRadius: config.regionVerifyRadius,
          });
        }

        // ── 自动记忆：验证生效 + 模型给了描述 ⇒ 写入场景记忆（含当时整屏指纹） ──
        let memoryNote = '';
        if (effect?.detected && config.autoRemember && target_description) {
          const lm = uiMemory.remember(target_description, x, y, undefined, before?.screen);
          memoryNote = ` Landmark #${lm.id} saved.`;
        }

        // ── 语义核对（第四轮）：OCR 检查预期文字是否出现在点击点邻域 ──
        // 像素验证回答「有没有变化」，语义核对回答「变化是不是预期的内容」
        let semantic: SemanticConfirm | 'ocr-unavailable' | null = null;
        if (expected_text && config.enableOcr && effect?.detected) {
          semantic = await semanticConfirm(
            effect.afterBuffer, x, y,
            Math.max(config.regionVerifyRadius * 1.5, 0.2),
            expected_text, config.ocrLang,
          ) ?? 'ocr-unavailable';
        }

        // ── 自适应下一步指引：双尺度判定 + 预期核对 ──
        const noopSuspected = effect && !effect.detected;
        const lowConfidence = typeof confidence === 'number' && confidence < 0.6;
        let nextStep = "MANDATORY: Call 'take_screenshot' to verify the UI state change.";
        if (noopSuspected) {
          nextStep = 'WARNING: Neither the screen nor the clicked region changed — you may have MISSED the target. ' +
            "Call 'zoom_inspect' around this point to refine coordinates, then retry.";
        } else if (lowConfidence) {
          nextStep = "Low confidence reported. Consider 'zoom_inspect' for finer grounding before the next action.";
        }
        if (!noopSuspected && expected_change) {
          nextStep += ` Then CONFIRM your expectation: "${expected_change}" — if it did NOT happen, treat this as a partial failure.`;
        }
        if (semantic && semantic !== 'ocr-unavailable' && !semantic.confirmed) {
          nextStep = `SEMANTIC MISMATCH: expected text "${expected_text}" was NOT found near the click point. ` +
            `Treat this click as FAILED even though pixels changed — re-examine with diff_view / take_screenshot.`;
        }
        if (sensitive) {
          nextStep = 'SENSITIVE FIELD: this looks like a credentials/input-secret area. ' +
            'Do NOT type secrets via type_text here — ask the USER to enter them personally, then continue with take_screenshot.';
        }

        return JSON.stringify({
          status: 'SUCCESS',
          action: `Mouse ${button} clicked.`,
          state_anchor: {
            normalized: { x, y },
            absolute_pixels: { x: px, y: py },
            screen_resolution: `${size.width}x${size.height}`,
            effect: effect ? {
              detected: effect.detected,
              scale: effect.scale, // page-level / element-level / none
              screen_similarity_pct: effect.screen.similarity_pct,
              region_similarity_pct: effect.region ? effect.region.similarity_pct : undefined,
            } : 'verification-off',
            expected_change: expected_change || undefined, // 预期锚定：模型行动前声明的预期
            sensitive_focus: sensitive || undefined,       // 风险闸门：焦点已标记为凭据区
            semantic: semantic
              ? (semantic === 'ocr-unavailable'
                ? 'ocr-unavailable'
                : { expected_text: expected_text, confirmed: semantic.confirmed, region_text_snippet: semantic.snippet })
              : undefined,
          },
          memory: memoryNote || undefined,
          next_step: nextStep,
        }, null, 2);

      } catch (error: any) {
        return JSON.stringify({
          status: 'FAILED',
          error: error.message,
          next_step: 'Analyze the error and try a different approach or re-evaluate the screen.',
        }, null, 2);
      }
    },
  });
}
