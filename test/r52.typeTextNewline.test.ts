// test/r52.typeTextNewline.test.ts
// R5-2 · D5 执法册：type_text 多行换行语义 —— TS 全链零剥离 + 回执披露。
//
// 根因（批1 seed-report，R4-2 §2.1/§4 D5）：\n 以 KEYEVENTF_UNICODE 0x000A
// 注入合成 WM_CHAR '\n'，Windows 编辑控件只认 '\r'(0x0D) ⇒ 换行被吞、多行
// 塌缩单行（两轮全废 9 浪费步）。python 侧修法（_newline_plan：换行 → 真
// VK_RETURN 键事件，python_service/tests/test_input_newline.py 钉）。
// 本册执法 TS 侧三面：
//   A. 工具层透传：多行 text 原样抵达 system.typeText（无剥离/归一），
//      回执披露 newline_count + newline_semantics；
//   B. dist 全链字节保真：dist/system.js → serialize → dist/physicalBackend.js
//      → 真实 HTTP 适配器（createPhysicalExecution, enableAuth=false）→ mock
//      物理服务端口 —— 捕获的线级 JSON body 落盘后与原文 utf8 逐字节比对
//      （\n / \r\n / 非 BMP 混合负载）；零 GUI（mock 端口，无真实键路）；
//   C. T8 回执增强回归钉：press_hotkey 选族和弦「SELECTION UNVERIFIED」话术
//      与非选族回执字节不变；type_text 鼠标代理降级披露。
// 全离线确定性：不孵化 python 服务、不触真实键盘（mock 端口 + 假 system）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { system } from '../src/system.ts';
import type { Config } from '../src/config.ts';
import { createTypeTextTool } from '../src/tools/typeText.ts';
import { createPressHotkeyTool, isSelectionChord } from '../src/tools/pressHotkey.ts';

type Exec = (a: unknown) => Promise<string>;
const exec = (t: unknown): Exec => (t as unknown as { execute: Exec }).execute;
async function runJson(t: unknown, args: unknown): Promise<any> {
  return JSON.parse(await exec(t)(args));
}

const NO_VERIFY_CFG = {
  maxTextLength: 1000, focusMaxAgeMs: 60_000,
  enableRiskGate: false, riskPatterns: '', enableApprovalGate: false, dangerPatterns: '',
  verifyActions: false, dryRun: false, enableOcr: false,
} as unknown as Config;

// ─── 假件工坊（r43 同款）───

const originalSystem = {
  typeText: system.typeText.bind(system),
  pressHotkey: system.pressHotkey.bind(system),
};
function patchSystem(over: Record<string, unknown>): void {
  const host = system as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) host[k] = v;
}
after(() => {
  const host = system as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(originalSystem)) host[k] = v;
});

// ─── A：工具层透传 + 回执披露 ───

test('R5-2 D5-A: 多行文本经工具层零剥离 + newline_count/newline_semantics 回执', async () => {
  const MULTILINE = 'ROW-1\nROW-2\r\nROW-3\rROW-4\r\nEmoji😀 尾行';
  let captured: string | null = null;
  patchSystem({ typeText: async (text: string, clearFirst: boolean) => {
    captured = text; void clearFirst;
  } });
  const out = await runJson(createTypeTextTool(NO_VERIFY_CFG), { text: MULTILINE });
  assert.equal(out.status, 'SUCCESS');
  assert.equal(captured, MULTILINE, '工具层必须逐字节透传（含 \\n / \\r\\n / \\r / 非 BMP）');
  // 回执披露：换行计数（\r\n 记 1 次）与注入语义
  assert.equal(out.state_anchor.newline_count, 4);
  assert.match(out.state_anchor.newline_semantics, /real Enter keypress/);
  assert.match(out.state_anchor.newline_semantics, /separate lines/);
});

