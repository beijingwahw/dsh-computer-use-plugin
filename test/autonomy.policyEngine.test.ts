// test/autonomy.policyEngine.test.ts
// 纪元 Φ（Φ-3 · 自主判断中枢）：policyEngine 全离线验证 —— 假 client 注入，绝不联网。
// 覆盖：七级确定性决策序 ①弹窗 ②判据匹配点击 ③文本宣称 ④僵局切换 ⑤技能召回
// ⑥预算升级 ⑦云脑兜底/未配置降级；关键词提取（中文 2-gram / 英文单词 / 停用词 /
// 纯数字 / 纪元 Δ WeakMap 缓存契约）；弹窗确认词面扩表（确定/同意/是/yes + 反例
// 取消/否/稍后仍走 Esc）；不确定判定（低置信 / 候选并列）与云脑咨询命中 / 越界回退 /
// 失败回退 / 异常回退；rationale / expectedEffect 非空与 utility 值域不变式。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PolicyEngine,
  extractGoalKeywords,
  type AutonomyActionKind,
  type PolicyAction,
  type PolicyContext,
} from '../src/autonomy/policyEngine.ts';
import { resetGlmClient, type GlmClient as GlmClientLike } from '../src/vlm/glmClient.ts';
import type { SnapshotElement, WorldSnapshot } from '../src/autonomy/worldSnapshot.ts';
import type { GoalSpec, GoalProgress } from '../src/autonomy/goalState.ts';

// ─── 假件与工厂 ───

/** 假 chatJson 响应 —— 与 GlmClient.chatJson 契约同构 */
interface ChatJsonResp { ok: boolean; value?: unknown; error?: string; raw: string }

/** 注入用假 client —— 只实现 policyEngine 消费的 chatJson，并捕获每次请求 */
function fakeClient(
  respond: (call: { prompt: string; images: unknown[] }) => ChatJsonResp | Promise<ChatJsonResp>,
): { client: GlmClientLike; calls: Array<{ prompt: string; images: unknown[] }> } {
  const calls: Array<{ prompt: string; images: unknown[] }> = [];
  const stub = {
    chatJson: async (req: { prompt?: unknown; images?: unknown }): Promise<ChatJsonResp> => {
      const call = {
        prompt: typeof req.prompt === 'string' ? req.prompt : '',
        images: Array.isArray(req.images) ? req.images : [],
      };
      calls.push(call);
      return respond(call);
    },
  };
  return { client: stub as unknown as GlmClientLike, calls };
}

/** 恒成功的假 client（大多数用例只关决策序本身，不关云脑） */
function idleClient(): { client: GlmClientLike; calls: Array<{ prompt: string; images: unknown[] }> } {
  return fakeClient(() => ({ ok: true, raw: '', value: { index: 0, reason: 'unused' } }));
}

/** 元素工厂 —— bbox 缺省 {10,20,110,60}，center 取几何中心 */
function elem(label: string, o: Partial<SnapshotElement> = {}): SnapshotElement {
  const bbox = o.bbox ?? { x0: 10, y0: 20, x1: 110, y1: 60 };
  return {
    label,
    role: o.role ?? 'button',
    bbox,
    center: o.center ?? { x: (bbox.x0 + bbox.x1) / 2, y: (bbox.y0 + bbox.y1) / 2 },
    confidence: o.confidence ?? 0.8,
    source: o.source ?? 'local',
    interactive: o.interactive === undefined ? true : o.interactive,
  };
}

/** 快照工厂 —— 除覆盖项外全部取安静缺省（无弹窗 / 无聚焦 / 无降级） */
function snap(o: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    takenAt: 1,
    width: o.width ?? 1920,
    height: o.height ?? 1080,
    dhash: o.dhash ?? null,
    elements: o.elements ?? [],
    textDigest: o.textDigest ?? '',
    popups: o.popups ?? [],
    focusedRegion: o.focusedRegion ?? null,
    sceneLabel: o.sceneLabel ?? 'desktop',
    degraded: o.degraded ?? [],
  };
}

