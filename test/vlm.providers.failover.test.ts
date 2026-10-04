// test/vlm.providers.failover.test.ts
// 纪元 Ψ（Ψ-6 万脑归一）：多脑故障切换池契约测试。
// 铁律：全离线 —— 手写假 VisionProvider 桩（可控 ok 序列 / 调用计数 / 可注入
// latencyMs，绝不真实联网）；熔断经时钟注入拨针复算；createProviderPool 铸造
// 用注入 fetchImpl + 环境变量控制法验证（进池 / 跳过 / 去重 / 空池）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { VisionChatRequest, VisionChatResult, VisionProvider } from '../src/vlm/providers/types.ts';

const {
  ProviderPool, createProviderPool, resolveProviderConfig, getPreset,
} = await import('../src/vlm/providers/failover.ts');

// ─── 假 VisionProvider 桩：可控成败序列 + 计数器 ───

/** 单步脚本：ok 成败 / 文本 / 错误 / 注入延迟 / 违约上抛 */
interface Step {
  ok?: boolean;
  text?: string;
  error?: string;
  latencyMs?: number;
  throwMsg?: string;
}

/** 假桩附加观测面：调用计数与最近一次请求的 jsonMode */
interface FakeProvider extends VisionProvider {
  readonly calls: number;
  readonly lastJsonMode: boolean | undefined;
}

/** 铸假脑：steps 按次消耗，耗尽重复末步；configured/baseUrl 可伪造；chat 违约可上抛 */
function fake(id: string, steps: Step[], o: { configured?: boolean; baseUrl?: string } = {}): FakeProvider {
  let calls = 0;
  let lastJsonMode: boolean | undefined;
  const model = `m-${id}`;
  const self: FakeProvider = {
    id,
    protocol: 'openai',
    model,
    ...(o.baseUrl !== undefined ? { baseUrl: o.baseUrl } : {}),
    configured: o.configured ?? true,
    get calls() { return calls; },
    get lastJsonMode() { return lastJsonMode; },
    async chat(r: VisionChatRequest): Promise<VisionChatResult> {
      const step = steps[Math.min(calls, steps.length - 1)] ?? {};
      calls++;
      lastJsonMode = r?.jsonMode === true;
      if (step.throwMsg !== undefined) throw new Error(step.throwMsg);
      if (step.ok === true) {
        return { ok: true, text: step.text ?? `ok@${id}`, latencyMs: step.latencyMs ?? 7, model, providerId: id };
      }
      return {
        ok: false, text: '', error: step.error ?? `err@${id}`,
        latencyMs: step.latencyMs ?? 7, model, providerId: id,
      };
    },
    async chatJson<T>(r: VisionChatRequest): Promise<{ ok: boolean; value?: T; error?: string; raw: string }> {
      const res = await self.chat(r);
      return res.ok
        ? { ok: true, value: res.text as T, raw: res.text }
        : { ok: false, error: res.error, raw: res.text };
    },
  };
  return self;
}

/** 最小合法请求（maxRetries 0 —— 池测试无重试等待；timeoutMs 短防长定时器） */
function req(o: Partial<VisionChatRequest> = {}): VisionChatRequest {
  return { images: [{ base64: 'QUJD' }], prompt: '看图说话', timeoutMs: 200, maxRetries: 0, ...o };
}

// ─── Ψ-6a 主力成功零切换 ───

test('Ψ-6a: 主力成功零切换 —— 直传主力结果，备脑零调用，notes 零噪音', async () => {
  const a = fake('glm', [{ ok: true, text: '主力回复' }]);
  const b = fake('qwen', [{ ok: true }]);
  const pool = new ProviderPool([a, b]);
  assert.equal(pool.size, 2);
  assert.deepEqual(pool.ids, ['glm', 'qwen']);
  const r = await pool.chat(req());
  assert.equal(r.ok, true);
  assert.equal(r.providerId, 'glm');
  assert.equal(r.text, '主力回复');
  assert.equal(r.model, 'm-glm');
  assert.equal(b.calls, 0, '主力成功 ⇒ 备脑零调用');
  assert.equal(pool.notes.length, 0, '零切换零噪音');
});

// ─── Ψ-6b 主力失败备补位 ───

