// test/now25.systemPerf.test.ts
// ΝΩ-25（系统层性能/正确性三件）执法测试：
//   1. PowerShell 批处理 —— WindowsAdapter 的复原序列同类相邻合并为单个
//      -EncodedCommand 脚本（Add-Type 只编译一次）；假 spawn 捕获编码命令
//      计数断言合并数；restoreAll 整条 LIFO 序列单次往返；错误信封不打折。
//   2. system.switchWindowByTitle 错误路由结构化 —— error.kind 优先（正例：
//      缺席类 kind ⇒ 委托接管；反例：element_not_found 且消息埋 ECONNREFUSED
//      钓饵 ⇒ 仍上抛 —— 方言变更不再静默改道）；无 kind 的外来 Error 才走
//      消息正则兜底。
//   3. ensureBackend 端口并行探活 —— 假 HTTP 服务（慢/快各一）：首活即取
//      （快者先证活先被收养）；哑 socket ×3 占住前序端口时总耗时 ≪ 串行墙
//      （8×800ms → ⌈8/4⌉ 批），收养 version 闸门语义不动。
// 全离线确定性（PS 半边与 HTTP 半边均为注入桩/localhost 假服务，零真实
// spawn —— python/powershell 缺席不影响本文件）。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as httpCreateServer, type Server as HttpServer } from 'node:http';
import { createServer as netCreateServer, type Server as NetServer, type Socket } from 'node:net';

import { WindowsAdapter, coalesceAdjacentRuns, shaper } from '../src/environmentShaper.ts';
import type { ShaperActionKind, UndoRecipe } from '../src/environmentShaper.ts';
import { system } from '../src/system.ts';
import * as backend from '../src/physicalBackend.ts';
import { PhysicalBackendError } from '../src/physicalBackend.ts';
import { probeAlive } from '../src/physicalBackend.internal.ts';
import { PHYSICAL_TCP_BASE_PORT as BASE_PORT } from '../src/physicalExecution/serviceManager.js';

// ─── 共用：假 powershell（解码 -EncodedCommand 回脚本原文；可注入应答） ───

interface PsHarness { scripts: string[]; exec: (cmd: string, args: string[]) => Promise<{ stdout: string }>; setRespond: (fn: ((script: string) => string | Promise<string>) | null) => void }

function fakePs(): PsHarness {
  const scripts: string[] = [];
  let respond: ((script: string) => string | Promise<string>) | null = null;
  const exec = async (_cmd: string, args: string[]) => {
    const last = String(args[args.length - 1]);
    const script = args.includes('-EncodedCommand')
      ? Buffer.from(last, 'base64').toString('utf16le')
      : last;
    scripts.push(script);
    if (respond) return { stdout: await respond(script) };
    // 缺省应答：扮演 powershell —— 批脚本的 OK 标记模板原样回显为标记行
    const markers = [...script.matchAll(/'R(\d+)\|(OK)'/g)].map(m => `R${m[1]}|OK`);
    if (markers.length > 0) return { stdout: `${markers.join('\n')}\n` };
    if (script.includes('MainWindowHandle')) return { stdout: '4242||Some Window\n' };
    if (script.includes('GetWindowRect')) return { stdout: '10,20,300,200,0\n' };
    return { stdout: 'True\n' };
  };
  return { scripts, exec, setRespond: fn => { respond = fn; } };
}

/** system 键鼠 monkey-patch（system 是可变对象字面量 —— 恢复器还原原样；先例 tools.switchTab.test.ts） */
function patchPressHotkey(fn: (keys: string[]) => Promise<void>): () => void {
  const host = system as unknown as Record<string, unknown>;
  const saved = host.pressHotkey;
  host.pressHotkey = fn;
  return () => { host.pressHotkey = saved; };
}

// ─── ΝΩ-25(b)：同类相邻合并通用件 ───

