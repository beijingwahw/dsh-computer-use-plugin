// test/r54.vlmEconomy.test.ts
// R5-4 执法册（视觉外包经济面 —— 批1/批2 证据画像的降本三件）：
//   b · ask_screen 同屏同问语义回放（内核键 ask.semanticCache，缺省 0=关）：
//       证据：批1 hotkey s48/s58/s68 三问同一「末行内容」；批2 extras s158/s168
//       同屏连问 X 按钮坐标 —— 同指纹屏的重复 ask 是纯函数，可零拨号回放。
//   a · 视觉摘要缓存（askScreen 单槽 + take_screenshot 回执捎带）：
//       证据：R4-2 D4 —— 宿主纯文本，take_screenshot 图像本体不被消费（8 次
//       冗余双拍）；回执带「上次问答+指纹匹配」⇒ 纯文本宿主同屏不重问。
//   键册 · ask.semanticCache / grounding.semanticCache 入册（R3-3 GAP-1 同款
//       病灶收割：消费点在、键不入册 ⇒ set 静默拒收，宿主根本开不了）。
// 全离线确定性：注入假 client / 假 system（pan15-19 注入风格），零网络零真机。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { kernelRegistry } from '../src/kernel/registry.ts';
import { registerProductionKernels } from '../src/kernel/index.ts';
import { system } from '../src/system.ts';
import { journal } from '../src/journal.ts';
import { contextManager } from '../src/contextManager.ts';
import type { Config } from '../src/config.ts';
import {
  createAskScreenTool,
  peekAskSummary,
  _resetAskCache_forTest,
  _overrideAskClock_forTest,
} from '../src/tools/askScreen.ts';
import { createTakeScreenshotTool } from '../src/tools/takeScreenshot.ts';
import { dhash } from '../src/perceptualHash.ts';

type Executable = { execute: (a: unknown) => Promise<string> };
async function runJson(tool: unknown, args: unknown): Promise<any> {
  const out = await (tool as Executable).execute(args);
  return JSON.parse(out);
}

/** 假 VLM client：计数 + 回放预设答案（零网络） */
function countingClient(answer: string) {
  const calls: string[] = [];
  const client = {
    chat: async (req: { prompt?: string }) => {
      calls.push(req.prompt ?? '');
      return { ok: true as const, text: answer, model: 'fake-vlm', latencyMs: 7 };
    },
  };
  return { client, calls };
}

/** 素材工坊：条纹纹理帧（dhash 非全零 —— 均色图 dhash 恒 000…0，与 normalizeHash
 *  脏指纹全零哨兵不可区分，peekAskSummary 按零误报优先律拒收；故测试帧必须带纹理）。
 *  条纹周期调制频率 ⇒ 不同周期产出结构不同的 dhash（异屏 miss 的判据源；
 *  灰度调制不行 —— dhash 只比相对梯度，同频条纹同指纹（实测三 seed 同串）。 */
async function stripedPng(period: number): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  const rects: string[] = [];
  for (let x = 0, i = 0; x < 320; x += period, i++) {
    rects.push(`<rect x="${x}" y="${i % 2 ? 120 : 0}" width="${period}" height="120" ` +
      `fill="rgb(${i % 2 ? 230 : 20},${(60 + (i * 7) % 120)},${(255 - (i * 11) % 200)})"/>`);
  }
  return sharp(Buffer.from(`<svg width="320" height="240">${rects.join('')}</svg>`)).png().toBuffer();
}
async function solidPng(): Promise<Buffer> { return stripedPng(40); }
async function splitPng(): Promise<Buffer> { return stripedPng(80); }

function patchSystem(over: Record<string, unknown>): () => void {
  const saved: Record<string, unknown> = {};
  const host = system as unknown as Record<string, unknown>;
  for (const key of Object.keys(over)) {
    saved[key] = host[key];
    host[key] = over[key];
  }
  return () => {
    for (const key of Object.keys(over)) host[key] = saved[key];
  };
}

/** R5-4 测试注册：走生产册 + set 开关（同时执法「键已入册、set 不再被拒」） */
function enableAskCache(): void {
  registerProductionKernels();
  const r = kernelRegistry.set('ask.semanticCache', 1);
  assert.ok(r.ok, `ask.semanticCache set 必须被收（R3-3 GAP-1 同款病灶已收割）：${JSON.stringify(r)}`);
}

// ═══ b · 语义回放 ═══

test('R5-4 b0: 回放缺省关（键在册值 0）⇒ 同屏同问双调照常两次真实拨号（零回归锚点）', async () => {
  _resetAskCache_forTest();
  registerProductionKernels(); // 生产缺省：ask.semanticCache=0
  try {
    const buf = await solidPng();
    const { client, calls } = countingClient('末行是 HOTKEY-VERIFIED-OK');
    const tool = createAskScreenTool({} as Config, { capture: async () => buf, client: client as never });
    const r1 = await runJson(tool, { question: '最后一行是什么？' });
    const r2 = await runJson(tool, { question: '最后一行是什么？' });
    assert.equal(r1.status, 'SUCCESS');
    assert.equal(r2.status, 'SUCCESS');
    assert.equal(calls.length, 2, '缺省关 ⇒ 双调两次真实进 VLM（W5-4⑧ 幂等契约零回归）');
    assert.equal(r2.state_anchor.answer_source, undefined, '无回放标记（拨号面与旧路径逐字节一致）');
  } finally {
    kernelRegistry.reset();
    _resetAskCache_forTest();
  }
});

