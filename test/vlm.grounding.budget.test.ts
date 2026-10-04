// test/vlm.grounding.budget.test.ts
// W6R-A4（预算作用域化）：verifyGate 任务级复核预算的并发隔离执法册。
// 铁律：**零联网** —— 主定位与复核端口全程假 client 注入（照 w1zoom 工坊）；
// 图像走 sharp 生成的真 PNG 过 codec 真实管线（不 mock 几何上游）。
// 覆盖：两路并发预算互不侵占（串账缺陷的回归锁）、taskId 账本单任务 8 次
// 封顶、跨任务不串账、resetVerifyGateBudget 定点/全清语义、账本表 LRU
// 封顶逐出（防 Map 泄漏）、taskId 脏值回落缺省账本。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { GlmClient, GlmVisionRequest } from '../src/vlm/glmClient.ts';

const {
  groundElements,
  resetVerifyGateBudget,
} = await import('../src/vlm/grounding.ts');
const { default: sharp } = await import('sharp');

// ─── 假件工坊（与 w1zoom 同款，零网络） ───

interface StubReply { ok: boolean; value?: unknown; error?: string; raw: string }

/** 主定位假 client：记录请求，回放预设结果 */
function fakeClient(reply: () => StubReply): { client: GlmClient; requests: GlmVisionRequest[] } {
  const requests: GlmVisionRequest[] = [];
  const client = {
    configured: true,
    chatJson: async (req: GlmVisionRequest) => {
      requests.push(req);
      return reply();
    },
  } as unknown as GlmClient;
  return { client, requests };
}

/** 复核端口假 client：grounding（jsonMode）恒失败 ⇒ reground-failed 且耗预算 */
function failingVerifyPort(): { client: GlmClient; calls: GlmVisionRequest[] } {
  const calls: GlmVisionRequest[] = [];
  const client = {
    configured: true,
    chatJson: async (req: GlmVisionRequest) => {
      calls.push(req);
      return req.jsonMode === true
        ? { ok: false, error: 'verify port down', raw: '' }
        : { ok: false, error: 'ocr down', raw: '' };
    },
  } as unknown as GlmClient;
  return { client, calls };
}

/** sharp 现场生成纯色 PNG（真图 Buffer —— codec 真实编码管线门票） */
async function makePng(width = 200, height = 150): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 96, g: 96, b: 96 } },
  }).png().toBuffer();
}

/** 触发复核的主定位元素（confidence 0.4 < 0.6；bbox 短边 30 不另触发） */
const el = (label: string) => ({ id: 'x', label, role: 'button', bbox: [20, 20, 80, 70], confidence: 0.4 });

// ─── W6R-A4a 两路并发：预算互不侵占（串账缺陷回归锁） ───

test('W6R-A4a: 两路并发各自 taskId —— 各账各记，budgetUsed 各为 1（旧模块级计数必串账为 2）', async () => {
  resetVerifyGateBudget();
  const bufA = await makePng();
  const bufB = await makePng();
  const mainA = fakeClient(() => ({ ok: true, raw: '', value: { elements: [el('任务甲目标')] } }));
  const mainB = fakeClient(() => ({ ok: true, raw: '', value: { elements: [el('任务乙目标')] } }));
  const portA = failingVerifyPort();
  const portB = failingVerifyPort();

  // 真并发：两路 groundElements 在途重叠（同一事件轮内并发下发复核）
  const [ra, rb] = await Promise.all([
    groundElements(bufA, { client: mainA.client, verifyClient: portA.client, verifyTaskId: 'task-a' }),
    groundElements(bufB, { client: mainB.client, verifyClient: portB.client, verifyTaskId: 'task-b' }),
  ]);

  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
  assert.ok(ra.verifyGate && rb.verifyGate, '闸门开启 ⇒ 报告在场');
  // 核心：各任务的预算账本互不侵占 —— 旧模块级全局计数下两路合计 2，
  // 后完成的一路 budgetUsed 会是 2（吃掉另一路的消耗）；作用域化后各记 1。
  assert.equal(ra.verifyGate!.budgetUsed, 1, '任务甲只看到自己的 1 次消耗');
  assert.equal(rb.verifyGate!.budgetUsed, 1, '任务乙只看到自己的 1 次消耗');
  // 复核真实下发（非 budget-exhausted —— 若串账提前封顶会直接放行）
  assert.equal(ra.verifyGate!.events[0]!.outcome, 'reground-failed');
  assert.equal(rb.verifyGate!.events[0]!.outcome, 'reground-failed');
  assert.equal(portA.calls.length, 1, '甲的复核流量走甲的端口');
  assert.equal(portB.calls.length, 1, '乙的复核流量走乙的端口');
});