test('NOW25-coalesce: 同类相邻段合并 —— 相邻同通道并入同批，跨通道保序不并', () => {
  const runs = coalesceAdjacentRuns(
    ['ps', 'ps', 'hotkey', 'ps', 'ps', 'ps', 'noop'],
    c => c,
  );
  assert.deepEqual(runs.map(r => r.channel), ['ps', 'hotkey', 'ps', 'noop'], '切段边界 = 通道切换点');
  assert.deepEqual(runs.map(r => r.items.length), [2, 1, 3, 1], '批内条数');
  // 跨通道步永不合并（LIFO 依赖序不可重排的合并面）
  const ordered = runs.flatMap(r => r.items);
  assert.deepEqual(ordered, ['ps', 'ps', 'hotkey', 'ps', 'ps', 'ps', 'noop'], '顺序保真');
});

// ─── ΝΩ-25(a)：undoBatch 批处理（PS 通道单脚本一次往返） ───

test('NOW25-batch: 3 条 ps 通道 recipe ⇒ 单次 -EncodedCommand，Add-Type 只编译一次', async () => {
  const ps = fakePs();
  const a = new WindowsAdapter({ probe: () => true, exec: ps.exec });
  const recipes: UndoRecipe[] = [
    { kind: 'move_window', titleHint: 'Notepad-A', before: { x: 1, y: 2, width: 30, height: 40 } },
    { kind: 'maximize_window', titleHint: 'Editor-B', before: { x: 5, y: 6 } },
    { kind: 'set_contrast', before: { theme: '4' } },
  ];
  const outcomes = await a.undoBatch(recipes);
  assert.equal(ps.scripts.length, 1, '整段一个脚本一次 spawn（旧逐条路径 ≥ 7 次）');
  assert.ok(outcomes.every(o => o.ok), `全部成功：${JSON.stringify(outcomes)}`);
  const script = ps.scripts[0];
  // Add-Type 只编译一次：两类 P/Invoke 声明各出现一次（多步共享一次编译）
  assert.equal((script.match(/Add-Type -Name U32\b/g) ?? []).length, 1, 'USER32 声明一次');
  assert.equal((script.match(/Add-Type -Name U32HC\b/g) ?? []).length, 1, 'HC 声明一次');
  // 标记协议在场：每步恰一行完成标记
  for (const tag of ['R0|', 'R1|', 'R2|']) assert.ok(script.includes(`'${tag}OK'`), `标记模板 ${tag} 在场`);
  // LIFO 步序保持：R0（先还原的 move）在前 —— 脚本内语句顺序即执行顺序
  assert.ok(script.indexOf("'Notepad-A'") < script.indexOf("'Editor-B'"), '批内语句序 = 传入序（LIFO）');
});

test('NOW25-batch: 通道切换不合并 —— [move, zoom, move] ⇒ 2 次 PS + 1 次热键', async () => {
  const ps = fakePs();
  const a = new WindowsAdapter({ probe: () => true, exec: ps.exec });
  const chords: string[][] = [];
  const restoreHotkey = patchPressHotkey(async keys => { chords.push([...keys]); });
  try {
    const recipes: UndoRecipe[] = [
      { kind: 'move_window', titleHint: 'A', before: { x: 1, y: 2 } },
      { kind: 'set_zoom', titleHint: 'B' },
      { kind: 'move_window', titleHint: 'C', before: { x: 3, y: 4 } },
    ];
    const outcomes = await a.undoBatch(recipes);
    assert.equal(ps.scripts.length, 2, '热键步隔断的两段 PS 各自成批（保序不跨通道合并）');
    assert.deepEqual(chords, [['ctrl', '0']], 'set_zoom 复原走热键管线（黑名单执法面不可绕）');
    assert.ok(outcomes.every(o => o.ok), '三步全成');
    // 顺序保真：第一段 PS 在热键之前发出
    assert.ok(ps.scripts[0].includes("'A'") && !ps.scripts[0].includes("'C'"), '首段只含热键前的步');
    assert.ok(ps.scripts[1].includes("'C'"), '末段只含热键后的步');
  } finally {
    restoreHotkey();
  }
});

