// test/reflexiveDecision.test.ts
// 反射决策工位（ReflexiveDecisionStation）—— 桩纪元终结者的执法点测试。
// 四条路径各有独立测试：脊髓反射 / 免疫抑制 / 反射弧缺席 / 平票歧义 + LLM 大脑路径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReflexiveDecisionStation } from '../src/knowledge/stations.ts';
import type {
  AtomicAction, DecisionContext, ExecutionResult, NeedGrounding, PerceptionRequest,
  ScenePatch,
} from '../src/knowledge/contracts.ts';

/** 归一化元素铸造（测试DSL —— rect 域 = 全屏归一化） */
function el(name: string, x: number, y: number, w = 0.1, h = 0.05): ScenePatch['elements'][number] {
  return { source: 'L1-tree', role: 'button', name, rect: { x, y, width: w, height: h } };
}

function scene(...els: Array<ScenePatch['elements'][number]>): ScenePatch[] {
  return [{
    region: { id: 'g0x0', x: 0, y: 0, width: 1, height: 1 },
    elements: els,
    funnelDepth: 'L1',
    capturedAt: Date.now(),
  }];
}

function ctx(intent: string, sc: ScenePatch[], knowledgeContext?: DecisionContext['knowledgeContext']): DecisionContext {
  return { intent: { id: 'i', description: intent }, scene: sc, knowledgeContext };
}

function env(payload: DecisionContext) {
  return { station: 'decision' as const, payload, tokenBudget: 2000 };
}

const isNeedGrounding = (o: AtomicAction | NeedGrounding): o is NeedGrounding =>
  typeof (o as NeedGrounding).reason === 'string' && !('kind' in o);

test('反射弧：intent 与元素名重合 ⇒ 直接点击该元素中心（零 LLM 决策）', async () => {
  const station = new ReflexiveDecisionStation({ chat: null });
  const sc = scene(el('settings', 0.1, 0.1, 0.2, 0.1), el('close', 0.8, 0.05));
  const out = await station.decide(env(ctx('open settings', sc)));
  assert.ok(!isNeedGrounding(out), `期望反射动作，得到 ${JSON.stringify(out)}`);
  assert.equal(out.kind, 'click_mouse');
  // 中心坐标：settings rect (0.1,0.1,0.2,0.1) ⇒ 中心 (0.2, 0.15)
  assert.deepEqual((out as any).args, { x: 0.2, y: 0.15 });
  assert.match(out.rationale ?? '', /reflex.*'settings'/, '审计轨迹：反射依据可回放');
});

test('免疫抑制：高置信 error-pattern 在场 ⇒ 手在陷阱前停住（NeedGrounding）', async () => {
  const station = new ReflexiveDecisionStation({ chat: null });
  const sc = scene(el('settings', 0.1, 0.1, 0.2, 0.1));
  const knowledge = {
    summary: '[error-pattern] action click_mouse failed: element vanishes',
    categories: ['error-pattern' as const],
    maxConfidence: 0.7,
    sources: [{ type: 'auto-learn' as const, ref: 'kb-1' }],
  };
  const out = await station.decide(env(ctx('open settings', sc, knowledge)));
  assert.ok(isNeedGrounding(out), 'error-pattern ≥0.5 ⇒ 反射被抑制');
  assert.match(out.reason, /suppressed by error-pattern/);
  assert.equal(out.focus, 'knowledge');
});

test('免疫阈值之下：低置信 error-pattern（0.3）不抑制 ⇒ 反射照常', async () => {
  const station = new ReflexiveDecisionStation({ chat: null });
  const sc = scene(el('settings', 0.1, 0.1, 0.2, 0.1));
  const knowledge = {
    summary: '[error-pattern] weak memory',
    categories: ['error-pattern' as const],
    maxConfidence: 0.3,
    sources: [],
  };
  const out = await station.decide(env(ctx('open settings', sc, knowledge)));
  assert.ok(!isNeedGrounding(out), '置信度 0.3 < 0.5 ⇒ 抑制不触发，反射照常');
});

