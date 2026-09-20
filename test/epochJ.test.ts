// test/epochJ.test.ts
// J 纪元（工程收敛）：全库代码质量攻坚的回归执法。
// 每一项修复配独立测试 —— 防「借尸还魂」（B 纪元方法论）。
// 范围：审批授予门 / swarm 增量游标 / 钉扎名额泄漏 / 相似度长度自适应 /
//       Tier0 压制口径 / 预演 degraded 放行 + rehearsalChainId / grounding
//       幻觉 id 拒绝 / 快照发号器 / heal 多行空 catch / to_step 下界钳制。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { approval } from '../src/approval.ts';
import { similarity } from '../src/perceptualHash.ts';
import { skillLibrary } from '../src/skillLibrary.ts';
import { swarm } from '../src/swarm.ts';
import { journal } from '../src/journal.ts';
import { contextManager } from '../src/contextManager.ts';
import { doctor } from '../src/qualityDoctor.ts';
import { ReflexiveDecisionStation } from '../src/knowledge/stations.ts';
import type { DecisionContext, ScenePatch } from '../src/knowledge/contracts.ts';
import type { Config } from '../src/config.ts';
import { PipelineOrchestratorImpl } from '../src/orchestration/pipeline.ts';
import { DefaultExecutionStation } from '../src/orchestration/stations.ts';
import type {
  IntentPayload, PipelineConfig, VisionStation, DecisionStation, ExecutionStation,
  AttentionEnvelope, PerceptionRequest, DecisionContext as D6Context, DecisionOutput,
  ExecutionOrder, ExecutionResult,
} from '../src/orchestration/contracts.ts';
import { createSaveSkillTool } from '../src/tools/skillTools.ts';

// ─── 共用 DSL（对齐 reflexiveDecision.test 的铸造律）───

function el(name: string, x: number, y: number, w = 0.1, h = 0.05): ScenePatch['elements'][number] {
  return { source: 'L1-tree', role: 'button', name, rect: { x, y, width: w, height: h } };
}
function sceneOf(...els: Array<ScenePatch['elements'][number]>): ScenePatch[] {
  return [{
    region: { id: 'g0x0', x: 0, y: 0, width: 1, height: 1 },
    elements: els, funnelDepth: 'L1', capturedAt: Date.now(),
  }];
}
function ctx(intent: string, sc: ScenePatch[], knowledgeContext?: DecisionContext['knowledgeContext']): DecisionContext {
  return { intent: { id: 'i', description: intent }, scene: sc, knowledgeContext };
}
function envOf(payload: DecisionContext) {
  return { station: 'decision' as const, payload, tokenBudget: 2000 };
}

beforeEach(() => {
  journal.reset();
  swarm.reset();
  skillLibrary.reset();
  contextManager.reset();
  approval.sweep();
});

// ─── J-1 审批授予门：grant 是执行的必要条件 ───

test('J-1a: 请求 ≠ 同意 —— 未 grant 的令牌 validate/consume 双拒', () => {
  const pa = approval.request('send payment');
  assert.equal(approval.validate(pa.token), false, '未授予的令牌不得过闸门');
  assert.equal(approval.consume(pa.token), false, '未授予的令牌不得被消费');
});

test('J-1b: grant(true) 激活；grant(false) 等价作废；伪令牌 grant 拒绝', () => {
  const pa = approval.request('delete record');
  assert.equal(approval.grant(pa.token, true), true);
  assert.equal(approval.validate(pa.token), true);
  const pb = approval.request('format disk');
  assert.equal(approval.grant(pb.token, false), true);
  assert.equal(approval.validate(pb.token), false, 'grant=false 立即作废');
  assert.equal(approval.grant('APR-FAKE', true), false, '伪令牌无法被授予');
});

// ─── J-2 swarm 增量游标：重复 crystalize 不再重复计数 ───