test('R5-2 D5-A2: 单行文本回执无换行键 —— 锚点形状与旧路逐字节一致', async () => {
  patchSystem({ typeText: async () => { /* noop */ } });
  const out = await runJson(createTypeTextTool(NO_VERIFY_CFG), { text: 'plain single line' });
  assert.equal(out.state_anchor.newline_count, undefined);
  assert.equal(out.state_anchor.newline_semantics, undefined);
  // ΑΩ-R29 顶层四键序铁律不破
  assert.deepEqual(Object.keys(out), ['status', 'action', 'state_anchor', 'next_step']);
});

test('R5-2 D5-A3: 工具描述立法多行语义（模型不再退回逐行+enter 绕行）', async () => {
  const desc = (createTypeTextTool(NO_VERIFY_CFG) as unknown as { description: string }).description;
  assert.match(desc, /Multi-line text is fully supported/);
  assert.match(desc, /real Enter keypresses/);
});

// ─── B：dist 全链字节保真（mock 物理端口 + 真实 HTTP 适配器）───

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const distUp = () => fs.existsSync(path.join(DIST, 'physicalBackend.js'))
  && fs.existsSync(path.join(DIST, 'system.js'));

test('R5-2 D5-B: dist 全链（system→ioMutex→backend→HTTP）多行字节逐比对落盘', { skip: !distUp() && 'dist 未构建（先 npm run build）' }, async () => {
  const MULTILINE = '# 标题行\r\nROW-1\nROW-2\r\nROW-3\r非BMP😀尾行';
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      bodies.push(`${req.method} ${req.url} ${raw}`);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'success', data: { typed_chars: MULTILINE.length } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  // dist 无 .d.ts（构建产物）—— 运行时动态取模 + 源码类型断言（tsc 不解析 dist）
  const distMod = (m: string) => `../dist/${m}.js`;
  let distBackend: typeof import('../src/physicalBackend.ts') | null = null;
  try {
    distBackend = (await import(distMod('physicalBackend'))) as typeof import('../src/physicalBackend.ts');
    const compose = (await import(distMod('physicalExecution/compose'))) as typeof import('../src/physicalExecution/compose.ts');
    const { createPhysicalExecution } = compose;
    // 真适配器指向 mock 端口（enableAuth=false —— 诊断模式，零密钥/零令牌）
    const adapter = createPhysicalExecution({
      baseUrl: `http://127.0.0.1:${addr.port}/v1`,
      timeoutMs: 3000,
      keyPath: 'unused-auth-disabled',
      enableAuth: false,
    });
    distBackend._setAdapterForTests(adapter as never);
    // dist 全链：system.typeText → serialize → backend.typeText → HTTP
    const distSystem = (await import(distMod('system'))) as { system: typeof system };
    await distSystem.system.typeText(MULTILINE, false);

    assert.equal(bodies.length, 1, '恰一次线级派发');
    const line = bodies[0];
    assert.match(line, /^POST \/v1\/type_text /, '端点与方法');
    const wireBody = line.replace(/^POST \/v1\/type_text /, '');
    // 落盘逐字节比对：线级 body 的 text 字段解码后与原文 utf8 字节相等
    const parsed = JSON.parse(wireBody) as { text: string; clear_first: boolean; dry_run: boolean };
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'r52-')), 'wire.json');
    fs.writeFileSync(tmp, parsed.text, 'utf8');
    const landed = fs.readFileSync(tmp);
    assert.deepEqual(landed, Buffer.from(MULTILINE, 'utf8'), '落盘字节 === 原文 utf8 字节（\\n/\\r\\n/\\r/非BMP 全保真）');
    assert.equal(parsed.clear_first, false);
    assert.equal(parsed.dry_run, false);
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  } finally {
    if (distBackend) distBackend._setAdapterForTests(null);
    server.close();
  }
});

// ─── C：T8 回执增强回归钉 ───

