// src/tools/typeText.ts
// 三层融合：长度防御（迭代中曾丢失，此处找回）+ 平台抽象（全部委托 system）+ 输入状态锚点。
// input_state 的二值语义（Replaced / Appended）让模型在验证截图前就知道该预期什么。
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Config } from '../config';
import { system } from '../system';
import { captureBefore, settleAndVerify } from '../actionVerifier';
import { quantum } from '../quantumSense';
import { focusTracker } from '../focusTracker';
import { semanticConfirm, SemanticConfirm } from '../textReader';
import { matchesRiskPatterns } from '../riskGate';

export function createTypeTextTool(config: Config) {
  return defineTool({
    name: 'type_text',
    description: 'Types text into the currently focused UI element. Use this after clicking on an input field.',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: 'The exact text string to type into the focused element.',
      },
      clearFirst: {
        type: 'boolean',
        required: false,
        description: 'Set to true to select all and clear existing text before typing. Default is false.',
      },
      expected_change: {
        type: 'string', required: false,
        description: 'What should appear if typing succeeds? e.g., "the typed text shows in the input field".',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const { text, clearFirst = false, expected_change } = args;

      // 前哨闸门：工具参数是被模型控制的输入面，防注入恶意长文本
      if (text.length > config.maxTextLength) {
        return `[Error]: Text too long. Maximum length is ${config.maxTextLength} characters.`;
      }

      // ── 风险闸门（第五轮）：凭据类输入不代劳 ──
      // 两级判定：焦点被标记为敏感区（点击密码框后），或文本自身命中风险语义
      // （如 "验证码 123456"）。拦截且绝不回显待输入内容。
      if (config.enableRiskGate && (
        focusTracker.isSensitive(config.focusMaxAgeMs) || matchesRiskPatterns(text, config.riskPatterns)
      )) {
        return JSON.stringify({
          status: 'ACTION_REQUIRED',
          state_anchor: {
            current_state: 'Sensitive input detected (credentials / verification code).',
            typed_content: '[REDACTED]', // 绝不回显敏感内容
          },
          next_step: 'STOP: do not type secrets yourself. Ask the user to enter this value personally ' +
            '(or provide it explicitly in chat). After the user finishes, continue with take_screenshot.',
        }, null, 2);
      }

      try {
        // 效果验证（焦点区域放大）：输入的变化几乎总发生在「最近点击的位置」——
        // 焦点追踪器把上次点击坐标隐式传给本工具，文字出现这类局部变化
        // 在全屏指纹里撑不动距离，但在焦点区域指纹里是巨变
        const verify = config.verifyActions && !config.dryRun;
        const focus = focusTracker.get(config.focusMaxAgeMs);
        const before = verify ? await captureBefore(focus, config.regionVerifyRadius) : null;

        await system.typeText(text, clearFirst);

        let effect = null;
        if (before) {
          effect = await settleAndVerify(before, {
            adaptive: config.adaptiveSettle,
            settleMs: config.actionSettleMs,
            threshold: config.noopSimilarityThreshold,
            regionRadius: config.regionVerifyRadius,
          });
        }
        // D-3 量子感知：验证证据喂给状态机（effect=null ⇒ undefined ⇒ 不计数）
        quantum.recordEffect(effect?.detected);
        const noopSuspected = effect && !effect.detected;

        // ── 语义自证（第四轮）：OCR 核对「输入的文字真的上屏了」──
        // 无需模型传参：把 typed 内容的前 40 字符作为预期文本，在焦点邻域核对。
        // 「打字进了错误的输入框 / 输入法吞字 / 焦点丢失」三类事故在此现形
        let typedConfirmed: SemanticConfirm | 'ocr-unavailable' | null = null;
        if (config.enableOcr && focus && effect?.detected) {
          typedConfirmed = await semanticConfirm(
            effect.afterBuffer, focus.x, focus.y,
            Math.max(config.regionVerifyRadius * 1.5, 0.2),
            text.slice(0, 40), config.ocrLang,
          ) ?? 'ocr-unavailable';
        }

        return JSON.stringify({
          status: 'SUCCESS',
          action: 'Text typed successfully.',
          state_anchor: {
            // 回显也做 Token 预算：截断到 50 字符
            typed_content: text.substring(0, 50) + (text.length > 50 ? '...' : ''),
            char_count: text.length,
            cleared_existing: clearFirst,
            input_state: clearFirst ? 'Replaced all previous content' : 'Appended to existing content',
            effect: effect ? {
              detected: effect.detected,
              scale: effect.scale,
              screen_similarity_pct: effect.screen.similarity_pct,
              region_similarity_pct: effect.region ? effect.region.similarity_pct : undefined,
              verified_around_focus: effect.region ? true : false,
            } : 'verification-off',
            expected_change: expected_change || undefined,
            typed_semantic: typedConfirmed
              ? (typedConfirmed === 'ocr-unavailable'
                ? 'ocr-unavailable'
                : { confirmed: typedConfirmed.confirmed, region_text_snippet: typedConfirmed.snippet })
              : undefined,
          },
          next_step: noopSuspected
            ? 'WARNING: Neither the screen nor the focus region changed — the input may have NO focus. Click the input field first, then retype.'
            : (typedConfirmed && typedConfirmed !== 'ocr-unavailable' && !typedConfirmed.confirmed
              ? 'SEMANTIC MISMATCH: the typed text was NOT found in the focus region — it may have gone to the WRONG field or been swallowed by an IME. Verify with take_screenshot and retype if needed.'
              : "MANDATORY: Call 'take_screenshot' immediately to verify that the text appears correctly in the input field." +
                (expected_change ? ` Confirm: "${expected_change}".` : '')),
        }, null, 2);

      } catch (error: any) {
        return JSON.stringify({
          status: 'FAILED',
          error: error.message,
          next_step: 'The text input failed. Check if an input field is currently focused. Call take_screenshot to verify the UI state.',
        }, null, 2);
      }
    },
  });
}
