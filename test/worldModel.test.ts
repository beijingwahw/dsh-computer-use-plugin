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

// ─── ΝΩ-15：世界模型聚类的在线化升级（碎片化治理）───
// 旧疾：质心冻结于铸造时刻 ⇒ 布局渐变时相似度跌破 0.62 ⇒ 分铸碎片 ⇒
// 转移表按 fromType|action 稀释、predict 证据摊薄、novel 率虚高。
// 修法三件套：在线质心吸收（α=1/members）+ 近邻合并（cosine ≥ 0.85）+
// 软量化签名（WM-2 跨格线脆性）。

/** ΝΩ-15 行夹具：4 个短名元素整列 —— 位置质量占比高，渐变可测 */
function rowScene(x: number): ScenePatch[] {
  return scene([['A', x, 0.2], ['B', x, 0.4], ['C', x, 0.6], ['D', x, 0.8]]);
}

/** ΝΩ-15 有机碎片化剧本：row(0.10)/row(0.55) 互不相似（cos≈0.53）分铸两型，
 *  中间布局反复出现（双端渐变）⇒ 双质心相向漂移至 cos≈0.87 —— 碎片化现场。
 *  返回 [近端 id, 远端 id]（远端 = 后铸的 screen-2，members 少 ⇒ 被收拢方）。 */
function fragmentByDrift(wm: InMemoryWorldModel): [string, string] {
  const nearId = wm.typeOf(rowScene(0.10))!;
  const farId = wm.typeOf(rowScene(0.55))!;
  assert.notEqual(nearId, farId, '两端布局不相似 ⇒ 分铸（碎片化现场）');
  for (let pass = 0; pass < 6; pass++) {
    for (let i = 0; i <= 7; i++) wm.typeOf(rowScene(+(0.15 + i * 0.05).toFixed(2)));
  }
  return [nearId, farId];
}

test('ΝΩ-15 在线质心：渐变序列不铸新类型（质心吸收后仍命中）', () => {
  const wm = new InMemoryWorldModel();
  const id = wm.typeOf(rowScene(0.10))!;
  // 整列右移 0.10→0.55（跨多条格线与格中点）：每步被当前质心吸收，
  // 质心随布局漂移 —— 全程同型（冻结质心在同剧本下 5 次分铸，探针实测）
  for (let i = 1; i <= 9; i++) {
    const x = +(0.10 + i * 0.05).toFixed(2);
    assert.equal(wm.typeOf(rowScene(x)), id, `渐变步 x=${x} 仍命中同型`);
  }
  assert.equal(wm.stats().types, 1, '零分铸');
  assert.equal(wm.exportSnapshot().types[0].members, 10, '会员计数 = 观察次数');
  // 异构屏照常分型（吸收不灭分辨力）
  assert.notEqual(wm.typeOf(MENU_BAR), id);
  assert.equal(wm.stats().types, 2);
});

test('ΝΩ-15 软量化（WM-2）：跨格线移动签名严格保留，跨格中点部分保留', () => {
  // 格线 x=0.25：OK 中心 0.249→0.251，主/邻格恰好互换 —— 签名集合不变
  const left = [['OK', 0.209, 0.7], ['Cancel', 0.6, 0.7]] as Array<[string, number, number]>;
  const right = [['OK', 0.211, 0.7], ['Cancel', 0.6, 0.7]] as Array<[string, number, number]>;
  const wm1 = new InMemoryWorldModel();
  const idL = wm1.typeOf(scene(left))!;
  assert.equal(wm1.typeOf(scene(right)), idL, '跨格线微移（约 4px）仍同型');
  // 独立模型铸右侧：两侧签名集合严格相等（集合语义 —— 脆性闭合的直接证据）
  const wm2 = new InMemoryWorldModel();
  wm2.typeOf(scene(right));
  const tokL = wm1.exportSnapshot().types[0].tokens.slice().sort();
  const tokR = wm2.exportSnapshot().types[0].tokens.slice().sort();
  assert.deepEqual(tokL, tokR, '跨格线：主/邻格互换 ⇒ 签名集合严格相等');
  // 跨格中点（x=0.375）：翻一枚 token —— 部分保留（同型但签名已变）
  const mid = [['OK', 0.336, 0.7], ['Cancel', 0.6, 0.7]] as Array<[string, number, number]>;
  assert.equal(wm1.typeOf(scene(mid)), idL, '跨中点移动仍同型（部分保留兜底）');
  const wm3 = new InMemoryWorldModel();
  wm3.typeOf(scene(mid));
  const tokM = wm3.exportSnapshot().types[0].tokens.slice().sort();
  const shared = tokL.filter(t => tokM.includes(t));
  assert.ok(shared.length > 0 && shared.length < tokL.length,
    `部分保留：共享 ${shared.length}/${tokL.length} 枚 token`);
});

