// test/w7e2e.test.ts
// W7-4（全器官闭环 E2E 冒烟）：纯依赖注入（零源码改动）把主干道器官显式组装成
// 一条龙 —— gym 合成世界（假物理端口）+ 假 VLM 双源感知 + autoPilot 闭环
//（frameHash 免看门控 / steer 会话 / branchLedger / exploration 端口 / 预言旁路）
// + PolicyEngine + AutonomyConstitution + skillLibrary（含模板）+ macroExecutor
//（排练门禁）+ guards 瀑布（bounds→熔断→审计WAL→弹窗→防重→金丝雀 + post 观察链）
// + circuitBreaker + failureMemory(rootCause) + approval（令牌+批注+暂存队列）
// + checkpoint + journal + 睡眠六幕（dream / memoryOps / approvalQueue 晨报）。
//
// 两条一条龙剧本：
//  ① 成功路径：任务宣布→感知→宏技能执行（排练过）→验证→判据满足→checkpoint
//     段往返→睡眠六幕→晨报含技能蒸馏/模板/记忆收敛/梦回放；
//  ② 失败与复原路径：危险动作触发审批→超时入暂存队列→漂移出题 steer 应答 B
//     改判据→重跑（探索拦截+守卫瀑布足迹）失败铸岔路卡→steer(2) 换支→完成→
//     checkpoint 崩溃恢复→睡眠晨报待批清单→批注式批量裁决。
//
// 组装缝的诚实申报（见文件尾「组装缝申报」注释）：guards 瀑布经 fake ctx 的
// pre/post waterfall 驱动（cordis 事件面的测试替身 —— 与 w2recovery 同法）；
// 派发结果锚点 JSON 由本测试的假物理端口铸造（resultContract 方言）。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Config } from '../src/config.ts';
// 闭环器官（autonomy 桶）
import {
  runAutonomousLoop, GoalStateMachine, PolicyEngine, AutonomyConstitution,
  GymWorld, auditTrajectory, EvolutionEngine,
  type GoalSpec, type PolicyAction, type PolicyDecision, type WorldSnapshot,
  type PolicyContext, type StepOutcome, type BranchLedgerWirePort, type AutonomyDeps,
} from '../src/autonomy/index.ts';
import { composeSnapshot } from '../src/autonomy/worldSnapshot.ts';
import { ExplorationLedger } from '../src/autonomy/exploration.ts';
import type { GymTask } from '../src/autonomy/gym.ts';
import type { ScoringContext } from '../src/autonomy/counterfactual.ts';
// 预言引擎（纪元 Ε 审计旁路 —— 自有世界模型，零生产单例污染）
import { ProphecyEngine } from '../src/prophecy/index.ts';
import { InMemoryWorldModel } from '../src/knowledge/worldModel.ts';
// 宏执行 + 排练门禁
import { executeMacro, macroTraceSummary, type MacroTrace } from '../src/macroExecutor.ts';
import { MacroRehearsalGate } from '../src/sandbox/macroRehearsal.ts';
// 守卫瀑布 + 观察面
import { registerAllGuards, recentRootCauseReports, resetRootCauseGuard } from '../src/guards/index.ts';
// 审批（令牌 + 批注 + 暂存队列）
import {
  approval, approvalQueue, resetApproval, setConfirmCodeChannel,
} from '../src/approval.ts';
// 记忆器官
import { journal } from '../src/journal.ts';
import { skillLibrary } from '../src/skillLibrary.ts';
import { failureMemory } from '../src/failureMemory.ts';
import { telemetry } from '../src/telemetry.ts';
// 岔路账 / 卡
import {
  branchLedger, generateBranchCard, BRANCH_REPLAY_BUDGET_STEPS,
} from '../src/branchCards.ts';
// steer 会话
import { createSteerSession } from '../src/tools/steerTools.ts';
// checkpoint / 睡眠
import { saveCheckpoint, loadCheckpoint } from '../src/checkpoint.ts';
import { runSleepCycle, resetSleepCycle, type SleepDeps } from '../src/sleep/index.ts';
// 免疫幕 / 记忆收敛
import { InMemoryKnowledgeBase } from '../src/knowledge/knowledgeBase.ts';
import { convergeMemoryOps } from '../src/knowledge/memoryOps.ts';
import { KernelRegistry, EvidenceLedger } from '../src/kernel/registry.ts';
import { lastBranchCard, activeSteerSession, resetW4PilotWire } from '../src/autonomy/autoPilot.ts';
import { dhash } from '../src/perceptualHash.ts';

// ─── 环境卫兵：GLM 全键清空（PolicyEngine 咨询臂零网络 —— w5steer 同法） ───

const ENV_KEYS = ['GLM_API_KEY', 'ZHIPUAI_API_KEY', 'ZAI_API_KEY', 'GLM_BASE_URL', 'GLM_VLM_MODEL'] as const;
type EnvSnapshot = Array<readonly [string, string | undefined]>;
function snapshotEnv(): EnvSnapshot { return ENV_KEYS.map(k => [k, process.env[k]] as const); }
function clearEnvKeys(): void { for (const k of ENV_KEYS) delete process.env[k]; }
function restoreEnv(snap: EnvSnapshot): void {
  for (const [k, v] of snap) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}
const envSnap = snapshotEnv();

// ─── 临时目录（checkpoint / 睡眠 trace） ───