/** 目标规格工厂 —— 缺省判据与 prog 工厂联动（「登录」元素可 1.0 命中） */
function spec(o: { goal?: string; successCriteria?: string[]; failureCriteria?: string[] } = {}): GoalSpec {
  return {
    goal: o.goal ?? '打开登录页',
    successCriteria: o.successCriteria ?? ['页面出现「登录」入口'],
    ...(o.failureCriteria ? { failureCriteria: o.failureCriteria } : {}),
  };
}

/** 目标进度工厂 —— 全部判据 unverified */
function prog(criteria: string[]): GoalProgress {
  return {
    phase: 'acting',
    stepIndex: 1,
    criteriaStatus: criteria.map(c => ({ criterion: c, status: 'unverified' as const })),
    startedAt: 1,
    lastUpdateAt: 2,
    blockers: [],
  };
}

/** 决策上下文工厂 —— spec 与 prog 判据自动对齐 */
function ctx(o: {
  snapshot?: Partial<WorldSnapshot>;
  spec?: GoalSpec;
  goal?: GoalProgress;
  history?: PolicyContext['history'];
  skills?: PolicyContext['skills'];
  budgetRemaining?: PolicyContext['budgetRemaining'];
} = {}): PolicyContext {
  const s = o.spec ?? spec();
  return {
    snapshot: snap(o.snapshot ?? {}),
    spec: s,
    goal: o.goal ?? prog(s.successCriteria),
    history: o.history ?? [],
    ...(o.skills !== undefined ? { skills: o.skills } : {}),
    ...(o.budgetRemaining !== undefined ? { budgetRemaining: o.budgetRemaining } : {}),
  };
}

/** 行动史条目用的极简动作字面量 */
function act(kind: AutonomyActionKind): PolicyAction {
  return { kind, rationale: '测试史', expectedEffect: '测试', utility: 0.5, riskTier: 'benign' };
}

// ─── Φ-3a 关键词提取 ───

test('Φ-3a: extractGoalKeywords —— 中文 2-gram、去重保序（goal+criteria 联合分词）', () => {
  assert.equal(typeof extractGoalKeywords, 'function');
  const kw = extractGoalKeywords(spec({ goal: '打开设置页面', successCriteria: ['设置面板可见'] }));
  assert.deepEqual(kw, ['打开', '开设', '设置', '置页', '页面', '置面', '面板', '板可', '可见']);
});

test('Φ-3a: 中英混合分词 —— CJK 段按 2-gram、英文按单词、标点切段、单字中文停用词滤除', () => {
  const kw = extractGoalKeywords(
    spec({ goal: '在 Chrome 中登录 GitHub 账号', successCriteria: ['地址栏包含 github.com 且显示用户名'] }),
  );
  assert.deepEqual(kw, [
    'chrome', '中登', '登录', 'github', '账号',
    '地址', '址栏', '栏包', '包含', 'com', '且显', '显示', '示用', '用户', '户名',
  ]);
  assert.equal(kw.includes('在'), false, '中文单字停用词应被滤除');
});

test('Φ-3a: 纯数字丢弃、英文停用词滤除、failureCriteria 不入关键词流', () => {
  assert.deepEqual(
    extractGoalKeywords(spec({ goal: '输入 12345 并确认', successCriteria: [] })),
    ['输入', '并确', '确认'],
  );
  assert.deepEqual(
    extractGoalKeywords(spec({ goal: 'the user must be logged in', successCriteria: [] })),
    ['user', 'logged'], // must/should/will/can 皆在停用词表
  );
  const kw = extractGoalKeywords(
    spec({ goal: '保存文件', successCriteria: [], failureCriteria: ['磁盘损坏'] }),
  );
  assert.deepEqual(kw, ['保存', '存文', '文件']);
});

