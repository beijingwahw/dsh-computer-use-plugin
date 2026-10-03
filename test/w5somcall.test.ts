// test/w5somcall.test.ts
// W5-4（SoM 稀疏标注生产调用面）测试面：W1-7 三件装备（sparseBudget/scores/
// routeLabels/stableColors）从「零调用方」接进 orchestration L3 适配器的生产
// 管线（截屏 → 编码前叠加 → grounding → 归一化）。全离线确定性：
//   - sharp 现场合成纯色 PNG（真像素、真编码 —— 叠加是否进图可像素级断言）；
//   - 假 GLM client（chatJson 桩，记录全部请求 —— 收到的 base64 可解码回看）；
//   - 假 marker 种子（含/不含 probe 置信 —— interactivityProbe 以数据面注入，
//     绝不 import 真探针，零键鼠零网络）；
//   - 内核键 som.sparseBudget / grounding.verifyZoom 测试自管（生产由宿主铸入）。
// 覆盖验收面：预算>0 走叠加 / 0·负·非有限直通（逐字节现状）/ scores 组装
// （有/无 probe 置信）/ 坐标闭环正确 / 降级四路 / 确定性幂等 / 叠加事件可观测。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { default as sharp } from 'sharp';
import { kernelRegistry } from '../src/kernel/registry.ts';
import { resetVerifyGateBudget } from '../src/vlm/grounding.ts';
import {
  createSemanticFromVlm,
  type SomMarkerSeed,
  type SomPipelineEvent,
} from '../src/orchestration/visionAdapters.ts';
import {
  assembleSomScores, renderSomOverlay,
} from '../src/vlm/som.ts';
import type { GlmClient } from '../src/vlm/glmClient.ts';

// ─── 假件工坊 ───

/** 纯灰 PNG（确定性底图：128 灰 —— 叠加芯片/描边任何鲜艳色都与它可分辨） */
async function solidPng(width: number, height: number, value = 128): Promise<Buffer> {
  return sharp(Buffer.alloc(width * height * 3, value), {
    raw: { width, height, channels: 3 },
  }).png().toBuffer();
}

/** chatJson 假 client：记录全部请求（images[0].base64 是编码后进 VLM 的图） */
function fakeVlm(value: () => unknown): { client: GlmClient; calls: any[] } {
  const calls: any[] = [];
  const client = {
    configured: true,
    chatJson: async (req: any) => {
      calls.push(req);
      return { ok: true, value: value(), raw: '' };
    },
    chat: async () => ({ ok: true, text: '' }),
  } as unknown as GlmClient;
  return { client, calls };
}

/** 假 VLM 收到的图：base64 → 原始像素（dims + 逐像素断言的原料） */
async function decodeReceived(call: any): Promise<{ data: Buffer; info: any }> {
  const b64: string = call?.images?.[0]?.base64;
  assert.ok(typeof b64 === 'string' && b64.length > 0, '请求应携带 base64 图像');
  const out = await sharp(Buffer.from(b64, 'base64'))
    .raw()
    .toBuffer({ resolveWithObject: true }) as unknown as { data: Buffer; info: any };
  return out;
}

/** 原始像素取色（3 通道行主序） */
function px(d: Buffer, info: any, x: number, y: number): { r: number; g: number; b: number } {
  const i = (y * info.width + x) * info.channels;
  return { r: d[i]!, g: d[i + 1]!, b: d[i + 2]! };
}

/** 全屏分区（RegionSpec 方言） */
const FULL = { id: 'g0x0', x: 0, y: 0, width: 1, height: 1 };

/** 种子速记：像素 bbox + 文本 + probe 置信 */
function seed(x0: number, y0: number, x1: number, y1: number, text?: string, probeConfidence?: number): SomMarkerSeed {
  return { bbox: { x0, y0, x1, y1 }, ...(text !== undefined ? { text } : {}), ...(probeConfidence !== undefined ? { probeConfidence } : {}) };
}

/** 假 VLM 回放元素（bbox = 屏幕像素系 —— 与种子同系，闭环断言的靶子） */
function vlmEls(...els: Array<{ label: string; bbox: [number, number, number, number] }>): () => unknown {
  return () => ({
    elements: els.map((e, i) => ({
      id: `x${i + 1}`, label: e.label, role: 'button', bbox: e.bbox, confidence: 0.9,
    })),
  });
}

