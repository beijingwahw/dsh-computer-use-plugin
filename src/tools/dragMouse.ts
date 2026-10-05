// src/tools/dragMouse.ts
// 四拍时序（移->按->移->放）下沉 system.dragMouse；本层负责校验与换算锚点。
// 修复原版：Button 未导入的编译错误；四个坐标各自独立校验与换算。
//
// ΑΩ-R29 老工具方言整治：SUCCESS 回执收编 toolOk 工厂 —— 手拼对象的键序
//（status/action/state_anchor/next_step）与缩进（null,2）与工厂产出逐字节相同，
// 消除手拼零形状变化。不收编清单（差异键 + 为什么）：
//   · 越界拒绝 `[Error]: Invalid drag coordinates...` 前缀方言 —— 工厂只产 JSON
//     四件套，无法复现前缀串；epochDelta.perimeter.test.ts 正则钉死该形状。
//   · 危险目的地 ACTION_REQUIRED：无顶层 action 键、reason 落位 state_anchor
//     中部（toolActionRequired 会注入 action 并把 reason 前置合并，键序漂移）
//     —— clickMouse ΑΩ-R11 同律定谳的方言族，保持现状。
//   · catch `[Error]: Drag operation failed...` 前缀方言 —— 同上，非工厂可产。
//
// ΠΑΝ-13（拖拽侧门封堵 · 批判报告 C1-5 H4 的修法面）：与 clickMouse 同级的
// 门禁接线 —— 判定/公证/预留三件套补齐：
//   ① 危险判定接入 actionGate.assertActionAllowed('drag_mouse')（此前是本文件
//     内联的纯自述判定 —— matchesDangerPatterns 单通道；现在走闸门判定核，
//     语义等价且与工具层/重放层共用同一事实源）；
//   ② 双钥公证锁（Ρ 纪元原语）：放行路径上对**落点**取 OCR 实读 + 白盒控件名
//     （notaryEvidence 自 clickMouse 导出复用），携证据重审 —— 目的地实读见危险
//     ⇒ 审批执法；实读与自述不符 ⇒ notary-mismatch（「拖进回收站」的谎报
//     根除点）。锁关/通道缺席 ⇒ 零行为（完全旧路径）；
//   ③ 派发预留 + 步终结算（Δ#2/V 纪元语义）：beginAttempt 原子预留（并发双花
//     封堵）→ 物理派发 → 步终按验证判决结算（verified ⇒ consume 焚毁 /
//     no-effect ⇒ attemptFailed 释放重试 / 派发异常 ⇒ attemptFailed 释放）。
//     取代旧「派发即焚」—— 一次用户同意不再在验证缺席时被预支，且并发的第
//     二回合在落到物理世界之前即被拒。验证关闭（effect=null，dry-run/双钥匙
//     逃生门语境）维持派发即消费旧方言（P-6 锚点逐字节保持）。
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Config } from '../config';
import { system } from '../system';
import * as backend from '../physicalBackend';
import { captureBefore, settleAndVerify, sleep } from '../actionVerifier';
import { normalizeHash, similarity } from '../perceptualHash';
import { quantum } from '../quantumSense';
import { focusTracker } from '../focusTracker';
import { matchesRiskPatterns } from '../riskGate';
import { approval } from '../approval';
import { journal } from '../journal';
import { toolOk } from '../toolResult';
import {
  consumeApprovalAmendment, gateByReversibility, laneAnchorOf,
  notaryEvidence, notaryAnchorOf, consumeApprovalWithHint,
} from './clickMouse';
import { assertActionAllowed, type ActionGateDecision, type NotaryEvidence } from './actionGate';

// ─── Y-4 运输验证判决（纯函数 —— 测试的确定性事实源）───
//
// 拖拽的本体论：不是「屏幕变了」（那是 click 的语义），而是「被抓取物从 A
// 运动到了 B」。证据三元组：起点区内容指纹（前）、终点区内容指纹（后）、
// 起点区内容指纹（后）。运输成立 = 前A ≈ 后B（同一视觉内容现在在目的地）；
// 腾空成立 = 前A ≄ 后A（原位置不再显示该内容）。两者同时成立 = 完整运输。

export interface TransportVerdict {
  transported: boolean;
  vacated: boolean;
  copyLike: boolean; // 内容出现在目的地但原位也在 = 复制/克隆语义
}

