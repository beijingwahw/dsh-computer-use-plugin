// test/vlm.verdict.test.ts
// 纪元 Ω（Ω-6 · 云端语义判决）：verdict 全本地验证 —— 假 client / 假 fetch 注入，绝不联网。
// 覆盖：未配置降级（零网络）、confirmed/refuted/uncertain 三值解析、非法枚举归 uncertain、
// region 同裁透传（含两图不对称越界失败）、请求双图顺序（前亮后暗亮度断言）与「动作前/后」
// 提示词、fuseWithPixelEvidence 全分支数值断言（纯函数不改入参）、chatJson 失败/抛错不越狱。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GlmClient, resetGlmClient,
  type GlmClient as GlmClientLike,
} from '../src/vlm/glmClient.ts';

const { judgeEffect, fuseWithPixelEvidence } = await import('../src/vlm/verdict.ts');
const { default: sharp } = await import('sharp');

// ─── 假件工坊 ───

/** 假 chatJson 响应 —— 与 GlmClient.chatJson 契约同构（value = extractGlmJson 之后的解析值） */
interface ChatJsonResp { ok: boolean; value?: unknown; error?: string; raw: string }

/** verdict 实际下发的请求形态（verdict 只依赖这两个字段） */
interface CapturedCall { prompt: string; images: Array<{ base64: string; mime?: string }> }

/** 注入用假 client —— 只实现 verdict 消费的 chatJson，并捕获每次请求 */
function fakeClient(
  respond: (call: CapturedCall) => ChatJsonResp | Promise<ChatJsonResp>,
): { client: GlmClientLike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const stub = {
    chatJson: async (req: { prompt?: unknown; images?: unknown }): Promise<ChatJsonResp> => {
      const call: CapturedCall = {
        prompt: typeof req.prompt === 'string' ? req.prompt : '',
        images: Array.isArray(req.images) ? (req.images as CapturedCall['images']) : [],
      };
      calls.push(call);
      return respond(call);
    },
  };
  return { client: stub as unknown as GlmClientLike, calls };
}

/** 假 fetch —— 返回 OpenAI 兼容 chat completion（content 可控）；绝不联网 */
function fakeFetchWithContent(content: string): typeof fetch {
  return (async () => new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )) as unknown as typeof fetch;
}

const WHITE = { r: 255, g: 255, b: 255 };
const BLACK = { r: 0, g: 0, b: 0 };

/** sharp 现场生成纯色测试 PNG（颜色区分前后图 —— 顺序断言靠亮度差；假 client 不看像素，只走真实编码管线） */
async function makePng(width: number, height: number, rgb: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: rgb },
  }).png().toBuffer();
}

/** 解码 base64 图的红通道均值（双图顺序断言：动作前=白 ≈255，动作后=黑 ≈0） */
async function redMean(base64: string): Promise<number> {
  const { channels } = await sharp(Buffer.from(base64, 'base64')).stats();
  return channels[0].mean;
}

/** 浮点近似断言（+0.1 加成分支有 1 ULP 浮点尘，容差 1e-9） */
function near(actual: unknown, expected: number): void {
  assert.ok(
    typeof actual === 'number' && Math.abs(actual - expected) < 1e-9,
    `expect ${String(actual)} ≈ ${expected}`,
  );
}

/** 基准云判决工厂 —— 数值刻意取二进制精确值（0.75/0.5/0.625…），均值断言无浮点尘 */
function cloud(verdict: 'confirmed' | 'refuted' | 'uncertain', confidence: number) {
  return {
    ok: true, verdict, scale: 'element' as const, explanation: '云脑说明',
    confidence, degraded: false, latencyMs: 88,
  };
}

// ─── Ω-6a 未配置降级（零网络） ───