test('Ψ-6b: 主力失败备补位 —— providerId 归因备脑，note 记切换决策', async () => {
  const a = fake('glm', [{ ok: false, error: 'glm http 500 after 1 attempt' }]);
  const b = fake('qwen', [{ ok: true, text: '备脑回复' }]);
  const pool = new ProviderPool([a, b]);
  const r = await pool.chat(req());
  assert.equal(r.ok, true);
  assert.equal(r.providerId, 'qwen', '备脑补位 —— providerId 即归因');
  assert.equal(r.text, '备脑回复');
  assert.equal(a.calls, 1);
  assert.equal(b.calls, 1);
  assert.ok(pool.notes.some(n => n.includes('glm') && n.includes('切换')), 'note 记了人话切换决策');
});

// ─── Ψ-6c 兄弟适配器违约上抛 —— 收敛切脑 ───

test('Ψ-6c: 兄弟适配器违约上抛 —— 池收敛为失败并继续切脑，绝不外抛', async () => {
  const a = fake('a', [{ throwMsg: '契约违约上抛' }]);
  const b = fake('b', [{ ok: true, text: 'b 脑接住' }]);
  const pool = new ProviderPool([a, b]);
  const r = await pool.chat(req());
  assert.equal(r.ok, true);
  assert.equal(r.providerId, 'b');
  assert.ok(pool.notes.some(n => n.includes('a') && n.includes('切换')));
});

// ─── Ψ-6d 熔断 open 跳行 + 冷却期回闭 ───

test('Ψ-6d: 熔断 open 跳行 —— 连败越阈后主力零调用，冷却期满自动回闭', async () => {
  let t = 1_000; // 可拨时钟 —— 熔断全程离线复算
  const a = fake('a', [{ ok: false, error: '挂了' }]); // 恒败主力
  const b = fake('b', [{ ok: true, text: 'b 脑' }]);
  const pool = new ProviderPool([a, b], {
    breakers: { failureThreshold: 2, cooldownMs: 60_000 },
    now: () => t,
  });
  assert.equal((await pool.chat(req())).providerId, 'b', '第 1 败：a 连败 1，b 补位');
  assert.equal((await pool.chat(req())).providerId, 'b', '第 2 败：a 连败 2 ⇒ 熔断 open');
  assert.equal(a.calls, 2);
  assert.equal(pool.health()[0].state, 'open');
  const r3 = await pool.chat(req()); // 第 3 次：a 已 open ⇒ 跳行
  assert.equal(a.calls, 2, '熔断 open ⇒ 主力零调用（整行跳过）');
  assert.equal(r3.ok, true);
  assert.equal(r3.providerId, 'b');
  assert.ok(pool.notes.some(n => n.includes('熔断')), 'note 记了熔断跳行决策');
  assert.equal(pool.health()[1].state, 'closed', '备脑屡胜不熔');
  t += 60_000; // 拨针越过冷却期 —— 半开语义惰性回闭
  assert.equal(pool.health()[0].state, 'closed', '冷却期满自动回 closed');
});

// ─── Ψ-6e 全败返回末败 ───

test('Ψ-6e: 全线失败 —— 回传最后一个失败结果（真实归因与错误现场）', async () => {
  const a = fake('a', [{ ok: false, error: 'err-a' }]);
  const b = fake('b', [{ ok: false, error: 'err-b' }]);
  const pool = new ProviderPool([a, b]);
  const r = await pool.chat(req());
  assert.equal(r.ok, false);
  assert.equal(r.providerId, 'b', '全败 ⇒ 最后一个失败者');
  assert.equal(r.error, 'err-b');
  assert.equal(r.text, '');
  assert.equal(r.degraded, undefined, '有脑真败 ≠ 未配置降级');
  assert.ok(pool.notes.some(n => n.includes('全线失败')));
});

// ─── Ψ-6f 空池 / 全员被跳 ⇒ 合成 degraded；垃圾条目剔除 ───

test('Ψ-6f: 空池合成 degraded —— 精确形状；未配置全员被跳同律；垃圾条目剔除', async () => {
  const empty = new ProviderPool([]);
  assert.equal(empty.size, 0);
  assert.deepEqual(empty.ids, []);
  const r = await empty.chat(req());
  assert.deepEqual(r, {
    ok: false, degraded: true, error: 'no provider available',
    providerId: 'pool', model: '', text: '', latencyMs: 0,
  });
  // 非空池但全员被跳（未配置）⇒ 同样合成 degraded
  const skipped = new ProviderPool([fake('a', [{ ok: true }], { configured: false })]);
  const r2 = await skipped.chat(req());
  assert.equal(r2.ok, false);
  assert.equal(r2.degraded, true);
  assert.equal(r2.providerId, 'pool');
  // 构造期垃圾条目安静剔除（不抛铁律在构造期即生效）
  const dirty = new ProviderPool([undefined as never, null as never, fake('x', [{ ok: true }])]);
  assert.equal(dirty.size, 1);
  assert.deepEqual(dirty.ids, ['x']);
});