// ─── W6R-A4b 单任务 8 次封顶保持 + 跨任务不串账 ───

test('W6R-A4b: taskId 账本单任务 8 次跨调用累计封顶；他任务不受牵连', async () => {
  resetVerifyGateBudget();
  const buf = await makePng();
  const main = fakeClient(() => ({ ok: true, raw: '', value: { elements: [el('甲')] } }));
  const port = failingVerifyPort();
  const runA = () => groundElements(buf, { client: main.client, verifyClient: port.client, verifyTaskId: 'cap-a' });

  let last = await runA();
  for (let i = 1; i < 8; i++) last = await runA();
  assert.equal(last.verifyGate!.budgetUsed, 8, '单任务跨调用累计到上限');
  assert.equal(last.verifyGate!.budgetMax, 8);
  const callsAfter8 = port.calls.length;

  // 第 9 次：本任务超限 ⇒ 放行（防雪崩不变）
  const ninth = await runA();
  assert.equal(ninth.verifyGate!.events[0]!.outcome, 'budget-exhausted');
  assert.equal(ninth.verifyGate!.budgetExhausted, true);
  assert.equal(ninth.verifyGate!.budgetUsed, 8, '超限后不再消耗');
  assert.equal(port.calls.length, callsAfter8, '超限后复核端口零调用');

  // 并发任务 B：A 耗满不影响 B 从 0 起账（旧全局计数下 B 直接 budget-exhausted）
  const mainB = fakeClient(() => ({ ok: true, raw: '', value: { elements: [el('乙')] } }));
  const portB = failingVerifyPort();
  const rb = await groundElements(buf, { client: mainB.client, verifyClient: portB.client, verifyTaskId: 'cap-b' });
  assert.equal(rb.verifyGate!.budgetUsed, 1, 'B 自起账 —— 不吃 A 的历史消耗');
  assert.equal(rb.verifyGate!.events[0]!.outcome, 'reground-failed', 'B 正常复核（未被 A 的封顶牵连）');

  // 缺省账本（不传 taskId）同样不被 A 污染 —— 既有调用方语义同步修复
  const mainD = fakeClient(() => ({ ok: true, raw: '', value: { elements: [el('默认')] } }));
  const portD = failingVerifyPort();
  const rd = await groundElements(buf, { client: mainD.client, verifyClient: portD.client });
  assert.equal(rd.verifyGate!.budgetUsed, 1, '缺省账本与 taskId 账本互不相通');
});

// ─── W6R-A4c resetVerifyGateBudget 作用域化重置语义 ───

