// test/tools.textTools.test.ts
// W6R-B7 补强：src/tools/textTools.ts 工具层直测（read_text / find_text，此前零直接覆盖）。
// 全离线确定性：假 adapter 经 physicalBackend._setAdapterForTests 注入（先例
// p3-ocrscore.test.ts）—— 服务端 L2 OCR 路径（getUiTree）与 UIA 探针（hitTest）
// 全部落网，绝不触发 D-5 微服务。textReader 的服务端负缓存每次归零
// （_setServerOcrFailedAt_forTest(0)）。
// 覆盖面：区域参数校验/双侧夹取数学、URL 感知、截断预算、find_text 的
// 大小写不敏感过滤 + interactivity 标注（uia 判决 / unprobed 降级）+ 交界警告话术。
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as backend from '../src/physicalBackend.ts';
import * as textReader from '../src/textReader.ts';
import { createReadTextTool, createFindTextTool } from '../src/tools/textTools.ts';
import type { Config } from '../src/config.ts';

type Exec = (a: unknown) => Promise<string>;
const exec = (t: unknown): Exec => (t as unknown as { execute: Exec }).execute;

after(() => {
  backend._setAdapterForTests(null);
  textReader._setServerOcrFailedAt_forTest(0);
});

beforeEach(() => {
  textReader._setServerOcrFailedAt_forTest(0); // 清服务端负缓存（离线前置）
});

const baseCfg = {
  ocrLang: 'eng',
  enableInteractivityProbe: false,
  probeMaxTargets: 2,
  probeDwellMs: 300,
  probeRegionRadius: 0.02,
  probeRepaintThreshold: 0.97,
  enableProbeMemory: false,
  enableProbeEconomy: false,
} as unknown as Config;

/** 假 L2 OCR 元素（rect 二进精确值 —— 断言免浮点噪声） */
function l2(name: string, rect: { x: number; y: number; width: number; height: number }, score = 0.9) {
  return { source: 'L2-ocr', role: 'text', name, rect, score };
}

/**
 * 探针路径的公共假面：悬停准备面（getCursor/moveMouse）按真实行为供给 ——
 * W8 起 UIA 全判决时 probeLegacy 不再触发它们（调用序执法见
 * interactivityProbe.economy.test.ts），有残余点时仍会用到。
 */
const probeHoverBase = {
  getCursor: async () => ({ ok: true as const, value: { x: 960, y: 540 } }),
  moveMouse: async () => ({ ok: true as const, value: { pixel: { x: 480, y: 270 } } }),
  health: async () => ({
    ok: true as const,
    value: {
      status: 'ok' as const, version: '0.4.0', platform: 'win32' as const, python: '3.12',
      screen: { width: 1920, height: 1080 }, capabilities: [], switch_window_method: 'native' as const,
      ui_funnel: { l1_tree: 'available' as const, l2_ocr: 'available' as const, l3_vlm: '', l3_arbitration_enabled: false },
      screenshot_transport: 'base64' as const, auth: { pid_attestation: false, capability_token: false },
    },
  }),
};

/** 装载假 adapter：getUiTree 回放受控元素表并记录调用参数 */
let uiTreeCalls: Array<Record<string, unknown>> = [];
function fakeOcr(elements: Array<Record<string, unknown>>): void {
  uiTreeCalls = [];
  backend._setAdapterForTests({
    getUiTree: async (args?: Record<string, unknown>) => {
      uiTreeCalls.push({ ...(args ?? {}) });
      return {
        ok: true as const,
        value: { elements, funnel_depth: 'L2', fault: null, captured_at: 1, l3_invoked: false },
      };
    },
  } as never);
}

const readText = createReadTextTool(baseCfg);
const findText = createFindTextTool(baseCfg);

// ═══ read_text：参数校验 / 区域数学 ═══

