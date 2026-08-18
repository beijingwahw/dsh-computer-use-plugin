// src/tools/clickMouse.ts
// 世界级升级：三坐标换算锚点 + dHash 效果验证（盲点检测）+ 置信度自报 +
// 验证生效自动写入 UI 记忆。模型第一次能「感知自己是否点中了」。
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Config } from '../config';
import { system } from '../system';
import { captureBefore, settleAndVerify, CombinedEffect } from '../actionVerifier';
import { focusTracker } from '../focusTracker';
import { semanticConfirm, SemanticConfirm } from '../textReader';
import { matchesRiskPatterns, matchesDangerPatterns } from '../riskGate';
import { approval } from '../approval';
import { uiMemory } from '../uiMemory';
import { regionDhash, similarity } from '../perceptualHash';
import { parseExpectation } from '../intent';
import { quantum } from '../quantumSense';
import { toolOk, toolErr } from '../toolResult';

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
      from_memory_id: {
        type: 'number', required: false,
        description: 'Landmark ID from recall_ui. When provided, the system PRE-VERIFIES locally that the target still looks like it did when remembered — clicks on moved/changed targets are aborted before execution.',
      },
      approval_token: {
        type: 'string', required: false,
        description: 'One-shot token from request_approval. Required for irreversible targets (send/delete/pay/submit order...).',
      },
      // ── C-1 意图感知验证：声明预期，物理规则引擎带着预期找证据 ──
      expected_effect: {
        type: 'string', required: false,
        description: 'EXPECTED visual effect if this click succeeds — a kind string or JSON. Kinds: ' +
          'toggle_on (checkmark appears), toggle_off, menu_expand (dropdown opens), menu_collapse, ' +
          'input_focus (caret appears), page_navigate. Example: {"kind":"menu_expand"}',
      },
      reasoning: {
        type: 'string', required: false,
        description: 'Why you chose this action (one sentence). Recorded into the causal journal for later counterfactual analysis.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const { x, y, button = 'left', confidence, target_description, expected_change, expected_text, from_memory_id, approval_token, expected_effect, reasoning } = args;

      // 双保险校验（Guard 已在前线，工具自查兜底）
      if (x < 0 || x > 1 || y < 0 || y > 1) {
        return toolErr(
          'Click validation failed.',
          `Invalid normalized coordinates (${x}, ${y}). X and Y must be between 0.0 and 1.0.`,
          'Re-estimate the target center from the latest screenshot; zoom_inspect can refine the estimate.',
        );
      }

      // ── 不可逆操作闸门（第六轮 + B-3 两阶段）：危险目标必须持有效令牌 ──
      // 阶段一 validate：只查不烧 —— 点击若抛异常，令牌仍可用于重试；
      // 阶段二 consume 在动作成功返回前调用（见下方 finally 前的成功路径）。
      const dangerous = config.enableApprovalGate
        && !!target_description
        && matchesDangerPatterns(target_description, config.dangerPatterns);
      if (dangerous && !(approval_token && approval.validate(approval_token))) {
        approval.sweep();
        return JSON.stringify({
          status: 'ACTION_REQUIRED',
          state_anchor: {
            target: target_description,
            reason: 'irreversible-action',
            note: 'This target looks irreversible (send/delete/pay/submit...).',
          },
          next_step: 'PAUSE: this action needs explicit user approval. Call request_approval with a clear ' +
            'description, tell the user what you are about to do, wait for their consent, then re-invoke ' +
            'click_mouse with the returned approval_token. Never proceed without consent.',
        }, null, 2);
      }

      try {
        const size = await system.getScreenSize();
        const px = Math.round(x * size.width);
        const py = Math.round(y * size.height);

        // ── 记忆预验（第六轮）：点击前本地核实目标还在原位 ──
        // recall_ui 给的是历史坐标；屏幕可能已变。取当前屏同位置区域指纹与
        // 记忆时的目标外观对比：不像 ⇒ 目标已移动/消失，点击中止（防 stale-click）
        let preVerified: boolean | undefined;
        if (typeof from_memory_id === 'number' && !config.dryRun) {
          const lm = uiMemory.get(from_memory_id);
          if (!lm) {
            return toolErr(
              `Landmark #${from_memory_id} click aborted.`,
              'Landmark not found in memory.',
              "Call 'recall_ui' to refresh landmark IDs, then retry with the correct from_memory_id.",
            );
          }
          if (lm.regionHash) {
            const curBuf = await system.captureScreen();
            const curRegion = await regionDhash(curBuf, lm.normalized.x, lm.normalized.y, config.regionVerifyRadius);
            const matchScore = similarity(curRegion, lm.regionHash);
            if (matchScore < 0.85) {
              return JSON.stringify({
                status: 'FAILED',
                state_anchor: {
                  pre_verification: {
                    landmark: from_memory_id,
                    appearance_similarity_pct: Math.round(matchScore * 1000) / 10,
                    verdict: 'target-changed',
                  },
                },
                next_step: 'ABORTED BEFORE CLICK: the target region no longer looks like it did when remembered ' +
                  '(the UI probably changed). Do NOT click stale coordinates — take a fresh screenshot and re-locate.',
              }, null, 2);
            }
            preVerified = true;
          }
        }

        // ── 效果验证（双尺度 + C-1 意图感知）：动作前同时取全屏 + 点击点区域指纹 ──
        // 区域指纹放大局部反馈（光标/高亮/展开），弥补全屏 dHash 的局部盲区
        // C-1：声明了 expected_effect 时保留动作前帧 —— 物理规则需要前后两帧对比
        const expectation = config.intentVerify ? parseExpectation(expected_effect) : null;
        const verify = config.verifyActions && !config.dryRun;
        const before = verify
          ? await captureBefore({ x, y }, config.regionVerifyRadius, !!expectation)
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
            physicsRules: config.physicsRules,
          }, expectation);
        }
        // D-3 量子感知：验证证据喂给状态机（effect=null ⇒ undefined ⇒ 不计数）
        quantum.recordEffect(effect?.detected);

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

        // ── 自适应下一步指引：双尺度判定 + C-1 意图裁决 + 预期核对 ──
        const noopSuspected = effect && !effect.detected;
        const intentBetrayed = effect?.intent && !effect.intent.satisfied && effect.detected;
        const lowConfidence = typeof confidence === 'number' && confidence < 0.6;
        let nextStep = "MANDATORY: Call 'take_screenshot' to verify the UI state change.";
        if (intentBetrayed) {
          nextStep = `INTENT MISMATCH: the screen changed but NOT in the expected way (${effect!.intent!.evidence}). ` +
            'The click probably landed on the wrong element — treat as partial failure and re-examine.';
        } else if (noopSuspected) {
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

        // ── 阶段二（B-3）：动作成功，令牌用后即焚 ──
        // 放在 SUCCESS return 前的最后一步：点击抛异常走 catch 路径，令牌不烧可重试
        if (dangerous && approval_token) approval.consume(approval_token);

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
              // C-1 意图裁决：期望 kind + 物理证据（与 detected 分歧 = 高级幻觉警报）
              intent: effect.intent ?? undefined,
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
        // B-3 注：异常路径不烧审批令牌（validate 只查不烧；consume 仅在成功 return 前调用）
        return toolErr(
          `Mouse ${button} click at (${x}, ${y}) failed.`,
          error.message,
          'Analyze the error and try a different approach; if an approval_token was used it is still valid for one retry.',
        );
      }
    },
  });
}
