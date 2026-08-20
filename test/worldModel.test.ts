// test/worldModel.test.ts
// 预测编码纪元回归测试：世界模型（屏幕类型学 + 接口动力学 + 惊讶计费器）。
// 每个用例对应预测处理理论的一条铁律 —— 熟悉的世界用便宜眼睛，意外的世界才付费。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryWorldModel, transitionActionKey } from '../src/knowledge/worldModel.ts';
import { KnowledgePipelineOrchestrator } from '../src/knowledge/pipeline.ts';
import { InMemoryKnowledgeBase } from '../src/knowledge/knowledgeBase.ts';
import { DoctorVerdictBridge } from '../src/knowledge/adapters.ts';
import type {
  AtomicAction, PipelineConfig, ScenePatch,
} from '../src/knowledge/contracts.ts';

/** 场景夹具：单全屏分区 + 指定元素（名称 + 归一化左上角） */
function scene(els: Array<[string, number, number]>): ScenePatch[] {
  return [{
    region: { id: 'g0x0', x: 0, y: 0, width: 1, height: 1 },
    elements: els.map(([name, x, y]) => ({
      source: 'L1-tree' as const, role: 'button', name,
      rect: { x, y, width: 0.08, height: 0.04 },
    })),
    funnelDepth: 'L1' as const,
    capturedAt: 0,
  }];
}

const SAVE_DIALOG = scene([['OK', 0.4, 0.7], ['Cancel', 0.6, 0.7]]);
const MENU_BAR = scene([['File', 0.1, 0.05], ['Edit', 0.25, 0.05], ['View', 0.4, 0.05]]);
const TOOLBAR = scene([['Share', 0.9, 0.05], ['Print', 0.95, 0.05]]);

// ─── 屏幕类型学：视觉皮层的物体识别 ───

test('类型学 #1：同构屏同型（微扰/加按钮泛化）+ 异构屏分型', () => {
  const wm = new InMemoryWorldModel();
  const t1 = wm.typeOf(SAVE_DIALOG);
  assert.ok(t1);
  // 微扰（坐标亚网格抖动）：同一保存框
  assert.equal(wm.typeOf(scene([['OK', 0.41, 0.69], ['Cancel', 0.58, 0.71]])), t1);
  // 加一个按钮的保存框仍是保存框（语义签名泛化 —— 老员工不会因多了个按钮就不认识）
  assert.equal(wm.typeOf(scene([['OK', 0.4, 0.7], ['Cancel', 0.6, 0.7], ['Dont save', 0.5, 0.8]])), t1);
  // 异构界面分型
  const t2 = wm.typeOf(MENU_BAR);
  const t3 = wm.typeOf(TOOLBAR);
  assert.ok(t2 && t3 && t1 !== t2 && t2 !== t3 && t1 !== t3);
  assert.equal(wm.stats().types, 3);
});

test('类型学 #2：看不见 ⇒ null（绝不铸造幽灵类型）', () => {
  const wm = new InMemoryWorldModel();
  assert.equal(wm.typeOf([]), null);
  assert.equal(wm.typeOf(undefined as unknown as ScenePatch[]), null);
  // fault 补丁（零元素）同律：「看不见」是 fault 不是真空屏
  assert.equal(wm.typeOf([{
    region: { id: 'g0x0', x: 0, y: 0, width: 1, height: 1 },
    elements: [], funnelDepth: 'empty' as const,
    fault: { source: 'L1' as const, detail: 'blind' }, capturedAt: 0,
  }]), null);
});

// ─── 接口动力学：海马体的认知地图 ───

test('动力学 #1：3× A→B ⇒ 预测 B@1.0 + 成功率 2/3；无历史 ⇒ null（诚实的无知）', () => {
  const wm = new InMemoryWorldModel();
  const a = wm.typeOf(SAVE_DIALOG)!;
  const b = wm.typeOf(MENU_BAR)!;
  assert.ok(wm.observe(a, 'click_mouse@22', b, true).ok);
  assert.ok(wm.observe(a, 'click_mouse@22', b, true).ok);
  assert.ok(wm.observe(a, 'click_mouse@22', b, false).ok);

  const p = wm.predict(a, 'click_mouse@22');
  assert.ok(p.ok && p.value);
  assert.equal(p.value.nextTypes.length, 1);
  assert.equal(p.value.nextTypes[0].typeId, b);
  assert.ok(Math.abs(p.value.nextTypes[0].prob - 1) < 1e-9);
  assert.equal(p.value.evidence, 3);
  assert.ok(Math.abs(p.value.successProb - 2 / 3) < 0.001);

  const cold = wm.predict(b, 'click_mouse@22');
  assert.ok(cold.ok && cold.value === null, '无证据 ⇒ 无预测（不是均匀分布的伪装）');
});