test('read_text: 半指定区域（只传 x）—— 诚实报错而非静默全屏兜底', async () => {
  fakeOcr([]);
  const out = await exec(readText)({ x: 0.5 });
  assert.match(out, /^\[Error\]: Region requires BOTH x and y/);
  assert.match(out, /Omit both for a full-screen read/);
  assert.equal(uiTreeCalls.length, 0, '校验失败不发起 OCR');
});

test('read_text: 越界区域拒绝（x=1.5 / half_size=0.6）', async () => {
  fakeOcr([]);
  assert.match(await exec(readText)({ x: 1.5, y: 0.5 }), /^\[Error\]: Invalid region/);
  assert.match(await exec(readText)({ x: 0.5, y: 0.5, half_size: 0.6 }), /^\[Error\]: Invalid region/);
  assert.equal(uiTreeCalls.length, 0);
});

test('read_text: 边界值放行（x/y=1.0、half_size=0.5）+ 双侧夹取数学', async () => {
  fakeOcr([]);
  await exec(readText)({ x: 0.9, y: 0.5, half_size: 0.25 });
  assert.equal(uiTreeCalls.length, 1);
  // x0=max(0,0.9-0.25)=0.65；x1=min(1,0.9+0.25)=1（越界侧归边）
  assert.deepEqual(uiTreeCalls[0]!.region, { x: 0.65, y: 0.25, width: 0.35, height: 0.5 });
  assert.equal(uiTreeCalls[0]!.source, 'ocr');
  assert.equal(uiTreeCalls[0]!.funnelCeiling, 'L2');
});

test('read_text: 全屏缺省 —— region 缺席传给服务端', async () => {
  fakeOcr([]);
  await exec(readText)({});
  assert.equal(uiTreeCalls.length, 1);
  assert.equal(uiTreeCalls[0]!.region, undefined, '全屏读 region 为 undefined');
});

// ═══ read_text：回执结构 ═══

test('read_text: 无字 —— text_found=false + 放大重试指引', async () => {
  fakeOcr([]);
  const out = JSON.parse(await exec(readText)({}));
  assert.equal(out.status, 'SUCCESS');
  assert.deepEqual(out.state_anchor, { scope: 'full_screen', text_found: false });
  assert.match(out.next_step, /zoom_inspect|larger half_size/);
});

test('read_text: 有字 —— 文本 + 字数 + scope 注记', async () => {
  fakeOcr([l2('Hello', { x: 0.1, y: 0.1, width: 0.05, height: 0.01 })]);
  const out = JSON.parse(await exec(readText)({ x: 0.5, y: 0.5, half_size: 0.25 }));
  assert.equal(out.state_anchor.scope, 'region_center=(0.5, 0.5) half=0.25');
  assert.equal(out.state_anchor.text_found, true);
  assert.equal(out.state_anchor.char_count, 5);
  assert.equal(out.state_anchor.text, 'Hello');
  assert.equal('urls_detected' in out.state_anchor, false, '无 URL 时键缺席');
});

test('read_text: 正文 URL 自动浮出 + 跳转出口指向 open_url（禁点击）', async () => {
  fakeOcr([l2('详见 https://example.com/a?x=1 即可', { x: 0.1, y: 0.2, width: 0.6, height: 0.04 })]);
  const out = JSON.parse(await exec(readText)({}));
  assert.deepEqual(out.state_anchor.urls_detected, ['https://example.com/a?x=1']);
  assert.match(out.next_step, /call 'open_url' with it/);
  assert.match(out.next_step, /do NOT click/);
});

test('read_text: 超长文本截断到 1500 字符预算', async () => {
  const long = 'x'.repeat(1600);
  fakeOcr([l2(long, { x: 0, y: 0, width: 0.4, height: 0.04 })]);
  const out = JSON.parse(await exec(readText)({}));
  assert.equal(out.state_anchor.char_count, 1600, 'char_count 报全长（诚实）');
  assert.equal(out.state_anchor.text.length, 1500 + '...[truncated]'.length);
  assert.ok(out.state_anchor.text.endsWith('...[truncated]'));
});