test('反射弧缺席：场景与意图零重合 ⇒ NeedGrounding 诚实回退', async () => {
  const station = new ReflexiveDecisionStation({ chat: null });
  const sc = scene(el('close', 0.8, 0.05), el('minimize', 0.7, 0.05));
  const out = await station.decide(env(ctx('open settings panel', sc)));
  assert.ok(isNeedGrounding(out));
  assert.match(out.reason, /no reflex arc/);
});

test('平票歧义：两个元素同分 ⇒ 反射不明确 ⇒ NeedGrounding（绝不掷硬币）', async () => {
  const station = new ReflexiveDecisionStation({ chat: null });
  // 'settings' 与 'settings panel' 都命中 intent 词 'settings'（各 1 分）⇒ 真平票
  const sc = scene(el('settings', 0.1, 0.1), el('settings panel', 0.5, 0.5));
  const out = await station.decide(env(ctx('open settings', sc)));
  assert.ok(isNeedGrounding(out), '两个候选同 1 分 ⇒ 平票不反射');
  assert.match(out.reason, /ambiguous/);
});

test('大脑路径：chat 在场 ⇒ LLM 规划优先（反射让位于大脑）', async () => {
  const chat = async () => '{"type":"action","action":{"kind":"type_text","args":{"text":"hello"}},"rationale":"llm says"}';
  const station = new ReflexiveDecisionStation({ chat });
  const sc = scene(el('settings', 0.1, 0.1));
  const out = await station.decide(env(ctx('open settings', sc)));
  assert.ok(!isNeedGrounding(out));
  assert.equal(out.kind, 'type_text', 'LLM 输出优先于脊髓反射');
  assert.equal(out.rationale, 'llm says');
});

test('免疫系统闭环：免疫抑制 + 反射 + 执行失败的端到端语义（组合而非单元）', async () => {
  // 场景：老员工直觉（error-pattern）在场 ⇒ 抑制反射 ——
  // 这是免疫系统与反射决策在流水线中的真实咬合：知识先于本能。
  const station = new ReflexiveDecisionStation({ chat: null, suppressConfidence: 0.5 });
  const sc = scene(el('delete-all', 0.5, 0.5));
  const trapKnowledge = {
    summary: '[error-pattern] action click_mouse failed (host-error): irreversible',
    categories: ['error-pattern' as const],
    maxConfidence: 0.9,
    sources: [{ type: 'auto-learn' as const, ref: 'kb-trap' }],
  };
  const out = await station.decide(env(ctx('delete all files', sc, trapKnowledge)));
  assert.ok(isNeedGrounding(out));
  assert.match(out.reason, /0\.90/, '抑制理由携带置信度证据');
});

// ─── 神经纪元 Tier 2：前额叶仿真（慢路径推理）───

test('前额叶 #1 零样本泛化：反射零重合（no arc）⇒ 语义相似度托举出动作', async () => {
  const station = new ReflexiveDecisionStation({ chat: null });
  // intent（拉丁词）与元素（CJK）零词汇重合（Tier 1 必死）—— workflow 证据语义托举：
  // 「整理数据」的老经验托举起「筛选数据」按钮（C-2 零样本泛化的决策侧执法）
  const sc = scene(el('筛选数据', 0.4, 0.4, 0.2, 0.1), el('关闭窗口', 0.9, 0.05));
  const knowledge = {
    summary: '[workflow] 整理数据',
    categories: ['workflow' as const],
    maxConfidence: 0.8,
    sources: [{ type: 'manual' as const, ref: 'kb-1' }],
    fragments: [{ category: 'workflow' as const, content: '整理数据', confidence: 0.8 }],
  };
  const out = await station.decide(env(ctx('clean up the spreadsheet data', sc, knowledge)));
  assert.ok(!isNeedGrounding(out), `前额叶应零样本命中，得到 ${JSON.stringify(out)}`);
  assert.equal(out.kind, 'click_mouse');
  assert.match(out.rationale ?? '', /deliberation/, '审计轨迹标注仿真来源');
  assert.match(out.rationale ?? '', /workflow/, '证据链携带 workflow 来源');
  // 命中的必须是语义相关的「筛选数据」（中心 x=0.5）而非「关闭窗口」（x=0.925）
  assert.ok((out as any).args.x < 0.6, `应点筛选数据中心，实际 ${(out as any).args.x}`);
});

