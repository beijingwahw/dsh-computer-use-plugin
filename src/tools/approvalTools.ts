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
import {
  approval, approvalQueue, configureDemonstrations, setDemonstrationObserver, type TargetHint,
} from '../approval';
// ΤΕΛ-3a：绑定事实的透明化探针（targetDigest 在场性 —— 只读，绝不外泄摘要本体）
import { boundTargetOf } from '../approval.security';
// ΠΑΝ-37：veto 撤销已批条目的执法原语（adjudicate 工具 grant=false 臂的透传点）
import { revokeGrantedEntries } from '../approval.queueState';
import { skillLibrary, type DemonstrationLearning } from '../skillLibrary';
// W4-0（F 接线）：暂存步账 —— stageAction 的 stepCursor 计量面（journal 总条数，
// 与 orchestrator 续跑对账的 ledgerCount 同源）。
import { journal } from '../journal';

// ─── Τ 纪元（干预即教育）：审批事件 → 技能库蒸馏的生产接线 ───
//
// 审批的「验收式消费成功」是用户背书+世界验证的特权正示范；「用户拒绝」是负示范。
// 本模块在工具装配时把 config.enableDemonstrations 铸入 approval 的模块级开关，
// 并安装观察者喂给技能库。教育是旁路：学习异常/开关关闭一律零行为，绝不影响
// 审批主流程的任何返回值（发射点的异常吞没在 approval.emitDemonstration）。

/** 最近一次示范学习结果（透明性注记的事实源）。learningSeq 用于区分
 *  「本次事件的产物」与上一轮的陈旧值 —— 注记只认新鲜的教育。 */
let lastDemonstrationLearning: DemonstrationLearning | null = null;
let learningSeq = 0;

/**
 * Τ 纪元：示范教育接线（工具装配时调用；设置绝对状态，天然幂等）。
 * enableDemonstrations=false ⇒ 开关关 + 观察者卸载（零行为）。
 */
export function wireDemonstrationEducation(config: Config): void {
  configureDemonstrations(config.enableDemonstrations);
  if (!config.enableDemonstrations) {
    setDemonstrationObserver(null);
    return;
  }
  setDemonstrationObserver(ev => {
    lastDemonstrationLearning = skillLibrary.learnFromDemonstration(ev);
    learningSeq += 1;
  });
}

