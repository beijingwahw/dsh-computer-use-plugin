// test/epochSigma.display.test.ts
// 纪元 Σ-5（全军升维）：多显示器感知 —— take_screenshot 的 display 参数跨屏捕获。
//
// 战况三层：
//   ① Python 侧 compileall（screen.py / routes.py 多屏改动无语法/缩进错误）
//   ② 真端到端：spawn 真实 FastAPI 服务（探活失败 ⇒ 按仓库先例 skip 并如实注明
//      —— 先例：physicalExecution.adapter.http.test.ts 的 ensureServiceUp 闸）
//      /displays 结构断言、无 display ≡ display=主屏索引、region 归一化基准 =
//      所选显示器矩形、越界索引 ⇒ invalid_args 失败信封（HTTP 恒 200 的 400 语义）
//   ③ TS 纯逻辑：adapter 请求体透传（display 键缺省时缺席 —— 字节等同现状）、
//      physicalBackend CaptureOptions 透传（假 adapter 经 _setAdapterForTests 注入）、
//      take_screenshot 工具 schema 含 display、锚点 display 字段（假 system 注入）
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = pathResolve(dirname(fileURLToPath(import.meta.url)), '..');

// ─── ① Python 侧 compileall ───

test('Σ-5①: python -m compileall 通过（screen.py/routes.py 多屏改动无语法错误）', (t) => {
  const r = spawnSync('python', ['-m', 'compileall', '-q', join(repoRoot, 'python_service', 'dsh_physical')], {
    timeout: 60_000,
  });
  // python 不在场 = 环境信号非代码信号（与下方真服务段同律：探活失败 ⇒ skip）；
  // python 在场而 compileall 非零退出才是代码信号 ⇒ 响亮 fail
  if (r.error) {
    t.skip(`python not available (${r.error.message}) — environment signal, not a code signal`);
    return;
  }
  assert.equal(r.status, 0, `compileall 失败：${r.stderr?.toString().trim() ?? '(no stderr)'}`);
});

// ─── ② 真端到端：spawn 真实 Python 微服务 ───

interface PyService {
  proc: ChildProcess;
  port: number;
  keyPath: string;
  baseUrl: string;
  pyOut: string;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolve(p));
    });
  });
}

/** 起服务：随机空闲端口 + 一次性密钥 + base64 传输（免 mmap 文件）。
 *  探活 25s 失败 ⇒ 返回 null（调用方按仓库先例 skip，不判 fail —— 环境信号非代码信号）。 */