test('前额叶 #2 平票破局：反射平票 ⇒ 知识证据是唯一合法破局者', async () => {
  const station = new ReflexiveDecisionStation({ chat: null });
  // 两个元素与 intent 各命中 1 词（Tier 1 平票）—— workflow 证据偏向其一
  const sc = scene(el('settings', 0.1, 0.1), el('settings panel', 0.5, 0.5));
  const knowledge = {
    summary: '[workflow] open settings panel via sidebar',
    categories: ['workflow' as const],
    maxConfidence: 0.9,
    sources: [],
    fragments: [{ category: 'workflow' as const, content: 'open settings panel via sidebar', confidence: 0.9 }],
  };
  const out = await station.decide(env(ctx('open settings', sc, knowledge)));
  assert.ok(!isNeedGrounding(out), `知识证据应破平票，得到 ${JSON.stringify(out)}`);
  // 「settings panel」获 workflow 证据加成 ⇒ 效用领先 ⇒ 胜出（中心 x≈0.55+）
  assert.ok((out as any).args.x > 0.5, '证据加成方胜出');
  assert.match(out.rationale ?? '', /utility=/);
});

test('前额叶 #3 证据经济学：陷阱惩罚压负 + 安全路径托举正 ⇒ 前额叶选出活路', async () => {
  const station = new ReflexiveDecisionStation({ chat: null });
  // 双证据低置信（均 < 0.5 抑制阈值 ⇒ Tier 0 不触发）；
  // intent 与两元素零词汇重合（Tier 1 no arc）⇒ 前额叶全权裁决：
  //   'delete item'：error-pattern 高相似 ⇒ 效用转负（陷阱记忆压垮）
  //   'clear log'：workflow 高相似 ⇒ 效用为正（老经验托举）
  const sc = scene(el('delete item', 0.4, 0.4, 0.2, 0.1), el('clear log', 0.7, 0.7, 0.2, 0.1));
  const knowledge = {
    summary: '[error-pattern] delete item broken; [workflow] clear log after erasing records',
    categories: ['error-pattern' as const, 'workflow' as const],
    maxConfidence: 0.45,
    sources: [],
    fragments: [
      { category: 'error-pattern' as const, content: 'delete item button is broken', confidence: 0.4 },
      { category: 'workflow' as const, content: 'clear log after erasing records', confidence: 0.45 },
    ],
  };
  const out = await station.decide(env(ctx('erase the record', sc, knowledge)));
  assert.ok(!isNeedGrounding(out), `前额叶应选出活路，得到 ${JSON.stringify(out)}`);
  assert.equal(out.kind, 'click_mouse');
  // 「clear log」中心 x=0.8；「delete item」中心 x=0.5 —— 陷阱方必须落选
  assert.ok((out as any).args.x > 0.7, `应点 clear log（x≈0.8），实际 ${(out as any).args.x}`);
  assert.match(out.rationale ?? '', /-error-pattern/, '证据链含陷阱惩罚');
  assert.match(out.rationale ?? '', /\+workflow/, '证据链含安全托举');
});

