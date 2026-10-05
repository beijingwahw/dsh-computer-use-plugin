// test/epochX.test.ts
// X 纪元（笔迹纪元）：运动反射弧 —— 反射脑的动作词汇执法册。
// 器官：src/intentGrammar.ts（意图语法层）+ stations.ts 运动弧集成。
// 逐件执法：
//   X-1 引号锚定提取（信息无损：六种引号风格 + 空/未配对段拒绝）
//   X-2 刺激类别判别（动词位；'delete "x"' 不误入笔迹弧）
//   X-3 残差铸造（载荷剥夺：引号内词不参加落点选举）
//   X-3b（ΠΑΝ-30）多引号段残差 —— 切分索引错位的执法重放（双载荷/紧邻/混族/撇号）
//   X-4 滚动指令提取（方向唯一 + 幅度运动学域，域外拒绝不钳制）
//   X-5 热键和弦提取（键名归一 + 键宇宙校验 + 和弦上限）
//   X-6 运动弧选择表（先落点后运笔 / 自证 L4 锚 / 精确性优先拒绝）
//   X-7 虚拟屏排练闭环（反射动作 → L4 自证 / 无焦点诚实失败 / esc 关弹窗）
//   X-8 消融归因（关运动弧 ⇒ 笔迹意图退回点击弧诚实接地；点击意图不受扰）
//   X-9 压制优先级（免疫系统对运动类刺激同样执法 —— Tier 0 先于一切运动）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractQuotedSpans, classifyMotor, residueTokens, extractScroll, extractHotkey,
} from '../src/intentGrammar.ts';
import { ReflexiveDecisionStation, dispatchElementsToGrid } from '../src/knowledge/stations.ts';
import { VirtualScreen } from '../src/sandbox/virtualScreen.ts';
import type { DecisionContext, KnowledgeInjection, ScenePatch } from '../src/knowledge/contracts.ts';

// ─── 场景铸造件 ───

function sceneOf(names: string[]): ScenePatch[] {
  return dispatchElementsToGrid(
    names.map((name, i) => ({
      role: 'text', name,
      rect: { x: 0.1 + (i % 3) * 0.3, y: 0.1 + Math.floor(i / 3) * 0.25, width: 0.15, height: 0.05 },
    })),
    { cols: 2, rows: 2 }, 'L2', 'L2-ocr',
  );
}

async function decideOf(
  description: string,
  sceneNames: string[],
  opts: { knowledge?: KnowledgeInjection; station?: Partial<ConstructorParameters<typeof ReflexiveDecisionStation>[0]> } = {},
): Promise<{ kind?: string; args?: Record<string, unknown>; expect?: { scale?: string; expectedText?: string }; rationale?: string; reason?: string }> {
  const station = new ReflexiveDecisionStation({ chat: null, ...opts.station });
  const ctx: DecisionContext = {
    intent: { id: 'x-test', description },
    scene: sceneOf(sceneNames),
    knowledgeContext: opts.knowledge,
  };
  const out = await station.decide({ station: 'decision', payload: ctx, tokenBudget: 0 });
  return out as never;
}

// ─── X-1 引号锚定提取 ───

test('X-1: 引号锚定 —— 六种风格无损提取 + 病态段拒绝', () => {
  const cases: Array<[string, string, string]> = [
    ['type "hello world" now', 'hello world', 'double'],
    ["enter 'alpha.local' there", 'alpha.local', 'single'],
    ['输入「你好世界」到这里', '你好世界', 'corner'],
    ['键入『机密文稿』', '机密文稿', 'white-corner'],
    ['fill “curly payload” in', 'curly payload', 'curly-double'],
    ['paste ‘draft v2’ please', 'draft v2', 'curly-single'],
  ];
  for (const [text, want, quote] of cases) {
    const spans = extractQuotedSpans(text);
    assert.equal(spans.length, 1, `"${text}" 恰一段`);
    assert.equal(spans[0].content, want, `无损提取（${quote}）`);
    assert.equal(spans[0].quote, quote);
  }
  // 病态：空段（无信息量）与未配对开引号都不构成载荷
  assert.equal(extractQuotedSpans('type "" into box').length, 0, '空段不算载荷');
  assert.equal(extractQuotedSpans("it's a 'test").length, 0, '未配对不算载荷（撇号不劫持）');
  // 撇号防护（X-1 执法出的缺陷）：缩写撇号不得配对后面载荷、也不得产出损坏载荷
  const contraction = extractQuotedSpans("don't press 'esc' here");
  assert.equal(contraction.length, 1, '缩写撇号不开引号');
  assert.equal(contraction[0].content, 'esc', '载荷完好（无 "t press " 类腐蚀）');
  // 多段如实计数（载荷歧义由运动弧拒绝）
  assert.equal(extractQuotedSpans('type "a" then "b"').length, 2);
});

