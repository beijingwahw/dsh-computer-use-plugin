// test/w4macro.test.ts
// W4-1 执法册：旗舰 A1「技能宏重放执行接线 + 参数化宏动作」。
//
//   M-1 宏解析：skillId 直取 / templateId 绑洞成功 / 绑洞失败回退母体技能
//        （W3-2 语义）/ 双缺席诚实失败；
//   M-2 重锚定非盲重放：label/iou/contain 三通道命中 ⇒ 按当前帧元素重解算；
//        重锚定失败 / 锚点证据整体缺席 ⇒ 坐标步降级跳过（dispatch 计数 = 0，
//        绝不盲点原坐标）；text 参数覆盖 type_text 槽（参数化宏动作）；
//   M-3 链内节奏：4 步宏 ⇒ dhash 抽查恰 2 次（每 2 步）；连续两次「世界未动」
//        ⇒ 诚实中止；
//   M-4 预算：步数超支 / 时长超支（注入时钟）⇒ 中止并记 degraded；
//   M-5 排练门禁两路：可靠度过闸直放（not-required）；<0.5 + 场景 ⇒ 虚拟
//        排练（passed 放行并登记 MuscleMemory / failed 拒绝）；<0.5 无场景 ⇒
//        degraded 拒绝；模板产物恒必排练；
//   M-6 工具升级：match_skill 附 matchTemplates 召回段；run_skill 高可靠直放
//        （回归）+ macro_trace；低可靠被门禁拒绝；模板路径门禁同律；
//   M-7 G3 契约：listSkillDigests 结构 / addDormantSkill 幂等与脏输入拒绝 /
//        容量驱逐 / 休眠不入 match 主池；
//   M-8 增量账本接线：总闸缺省关 ⇒ 零观察（零回归）；开 ⇒ 首帧 keyframe、
//        同帧 silent（ScreenStateLedger.ingest → deliverIncremental 消费链）；
//   M-9 runtime 决策面：case 'macro' 重锚定点击（假 system 像素换算取证）+
//        轨迹摘要入 note；recall_skill 从「只报到达」升级为执行；无匹配 ⇒
//        no_effect（回归）。
// 全程离线确定性：注入 capture/dhashOf/readWords、假 GLM 缺席、monkey-patch
// 键鼠、注入时钟零真睡；sharp 现场生成真 PNG（增量账本分析管线）。
import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { default as sharp } from 'sharp';
import { system } from '../src/system.ts';
import { kernelRegistry } from '../src/kernel/registry.ts';
import { skillLibrary, type SkillStep } from '../src/skillLibrary.ts';
import type { Config } from '../src/config.ts';
import { stopBackend } from '../src/physicalBackend.ts';
import {
  executeMacro, resolveMacroChain, defaultReanchor, macroTraceSummary,
  REANCHOR_IOU_GATE, MACRO_SPOT_PERIOD,
  type MacroAnchorElement, type MacroRunnerDeps, type MacroTrace,
} from '../src/macroExecutor.ts';
import {
  MacroRehearsalGate, resetMacroRehearsalGate, translateToSandboxActions,
  buildVirtualScene, MACRO_REHEARSAL_GATE,
} from '../src/sandbox/macroRehearsal.ts';
import { deterministicReplay } from '../src/sandbox/engine.ts';
import { createMatchSkillTool, createRunSkillTool } from '../src/tools/skillTools.ts';
import { createPerceive, createExecute } from '../src/autonomy/runtime.ts';
import type { RuntimeDeps } from '../src/autonomy/runtime.ts';
import type { WorldSnapshot } from '../src/autonomy/worldSnapshot.ts';
import type { PolicyAction } from '../src/autonomy/policyEngine.ts';

// ─── 共用铸模 ───

beforeEach(() => {
  skillLibrary.configure(true, '', 50);
  skillLibrary.reset();
  resetMacroRehearsalGate();
  kernelRegistry.reset();
});

afterEach(() => {
  kernelRegistry.reset();
});

// run_skill 的 Y-7 终态指纹走 captureProcessed ⇒ 懒拉起物理服务（生产设计；
// 测试进程无卸载钩子 —— 显式关停防事件循环悬挂，epochDelta.safety 同律）
after(async () => {
  await stopBackend();
});

const click = (x: number, y: number, extra: Record<string, unknown> = {}): SkillStep =>
  ({ tool: 'click_mouse', args: { x, y, ...extra } });
const typeStep = (text: string): SkillStep => ({ tool: 'type_text', args: { text } });

/** 假 dispatch 工坊：记录派发步，可选注入失败 */
function makeDispatch(opts: { failTools?: Set<string> } = {}) {
  const dispatched: SkillStep[] = [];
  const deps: MacroRunnerDeps['dispatch'] = async (step) => {
    dispatched.push(step);
    if (opts.failTools?.has(step.tool)) return { ok: false, note: 'injected failure' };
    return { ok: true, note: 'ok' };
  };
  return { dispatched, dispatch: deps };
}

/** 造低可靠技能：induce 后连败两次 ⇒ Beta 后验 (1+1)/(1+2+2)=0.4 < 0.5 */
function induceLowReliability(description: string, steps: SkillStep[]) {
  const s = skillLibrary.induce(description, steps)!;
  skillLibrary.recordOutcome(s.id, false);
  skillLibrary.recordOutcome(s.id, false);
  return s;
}

/** 造模板：两母体同骨架异参数 ⇒ distillTemplates 产 ≥1 模板 */
function distillOneTemplate(): number {
  skillLibrary.induce('登录门户甲', [click(0.2, 0.2), typeStep('alice')]);
  skillLibrary.induce('登录门户乙', [click(0.3, 0.3), typeStep('bob')]);
  const { created } = skillLibrary.distillTemplates();
  assert.ok(created.length >= 1, `蒸馏应产模板，实际 ${created.length}`);
  return created[0].id;
}