test('J-2: crystalize 幂等 —— 同一批日志条目只入账一次', async () => {
  const hash = 'a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890';
  for (let i = 0; i < 3; i++) {
    await journal.append({
      ts: Date.now(), tool: 'click_mouse', args: { x: 0.1 * (i + 1), y: 0.5 },
      status: 'SUCCESS', effect_detected: true,
      observe: `#${i} dHash=${hash} popup=false`,
    });
  }
  const first = swarm.crystalize();
  assert.equal(first, 3, '首次结晶消费全部 3 条');
  const second = swarm.crystalize();
  assert.equal(second, 0, 'J 纪元：重复结晶零新增（旧实现再 +3）');
  const top = swarm.report().topRoutes[0];
  assert.equal(top.attempts, 3, '晶体 attempts 不被重复调用膨胀');
  // 新条目到达后增量入账
  await journal.append({
    ts: Date.now(), tool: 'click_mouse', args: { x: 0.9, y: 0.1 },
    status: 'FAILED', effect_detected: false,
    observe: `#3 dHash=${hash} popup=false`,
  });
  assert.equal(swarm.crystalize(), 1, '只消费新增的 1 条');
});

// ─── J-3 相似度长度自适应：分母取实际哈希长度 ───

test('J-3: similarity 按位长归一 —— 短哈希全异 = 0（旧实现 1-10/64=0.84）', () => {
  const a = '0'.repeat(10);
  const b = '1'.repeat(10);
  assert.equal(similarity(a, b), 0);
  assert.equal(similarity(a, a), 1);
  // 64 位标准哈希行为不变
  const h1 = '0'.repeat(64);
  const h2 = '1'.repeat(64);
  assert.equal(similarity(h1, h2), 0);
});

// ─── J-4 Tier 0 压制口径：error-pattern 条目的最大置信度 ───

test('J-4a: 高置信 workflow 不得劫持压制 —— error-pattern 0.2 < 0.55 不抑制', async () => {
  const station = new ReflexiveDecisionStation({ chat: null });
  const sc = sceneOf(el('settings', 0.1, 0.1, 0.2, 0.1));
  const knowledge = {
    summary: '[workflow] reliable flow; [error-pattern] weak memory',
    categories: ['error-pattern' as const, 'workflow' as const],
    maxConfidence: 0.9, // 全类别最大值来自 workflow —— 旧判据会误触发压制
    sources: [],
    fragments: [
      { category: 'workflow' as const, content: 'open settings panel', confidence: 0.9 },
      { category: 'error-pattern' as const, content: 'rare glitch', confidence: 0.2 },
    ],
  };
  const out = await station.decide(envOf(ctx('open settings', sc, knowledge)));
  assert.ok('kind' in out, '低置信陷阱记忆不压制反射（旧实现被 workflow 0.9 劫持）');
  assert.equal(out.kind, 'click_mouse');
});

test('J-4b: 高置信 error-pattern 仍照常压制（保守语义零回归）', async () => {
  const station = new ReflexiveDecisionStation({ chat: null });
  const sc = sceneOf(el('settings', 0.1, 0.1, 0.2, 0.1));
  const knowledge = {
    summary: '[error-pattern] trap',
    categories: ['error-pattern' as const],
    maxConfidence: 0.2, // 低于阈值 —— 若新口径误读此字段也不该压制
    sources: [],
    // 陷阱证据指向同一元素（sim ≥ floor 才有否决资格）；新鲜亲证
    // （trust 0.9 ≥ VERIFY_TRUST_FLOOR）⇒ 诚实接地不探针 ⇒ 真压制
    fragments: [{ category: 'error-pattern' as const, content: 'settings button is broken', confidence: 0.9, verifiedAt: Date.now() }],
  };
  const out = await station.decide(envOf(ctx('open settings', sc, knowledge)));
  assert.ok(!('kind' in out), 'error-pattern 0.9 ≥ 0.55 且亲证 ⇒ 压制（NeedGrounding 无 kind 判别）');
});

// ─── J-5 预演闸门：degraded 放行 / failed 拒绝 / rehearsalChainId 回流 ───

function execEnv(payload: ExecutionOrder): AttentionEnvelope<'execution', ExecutionOrder> {
  return { station: 'execution', payload, tokenBudget: 0 };
}