// ─── X-2 刺激类别判别 ───

test('X-2: 动词位判别 —— 类别词表 + 反例执法', () => {
  assert.equal(classifyMotor('type "x" into the box'), 'typing');
  assert.equal(classifyMotor('输入 "x"'), 'typing');
  assert.equal(classifyMotor('fill "42"'), 'typing');
  assert.equal(classifyMotor('scroll down'), 'scrolling');
  assert.equal(classifyMotor('滚动 下来'), 'scrolling');
  assert.equal(classifyMotor('press ctrl s'), 'hotkey');
  assert.equal(classifyMotor('delete "x" now'), null, '删除动词不因引号段误入笔迹弧');
  assert.equal(classifyMotor('open the files page'), null);
  assert.equal(classifyMotor('clear the log'), null);
});

// ─── X-3 残差铸造（载荷剥夺） ───

test('X-3: 残差 —— 引号内词不参加落点选举', () => {
  const r1 = residueTokens('type "hello world" into the server field');
  assert.ok(r1.includes('server') && r1.includes('field'), '落点词在场');
  assert.ok(!r1.includes('hello') && !r1.includes('world'), '载荷词被剥夺');
  // 残差只切动词词表（into/the 非动词、照常保留 —— 见下行 r2）；原式
  // `!A && !B || !A` 恒等于 `!A`，'into' 分支是从不生效的死逻辑。
  assert.ok(!r1.includes('type'), '动词被切除');
  const r2 = residueTokens('type "alpha.local"');
  assert.equal(r2.filter(t => t !== 'into' && t !== 'the').length, 0, '纯载荷意图残差为空（只剩虚词）');
});

// ─── X-3b（ΠΑΝ-30）：多引号段残差 —— 切分索引错位的执法重放 ───

test('X-3b/ΠΑΝ-30: 多引号段残差错位 —— 最小重放（载荷泄漏 + 动词腰斩必须绝迹）', () => {
  // 批判 C1-2 H5 实证 bug：span range 基于原文索引，左→右逐段 splice 后字符串
  // 收缩，后续段持陈旧索引做手术 ⇒ 残差 ["then","\"bb","ess","ctrl"] —— 第二
  // 载荷泄漏进残差、'press' 被腰斩成 'ess'。自右向左切除后残差必须干净
  //（'ctrl' 是键名不是动词 —— 残差合法成员，热键弧的消费对象）。
  const r = residueTokens('type "aa" then "bb" press ctrl');
  assert.deepEqual(r, ['then', 'ctrl'], `双载荷+双动词残差恰为连接词+键名（实际 ${JSON.stringify(r)}）`);
  // 载荷词绝无泄漏（无引号残片、无载荷子串）
  assert.ok(!r.some(t => t.includes('bb') || t.includes('aa')), '载荷词不进残差');
  // 动词词表在残差中的识别不被腰斩（'ess' 绝迹 = press 被完整切除）
  assert.ok(!r.some(t => t === 'ess' || t === 'pres'), '动词完整切除（无腰斩碎片）');
});

