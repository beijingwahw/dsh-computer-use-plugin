// test/reflexiveDecision.test.ts
// 反射决策工位（ReflexiveDecisionStation）—— 桩纪元终结者的执法点测试。
// 既有路径各有独立测试：脊髓反射 / 免疫抑制 / 反射弧缺席 / 平票歧义 + 前额叶
// 仿真 / 核证探针；ΝΩ-16 增级联仲裁组（反射先行、LLM 断后）+ DS-3 嵌入缓存
// + DS-4 闩锁升级。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReflexiveDecisionStation, embedCached } from '../src/knowledge/stations.ts';
import { embed } from '../src/semanticHash.ts';
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

// ─── ΝΩ-16 级联仲裁：反射先行、LLM 断后（反转「LLM 独裁坍缩」）───
// 旧律 chat 在场 ⇒ 一切交 LLM（Tier0/1/2/2.5 全旁路）；新律恒序级联。

test('级联 #1 LLM 在场 + 明确反射命中 ⇒ 反射直发不调 LLM（计数断言）+ 轨迹记 reflex', async () => {
  let calls = 0;
  const chat = async () => {
    calls += 1;
    return '{"type":"action","action":{"kind":"type_text","args":{"text":"x"}},"rationale":"llm says"}';
  };
  const station = new ReflexiveDecisionStation({ chat });
  const sc = scene(el('settings', 0.1, 0.1, 0.2, 0.1), el('close', 0.8, 0.05));
  const out = await station.decide(env(ctx('open settings', sc)));
  assert.equal(calls, 0, '无歧义反射命中 ⇒ 零 LLM 调用（延迟/成本归零）');
  assert.ok(!isNeedGrounding(out), `期望反射动作，得到 ${JSON.stringify(out)}`);
  assert.equal(out.kind, 'click_mouse', '反射弧直发（而非 LLM 的 type_text）');
  assert.match(out.rationale ?? '', /reflex.*'settings'/, '审计轨迹：反射依据可回放');
  assert.equal((out as any).tierUsed, 'reflex', '决策轨迹层别标注：reflex');
});

test('级联 #2 LLM 在场 + 压制命中 ⇒ prompt 含压制证据（两级语义），LLM 绕行非被否决', async () => {
  const prompts: string[] = [];
  const chat = async (p: string) => {
    prompts.push(p);
    return '{"type":"action","action":{"kind":"click_mouse","args":{"x":0.9,"y":0.9}},"rationale":"llm reroute"}';
  };
  const station = new ReflexiveDecisionStation({ chat });
  // 本能弧会命中 'delete item'（唯一词重合）—— 但 error-pattern 0.7 ≥ 0.55 压制
  const sc = scene(el('delete item', 0.4, 0.4, 0.2, 0.1));
  const knowledge = {
    summary: '[error-pattern] delete item broken',
    categories: ['error-pattern' as const],
    maxConfidence: 0.7,
    sources: [{ type: 'manual' as const, ref: 'kb-1' }],
    fragments: [{ category: 'error-pattern' as const, content: 'delete item button is broken', confidence: 0.7 }],
  };
  const out = await station.decide(env(ctx('delete the record', sc, knowledge)));
  assert.equal(prompts.length, 1, '压制 ⇒ 交大脑绕行（证据注入），而非直接否决 LLM');
  assert.match(prompts[0], /IMMUNE SUPPRESSION ACTIVE/, '压制声明入 prompt（一级确定性语义）');
  assert.match(prompts[0], /delete item button is broken/, '陷阱证据入 prompt（二级咨询性语义）');
  assert.ok(!isNeedGrounding(out), 'LLM 绕行成功 ⇒ 动作成立');
  assert.match(out.rationale ?? '', /llm reroute/);
  assert.equal((out as any).tierUsed, 'llm', '决策轨迹层别标注：llm');
  // 被压制的本能弧绝不发射：直发坐标（delete item 中心 x=0.5）不得出现
  assert.ok(Math.abs((out as any).args.x - 0.5) > 0.01, `LLM 绕行坐标 ≠ 被压制本能弧坐标，实际 ${(out as any).args.x}`);
});

