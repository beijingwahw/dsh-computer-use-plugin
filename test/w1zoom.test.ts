// test/w1zoom.test.ts
// W1-8（P3 置信度门控级联注视 · 选择性 Zoom 复核）：grounding 出口 verifyGate
// 复核闸的执法册。铁律：**零联网** —— 主定位与复核端口全程假 client 注入；
// 图像走 sharp 生成的真 PNG 过 codec 真实管线（不 mock 几何上游）。
// 覆盖：三触发条件各自触发/不触发、复核改值（adopted）、两轮一致（agree）、
// 文字冲突保守路径（conflict）、预算封顶（调用级 + 任务级模块计数 + reset）、
// 复核端口缺席/未配置/OCR 失败/裁剪不可用的降级放行、闸门显式关闭、
// 无匹配（no-match）、label 无文字身份（text-unverifiable）与递归卫兵。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { GlmClient, GlmVisionRequest } from '../src/vlm/glmClient.ts';

const {
  groundElements,
  resetVerifyGateBudget,
  _overrideZoomSharpResolver_forTest,
} = await import('../src/vlm/grounding.ts');
const { default: sharp } = await import('sharp');

// ─── 假件工坊（零网络） ───

/** chatJson 桩回复形态 */
interface StubReply { ok: boolean; value?: unknown; error?: string; raw: string }

/** 主定位假 client：记录请求，回放预设结果 */
function fakeClient(
  reply: () => StubReply,
  configured = true,
): { client: GlmClient; requests: GlmVisionRequest[] } {
  const requests: GlmVisionRequest[] = [];
  const client = {
    configured,
    chatJson: async (req: GlmVisionRequest) => {
      requests.push(req);
      return reply();
    },
  } as unknown as GlmClient;
  return { client, requests };
}

/**
 * W1-8 复核端口假 client：grounding（jsonMode:true）与 OCR（无 jsonMode ——
 * vlmOcr 只发 images+prompt）按请求形态分派回放，并记录全部请求。
 */
function fakeVerifyPort(
  groundingReply: () => StubReply,
  ocrReply: () => StubReply,
  configured = true,
): { client: GlmClient; calls: GlmVisionRequest[] } {
  const calls: GlmVisionRequest[] = [];
  const client = {
    configured,
    chatJson: async (req: GlmVisionRequest) => {
      calls.push(req);
      return req.jsonMode === true ? groundingReply() : ocrReply();
    },
  } as unknown as GlmClient;
  return { client, calls };
}

/** sharp 现场生成纯色 PNG（真图 Buffer —— codec 真实编码管线门票） */
async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 96, g: 96, b: 96 } },
  }).png().toBuffer();
}

/** 主定位元素方言工厂 */
function el(label: string, bbox: [number, number, number, number], confidence: number) {
  return { id: 'x', label, role: 'button', bbox, confidence };
}

/** OCR 成功回复（words JSON） */
const ocrWords = (texts: string[]): StubReply => ({
  ok: true, raw: '',
  value: { words: texts.map((t, i) => ({ text: t, confidence: 0.9, bbox: [i * 30, 0, i * 30 + 28, 20] })) },
});

// 200x150 as-is 小图：提示词系 = 编码系 = buffer 系 = 输出系（无缩放干扰）
const SCREEN_W = 200;
const SCREEN_H = 150;

// ─── W1-8a 三触发条件：各自触发（无复核端口 ⇒ port-absent 放行原值） ───

