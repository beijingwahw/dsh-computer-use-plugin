// test/vlm.providers.ensemble.test.ts
// 纪元 Σ（Σ-1 全军升维）：云脑合议庭契约测试。
// 铁律：全离线 —— 手写假 VisionProvider 桩（可控 chat/chatJson 返回 / 延迟 /
// 失败 / 违约上抛）；createEnsembleCourt 铸造用注入 fetchImpl + 环境变量控制法
// 验证（进席 / 跳过 / 去重 / 空席）；融合数值断言复算真 normalizedLevenshtein
// 与真 arbitrateElements 的数学期望。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  EnsembleQuery,
  EnsembleMemberResult,
} from '../src/vlm/providers/ensemble.ts';
import type {
  VisionChatRequest,
  VisionChatResult,
  VisionProvider,
} from '../src/vlm/providers/types.ts';

const { EnsembleCourt, createEnsembleCourt } = await import('../src/vlm/providers/ensemble.ts');
const { normalizedLevenshtein } = await import('../src/vlm/arbitration.ts');

// ─── 假 VisionProvider 桩：可控成败序列 + 计数器 + json 载荷 ───

/** 单步脚本：chat 成败 / 文本 / 错误 / 注入延迟 / 违约上抛 / chatJson 载荷 */
interface Step {
  ok?: boolean;
  text?: string;
  error?: string;
  latencyMs?: number;
  throwMsg?: string;
  /** chatJson 成功时的解析载荷（raw = JSON.stringify(json)） */
  json?: unknown;
}

/** 假桩附加观测面：调用计数（chat 与 chatJson 共享计数） */
interface FakeProvider extends VisionProvider {
  readonly calls: number;
}

/** 铸假脑：steps 按次消耗，耗尽重复末步；configured 可伪造；chat/chatJson 违约可上抛 */
function fake(id: string, steps: Step[], o: { configured?: boolean } = {}): FakeProvider {
  let calls = 0;
  const model = `m-${id}`;
  const self: FakeProvider = {
    id,
    protocol: 'openai',
    model,
    configured: o.configured ?? true,
    get calls() { return calls; },
    async chat(_r: VisionChatRequest): Promise<VisionChatResult> {
      const step = steps[Math.min(calls, steps.length - 1)] ?? {};
      calls++;
      if (step.throwMsg !== undefined) throw new Error(step.throwMsg);
      if (step.ok === true) {
        return {
          ok: true, text: step.text ?? `ok@${id}`,
          latencyMs: step.latencyMs ?? 5, model, providerId: id,
        };
      }
      return {
        ok: false, text: '', error: step.error ?? `err@${id}`,
        latencyMs: step.latencyMs ?? 5, model, providerId: id,
      };
    },
    async chatJson<T>(_r: VisionChatRequest): Promise<{ ok: boolean; value?: T; error?: string; raw: string }> {
      const step = steps[Math.min(calls, steps.length - 1)] ?? {};
      calls++;
      if (step.throwMsg !== undefined) throw new Error(step.throwMsg);
      if (step.ok === true) {
        if (step.json !== undefined) {
          const raw = typeof step.json === 'string' ? step.json : JSON.stringify(step.json);
          return { ok: true, value: step.json as T, raw };
        }
        const text = step.text ?? `ok@${id}`;
        return { ok: true, value: text as T, raw: text };
      }
      return { ok: false, error: step.error ?? `err@${id}`, raw: '' };
    },
  };
  return self;
}

/** 最小合法问询（timeoutMs 短防长定时器；question 供 askElements 聚焦） */
function q(o: Partial<EnsembleQuery> & { question?: string } = {}): EnsembleQuery & { question?: string } {
  return { images: [{ base64: 'QUJD' }], prompt: '看图说话', timeoutMs: 200, ...o };
}

/** 浮点近似相等 */
const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;

// ─── Σ-1a 单家直通 degraded + 构造期卫生 ───