test('NOW25-batch: 错误信封不打折 —— R0|ERR 单步失败记因，不阻断 R1', async () => {
  const ps = fakePs();
  ps.setRespond(() => 'R0|ERR|SetWindowPos blew up\nR1|OK\n');
  const a = new WindowsAdapter({ probe: () => true, exec: ps.exec });
  const outcomes = await a.undoBatch([
    { kind: 'move_window', titleHint: 'A', before: { x: 1, y: 2 } },
    { kind: 'move_window', titleHint: 'B', before: { x: 3, y: 4 } },
  ]);
  assert.deepEqual(outcomes[0], { ok: false, reason: 'SetWindowPos blew up' }, '单步失败有原因');
  assert.deepEqual(outcomes[1], { ok: true }, '失败不阻断后续步（部分复原优于中止）');
});

test('NOW25-batch: spawn 失败 ⇒ 整段记因（exec 拒绝的整批信封）', async () => {
  const ps = fakePs();
  ps.setRespond(() => { throw new Error('spawn powershell ENOENT'); });
  const a = new WindowsAdapter({ probe: () => true, exec: ps.exec });
  const outcomes = await a.undoBatch([
    { kind: 'maximize_window', titleHint: 'A' },
    { kind: 'set_contrast', before: { theme: '0' } },
  ]);
  assert.equal(outcomes.length, 2);
  assert.ok(outcomes.every(o => !o.ok && o.reason?.includes('ENOENT')), `整段失败带原因：${JSON.stringify(outcomes)}`);
});

test('NOW25-batch: 零标记方言兼容 —— 旧 exec 桩只回显数值 ⇒ 视为整段成功', async () => {
  // O-17/M-1 纪元的注入桩恒返 '4\n'（无标记行）：批处理不得误判为失败
  const ps = fakePs();
  ps.setRespond(() => '4\n');
  const a = new WindowsAdapter({ probe: () => true, exec: ps.exec });
  const outcomes = await a.undoBatch([{ kind: 'set_contrast', before: { theme: '4' } }]);
  assert.deepEqual(outcomes, [{ ok: true }], '无标记 ⇒ 不虚构失败（兼容面零回归）');
});

test('NOW25-batch: 单条 undo 走批编译器 —— 1 次 PS 往返 + 精确归位语句', async () => {
  const ps = fakePs();
  const a = new WindowsAdapter({ probe: () => true, exec: ps.exec });
  await a.undo({ kind: 'move_window', titleHint: 'A', before: { x: 11, y: 22, width: 300, height: 200, maximized: true } });
  assert.equal(ps.scripts.length, 1, '单条 = 单步批 = 1 次往返（旧路径最多 4 次）');
  const s = ps.scripts[0];
  assert.ok(s.includes('SetForegroundWindow') && s.includes('ShowWindowAsync($h, 3)') && s.includes('SetWindowPos'),
    '查找→置前→还原窗口态→精确归位四步合并进单脚本');
  assert.ok(s.includes('11, 22, 300, 200, 4'), '几何快照精确归位（有尺寸 ⇒ flags=0x4）');
});

test('NOW25-batch: 无几何快照 ⇒ 诚实降级（仅还原窗口态，不拼垃圾几何）', async () => {
  const ps = fakePs();
  const a = new WindowsAdapter({ probe: () => true, exec: ps.exec });
  await a.undo({ kind: 'maximize_window', titleHint: 'A' });
  const s = ps.scripts[0];
  assert.ok(s.includes('ShowWindowAsync($h, 1)'), '降级 = 还原窗口态');
  assert.ok(!s.includes('::SetWindowPos('), '无快照不归位（与旧单条路径同律；声明面不算调用）');
});