test('W1-8a: 三触发条件各自在场 —— confidence<0.6 / 短边<24px / 邻域候选>5；无端口放行原值', async () => {
  resetVerifyGateBudget();
  const buf = await makePng(SCREEN_W, SCREEN_H);
  // e1 低置信（其余不触发）；e2 小目标；e3 拥挤邻域（+6 个被 NMS 吸收的重复检出）
  // e4 双条件并存（confidence + short-edge）
  const main = fakeClient(() => ({
    ok: true, raw: '',
    value: {
      elements: [
        el('低置信按钮', [10, 10, 60, 60], 0.5),          // e1: conf 0.5, 短边 50, 密度 1
        el('小按钮', [90, 10, 130, 29], 0.9),             // e2: 短边 19
        el('密集区', [10, 80, 90, 150], 0.95),            // e3: 邻域密度 7（自身+6 重复）
        el('双触发', [150, 100, 170, 115], 0.4),          // e4: conf 0.4 + 短边 20/15
        // e5..e10: 密集区的 6 个重复检出（IoU≥0.6 全被 NMS 吸收，但计入 pre-NMS 密度）
        el('密集区', [13, 83, 93, 153], 0.9),
        el('密集区', [16, 86, 96, 150], 0.9),
        el('密集区', [19, 89, 99, 150], 0.9),
        el('密集区', [13, 86, 93, 150], 0.9),
        el('密集区', [16, 83, 96, 150], 0.9),
        el('密集区', [12, 88, 92, 150], 0.9),
      ],
    },
  }));
  const r = await groundElements(buf, { client: main.client });
  assert.equal(r.ok, true);
  assert.equal(r.elements.length, 4, '6 个重复检出被 NMS 吸收，4 元素幸存');
  assert.ok(r.verifyGate, '闸门开启 ⇒ 报告在场');
  assert.equal(r.verifyGate!.events.length, 4, '四个元素全部触发');
  const byId = new Map(r.verifyGate!.events.map(e => [e.id, e]));
  assert.deepEqual([...byId.get('e1')!.reasons], ['confidence']);
  assert.deepEqual([...byId.get('e2')!.reasons], ['short-edge']);
  assert.deepEqual([...byId.get('e3')!.reasons], ['density']);
  assert.deepEqual([...byId.get('e4')!.reasons], ['confidence', 'short-edge'], '多条件并存全记');
  for (const ev of r.verifyGate!.events) {
    assert.equal(ev.outcome, 'port-absent', '无复核端口 ⇒ 放行原值');
  }
  // 放行原值：元素零改动 + 零预算消耗 + 零额外网络
  const e1 = r.elements.find(e => e.id === 'e1')!;
  assert.deepEqual(e1.bbox, { x0: 10, y0: 10, x1: 60, y1: 60 });
  assert.equal(e1.confidence, 0.5);
  assert.equal(r.verifyGate!.budgetUsed, 0, '端口缺席不耗预算');
  assert.equal(main.requests.length, 1, '复核流量绝不流向主 client');
});

// ─── W1-8b 不触发 ───

test('W1-8b: 高置信 + 大目标 + 稀疏邻域 ⇒ 零触发、复核端口零调用', async () => {
  resetVerifyGateBudget();
  const buf = await makePng(SCREEN_W, SCREEN_H);
  const main = fakeClient(() => ({
    ok: true, raw: '',
    value: { elements: [el('健康元素', [20, 20, 80, 70], 0.92)] }, // conf≥0.6、短边 50、密度 1
  }));
  const port = fakeVerifyPort(
    () => ({ ok: true, raw: '', value: { elements: [] } }),
    () => ocrWords(['健康元素']),
  );
  const r = await groundElements(buf, { client: main.client, verifyClient: port.client });
  assert.equal(r.ok, true);
  assert.ok(r.verifyGate);
  assert.deepEqual(r.verifyGate!.events, [], '无人触发');
  assert.equal(port.calls.length, 0, '复核端口零调用');
  assert.equal(r.verifyGate!.budgetUsed, 0);
  assert.equal(main.requests.length, 1);
});

// ─── W1-8c 复核改值（adopted）：偏差>8px 且 OCR 文字一致 ───