test('ΝΩ-15 mergeSimilarTypes：碎片收拢 —— 计数守恒 + alias 透明', () => {
  const wm = new InMemoryWorldModel();
  const [nearId, farId] = fragmentByDrift(wm);
  // 转移账本：双向 + next 侧同时涉及两型（合并最复杂的面）
  assert.ok(wm.observe(nearId, 'act', farId, true).ok);
  assert.ok(wm.observe(nearId, 'act', farId, true).ok);
  assert.ok(wm.observe(farId, 'act', nearId, false).ok);
  assert.ok(wm.observe(nearId, 'act2', nearId, true).ok);
  const before = wm.exportSnapshot();
  const beforeMembers = before.types.reduce((s, t) => s + t.members, 0);
  const beforeObs = wm.stats().observations;

  const r = wm.mergeSimilarTypes();
  assert.deepEqual(r.merged, [{ from: farId, into: nearId }], '远端（证据少）并入近端（证据多）');
  assert.equal(wm.stats().types, 1, '碎片收拢为一型');
  assert.equal(wm.stats().observations, beforeObs, '转移总质量守恒');
  const after = wm.exportSnapshot();
  assert.equal(after.types.reduce((s, t) => s + t.members, 0), beforeMembers, '会员计数守恒（相加）');
  assert.deepEqual(after.aliases, [[farId, nearId]], 'alias 留档');

  // 同 actionKey 的 next 分布加权合并：act 三笔（两笔 near→far + 一笔 far→near）
  // 全部改道幸存 id；act2 不受扰
  const act = after.transitions.find(t => t.action === 'act')!;
  assert.equal(act.from, nearId);
  assert.equal(act.total, 3);
  assert.deepEqual(act.next, [[nearId, 3]]);
  const act2 = after.transitions.find(t => t.action === 'act2')!;
  assert.equal(act2.total, 1);
  assert.deepEqual(act2.next, [[nearId, 1]]);

  // alias 查询透明：旧 id 的 predict/surprise/observe 与幸存 id 完全等价
  assert.deepEqual(wm.predict(farId, 'act'), wm.predict(nearId, 'act'));
  assert.deepEqual(wm.surprise(farId, 'act', nearId), wm.surprise(nearId, 'act', nearId));
  assert.ok(wm.observe(farId, 'act', nearId, true).ok);
  assert.equal(wm.exportSnapshot().transitions.find(t => t.action === 'act')!.total, 4,
    '旧 id 入账透明改道幸存键');
  // typeOf 产出恒为幸存 id（收拢后的两端布局都命中漂移质心）
  assert.equal(wm.typeOf(rowScene(0.30)), nearId);
  assert.equal(wm.typeOf(rowScene(0.55)), nearId);
  // 负例：不相似对绝不合并（收拢有口径，不是大杂烩）
  wm.typeOf(MENU_BAR);
  assert.equal(wm.mergeSimilarTypes().merged.length, 0, 'cos < 0.85 不合并');
});

