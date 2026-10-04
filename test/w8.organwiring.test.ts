// test/w8.organwiring.test.ts
// W8（DEBTS D-B3/D-B4「已造未通电」器官接线）执法册：两条投喂线「接通且受控」
// —— 生效臂（开启时标记/失败轨迹确实到达消费面，注入假件捕获）+ 回归锁
//（关闭/缺省时行为与现状逐字节一致）+ 源级取证（src/index.ts 组合根字面接线
// 在场 —— w3wire/w7wire 同法）。全离线确定性：假 GLM client（chatJson 桩记录
// 全部请求，收到的 base64 可解码回看）、假无障碍树 provider、假失败记忆 dump、
// 注入时钟；零网络零键鼠。
//
//   D-B3（SoM 种子投喂）：createSomMarkerSeedSupply（src/vlm/som.ts W8 区）把
//     L1 a11y 元素 + 注入交互置信铸成种子流；接进 createSemanticFromVlm 的
//     somMarkers 端口后，预算>0 ⇒ 叠加图真正进入 VLM 调用面（编码后 base64
//     像素级断言）；预算 0（缺省）⇒ 供给口根本不被调用、收到的图与「无 SoM
//     接线」逐字节一致。生产接线：src/index.ts 铸 som.sparseBudget 内核键
//    （defaultValue=config.somSparseBudget，缺省 0 —— D-B1 缺省决策保持）。
//   D-B4（梦 failures 源投喂）：createDreamDeps（src/sleep/dreamFeed.ts）把
//     失败记忆 dump 面适配为 SleepDeps.dream；runSleepCycle 消费后 report.dream
//     在场且 entry id = 失败记录 id（失败轨迹真到达 runDreamReplay）；dream dep
//     缺席 ⇒ report.dream 缺席（六幕零漂移）；空失败集 ⇒ 诚实跳过注记。
//     生产接线：src/index.ts 卸载路径 enableSleepCycle（缺省 false）块内投喂
//     —— 开关关 ⇒ 现状逐字节保持（源级顺序断言锁）。
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { default as sharp } from 'sharp';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { kernelRegistry } from '../src/kernel/registry.ts';
import { resetVerifyGateBudget } from '../src/vlm/grounding.ts';
import { createSemanticFromVlm } from '../src/orchestration/visionAdapters.ts';
import {
  createSomMarkerSeedSupply, sanitizeSomSeedInput, type SomMarkerSeedInput,
} from '../src/vlm/som.ts';
import { setAccessibilityProvider } from '../src/uiExtractor.ts';
import type { GlmClient } from '../src/vlm/glmClient.ts';
import {
  runSleepCycle, resetSleepCycle, createDreamDeps,
} from '../src/sleep/index.ts';
import type { SleepDeps } from '../src/sleep/index.ts';

// ─── 假件工坊（w5somcall 同源纪律） ───

/** 纯灰 PNG（128 灰底 —— 叠加描边/芯片任何鲜艳色都与它可分辨） */
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

/** 假 VLM 收到的图：base64 → 原始像素 */
async function decodeReceived(call: any): Promise<{ data: Buffer; info: any }> {
  const b64: string = call?.images?.[0]?.base64;
  assert.ok(typeof b64 === 'string' && b64.length > 0, '请求应携带 base64 图像');
  return sharp(Buffer.from(b64, 'base64'))
    .raw()
    .toBuffer({ resolveWithObject: true }) as unknown as Promise<{ data: Buffer; info: any }>;
}

/** 原始像素取色（3 通道行主序） */
function px(d: Buffer, info: any, x: number, y: number): { r: number; g: number; b: number } {
  const i = (y * info.width + x) * info.channels;
  return { r: d[i]!, g: d[i + 1]!, b: d[i + 2]! };
}

const FULL = { id: 'g0x0', x: 0, y: 0, width: 1, height: 1 };

/** 假 VLM 回放元素（bbox = 屏幕像素系 —— 与种子同系，闭环断言的靶子） */
function vlmEls(...els: Array<{ label: string; bbox: [number, number, number, number] }>): () => unknown {
  return () => ({
    elements: els.map((e, i) => ({
      id: `x${i + 1}`, label: e.label, role: 'button', bbox: e.bbox, confidence: 0.9,
    })),
  });
}

