// test/pan39-42.sandbox.test.ts
// ΠΑΝ 修复潮（F2-3 工单）：沙箱排练→固化→重放闭环五处断裂的执法测试。
//   ΠΑΝ-39 装配函数接线完备（applySandboxStack：4 工具 + 3 事件 + 引擎配置 +
//          sandboxLog 落盘恢复 D-6/D-7 双断点 + dispose 可逆清理）
//   ΠΑΝ-40 闭环五断裂（chain 臂发射方 / rehearse_chain 收场景 / 嗅探键名对齐
//          生产者 / hostFingerprint 生产侧铸造 / 门 4B 指纹缺席分道）
//   ΠΑΝ-41 双账本合一（引擎与宏门禁同账本、save 真实落盘、崩溃后恢复）+
//          指纹相似度单源（128 位不再负数）
//   ΠΑΝ-42 重放门禁语义（步级扫描扩 hotkey/drag；可靠度从派发完成升级为
//          效果验证 —— refuted 不虚增计数、缺席诚实降级）
// 全离线确定性：假 ctx / 注入引擎与执行器 / 隔离 MuscleMemoryStore / tmp 落盘。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'node:url';

import { applySandboxStack } from '../src/sandbox/apply.ts';
import { MuscleMemoryStore, sharedMuscleMemoryStore } from '../src/sandbox/memory.ts';
import { MacroRehearsalGate, sharedMacroRehearsalGate, resetMacroRehearsalGate } from '../src/sandbox/macroRehearsal.ts';
import { SandboxEngineImpl } from '../src/sandbox/engine.ts';
import { sandboxLog } from '../src/sandbox/log.ts';
import { sniffFingerprint } from '../src/sandbox/events.ts';
import { fpSimilarity, muscleReliability, type SandboxAction, type HostExecutor } from '../src/sandbox/types.ts';
import { COGNITION_PLAN_READY_EVENT, COGNITION_PLAN_VERSION } from '../src/cognitionEvents.ts';
import { DOCTOR_VERDICT_EVENT, makeScore } from '../src/doctorEvents.ts';
import { mintChainPlanReady, planTasks, type ChatFn } from '../src/planner.ts';

// ─── 测试基建 ───

/** 假 cordis ctx：工具注册收集 / 事件总线可发可收 / 服务注册表 / effect 收集 */
function makeFakeCtx() {
  const tools: Array<{ name: string; execute: (args?: any) => Promise<string> }> = [];
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const services = new Map<string, unknown>();
  const effects: Array<() => void> = [];
  const ctx = {
    tools: { register: (t: any) => { tools.push(t); } },
    on: (ev: string, h: (...args: any[]) => any) => {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev)!.push(h);
    },
    get: (n: string) => services.get(n),
    set: (n: string, v: unknown) => { services.set(n, v); },
    emit: (ev: string, ...args: any[]) => {
      for (const h of handlers.get(ev) ?? []) h(...args);
    },
    effect: (reg: () => () => void) => { effects.push(reg()); },
  };
  return {
    ctx: ctx as never,
    tools,
    handlers,
    emit: ctx.emit,
    services,
    disposeAll: () => { for (const d of effects) d(); },
  };
}

const tick = (ms = 15): Promise<void> => new Promise(r => setTimeout(r, ms));

/** 直接铸造已固化条目（绕开排练/医生 —— 门禁路径的确定性底座；epochChi 同法） */
function consolidatedEntry(
  eng: SandboxEngineImpl,
  steps: SandboxAction[],
  entryFp: string | undefined,
): string {
  const outcome = {
    chainId: `chain-pan-${Date.now().toString(36)}`, snapshotId: 'snap-pan', verdict: 'passed' as const,
    steps: steps.map((action, index) => ({
      index, action, effectDetected: true, expectationMet: null, latencyMs: 1,
    })),
    failedAtIndex: null, score: makeScore(50)!, verificationLayers: [] as never[],
    totalLatencyMs: steps.length, chainTip: 'tip-pan', reportPath: 'in-memory',
    ...(entryFp !== undefined ? { entrySceneFingerprint: entryFp } : {}),
    createdAt: 1,
  };
  const r = eng.consolidate(outcome as never, 'approved');
  assert.ok(r.ok && r.value, 'passed × approved ⇒ 固化入库');
  return r.value!.id;
}

beforeEach(() => {
  sandboxLog.reset();
  sharedMuscleMemoryStore.reset();
  resetMacroRehearsalGate();
});

// ─── ΠΑΝ-39：装配函数接线完备 ───