// ─── Ψ-6g note 环形 10 条 ───

test('Ψ-6g: note 环形缓冲 —— 只留最近 10 条，溢出丢最老，空白丢弃', () => {
  const pool = new ProviderPool([fake('a', [{ ok: true }])]);
  for (let i = 1; i <= 12; i++) pool.note(`决策${i}`);
  assert.equal(pool.notes.length, 10);
  assert.equal(pool.notes[0], '决策3', '最老两条被挤出环');
  assert.equal(pool.notes[9], '决策12');
  assert.deepEqual(pool.notes.slice(0, 2), ['决策3', '决策4']);
  pool.note('   ');
  pool.note('');
  assert.equal(pool.notes.length, 10, '空白/空串安静丢弃');
});

// ─── Ψ-6h health 快照 ───

test('Ψ-6h: health 快照 —— id/configured/熔断态三件套，只读不改状态', async () => {
  const a = fake('a', [{ ok: false }]);
  const b = fake('b', [{ ok: false }]);
  const c = fake('c', [{ ok: false }], { configured: false });
  const pool = new ProviderPool([a, b, c], {
    breakers: { failureThreshold: 1, cooldownMs: 60_000 },
    now: () => 5_000,
  });
  assert.deepEqual(pool.health(), [
    { id: 'a', configured: true, state: 'closed' },
    { id: 'b', configured: true, state: 'closed' },
    { id: 'c', configured: false, state: 'closed' },
  ]);
  await pool.chat(req());
  const h = pool.health();
  assert.equal(h[0].state, 'open', 'a 一败即熔（threshold 1）');
  assert.equal(h[1].state, 'open');
  assert.equal(h[2].state, 'closed', '未配置脑未被调用，熔断不动');
  assert.equal(h[2].configured, false);
});

// ─── Ψ-6i chatJson 提取 / 失败 ───

test('Ψ-6i: chatJson —— 强制 jsonMode + 剥壳提取；无 JSON / 全败两路失败', async () => {
  // 备脑补位后提取成功（围栏剥壳 + jsonMode 透传断言）
  const a = fake('a', [{ ok: false }]);
  const b = fake('b', [{ ok: true, text: '```json\n{"x":1}\n```' }]);
  const pool = new ProviderPool([a, b]);
  const j = await pool.chatJson<{ x: number }>(req());
  assert.equal(j.ok, true);
  assert.deepEqual(j.value, { x: 1 });
  assert.equal(j.raw, '```json\n{"x":1}\n```', 'raw 恒为回复原文');
  assert.equal(a.lastJsonMode, true, 'chatJson 强制 jsonMode');
  assert.equal(b.lastJsonMode, true);
  // 成功但回复无平衡 JSON
  const pool2 = new ProviderPool([fake('a', [{ ok: true, text: '纯文本无 JSON' }])]);
  const j2 = await pool2.chatJson(req());
  assert.equal(j2.ok, false);
  assert.ok(j2.error!.includes('extraction'));
  assert.equal(j2.raw, '纯文本无 JSON');
  // 全败 —— error 透传末败原因，raw 为空
  const pool3 = new ProviderPool([fake('a', [{ ok: false, error: 'err-a' }])]);
  const j3 = await pool3.chatJson(req());
  assert.equal(j3.ok, false);
  assert.equal(j3.error, 'err-a');
  assert.equal(j3.raw, '');
});

// ─── ΝΩ-18（熔断剥壳半权）：chatJson 剥壳失败 ≠ 拨号失败 —— 半权记账 ───