/** 假无障碍树：两个按钮（像素 rect —— uiExtractor 的原始方言） */
function fakeA11yTree(): unknown {
  return {
    rect: { x: 0, y: 0, width: 800, height: 600 }, role: 'root', name: 'root', children: [
      { rect: { x: 10, y: 10, width: 50, height: 40 }, role: 'Button', name: '设置', children: [] },
      { rect: { x: 120, y: 30, width: 60, height: 45 }, role: 'Button', name: '取消', children: [] },
      // 正文节点（非可交互角色）—— 供源的双闸门应排除它
      { rect: { x: 300, y: 300, width: 200, height: 24 }, role: 'Text', name: '一段正文', children: [] },
    ],
  };
}

// ─── 内核键测试自管（生产由宿主 src/index.ts 铸入 —— W2-0 同款先例） ───

before(() => {
  kernelRegistry.register({
    key: 'som.sparseBudget', organ: 'perception', defaultValue: 0, min: 0, max: 64,
    note: 'W8 测试注册（生产由宿主以 config.somSparseBudget 铸入 —— 源级取证另锁）',
  });
  kernelRegistry.register({
    key: 'grounding.verifyZoom', organ: 'perception', defaultValue: 1, min: 0, max: 1,
    note: 'W8 测试注册',
  });
  kernelRegistry.set('som.sparseBudget', 0);
  kernelRegistry.set('grounding.verifyZoom', 0); // 隔离复核流量 —— chatJson 调用数可精确断言
  resetVerifyGateBudget();
});

afterEach(() => {
  setAccessibilityProvider(null as never); // 还原全局 provider，不泄漏给后续测试
  kernelRegistry.set('som.sparseBudget', 0);
});

after(() => {
  kernelRegistry.set('som.sparseBudget', 0);
  kernelRegistry.set('grounding.verifyZoom', 1);
  resetVerifyGateBudget();
  resetSleepCycle();
});

// ═══ D-B3：SoM 种子投喂（som.ts 供源工装 → somMarkers 端口 → VLM 调用面） ═══

test('W8-B3①: sanitizeSomSeedInput —— 合法直通 / 垃圾剔除 / 键缺席语义（防御绝不抛）', () => {
  // 合法：bbox + 文本 + 置信原样随行
  const ok = sanitizeSomSeedInput({ bbox: { x0: 1, y0: 2, x1: 30, y1: 40 }, text: '设置', probeConfidence: 0.97 });
  assert.deepEqual(ok, { bbox: { x0: 1, y0: 2, x1: 30, y1: 40 }, text: '设置', probeConfidence: 0.97 });
  // 垃圾bbox：非对象 / NaN / 非有限 / 零尺寸 / 反向 ⇒ null（静默剔除不毒化）
  for (const bad of [null, 42, 'x', {}, { bbox: null }, { bbox: { x0: Number.NaN, y0: 0, x1: 1, y1: 1 } },
    { bbox: { x0: 0, y0: 0, x1: 0, y1: 10 } }, { bbox: { x0: 5, y0: 0, x1: 1, y1: 10 } }]) {
    assert.equal(sanitizeSomSeedInput(bad), null, `垃圾输入应剔除：${JSON.stringify(bad)}`);
  }
  // 键缺席语义：空白文本 ⇒ 无 text 键；非有限置信 ⇒ 无 probeConfidence 键（无证据 ≠ 0 分）
  const noText = sanitizeSomSeedInput({ bbox: { x0: 0, y0: 0, x1: 5, y1: 5 }, text: '  ' })!;
  assert.ok(!('text' in noText), '空白文本 ⇒ 键缺席');
  const noConf = sanitizeSomSeedInput({ bbox: { x0: 0, y0: 0, x1: 5, y1: 5 }, probeConfidence: Number.NaN })!;
  assert.ok(!('probeConfidence' in noConf), 'NaN 置信 ⇒ 键缺席');
});

