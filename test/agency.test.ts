// test/agency.test.ts
// D-1 多智能体协同回归测试：IO 互斥 / 链段标记 / 协调器生命周期 / 裁决策略 /
// checkpoint v3 幂等迁移。每个用例锁死一条「一台躯体，多重心智」的工程承诺。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { serialize } from '../src/ioMutex.ts';
import { journal } from '../src/journal.ts';
import { coordinator, ConfidenceWeightedArbitrator } from '../src/subAgent.ts';
import { migrateCheckpoint } from '../src/checkpoint.ts';
import { saveCheckpoint, loadCheckpoint } from '../src/checkpoint.ts';
import { shaper, LinuxAdapter } from '../src/environmentShaper.ts';
import type { UndoRecord } from '../src/environmentShaper.ts';
import { quantum, UiExtractorWhitebox } from '../src/quantumSense.ts';
import type { WhiteboxNode, WhiteboxProvider } from '../src/quantumSense.ts';
import { setAccessibilityProvider } from '../src/uiExtractor.ts';

// ─── D-2: 环境重塑（假 probe/exec 注入，零子进程依赖） ───

/** 假适配器环境：wmctrl/xdotool/gsettings 全存在 + DISPLAY 在 */
function fakeLinuxDeps() {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let geometry: string | null = 'WINDOW=123\nX=10\nY=20\nWIDTH=800\nHEIGHT=600\nSCREEN=0\n';
  return {
    calls,
    setGeometry(g: string | null) { geometry = g; },
    deps: {
      probe: (cmd: string) => ['wmctrl', 'xdotool', 'gsettings'].includes(cmd),
      exec: async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        if (cmd === 'xdotool' && args[0] === 'search') return { stdout: '123\n' };
        if (cmd === 'xdotool' && args[0] === 'getwindowgeometry') {
          if (geometry === null) throw new Error('no window');
          return { stdout: geometry };
        }
        if (cmd === 'gsettings' && args[0] === 'get') return { stdout: "'Yaru-dark'\n" };
        return { stdout: '' };
      },
      env: { DISPLAY: ':0' },
    } as ConstructorParameters<typeof LinuxAdapter>[0],
  };
}

beforeEach(() => {
  shaper.clearUndoLog();
  shaper.configure(false, false);
  quantum.reset();
});

// ─── D-3: 量子感知（黑白盒叠加态） ───

function fakeProvider(nodes: WhiteboxNode[], ready = true): WhiteboxProvider {
  return { name: 'fake-box', isReady: () => ready, extract: async () => nodes };
}

test('D-3: 状态机 —— 3 连败降级叠加态，SENSE_SHIFT 入链，2 连胜出院', async () => {
  quantum.configure(3, 2, 30);
  quantum.setProvider(fakeProvider([{ rect: { x: 0, y: 0, width: 10, height: 10 }, label: 'btn' }]));
  quantum.recordEffect(false);
  quantum.recordEffect(false);
  assert.equal(quantum.mode(), 'black_box', '2 败未达阈值');
  quantum.recordEffect(false);
  assert.equal(quantum.mode(), 'superposition', '3 败达阈值且源就绪');
  await new Promise(r => setImmediate(r));
  assert.ok(journal.list(false).some(e => e.tool === 'SENSE_SHIFT'), '跃迁必须入因果链');
  assert.equal(journal.verify().ok, true, '标记入链不断链');
  // 急救成功出院：1 胜未达，2 胜回归
  quantum.recordEffect(true);
  assert.equal(quantum.mode(), 'superposition');
  quantum.recordEffect(true);
  assert.equal(quantum.mode(), 'black_box', '2 连胜回归纯视觉');
});

test('D-3: recordEffect(undefined) 直通 —— 无验证证据不计数（调用方契约锁）', () => {
  quantum.configure(3, 2, 30);
  quantum.setProvider(fakeProvider([]));
  for (let i = 0; i < 10; i++) quantum.recordEffect(undefined);
  assert.equal(quantum.mode(), 'black_box');
  assert.equal(quantum.status().failStreak, 0);
  assert.equal(quantum.status().degradeBlocked, 0);
  // 混合序列：败-undefined-败-undefined-败 ⇒ 仍按 3 次有效证据计
  quantum.recordEffect(false);
  quantum.recordEffect(undefined);
  quantum.recordEffect(false);
  quantum.recordEffect(undefined);
  quantum.recordEffect(false);
  assert.equal(quantum.mode(), 'superposition', 'undefined 不得稀释硬证据');
});