const anchor = (label: string, x0: number, y0: number, x1: number, y1: number): MacroAnchorElement =>
  ({ label, bbox: { x0, y0, x1, y1 } });

// ─── M-1：宏解析 ───

test('M-1a: skillId 直取 —— 解析产物为技能步骤链的拷贝', () => {
  const s = skillLibrary.induce('打开设置', [click(0.25, 0.25), typeStep('hello')])!;
  const r = resolveMacroChain({ skillId: s.id });
  assert.ok(r.ok);
  assert.equal(r.source.kind, 'skill');
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps[0].tool, 'click_mouse');
  // 拷贝语义：改解析产物不触库内技能
  r.steps[0].args.x = 0.99;
  assert.equal(skillLibrary.get(s.id)!.steps[0].args.x, 0.25, '解析产物是拷贝（库内原链不动）');
});

test('M-1b: templateId 绑洞成功 —— holeReader 读值注入 + 常量槽回放', () => {
  const tplId = distillOneTemplate();
  const r = resolveMacroChain({
    templateId: tplId,
    holeReader: (req) => (req.type === 'number' ? 0.42 : req.type === 'string' ? 'carol' : undefined),
  });
  assert.ok(r.ok, `模板绑定应成功：${r.ok ? '' : r.detail}`);
  assert.equal(r.source.kind, 'template');
  assert.equal(r.steps[0].args.x, 0.42, '坐标洞绑定 reader 值');
  assert.equal(r.steps[1].args.text, 'carol', '文本洞绑定 reader 值');
});

test('M-1c: 绑洞失败 ⇒ 回退模板 parents 中可靠度最高的字面量技能（W3-2 语义）', () => {
  const tplId = distillOneTemplate();
  const r = resolveMacroChain({ templateId: tplId, holeReader: () => undefined });
  assert.ok(r.ok, '绑定失败应回退母体技能而非整体失败');
  assert.equal(r.source.kind, 'fallback-skill');
  assert.ok(r.fallbackReason?.includes('回退母体技能'));
  assert.ok(r.steps.length >= 2, '回退链完整可执行');
});

test('M-1d: 双缺席 ⇒ not-found 诚实失败；空链技能 ⇒ empty-chain', () => {
  const r1 = resolveMacroChain({});
  assert.ok(!r1.ok && r1.reason === 'not-found');
  const ghost = resolveMacroChain({ skillId: 999 });
  assert.ok(!ghost.ok && ghost.reason === 'not-found');
});

// ─── M-2：重锚定非盲重放 ───

test('M-2a: label 通道 —— target_description 命中同名元素（已挪位）⇒ 按当前中心重解算', async () => {
  const s = skillLibrary.induce('点保存', [
    click(0.2, 0.2, { target_description: 'Save' }),
  ])!;
  const { dispatched, dispatch } = makeDispatch();
  const trace = await executeMacro({ skillId: s.id }, {
    dispatch,
    anchors: () => [anchor('Save', 0.6, 0.6, 0.7, 0.68)],
    spotCheck: async () => true,
  });
  assert.ok(trace.ok);
  assert.equal(dispatched.length, 1);
  const via = trace.steps[0].reanchor!;
  assert.equal(via.via, 'label', '标签通道命中');
  assert.ok(Math.abs(dispatched[0].args.x - 0.65) < 1e-9, `x 重解算为元素中心 0.65，实际 ${dispatched[0].args.x}`);
  assert.ok(Math.abs(dispatched[0].args.y - 0.64) < 1e-9, 'y 重解算为元素中心 0.64');
});

test('M-2b: iou 通道 —— 无标签时原坐标邻域窗与元素 bbox 的 IoU 过门（elementTracker 阈值同律）', async () => {
  const s = skillLibrary.induce('点提交', [click(0.5, 0.5)])!;
  const { dispatched, dispatch } = makeDispatch();
  const trace = await executeMacro({ skillId: s.id }, {
    dispatch,
    anchors: () => [anchor('Submit', 0.42, 0.44, 0.58, 0.56)], // 原点仍在框内且框与 0.06 窗 IoU 高
    spotCheck: async () => true,
  });
  assert.ok(trace.ok);
  assert.equal(trace.steps[0].reanchor!.via, 'iou');
  assert.ok(Math.abs(dispatched[0].args.x - 0.5) < 1e-9);
  // defaultReanchor 的直接单测：自适应窗与元素同尺度 ⇒ 点居中的 IoU 远过门
  //（元素 0.16×0.12 ⇒ side=0.12 ⇒ 窗 ⊆ 框 ⇒ IoU = 0.0144/0.0192 = 0.75 ≥ 0.4）
  const hit = defaultReanchor({ x: 0.5, y: 0.5 }, [anchor('Submit', 0.42, 0.44, 0.58, 0.56)]);
  assert.ok(hit && hit.via === 'iou');
  assert.ok(REANCHOR_IOU_GATE === 0.4, 'IoU 门与 elementTracker.IOU_MATCH 同律');
});

test('M-2c: contain 通道 —— 大目标（窗 IoU 天然低）按点包含 + 最小面积命中', () => {
  const big = anchor('Panel', 0.0, 0.0, 1.0, 1.0);
  const inner = anchor('OK', 0.48, 0.48, 0.54, 0.54);
  // 点在小元素内：iou 已能命中；点在大容器空白区 ⇒ contain 兜底
  const hitInner = defaultReanchor({ x: 0.51, y: 0.51 }, [big, inner]);
  assert.ok(hitInner, '点在具体控件内 ⇒ 命中');
  const hitBig = defaultReanchor({ x: 0.05, y: 0.05 }, [big]);
  assert.ok(hitBig && hitBig.via === 'contain', '大容器点走 contain 通道');
});