test('Σ-1a: 单家庭单家直通 —— quorum degraded、agreement 1、普查精确；构造期垃圾/去重', async () => {
  const a = fake('a', [{ ok: true, text: '唯一答案', latencyMs: 7 }]);
  const court = new EnsembleCourt([a]);
  assert.equal(court.size, 1);
  const r = await court.askText(q());
  assert.equal(r.text, '唯一答案', '单家直通');
  assert.equal(r.agreement, 1, '自证恒等 ⇒ agreement 1');
  assert.equal(r.quorum, 'degraded', '单席无法互相作证 —— 诚实降级档');
  assert.deepEqual(r.members, [{ id: 'a', ok: true, text: '唯一答案', latencyMs: 7 }]);

  // 构造期卫生：垃圾条目剔除 + 同 id 去重先到先得
  const dirty = new EnsembleCourt([
    undefined as never, null as never,
    fake('x', [{ ok: true }]), fake('x', [{ ok: true, text: '后来者' }]),
    fake('y', [{ ok: true }]),
  ]);
  assert.equal(dirty.size, 2, '垃圾剔除 + 同 id 去重');
  const r2 = await dirty.askText(q());
  assert.equal(r2.members.length, 2);
  assert.equal(r2.members[0]!.id, 'x');
  assert.ok(!r2.members[0]!.text.includes('后来者'), '同 id 先到先得');
});

// ─── Σ-1b 全败 / 空庭 ⇒ degraded 空答案 ───

test('Σ-1b: 全线失败与空庭 —— text 空串、agreement 0、degraded、普查保留错误现场', async () => {
  const court = new EnsembleCourt([
    fake('a', [{ ok: false, error: 'err-a' }]),
    fake('b', [{ ok: false, error: 'err-b', latencyMs: 9 }]),
  ]);
  const r = await court.askText(q());
  assert.equal(r.text, '');
  assert.equal(r.agreement, 0);
  assert.equal(r.quorum, 'degraded');
  assert.equal(r.members.length, 2);
  assert.deepEqual(
    r.members.map(m => [m.id, m.ok, m.error]),
    [['a', false, 'err-a'], ['b', false, 'err-b']],
    '普查保留各席归因',
  );
  assert.equal(r.members[1]!.latencyMs, 9);

  // 空庭：三问皆降级形态，绝不抛
  const empty = new EnsembleCourt([]);
  assert.equal(empty.size, 0);
  const rt = await empty.askText(q());
  assert.deepEqual(rt, { text: '', agreement: 0, quorum: 'degraded', members: [] });
  const rv = await empty.askVerdict(q());
  assert.deepEqual(rv, { verdict: 'uncertain', confidence: 0, dissents: [], members: [] });
  const re = await empty.askElements(q());
  assert.deepEqual(re, { elements: [], fusedFrom: 0 });
});

// ─── Σ-1c 双家/三家一致 unanimous ───

test('Σ-1c: 三家两同一异拼 unanimous —— 拼写级分歧（sim 0.75）≥0.7 同簇', async () => {
  const A = '确认按钮';
  const B = '确认按钮';
  const C = '确认按纽'; // 一字之差：sim(A,C) = 1 - 1/4 = 0.75 ≥ 0.7
  assert.ok(near(normalizedLevenshtein(A, C), 0.75), '前提自检：拼写给分线之上');
  const court = new EnsembleCourt([
    fake('a', [{ ok: true, text: A }]),
    fake('b', [{ ok: true, text: B }]),
    fake('c', [{ ok: true, text: C }]),
  ]);
  const r = await court.askText(q());
  assert.equal(r.quorum, 'unanimous', '传递闭包归同簇 ⇒ 全体一致');
  assert.equal(r.text, A, '代表簇首家文本');
  assert.ok(near(r.agreement, (1 + 0.75 + 0.75) / 3), 'agreement = 两两相似度均值');
  // 双家完全一致的最小合议
  const twin = new EnsembleCourt([
    fake('a', [{ ok: true, text: '完全一致' }]),
    fake('b', [{ ok: true, text: '完全一致' }]),
  ]);
  const r2 = await twin.askText(q());
  assert.equal(r2.quorum, 'unanimous');
  assert.equal(r2.agreement, 1);
  assert.equal(r2.text, '完全一致');
});

// ─── Σ-1d 三家两票 majority（文本取多数簇） ───