test('D-3: 无源不降级 —— 想自救但没有眼镜，degradeBlocked 诚实可见', () => {
  quantum.configure(3, 2, 30);
  quantum.setProvider(fakeProvider([], false)); // isReady = false
  for (let i = 0; i < 5; i++) quantum.recordEffect(false);
  assert.equal(quantum.mode(), 'black_box', '绝不假装进入叠加态');
  assert.equal(quantum.status().degradeBlocked, 3, '第 3/4/5 败各暴露一次受阻');
});

test('D-3: 未 configure ⇒ 一切入口 no-op（单一关闭路径 = enableQuantumSense=false）', () => {
  quantum.setProvider(fakeProvider([])); // 有源但未 configure
  for (let i = 0; i < 10; i++) quantum.recordEffect(false);
  assert.equal(quantum.mode(), 'black_box');
  assert.equal(quantum.status().degradeBlocked, 0, '未启用的状态机不得留痕');
});

test('D-3: configure 钳制 —— degradeAfter<=0 视为 1（不存在第二条关闭语义）', () => {
  quantum.configure(0, 0, 0);
  quantum.setProvider(fakeProvider([]));
  quantum.recordEffect(false);
  assert.equal(quantum.mode(), 'superposition', '单败即降级');
  quantum.recordEffect(true);
  assert.equal(quantum.mode(), 'black_box', '单胜即出院');
});

test('D-3: overlayNodes —— 去重（IoU/包含）、预算裁剪、label 截断', async () => {
  quantum.configure(1, 2, 2); // 单败降级 + maxNodes = 2
  const longLabel = 'a-very-long-structured-sense-label-over-twenty-chars';
  const nodes: WhiteboxNode[] = [
    { rect: { x: 0, y: 0, width: 100, height: 50 }, label: 'dup-of-existing' },   // 与 existing 全重合
    { rect: { x: 20, y: 10, width: 200, height: 100 }, label: 'contains-existing' }, // 中心包含 existing(50,25)
    { rect: { x: 0, y: 200, width: 40, height: 40 }, label: longLabel },          // 唯一新节点 + 超长 label
    { rect: { x: 100, y: 400, width: 40, height: 40 }, label: 'another' },        // 唯一新节点
    { rect: { x: 600, y: 600, width: 40, height: 40 }, label: 'over-budget' },    // 超预算被裁
  ];
  quantum.setProvider(fakeProvider(nodes));
  // 强制进入叠加态
  quantum.recordEffect(false);
  const existing = [{ rect: { x: 0, y: 0, width: 100, height: 50 } }];
  const out = await quantum.overlayNodes(existing);
  assert.equal(out.length, 2, '预算 2 硬顶');
  assert.deepEqual(out.map(o => o.label), [`${longLabel.slice(0, 20)}…`, 'another']);
  assert.deepEqual(out.map(o => o.tag), [1, 2], 'episode 内单调递增编号');
});

test('D-3: overlayNodes 守卫 —— 黑盒态返回 []；extract 故障返回 []（不毒化管线）', async () => {
  quantum.configure(1, 2, 30);
  quantum.setProvider(fakeProvider([{ rect: { x: 0, y: 0, width: 5, height: 5 }, label: 'x' }]));
  assert.deepEqual(await quantum.overlayNodes([]), [], '黑盒态零标注');
  quantum.recordEffect(false); // 单败阈值 ⇒ 进入叠加态
  const broken = { name: 'broken', isReady: () => true, extract: async () => { throw new Error('boom'); } };
  quantum.setProvider(broken);
  assert.deepEqual(await quantum.overlayNodes([]), [], '白盒故障诚实空集');
});

test('D-3: dump/restore —— 感知相位跨崩溃存活 + 防御性恢复', () => {
  quantum.configure(3, 2, 30);
  quantum.setProvider(fakeProvider([])); // 有源方可降级
  quantum.recordEffect(false); quantum.recordEffect(false); quantum.recordEffect(false);
  const snap = quantum.dump();
  assert.equal(snap.mode, 'superposition');
  quantum.reset();
  quantum.configure(3, 2, 30);
  quantum.restore(snap);
  assert.equal(quantum.mode(), 'superposition', '急救未完不中断');
  quantum.restore(undefined);           // 旧档无 section：no-op
  quantum.restore({ mode: 'bogus' } as any); // 坏档：拒绝
  assert.equal(quantum.mode(), 'superposition');
});