// ─── ΝΩ-25(a)：Shaper.restoreAll 整条 LIFO 序列单次往返 ───

beforeEach(() => {
  shaper.clearUndoLog();
  shaper.configure(false, false);
});

afterEach(() => {
  shaper.clearUndoLog();
  shaper.configure(false, false);
  (shaper as unknown as { caps: ReadonlySet<ShaperActionKind> }).caps = new Set();
});

test('NOW25-restoreAll: 两条窗口账目 ⇒ 复原仅 1 次 PS 往返（批处理落地 shaper 层）', async () => {
  const ps = fakePs();
  const adapter = new WindowsAdapter({ probe: () => true, exec: ps.exec });
  shaper.setAdapterForTest(adapter);
  (shaper as unknown as { caps: ReadonlySet<ShaperActionKind> }).caps =
    new Set(['raise_window', 'maximize_window', 'move_window'] as ShaperActionKind[]);
  const r1 = await shaper.apply({ kind: 'move_window', titleHint: 'Notepad-A', x: 10, y: 20 });
  const r2 = await shaper.apply({ kind: 'maximize_window', titleHint: 'Editor-B' });
  assert.ok(r1.ok && r2.ok, '两条 apply 成功入账');
  assert.equal(shaper.undoDepth(), 2);
  const afterApplies = ps.scripts.length;
  const results = await shaper.restoreAll();
  assert.equal(ps.scripts.length, afterApplies + 1, `restoreAll 只新增 1 次 PS 往返（实际 +${ps.scripts.length - afterApplies}）`);
  assert.deepEqual(results.map(r => r.ok), [true, true], 'LIFO 序两条全成');
  assert.equal(shaper.undoDepth(), 0, '账目清零');
  const batch = ps.scripts[ps.scripts.length - 1];
  // 批脚本纪律：EncodedCommand 通道 + Add-Type 单次编译 + 双步标记
  assert.equal((batch.match(/Add-Type -Name U32\b/g) ?? []).length, 1, 'Add-Type 只编译一次');
  assert.ok(batch.includes("'R0|OK'") && batch.includes("'R1|OK'"), '两步各带完成标记');
  assert.ok(batch.indexOf("'Editor-B'") < batch.indexOf("'Notepad-A'"), 'LIFO：后做的（maximize B）先还原');
});

test('NOW25-restoreAll: 批内单步失败 ⇒ 账本记因存留（undo_log 可见 PENDING + 原因）', async () => {
  const ps = fakePs();
  // 仅批脚本（ErrorActionPreference 开头）注入失败标记；apply 阶段照常应答
  ps.setRespond(script => script.includes("$ErrorActionPreference = 'Stop'")
    ? 'R0|OK\nR1|ERR|window vanished\n'
    : (script.includes('MainWindowHandle') ? '4242||W\n' : 'True\n'));
  const adapter = new WindowsAdapter({ probe: () => true, exec: ps.exec });
  shaper.setAdapterForTest(adapter);
  (shaper as unknown as { caps: ReadonlySet<ShaperActionKind> }).caps =
    new Set(['raise_window', 'maximize_window', 'move_window'] as ShaperActionKind[]);
  await shaper.apply({ kind: 'move_window', titleHint: 'A', x: 1, y: 2 });
  await shaper.apply({ kind: 'maximize_window', titleHint: 'B' });
  const results = await shaper.restoreAll();
  assert.deepEqual(results.map(r => r.ok), [true, false], 'R0 成、R1 败（信封逐条）');
  assert.equal(results[1].reason, 'window vanished');
  assert.equal(shaper.undoDepth(), 1, '失败条目存留复原义务');
  const log = shaper.dumpUndoLog();
  assert.equal(log.find(r => !r.undone)?.undoFailureReason, 'window vanished', '失败原因入账本');
});

// ─── ΝΩ-25(b)：apply 路径的往返合并（每窗口操作数百 ms 的直接减负） ───

