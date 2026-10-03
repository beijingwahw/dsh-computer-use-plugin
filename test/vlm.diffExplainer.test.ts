// test/vlm.diffExplainer.test.ts
// 纪元 Ω（Ω-7）：diffExplainer 单测 —— 假 fetch 注入绝不联网，sharp 现场合成 PNG。
//
// 覆盖面：未配置降级 / 正常解析（乱序 label 对齐）/ 空 regions 语义 /
// 多余 label 丢弃与缺省编号 / label 全对不上时的按序对齐与宁缺毋滥 /
// chatJson 失败降级 / summary 硬截断 / 注入 client 违约抛错 / 围栏字符串兜底。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSharp, type SharpLike } from '../src/_legacyDeps.ts';
import { GlmClient, resetGlmClient } from '../src/vlm/glmClient.ts';

// 铁律：被测模块经动态 import 进入（不改变模块图，也不在加载期产生副作用）
const { explainDiff } = await import('../src/vlm/diffExplainer.ts');

// ─── sharp 现场合成（perceptualHash.test.ts 同款懒加载 + SKIP 守卫）───

let sharp: SharpLike | null = null;
async function requireSharp(): Promise<SharpLike> {
  if (!sharp) sharp = await getSharp();
  return sharp;
}

/** sharp 缺席时整个 case 标记 SKIP（批次 E 模式：不装原生依赖不红脸） */
async function withSharp<T>(
  t: { skip(msg: string): unknown },
  fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    await requireSharp();
  } catch (e: any) {
    t.skip(`sharp unavailable — ${e?.message?.slice(0, 200) ?? ''}`);
    return undefined;
  }
  return fn();
}

