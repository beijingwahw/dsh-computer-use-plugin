// test/tools.extractUiVision.test.ts
// W6R-B7 补强：src/tools/extractUiVision.ts 工具层直测（此前零直接覆盖）。
// 全离线确定性：
//   · system.captureScreen/getScreenSize 用 monkey-patch 假面（先例 w1exec.test.ts）；
//   · fetch 用 globalThis.fetch 覆写（记录请求/回放响应）—— B-5 超时护栏分支
//     以 TimeoutError 名字注入，零真实网络。
// 覆盖面：空配置快速失败（零网络请求）、正常路径回执（bbox→归一化中心数学）、
// 畸形条目剔除、Token 预算 slice(10)、HTTP 非 200、超时护栏话术、网络异常降级。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { system } from '../src/system.ts';
import { createExtractUiVisionTool } from '../src/tools/extractUiVision.ts';
import type { Config } from '../src/config.ts';

type Exec = (a: unknown) => Promise<string>;
const exec = (t: unknown): Exec => (t as unknown as { execute: Exec }).execute;

function makeCfg(localVisionApi: string, visionApiTimeoutMs = 5000): Config {
  return { localVisionApi, visionApiTimeoutMs } as unknown as Config;
}

/** system 假面（可变对象字面量 monkey-patch —— 恢复器还原原样） */
function patchSystem(): () => void {
  const host = system as unknown as Record<string, unknown>;
  const savedCap = host.captureScreen;
  const savedSize = host.getScreenSize;
  host.captureScreen = async () => Buffer.from('fake-png-bytes');
  host.getScreenSize = async () => ({ width: 1920, height: 1080 });
  return () => { host.captureScreen = savedCap; host.getScreenSize = savedSize; };
}

interface FetchCall { url: string; method: string; body: unknown; signal: unknown }

/** fetch 假面：记录调用；按脚本回放 */
function patchFetch(respond: (url: string) => Promise<unknown>): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const saved = globalThis.fetch;
  globalThis.fetch = (((url: any, init?: any) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body, signal: init?.signal });
    return respond(String(url));
  }) as unknown as typeof fetch);
  return { calls, restore: () => { globalThis.fetch = saved; } };
}

const restoreSystem = patchSystem();
after(() => restoreSystem());

test('extract_ui_vision: 未配置 localVisionApi —— 零网络请求直接降级', async () => {
  const tool = createExtractUiVisionTool(makeCfg(''));
  const { calls, restore } = patchFetch(async () => { throw new Error('不应发起网络请求'); });
  try {
    const out = JSON.parse(await exec(tool)({}));
    assert.equal(out.status, 'FAILED');
    assert.equal(out.action, 'Local vision extraction unavailable.');
    assert.equal(out.state_anchor.error, 'localVisionApi is not configured.');
    assert.match(out.next_step, /take_screenshot.*visual grounding|visual grounding/s);
    assert.equal(calls.length, 0, '空配置快速失败：不 fetch');
  } finally {
    restore();
  }
});

test('extract_ui_vision: 正常路径 —— 分辨率 + bbox→归一化中心（toFixed(3)）', async () => {
  const tool = createExtractUiVisionTool(makeCfg('http://127.0.0.1:9999/parse_gui'));
  const { calls, restore } = patchFetch(async () => ({
    ok: true, status: 200,
    json: async () => ({
      elements: [
        { label: 'button-a', bbox: [100, 100, 220, 260] },  // cx=160/1920, cy=180/1080
        { label: 'input-b', bbox: [960, 540, 1440, 810] },  // cx=1200/1920=0.625, cy=675/1080=0.625
      ],
    }),
  }));
  try {
    const out = JSON.parse(await exec(tool)({}));
    assert.equal(out.status, 'SUCCESS');
    assert.equal(out.action, 'Extracted 2 element(s) via local vision model.');
    assert.equal(out.state_anchor.screen_resolution, '1920x1080');
    assert.equal(out.state_anchor.extracted_count, 2);
    assert.deepEqual(out.state_anchor.elements, [
      { label: 'button-a', center_normalized: { x: 0.083, y: 0.167 } },
      { label: 'input-b', center_normalized: { x: 0.625, y: 0.625 } },
    ]);
    assert.match(out.next_step, /center_normalized.*click_mouse/);
    // 请求面：POST + FormData + 超时信号在场（B-5 护栏不可缺）
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'http://127.0.0.1:9999/parse_gui');
    assert.equal(calls[0]!.method, 'POST');
    assert.ok(calls[0]!.body instanceof FormData, '原生 FormData（免 axios 依赖）');
    assert.ok(calls[0]!.signal, 'AbortSignal.timeout 护栏在场');
  } finally {
    restore();
  }
});