test('NOW25-apply: raise_window 单次往返（查找+置前合并）；move_window 预解析+变异合并', async () => {
  const ps = fakePs();
  const a = new WindowsAdapter({ probe: () => true, exec: ps.exec });
  await a.apply({ kind: 'raise_window', titleHint: 'Terminal' });
  assert.equal(ps.scripts.length, 1, 'raise：查找+置前一个脚本（旧路径 2 次冷启动）');
  assert.ok(ps.scripts[0].includes('MainWindowHandle') && ps.scripts[0].includes('SetForegroundWindow'),
    '查找与置前同脚本（同批单冷启动）');
  ps.scripts.length = 0;
  const recipe = await a.apply({ kind: 'move_window', titleHint: 'Terminal', x: 5, y: 6 });
  assert.equal(ps.scripts.length, 4, 'move：预解析 1 + 几何 2 + 变异 1（旧路径 5 次）');
  assert.ok(ps.scripts[3].includes('SetForegroundWindow') && ps.scripts[3].includes('SetWindowPos'),
    '置前与移动合并为单次变异往返');
  assert.deepEqual(recipe.before, { x: 10, y: 20, width: 300, height: 200, maximized: false }, '几何快照语义零回归');
});

// ─── ΝΩ-25 之二：system.switchWindowByTitle 的错误 kind 路由 ───

/** 注入假 backend adapter 的 switchWindow 应答（经 _setAdapterForTests 官方测试缝） */
function fakeSwitchWindow(switchWindow: unknown): void {
  backend._setAdapterForTests({ switchWindow } as never);
}

test('NOW25-kind: unwrapK 出口 —— PhysicalBackendError 携带 kind，消息方言逐字节保持', async () => {
  fakeSwitchWindow(async () => ({ ok: false, error: { kind: 'transport_error', detail: 'connect ECONNREFUSED 127.0.0.1:8421' } }));
  try {
    await assert.rejects(backend.switchWindow('kw'), (e: unknown) => {
      assert.ok(e instanceof PhysicalBackendError, '结构化错误类型');
      assert.equal((e as PhysicalBackendError).kind, 'transport_error', 'kind 通道透传');
      assert.equal((e as Error).message, '[physicalBackend] switch_window failed: transport_error: connect ECONNREFUSED 127.0.0.1:8421',
        '消息文本与既有 unwrap 方言一致（零回归）');
      return true;
    });
  } finally {
    backend._setAdapterForTests(null);
  }
});

test('NOW25-kind: 正例 —— kind=window_unavailable ⇒ 委托接管', async () => {
  fakeSwitchWindow(async () => ({ ok: false, error: { kind: 'window_unavailable', detail: 'pygetwindow not installed' } }));
  system.setWindowDelegate(async kw => ({ matched: `delegated:${kw}` }));
  try {
    const r = await system.switchWindowByTitle('chrome');
    assert.deepEqual(r, { method: 'delegate', matched: 'delegated:chrome' }, '缺席 ⇒ 委托通道');
  } finally {
    system.setWindowDelegate(null);
    backend._setAdapterForTests(null);
  }
});

test('NOW25-kind: 反例 —— kind=element_not_found 且消息埋 ECONNREFUSED 钓饵 ⇒ 仍上抛（kind 优先于消息）', async () => {
  // 旧实现按消息正则路由：这条会被误判缺席并静默改道委托。结构化路由后，
  // kind 在场 ⇒ 消息文本不再参与判定 —— 错误方言变更不再改道控制流。
  fakeSwitchWindow(async () => ({ ok: false, error: { kind: 'element_not_found', detail: 'no window; available: [a, b] (ECONNREFUSED bait)' } }));
  system.setWindowDelegate(async () => ({ matched: 'should-not-happen' }));
  try {
    await assert.rejects(system.switchWindowByTitle('ghost'), (e: unknown) => {
      assert.equal((e as PhysicalBackendError).kind, 'element_not_found', '真实未命中如实上抛');
      return true;
    });
  } finally {
    system.setWindowDelegate(null);
    backend._setAdapterForTests(null);
  }
});