test('动力学 #2：异常诚实 —— 域外拒绝（Result，绝不 throw）', () => {
  const wm = new InMemoryWorldModel();
  assert.ok(!wm.observe('', 'act', 'screen-1', true).ok);
  assert.ok(!wm.observe('screen-1', 'act', '', true).ok);
  assert.ok(!wm.observe('screen-1', 'act', 'screen-2', 'yes' as unknown as boolean).ok);
  assert.ok(!wm.predict('', 'act').ok);
  assert.ok(!wm.surprise('screen-1', 'act', '').ok);
  // 合法输入零伤
  assert.ok(wm.observe('screen-1', 'act', 'screen-2', true).ok);
});

// ─── 惊讶计费器：多巴胺能预测误差信号 ───

test('惊讶 #1：无历史 ⇒ novel；熟悉转移 ⇒ 低 bits；未见目的地 ⇒ novel + ≥3 bits', () => {
  const wm = new InMemoryWorldModel();
  const a = wm.typeOf(SAVE_DIALOG)!;
  const b = wm.typeOf(MENU_BAR)!;
  const c = wm.typeOf(TOOLBAR)!;

  // 冷启动：从未见过任何转移 —— 一切都是新闻
  const cold = wm.surprise(a, 'click_mouse@22', b);
  assert.ok(cold.ok && cold.value.novel && cold.value.evidence === 0);

  for (let i = 0; i < 3; i++) wm.observe(a, 'click_mouse@22', b, true);
  // 熟悉转移：p = 3.5/4 = 0.875 ⇒ bits ≈ 0.19（平静）
  const warm = wm.surprise(a, 'click_mouse@22', b);
  assert.ok(warm.ok && !warm.value.novel);
  assert.ok(warm.value.bits < 1, `熟悉转移 bits=${warm.value.bits} 应 < 1`);
  // 未见目的地：p = 0.5/4 = 0.125 ⇒ bits = 3.0（正好达 L3 升级线）
  const shock = wm.surprise(a, 'click_mouse@22', c);
  assert.ok(shock.ok && shock.value.novel);
  assert.ok(shock.value.bits >= 3, `未见目的地 bits=${shock.value.bits} 应 ≥3（L3 阈值）`);
});

test('惊讶 #2：证据经济学 —— 反例重演后 bits 如实上升（概率坍缩可度量）', () => {
  const wm = new InMemoryWorldModel();
  const a = wm.typeOf(SAVE_DIALOG)!;
  const b = wm.typeOf(MENU_BAR)!;
  const c = wm.typeOf(TOOLBAR)!;
  // 9 次去 B，1 次去 C：C 是熟悉的小概率事件（非 novel）
  for (let i = 0; i < 9; i++) wm.observe(a, 'click_mouse@22', b, true);
  wm.observe(a, 'click_mouse@22', c, true);
  const rare = wm.surprise(a, 'click_mouse@22', c);
  assert.ok(rare.ok && !rare.value.novel, '见过一次 ⇒ 不再是 novel');
  // p = (1+0.5)/(10+0.5×3) = 0.13 ⇒ bits ≈ 2.94 —— 边缘事件如实定价
  assert.ok(rare.value.bits > 2 && rare.value.bits < 3.5, `实际 ${rare.value.bits}`);
});

test('动作键方言：指针动作量化到区域，无坐标动作用 kind', () => {
  assert.equal(transitionActionKey({ kind: 'click_mouse', args: { x: 0.5, y: 0.5 }, rationale: '' }), 'click_mouse@22');
  assert.equal(transitionActionKey({ kind: 'click_mouse', args: { x: 0.05, y: 0.95 }, rationale: '' }), 'click_mouse@03');
  // 域外钳制：坐标越界钳回 [0,1]（执行方言的防御性归一）
  assert.equal(transitionActionKey({ kind: 'click_mouse', args: { x: 1.4, y: -0.2 }, rationale: '' }), 'click_mouse@30');
  assert.equal(transitionActionKey({ kind: 'type_text', args: { text: 'hi' }, rationale: '' }), 'type_text');
  assert.equal(transitionActionKey({ kind: 'noop', args: {}, rationale: '' }), 'noop');
});