/** 内核键测试自管（生产由宿主 src/index.ts 铸入 —— W2-0 同款先例） */
function registerSomKernels(): void {
  kernelRegistry.register({
    key: 'som.sparseBudget', organ: 'perception', defaultValue: 0, min: 0, max: 64,
    note: 'W5-4 测试注册（生产由宿主以 config.somSparseBudget 铸入）',
  });
  kernelRegistry.register({
    key: 'grounding.verifyZoom', organ: 'perception', defaultValue: 1, min: 0, max: 1,
    note: 'W5-4 测试注册',
  });
}

before(() => {
  registerSomKernels();
  kernelRegistry.set('som.sparseBudget', 0);
  kernelRegistry.set('grounding.verifyZoom', 0); // 隔离复核流量 —— chatJson 调用数可精确断言
  resetVerifyGateBudget();
});
after(() => {
  kernelRegistry.set('som.sparseBudget', 0);
  kernelRegistry.set('grounding.verifyZoom', 1);
  resetVerifyGateBudget();
});

// ─── scores 组装（纯函数：有/无 probe 置信） ───────────────────────

test('W5-4①: assembleSomScores —— probe 置信有限才在场；文本×任务都在场才有 relevance；脏输入防御', () => {
  // 有 probe 置信 + 有文本 + 有任务：两通道证据齐备
  const s = assembleSomScores(
    [{ text: '设置', probeConfidence: 0.97 }, { text: '取消', probeConfidence: 0.2 }],
    '打开设置',
  );
  assert.equal(s.length, 2);
  assert.equal(s[0]!.confidence, 0.97, 'probe 置信原样随行（clamp 归 selectSparseMarkers）');
  assert.ok('relevance' in s[0]! && typeof s[0]!.relevance === 'number', '相关度通道在场');
  assert.ok(s[0]!.relevance! >= 0 && s[0]!.relevance! <= 1, '相关度夹在 [0,1]');
  assert.ok((s[0]!.relevance ?? 0) >= (s[1]!.relevance ?? 0), '「设置」对任务不弱于「取消」（同尺可比）');

  // 无 probe 置信：confidence 键缺席（通道缺席 ≠ 0 分 —— 不混淆两种决策）
  const noConf = assembleSomScores([{ text: '设置' }, {}], '打开设置');
  assert.ok(!('confidence' in noConf[0]!), '无置信 ⇒ 键缺席（非 0）');
  assert.ok(!('confidence' in noConf[1]!), '空种子 ⇒ 键缺席');

  // 无文本 / 无任务 ⇒ relevance 键缺席（无语义证据 ≠ 0 分）
  assert.ok(!('relevance' in assembleSomScores([{ text: '' }], '打开设置')[0]!), '空文本 ⇒ 无相关度');
  assert.ok(!('relevance' in assembleSomScores([{ text: '设置' }], '')[0]!), '空任务 ⇒ 无相关度');

  // 非有限 probe 置信 ⇒ 键缺席；非数组入参 ⇒ []（防御绝不抛）
  assert.ok(!('confidence' in assembleSomScores([{ probeConfidence: Number.NaN }], 't')[0]!), 'NaN 置信 ⇒ 键缺席');
  assert.deepEqual(assembleSomScores(undefined, 't'), []);
  assert.deepEqual(assembleSomScores('garbage' as unknown as never, 't'), []);
});

// ─── 预算>0 走叠加（happy path：叠加图真的进编码） ─────────────────