test('W1-8c: 复核改值 —— ROI 外扩 50% + 2x 上采样重定位，偏差>8px 且文字一致 ⇒ 取复核值', async () => {
  resetVerifyGateBudget();
  const buf = await makePng(SCREEN_W, SCREEN_H);
  // 主定位：conf 0.5（触发）、bbox [80,60,120,90]（短边 30 不触发）、密度 1
  const main = fakeClient(() => ({
    ok: true, raw: '', value: { elements: [el('确定', [80, 60, 120, 90], 0.5)] },
  }));
  // ROI = bbox 外扩 50% ⇒ [70,52,130,98]（60x46）⇒ 2x ⇒ 120x92 复核画布。
  // 复核定位（ROI 系）[70,36,110,76] ⇒ buffer 系 [105,70,125,90]，中心 (115,80)
  // 与原中心 (100,75) 偏差 √(15²+5²)≈15.81px > 8px；OCR 读出「确定」一致 ⇒ 采信。
  const port = fakeVerifyPort(
    () => ({ ok: true, raw: '', value: { elements: [el('确定', [70, 36, 110, 76], 0.92)] } }),
    () => ocrWords(['确定']),
  );
  const r = await groundElements(buf, { client: main.client, verifyClient: port.client });
  assert.equal(r.ok, true);
  const e = r.elements[0]!;
  assert.deepEqual(e.bbox, { x0: 105, y0: 70, x1: 125, y1: 90 }, '几何取复核值');
  assert.deepEqual(e.center, { x: 115, y: 80 });
  assert.equal(e.confidence, 0.92, '置信取两轮最大');
  assert.equal(e.id, 'e1', 'id 恒不改（下游引用锚点稳定）');
  assert.equal(e.label, '确定', 'label 恒不改');
  const ev = r.verifyGate!.events[0]!;
  assert.deepEqual([...ev.reasons], ['confidence']);
  assert.equal(ev.outcome, 'adopted');
  assert.ok(Math.abs((ev.deviationPx ?? 0) - 15.81) < 0.02, `偏差≈15.81（实得 ${ev.deviationPx}）`);
  // 复核端口的 grounding 请求收到 120x92 的 2x ROI 图（裁剪+上采样几何实证）
  assert.equal(port.calls.length, 2, '一次复核 grounding + 一次 OCR');
  const gCall = port.calls.find(c => c.jsonMode === true)!;
  const meta = await sharp(Buffer.from(gCall.images[0]!.base64, 'base64')).metadata();
  assert.equal(meta.width, 120);
  assert.equal(meta.height, 92);
  assert.equal(r.verifyGate!.budgetUsed, 1);
  assert.equal(main.requests.length, 1);
});

// ─── W1-8d 两轮一致（agree）：偏差≤8px 且文字一致 ⇒ 保留原值 ───

test('W1-8d: 两轮定位一致（偏差≤8px）且文字一致 ⇒ 保留原值（agree）', async () => {
  resetVerifyGateBudget();
  const buf = await makePng(SCREEN_W, SCREEN_H);
  const main = fakeClient(() => ({
    ok: true, raw: '', value: { elements: [el('确定', [80, 60, 120, 90], 0.5)] },
  }));
  // 复核定位（ROI 系）[40,26,80,66] ⇒ buffer 中心恰回 (100,75) ⇒ 偏差 0。
  // 复核元素 conf 0.4 自身也会触发闸门 —— 若递归卫兵失效将雪崩调用/超时。
  const port = fakeVerifyPort(
    () => ({ ok: true, raw: '', value: { elements: [el('确定', [40, 26, 80, 66], 0.4)] } }),
    () => ocrWords(['确定']),
  );
  const r = await groundElements(buf, { client: main.client, verifyClient: port.client });
  const e = r.elements[0]!;
  assert.deepEqual(e.bbox, { x0: 80, y0: 60, x1: 120, y1: 90 }, '两轮一致 ⇒ 原值保留');
  assert.equal(e.confidence, 0.5, '置信不改动');
  const ev = r.verifyGate!.events[0]!;
  assert.equal(ev.outcome, 'agree');
  assert.ok((ev.deviationPx ?? 99) <= 8);
  assert.equal(port.calls.length, 2, '递归卫兵：复核层不再触发复核（恰好 2 次端口调用）');
});

// ─── W1-8e 文字冲突保守路径（conflict） ───