/** 合成两张不同的 320x200 PNG：before = 左上黑方块；after = 右下红方块 + 顶部蓝条 */
async function makeImagePair(): Promise<[Buffer, Buffer]> {
  const s = await requireSharp();
  const W = 320, H = 200;
  const paint = (rects: Array<[number, number, number, number, [number, number, number]]>): Buffer => {
    const buf = Buffer.alloc(W * H * 3, 255); // 白底
    for (const [x0, y0, w, h, rgb] of rects) {
      for (let y = y0; y < Math.min(H, y0 + h); y++) {
        for (let x = x0; x < Math.min(W, x0 + w); x++) {
          const i = (y * W + x) * 3;
          buf[i] = rgb[0]!; buf[i + 1] = rgb[1]!; buf[i + 2] = rgb[2]!;
        }
      }
    }
    return buf;
  };
  const toPng = (buf: Buffer) => s(buf, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  const before = await toPng(paint([[20, 20, 60, 60, [10, 10, 10]]]));
  const after = await toPng(paint([[200, 120, 60, 60, [200, 30, 30]], [0, 0, 320, 24, [30, 60, 200]]]));
  return [before, after];
}

// ─── 假 client 构造（真 GlmClient + 假 fetch —— 兄弟模块自带的测试缝）───

/** 假 fetch：固定回一条含指定 content 的 chat completion；bodies 捕获请求原文 */
function fakeGlmFetch(content: string, bodies?: string[]): typeof fetch {
  return (async (_url: unknown, init?: { body?: unknown }) => {
    if (bodies) bodies.push(String(init?.body ?? ''));
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

/** 假 fetch：恒定 HTTP 400（非可重试状态码，立即失败）—— 测 chatJson 失败臂 */
function failingGlmFetch(): typeof fetch {
  return (async () =>
    new Response('{"error":{"message":"bad request"}}', { status: 400 })) as unknown as typeof fetch;
}

/** 注入便捷构造：apiKey 走假值 + 假 fetch —— 绝不真实联网 */
function clientWith(content: string, bodies?: string[]): GlmClient {
  return new GlmClient({ apiKey: 'test-only', fetchImpl: fakeGlmFetch(content, bodies) });
}

/** 从捕获的请求体中取 user 消息（prompt 文本 + image_url 帧） */
function userMessageOf(body: string): { text: string; imageCount: number } {
  const payload = JSON.parse(body) as { messages: Array<{ role: string; content: any }> };
  const user = payload.messages.find(m => m.role === 'user')!;
  const parts: any[] = user.content;
  return {
    text: parts.filter(p => p.type === 'text').map(p => p.text).join(''),
    imageCount: parts.filter(p => p.type === 'image_url').length,
  };
}

// ─── 用例 ───

test('未配置降级：无注入 client 且环境无 apiKey → degraded:true，绝不抛', async () => {
  // 隔离环境 apiKey 与单例快照（isGlmConfigured 读单例或环境）
  delete process.env.GLM_API_KEY;
  delete process.env.ZHIPUAI_API_KEY;
  delete process.env.ZAI_API_KEY;
  resetGlmClient();
  const res = await explainDiff(Buffer.from([1]), Buffer.from([2]), [
    { bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } },
  ]);
  assert.equal(res.ok, false, '未配置 ⇒ 不算成功');
  assert.equal(res.degraded, true, '诚实降级标记');
  assert.equal(res.summary, '');
  assert.deepEqual(res.regionNotes, []);
  assert.match(res.error ?? '', /not configured/);
  assert.ok(Number.isFinite(res.latencyMs) && res.latencyMs >= 0, 'latencyMs 恒为有限非负数');
});

test('正常解析：乱序 label 精确对齐，输出按输入清单顺序', async (t) => withSharp(t, async () => {
  const [before, after] = await makeImagePair();
  const bodies: string[] = [];
  const res = await explainDiff(before, after, [
    { label: '色块区', bbox: { x0: 20, y0: 20, x1: 80, y1: 80 }, areaPct: 5.6 },
    { label: '顶栏', bbox: { x0: 0, y0: 0, x1: 320, y1: 24 } },
  ], {
    client: clientWith(JSON.stringify({
      summary: '色块从左上移动到右下并变红，顶部出现蓝色横条',
      regions: [
        { label: '顶栏', note: '顶部出现一条蓝色横幅' }, // 乱序：先返回第二个区域
        { label: '色块区', note: '黑色方块变为红色并移动到右下角' },
      ],
    }), bodies),
  });
  assert.equal(res.ok, true);
  assert.equal(res.degraded, false);
  assert.equal(res.summary, '色块从左上移动到右下并变红，顶部出现蓝色横条');
  assert.deepEqual(res.regionNotes, [
    { label: '色块区', note: '黑色方块变为红色并移动到右下角' },
    { label: '顶栏', note: '顶部出现一条蓝色横幅' },
  ], '乱序返回被 label 对齐纠正，顺序与输入一致');
  assert.equal(bodies.length, 1, '恰好一次 VLM 调用');
  const user = userMessageOf(bodies[0]!);
  assert.equal(user.imageCount, 2, '两帧截图随 prompt 下发');
  assert.ok(user.text.includes('label=色块区'), 'prompt 含区域清单');
  assert.ok(user.text.includes('面积占比=5.6'), 'areaPct 进入清单');
  assert.ok(Number.isFinite(res.latencyMs) && res.latencyMs >= 0);
}));

test('空 regions 语义：仍走一次调用总述两图差异，regionNotes 恒空', async (t) => withSharp(t, async () => {
  const [before, after] = await makeImagePair();
  const bodies: string[] = [];
  const res = await explainDiff(before, after, [], {
    client: clientWith(JSON.stringify({ summary: '整体从素色变为带色块界面', regions: [] }), bodies),
  });
  assert.equal(res.ok, true, '空 regions 不是错误 —— 总述仍算成功');
  assert.equal(res.summary, '整体从素色变为带色块界面');
  assert.deepEqual(res.regionNotes, []);
  assert.equal(bodies.length, 1, '恰好一次 VLM 调用');
  const user = userMessageOf(bodies[0]!);
  assert.ok(!user.text.includes('label='), 'prompt 无区域清单段');
  assert.ok(user.text.includes('总述'), 'prompt 明示总述语义');
}));

test('多余 label 丢弃：臆造区域不进清单，缺省 label 自动编号 ΔN', async (t) => withSharp(t, async () => {
  const [before, after] = await makeImagePair();
  const res = await explainDiff(before, after, [
    { bbox: { x0: 20, y0: 20, x1: 80, y1: 80 } }, // 无 label → Δ1
    { bbox: { x0: 0, y0: 0, x1: 320, y1: 24 } },  // 无 label → Δ2
  ], {
    client: clientWith(JSON.stringify({
      summary: '两处可见变化',
      regions: [
        { label: 'Δ2', note: '顶栏区域变化' },
        { label: 'Δ99', note: '臆造出来的区域' }, // 多余：输入清单之外 → 丢弃
        { label: 'Δ1', note: '色块区域变化' },
      ],
    })),
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.regionNotes, [
    { label: 'Δ1', note: '色块区域变化' },
    { label: 'Δ2', note: '顶栏区域变化' },
  ], 'Δ99 被丢弃；输出按输入顺序');
}));

test('label 全对不上：数量相等按序对齐；数量不等宁缺毋滥', async (t) => withSharp(t, async () => {
  const [before, after] = await makeImagePair();
  const regions = [
    { bbox: { x0: 20, y0: 20, x1: 80, y1: 80 } },
    { bbox: { x0: 0, y0: 0, x1: 320, y1: 24 } },
  ];
  const aligned = await explainDiff(before, after, regions, {
    client: clientWith(JSON.stringify({
      summary: '两处变化',
      regions: [
        { label: '区域一', note: '第一处变化' }, // VLM 自作主张改名
        { label: '区域二', note: '第二处变化' },
      ],
    })),
  });
  assert.equal(aligned.ok, true);
  assert.deepEqual(aligned.regionNotes, [
    { label: 'Δ1', note: '第一处变化' },
    { label: 'Δ2', note: '第二处变化' },
  ], '数量相等 → 按输入顺序位置对齐');

  const dropped = await explainDiff(before, after, regions, {
    client: clientWith(JSON.stringify({
      summary: '数量都不对',
      regions: [
        { label: '区域一', note: '一' },
        { label: '区域二', note: '二' },
        { label: '区域三', note: '三' }, // 3 对 2 —— 位置推断不可辩护
      ],
    })),
  });
  assert.equal(dropped.ok, true, 'summary 有效仍算成功');
  assert.deepEqual(dropped.regionNotes, [], '宁缺毋滥：注解全部丢弃');
}));

test('chatJson 失败降级：HTTP 400 → ok:false + degraded:true，绝不抛', async (t) => withSharp(t, async () => {
  const [before, after] = await makeImagePair();
  const res = await explainDiff(before, after, [{ bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } }], {
    client: new GlmClient({ apiKey: 'test-only', fetchImpl: failingGlmFetch() }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.degraded, true, '云脑路径未走通 → 降级标记');
  assert.equal(res.summary, '');
  assert.deepEqual(res.regionNotes, []);
  assert.match(res.error ?? '', /HTTP 400/);
}));

test('summary 超长硬截断：≤120 字（prompt 约束之外的第二道闸）', async (t) => withSharp(t, async () => {
  const [before, after] = await makeImagePair();
  const res = await explainDiff(before, after, [], {
    client: clientWith(JSON.stringify({ summary: '变'.repeat(200), regions: [] })),
  });
  assert.equal(res.ok, true);
  assert.equal(Array.from(res.summary).length, 120, '按码点截到 120 字');
}));

test('注入 client 违约抛错 → 收敛为 ok:false + degraded:true，绝不向上抛', async (t) => withSharp(t, async () => {
  const [before, after] = await makeImagePair();
  const evil = { chatJson: async () => { throw new Error('boom'); } } as unknown as GlmClient;
  const res = await explainDiff(before, after, [], { client: evil });
  assert.equal(res.ok, false);
  assert.equal(res.degraded, true);
  assert.match(res.error ?? '', /boom/);
}));

test('字符串兜底：回复被 ```json 围栏包裹仍可解析', async (t) => withSharp(t, async () => {
  const [before, after] = await makeImagePair();
  const res = await explainDiff(before, after, [{ label: 'Δ1', bbox: { x0: 0, y0: 0, x1: 5, y1: 5 } }], {
    client: clientWith('```json\n{"summary":"围栏里的总述","regions":[{"label":"Δ1","note":"围栏注解"}]}\n```'),
  });
  assert.equal(res.ok, true);
  assert.equal(res.summary, '围栏里的总述');
  assert.deepEqual(res.regionNotes, [{ label: 'Δ1', note: '围栏注解' }]);
}));