test('ΝΩ-18: chatJson 剥壳失败半权 —— 阈值 2 需 4 次坏 JSON 才 open（2N 半权律）；好 JSON 清零', async () => {
  let t = 100_000; // 可拨时钟 —— 熔断全程离线复算
  const badJson = fake('bad-json', [{ ok: true, text: '纯文本无 JSON' }]); // 恒拨号成功、恒剥壳失败
  const pool = new ProviderPool([badJson], {
    breakers: { failureThreshold: 2, cooldownMs: 60_000 },
    now: () => t,
  });
  await pool.chatJson(req());
  await pool.chatJson(req());
  await pool.chatJson(req()); // 3 次剥壳失败 = 1.5 权 < 2
  assert.equal(pool.health()[0].state, 'closed', '3 次坏 JSON（1.5 权）< 阈值 2 ⇒ 不熔断（误熔断好脑防线）');
  assert.equal(badJson.calls, 3, '闭合期照常拨号');
  await pool.chatJson(req()); // 第 4 次 = 2.0 ≥ 2 ⇒ open（半权：阈值 N 需 2N 次）
  assert.equal(pool.health()[0].state, 'open', '第 4 次（2N）恰熔断');
  assert.equal(badJson.calls, 4);
  // open ⇒ 整行跳过：chatJson 回合成 degraded（未拨号），主力零新调用
  const j = await pool.chatJson(req());
  assert.equal(j.ok, false);
  assert.equal(j.error, 'no provider available');
  assert.equal(badJson.calls, 4, 'open 后零拨号');

  // 好 JSON 一次即治愈（onSuccess 清零分数账）—— 交替型坏路线永不误熔断
  const flaky = fake('flaky', [
    { ok: true, text: 'not json' },   // 剥壳失败 ×3（1.5 权）
    { ok: true, text: 'not json' },
    { ok: true, text: 'not json' },
    { ok: true, text: '{"good":1}' }, // 好 JSON ⇒ onSuccess 清零
    { ok: true, text: 'not json' },   // 0.5 权
  ]);
  const pool2 = new ProviderPool([flaky], {
    breakers: { failureThreshold: 2, cooldownMs: 60_000 },
    now: () => t,
  });
  await pool2.chatJson(req());
  await pool2.chatJson(req());
  await pool2.chatJson(req());
  assert.equal(pool2.health()[0].state, 'closed', '1.5 权未熔');
  const okCall = await pool2.chatJson<{ good: number }>(req());
  assert.equal(okCall.ok, true, '好 JSON 承接');
  assert.equal(pool2.health()[0].state, 'closed', 'onSuccess 治愈（清零分数账）');
  await pool2.chatJson(req());
  assert.equal(pool2.health()[0].state, 'closed', '清零后重计 0.5 权 ⇒ 仍闭合');
});

test('ΝΩ-18: 真拨号失败全权照旧 + chat() 的 onSuccess 记账位置迁移零回归', async () => {
  let t = 200_000;
  // 全权律保持：2 次真实拨号失败即 open（既有 Ψ-6d 语义不因半权改动漂移）
  const a = fake('a', [{ ok: false, error: '挂了' }]);
  const b = fake('b', [{ ok: true, text: 'b 脑' }]);
  const pool = new ProviderPool([a, b], {
    breakers: { failureThreshold: 2, cooldownMs: 60_000 },
    now: () => t,
  });
  assert.equal((await pool.chat(req())).providerId, 'b');
  const j2 = await pool.chatJson(req()); // a 第二次真失败（全权 2）⇒ open；b 拨号成功但 'b 脑' 剥壳失败
  assert.equal(j2.ok, false);
  assert.match(j2.error!, /extraction failed/, 'chatJson 剥壳失败如实归因（b 的半权不掺进 a 的全权账）');
  assert.equal(pool.health()[0].state, 'open', '2 次真失败（全权）⇒ 即熔');
  assert.equal(pool.health()[1].state, 'closed', 'b：1 次拨号成功 + 1 次剥壳半权 ⇒ 0.5 权闭合');
  // chat() 胜者 onSuccess 经 runChainEntry 迁移后照记：胜脑连胜不熔，熔断脑冷却后回闭可再胜
  t += 60_000; // 越过冷却期
  assert.equal((await pool.chat(req())).providerId, 'b', 'a 冷却回闭再试再败 ⇒ b 照常补位');
  assert.equal(pool.health()[1].state, 'closed', '胜脑屡胜不熔（onSuccess 记账在场）');
});

// ─── Ψ-6j createProviderPool 铸造（env 控制法 + 注入 fetchImpl） ───