test('Ω-6a: 未配置且未注入 client ⇒ 零网络降级（ok:false + degraded:true，空壳判决 + error）', async () => {
  const keys = ['GLM_API_KEY', 'ZHIPUAI_API_KEY', 'ZAI_API_KEY'] as const;
  const saved = keys.map(k => [k, process.env[k]] as const);
  try {
    for (const k of keys) delete process.env[k];
    resetGlmClient(); // 清掉可能的已配置单例，保证 isGlmConfigured 走环境变量重探测
    const before = await makePng(80, 60, WHITE);
    const after = await makePng(80, 60, BLACK);

    const r = await judgeEffect(before, after, '点击后菜单展开');
    assert.equal(r.ok, false);
    assert.equal(r.degraded, true);
    assert.equal(r.verdict, 'uncertain'); // 空壳判决 —— 宁可空不可错
    assert.equal(r.scale, 'none');
    assert.equal(r.explanation, '');
    assert.equal(r.confidence, 0);
    assert.ok(r.error, 'error 必有失败原因');
    assert.ok(Number.isFinite(r.latencyMs) && r.latencyMs >= 0);
  } finally {
    for (const [k, v] of saved) { if (v !== undefined) process.env[k] = v; }
    resetGlmClient();
  }
});

// ─── Ω-6b 三值解析与请求形态 ───

test('Ω-6b: confirmed 解析 —— 双图按序下发（第一张动作前、第二张动作后），提示词钉死顺序并嵌入预期', async () => {
  const { client, calls } = fakeClient(() => ({
    ok: true, raw: '',
    value: { verdict: 'confirmed', scale: 'element', explanation: '下拉菜单已展开', confidence: 0.88 },
  }));
  const r = await judgeEffect(
    await makePng(120, 90, WHITE),
    await makePng(120, 90, BLACK),
    '点击后下拉菜单展开',
    { client },
  );
  assert.equal(r.ok, true);
  assert.equal(r.degraded, false);
  assert.equal(r.error, undefined);
  assert.equal(r.verdict, 'confirmed');
  assert.equal(r.scale, 'element');
  assert.equal(r.explanation, '下拉菜单已展开');
  assert.equal(r.confidence, 0.88);
  assert.ok(Number.isFinite(r.latencyMs) && r.latencyMs >= 0);

  // 请求形态：恰好两张图（真实编码管线的 base64）+ 顺序语义正确的提示词
  assert.equal(calls.length, 1);
  assert.equal(calls[0].images.length, 2);
  assert.ok(calls[0].images[0].base64.length > 100, '前图 base64 应为真实编码产物');
  assert.ok(calls[0].images[1].base64.length > 100, '后图 base64 应为真实编码产物');
  assert.notEqual(calls[0].images[0].base64, calls[0].images[1].base64); // 两图确实不同
  assert.ok((await redMean(calls[0].images[0].base64)) > 200, '第一张应为动作前（白底亮图）');
  assert.ok((await redMean(calls[0].images[1].base64)) < 50, '第二张应为动作后（黑底暗图）');
  const prompt = calls[0].prompt;
  assert.ok(prompt.includes('第一张') && prompt.includes('动作前') && prompt.includes('动作后'),
    '提示词须显式说明双图顺序（第一张动作前、第二张动作后）');
  assert.ok(prompt.includes('下拉菜单展开'), 'buildVerdictPrompt 应嵌入预期描述');
  assert.ok(prompt.includes('confirmed'), 'som 判决铁律提示词应透传');
});

test('Ω-6b: refuted / uncertain 解析 —— 枚举与数值直通，置信度数字串方言也收', async () => {
  const refuted = fakeClient(() => ({
    ok: true, raw: '',
    value: { verdict: 'refuted', scale: 'page', explanation: '页面整体未变化', confidence: '0.75' },
  }));
  const r1 = await judgeEffect(
    await makePng(60, 40, WHITE), await makePng(60, 40, BLACK),
    '弹窗出现', { client: refuted.client },
  );
  assert.equal(r1.ok, true);
  assert.equal(r1.verdict, 'refuted');
  assert.equal(r1.scale, 'page');
  assert.equal(r1.explanation, '页面整体未变化');
  assert.equal(r1.confidence, 0.75); // '0.75' 数字串 → 宽松转数

  const uncertain = fakeClient(() => ({
    ok: true, raw: '',
    value: { verdict: 'uncertain', scale: 'none', explanation: '两图几乎一致，无法确认', confidence: 0.5 },
  }));
  const r2 = await judgeEffect(
    await makePng(60, 40, WHITE), await makePng(60, 40, BLACK),
    '输入框获得焦点', { client: uncertain.client },
  );
  assert.equal(r2.ok, true);
  assert.equal(r2.verdict, 'uncertain');
  assert.equal(r2.scale, 'none');
  assert.equal(r2.explanation, '两图几乎一致，无法确认');
  assert.equal(r2.confidence, 0.5);
});