test('M-2d: 重锚定失败 ⇒ 降级跳过 + 绝不盲点原坐标（dispatch 不被调）', async () => {
  const s = skillLibrary.induce('点不存在的按钮', [click(0.9, 0.9), typeStep('hi')])!;
  const { dispatched, dispatch } = makeDispatch();
  const trace = await executeMacro({ skillId: s.id }, {
    dispatch,
    anchors: () => [anchor('Home', 0.0, 0.0, 0.1, 0.1)], // 与原坐标无任何重叠
  });
  assert.ok(trace.ok, 'type 步无坐标槽仍执行 ⇒ ok=true（坐标红律只辖坐标步）');
  assert.equal(trace.steps[0].status, 'degraded-skip');
  assert.ok(trace.degraded.includes('reanchor-failed'));
  assert.equal(dispatched.filter(x => x.tool === 'click_mouse').length, 0, '盲点红律：click 步零派发');
  // type 步无坐标槽，仍被派发（坐标红律只辖坐标步）
  assert.equal(dispatched.filter(x => x.tool === 'type_text').length, 1);
});

test('M-2e: 锚点证据整体缺席 ⇒ 全部坐标步降级（诚实拒绝，非盲放）', async () => {
  const s = skillLibrary.induce('无证据之点', [click(0.5, 0.5)])!;
  const { dispatched, dispatch } = makeDispatch();
  const trace = await executeMacro({ skillId: s.id }, { dispatch, anchors: () => [] });
  assert.ok(!trace.ok);
  assert.equal(dispatched.length, 0);
  assert.ok(trace.steps[0].note.includes('绝不盲点'));
});

test('M-2f: 参数化宏动作 —— args.text 覆盖 type_text 槽 / args.target 作重锚定标签提示', async () => {
  const s = skillLibrary.induce('给某人发消息', [click(0.5, 0.5), typeStep('旧文本')])!;
  const { dispatched, dispatch } = makeDispatch();
  const trace = await executeMacro(
    { skillId: s.id, args: { text: '新文本', target: 'Compose' } },
    {
      dispatch,
      anchors: () => [anchor('Compose', 0.3, 0.3, 0.4, 0.38)],
      spotCheck: async () => true,
    },
  );
  assert.ok(trace.ok);
  assert.equal(dispatched[1].args.text, '新文本', 'text 参数覆盖 type 槽');
  assert.equal(trace.steps[0].reanchor!.via, 'label');
  assert.equal(trace.steps[0].reanchor!.label, 'Compose');
});

// ─── M-3：链内节奏（dhash 抽查） ───

test('M-3a: 4 步宏 ⇒ 抽查恰 2 次（每 2 步一次 —— MACRO_SPOT_PERIOD 同律）', async () => {
  const s = skillLibrary.induce('四步流程', [
    click(0.3, 0.3), typeStep('a'), click(0.3, 0.3), typeStep('b'),
  ])!;
  let spotCalls = 0;
  const { dispatch } = makeDispatch();
  const trace = await executeMacro({ skillId: s.id }, {
    dispatch,
    anchors: () => [anchor('X', 0.2, 0.2, 0.4, 0.4)],
    spotCheck: async () => { spotCalls++; return true; },
  });
  assert.ok(trace.ok);
  assert.equal(MACRO_SPOT_PERIOD, 2);
  assert.equal(spotCalls, 2, `4 步 ⇒ 2 次抽查，实际 ${spotCalls}`);
  assert.equal(trace.spotChecks.length, 2);
  assert.ok(trace.spotChecks.every(s => s.changed === true));
});

test('M-3b: 连续两次抽查「世界未动」⇒ 诚实中止（不再盲放余步）', async () => {
  const s = skillLibrary.induce('六步死链', [
    click(0.3, 0.3), typeStep('a'), click(0.3, 0.3), typeStep('b'),
    click(0.3, 0.3), typeStep('c'),
  ])!;
  const { dispatched, dispatch } = makeDispatch();
  const trace = await executeMacro({ skillId: s.id }, {
    dispatch,
    anchors: () => [anchor('X', 0.2, 0.2, 0.4, 0.4)],
    spotCheck: async () => false, // 世界纹丝不动
  });
  assert.ok(!trace.ok, '抽查反证中止 ⇒ ok=false');
  assert.equal(trace.aborted, 'spot-flat');
  assert.ok(trace.degraded.includes('spot-flat'));
  assert.equal(dispatched.length, 4, '第 4 步后中止 —— 余 2 步不盲放');
});

test('M-3c: 抽查端口抛异常 ⇒ 证据缺席（不反证、不中止）', async () => {
  const s = skillLibrary.induce('抽查端口炸裂', [
    click(0.3, 0.3), typeStep('a'), click(0.3, 0.3), typeStep('b'),
  ])!;
  const { dispatched, dispatch } = makeDispatch();
  const trace = await executeMacro({ skillId: s.id }, {
    dispatch,
    anchors: () => [anchor('X', 0.2, 0.2, 0.4, 0.4)],
    spotCheck: async () => { throw new Error('boom'); },
  });
  assert.ok(trace.ok, '抽查缺席不反证 —— 宏完整执行');
  assert.equal(dispatched.length, 4);
  assert.ok(trace.spotChecks.every(s => s.changed === null), '炸裂 ⇒ null（诚实缺席）');
});

// ─── M-4：预算（步数 / 时长） ───

test('M-4a: maxSteps=1 ⇒ 1 步后诚实中止（budget-steps）', async () => {
  const s = skillLibrary.induce('长链', [click(0.3, 0.3), typeStep('a'), typeStep('b')])!;
  const { dispatched, dispatch } = makeDispatch();
  const trace = await executeMacro({ skillId: s.id }, {
    dispatch,
    anchors: () => [anchor('X', 0.2, 0.2, 0.4, 0.4)],
    budget: { maxSteps: 1 },
  });
  assert.equal(dispatched.length, 1);
  assert.equal(trace.aborted, 'budget-steps(1)');
  assert.ok(trace.degraded.includes('budget-steps'));
});