test('Σ-1d: 三家两票 majority —— 最大簇占比 2/3 ≥ 0.5，text 取多数簇首家', async () => {
  const A = '设置按钮在右上角';
  const B = '设置按钮在右上角.'; // sim(A,B) = 1 - 1/7 ≈ 0.857 同簇
  const C = '我不知道设置在哪里，请提供更多上下文信息才能回答这个问题';
  assert.ok(normalizedLevenshtein(A, B) >= 0.7 && normalizedLevenshtein(A, C) < 0.7, '前提自检');
  const court = new EnsembleCourt([
    fake('a', [{ ok: true, text: A }]),
    fake('b', [{ ok: true, text: B }]),
    fake('c', [{ ok: true, text: C }]),
  ]);
  const r = await court.askText(q());
  assert.equal(r.quorum, 'majority');
  assert.equal(r.text, A, '多数簇首家的文本（座次序，无置信可选）');
  const expected = (normalizedLevenshtein(A, B) + normalizedLevenshtein(A, C) + normalizedLevenshtein(B, C)) / 3;
  assert.ok(near(r.agreement, expected), 'agreement 复算真 normalizedLevenshtein 均值');
  assert.ok(r.members.every(m => m.ok));
});

// ─── Σ-1e 意见分裂 split ───

test('Σ-1e: 意见分裂 split —— 三簇各一票、最大簇占比 1/3 < 0.5、text 仍取首簇首家', async () => {
  const court = new EnsembleCourt([
    fake('a', [{ ok: true, text: '是' }]),
    fake('b', [{ ok: true, text: '否' }]),
    fake('c', [{ ok: true, text: '不知道' }]),
  ]);
  const r = await court.askText(q());
  assert.equal(r.quorum, 'split');
  assert.equal(r.text, '是', '分裂也如实上报代表簇（并列取成员序最小）');
  assert.equal(r.agreement, 0, '两两相似度全 0');
  assert.equal(r.members.length, 3);
});

// ─── Σ-1f 一家失败（含违约上抛）其余继续合议 ───

test('Σ-1f: 一家失败其余继续 —— 成员失败/上抛收敛为普查记账，不带崩整庭', async () => {
  const court = new EnsembleCourt([
    fake('boom', [{ throwMsg: '恶意上抛' }]),
    fake('b', [{ ok: true, text: '同意此观点' }]),
    fake('c', [{ ok: true, text: '同意此观点' }]),
  ]);
  const r = await court.askText(q());
  assert.equal(r.quorum, 'unanimous', '幸存两家一致 ⇒ 仍可定谳');
  assert.equal(r.text, '同意此观点');
  assert.equal(r.members[0]!.ok, false);
  assert.ok(r.members[0]!.error!.includes('恶意上抛'), '上抛收敛为错误串');
  assert.equal(r.members[1]!.ok, true);
  assert.equal(r.members[2]!.ok, true);
});

// ─── Σ-1g 未配置成员普查（不拨号） ───

test('Σ-1g: 未配置成员 —— 普查记 not configured、零拨号，不挤占幸存者直通', async () => {
  const dead = fake('dead', [{ ok: true }], { configured: false });
  const alive = fake('alive', [{ ok: true, text: '独苗答案' }]);
  const court = new EnsembleCourt([dead, alive]);
  const r = await court.askText(q());
  assert.equal(dead.calls, 0, '未配置 ⇒ 零拨号');
  assert.equal(alive.calls, 1);
  assert.equal(r.members[0]!.ok, false);
  assert.ok(r.members[0]!.error!.includes('not configured'));
  assert.equal(r.text, '独苗答案', '唯一成功家直通');
  assert.equal(r.quorum, 'degraded');
});

// ─── Σ-1h askVerdict 多数票 confirmed ───