test('R5-2 T8-C1: 选族和弦（shift+end/home/方向键）回执明示 SELECTION UNVERIFIED', async () => {
  for (const keys of [['shift', 'end'], ['shift', 'home'], ['shift', 'right'], ['shift', 'down']]) {
    patchSystem({ pressHotkey: async () => { /* noop */ } });
    const out = await runJson(createPressHotkeyTool(), { keys });
    assert.equal(out.status, 'SUCCESS');
    assert.match(out.next_step, /SELECTION UNVERIFIED/, `keys=${keys.join('+')}`);
    assert.match(out.next_step, /duplicate-text hazard/);
    assert.match(out.next_step, /take_screenshot/);
  }
});

test('R5-2 T8-C2: 非选族和弦回执字节不变（ctrl+s / esc / 单键）', async () => {
  patchSystem({ pressHotkey: async () => { /* noop */ } });
  for (const keys of [['ctrl', 's'], ['esc'], ['ctrl', 'shift', 'tab'], ['shift']]) {
    const out = await runJson(createPressHotkeyTool(), { keys });
    assert.equal(out.next_step, "Call 'take_screenshot' to verify the shortcut took effect.", `keys=${keys.join('+')}`);
  }
  assert.equal(isSelectionChord(['shift', 'end']), true);
  assert.equal(isSelectionChord(['ctrl', 'end']), false);
  assert.equal(isSelectionChord(['shift']), false);
  assert.equal(isSelectionChord('shift+end'), false, '非数组输入安全拒绝');
});

test('R5-2 T8-C3: noop WARNING 附鼠标代理降级披露 + 禁盲重打（加法式，原锚保留）', async () => {
  const { default: sharp } = await import('sharp');
  const tiny = (await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 90, g: 90, b: 90 } },
  }).jpeg().toBuffer()).toString('base64');
  const backend = (await import('../src/physicalBackend.ts'));
  const SCREEN = '7777777777777777';
  const REGION = 'aaaaaaaaaaaaaaaa';
  let n = -1;
  backend._setAdapterForTests({
    takeScreenshot: async () => {
      n++;
      return {
        ok: true as const,
        value: {
          transport: 'base64' as const, name: '', size: 0, shape: [1, 1, 3] as [number, number, number],
          dtype: 'uint8', stride: 0, format: 'png', width: 1, height: 1, captured_at: 1,
          image_base64: tiny, dhash: SCREEN, phash: null, region_dhash: REGION,
          unchanged: false, frame_id: null,
        },
      };
    },
  } as never);
  patchSystem({
    typeText: async () => { /* noop */ },
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    getMousePosition: async () => ({ x: 100, y: 100 }), // 焦点兜底 → 鼠标代理路径
  });
  const cfg = {
    maxTextLength: 1000, focusMaxAgeMs: 60_000,
    enableRiskGate: false, riskPatterns: '', enableApprovalGate: false, dangerPatterns: '',
    verifyActions: true, dryRun: false, adaptiveSettle: false, actionSettleMs: 1,
    noopSimilarityThreshold: 0.97, regionVerifyRadius: 0.15, enableOcr: false,
  } as unknown as Config;
  const out = await runJson(createTypeTextTool(cfg), { text: 'ROW-2-EDITED-FULL' });
  try {
    assert.equal(out.state_anchor.effect.detected, false);
    // 既有 b4② 锚（r43）原句保留（加法式）
    assert.match(out.action, /^WARNING: keystrokes dispatched but NO screen\/focus-region change was verified/);
    assert.match(out.action, /Do NOT chain the next action on this input/);
    assert.match(out.next_step, /Click the input field first, then retype/);
    // R5-2 新增：鼠标代理披露 + 禁盲重打
    assert.match(out.action, /CAVEAT: the verified region was centered on the CURRENT MOUSE POSITION/);
    assert.match(out.next_step, /blind retyping duplicates the inserted text/);
    assert.match(out.state_anchor.effect.focus_source, /mouse-position/);
  } finally {
    backend._setAdapterForTests(null);
  }
});