test('X-3b/ΠΑΝ-30: 双载荷场景（用户名 + 密码）—— 两段无损提取且都被剥夺投票权', () => {
  const text = 'type "user@example.com" then type "p@ss word" into the login form';
  const spans = extractQuotedSpans(text);
  assert.equal(spans.length, 2, '双载荷如实计数');
  assert.equal(spans[0].content, 'user@example.com', '用户名无损（编辑距离 0）');
  assert.equal(spans[1].content, 'p@ss word', '密码无损（含空格的第二段不腐蚀第一段）');
  const r = residueTokens(text);
  assert.ok(!r.some(t => t.includes('example') || t.includes('p@ss') || t.includes('word')), '两段载荷全部被剥夺落点投票权');
  assert.ok(r.includes('login') && r.includes('form'), '落点词保留（多段切除后仍可投票）');
  assert.equal(classifyMotor(text), 'typing', '多段载荷下动词位判别照常');
  // 相邻/混合引号族边界：紧邻双段、单双混用、三段、角引号（中文）
  assert.deepEqual(residueTokens('type "aa""bb" now'), ['now'], '紧邻双段（无间隔）');
  assert.deepEqual(residueTokens("press 'a' then \"b\" ctrl"), ['then', 'ctrl'], '单双引号混用双段');
  const cn = residueTokens('输入「甲」然后 键入「乙」到这里');
  assert.ok(!cn.some(t => t.includes('甲') || t.includes('乙')), '角引号双段载荷被剥夺（中文同律）');
  assert.ok(cn.includes('然后'), '连接词保留（多段切除后残差仍可读）');
  assert.deepEqual(residueTokens('"one" "two" "three" press ctrl'), ['ctrl'], '三段载荷 + 尾部动词（动词在末段之后不被腰斩）');
  // 缩写撇号 + 多段载荷共存（X-1 防护与 ΠΑΝ-30 修复的正交性）
  assert.deepEqual(residueTokens("don't type 'x' then 'y' ok"), ['don', 't', 'then', 'ok'], '撇号防护不被多段切除破坏');
});

test('X-3b/ΠΑΝ-30: 多段场景下热键/滚动弧的残差消费 —— 引号段不再误拒', () => {
  // 旧 bug 的下游症状：'"bb'/'ess' 不是键名 ⇒ extractHotkey 误拒。修后带双引号
  // 段的热键意图残差只余真键名。
  const hk = extractHotkey('"note text" press ctrl s');
  assert.ok(hk.kind === 'ok' && JSON.stringify(hk.value.keys) === JSON.stringify(['ctrl', 's']),
    `引号载荷段不参与键名选举（实际 ${JSON.stringify(hk)}）`);
  const sc = extractScroll('scroll down "comment" 3');
  assert.ok(sc.kind === 'ok' && sc.value.direction === 'down' && sc.value.amount === 3, '滚动量不被引号段错位吞并');
});

// ─── X-4 滚动指令提取 ───

test('X-4: 滚动提取 —— 方向唯一 + 幅度域 [1,20]，域外拒绝不钳制', () => {
  const a = extractScroll('scroll down');
  assert.ok(a.kind === 'ok' && a.value.direction === 'down' && a.value.amount === 1, '缺省幅度 1');
  const b = extractScroll('scroll up 3');
  assert.ok(b.kind === 'ok' && b.value.direction === 'up' && b.value.amount === 3);
  const sideways = extractScroll('scroll sideways');
  assert.ok(sideways.kind === 'refused' && /direction absent/.test(sideways.reason), '方向缺席拒绝');
  const both = extractScroll('scroll up then down');
  assert.ok(both.kind === 'refused' && /ambiguous/.test(both.reason), '方向多义拒绝');
  const huge = extractScroll('scroll down 999');
  assert.ok(huge.kind === 'refused' && /kinematic domain/.test(huge.reason), '幅度域外拒绝（不钳制成 20）');
});

// ─── X-5 热键和弦提取 ───

test('X-5: 热键提取 —— 键名归一 + 键宇宙校验 + 和弦上限', () => {
  const a = extractHotkey('press ctrl s');
  assert.ok(a.kind === 'ok' && JSON.stringify(a.value.keys) === JSON.stringify(['ctrl', 's']));
  const b = extractHotkey('press control alt delete');
  assert.ok(b.kind === 'ok' && JSON.stringify(b.value.keys) === JSON.stringify(['ctrl', 'alt', 'delete']), '别名归一（control→ctrl）');
  const c = extractHotkey('press escape');
  assert.ok(c.kind === 'ok' && JSON.stringify(c.value.keys) === JSON.stringify(['esc']));
  const notKey = extractHotkey('press the button');
  assert.ok(notKey.kind === 'refused' && /not a key name/.test(notKey.reason), "'button' 不是键名");
  assert.ok(extractHotkey('press').kind === 'refused', '零键拒绝');
  const long = extractHotkey('press ctrl alt shift a b');
  assert.ok(long.kind === 'refused' && /chord/.test(long.reason), '五键和弦 = 解析噪声拒绝');
});