test('Σ-1h: askVerdict 多数票 —— confirmed 胜出，confidence = 胜方均值×占比，dissents 点名少数派', async () => {
  const court = new EnsembleCourt([
    fake('a', [{ ok: true, json: { verdict: 'confirmed', confidence: 0.8 } }]),
    fake('b', [{ ok: true, json: { verdict: 'confirmed', confidence: 0.6 } }]),
    fake('c', [{ ok: true, json: { verdict: 'refuted', confidence: 0.9 } }]),
  ]);
  const r = await court.askVerdict(q({ prompt: '图中是否有保存按钮？' }));
  assert.equal(r.verdict, 'confirmed');
  assert.ok(near(r.confidence, ((0.8 + 0.6) / 2) * (2 / 3)), '0.7 × 2/3 ≈ 0.4667');
  assert.deepEqual(r.dissents, ['c:refuted'], '少数派点名 `${id}:${verdict}`');
  assert.equal(r.members.length, 3);
  assert.ok(r.members.every(m => m.ok));
  assert.ok(r.members.every(m => m.text.includes('"verdict"')), 'json 路径 text 记 raw 原文');
});

// ─── Σ-1i askVerdict 平票 ⇒ uncertain ───

test('Σ-1i: askVerdict 平票 —— 1:1 ⇒ uncertain、confidence 0、双方皆列 dissents', async () => {
  const court = new EnsembleCourt([
    fake('a', [{ ok: true, json: { verdict: 'confirmed', confidence: 0.9 } }]),
    fake('b', [{ ok: true, json: { verdict: 'refuted', confidence: 0.9 } }]),
  ]);
  const r = await court.askVerdict(q());
  assert.equal(r.verdict, 'uncertain');
  assert.equal(r.confidence, 0);
  assert.deepEqual(r.dissents, ['a:confirmed', 'b:refuted'], '无一票成为判决 ⇒ 票票皆异议');
});

// ─── Σ-1j askVerdict 垃圾载荷 ⇒ uncertain ───

test('Σ-1j: askVerdict 垃圾载荷 —— 脏 verdict/缺字段/调用失败均不入票池 ⇒ uncertain', async () => {
  const court = new EnsembleCourt([
    fake('a', [{ ok: true, json: { verdict: 'banana', confidence: 0.9 } }]),
    fake('b', [{ ok: true, json: { answer: 42 } }]),
    fake('c', [{ ok: false, error: 'err-c' }]),
  ]);
  const r = await court.askVerdict(q());
  assert.equal(r.verdict, 'uncertain', '0:0 有效票 = 平票同律');
  assert.equal(r.confidence, 0);
  assert.deepEqual(r.dissents, [], '无有效票 ⇒ 无异议可点名');
  assert.equal(r.members[2]!.ok, false, '失败席位普查如实记账');
});

// ─── Σ-1k askVerdict refuted 多数 + confidence 夹逼 ───

test('Σ-1k: askVerdict refuted 多数 —— confidence = 0.75×2/3 = 0.5；缺省 confidence 记中性 0.5', async () => {
  const court = new EnsembleCourt([
    fake('a', [{ ok: true, json: { verdict: 'confirmed', confidence: 0.9 } }]),
    fake('b', [{ ok: true, json: { verdict: 'refuted', confidence: 0.7 } }]),
    fake('c', [{ ok: true, json: { verdict: 'refuted' } }]), // confidence 缺席 ⇒ 中性 0.5
  ]);
  const r = await court.askVerdict(q());
  assert.equal(r.verdict, 'refuted');
  assert.ok(near(r.confidence, ((0.7 + 0.5) / 2) * (2 / 3)), '0.6 × 2/3 = 0.4');
  assert.deepEqual(r.dissents, ['a:confirmed']);
});

// ─── Σ-1l askElements 双家经真 arbitrateElements 融合（数值断言） ───