test('R5-4 b1: 开关开 ⇒ 同屏同问第二次零拨号回放（answer_source=semantic-cache-hit）', async () => {
  _resetAskCache_forTest();
  enableAskCache();
  try {
    const buf = await solidPng();
    const { client, calls } = countingClient('末行是 HOTKEY-VERIFIED-OK');
    const tool = createAskScreenTool({} as Config, { capture: async () => buf, client: client as never });
    const r1 = await runJson(tool, { question: '最后一行是什么？' });
    assert.equal(calls.length, 1, '首问真实拨号');
    const r2 = await runJson(tool, { question: '最后一行是什么？' });
    assert.equal(calls.length, 1, '同屏同问 ⇒ 零新拨号（verify 类重复问的去重闸）');
    assert.equal(r2.state_anchor.answer_source, 'semantic-cache-hit (screen fingerprint + question identical within 30s — no VLM call was made)');
    assert.equal(r2.state_anchor.answer, r1.state_anchor.answer, '回放答案逐字节一致');
    assert.equal(r2.state_anchor.latency_ms, 0);
  } finally {
    kernelRegistry.reset();
    _resetAskCache_forTest();
  }
});

test('R5-4 b2: 异问 / 异屏 ⇒ 未命中走全管线（键分量执法）', async () => {
  _resetAskCache_forTest();
  enableAskCache();
  try {
    const solid = await solidPng();
    const split = await splitPng();
    const { client, calls } = countingClient('某答案');
    const tool = createAskScreenTool({} as Config, {
      capture: async (which: 'solid' | 'split' = 'solid') => (which === 'solid' ? solid : split),
      client: client as never,
    });
    // 直接驱动：capture 无参方言下先同屏同问铺缓存
    await runJson(tool, { question: 'Q1' });
    assert.equal(calls.length, 1);
    // ① 异问：同屏不同问 ⇒ miss
    const q2 = await runJson(tool, { question: 'Q2' });
    assert.equal(calls.length, 2, '不同问 ⇒ 全管线');
    assert.equal(q2.state_anchor.answer_source, undefined);
    // ② 异屏：同问不同屏 ⇒ miss（deps.capture 换 split 帧）
    const tool2 = createAskScreenTool({} as Config, { capture: async () => split, client: client as never });
    const s2 = await runJson(tool2, { question: 'Q1' });
    assert.equal(calls.length, 3, '屏指纹不同 ⇒ 全管线（缓存不跨屏回放）');
    assert.equal(s2.state_anchor.answer_source, undefined);
  } finally {
    kernelRegistry.reset();
    _resetAskCache_forTest();
  }
});

test('R5-4 b3: TTL 30s —— 窗口内命中、越过窗口诚实回源（墙钟注入）', async () => {
  _resetAskCache_forTest();
  enableAskCache();
  let now = 1_000_000;
  _overrideAskClock_forTest(() => now);
  try {
    const buf = await solidPng();
    const { client, calls } = countingClient('某答案');
    const tool = createAskScreenTool({} as Config, { capture: async () => buf, client: client as never });
    await runJson(tool, { question: 'TTL' }); // miss（写缓存 @now）
    now += 29_999; // 窗口内
    const hit = await runJson(tool, { question: 'TTL' });
    assert.equal(hit.state_anchor.answer_source.includes('semantic-cache-hit'), true);
    assert.equal(calls.length, 1);
    now += 2; // 越过 30s
    const expired = await runJson(tool, { question: 'TTL' });
    assert.equal(expired.state_anchor.answer_source, undefined, '过期 ⇒ 诚实回源');
    assert.equal(calls.length, 2, '全管线重跑');
  } finally {
    _overrideAskClock_forTest(null);
    kernelRegistry.reset();
    _resetAskCache_forTest();
  }
});

// ═══ a · 视觉摘要缓存（askScreen 单槽 + take_screenshot 回执捎带） ═══