// ─── X-6 运动弧选择表 ───

test('X-6a: 笔迹反射 —— 无落点 ⇒ type_text + 自证 L4 锚', async () => {
  const out = await decideOf('type "alpha.local"', ['server field', 'user name', 'notes area']);
  assert.equal(out.kind, 'type_text');
  assert.equal(out.args?.text, 'alpha.local');
  assert.equal(out.expect?.scale, 'text-level', '生而携带 L4 预期锚');
  assert.equal(out.expect?.expectedText, 'alpha.local', '自证锚与载荷同源（编辑距离 0）');
  assert.match(String(out.rationale), /quote-anchored/, '白盒轨迹');
});

test('X-6b: 运动序法则 —— 先落点后运笔（残差严格领先 ⇒ 点击前置）', async () => {
  const out = await decideOf('type "gamma" into the server field', ['server field', 'user name', 'notes area']);
  assert.equal(out.kind, 'click_mouse', '落点前置，笔迹让位');
  assert.match(String(out.rationale), /prerequisite-first/, '法则入轨迹');
  // 载荷剥夺执法：载荷词不投票 —— 'type "user name"' 不因载荷撞名而改道
  const out2 = await decideOf('type "user name" into the server field', ['server field', 'user name', 'notes area']);
  assert.equal(out2.kind, 'click_mouse');
  assert.match(String(out2.rationale), /'server field'/, '落点 = server field（载荷 "user name" 未劫持选举）');
});

test('X-6c: 精确性优先 —— 载荷缺席/多义 ⇒ 结构化拒绝', async () => {
  const noPayload = await decideOf('type the password', ['server field', 'user name']);
  assert.equal(noPayload.kind, undefined, '无动作');
  assert.match(String(noPayload.reason), /without quoted payload/, '自由文本提取是有损猜测 —— 拒绝');
  const two = await decideOf('type "a" "b"', ['server field', 'user name']);
  assert.match(String(two.reason), /payload ambiguous/, '双载荷歧义拒绝');
});

test('X-6d: 知识教落点、语法教载荷 —— workflow 语义托举与笔迹弧闭环', async () => {
  // 'type the password'（无引号载荷）+ workflow 证据 ⇒ 前额叶托举落点（点击）
  const out = await decideOf('type the password', ['password field', 'server field'], {
    knowledge: {
      summary: 'password field receives the secret', categories: ['workflow'], maxConfidence: 0.6,
      sources: [{ type: 'manual', ref: 'seed' }],
      fragments: [{ category: 'workflow', content: 'password field receives the secret', confidence: 0.6 }],
    },
  });
  assert.equal(out.kind, 'click_mouse', '无载荷笔迹意图 ⇒ 仿真托举落点（先落点法则的仿真面）');
  assert.match(String(out.rationale), /'password field'/);
});

test('X-6e: 保护律 —— "press the big red button" 走点击不走热键', async () => {
  const out = await decideOf('press the big red button', ['big red button', 'small blue button']);
  assert.equal(out.kind, 'click_mouse', '残差命中控件 ⇒ 前置点击，热键弧不误伤点击意图');
});

test('X-6f: 滚动与热键弧 —— 无落点运动类刺激直接发射', async () => {
  const scroll = await decideOf('scroll down', ['files', 'network']);
  assert.equal(scroll.kind, 'scroll_page');
  assert.deepEqual(scroll.args, { direction: 'down', amount: 1 });
  const hotkey = await decideOf('press ctrl s', ['files', 'network']);
  assert.equal(hotkey.kind, 'press_hotkey');
  assert.deepEqual(hotkey.args, { keys: ['ctrl', 's'] });
});

// ─── X-7 虚拟屏排练闭环（反射动作的世界证据） ───