test('Σ-1l: askElements 双家融合 —— 凸组合框/置信加成/角色继承的精确复算', async () => {
  // 左席 a（vlm 侧）：bbox 数组形态 [0,0,100,100] conf 0.8
  const a = fake('a', [{
    ok: true,
    json: { elements: [{ label: '设置', role: 'button', bbox: [0, 0, 100, 100], confidence: 0.8 }] },
  }]);
  // 右席 b（local 侧）：与 a IoU=8100/11900≈0.68 ≥0.5 配对 + 一个不相交单源元素
  const b = fake('b', [{
    ok: true,
    json: {
      elements: [
        { label: '设置入口', role: 'link', bbox: { x0: 10, y0: 10, x1: 110, y1: 110 }, confidence: 0.6 },
        { label: '关闭', role: 'icon', bbox: { x0: 500, y0: 500, x1: 600, y1: 600 }, confidence: 0.9 },
      ],
    },
  }]);
  const court = new EnsembleCourt([a, b]);
  const r = await court.askElements(q({ prompt: '列出可点击元素', question: '找到设置入口' }));
  assert.equal(r.fusedFrom, 2);
  assert.equal(r.elements.length, 2, '一对融合 + 一个右席单源直通');
  const fused = r.elements[0]!;
  // 融合框：wv=0.8/1.4、wl=0.6/1.4 ⇒ 每坐标凸组合
  assert.ok(near(fused.bbox.x0, 30 / 7), 'x0 = 0×(4/7)+10×(3/7) = 30/7');
  assert.ok(near(fused.bbox.y0, 30 / 7));
  assert.ok(near(fused.bbox.x1, 730 / 7), 'x1 = 100×(4/7)+110×(3/7) = 730/7');
  assert.ok(near(fused.bbox.y1, 730 / 7));
  assert.ok(near(fused.center.x, 380 / 7) && near(fused.center.y, 380 / 7));
  assert.ok(near(fused.confidence, 0.85), 'min(1,(0.8+0.6)/2+0.15)');
  assert.equal(fused.label, '设置', 'cv 0.8 ≥ cl 0.6 ⇒ 左席标签');
  assert.equal(fused.role, 'button', '左席位序原位继承 role');
  assert.equal(fused.source, 'vlm');
  const only = r.elements[1]!;
  assert.deepEqual(only.bbox, { x0: 500, y0: 500, x1: 600, y1: 600 }, '右席单源 bbox 原样直通');
  assert.equal(only.label, '关闭');
  assert.equal(only.role, 'icon', 'bbox 指纹回查右席找回 role');
  assert.ok(near(only.confidence, 0.9));
  assert.equal(only.id, 'e2', 'id 统一重排');
});

// ─── Σ-1m askElements 单家直通 / 全败 / 垃圾载荷 ───

test('Σ-1m: askElements 单家直通（无仲裁）与全败/垃圾载荷归空', async () => {
  const court = new EnsembleCourt([fake('a', [{
    ok: true,
    json: {
      elements: [
        { label: '保存', role: 'button', bbox: [10, 20, 110, 70], confidence: 0.9 },
        { label: '取消', bbox: { x0: 200, y0: 20, x1: 300, y1: 70 } }, // role/confidence 缺席
      ],
    },
  }])]);
  const r = await court.askElements(q({ prompt: '列出元素' }));
  assert.equal(r.fusedFrom, 1, '单家 = 直通无仲裁');
  assert.equal(r.elements.length, 2);
  const e1 = r.elements[0]!;
  assert.equal(e1.label, '保存');
  assert.equal(e1.role, 'button');
  assert.ok(near(e1.confidence, 0.9));
  assert.deepEqual(e1.bbox, { x0: 10, y0: 20, x1: 110, y1: 70 }, 'bbox 数组转对象');
  assert.ok(near(e1.center.x, 60) && near(e1.center.y, 45));
  const e2 = r.elements[1]!;
  assert.equal(e2.role, 'unknown', 'role 缺席兜底');
  assert.ok(near(e2.confidence, 0.5), 'confidence 缺席记中性 0.5');
  // 全败与垃圾载荷 ⇒ 空元素表
  const failed = new EnsembleCourt([fake('x', [{ ok: false, error: 'err-x' }])]);
  assert.deepEqual(await failed.askElements(q()), { elements: [], fusedFrom: 0 });
  const garbage = new EnsembleCourt([fake('y', [{ ok: true, json: { elements: '不是数组' } }])]);
  assert.deepEqual(await garbage.askElements(q()), { elements: [], fusedFrom: 0 });
});

// ─── Σ-1n askElements 三家累进折叠 ───