test('Φ-3a: 关键词缓存（纪元 Δ）—— 同一 spec 对象复用命中同果，不同对象互不串台', async () => {
  const s = spec({ goal: '打开设置页面', successCriteria: ['设置面板可见'] });
  const first = extractGoalKeywords(s);
  const second = extractGoalKeywords(s);
  assert.deepEqual(second, first, '语义不变式：重复调用结果逐字相同');
  assert.equal(second, first, 'WeakMap 缓存契约：同一 spec 对象命中同一数组（零重分词）');
  const fresh = spec({ goal: '打开设置页面', successCriteria: ['设置面板可见'] });
  const other = extractGoalKeywords(fresh);
  assert.deepEqual(other, first, '不同对象内容同果');
  assert.notEqual(other, first, '不同对象各自计算，缓存按身份隔离');
  // 决策路径多次复用同一 spec：行为与首调逐字一致（缓存透明性）
  const engine = new PolicyEngine();
  const d1 = await engine.decide(ctx({ spec: s }));
  const d2 = await engine.decide(ctx({ spec: s }));
  assert.deepEqual(d2.action, d1.action);
});

// ─── Φ-3b ① 弹窗优先 ───

test('Φ-3b: ① popups 非空且无确认类元素 ⇒ hotkey Esc（payload 恰为 {keys:[esc]}，utility 0.9，压过一切元素匹配）', async () => {
  const { client, calls } = idleClient();
  const engine = new PolicyEngine({ client, useVlmWhenUncertain: true });
  const dec = await engine.decide(
    ctx({ snapshot: snap({ popups: ['是否允许此应用通知'], elements: [elem('登录')] }) }),
  );
  assert.equal(dec.action.kind, 'hotkey');
  assert.deepEqual(dec.action.payload, { keys: ['esc'] });
  assert.equal(dec.action.utility, 0.9);
  assert.equal(dec.action.target, undefined);
  assert.equal(dec.uncertain, false);
  assert.equal(dec.degraded, false);
  assert.match(dec.action.rationale, /弹窗/);
  assert.ok(dec.action.expectedEffect.length > 0);
  assert.equal(calls.length, 0, '弹窗处置确定性动作，不得触云脑');
});

test('Φ-3b: ① 弹窗内确认类元素（允许）⇒ 点击之（utility 0.9）；确认元素不可交互 ⇒ 回退 Esc', async () => {
  const engine = new PolicyEngine();
  const dec = await engine.decide(
    ctx({ snapshot: snap({ popups: ['更新可用'], elements: [elem('稍后'), elem('允许', { confidence: 0.7 })] }) }),
  );
  assert.equal(dec.action.kind, 'click');
  assert.equal(dec.action.target?.label, '允许');
  assert.equal(dec.action.utility, 0.9, '弹窗处置效用恒 0.9（契约），不随元素置信');
  assert.equal(dec.action.riskTier, 'benign');
  assert.match(dec.action.rationale, /弹窗/);

  const esc = await engine.decide(
    ctx({
      snapshot: snap({
        popups: ['更新可用'],
        elements: [elem('允许', { interactive: false }), elem('稍后')],
      }),
    }),
  );
  assert.equal(esc.action.kind, 'hotkey');
  assert.deepEqual(esc.action.payload, { keys: ['esc'] });
});

test('Φ-3b: ① 确认词面扩表（纪元 Δ）—— 确定/同意/是/yes 皆判确认元素并点击，不再反落 Esc', async () => {
  const engine = new PolicyEngine();
  for (const label of ['确定', '同意', '是', 'Yes', 'OK 恢复出厂设置']) {
    const dec = await engine.decide(
      ctx({ snapshot: snap({ popups: ['系统提示'], elements: [elem(label, { confidence: 0.7 })] }) }),
    );
    assert.equal(dec.action.kind, 'click', `label=${label} 应识别为确认类元素`);
    assert.equal(dec.action.target?.label, label);
    assert.equal(dec.action.utility, 0.9, '弹窗处置效用恒 0.9');
  }
  // 混合候选：高置信「取消」不含确认词面，低置信「是(Y)」胜出（确认滤镜先筛再排序）
  const dec = await engine.decide(
    ctx({
      snapshot: snap({
        popups: ['放弃更改？'],
        elements: [elem('取消', { confidence: 0.95 }), elem('是(Y)', { confidence: 0.6 })],
      }),
    }),
  );
  assert.equal(dec.action.kind, 'click');
  assert.equal(dec.action.target?.label, '是(Y)');
});