test('ΝΩ-15 fork/merge 次序 A：维护在先 ⇒ 重放按 alias 改写，碎片不复活', () => {
  const root = new InMemoryWorldModel();
  const [nearId, farId] = fragmentByDrift(root);
  // run 内 fork：继承两型，观察远端布局 + 双向转移
  const f = root.fork();
  assert.equal(f.typeOf(rowScene(0.55)), farId, 'fork 继承指认（member op）');
  f.observe(farId, 'act', nearId, true);
  f.observe(nearId, 'act', farId, true);
  // 维护在 merge() 重放之先：farId 收拢进 nearId
  assert.equal(root.mergeSimilarTypes().merged.length, 1);
  const before = root.exportSnapshot();
  const membersBefore = before.types.reduce((s, t) => s + t.members, 0);
  assert.equal(root.stats().observations, 0);

  root.merge(f);
  const after = root.exportSnapshot();
  assert.equal(root.stats().types, 1, '重放不复活已收拢碎片');
  assert.ok(!after.types.some(t => t.id === farId), '被合并 id 不回册');
  assert.equal(root.stats().observations, 2, '重放观察守恒');
  assert.equal(after.types.reduce((s, t) => s + t.members, 0), membersBefore + 1,
    'fork 的 member op 计入幸存者（含质心吸收）');
  // 转移按 alias 改道：两笔观察同落幸存键，next 全指幸存 id
  const act = after.transitions.find(t => t.action === 'act')!;
  assert.equal(act.from, nearId);
  assert.equal(act.total, 2);
  assert.deepEqual(act.next, [[nearId, 2]]);
});

test('ΝΩ-15 fork/merge 次序 B：重放在先 ⇒ 下一幕收拢，终态与次序 A 等价', () => {
  /** 同剧本跑两种次序，返回可比较的终态摘要 */
  const run = (maintenanceFirst: boolean) => {
    const root = new InMemoryWorldModel();
    const [nearId, farId] = fragmentByDrift(root);
    const f = root.fork();
    f.typeOf(rowScene(0.55));
    f.observe(farId, 'act', nearId, true);
    f.observe(nearId, 'act', farId, true);
    if (maintenanceFirst) {
      root.mergeSimilarTypes();
      root.merge(f);
    } else {
      root.merge(f); // 重放在先：farId 侧 +1 会员、转移按原 id 落地
      root.mergeSimilarTypes(); // 维护在后：按当刻余弦收拢
    }
    const snap = root.exportSnapshot();
    return {
      types: root.stats().types,
      observations: root.stats().observations,
      members: snap.types.reduce((s, t) => s + t.members, 0),
      act: snap.transitions.find(t => t.action === 'act'),
      aliasOk: JSON.stringify(root.predict(farId, 'act')) === JSON.stringify(root.predict(nearId, 'act')),
      nearId,
    };
  };
  const orderA = run(true);
  const orderB = run(false);
  // 两种次序的确定性语义：计数守恒同果、分布同形、alias 透明同律
  assert.equal(orderB.types, 1);
  assert.deepEqual(orderB.act, orderA.act, '转移分布逐项等价（total/next 同形）');
  assert.equal(orderB.observations, orderA.observations);
  assert.equal(orderB.members, orderA.members, '会员总数等价（fork 的观察不因次序丢失/重复）');
  assert.ok(orderB.aliasOk && orderA.aliasOk);
  assert.equal(orderB.act!.from, orderB.nearId);
  assert.deepEqual(orderB.act!.next, [[orderB.nearId, 2]]);
});

test('ΝΩ-15 fork/merge：维护已收拢的号，fork 后铸的同号类型不复活碎片', () => {
  const root = new InMemoryWorldModel();
  const nearId = root.typeOf(rowScene(0.10))!; // screen-1（root 计数器=1）
  // 两个 fork 都在 root 只有 screen-1 时分出（各自计数器=1 ⇒ 都会铸 screen-2）
  const f1 = root.fork();
  const f2 = root.fork();
  const f1Id = f1.typeOf(rowScene(0.55))!; // 同布局 —— 与 root 后铸的 screen-2 同型
  assert.equal(f1Id, 'screen-2');
  const f2Id = f2.typeOf(MENU_BAR)!; // 无关内容 —— 也占了 screen-2 号
  assert.equal(f2Id, 'screen-2');
  // root 并发自己也铸 screen-2（row55），随后渐变漂移 + 维护收拢
  const rootFarId = root.typeOf(rowScene(0.55))!;
  assert.equal(rootFarId, 'screen-2');
  for (let pass = 0; pass < 6; pass++) {
    for (let i = 0; i <= 7; i++) root.typeOf(rowScene(+(0.15 + i * 0.05).toFixed(2)));
  }
  assert.deepEqual(root.mergeSimilarTypes().merged, [{ from: 'screen-2', into: nearId }]);

  // f1 的铸造（screen-2，同型异号）：降级为幸存者的会员吸收 —— 不复活
  const membersBefore = root.exportSnapshot().types[0].members;
  root.merge(f1);
  const snap1 = root.exportSnapshot();
  assert.equal(root.stats().types, 1, '同型异号铸造不复活碎片');
  assert.ok(!snap1.types.some(t => t.id === 'screen-2'));
  assert.equal(snap1.types[0].members, membersBefore + 1, '降级为会员吸收');

  // f2 的铸造（screen-2 号，无关内容）：与幸存者不相似 ⇒ 重铸新号，绝不
  // 污染幸存者向量、绝不复活别名 id
  root.merge(f2);
  const snap2 = root.exportSnapshot();
  assert.equal(root.stats().types, 2, '无关内容另立新型');
  assert.ok(!snap2.types.some(t => t.id === 'screen-2'), '别名占用的 id 不复活为类型');
  const newType = snap2.types.find(t => t.id !== nearId)!;
  assert.equal(newType.id, 'screen-3', '按父计数器重铸新号');
  assert.ok(newType.tokens.some(t => t.startsWith('File@')), '新号承载 MENU 内容');
});