test('级联 #3 平票歧义 ⇒ LLM 终审 + Tier2 效用排序提示注入（提示非指令，可推翻）', async () => {
  const prompts: string[] = [];
  const chat = async (p: string) => {
    prompts.push(p);
    // 大脑故意推翻提示：点 settings（x=0.15）而非提示偏向的 settings panel（x=0.55）
    return '{"type":"action","action":{"kind":"click_mouse","args":{"x":0.15,"y":0.15}},"rationale":"brain overrules"}';
  };
  const station = new ReflexiveDecisionStation({ chat });
  const sc = scene(el('settings', 0.1, 0.1), el('settings panel', 0.5, 0.5));
  const knowledge = {
    summary: '[workflow] open settings panel via sidebar',
    categories: ['workflow' as const],
    maxConfidence: 0.9,
    sources: [],
    fragments: [{ category: 'workflow' as const, content: 'open settings panel via sidebar', confidence: 0.9 }],
  };
  const out = await station.decide(env(ctx('open settings', sc, knowledge)));
  assert.equal(prompts.length, 1, '平票歧义 ⇒ 交大脑');
  assert.match(prompts[0], /RANKING HINT/, 'Tier2 效用评分作为排序提示入 prompt');
  assert.match(prompts[0], /settings panel/, '提示携带仿真胜者证据');
  assert.ok(!isNeedGrounding(out));
  assert.equal((out as any).args.x, 0.15, '大脑可推翻提示（裁决权在模型）');
  assert.equal((out as any).tierUsed, 'llm');
});

test('级联 #4 LLM 在场 + 无反射弧 ⇒ 大脑断后；无证据面 ⇒ 无伪造排序提示；大脑接地即接地', async () => {
  const prompts: string[] = [];
  const chat = async (p: string) => {
    prompts.push(p);
    return '{"type":"need-grounding","reason":"brain needs semantics","focus":"full-scene"}';
  };
  const station = new ReflexiveDecisionStation({ chat });
  const sc = scene(el('close', 0.8, 0.05), el('minimize', 0.7, 0.05));
  const out = await station.decide(env(ctx('open settings panel', sc)));
  assert.equal(prompts.length, 1, '无弧 ⇒ 大脑断后');
  assert.doesNotMatch(prompts[0], /RANKING HINT/, '无证据面 ⇒ 排序提示诚实缺席');
  assert.ok(isNeedGrounding(out), '大脑的接地就是接地');
  assert.match(out.reason, /brain needs semantics/);
});

test('级联 #5 压制 + 大脑通道故障 ⇒ 压制接地兜底（最坏情形 = 诚实停手，绝不是本能弧）', async () => {
  const chat = async (): Promise<string> => { throw new Error('channel down'); };
  const station = new ReflexiveDecisionStation({ chat });
  const sc = scene(el('delete item', 0.4, 0.4, 0.2, 0.1));
  const knowledge = {
    summary: '[error-pattern] delete item broken',
    categories: ['error-pattern' as const],
    maxConfidence: 0.7,
    sources: [],
    fragments: [{ category: 'error-pattern' as const, content: 'delete item button is broken', confidence: 0.7 }],
  };
  const out = await station.decide(env(ctx('delete the record', sc, knowledge)));
  assert.ok(isNeedGrounding(out), '大脑故障 ⇒ 压制接地兜底');
  assert.match(out.reason, /suppressed by error-pattern/);
  assert.equal(out.focus, 'knowledge');
});