test('Φ-3b: ① 反例 —— 纯否定/中性词面（取消/否/稍后/关闭）不算确认元素，仍走 Esc', async () => {
  const engine = new PolicyEngine();
  const dec = await engine.decide(
    ctx({ snapshot: snap({ popups: ['放弃更改？'], elements: [elem('取消'), elem('否'), elem('稍后')] }) }),
  );
  assert.equal(dec.action.kind, 'hotkey');
  assert.deepEqual(dec.action.payload, { keys: ['esc'] });
  assert.equal(dec.action.target, undefined);
});

test('Φ-3b: 纯空白 popups 条目不算弹窗 ⇒ 决策序继续走到 ② 元素匹配', async () => {
  const { client } = idleClient();
  const engine = new PolicyEngine({ client });
  const dec = await engine.decide(
    ctx({ snapshot: snap({ popups: ['   '], elements: [elem('登录', { confidence: 0.9 })] }) }),
  );
  assert.equal(dec.action.kind, 'click');
  assert.equal(dec.action.target?.label, '登录');
});

// ─── Φ-3c ② 判据匹配点击 ───

test('Φ-3c: ② 未 met 判据关键词命中可交互元素 ⇒ click 最佳候选（utility=元素置信，target 带几何，零云脑）', async () => {
  const { client, calls } = idleClient();
  const engine = new PolicyEngine({ client, useVlmWhenUncertain: true });
  const dec = await engine.decide(
    ctx({
      snapshot: snap({ elements: [elem('登录', { confidence: 0.88 }), elem('帮助')] }),
    }),
  );
  assert.equal(dec.action.kind, 'click');
  assert.equal(dec.action.target?.label, '登录');
  assert.deepEqual(dec.action.target?.center, { x: 60, y: 40 });
  assert.deepEqual(dec.action.target?.bbox, { x0: 10, y0: 20, x1: 110, y1: 60 });
  assert.equal(dec.action.utility, 0.88);
  assert.equal(dec.uncertain, false);
  assert.equal(dec.degraded, false);
  assert.equal(dec.action.payload?.criterion, '页面出现「登录」入口');
  assert.equal(typeof dec.action.payload?.matchScore, 'number');
  assert.ok(dec.action.rationale.length > 0 && dec.action.expectedEffect.length > 0);
  assert.equal(calls.length, 0, '匹配置信充分（1.0 ≥ 0.55 且无并列）时不得触云脑');
});

test('Φ-3c: interactive===false 的匹配元素被跳过；点击风险词法分层（敏感/破坏）', async () => {
  const { client } = idleClient();
  const engine = new PolicyEngine({ client });
  const dec = await engine.decide(
    ctx({
      spec: spec({ successCriteria: ['完成「发送消息」操作'] }),
      snapshot: snap({
        elements: [elem('删除文件', { interactive: false }), elem('发送消息', { confidence: 0.6 })],
      }),
    }),
  );
  assert.equal(dec.action.kind, 'click');
  assert.equal(dec.action.target?.label, '发送消息', '不可交互的匹配元素不得参选');
  assert.equal(dec.action.riskTier, 'sensitive');

  const destructive = await engine.decide(
    ctx({
      spec: spec({ successCriteria: ['回收站已清空'] }),
      snapshot: snap({ elements: [elem('清空回收站', { confidence: 0.5 })] }),
    }),
  );
  assert.equal(destructive.action.kind, 'click');
  assert.equal(destructive.action.riskTier, 'destructive');
});

// ─── Φ-3d ③ 文本宣称 ───

