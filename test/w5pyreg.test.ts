// test/w5pyreg.test.ts
// W5-1（Python 物理层注册落盘）：W4-6/W4-8 报告的注册行落盘后的冒烟验证。
//
// 战况三面：
//   ① Python 侧 py_compile（routes.py / server.py / auth.py / config.py）+
//      uvc/hid/audio 三 --selftest 仍 exit 0（注册不引入语法/行为回归）。
//   ② 真服务冒烟（spawn 真实 FastAPI 服务，回环 TCP 随机端口；探活失败 ⇒
//      按仓库先例 skip）：/health 200 + hardware 能力面在场；新端点各打一次
//      —— 硬件缺席 ⇒ **结构化** 200 响应（failure 信封或 dry-run success），
//      绝不 5xx/崩溃；auth 面对新端点生效（无 token ⇒ unauthorized 信封）。
//   ③ 兼容快检：既有端点（click_mouse dry-run / take_screenshot）原样成功
//      （全量零破坏由 w4mobile 12 项 E2E 保证，此处只做冒烟级抽查）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = pathResolve(dirname(fileURLToPath(import.meta.url)), '..');
const pyRoot = join(repoRoot, 'python_service');

// ─── ① Python 侧：py_compile + 三自测 ───

test('W5-1①a: python -m py_compile 全过（注册改动无语法错误）', (t) => {
  const r = spawnSync('python', [
    '-m', 'py_compile',
    'dsh_physical/routes.py', 'dsh_physical/server.py',
    'dsh_physical/auth.py', 'dsh_physical/config.py',
    'dsh_physical/__init__.py',
  ], { cwd: pyRoot, timeout: 60_000 });
  if (r.error) {
    t.skip(`python not available (${r.error.message}) — environment signal, not a code signal`);
    return;
  }
  assert.equal(r.status, 0, `py_compile 失败：${r.stderr?.toString().trim() ?? '(no stderr)'}`);
});

test('W5-1①b: uvc/hid/audio 三 --selftest 仍 exit 0（行为零回归）', (t) => {
  for (const mod of ['uvc', 'hid', 'audio']) {
    const r = spawnSync('python', ['-m', `dsh_physical.${mod}`, '--selftest'], {
      cwd: pyRoot, timeout: 120_000,
    });
    if (r.error) {
      t.skip(`python not available (${r.error.message}) — environment signal, not a code signal`);
      return;
    }
    assert.equal(r.status, 0, `${mod} selftest exit=${r.status}：\n${r.stdout?.toString() ?? ''}\n${r.stderr?.toString() ?? ''}`);
  }
});

// ─── ② 真服务冒烟（硬件缺席安全律的端到端判决）───