// ─── 流水线惊讶计费器：L3 花钱权由预测误差授予（端到端执法）───

const WM_CONFIG: PipelineConfig = {
  regionGrid: { cols: 1, rows: 1 },
  timeout: { overall: 5000, perStep: 1000, perPerception: 500 },
  retryPolicy: { maxRetries: 2, backoffMs: 1, maxBackoffMs: 4 },
  knowledgeTimeout: 50, knowledgeMaxResults: 5, knowledgeMaxChars: 300,
};

/** 可编程假工位：视觉记录每轮 forceL3 并按剧本出场景；执行恒失败驱动重试循环 */
function predictiveStations(scenes: ScenePatch[][], maxRetries: number) {
  const forceL3Log: boolean[] = [];
  let round = 0;
  const click: AtomicAction = { kind: 'click_mouse', args: { x: 0.5, y: 0.5 }, rationale: 'stub' };
  return {
    forceL3Log,
    deps: {
      vision: {
        async perceive(env: any): Promise<ScenePatch[]> {
          forceL3Log.push(!!env.payload.forceL3);
          const s = scenes[Math.min(round, scenes.length - 1)];
          round += 1;
          return s;
        },
      },
      decision: {
        async decide(): Promise<AtomicAction> { return click; },
      },
      execution: {
        async execute(env: any) {
          return {
            action: env.payload as AtomicAction, status: 'failure' as const, durationMs: 1,
            failure: { kind: 'host-error' as const, detail: 'programmed' },
          };
        },
      },
      knowledge: new InMemoryKnowledgeBase(),
      verdictBridge: new DoctorVerdictBridge(),
      emit: () => { /* 旁路 */ },
    },
    config: { ...WM_CONFIG, retryPolicy: { maxRetries, backoffMs: 1, maxBackoffMs: 4 } },
  };
}

test('计费器 #1：意外到达（保存框→菜单栏）⇒ 下轮感知 forceL3=true', async () => {
  const wm = new InMemoryWorldModel();
  const rig = predictiveStations([SAVE_DIALOG, MENU_BAR, MENU_BAR], 2);
  const o = new KnowledgePipelineOrchestrator();
  o.configure(rig.config);
  o.wire({ ...rig.deps, worldModel: wm });
  const report = await o.run({ id: 'i-esc', description: 'open settings' });
  assert.equal(report.verdict, 'failed'); // 重试耗尽（三次失败）—— 计费器观测窗
  // r1 冷启动 false；r2 感知时转移未结算仍 false；r3 携带 r2 的 novel 惊讶 ⇒ true
  assert.deepEqual(rig.forceL3Log, [false, false, true],
    `实际 ${JSON.stringify(rig.forceL3Log)}`);
  // 世界模型入账：2 次转移结算（r2、r3），2 个屏幕类型
  assert.equal(wm.stats().observations, 2);
  assert.equal(wm.stats().types, 2);
});

test('计费器 #2：熟悉的世界回到便宜眼睛 —— 惊讶平息即降级', async () => {
  const wm = new InMemoryWorldModel();
  // 恒定场景：每次点击都停在原地（保存框）—— 首见是新闻，再见是常态
  const rig = predictiveStations([SAVE_DIALOG, SAVE_DIALOG, SAVE_DIALOG, SAVE_DIALOG], 3);
  const o = new KnowledgePipelineOrchestrator();
  o.configure(rig.config);
  o.wire({ ...rig.deps, worldModel: wm });
  const report = await o.run({ id: 'i-calm', description: 'open settings' });
  assert.equal(report.verdict, 'failed'); // 四次失败（1+3 重试）—— 完整观测窗
  // r1 冷启动 false；r2 首见「点击后原地」是 novel（无任何转移史）—— 但升级只
  // 能作用于下一轮感知 ⇒ r3 用贵眼睛 true；r3 结算 p=0.75、bits≈0.42（平静）
  // ⇒ r4 降回 false —— 计费闭环双向执法：升级看意外，平息回便宜
  assert.deepEqual(rig.forceL3Log, [false, false, true, false],
    `实际 ${JSON.stringify(rig.forceL3Log)}`);
});