test('Ω-6b: 非法枚举归 uncertain / none —— 判决永不出错值；explanation 兜底空串；置信度夹取', async () => {
  const before = await makePng(60, 40, WHITE);
  const after = await makePng(60, 40, BLACK);
  const run = async (value: unknown) => {
    const { client } = fakeClient(() => ({ ok: true, raw: '', value }));
    return judgeEffect(before, after, '任意预期', { client });
  };

  // verdict 非法三连：拼错 / 非字符串 / 缺席 —— 全归 uncertain（载荷不可用不是调用失败，ok 仍 true）
  const bogus = await run({ verdict: 'maybe', scale: 'page', explanation: 'x', confidence: 0.9 });
  assert.equal(bogus.ok, true);
  assert.equal(bogus.verdict, 'uncertain');
  assert.equal(bogus.scale, 'page'); // scale 合法则保留

  const numVerdict = await run({ verdict: 42, scale: 'element', confidence: 0.9 });
  assert.equal(numVerdict.verdict, 'uncertain');

  const missing = await run({ scale: 'none', confidence: 0.9 });
  assert.equal(missing.verdict, 'uncertain');

  // scale 非法归 none；confidence 越界夹取、非法压 0；explanation 缺席兜底空串
  const badScale = await run({ verdict: 'confirmed', scale: 'universe', explanation: 'ok', confidence: 1.4 });
  assert.equal(badScale.scale, 'none');
  assert.equal(badScale.confidence, 1); // 1.4 夹上界
  const neg = await run({ verdict: 'confirmed', scale: 'page', explanation: 'ok', confidence: -0.2 });
  assert.equal(neg.confidence, 0); // 负值夹下界
  const nan = await run({ verdict: 'confirmed', scale: 'page', confidence: 'abc' });
  assert.equal(nan.confidence, 0);
  assert.equal(nan.explanation, ''); // 兜底空串，绝不 undefined

  // 载荷整体是垃圾（字符串 / null）—— 同样安全归位，绝不抛
  const junk = await run('模型自由发挥');
  assert.equal(junk.ok, true);
  assert.equal(junk.verdict, 'uncertain');
  assert.equal(junk.scale, 'none');
  assert.equal(junk.explanation, '');
  assert.equal(junk.confidence, 0);
  const nullish = await run(null);
  assert.equal(nullish.ok, true);
  assert.equal(nullish.verdict, 'uncertain');
});

// ─── Ω-6c region 同裁 ───

test('Ω-6c: region 同裁透传 —— 两图收到的都是 region 子图（宽高 = x1-x0 / y1-y0）', async () => {
  const { client, calls } = fakeClient(() => ({
    ok: true, raw: '',
    value: { verdict: 'confirmed', scale: 'element', explanation: '局部有变', confidence: 0.7 },
  }));
  await judgeEffect(
    await makePng(400, 300, WHITE),
    await makePng(400, 300, BLACK),
    '按钮高亮',
    { region: { x0: 10, y0: 20, x1: 110, y1: 170 }, client },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].images.length, 2);
  for (const img of calls[0].images) {
    const meta = await sharp(Buffer.from(img.base64, 'base64')).metadata();
    assert.equal(meta.width, 100); // 110 - 10
    assert.equal(meta.height, 150); // 170 - 20
  }
});