test('W8-B3②: createSomMarkerSeedSupply —— a11y 通道产种 / 交互置信数据面随行 / 通道缺席诚实降级', async () => {
  setAccessibilityProvider(async () => fakeA11yTree());
  const probes: Array<Array<{ x: number; y: number }>> = [];
  const supply = createSomMarkerSeedSupply({
    // 不投 capture ⇒ OCR 通道诚实缺席（仅 a11y 面）—— 缺席不是故障
    probeConfidence: async points => {
      probes.push(points);
      return [0.97, Number.NaN]; // 第二个：垃圾值 ⇒ 键缺席（诚实无证据）
    },
  });
  const seeds = await supply();
  // 双闸门后恰好两个按钮种子；正文 Text 节点被角色闸排除
  assert.equal(seeds.length, 2, 'a11y 通道产出 2 粒种子（Text 正文被角色闸排除）');
  assert.deepEqual(seeds[0]!.bbox, { x0: 10, y0: 10, x1: 60, y1: 50 }, '像素 rect → bbox 直通（零换算）');
  assert.equal(seeds[0]!.text, '设置', '元素名称随行（taskRelevance 的输入）');
  assert.equal(seeds[0]!.probeConfidence, 0.97, '注入置信按中心点序对齐随行');
  assert.ok(!('probeConfidence' in seeds[1]!), '垃圾置信 ⇒ 键缺席（无证据 ≠ 0 分）');
  // 置信面按种子中心点批量问询（(10+60)/2=35, (10+50)/2=30）
  assert.equal(probes.length, 1);
  assert.deepEqual(probes[0]![0], { x: 35, y: 30 });

  // 置信面抛错 ⇒ 种子照常供给、键全体缺席（探针是增益不是前提，绝不毒化种子面）
  const faultSupply = createSomMarkerSeedSupply({
    probeConfidence: async () => { throw new Error('probe exploded'); },
  });
  const faultSeeds = await faultSupply();
  assert.equal(faultSeeds.length, 2, '置信面故障 ⇒ 种子面不受影响');
  assert.ok(faultSeeds.every(s => !('probeConfidence' in s)), '故障 ⇒ 置信键全体缺席');
});

test('W8-B3③: 无面供给（零配置）⇒ 诚实空集；供给口绝不抛', async () => {
  setAccessibilityProvider(null as never); // a11y 通道缺席
  const supply = createSomMarkerSeedSupply(); // 无 capture / 无 screenSize / 无置信面
  assert.deepEqual(await supply(), [], '全通道缺席 ⇒ []（适配器记 elements-empty 直通）');
});

test('W8-B3④: 【生效臂】预算开 ⇒ 供给种子真进 VLM 调用面 —— 叠加图替换原图进编码', async () => {
  const png = await solidPng(200, 150);
  setAccessibilityProvider(async () => fakeA11yTree());
  let supplyCalls = 0;
  const supply = createSomMarkerSeedSupply({
    probeConfidence: async () => [0.97, 0.95],
  });
  const fake = fakeVlm(vlmEls({ label: '设置', bbox: [20, 20, 90, 80] }));
  const src = createSemanticFromVlm({
    capture: async () => png,
    screenSize: async () => ({ width: 200, height: 150 }),
    client: fake.client,
    somMarkers: async () => {
      supplyCalls += 1;
      return supply();
    },
  });

  kernelRegistry.set('som.sparseBudget', 4); // 内核键点亮（生产由 src/index.ts 铸入 config.somSparseBudget）
  try {
    const els = await src.ground(FULL, '打开设置');
    assert.equal(els.length, 1, 'grounding 照常产出（叠加不改变元素面）');
    assert.equal(fake.calls.length, 1, '恰好一次主定位');
    assert.equal(supplyCalls, 1, '预算>0 ⇒ 供给口真被调用（D-B3 通电证据）');

    // 事件记账：种子 → 叠加 → 编码全链生效
    const ev = src.somEventLog()[0]!;
    assert.equal(ev.applied, true, '叠加成功');
    assert.equal(ev.budget, 4, '内核键预算生效');
    assert.equal(ev.elementsIn, 2, '两粒种子参与分派');
    assert.deepEqual(ev.selected, [1, 2], '预算 ≥ 种子数 ⇒ 全选');

    // 像素级证据：VLM 收到的图里，marker1 描边（bbox x=10 左缘）不再是背景灰
    const { data, info } = await decodeReceived(fake.calls[0]);
    assert.equal(info.width, 200, '叠加同尺寸（宽）—— 坐标闭环前提');
    assert.equal(info.height, 150, '叠加同尺寸（高）');
    const stroke = px(data, info, 11, 30); // marker1 左缘描边带（x0=10, strokeWidth=3）
    const far = px(data, info, 195, 145); // 远离任何标记的背景锚点
    const drift = (p: { r: number; g: number; b: number }) =>
      Math.max(Math.abs(p.r - 128), Math.abs(p.g - 128), Math.abs(p.b - 128));
    assert.ok(drift(stroke) > 30, `描边像素应显著偏离背景灰（实得 rgb(${stroke.r},${stroke.g},${stroke.b})）`);
    assert.ok(drift(far) <= 6, `背景应保持原灰（实得 rgb(${far.r},${far.g},${far.b})）`);
  } finally {
    kernelRegistry.set('som.sparseBudget', 0);
  }
});