test('W1-8e: OCR 文字不一致 ⇒ 保守取原值 + 置信减半 + 冲突证据', async () => {
  resetVerifyGateBudget();
  const buf = await makePng(SCREEN_W, SCREEN_H);
  const main = fakeClient(() => ({
    ok: true, raw: '', value: { elements: [el('确定', [80, 60, 120, 90], 0.5)] },
  }));
  const port = fakeVerifyPort(
    () => ({ ok: true, raw: '', value: { elements: [el('确定', [70, 36, 110, 76], 0.92)] } }), // 偏差≈15.81px
    () => ocrWords(['取消', '返回']), // ROI 里读不出「确定」⇒ 文字冲突
  );
  const r = await groundElements(buf, { client: main.client, verifyClient: port.client });
  const e = r.elements[0]!;
  assert.deepEqual(e.bbox, { x0: 80, y0: 60, x1: 120, y1: 90 }, '冲突 ⇒ 保守取原值');
  assert.equal(e.confidence, 0.25, '置信 0.5×0.5 减半');
  const ev = r.verifyGate!.events[0]!;
  assert.equal(ev.outcome, 'conflict');
  assert.ok(Math.abs((ev.deviationPx ?? 0) - 15.81) < 0.02, '偏差照记（证据保留）');
  assert.ok(ev.detail && ev.detail.includes('确定'), '冲突证据在场');
  assert.equal(r.verifyGate!.budgetUsed, 1);
});

// ─── W1-8f 预算封顶（调用级 verifyBudget） ───

test('W1-8f: 调用级预算封顶 —— verifyBudget:1 下第二触发元素直接放行并记 degraded', async () => {
  resetVerifyGateBudget();
  const buf = await makePng(SCREEN_W, SCREEN_H);
  const main = fakeClient(() => ({
    ok: true, raw: '',
    value: {
      elements: [
        el('甲', [10, 10, 60, 50], 0.4),    // e1 触发（confidence）
        el('乙', [100, 90, 160, 140], 0.4), // e2 触发（confidence；面积更大先出）
      ],
    },
  }));
  const port = fakeVerifyPort(
    () => ({ ok: false, error: 'verify grounding down', raw: '' }), // 复核失败 ⇒ 放行（仍耗预算）
    () => ocrWords(['甲']),
  );
  const r = await groundElements(buf, { client: main.client, verifyClient: port.client, verifyBudget: 1 });
  const byId = new Map(r.verifyGate!.events.map(e => [e.id, e]));
  assert.equal(byId.get('e2')!.outcome, 'reground-failed', '首个触发者（面积序在前）真实复核');
  assert.equal(byId.get('e1')!.outcome, 'budget-exhausted', '次者被调用级预算封顶');
  assert.equal(r.verifyGate!.budgetExhausted, true, 'degraded 记账');
  assert.equal(r.verifyGate!.budgetUsed, 1);
  assert.equal(port.calls.length, 1, '只真实下发了 1 次复核');
  // 两元素原值不动
  for (const e of r.elements) {
    assert.equal(e.confidence, 0.4);
  }
});

// ─── W1-8g 预算封顶（任务级模块计数 + resetVerifyGateBudget） ───

test('W1-8g: 任务级预算 8 次跨调用累计 —— 第 9 次放行，reset 后恢复', async () => {
  resetVerifyGateBudget();
  const buf = await makePng(SCREEN_W, SCREEN_H);
  const main = fakeClient(() => ({
    ok: true, raw: '', value: { elements: [el('甲', [20, 20, 80, 70], 0.4)] },
  }));
  const port = fakeVerifyPort(
    () => ({ ok: false, error: 'down', raw: '' }),
    () => ocrWords([]),
  );
  const run = () => groundElements(buf, { client: main.client, verifyClient: port.client });
  // 8 次任务预算耗尽（每次 1 个触发元素，复核失败仍记账）
  let last = await run();
  for (let i = 1; i < 8; i++) last = await run();
  assert.equal(last.verifyGate!.budgetUsed, 8, '模块级计数跨调用累计到上限');
  assert.equal(last.verifyGate!.budgetMax, 8);
  const callsAfter8 = port.calls.length;
  // 第 9 次：超限 ⇒ 放行原值 + degraded 记账，端口零调用（防雪崩）
  const ninth = await run();
  assert.equal(ninth.verifyGate!.events[0]!.outcome, 'budget-exhausted');
  assert.equal(ninth.verifyGate!.budgetExhausted, true);
  assert.equal(ninth.verifyGate!.budgetUsed, 8, '超限后不再消耗');
  assert.equal(ninth.elements[0]!.confidence, 0.4, '原值放行');
  assert.equal(port.calls.length, callsAfter8, '超限后复核端口零调用');
  // 新任务 reset ⇒ 预算恢复
  resetVerifyGateBudget();
  const fresh = await run();
  assert.equal(fresh.verifyGate!.budgetUsed, 1);
  assert.equal(fresh.verifyGate!.events[0]!.outcome, 'reground-failed');
});