test('W5-4②: 预算>0 ⇒ 叠加进编码 —— 同尺寸合成、标签芯片像素在场、事件如实记账', async () => {
  const png = await solidPng(200, 150);
  const fake = fakeVlm(vlmEls({ label: '设置', bbox: [20, 20, 90, 80] }, { label: '取消', bbox: [120, 30, 180, 90] }));
  const events: SomPipelineEvent[] = [];
  const src = createSemanticFromVlm({
    capture: async () => png,
    screenSize: async () => ({ width: 200, height: 150 }),
    client: fake.client,
    somSparseBudget: 8,
    somMarkers: async () => [
      seed(20, 20, 90, 80, '设置', 0.97),
      seed(120, 30, 180, 90, '取消', 0.2),
    ],
    onSomEvent: ev => events.push(ev),
  });

  const els = await src.ground(FULL, '打开设置');
  assert.equal(els.length, 2, 'grounding 照常产出（叠加不改变元素面）');
  assert.equal(fake.calls.length, 1, '恰好一次主定位（复核闸已隔离关闭）');

  // 事件记账：元素数 / 预算 / 选中集（可观测面）
  assert.equal(src.somEventLog().length, 1);
  const ev = src.somEventLog()[0]!;
  assert.equal(ev.applied, true);
  assert.equal(ev.budget, 8);
  assert.equal(ev.elementsIn, 2);
  assert.deepEqual(ev.selected, [1, 2]);
  assert.notEqual(ev.sparseFallback, true, '双通道证据在场 ⇒ 不回退全量');
  assert.deepEqual(events, src.somEventLog(), '遥测回调与账本同源同序');

  // 叠加图真的进了 VLM：解码收到的图，尺寸不变（零缩放零裁剪），
  // marker1 的 down 向标签芯片中心 (30,94) 不再是背景灰
  const { data, info } = await decodeReceived(fake.calls[0]);
  assert.equal(info.width, 200, '坐标闭环前提①：叠加同尺寸（宽）');
  assert.equal(info.height, 150, '坐标闭环前提①：叠加同尺寸（高）');
  const chip = px(data, info, 30, 94);
  const far = px(data, info, 195, 145); // 远离任何标记的背景锚点
  const maxDrift = (p: { r: number; g: number; b: number }) =>
    Math.max(Math.abs(p.r - 128), Math.abs(p.g - 128), Math.abs(p.b - 128));
  assert.ok(maxDrift(chip) > 30, `芯片像素应显著偏离背景灰（实得 rgb(${chip.r},${chip.g},${chip.b})）`);
  assert.ok(maxDrift(far) <= 6, `背景应保持原灰（实得 rgb(${far.r},${far.g},${far.b})）`);
});

// ─── 预算 0 / 负 / 非有限 ⇒ 原图直通（逐字节现状） ─────────────────

test('W5-4③: 预算 0/负/非有限 ⇒ 直通 —— 收到的图与「完全无 SoM 接线」逐字节一致', async () => {
  const png = await solidPng(200, 150);
  const els = vlmEls({ label: '设置', bbox: [20, 20, 90, 80] });
  const seeds = async () => [seed(20, 20, 90, 80, '设置', 0.97)];

  // 对照组：完全无 SoM 接线（现状路径）
  const control = fakeVlm(els);
  await createSemanticFromVlm({
    capture: async () => png, screenSize: async () => ({ width: 200, height: 150 }),
    client: control.client,
  }).ground(FULL, '打开设置');
  const b64Control = control.calls[0].images[0].base64 as string;

  for (const bad of [0, -3, Number.NaN, Number.NEGATIVE_INFINITY]) {
    const fake = fakeVlm(els);
    const src = createSemanticFromVlm({
      capture: async () => png, screenSize: async () => ({ width: 200, height: 150 }),
      client: fake.client,
      somSparseBudget: bad,
      somMarkers: seeds, // 证据在场也拦不住预算闸 —— 预算关是一票否决
    });
    const out = await src.ground(FULL, '打开设置');
    assert.equal(out.length, 1, `budget=${String(bad)}：grounding 照常`);
    assert.equal(fake.calls[0].images[0].base64, b64Control, `budget=${String(bad)}：进 VLM 的图逐字节 = 现状`);
    const ev = src.somEventLog()[0]!;
    assert.equal(ev.applied, false);
    assert.equal(ev.reason, 'budget-off');
    assert.equal(ev.budget, 0, '事件里预算如实记 0（关）');
    assert.equal(ev.degraded, undefined, '常态直通不是降级（区别于叠加失败）');
  }

  // 内核键通道：注册而未设（缺省 0）同样直通 —— config.somSparseBudget 缺省 0 的生产语义
  const kn = fakeVlm(els);
  const srcKn = createSemanticFromVlm({
    capture: async () => png, screenSize: async () => ({ width: 200, height: 150 }),
    client: kn.client,
    somMarkers: seeds, // 不给显式预算 —— 走内核键缺省
  });
  await srcKn.ground(FULL, '打开设置');
  assert.equal(kn.calls[0].images[0].base64, b64Control, '内核键缺省 0 ⇒ 逐字节现状');
  assert.equal(srcKn.somEventLog()[0]!.reason, 'budget-off');
});

// ─── 预算通道：内核键生效 + 显式入参压过内核键 ─────────────────────