test('级联 #6 重试语境（chat 在场）⇒ 反射复读让位大脑（失败上下文随行 prompt）', async () => {
  const prompts: string[] = [];
  const chat = async (p: string) => {
    prompts.push(p);
    return '{"type":"action","action":{"kind":"click_mouse","args":{"x":0.9,"y":0.9}},"rationale":"retry reroute"}';
  };
  const station = new ReflexiveDecisionStation({ chat });
  const sc = scene(el('settings', 0.1, 0.1)); // 唯一命中 —— 但这是重试
  const out = await station.decide(
    env(ctx('open settings', sc)),
    { reason: 'click timed out', retryCount: 1 },
  );
  assert.equal(prompts.length, 1, '首次发射已失败 ⇒ 确定性复读交大脑（保守原则）');
  assert.match(prompts[0], /LAST FAILURE/, '失败上下文入 prompt');
  assert.equal((out as any).tierUsed, 'llm');
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

// ─── DS-3（ΝΩ-16 顺修）：仿真层文本嵌入的进程级 LRU 缓存 ───

test('DS-3 嵌入缓存命中：同文本返回同一引用（零重算），值与裸 embed 同源', async () => {
  const text = 'ds3 cache probe 整理数据';
  const a = embedCached(text);
  const b = embedCached(text);
  assert.ok(a === b, '命中 = 同一对象引用（缓存生效，非重算）');
  assert.deepEqual(b.dims, embed(text).dims, '缓存值与裸 embed 同源（纯函数零漂移）');
  const c = embedCached('ds3 distinct text');
  assert.ok(c !== a, '不同文本 ⇒ 不同向量对象');
});

test('DS-3 容量执法：1025 新键 ⇒ 最旧者被逐（LRU 非全清），逐出只损失缓存不损失正确性', async () => {
  const first = embedCached('ds3-evict-0');
  for (let i = 1; i <= 1024; i++) embedCached(`ds3-evict-${i}`);
  const survivorA = embedCached('ds3-evict-1'); // 邻近较新键：仍应命中
  const reFirst = embedCached('ds3-evict-0'); // 最旧键：已被逐 ⇒ 重算
  assert.ok(reFirst !== first, '容量 1024 ⇒ 最旧键逐出后重算（新引用）');
  assert.deepEqual(reFirst.dims, first.dims, '逐出只损失缓存不损失正确性');
  const survivorB = embedCached('ds3-evict-1');
  assert.ok(survivorA === survivorB, 'LRU 语义：较新键仍命中（非全清）');
});

// ─── DS-4（ΝΩ-16 顺修）：探针闩锁进程级升级（学习闭环容量断裂的跨 run 续护）───

/** 传闻压制场景铸造（探针触发条件全齐：heresay error-pattern ≥ 阈值 + 会命中的本能弧） */
function hearsayTrapEnv(intentId: string) {
  const sc = scene(el('delete item', 0.4, 0.4, 0.2, 0.1));
  const knowledge = {
    summary: '[error-pattern] delete item broken',
    categories: ['error-pattern' as const],
    maxConfidence: 0.7,
    sources: [{ type: 'manual' as const, ref: 'kb-1' }],
    fragments: [{ category: 'error-pattern' as const, content: 'delete item button is broken', confidence: 0.7 }],
  };
  return env({
    intent: { id: intentId, description: 'delete the record' },
    scene: sc,
    knowledgeContext: knowledge,
  });
}

test('DS-4 闩锁升级：容量断裂上报 ⇒ 跨工位实例续护（新实例不再重付探针学费）', async () => {
  // 病灶复现：探针失败的学习若被容量拒绝，跨实例闩锁为空 ⇒ 新 run 再探一针
  const a = new ReflexiveDecisionStation({ chat: null });
  const outA = await a.decide(hearsayTrapEnv('ds4-a'));
  assert.ok(!isNeedGrounding(outA));
  assert.match(outA.rationale ?? '', /probe\(verified-grounding\)/, 'run A 探针放行（传闻无背书）');
  const b = new ReflexiveDecisionStation({ chat: null });
  const outB = await b.decide(hearsayTrapEnv('ds4-a'));
  assert.ok(!isNeedGrounding(outB));
  assert.match(outB.rationale ?? '', /probe\(verified-grounding\)/, '病灶：实例闩锁不跨实例 ⇒ run B 重付学费');
  // 修复：pipeline 侧 learnFromOutcome 容量拒绝上报（接线缝）⇒ 闩锁升进程级
  b.escalateProbeLatch('ds4-a');
  const c = new ReflexiveDecisionStation({ chat: null });
  const outC = await c.decide(hearsayTrapEnv('ds4-a'));
  assert.ok(isNeedGrounding(outC), '进程级闩锁续护 ⇒ 不再探针，诚实接地');
  assert.match(outC.reason, /suppressed by error-pattern/);
});

test('DS-4 闩锁衰减：1h 过线自动解除（容量拒绝可被上游清库 —— 复活通道不焊死）', async () => {
  const stale = new ReflexiveDecisionStation({ chat: null });
  // 时间旅行缝：61 分钟前升级 ⇒ 已过 decay 线
  stale.escalateProbeLatch('ds4-d', Date.now() - 61 * 60 * 1000);
  const outD = await stale.decide(hearsayTrapEnv('ds4-d'));
  assert.ok(!isNeedGrounding(outD));
  assert.match(outD.rationale ?? '', /probe\(verified-grounding\)/, '衰减过线 ⇒ 闩锁自动解除，探针复活');

  const fresh = new ReflexiveDecisionStation({ chat: null });
  fresh.escalateProbeLatch('ds4-e'); // 缺省墙钟（刚刚）⇒ 闩锁生效
  const outE = await fresh.decide(hearsayTrapEnv('ds4-e'));
  assert.ok(isNeedGrounding(outE), '未过衰减线 ⇒ 进程级闩锁照常执法');
  assert.match(outE.reason, /suppressed by error-pattern/);
});