// ─── W1-8h VLM 缺席/失败降级（绝不抛、绝不阻塞） ───

test('W1-8h: 复核端口未接线 / 未配置 / OCR 失败 ⇒ 一律放行原值', async () => {
  const buf = await makePng(SCREEN_W, SCREEN_H);
  const trigReply = () => ({
    ok: true, raw: '', value: { elements: [el('目标', [80, 60, 120, 90], 0.5)] },
  });

  // 1) 端口未接线（生产默认形态）：触发 ⇒ port-absent，零额外网络
  resetVerifyGateBudget();
  const main1 = fakeClient(trigReply);
  const r1 = await groundElements(buf, { client: main1.client });
  assert.equal(r1.verifyGate!.events[0]!.outcome, 'port-absent');
  assert.deepEqual(r1.elements[0]!.bbox, { x0: 80, y0: 60, x1: 120, y1: 90 });
  assert.equal(r1.verifyGate!.budgetUsed, 0);
  assert.equal(main1.requests.length, 1);

  // 2) 端口未配置（configured:false）：等同缺席
  const main2 = fakeClient(trigReply);
  const port2 = fakeVerifyPort(
    () => ({ ok: true, raw: '', value: { elements: [] } }),
    () => ocrWords([]),
    false,
  );
  const r2 = await groundElements(buf, { client: main2.client, verifyClient: port2.client });
  assert.equal(r2.verifyGate!.events[0]!.outcome, 'port-absent');
  assert.equal(port2.calls.length, 0);

  // 3) 复核 grounding 失败 ⇒ 放行原值（预算已耗 —— 真实下发过）
  resetVerifyGateBudget();
  const main3 = fakeClient(trigReply);
  const port3 = fakeVerifyPort(
    () => ({ ok: false, error: 'verify port down', raw: '' }),
    () => ocrWords(['目标']),
  );
  const r3 = await groundElements(buf, { client: main3.client, verifyClient: port3.client });
  assert.equal(r3.verifyGate!.events[0]!.outcome, 'reground-failed');
  assert.ok(r3.verifyGate!.events[0]!.detail?.includes('verify port down'), '失败原因透传');
  assert.deepEqual(r3.elements[0]!.bbox, { x0: 80, y0: 60, x1: 120, y1: 90 }, '原值放行');
  assert.equal(r3.elements[0]!.confidence, 0.5);

  // 4) 复核 OCR 失败（VLM 半瘫）⇒ 放行原值，绝不抛
  resetVerifyGateBudget();
  const main4 = fakeClient(trigReply);
  const port4 = fakeVerifyPort(
    () => ({ ok: true, raw: '', value: { elements: [el('目标', [70, 36, 110, 76], 0.9)] } }),
    () => ({ ok: false, error: 'ocr backend down', raw: '' }),
  );
  const r4 = await groundElements(buf, { client: main4.client, verifyClient: port4.client });
  assert.equal(r4.verifyGate!.events[0]!.outcome, 'ocr-unavailable');
  assert.deepEqual(r4.elements[0]!.bbox, { x0: 80, y0: 60, x1: 120, y1: 90 }, '原值放行');
  assert.equal(r4.elements[0]!.confidence, 0.5);
});

// ─── W1-8i ROI 裁剪不可用（sharp 缺席）⇒ 放行且零预算消耗 ───

test('W1-8i: sharp 裁剪不可用 ⇒ crop-unavailable 放行，复核端口零调用、零预算', async () => {
  resetVerifyGateBudget();
  const buf = await makePng(SCREEN_W, SCREEN_H);
  const main = fakeClient(() => ({
    ok: true, raw: '', value: { elements: [el('目标', [80, 60, 120, 90], 0.5)] },
  }));
  const port = fakeVerifyPort(
    () => ({ ok: true, raw: '', value: { elements: [] } }),
    () => ocrWords([]),
  );
  try {
    _overrideZoomSharpResolver_forTest(async () => {
      throw new Error('sharp unavailable (simulated)');
    });
    const r = await groundElements(buf, { client: main.client, verifyClient: port.client });
    assert.equal(r.ok, true, '裁剪失败不毒化主结果');
    assert.equal(r.verifyGate!.events[0]!.outcome, 'crop-unavailable');
    assert.deepEqual(r.elements[0]!.bbox, { x0: 80, y0: 60, x1: 120, y1: 90 });
    assert.equal(port.calls.length, 0, '未下发任何复核请求');
    assert.equal(r.verifyGate!.budgetUsed, 0, '未耗云脑 ⇒ 不记账');
  } finally {
    _overrideZoomSharpResolver_forTest(null); // 复位生产解析器
  }
});