test('D-3: UiExtractorWhitebox —— 通道复用白盒适配器（isReady/extract/降级）', async () => {
  const adapter = new UiExtractorWhitebox();
  setAccessibilityProvider(null as any);
  assert.equal(adapter.isReady(), false);
  assert.deepEqual(await adapter.extract(), [], 'provider 缺失 ⇒ 诚实空集');
  // 注入假无障碍树：button 命中可交互角色，heading 不命中
  setAccessibilityProvider(async () => ({
    children: [
      { role: 'button', name: 'Submit', rect: { x: 1, y: 2, width: 30, height: 10 } },
      { role: 'heading', name: 'Title', rect: { x: 0, y: 0, width: 500, height: 40 } },
    ],
  }));
  assert.equal(adapter.isReady(), true);
  const nodes = await adapter.extract();
  assert.equal(nodes.length, 1, '只映射可交互角色');
  assert.equal(nodes[0].label, 'Submit');
  setAccessibilityProvider(null as any); // 还原全局态，不泄漏给后续测试
});

test('D-2: LinuxAdapter 能力探测 —— wmctrl+DISPLAY ⇒ 窗口三动作+缩放+对比度', async () => {
  const f = fakeLinuxDeps();
  const adapter = new LinuxAdapter(f.deps);
  const caps = await adapter.capabilities();
  assert.deepEqual(new Set(caps), new Set(['raise_window', 'maximize_window', 'move_window', 'set_zoom', 'set_contrast']));
});

test('D-2: 能力探测诚实性 —— 无 DISPLAY ⇒ 空能力集（本沙箱的真实形态）', async () => {
  const adapter = new LinuxAdapter({
    probe: () => true, env: {}, // 工具全在但无图形会话
  });
  assert.equal((await adapter.capabilities()).size, 0);
});

test('D-2: initialize 永不抛错 —— 探测链异常 ⇒ 空能力集继续', async () => {
  const adapter = new LinuxAdapter({
    probe: () => { throw new Error('probe exploded'); },
    env: { DISPLAY: ':0' },
  });
  const caps = await adapter.capabilities();
  assert.equal(caps.size, 0); // 探测失败被吞为诚实空集（不抛错毒化启动）
});

test('D-2: apply/undo 往返 —— maximize 捕获几何快照并 LIFO 复原', async () => {
  const f = fakeLinuxDeps();
  // 直接测适配器层：shaper 单例已绑定真实探测（沙箱空能力），适配器才是单元UnderTest
  const adapter = new LinuxAdapter(f.deps);
  const recipe = await adapter.apply({ kind: 'maximize_window', titleHint: 'Chrome' });
  // recipe.kind 恒等于原始动作 kind（审查修正 #1 的回归锁）
  assert.equal(recipe.kind, 'maximize_window');
  assert.deepEqual(recipe.before, { x: 10, y: 20, width: 800, height: 600, maximized: false });
  await adapter.undo(recipe);
  // 复原序列：激活 → 去最大化标记 → 归位几何（三步都留痕）
  const undoCalls = f.calls.slice(-3).map(c => `${c.cmd} ${c.args.join(' ')}`).join(' | ');
  assert.ok(undoCalls.includes('remove,maximized_vert,maximized_horz'), '必须去除最大化标记');
  assert.ok(undoCalls.includes('0,10,20,800,600'), '必须按快照归位几何');
});

test('D-2: undo 降级 —— 几何不可读时止步于去标记（诚实记录）', async () => {
  const f = fakeLinuxDeps();
  f.setGeometry(null); // xdotool 查询失败
  const adapter = new LinuxAdapter(f.deps);
  const recipe = await adapter.apply({ kind: 'maximize_window', titleHint: 'X' });
  assert.equal(recipe.before, undefined); // 快照缺失如实为空
  await adapter.undo(recipe);
  const lastTwo = f.calls.slice(-2).map(c => c.args.join(' ')).join(' | ');
  assert.ok(lastTwo.includes('remove,maximized_vert,maximized_horz'));
  assert.ok(!lastTwo.includes('0,undefined'), '无快照不得拼出垃圾几何');
});