test('Ω-6c: region 在某一图上越界 ⇒ 同裁语义下诚实失败（ok:false + degraded），不发请求', async () => {
  const { client, calls } = fakeClient(() => ({ ok: true, raw: '', value: {} }));
  // before 400x300 裁得出 100x100；after 50x40 装不下 —— region 同裁，after 编码失败
  const r = await judgeEffect(
    await makePng(400, 300, WHITE),
    await makePng(50, 40, BLACK),
    '任意预期',
    { region: { x0: 0, y0: 0, x1: 100, y1: 100 }, client },
  );
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
  assert.equal(r.verdict, 'uncertain');
  assert.match(r.error ?? '', /after/); // 失败归因到 after 一侧
  assert.match(r.error ?? '', /exceeds image bounds/); // codec 的 region 越界原话透传
  assert.equal(calls.length, 0); // 编码失败先于任何云脑请求
});

// ─── Ω-6d fuseWithPixelEvidence 双脑融合 ───

test('Ω-6d: ok:false 原样返回（同一引用）；纯函数不改入参；其余字段原样透传', () => {
  const dead = {
    ok: false, verdict: 'uncertain' as const, scale: 'none' as const, explanation: '',
    confidence: 0, degraded: true, error: 'glm outage', latencyMs: 3,
  };
  const fusedDead = fuseWithPixelEvidence(dead, { detected: true, similarityPct: 10 });
  assert.equal(fusedDead, dead); // 原样返回 —— 对象同一性

  // 纯函数性：入参快照不因融合改变；返回新对象（≠ 入参引用）
  const input = cloud('confirmed', 0.75);
  const snapshot = { ...input };
  const out = fuseWithPixelEvidence(input, { detected: true, similarityPct: 50 });
  assert.notEqual(out, input);
  assert.deepEqual(input, snapshot);
  assert.equal(out.ok, true);
  assert.equal(out.scale, 'element');
  assert.equal(out.explanation, '云脑说明');
  assert.equal(out.degraded, false);
  assert.equal(out.latencyMs, 88);
});

test('Ω-6d: 分支② refuted × 未检出变化 ⇒ refuted，置信取均值（含 similarityPct 夹取与缺席自证）', () => {
  // vlm 0.75、sim 50 → pixelConf 50/100=0.5 → 均值 (0.75+0.5)/2 = 0.625
  const r = fuseWithPixelEvidence(cloud('refuted', 0.75), { detected: false, similarityPct: 50 });
  assert.equal(r.verdict, 'refuted');
  assert.equal(r.confidence, 0.625);

  // similarityPct 120 夹 100 → pixelConf 1 → 均值 (0.75+1)/2 = 0.875
  const clamped = fuseWithPixelEvidence(cloud('refuted', 0.75), { detected: false, similarityPct: 120 });
  assert.equal(clamped.verdict, 'refuted');
  assert.equal(clamped.confidence, 0.875);

  // similarityPct 非有限：像素布尔自证取满置信（detected=false → sim 按 100）→ 0.875
  const nanSim = fuseWithPixelEvidence(cloud('refuted', 0.75), { detected: false, similarityPct: Number.NaN });
  assert.equal(nanSim.verdict, 'refuted');
  assert.equal(nanSim.confidence, 0.875);
});

test('Ω-6d: 分支③ confirmed × 未检出变化 ⇒ 分歧降级 uncertain，置信保守化 min(vlm, 0.6)', () => {
  const high = fuseWithPixelEvidence(cloud('confirmed', 0.8), { detected: false, similarityPct: 99 });
  assert.equal(high.verdict, 'uncertain'); // 分歧降级 —— 绝不硬判 confirmed
  assert.equal(high.confidence, 0.6); // min(0.8, 0.6)

  const low = fuseWithPixelEvidence(cloud('confirmed', 0.4), { detected: false, similarityPct: 99 });
  assert.equal(low.verdict, 'uncertain');
  assert.equal(low.confidence, 0.4); // min(0.4, 0.6) —— 本就低则不抬升
});