test('W8-B3⑤: 【回归锁】预算 0（缺省）⇒ 供给口零调用、收到的图与「无 SoM 接线」逐字节一致', async () => {
  const png = await solidPng(200, 150);
  const els = vlmEls({ label: '设置', bbox: [20, 20, 90, 80] });
  setAccessibilityProvider(async () => fakeA11yTree());
  let supplyCalls = 0;

  // 对照组：完全无 SoM 接线（现状路径）
  const control = fakeVlm(els);
  await createSemanticFromVlm({
    capture: async () => png, screenSize: async () => ({ width: 200, height: 150 }),
    client: control.client,
  }).ground(FULL, '打开设置');
  const b64Control = control.calls[0].images[0].base64 as string;

  // 实验组：端口投喂在场，但预算 = 内核键缺省 0
  assert.equal(kernelRegistry.getOrDefault('som.sparseBudget', 0), 0, '内核键缺省读数 0（现状锚）');
  const fake = fakeVlm(els);
  const src = createSemanticFromVlm({
    capture: async () => png, screenSize: async () => ({ width: 200, height: 150 }),
    client: fake.client,
    somMarkers: async () => {
      supplyCalls += 1;
      return [] as SomMarkerSeedInput[];
    },
  });
  await src.ground(FULL, '打开设置');
  assert.equal(supplyCalls, 0, '预算 0 ⇒ 供给口根本不被调用（预算闸先行）');
  assert.equal(fake.calls[0].images[0].base64, b64Control, '收到的图与无 SoM 接线逐字节一致');
  const ev = src.somEventLog()[0]!;
  assert.equal(ev.applied, false, '直通');
  assert.equal(ev.reason, 'budget-off', '缺省归因：预算关（D-B1 缺省决策保持）');
});

// ═══ D-B4：梦 failures 源投喂（dreamFeed 供源工装 → SleepDeps.dream → 梦回放） ═══

/** 失败记录速记（FailureRecord 的结构子集 —— dreamTrajectories 的净化原料） */
function failureRecord(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, query: '导出报表', approach: 'scroll 后误点折叠区', symptom: '无进展',
    sceneHash: 'scenehash00000000ff', at: 1_700_000_000_000, ...over,
  };
}