test('X-7: 排练闭环 —— 自证反射在虚拟屏上 L4 达成；无焦点诚实失败', async () => {
  const field = { role: 'input', name: 'server field', rect: { x: 0.4, y: 0.4, width: 0.2, height: 0.08 }, acceptsText: true };
  const vs = new VirtualScreen([field]);
  // 决策场景与虚拟屏同源 rect（排练对真实几何做命中测试）
  const fieldScene = dispatchElementsToGrid(
    [{ role: 'input', name: 'server field', rect: field.rect }],
    { cols: 2, rows: 2 }, 'L2', 'L2-ocr');
  const station = new ReflexiveDecisionStation({ chat: null });
  const decideWith = async (description: string) =>
    station.decide({ station: 'decision', payload: { intent: { id: 'x7', description }, scene: fieldScene }, tokenBudget: 0 });

  // 运动序：先落点（点击聚焦）→ 后运笔（type_text 落字）
  const click = await decideWith('type "alpha.local" into the server field') as any;
  assert.equal(click.kind, 'click_mouse');
  const clickEv = vs.applyAction({ kind: 'click_mouse', args: (click as any).args } as never);
  assert.ok(clickEv.effectDetected, '落点命中');

  const type = await decideWith('type "alpha.local"') as any;
  assert.equal(type.kind, 'type_text');
  const typeEv = vs.applyAction({ kind: 'type_text', args: { text: type.args.text }, expect: type.expect } as never);
  assert.ok(typeEv.effectDetected, '笔迹落进聚焦控件');
  assert.equal(typeEv.expectationMet, true, 'L4 自证锚达成（反射知道自己成功长什么样）');

  // 无焦点运笔：诚实失败（世界证据，非脚本裁决）
  const vs2 = new VirtualScreen([field]);
  const coldEv = vs2.applyAction({ kind: 'type_text', args: { text: 'x' } } as never);
  assert.equal(coldEv.effectDetected, false, '无焦点 ⇒ 文字无处落 —— 诚实失败');

  // esc 关弹窗（K 纪元键盘状态模型的运动弧接线）
  const popup = { role: 'dialog', name: 'confirm', rect: { x: 0.8, y: 0.1, width: 0.15, height: 0.1 }, popup: true };
  const vs3 = new VirtualScreen([popup]);
  const esc = await decideOf('press escape', []);
  assert.equal(esc.kind, 'press_hotkey');
  const escEv = vs3.applyAction({ kind: 'press_hotkey', args: { keys: ['esc'] } } as never);
  assert.ok(escEv.effectDetected, 'esc 关闭弹窗');
});

// ─── X-8 消融归因 ───

test('X-8: 消融 —— 关运动弧 ⇒ 笔迹意图退回点击弧诚实接地；点击意图不受扰', async () => {
  const ablated = { station: { disableMotorArc: true } };
  const typing = await decideOf('type "alpha.local"', ['server field', 'user name'], ablated);
  assert.equal(typing.kind, undefined, '消融下无动作');
  assert.match(String(typing.reason), /no reflex arc/, '退回点击弧的零重合接地');
  const click = await decideOf('open the files page', ['files', 'network'], ablated);
  assert.equal(click.kind, 'click_mouse', '点击主权不受运动消融影响');
});

// ─── X-9 压制优先级 ───

test('X-9: 免疫优先 —— error-pattern 对运动类刺激同样压制（Tier 0 先于一切运动）', async () => {
  // 场景无词法活路（'main menu' 与残差零重合）⇒ 压制 ⇒ 仿真无活路 ⇒
  // 探针信任门控（新鲜亲证 0.9 ≥ 地板）⇒ 不放行 ⇒ 诚实接地。
  // 注：若场景有词法活路（如 'server field' 共享 'field'），前额叶会改道
  // 点击活路 —— 那是证据经济学的正确行为（X-6d 的对偶），不是本测的对象。
  const out = await decideOf('type "x" into the guest field', ['guest field', 'main menu'], {
    knowledge: {
      summary: 'guest field is broken', categories: ['error-pattern'], maxConfidence: 0.9,
      sources: [{ type: 'manual', ref: 'seed' }],
      fragments: [{ category: 'error-pattern', content: 'guest field typing fails always', confidence: 0.9, verifiedAt: Date.now() }],
    },
  });
  assert.equal(out.kind, undefined, '压制下不发动作');
  assert.match(String(out.reason), /suppressed/, '压制理由在场');
});