test('Ω-6d: 分支④ confirmed × 检出变化 ⇒ confirmed，置信 = min(1, 均值+0.1)（双脑一致加成）', () => {
  // vlm 0.75、sim 50 → pixelConf (100-50)/100=0.5 → 均值 0.625 → +0.1 = 0.725
  const r = fuseWithPixelEvidence(cloud('confirmed', 0.75), { detected: true, similarityPct: 50 });
  assert.equal(r.verdict, 'confirmed');
  near(r.confidence, 0.725);

  // vlm 1、sim 10 → pixelConf 0.9 → 均值 0.95 → +0.1 = 1.05 → 封顶 1
  const capped = fuseWithPixelEvidence(cloud('confirmed', 1), { detected: true, similarityPct: 10 });
  assert.equal(capped.verdict, 'confirmed');
  assert.equal(capped.confidence, 1);
});

test('Ω-6d: 分支⑤ 其余（refuted×检出 / uncertain×任一）⇒ uncertain，置信 min(vlm, 0.6) 保守化', () => {
  // 反向分歧：云说没效果、像素说有变化 —— 同样降级
  const r1 = fuseWithPixelEvidence(cloud('refuted', 0.55), { detected: true, similarityPct: 40 });
  assert.equal(r1.verdict, 'uncertain');
  assert.equal(r1.confidence, 0.55); // min(0.55, 0.6)

  // 云脑本就 uncertain —— 保持 uncertain、置信保守化
  const r2 = fuseWithPixelEvidence(cloud('uncertain', 0.9), { detected: true, similarityPct: 20 });
  assert.equal(r2.verdict, 'uncertain');
  assert.equal(r2.confidence, 0.6); // min(0.9, 0.6)
  const r3 = fuseWithPixelEvidence(cloud('uncertain', 0.5), { detected: false, similarityPct: 95 });
  assert.equal(r3.verdict, 'uncertain');
  assert.equal(r3.confidence, 0.5); // min(0.5, 0.6)
});

// ─── Ω-6e chatJson 失败 / 抛错 ───

test('Ω-6e: chatJson 失败 ⇒ ok:false + degraded（error 透传），绝不抛', async () => {
  const { client } = fakeClient(() => ({ ok: false, error: 'mock glm outage', raw: 'no-json' }));
  const r = await judgeEffect(
    await makePng(100, 80, WHITE), await makePng(100, 80, BLACK),
    '任意预期', { client },
  );
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
  assert.equal(r.verdict, 'uncertain');
  assert.equal(r.scale, 'none');
  assert.equal(r.explanation, '');
  assert.equal(r.confidence, 0);
  assert.match(r.error ?? '', /mock glm outage/);
  assert.ok(Number.isFinite(r.latencyMs) && r.latencyMs >= 0);
});

test('Ω-6e: 注入 client 抛错 / 空 buffer —— 外层兜底收敛为返回值，绝不越狱上抛', async () => {
  const thrower = {
    chatJson: async () => { throw new Error('injected client blew up'); },
  } as unknown as GlmClientLike;

  const r1 = await judgeEffect(
    await makePng(60, 40, WHITE), await makePng(60, 40, BLACK),
    'x', { client: thrower },
  );
  assert.equal(r1.ok, false);
  assert.equal(r1.degraded, true);
  assert.match(r1.error ?? '', /blew up/);

  // 空 before buffer —— 编码前的守卫（且轮不到 client）
  const r2 = await judgeEffect(Buffer.alloc(0), await makePng(60, 40, BLACK), 'x', { client: thrower });
  assert.equal(r2.ok, false);
  assert.equal(r2.degraded, true);
  assert.match(r2.error ?? '', /before/);
});

test('Ω-6e: 真 GlmClient（假 fetch）端到端 —— 围栏 JSON 剥壳解析成功', async () => {
  const real = new GlmClient({
    apiKey: 'test-key',
    fetchImpl: fakeFetchWithContent(
      '```json\n{"verdict":"refuted","scale":"none","explanation":"两图一致","confidence":0.66}\n```',
    ),
  });
  const r = await judgeEffect(
    await makePng(120, 60, WHITE), await makePng(120, 60, BLACK),
    '窗口关闭', { client: real },
  );
  assert.equal(r.ok, true);
  assert.equal(r.degraded, false);
  assert.equal(r.verdict, 'refuted');
  assert.equal(r.scale, 'none');
  assert.equal(r.explanation, '两图一致');
  assert.equal(r.confidence, 0.66);
});