test('Φ-3d: ③ 无元素匹配但 textDigest 含判据全部关键词 ⇒ declare（utility 0.6，交验证层）；digest 不全 ⇒ 不宣称', async () => {
  const { client, calls } = idleClient();
  const engine = new PolicyEngine({ client });
  const dec = await engine.decide(
    ctx({
      spec: spec({ successCriteria: ['页面显示欢迎语'] }),
      snapshot: snap({ elements: [elem('天气')], textDigest: '本页面显示欢迎语，欢迎回来' }),
    }),
  );
  assert.equal(dec.action.kind, 'declare');
  assert.equal(dec.action.utility, 0.6);
  assert.equal(dec.action.payload?.criterion, '页面显示欢迎语');
  assert.equal(dec.uncertain, false);
  assert.equal(dec.degraded, false);
  assert.equal(calls.length, 0);

  // 反例：digest 缺「示欢/迎语」等关键词 ⇒ 不宣称，落到 ⑦ ask_vlm
  const fallback = await engine.decide(
    ctx({
      spec: spec({ successCriteria: ['页面显示欢迎语'] }),
      snapshot: snap({ elements: [elem('天气')], textDigest: '加载中，请稍候' }),
    }),
  );
  assert.equal(fallback.action.kind, 'ask_vlm');
});

// ─── Φ-3e ④ 僵局切换 ───

test('Φ-3e: ④ 尾部同类 no_effect ≥2 次 ⇒ 切换 scroll（payload 恰为 {direction:down}，utility 0.5）', async () => {
  const { client } = idleClient();
  const engine = new PolicyEngine({ client });
  const dec = await engine.decide(
    ctx({
      snapshot: snap({ elements: [elem('天气')] }),
      history: [
        { action: act('click'), outcome: 'no_effect' },
        { action: act('click'), outcome: 'no_effect' },
      ],
    }),
  );
  assert.equal(dec.action.kind, 'scroll');
  assert.deepEqual(dec.action.payload, { direction: 'down' });
  assert.equal(dec.action.utility, 0.5);
  assert.equal(dec.uncertain, false);
  assert.match(dec.action.rationale, /连续 2 次无效果/);
});

test('Φ-3e: ④ scroll/inspect 轮换 —— 上次切换是 scroll ⇒ 这次 inspect；region 取 focusedRegion，缺省全屏', async () => {
  const { client } = idleClient();
  const engine = new PolicyEngine({ client });
  const dec = await engine.decide(
    ctx({
      snapshot: snap({ elements: [elem('天气')], focusedRegion: { x0: 100, y0: 200, x1: 600, y1: 500 } }),
      history: [
        { action: act('click'), outcome: 'no_effect' },
        { action: act('click'), outcome: 'no_effect' },
        { action: act('scroll'), outcome: 'no_effect' },
      ],
    }),
  );
  assert.equal(dec.action.kind, 'inspect');
  assert.deepEqual(dec.action.payload?.region, { x0: 100, y0: 200, x1: 600, y1: 500 });

  const full = await engine.decide(
    ctx({
      snapshot: snap({ elements: [elem('天气')] }),
      history: [
        { action: act('click'), outcome: 'no_effect' },
        { action: act('click'), outcome: 'no_effect' },
        { action: act('scroll'), outcome: 'no_effect' },
      ],
    }),
  );
  assert.equal(full.action.kind, 'inspect');
  assert.deepEqual(full.action.payload?.region, { x0: 0, y0: 0, x1: 1920, y1: 1080 });
});

test('Φ-3e: 尾部 no_effect 但 kind 交替（无同类成对）⇒ 不触发 ④，落到 ⑦ ask_vlm', async () => {
  const { client } = idleClient();
  const engine = new PolicyEngine({ client });
  const dec = await engine.decide(
    ctx({
      snapshot: snap({ elements: [elem('天气')] }),
      history: [
        { action: act('click'), outcome: 'no_effect' },
        { action: act('scroll'), outcome: 'no_effect' },
      ],
    }),
  );
  assert.equal(dec.action.kind, 'ask_vlm');
});

// ─── Φ-3f ⑤ 技能召回 ───