test('extract_ui_vision: 畸形条目剔除 —— 缺 bbox / 非数值 / 短数组不污染 SUCCESS', async () => {
  const tool = createExtractUiVisionTool(makeCfg('http://127.0.0.1:9999/parse'));
  const { restore } = patchFetch(async () => ({
    ok: true, status: 200,
    json: async () => ({
      elements: [
        { label: 'good', bbox: [0, 0, 1920, 1080] },
        { label: 'no-bbox' },
        { label: 'nan', bbox: [Number.NaN, 0, 10, 10] },
        { label: 'short', bbox: [1, 2, 3] },
        { label: 'str', bbox: ['a', 'b', 'c', 'd'] },
      ],
    }),
  }));
  try {
    const out = JSON.parse(await exec(tool)({}));
    assert.equal(out.status, 'SUCCESS');
    assert.equal(out.state_anchor.extracted_count, 1, '仅 1 条合法条目存活');
    assert.deepEqual(out.state_anchor.elements, [
      { label: 'good', center_normalized: { x: 0.5, y: 0.5 } },
    ]);
  } finally {
    restore();
  }
});

test('extract_ui_vision: Token 预算 —— elements 回传上限 10 条', async () => {
  const tool = createExtractUiVisionTool(makeCfg('http://127.0.0.1:9999/parse'));
  const many = Array.from({ length: 12 }, (_, i) => ({ label: `e${i}`, bbox: [i, i, i + 1, i + 1] }));
  const { restore } = patchFetch(async () => ({ ok: true, status: 200, json: async () => ({ elements: many }) }));
  try {
    const out = JSON.parse(await exec(tool)({}));
    assert.equal(out.state_anchor.extracted_count, 12, '计数诚实报全量');
    assert.equal(out.state_anchor.elements.length, 10, '清单截断到 10（Token 预算）');
  } finally {
    restore();
  }
});

test('extract_ui_vision: HTTP 500 —— 错误点名状态码 + 截图兜底', async () => {
  const tool = createExtractUiVisionTool(makeCfg('http://127.0.0.1:9999/parse'));
  const { restore } = patchFetch(async () => ({ ok: false, status: 500 }));
  try {
    const out = JSON.parse(await exec(tool)({}));
    assert.equal(out.status, 'FAILED');
    assert.equal(out.action, 'Local vision extraction failed.');
    assert.equal(out.state_anchor.error, 'Local vision API responded 500');
    assert.match(out.next_step, /take_screenshot/);
  } finally {
    restore();
  }
});

test('extract_ui_vision: B-5 超时护栏 —— TimeoutError 快速失败 + 忌重试提示', async () => {
  const tool = createExtractUiVisionTool(makeCfg('http://127.0.0.1:9999/parse', 1200));
  const { restore } = patchFetch(async () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    throw err;
  });
  try {
    const out = JSON.parse(await exec(tool)({}));
    assert.equal(out.status, 'FAILED');
    assert.equal(out.state_anchor.error, 'Local vision API timed out after 1200ms.');
    assert.match(out.next_step, /avoid retrying immediately/);
  } finally {
    restore();
  }
});

test('extract_ui_vision: AbortError 同走超时分支（护栏双名兼容）', async () => {
  const tool = createExtractUiVisionTool(makeCfg('http://127.0.0.1:9999/parse', 800));
  const { restore } = patchFetch(async () => {
    const err = new Error('This operation was aborted');
    err.name = 'AbortError';
    throw err;
  });
  try {
    const out = JSON.parse(await exec(tool)({}));
    assert.equal(out.status, 'FAILED');
    assert.equal(out.state_anchor.error, 'Local vision API timed out after 800ms.');
  } finally {
    restore();
  }
});

test('extract_ui_vision: 一般网络错误 —— 原始消息透传 + 降级路由', async () => {
  const tool = createExtractUiVisionTool(makeCfg('http://127.0.0.1:9999/parse'));
  const { restore } = patchFetch(async () => { throw new TypeError('fetch failed'); });
  try {
    const out = JSON.parse(await exec(tool)({}));
    assert.equal(out.status, 'FAILED');
    assert.equal(out.state_anchor.error, 'fetch failed');
    assert.match(out.next_step, /Fallback to standard 'take_screenshot'/);
    assert.doesNotMatch(out.next_step, /avoid retrying/);
  } finally {
    restore();
  }
});