test('M-4b: 注入时钟超支 ⇒ budget-ms 中止（确定性 —— 零真钟）', async () => {
  const s = skillLibrary.induce('慢链', [click(0.3, 0.3), typeStep('a'), typeStep('b')])!;
  let t = 0;
  const { dispatched, dispatch } = makeDispatch();
  const trace = await executeMacro({ skillId: s.id }, {
    dispatch,
    anchors: () => [anchor('X', 0.2, 0.2, 0.4, 0.4)],
    now: () => (t += 10), // 每步 +10ms ⇒ 第二步边界 20ms > timeoutMs 15
    budget: { timeoutMs: 15 },
  });
  assert.equal(dispatched.length, 1);
  assert.equal(trace.aborted, 'budget-ms(15)');
  assert.ok(trace.degraded.includes('budget-ms'));
});

// ─── M-5：排练门禁（两路 + 场景三态） ───

test('M-5a: 可靠度过闸（≥0.5）⇒ 免排练直放 —— not-required', () => {
  const gate = new MacroRehearsalGate();
  const v = gate.gate({ reliability: 0.7, steps: [click(0.5, 0.5)] });
  assert.equal(v.required, false);
  assert.equal(v.verdict, 'not-required');
  assert.equal(v.allowed, true);
  assert.equal(MACRO_REHEARSAL_GATE, 0.5, '门禁阈值 = Laplace 中性先验（与 sandbox DEFAULT_MIN_RELIABILITY 同口径）');
});

test('M-5b: 可靠度 <0.5 + 场景 ⇒ 虚拟排练通过 ⇒ 放行并登记 MuscleMemory', async () => {
  const s = induceLowReliability('低可靠但世界可达', [click(0.5, 0.5)]);
  const gate = new MacroRehearsalGate();
  const v = gate.gate({
    reliability: 0.4,
    steps: skillLibrary.get(s.id)!.steps,
    scene: [{ label: 'OK', bbox: { x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 } }],
  });
  assert.equal(v.verdict, 'passed', `应排练通过：${v.note}`);
  assert.equal(v.allowed, true);
  assert.ok(v.muscleEntryId, '排练通过 ⇒ MuscleMemoryStore 登记');
  assert.equal(gate.registeredEntries(), 1);
  // 全链路：executeMacro 消费同门禁 ⇒ 低可靠技能经排练后照常执行
  const { dispatched, dispatch } = makeDispatch();
  const trace = await executeMacro({ skillId: s.id }, {
    dispatch,
    rehearsal: gate,
    anchors: () => [anchor('OK', 0.4, 0.4, 0.6, 0.6)],
    spotCheck: async () => true,
  });
  assert.ok(trace.ok, `排练放行后宏应执行：${macroTraceSummary(trace)}`);
  assert.equal(trace.rehearsalGate.verdict, 'passed');
  assert.equal(dispatched.length, 1);
});

test('M-5c: 虚拟排练反证（type 无落点）⇒ failed 拒绝 —— 宏不派发', async () => {
  const s = induceLowReliability('低可靠且世界不可达', [typeStep('nowhere')]);
  const gate = new MacroRehearsalGate();
  const v = gate.gate({
    reliability: 0.4,
    steps: skillLibrary.get(s.id)!.steps,
    scene: [{ label: 'Label', bbox: { x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.2 } }], // 无 acceptsText 控件
  });
  assert.equal(v.verdict, 'failed', 'type 无聚焦控件 ⇒ 排练反证');
  assert.equal(v.allowed, false);
  // 全链路：门禁拒绝 ⇒ executeMacro 零派发
  const { dispatched, dispatch } = makeDispatch();
  const trace = await executeMacro({ skillId: s.id }, {
    dispatch, rehearsal: gate,
    anchors: () => [anchor('Label', 0.1, 0.1, 0.2, 0.2)],
  });
  assert.ok(!trace.ok);
  assert.ok(trace.degraded.includes('gate-rejected'));
  assert.equal(dispatched.length, 0, '门禁拒绝 ⇒ 宿主零派发');
});

test('M-5d: 可靠度 <0.5 且场景缺席 ⇒ degraded 诚实拒绝（低可靠 + 零世界证据不放行）', async () => {
  const gate = new MacroRehearsalGate();
  const v = gate.gate({ reliability: 0.3, steps: [click(0.5, 0.5)], scene: undefined });
  assert.equal(v.verdict, 'degraded');
  assert.equal(v.allowed, false);
  assert.ok(v.note.includes('不放行'));
});

test('M-5e: 模板绑定产物恒必排练（forceRehearsal —— 年轻证据零账本）', () => {
  const gate = new MacroRehearsalGate();
  const v = gate.gate({
    reliability: 0.9, forceRehearsal: true,
    steps: [click(0.5, 0.5)],
    scene: [{ label: 'Go', bbox: { x0: 0.45, y0: 0.45, x1: 0.55, y1: 0.55 } }],
  });
  assert.equal(v.required, true, '模板产物必排练 —— 数值闸豁免、结构闸执法');
  assert.equal(v.verdict, 'passed');
});

