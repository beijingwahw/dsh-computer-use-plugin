// test/r32.failoverFallback.test.ts
// R3-2（fallback 备脑修复）：per-brain 模型注入口 + max_tokens 钳制泛化 + failover 真实时序。
// 病灶（R2-1 §6 登记）：failover 池的 glm 备脑经 registry 缺省解析为 glm-5.3-flash，
// 本账户实测 429 code 1113 余额不足 —— failover 机制在线但拨号必败，等于单脑裸奔；
// 且 R1-5 的 glm-4v-flash max_tokens ≤1024 钳制只是冒烟脚本的运行时注入，从未落 src。
// 执法面：真实 openai 适配器 + mock 传输（dispatch fetch 按 URL 分派），零真实联网。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import type { GlmVisionRequest } from '../src/vlm/glmClient.ts';
import type { VisionChatRequest } from '../src/vlm/providers/types.ts';

const glmMod = await import('../src/vlm/glmClient.ts');
const { createProviderPool, parseFallbackSpec, ProviderPool } = await import('../src/vlm/providers/failover.ts');
const { createEnsembleCourt } = await import('../src/vlm/providers/ensemble.ts');

// ─── 环境隔离（与 p2a-fixes.test.ts 同面）：抹掉真实平台 key，退出恢复 ───
const ENV_KEYS = [
  'GLM_API_KEY', 'ZHIPUAI_API_KEY', 'ZAI_API_KEY', 'GLM_BASE_URL', 'GLM_VLM_MODEL',
  'OPENAI_API_KEY', 'DASHSCOPE_API_KEY', 'ALIYUN_API_KEY',
] as const;
const savedEnv = new Map<string, string | undefined>();
for (const k of ENV_KEYS) {
  savedEnv.set(k, process.env[k]);
  delete process.env[k];
}
after(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  glmMod.resetGlmClient();
  glmMod.attachFailoverPool(null); // 摘除测试期接线，防跨测试污染
});

// ─── mock 传输：按 URL 分派的假 fetch + 请求体捕获 ───

interface Captured { url: string; body: Record<string, unknown> }

/**
 * 分派假 fetch：dashscope（qwen 主脑/池主力）回 429 余额不足形状；bigmodel
 * （glm 备脑）回 200 成功形状。captured 记录每次 POST 的解析后请求体。
 */