test('W6R-A4c: resetVerifyGateBudget(taskId) 定点清零 —— 只清该任务，他任务与缺省账不动', async () => {
  resetVerifyGateBudget();
  const buf = await makePng();
  const mkRun = (taskId: string | undefined) => {
    const main = fakeClient(() => ({ ok: true, raw: '', value: { elements: [el('t')] } }));
    const port = failingVerifyPort();
    return () => groundElements(buf, { client: main.client, verifyClient: port.client, ...(taskId ? { verifyTaskId: taskId } : {}) });
  };
  const runA = mkRun('rs-a');
  const runB = mkRun('rs-b');
  const runDefault = mkRun(undefined);

  await runA();
  await runB();
  await runDefault();

  // 定点清 A：B 与缺省账本不动
  resetVerifyGateBudget('rs-a');
  const ra2 = await runA();
  const rb2 = await runB();
  const rd2 = await runDefault();
  assert.equal(ra2.verifyGate!.budgetUsed, 1, 'A 清零后从 1 重新起账');
  assert.equal(rb2.verifyGate!.budgetUsed, 2, 'B 不受 A 的重置影响');
  assert.equal(rd2.verifyGate!.budgetUsed, 2, '缺省账本不受定点重置影响');

  // 无参（历史签名）：全清 —— 既有调用方语义保持
  resetVerifyGateBudget();
  const ra3 = await runA();
  const rb3 = await runB();
  const rd3 = await runDefault();
  assert.equal(ra3.verifyGate!.budgetUsed, 1);
  assert.equal(rb3.verifyGate!.budgetUsed, 1);
  assert.equal(rd3.verifyGate!.budgetUsed, 1);
  resetVerifyGateBudget();
});

// ─── W6R-A4d 账本表 LRU 封顶逐出（防 Map 泄漏） ───

test('W6R-A4d: 账本表封顶 64 槽 LRU 逐出 —— 最久未用的任务账本被回收，复活从 0 起账', async () => {
  resetVerifyGateBudget();
  const buf = await makePng();
  // 健康元素（conf 0.95 / 大目标 / 稀疏）⇒ 不触发复核，仅触达账本（建/刷新槽位）
  const healthyMain = fakeClient(() => ({
    ok: true, raw: '', value: { elements: [{ id: 'x', label: '健康', role: 'button', bbox: [20, 20, 80, 70], confidence: 0.95 }] },
  }));
  const trigMain = fakeClient(() => ({ ok: true, raw: '', value: { elements: [el('老任务')] } }));
  const port = failingVerifyPort();

  // 老任务先耗 1 次预算（占据最早的 LRU 槽位）
  const r1 = await groundElements(buf, { client: trigMain.client, verifyClient: port.client, verifyTaskId: 'old' });
  assert.equal(r1.verifyGate!.budgetUsed, 1);

  // 64 个新任务触达账本表（容量 64 —— old 成为第 65 个键，最久未用被逐出）
  for (let i = 0; i < 64; i++) {
    const r = await groundElements(buf, { client: healthyMain.client, verifyTaskId: `churn-${i}` });
    assert.equal(r.ok, true);
  }

  // 老任务复活：账本已被 LRU 逐出 ⇒ 重建从 0 起账（宁可多给复核，不可漏账）
  const r2 = await groundElements(buf, { client: trigMain.client, verifyClient: port.client, verifyTaskId: 'old' });
  assert.equal(r2.verifyGate!.budgetUsed, 1, '被逐出后复活从 0 重新起账（若未逐出应为 2）');
  resetVerifyGateBudget();
});

// ─── W6R-A4e taskId 脏值防御：回落缺省账本 ───

test('W6R-A4e: verifyTaskId 脏值（空串/非字符串）安静回落缺省账本，绝不抛', async () => {
  resetVerifyGateBudget();
  const buf = await makePng();
  const main = fakeClient(() => ({ ok: true, raw: '', value: { elements: [el('甲')] } }));
  const port = failingVerifyPort();

  const r1 = await groundElements(buf, { client: main.client, verifyClient: port.client, verifyTaskId: '' });
  assert.equal(r1.ok, true, '空串 taskId 不炸管线');
  assert.equal(r1.verifyGate!.budgetUsed, 1, '空串 ⇒ 缺省账本记账');

  const r2 = await groundElements(buf, {
    client: main.client, verifyClient: port.client,
    verifyTaskId: 42 as unknown as string,
  });
  assert.equal(r2.ok, true, '非字符串 taskId 不炸管线');
  assert.equal(r2.verifyGate!.budgetUsed, 2, '脏值 ⇒ 同样落缺省账本（连续累计）');
  resetVerifyGateBudget();
});
