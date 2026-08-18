// src/sandbox/index.ts
// D-5 沙箱执行引擎 —— DSH 插件入口（第五器官降生）。
// 物理法则合规：
//   一切皆插件     → 标准 apply(ctx, config)，name/inject 导出
//   依赖驱动加载   → inject 声明 tools（必需）+ dsh.cognition? / dsh.quality-doctor?（可选，
//                    缺席时引擎仍加载，排练/门禁诚实降级 —— 服务就绪后经事件自动咬合）
//   可逆注册与隔离 → 一切监听与内存资源随 ctx.effect 登记清理（Cordis 注册即效果模型）
//   事件总线通信   → 与 D-1/D-4 零直接调用，咬合只走事件（events.ts 单点收口）
//   可观测性对齐   → 沙箱独立 append-only 哈希链账本（log.ts，规范对齐 journal）
// Token 纪律：工具返回只进紧凑数字（尝试/漂移/置信度），全量证据走 reportPath 句柄。
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  onCognitionPlanReady, onDoctorVerdict, onHostToolPost, sniffFingerprint,
} from './events';
import { sandboxLog } from './log';
import { SandboxEngineImpl } from './engine';
import { muscleReliability, type SandboxConfig } from './types';

export { SandboxConfig } from './types';
export { SandboxEngineImpl } from './engine';
export { muscleReliability, resolveConsolidation } from './types';

export const name = 'sandbox-execution-plugin';

// 可选依赖 '?' 语法：缺席不阻断加载，相关能力诚实降级
export const inject = ['tools', 'dsh.cognition?', 'dsh.quality-doctor?'];

// D-5 替身人格（三正交段内嵌于工具描述 —— DSH 模式：工具即角色的躯壳）
const SHADOW_DOCTRINE =
  'You are the Sandbox Execution Engine — the safe avatar of this digital organism in the physical world. ' +
  'THE HOST IS SACRED: everything here is virtual; replay_on_host is the ONLY exit and only passes ' +
  'the four gates (token / doctor / reliability / fingerprint). ' +
  'DRILL, THEN DELIVER: errors are nutrients — captured, diagnosed, corrected, repeated; ' +
  'the conversation sees results, never sweat. ' +
  'TRUST IS A FINGERPRINT: replay starts only when the host state matches the rehearsal state; ' +
  'a stale rehearsal is a lie.';