test('J-5a: 预演 degraded（验证层缺席）放行交付，rehearsed 不冒领', async () => {
  const station = new DefaultExecutionStation({
    sandbox: { rehearse: async () => ({ verdict: 'degraded', reportPath: 'r.json' }) },
    host: { execute: async () => ({ effectDetected: true, latencyMs: 5 }) },
    rehearseBeforeExecute: true,
  });
  const r = await station.execute(execEnv({ seq: 3, intentRef: 'intent-abc', action: { kind: 'click_mouse', args: { x: 0.5, y: 0.5 } } }));
  assert.equal(r.failure, undefined, 'degraded = 无证据，不阻断宿主执行（旧实现恒 sandbox-degraded）');
  assert.equal(r.rehearsed, false, '仅 passed 置真');
  assert.equal(r.effectDetected, true);
  assert.equal(r.rehearsalChainId, 'chain-exec-intent-abc-3', '链 id 编入 intentRef（并发 run 不撞号）');
});

test('J-5b: 预演 failed（硬反证据）仍拒绝交付', async () => {
  const station = new DefaultExecutionStation({
    sandbox: { rehearse: async () => ({ verdict: 'failed', reportPath: 'r.json' }) },
    host: { execute: async () => ({ effectDetected: true, latencyMs: 5 }) },
    rehearseBeforeExecute: true,
  });
  const r = await station.execute(execEnv({ seq: 1, action: { kind: 'click_mouse', args: { x: 0.5, y: 0.5 } } }));
  assert.equal(r.failure?.kind, 'sandbox-degraded');
  assert.equal(r.rehearsalChainId, 'chain-exec-1', '无 intentRef 时退回旧方言');
});

// ─── J-6 grounding 裁决：幻觉 regionId 拒绝 / 合法 regionId 批准 ───

function makeStations(decisionScript: Array<DecisionOutput>): { vision: VisionStation; decision: DecisionStation; execution: ExecutionStation } {
  let call = 0;
  const vision: VisionStation = {
    async *perceive(e: AttentionEnvelope<'vision', PerceptionRequest>) {
      for (const r of e.payload.regions) {
        yield {
          region: r,
          elements: [{ source: 'L2-ocr' as const, role: 'button' as const, name: 'b', rect: { x: 0.5, y: 0.5, width: 0.1, height: 0.05 } }],
          funnelDepth: 'L2' as const,
          capturedAt: Date.now(),
        };
      }
    },
  };
  const decision: DecisionStation = {
    decide: async (_e: AttentionEnvelope<'decision', D6Context>) => {
      const out = decisionScript[Math.min(call, decisionScript.length - 1)];
      call += 1;
      return out;
    },
  };
  const execution: ExecutionStation = {
    execute: async (e: AttentionEnvelope<'execution', ExecutionOrder>) =>
      ({ seq: e.payload.seq, effectDetected: true, latencyMs: 1, rehearsed: false }) as ExecutionResult,
  };
  return { vision, decision, execution };
}

function pipelineConfig(): PipelineConfig {
  return {
    maxDecisionRetries: 1,
    regionGrid: { cols: 2, rows: 2 },
    stationTokenBudgets: { vision: 10, decision: 100, execution: 0 },
    rehearseBeforeExecute: false,
    attemptTimeoutMs: 2000,
    perceptionDeadlineMs: 1000,
    consumePlanReady: false,
  };
}

const intent: IntentPayload = { id: 'intent-j6', goal: 'click the save button', source: 'user' };

test('J-6a: 幻觉 regionId（不在场景/网格）⇒ 拒绝终局 failed', async () => {
  const orch = new PipelineOrchestratorImpl();
  assert.ok(orch.configure(pipelineConfig()).ok);
  const stations = makeStations([
    { kind: 'need-grounding', regionId: 'g9x9', question: 'where is save?' },
    { kind: 'click_mouse', args: { x: 0.5, y: 0.5 }, rationale: 'r' }, // 旧实现（恒批准）才会走到这里
  ]);
  orch.wire(stations);
  const report = await orch.run(intent);
  assert.equal(report.verdict, 'failed', '幻觉 id 被诚实拒绝（旧实现恒批准 + 静默回退 g0x0）');
});