test('D-2: shaper 单例（沙箱形态）—— 空能力集 ⇒ apply 诚实拒绝并指路 capabilities', async () => {
  // 本沙箱无 wmctrl/xdotool/DISPLAY：真实探测 ⇒ 空能力集 ⇒ 每次拒绝都带可操作指引。
  // set_contrast 的作用域闸门在能力闸门之后（沙箱形态下先被能力拒绝 —— 顺序即安全层级）。
  await shaper.initialize();
  assert.equal(shaper.capabilities().size, 0);
  const r = await shaper.apply({ kind: 'raise_window', titleHint: 'X' });
  assert.equal(r.ok, false);
  assert.ok(r.reason!.includes('unavailable'), '空能力必须给出可读原因');
  assert.ok(r.reason!.includes('capabilities'), '拒绝信息必须指路 capabilities');
  // 窗口级动作缺 titleHint：能力拒绝在前，故 titleHint 校验不可达（顺序由测试锁死）
  const contrast = await shaper.apply({ kind: 'set_contrast' });
  assert.equal(contrast.ok, false);
});

test('D-2: dryRun —— 诚实拒绝而非假装成功（无变更即无复原义务）', async () => {
  shaper.configure(false, true); // dryRun on
  await shaper.initialize();
  const r = await shaper.apply({ kind: 'set_zoom', level: 125 });
  assert.equal(r.ok, false);
  assert.ok(r.reason!.includes('dry-run'));
  assert.equal(shaper.undoDepth(), 0, '拒绝路径不得产生撤销义务');
});

test('D-2: restoreUndoLog 防御性恢复 —— 坏条目跳过，令牌序列不撞', () => {
  const rec: UndoRecord = {
    token: 'undo-1', action: { kind: 'raise_window', titleHint: 'X' },
    recipe: { kind: 'raise_window', titleHint: 'X' }, undone: false,
  };
  shaper.restoreUndoLog([rec, null as any, { token: 'bad' } as any]);
  assert.equal(shaper.undoDepth(), 1);
  assert.equal(shaper.dumpUndoLog().length, 1);
  shaper.restoreUndoLog(undefined); // v1/v2 旧档无此 section：no-op
  assert.equal(shaper.dumpUndoLog().length, 1);
});

test('D-2: applyPreset —— 预设链解析与伪步骤拒绝', async () => {
  await shaper.initialize();
  const results = await shaper.applyPreset('raise,maximize,bogus_step', 'Chrome');
  assert.equal(results.length, 3);
  assert.ok(results.every(r => !r.ok), '沙箱空能力：全部诚实拒绝');
  assert.ok(results[2].reason!.includes('unknown preset step'));
  const empty = await shaper.applyPreset('', 'X');
  assert.equal(empty[0].ok, false);
});

// ─── D-1: IO 互斥（物理躯体公理） ───

test('D-1: serialize —— 并发动作按到达序串行执行', async () => {
  const order: number[] = [];
  const job = (n: number, ms: number) => () =>
    new Promise<void>(res => setTimeout(() => { order.push(n); res(); }, ms));
  // 后发快任务不得插队先发慢任务 —— 量子坍缩为队列
  await Promise.all([serialize(job(1, 30)), serialize(job(2, 5)), serialize(job(3, 1))]);
  assert.deepEqual(order, [1, 2, 3]);
});

test('D-1: serialize —— 单失败不毒化队列（后续调用照常）', async () => {
  await assert.rejects(serialize(async () => { throw new Error('boom'); }));
  const v = await serialize(async () => 42);
  assert.equal(v, 42);
});

// ─── D-1: 链段标记 ───

beforeEach(() => {
  journal.reset();
  coordinator.reset();
  coordinator.configure(3, 10);
});