async function startPythonService(): Promise<PyService | null> {
  const port = await freePort();
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-sigma5-'));
  const keyPath = join(tmp, 'test.key');
  writeFileSync(keyPath, randomBytes(32));
  const proc = spawn('python', ['-m', 'dsh_physical'], {
    cwd: join(repoRoot, 'python_service'),
    env: {
      ...process.env,
      DSH_PHYSICAL_TRANSPORT: 'tcp',
      DSH_PHYSICAL_TCP_HOST: '127.0.0.1',
      DSH_PHYSICAL_TCP_PORT: String(port),
      DSH_PHYSICAL_KEY_PATH: keyPath,
      DSH_PHYSICAL_SHOT_TRANSPORT: 'base64',
      DSH_PHYSICAL_PID_ATTESTATION: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let pyOut = '';
  proc.stdout?.on('data', d => { pyOut += d; });
  proc.stderr?.on('data', d => { pyOut += d; });

  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return null; // 启动即退（缺依赖等）
    try {
      const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return { proc, port, keyPath, baseUrl, pyOut };
    } catch { /* 尚未就绪 */ }
    await new Promise(r => setTimeout(r, 250));
  }
  try { proc.kill(); } catch { /* noop */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  return null;
}

const svc = await startPythonService();

// 服务所在平台（/health 免鉴权）：越界 400 断言仅 Windows（其余平台按契约诚实降级主屏）
let svcPlatform = '';
if (svc) {
  try {
    const h: any = await (await fetch(`${svc.baseUrl}/health`, { signal: AbortSignal.timeout(2000) })).json();
    svcPlatform = String(h?.data?.platform ?? '');
  } catch { /* 探活刚过又挂了？E2E 测试自身会失败 */ }
}

const e2eSkip = !svc;
const maybeE2E = e2eSkip ? test.skip : test;
const skipNote = 'Python 物理微服务未能在本环境拉起（探活失败）—— 按仓库先例 skip 真端到端段';

if (svc) {
  after(() => {
    try { svc.proc.kill(); } catch { /* noop */ }
    try { rmSync(dirname(svc.keyPath), { recursive: true, force: true }); } catch { /* noop */ }
  });
}

test('Σ-5②(环境): Python 服务端到端段执行状态如实申报', () => {
  if (svc) {
    console.log(`[Σ-5] 真服务已起 http://127.0.0.1:${svc.port}/v1（platform=${svcPlatform || '?'}）—— E2E 段全量执行`);
  } else {
    console.log(`[Σ-5] ${skipNote}`);
  }
  assert.ok(true); // 申报性测试：永远通过，状态见 stdout
});

// 鉴权头：与 Python 端 auth 中间件同一 HMAC 契约（capToken.ts 铸 X-Cap-Token）
let keyBytes: Uint8Array | null = null;
async function authHeaders(): Promise<Record<string, string>> {
  if (!keyBytes) {
    const { ensureKey } = await import('../src/physicalExecution/capToken.ts');
    const { readFile } = await import('node:fs/promises');
    keyBytes = new Uint8Array(await readFile(svc!.keyPath));
    void ensureKey; // 密钥由本测试落盘（32B CSPRNG），直接读即同一契约
  }
  const { mintToken } = await import('../src/physicalExecution/capToken.ts');
  const { ALL_CAPS } = await import('../src/physicalExecution/index.ts');
  return {
    'Content-Type': 'application/json',
    'X-Cap-Token': mintToken(keyBytes, process.pid, ALL_CAPS, 60),
  };
}

async function svcPost(path: string, body: unknown): Promise<any> {
  const r = await fetch(`${svc!.baseUrl}${path}`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return await r.json();
}

async function svcGet(path: string): Promise<any> {
  const r = await fetch(`${svc!.baseUrl}${path}`, {
    headers: await authHeaders(),
    signal: AbortSignal.timeout(5000),
  });
  return await r.json();
}

let cachedDisplays: any[] | null = null;
async function displays(): Promise<any[]> {
  if (cachedDisplays) return cachedDisplays;
  const body = await svcGet('/displays');
  assert.equal(body.status, 'success', `/displays 必须成功：${JSON.stringify(body)}`);
  cachedDisplays = body.data.displays;
  return cachedDisplays!;
}

maybeE2E('Σ-5②a: /displays 返回结构（真机清单，全屏虚拟坐标系）', async () => {
  const ds = await displays();
  assert.ok(Array.isArray(ds) && ds.length >= 1, `至少一块显示器：${JSON.stringify(ds)}`);
  for (const d of ds) {
    assert.equal(typeof d.name, 'string', 'name: string');
    assert.equal(typeof d.x, 'number', 'x: number（虚拟坐标，副屏可为负）');
    assert.equal(typeof d.y, 'number', 'y: number');
    assert.ok(Number.isFinite(d.width) && d.width > 0, 'width > 0');
    assert.ok(Number.isFinite(d.height) && d.height > 0, 'height > 0');
    assert.equal(typeof d.primary, 'boolean', 'primary: boolean');
  }
  if (svcPlatform === 'win32') {
    assert.equal(ds.filter((d: any) => d.primary).length, 1, 'Windows：恰好一块主屏');
  }
  console.log(`[Σ-5] 真机显示器清单（${ds.length} 块）：${JSON.stringify(ds)}`);
});

maybeE2E('Σ-5②b: 无 display ≡ display=主屏索引；extras.display 仅在请求时在场（兼容铁律）', async () => {
  const ds = await displays();
  const primaryIdx = Math.max(0, ds.findIndex((d: any) => d.primary));

  const none = await svcPost('/take_screenshot', { format: 'png' });
  assert.equal(none.status, 'success', `无 display 截屏必须成功：${JSON.stringify(none).slice(0, 300)}`);
  // 兼容铁律：无 display 请求的响应不得引入 display 键（extras 字节不变）
  assert.ok(!('display' in none.data), '无 display ⇒ data 无 display 键（响应字节与 Σ-5 前等同）');

  const withPrimary = await svcPost('/take_screenshot', { format: 'png', display: primaryIdx });
  assert.equal(withPrimary.status, 'success');
  assert.strictEqual(withPrimary.data.display, primaryIdx, '请求 display ⇒ extras.display 回填实际使用的索引');

  // 等价性：无 display（主屏直拍）与显式主屏索引（全屏虚拟图裁剪）同一矩形。
  // 注：DPI 缩放环境下 /displays 报逻辑像素（本机 1920x1080@125% 报 1536x864），
  // 捕获图是物理像素 —— 服务端按包围盒比例映射对齐，故等价性以捕获尺寸互证。
  assert.equal(none.data.width, withPrimary.data.width,
    `宽度等价：${none.data.width} vs ${withPrimary.data.width}`);
  assert.equal(none.data.height, withPrimary.data.height,
    `高度等价：${none.data.height} vs ${withPrimary.data.height}`);
});

maybeE2E('Σ-5②c: display 选定后 region 归一化基准 = 所选显示器矩形（而非主屏）', async () => {
  // 参考尺寸 = 该显示器整幅捕获（捕获域自证，免疫 /displays 的逻辑像素域差异）
  const full = await svcPost('/take_screenshot', { format: 'png', display: 0 });
  assert.equal(full.status, 'success', JSON.stringify(full).slice(0, 300));
  const r = await svcPost('/take_screenshot', {
    format: 'png', display: 0,
    region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
  });
  assert.equal(r.status, 'success', JSON.stringify(r).slice(0, 300));
  const expectW = full.data.width / 2;
  const expectH = full.data.height / 2;
  assert.ok(Math.abs(r.data.width - expectW) <= 2,
    `region 半宽 ⇒ ${r.data.width} ≈ ${expectW}（显示器 0 整幅 ${full.data.width} 的基准）`);
  assert.ok(Math.abs(r.data.height - expectH) <= 2, `region 半高 ⇒ ${r.data.height} ≈ ${expectH}`);
});

maybeE2E('Σ-5②d: display 越界/负索引 ⇒ invalid_args 失败信封（HTTP 恒 200 的 400 语义）',
  { skip: svcPlatform === 'win32' ? false : '非 Windows 平台 display 按契约诚实降级主屏（非 400）—— 仅 Windows 断言越界' },
  async () => {
    const ds = await displays();
    const bad = await svcPost('/take_screenshot', { format: 'png', display: ds.length + 5 });
    assert.equal(bad.status, 'failure', `越界索引必须失败信封：${JSON.stringify(bad).slice(0, 300)}`);
    assert.equal(bad.error.kind, 'invalid_args', `kind=invalid_args（实际 ${bad.error.kind}）`);
    assert.match(String(bad.error.detail), /display index/);

    const neg = await svcPost('/take_screenshot', { format: 'png', display: -1 });
    assert.equal(neg.status, 'failure');
    assert.equal(neg.error.kind, 'invalid_args', '负索引同样拒绝（Python 负索引会从尾部取 —— 必须显式挡掉）');
  });

// ─── ③ TS 纯逻辑 ───

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

test('Σ-5③a: adapter.takeScreenshot display 透传 —— 有值随请求、缺省键缺席（字节等同现状）', async () => {
  const bodies: Array<{ path: string; body: any }> = [];
  const server: Server = await new Promise((resolve, reject) => {
    const s = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c; });
      req.on('end', () => {
        bodies.push({ path: req.url ?? '', body: raw ? JSON.parse(raw) : null });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', data: { transport: 'none' }, latency_ms: 1 }));
      });
    });
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;

  const { createPhysicalExecution } = await import('../src/physicalExecution/index.ts');
  // Σ-5：display 扩展参数面在 impl 类上（contracts 接口未含 —— 与 physicalBackend
  // 同式断言到 PhysicalExecutionAdapterImpl）
  const adapter = createPhysicalExecution({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    timeoutMs: 3000,
    enableAuth: false,
  } as never) as import('../src/physicalExecution/index.ts').PhysicalExecutionAdapterImpl;

  try {
    // 有值：display=3 ⇒ 请求体携带 display: 3
    let r = await adapter.takeScreenshot({ display: 3 });
    assert.ok(r.ok, '假服务必须成功');
    assert.equal(bodies[bodies.length - 1].path, '/v1/take_screenshot');
    assert.strictEqual(bodies[bodies.length - 1].body.display, 3, 'display=3 随请求透传');

    // 零值合法：display=0 ⇒ 透传 0（不是 falsy 丢包）
    r = await adapter.takeScreenshot({ display: 0 });
    assert.ok(r.ok);
    assert.strictEqual(bodies[bodies.length - 1].body.display, 0, 'display=0 必须透传 0（!== undefined）');

    // 缺省：键缺席 —— JSON 序列化丢弃 undefined ⇒ 请求字节与 Σ-5 前等同
    r = await adapter.takeScreenshot();
    assert.ok(r.ok);
    assert.ok(!('display' in bodies[bodies.length - 1].body), '缺省 ⇒ display 键缺席（现状字节等同）');
    assert.ok(!('display' in bodies[bodies.length - 1].body) && bodies[bodies.length - 1].body.format === 'png',
      '其余字段照旧');
  } finally {
    await closeServer(server);
  }
});

test('Σ-5③b: physicalBackend.captureProcessed —— CaptureOptions.display 透传 + ProcessedCapture.display 回填', async () => {
  const backend = await import('../src/physicalBackend.ts');
  // 1x1 PNG（合法图像字节 —— readShm base64 路径直接解码）
  const png1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const calls: any[] = [];
  const fakeAdapter = {
    takeScreenshot: async (args?: any) => {
      calls.push(args);
      return {
        ok: true as const,
        value: {
          transport: 'base64', name: '', size: png1x1.length,
          shape: [1, 1, 3] as [number, number, number], dtype: 'uint8', stride: 3,
          format: 'PNG', width: 1, height: 1, captured_at: Date.now() / 1000,
          image_base64: png1x1.toString('base64'),
          dhash: null, phash: null, region_dhash: null,
          unchanged: false, frame_id: null, frame_count: 0,
          ...(args?.display !== undefined ? { display: args.display } : {}),
        },
      };
    },
  };
  backend._setAdapterForTests(fakeAdapter as never);
  try {
    const r1 = await backend.captureProcessed({ format: 'png', display: 2 });
    assert.equal(calls.length, 1);
    assert.strictEqual(calls[0].display, 2, 'CaptureOptions.display=2 透传到 adapter.takeScreenshot');
    assert.strictEqual(r1.display, 2, 'ProcessedCapture.display 回填实际索引');
    assert.ok(r1.buffer?.equals(png1x1), 'base64 读取路径不受影响');

    // display=0：透传 0（零值不得被吞）
    const r0 = await backend.captureProcessed({ format: 'png', display: 0 });
    assert.strictEqual(calls[1].display, 0);
    assert.strictEqual(r0.display, 0);

    // 缺省：透传 undefined + 回填 null（= 主屏现状）
    const r2 = await backend.captureProcessed({ format: 'png' });
    assert.strictEqual(calls[2].display, undefined, '缺省 ⇒ undefined 透传（JSON 序丢键）');
    assert.strictEqual(r2.display, null, '缺省 ⇒ ProcessedCapture.display = null');
  } finally {
    backend._setAdapterForTests(null);
  }
});

test('Σ-5③c: take_screenshot 工具 —— schema 含 display；锚点 display/active_display 联动（假 system 注入）', async () => {
  const { createTakeScreenshotTool } = await import('../src/tools/takeScreenshot.ts');
  const { system } = await import('../src/system.ts');
  const makeConfig = (over: Record<string, unknown> = {}): any => ({
    compressWidth: 1440, jpegQuality: 75, gridDivisions: 10,
    maxImageCount: 9, maxContextImageKb: 4096,
    enableElementIdMode: false, enableQuantumSense: false,
    enableOcr: false, popupKeywords: '', ocrLang: 'eng',
    stableScreenDistance: 3,
    ...over,
  });

  const tool: any = createTakeScreenshotTool(makeConfig());

  // ── schema：display 参数入伍，既有参数不倒退 ──
  const props = tool.parameters?.properties ?? {};
  assert.equal(props.display?.type, 'number', '工具参数 schema 含 display: number');
  assert.match(String(props.display?.description ?? ''), /0-based/i, '描述注明 0 起索引');
  assert.match(String(props.display?.description ?? ''), /[Pp]rimary/, '描述注明缺省主屏');
  assert.ok(props.region && props.force, '既有参数（region/force）不倒退');

  // ── 假 system 注入（system 是可变对象字面量 —— 恢复器还原原样）──
  const FAKE_DISPLAYS = [
    { name: 'Primary', x: 0, y: 0, width: 1920, height: 1080 },
    { name: 'Monitor@1920,0', x: 1920, y: 0, width: 2560, height: 1440 },
  ];
  const { default: sharp } = await import('sharp');
  const tinyJpeg = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 128, g: 128, b: 128 } },
  }).jpeg().toBuffer();

  const capCalls: any[] = [];
  const fakeCapture = (opts: any) => {
    const w = opts.display === 1 ? 2560 : 1920;
    const h = opts.display === 1 ? 1440 : 1080;
    return {
      buffer: tinyJpeg, width: w, height: h,
      dhash: '0011223344556677', phash: null, regionDhash: null,
      unchanged: false,
      frameId: null, // null ⇒ detectPopup 走 sharp 缓冲路径，不触后端 frameStats
      transport: 'base64', salience: null,
      display: typeof opts.display === 'number' ? opts.display : null,
    };
  };
  const saved: Record<string, unknown> = {};
  const patch = (over: Record<string, unknown>) => {
    for (const key of Object.keys(over)) {
      saved[key] = (system as unknown as Record<string, unknown>)[key];
      (system as unknown as Record<string, unknown>)[key] = over[key];
    }
    return () => {
      for (const key of Object.keys(over)) {
        (system as unknown as Record<string, unknown>)[key] = saved[key];
      }
    };
  };
  const restore = patch({
    getActiveDisplay: async () => FAKE_DISPLAYS[0],
    getMousePosition: async () => ({ x: 960, y: 540 }), // 鼠标在主屏（display 0）
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    getAllDisplays: async () => FAKE_DISPLAYS,
    captureScreenWithOverlay: async (opts: any) => { capCalls.push(opts); return fakeCapture(opts); },
  });

  try {
    // display=1：跨屏 —— display 透传、锚点切屏、准星省画（鼠标不在目标屏）
    const v1 = JSON.parse(String(await tool.execute({ display: 1 }, undefined)));
    assert.equal(v1.status, 'SUCCESS');
    assert.strictEqual(v1.state_anchor.display, 1, '锚点 display = 实际使用的索引');
    assert.equal(v1.state_anchor.active_display.name, 'Monitor@1920,0', 'active_display 切到目标屏');
    assert.equal(v1.state_anchor.active_display.resolution, '2560x1440');
    assert.deepEqual(v1.state_anchor.active_display.origin, { x: 1920, y: 0 }, 'origin = 目标屏虚拟坐标（换算契约）');
    assert.strictEqual(capCalls[capCalls.length - 1].display, 1, 'display 透传到 captureScreenWithOverlay');
    assert.strictEqual(capCalls[capCalls.length - 1].crosshair, undefined, '鼠标不在目标屏 ⇒ 准星省画（不伪造）');
    assert.match(v1.state_anchor.overlay_legend.join('\n'), /No crosshair/, '图例如实申报准星缺席');

    // display=0：鼠标在目标屏 ⇒ 准星相对该屏 (0.5, 0.5)
    const v0 = JSON.parse(String(await tool.execute({ display: 0 }, undefined)));
    assert.equal(v0.status, 'SUCCESS');
    assert.strictEqual(v0.state_anchor.display, 0);
    const ch = capCalls[capCalls.length - 1].crosshair;
    assert.ok(ch && Math.abs(ch.x - 0.5) < 1e-9 && Math.abs(ch.y - 0.5) < 1e-9,
      `准星换算到所选显示器域：(960-0)/1920=0.5（实际 ${JSON.stringify(ch)}）`);

    // 无 display：现状 —— 锚点无 display 键（字节兼容）、准星主屏域
    const vn = JSON.parse(String(await tool.execute({}, undefined)));
    assert.equal(vn.status, 'SUCCESS');
    assert.ok(!('display' in vn.state_anchor), '无 display 参数 ⇒ 锚点不含 display 键（现状字节不变）');
    assert.strictEqual(capCalls[capCalls.length - 1].display, undefined, 'captureScreenWithOverlay 不收 display');
    assert.equal(vn.state_anchor.active_display.name, 'Primary', 'active_display = 鼠标所在屏（现状语义）');

    // 越界索引：快速失败（服务端也有 400 深拍 —— 见 Σ-5②d）
    const bad = String(await tool.execute({ display: 5 }, undefined));
    assert.match(bad, /\[Error\]: Invalid display index 5/);
    assert.match(bad, /0\.\.1/);

    // 非整数索引：拒绝
    const bad2 = String(await tool.execute({ display: 1.5 }, undefined));
    assert.match(bad2, /Invalid display index/);
  } finally {
    restore();
  }
});