function makeDispatch(opts: { glmOk: boolean } = { glmOk: true }) {
  const captured: Captured[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const raw = typeof init?.body === 'string' ? init.body : '';
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* 脏体如实留空 */ }
    captured.push({ url: u, body });
    if (u.includes('bigmodel.cn')) {
      if (!opts.glmOk) {
        return new Response('{"error":{"code":"1113","message":"balance insufficient"}}',
          { status: 429, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'glm-4v-flash 备脑回复' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    // dashscope：429 余额不足/限流形状（R2-1 实测同码）
    return new Response('{"error":{"code":"Throttling","message":"Requests throttled"}}',
      { status: 429, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, captured };
}

/** 最小合法请求（maxRetries 0 —— 429 立即终败零退避；确定性） */
function req(o: Partial<VisionChatRequest> = {}): VisionChatRequest {
  return { images: [{ base64: 'QUJD' }], prompt: '看图说话', timeoutMs: 500, maxRetries: 0, ...o };
}

/** glmClient 形态的同款请求（桥级时序测试用） */
function greq(o: Partial<GlmVisionRequest> = {}): GlmVisionRequest {
  return { images: [{ base64: 'QUJD', mime: 'image/png' }], prompt: '描述这张截图', timeoutMs: 500, maxRetries: 0, ...o };
}

// ═══ R3-2-a：parseFallbackSpec 方言解析（纯函数单元） ═══

test('R3-2: parseFallbackSpec —— 裸 id / id=model 双方言与脏值防御', () => {
  // 裸 id（既有形态）：model 空串 = 未覆写
  assert.deepEqual(parseFallbackSpec('glm'), { platform: 'glm', model: '' });
  assert.deepEqual(parseFallbackSpec('  GLM '), { platform: 'glm', model: '' }); // trim + 小写归一
  // per-brain 覆写：首个 '=' 切分，模型名原样大小写
  assert.deepEqual(parseFallbackSpec('glm=glm-4v-flash'), { platform: 'glm', model: 'glm-4v-flash' });
  assert.deepEqual(parseFallbackSpec(' glm = glm-4v-flash '), { platform: 'glm', model: 'glm-4v-flash' });
  // '=' 后空白 ⇒ 视同缺席（宽容解析，不抛）
  assert.deepEqual(parseFallbackSpec('glm='), { platform: 'glm', model: '' });
  // 空段/无 id/非字符串 ⇒ null
  assert.equal(parseFallbackSpec(''), null);
  assert.equal(parseFallbackSpec('   '), null);
  assert.equal(parseFallbackSpec('=model'), null);
  assert.equal(parseFallbackSpec(undefined), null);
  assert.equal(parseFallbackSpec(123 as unknown), null);
  assert.equal(parseFallbackSpec(null as unknown), null);
});

// ═══ R3-2-b：池铸造 —— per-brain 模型注入 + 硬顶钳制（真实适配器 + mock 传输） ═══

test('R3-2: 池铸造 per-brain 注入 —— glm=glm-4v-flash 覆写预设缺省 + max_tokens 钳到 1024', async () => {
  process.env.GLM_API_KEY = 'test-glm-key';
  try {
    const { fetchImpl, captured } = makeDispatch();
    const pool = createProviderPool({
      provider: 'qwen', apiKey: 'qk',
      fallbacks: ['glm=glm-4v-flash'],
      fetchImpl,
    });
    assert.equal(pool.size, 2, 'qwen 主力 + glm 备脑（per-brain 段解析成立，不再被整段丢弃）');
    assert.deepEqual(pool.ids, ['qwen', 'glm']);

    // 主脑（qwen 池主力）429 ⇒ glm 备脑接管；请求显式 maxTokens 2048（grounding 器官量级）
    const r = await pool.chat(req({ maxTokens: 2048 }));
    assert.equal(r.ok, true, 'glm-4v-flash 备脑救回');
    assert.equal(r.providerId, 'glm');
    assert.equal(r.model, 'glm-4v-flash', 'per-brain 模型覆写生效（非 registry 缺省 glm-5.3-flash）');

    // 传输侧执法：dashscope 一次 429；bigmodel 请求体 model=glm-4v-flash + max_tokens=1024
    const glmCall = captured.find(c => c.url.includes('bigmodel.cn'));
    assert.ok(glmCall, '备脑拨号发生');
    assert.equal(glmCall!.body.model, 'glm-4v-flash');
    assert.equal(glmCall!.body.max_tokens, 1024, 'maxTokens 2048 → 钳到免费档硬顶 1024（R1-5 的 400 拒单防线）');
    assert.equal(captured.filter(c => c.url.includes('dashscope')).length, 1, '主力恰一次 429（maxRetries 0）');
  } finally {
    delete process.env.GLM_API_KEY;
  }
});

test('R3-2: 裸 id 段零变化 —— 不覆写模型（registry 缺省）也不钳 max_tokens', async () => {
  process.env.GLM_API_KEY = 'test-glm-key';
  try {
    const { fetchImpl, captured } = makeDispatch();
    const pool = createProviderPool({
      provider: 'qwen', apiKey: 'qk',
      fallbacks: ['glm'],
      fetchImpl,
    });
    assert.deepEqual(pool.ids, ['qwen', 'glm']);
    const r = await pool.chat(req({ maxTokens: 2048 }));
    assert.equal(r.ok, true);
    assert.equal(r.model, 'glm-5.3-flash', '裸 id ⇒ registry 缺省模型（既有行为逐字节保持）');
    const glmCall = captured.find(c => c.url.includes('bigmodel.cn'));
    assert.equal(glmCall!.body.model, 'glm-5.3-flash');
    assert.equal(glmCall!.body.max_tokens, 2048, 'glm-5.3-flash 不在硬顶表 ⇒ 零钳制（缺省零变化律）');
  } finally {
    delete process.env.GLM_API_KEY;
  }
});

test('R3-2: chatJson + maxTokens 缺席 —— 适配器缺省 2048 同被钳到 1024', async () => {
  process.env.GLM_API_KEY = 'test-glm-key';
  try {
    const { fetchImpl, captured } = makeDispatch();
    const pool = createProviderPool({
      provider: 'qwen', apiKey: 'qk',
      fallbacks: ['glm=glm-4v-flash'],
      fetchImpl,
    });
    // maxTokens 不给（ask/OCR 器官的常见形态 —— 适配器自落 2048）
    const j = await pool.chatJson(req());
    assert.equal(j.ok, false, '回复非 JSON ⇒ 剥壳失败（诚实失败，拨号本身成功）');
    const glmCall = captured.find(c => c.url.includes('bigmodel.cn'));
    assert.ok(glmCall, '备脑拨号发生');
    assert.equal(glmCall!.body.max_tokens, 1024, 'undefined 缺省 2048 同样进界（免费档免费的前提）');
  } finally {
    delete process.env.GLM_API_KEY;
  }
});

// ═══ R3-2-c：单例-池贯通的真实时序 —— 主脑 429 → 备脑接管；备脑也挂 → 诚实降级 ═══

test('R3-2: 主脑 429 → 池内 qwen 亦 429 → glm-4v-flash 接管（真实时序 + note failover）', async () => {
  process.env.GLM_API_KEY = 'test-glm-key';
  try {
    const { fetchImpl, captured } = makeDispatch();
    // 池：qwen 主力 + glm=glm-4v-flash 备脑（configureVlm 铸池同构 —— 真实适配器）
    const pool = createProviderPool({
      provider: 'qwen', apiKey: 'qk',
      fallbacks: ['glm=glm-4v-flash'],
      fetchImpl,
    });
    glmMod.attachFailoverPool(pool);
    // 单例：qwen 平台主脑（R2-1 部署形态），共享同一 mock 传输 ⇒ 恒 429
    const client = new glmMod.GlmClient({ platform: 'qwen', apiKey: 'qk', fetchImpl });

    const r = await client.chat(greq({ maxTokens: 2048 }));
    assert.equal(r.ok, true, '备脑救回');
    assert.equal(r.providerId, 'glm', '归因到 glm 备脑');
    assert.equal(r.model, 'glm-4v-flash', '备脑自报模型 = per-brain 覆写名');
    assert.equal(r.note, 'failover', 'P2a-1 failover 标注在场');
    // 时序执法：单例 qwen 429 一次 → 池 qwen 429 一次 → glm 一次成功
    const dash = captured.filter(c => c.url.includes('dashscope'));
    const big = captured.filter(c => c.url.includes('bigmodel.cn'));
    assert.equal(dash.length, 2, 'qwen 恰两次 429（单例首发 + 池主力补位尝试）');
    assert.equal(big.length, 1, 'glm 备脑恰一次救回');
    assert.equal(big[0]!.body.model, 'glm-4v-flash');
    assert.equal(big[0]!.body.max_tokens, 1024, '桥级钳制同样生效（consultFailoverPool 透传请求 → 铸造点包装执法）');
  } finally {
    glmMod.attachFailoverPool(null);
    delete process.env.GLM_API_KEY;
  }
});

test('R3-2: 备脑也挂（双 429）⇒ 诚实降级 —— 主脑原失败现场保留，无 failover 幻觉', async () => {
  process.env.GLM_API_KEY = 'test-glm-key';
  try {
    const { fetchImpl } = makeDispatch({ glmOk: false }); // dashscope 与 bigmodel 全 429
    const pool = createProviderPool({
      provider: 'qwen', apiKey: 'qk',
      fallbacks: ['glm=glm-4v-flash'],
      fetchImpl,
    });
    glmMod.attachFailoverPool(pool);
    const client = new glmMod.GlmClient({ platform: 'qwen', apiKey: 'qk', fetchImpl });

    const r = await client.chat(greq());
    assert.equal(r.ok, false, '全链 429 ⇒ 失败如实上抛（绝不静默成功）');
    assert.equal(r.note, undefined, '无 failover 标注（池全败不冒功）');
    assert.match(r.error!, /429/, '主脑失败现场保留（池的失败不覆盖归因）');
    assert.equal(r.providerId, 'qwen', '归因保持主脑（委托路径失败形态）');
    // 池侧叙事：两颗脑各留一次失败切换决策
    assert.ok(pool.notes.some(n => n.includes('qwen') && n.includes('失败')), '池记 qwen 失败');
    assert.ok(pool.notes.some(n => n.includes('glm') && n.includes('失败')), '池记 glm 失败');
    assert.ok(pool.notes.some(n => n.includes('全线失败')), '全败叙事在场');
  } finally {
    glmMod.attachFailoverPool(null);
    delete process.env.GLM_API_KEY;
  }
});

// ═══ R3-2-d：glm 原生路径（GLM_VLM_MODEL=glm-4v-flash 直配主脑）钳制泛化 ═══

test('R3-2: glm 原生路径钳制 —— GLM_VLM_MODEL=glm-4v-flash 时 max_tokens 2048→1024；他模型零钳制', async () => {
  /** 记录请求体的成功假 fetch（回 openai 兼容成功形状） */
  const recorder = (): { fetchImpl: typeof fetch; bodies: Array<Record<string, unknown>> } => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      bodies.push(body);
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    return { fetchImpl, bodies };
  };
  process.env.GLM_VLM_MODEL = 'glm-4v-flash';
  try {
    const { fetchImpl, bodies } = recorder();
    const client = new glmMod.GlmClient({ apiKey: 'k', fetchImpl });
    const r = await client.chat(greq({ maxTokens: 2048 }));
    assert.equal(r.ok, true);
    assert.equal(r.model, 'glm-4v-flash', 'env GLM_VLM_MODEL 解析（R1-5 免费档直配形态）');
    assert.equal(bodies[0]!.max_tokens, 1024, '原生路径硬顶钳制生效（R1-5 钳制层自此落 src）');
    // 界内值原样（512 ≤ 1024 不动）
    await client.chat(greq({ maxTokens: 512 }));
    assert.equal(bodies[1]!.max_tokens, 512, '界内值零扰动');
  } finally {
    delete process.env.GLM_VLM_MODEL;
  }
  // 非命中家族（glm-5.3-flash 缺省）⇒ 零钳制（缺省零变化律）
  const { fetchImpl: f2, bodies: bodies2 } = recorder();
  const client2 = new glmMod.GlmClient({ apiKey: 'k', fetchImpl: f2 });
  await client2.chat(greq({ maxTokens: 2048 }));
  assert.equal(bodies2[0]!.model, 'glm-5.3-flash', '缺省模型不受 R3-2 影响');
  assert.equal(bodies2[0]!.max_tokens, 2048, '缺省模型零钳制');
});

// ═══ R3-2-e：合议庭同方言 —— extraProviders 的 id=model 段不再挤掉 glm 席 ═══

test('R3-2: 合议庭 extraProviders —— glm=glm-4v-flash 同方言入席（池庭同脑）', () => {
  // R4-5 回归护栏修复：createEnsembleCourt 无 apiKey 选项（钥匙经各平台 env 名册解析，
  // 首版误写成内联选项——运行时被忽略、tsc 报 TS2353）。改经 env 方言注入，确定性入席。
  process.env.GLM_API_KEY = 'test-glm-key';
  process.env.OPENAI_API_KEY = 'sk-k';
  try {
    const court = createEnsembleCourt({
      provider: 'openai',
      extraProviders: ['glm=glm-4v-flash'],
    });
    const roster = court.listRoster();
    assert.equal(roster.length, 2, 'glm 席未被 id=model 段静默挤掉');
    const glmSeat = roster.find(p => p.id === 'glm');
    assert.ok(glmSeat, 'glm 在席');
    assert.equal(glmSeat!.model, 'glm-4v-flash', '庭内 glm 脑模型与池一致（同链同脑，绝不漂移）');
  } finally {
    delete process.env.GLM_API_KEY;
    delete process.env.OPENAI_API_KEY;
  }
});

// ═══ R3-2-f：模型硬顶知识单点（types.ts 导出面） ═══

test('R3-2: tokenCapForModel/clampMaxTokensForModel —— 家族命中与零变化', async () => {
  const types = await import('../src/vlm/providers/types.ts');
  assert.equal(types.tokenCapForModel('glm-4v-flash'), 1024);
  assert.equal(types.tokenCapForModel('GLM-4V-FLASH-250414'), 1024, '前缀 + 大小写不敏感（日期后缀变体）');
  assert.equal(types.tokenCapForModel('glm-4.5v'), null, '付费档无已知硬顶');
  assert.equal(types.tokenCapForModel('qwen3-vl-plus'), null, 'qwen 4096 无碍（R2-1 §4 D）');
  assert.equal(types.tokenCapForModel(''), null);
  assert.equal(types.tokenCapForModel(undefined), null);
  assert.equal(types.clampMaxTokensForModel('glm-4v-flash', 2048), 1024);
  assert.equal(types.clampMaxTokensForModel('glm-4v-flash', 1024), 1024, '界上沿原样');
  assert.equal(types.clampMaxTokensForModel('glm-4v-flash', 512), 512, '只钳不抬');
  assert.equal(types.clampMaxTokensForModel('qwen3-vl-plus', 4096), 4096, '非命中家族恒等');
  // ProviderPool 直铸路径不受影响（既有回归锚：池序/救回语义零变化）
  const pool = new ProviderPool([]);
  assert.equal(pool.size, 0);
});