test('Φ-3f: ⑤ 技能描述与目标重合 ⇒ recall_skill（utility=reliability×0.8，取重合技能中可靠度最高者）；无重合 ⇒ 跳过', async () => {
  const { client } = idleClient();
  const engine = new PolicyEngine({ client });
  const dec = await engine.decide(
    ctx({
      spec: spec({ goal: '打开浏览器并登录账号', successCriteria: ['登录成功'] }),
      skills: [
        { id: 'login-flow', description: '在浏览器中打开网页并登录账号', reliability: 0.9 },
        { id: 'weather', description: '查询天气预报', reliability: 0.99 },
      ],
    }),
  );
  assert.equal(dec.action.kind, 'recall_skill');
  assert.equal(dec.action.payload?.skillId, 'login-flow');
  assert.ok(Math.abs((dec.action.utility as number) - 0.72) < 1e-9, `utility 应为 0.9×0.8，实得 ${dec.action.utility}`);
  assert.match(dec.action.rationale, /login-flow/);

  const none = await engine.decide(
    ctx({
      spec: spec({ goal: '打开浏览器并登录账号', successCriteria: ['登录成功'] }),
      skills: [{ id: 'weather', description: '查询天气预报', reliability: 0.99 }],
    }),
  );
  assert.equal(none.action.kind, 'ask_vlm', '无重合技能不得召回');
});

// ─── Φ-3g ⑥ 预算升级 / ⑦ 云脑兜底 ───

test('Φ-3g: ⑥ 预算将尽（steps≤2 或 ms≤15000）⇒ escalate utility 0.4；预算尚足则不升级', async () => {
  const { client } = idleClient();
  const engine = new PolicyEngine({ client });
  const bySteps = await engine.decide(
    ctx({ snapshot: snap({ elements: [elem('天气')] }), budgetRemaining: { steps: 2, ms: 60000 } }),
  );
  assert.equal(bySteps.action.kind, 'escalate');
  assert.equal(bySteps.action.utility, 0.4);
  assert.equal(bySteps.action.payload?.reason, 'budget-low');
  assert.equal(bySteps.action.payload?.stepsLeft, 2);

  const byMs = await engine.decide(
    ctx({ snapshot: snap({ elements: [elem('天气')] }), budgetRemaining: { steps: 50, ms: 15000 } }),
  );
  assert.equal(byMs.action.kind, 'escalate');

  const ample = await engine.decide(
    ctx({ snapshot: snap({ elements: [elem('天气')] }), budgetRemaining: { steps: 3, ms: 16000 } }),
  );
  assert.equal(ample.action.kind, 'ask_vlm', '步数 3 > 2 且毫秒 16000 > 15000 不得升级');
});

test('Φ-3g: ⑦ 兜底 ask_vlm —— uncertain:true、问题含目标、且 decide 自身不拨号（执行层持图发问）', async () => {
  const { client, calls } = idleClient();
  const engine = new PolicyEngine({ client });
  const dec = await engine.decide(ctx({ snapshot: snap({ elements: [elem('天气')] }) }));
  assert.equal(dec.action.kind, 'ask_vlm');
  assert.equal(dec.uncertain, true);
  assert.equal(dec.degraded, false);
  assert.equal(dec.action.utility, 0.3);
  assert.match(String(dec.action.payload?.question), /打开登录页/);
  assert.ok(dec.action.rationale.length > 0 && dec.action.expectedEffect.length > 0);
  assert.equal(calls.length, 0, 'ask_vlm 是动作不是调用：决策中枢无像素，发问由执行层执行');
});

// ─── Φ-3h ⑦ 未配置降级（环境变量受控，绝不联网） ───

test('Φ-3h: 云脑未配置（无注入 client 且环境无 key）⇒ escalate + degraded:true', async () => {
  const keys = ['GLM_API_KEY', 'ZHIPUAI_API_KEY', 'ZAI_API_KEY'] as const;
  const saved = keys.map(k => [k, process.env[k]] as const);
  try {
    for (const k of keys) delete process.env[k];
    resetGlmClient(); // 清掉可能的已配置单例，保证 isGlmConfigured 走环境变量重探测
    const engine = new PolicyEngine(); // 无任何注入
    const dec = await engine.decide(ctx({ snapshot: snap({ elements: [elem('天气')] }) }));
    assert.equal(dec.action.kind, 'escalate');
    assert.equal(dec.degraded, true);
    assert.equal(dec.uncertain, true);
    assert.equal(dec.action.payload?.reason, 'no-deterministic-action');
    assert.match(dec.action.rationale, /未配置/);
  } finally {
    for (const [k, v] of saved) { if (v !== undefined) process.env[k] = v; }
    resetGlmClient();
  }
});