export function createRequestApprovalTool(config: Config) {
  wireDemonstrationEducation(config); // Τ：装配即接线（教育旁路上电）
  return defineTool({
    name: 'request_approval',
    description:
      'Requests user approval for an irreversible action (send/delete/pay/submit order...). ' +
      'ONE consent covers the WHOLE task: the returned token stays valid across retries until a VERIFIED ' +
      'effect (or the retry budget expires) — if click_mouse reports acceptance=retry-allowed, retry under ' +
      'the SAME token without asking the user again. ' +
      'W1-2: when the out-of-band channel is armed, a 6-digit confirm code is delivered to the user ' +
      'OUT-OF-BAND (approval console) — you will NEVER see the code; the user approves by giving you that code. ' +
      'W2-1 (H4 staging): if the user is away, the request may go unanswered; after the staging timeout the agent MAY ' +
      'stage the irreversible action into the offline approval queue (evidence attached) and continue all REVERSIBLE ' +
      'work — the next sleep morning report lists staged items for one-annotated batch adjudication. ' +
      'Workflow: call this tool -> relay the message to the user -> wait for consent -> ' +
      'call grant_approval if they agree (with their confirm code, when required) -> re-invoke click_mouse with the token. ' +
      'ΤΕΛ-3a: pass the optional target argument to mint a TARGET-BOUND token — the consent then buys exactly that ' +
      'target (mismatching redeem calls are refused fail-closed); omit it for the legacy unbound form.',
    parameters: {
      description: {
        type: 'string', required: true,
        description: 'EXACTLY what you are about to do and why, e.g., "click 发送 to submit the email to Alice".',
      },
      consequence: {
        type: 'string',
        description: 'What happens if this cannot be undone (e.g., "the email will be sent and cannot be recalled").',
      },
      stage: {
        type: 'boolean',
        description: 'W4-0 (F): stage this request into the OFFLINE approval queue NOW (user away) instead of blocking. ' +
          'Captures stepCursor = current journal length so the W3-4 resume only replays steps AFTER this point ' +
          '(reversible work already on the ledger is not repeated). Set it only after the user has been silent past ' +
          'the staging window and reversible work remains; adjudication then flows through the morning report / ' +
          'adjudicate_approval_queue — do NOT keep asking in chat for a staged item.',
      },
      // ΤΕΛ-3a：激活能力限缩令牌的生产铸造面（ΠΑΝ-5 targetDigest 的模型可调入口）。
      // 模型请求审批时声明「这次同意买的是什么」—— 声明后被铸入 targetDigest，
      // 兑换面（validate/beginAttempt/consume）对不匹配目标 fail-closed 拒绝。
      target: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tool: {
            type: 'string',
            description: 'The EXACT tool name you will redeem this approval with (click_mouse / drag_mouse / ' +
              'click_element / press_hotkey). The redeeming call must carry the SAME tool.',
          },
          target_description: {
            type: 'string',
            description: 'What you will act on, e.g. "发送 button at the bottom of the compose window". Must match ' +
              'the target_description you pass on the redeeming call (click_element: the element name).',
          },
          x: {
            type: 'number',
            description: 'Normalized x [0,1] of the click point — only for coordinate-addressed tools (click_mouse). ' +
              'Quantized to 1/1000 (tolerance band); omit for description-addressed tools (click_element/drag_mouse/press_hotkey).',
          },
          y: {
            type: 'number',
            description: 'Normalized y [0,1] of the click point — same rules as x.',
          },
        },
        description: 'ΤΕΛ-3a (capability scoping): OPTIONAL target binding. When present, the minted token is ' +
          'cryptographically bound to this target (macaroon-style targetDigest) and can ONLY be redeemed against a ' +
          'dispatch that matches it — the user\'s consent buys EXACTLY this action, not "any dangerous click within ' +
          'TTL". Omit it and the token stays unbound (legacy bearer form, byte-identical behavior). Once bound, a ' +
          'mismatching redeem call is REFUSED (fail-closed) — bind only what you will actually execute.',
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

      // V 纪元：TTL 与重试预算来自部署配置（一次确认覆盖整个任务的重试窗口）
      // Τ 纪元：铸造时快照动作形状（仅在 enableDemonstrations 时采集 —— 关闭时
      // 连形状都不记，最小捕获面）。request_approval 只确知「描述」—— 工具名与
      // 坐标诚实缺席（described-action）；携带完整形状的调用方经 approval.request
      // 直接铸入。type_text 类在铸造点即脱敏为长度桶（隐私铁律）。
      // ΤΕΛ-3a：target 在场 ⇒ 透传 approval.request 的 opts.target —— 生产铸造面
      // 自此可铸**能力限缩令牌**（macaroon 式 targetDigest：目标描述+动作+坐标域
      // 的规范化哈希，ΠΑΝ-5 的 API 此前只有编程面调用方）。模型请求审批时声明
      // 「这次同意买的是什么」；一旦绑定，兑换面（validate/beginAttempt/consume）
      // 对不匹配目标 fail-closed 拒绝。
      // 兼容律（ΤΕΛ-3c）：target 缺席 ⇒ opts.target 缺席 ⇒ 令牌不携带绑定 ⇒
      // 铸造路径与返回值逐字节不变（绑定是 opt-in 升级面）。防御式：垃圾形态
      // （非对象/缺 tool）⇒ 绑定诚实缺席 + 输出面 target_binding.bound=false 透明
      // 申报（绝不抛、绝不静默把限缩请求降级为全能力令牌而不告知）。
      const rawTarget: unknown = (args as { target?: unknown }).target;
      const targetProvided = rawTarget !== undefined && rawTarget !== null;
      let mintTarget: TargetHint | undefined;
      let targetIgnoredReason: string | undefined;
      if (targetProvided) {
        if (typeof rawTarget === 'object' && !Array.isArray(rawTarget)) {
          const t = rawTarget as Record<string, unknown>;
          const tool = typeof t.tool === 'string' ? t.tool.trim() : '';
          if (tool !== '') {
            mintTarget = {
              tool,
              ...(typeof t.x === 'number' && Number.isFinite(t.x) ? { x: t.x } : {}),
              ...(typeof t.y === 'number' && Number.isFinite(t.y) ? { y: t.y } : {}),
              ...(typeof t.target_description === 'string' && t.target_description.trim() !== ''
                ? { target_description: t.target_description }
                : {}),
            };
          } else {
            targetIgnoredReason = 'invalid-target-shape (tool missing or empty — no bindable capability identity)';
          }
        } else {
          targetIgnoredReason = 'invalid-target-shape (target must be an object with a non-empty tool string)';
        }
      }
      const pa = approval.request(args.description, {
        ttlMs: config.approvalTokenTtlMs,
        maxAttempts: config.approvalMaxAttempts,
        actionShape: config.enableDemonstrations
          ? { tool: 'described-action', target_description: args.description }
          : undefined,
        // ΤΕΛ-3a：opts.target 在场 ⇒ request 内铸入 targetDigest（不可规范化 ⇒
        // 绑定诚实缺席 —— request 宽容面；输出面如实申报）
        ...(mintTarget !== undefined ? { target: mintTarget } : {}),
      });
      // ΤΕΛ-3a：绑定事实的铸造后核验（boundTargetOf = 簿记真值源 —— 不信透传
      // 自证，以账本为准）。targetDigest 本体绝不外泄（输出面只见布尔与成因）。
      const targetBound = targetProvided && boundTargetOf(pa.token) !== undefined;
      const consequence = args.consequence
        ? ` Consequence: ${args.consequence}.`
        : ' This action is likely irreversible.';

      // W4-0（F 接线 · W3-4 需要）：暂存模式下附带 stepCursor —— agent 显式
      // stage=true（用户离开的成熟信号 —— 墙钟暂存超时的代理面）⇒ 立即入暂存
      // 队列并携带 stepCursor = journal.list(false).length（入队时步账：续跑对账
      // 只重演此后的步骤，已暂存的可逆部分不重复执行 —— stageAction 签名的
      // stepCursor 字段）。缺省不携 stage ⇒ 零暂存尝试，与接线前逐字节一致；
      // 暂存资格由 stageAction 自行执法（通道缺席/队列封顶 ⇒ 诚实拒绝并透出）。
      let w4Staged: { ok: true; id: string; stepCursor: number } | { ok: false; reason: string } | null = null;
      if (args.stage === true) {
        const w4Cursor = ((): number => {
          try {
            return journal.list(false).length;
          } catch {
            return 0;
          }
        })();
        const r = approvalQueue.stageAction({
          token: pa.token,
          description: args.description,
          ttlMs: config.approvalTokenTtlMs,
          stagingTimeoutMs: 0, // 显式 stage 请求即成熟信号（缺省 5min 墙钟超时的代理面）
          stepCursor: w4Cursor,
        });
        w4Staged = r.ok ? { ok: true, id: r.entry.id, stepCursor: r.entry.stepCursor ?? w4Cursor } : { ok: false, reason: r.reason };
      }

      // W1-2（S2）：带外确认码在场情况透明化。安全核心 —— **确认码本身绝不出
      // 现在本返回值的任何位置**（码只经带外通道投给人类；模型上下文不可见 ⇒
      // 模型无法伪造同意）。只透出布尔事实与通道状态。
      // W6R fail-closed：通道缺席（confirmCodeHash 缺席 ⇒ degraded）时不再给
      // 「照旧 yes/no 同意」的话术 —— 无码同意已废除，grant_approval 会拒绝
      // 该令牌；诚实告知用户须经宿主 UI 完成人工确认。
      const codeRequired = pa.confirmCodeHash !== undefined;
      const consentAsk = codeRequired
        ? 'To approve, reply with the 6-DIGIT CONFIRMATION CODE shown in your approval console / ' +
          'notification (it was sent to you out-of-band, NOT in this chat). To refuse, reply "no".'
        : 'The out-of-band confirm channel is ABSENT in this host — this approval CANNOT be granted ' +
          'in this chat (fail-closed). 带外确认通道缺席，无法完成人工确认，请用户通过宿主 UI 操作' +
          '（或由宿主接线 approval/confirm-code 事件总线后重新发起审批）。To refuse, reply "no".';
      const retryClause =
        `Never fabricate or reuse a token. ONE consent covers the whole task: if a click does not ` +
        `take verified effect, the token stays valid for up to ${pa.maxAttempts} attempts within ` +
        `${Math.round((pa.expiresAt - Date.now()) / 1000)}s — retry WITHOUT asking the user again; ` +
        'only call request_approval anew if the retry budget is exhausted, the token expired, or the task changed.';
      const nextStep = codeRequired
        ? 'RELAY the message_to_relay to the user VERBATIM and WAIT for their reply. ' +
          'The 6-digit confirm code is delivered to the user OUT-OF-BAND (approval console / notification) — ' +
          'you will NEVER see it and must NOT guess it. If they approve, they reply WITH the code: call ' +
          'grant_approval with the token, grant=true and confirm_code=THE CODE THE USER GAVE YOU. ' +
          'If they refuse, do NOT proceed — propose an alternative or stop. ' + retryClause
        : 'The out-of-band confirm channel is ABSENT (fail-closed): grant_approval will REFUSE this ' +
          'token — there is NO code-less consent anymore. 带外确认通道缺席，无法完成人工确认，' +
          '请用户通过宿主 UI 操作。If the action must proceed, the host must arm the ' +
          'approval/confirm-code event bus (wireDoctorVerdictChannel) and a FRESH request_approval ' +
          'must be minted; do NOT retry grant_approval for this token. If the user refuses, do NOT proceed.';

      return JSON.stringify({
        status: 'PENDING_USER_CONSENT',
        state_anchor: {
          token: pa.token,
          action: args.description,
          expires_in_seconds: Math.round((pa.expiresAt - Date.now()) / 1000),
          retry_budget: pa.maxAttempts,
          // W1-2（S2）：码要求的布尔事实（不含码本身）；W6R：通道缺席 ⇒
          // 诚实标记 absent（该令牌不可经对话授予 —— fail-closed）
          confirm_code_required: codeRequired,
          confirm_channel: codeRequired ? 'out-of-band' : 'out-of-band-absent',
          // ΤΕΛ-3a：绑定事实透明化（只在模型显式携 target 时入键 —— 无 target
          // 调用的输出面逐字节保持旧形态，ΤΕΛ-3c 兼容律）。bound=true ⇒ 一次
          // 同意恰授权这一个目标；成因字段只在绑定未成立时在场（诚实申报）。
          ...(targetProvided
            ? {
              target_binding: {
                bound: targetBound,
                ...(targetBound
                  ? { note: 'Token is TARGET-BOUND: redeem calls must carry the SAME tool/x/y/target_description ' +
                      '(mismatch is refused fail-closed and does NOT burn the token).' }
                  : { reason: targetIgnoredReason ?? 'binding-absent (digest pipeline refused the shape)' }),
              },
            }
            : {}),
          // W2-1（H4）：暂存降级透明化 —— 用户离开时超时后的非阻塞出路
          staging: (() => {
            const s = approvalQueue.stagingAvailability();
            return {
              available: s.available,
              stage_after_seconds: Math.round(s.stagingTimeoutMs / 1000),
              persistence: s.persistent ? 'file' : 'memory',
            };
          })(),
          // W4-0（F）：本次调用是否已暂存（含 stepCursor 回显）或诚实拒绝的成因
          ...(w4Staged !== null
            ? w4Staged.ok
              ? { staged: { id: w4Staged.id, step_cursor: w4Staged.stepCursor } }
              : { staged: { declined: w4Staged.reason } }
            : {}),
        },
        message_to_relay: `I am about to: ${args.description}.${consequence} ${consentAsk}`,
        // ΤΕΛ-3a：绑定令牌的兑换指引（只在 bound 时附加 —— 无 target/绑定未成立
        // 路径的 next_step 逐字节保持旧文，ΤΕΛ-3c 兼容律）。绑定 = 兑换面强制
        // 比对：模型必须以与铸造时同一形状（同 tool、同坐标、同目标描述）兑现。
        next_step: (w4Staged !== null && w4Staged.ok
          ? 'STAGED into the offline approval queue (step_cursor captured). Continue all REVERSIBLE work; the ' +
            'staged irreversible step executes after adjudication via the morning report / adjudicate_approval_queue ' +
            '(or an in-chat grant before then). Do NOT keep re-asking for a staged item.'
          : nextStep) + (targetBound
          ? ' TARGET-BOUND token: the redeeming call MUST carry the SAME tool/x/y/target_description you declared ' +
            'here (quantization tolerance 1/1000) — a mismatching target is refused fail-closed.'
          : ''),
      }, null, 2);
    },
  });
}