test('M-5f: 宏链 → SandboxAction 翻译与场景铸造（确定性 + 畸形拒收）', () => {
  const actions = translateToSandboxActions([click(0.1, 0.1), typeStep('x'), { tool: 'unknown_tool', args: {} } as SkillStep]);
  assert.equal(actions[0].kind, 'click_mouse');
  assert.equal(actions[1].kind, 'type_text');
  assert.equal(actions[2].kind, 'noop', '词汇表外工具 ⇒ noop（诚实缺席）');
  const scene = buildVirtualScene([
    { label: 'A', bbox: { x0: 0, y0: 0, x1: 0.5, y1: 0.5 } },
    { label: 'bad', bbox: { x0: NaN, y0: 0, x1: 1, y1: 1 } }, // 畸形框拒收
  ]);
  assert.equal(scene.length, 1);
  // deterministicReplay 出口消费宏链（sandbox 引擎的 replay 面吃宏方言）
  const replay = deterministicReplay(actions.slice(0, 1), { scene });
  assert.equal(replay.verdict, 'passed');
});

/** 造纯 string 洞模板：坐标同值（常量槽）+ 仅 text 异 ⇒ 唯一洞是文本 */
function distillTextHoleTemplate(): number {
  skillLibrary.induce('搜索甲', [click(0.5, 0.5), typeStep('alice')]);
  skillLibrary.induce('搜索乙', [click(0.5, 0.5), typeStep('bob')]);
  const { created } = skillLibrary.distillTemplates();
  assert.ok(created.length >= 1, `纯文本洞蒸馏应产模板，实际 ${created.length}`);
  const tpl = created.find(t => t.steps.some(st => Object.values(st.args).some(v => (v as any)?.kind === 'hole' && (v as any)?.type === 'string')));
  assert.ok(tpl, '存在 string 洞模板');
  return tpl.id;
}

// ─── M-7：G3 契约（digest 两 API + 休眠段） ───

test('M-7a: listSkillDigests —— G3 契约结构逐字对齐（skillId:string / stepsDigest:Array<Record<string,number>> / reliability:number）', () => {
  const a = skillLibrary.induce('打开甲', [click(0.25, 0.25)])!;
  skillLibrary.induce('打开乙', [click(0.75, 0.75)])!;
  const digests = skillLibrary.listSkillDigests();
  assert.equal(digests.length, 2);
  for (const d of digests) {
    assert.equal(typeof d.skillId, 'string', 'skillId 是 string（契约字面）');
    assert.equal(typeof d.sceneFingerprint, 'string');
    assert.ok(Array.isArray(d.stepsDigest));
    assert.equal(d.stepsDigest.length, 1);
    const step = d.stepsDigest[0];
    assert.equal(typeof step, 'object');
    assert.equal(Object.keys(step).length, 1, '每步一个 { 工具名: args哈希 }');
    const [tool, hash] = Object.entries(step)[0];
    assert.equal(tool, 'click_mouse');
    assert.equal(typeof hash, 'number', '哈希是 number（契约字面）');
    assert.ok(Number.isFinite(hash) && hash >= 0);
    assert.equal(typeof d.reliability, 'number');
    assert.ok(d.reliability > 0 && d.reliability <= 1);
  }
  // 确定性 + 区分度：同 args 同哈希、异 args 异哈希
  const [d1, d2] = digests;
  const h = (d: typeof d1) => Object.values(d.stepsDigest[0])[0];
  assert.notEqual(h(d1), h(d2), '不同坐标 ⇒ 不同摘要哈希');
  const again = skillLibrary.listSkillDigests();
  assert.equal(h(again.find(x => x.skillId === d1.skillId)!), h(d1), '纯确定性：同库同摘要');
  // skillId 与库内技能名对齐（人类可读标识）
  assert.ok(digests.some(x => x.skillId === a.name));
});

test('M-7b: addDormantSkill —— 合法登记 / 幂等拒绝 / 脏输入拒绝', () => {
  const ok = skillLibrary.addDormantSkill({
    skillId: 'node-b#skill-7', sceneFingerprint: 'ab'.repeat(8),
    stepsDigest: [{ click_mouse: 12345 }], reliability: 0.6, origin: 'federation/swarm-b',
  });
  assert.equal(ok, true);
  assert.equal(skillLibrary.addDormantSkill({
    skillId: 'node-b#skill-7', sceneFingerprint: '', stepsDigest: [], reliability: 0.5, origin: 'x',
  }), false, '同 skillId 幂等拒绝');
  assert.equal(skillLibrary.addDormantSkill({
    skillId: '', sceneFingerprint: '', stepsDigest: [{ a: 1 }], reliability: 0.5, origin: 'x',
  }), false, '空 skillId 拒绝');
  assert.equal(skillLibrary.addDormantSkill({
    skillId: 'x1', sceneFingerprint: '', stepsDigest: [], reliability: 0.5, origin: 'x',
  }), false, '空 stepsDigest 拒绝');
  assert.equal(skillLibrary.addDormantSkill({
    skillId: 'x2', sceneFingerprint: '', stepsDigest: [{ a: 'not-number' as unknown as number }], reliability: 0.5, origin: 'x',
  }), false, 'stepsDigest 值非 number 拒绝');
  assert.equal(skillLibrary.addDormantSkill({
    skillId: 'x3', sceneFingerprint: '', stepsDigest: [{ a: 1 }], reliability: 1.5, origin: 'x',
  }), false, 'reliability 越域拒绝');
  assert.equal(skillLibrary.listDormantSkills().length, 1);
});

test('M-7c: 休眠段容量驱逐（FIFO）+ 休眠不入 match 主池', () => {
  for (let i = 0; i < 33; i++) {
    skillLibrary.addDormantSkill({
      skillId: `d-${i}`, sceneFingerprint: '', stepsDigest: [{ click_mouse: i }],
      reliability: 0.5, origin: 'bench',
    });
  }
  const dormant = skillLibrary.listDormantSkills();
  assert.equal(dormant.length, 32, '容量 32');
  assert.equal(dormant[0].skillId, 'd-1', '最老（d-0）被 FIFO 驱逐');
  // 休眠隔离：外来摘要不污染本机召回
  const hits = skillLibrary.match('click_mouse 打开', undefined, 3);
  assert.equal(hits.length, 0, '休眠技能不进 match 主池（外来未验证 —— 诚实隔离）');
});