// ─── Φ-3i 不确定判定与云脑咨询 ───

test('Φ-3i: 候选并列（分差 <0.05）⇒ uncertain ⇒ 云脑咨询命中 ⇒ 采纳云脑所选（而非确定性最佳）', async () => {
  const { client, calls } = fakeClient(() => ({
    ok: true, raw: '', value: { index: 1, reason: '登录是系统入口' },
  }));
  const engine = new PolicyEngine({ client, useVlmWhenUncertain: true });
  const dec = await engine.decide(
    ctx({
      spec: spec({ goal: '进入系统', successCriteria: ['登录系统成功'] }),
      snapshot: snap({
        elements: [
          elem('登录', { confidence: 0.7 }),
          elem('系统', { confidence: 0.95, bbox: { x0: 200, y0: 200, x1: 400, y1: 260 } }),
        ],
      }),
    }),
  );
  // 确定性排序应为「系统」（同分取置信高者），云脑选 index 1 ⇒「登录」
  assert.equal(dec.action.kind, 'click');
  assert.equal(dec.action.target?.label, '登录');
  assert.equal(dec.action.utility, 0.7);
  assert.deepEqual(dec.action.target?.center, { x: 60, y: 40 });
  assert.equal(dec.uncertain, true, '本地证据并列，uncertain 保持');
  assert.equal(dec.degraded, false);
  assert.match(String(dec.note), /云脑/);
  assert.equal(calls.length, 1, '只咨询一次');
  assert.match(calls[0].prompt, /登录系统成功/, '提示词应含未达成判据');
  assert.match(calls[0].prompt, /index/, '提示词应索要 index');
  assert.deepEqual(calls[0].images, [], '快照无像素，纯文本语义仲裁');
  assert.match(dec.action.rationale, /云脑/);
});

test('Φ-3i: 云脑越界 / 调用失败 / 抛异常 ⇒ 一律回退确定性最佳并标 degraded:true，绝不 reject', async () => {
  const snapshot = snap({
    elements: [
      elem('登录', { confidence: 0.7 }),
      elem('系统', { confidence: 0.95 }),
    ],
  });
  const base = { spec: spec({ goal: '进入系统', successCriteria: ['登录系统成功'] }), snapshot };

  const oob = fakeClient(() => ({ ok: true, raw: '', value: { index: 99, reason: '手滑' } }));
  const d1 = await new PolicyEngine({ client: oob.client }).decide(ctx(base));
  assert.equal(d1.action.kind, 'click');
  assert.equal(d1.action.target?.label, '系统', '越界 ⇒ 回退确定性最佳（同分取置信高者）');
  assert.equal(d1.action.utility, 0.95);
  assert.equal(d1.degraded, true);
  assert.equal(d1.uncertain, true);
  assert.match(String(d1.note), /越界/);

  const fail = fakeClient(() => ({ ok: false, error: 'mock glm outage', raw: '' }));
  const d2 = await new PolicyEngine({ client: fail.client }).decide(ctx(base));
  assert.equal(d2.action.target?.label, '系统');
  assert.equal(d2.degraded, true);
  assert.ok((d2.note ?? '').length > 0);

  const boom = fakeClient(() => { throw new Error('boom'); });
  const d3 = await new PolicyEngine({ client: boom.client }).decide(ctx(base));
  assert.equal(d3.action.kind, 'click');
  assert.equal(d3.action.target?.label, '系统');
  assert.equal(d3.degraded, true);
  assert.match(String(d3.note), /异常/);
});