test('D-1: appendMarker —— 入链防篡改且零污染动作流', async () => {
  await journal.append({ ts: 1, tool: 'click_mouse', args: { x: 0.5 }, status: 'SUCCESS' });
  await journal.appendMarker({ kind: 'AGENT_BEGIN', taskId: 'scout-1', role: '调研员', objective: '查定价' });
  await journal.append({ ts: 2, tool: 'type_text', args: { text: 'hi' }, status: 'SUCCESS' });

  // 链完整：标记与动作同链，verify 全绿
  assert.equal(journal.verify().ok, true);
  // 零污染：动作流（重放/归纳/结晶的事实源）不含标记
  assert.ok(journal.list(true).every(e => e.tool !== 'AGENT_BEGIN'));
  // 全量审计可见：标记留在因果时间轴上
  assert.ok(journal.list(false).some(e => e.tool === 'AGENT_BEGIN'));
});

test('D-1: 代理生命周期标记成对入链', async () => {
  coordinator.spawn([{ id: 'scout-1', role: 'r', objective: 'o', maxSteps: 5 }]);
  coordinator.report('scout-1', 'findings', 0.9);
  await new Promise(r => setImmediate(r)); // 标记 fire-and-forget 落链
  const tools = journal.list(false).map(e => e.tool);
  assert.ok(tools.includes('AGENT_BEGIN') && tools.includes('AGENT_END'));
  assert.equal(journal.verify().ok, true);
});

// ─── D-1: 协调器生命周期 ───

test('D-1: spawn 满员拒绝 + 同号去重', () => {
  const spawned = coordinator.spawn([
    { id: 'a1', role: 'A', objective: 'o1', maxSteps: 5 },
    { id: 'a2', role: 'B', objective: 'o2', maxSteps: 5 },
    { id: 'a1', role: 'A-dup', objective: 'dup', maxSteps: 5 }, // 同号去重
    { id: 'a3', role: 'C', objective: 'o3', maxSteps: 5 },
    { id: 'a4', role: 'D', objective: 'o4', maxSteps: 5 }, // 超额（max=3）
  ]);
  assert.equal(spawned.length, 3);
  assert.deepEqual(spawned.map(s => s.spec.id), ['a1', 'a2', 'a3']);
});

test('D-1: chargeStep —— 动作记账、非动作直通、预算信号', () => {
  coordinator.spawn([{ id: 'w1', role: 'r', objective: 'o', maxSteps: 2 }]);
  assert.equal(coordinator.current()?.spec.id, 'w1');
  coordinator.chargeStep('click_mouse');
  assert.equal(coordinator.current()?.stepsUsed, 1);
  coordinator.chargeStep('take_screenshot'); // 观察类不计步
  assert.equal(coordinator.current()?.stepsUsed, 1);
  coordinator.chargeStep('type_text');
  assert.equal(coordinator.current()?.status, 'working');
  const over = coordinator.chargeStep('scroll_page');
  assert.equal(over, true, '步数达预算应返回超限信号');
});

test('D-1: report 轮转 —— 报告后切到下一角色，全员报告后 current 为空', () => {
  coordinator.spawn([
    { id: 's1', role: 'A', objective: 'o', maxSteps: 5 },
    { id: 's2', role: 'B', objective: 'o', maxSteps: 5 },
  ]);
  const next = coordinator.report('s1', 'A 的结论', 0.9);
  assert.equal(next?.spec.id, 's2');
  // 重复报告同一代理：幂等忽略
  const still = coordinator.report('s1', '重复报告', 0.1);
  assert.equal(still?.spec.id, 's2');
  coordinator.report('s2', 'B 的结论', 0.8);
  assert.equal(coordinator.current(), null, '全员已报告');
});

// ─── D-1: 裁决策略 ───

test('D-1: arbitrate —— 未全员报告返回 null', async () => {
  coordinator.spawn([
    { id: 'x1', role: 'A', objective: 'o', maxSteps: 5 },
    { id: 'x2', role: 'B', objective: 'o', maxSteps: 5 },
  ]);
  coordinator.report('x1', '结论一', 0.9);
  assert.equal(await coordinator.arbitrate(), null);
});

test('D-1: arbitrate —— 语义一致判 consensus', async () => {
  coordinator.spawn([
    { id: 'c1', role: 'A', objective: 'o', maxSteps: 5 },
    { id: 'c2', role: 'B', objective: 'o', maxSteps: 5 },
  ]);
  coordinator.report('c1', '竞品 A 定价 10 美元每月，功能包含数据筛选', 0.9);
  coordinator.report('c2', '竞品 A 定价 10 美元每月，支持筛选和导出数据', 0.8);
  const arb = await coordinator.arbitrate();
  assert.equal(arb!.verdict, 'consensus');
  assert.equal(arb!.crossValidation.length, 1);
  assert.ok(arb!.crossValidation[0].agreement > 0.5);
});