test('J-6b: 合法 regionId（在场且未达 L3）⇒ 批准 → L3 重扫 → 动作完成', async () => {
  const orch = new PipelineOrchestratorImpl();
  assert.ok(orch.configure(pipelineConfig()).ok);
  const stations = makeStations([
    { kind: 'need-grounding', regionId: 'g0x0', question: 'where is save?' },
    { kind: 'click_mouse', args: { x: 0.5, y: 0.5 }, rationale: 'save' },
  ]);
  orch.wire(stations);
  const report = await orch.run(intent);
  assert.equal(report.verdict, 'completed');
  assert.equal(report.attempts.length, 1);
  assert.ok(report.tokenBudgetsGranted.vision > 0, 'L3 重扫的 token 预算入账');
});

// ─── J-7 技能库发号器：nextSynthId 快照保真 + nextId 撞号防线 ───

test('J-7: dump/restore 携带 nextSynthId；稀疏 ids 下 nextId 不撞号', () => {
  skillLibrary.restore({ skills: [], nextId: 1, nextSynthId: 7 });
  assert.equal(skillLibrary.dump().nextSynthId, 7, '旧实现 checkpoint 丢 nextSynthId（崩溃后 syn-1 撞名）');
  // ids 稀疏（1,5）：旧实现 length+1 = 3 < 6 ⇒ 新技能撞 id 5
  skillLibrary.restore({
    skills: [
      { id: 1, name: 'skill-1', description: 'a', steps: [], successCount: 1, attemptCount: 1, createdAt: 1, lastUsedAt: 1 },
      { id: 5, name: 'skill-5', description: 'b', steps: [], successCount: 1, attemptCount: 1, createdAt: 1, lastUsedAt: 1 },
    ],
    nextId: 3,
  });
  assert.ok(skillLibrary.dump().nextId >= 6, `nextId ≥ max(id)+1，实际 ${skillLibrary.dump().nextId}`);
});

// ─── J-8 钉扎名额泄漏：降级即解钉，名额随图像释放 ───

test('J-8: 安全阀驱逐钉扎图后名额不泄漏 —— 后续高显著度图仍可钉扎', async () => {
  // 场景（maxImageCount=1, pinBudget=2）：B/C 靠惊讶钉扎 → D 入窗触发安全阀
  // 驱逐钉扎图 → J 纪元修复后 D 可钉扎并存续；旧实现僵尸名额占满 budget，
  // D 无法钉扎 → 被优先驱逐（窗口残留 C 而非 D）。
  contextManager.configure(1, 10_000_000, false, 0, false);
  contextManager.configureFocus(true, 2, 0, 6);
  const h1 = '0'.repeat(64);
  const h2 = '1'.repeat(32) + '0'.repeat(32); // dist(h1,h2)=32 ≥ 24 ⇒ 惊讶
  const h3 = '0'.repeat(32) + '1'.repeat(32); // dist(h2,h3)=64
  const h4 = '1'.repeat(64);                  // dist(h3,h4)=32
  await contextManager.addScreenshot('a', h1);
  await contextManager.addScreenshot('b', h2);
  await contextManager.addScreenshot('c', h3); // 安全阀路径驱逐 B（钉扎）
  await contextManager.addScreenshot('d', h4); // J 纪元后 D 可钉扎
  const last = contextManager.lastImageRecord();
  assert.equal(last?.hash, h4, 'D 存活为窗口最新图（旧实现：僵尸名额 ⇒ D 被逐、窗口残留 C）');
  assert.equal(contextManager.imageCount(), 1);
});

// ─── J-9 heal 多行空 catch：注释化手术真实生效 ───