test('W5-4④: 内核键 som.sparseBudget 生效；显式入参恒压过内核键（裁决序可观测）', async () => {
  const png = await solidPng(240, 160);
  const four = [
    seed(10, 10, 50, 40, '甲', 0.9),
    seed(60, 10, 100, 40, '乙', 0.5),
    seed(110, 10, 150, 40, '丙', 0.3),
    seed(160, 10, 200, 40, '丁', 0.1),
  ];
  const fake = fakeVlm(vlmEls({ label: '甲', bbox: [10, 10, 50, 40] }));

  // 内核键 2（显式入参缺席）：Top-2 = 高置信者 {甲,乙}
  kernelRegistry.set('som.sparseBudget', 2);
  const srcKn = createSemanticFromVlm({
    capture: async () => png, screenSize: async () => ({ width: 240, height: 160 }),
    client: fake.client, somMarkers: async () => four,
  });
  await srcKn.ground(FULL, '');
  let ev = srcKn.somEventLog()[0]!;
  assert.equal(ev.applied, true);
  assert.equal(ev.budget, 2, '预算读自内核键');
  assert.equal(ev.elementsIn, 4);
  assert.deepEqual(ev.selected, [1, 2], '置信降序 Top-2（甲 0.9 > 乙 0.5）');

  // 显式入参 3 压过内核键 2：Top-3
  const srcOpt = createSemanticFromVlm({
    capture: async () => png, screenSize: async () => ({ width: 240, height: 160 }),
    client: fake.client, somSparseBudget: 3, somMarkers: async () => four,
  });
  await srcOpt.ground(FULL, '');
  ev = srcOpt.somEventLog()[0]!;
  assert.equal(ev.budget, 3, '显式入参恒压过内核键');
  assert.deepEqual(ev.selected, [1, 2, 3]);
  kernelRegistry.set('som.sparseBudget', 0);
});

// ─── scores 组装在调用面的效应：有/无 probe 置信两路裁决 ────────────

test('W5-4⑤: 有 probe 置信 ⇒ 置信定名额；无 probe 置信 ⇒ 任务相关度定名额；双缺席 ⇒ 诚实回退全量', async () => {
  const png = await solidPng(240, 160);
  const fake = fakeVlm(vlmEls({ label: '设置', bbox: [10, 10, 60, 50] }));

  // ① 有 probe 置信（同文本同相关度 ⇒ 置信是唯一判别量）
  const src1 = createSemanticFromVlm({
    capture: async () => png, screenSize: async () => ({ width: 240, height: 160 }),
    client: fake.client, somSparseBudget: 1,
    somMarkers: async () => [seed(10, 10, 60, 50, '设置', 0.2), seed(70, 10, 120, 50, '设置', 0.95)],
  });
  await src1.ground(FULL, '打开设置');
  assert.deepEqual(src1.somEventLog()[0]!.selected, [2], '置信 0.95 胜 0.2（id=原始下标+1）');

  // ② 无 probe 置信（confidence 键全体缺席 ⇒ 中性 1）：任务相关度裁决
  const src2 = createSemanticFromVlm({
    capture: async () => png, screenSize: async () => ({ width: 240, height: 160 }),
    client: fake.client, somSparseBudget: 1,
    somMarkers: async () => [seed(10, 10, 60, 50, '取消'), seed(70, 10, 120, 50, '设置')],
  });
  await src2.ground(FULL, '打开设置');
  assert.deepEqual(src2.somEventLog()[0]!.selected, [2], '「设置」对任务「打开设置」相关度更高 ⇒ 胜出');

  // ③ 双通道皆缺席（无置信 + 空任务）⇒ W1-7 诚实回退全量（不假装知道优先级）
  const src3 = createSemanticFromVlm({
    capture: async () => png, screenSize: async () => ({ width: 240, height: 160 }),
    client: fake.client, somSparseBudget: 1,
    somMarkers: async () => [seed(10, 10, 60, 50), seed(70, 10, 120, 50)],
  });
  await src3.ground(FULL, '');
  const ev3 = src3.somEventLog()[0]!;
  assert.equal(ev3.applied, true);
  assert.equal(ev3.sparseFallback, true, '证据双缺席 ⇒ 回退全量如实上报');
  assert.deepEqual(ev3.selected, [1, 2]);
});

// ─── 坐标闭环：叠加不改坐标系，模型回话即原图像素系 ─────────────────