test('ΠΑΝ-39a: applySandboxStack 装配完备 —— 4 工具注册 + 3 事件接线 + 服务自荐 + dispose 可逆', async () => {
  const f = makeFakeCtx();
  const dir = mkdtempSync(join(tmpdir(), 'pan39a-'));
  try {
    const engine = new SandboxEngineImpl(f.ctx as never, new MuscleMemoryStore());
    const stack = applySandboxStack(f.ctx as never, { reportDir: dir }, { engine });
    // 四工具注册面（工作单语义：rehearse_chain / recall_muscle / replay_on_host / verify_sandbox_log）
    assert.deepEqual(
      f.tools.map(t => t.name).sort(),
      ['recall_muscle', 'rehearse_chain', 'replay_on_host', 'verify_sandbox_log'],
      '四个演武工具全部注册',
    );
    // 三条事件接线
    assert.ok(f.handlers.has(COGNITION_PLAN_READY_EVENT), 'D-1 计划投喂接线（chain 臂排练）');
    assert.ok(f.handlers.has(DOCTOR_VERDICT_EVENT), 'D-4 判决回执接线（双闸门固化）');
    assert.ok(f.handlers.has('tools/post-execute'), '宿主管线观察接线（指纹嗅探镜像源头）');
    // 服务自荐（dsh.sandbox）
    assert.ok(f.services.has('dsh.sandbox'), 'dsh.sandbox 服务自荐注册');
    assert.strictEqual(stack.engine, engine, '句柄持有注入引擎（注入端口保可测）');
    // dispose 可逆清理（不抛即证；ctx.effect 登记与句柄 dispose 同一函数）
    stack.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ΠΑΝ-39b: sandboxLog 双断点恢复 —— 装配后 D-5/D-6/D-7 复用账本真实落盘', async () => {
  const f = makeFakeCtx();
  const dir = mkdtempSync(join(tmpdir(), 'pan39b-'));
  try {
    applySandboxStack(f.ctx as never, { reportDir: dir }, { engine: new SandboxEngineImpl(null, new MuscleMemoryStore()) });
    const tool = f.tools.find(t => t.name === 'rehearse_chain')!;
    const out = JSON.parse(await tool.execute({
      actions: JSON.stringify([{ kind: 'click_mouse', args: { x: 0.5, y: 0.5 } }]),
    }));
    assert.equal(out.status, 'SUCCESS');
    const logPath = join(dir, 'sandbox-log.jsonl');
    assert.ok(existsSync(logPath), '装配面 configure 后哈希链账本真实落盘（此前恒内存态）');
    const line = readFileSync(logPath, 'utf8').split('\n').filter(l => l.trim() !== '').pop()!;
    const entry = JSON.parse(line);
    assert.ok(typeof entry.hash === 'string' && entry.hash.length > 0, '链上哈希在场（append-only 链语义）');
    assert.equal(entry.kind, 'rehearsal-end');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ΠΑΝ-39c（源级金丝雀）：组合根挂线在场的防回归锚 —— 修复前的病灶正是「装配
// 层生产不可达」（C2-3 H1：根插件从不装载 D-5）。断言以源文本为证（pan3437
// 的 idxSrc 同方言）：挂线调用 + 门控（ΤΕΛ-8a 起为沙箱专属开关 enableSandboxStack
// 三态门控：未设回退 autonomyEnabled 旧门控，显式设置优先 —— D-G16① 收口）
// + 黑名单透传（ΠΑΝ-42 第五门消费面）。
test('ΠΑΝ-39c: 组合根挂线在场 —— src/index.ts 经沙箱专属开关（未设回退旧门控）装配沙箱栈', () => {
  const idxSrc = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
  assert.ok(idxSrc.includes('applySandboxStack(ctx,'),
    '组合根一行挂线在场（此前 dsh.plugin.json entry 只指根插件且根插件从不装载 D-5）');
  assert.ok(idxSrc.includes('config.enableSandboxStack ?? config.autonomyEnabled'),
    'ΤΕΛ-8a 沙箱专属开关三态门控在场（未设回退 autonomyEnabled 旧门控保兼容，显式 true/false 优先）');
  assert.ok(idxSrc.includes('hotkeyBlacklistCsv: config.hotkeyBlacklist'),
    '热键黑名单 CSV 透传（ΠΑΝ-42 步级扫描/不可逆判定的消费面）');
  assert.ok(!idxSrc.includes('enableHostReplayExecution: true'),
    '宿主真派发开关不被组合根点亮（开发者预览语义保持 —— 点亮需 SandboxConfig 层显式开）');
});

// ─── ΠΑΝ-40a：chain 臂发射方（planner）───

test('ΠΑΝ-40a: mintChainPlanReady 铸 chain 臂（cognitionEvents 方言零新造）；毒证链不铸造', () => {
  const payload = mintChainPlanReady({
    actions: [{ kind: 'click_mouse', args: { x: 0.5, y: 0.5 } }],
  });
  assert.ok(payload, '合法链铸造成功');
  assert.ok('chain' in payload, '载荷是 CognitionChainPayload（chain 臂）');
  assert.equal((payload as { chain: { origin: string } }).chain.origin, 'cognition');
  assert.equal((payload as { planVersion: string }).planVersion, COGNITION_PLAN_VERSION, 'planVersion 单源（cognitionEvents）');
  // 毒证拦截：非法 kind / 空链 ⇒ null（诚实缺席，绝不发射半截链）
  assert.equal(mintChainPlanReady({ actions: [{ kind: 'rm_rf', args: {} }] }), null, '词表外 kind 不铸造');
  assert.equal(mintChainPlanReady({ actions: [] }), null, '空链不铸造');
  assert.equal(mintChainPlanReady({ actions: [{ kind: 'click_mouse', args: { x: 5, y: 0.5 } }] }), null, '越界坐标不铸造');
  // 可选字段诚实缺席/在场
  const withFp = mintChainPlanReady({
    actions: [{ kind: 'noop', args: {} }],
    entrySceneFingerprint: '01'.repeat(32),
    virtualScene: [{ role: 'button', name: 'ok', rect: { x: 0, y: 0, width: 0.1, height: 0.1 } }],
    budgetMs: 5000,
  });
  assert.ok(withFp && 'chain' in withFp);
  const chain = (withFp as unknown as { chain: Record<string, unknown> }).chain;
  assert.equal(chain.entrySceneFingerprint, '01'.repeat(32));
  assert.ok(Array.isArray(chain.virtualScene) && (chain.virtualScene as unknown[]).length === 1);
  assert.equal(chain.budgetMs, 5000);
  // 域外预算诚实缺席
  const badBudget = mintChainPlanReady({ actions: [{ kind: 'noop', args: {} }], budgetMs: -1 });
  assert.ok(badBudget && 'chain' in badBudget);
  assert.equal((badBudget as unknown as { chain: Record<string, unknown> }).chain.budgetMs, undefined, '负预算不入域（mintIntentPlanReady 同律）');
});

test('ΠΑΝ-40a: planTasks 计划就绪发射 chain 臂 —— 空计划/毒证链/发射钩故障均不毒化主流程', async () => {
  const chatOk: ChatFn = async () => '[{"id":1,"action":"open browser","deps":[]}]';
  const emitted: unknown[] = [];
  const tasks = await planTasks('do something', chatOk, {
    emitPlanReady: p => { emitted.push(p); },
    chain: { actions: [{ kind: 'click_mouse', args: { x: 0.5, y: 0.5 } }] },
  });
  assert.equal(tasks.length, 1, '计划主流程照旧返回子任务');
  assert.equal(emitted.length, 1, '计划就绪 ⇒ chain 臂发射恰好一次');
  assert.ok('chain' in (emitted[0] as object), '发射的是 chain 臂载荷');
  // 毒证链：不发射（诚实缺席），计划照旧
  const emitted2: unknown[] = [];
  await planTasks('t2', chatOk, {
    emitPlanReady: p => { emitted2.push(p); },
    chain: { actions: [{ kind: 'rm_rf', args: {} }] },
  });
  assert.equal(emitted2.length, 0, '非法动作链不发射');
  // 空计划（chat 返回无数组）：不发射
  const emitted3: unknown[] = [];
  await planTasks('t3', async () => 'no json here', {
    emitPlanReady: p => { emitted3.push(p); },
    chain: { actions: [{ kind: 'noop', args: {} }] },
  });
  assert.equal(emitted3.length, 0, '空计划不发射');
  // 发射钩抛错：旁路收敛，计划主流程不炸
  const tasks4 = await planTasks('t4', chatOk, {
    emitPlanReady: () => { throw new Error('bus down'); },
    chain: { actions: [{ kind: 'noop', args: {} }] },
  });
  assert.equal(tasks4.length, 1, '发射钩故障不毒化计划主流程（旁路义务）');
});

test('ΠΑΝ-40a: 装配接线后 cognition/plan-ready chain 臂 → engine.receivePlan 排练（闭环第一环）', async () => {
  const f = makeFakeCtx();
  const engine = new SandboxEngineImpl(f.ctx as never, new MuscleMemoryStore());
  applySandboxStack(f.ctx as never, {}, { engine });
  const scene = [{ role: 'button', name: 'save', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } }];
  const payload = mintChainPlanReady({
    id: 'chain-pan-emit',
    actions: [{ kind: 'click_mouse', args: { x: 0.2, y: 0.15 } }],
    virtualScene: scene as never,
  });
  assert.ok(payload);
  f.emit(COGNITION_PLAN_READY_EVENT, payload);
  await tick();
  const endEntry = sandboxLog.list().find(e => e.kind === 'rehearsal-end'
    && e.data?.chainId === 'chain-pan-emit');
  assert.ok(endEntry, 'chain 臂经事件总线触发排练并落账（此前 receivePlan 是死码）');
  assert.equal(endEntry!.data?.verdict, 'passed', '携带场景的链排练产真证据');
});

// ─── ΠΑΝ-40b/c/d/e：闭环其余断裂 ───

test('ΠΑΝ-40b: rehearse_chain 收 virtualScene 参数 —— 有场景产证据（passed），缺省诚实 degraded 保留', async () => {
  const f = makeFakeCtx();
  applySandboxStack(f.ctx as never, {}, { engine: new SandboxEngineImpl(null, new MuscleMemoryStore()) });
  const tool = f.tools.find(t => t.name === 'rehearse_chain')!;
  const scene = [{ role: 'button', name: 'save', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } }];
  const withScene = JSON.parse(await tool.execute({
    actions: JSON.stringify([{ kind: 'click_mouse', args: { x: 0.2, y: 0.15 } }]),
    virtual_scene: JSON.stringify(scene),
  }));
  assert.equal(withScene.status, 'SUCCESS');
  assert.equal(withScene.verdict, 'passed', '装配面把场景传入 ⇒ L1 命中证据（此前恒 degraded）');
  // 缺省：degraded 诚实保留（零回归）
  const noScene = JSON.parse(await tool.execute({
    actions: JSON.stringify([{ kind: 'click_mouse', args: { x: 0.2, y: 0.15 } }]),
  }));
  assert.equal(noScene.status, 'SUCCESS');
  assert.equal(noScene.verdict, 'degraded', '缺场景 ⇒ 诚实 degraded（绝不伪造 passed）');
  // 畸形场景：整链拒绝（毒证拦截）
  const badScene = JSON.parse(await tool.execute({
    actions: JSON.stringify([{ kind: 'click_mouse', args: { x: 0.2, y: 0.15 } }]),
    virtual_scene: JSON.stringify([{ role: 'button', name: 'x', rect: { x: 5, y: 0, width: 0.1, height: 0.1 } }]),
  }));
  assert.equal(badScene.status, 'FAILED');
  assert.match(badScene.reason, /virtual_scene/);
});

test('ΠΑΝ-40c: 嗅探键名对齐真实生产者 —— screen/region/exitFingerprint(hex)/hash/sceneHash 双方言归一', () => {
  const fp = '01'.repeat(32);
  // BeforeState 方言（clickMouse/actionVerifier 生产实键）：screen / region
  assert.equal(sniffFingerprint(JSON.stringify({ state_anchor: { screen: fp } })), fp);
  assert.equal(sniffFingerprint(JSON.stringify({ state_anchor: { region: fp } })), fp);
  // contextManager 帧记录方言：hash / sceneHash（驼峰）
  assert.equal(sniffFingerprint(JSON.stringify({ hash: fp })), fp);
  assert.equal(sniffFingerprint(JSON.stringify({ sceneHash: fp })), fp);
  // 技能离场指纹方言：16-hex dhash（cap.dhash 原样 hex）⇒ 归一为 64 位位串
  const hex = 'deadbeefdeadbeef';
  const expectedBits = BigInt(`0x${hex}`).toString(2).padStart(64, '0');
  assert.equal(sniffFingerprint(JSON.stringify({ exitFingerprint: hex })), expectedBits, 'hex dhash 归一为位串');
  // 旧四键兼容保留
  assert.equal(sniffFingerprint(JSON.stringify({ scene_hash: fp })), fp);
  // 非指纹 hex（任意长取证摘要）：形状卫兵拒绝（诚实缺席）
  assert.equal(sniffFingerprint(JSON.stringify({ hash: 'a'.repeat(64) })), null);
  assert.equal(sniffFingerprint('plain text not json'), null);
});

test('ΠΑΝ-40d+40e: 指纹铸造→固化→召回→重放闭环 —— 排练时铸指纹入库，门4B 同屏放行', async () => {
  const f = makeFakeCtx();
  const engine = new SandboxEngineImpl(f.ctx as never, new MuscleMemoryStore());
  const dispatched: SandboxAction[] = [];
  const executor: HostExecutor = {
    executeAction: async a => { dispatched.push(a); return { ok: true, note: 'faked' }; },
    verifyChainEffect: async () => ({ verified: true, note: 'world-effect observed (faked)' }),
  };
  applySandboxStack(f.ctx as never, {}, { engine, hostExecutor: executor });
  const fp = '01'.repeat(32);
  // 生产侧宿主观察：tools/post-execute 携带 BeforeState 方言指纹（ΠΑΝ-40c 对齐后可嗅探）
  //（waterfall 礼仪：第三参 next 透传 —— 与真实宿主管线同形状）
  f.emit('tools/post-execute', { name: 'click_mouse', args: {} },
    JSON.stringify({ status: 'SUCCESS', state_anchor: { effect: 'verification-off', screen: fp } }),
    (v: unknown) => v);
  // 排练（带场景）—— entrySceneFingerprint 未显式供源 ⇒ ΠΑΝ-40d 从宿主观察铸造
  const tool = f.tools.find(t => t.name === 'rehearse_chain')!;
  const scene = [{ role: 'button', name: 'save', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } }];
  const out = JSON.parse(await tool.execute({
    actions: JSON.stringify([{ kind: 'click_mouse', args: { x: 0.2, y: 0.15, target_description: 'save button' } }]),
    virtual_scene: JSON.stringify(scene),
  }));
  assert.equal(out.verdict, 'passed');
  assert.equal(out.entry_scene_fingerprint_minted, true, '排练时刻宿主观察在场 ⇒ 入口指纹铸造（此前全库无生产赋值点）');
  // 医生 approved → 双闸门固化
  f.emit(DOCTOR_VERDICT_EVENT, {
    subject: out.chain_id, chainTip: 'tip', verdict: 'approved', score: makeScore(80)!,
  });
  await tick();
  // 召回（同屏加成 —— 门4B 对偶面）
  const recall = f.tools.find(t => t.name === 'recall_muscle')!;
  const rec = JSON.parse(await recall.execute({ query: 'chain save' }));
  assert.equal(rec.status, 'SUCCESS');
  assert.equal(rec.hits.length, 1, '固化条目可召回（此前库恒空）');
  const entryId = rec.hits[0].id;
  // 重放：两阶段令牌 + 五门（含 4B 同屏 —— 铸造的入口指纹 vs 宿主观察）
  const replay = f.tools.find(t => t.name === 'replay_on_host')!;
  const phase1 = JSON.parse(await replay.execute({ entry_id: entryId }));
  assert.equal(phase1.status, 'PENDING_USER_CONSENT');
  assert.match(phase1.token, /^SBX-/);
  const phase2 = JSON.parse(await replay.execute({ entry_id: entryId, confirm_token: phase1.token }));
  assert.equal(phase2.status, 'SUCCESS', '门4B 同屏（铸造指纹 = 宿主观察）⇒ 放行（此前恒拒）');
  assert.equal(phase2.verdict, 'confirmed');
  assert.equal(dispatched.length, 1, '真派发一步');
  assert.equal(phase2.reliability_after, Number((2 / 3).toFixed(3)), '效果验证通过 ⇒ 可靠度回写 (1+1)/(1+2)');
});

test('ΠΑΝ-40e: 门4B 指纹缺席分道 —— 不可逆宏 fail-closed 拒绝；可逆宏降级放行并标注', async () => {
  // 场景一：不可逆步（危险描述无令牌）+ 双侧指纹缺席 ⇒ fail-closed 拒绝
  const engIrrev = new SandboxEngineImpl(null, new MuscleMemoryStore());
  engIrrev.configure({});
  engIrrev.wireHostExecutor({
    executeAction: async () => ({ ok: true, note: 'never' }),
  });
  const irrevId = consolidatedEntry(engIrrev, [
    { kind: 'click_mouse', args: { x: 0.5, y: 0.5, target_description: 'delete the database' } },
  ] as SandboxAction[], undefined);
  const t1 = engIrrev.requestReplayToken(irrevId);
  const o1 = await engIrrev.replayOnHost(irrevId, { confirmToken: t1 });
  assert.equal(o1.verdict, 'failed', '不可逆宏 + 指纹证据缺席 ⇒ fail-closed（绝不放行）');
  const gateIrrev = sandboxLog.list().find(e => e.kind === 'host-replay-gate'
    && e.data?.gate === 'fingerprint-absent-irreversible');
  assert.ok(gateIrrev, '拒绝入链归因 fingerprint-absent-irreversible');

  // 场景二：全可逆步 + 指纹缺席 ⇒ 降级放行 + 车道标注
  const engRev = new SandboxEngineImpl(null, new MuscleMemoryStore());
  engRev.configure({});
  const dispatched: SandboxAction[] = [];
  engRev.wireHostExecutor({
    executeAction: async a => { dispatched.push(a); return { ok: true, note: 'faked' }; },
  });
  const revId = consolidatedEntry(engRev, [
    { kind: 'click_mouse', args: { x: 0.5, y: 0.5, target_description: 'save button' } },
  ] as SandboxAction[], undefined);
  const t2 = engRev.requestReplayToken(revId);
  const o2 = await engRev.replayOnHost(revId, { confirmToken: t2 });
  assert.equal(o2.verdict, 'confirmed', '可逆宏 + 指纹缺席 ⇒ 降级放行（诚实降级 ≠ 假装验证过）');
  assert.equal(dispatched.length, 1);
  const laneEntry = sandboxLog.list().find(e => e.kind === 'host-replay-gate'
    && e.data?.gate === 'fingerprint-degraded-reversible');
  assert.ok(laneEntry, '降级车道入链标注（fingerprint-degraded-reversible）');
  // 可靠度回写不受降级影响（可逆宏本身派发成功）
  const entry = (engRev as unknown as { memory: MuscleMemoryStore }).memory.get(revId);
  assert.equal(entry?.hostReplayCount, 1);
});

// ─── ΠΑΝ-41：双账本合一 + 指纹相似度单源 ───

test('ΠΑΝ-41a: 引擎与宏排练门禁同账本 —— 宏登记引擎可见；save 真实落盘；崩溃后恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pan41a-'));
  try {
    const musclePath = join(dir, 'muscle.json');
    const store = new MuscleMemoryStore();
    const gate = new MacroRehearsalGate(store);
    const eng = new SandboxEngineImpl(null, store);
    eng.configure({ memoryPath: musclePath }); // ΠΑΝ-41：共享账本由此武装持久化
    const v = gate.gate({
      reliability: 0,
      steps: [{ tool: 'click_mouse', args: { x: 0.2, y: 0.15 } }],
      scene: [{ label: 'btn', bbox: { x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.2 } }],
    });
    assert.equal(v.verdict, 'passed', '宏排练通过（虚拟场景产证据）');
    assert.ok(v.muscleEntryId);
    assert.ok(existsSync(musclePath), '排练通过即刻真实落盘（save 不再静默 no-op）');
    // 双账本合一：宏门禁登记在引擎的召回面直接可见（此前两个 store 互不可见）
    const seen = eng.recallMuscleMemory('macro rehearsal');
    assert.ok(seen.ok && seen.value.length >= 1, '引擎召回可见宏排练登记（同账本）');
    // 崩溃模拟：内存态归零（进程死亡等价）⇒ 新 store + 新引擎同路径恢复
    store.reset();
    assert.equal(store.size(), 0);
    const resurrected = new MuscleMemoryStore();
    const eng2 = new SandboxEngineImpl(null, resurrected);
    eng2.configure({ memoryPath: musclePath }); // configure+load 防御恢复
    const r2 = eng2.recallMuscleMemory('macro rehearsal');
    assert.ok(r2.ok && r2.value.length >= 1, '崩溃后跨会话恢复登记（此前登记仅存活于进程内存）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ΠΑΝ-41b: 缺省账本归一 —— 引擎缺省构造与共享宏门禁单例同一 MuscleMemoryStore', () => {
  const eng = new SandboxEngineImpl(null); // 缺省 = sharedMuscleMemoryStore（ΠΑΝ-41）
  eng.configure({});
  const v = sharedMacroRehearsalGate.gate({
    reliability: 0,
    steps: [{ tool: 'click_mouse', args: { x: 0.2, y: 0.15 } }],
    scene: [{ label: 'ok button', bbox: { x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.2 } }],
  });
  assert.equal(v.verdict, 'passed');
  const r = eng.recallMuscleMemory('macro rehearsal');
  assert.ok(r.ok && r.value.length >= 1, '共享门禁单例登记 ⇒ 缺省引擎立即可见（同账本）');
  // 宿主重放计数经引擎记到宏条目头上（此前 recordHostReplay 永远记不到宏条目）：
  // 私有面经结构子集视图断言（测试特权 —— 不改产品面可见性）
  const sharedView = (eng as unknown as { memory: MuscleMemoryStore }).memory;
  assert.strictEqual(sharedView, sharedMuscleMemoryStore, '引擎缺省构造持共享账本（双账本合一的构造面证据）');
});

test('ΠΑΝ-41c: 指纹相似度单源 —— 128 位等宽不再负数；不等宽前缀比对注记', () => {
  // 旧 memory.fingerprintSimilarity：等宽硬编码除数 64 ⇒ 1-128/64 = -1（负数）
  const a = '0'.repeat(128), b = '1'.repeat(128);
  assert.equal(fpSimilarity(a, b).similarity, 0, '128 位全异 ⇒ 0（不再负数）');
  assert.equal(fpSimilarity(a, a).similarity, 1);
  // 位宽演进：64 位入口 vs 128 位宿主观察（公共前缀）
  const host128 = ('01'.repeat(32)) + ('10'.repeat(32));
  const entry64 = host128.slice(0, 64);
  const cmp = fpSimilarity(entry64, host128);
  assert.equal(cmp.similarity, 1);
  assert.equal(cmp.truncatedTo, 64, '不等宽 ⇒ 前缀比对 + truncatedTo 注记');
  // 召回侧同屏加成走同一实现：128 位同屏命中加成（此前等宽才比 ⇒ 静默失配）
  const store = new MuscleMemoryStore();
  store.consolidate(
    { next: () => 'muscle-pan41c' } as never,
    'open the settings pane 128', 'chain-pan41c',
    [{ kind: 'click_mouse', args: { x: 0.5, y: 0.5 } }], a,
  );
  const hits = store.recall({ text: 'settings pane', currentSceneFingerprint: a });
  assert.ok(hits.length >= 1, '128 位同屏 ⇒ 召回命中（单源实现位宽鲁棒）');
  const hitsOff = store.recall({ text: 'settings pane', currentSceneFingerprint: b });
  assert.ok(hitsOff.length === 0 || hitsOff[0].score < hits[0].score, '异屏无加成（分维诚实）');
});

// ─── ΠΑΝ-42：步级扫描扩员 + 可靠度效果验证 ───

test('ΠΑΝ-42a: 步级扫描覆盖 hotkey —— 链中段危险热键在派发前被拦（零部分执行）', async () => {
  const eng = new SandboxEngineImpl(null, new MuscleMemoryStore());
  eng.configure({ hotkeyBlacklistCsv: 'alt+f4,meta' }); // ΠΑΝ-42：黑名单透传 ⇒ 前置扫描执法
  const dispatched: SandboxAction[] = [];
  eng.wireHostExecutor({
    executeAction: async a => { dispatched.push(a); return { ok: true, note: 'faked' }; },
  });
  const fp = '01'.repeat(32);
  const entryId = consolidatedEntry(eng, [
    { kind: 'type_text', args: { text: 'harmless preamble' } },
    { kind: 'press_hotkey', args: { keys: ['alt', 'f4'] } },
  ], fp);
  eng.noteHostObservation(fp); // 同屏（排除 4B 通道 —— 本例只证第五门）
  const token = eng.requestReplayToken(entryId);
  const out = await eng.replayOnHost(entryId, { confirmToken: token });
  assert.equal(out.verdict, 'failed', '黑名单热键步整链拒绝');
  assert.equal(dispatched.length, 0, '扫描先于派发 —— 链中段的危险步绝不产生部分执行（此前先执行第一步才被 system 层拦）');
  const gateEntry = sandboxLog.list().find(e => e.kind === 'host-replay-gate'
    && e.data?.gate === 'safety-scan');
  assert.ok(gateEntry, 'safety-scan 门禁行入链');
  assert.equal(gateEntry!.data?.stepIndex, 1, '归因首犯步 = 1（热键步）');
  assert.equal(gateEntry!.data?.reason, 'blacklisted-hotkey');
});

test('ΠΑΝ-42a: 步级扫描覆盖 drag —— 危险拖拽终点无令牌被拦（ActionKind 扩员对齐）', async () => {
  const eng = new SandboxEngineImpl(null, new MuscleMemoryStore());
  eng.configure({});
  const dispatched: SandboxAction[] = [];
  eng.wireHostExecutor({
    executeAction: async a => { dispatched.push(a); return { ok: true, note: 'faked' }; },
  });
  const fp = '01'.repeat(32);
  const entryId = consolidatedEntry(eng, [
    {
      kind: 'drag_mouse',
      args: { startX: 0.1, startY: 0.1, endX: 0.9, endY: 0.9, target_description: 'drag the file to the trash and delete the database' },
    },
  ], fp);
  eng.noteHostObservation(fp);
  const token = eng.requestReplayToken(entryId);
  const out = await eng.replayOnHost(entryId, { confirmToken: token });
  assert.equal(out.verdict, 'failed', '危险拖拽步被扫描拦截（此前 drag 不在扫描面）');
  assert.equal(dispatched.length, 0);
  const gateEntry = sandboxLog.list().find(e => e.kind === 'host-replay-gate'
    && e.data?.gate === 'safety-scan');
  assert.ok(gateEntry && gateEntry.data?.reason === 'irreversible-action', '归因审批域拒因');
});

test('ΠΑΝ-42b: 可靠度效果验证 —— refuted ⇒ diverged 且不虚增计数；缺席 ⇒ 派发基线诚实降级', async () => {
  const mkEngine = (): { eng: SandboxEngineImpl; dispatched: SandboxAction[] } => {
    const eng = new SandboxEngineImpl(null, new MuscleMemoryStore());
    eng.configure({});
    const dispatched: SandboxAction[] = [];
    return { eng, dispatched };
  };
  const fp = '01'.repeat(32);
  const steps: SandboxAction[] = [{ kind: 'click_mouse', args: { x: 0.5, y: 0.5, target_description: 'save button' } }];

  // 场景一：验证器驳回（打偏/零效果）⇒ diverged + effect-missing + 可靠度计失败
  {
    const { eng } = mkEngine();
    eng.wireHostExecutor({
      executeAction: async () => ({ ok: true, note: 'dispatched' }),
      verifyChainEffect: async () => ({ verified: false, note: 'no screen change observed' }),
    });
    const id = consolidatedEntry(eng, steps, fp);
    eng.noteHostObservation(fp);
    const out = await eng.replayOnHost(id, { confirmToken: eng.requestReplayToken(id) });
    assert.equal(out.verdict, 'diverged', '派发完成但效果驳回 ⇒ diverged（此前误 confirmed 虚增计数）');
    assert.equal(out.divergences.length, 1);
    assert.equal(out.divergences[0].kind, 'effect-missing');
    assert.ok(Math.abs(out.reliabilityAfter - 1 / 3) < 1e-9, '失败入账：可靠度 (0+1)/(1+2) = 1/3');
  }

  // 场景二：验证器确认 ⇒ confirmed（效果与派发双证）
  {
    const { eng } = mkEngine();
    eng.wireHostExecutor({
      executeAction: async () => ({ ok: true, note: 'dispatched' }),
      verifyChainEffect: async () => ({ verified: true, note: 'world-effect observed' }),
    });
    const id = consolidatedEntry(eng, steps, fp);
    eng.noteHostObservation(fp);
    const out = await eng.replayOnHost(id, { confirmToken: eng.requestReplayToken(id) });
    assert.equal(out.verdict, 'confirmed');
    assert.ok(Math.abs(out.reliabilityAfter - 2 / 3) < 1e-9);
  }

  // 场景三：验证面缺席（端口未实现）⇒ 派发基线 confirmed（诚实降级不虚报）
  {
    const { eng, dispatched } = mkEngine();
    eng.wireHostExecutor({
      executeAction: async a => { dispatched.push(a); return { ok: true, note: 'dispatched' }; },
      // verifyChainEffect 缺席 —— 旧执行器方言零回归
    });
    const id = consolidatedEntry(eng, steps, fp);
    eng.noteHostObservation(fp);
    const out = await eng.replayOnHost(id, { confirmToken: eng.requestReplayToken(id) });
    assert.equal(out.verdict, 'confirmed', '验证面缺席 ⇒ 派发基线（缺席降级，不虚报效果验证）');
    assert.equal(dispatched.length, 1);
    assert.ok(Math.abs(out.reliabilityAfter - 2 / 3) < 1e-9);
  }

  // 场景四：验证器违约抛错 ⇒ 收敛为缺席（双保险层，绝不击穿数据流）
  {
    const { eng } = mkEngine();
    eng.wireHostExecutor({
      executeAction: async () => ({ ok: true, note: 'dispatched' }),
      verifyChainEffect: async () => { throw new Error('verifier exploded'); },
    });
    const id = consolidatedEntry(eng, steps, fp);
    eng.noteHostObservation(fp);
    const out = await eng.replayOnHost(id, { confirmToken: eng.requestReplayToken(id) });
    assert.equal(out.verdict, 'confirmed', '验证器故障 ⇒ 缺席降级（绝不误杀派发事实）');
  }
});

test('ΠΑΝ-42c: muscleReliability 导出面回归 —— 计数是唯一事实源（门4A 度量任务可靠度的地基）', () => {
  assert.equal(muscleReliability({ hostSuccessCount: 0, hostReplayCount: 0 }), 0.5, 'Laplace 中性先验');
  assert.equal(muscleReliability({ hostSuccessCount: 0, hostReplayCount: 1 }), 1 / 3, '失败一次降档');
});