test('NOW25-kind: 反例 —— kind=internal_error ⇒ 上抛（不在缺席清单）', async () => {
  fakeSwitchWindow(async () => ({ ok: false, error: { kind: 'internal_error', detail: 'boom' } }));
  system.setWindowDelegate(async () => ({ matched: 'should-not-happen' }));
  try {
    await assert.rejects(system.switchWindowByTitle('x'), (e: unknown) =>
      (e as PhysicalBackendError).kind === 'internal_error');
  } finally {
    system.setWindowDelegate(null);
    backend._setAdapterForTests(null);
  }
});

test('NOW25-kind: 兜底正例 —— 无 kind 的外来 Error 消息含 ECONNREFUSED ⇒ 委托接管', async () => {
  fakeSwitchWindow(async () => { throw new Error('fetch GET /switch_window failed: ECONNREFUSED 127.0.0.1:1'); });
  system.setWindowDelegate(async () => ({ matched: 'fallback-delegate' }));
  try {
    const r = await system.switchWindowByTitle('x');
    assert.equal(r.method, 'delegate', '无 kind ⇒ 消息正则兜底（旧方言零回归）');
  } finally {
    system.setWindowDelegate(null);
    backend._setAdapterForTests(null);
  }
});

test('NOW25-kind: 兜底反例 —— 无 kind 的普通 Error ⇒ 上抛', async () => {
  fakeSwitchWindow(async () => { throw new Error('totally unknown failure'); });
  system.setWindowDelegate(async () => ({ matched: 'should-not-happen' }));
  try {
    await assert.rejects(system.switchWindowByTitle('x'), /totally unknown failure/);
  } finally {
    system.setWindowDelegate(null);
    backend._setAdapterForTests(null);
  }
});

// ─── ΝΩ-25 之三：ensureBackend 候选端口并行探活（假 HTTP 服务） ───

const KEY_ENV = 'DSH_PHYSICAL_KEY_PATH';
let keyDir: string | null = null;

function tempKeyPath(): string {
  keyDir = mkdtempSync(join(tmpdir(), 'now25-key-'));
  return join(keyDir, 'physical.key');
}

/** 假物理服务：/v1/health 与 /v1/cursor 按 success 信封应答（鉴权头不校验 —— 只测探活/收养路由） */
function fakePhysicalSvc(opts: { healthDelayMs?: number } = {}) {
  const hits = { health: 0, cursor: 0 };
  const server = httpCreateServer((req, res) => {
    const respond = () => {
      if (req.url === '/v1/health') {
        hits.health++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          status: 'success',
          latency_ms: 1,
          data: {
            status: 'ok', version: '0.4.0', platform: process.platform, python: 'fake-py',
            screen: { width: 640, height: 480 }, capabilities: [],
            switch_window_method: 'native',
            ui_funnel: { l1_tree: 'available', l2_ocr: 'available', l3_vlm: '', l3_arbitration_enabled: false },
            screenshot_transport: 'base64', auth: { pid_attestation: false, capability_token: true },
          },
        }));
      } else if (req.url === '/v1/cursor') {
        hits.cursor++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', latency_ms: 1, data: { x: 1, y: 2 } }));
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
      }
    };
    if (opts.healthDelayMs && req.url === '/v1/health') setTimeout(respond, opts.healthDelayMs);
    else respond();
  });
  return { server, hits };
}

async function listen(server: HttpServer, port: number): Promise<void> {
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
}

async function closeHttp(server: HttpServer): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