function makeDoctorFixture(): { root: string; cfg: { sourceRoot: string; memoryPath: string; strict: boolean } } {
  const root = mkdtempSync(join(tmpdir(), 'doctor-j-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  return { root, cfg: { sourceRoot: join(root, 'src'), memoryPath: join(root, 'doctor-memory.json'), strict: false } };
}

test('J-9: 多行空 catch 的机械修复真实改写文件（旧实现 no-op 却计为已应用）', async () => {
  const { root, cfg } = makeDoctorFixture();
  const file = join(root, 'src', 'multiline.ts');
  writeFileSync(file, 'try { a(); } catch (e) {\n}\n', 'utf8');
  await doctor.configure(cfg);
  const report = await doctor.diagnose();
  assert.ok(report.findings.some(f => f.ruleId === 'smell.empty-catch'), '多行空 catch 被诊断发现');

  const res = await doctor.heal(report, { maxRisk: 'mechanical', authorized: true, dryRun: false });
  assert.equal(res.applied.length, 1, '补丁真实应用');
  const healed = readFileSync(file, 'utf8');
  assert.ok(healed.includes('/* FIXME(doctor)'), 'open 行尾被注释化（多行形态真实改写）');
  assert.ok(!/\{\s*\}/.test(healed), '不再有空洞块');
  assert.equal(doctor.memory().totalFixesApplied, 1);

  doctor.resetMemory();
  doctor.resetConfig();
  rmSync(root, { recursive: true, force: true });
});

// ─── J-10 to_step 下界钳制：负数不再触发 slice 尾部语义 ───

test('J-10: save_skill 的 to_step=-2 被钳到 from（旧实现 slice(0,-1) 铸错技能）', async () => {
  for (let i = 0; i < 5; i++) {
    await journal.append({
      ts: Date.now(), tool: 'click_mouse', args: { x: 0.1 * i, y: 0.2 },
      status: 'SUCCESS', effect_detected: true,
    });
  }
  const tool = createSaveSkillTool(); // 零参工厂（config 不入参 —— 单例依赖注入）
  await (tool as unknown as { execute: (args: unknown) => Promise<string> }).execute({ description: 'j10 skill', from_step: 0, to_step: -2 });
  const skills = skillLibrary.list();
  assert.equal(skills.length, 1);
  assert.equal(skills[0].steps.length, 1, 'to<from 收敛到 from（旧实现 = 除最后 1 条外的全部 4 步）');
});

// ─── J-11 纵深防御：屏幕尺寸有限正数闸（NaN 坐标永久免疫）───

test('J-11: sanitizeScreenSize —— 坏数据 ⇒ null，好数据直通', async () => {
  const { sanitizeScreenSize } = await import('../src/physicalExecution/d7HostPort.ts');
  assert.deepEqual(sanitizeScreenSize({ width: 1920, height: 1080 }), { width: 1920, height: 1080 });
  // 旧 NaN 事故的全部形态：undefined 键 / 非有限 / 非正 / 缺席
  assert.equal(sanitizeScreenSize(undefined), null);
  assert.equal(sanitizeScreenSize({} as never), null);
  assert.equal(sanitizeScreenSize({ width: undefined, height: 1080 } as never), null, '旧事故形态：width undefined');
  assert.equal(sanitizeScreenSize({ width: Number.NaN, height: 1080 } as never), null);
  assert.equal(sanitizeScreenSize({ width: 0, height: 1080 } as never), null);
  assert.equal(sanitizeScreenSize({ width: -5, height: Infinity } as never), null);
});

// ─── J-12 'escalated' 兑现语义：grounding 预算耗尽 = 上交裁决权（非谎称失败）───

test('J-12: 决策层反复索要 L3 帮助 ⇒ verdict=escalated（七态枚举无死态）', async () => {
  const orch = new PipelineOrchestratorImpl();
  assert.ok(orch.configure(pipelineConfig()).ok);
  const stations = makeStations([
    { kind: 'need-grounding', regionId: 'g0x0', question: 'where is save?' }, // 每轮都合法要 L3
  ]);
  orch.wire(stations);
  const report = await orch.run({ id: 'intent-j12', goal: 'g', source: 'user' });
  assert.equal(report.verdict, 'escalated', '预算耗尽 = 上交（旧实现谎称 failed；且 escalated 曾是死态）');
  assert.match(report.terminalReason, /grounding budget exhausted/, '终局归因诚实');
});

// ─── J-13 'escalated' 第二路径：completed 但 D-4 needs_review ⇒ 上交人类 ───

test('J-13: reconcileVerdicts —— rejected 否决 / needs_review 把 completed 升格为 escalated', async () => {
  const { reconcileVerdicts } = await import('../src/orchestration/index.ts');
  type Report = Parameters<typeof reconcileVerdicts>[0];
  const mk = (chainId: string): Report => ({
    intentRef: 'i13', verdict: 'completed', terminalReason: 'goal achieved',
    attempts: [{
      seq: 1, attempt: 1,
      action: { kind: 'click_mouse', args: {}, rationale: 'r' } as never,
      result: { seq: 1, effectDetected: true, latencyMs: 1, rehearsed: false, rehearsalChainId: chainId },
    }],
    tokenBudgetsGranted: { vision: 0, decision: 0, execution: 0 },
    chainTip: 't', reportPath: 'in-memory',
  });
  // rejected：否决权
  const idx1 = new Map([['chain-exec-i13-1', { subject: 'chain-exec-i13-1', chainTip: 't', verdict: 'rejected', score: 40, rationale: 'genesis violated' } as never]]);
  const r1 = mk('chain-exec-i13-1');
  reconcileVerdicts(r1, idx1);
  assert.equal(r1.verdict, 'rejected');
  assert.equal(r1.attempts[0].doctorVerdict?.verdict, 'rejected', '判决按 rehearsalChainId 精确补写');
  // needs_review：completed ⇒ escalated（上交人类，不静默放行）
  const idx2 = new Map([['chain-exec-i13-1', { subject: 'chain-exec-i13-1', chainTip: 't', verdict: 'needs_review', score: 75, rationale: 'chain not audited' } as never]]);
  const r2 = mk('chain-exec-i13-1');
  reconcileVerdicts(r2, idx2);
  assert.equal(r2.verdict, 'escalated', '硬证据说成了但 D-4 要求复核 ⇒ 上交');
  // 非 completed（如 failed）不被 needs_review 篡改
  const r3 = mk('chain-exec-i13-1');
  r3.verdict = 'failed';
  reconcileVerdicts(r3, idx2);
  assert.equal(r3.verdict, 'failed', '保守：仅 completed 可被升格');
});

// ─── J-14 审批盲区收窄：expected_text 第二危险信号 ───

test('J-14: 不填 target_description 但 expected_text 命中危险词 ⇒ 闸门照常拦截', async () => {
  const { createClickMouseTool } = await import('../src/tools/clickMouse.ts');
  const cfg = {
    enableApprovalGate: true,
    dangerPatterns: 'send,发送,delete,删除,pay,支付',
  } as unknown as Config;
  const tool = createClickMouseTool(cfg);
  const out = await (tool as unknown as { execute: (a: unknown) => Promise<string> })
    .execute({ x: 0.5, y: 0.5, expected_text: '点击后出现 发送订单 确认' });
  const parsed = JSON.parse(out);
  assert.equal(parsed.status, 'ACTION_REQUIRED', '旧实现：不填描述即可绕过闸门');
  assert.equal(parsed.state_anchor.danger_signal, 'expected_text', '归因到第二信号通道');
  // 安全面零回归：正常预期文本不触发
  const okOut = await (tool as unknown as { execute: (a: unknown) => Promise<string> })
    .execute({ x: 0.5, y: 0.5, expected_text: '菜单展开' });
  assert.notEqual(JSON.parse(okOut).status, 'ACTION_REQUIRED');
});

// ─── J-15 parseExpectation 双分支同词表：未知 kind ⇒ 诚实缺席 ───

test('J-15: JSON 分支与简写分支同一 kind 词表（拼错 kind 不再"貌似合法实为弃权"）', async () => {
  const { parseExpectation } = await import('../src/intent.ts');
  // 合法 kind：两分支都收
  assert.equal(parseExpectation('toggle_on')?.kind, 'toggle_on');
  assert.equal(parseExpectation('{"kind":"toggle_on","text":"x"}')?.text, 'x');
  assert.equal(parseExpectation('{"kind":"page_navigate"}')?.kind, 'page_navigate');
  // 未知 kind：两分支同拒（旧实现 JSON 分支任意字符串直通 as 断言）
  assert.equal(parseExpectation('togle_on'), null, '简写拼错 ⇒ null（既有行为）');
  assert.equal(parseExpectation('{"kind":"togle_on"}'), null, 'JSON 拼错 ⇒ null（J 纪元对齐）');
  assert.equal(parseExpectation('{"kind":123}'), null);
});