// ─── W1-8j 闸门显式关闭 ───

test('W1-8j: verifyGate:false ⇒ 报告缺席、端口零调用、触发形态元素原样直通', async () => {
  resetVerifyGateBudget();
  const buf = await makePng(SCREEN_W, SCREEN_H);
  const main = fakeClient(() => ({
    ok: true, raw: '', value: { elements: [el('目标', [80, 60, 120, 90], 0.5)] },
  }));
  const port = fakeVerifyPort(
    () => ({ ok: true, raw: '', value: { elements: [el('劫持', [0, 0, 10, 10], 0.99)] } }),
    () => ocrWords(['劫持']),
  );
  const r = await groundElements(buf, { client: main.client, verifyClient: port.client, verifyGate: false });
  assert.equal(r.ok, true);
  assert.equal(r.verifyGate, undefined, '闸关 ⇒ 报告缺席');
  assert.deepEqual(r.elements[0]!.bbox, { x0: 80, y0: 60, x1: 120, y1: 90 });
  assert.equal(r.elements[0]!.confidence, 0.5);
  assert.equal(port.calls.length, 0);
});

// ─── W1-8k 复核层无匹配 / label 无文字身份 ───

test('W1-8k: 复核层无同名无重叠候选 ⇒ no-match 放行；OCR 不再下发', async () => {
  resetVerifyGateBudget();
  const buf = await makePng(SCREEN_W, SCREEN_H);
  const main = fakeClient(() => ({
    ok: true, raw: '', value: { elements: [el('目标', [80, 60, 120, 90], 0.5)] },
  }));
  // 复核元素落在 ROI 左上角（buffer 系 [70,53,78,66]，与原 bbox 无重叠）且异名
  const port = fakeVerifyPort(
    () => ({ ok: true, raw: '', value: { elements: [el('别的', [0, 2, 16, 28], 0.9)] } }),
    () => ocrWords(['别的']),
  );
  const r = await groundElements(buf, { client: main.client, verifyClient: port.client });
  assert.equal(r.verifyGate!.events[0]!.outcome, 'no-match');
  assert.deepEqual(r.elements[0]!.bbox, { x0: 80, y0: 60, x1: 120, y1: 90 }, '原值放行');
  assert.equal(port.calls.length, 1, '无匹配 ⇒ OCR 不下发（复核 grounding 1 次）');
  assert.equal(r.verifyGate!.budgetUsed, 1);
});

test('W1-8k2: label 为兜底串「未知元素」⇒ 无文字身份，诚实 text-unverifiable 放行', async () => {
  resetVerifyGateBudget();
  const buf = await makePng(SCREEN_W, SCREEN_H);
  const main = fakeClient(() => ({
    ok: true, raw: '', value: { elements: [el('', [80, 60, 120, 90], 0.5)] }, // 空 label ⇒ 兜底串
  }));
  const port = fakeVerifyPort(
    () => ({ ok: true, raw: '', value: { elements: [el('未知元素', [70, 36, 110, 76], 0.9)] } }),
    () => ocrWords(['随便什么字']),
  );
  const r = await groundElements(buf, { client: main.client, verifyClient: port.client });
  assert.equal(r.elements[0]!.label, '未知元素');
  assert.equal(r.verifyGate!.events[0]!.outcome, 'text-unverifiable');
  assert.equal(r.elements[0]!.confidence, 0.5, '不奖不惩');
  assert.deepEqual(r.elements[0]!.bbox, { x0: 80, y0: 60, x1: 120, y1: 90 });
  assert.equal(port.calls.length, 2, '复核 grounding + OCR 各一次（文字裁决需 OCR 在场）');
});