test('W5-4⑥: 坐标闭环 —— 叠加前后同尺寸，锚点 bbox 回话经归一化后与真值重合（≤1e-9）', async () => {
  const W = 200, H = 150;
  const png = await solidPng(W, H);
  const truth = { x0: 20, y0: 20, x1: 90, y1: 80 };
  const fake = fakeVlm(vlmEls({ label: '设置', bbox: [20, 20, 90, 80] })); // 假 VLM 按锚点回 echo
  const src = createSemanticFromVlm({
    capture: async () => png, screenSize: async () => ({ width: W, height: H }),
    client: fake.client, somSparseBudget: 4,
    somMarkers: async () => [seed(20, 20, 90, 80, '设置', 0.97)],
  });
  const els = await src.ground(FULL, '打开设置');

  // 闭环①：渲染器输出与原图同尺寸（同 buffer 元数据 SVG、top/left=0、无缩放裁剪）
  const direct = await renderSomOverlay(png, {
    markers: [{ id: 1, bbox: truth, center: { x: 55, y: 50 }, text: '设置' }],
    sparseBudget: 4, routeLabels: true, stableColors: true,
    scores: assembleSomScores([{ text: '设置', probeConfidence: 0.97 }], '打开设置'),
  });
  assert.ok(direct.ok && direct.width === W && direct.height === H, '叠加输出与原图逐像素同尺寸');

  // 闭环②：进 VLM 的编码图同尺寸（as-is 不缩放）⇒ 模型回话坐标系 == 原图像素系
  const { info } = await decodeReceived(fake.calls[0]);
  assert.equal(info.width, W); assert.equal(info.height, H);

  // 闭环③：端到端 —— 像素回话 → 适配器归一化 → 与真值归一化重合
  assert.equal(els.length, 1);
  const rect = els[0]!.rect;
  const eps = 1e-9;
  assert.ok(Math.abs(rect.x - truth.x0 / W) < eps, `x 闭环（${rect.x} vs ${truth.x0 / W}）`);
  assert.ok(Math.abs(rect.y - truth.y0 / H) < eps, `y 闭环（${rect.y} vs ${truth.y0 / H}）`);
  assert.ok(Math.abs(rect.width - (truth.x1 - truth.x0) / W) < eps, 'width 闭环');
  assert.ok(Math.abs(rect.height - (truth.y1 - truth.y0) / H) < eps, 'height 闭环');

  // 闭环④：种子区域过滤（中心落区律与 L1/L2 同源）—— 右半区只留右半标记
  const fake2 = fakeVlm(vlmEls({ label: '取消', bbox: [120, 30, 180, 90] }));
  const src2 = createSemanticFromVlm({
    capture: async () => png, screenSize: async () => ({ width: W, height: H }),
    client: fake2.client, somSparseBudget: 4,
    somMarkers: async () => [seed(20, 20, 90, 80, '设置', 0.97), seed(120, 30, 180, 90, '取消', 0.9)],
  });
  await src2.ground({ id: 'r', x: 0.5, y: 0, width: 0.5, height: 1 }, '打开设置');
  const ev2 = src2.somEventLog()[0]!;
  assert.equal(ev2.elementsIn, 1, '区域外种子被分派律过滤');
  // id 为过滤后重编的稠密序（1..K 无空洞 —— 编号是给 VLM 的锚点语义，
  // 过滤后跳号会让「点 2 号」找不到 1 号而显得突兀）；渲染序 = 种子原序
  assert.deepEqual(ev2.selected, [1], '幸存者（原第 2 颗种子）重编为 1 号');
});

// ─── 降级四路：预算关 / 供给口缺席 / 元素面空 / 叠加失败 ────────────