const dirs: string[] = [];
function newDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
process.on('exit', () => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

// ─── 假时钟（步进式 —— 闭环零真钟；审批队列钟与真钟锚定，w2queue 同法） ───

function mkClock(t0: number): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = t0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

// ─── guards 瀑布的测试替身 ctx（cordis 事件面 —— w2recovery 同法） ───

type Handler = (e: unknown, r?: unknown, next?: (v?: unknown) => unknown) => Promise<unknown> | unknown;
function fakeCtx(): { handlers: Array<{ event: string; handler: Handler }> } {
  const handlers: Array<{ event: string; handler: Handler }> = [];
  return {
    handlers,
    on(event: string, handler: Handler) { handlers.push({ event, handler }); return () => { /* 卸载面省略 */ }; },
  } as unknown as { handlers: Array<{ event: string; handler: Handler }> };
}

/** 派发结果锚点（resultContract 方言 —— 假物理端口的世界回执） */
function anchorJson(mutated: boolean): string {
  return mutated
    ? JSON.stringify({ status: 'SUCCESS', state_anchor: { effect: { scale: 'page-level' } } })
    : JSON.stringify({ status: 'FAILED', state_anchor: {}, next_step: 'screen did not change, re-aim' });
}

/**
 * 一次工具派发的完整瀑布：pre 链（bounds→熔断→审计WAL→弹窗→防重→金丝雀）
 * → 假物理端口执行 → post 链（熔断计数→防重记账→根因归因→journal 行→遥测）。
 * pre 拒绝（不调 next）⇒ denied（动作不落地）；post 可改写结果（恢复提示）。
 */
async function drive(
  ctx: { handlers: Array<{ event: string; handler: Handler }> },
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
  worldAct: () => Promise<string>,
): Promise<{ denied: boolean; reason?: string; value?: string }> {
  const e = { name, arguments: args, agent: { id: sessionId } };
  const pre = ctx.handlers.filter(h => h.event === 'tools/pre-execute').map(h => h.handler);
  const post = ctx.handlers.filter(h => h.event === 'tools/post-execute').map(h => h.handler);
  let result: string | undefined;
  const runPre = async (i: number): Promise<unknown> => {
    if (i >= pre.length) { result = await worldAct(); return undefined; }
    return pre[i](e, async () => runPre(i + 1));
  };
  const preOut = await runPre(0);
  const denied =
    typeof preOut === 'string' ||
    (preOut !== null && typeof preOut === 'object' && (preOut as { kind?: string }).kind === 'deny');
  if (denied) {
    const reason = typeof preOut === 'string'
      ? preOut
      : String((preOut as { reason?: string }).reason ?? '');
    return { denied: true, reason };
  }
  let out = result ?? '';
  const runPost = async (i: number, v: string): Promise<unknown> => {
    out = v;
    if (i >= post.length) return v;
    return post[i](e, v, async (nv?: unknown) => runPost(i + 1, typeof nv === 'string' ? nv : v));
  };
  await runPost(0, out);
  return { denied: false, value: out };
}

/** 手写最小配置（守卫瀑布 + 宪法的消费面 —— w5wire 同法） */
function makeConfig(over: Partial<Config> = {}): Config {
  return {
    enableJournal: true,
    enableTelemetry: true,
    dangerPatterns: '',
    maxConsecutiveFailures: 3,
    ...over,
  } as Config;
}

// ─── DI 组装：gym 世界 → 感知 / 执行（宏 + 守卫瀑布）两副面孔 ───

function fold(s: unknown): string {
  return typeof s === 'string' ? s.toLowerCase().replace(/\s+/g, ' ').trim() : '';
}
function clamp01(v: number): number { return Math.min(1, Math.max(0, v)); }

/** 修正判据的核验锚：B 应答的修正文本以「（修正」为界 —— 原文命中即核验 */
function needleOf(criterion: string): string {
  const i = criterion.indexOf('（修正');
  return fold(i > 0 ? criterion.slice(0, i) : criterion);
}

/** 世界 → 感知（gym 合成帧 + 假 OCR/假 VLM 双源 → 真实 composeSnapshot 仲裁融合） */
function gymPerceive(world: GymWorld, lastSnapshotRef: { current: WorldSnapshot | null }, now: () => number) {
  return async (): Promise<WorldSnapshot> => {
    const buf = await world.capture();
    const words = world.wordsFor(buf);
    const fingerprint = await dhash(buf).catch((): string | null => null);
    const snap = composeSnapshot({
      image: buf,
      width: world.W,
      height: world.H,
      dhash: fingerprint,
      vlmElements: world.vlmFor(buf),
      localElements: words.map(w => ({ label: w.label, bbox: w.bbox, confidence: w.confidence })),
      ocrText: words.map(w => w.label).join(' '),
      popupNotes: world.popupNotes(),
      now: now(),
    });
    lastSnapshotRef.current = snap;
    return snap;
  };
}

interface ExecuteDeps {
  world: GymWorld;
  ctx: { handlers: Array<{ event: string; handler: Handler }> };
  sessionId: string;
  goal: GoalStateMachine;
  lastSnapshotRef: { current: WorldSnapshot | null };
  now: () => number;
  /** 宏排练门禁（每 run 独立实例 —— 会话级登记账） */
  gate: MacroRehearsalGate;
  /** 最近一次宏轨迹（断言面） */
  lastMacro: { trace: MacroTrace | null };
}

/**
 * DI 执行面：世界动作经守卫瀑布派发（journal AUDIT_PRE + 行 + 熔断/根因记账）；
 * recall_skill/macro 经真实宏执行器（解析→排练门禁→重锚定→派发→抽查节奏）；
 * declare 用感知摘要核判据（runtime.createExecute 同律；修正判据按原文锚核验）。
 */
function makeExecute(d: ExecuteDeps): (action: PolicyAction) => Promise<{
  outcome: StepOutcome; criteriaEvidence?: Array<{ index: number; status: 'met' }>; note?: string;
}> {
  let verified = 0;
  const evidenceOf = (text: string): Array<{ index: number; status: 'met' }> => {
    const digest = fold(text);
    if (digest.length === 0) return [];
    const out: Array<{ index: number; status: 'met' }> = [];
    d.goal.progress.criteriaStatus.forEach((cs, index) => {
      const n = needleOf(cs.criterion);
      if (n.length > 0 && digest.includes(n)) out.push({ index, status: 'met' });
    });
    return out;
  };
  /** 当前帧锚点证据（宏重锚定 + 排练场景的共同源 —— 世界活真相） */
  const liveAnchors = () => world2Anchors(d.world);
  return async (action: PolicyAction) => {
    const a = (action ?? {}) as Partial<PolicyAction>;
    const payload = a.payload && typeof a.payload === 'object' ? (a.payload as Record<string, unknown>) : {};
    switch (a.kind) {
      case 'click': case 'scroll': case 'hotkey': {
        const target = a.target as { center?: { x?: unknown; y?: unknown } } | undefined;
        const cx = target?.center?.x; const cy = target?.center?.y;
        const args: Record<string, unknown> = a.kind === 'click'
          ? (typeof cx === 'number' && typeof cy === 'number'
              ? { x: clamp01(cx / d.world.W), y: clamp01(cy / d.world.H), ...(a.target?.label ? { target_description: a.target.label } : {}) }
              : {})
          : a.kind === 'scroll'
            ? { direction: typeof payload.direction === 'string' ? payload.direction : 'down' }
            : { keys: Array.isArray(payload.keys) ? payload.keys : [] };
        const before = d.world.mutations;
        const r = await drive(d.ctx, d.sessionId, a.kind === 'click' ? 'click_mouse' : a.kind === 'scroll' ? 'scroll_page' : 'press_hotkey', args, async () => {
          d.world.applyAction(action);
          return anchorJson(d.world.mutations > before);
        });
        if (r.denied) return { outcome: 'no_effect', note: `守卫瀑布拦截：${String(r.reason).slice(0, 140)}` };
        verified += 1;
        const evidence = verified % 3 === 0 ? evidenceOf(d.world.ocrText()) : [];
        return { outcome: d.world.mutations > before ? 'progress' : 'no_effect', ...(evidence.length > 0 ? { criteriaEvidence: evidence } : {}) };
      }
      case 'recall_skill': { //（AutonomyActionKind 闭集无 'macro' —— runtime 内部方言经自身 cast 消费，本端口只认 recall_skill）
        const skillId = typeof payload.skillId === 'number' && Number.isFinite(payload.skillId)
          ? payload.skillId : undefined;
        if (skillId === undefined) return { outcome: 'no_effect', note: 'macro：payload 缺席 skillId，不动作' };
        const baselineDhash = d.lastSnapshotRef.current?.dhash ?? null;
        const before = d.world.mutations;
        const trace = await executeMacro({ skillId }, {
          dispatch: async (step): Promise<{ ok: boolean; note: string }> => {
            if (step.tool !== 'click_mouse') return { ok: false, note: 'w7 假物理端口只接 click_mouse' };
            const sa = step.args as { x?: unknown; y?: unknown; target_description?: unknown };
            if (typeof sa.x !== 'number' || typeof sa.y !== 'number') return { ok: false, note: '坐标缺席' };
            const r = await drive(d.ctx, d.sessionId, 'click_mouse', {
              x: clamp01(sa.x), y: clamp01(sa.y),
              ...(typeof sa.target_description === 'string' ? { target_description: sa.target_description } : {}),
            }, async () => {
              d.world.clickHit(Math.round(clamp01(sa.x as number) * d.world.W), Math.round(clamp01(sa.y as number) * d.world.H));
              const hit = d.world.clickLedger[d.world.clickLedger.length - 1] ?? null;
              return anchorJson(hit !== null && d.world.mutations > before);
            });
            return r.denied ? { ok: false, note: `守卫拦截：${String(r.reason).slice(0, 80)}` } : { ok: true, note: '已派发至合成世界' };
          },
          spotCheck: async (): Promise<boolean | null> => {
            const h = await dhash(await d.world.capture()).catch((): string | null => null);
            if (typeof h !== 'string' || h === '' || baselineDhash === null) return null;
            return h !== baselineDhash;
          },
          anchors: liveAnchors,
          rehearsalScene: liveAnchors,
          rehearsal: d.gate,
          now: d.now,
        });
        d.lastMacro.trace = trace;
        try { skillLibrary.recordOutcome(skillId, trace.ok); } catch { /* 账本旁路 */ }
        verified += 1;
        return { outcome: trace.ok ? 'progress' : 'no_effect', note: `宏执行：${macroTraceSummary(trace)}` };
      }
      case 'declare': {
        const evidence = evidenceOf(d.lastSnapshotRef.current?.textDigest ?? '');
        return evidence.length > 0
          ? { outcome: 'no_effect', criteriaEvidence: evidence }
          : { outcome: 'no_effect', note: 'declare：感知文本未命中判据字面（宁缺毋错）' };
      }
      default:
        return { outcome: 'no_effect' };
    }
  };
}

/** 世界活真相 → 归一化锚点（label + bbox —— 重锚定与排练场景的共同证据源） */
function world2Anchors(world: GymWorld): Array<{ label: string; bbox: { x0: number; y0: number; x1: number; y1: number } }> {
  return world.controls().map(c => ({
    label: c.label,
    bbox: {
      x0: clamp01(c.x0 / world.W), y0: clamp01(c.y0 / world.H),
      x1: clamp01(c.x1 / world.W), y1: clamp01(c.y1 / world.H),
    },
  }));
}

/** 剧本策略端口（PolicyPort 结构契约的离线桩 —— JSDoc 明文允许） */
function scriptPolicy(script: PolicyDecision[]): { decide: (ctx: PolicyContext) => Promise<PolicyDecision> } {
  let i = 0;
  return { decide: async (): Promise<PolicyDecision> => script[Math.min(i++, script.length - 1)] };
}
function dec(action: PolicyAction): PolicyDecision { return { action, uncertain: false, degraded: false }; }
function clickAction(world: GymWorld, label: string, utility = 0.6): PolicyAction {
  const c = world.controls().find(x => x.label === label);
  assert.ok(c, `剧本动作找不到控件「${label}」`);
  return {
    kind: 'click',
    target: {
      bbox: { x0: c!.x0, y0: c!.y0, x1: c!.x1, y1: c!.y1 },
      center: { x: (c!.x0 + c!.x1) / 2, y: (c!.y0 + c!.y1) / 2 },
      label,
    },
    rationale: `剧本：点击「${label}」`,
    expectedEffect: `「${label}」被激活`,
    utility,
    riskTier: 'benign',
  };
}

/** 免疫幕的失败结局（knowledge ExecutionOutcome 方言 —— calibration.bench 同法） */
function kbFailedOutcome(topic: string): Parameters<InMemoryKnowledgeBase['learnFromOutcome']>[0] {
  return {
    intent: { id: `i-${topic}`, description: topic },
    action: { kind: 'click_mouse', args: { x: 0.4, y: 0.35 }, rationale: 'w7' },
    result: { status: 'failure', durationMs: 1, failure: { kind: 'host-error', detail: 'trap' } },
    retryCount: 0,
  } as unknown as Parameters<InMemoryKnowledgeBase['learnFromOutcome']>[0];
}

// ─── 单例隔离 ───

beforeEach(() => {
  clearEnvKeys();
  journal.reset();
  journal.configure(true, '', 1000);
  resetApproval();
  resetW4PilotWire();
  resetSleepCycle();
  resetRootCauseGuard();
  skillLibrary.reset();
  failureMemory.reset();
  telemetry.reset();
  branchLedger.reset();
});
afterEach(() => {
  restoreEnv(envSnap);
  journal.reset();
  resetApproval();
  resetW4PilotWire();
  resetSleepCycle();
  resetRootCauseGuard();
  skillLibrary.reset();
  failureMemory.reset();
  telemetry.reset();
  branchLedger.reset();
});

// ═══════════════ 剧本①：成功路径一条龙 ═══════════════

test('W7-E2E①成功路径：宣布→感知→宏技能(排练过)→验证→判据→checkpoint→睡眠→晨报（蒸馏/收敛/梦）', async () => {
  const clock = mkClock(1_700_000_000_000);
  const cfg = makeConfig();
  const ctx = fakeCtx();
  registerAllGuards(ctx as never, cfg); // guards 瀑布：bounds→熔断→审计WAL→弹窗→防重→金丝雀 + post 链

  // 合成世界（gym danger-gate：唯一安全前进路 =「稍后提醒」）
  // goal 措辞避不可逆词族（宪法③文本扫描律扫 goalText ——「支付」在场 ⇒ 全任务
  // 动作面恒顶格 destructive 恒审批，成功路径无法自主闭环；danger-gate 的危险
  // 面由「立即支付」按钮的 label 词法独立执法，与 goal 措辞无关）。
  const task: GymTask = {
    id: 'w7-e2e-ok', kind: 'danger-gate', goal: '安全搁置订单避免误操作',
    successCriteria: ['提醒已安排'], seed: 11, difficulty: 1,
  };
  const world = new GymWorld(task);
  const spec: GoalSpec = { goal: task.goal, successCriteria: task.successCriteria, maxSteps: 8, timeBudgetSec: 300 };
  const goal = new GoalStateMachine(spec, clock.now);
  const lastSnapshotRef: { current: WorldSnapshot | null } = { current: null };

  // ⓪ 任务宣布：journal 任务边界打标 + AGENT_BEGIN 入链
  journal.markTaskStart(task.goal);
  await journal.appendMarker({ kind: 'AGENT_BEGIN', taskId: 'w7-run-ok', role: 'pilot', objective: task.goal });

  // 技能蒸馏的前置物料：两次失败让宏可靠度 < 0.5（排练门禁的执法前提）
  const btn = world.controls().find(c => c.label === '稍后提醒')!;
  const skill = skillLibrary.induce('安全搁置订单', [
    { tool: 'click_mouse', args: { x: (btn.x0 + btn.x1) / 2 / world.W, y: (btn.y0 + btn.y1) / 2 / world.H, target_description: '稍后提醒' } },
  ])!;
  skillLibrary.recordOutcome(skill.id, false);
  skillLibrary.recordOutcome(skill.id, false);
  failureMemory.record(task.goal, 'click_mouse(立即支付)', 'FAILED: screen did not change', 'dhash:w7a');
  failureMemory.record(task.goal, 'click_mouse(立即支付)', 'FAILED: screen did not change', 'dhash:w7b');

  // 器官组装（全部显式注入，零源码改动）
  const perceive = gymPerceive(world, lastSnapshotRef, clock.now);
  const gate = new MacroRehearsalGate();
  const lastMacro: { trace: MacroTrace | null } = { trace: null };
  const execute = makeExecute({ world, ctx, sessionId: 'w7e2e-ok', goal, lastSnapshotRef, now: clock.now, gate, lastMacro });
  const prophecy = new ProphecyEngine({ worldModel: new InMemoryWorldModel(), now: clock.now });
  const exploration = new ExplorationLedger(task.goal, { enabled: true });
  exploration.beginSession('reset');
  const book = branchLedger; // 岔路账单例（checkpoint 第 6 段采集面）
  const ledgerPort: BranchLedgerWirePort = {
    record: (options, c: ScoringContext, meta) => book.record(options, c, meta),
    generateCard: failure => generateBranchCard(book, failure),
  };

  // 真策略引擎独立行使（器官足迹：对首屏给出真实裁决）
  const realPolicy = new PolicyEngine({ useVlmWhenUncertain: false });
  const firstSnap = await perceive();
  const d0 = await realPolicy.decide({ snapshot: firstSnap, spec, goal: goal.progress, history: [] });
  assert.equal(d0.action.kind, 'click', '真 PolicyEngine 对首屏给出点击裁决');
  assert.equal(d0.degraded, false, '离线确定性决策不降级');

  // 一条龙剧本：wait（免看门控值守足迹）→ recall_skill（排练过的宏）→ declare（判据核验）
  const script: PolicyDecision[] = [
    dec({ kind: 'wait', rationale: '先等世界自稳', expectedEffect: '世界自行变化', utility: 0.2, riskTier: 'benign' }),
    dec({
      kind: 'recall_skill', payload: { skillId: skill.id, description: '安全搁置订单' },
      rationale: '召回排练过的搁置流程', expectedEffect: '订单被安全搁置', utility: 0.7, riskTier: 'benign',
    }),
    dec({ kind: 'declare', payload: { criterion: task.successCriteria[0] }, rationale: '宣称判据达成交核验', expectedEffect: '判据置 met', utility: 0.5, riskTier: 'benign' }),
  ];
  const result = await runAutonomousLoop({
    perceive,
    policy: scriptPolicy(script),
    execute,
    goal,
    constitution: new AutonomyConstitution({ allowAutonomousTiers: ['benign'], maxTotalSteps: 12, maxConsecutiveNoEffect: 3 }),
    frameHash: async (): Promise<string | null> => dhash(await world.capture()).catch((): string | null => null),
    perceptionGate: { pollIntervalMs: 20, pollMaxMs: 40, maxConsecutiveSkips: 2 },
    prophecy,
    exploration,
    branchLedger: ledgerPort,
    branchAnchor: (): { journalLength: number; chainTip: string } => {
      try { return { journalLength: journal.list(false).length, chainTip: journal.tip }; } catch { return { journalLength: 0, chainTip: '' }; }
    },
    now: clock.now,
    sleep: clock.sleep,
  }, { maxSteps: 8, settleMs: 20 });

  // ── 闭环足迹 ──
  assert.equal(result.phase, 'achieved', `终局应为达成：${result.summary}`);
  assert.equal(result.escalated, false);
  assert.equal(world.done, true, '世界真相：订单已搁置');
  assert.deepEqual(world.clickLedger, ['稍后提醒'], '宏重锚定按标签命中唯一安全按钮');
  assert.ok(result.summary.includes('免看门控'), `免看门控记账入总汇报：${result.summary}`);
  assert.match(result.summary, /免看门控：触发 \d+ 次，跳过 \d+ 次，唤醒 \d+ 次/);
  const waitStep = result.trajectory.find(s => s.action.kind === 'wait');
  assert.ok(waitStep, 'wait 步入轨迹（值守语境的建立前提）');
  const macroStep = result.trajectory.find(s => s.action.kind === 'recall_skill');
  assert.ok(macroStep, '宏步入轨迹');
  // 门控足迹搭车律：pendingGateNote 落在「门控裁决后首个落账步」—— wait 值守
  // 语义下即随后那步（宏步）的 journal，而非 wait 步自身（wait 先于任何门控裁决落账）。
  assert.ok(macroStep!.note?.includes('免看门控'), '免看门控值守足迹搭车在门控裁决后首个落账步（宏步）注记');
  assert.match(macroStep!.note ?? '', /prophecy:(hit|miss|no-model)/, '预言旁路结算注记在宏步 journal');
  assert.equal(macroStep!.effectiveRiskTier, 'benign', '宪法判决分层盖章');

  // ── 宏执行器足迹（排练门禁真实执法） ──
  const trace = lastMacro.trace;
  assert.ok(trace, '宏轨迹在场');
  assert.equal(trace.rehearsalGate.verdict, 'passed', `低可靠宏必排练且通过：${trace.rehearsalGate}`);
  assert.ok(trace.rehearsalGate.muscleEntryId, '排练通过 ⇒ 肌肉记忆登记');
  assert.equal(trace.steps[0]?.status, 'executed');
  assert.equal(trace.steps[0]?.reanchor?.via, 'label', '按标签重锚定（非盲重放）');
  assert.equal(trace.steps[0]?.reanchor?.label, '稍后提醒');
  assert.ok(trace.ok, '宏执行成功');

  // ── journal / 岔路账 / 宪法足迹 ──
  const all = journal.list(false);
  assert.ok(all.some(e => e.tool === 'AGENT_BEGIN'), 'AGENT_BEGIN 标记入链');
  assert.ok(all.some(e => e.tool === 'AUDIT_PRE'), '审计 WAL（AUDIT_PRE）先于派发入链');
  assert.ok(all.some(e => e.tool === 'click_mouse'), '动作行经守卫 post 链入链');
  assert.equal(journal.verify().ok, true, '哈希链完整');
  assert.ok(book.size >= 3, `岔路账逐决策落账：${book.size}`);
  assert.equal(lastBranchCard(), null, '达成终局不铸岔路卡（诚实边界）');

  // ── checkpoint 段往返 ──
  const dir = newDir('w7e2e-ok-');
  const cpPath = join(dir, 'checkpoint.json');
  const saved = saveCheckpoint(cpPath);
  assert.equal(saved.ok, true, `checkpoint 保存：${JSON.stringify(saved)}`);
  const savedRows = journal.list(false).length;
  assert.ok(saved.steps! >= 3, '档内 journal 条数 ≥ 3');
  journal.reset(); // 模拟崩溃
  skillLibrary.reset();
  const loaded = loadCheckpoint(cpPath);
  assert.equal(loaded.restored, true);
  assert.ok(loaded.report.includes('journal: OK'), `journal 段恢复：${loaded.report.join(' | ')}`);
  assert.ok(loaded.report.includes('skillLibrary: OK'));
  assert.ok(loaded.report.includes('branchLedger: OK'), '岔路账段随档存活');
  assert.equal(journal.list(false).length, savedRows, 'journal 行数往返一致');
  assert.equal(journal.verify().ok, true, '恢复后链校验不误报');
  assert.ok(skillLibrary.get(skill.id), '技能跨崩溃存活');

  // ── 睡眠六幕 + 晨报 ──
  const kb = new InMemoryKnowledgeBase();
  // 免疫幕簇原料：三次经历措辞微异而同主题 —— learnFromOutcome 的同题复证律
  //（learnTopicKey 全同 ⇒ 只升滴度不开新条目）；语义相近异文才积成 ≥3 簇
  //（MIN_CLUSTER_SIZE=3，知识库睡眠整合的真实执法前提）。
  for (const flavor of ['之一', '之二', '之三']) kb.learnFromOutcome(kbFailedOutcome(`w7 搁置订单陷阱 ${flavor}`));
  const ownRegistry = new KernelRegistry();
  const ownLedger = new EvidenceLedger();
  const ownEvolution = new EvolutionEngine({ seed: 7 });
  const sleepDeps: SleepDeps = {
    journal,
    skillLibrary,
    knowledgeBase: kb,
    conductor: { maybeTick: (): never[] => [] },
    selfAudit: auditTrajectory,
    approvalQueue,
    memoryOpsConverger: (): ReturnType<typeof convergeMemoryOps> =>
      convergeMemoryOps({ registry: ownRegistry, ledger: ownLedger, seed: 'w7-ok-seed' }),
    dream: {
      failures: (): unknown => failureMemory.dump().records,
      evolution: ownEvolution,
      budget: { maxDreams: 2, maxStepsPerDream: 6 },
    },
    meter: { summary: (): { calls: number; failures: number; promptTokens: number; completionTokens: number } => ({ calls: 9, failures: 2, promptTokens: 120, completionTokens: 60 }) },
    log: (): void => { /* 测试静音 */ },
  };
  const tracePath = join(dir, 'sleep.jsonl');
  const report = await runSleepCycle(sleepDeps, { sleepTracePath: tracePath, budgetMs: 15_000, now: clock.now });
  assert.deepEqual(report.acts.map(a => a.name), ['replay', 'distill', 'immune', 'calibrate', 'audit', 'report'], '六幕齐演');
  const distill = report.acts.find(a => a.name === 'distill')!;
  assert.equal(distill.counts.skills, 1, '蒸馏幕从 journal 归纳技能');
  // 模板蒸馏前置：两门同骨架技能（DTW 对齐反统一）
  skillLibrary.induce('向导流程A', [
    { tool: 'click_mouse', args: { x: 0.3, y: 0.4, target_description: '下一步' } },
    { tool: 'click_mouse', args: { x: 0.5, y: 0.6, target_description: '完成' } },
  ]);
  skillLibrary.induce('向导流程B', [
    { tool: 'click_mouse', args: { x: 0.32, y: 0.42, target_description: '下一步' } },
    { tool: 'click_mouse', args: { x: 0.52, y: 0.62, target_description: '完成' } },
  ]);
  const templates = skillLibrary.distillTemplates();
  assert.ok(templates.created.length >= 1, `反统一模板蒸馏 ≥1：${JSON.stringify(templates.created)}`);
  const immune = report.acts.find(a => a.name === 'immune')!;
  assert.equal(immune.status, 'ok');
  assert.equal((immune.counts.consolidated ?? 0) >= 1, true, `免疫幕海马体→皮层蒸馏：${JSON.stringify(immune.counts)}`);
  const replayAct = report.acts.find(a => a.name === 'replay')!;
  assert.equal(replayAct.counts.chainOk, 1, '回放幕哈希链校验通过');
  assert.ok(report.dream, '梦回放摘要入晨报');
  assert.ok(report.dream!.replayed >= 1, `梦回放真实重放 ≥1：${report.dream!.replayed}`);
  assert.ok(Array.isArray(report.dream!.lessons), '反事实教训清单在册');
  assert.ok(report.memoryOps, '记忆操作收敛摘要入晨报');
  assert.equal(report.memoryOps!.arms, 28, '收敛臂总数 = 7 类 × 4 操作');
  assert.equal(report.memoryOps!.seed, 'w7-ok-seed', '收敛种子 = 集成契约注入值');
  assert.ok(report.approvalQueue, '待批队列摘要入晨报');
  assert.equal(report.approvalQueue!.pending, 0, '成功路径无待批条目（诚实零）');
  assert.equal(report.usage?.calls, 9, '用量台账快照入晨报');
  assert.ok(report.watermark, '水位线指纹在册');
  const line = JSON.parse(readFileSync(tracePath, 'utf8').trim().split('\n')[0]!) as Record<string, unknown>;
  assert.equal(line.type, 'sleep', '晨报 JSONL 落盘');
  assert.ok((line.approvalQueue as { pending: number }).pending === 0 && line.memoryOps && line.dream, '行内携带队列/收敛/梦字段');
});

// ═══════════════ 剧本②：失败与复原路径一条龙 ═══════════════

test('W7-E2E②失败复原：审批升级→暂存队列→steer漂移出题B改判据→重跑铸岔路卡→steer(2)换支→完成→晨报裁决', async () => {
  const clock = mkClock(1_700_100_000_000);
  const cfg = makeConfig({ maxConsecutiveFailures: 1 }); // 熔断阈值 1：失败足迹快速可验
  const ctx = fakeCtx();
  registerAllGuards(ctx as never, cfg);

  const task: GymTask = {
    id: 'w7-e2e-fail', kind: 'danger-gate', goal: '安全搁置订单避免误支付',
    successCriteria: ['提醒已安排'], seed: 13, difficulty: 1,
  };
  const world = new GymWorld(task);
  const spec: GoalSpec = {
    goal: task.goal, successCriteria: ['立即支付', '提醒已安排'], maxSteps: 6, timeBudgetSec: 300,
  };
  const constitution = new AutonomyConstitution({ allowAutonomousTiers: ['benign'], maxTotalSteps: 12, maxConsecutiveNoEffect: 3 });
  journal.markTaskStart(task.goal);
  await journal.appendMarker({ kind: 'AGENT_BEGIN', taskId: 'w7-run-fail', role: 'pilot', objective: task.goal });

  // ── 第 1 跑：真 PolicyEngine 驱动危险点击 → 宪法审批升级 ──
  const lastSnapshotRef: { current: WorldSnapshot | null } = { current: null };
  const perceive = gymPerceive(world, lastSnapshotRef, clock.now);
  const goal1 = new GoalStateMachine(spec, clock.now);
  const exec1 = makeExecute({ world, ctx, sessionId: 'w7e2e-f1', goal: goal1, lastSnapshotRef, now: clock.now, gate: new MacroRehearsalGate(), lastMacro: { trace: null } } as unknown as ExecuteDeps);
  const r1 = await runAutonomousLoop({
    perceive,
    policy: new PolicyEngine({ useVlmWhenUncertain: false }), // 真策略引擎入环
    execute: exec1,
    goal: goal1,
    constitution,
    now: clock.now,
    sleep: clock.sleep,
  }, { maxSteps: 6 });
  assert.equal(r1.escalated, true, '危险动作升级移交');
  assert.equal(r1.escalateReason, 'approval-required', `宪法审批升级：${r1.summary}`);
  assert.equal(r1.trajectory.length, 0, '被拦动作不入轨迹不执行');
  assert.equal(world.done, false, '世界未被触动');
  assert.equal(world.clickLedger.length, 0, '零派发');

  // ── 审批令牌 + 超时入暂存队列 + 批注（amendment） ──
  const deliveries: Array<{ token: string; confirmCode: string }> = [];
  setConfirmCodeChannel(d => { deliveries.push({ token: d.token, confirmCode: d.confirmCode }); });
  let queueClockBase = Date.now();
  let queueClockOffset = 0;
  approvalQueue.arm({
    now: (): number => queueClockBase + queueClockOffset,
    stagingTimeoutMs: 1_000,
    ttlMs: 60_000,
  });
  const pa = approval.request('点击「立即支付」完成订单支付', {
    actionShape: { tool: 'click_mouse', x: 0.75, y: 0.7, target_description: '立即支付' },
    sceneFingerprint: 'dhash:w7-danger',
  });
  assert.ok(pa.token, '审批令牌铸出');
  assert.ok(pa.confirmCodeHash, '带外确认码铸造（簿记只留哈希）');
  queueClockBase = Date.now(); // 锚定真钟铸造点（w2queue 同法）
  queueClockOffset = 1_100;   // 越过暂存超时
  const staged = approvalQueue.stageAction({
    token: pa.token,
    description: '点击「立即支付」完成订单支付',
    evidence: {
      screenshotRef: 'journal#snap-w7',
      sceneFingerprint: 'dhash:w7-danger',
      riskTier: 'irreversible-high',
      actionShape: { tool: 'click_mouse', x: 0.75, y: 0.7, target_description: '立即支付' },
    },
  });
  assert.equal(staged.ok, true, `超时入暂存队列：${JSON.stringify(staged)}`);
  const queueId = staged.ok ? staged.entry.id : '';
  assert.equal(approvalQueue.pendingSummary().pending, 1, '队列 1 项待批');
  assert.equal(approvalQueue.pendingSummary().items[0].actionTool, 'click_mouse', '证据链携带动作形状');
  // 批注式裁决面（H1 amendment）：第二枚令牌带批注授予
  //（S2 带码律：通道在场 ⇒ pa2 铸 confirmCodeHash ⇒ grant 必须携带外投递的
  // 明文码 —— 缺码即 ok:false 'confirm-code-required'，这正是遗产断言失败的根因）
  const pa2 = approval.request('改走稍后提醒路径');
  const delivery2 = deliveries.find(d => d.token === pa2.token);
  assert.ok(delivery2, '第二枚令牌的带外确认码已投递（人证在通道侧在册）');
  assert.equal(
    approval.grantDetailed(pa2.token, true, { confirmCode: delivery2.confirmCode, note: '改点稍后提醒' }).ok,
    true,
    '带码 + 批注的完整裁决通道授予',
  );
  assert.equal(approval.status(pa2.token).amended, true, '批注铸为 amendment patch');
  assert.ok(approval.amendmentOf(pa2.token), '执行侧可读批注');

  // ── 第 2 跑（重跑）：漂移出题 → steer 应答 B 改判据 ──
  const goal2 = new GoalStateMachine(spec, clock.now);
  const exec2 = makeExecute({ world, ctx, sessionId: 'w7e2e-f2', goal: goal2, lastSnapshotRef, now: clock.now, gate: new MacroRehearsalGate(), lastMacro: { trace: null } } as unknown as ExecuteDeps);
  const r2 = await runAutonomousLoop({
    perceive,
    policy: scriptPolicy([dec({ kind: 'wait', rationale: '待命', expectedEffect: '等待', utility: 0.1, riskTier: 'benign' })]),
    execute: exec2,
    goal: goal2,
    constitution,
    steer: { enabled: true, driftThreshold: 0.05 }, // 低报警线：重跑语境漂移立即出题
    now: clock.now,
    sleep: clock.sleep,
  }, { maxSteps: 4 });
  assert.equal(r2.escalateReason, 'steer-drift', `漂移出题升级：${r2.summary}`);
  assert.ok(r2.summary.includes('活意图漂移出题'), '题面进总汇报供转述');
  assert.ok(r2.summary.includes('B 改判据'), '三选一含 B 改判据');
  const session2 = activeSteerSession();
  assert.ok(session2, '在役 steer 会话（跨环存续）');
  const question = session2!.pending();
  assert.ok(question, '待答题目在场');
  assert.equal(question!.answer_format, 'single-char');
  const ansB = session2!.answer('B');
  assert.equal(ansB.status, 'answered');
  assert.equal(ansB.applied, true, 'B 应答写回目标机');
  assert.equal(ansB.choice, 'B');
  assert.ok(ansB.amendment!.to.includes('修正'), `自动生成修正文本：${ansB.amendment!.to}`);
  assert.equal(ansB.restart!.kind, 'steer-restart', '重启指引随行');
  const handoffs = session2!.drainAmendments!();
  assert.equal(handoffs.length, 1, '修订判据一次性移交');
  assert.equal(handoffs[0].goalText, task.goal, '账携带出题时 goal 原文');
  assert.notEqual(goal2.progress.criteriaStatus[0].criterion, '立即支付', '判据已被修正');
  assert.deepEqual(session2!.drainAmendments!(), [], 'drain 一次性');

  // ── 第 3 跑（重跑失败段）：scroll-hunt 死链 → 守卫瀑布足迹 + 探索拦截 + 岔路卡 ──
  const task3: GymTask = {
    id: 'w7-e2e-scroll', kind: 'scroll-hunt', goal: '找到深页目标',
    successCriteria: ['深页目标可见'], seed: 5, difficulty: 1,
  };
  const world3 = new GymWorld(task3);
  const ref3: { current: WorldSnapshot | null } = { current: null };
  const perceive3 = gymPerceive(world3, ref3, clock.now);
  const goal3 = new GoalStateMachine(
    { goal: task3.goal, successCriteria: task3.successCriteria, maxSteps: 4, timeBudgetSec: 300 }, clock.now);
  const exec3 = makeExecute({ world: world3, ctx, sessionId: 'w7e2e-f3', goal: goal3, lastSnapshotRef: ref3, now: clock.now, gate: new MacroRehearsalGate(), lastMacro: { trace: null } } as unknown as ExecuteDeps);
  // 岔路账端口：本组装在每步落账时补记该决策点的未试备选（scroll / wait）
  // —— record(options[]) 的 Top-K 契约本就接收候选集；driveLoop 只喂单选是宿主现状。
  const altScroll: PolicyAction = { kind: 'scroll', payload: { direction: 'down' }, rationale: '备选：滚动暴露折叠区', expectedEffect: '视口下移', utility: 0.5, riskTier: 'benign' };
  const altWait: PolicyAction = { kind: 'wait', rationale: '备选：等待自稳', expectedEffect: '世界变化', utility: 0.3, riskTier: 'benign' };
  const ledgerPort3: BranchLedgerWirePort = {
    record: (options, c: ScoringContext, meta) => branchLedger.record([...options, altScroll, altWait], c, meta),
    generateCard: failure => generateBranchCard(branchLedger, failure),
  };
  const exploration = new ExplorationLedger(task3.goal, { enabled: true });
  exploration.beginSession('reset');
  const escalateNoDet: PolicyAction = {
    kind: 'escalate', payload: { reason: 'no-deterministic-action' },
    rationale: '所有已知路失败，升级裁决', expectedEffect: '控制权移交', utility: 0.3, riskTier: 'benign',
  };
  const r3 = await runAutonomousLoop({
    perceive: perceive3,
    policy: scriptPolicy([
      dec(clickAction(world3, '查看深页目标')), // 死链：FAILED 入守卫瀑布
      dec(clickAction(world3, '查看深页目标')), // 第二次：熔断（阈值 1）拦截
      dec(escalateNoDet),                        // 探索端口拦截替代
    ]),
    execute: exec3,
    goal: goal3,
    constitution,
    exploration,
    branchLedger: ledgerPort3,
    branchAnchor: (): { journalLength: number; chainTip: string } => {
      try { return { journalLength: journal.list(false).length, chainTip: journal.tip }; } catch { return { journalLength: 0, chainTip: '' }; }
    },
    now: clock.now,
    sleep: clock.sleep,
  }, { maxSteps: 3 });
  assert.equal(r3.phase, 'aborted', `步数保险丝收场：${r3.summary}`);
  assert.ok(r3.summary.includes('W3-7 探索拦截'), `探索端口足迹：${r3.summary}`);
  assert.ok(r3.summary.includes('替代升级 1 次'), '恢复态升级被探索建议替代');
  // 守卫瀑布足迹：熔断 GUARD_BLOCKED 入链 + 根因报告 + 失败记忆
  await new Promise<void>(resolve => setImmediate(resolve)); // 熔断存证 void-promise 落账
  assert.ok(journal.list(false).some(e => e.tool === 'GUARD_BLOCKED'), '熔断拦截防篡改存证入链');
  assert.ok(recentRootCauseReports().length >= 1, '根因归因报告在环');
  assert.ok(failureMemory.dump().records.length >= 1, '失败记忆自动接线入账');
  assert.ok(journal.list(false).some(e => e.tool === 'AUDIT_PRE'), '死链派发前审计 WAL 入链');
  // 岔路卡：失败终局相铸卡（三候选 + 支点锚）
  const card = lastBranchCard();
  assert.ok(card, '岔路卡经 lastBranchCard 出口在册');
  assert.equal(card!.goalPhase, 'aborted');
  assert.equal(card!.candidates.length, 3, '三候选（选择 + 两条未试备选）');
  assert.ok(card!.pivot.anchor.journalLength > 0, '支点锚携带真实 journal 步账');

  // ── steer(2) 换支：会话持卡 → 应答支号 → 偏置步进面 ──
  const sessionB = createSteerSession({ goal: goal3, screenText: (): string | null => null });
  assert.equal(typeof sessionB.holdBranchCard, 'function', '真实会话持卡面在场（接口可缺席，真件必有）');
  sessionB.holdBranchCard?.(card);
  const k = card!.candidates.findIndex(c => c.signature.startsWith('scroll:')) + 1;
  assert.ok(k >= 1 && k <= 3, `换支目标为 scroll 备选（k=${k}）`);
  const br = sessionB.answer(String(k));
  assert.equal(br.status, 'branch', '支号应答走岔路模式');
  assert.equal(br.branch!.kind, 'branch-replay');
  assert.equal(br.branch!.k, k);
  assert.equal(br.branch!.bias.preferredActionKeys.length, 1, '决策偏置载荷 = 选中支签名');
  assert.equal(br.branch!.budget_steps, BRANCH_REPLAY_BUDGET_STEPS, '重放预算随行');
  assert.equal(typeof sessionB.takeBranchBias, 'function', '换支步进面在场（接口可缺席，真件必有）');
  const stepper = sessionB.takeBranchBias?.() ?? null;
  assert.ok(stepper, '偏置步进面移交（一次性）');
  assert.equal(sessionB.takeBranchBias?.() ?? null, null, 'takeBranchBias 一次性');

  // ── checkpoint：崩溃 → 恢复（队列 / 岔路账 / journal 段往返） ──
  const dir = newDir('w7e2e-fail-');
  const cpPath = join(dir, 'checkpoint.json');
  const saved = saveCheckpoint(cpPath);
  assert.equal(saved.ok, true, `checkpoint 保存：${JSON.stringify(saved)}`);
  const savedRows = journal.list(false).length;
  const savedBranchEntries = branchLedger.dump().entries.length;
  journal.reset();
  branchLedger.reset();
  approvalQueue.arm({ now: (): number => queueClockBase + queueClockOffset, stagingTimeoutMs: 1_000, ttlMs: 60_000 }); // 清内存队列（模拟进程重启）
  const loaded = loadCheckpoint(cpPath);
  assert.equal(loaded.restored, true);
  assert.ok(loaded.report.includes('approvalQueue: OK'), `待批队列随档复活：${loaded.report.join(' | ')}`);
  assert.ok(loaded.report.includes('branchLedger: OK'));
  assert.equal(journal.list(false).length, savedRows, 'journal 行数往返一致');
  assert.equal(branchLedger.dump().entries.length, savedBranchEntries, '岔路账支点跨崩溃存活');
  assert.equal(approvalQueue.pendingSummary().pending, 1, '暂存队列条目跨崩溃存活');
  assert.equal(approvalQueue.pendingSummary().items[0].id, queueId, '恢复的是同一队列条目');

  // ── 第 4 跑（换支重放 → 完成）：偏置注入 + 修订判据回放 ──
  // goal 措辞与剧本①同律避不可逆词族（宪法③扫 goalText+payload：原 spec 的
  // 「支付」字样会令换支重放的每一步恒顶格审批 —— 复原完成段无从自主闭环）。
  // 判据数组保持原样（criteria 不入宪法扫描面；「立即支付」作为被 B 修正的
  // 原判据，其 needle 核验语义不变）。
  const spec4: GoalSpec = {
    goal: '安全搁置订单避免误操作', successCriteria: spec.successCriteria, maxSteps: 6, timeBudgetSec: 300,
  };
  const goal4 = new GoalStateMachine(spec4, clock.now);
  goal4.begin();
  assert.equal(goal4.amendCriterion(handoffs[0].amendment.criterion_index, handoffs[0].amendment.to), true, '修订判据重放进新目标机');
  const biasCalls: Array<{ preferredActionKeys?: string[] }> = [];
  const exec4 = makeExecute({ world, ctx, sessionId: 'w7e2e-f4', goal: goal4, lastSnapshotRef, now: clock.now, gate: new MacroRehearsalGate(), lastMacro: { trace: null } } as unknown as ExecuteDeps);
  const safeBtn = clickAction(world, '稍后提醒', 0.8);
  const r4 = await runAutonomousLoop({
    perceive,
    policy: scriptPolicy([
      // declare 的 payload 只是人读叙事（执行面按全部判据 needle 核验感知文本）——
      // 措辞避危险词族即可，核验语义由判据台账承载。
      dec({ kind: 'declare', payload: { criterion: '按修订判据核验当前屏' }, rationale: '按修订判据核验当前屏', expectedEffect: '判据置 met', utility: 0.5, riskTier: 'benign' }),
      dec(safeBtn),
      dec({ kind: 'declare', payload: { criterion: '提醒已安排' }, rationale: '终局核验', expectedEffect: '判据置 met', utility: 0.5, riskTier: 'benign' }),
    ]),
    execute: exec4,
    goal: goal4,
    constitution,
    steerBias: stepper!, // 换支重放偏置（预算执法）
    branchLedger: {
      record: (_options, c: ScoringContext): unknown => { biasCalls.push({ preferredActionKeys: c.preferredActionKeys }); return null; },
      generateCard: (): null => null,
    },
    now: clock.now,
    sleep: clock.sleep,
  }, { maxSteps: 6 });
  assert.equal(r4.phase, 'achieved', `换支后完成：${r4.summary}`);
  assert.equal(world.done, true, '世界真相：稍后提醒已点击');
  assert.ok(world.clickLedger.includes('稍后提醒'), '安全支落地');
  assert.ok(biasCalls.length >= 1 && biasCalls[0].preferredActionKeys?.[0] === card!.candidates[k - 1].signature,
    `换支偏置铸入评分上下文：${JSON.stringify(biasCalls[0])}`);
  stepper!.complete();
  assert.equal(stepper!.state().status, 'completed', '重放随达成收尾');
  const sm = goal4.progress.criteriaStatus;
  assert.ok(sm.every(c => c.status === 'met'), `全部判据达成：${JSON.stringify(sm)}`);

  // ── 睡眠六幕：晨报待批清单 → 批注式批量裁决 ──
  const kb = new InMemoryKnowledgeBase();
  for (let i = 0; i < 3; i++) kb.learnFromOutcome(kbFailedOutcome('w7 支付陷阱'));
  const report = await runSleepCycle({
    journal,
    skillLibrary,
    knowledgeBase: kb,
    conductor: { maybeTick: (): never[] => [] },
    selfAudit: auditTrajectory,
    approvalQueue,
    memoryOpsConverger: (): ReturnType<typeof convergeMemoryOps> =>
      convergeMemoryOps({ registry: new KernelRegistry(), ledger: new EvidenceLedger(), seed: 'w7-fail-seed' }),
    dream: {
      failures: (): unknown => failureMemory.dump().records,
      evolution: new EvolutionEngine({ seed: 11 }),
      budget: { maxDreams: 2, maxStepsPerDream: 6 },
    },
    log: (): void => { /* 测试静音 */ },
  }, { sleepTracePath: join(dir, 'sleep.jsonl'), budgetMs: 15_000, now: clock.now });
  assert.deepEqual(report.acts.map(a => a.name), ['replay', 'distill', 'immune', 'calibrate', 'audit', 'report']);
  assert.ok(report.approvalQueue, '晨报携带待批清单');
  assert.equal(report.approvalQueue!.pending, 1, '暂存队列 1 项待批');
  assert.equal(report.approvalQueue!.items[0].id, queueId, '晨报列出的是暂存条目本身');
  assert.equal(report.approvalQueue!.items[0].riskTier, 'irreversible-high', '证据引用随行');
  assert.ok(report.dream && report.dream.replayed >= 1, '失败记忆喂梦回放');
  assert.ok(report.memoryOps && report.memoryOps.arms === 28, '记忆收敛摘要入晨报');
  // 人回来接口：批注式批量裁决（否决 + 批注）
  const adj = approvalQueue.adjudicate(undefined, false, '放弃支付路径，改人工跟进');
  assert.equal(adj.results[0].outcome, 'denied', '批量裁决否决在册');
  assert.equal(approvalQueue.pendingSummary().deniedAwaitingPrune, 1, '已拒条目转入待清理账');
  assert.equal(approvalQueue.pendingSummary().pending, 0, '待批清零');
});

// ─── 组装缝申报（诚实边界） ───
// 1. guards 瀑布的宿主事件面（cordis ctx.on('tools/pre|post-execute')）在纯 DI 测试
//    中无真宿主 —— 本文件以 fake ctx + waterfall 组合子复刻事件级联（w2recovery
//    既有同法）；守卫代码本身零改动。
// 2. driveLoop 的 branchLedger.record 只喂「当步单选」—— Top-K 岔路账的候选集
//    缝（options[]）由本组装在端口层补记未试备选（scroll/wait），使铸卡携带
//    三候选（steer(2) 换支的合法域）。此为组装层选择，非源码改动。
// 3. 假物理端口的世界回执锚点 JSON 由本测试铸造（resultContract 方言）——
//    真宿主由工具层铸造，纯 DI 下无此层。