/** env 控制法三件套：涉及的环境变量全量备份 → 清场 → 测后还原 */
const ENV_KEYS = [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'QWEN_API_KEY', 'DASHSCOPE_API_KEY',
] as const;
const savedEnv = ENV_KEYS.map(k => [k, process.env[k]] as const);
function restoreEnv(): void {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

test('Ψ-6j: createProviderPool 铸造 —— env 控制法下的进池/跳过/去重/空池/补位', async () => {
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.GEMINI_API_KEY = 'gem-test';

    const meterCalls: Array<{ providerId: string }> = [];
    // 假 fetch 一：恒回 openai 成功形状（主力命中）
    const okFetch = (async () => new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: '主力回复' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;

    // 主力 openai 显式 key；anthropic/gemini 经各自 env 进池；qwen 无 env 钥匙被跳
    const pool = createProviderPool({
      provider: 'openai', apiKey: 'sk-primary',
      fallbacks: ['anthropic', 'gemini', 'qwen'],
      fetchImpl: okFetch,
      meter: rec => meterCalls.push(rec),
    });
    assert.equal(pool.size, 3, 'qwen 解析不出 key ⇒ 跳过不进池');
    assert.deepEqual(pool.ids, ['openai', 'anthropic', 'gemini']);
    assert.ok(pool.health().every(h => h.configured), '三大脑全部配置成立');
    const r = await pool.chat(req());
    assert.equal(r.ok, true);
    assert.equal(r.providerId, 'openai');
    assert.equal(r.text, '主力回复');
    assert.equal(meterCalls.length, 1, 'meter 透传 —— 主力恰好一条遥测');
    assert.equal(meterCalls[0]!.providerId, 'openai');

    // 假 fetch 二：URL 分派 —— anthropic 云回成功形状，其余 500
    const dispatch = (async (url: unknown) => {
      if (String(url).includes('api.anthropic.com')) {
        return new Response(
          JSON.stringify({ content: [{ type: 'text', text: '备脑回复' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{"error":{"message":"boom"}}', {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const pool2 = createProviderPool({
      provider: 'openai', apiKey: 'sk-primary',
      fallbacks: ['anthropic', 'openai', 'anthropic'],
      fetchImpl: dispatch,
    });
    assert.equal(pool2.size, 2, 'fallback 与主力同 id 去重');
    const r2 = await pool2.chat(req());
    assert.equal(r2.ok, true);
    assert.equal(r2.providerId, 'anthropic', '主力 500 ⇒ anthropic 备脑真补位');
    assert.equal(r2.text, '备脑回复');

    // localAuthOptional：ollama 无钥也进池（本机免钥），qwen 无钥跳过
    const pool3 = createProviderPool({ provider: 'openai', apiKey: 'k', fallbacks: ['ollama', 'qwen'] });
    assert.equal(pool3.size, 2);
    assert.deepEqual(pool3.ids, ['openai', 'ollama']);
    assert.equal(pool3.health()[1]!.configured, true, '本机 baseUrl + localAuthOptional ⇒ 免钥配置成立');

    // 主力平台未给 / 查无预设 ⇒ 空池
    assert.equal(createProviderPool().size, 0);
    assert.equal(createProviderPool({ provider: 'nope' }).size, 0);

    // 主力查有预设但无钥 ⇒ 仍进池（configured:false 诚实降级，而非静默丢脑）
    delete process.env.ANTHROPIC_API_KEY;
    const pool4 = createProviderPool({ provider: 'anthropic' });
    assert.equal(pool4.size, 1);
    assert.equal(pool4.health()[0]!.configured, false);
    const r4 = await pool4.chat(req());
    assert.equal(r4.ok, false);
    assert.equal(r4.providerId, 'pool', '未配置主力被跳 ⇒ 合成 degraded');
    assert.equal(r4.degraded, true);
  } finally {
    restoreEnv();
  }
});

// ─── ΑΩ-R35 同源降位：与主力同平台同 baseUrl 的候选降一位（不删除） ───

test('ΑΩ-R35: 同源降位 —— 同平台同端点候选降一位、异构脑先上、同源脑殿后仍可救场', async () => {
  const GLM_URL = 'https://open.bigmodel.cn/api/paas/v4/';
  const head = fake('glm-main', [{ ok: false, error: 'network unreachable' }], { baseUrl: GLM_URL });
  const twin = fake('glm-mirror', [{ ok: true, text: '同源脑殿后救场' }], { baseUrl: GLM_URL.replace(/\/+$/, '') }); // 尾斜杠归一同源
  const hetero = fake('openai', [{ ok: true, text: '异构脑先上' }], { baseUrl: 'https://api.openai.com/v1' });
  const tail = fake('qwen', [{ ok: true }], { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' });
  const pool = new ProviderPool([head, twin, hetero, tail]);
  // 降位后池序：同源 twin 从次席降到第 3 位（降序不删除）
  assert.deepEqual(pool.ids, ['glm-main', 'openai', 'glm-mirror', 'qwen'], '同源候选降一位，异构脑顶上次席');
  assert.ok(pool.notes.some(n => n.includes('同源降位') && n.includes('glm-mirror')), 'note 记录降位决策');

  // 主力网络错 ⇒ 异构脑先补位（不再对同源端点白烧一次）
  const r = await pool.chat(req());
  assert.equal(r.ok, true);
  assert.equal(r.providerId, 'openai', '异构脑先上');
  assert.equal(twin.calls, 0, '同源脑未被白白试错');
  assert.equal(tail.calls, 0, '第 4 席未动');

  // 降序不删除：异构脑也倒下时，同源脑仍作最后手段
  const head2 = fake('glm-main', [{ ok: false, error: 'net down' }], { baseUrl: GLM_URL });
  const twin2 = fake('glm-mirror', [{ ok: true, text: '最后手段' }], { baseUrl: GLM_URL });
  const hetero2 = fake('openai', [{ ok: false, error: '也挂了' }], { baseUrl: 'https://api.openai.com/v1' });
  const pool2 = new ProviderPool([head2, twin2, hetero2]);
  assert.deepEqual(pool2.ids, ['glm-main', 'openai', 'glm-mirror']);
  const r2 = await pool2.chat(req());
  assert.equal(r2.ok, true);
  assert.equal(r2.providerId, 'glm-mirror', '同源脑仍在池内 —— 全线告急时照常救场');
  assert.equal(twin2.calls, 1);

  // 非同源（同 protocol 异端点 / baseUrl 缺席）⇒ 原池序纹丝不动
  const noDemote = new ProviderPool([
    fake('a', [{ ok: true }], { baseUrl: 'https://a.example/v1' }),
    fake('b', [{ ok: true }], { baseUrl: 'https://b.example/v1' }), // 同 protocol 异端点
    fake('c', [{ ok: true }]), // baseUrl 缺席 ⇒ 不虚构比对材料
  ]);
  assert.deepEqual(noDemote.ids, ['a', 'b', 'c'], '非同源零扰动');
  assert.equal(noDemote.notes.length, 0, '零降位零噪音');
});

// ─── Ψ-6k registry 桩契约 —— resolveProviderConfig / getPreset ───

test('Ψ-6k: registry 桩 —— resolveProviderConfig 三级来源与 getPreset 归一', () => {
  try {
    // 平台未给 / 查无预设 ⇒ null
    assert.equal(resolveProviderConfig(), null);
    assert.equal(resolveProviderConfig({}), null);
    assert.equal(resolveProviderConfig({ provider: 'nope' }), null);
    // 显式 key ⇒ via 'explicit'；baseUrl/model 回退预设缺省
    const c1 = resolveProviderConfig({ provider: 'openai', apiKey: ' sk-x ' });
    assert.notEqual(c1, null);
    assert.equal(c1!.via, 'explicit');
    assert.equal(c1!.apiKey, 'sk-x', '显式 key trim 归一');
    assert.equal(c1!.baseUrl, 'https://api.openai.com/v1');
    assert.equal(c1!.model, 'gpt-4o-mini');
    // 显式 baseUrl/model 覆盖预设
    const c2 = resolveProviderConfig({ provider: 'openai', apiKey: 'k', baseUrl: 'http://localhost:9/v1', model: 'm' });
    assert.equal(c2!.baseUrl, 'http://localhost:9/v1');
    assert.equal(c2!.model, 'm');
    // env 控制法：GEMINI_API_KEY 缺席 ⇒ 回退 GOOGLE_API_KEY，via 'env'
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLE_API_KEY = 'g-key';
    const c3 = resolveProviderConfig({ provider: 'gemini' });
    assert.equal(c3!.via, 'env');
    assert.equal(c3!.apiKey, 'g-key');
    // 全无 ⇒ via 'preset'（apiKey 空串，不抛）
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const c4 = resolveProviderConfig({ provider: 'gemini' });
    assert.equal(c4!.via, 'preset');
    assert.equal(c4!.apiKey, '');
    // getPreset：trim + 小写归一；脏值安静 null
    assert.equal(getPreset('  OPENAI ')!.platform, 'openai');
    assert.equal(getPreset(undefined), null);
    assert.equal(getPreset(''), null);
  } finally {
    restoreEnv();
  }
});