test('D-1: arbitrate —— 语义分歧判 conflict 并给出胜者', async () => {
  coordinator.spawn([
    { id: 'f1', role: 'A', objective: 'o', maxSteps: 5 },
    { id: 'f2', role: 'B', objective: 'o', maxSteps: 5 },
  ]);
  coordinator.report('f1', '打开浏览器导航到新闻网站浏览头条', 0.9);
  coordinator.report('f2', '在 Excel 中筛选数据并保存报表', 0.6);
  const arb = await coordinator.arbitrate();
  assert.equal(arb!.verdict, 'conflict');
  assert.ok(arb!.winner === 'f1' || arb!.winner === 'f2');
  assert.ok(arb!.rationale.length > 0, '裁决归因必须透明');
});

test('D-1: 策略模式 —— 自定义策略可热插拔', async () => {
  const custom = {
    name: 'always-consensus',
    async arbitrate() {
      return { verdict: 'consensus' as const, crossValidation: [], rationale: 'custom' };
    },
  };
  coordinator.spawn([{ id: 'p1', role: 'A', objective: 'o', maxSteps: 5 }]);
  coordinator.report('p1', '结论', 0.5);
  const arb = await coordinator.arbitrate(custom);
  assert.equal(arb!.rationale, 'custom');
});

test('D-1: 缺省裁决器 —— 空报告与单报告的诚实降级', async () => {
  const s = new ConfidenceWeightedArbitrator();
  const none = await s.arbitrate([]);
  assert.equal(none.verdict, 'best_single');
  const single = await s.arbitrate([{ taskId: 't', status: 'completed', findings: 'x', confidence: 1, stepsUsed: 1 }]);
  assert.equal(single.verdict, 'best_single');
  assert.equal(single.winner, 't');
});

// ─── D-1: checkpoint v3 幂等迁移 ───

test('D-1: migrateCheckpoint —— v1/v2 → v3 归一，重复执行幂等', () => {
  const v2 = {
    version: 2, savedAt: 1,
    uiMemory: [], skillLibrary: [], failureMemory: [],
    journal: { entries: [], chainTip: 'GENESIS', chainBase: 'GENESIS' },
    telemetry: {},
  };
  const m1 = migrateCheckpoint(v2)!;
  assert.equal(m1.version, 3);
  assert.deepEqual(m1.swarmAgents, []);
  // 幂等性：对迁移结果再迁移，结构不变（可重复执行不报错）
  const m2 = migrateCheckpoint(m1)!;
  assert.deepEqual(m2, m1);
  const m3 = migrateCheckpoint(m2)!;
  assert.deepEqual(m3, m1);
  // v3 原样透传
  const v3 = migrateCheckpoint({ ...m1, savedAt: 99 })!;
  assert.equal(v3.savedAt, 99);
  // 未知版本拒绝
  assert.equal(migrateCheckpoint({ version: 99 }), null);
  assert.equal(migrateCheckpoint(null), null);
});

test('D-1: checkpoint 往返 —— 团队状态无损复活', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cp-v3-'));
  const file = path.join(dir, 'cp.json');
  try {
    coordinator.spawn([
      { id: 'r1', role: 'A', objective: 'o', maxSteps: 5 },
      { id: 'r2', role: 'B', objective: 'o', maxSteps: 5 },
    ]);
    coordinator.report('r1', '报告一：定价 10 元', 0.9);
    await new Promise(r => setImmediate(r)); // 标记落链
    assert.equal(saveCheckpoint(file).ok, true);

    coordinator.reset();
    assert.equal(coordinator.roster().length, 0);
    const res = loadCheckpoint(file);
    assert.equal(res.restored, true);
    // 团队原地满血：花名册 + 已有报告复活，未完成代理继续轮转
    assert.equal(coordinator.roster().length, 2);
    assert.equal(coordinator.current()?.spec.id, 'r2');
    assert.equal(coordinator.roster().find(a => a.spec.id === 'r1')?.report?.findings, '报告一：定价 10 元');
    // 恢复后链仍可续（v3 语义与 B-1 一致）
    assert.equal(journal.verify().ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