test('前额叶 #4 无证据不仿真：fragments 缺席 ⇒ 反射接地原样透传（诚实降级）', async () => {
  const station = new ReflexiveDecisionStation({ chat: null });
  const sc = scene(el('close', 0.8, 0.05), el('minimize', 0.7, 0.05));
  // 有 knowledgeContext 但无 fragments（旧实现/预算截断）⇒ 无米下锅
  const knowledge = {
    summary: '[workflow] something',
    categories: ['workflow' as const],
    maxConfidence: 0.5,
    sources: [],
  };
  const out = await station.decide(env(ctx('open settings panel', sc, knowledge)));
  assert.ok(isNeedGrounding(out));
  assert.match(out.reason, /no reflex arc/, '无 fragments ⇒ 前额叶静默，反射理由透传');
});

// ─── 核证接地（verified grounding 纪元）：信任门控的接地前探针 ───
// 信任 = 置信度 × 亲证衰减（trustOf）；VERIFY_TRUST_FLOOR（缺省 0.2）是门控地板。
// 三态：传闻（verifiedAt 缺席 ⇒ trust 0）⇒ 探针 / 新鲜亲证（trust ≥ 地板）⇒ 诚实接地 /
// 陈年亲证（衰减过线）⇒ 复活探针。探针 = 放行被压制的反射弧（一针验证）。

test('核证接地 #1 传闻压制：trap 证据从未亲证 ⇒ 接地前放行一针探针', async () => {
  const station = new ReflexiveDecisionStation({ chat: null });
  const sc = scene(el('delete item', 0.4, 0.4, 0.2, 0.1));
  // 传闻种子：manual 断言（verifiedAt 缺席 ⇒ trust 0）—— 从未亲证过的压制证据
  const knowledge = {
    summary: '[error-pattern] delete item broken',
    categories: ['error-pattern' as const],
    maxConfidence: 0.7,
    sources: [{ type: 'manual' as const, ref: 'kb-1' }],
    fragments: [{ category: 'error-pattern' as const, content: 'delete item button is broken', confidence: 0.7 }],
  };
  const out = await station.decide(env(ctx('delete the record', sc, knowledge)));
  assert.ok(!isNeedGrounding(out), `传闻压制 ⇒ 探针放行，得到 ${JSON.stringify(out)}`);
  assert.equal(out.kind, 'click_mouse');
  // 探针点击的是被压制的反射弧目标（delete item 中心 x=0.5）
  assert.ok(Math.abs((out as any).args.x - 0.5) < 0.01, `探针放行本能弧，实际 x=${(out as any).args.x}`);
  assert.match(out.rationale ?? '', /probe\(verified-grounding\)/, '审计轨迹标注探针来源');
  assert.match(out.rationale ?? '', /reflex/, '探针内联被压制的反射弧依据');
});

test('核证接地 #2 亲证背书：新鲜亲证（trust ≥ floor）⇒ 诚实接地（不探针）', async () => {
  const station = new ReflexiveDecisionStation({ chat: null });
  const sc = scene(el('delete item', 0.4, 0.4, 0.2, 0.1));
  const knowledge = {
    summary: '[error-pattern] delete item broken',
    categories: ['error-pattern' as const],
    maxConfidence: 0.7,
    sources: [{ type: 'auto-learn' as const, ref: 'kb-1' }],
    // 亲历执行学到的失败（verifiedAt = now ⇒ trust 0.7 ≥ floor 0.2）—— 亲证背书
    fragments: [{ category: 'error-pattern' as const, content: 'delete item button is broken', confidence: 0.7, verifiedAt: Date.now() }],
  };
  const out = await station.decide(env(ctx('delete the record', sc, knowledge)));
  assert.ok(isNeedGrounding(out), '亲证背书 ⇒ 接地成立（压制有现实背书）');
  assert.match(out.reason, /suppressed by error-pattern/);
});