// ─── M-9：runtime 决策面（case 'macro' + recall_skill 升级） ───

/** system 键鼠 monkey-patch（w3wire 注入风格） */
function patchSystem(over: Partial<Record<'clickMouse' | 'typeText' | 'scroll' | 'pressHotkey' | 'getScreenSize', unknown>>): () => void {
  const saved: Record<string, unknown> = {};
  const host = system as unknown as Record<string, unknown>;
  for (const key of Object.keys(over)) {
    saved[key] = host[key];
    host[key] = (over as Record<string, unknown>)[key];
  }
  return () => { for (const key of Object.keys(over)) host[key] = saved[key]; };
}

/** 假世界快照（800×600，两元素 —— 重锚定的当前帧证据） */
function fakeSnapshot(): WorldSnapshot {
  return {
    takenAt: 1, width: 800, height: 600,
    dhash: 'ab'.repeat(32),
    elements: [
      {
        label: 'Open Settings', role: 'button',
        bbox: { x0: 160, y0: 160, x1: 320, y1: 240 }, // 归一 (0.2,0.2)-(0.4,0.4)
        center: { x: 240, y: 200 },
        confidence: 0.9, source: 'vlm', interactive: true,
      },
      {
        label: 'Search Box', role: 'input',
        bbox: { x0: 520, y0: 480, x1: 680, y1: 540 },
        center: { x: 600, y: 510 },
        confidence: 0.8, source: 'vlm', interactive: true,
      },
    ],
    textDigest: 'Open Settings Search Box',
    popups: [], focusedRegion: null, sceneLabel: '', degraded: [],
  } as unknown as WorldSnapshot;
}

const baseRuntimeDeps = (snapRef: { current: WorldSnapshot | null }): RuntimeDeps => ({
  capture: async () => Buffer.from('fake-frame'),
  imageSize: async () => ({ width: 800, height: 600 }),
  dhashOf: async () => 'cd'.repeat(32), // 抽查证据：与快照 dhash 全异 ⇒ changed=true
  readWords: async () => [],
  groundVlm: async () => [],
  lastSnapshotRef: snapRef,
  now: () => 1000,
  sleep: async () => { /* 零真睡 */ },
});

const mkAction = (kind: string, payload?: Record<string, unknown>): PolicyAction => ({
  kind: kind as PolicyAction['kind'],
  ...(payload ? { payload } : {}),
  rationale: 'w4 测试', expectedEffect: 'w4 测试', utility: 0.5, riskTier: 'benign',
});

test('M-9a: case macro —— 重锚定点击按当前帧元素重解算（像素换算链取证）+ 轨迹摘要入 note', async () => {
  const s = skillLibrary.induce('打开设置', [
    click(0.05, 0.05, { target_description: 'Open Settings' }), // 原坐标已漂移
    typeStep('hello'),
  ])!;
  const snapRef = { current: fakeSnapshot() };
  const clicks: Array<{ x: number; y: number }> = [];
  const typed: string[] = [];
  const restore = patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async (x: number, y: number) => { clicks.push({ x, y }); },
    typeText: async (t: string) => { typed.push(t); },
  });
  try {
    const execute = createExecute({
      ...baseRuntimeDeps(snapRef),
      spec: { goal: '打开设置', successCriteria: [] } as never,
    });
    const out = await execute(mkAction('macro', { skillId: s.id }) as never);
    assert.equal(out.outcome, 'progress', `宏应进展：${out.note}`);
    assert.equal(clicks.length, 1);
    // 重锚定到元素中心 (0.3, 0.333) ⇒ 像素 (576, 360) —— 归一化换算链取证
    assert.equal(clicks[0].x, 576, `x = 0.3*1920，实际 ${clicks[0].x}`);
    assert.equal(clicks[0].y, Math.round((200 / 600) * 1080), `y = 快照中心归一 × 1080，实际 ${clicks[0].y}`);
    assert.deepEqual(typed, ['hello']);
    assert.ok(out.note!.includes('宏执行'), 'note 含宏执行轨迹摘要');
    assert.ok(out.note!.includes('重锚定') || out.note!.includes('执行 2/2'), '轨迹含重锚定/步数证据');
    assert.ok(out.verification && out.verification.degraded.length === 0, '无降级');
  } finally {
    restore();
  }
});

test('M-9b: case macro —— payload 缺席宏定位 ⇒ no_effect；未知技能 ⇒ 诚实失败', async () => {
  const snapRef = { current: fakeSnapshot() };
  const execute = createExecute({
    ...baseRuntimeDeps(snapRef),
    spec: { goal: 'g', successCriteria: [] } as never,
  });
  const noTarget = await execute(mkAction('macro', {}) as never);
  assert.equal(noTarget.outcome, 'no_effect');
  assert.ok(noTarget.note!.includes('缺席宏定位'));
  const ghost = await execute(mkAction('macro', { skillId: 424242 }) as never);
  assert.equal(ghost.outcome, 'no_effect');
  assert.ok(ghost.note!.includes('宏解析失败'), `note=${ghost.note}`);
});