export function judgeTransport(
  beforeStartHash: string | null,
  afterEndHash: string | null,
  afterStartHash: string | null,
  thresholds: { transported: number; vacated: number } = { transported: 0.75, vacated: 0.85 },
): TransportVerdict | null {
  if (!beforeStartHash || !afterEndHash) return null;
  const atDestination = similarity(normalizeHash(beforeStartHash), normalizeHash(afterEndHash));
  const stillAtSource = afterStartHash
    ? similarity(normalizeHash(beforeStartHash), normalizeHash(afterStartHash))
    : null;
  const transported = atDestination >= thresholds.transported;
  const vacated = stillAtSource === null ? false : stillAtSource < thresholds.vacated;
  return {
    transported,
    vacated,
    copyLike: transported && stillAtSource !== null && stillAtSource >= thresholds.vacated,
  };
}

export function createDragMouseTool(config: Config) {
  return defineTool({
    name: 'drag_mouse',
    description:
      'Clicks and holds the mouse at a starting point, drags to an ending point, and releases. ' +
      'Used for moving files, resizing windows, or dragging sliders.',
    parameters: {
      startX: { type: 'number', required: true, description: 'Start X coordinate (0.0 to 1.0).' },
      startY: { type: 'number', required: true, description: 'Start Y coordinate (0.0 to 1.0).' },
      endX: { type: 'number', required: true, description: 'End X coordinate (0.0 to 1.0).' },
      endY: { type: 'number', required: true, description: 'End Y coordinate (0.0 to 1.0).' },
      // Δ 纪元（安全外围#6）：拖拽安检的可判定语义面 —— 描述**目的地**（拖到哪）。
      // 可选通道（拖滑块/调窗口无危险语义，不设 click 式硬前置）。
      target_description: {
        type: 'string',
        description: 'What you are dragging and WHERE you drop it (e.g., "report.doc onto the 删除/回收站 zone"). ' +
          'Feeds the danger/approval gate: a drag into a delete/send/pay zone is as irreversible as the click ' +
          'that triggers it — supply approval_token for such targets. The drop point is independently ' +
          'notarized (OCR screen-read + whitebox control name): a description that contradicts the screen ' +
          'is rejected (notary-mismatch).',
      },
      approval_token: {
        type: 'string',
        description: 'One-shot token from request_approval. Required for irreversible drag destinations ' +
          '(delete/recycle bin/send/pay...).',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const { startX, startY, endX, endY, target_description, approval_token } = args;

      // NaN 卫兵：NaN 与任何比较皆为 false，会穿过四重 bounds 检查直达
      // Math.round(NaN * size) —— 物理层收到 NaN 像素
      if (!Number.isFinite(startX) || !Number.isFinite(startY) ||
          !Number.isFinite(endX) || !Number.isFinite(endY) ||
          startX < 0 || startX > 1 || startY < 0 || startY > 1 ||
          endX < 0 || endX > 1 || endY < 0 || endY > 1) {
        return `[Error]: Invalid drag coordinates. All four values must be between 0.0 and 1.0.`;
      }

      // ── W1-2 批注消费接线（W2-2）：危险判定之前读 amendment patch 修正计划 ──
      // 抓取点（start）与目标描述参与修正（RawActionShape 是单点形状 —— 拖拽的
      // 抓取点先行；目的地语义修正走 target_description）。修正后的描述参与
      // 危险判定（用户批注把拖拽改述为「拖进删除区」⇒ 按危险处理 —— 批注不得
      // 成为绕闸通道）。无令牌/无批注 ⇒ 零行为（旧路径逐字节不变）。
      const amendment = consumeApprovalAmendment(
        approval_token,
        { tool: 'drag_mouse', x: startX, y: startY, target_description },
      );
      const effStartX = amendment.x ?? startX;
      const effStartY = amendment.y ?? startY;
      const effTarget = amendment.target_description ?? target_description;

      // ── ΠΑΝ-13：拖拽安检接入 actionGate（与 clickMouse 同一判定事实源）───
      // 旧实现是本文件内联的纯自述判定（matchesDangerPatterns 单通道）——
      // 现在走 assertActionAllowed('drag_mouse')：语义逐条等价（危险信号计算 /
      // 拒绝归因 token 在场 'token-not-granted-or-expired' / 缺席
      // 'irreversible-action' / 阻断路径 sweep / 描述可选通道不设 undescribed
      // 硬前置），且为下方的公证第二遍与重放层预留了同一分派面。阻断回执
      // 方言与旧实现逐字节相同（P-6 测试钉死）。
      const gate = assertActionAllowed(
        'drag_mouse',
        { target_description: effTarget, approval_token },
        config,
      );
      if (!gate.allowed) {
        return JSON.stringify({
          status: 'ACTION_REQUIRED',
          state_anchor: {
            target: effTarget ?? '(undescribed drag)',
            danger_signal: gate.dangerSignalChannel ?? 'target_description',
            reason: gate.reason,
            normalized: { start: { x: effStartX, y: effStartY }, end: { x: endX, y: endY } },
            note: approval_token
              ? 'The token exists but the user has not granted it yet (or it expired).'
              : 'This drag destination looks irreversible (delete/recycle bin/send/pay...).',
          },
          next_step: 'PAUSE: this drag needs explicit user approval. Call request_approval with a clear ' +
            'description (what is being dragged and where it lands), relay the message, wait for consent, ' +
            'call grant_approval(token, true), then re-invoke drag_mouse with the returned approval_token. ' +
            'Never proceed without consent.',
        }, null, 2);
      }

      // ── ΠΑΝ-13：双钥公证锁（第二遍）—— 放行路径上对**落点**独立取证重审 ──
      // 与 clickMouse 的 notaryStage 同律（notaryEvidence 原语复用，取证中心
      // 是拖拽落点 endX/endY —— 危险语义挂在「拖到哪」上）：OCR 实读 + 白盒
      // 控件名任一通道见危险 ⇒ 审批执法；OCR 实读与自述不符 ⇒ notary-mismatch。
      // 取证失败一律 null（诚实缺席），锁只在「通道在场且见危险/不符」时收紧。
      // 总开关关 / 通道不可用 ⇒ 零行为（完全旧路径 —— P-6/r29 测试语境）。
      let gate2: ActionGateDecision = gate;
      let notarization: Record<string, unknown> | undefined;
      if (config.enableNotarizationLock && !config.dryRun) {
        const avail = notaryEvidence.channelsAvailable(config);
        if (avail.ocr || avail.structural) {
          let evidence: NotaryEvidence | undefined;
          try {
            evidence = {
              ocrLabel: avail.ocr ? await notaryEvidence.readOcrLabel(config, endX, endY) : null,
              structuralName: avail.structural ? await notaryEvidence.readStructuralName(config, endX, endY) : null,
            };
            gate2 = assertActionAllowed(
              'drag_mouse',
              { target_description: effTarget, approval_token },
              config,
              evidence,
            );
          } catch {
            // 宪法：运行层永不抛 —— 取证自身失败 = 通道缺席，维持第一遍判决
            evidence = undefined;
            gate2 = gate;
          }
          notarization = notaryAnchorOf(gate2.notarization, evidence, gate2.notaryNote);
          if (!gate2.allowed) {
            // 审计留痕：公证拦截入防篡改链（GUARD_BLOCKED 方言，clickMouse 同律）
            void journal.appendMarker({
              kind: 'GUARD_BLOCKED',
              guard: 'notary-lock',
              reason: gate2.reason === 'notary-mismatch'
                ? 'notary-mismatch'
                : `danger:${gate2.dangerSignalChannel ?? 'unknown'}`,
            }).catch(() => { /* 存证旁路 */ });
            const mismatch = gate2.reason === 'notary-mismatch';
            const ocrSnippet = (evidence?.ocrLabel ?? '').slice(0, 60);
            return JSON.stringify({
              status: 'ACTION_REQUIRED',
              state_anchor: {
                target: effTarget ?? '(undescribed drag)',
                danger_signal: gate2.dangerSignalChannel ?? 'target_description',
                reason: gate2.reason,
                notarization,
                normalized: { start: { x: effStartX, y: effStartY }, end: { x: endX, y: endY } },
                note: mismatch
                  ? 'The text actually READ FROM THE SCREEN at the drop point does not match your description ' +
                    '(semantic handshake failed) — the destination may have moved, or the description is wrong.'
                  : approval_token
                    ? 'The token exists but the user has not granted it yet (or it expired).'
                    : 'This drop destination looks irreversible — the danger was NOTARIZED FROM THE SCREEN ' +
                      '(OCR-read label / whitebox control name), not taken from your description.',
              },
              next_step: mismatch
                ? `NOTARY MISMATCH: the drop point actually reads "${ocrSnippet}". RE-DESCRIBE the destination ` +
                  'using the text ACTUALLY SHOWN ON SCREEN (put it in target_description) and retry the drag. ' +
                  "If the screen has changed, call 'take_screenshot' first and re-locate the destination."
                : 'PAUSE: this drag needs explicit user approval. Call request_approval with a clear ' +
                  'description (quote the text actually shown at the destination), tell the user what you are ' +
                  'about to do, wait for their consent, call grant_approval(token, true), then re-invoke ' +
                  'drag_mouse with the returned approval_token. Never proceed without consent.',
            }, null, 2);
          }
        } else {
          notarization = notaryAnchorOf('degraded', undefined, 'notary-channels-unavailable');
        }
      }
      const dangerous = gate2.dangerous;

      // ── W5-0（C 接线 · W4-3 S5）：可逆性分道 —— 目的地语义即描述面 ──
      // 「拖进回收站」与「点删除按钮」同属可补偿/不可逆族 —— 与 click 同律
      // 三路执法（ΠΑΝ-13 后危险拖拽同样走预留/结算，escrow 道铸预案先行成立）。
      // 开关关（缺省）⇒ applied:false 零行为。
      const laneGate = await gateByReversibility(config, {
        tool: 'drag_mouse',
        ...(effTarget !== undefined ? { description: effTarget } : {}),
        ...(approval_token !== undefined ? { approvalToken: approval_token } : {}),
        enforceEscrow: !!(dangerous && approval_token),
      });
      if (laneGate.applied && laneGate.blocked !== null) {
        return laneGate.blocked;
      }

      // ΠΑΝ-13：本回合是否已持有 beginAttempt 的派发预留（catch 路径据此结算）
      let attemptReserved = false;
      try {
        const size = await system.getScreenSize();
        const startPixel = { x: Math.round(effStartX * size.width), y: Math.round(effStartY * size.height) };
        const endPixel = { x: Math.round(endX * size.width), y: Math.round(endY * size.height) };

        // 效果验证（双尺度）：起点区域是「被抓取物」原来的位置，拖拽后必然剧变；
        // 终点登记为新焦点，供后续输入类动作的区域验证使用
        const verify = config.verifyActions && !config.dryRun;
        const before = verify
          ? await captureBefore({ x: effStartX, y: effStartY }, config.regionVerifyRadius)
          : null;

        // ── ΠΑΝ-13：派发预留（Δ#2 双花窗口封堵 —— 与 clickMouse 同律）───
        // validate（只查不烧）与消费之间隔着多个 await —— 并发两次同令牌调用
        // 都能过 validate、都派发物理拖拽。beginAttempt 在物理派发前原子预留
        // 一次尝试（attempts +1 且同令牌同时只允许一个在途回合），与本行到
        // system.dragMouse 之间零 await —— 并发的第二回合在落到物理世界之前
        // 即被拒（恰一次派发）。预算耗尽在派发前焚毁。
        if (dangerous && approval_token) {
          // ΤΕΛ-3b：预留面补齐 targetHint（此前只 consume 携、beginAttempt 裸调 ——
          // 绑定令牌会在预留处恒被 target-hint-required 拒绝，同一形状双标准）。
          // 形状与步终消费点（consumeApprovalWithHint）严格一致：描述级
          // {tool:'drag_mouse', target_description}（effTarget 已是批注修正后的
          // 目的地描述 —— 与消费点同源同值）。未绑定令牌零行为（兼容律）。
          if (!approval.beginAttempt(approval_token, {
            target: { tool: 'drag_mouse', target_description: effTarget },
          })) {
            approval.sweep();
            return JSON.stringify({
              status: 'ACTION_REQUIRED',
              state_anchor: {
                target: effTarget ?? '(undescribed drag)',
                approval_gate: 'attempt-reservation-denied',
                reason: 'attempt-in-flight-or-budget-exhausted',
                normalized: { start: { x: effStartX, y: effStartY }, end: { x: endX, y: endY } },
                note: 'The token is valid, but another attempt under it is still in flight, or its retry budget is exhausted.',
              },
              next_step: 'Do NOT re-invoke drag_mouse concurrently with the same token — wait for the in-flight ' +
                'attempt to settle. If the retry budget is exhausted, call request_approval again and explain to ' +
                'the user why the action keeps failing.',
            }, null, 2);
          }
          attemptReserved = true;
        }

        await system.dragMouse(startPixel, endPixel);
        // ΠΑΝ-13：终点焦点登记带敏感判定（L12 收口 —— 与 clickMouse 同律）——
        // 目的地描述命中凭据语义（拖进密码框）⇒ 焦点标记敏感，后续 type_text
        // / 粘贴面热键将被闸门拦截。
        const sensitiveEnd = config.enableRiskGate
          && !!effTarget
          && matchesRiskPatterns(effTarget, config.riskPatterns);
        focusTracker.set(endX, endY, sensitiveEnd);

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

        // ── Y-4 运输验证：被抓取物真的从起点运动到终点了吗 ──
        let transport: TransportVerdict | null = null;
        if (verify) {
          try {
            const r = Math.max(config.regionVerifyRadius, 0.08);
            const atEnd = await backend.captureProcessed({
              metaOnly: true,
              wantRegionHash: { x: endX, y: endY, r },
            });
            const atStart = await backend.captureProcessed({
              metaOnly: true,
              wantRegionHash: { x: effStartX, y: effStartY, r },
            });
            transport = judgeTransport(
              before?.region ?? null,
              atEnd.regionDhash ?? null,
              atStart.regionDhash ?? null,
            );
          } catch { /* 运输验证是旁路义务：失败不毒化主判决 */ }
        }

        // ── ΠΑΝ-13：步终结算（取代旧「派发即焚」）───
        // 旧法：派发后立即 consume —— 验证缺席/失败也预支用户的同意，且并发
        // 双花窗口敞开（C1-5 H4 次级病灶）。新法（clickMouse 验收式消费同律）：
        //   · 验证通道关闭（effect=null：dry-run / verifyActions=false 语境）⇒
        //     无从验收，维持旧方言（派发即消费 —— P-6 锚点逐字节保持）；
        //   · no-effect（世界没变）⇒ attemptFailed 释放预留 + TTL 续期 ——
        //     未生效的尝试没有消耗用户的同意，同授权内自动重试；
        //   · transport-mismatch（像素变了但没运走）⇒ 同上（世界可能已被意外
        //     改变，attemptFailed 触发托管补偿 saga）；
        //   · verified（变化 + 内容到位）⇒ consume 焚毁（ΠΑΝ-12：统一落点，
        //     targetHint 随行透传 —— 令牌-目标绑定的接线预留）。
        // 派发异常在下方 catch 结算（attemptFailed 只释放预留 —— B-3 语义：
        // 异常回合令牌保留供同授权内重试）。
        let acceptance:
          | { verdict: 'verified'; detail: string }
          | { verdict: 'unverified-dispatch-consumed'; detail: string }
          | { verdict: 'retry-allowed'; reason: string; remaining_attempts: number; detail: string }
          | { verdict: 'budget-exhausted'; reason: string; detail: string }
          | undefined;
        if (dangerous && approval_token) {
          if (!effect) {
            // 验证通道关闭：无从验收，维持旧方言（派发即消费，用后即焚）
            consumeApprovalWithHint(approval_token, { tool: 'drag_mouse', target_description: effTarget });
            acceptance = {
              verdict: 'unverified-dispatch-consumed',
              detail: 'Effect verification unavailable (verifyActions=false or dry-run); token consumed on dispatch.',
            };
          } else if (!effect.detected) {
            const r = approval.attemptFailed(approval_token, 'no-effect');
            acceptance = r.valid
              ? {
                verdict: 'retry-allowed', reason: 'no-effect', remaining_attempts: r.remainingAttempts,
                detail: 'No verified world change — the drag did NOT take effect (grabbed nothing / wrong window). ' +
                  `Token STILL VALID (${r.remainingAttempts} attempts left): adjust the start point and RETRY ` +
                  'within the SAME approval. Do NOT ask the user again.',
              }
              : {
                verdict: 'budget-exhausted', reason: 'no-effect',
                detail: 'Retry budget exhausted with no verified effect. The token is void. ' +
                  'Call request_approval again and explain to the user why the action keeps failing.',
              };
          } else if (transport && !transport.transported) {
            const r = approval.attemptFailed(approval_token, 'transport-mismatch');
            acceptance = r.valid
              ? {
                verdict: 'retry-allowed', reason: 'transport-mismatch', remaining_attempts: r.remainingAttempts,
                detail: 'Pixels changed but the grabbed content is NOT at the destination — the drag probably ' +
                  `dropped midway. Token STILL VALID (${r.remainingAttempts} attempts left): re-examine and RETRY ` +
                  'within the SAME approval. Do NOT ask the user again.',
              }
              : {
                verdict: 'budget-exhausted', reason: 'transport-mismatch',
                detail: 'Retry budget exhausted with repeated failed transports. The token is void. ' +
                  'Call request_approval again and explain to the user what keeps going wrong.',
              };
          } else {
            // 验收通过：世界出现了变化且（有运输证据时）内容到达了目的地
            consumeApprovalWithHint(approval_token, { tool: 'drag_mouse', target_description: effTarget });
            acceptance = {
              verdict: 'verified',
              detail: 'Verified world change' + (transport ? ' with the grabbed content transported to the destination' : '') +
                ' — user consent consumed by this irreversible effect. Report the acceptance result to the user.',
            };
          }
        }

        // ΑΩ-R29：SUCCESS 收编 toolOk（工厂产出与旧手拼逐字节相同 —— 键序/缩进一致）。
        return toolOk(
          'Mouse dragged.',
          {
            normalized: { start: { x: effStartX, y: effStartY }, end: { x: endX, y: endY } },
            absolute_pixels: { start: startPixel, end: endPixel },
            screen_resolution: `${size.width}x${size.height}`,
            effect: effect ? {
              detected: effect.detected,
              scale: effect.scale,
              screen_similarity_pct: effect.screen.similarity_pct,
              region_similarity_pct: effect.region ? effect.region.similarity_pct : undefined,
            } : 'verification-off',
            // Y-4 运输三元组：内容级证据（比像素变化更强的「物走了」判决）
            transport: transport
              ? {
                transported: transport.transported,
                vacated: transport.vacated,
                ...(transport.copyLike ? { semantics: 'copy-like (content now at BOTH source and destination)' } : {}),
              }
              : undefined,
            // Δ#6 安检透明化：本次拖拽是否经审批令牌放行（ΠΑΝ-13 步终结算后，
            // 「已随派发消费」只在对验证缺席的旧方言成立 —— verified/retry 的
            // 兑付情况见 acceptance）
            approval_gate: dangerous ? {
              described: true,
              ...(acceptance === undefined || acceptance.verdict === 'unverified-dispatch-consumed'
                ? { token_consumed_on_dispatch: true }
                : {}),
            } : undefined,
            // ΠΑΝ-13：验收式结算裁决（verified / retry-allowed / budget-exhausted /
            // unverified-dispatch-consumed；非令牌动作缺席）
            acceptance: acceptance || undefined,
            // ΠΑΝ-13：双钥公证参与情况（engaged/degraded + 通道在场注记；
            // 总开关关 ⇒ 键不入场 —— 完全旧路径）
            notarization: notarization || undefined,
            // W2-2（W1-2）：批注修正透明化 —— 用户批注把计划修正成了什么
            amendment: amendment.stamp || undefined,
            // W5-0（C 接线）：可逆性分道注记（快道/托管道 + 预案 id；未分道缺席）
            reversibility_lane: laneAnchorOf(laneGate),
          },
          transport && !transport.transported && effect?.detected
            ? 'PIXELS CHANGED BUT NO TRANSPORT: something moved, yet the content you grabbed is NOT at the destination — ' +
              'you may have dragged the wrong object or dropped it midway. take_screenshot to see where it went.'
            : transport && transport.transported
              ? `TRANSPORT VERIFIED: the grabbed content now sits at the destination${transport.vacated ? ' and its old position is empty' : ''}. ` +
                "MANDATORY: take_screenshot to confirm the final layout."
              : noopSuspected
                ? 'WARNING: Neither the screen nor the start region changed — the drag may not have grabbed the target. Verify with take_screenshot and retry with adjusted start point.'
                : "MANDATORY: Call 'take_screenshot' to verify the drag result.",
        );

      } catch (error: any) {
        // ΠΑΝ-13：已预留的尝试在此结算（attemptFailed 只释放预留、不重复计数）
        // —— 令牌保留、TTL 续期，B-3 的「异常后同令牌重试」语义原样保持。
        if (attemptReserved && approval_token) approval.attemptFailed(approval_token, 'dispatch-exception');
        return `[Error]: Drag operation failed. ${error.message}`;
      }
    },
  });
}
