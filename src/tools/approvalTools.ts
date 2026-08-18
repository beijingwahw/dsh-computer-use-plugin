// src/tools/approvalTools.ts
// 第六轮创新之三：人机协同审批工具（request_approval）。
// 与 approval.ts 的一次性令牌机制配套：
//   1. Agent 调用本工具描述即将执行的不可逆操作；
//   2. 工具返回 PENDING 令牌与标准话术，Agent 必须把话术转述给用户并等待同意；
//   3. 用户同意后，Agent 凭话术中的令牌重新调用 click_mouse —— 令牌用后即焚（TTL 120s）。
// 设计要点：
//   - 令牌不等于许可：令牌只是「资格」，真正的许可是用户在对话中的明确同意；
//     工具层无法听见对话，因此引导语强制要求 Agent 先转述、后使用。
//   - grant/revoke 双通道：用户口头同意（grant=true）即激活令牌；拒绝（revoke）立即作废。
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Config } from '../config';
import { approval } from '../approval';

export function createRequestApprovalTool(config: Config) {
  return defineTool({
    name: 'request_approval',
    description:
      'Requests user approval for an irreversible action (send/delete/pay/submit order...). ' +
      'Returns a one-shot token that must accompany the subsequent click_mouse call. ' +
      'Workflow: call this tool -> relay the message to the user -> wait for consent -> ' +
      'call grant_approval if they agree (or stop if they refuse) -> re-invoke click_mouse with the token.',
    parameters: {
      description: {
        type: 'string', required: true,
        description: 'EXACTLY what you are about to do and why, e.g., "click 发送 to submit the email to Alice".',
      },
      consequence: {
        type: 'string', required: false,
        description: 'What happens if this cannot be undone (e.g., "the email will be sent and cannot be recalled").',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      if (!config.enableApprovalGate) {
        return '[System]: Approval gate disabled — no token needed.';
      }
      approval.sweep(); // 顺手清理过期令牌

      const pa = approval.request(args.description);
      const consequence = args.consequence
        ? ` Consequence: ${args.consequence}.`
        : ' This action is likely irreversible.';

      return JSON.stringify({
        status: 'PENDING_USER_CONSENT',
        state_anchor: {
          token: pa.token,
          action: args.description,
          expires_in_seconds: Math.round((pa.expiresAt - Date.now()) / 1000),
        },
        message_to_relay: `I am about to: ${args.description}.${consequence} ` +
          'Do you approve? (yes / no)',
        next_step:
          'RELAY the message_to_relay to the user VERBATIM and WAIT for their reply. ' +
          'If they approve, call grant_approval with the token, then re-invoke click_mouse with ' +
          'approval_token set. If they refuse, do NOT proceed — propose an alternative or stop. ' +
          'Never fabricate or reuse a token; each token is single-use and expires in 120 seconds.',
      }, null, 2);
    },
  });
}

export function createGrantApprovalTool(config: Config) {
  return defineTool({
    name: 'grant_approval',
    description:
      'Confirms or revokes user consent for a pending approval token. ' +
      'Call grant=true ONLY after the user explicitly agreed in the conversation. ' +
      'grant=false (or calling revoke) immediately invalidates the token.',
    parameters: {
      token: { type: 'string', required: true, description: 'The pending token from request_approval.' },
      grant: {
        type: 'boolean', required: true,
        description: 'true = the user explicitly approved; false = the user refused (token is voided).',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      if (!config.enableApprovalGate) {
        return '[System]: Approval gate disabled — nothing to grant.';
      }
      if (!args.grant) {
        approval.revoke(args.token);
        return JSON.stringify({
          status: 'REVOKED',
          state_anchor: { token: args.token, granted: false },
          next_step: 'Token voided. Do NOT perform the action. Ask the user how they want to proceed instead.',
        }, null, 2);
      }
      return JSON.stringify({
        status: 'GRANTED',
        state_anchor: { token: args.token, granted: true },
        next_step: 'User consent recorded. Re-invoke click_mouse NOW with approval_token="' +
          args.token + '" — the token is single-use and expires soon.',
      }, null, 2);
    },
  });
}