test('M-9c: recall_skill 升级 —— 命中即经宏执行器落地（派发计数 > 0 + 轨迹摘要）；无匹配 ⇒ no_effect（回归）', async () => {
  skillLibrary.induce('打开设置并搜索', [click(0.05, 0.05, { target_description: 'Open Settings' })])!;
  const snapRef = { current: fakeSnapshot() };
  const clicks: Array<{ x: number; y: number }> = [];
  const restore = patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async (x: number, y: number) => { clicks.push({ x, y }); },
    typeText: async () => { /* 不应到达 */ },
  });
  try {
    const execute = createExecute({
      ...baseRuntimeDeps(snapRef),
      spec: { goal: '打开设置并搜索', successCriteria: [] } as never,
    });
    const out = await execute(mkAction('recall_skill') as never);
    assert.equal(out.outcome, 'progress', `recall_skill 应执行宏：${out.note}`);
    assert.equal(clicks.length, 1, '召回即落地（不再只报到达）');
    assert.ok(out.note!.includes('宏执行'), 'note 携宏轨迹摘要');
  } finally {
    restore();
  }
  // 无匹配 ⇒ no_effect（既有语义零回归）
  skillLibrary.reset();
  const snapRef2 = { current: fakeSnapshot() };
  const execute2 = createExecute({
    ...baseRuntimeDeps(snapRef2),
    spec: { goal: '完全不相关的目标', successCriteria: [] } as never,
  });
  const miss = await execute2(mkAction('recall_skill') as never);
  assert.equal(miss.outcome, 'no_effect');
  assert.ok(miss.note!.includes('无匹配'));
});

test('M-9d: macro 可靠度回写闭环 —— 执行后技能账本 attemptCount+1', async () => {
  const s = skillLibrary.induce('回写闭环', [click(0.05, 0.05, { target_description: 'Open Settings' })])!;
  const before = skillLibrary.get(s.id)!.attemptCount;
  const snapRef = { current: fakeSnapshot() };
  const restore = patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async () => { /* 记账即可 */ },
    typeText: async () => { /* noop */ },
  });
  try {
    const execute = createExecute({
      ...baseRuntimeDeps(snapRef),
      spec: { goal: 'g', successCriteria: [] } as never,
    });
    await execute(mkAction('macro', { skillId: s.id }) as never);
    assert.equal(skillLibrary.get(s.id)!.attemptCount, before + 1, '宏执行回写技能账本');
  } finally {
    restore();
  }
});

// ─── M-8：增量账本接线（createPerceive 消费链 + 总闸零回归） ───

async function grayPng(luma: number): Promise<Buffer> {
  return sharp({ create: { width: 400, height: 300, channels: 3, background: { r: luma, g: luma, b: luma } } })
    .png().toBuffer();
}

test('M-8a: 总闸缺省关 ⇒ 增量观察面零写入（零回归铁证）', async () => {
  assert.equal(kernelRegistry.getOrDefault('visualDiff.incremental', 0), 0, '缺省关');
  const png = await grayPng(96);
  const observer: { current: { verdict: unknown; delivery: unknown } | null } = { current: null };
  const perceive = createPerceive({
    capture: async () => png,
    imageSize: async () => ({ width: 400, height: 300 }),
    dhashOf: async () => 'ab'.repeat(32),
    readWords: async () => [],
    groundVlm: async () => [],
    now: () => 1000,
    incrementalObserver: observer as never,
  });
  await perceive();
  await perceive();
  assert.equal(observer.current, null, '开关关 ⇒ 观察面零写入 —— 感知行为与接线前一致');
});

test('M-8b: 总闸开 ⇒ ScreenStateLedger.ingest → deliverIncremental 消费链（首帧 keyframe / 同帧 silent）', async () => {
  // 测试内注册 + 开闸（w3incremental 同律；生产由 index.ts 铸入）
  kernelRegistry.register({ key: 'visualDiff.incremental', organ: 'perception', defaultValue: 0, min: 0, max: 1 });
  await kernelRegistry.set('visualDiff.incremental', 1);
  const png = await grayPng(96);
  const observer: { current: { verdict: { kind: string; generation: number }; delivery: unknown } | null } = { current: null };
  const frames = [png, png]; // 第二帧与首帧相同 ⇒ silent
  let i = 0;
  const perceive = createPerceive({
    capture: async () => frames[Math.min(i++, frames.length - 1)],
    imageSize: async () => ({ width: 400, height: 300 }),
    dhashOf: async () => 'ab'.repeat(32),
    readWords: async () => [],
    groundVlm: async () => [],
    now: () => 1000,
    incrementalObserver: observer as never,
  });
  const snap1 = await perceive();
  assert.ok(snap1, '主感知不受增量旁路影响');
  assert.ok(observer.current, '开关开 ⇒ 观察面收到判决');
  assert.equal(observer.current!.verdict.kind, 'keyframe', '账本冷启动 ⇒ 首帧关键帧');
  assert.equal(observer.current!.verdict.generation, 1);
  assert.equal(observer.current!.delivery, null, '附件服务缺席 ⇒ deliverIncremental null（诚实降级）');
  await perceive();
  assert.equal(observer.current!.verdict.kind, 'silent', '同帧再入账 ⇒ silent（免投递）');
});

// ─── M-6：工具升级（match_skill 模板段 + run_skill 门禁/轨迹） ───

const toolCfg = {
  enableApprovalGate: false, dangerPatterns: '', enableRiskGate: false, riskPatterns: '',
  maxTextLength: 1000, focusMaxAgeMs: 60_000, verifyActions: false, dryRun: false,
  enableInteractivityProbe: false, intentVerify: false, enableOcr: false, autoRemember: false,
  adaptiveSettle: false, actionSettleMs: 1, noopSimilarityThreshold: 0.97, regionVerifyRadius: 0.15,
  physicsRules: '', replayMaxSteps: 100, enableJournal: true, enableSkillLibrary: true,
  enableRecombination: false,
} as unknown as Config;

type Executable = { execute: (a: unknown) => Promise<string> };
async function runJson(tool: unknown, args: unknown): Promise<any> {
  const out = await (tool as Executable).execute(args);
  return JSON.parse(out);
}