test('W5-4⑦: 降级四路 —— 每路原图直通 + 归因入事件；叠加失败带 degraded 注记', async () => {
  const png = await solidPng(200, 150);
  const els = vlmEls({ label: '设置', bbox: [20, 20, 90, 80] });

  // 路① probe/证据供给口缺席（宿主未接线）：预算>0 也直通
  const f1 = fakeVlm(els);
  const s1 = createSemanticFromVlm({
    capture: async () => png, screenSize: async () => ({ width: 200, height: 150 }),
    client: f1.client, somSparseBudget: 4, // somMarkers 缺席
  });
  assert.equal((await s1.ground(FULL, '打开设置')).length, 1);
  let ev = s1.somEventLog()[0]!;
  assert.equal(ev.applied, false); assert.equal(ev.reason, 'marker-port-absent');
  { const { data, info } = await decodeReceived(f1.calls[0]); // 芯片位仍是背景灰 ⇒ 原图直通
    const c = px(data, info, 30, 94);
    assert.ok(Math.abs(c.r - 128) <= 6 && Math.abs(c.g - 128) <= 6, `直通未叠加（rgb(${c.r},${c.g},${c.b})）`); }

  // 路② 元素面为空（供给空数组 / 全脏种子）
  for (const supply of [async () => [], async () => [
    seed(Number.NaN, 0, 10, 10),            // NaN bbox —— 脏种子跳过
    seed(20, 20, 20, 80),                    // 零宽退化 —— 跳过
    null as unknown as SomMarkerSeed,        // 垃圾项 —— 跳过
  ]]) {
    const f2 = fakeVlm(els);
    const s2 = createSemanticFromVlm({
      capture: async () => png, screenSize: async () => ({ width: 200, height: 150 }),
      client: f2.client, somSparseBudget: 4, somMarkers: supply,
    });
    assert.equal((await s2.ground(FULL, '打开设置')).length, 1, 'grounding 不受影响');
    ev = s2.somEventLog()[0]!;
    assert.equal(ev.applied, false); assert.equal(ev.reason, 'elements-empty');
  }

  // 路③ 叠加失败（sharp 链失败模拟：capture 给非图缓冲）⇒ 原图直通 + degraded 注记；
  //   随后 grounding 编码同样失败 ⇒ 诚实上抛（失败是 grounding 自己的，不是 SoM 的）
  const f3 = fakeVlm(els);
  const s3 = createSemanticFromVlm({
    capture: async () => Buffer.from('definitely not an image'),
    screenSize: async () => ({ width: 200, height: 150 }),
    client: f3.client, somSparseBudget: 4,
    somMarkers: async () => [seed(20, 20, 90, 80, '设置', 0.97)],
  });
  await assert.rejects(() => s3.ground(FULL, '打开设置'), /decode|图像|image/i, '原图直通后按现状失败上抛');
  ev = s3.somEventLog()[0]!;
  assert.equal(ev.applied, false);
  assert.equal(ev.reason, 'overlay-failed');
  assert.equal(ev.degraded, true, '叠加失败 ⇒ 诚实降级注记');
  assert.ok(typeof ev.detail === 'string' && ev.detail.length > 0, '失败详情入事件');
  assert.equal(f3.calls.length, 0, '编码失败 ⇒ 未拨云脑（零网络浪费）');

  // 路④ 供给口抛错（probe 管线故障的数据面投影）⇒ 降级直通，grounding 照常成功
  const f4 = fakeVlm(els);
  const s4 = createSemanticFromVlm({
    capture: async () => png, screenSize: async () => ({ width: 200, height: 150 }),
    client: f4.client, somSparseBudget: 4,
    somMarkers: async () => { throw new Error('probe pipeline exploded'); },
  });
  assert.equal((await s4.ground(FULL, '打开设置')).length, 1, 'SoM 故障绝不带崩主管线');
  ev = s4.somEventLog()[0]!;
  assert.equal(ev.applied, false); assert.equal(ev.reason, 'marker-source-fault');
  assert.equal(ev.degraded, true);
  assert.match(ev.detail ?? '', /probe pipeline exploded/);

  // 路外加固：遥测回调抛错被吞（观察面绝不毒化主管线）
  const f5 = fakeVlm(els);
  const s5 = createSemanticFromVlm({
    capture: async () => png, screenSize: async () => ({ width: 200, height: 150 }),
    client: f5.client, somSparseBudget: 0,
    onSomEvent: () => { throw new Error('telemetry sink exploded'); },
  });
  assert.equal((await s5.ground(FULL, '打开设置')).length, 1, '遥测面故障被吞');
  assert.equal(s5.somEventLog().length, 1, '账本仍然记账');
});

// ─── 确定性 / 幂等 ─────────────────────────────────────────────────