export async function apply(ctx: Context, config: SandboxConfig): Promise<void> {
  console.log('[Sandbox] Initializing Sandbox Execution Engine (D-5)...');

  const engine = new SandboxEngineImpl(ctx);
  // 《异常诚实分层契约》第一条（加载层）：配置非法 throw —— 拒绝带病上线；
  // 此后第二条（运行层）：一切运行时永不抛错（Result/verdict 降级）
  engine.configure(config);
  sandboxLog.configure(config.reportDir ? `${config.reportDir}/sandbox-log.jsonl` : '', 2000);

  // ── 事件总线接线（与 D-1/D-4/宿主管线的唯一咬合通道）──

  // D-1 计划投喂：候选链到达即入排练（DRILL）。
  // P0-3 联合方言纪律：plan-ready 载荷可能是 chain（D-5 需求）或 intent 双方言
  // （D-6/D-7 主权）—— D-5 只排练链臂，意图臂静默让渡（主权边界，不是故障）。
  onCognitionPlanReady(ctx, payload => {
    if (!('chain' in payload) || !payload.chain) return;
    void engine.receivePlan(payload.chain).then(outcome => {
      console.log(`[Sandbox] Rehearsed plan ${outcome.chainId}: verdict=${outcome.verdict} ` +
        `steps=${outcome.steps.length} latency=${outcome.totalLatencyMs}ms report=${outcome.reportPath}`);
    });
  });

  // D-4 判决回执：入缓存（双闸门复核 + 重放时刻否决源）
  onDoctorVerdict(ctx, payload => {
    engine.noteDoctorVerdict(payload);
  });

  // 宿主管线观察（纯观察透传）：嗅探屏指纹 —— TRUST IS A FINGERPRINT 的镜像源头
  onHostToolPost(ctx, (_call, result) => {
    engine.noteHostObservation(sniffFingerprint(result));
  });

  // 可选服务在场探测（dsh.quality-doctor：只持句柄不读全文 —— Token 纪律）
  const doctor = ctx.get('dsh.quality-doctor') as
    | { reportPath?: () => string | null }
    | undefined;
  console.log(doctor
    ? '[Sandbox] Quality doctor service detected — verdicts will be honored.'
    : '[Sandbox] Quality doctor service absent — consolidation defaults to freeze-for-review (honest degradation).');

  // ── 演武工具面（对话流只见紧凑数字）──

  ctx.tools.register(defineTool({
    name: 'rehearse_chain',
    description: SHADOW_DOCTRINE + ' Rehearse an action chain in the virtual sandbox. ' +
      'Returns compact numbers only (verdict, steps, latency, score); full evidence goes to reportPath.',
    parameters: {
      actions: {
        type: 'string', required: true,
        description: 'JSON array of actions: [{"kind":"click_mouse","args":{"x":0.5,"y":0.5},'
          + '"expect":{"scale":"element-level","expectedText":"Sign in"}}] '
          + '(kinds: click_mouse|type_text|scroll_page|press_hotkey|drag_mouse|switch_tab|switch_window|dismiss_popup|noop)',
      },
      budget_ms: {
        type: 'number', required: false,
        description: 'Optional wall-clock budget; on expiry the rehearsal aborts gracefully with partial trajectory.',
      },
    },
    output: { schema: { type: 'string' }, render: (_a: any, v: any) => [{ type: "text", text: v }] },
    async execute(args: any) {
      try {
        const actions = JSON.parse(args.actions);
        if (!Array.isArray(actions) || actions.length === 0) {
          return JSON.stringify({ status: 'FAILED', reason: 'actions must be a non-empty JSON array' });
        }
        const chain = {
          id: `chain-manual-${Date.now().toString(36)}`,
          actions,
          budgetMs: typeof args.budget_ms === 'number' ? args.budget_ms : undefined,
          origin: 'manual' as const,
        };
        const o = await engine.rehearse(chain);
        // 紧凑数字战报（Token 纪律）：全量证据在 reportPath
        return JSON.stringify({
          status: 'SUCCESS',
          verdict: o.verdict,
          chain_id: o.chainId,
          steps: o.steps.length,
          failed_at: o.failedAtIndex,
          total_latency_ms: o.totalLatencyMs,
          budget_ms: o.budgetMs,
          score: o.score,
          verification_layers: o.verificationLayers,
          chain_tip: o.chainTip,
          report: o.reportPath,
        });
      } catch (e: any) {
        return JSON.stringify({ status: 'FAILED', reason: `malformed input: ${e.message}` });
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'recall_muscle',
    description: 'Recall muscle memory entries by natural-language query (prior, not guarantee — '
      + 'every replay still passes the four gates). Ranked by text overlap × reliability + scene bonus + recency.',
    parameters: {
      query: { type: 'string', required: true, description: 'Natural language query.' },
    },
    output: { schema: { type: 'string' }, render: (_a: any, v: any) => [{ type: "text", text: v }] },
    async execute(args: any) {
      const r = engine.recallMuscleMemory(String(args.query ?? ''));
      if (!r.ok) return JSON.stringify({ status: 'FAILED', reason: r.reason });
      return JSON.stringify({
        status: 'SUCCESS',
        hits: r.value.map(e => ({
          id: e.id,
          trigger: e.trigger,
          steps: e.steps.length,
          reliability: Number(muscleReliability(e).toFixed(3)),
          rehearsal_passes: e.rehearsalPassCount,
          host_replays: e.hostReplayCount,
        })),
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'replay_on_host',
    description: SHADOW_DOCTRINE + ' Request host replay of a muscle-memory entry. '
      + 'Phase 1: omit confirm_token to obtain a pending token. Phase 2: re-call with the token. '
      + 'Four gates: token / doctor verdict / reliability threshold / entry-scene fingerprint match.',
    parameters: {
      entry_id: { type: 'string', required: true, description: 'Muscle memory entry id.' },
      confirm_token: {
        type: 'string', required: false,
        description: 'Omit in phase 1 to get a token; include in phase 2 to attempt the replay.',
      },
    },
    output: { schema: { type: 'string' }, render: (_a: any, v: any) => [{ type: "text", text: v }] },
    async execute(args: any) {
      const entryId = String(args.entry_id ?? '');
      if (!args.confirm_token) {
        const token = engine.requestReplayToken(entryId);
        return JSON.stringify({
          status: 'PENDING_USER_CONSENT',
          entry_id: entryId,
          token,
          note: 'Re-call replay_on_host with confirm_token to pass the gates (TTL 120s).',
        });
      }
      const outcome = await engine.replayOnHost(entryId, { confirmToken: String(args.confirm_token) });
      return JSON.stringify({
        status: outcome.verdict === 'confirmed' ? 'SUCCESS' : 'FAILED',
        verdict: outcome.verdict,
        muscle_memory_id: outcome.muscleMemoryId,
        divergences: outcome.divergences.length,
        reliability_after: Number(outcome.reliabilityAfter.toFixed(3)),
        journal_refs: outcome.journalRefs.length,
        report: outcome.reportPath,
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'verify_sandbox_log',
    description: 'Verify the append-only hash chain of the sandbox session log (tamper-evidence audit).',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a: any, v: any) => [{ type: "text", text: v }] },
    async execute() {
      const r = engine.verifyLog();
      if (!r.ok) return JSON.stringify({ status: 'FAILED', reason: r.reason });
      return JSON.stringify({
        status: 'SUCCESS',
        chain_intact: r.value.ok,
        entries: r.value.length,
        broken_at: r.value.brokenAt,
      });
    },
  }));

  console.log('[Sandbox] 4 rehearsal tools registered (rehearse_chain / recall_muscle / replay_on_host / verify_sandbox_log).');

  // ── 可逆注册：一切资源登记清理（Cordis 注册即效果模型）──
  ctx.effect(() => {
    console.log('[Sandbox] Unloading, rolling back resources...');
    return () => {
      // 持久化资产先行落盘（肌肉记忆的寿命长于会话）；账本随 JSONL 已增量落盘
      engine.reset(); // 内存态归零：记忆/令牌/判决缓存/观察缓存/账本窗口
      console.log('[Sandbox] Unloaded. Zero residue.');
    };
  });

  console.log('[Sandbox] Initialization complete! The host remains untouched until all gates open.');
}