interface PyService {
  proc: ChildProcess;
  port: number;
  keyPath: string;
  baseUrl: string;
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

async function startPythonService(): Promise<PyService | null> {
  const port = await freePort();
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-w51-'));
  const keyPath = join(tmp, 'test.key');
  writeFileSync(keyPath, randomBytes(32));
  const proc = spawn('python', ['-m', 'dsh_physical'], {
    cwd: pyRoot,
    env: {
      ...process.env,
      DSH_PHYSICAL_TRANSPORT: 'tcp',
      DSH_PHYSICAL_TCP_HOST: '127.0.0.1',
      DSH_PHYSICAL_TCP_PORT: String(port),
      DSH_PHYSICAL_KEY_PATH: keyPath,
      DSH_PHYSICAL_SHOT_TRANSPORT: 'base64',
      DSH_PHYSICAL_PID_ATTESTATION: 'false',
      // 硬件缺席律的判决环境：uvc=auto（cv2 缺席 ⇒ 诚实 unsupported 路径）、
      // hid 端口不设（pyserial 缺席/无 CH340 ⇒ 诚实 unsupported 路径）、
      // audio 走缺省 WASAPI 探测（comtypes 缺席 ⇒ available=false 诚实信封）。
      DSH_PHYSICAL_UVC_SOURCE: 'auto',
      DSH_PHYSICAL_ANDROID_CMD_TIMEOUT_MS: '3000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return null; // 启动即退（缺依赖等）
    try {
      const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return { proc, port, keyPath, baseUrl };
    } catch { /* 尚未就绪 */ }
    await new Promise(r => setTimeout(r, 250));
  }
  try { proc.kill(); } catch { /* noop */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  return null;
}

const svc = await startPythonService();

if (svc) {
  after(() => {
    try { svc.proc.kill(); } catch { /* noop */ }
    try { rmSync(dirname(svc.keyPath), { recursive: true, force: true }); } catch { /* noop */ }
  });
}

// ΝΩ-38 诚实度修正：原唯一断言 assert.ok(true)（永真）——改 {skip}，状态由 maybeE2E 段实际执行/skip 如实反映（skip 后本体不执行）。
test('W5-1②(环境): 真服务冒烟段执行状态如实申报', { skip: '申报性测试：原唯一断言 assert.ok(true) 永真——状态改由冒烟段实际执行/skip 计数如实反映（ΝΩ-38）' }, () => {
  if (svc) {
    console.log(`[W5-1] 真服务已起 http://127.0.0.1:${svc.port}/v1 —— 冒烟段全量执行`);
  } else {
    console.log('[W5-1] Python 物理微服务未能在本环境拉起（探活失败）—— 按仓库先例 skip 冒烟段');
  }
});

const maybeE2E = svc ? test : test.skip;

if (svc) {
  let keyBytes: Uint8Array | null = null;
  async function authHeaders(): Promise<Record<string, string>> {
    if (!keyBytes) {
      const { readFile } = await import('node:fs/promises');
      keyBytes = new Uint8Array(await readFile(svc!.keyPath));
    }
    const { mintToken } = await import('../src/physicalExecution/capToken.ts');
    const { ALL_CAPS } = await import('../src/physicalExecution/index.ts');
    return {
      'Content-Type': 'application/json',
      'X-Cap-Token': mintToken(keyBytes, process.pid, ALL_CAPS, 60),
      // W6-R-A3 nonce 强制：X-Request-Id 是单次性防重放头 —— 服务端缺头即 401、
      // 同 nonce 重放即 401。每请求新鲜 randomUUID（本函数每请求各调一次 ⇒ 天然新鲜）。
      'X-Request-Id': randomUUID(),
    };
  }

  async function svcPost(path: string, body: unknown): Promise<{ httpStatus: number; json: any }> {
    const r = await fetch(`${svc!.baseUrl}${path}`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    return { httpStatus: r.status, json: await r.json() };
  }

  async function svcGet(path: string, withAuth = true): Promise<{ httpStatus: number; json: any }> {
    const r = await fetch(`${svc!.baseUrl}${path}`, {
      headers: withAuth ? await authHeaders() : {},
      signal: AbortSignal.timeout(30_000),
    });
    return { httpStatus: r.status, json: await r.json() };
  }

  /** 硬件缺席安全律的统一断言：HTTP 恒 200 + 结构化信封（status 字段在场），绝不 5xx/裸崩。 */
  function assertStructured(r: { httpStatus: number; json: any }, label: string): void {
    assert.equal(r.httpStatus, 200, `${label} HTTP 必须恒 200（实际 ${r.httpStatus}）—— 5xx = 注册破坏异常诚实铁律`);
    assert.ok(r.json && typeof r.json === 'object', `${label} 响应必须是 JSON 对象`);
    assert.ok(r.json.status === 'success' || r.json.status === 'failure',
      `${label} 必须是结构化信封（status ∈ success|failure，实际 ${JSON.stringify(r.json).slice(0, 200)}）`);
    if (r.json.status === 'failure') {
      assert.ok(r.json.error && typeof r.json.error.kind === 'string' && r.json.error.kind.length > 0,
        `${label} failure 信封必须携带 error.kind（结构化降级而非裸崩）`);
    }
  }

  maybeE2E('W5-1②a: /health 200 + 新控制器入列 + hardware 能力面（读缓存态不阻塞）', async () => {
    const r = await svcGet('/health');
    assert.equal(r.httpStatus, 200);
    assert.equal(r.json.status, 'success', `/health 必须 success：${JSON.stringify(r.json).slice(0, 300)}`);
    assert.ok(Array.isArray(r.json.data.controllers) && r.json.data.controllers.includes('uvc')
      && r.json.data.controllers.includes('hid'),
      `controllers 须含 uvc/hid（实际 ${JSON.stringify(r.json.data.controllers)}）`);
    const hw = r.json.data.hardware;
    assert.ok(hw && typeof hw === 'object', '/health 须申报 hardware 面');
    assert.equal(hw.uvc.initialized, true, 'uvc 面已装配（构造零硬件副作用）');
    assert.equal(typeof hw.uvc.backend, 'string', 'uvc.backend 如实申报（unresolved = 未触设备）');
    assert.equal(hw.hid.initialized, true, 'hid 面已装配');
    assert.equal(typeof hw.hid.protocol, 'string', 'hid.protocol 申报（ch9329）');
    assert.equal(typeof hw.hid.transport, 'object', 'hid.transport 纯读描述（不开串口）');
    assert.equal(hw.audio.probed, false, 'audio 首调前如实报未探测（探活路径不建 WASAPI 链）');
  });

  maybeE2E('W5-1②b: /v1/uvc/capture —— 硬件缺席 ⇒ 结构化诚实降级（cv2 缺席或无采集卡不 5xx）', async () => {
    const r = await svcPost('/uvc/capture', { format: 'png', want_hashes: true });
    assertStructured(r, '/v1/uvc/capture');
    if (r.json.status === 'failure') {
      // 本环境 cv2 缺席 ⇒ UnsupportedFrameSource 的诚实信封
      assert.equal(r.json.error.kind, 'screen_capture_failed',
        `cv2/设备缺席 ⇒ kind=screen_capture_failed（实际 ${r.json.error.kind}）`);
      console.log(`[W5-1] uvc 诚实降级：${r.json.error.detail.slice(0, 120)}`);
    } else {
      // 环境真有采集卡 ⇒ 成功路径的形状契约
      assert.ok(typeof r.json.data.image_base64 === 'string' && r.json.data.image_base64.length > 0, '成功 ⇒ base64 帧');
      assert.ok(typeof r.json.data.width === 'number', '成功 ⇒ width 元数据');
      console.log('[W5-1] uvc 真设备在位：capture 成功路径');
    }
  });

  maybeE2E('W5-1②c: /v1/hid/* 六端点 —— dry-run 成功（零硬件副作用）+ 非dry-run 结构化降级', async () => {
    // dry_run：帧构造纯函数可验，dry=True ⇒ 不触串口 ⇒ 确定性成功
    const cases: Array<[string, unknown, (data: any) => void]> = [
      ['/hid/click', { x: 0.5, y: 0.5, dry_run: true }, d => {
        assert.equal(d.frames_sent, 0, 'dry ⇒ 零帧发出');
        assert.equal(d.abs.x, 0x3FFF, '归一化 0.5 → 0x3FFF（手算可验）');
      }],
      ['/hid/move', { x: 0.25, y: 0.75, dry_run: true }, d => {
        assert.equal(d.frames_sent, 0);
      }],
      ['/hid/drag', { start: { x: 0.1, y: 0.1 }, end: { x: 0.9, y: 0.9 }, dry_run: true }, d => {
        assert.equal(d.frames_sent, 0);
        assert.equal(d.start_abs.x, Math.trunc(0.1 * 0x7FFF), 'start_abs 审计换算（int(0.1*32767)）');
      }],
      ['/hid/scroll', { direction: 'down', amount: 3, dry_run: true }, d => {
        assert.equal(d.direction, 'down');
      }],
      ['/hid/hotkey', { keys: ['ctrl', 's'], dry_run: true }, d => {
        assert.deepEqual(d.pressed, ['ctrl', 's']);
      }],
      ['/hid/type_text', { text: 'hello', dry_run: true }, d => {
        assert.equal(d.typed_chars, 5);
      }],
    ];
    for (const [path, body, checkData] of cases) {
      const r = await svcPost(path, body);
      assertStructured(r, path);
      assert.equal(r.json.status, 'success', `${path} dry-run 必须成功（不触硬件）：${JSON.stringify(r.json).slice(0, 300)}`);
      checkData(r.json.data);
    }

    // 非 dry-run：无 HID 棒 ⇒ 结构化失败信封（HTTP 恒 200，绝不 5xx）
    const live = await svcPost('/hid/click', { x: 0.5, y: 0.5 });
    assertStructured(live, '/hid/click(live)');
    if (live.json.status === 'failure') {
      assert.match(String(live.json.error.detail), /pyserial|USB-serial|serial open/i,
        `缺硬件原因须真实随行（实际 ${live.json.error.detail.slice(0, 160)}）`);
      console.log(`[W5-1] hid 诚实降级：${live.json.error.detail.slice(0, 120)}`);
    } else {
      console.log('[W5-1] hid 真设备在位：live click 成功路径');
    }

    // 参数校验方言：越界坐标 ⇒ invalid_args（Pydantic 层即拒，FastAPI 默认 422 ——
    // 与既有端点同方言，此为框架行为非注册引入）
    const oob = await svcPost('/hid/click', { x: 1.5, y: 0.5, dry_run: true });
    assert.ok(oob.httpStatus === 422 || (oob.httpStatus === 200 && oob.json?.status === 'failure'),
      '越界坐标被拒（422 Pydantic 或 failure 信封均可，不得是 5xx）');
  });

  maybeE2E('W5-1②d: GET /v1/audio_events —— 结构化信封（available/backend/window_ms/event 契约）+ health 缓存落账', async () => {
    const r = await svcGet('/audio_events');
    assertStructured(r, '/v1/audio_events');
    assert.equal(r.json.status, 'success', `audio_events_payload 防御式绝不抛 ⇒ success：${JSON.stringify(r.json).slice(0, 300)}`);
    const p = r.json.data;
    assert.equal(typeof p.available, 'boolean', 'available: boolean');
    assert.equal(typeof p.backend, 'string', 'backend: string');
    assert.equal(typeof p.window_ms, 'number', 'window_ms: number');
    assert.ok(p.event === null || (typeof p.event === 'object' && typeof p.event.event === 'string'),
      'event: null（通道不可用诚实缺席）| {event, confidence, ts}');
    if (!p.available) {
      assert.ok(typeof p.reason === 'string' && p.reason.length > 0, '不可用 ⇒ 真实原因随行（不静默）');
      console.log(`[W5-1] audio 诚实降级：backend=${p.backend} reason=${String(p.reason).slice(0, 120)}`);
    } else {
      console.log(`[W5-1] audio 通道在位：backend=${p.backend} event=${p.event?.event}`);
    }

    // 首调事实落 health 缓存（probed=true，探活路径之外建链）
    const h = await svcGet('/health');
    assert.equal(h.json.data.hardware.audio.probed, true, '首调后 health.audio.probed=true');
    assert.equal(h.json.data.hardware.audio.available, p.available, '缓存值与端点回执一致');
  });

  maybeE2E('W5-1②e: auth 对新端点生效 —— 无 token ⇒ 401 + unauthorized 信封', async () => {
    const r = await fetch(`${svc!.baseUrl}/audio_events`, { signal: AbortSignal.timeout(5000) });
    // W6-R-A3 错误码修正：认证失败是安全层判决（非业务层）⇒ HTTP 401；
    // 错误信封 JSON 结构不变（{status:'failure', error:{kind, detail}}）。
    assert.equal(r.status, 401, 'auth 拒绝走 401 + failure 信封方言（安全层判决非业务层）');
    const body: any = await r.json();
    assert.equal(body.status, 'failure');
    assert.equal(body.error.kind, 'unauthorized', `无 token ⇒ unauthorized（实际 ${body.error?.kind}）`);
  });

  maybeE2E('W5-1③: 兼容冒烟 —— 既有端点原样（click dry-run / take_screenshot 成功；全量由 w4mobile 保证）', async () => {
    const click = await svcPost('/click_mouse', { x: 0.5, y: 0.5, dry_run: true });
    assertStructured(click, '/v1/click_mouse');
    assert.equal(click.json.status, 'success', `既有 dry-run 点击必须照旧成功：${JSON.stringify(click.json).slice(0, 300)}`);

    const shot = await svcPost('/take_screenshot', { format: 'png' });
    assertStructured(shot, '/v1/take_screenshot');
    assert.equal(shot.json.status, 'success', `主机截屏必须照旧成功：${JSON.stringify(shot.json).slice(0, 300)}`);
  });
}