test('W5-4⑧: 确定性幂等 —— 同输入两次 ground，进 VLM 的图逐字节一致、事件同形', async () => {
  const png = await solidPng(200, 150);
  const fake = fakeVlm(vlmEls({ label: '设置', bbox: [20, 20, 90, 80] }));
  const src = createSemanticFromVlm({
    capture: async () => png, screenSize: async () => ({ width: 200, height: 150 }),
    client: fake.client, somSparseBudget: 4,
    somMarkers: async () => [seed(20, 20, 90, 80, '设置', 0.97), seed(120, 30, 180, 90, '取消', 0.2)],
  });
  await src.ground(FULL, '打开设置');
  await src.ground(FULL, '打开设置');
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0].images[0].base64, fake.calls[1].images[0].base64, '叠加+编码全链确定性');
  assert.equal(fake.calls[0].prompt, fake.calls[1].prompt, '提示词同形（坐标语义未漂移）');
  const [e1, e2] = src.somEventLog();
  assert.deepEqual(
    { applied: e1!.applied, budget: e1!.budget, elementsIn: e1!.elementsIn, selected: e1!.selected },
    { applied: e2!.applied, budget: e2!.budget, elementsIn: e2!.elementsIn, selected: e2!.selected },
    '事件同形（幂等可观测）',
  );
});

// ─── 翻转默认的证据链（模拟假 VLM：锚点在场 ⇒ 元素引用更准） ────────

test('W5-4⑨: 翻转证据（模拟）—— 带锚点图调用时假 VLM 按锚点回 echo，定位误差 0；无锚点漂移可测', async () => {
  const W = 200, H = 150;
  const png = await solidPng(W, H);
  const truth = { x0: 20, y0: 20, x1: 90, y1: 80 }; // 屏上真值元素
  const drift = { x0: 30, y0: 30, x1: 100, y1: 90 }; // 无锚点时假 VLM 的模拟漂移 (+10,+10)

  // 场景 A（现状：预算 0 无叠加）：假 VLM 漂移作答
  const fa = fakeVlm(vlmEls({ label: '设置', bbox: [drift.x0, drift.y0, drift.x1, drift.y1] }));
  const sa = createSemanticFromVlm({
    capture: async () => png, screenSize: async () => ({ width: W, height: H }),
    client: fa.client, somSparseBudget: 0,
    somMarkers: async () => [seed(truth.x0, truth.y0, truth.x1, truth.y1, '设置', 0.97)],
  });
  const ea = (await sa.ground(FULL, '打开设置'))[0]!.rect;

  // 场景 B（叠加开）：假 VLM 按编号锚点回 echo（锚点跟随）
  const fb = fakeVlm(vlmEls({ label: '设置', bbox: [truth.x0, truth.y0, truth.x1, truth.y1] }));
  const sb = createSemanticFromVlm({
    capture: async () => png, screenSize: async () => ({ width: W, height: H }),
    client: fb.client, somSparseBudget: 4,
    somMarkers: async () => [seed(truth.x0, truth.y0, truth.x1, truth.y1, '设置', 0.97)],
  });
  const eb = (await sb.ground(FULL, '打开设置'))[0]!.rect;

  // 两场景进 VLM 的图：同尺寸、不同字节（叠加确实改写了视觉面）
  const aB64 = fa.calls[0].images[0].base64 as string;
  const bB64 = fb.calls[0].images[0].base64 as string;
  assert.notEqual(aB64, bB64, '叠加改写出图');
  const da = await decodeReceived(fa.calls[0]); const db = await decodeReceived(fb.calls[0]);
  assert.equal(da.info.width, db.info.width); assert.equal(da.info.height, db.info.height);

  // 误差度量（归一化系）：B 精确命中；A 的中心误差 = 漂移量
  const ctr = (r: { x: number; y: number; width: number; height: number }) =>
    ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  const tb = { x: truth.x0 / W + (truth.x1 - truth.x0) / 2 / W, y: truth.y0 / H + (truth.y1 - truth.y0) / 2 / H };
  const cb = ctr(eb); const ca = ctr(ea);
  assert.ok(Math.abs(cb.x - tb.x) < 1e-9 && Math.abs(cb.y - tb.y) < 1e-9, '锚点跟随 ⇒ 中心误差 0');
  assert.ok(Math.abs(ca.x - tb.x - 10 / W) < 1e-9 && Math.abs(ca.y - tb.y - 10 / H) < 1e-9,
    `无锚点漂移可测（+${10 / W}, +${10 / H}）`);
  // 诚实边界：这是注入假 VLM 的模拟证据（真模型增益需在线 A/B —— 报告据此给翻转建议）
});