test('核证接地 #3 陈年亲证：60 天前亲证（trust 衰减过线）⇒ 复活探针', async () => {
  const station = new ReflexiveDecisionStation({ chat: null });
  const sc = scene(el('delete item', 0.4, 0.4, 0.2, 0.1));
  const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
  const knowledge = {
    summary: '[error-pattern] delete item broken',
    categories: ['error-pattern' as const],
    maxConfidence: 0.7,
    sources: [{ type: 'auto-learn' as const, ref: 'kb-1' }],
    // 陈年亲证：conf 0.7 × 0.5^(60/30) = 0.175 < floor 0.2 —— 世界可能已变（忏悔复活通道）
    fragments: [{ category: 'error-pattern' as const, content: 'delete item button is broken', confidence: 0.7, verifiedAt: sixtyDaysAgo }],
  };
  const out = await station.decide(env(ctx('delete the record', sc, knowledge)));
  assert.ok(!isNeedGrounding(out), '陈年亲证衰减过线 ⇒ 复活探针（世界会变，亲证会过期）');
  assert.match(out.rationale ?? '', /probe\(verified-grounding\)/);
});

test('核证接地 #4 弧缺席：传闻压制 + 无被压制的本能弧 ⇒ 无从探针，诚实接地', async () => {
  const station = new ReflexiveDecisionStation({ chat: null });
  // intent 与元素零重合 ⇒ 反射弧缺席（no arc）—— 探针无从放行
  const sc = scene(el('close', 0.8, 0.05));
  const knowledge = {
    summary: '[error-pattern] close broken',
    categories: ['error-pattern' as const],
    maxConfidence: 0.7,
    sources: [],
    fragments: [{ category: 'error-pattern' as const, content: 'close button is broken', confidence: 0.7 }],
  };
  const out = await station.decide(env(ctx('open settings panel', sc, knowledge)));
  assert.ok(isNeedGrounding(out), '无弧可探 ⇒ 诚实接地');
  assert.match(out.reason, /suppressed by error-pattern/);
});

test('核证接地 #5 改道优先：压制 + 前额叶活路在场 ⇒ 探针不登场（workflow 托举）', async () => {
  const station = new ReflexiveDecisionStation({ chat: null });
  // intent 与两元素零词汇重合（no arc）⇒ 前额叶全权：陷阱 veto + workflow 托举活路
  const sc = scene(el('delete item', 0.4, 0.4, 0.2, 0.1), el('clear log', 0.7, 0.7, 0.2, 0.1));
  const knowledge = {
    summary: '[error-pattern] delete item broken; [workflow] clear log',
    categories: ['error-pattern' as const, 'workflow' as const],
    maxConfidence: 0.7,
    sources: [],
    fragments: [
      { category: 'error-pattern' as const, content: 'delete item button is broken', confidence: 0.7 },
      { category: 'workflow' as const, content: 'clear log after erasing records', confidence: 0.6 },
    ],
  };
  const out = await station.decide(env(ctx('erase the record', sc, knowledge)));
  assert.ok(!isNeedGrounding(out), '活路在场 ⇒ 改道优先，探针不登场');
  assert.ok((out as any).args.x > 0.7, `应点 clear log（x≈0.8），实际 ${(out as any).args.x}`);
  assert.match(out.rationale ?? '', /deliberation/, '改道来自前额叶仿真');
});

test('核证接地 #6 无证据面兼容：fragments 缺席的压制 ⇒ 门控无从评估，诚实接地（旧方言）', async () => {
  const station = new ReflexiveDecisionStation({ chat: null });
  const sc = scene(el('delete item', 0.4, 0.4, 0.2, 0.1));
  // 旧实现/预算截断的注入（无 fragments）⇒ 信任门控无从评估 ⇒ 保守诚实接地
  const knowledge = {
    summary: '[error-pattern] delete item broken',
    categories: ['error-pattern' as const],
    maxConfidence: 0.7,
    sources: [],
  };
  const out = await station.decide(env(ctx('delete the record', sc, knowledge)));
  assert.ok(isNeedGrounding(out), '无证据面 ⇒ 不探针（无从评估信任），诚实接地');
  assert.match(out.reason, /suppressed by error-pattern/);
});