export function createGrantApprovalTool(config: Config) {
  wireDemonstrationEducation(config); // Τ：装配即接线（教育旁路上电）
  return defineTool({
    name: 'grant_approval',
    description:
      'Confirms or revokes user consent for a pending approval token. ' +
      'Call grant=true ONLY after the user explicitly agreed in the conversation. ' +
      'W1-2 (S2): when the approval was minted with confirm_code_required=true, grant=true ALSO needs ' +
      'confirm_code — the 6-digit code the USER read from their out-of-band approval console and gave you. ' +
      'Never guess or fabricate the code: mismatches burn the token. ' +
      'W6R fail-closed: if the approval console reports confirm_channel=out-of-band-absent, the token ' +
      'can NEVER be granted in chat — the user must confirm through the HOST UI instead. ' +
      'W1-2 (H1): optional note carries the user annotation amending the plan (e.g., "yes, but click the ' +
      'small Send at the bottom-right") — it is cast onto the token as a structured amendment the executor ' +
      'honors before dispatch. ' +
      'ΤΕΛ-3a: target-bound tokens (minted with the target argument) report target_bound=true — redeem them ONLY ' +
      'against the exact tool/x/y/target_description they were bound to. ' +
      'grant=false (or calling revoke) immediately invalidates the token.',
    parameters: {
      token: { type: 'string', required: true, description: 'The pending token from request_approval.' },
      grant: {
        type: 'boolean', required: true,
        description: 'true = the user explicitly approved; false = the user refused (token is voided).',
      },
      confirm_code: {
        type: 'string',
        description: 'W1-2 (S2): the 6-digit out-of-band confirm code the user gave you (required when ' +
          'confirm_code_required=true). The check is constant-time: no hint about which digits are wrong.',
      },
      note: {
        type: 'string',
        description: 'W1-2 (H1): optional user annotation amending the plan (consent WITH corrections) or the ' +
          'refusal reason (with grant=false). Cast onto the token as a structured amendment honored before dispatch.',
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
      // W1-2：opts 只透传合法类型（防御式 —— 非法类型按缺席处理，不抛）
      const confirmCode = typeof args.confirm_code === 'string' ? args.confirm_code : undefined;
      const note = typeof args.note === 'string' && args.note.trim() ? args.note : undefined;
      if (!args.grant) {
        // Τ 纪元：用户拒绝走 grant(false) 通道（世界态与旧 approval.revoke 等价 ——
        // 令牌在场即删除；额外铸一次负示范事件，旁路失败不碰审批主流程）。
        // W1-2（H1）：拒绝可携批注（否决理由）—— 先铸入再作废，负示范事件携带
        // amended 标注与批注内容（最强负示范：用户不仅拒绝还说清了为什么）。
        const seqBefore = learningSeq;
        const outcome = approval.grantDetailed(args.token, false, { note });
        // 透明性注记：只认本次事件的新鲜教育（陈旧学习结果不得冒充）
        const learning = config.enableDemonstrations && learningSeq > seqBefore
          ? lastDemonstrationLearning
          : null;
        const revoked: Record<string, unknown> = {
          status: 'REVOKED',
          state_anchor: {
            token: args.token,
            granted: false,
            // W1-2（H1）：批注在场 ⇒ amended 标注 + 修正内容回显（用户可见自己的话）
            ...(note && outcome.ok
              ? { amended: true, amendment_note: note.slice(0, 200) }
              : {}),
          },
          next_step: 'Token voided. Do NOT perform the action. Ask the user how they want to proceed instead.',
        };
        if (learning) {
          revoked.education_note = learning.outcome === 'penalized'
            ? `已教育：回避 1 条（用户否决；命中技能 #${learning.skillId} 可靠度下调并标记 denied）`
            : '已教育：回避 1 条（用户否决该动作形状，已入回避注记）';
        }
        return JSON.stringify(revoked, null, 2);
      }
      // J 纪元：grant 真正激活令牌（approval.grantDetailed 同时校验在场与时效）。
      // 伪造或过期的 token 不给「已同意，立即执行」的指令 —— 否则模型带着
      // 假令牌重放 click_mouse，白费一轮并侵蚀审批协议的可信度。
      // W1-2（S2）：带码审批须携匹配 confirm_code —— 错误码区分「码错误」与
      // 「令牌无效」（恒定时间比较，不泄露哪一位错）；限流路径保留旧字面
      // invalid-or-expired-token（resultContract Δ#4 的读侧精化依赖该指纹）。
      approval.sweep();
      const res = approval.grantDetailed(args.token, true, { confirmCode, note });
      if (!res.ok) {
        const reason = res.reason === 'rate-limited' ? 'invalid-or-expired-token' : res.reason;
        const nextStep =
          res.reason === 'confirm-channel-absent'
            ? '带外确认通道缺席，无法完成人工确认，请用户通过宿主 UI 操作。' +
              'This token was minted while the out-of-band confirm channel was absent (or delivery ' +
              'failed), so it can NEVER be granted — no code-less consent exists (fail-closed). ' +
              'Do NOT retry grant_approval for this token; the user must act through the HOST UI, ' +
              'or the host must arm the approval/confirm-code event bus (wireDoctorVerdictChannel) ' +
              'and a FRESH request_approval must be minted.'
            : res.reason === 'confirm-code-required'
              ? 'This approval requires the OUT-OF-BAND confirm code. Ask the USER for the 6-digit code shown ' +
                'in their approval console / notification, then call grant_approval again with grant=true and ' +
                'confirm_code=that code. The code is NEVER shown to you — only to the user.'
              : res.reason === 'confirm-code-mismatch'
                ? 'The confirm code does NOT match (constant-time check — no hint about which digits are ' +
                  'wrong). Ask the user to re-read the code from the approval console and retry with it. ' +
                  'Do NOT guess codes: repeated mismatches burn the token.'
                : res.reason === 'code-attempts-exhausted'
                  ? 'Too many wrong confirm codes — the token is void (anti-enumeration cap). Call ' +
                    'request_approval to mint a fresh one; the new code is delivered to the user out-of-band again.'
                  : 'This token is not pending (unknown, already consumed, or expired). ' +
                    'Call request_approval again to mint a fresh one.';
        return JSON.stringify({
          status: 'FAILED',
          state_anchor: { token: args.token, granted: false, reason },
          next_step: nextStep,
        }, null, 2);
      }
      // Τ 纪元：授予时刻尚无教育发生（教育锚在验收式消费/拒绝）—— 注记只作
      // 诚实的前瞻披露，绝不冒充「已教育」的计数。
      // W1-2（H1）：批注铸入成功 ⇒ 回显结构化 amendment（模型必须照修正后的
      // 计划执行 —— 批注是用户亲手改过的计划，不是可选建议）。
      // ΤΕΛ-3a：绑定令牌的授予面指引 —— boundTargetOf 只读探针（令牌携带
      // targetDigest ⇒ 回执如实标注 + 兑换形状指引；未绑定 ⇒ 零新键，授予
      // 回执逐字节保持旧形态，ΤΕΛ-3c 兼容律）。摘要本体绝不外泄。
      const amendment = approval.amendmentOf(args.token);
      const grantedTargetBound = boundTargetOf(args.token) !== undefined;
      const granted: Record<string, unknown> = {
        status: 'GRANTED',
        state_anchor: {
          token: args.token,
          granted: true,
          ...(amendment ? { amended: true } : {}),
          ...(grantedTargetBound ? { target_bound: true } : {}),
        },
        next_step: 'User consent recorded. Re-invoke click_mouse NOW with approval_token="' +
          args.token + '". ONE consent covers the WHOLE task: if the result reports ' +
          'acceptance=retry-allowed (no verified effect yet), fix and RETRY with the same token — ' +
          'do NOT ask the user again. When acceptance=verified, report the acceptance result to the user.' +
          (grantedTargetBound
            ? ' This token is TARGET-BOUND: every redeem call (validate/beginAttempt/consume) must carry the SAME ' +
              'tool/x/y/target_description declared at request_approval — a different target is refused fail-closed.'
            : ''),
      };
      if (amendment) {
        granted.amendment = {
          note: amendment.note,
          target_description_correction: amendment.targetDescriptionDelta.corrected,
          original_description: amendment.targetDescriptionDelta.original,
          instruction: 'The user AMENDED the plan. Execute per the CORRECTED target above — ' +
            're-describe the target (target_description) with the corrected wording when re-invoking the action.',
        };
      }
      if (config.enableDemonstrations) {
        granted.education_note =
          '教育待验收：本同意兑现为一次世界验证过的效果时，将强化匹配技能的动作模式；' +
          '若用户否决则入回避注记。';
      }
      return JSON.stringify(granted, null, 2);
    },
  });
}

// ─── W2-1（H4 暂存式离线批准队列）：批注式批量裁决工具 ───
//
// 晨报列出待批清单后，用户经本工具一次裁决多项：grant + note（可选批注）
// 复用 W1-2 的批注协议 —— 每个条目按自身描述各铸一份 amendment，续跑执行
// 令牌原样携带（执行侧 applyAmendment 照常消费）。安全律（approval.ts 执法）：
//   · 每项 grant 消耗一枚 Y-10 同意预算（批量不是 click-fatigue 的后门）；
//   · 过期条目保守拒绝（ttl-expired —— 须重走完整审批，绝不自动作废）；
//   · 已裁决条目拒绝翻案（already-decided —— 双重裁决封堵）。
export function createAdjudicateApprovalQueueTool(config: Config) {
  wireDemonstrationEducation(config); // Τ：装配即接线（教育旁路上电，与同模块工具一致）
  return defineTool({
    name: 'adjudicate_approval_queue',
    description:
      'Batch-adjudicates the OFFLINE STAGING approval queue (W2-1 H4). The sleep morning report lists staged ' +
      'irreversible actions that went unanswered; the user reviews them ONCE here. One call carries the verdict ' +
      'for MANY items, and the optional note is the user ANNOTATION (W1-2 amendment protocol): consent WITH ' +
      'corrections — each entry gets its own amendment cast from its own description, honored at resume time. ' +
      'ΠΑΝ-1/ΠΑΝ-36 (human-proof): granting an entry requires the 6-digit OUT-OF-BAND confirm code that was ' +
      'delivered to the user when the ORIGINAL request was staged — pass confirm_code as a single string (one ' +
      'code for a single item / all items from the same approval) or as an object mapping each entry id to its ' +
      'own code (batch morning-report adjudication where each item carries its own code). No code ⇒ refused; ' +
      'wrong codes burn the entry after 5 attempts. Each granted item consumes one rate-budget token; EXPIRED ' +
      'items are conservatively REFUSED (ttl-expired); already-decided items cannot be re-decided. ' +
      'ΠΑΝ-37: grant=false (veto) ALSO revokes already-granted-but-not-yet-resumed entries — user refusal ' +
      'always wins over a prior grant. Call this ONLY after relaying the morning-report pending list to the ' +
      'user and getting their explicit verdict (their codes, and their corrections as the note).',
    parameters: {
      ids: {
        type: 'array',
        description: 'Queue entry ids to adjudicate (from the morning report). Omit = ALL undecided entries.',
      },
      grant: {
        type: 'boolean', required: true,
        description: 'true = the user approves the listed actions; false = the user refuses them (token-free, clears the list, ' +
          'and revokes already-granted entries that have not resumed yet).',
      },
      confirm_code: {
        oneOf: [
          {
            type: 'string',
            description: 'The 6-digit out-of-band confirm code the user gave you — applies to every listed id ' +
              '(single-item adjudication, or all items staged from the same approval).',
          },
          {
            type: 'object',
            additionalProperties: true,
            description: 'Per-entry codes for batch adjudication: {"<entry-id>": "<6-digit code>", ...} — each entry ' +
              'was anchored with its own original approval\'s code.',
          },
        ],
        description: 'ΠΑΝ-1: required for grant=true (the user\'s out-of-band codes; never guess — mismatches burn entries).',
      },
      note: {
        type: 'string',
        description: 'W2-1/H1: user annotation carrying the verdict (and corrections) for ALL listed ids — ' +
          'cast per-entry as a structured amendment honored before dispatch at resume time.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      if (!config.enableApprovalGate) {
        return '[System]: Approval gate disabled — the staging queue is inactive.';
      }
      // 防御式：非法类型按缺席处理（ids 非数组 ⇒ 全部待批；note 空串 ⇒ 无批注）
      const ids = Array.isArray(args.ids) ? args.ids : [];
      const note = typeof args.note === 'string' && args.note.trim() ? args.note : undefined;
      // ΠΑΝ-37：veto 撤销先行 —— grant=false 时已批未续跑的条目就地改判 denied
      //（裁决于撤销之后 ⇒ 撤销过的条目对 adjudicate 呈 already-decided，账面如实）。
      let revokedGranted = 0;
      if (args.grant !== true) {
        revokedGranted = revokeGrantedEntries(ids).revoked;
      }
      // ΠΑΝ-36a：confirm_code 透传（string = 施于全部条目；object = 逐条目各交
      // 各码；其余形态 ⇒ 未携码 —— 队列侧 fail-closed 拒绝 grant）。
      const rawCode = (args as { confirm_code?: unknown }).confirm_code;
      let confirmCode: string | Record<string, string> | undefined;
      if (typeof rawCode === 'string' && rawCode.trim() !== '') {
        confirmCode = rawCode;
      } else if (rawCode && typeof rawCode === 'object' && !Array.isArray(rawCode)) {
        const map: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawCode as Record<string, unknown>)) {
          if (typeof v === 'string' && v.trim() !== '') map[k] = v;
        }
        if (Object.keys(map).length > 0) confirmCode = map;
      }
      const r = approvalQueue.adjudicate(ids, args.grant === true, note, confirmCode);
      const summary = approvalQueue.pendingSummary();
      const granted = r.results.filter(x => x.outcome === 'granted').length;
      const denied = r.results.filter(x => x.outcome === 'denied').length;
      const anchor: Record<string, unknown> = {
        adjudicated: r.results.length,
        granted,
        denied,
        ...(revokedGranted > 0 ? { revoked_granted: revokedGranted } : {}),
        queue_after: {
          pending: summary.pending,
          expired: summary.expired,
          granted_awaiting_resume: summary.grantedAwaitingResume,
        },
        persisted: r.persisted,
      };
      if (!r.persisted) {
        anchor.persistence_warning =
          'Queue persistence FAILED — decisions are in memory only; re-run this adjudication after the host recovers.';
      }
      // ΠΑΝ-36a：码要求的诚实指引（grant 臂被人证拒绝时给出正确出路）
      const codeBlocked = r.results.some(x =>
        x.outcome === 'confirm-code-required' || x.outcome === 'confirm-code-mismatch'
        || x.outcome === 'confirm-channel-absent' || x.outcome === 'code-attempts-exhausted');
      const nextStep = args.grant === true
        ? (codeBlocked
          ? 'Human proof REQUIRED (ΠΑΝ-1): granting a staged entry needs the 6-digit OUT-OF-BAND confirm code the ' +
            'user received when the request was staged. Ask the USER for the code (you can NEVER see it yourself), ' +
            'then re-call adjudicate_approval_queue with grant=true and confirm_code=that code (single string, or ' +
            'one code per entry id for batches). Wrong codes burn entries after 5 attempts — never guess. ' +
            'Entries without a code anchor (restored from disk) can NEVER be batch-granted: the user must deny ' +
            'and re-request via request_approval.'
          : 'Approved entries await RESUME: the orchestrator consumes them (takeGranted) and completes the final ' +
            'irreversible step under a pre-granted execution token; you do NOT re-ask the user.')
        : (revokedGranted > 0
          ? 'Refused entries are recorded (with the annotation) and will not execute; ' + revokedGranted +
            ' previously-GRANTED entry(ies) were REVOKED by this veto (they can no longer be resumed).'
          : 'Refused entries are recorded (with the annotation) and will not execute; propose alternatives if needed.');
      return JSON.stringify({
        status: r.results.length === 0 && revokedGranted === 0 ? 'NOTHING_TO_ADJUDICATE' : 'ADJUDICATED',
        state_anchor: anchor,
        per_item: r.results,
        next_step: nextStep,
      }, null, 2);
    },
  });
}