/** 哑 socket：accept 后永不响应 —— 探活每次吃满 800ms 超时（串行墙的构成单元） */
function dumbListener() {
  const conns = new Set<Socket>();
  const server: NetServer = netCreateServer(sock => {
    conns.add(sock);
    sock.on('close', () => conns.delete(sock));
  });
  return {
    server,
    async close(): Promise<void> {
      for (const c of conns) c.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

/** 端口占用哨兵：任一目标端口已有响应者 ⇒ 外部占用，跳过（诚实不误报） */
async function portsFree(ports: number[]): Promise<boolean> {
  for (const p of ports) {
    if (await probeAlive(p)) return false;
  }
  return true;
}

afterEach(async () => {
  await backend.stopBackend();
  if (keyDir) { rmSync(keyDir, { recursive: true, force: true }); keyDir = null; }
  delete process.env[KEY_ENV];
});

test('NOW25-scan: 首活即取 —— 慢(400ms)/快(即时)两假服务，快者先证活先被收养', async () => {
  const P_SLOW = BASE_PORT, P_FAST = BASE_PORT + 1;
  if (!(await portsFree([P_SLOW, P_FAST]))) return; // 外部占用 ⇒ 跳过（哨兵语义）
  process.env[KEY_ENV] = tempKeyPath();
  const slow = fakePhysicalSvc({ healthDelayMs: 400 });
  const fast = fakePhysicalSvc();
  try {
    await listen(slow.server, P_SLOW);
    await listen(fast.server, P_FAST);
    await backend.ensureBackend();
    assert.equal(backend.healthSnapshot()?.version, '0.4.0', '收养成立（version 闸门 0.4.0 通过）');
    assert.ok(backend.healthSnapshot()?.screen && 'width' in (backend.healthSnapshot()!.screen as object),
      '收养回填 screen（getCursor 鉴权握手亦通过）');
    // 首活即取：快端口先给出活证据 ⇒ 收养落快端口（cursor 命中只在快者）
    assert.equal(fast.hits.cursor, 1, '快服务收到收养握手（health+cursor）');
    assert.equal(slow.hits.cursor, 0, '慢服务只被探活（health probe），未被收养');
    assert.ok(slow.hits.health >= 1, '慢服务的 health 探针在场（并行探活覆盖全候选）');
  } finally {
    await closeHttp(slow.server);
    await closeHttp(fast.server);
  }
});

test('NOW25-scan: 并行墙 —— 3 个哑 socket（各 800ms 探活超时）+ 第 4 口活服务，总耗时 ≪ 串行（≥2400ms）', async () => {
  const DUMB = [BASE_PORT, BASE_PORT + 1, BASE_PORT + 2];
  const P_ALIVE = BASE_PORT + 3;
  const needed = [...DUMB, P_ALIVE];
  if (!(await portsFree(needed))) return; // 外部占用 ⇒ 跳过
  process.env[KEY_ENV] = tempKeyPath();
  const dumb = [dumbListener(), dumbListener(), dumbListener()];
  const alive = fakePhysicalSvc();
  try {
    for (const [i, d] of dumb.entries()) {
      await new Promise<void>((resolve, reject) => {
        d.server.once('error', reject);
        d.server.listen(DUMB[i], '127.0.0.1', () => resolve());
      });
    }
    await listen(alive.server, P_ALIVE);
    const t0 = Date.now();
    await backend.ensureBackend();
    const elapsed = Date.now() - t0;
    assert.equal(backend.healthSnapshot()?.version, '0.4.0', '越过哑端口收养第 4 口活服务');
    assert.equal(alive.hits.cursor, 1, '收养握手落在活服务');
    // 串行语义：3×800ms 探活超时 + 收养 ≈ ≥2400ms；并行 cap 4 ⇒ 全候选同批探活
    assert.ok(elapsed < 2000, `并行探活总耗时 ${elapsed}ms（串行下界 2400ms）`);
  } finally {
    for (const d of dumb) await d.close();
    await closeHttp(alive.server);
  }
});