test('Σ-1n: askElements 三家折叠 —— 两轮融合置信 0.8→0.95→1.0，框不动', async () => {
  const element = (conf: number): { json: unknown; ok: boolean } => ({
    ok: true,
    json: { elements: [{ label: '确定', role: 'button', bbox: [0, 0, 100, 100], confidence: conf }] },
  });
  const court = new EnsembleCourt([fake('a', [element(0.8)]), fake('b', [element(0.8)]), fake('c', [element(0.8)])]);
  const r = await court.askElements(q({ prompt: '列出元素' }));
  assert.equal(r.fusedFrom, 3);
  assert.equal(r.elements.length, 1);
  const e = r.elements[0]!;
  // 第 1 折：min(1, 0.8+0.15)=0.95；第 2 折：min(1, (0.95+0.8)/2+0.15)=min(1,1.025)=1
  assert.ok(near(e.confidence, 1));
  assert.deepEqual(e.bbox, { x0: 0, y0: 0, x1: 100, y1: 100 }, '同位框凸组合不动');
  assert.equal(e.label, '确定');
  assert.equal(e.role, 'button', '折叠后 role 原位继承');
});

// ─── Σ-1o createEnsembleCourt 铸造（env 控制法 + 注入 fetchImpl） ───

/** env 控制法三件套：涉及的环境变量全量备份 → 清场 → 测后还原 */
const ENV_KEYS = [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'DASHSCOPE_API_KEY', 'ALIYUN_API_KEY', 'GLM_API_KEY', 'ZHIPUAI_API_KEY', 'ZAI_API_KEY',
] as const;
const savedEnv = ENV_KEYS.map(k => [k, process.env[k]] as const);
function restoreEnv(): void {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

test('Σ-1o: createEnsembleCourt 铸造 —— env 控制法下的进席/跳过/去重/空席/合议闭环', async () => {
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.OPENAI_API_KEY = 'sk-o';
    process.env.ANTHROPIC_API_KEY = 'sk-a';

    // URL 分派假 fetch：openai/anthropic 各回己方成功形状（同文本 ⇒ unanimous）
    const dispatch = (async (url: unknown) => {
      if (String(url).includes('api.openai.com')) {
        return new Response(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: '一致答案' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (String(url).includes('api.anthropic.com')) {
        return new Response(
          JSON.stringify({ content: [{ type: 'text', text: '一致答案' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{"error":{"message":"boom"}}', {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    // 主力 openai（env 钥匙）+ anthropic（env 钥匙）；qwen 无钥跳过；openai 重复去重；nope 查无预设跳过
    const court = createEnsembleCourt({
      provider: 'openai',
      extraProviders: ['anthropic', 'qwen', 'openai', 'nope'],
      fetchImpl: dispatch,
    });
    assert.equal(court.size, 2, 'qwen 无钥跳过、openai 去重、nope 查无跳过');
    const ans = await court.askText(q({ prompt: '图中是什么？' }));
    assert.equal(ans.quorum, 'unanimous', '真适配器离线闭环：双席异构同辞');
    assert.equal(ans.text, '一致答案');
    assert.deepEqual(ans.members.map(m => [m.id, m.ok]), [['openai', true], ['anthropic', true]]);

    // 主力查无预设 ⇒ 主力席位空缺，extra 续铸（庭不因主力缺席而解散）
    assert.equal(createEnsembleCourt({ provider: 'nope', extraProviders: ['anthropic'] }).size, 1);
    // 全无 ⇒ 空庭
    assert.equal(createEnsembleCourt().size, 0);
    assert.equal(createEnsembleCourt({ provider: 'nope' }).size, 0);
    // localAuthOptional：ollama 本机免钥进席，qwen 无钥跳过
    const local = createEnsembleCourt({ provider: 'openai', extraProviders: ['ollama', 'qwen'] });
    assert.equal(local.size, 2);

    // 主力查有预设但无钥 ⇒ 照常入席（configured:false 诚实降级，普查记 not configured）
    delete process.env.ANTHROPIC_API_KEY;
    const keyless = createEnsembleCourt({ provider: 'anthropic' });
    assert.equal(keyless.size, 1);
    const r = await keyless.askText(q());
    assert.equal(r.quorum, 'degraded');
    assert.equal(r.text, '');
    assert.equal(r.members[0]!.ok, false);
    assert.ok(r.members[0]!.error!.includes('not configured'));
  } finally {
    restoreEnv();
  }
});

// ─── ΑΩ-R35 成本闸：maxParallel / maxSessionCalls（缺省 = 全量并问不变） ───

test('ΑΩ-R35: maxParallel 成本闸 —— 座次序占席、超席零拨号、普查记 skipped due to budget', async () => {
  const a = fake('a', [{ ok: true, text: '占席答案' }]);
  const b = fake('b', [{ ok: true, text: '占席答案' }]);
  const c = fake('c', [{ ok: true, text: '席三' }]);
  const court = new EnsembleCourt([a, b, c], { maxParallel: 2 });
  const r = await court.askText(q());
  assert.equal(a.calls, 1, '座次序在前者先占席');
  assert.equal(b.calls, 1);
  assert.equal(c.calls, 0, '第三席超闸 ⇒ 零拨号');
  assert.deepEqual(
    r.members.map(m => [m.id, m.ok]),
    [['a', true], ['b', true], ['c', false]],
    '普查表仍与庭员数等长（诚实透传，绝不静默丢席）',
  );
  assert.match(r.members[2]!.error!, /skipped due to budget/, 'skipped-due-budget 归因在普查条目');
  assert.match(r.members[2]!.error!, /maxParallel 2 reached/);
  assert.equal(r.members[2]!.latencyMs, 0);
  assert.equal(r.quorum, 'unanimous', '占席两家照常合议');

  // 未配置席不占预算：dead 在首位不烧 maxParallel 名额
  const dead = fake('dead', [{ ok: true }], { configured: false });
  const alive1 = fake('a1', [{ ok: true, text: 'x' }]);
  const alive2 = fake('a2', [{ ok: true, text: 'x' }]);
  const gated = new EnsembleCourt([dead, alive1, alive2], { maxParallel: 2 });
  const r2 = await gated.askText(q());
  assert.equal(dead.calls, 0);
  assert.equal(alive1.calls, 1);
  assert.equal(alive2.calls, 1, '未配置席不占预算 ⇒ 两席配置脑全数拨号');
  assert.match(r2.members[0]!.error!, /not configured/);

  // 脏值安静缺席 = 不设限（全量并问，既往行为不变）
  const dirty = new EnsembleCourt([a, b, c], { maxParallel: 0, maxSessionCalls: -3 });
  await dirty.askText(q());
  assert.equal(a.calls + b.calls + c.calls >= 3, true, '脏闸值忽略 ⇒ 全员照拨');
});

test('ΑΩ-R35: maxSessionCalls 会话预算 —— 庭生命周期拨号封顶、耗尽后全员 skipped-due-budget', async () => {
  const a = fake('a', [{ ok: true, text: '一次' }]);
  const b = fake('b', [{ ok: true, text: '一次' }]);
  const court = new EnsembleCourt([a, b], { maxSessionCalls: 3 });
  const q1 = await court.askText(q());
  assert.equal(q1.quorum, 'unanimous', '第 1 问（2 次拨号）预算内全量并问');
  assert.equal(a.calls, 1);
  assert.equal(b.calls, 1);
  const q2 = await court.askText(q());
  assert.equal(a.calls, 2, '第 2 问只剩 1 席预算 —— 座次序 a 占席再拨一次');
  assert.equal(b.calls, 1, '预算只容 1 席 ⇒ b 第 2 问零拨号');
  assert.equal(q2.members[0]!.ok, true);
  assert.match(q2.members[1]!.error!, /skipped due to budget/);
  assert.match(q2.members[1]!.error!, /session call budget exhausted \(3\/3\)/);
  assert.equal(q2.quorum, 'degraded', '单家直通降级档');
  const q3 = await court.askText(q());
  assert.equal(a.calls, 2, '预算耗尽 ⇒ 零拨号');
  assert.equal(b.calls, 1, 'b 两问合计仍只拨过 1 次');
  assert.ok(q3.members.every(m => m.ok === false && /skipped due to budget/.test(m.error ?? '')), '全员 skipped 记账');
  assert.deepEqual({ text: '', agreement: 0, quorum: 'degraded' }, { text: q3.text, agreement: q3.agreement, quorum: q3.quorum });
});

// ─── Σ-1p 恶意桩绝不抛（脏返回 + 双路违约上抛） ───

test('Σ-1p: 恶意桩绝不抛 —— 脏返回与双路违约上抛全收敛为成员失败', async () => {
  const junk: VisionProvider = {
    id: 'junk',
    protocol: 'openai',
    model: 'm',
    configured: true,
    chat: async () => undefined as unknown as VisionChatResult,
    chatJson: async () => { throw new Error('json 通道炸了'); },
  };
  const boom: VisionProvider = {
    id: 'boom',
    protocol: 'openai',
    model: 'm',
    configured: true,
    chat: async () => { throw new Error('chat 通道炸了'); },
    chatJson: async () => { throw new Error('json 通道也炸了'); },
  };
  const court = new EnsembleCourt([boom, junk]);
  // 三问全部收敛 —— await 本身不抛即不抛铁律成立
  const rt = await court.askText(q());
  assert.equal(rt.quorum, 'degraded');
  assert.equal(rt.text, '');
  assert.deepEqual(
    rt.members.map(m => [m.id, m.ok]),
    [['boom', false], ['junk', false]],
    '座次对齐的普查记账',
  );
  assert.ok(rt.members[0]!.error!.includes('chat 通道炸了'));
  assert.ok(rt.members[1]!.error !== undefined, '脏返回收敛为失败记账');
  const rv = await court.askVerdict(q());
  assert.deepEqual(
    { ...rv, members: rv.members.map((m: EnsembleMemberResult) => m.ok) },
    { verdict: 'uncertain', confidence: 0, dissents: [], members: [false, false] },
  );
  const re = await court.askElements(q());
  assert.deepEqual(re, { elements: [], fusedFrom: 0 });
});

// ─── ΝΩ-47 loglinear 折叠模式：连折置信膨胀修正（opt-in，缺省 classic 饱和律不动） ───

test('ΝΩ-47: askElements loglinear —— 基线 0.8 五家连折不饱和（数值断言新公式）；classic 对照组仍饱和', async () => {
  const element = (conf: number): { json: unknown; ok: boolean } => ({
    ok: true,
    json: { elements: [{ label: '确定', role: 'button', bbox: [0, 0, 100, 100], confidence: conf }] },
  });
  const mkCourt = (o: { fuseMode?: 'classic' | 'loglinear' }) =>
    new EnsembleCourt(
      ['a', 'b', 'c', 'd', 'e'].map(id => fake(id, [element(0.8)])),
      o,
    );
  // loglinear 手算（c1 = 0.8；c_k = (c_{k-1} + 0.8)/2 + 0.15/√k）：
  //   c2 = 0.8 + 0.15/√2                 = 0.9060660172
  //   c3 = (c2+0.8)/2 + 0.15/√3          = 0.9396355490
  //   c4 = (c3+0.8)/2 + 0.075            = 0.9448177745
  //   c5 = (c4+0.8)/2 + 0.15/√5          = 0.9394909266 —— 收敛于基线上方的有界小增益
  const r = await mkCourt({ fuseMode: 'loglinear' }).askElements(q({ prompt: '列出元素' }));
  assert.equal(r.fusedFrom, 5);
  assert.equal(r.elements.length, 1, '同位框五家合一');
  const e = r.elements[0]!;
  assert.ok(near(e.confidence, 0.9394909265668524), `实际 ${e.confidence} ≈ 手算 0.9394909266`);
  assert.ok(e.confidence < 1, '五家连折不饱和至 1（classic 两折即触顶）');
  assert.deepEqual(e.bbox, { x0: 0, y0: 0, x1: 100, y1: 100 }, '同位框凸组合不动');
  assert.equal(e.label, '确定');
  assert.equal(e.role, 'button', '折叠后 role 原位继承');

  // classic 对照组（缺省）：同五家仍按旧律饱和（Σ-1n 已钉死 0.8→0.95→1 的膨胀）
  const classic = await mkCourt({}).askElements(q({ prompt: '列出元素' }));
  assert.equal(classic.elements[0]!.confidence, 1, '缺省 classic 旧行为逐字节保持');
  // 脏 fuseMode 字面量安静归 classic（不抛铁律）
  const dirty = await mkCourt({ fuseMode: 'banana' as never }).askElements(q({ prompt: '列出元素' }));
  assert.equal(dirty.elements[0]!.confidence, 1, '脏模式归 classic');
});