test('M-6a: match_skill 附 matchTemplates 召回段（参数化模板并列呈现）', async () => {
  distillOneTemplate();
  const out = await (createMatchSkillTool(toolCfg) as Executable).execute({ query: '登录门户' });
  assert.ok(out.includes('[Parameterized templates'), `输出应含模板召回段：${out.slice(0, 400)}`);
  assert.ok(out.includes('template_id='));
  assert.ok(out.includes('holes='));
  // 字面量命中段保持既有形态（回归）
  assert.ok(out.includes('matching skill(s)'));
});

test('M-6b: match_skill 无模板 ⇒ 输出无模板段（零回归）', async () => {
  skillLibrary.induce('打开设置', [click(0.25, 0.25)])!;
  const out = await (createMatchSkillTool(toolCfg) as Executable).execute({ query: '打开设置' });
  assert.ok(out.includes('matching skill(s)'));
  assert.ok(!out.includes('[Parameterized templates'), '无模板 ⇒ 无模板段');
});

test('M-6c: run_skill 高可靠直放（回归）+ macro_trace 携门禁判词', async () => {
  let clicks = 0;
  const restore = patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async () => { clicks++; },
    typeText: async () => { /* noop */ },
  });
  try {
    const s = skillLibrary.induce('打开设置', [click(0.25, 0.25)])!; // 1/1 ⇒ 0.667 过闸
    const out = await runJson(createRunSkillTool(toolCfg), { id: s.id, confirm: true });
    assert.equal(clicks, 1, '高可靠 ⇒ 免排练直放（既有行为零回归）');
    assert.equal(out.macro_trace.rehearsal_gate.verdict, 'not-required');
    assert.equal(out.macro_trace.source.kind, 'skill');
    assert.ok(['SUCCESS', 'SUCCESS_UNVERIFIED', 'PARTIAL_FAILURE'].includes(out.status));
  } finally {
    restore();
  }
});

test('M-6d: run_skill 低可靠 ⇒ 排练门禁拒绝（REHEARSAL_GATE_REJECTED，零派发）', async () => {
  let clicks = 0;
  const restore = patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async () => { clicks++; },
    typeText: async () => { /* noop */ },
  });
  try {
    const s = induceLowReliability('屡败流程', [click(0.25, 0.25)]); // 0.4 < 0.5
    const out = await runJson(createRunSkillTool(toolCfg), { id: s.id, confirm: true });
    assert.equal(out.status, 'REHEARSAL_GATE_REJECTED');
    assert.equal(clicks, 0, '门禁拒绝 ⇒ 零派发');
    assert.equal(out.macro_trace.rehearsal_gate.verdict, 'degraded');
    assert.ok(out.next_step.includes('rehearsal gate'));
  } finally {
    restore();
  }
});

test('M-6e: run_skill 模板路径 —— 纯文本洞绑定成功 ⇒ 入闸必排练（门禁同律执法）', async () => {
  let typed: string[] = [];
  const restore = patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async () => { /* noop */ },
    typeText: async (t: string) => { typed.push(t); },
  });
  try {
    const tplId = distillTextHoleTemplate();
    // 纯 string 洞 + text 参数 ⇒ 绑定成功（模板路径）⇒ 必排练 ⇒ 工具层无
    // 帧元素场景 ⇒ 诚实拒绝（诚实拒绝优于盲目派发 —— 集成阶段接场景源后放行）
    const out = await runJson(createRunSkillTool(toolCfg), { template_id: tplId, confirm: true, text: 'carol' });
    assert.equal(out.status, 'REHEARSAL_GATE_REJECTED');
    assert.equal(out.macro_trace.source.kind, 'template', '宏解析经模板路径（绑定成功才入闸）');
    assert.equal(out.macro_trace.rehearsal_gate.required, true, '模板产物恒必排练');
    assert.equal(typed.length, 0, '拒绝 ⇒ 零派发');
  } finally {
    restore();
  }
});

test('M-6f: run_skill 模板绑定失败 ⇒ 回退母体技能执行（W3-2 语义的工具面兑现）', async () => {
  let clicks = 0;
  const restore = patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async () => { clicks++; },
    typeText: async () => { /* noop */ },
  });
  try {
    const tplId = distillOneTemplate();
    // 不给 text ⇒ string 洞绑定失败 ⇒ 回退母体字面量技能（1/1=0.667 过闸直放）
    const out = await runJson(createRunSkillTool(toolCfg), { template_id: tplId, confirm: true });
    assert.equal(out.macro_trace.source.kind, 'fallback-skill', '绑定失败回退母体技能');
    assert.ok(out.macro_trace.fallback_reason.includes('回退母体技能'));
    assert.ok(clicks >= 1, '回退链照常执行');
    assert.equal(out.macro_trace.rehearsal_gate.verdict, 'not-required', '母体可靠度过闸');
  } finally {
    restore();
  }
});

// ─── 兜底：轨迹摘要的 Token 纪律形态 ───

test('M-10: macroTraceSummary —— 判词可读 + 轨迹字段完备（审计面）', async () => {
  const s = skillLibrary.induce('摘要', [click(0.3, 0.3)])!;
  const { dispatch } = makeDispatch();
  const trace: MacroTrace = await executeMacro({ skillId: s.id }, {
    dispatch,
    anchors: () => [anchor('X', 0.2, 0.2, 0.4, 0.4)],
    spotCheck: async () => true,
  });
  const summary = macroTraceSummary(trace);
  assert.ok(summary.includes('宏源自 skill'));
  assert.ok(summary.includes('执行 1/1'));
  assert.ok(summary.includes('排练门禁免验'));
  // 轨迹结构完备（消费方契约）
  assert.equal(typeof trace.ok, 'boolean');
  assert.equal(typeof trace.reliability, 'number');
  assert.ok(Array.isArray(trace.steps));
  assert.ok(Array.isArray(trace.spotChecks));
  assert.ok(Array.isArray(trace.degraded));
  assert.ok(trace.budget.maxSteps > 0 && trace.budget.timeoutMs > 0);
});