test('R5-4 a1: 成功 ask 后 peekAskSummary 指纹命中/异屏/过期三态', async () => {
  _resetAskCache_forTest();
  let now = 2_000_000;
  _overrideAskClock_forTest(() => now);
  try {
    const buf = await solidPng();
    const hash = await dhash(buf);
    const splitHash = await dhash(await splitPng());
    const { client } = countingClient('状态栏显示 Ln 3, Col 24');
    const tool = createAskScreenTool({} as Config, { capture: async () => buf, client: client as never });
    await runJson(tool, { question: '状态栏显示什么？' });
    // ① 同指纹（汉明 0）⇒ 命中
    const hit = peekAskSummary(hash, 0);
    assert.ok(hit, '同屏指纹命中');
    assert.equal(hit.question, '状态栏显示什么？');
    assert.equal(hit.answer, '状态栏显示 Ln 3, Col 24');
    // ② 异屏（汉明 > 阈）⇒ null
    assert.equal(peekAskSummary(splitHash, 0), null, '异屏不提示（零误报优先）');
    // ③ 新鲜窗（120s）外 ⇒ null
    now += 121_000;
    assert.equal(peekAskSummary(hash, 0), null, '摘要过期不捎带');
  } finally {
    _overrideAskClock_forTest(null);
    _resetAskCache_forTest();
  }
});

test('R5-4 a2: take_screenshot 回执捎带 visual_summary_cache —— 同指纹在场、异指纹缺席', async () => {
  _resetAskCache_forTest();
  journal.reset();
  contextManager.reset();
  const { default: sharp } = await import('sharp');
  // 问屏帧（clean 域）与截图帧（overlaid 域）用同一像素 ⇒ 同 dhash（阈值 3 内）
  const askBuf = await solidPng();
  const askHash = await dhash(askBuf);
  const capCalls: Array<{ [k: string]: unknown }> = [];
  const restore = patchSystem({
    getActiveDisplay: async () => ({ name: 'Primary', x: 0, y: 0, width: 1920, height: 1080 }),
    getMousePosition: async () => ({ x: 100, y: 100 }),
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    captureScreenWithOverlay: async (opts: any) => {
      capCalls.push(opts);
      const jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 90, g: 90, b: 90 } } })
        .jpeg().toBuffer();
      return {
        buffer: jpeg, width: 1920, height: 1080,
        dhash: capCalls.length === 1 ? askHash : (await dhash(await splitPng())), // 第 1 拍同屏、第 2 拍异屏
        phash: null, regionDhash: null, unchanged: false, frameId: null,
        transport: 'base64', salience: null, display: null,
      };
    },
  });
  try {
    // 铺摘要：一次成功 ask（摘要单槽登记不受回放开关调制）
    const { client, calls } = countingClient('这是一个干净的桌面');
    const askTool = createAskScreenTool({} as Config, { capture: async () => askBuf, client: client as never });
    await runJson(askTool, { question: '屏幕上有什么窗口？' });
    assert.equal(calls.length, 1);
    // ① 同指纹截图 ⇒ 回执捎带
    const cfg = {
      jpegQuality: 75, gridDivisions: 10, compressWidth: 1440, maxImageCount: 9,
      maxContextImageKb: 4096, enableElementIdMode: false, enableQuantumSense: false,
      enableOcr: false, popupKeywords: '', ocrLang: 'eng', stableScreenDistance: 3,
    } as unknown as Config;
    const shot1 = await runJson(createTakeScreenshotTool(cfg), {});
    assert.equal(shot1.status, 'SUCCESS');
    const cache1 = shot1.state_anchor.visual_summary_cache;
    assert.ok(cache1, '同指纹 ⇒ 摘要在场（纯文本宿主的同屏不重问提示）');
    assert.equal(cache1.question, '屏幕上有什么窗口？');
    assert.equal(cache1.answer, '这是一个干净的桌面');
    assert.ok(cache1.note.includes('Do NOT re-ask'), '提示语含去重指令');
    assert.ok(typeof cache1.age_seconds === 'number');
    // ② 异指纹截图 ⇒ 缺席（零误报）
    const shot2 = await runJson(createTakeScreenshotTool(cfg), { force: true });
    assert.equal(shot2.status, 'SUCCESS');
    assert.equal(shot2.state_anchor.visual_summary_cache, undefined, '异屏不捎带（宁缺勿错）');
  } finally {
    restore();
    journal.reset();
    contextManager.reset();
    _resetAskCache_forTest();
  }
});

// ═══ 键册 · GAP-1 同款病灶收割 ═══

test('R5-4 k1: ask.semanticCache / grounding.semanticCache 双键入册（62 键）且缺省 0=关', () => {
  kernelRegistry.reset();
  try {
    registerProductionKernels();
    assert.ok(kernelRegistry.has('ask.semanticCache'), 'ask.semanticCache 在册');
    assert.ok(kernelRegistry.has('grounding.semanticCache'), 'grounding.semanticCache 在册（ΝΩ-48 消费点终于可开）');
    assert.equal(kernelRegistry.getOrDefault('ask.semanticCache', -1), 0, '缺省 0 = 关（零回归）');
    assert.equal(kernelRegistry.getOrDefault('grounding.semanticCache', -1), 0);
    const r = kernelRegistry.set('grounding.semanticCache', 1);
    assert.ok(r.ok, 'set 不再被 unregistered 拒收');
    assert.equal(kernelRegistry.getOrDefault('grounding.semanticCache', 0), 1);
  } finally {
    kernelRegistry.reset();
  }
});