test('W8-B4①: createDreamDeps —— dump 双方言提取 / 垃圾 ⇒ 空集 / 故障上抛（故障 ≠ 空集）', () => {
  // {records} 形状（failureMemory.dump 的方言）⇒ 取 records
  const d1 = createDreamDeps({ dumpFailures: () => ({ records: [failureRecord(7)], nextId: 8 }) });
  const out1 = d1.failures() as unknown[];
  assert.equal(out1.length, 1);
  assert.equal((out1[0] as { id: number }).id, 7);
  // 裸数组（测试直投 FailureRecord[]/DreamFailureTrajectory[]）⇒ 原样直通
  const d2 = createDreamDeps({ dumpFailures: () => [failureRecord(1), failureRecord(2)] });
  assert.equal((d2.failures() as unknown[]).length, 2);
  // 垃圾 dump（非数组非 {records}）⇒ 空失败集（净化归梦管线 —— 数据垃圾不是故障）
  for (const garbage of [null, 42, 'x', {}, { records: 'nope' }] as Array<unknown>) {
    const d = createDreamDeps({ dumpFailures: () => garbage });
    assert.deepEqual(d.failures(), [], `垃圾 dump ⇒ []：${JSON.stringify(garbage)}`);
  }
  // dumpFailures 自身抛错 ⇒ 原样上抛 —— dreamSidecar 的『失败轨迹源故障（旁路
  // 吸收）』注记臂是梦管线为供给口故障预留的执法面，供源不得吞真故障谎报空集
  const d3 = createDreamDeps({ dumpFailures: () => { throw new Error('memory corrupted'); } });
  assert.throws(() => d3.failures(), /memory corrupted/);
  // evolution / spectrum / budget 可选透传（缺席 ⇒ 键缺席 —— 生产面不可及时诚实缺席）
  assert.ok(!('evolution' in d1) && !('spectrum' in d1) && !('budget' in d1), '未投面 ⇒ 键缺席');
  const d4 = createDreamDeps({
    dumpFailures: () => [],
    spectrum: { form: 3.5 },
    budget: { maxDreams: 1 },
  });
  assert.deepEqual(d4.spectrum, { form: 3.5 });
  assert.deepEqual(d4.budget, { maxDreams: 1 });
});

test('W8-B4②: 【生效臂】梦 deps 投喂 ⇒ 失败轨迹真到达梦回放消费面（entry id = 失败记录 id）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'w8dream-on-'));
  try {
    resetSleepCycle();
    let n = 0;
    const journal = {
      list: () => [{ ts: ++n, tool: 'click', args: {}, status: 'SUCCESS', hash: `h${n}` }],
      verify: () => ({ ok: true, length: n, brokenAt: null }),
      currentTask: () => '导出报表',
    };
    const deps: SleepDeps = {
      journal,
      // D-B4 的本线：真实失败源（failureMemory.dump 面的形状）经 createDreamDeps 适配
      dream: createDreamDeps({
        dumpFailures: () => ({ records: [failureRecord(7, { symptom: '折叠区无响应' })], nextId: 8 }),
        budget: { maxDreams: 1 }, // 只回放这一条 —— 测试预算礼让
      }),
    };
    const report = await runSleepCycle(deps, {
      sleepTracePath: join(dir, 'trace.jsonl'),
      now: () => 1_800_000_000_000,
    });
    assert.ok(report.dream, '梦摘要在场（dep 投喂 ⇒ 梦激活）');
    assert.equal(report.dream!.attempted, 1, '一条失败轨迹参与梦回放');
    assert.equal(report.dream!.entries.length, 1);
    assert.equal(report.dream!.entries[0]!.id, '7', 'entry id = 失败记录 id（失败源→消费面的身份闭环）');
    assert.ok(report.dream!.watermark.startsWith('dream-'), '梦独立水位线在场');
    const replayAct = report.acts.find(a => a.name === 'replay')!;
    assert.equal(replayAct.counts.dreamAttempted, 1, '复合幕 counts 合并（第①幕消费了梦面）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetSleepCycle();
  }
});

test('W8-B4③: 【回归锁】dream dep 缺席 ⇒ report.dream 缺席（六幕零漂移）；空失败集 ⇒ 诚实跳过注记', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'w8dream-off-'));
  try {
    resetSleepCycle();
    let n = 0;
    const journal = {
      list: () => [{ ts: ++n, tool: 'click', args: {}, status: 'SUCCESS', hash: `h${n}` }],
      verify: () => ({ ok: true, length: n, brokenAt: null }),
    };
    // ① dep 缺席（接线前的现状）：零漂移
    const r1 = await runSleepCycle({ journal }, { sleepTracePath: join(dir, 't1.jsonl'), now: () => 1 });
    assert.equal(r1.dream, undefined, 'dep 缺席 ⇒ 梦摘要缺席（现状路径零漂移）');
    assert.ok(!('dreams' in (r1.acts.find(a => a.name === 'replay')!.counts)), '梦 counts 键缺席');
    // ② dep 在场但失败记忆为空：诚实跳过（不伪造梦）
    resetSleepCycle();
    n = 0;
    const r2 = await runSleepCycle({
      journal,
      dream: createDreamDeps({ dumpFailures: () => ({ records: [], nextId: 1 }) }),
    }, { sleepTracePath: join(dir, 't2.jsonl'), now: () => 1 });
    assert.ok(r2.dream, '梦摘要在场（dep 在场 ⇒ 面激活）');
    assert.equal(r2.dream!.attempted, 0);
    assert.ok(r2.dream!.note!.includes('无失败轨迹'), '空失败集 ⇒ 诚实跳过注记');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetSleepCycle();
  }
});