test('ΝΩ-15 快照往返：漂移质心与 alias 表无损水合；旧档（无新字段）兼容', () => {
  const wm = new InMemoryWorldModel();
  const [nearId, farId] = fragmentByDrift(wm);
  wm.observe(nearId, 'act', farId, true);
  assert.equal(wm.mergeSimilarTypes().merged.length, 1);

  const snap = JSON.parse(JSON.stringify(wm.exportSnapshot())); // 真实 JSON 往返（磁盘同构）
  const reborn = new InMemoryWorldModel();
  assert.ok(reborn.restoreSnapshot(snap).ok);
  assert.deepEqual(reborn.exportSnapshot().aliases, [[farId, nearId]], 'alias 表往返');
  // 漂移质心往返存活：若 vec 丢失（由铸造 tokens 重铸）则 row(0.30) 必分铸
  assert.equal(reborn.typeOf(rowScene(0.30)), nearId, '质心漂移不因落盘遗忘');
  assert.deepEqual(reborn.predict(farId, 'act'), reborn.predict(nearId, 'act'), '旧 id 透明');

  // 旧档兼容：无 vec / 无 aliases 字段 ⇒ 空表 + tokens 重铸（诚实降级）
  const legacy = {
    version: 1,
    types: (snap.types as Array<Record<string, unknown>>).map(t => ({
      id: t.id, tokens: t.tokens, members: t.members,
    })),
    transitions: snap.transitions,
    typeCounter: snap.typeCounter,
  };
  const rebornLegacy = new InMemoryWorldModel();
  assert.ok(rebornLegacy.restoreSnapshot(legacy).ok, '旧档（ΝΩ-15 前格式）可水合');
  assert.equal(rebornLegacy.stats().types, 1);
  assert.notEqual(rebornLegacy.typeOf(rowScene(0.55)), nearId,
    '质心重铸自铸造签名 ⇒ 漂移历史不虚构（vec 字段是承重墙的证据）');

  // 非法新字段 ⇒ 整体拒绝（异常诚实，绝不半水合）
  const reject = (s: unknown, why: string) =>
    assert.ok(!(new InMemoryWorldModel()).restoreSnapshot(s).ok, why);
  reject({ ...legacy, aliases: [['screen-9', 'screen-404']] }, 'alias 链悬空');
  reject({ ...legacy, aliases: [[nearId, 'screen-1']] }, 'alias source 是活类型');
  reject({ ...legacy, aliases: [['a', 'b'], ['b', 'a']] }, 'alias 环');
  reject({
    ...legacy,
    types: [{ id: 'screen-1', tokens: ['OK@22'], members: 1, vec: { dims: [[5, 1], [5, 1]], norm: 1 } }],
    transitions: [], aliases: [],
  }, 'vec 桶号重复（cosine 双指针前提破坏）');
  reject({
    ...legacy,
    types: [{ id: 'screen-1', tokens: ['OK@22'], members: 1, vec: { dims: [[9, 1], [5, 1]], norm: 1 } }],
    transitions: [], aliases: [],
  }, 'vec 桶号乱序');
});