test('Φ-3i: 匹配置信不足（<0.55）⇒ uncertain；useVlmWhenUncertain=false ⇒ 零咨询、保留确定性选择', async () => {
  const { client, calls } = idleClient();
  const engine = new PolicyEngine({ client, useVlmWhenUncertain: false });
  const dec = await engine.decide(
    ctx({
      snapshot: snap({ elements: [elem('注册登录', { confidence: 0.66 })] }),
    }),
  );
  // 标签 3 个 token 仅「登录」命中判据 ⇒ 覆盖率 1/3 < 0.55 ⇒ uncertain
  assert.equal(dec.action.kind, 'click');
  assert.equal(dec.action.target?.label, '注册登录');
  assert.equal(dec.action.utility, 0.66);
  assert.equal(dec.uncertain, true);
  assert.equal(dec.degraded, false);
  assert.equal(calls.length, 0, '咨询开关关闭时不得拨号');
});

// ─── Φ-3j 鲁棒性与输出不变式 ───

test('Φ-3j: 绝不抛异常 —— null/空 ctx / 垃圾元素数组均收敛为合法决策', async () => {
  const { client } = idleClient();
  const engine = new PolicyEngine({ client });
  // null ctx：全字段防御缺省 ⇒ 走完决策序落到 ⑦，而非异常
  const d1 = await engine.decide(null as unknown as PolicyContext);
  assert.ok(['ask_vlm', 'escalate'].includes(d1.action.kind));

  const d2 = await engine.decide({} as PolicyContext);
  assert.ok(['ask_vlm', 'escalate'].includes(d2.action.kind));

  // 毒化属性访问抛错 ⇒ 收敛为内部异常升级（catch 臂执法）
  const poisoned = {
    snapshot: { get elements(): never { throw new Error('poison'); } },
  } as unknown as PolicyContext;
  const d4 = await engine.decide(poisoned);
  assert.equal(d4.action.kind, 'escalate');
  assert.equal(d4.degraded, true);
  assert.equal(d4.action.payload?.reason, 'policy-engine-internal-error');

  const junk = await engine.decide(
    ctx({
      snapshot: snap({
        elements: [null, 5, 'x', { label: '登录' }] as unknown as SnapshotElement[],
      }),
    }),
  );
  assert.equal(junk.action.kind, 'click');
  assert.equal(junk.action.target?.label, '登录');
});

test('Φ-3j: 输出不变式 —— 各级决策的 rationale/expectedEffect 恒非空中文、utility ∈ [0,1]、riskTier 三值之一', async () => {
  const { client } = idleClient();
  const engine = new PolicyEngine({ client });
  const scenarios: PolicyContext[] = [
    ctx({ snapshot: snap({ popups: ['提示'], elements: [elem('允许')] }) }),                       // ①
    ctx({ snapshot: snap({ elements: [elem('登录', { confidence: 0.88 })] }) }),                    // ②
    ctx({ spec: spec({ successCriteria: ['页面显示欢迎语'] }), snapshot: snap({ textDigest: '页面显示欢迎语' }) }), // ③
    ctx({ snapshot: snap({ elements: [elem('天气')] }), history: [{ action: act('click'), outcome: 'no_effect' }, { action: act('click'), outcome: 'no_effect' }] }), // ④
    ctx({ spec: spec({ goal: '打开浏览器并登录账号', successCriteria: ['登录成功'] }), skills: [{ id: 's1', description: '浏览器登录账号流程', reliability: 0.8 }] }), // ⑤
    ctx({ snapshot: snap({ elements: [elem('天气')] }), budgetRemaining: { steps: 1, ms: 5000 } }),  // ⑥
    ctx({ snapshot: snap({ elements: [elem('天气')] }) }),                                          // ⑦
  ];
  for (const c of scenarios) {
    const dec = await engine.decide(c);
    assert.ok(dec.action.rationale.length >= 4, `rationale 非空：${dec.action.kind}`);
    assert.ok(dec.action.expectedEffect.length >= 4, `expectedEffect 非空：${dec.action.kind}`);
    assert.ok(dec.action.utility >= 0 && dec.action.utility <= 1, `utility 值域：${dec.action.utility}`);
    assert.ok(['benign', 'sensitive', 'destructive'].includes(dec.action.riskTier));
    assert.equal(typeof dec.uncertain, 'boolean');
    assert.equal(typeof dec.degraded, 'boolean');
  }
});