// ═══ 源级取证：src/index.ts 组合根字面接线（w3wire/w7wire 同法） ═══

test('W8-源级①: src/index.ts 铸 som.sparseBudget 内核键 —— config.somSparseBudget 铸入、缺省 0 不变律', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const i = src.indexOf("key: 'som.sparseBudget'");
  assert.ok(i > 0, 'som.sparseBudget 入册行在场（D-B3 生产接线）');
  const line = src.slice(i, src.indexOf('\n', i));
  assert.ok(line.includes('defaultValue: config.somSparseBudget'), 'config.somSparseBudget 铸入（配置通道）');
  assert.ok(line.includes("organ: 'perception'"), '器官归属 perception');
  // 缺省不变：config.somSparseBudget 缺省 0（config.ts:551 default(0)）⇒ 入册值 0
  // = 未入册时 getOrDefault 的回声 0 —— 两条路径读数逐字节一致（D-B1 保持）。
  const cfg = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
  const ci = cfg.indexOf('somSparseBudget: Schema.number()');
  assert.ok(ci > 0 && cfg.slice(ci, cfg.indexOf('\n', ci)).includes('.default(0)'), 'config 缺省 0 在场（缺省不变的前提证据）');
});

test('W8-源级②: src/index.ts 投 dream 失败源 —— 字面接线在场且位于 enableSleepCycle 开关块内（缺省关 ⇒ 现状保持）', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const literal = 'dream: createDreamDeps({ dumpFailures: () => failureMemory.dump() })';
  const iDream = src.indexOf(literal);
  assert.ok(iDream > 0, 'dream 投喂字面在场（D-B4 生产接线）');
  const iSwitch = src.indexOf('if (config.enableSleepCycle)');
  assert.ok(iSwitch > 0 && iSwitch < iDream, '投喂位于 enableSleepCycle 块内（缺省 false ⇒ 投喂永不发生）');
  assert.ok(src.includes('runSleepCycle, createDreamDeps'), '桶导入面携带 createDreamDeps');
  // enableSleepCycle 缺省 false（缺省关的证据）
  const cfg = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
  const ci = cfg.indexOf('enableSleepCycle: Schema.boolean()');
  assert.ok(ci > 0 && cfg.slice(ci, cfg.indexOf('\n', ci)).includes('.default(false)'), 'enableSleepCycle 缺省 false 在场');
});

// ═══ W8-B2：组合根 somMarkers 接线源级取证（orchestration/index.ts 字面接线） ═══

test('W8-B2源级: orchestration/index.ts 铸 L3 源处接 somMarkers 供源口（D-B3 通电的组合根证据）', () => {
  const src = readFileSync(new URL('../src/orchestration/index.ts', import.meta.url), 'utf8');
  const i = src.indexOf('somMarkers: createSomMarkerSeedSupply(');
  assert.ok(i > 0, 'somMarkers 供源接线字面在场（W8-A3 报告的推荐形态）');
  // 供源物料与 L3 适配器同源（capture/screenSize 同一 system 面 —— 坐标系闭环）
  const wiring = src.slice(i, src.indexOf('});', i));
  assert.ok(wiring.includes('screenSize:'), '供源携带 screenSize（OCR 词框归一化换算源）');
  assert.ok(wiring.includes('capture:'), '供源携带 capture（OCR 通道原料）');
  // 预算缺省零行为：接入点在 som.sparseBudget 缺省 0 的预算闸之后才可能生效
  //（applySparseSom budget-off 先行 —— W8-B3⑤ 已行为锁定，此处锁组合根不缺席）
  assert.ok(src.includes("await import('../vlm/som')"), 'som 供源工装经动态引入（D-6 模块图零污染）');
});