test('read_text: 三连以上换行压缩为两连（文本预算卫生）', async () => {
  fakeOcr([l2('a\n\n\n\nb', { x: 0, y: 0, width: 0.1, height: 0.01 })]);
  const out = JSON.parse(await exec(readText)({}));
  assert.equal(out.state_anchor.text, 'a\n\nb');
});

test('read_text: OCR 全路径失败 —— [Error] 前缀 + take_screenshot 降级指引', async () => {
  // getUiTree 失败 ⇒ 服务端负缓存；legacy 路径 captureCleanPng 亦失败 ⇒ 工具 catch
  backend._setAdapterForTests({
    getUiTree: async () => ({ ok: false as const, error: { kind: 'ocr_unavailable', detail: 'engine missing' } }),
    takeScreenshot: async () => ({ ok: false as const, error: { kind: 'screen_capture_failed', detail: 'no frame' } }),
  } as never);
  const out = await exec(readText)({});
  assert.match(out, /^\[Error\]: OCR failed \(/);
  assert.match(out, /fall back to take_screenshot/);
});

// ═══ find_text ═══

test('find_text: 无命中 —— matches=0 + 视觉兜底指引', async () => {
  fakeOcr([l2('Settings', { x: 0.1, y: 0.1, width: 0.05, height: 0.01 })]);
  const out = JSON.parse(await exec(findText)({ keyword: 'nonexistent' }));
  assert.equal(out.status, 'SUCCESS');
  assert.deepEqual(out.state_anchor.keyword, 'nonexistent');
  assert.equal(out.state_anchor.matches, 0);
  assert.match(out.next_step, /No match on screen/);
});

test('find_text: 大小写不敏感包含匹配 + 探针关闭 ⇒ unprobed 标注', async () => {
  fakeOcr([l2('Login', { x: 0.4, y: 0.5, width: 0.05, height: 0.01 })]);
  const out = JSON.parse(await exec(findText)({ keyword: 'LOG' }));
  assert.equal(out.state_anchor.matches, 1);
  assert.equal(out.state_anchor.probed, 0);
  const line = out.state_anchor.locations[0] as string;
  assert.match(line, /"Login"/);
  assert.match(line, /center=\(0\.425, 0\.505\)/);
  assert.match(line, /shape=control-like/);
  assert.match(line, /interactivity=unprobed \(budget; trust shape with caution\)/);
  assert.match(out.next_step, /ONLY click a match with interactivity=control/);
});

test('find_text: 探针开启 —— UIA control/text 双判决 + via=uia 证据链 + 警告话术', async () => {
  // 场景：正文行提到 login（content-like，宽行）与真按钮 Login（control-like，紧凑）
  const hits: Array<{ x: number; y: number; classification: string; control_type: string }> = [];
  backend._setAdapterForTests({
    ...probeHoverBase,
    getUiTree: async () => ({
      ok: true as const,
      value: {
        elements: [
          l2('To login, enter your credentials now', { x: 0.05, y: 0.1, width: 0.6, height: 0.04 }),
          l2('Login', { x: 0.4, y: 0.5, width: 0.05, height: 0.01 }),
        ],
        funnel_depth: 'L2', fault: null, captured_at: 1, l3_invoked: false,
      },
    }),
    hitTest: async (args: { x: number; y: number }) => {
      // 宽行中心 y≈0.12 ⇒ text；按钮中心 y≈0.505 ⇒ control
      const isControl = args.y > 0.3;
      hits.push({
        x: args.x, y: args.y,
        classification: isControl ? 'control' : 'text',
        control_type: isControl ? 'Button' : 'Text',
      });
      return {
        ok: true as const,
        value: {
          available: true,
          classification: isControl ? 'control' : 'text',
          control_type: isControl ? 'Button' : 'Text',
          name: isControl ? 'Login' : '正文',
          matched_depth: isControl ? 2 : null,
        },
      };
    },
  } as never);
  const tool = createFindTextTool({ ...baseCfg, enableInteractivityProbe: true } as Config);
  const out = JSON.parse(await exec(tool)({ keyword: 'login' }));
  assert.equal(out.state_anchor.matches, 2);
  assert.equal(out.state_anchor.probed, 2);
  assert.equal(hits.length, 2, '两个目标点均过 UIA 通道');
  const textLine = (out.state_anchor.locations as string[]).find(l => l.includes('credentials'))!;
  const ctrlLine = (out.state_anchor.locations as string[]).find(l => l.includes('"Login"'))!;
  assert.match(textLine, /shape=content-like interactivity=text \[via=uia\(Text\), conf=0\.93\]/);
  assert.match(ctrlLine, /shape=control-like interactivity=control \[via=uia\(Button, ancestor\+2\), conf=0\.97\]/);
  assert.match(out.next_step, /A control match exists in this result\./);
  assert.ok(!out.next_step.includes('WARNING: only text matches'));
});

test('find_text: 只有正文命中 —— WARNING 话术禁止点击', async () => {
  backend._setAdapterForTests({
    ...probeHoverBase,
    getUiTree: async () => ({
      ok: true as const,
      value: {
        elements: [l2('please login to continue reading', { x: 0.05, y: 0.1, width: 0.6, height: 0.04 })],
        funnel_depth: 'L2', fault: null, captured_at: 1, l3_invoked: false,
      },
    }),
    hitTest: async () => ({
      ok: true as const,
      value: { available: true, classification: 'text', control_type: 'Text', name: '正文', matched_depth: null },
    }),
  } as never);
  const tool = createFindTextTool({ ...baseCfg, enableInteractivityProbe: true } as Config);
  const out = JSON.parse(await exec(tool)({ keyword: 'login' }));
  assert.equal(out.state_anchor.probed, 1);
  assert.match(out.state_anchor.locations[0], /interactivity=text/);
  assert.match(out.next_step, /WARNING: only text matches were found — do not click any of them\./);
});

// ═══ ΝΩ-31：find_text 多命中标注（形状先验全覆盖）═══

test('ΝΩ-31 find_text: 第 9+ 命中不再从清单消失 —— 至少携带 wordShape 几何标注', async () => {
  // 12 个 'menu' 命中：前 4 个紧凑（control-like）、第 5+ 个宽行（content-like）
  const els = Array.from({ length: 12 }, (_, i) =>
    i < 4
      ? l2(`menu item ${i}`, { x: 0.1 + i * 0.05, y: 0.05, width: 0.05, height: 0.01 })
      : l2(`menu option ${i} with a long caption line`, { x: 0.05, y: 0.1 + i * 0.05, width: 0.6, height: 0.04 }));
  fakeOcr(els);
  const out = JSON.parse(await exec(findText)({ keyword: 'menu' }));
  assert.equal(out.status, 'SUCCESS');
  assert.equal(out.state_anchor.matches, 12);
  assert.equal(out.state_anchor.locations.length, 12, '全部命中入清单（旧行为只列前 8）');
  const pool = out.state_anchor.locations.slice(0, 8) as string[];
  const beyond = out.state_anchor.locations.slice(8) as string[];
  assert.ok(pool.every(l => /interactivity=unprobed \(budget; trust shape with caution\)/.test(l)),
    '探针池内未探针命中：budget 标注（旧语义不动）');
  assert.ok(beyond.every(l => /shape=(control-like|content-like|ambiguous)/.test(l)),
    '第 9+ 命中携带 wordShape 几何先验（无探针也有形状证据）');
  assert.ok(beyond.every(l => /interactivity=unprobed \(beyond probe pool; shape prior only\)/.test(l)),
    '第 9+ 命中如实标注池外（本轮不可能升级为物理判决）');
  assert.match(beyond[0], /shape=content-like/, '宽行命中判 content-like（几何判据照常执法）');
  assert.match(out.state_anchor.locations[0], /shape=control-like/);
});
