// test/w4mobile.test.ts
// W4-5（L1 移动 Surface）：scrcpy/ADB 设备入列虚拟显示器 —— 离线契约测试。
//
// 世界级标准的三面战况：
//   ① Python 侧 compileall（android.py / routes.py / screen.py / server.py /
//      config.py 无语法错误）
//   ② Python 离线契约：stub runner 注入 AndroidController（真机/adb 大概率
//      缺席 —— 一切外部子进程调用经 runner 桩，零真进程）—— surface id 方言、
//      设备清单 + 真机缺席诚实降级、归一化 [0,1]² → 设备像素换算、长按=时长
//      阈值 / swipe=drag、ASCII 文本契约、帧源降级链（scrcpy → adb screencap）、
//      ScreenCapture surface 管线的 dhash 变化门控复用（帧未变不重复编码投递）
//      与 extras.surface 回显。PIL/numpy 缺席 ⇒ 按仓库先例 skip 并如实注明。
//   ③ TS 纯逻辑：假 HTTP 层断言 adapter 请求体的 surface 键透传（缺省键缺席 =
//      字节等同现状）、physicalBackend 的 CaptureOptions/clickMouse surface
//      透传与归一化坐标原样传递（换算只发生在服务端 —— 契约不破）、
//      listSurfaces 能力申报合并、帧门控 unchanged 分支。
//   ④ 真端到端（spawn 真实 FastAPI 服务；探活失败 ⇒ 按仓库先例 skip）：
//      /v1/devices 形状 + 诚实 degraded、android surface 截图对缺席设备的
//      失败信封、无 surface 请求的响应字节不引入新键（兼容铁律）、
//      host:0 dry-run 点击路由成功。
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

// ─── ① Python 侧 compileall ───

test('W4-5①: python -m compileall 通过（android.py 等五文件无语法错误）', (t) => {
  const r = spawnSync('python', ['-m', 'compileall', '-q', join(pyRoot, 'dsh_physical')], {
    timeout: 60_000,
  });
  if (r.error) {
    t.skip(`python not available (${r.error.message}) — environment signal, not a code signal`);
    return;
  }
  assert.equal(r.status, 0, `compileall 失败：${r.stderr?.toString().trim() ?? '(no stderr)'}`);
});

// ─── ② Python 离线契约（stub runner 注入 —— 零真子进程）───

const PY_CONTRACT = String.raw`
import io
import sys

try:
    from PIL import Image
    import numpy  # noqa: F401
except Exception as e:  # noqa: BLE001
    print(f"SKIP: PIL/numpy unavailable: {e}")
    sys.exit(3)

from dsh_physical.android import AndroidController, format_surface_id, parse_surface_id
from dsh_physical.config import AndroidConfig, ScreenshotConfig
from dsh_physical.errors import ErrorKind, PhysicalError
from dsh_physical.screen import ScreenCapture

fails: list = []


def check(name: str, cond, detail: str = "") -> None:
    if cond:
        print(f"  ok  {name}")
    else:
        fails.append(name)
        print(f"FAIL  {name} :: {detail}")


def expect_err(name: str, fn, kind, match=None) -> None:
    try:
        fn()
    except PhysicalError as e:
        ok = e.kind == kind and (match is None or match in e.detail)
        check(name, ok, f"got kind={e.kind} detail={e.detail!r}")
    except Exception as e:  # noqa: BLE001
        check(name, False, f"unexpected {type(e).__name__}: {e}")
    else:
        check(name, False, "no PhysicalError raised")


# ── 1. surface id 方言（host:<i> / android:<serial>）──
check("parse host:0", parse_surface_id("host:0") == ("host", 0))
check("parse host:12", parse_surface_id("host:12") == ("host", 12))
check("parse android serial", parse_surface_id("android:emulator-5554") == ("android", "emulator-5554"))
check("format inverse", format_surface_id(*parse_surface_id("android:ZX1G22")) == "android:ZX1G22")
expect_err("reject host:x", lambda: parse_surface_id("host:x"), ErrorKind.INVALID_ARGS)
expect_err("reject host:-1 (python negative-index trap)", lambda: parse_surface_id("host:-1"), ErrorKind.INVALID_ARGS)
expect_err("reject empty serial", lambda: parse_surface_id("android:"), ErrorKind.INVALID_ARGS)
expect_err("reject unknown kind", lambda: parse_surface_id("web:1"), ErrorKind.INVALID_ARGS)
expect_err("reject garbage", lambda: parse_surface_id("host0"), ErrorKind.INVALID_ARGS)

# ── 2. stub runner（外部世界唯一出口 —— 全部子进程经此注入）──
png_buf = io.BytesIO()
Image.new("RGB", (32, 48), (200, 30, 30)).save(png_buf, format="PNG")
PNG = png_buf.getvalue()

CALLS: list = []


def mk_runner(devices_rc=0,
              devices_out=b"List of devices attached\nemu1\tdevice\nemu2\toffline\n",
              wm_rc=0, wm_out=b"Physical size: 1080x1920\n",
              scrcpy_version=None, scrcpy_fail=False):
    def runner(argv, timeout_s=None, cwd=None):
        import pathlib

        CALLS.append(list(argv))
        a0 = argv[0]
        if a0 == "adb":
            if "devices" in argv:
                return (devices_rc, devices_out, b"")
            if "wm" in argv:
                return (wm_rc, wm_out, b"")
            if "screencap" in argv:
                return (0, PNG, b"")
            return (0, b"", b"")
        if a0 == "scrcpy":
            if "--version" in argv:
                if scrcpy_version is None:
                    return (127, b"", b"scrcpy: command not found")
                return (0, f"scrcpy {scrcpy_version}\n".encode(), b"")
            if "--screenshot" in argv:
                if scrcpy_fail:
                    return (1, b"", b"scrcpy boom")
                pathlib.Path(cwd, "screenshot_20261003_000000.png").write_bytes(PNG)
                return (0, b"", b"")
        return (1, b"", b"unexpected argv")
    return runner


cfg = AndroidConfig()
a = AndroidController(cfg, runner=mk_runner())

# ── 3. 设备清单 + 真机缺席诚实降级 ──
inv = a.list_devices()
check("inventory serials", [d["serial"] for d in inv["devices"]] == ["emu1", "emu2"])
d1 = inv["devices"][0]
check("online device state", d1["state"] == "device")
check("surface_id dialect", d1["surface_id"] == "android:emu1")
check("resolution from wm size", d1["resolution"] == {"width": 1080, "height": 1920})
check("offline device resolution None (honest)", inv["devices"][1]["resolution"] is None)
check("not degraded with adb", inv["degraded"] is False)

a_ovr = AndroidController(cfg, runner=mk_runner(wm_out=b"Physical size: 1080x1920\nOverride size: 720x1280\n"))
inv_ovr = a_ovr.list_devices()
check("override size preferred", inv_ovr["devices"][0]["resolution"] == {"width": 720, "height": 1280})

a_dead = AndroidController(cfg, runner=mk_runner(devices_rc=127))
inv_dead = a_dead.list_devices()
check("adb absent => empty + degraded + reason",
      inv_dead["devices"] == [] and inv_dead["degraded"] is True
      and "adb devices failed" in inv_dead.get("reason", ""))
check("cached_inventory readable", a_dead.cached_inventory() == inv_dead)

# ── 4. 归一化 [0,1]^2 -> 设备像素（契约不破：换算只在注入前最后一刻）──
CALLS.clear()
r = a.tap("emu1", 0.5, 0.5)
check("tap pixel (1080x1920 @ 0.5,0.5)", r["pixel"] == {"x": 540, "y": 960})
check("tap argv", CALLS[-1][5:] == ["tap", "540", "960"], f"got {CALLS[-1]}")
check("tap audit screen dims", r["screen"] == {"width": 1080, "height": 1920})
r_edge = a.tap("emu1", 1.0, 1.0)
check("edge clamp to w-1/h-1", r_edge["pixel"] == {"x": 1079, "y": 1919})
expect_err("oob coords rejected", lambda: a.tap("emu1", 1.5, 0.5), ErrorKind.OUT_OF_BOUNDS)
expect_err("middle button honest refusal", lambda: a.tap("emu1", 0.5, 0.5, "middle"), ErrorKind.INVALID_ARGS)
a.tap("emu1", 0.25, 0.75, "right")
check("right click => long-press stationary swipe",
      CALLS[-1][6:] == ["270", "1440", "270", "1440", str(cfg.long_press_threshold_ms)],
      f"got {CALLS[-1]}")

# ── 5. drag=swipe + 按压时长；长按=时长阈值 ──
r_drag = a.drag("emu1", {"x": 0.5, "y": 0.5}, {"x": 0.5, "y": 0.5})
check("stationary drag => long_press mode",
      r_drag["mode"] == "long_press" and r_drag["duration_ms"] >= cfg.long_press_threshold_ms)
check("stationary argv", CALLS[-1][6:] == ["540", "960", "540", "960", str(r_drag["duration_ms"])])
r_mv = a.drag("emu1", {"x": 0.1, "y": 0.2}, {"x": 0.9, "y": 0.8})
check("moving drag => swipe mode", r_mv["mode"] == "swipe")
check("moving argv pixels", CALLS[-1][6:11] == ["108", "384", "972", "1536", str(cfg.swipe_duration_ms)],
      f"got {CALLS[-1]}")

# ── 6. 文本 / 按键 / 滚动 ──
r_txt = a.type_text("emu1", "hello world")
check("typed_chars", r_txt["typed_chars"] == 11)
check("space escaped to %s", CALLS[-1][-1] == "hello%sworld", f"got {CALLS[-1]}")
expect_err("non-ascii honest refusal", lambda: a.type_text("emu1", "\u4f60\u597d"), ErrorKind.INVALID_ARGS)
a.type_text("emu1", "abc", clear_first=True)
ke_calls = [c for c in CALLS if "keyevent" in c]
check("clear_first via backspace keyevents",
      len(ke_calls) == 1 and ke_calls[0][-1].split() == ["67"] * cfg.clear_first_backspaces,
      f"got {ke_calls}")
a.key("emu1", ["enter"])
check("enter => keyevent 66", CALLS[-1][-1] == "66")
expect_err("combo honest refusal", lambda: a.key("emu1", ["ctrl", "a"]), ErrorKind.UNKNOWN_KEY)
r_sc = a.scroll("emu1", "down", 2)
check("scroll pixels = amount * px_per_tick", r_sc["pixels"] == 2 * cfg.scroll_px_per_tick)
check("scroll down => upward gesture from center",
      CALLS[-1][6:10] == ["540", str(960 + r_sc["pixels"] // 2), "540", str(960 - r_sc["pixels"] // 2)],
      f"got {CALLS[-1]}")

# ── 7. 帧源降级链：scrcpy 优先 -> adb screencap 单帧 ──
CALLS.clear()
a4 = AndroidController(cfg, runner=mk_runner())  # scrcpy 缺席
img4, note4 = a4.grab_frame("emu1")
check("degraded frame bytes", img4.size == (32, 48))
check("degrade note mentions scrcpy+screencap", note4 is not None and "scrcpy" in note4 and "screencap" in note4)
check("adb screencap actually used", any("screencap" in c for c in CALLS))

a5 = AndroidController(cfg, runner=mk_runner(scrcpy_version="2.7"))
img5, note5 = a5.grab_frame("emu1")
check("scrcpy frame, no note", img5.size == (32, 48) and note5 is None)
check("scrcpy argv (--screenshot + --serial + --max-size)",
      any(c[0] == "scrcpy" and "--screenshot" in c and "--serial=emu1" in c
          and any(str(x).startswith("--max-size=") for x in c) for c in CALLS))

a6 = AndroidController(cfg, runner=mk_runner(scrcpy_version="2.7", scrcpy_fail=True))
img6, note6 = a6.grab_frame("emu1")
check("scrcpy runtime failure -> screencap degrade", img6.size == (32, 48) and note6 is not None and "degraded" in note6)

a7 = AndroidController(cfg, runner=mk_runner(scrcpy_version="1.25"))
img7, note7 = a7.grab_frame("emu1")
check("under-min-version scrcpy -> degrade (version named)", note7 is not None and "1.25" in note7)

# ── 8. ScreenCapture surface 管线：android 帧进同一管线 ⇒ dhash 门控复用 ──
import asyncio

frames = [Image.new("RGB", (64, 64), (10, 10, 10)), Image.new("RGB", (64, 64), (10, 10, 10))]
idx = {"i": 0}


def source(serial):
    i = idx["i"]
    idx["i"] += 1
    return frames[min(i, len(frames) - 1)], None


sc = ScreenCapture(ScreenshotConfig(transport="base64"), surface_source=source)


async def run_captures():
    h1, e1 = await sc.capture("png", want_hashes=True, surface="android:emu1")
    ref = e1["dhash"]
    h2, e2 = await sc.capture("png", want_hashes=True, surface="android:emu1",
                              gate={"dhash_ref": ref, "distance": 0})
    hm, em = await sc.capture("png", want_hashes=True, surface="android:emu1", meta_only=True)
    h3, e3 = await sc.capture("png", surface="android:emu1", keep_frame=True)
    return (h1, e1), (h2, e2), (hm, em), (h3, e3)


(h1, e1), (h2, e2), (hm, em), (h3, e3) = asyncio.run(run_captures())
check("first capture encodes (handle present)", h1 is not None)
check("extras.surface echo", e1.get("surface") == "android:emu1")
check("gate reuse: identical frame => unchanged, no handle",
      h2 is None and e2.get("unchanged") is True)
check("gate keeps surface metadata", e2.get("surface") == "android:emu1" and e2.get("dhash") == e1["dhash"])
check("meta_only: fingerprints without handle", hm is None and em.get("dhash") is not None)
check("keep_frame ring works for android frames", h3 is not None and e3.get("frame_id") is not None)

# 帧源未接线 => 诚实失败（绝不静默降级主机屏 —— 坐标基准污染）
sc2 = ScreenCapture(ScreenshotConfig(transport="base64"))
expect_err("unwired surface source honest failure",
           lambda: asyncio.run(sc2.capture("png", surface="android:emuX")),
           ErrorKind.SCREEN_CAPTURE_FAILED, "no frame source wired")
expect_err("malformed surface id at capture level",
           lambda: asyncio.run(sc.capture("png", surface="host:x")),
           ErrorKind.INVALID_ARGS)

if fails:
    print(f"PY_CONTRACT_FAILED: {len(fails)}: {fails}")
    sys.exit(1)
print("ALL_PY_CONTRACT_OK")
sys.exit(0)
`;

test('W4-5②: android.py 离线契约（stub runner 注入：方言/清单/归一化/长按/降级链/帧门控）', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-w45-py-'));
  const script = join(tmp, 'w4_contract.py');
  writeFileSync(script, PY_CONTRACT);
  try {
    const r = spawnSync('python', ['-X', 'utf8', script], {
      cwd: pyRoot,
      timeout: 120_000,
      encoding: 'buffer',
      // 按路径跑脚本时 sys.path[0] 是脚本所在临时目录而非 cwd —— 显式注入
      // python_service 使 dsh_physical 可导入（与 -m 形态的语义对齐）
      env: { ...process.env, PYTHONPATH: pyRoot },
    });
    if (r.error) {
      t.skip(`python not available (${r.error.message}) — environment signal, not a code signal`);
      return;
    }
    const out = `${r.stdout?.toString() ?? ''}${r.stderr?.toString() ?? ''}`;
    if (r.status === 3) {
      t.skip(`PIL/numpy unavailable — python 契约段按先例 skip：${out.trim().split('\n')[0] ?? out.trim().slice(0, 120)}`);
      return;
    }
    assert.equal(r.status, 0, `python 契约脚本失败（exit=${r.status}）：\n${out}`);
    assert.match(out, /ALL_PY_CONTRACT_OK/);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

// ─── ③ TS 纯逻辑 ───

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

test('W4-5③a: adapter 请求体 surface 键透传（缺省键缺席 = 字节等同现状）+ /v1/devices GET', async () => {
  const bodies: Array<{ method: string; path: string; body: any }> = [];
  const server: Server = await new Promise((resolve, reject) => {
    const s = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c; });
      req.on('end', () => {
        bodies.push({ method: req.method ?? '', path: req.url ?? '', body: raw ? JSON.parse(raw) : null });
        let data: unknown = { transport: 'none' };
        if (req.url === '/v1/devices') {
          data = {
            devices: [{ serial: 'emu1', state: 'device', surface_id: 'android:emu1', resolution: { width: 1080, height: 1920 } }],
            degraded: false,
          };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', data, latency_ms: 1 }));
      });
    });
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;

  const { createPhysicalExecution } = await import('../src/physicalExecution/index.ts');
  const adapter = createPhysicalExecution({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    timeoutMs: 3000,
    enableAuth: false,
  } as never) as import('../src/physicalExecution/index.ts').PhysicalExecutionAdapterImpl;

  try {
    // take_screenshot：surface 透传
    let r = await adapter.takeScreenshot({ surface: 'android:emu1' });
    assert.ok(r.ok, '假服务必须成功');
    assert.equal(bodies[bodies.length - 1].path, '/v1/take_screenshot');
    assert.strictEqual(bodies[bodies.length - 1].body.surface, 'android:emu1', 'surface 随请求透传');

    // surface 与 display 并存：两键都在（服务端 surface 获胜）
    r = await adapter.takeScreenshot({ surface: 'host:1', display: 0 });
    assert.ok(r.ok);
    assert.strictEqual(bodies[bodies.length - 1].body.surface, 'host:1');
    assert.strictEqual(bodies[bodies.length - 1].body.display, 0);

    // 缺省：键缺席 —— JSON 序列化丢 undefined ⇒ 请求字节与 W4-5 前等同
    r = await adapter.takeScreenshot();
    assert.ok(r.ok);
    assert.ok(!('surface' in bodies[bodies.length - 1].body), '缺省 ⇒ surface 键缺席（兼容铁律）');

    // click：surface + 归一化坐标原样（换算只在服务端）
    const c = await adapter.clickMouse({ x: 0.25, y: 0.75, surface: 'android:emu1' });
    assert.ok(c.ok);
    const clickBody = bodies[bodies.length - 1].body;
    assert.equal(bodies[bodies.length - 1].path, '/v1/click_mouse');
    assert.strictEqual(clickBody.surface, 'android:emu1');
    assert.strictEqual(clickBody.x, 0.25, 'x 归一化原样透传（不预换算 —— 契约不破）');
    assert.strictEqual(clickBody.y, 0.75, 'y 归一化原样透传');

    // type：surface 透传
    const tr = await adapter.typeText({ text: 'hi', surface: 'android:emu1' });
    assert.ok(tr.ok);
    assert.strictEqual(bodies[bodies.length - 1].path, '/v1/type_text');
    assert.strictEqual(bodies[bodies.length - 1].body.surface, 'android:emu1');

    // /v1/devices：GET + 信封解析
    const inv = await adapter.getDevices();
    assert.ok(inv.ok, 'getDevices 必须成功');
    assert.equal(bodies[bodies.length - 1].method, 'GET');
    assert.equal(bodies[bodies.length - 1].path, '/v1/devices');
    assert.equal(inv.value.devices.length, 1);
    assert.equal(inv.value.devices[0].surface_id, 'android:emu1');
    assert.equal(inv.value.degraded, false);
  } finally {
    await closeServer(server);
  }
});

test('W4-5③b: surface id 方言（TS 镜像 parse_surface_id）+ 构造器互逆', async () => {
  const pb = await import('../src/physicalBackend.ts');
  assert.deepEqual(pb.parseSurfaceId('host:0'), { kind: 'host', index: 0 });
  assert.deepEqual(pb.parseSurfaceId('host:12'), { kind: 'host', index: 12 });
  assert.deepEqual(pb.parseSurfaceId('android:emulator-5554'), { kind: 'android', serial: 'emulator-5554' });
  assert.equal(pb.hostSurface(2), 'host:2');
  assert.equal(pb.androidSurface('emu1'), 'android:emu1');
  assert.deepEqual(pb.parseSurfaceId(pb.androidSurface('emu1')), { kind: 'android', serial: 'emu1' });

  for (const bad of ['host:x', 'host:-1', 'android:', 'web:1', 'host0', '']) {
    assert.throws(() => pb.parseSurfaceId(bad), /invalid surface id/, `畸形 id 必须快速失败：${JSON.stringify(bad)}`);
  }
});

test('W4-5③c: physicalBackend —— surface 透传/回显、归一化原样、listSurfaces 合并、真机缺席诚实降级', async () => {
  const backend = await import('../src/physicalBackend.ts');
  const png1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const shotCalls: any[] = [];
  const clickCalls: any[] = [];
  const typeCalls: any[] = [];
  const fakeAdapter = {
    takeScreenshot: async (args?: any) => {
      shotCalls.push(args);
      return {
        ok: true as const,
        value: {
          transport: 'base64', name: '', size: png1x1.length,
          shape: [1, 1, 3] as [number, number, number], dtype: 'uint8', stride: 3,
          format: 'PNG', width: 1, height: 1, captured_at: Date.now() / 1000,
          image_base64: png1x1.toString('base64'),
          dhash: null, phash: null, region_dhash: null,
          unchanged: false, frame_id: null, frame_count: 0,
          ...(args?.surface !== undefined ? { surface: args.surface } : {}),
        },
      };
    },
    clickMouse: async (args: any) => {
      clickCalls.push(args);
      return { ok: true as const, value: { pixel: { x: 1, y: 1 }, screen: { width: 2, height: 2 } } };
    },
    typeText: async (args: any) => {
      typeCalls.push(args);
      return { ok: true as const, value: { typed_chars: args.text.length } };
    },
    getDisplays: async () => ({
      ok: true as const,
      value: {
        displays: [
          { name: 'Primary', x: 0, y: 0, width: 1920, height: 1080, primary: true },
          { name: 'Monitor@1920,0', x: 1920, y: 0, width: 2560, height: 1440 },
        ],
      },
    }),
    getDevices: async () => ({
      ok: true as const,
      value: {
        devices: [
          { serial: 'emu1', state: 'device', surface_id: 'android:emu1', resolution: { width: 1080, height: 1920 } },
        ],
        degraded: false,
      },
    }),
  };
  backend._setAdapterForTests(fakeAdapter as never);
  try {
    // 截图：CaptureOptions.surface 透传 + ProcessedCapture.surface 回填
    const r1 = await backend.captureProcessed({ format: 'png', surface: 'android:emu1' });
    assert.strictEqual(shotCalls[0].surface, 'android:emu1', 'surface 透传到 takeScreenshot');
    assert.strictEqual(r1.surface, 'android:emu1', 'ProcessedCapture.surface 回显');
    assert.ok(r1.buffer?.equals(png1x1), 'base64 读取路径不受影响');

    // 缺省：透传 undefined + 回填 null（兼容铁律）
    const r0 = await backend.captureProcessed({ format: 'png' });
    assert.strictEqual(shotCalls[1].surface, undefined);
    assert.strictEqual(r0.surface, null);

    // 点击：surface 透传 + 归一化坐标原样（换算只在服务端 —— 契约不破）
    await backend.clickMouse(0.5, 0.25, 'left', false, 'android:emu1');
    assert.strictEqual(clickCalls[0].surface, 'android:emu1');
    assert.strictEqual(clickCalls[0].x, 0.5, 'x ∈ [0,1] 原样（服务端按设备分辨率换算）');
    assert.strictEqual(clickCalls[0].y, 0.25);

    // 缺省 surface：undefined（不引入键）
    await backend.clickMouse(0.5, 0.5);
    assert.strictEqual(clickCalls[1].surface, undefined);

    // 打字：surface 透传
    const n = await backend.typeText('hi', false, false, 'android:emu1');
    assert.equal(n, 2);
    assert.strictEqual(typeCalls[0].surface, 'android:emu1');

    // listSurfaces：host 显示器 + android 设备统一入列
    const surfaces = await backend.listSurfaces();
    assert.deepEqual(surfaces.host, ['host:0', 'host:1'], '显示器索引 → host:<i>');
    assert.deepEqual(surfaces.android, ['android:emu1'], 'adb serial → android:<serial>');
    assert.equal(surfaces.degraded, false);

    // listMobileDevices：清单原样
    const inv = await backend.listMobileDevices();
    assert.equal(inv.devices[0].serial, 'emu1');
    assert.equal(inv.degraded, false);
  } finally {
    backend._setAdapterForTests(null);
  }

  // 真机/adb 缺席：degraded 诚实申报（空 android 面 + 原因随行）
  const degradedAdapter = {
    getDisplays: async () => ({
      ok: true as const,
      value: { displays: [{ name: 'Primary', x: 0, y: 0, width: 1920, height: 1080, primary: true }] },
    }),
    getDevices: async () => ({
      ok: true as const,
      value: { devices: [], degraded: true, reason: 'adb devices failed (rc=127): adb: command not found' },
    }),
  };
  backend._setAdapterForTests(degradedAdapter as never);
  try {
    const surfaces = await backend.listSurfaces();
    assert.deepEqual(surfaces.host, ['host:0']);
    assert.deepEqual(surfaces.android, [], '真机缺席 ⇒ android 面为空');
    assert.equal(surfaces.degraded, true, 'degraded 标记随行');
    assert.match(surfaces.reason ?? '', /rc=127/, '真实原因随行（不静默假装无设备）');
  } finally {
    backend._setAdapterForTests(null);
  }
});

test('W4-5③d: 帧门控复用 —— gate 命中 ⇒ unchanged、无图投递、surface 元数据保留', async () => {
  const backend = await import('../src/physicalBackend.ts');
  // 服务端语义的假实现：同 dhash 参考 ⇒ unchanged（android 帧与 host 帧同一管线）
  let dhash = '0011223344556677';
  const fakeAdapter = {
    takeScreenshot: async (args?: any) => {
      if (args?.gate && args.gate.dhashRef === dhash) {
        return {
          ok: true as const,
          value: {
            transport: 'none', name: '', size: 0, shape: [0, 0, 0], dtype: '', stride: 0,
            format: '', width: 64, height: 64, captured_at: Date.now() / 1000, image_base64: '',
            dhash, unchanged: true, surface: args.surface,
          },
        };
      }
      return {
        ok: true as const,
        value: {
          transport: 'base64', name: '', size: 1, shape: [1, 1, 3], dtype: 'uint8', stride: 3,
          format: 'PNG', width: 64, height: 64, captured_at: Date.now() / 1000,
          image_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          dhash, unchanged: false, surface: args?.surface,
        },
      };
    },
  };
  backend._setAdapterForTests(fakeAdapter as never);
  try {
    // 第一帧：建立参考
    const first = await backend.captureProcessed({ format: 'png', surface: 'android:emu1', wantHashes: true });
    assert.equal(first.unchanged, false);
    assert.ok(first.buffer, '首帧投递图像');

    // 第二帧（未变）：gate 命中 ⇒ 不重复编码投递
    const second = await backend.captureProcessed({
      format: 'png', surface: 'android:emu1',
      gate: { dhashRef: first.dhash!, distance: 0 },
    });
    assert.equal(second.unchanged, true, '帧未变 ⇒ unchanged');
    assert.equal(second.buffer, null, '帧未变 ⇒ 不投递图像字节（带宽门控）');
    assert.equal(second.dhash, dhash, '指纹随行（下轮 gate 参考）');
    assert.equal(second.surface, 'android:emu1', 'surface 元数据随行');
    assert.equal(second.width, 64, '分辨率元数据随行');
  } finally {
    backend._setAdapterForTests(null);
  }
});

// ─── ④ 真端到端：spawn 真实 Python 微服务（探活失败 ⇒ 先例 skip）───

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
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-w45-'));
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
      DSH_PHYSICAL_ANDROID_CMD_TIMEOUT_MS: '3000', // 真机缺席时 adb 探测快速失败
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

test('W4-5④(环境): 真服务端到端段执行状态如实申报', () => {
  if (svc) {
    console.log(`[W4-5] 真服务已起 http://127.0.0.1:${svc.port}/v1 —— E2E 段全量执行`);
  } else {
    console.log('[W4-5] Python 物理微服务未能在本环境拉起（探活失败）—— 按仓库先例 skip 真端到端段');
  }
  assert.ok(true); // 申报性测试：永远通过，状态见 stdout
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
      // W6-R-A3 nonce 强制：X-Request-Id 单次性防重放头 —— 服务端缺头即 401、
      // 同 nonce 重放即 401。每请求新鲜 randomUUID（本函数每请求各调一次 ⇒ 天然新鲜）。
      'X-Request-Id': randomUUID(),
    };
  }

  async function svcPost(path: string, body: unknown): Promise<any> {
    const r = await fetch(`${svc!.baseUrl}${path}`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    return await r.json();
  }

  async function svcGet(path: string): Promise<any> {
    const r = await fetch(`${svc!.baseUrl}${path}`, {
      headers: await authHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    return await r.json();
  }

  let devicesProbed = false;
  let devicesDegraded = false;

  maybeE2E('W4-5④a: /v1/devices —— 形状契约 + 真机缺席诚实降级（空清单 + degraded + 原因）', async () => {
    const body = await svcGet('/devices');
    assert.equal(body.status, 'success', `/v1/devices 必须成功：${JSON.stringify(body).slice(0, 300)}`);
    assert.ok(Array.isArray(body.data.devices), 'devices: array');
    for (const d of body.data.devices) {
      assert.equal(typeof d.serial, 'string', 'serial: string');
      assert.equal(typeof d.state, 'string', 'state: string');
      assert.match(d.surface_id, /^android:/, 'surface_id 方言 android:<serial>');
      assert.ok(d.resolution === null || (typeof d.resolution?.width === 'number' && typeof d.resolution?.height === 'number'),
        'resolution: {width,height} | null（缺席不编造）');
    }
    assert.equal(typeof body.data.degraded, 'boolean', 'degraded: boolean 必在场');
    devicesProbed = true;
    devicesDegraded = body.data.degraded;
    if (body.data.degraded) {
      assert.ok(typeof body.data.reason === 'string' && body.data.reason.length > 0,
        '真机缺席 ⇒ degraded=true + 真实原因随行（不静默）');
      console.log(`[W4-5] 本环境无移动真机（诚实降级）：${body.data.reason}`);
    } else {
      console.log(`[W4-5] 检出 ${body.data.devices.length} 台真机：${body.data.devices.map((d: any) => d.surface_id).join(', ')}`);
    }
  });

  maybeE2E('W4-5④b: android surface 对缺席设备 ⇒ screen_capture_failed 失败信封（HTTP 恒 200）', async () => {
    const body = await svcPost('/take_screenshot', { format: 'png', surface: 'android:no-such-device' });
    assert.equal(body.status, 'failure', `缺席设备必须失败信封：${JSON.stringify(body).slice(0, 300)}`);
    assert.equal(body.error.kind, 'screen_capture_failed', `kind=screen_capture_failed（实际 ${body.error.kind}）`);
  });

  maybeE2E('W4-5④c: 无 surface 请求 ⇒ 响应字节不引入新键（兼容铁律）', async () => {
    const body = await svcPost('/take_screenshot', { format: 'png' });
    assert.equal(body.status, 'success', `主机截屏必须照旧成功：${JSON.stringify(body).slice(0, 300)}`);
    assert.ok(!('surface' in body.data), '无 surface ⇒ data 无 surface 键（与 W4-5 前逐字节等同）');
  });

  maybeE2E('W4-5④d: 畸形 surface id ⇒ invalid_args；host:0 dry-run 点击路由成功并回显 surface', async () => {
    const bad = await svcPost('/click_mouse', { x: 0.5, y: 0.5, dry_run: true, surface: 'host:x' });
    assert.equal(bad.status, 'failure', '畸形 id 必须失败信封');
    assert.equal(bad.error.kind, 'invalid_args', `kind=invalid_args（实际 ${bad.error.kind}）`);
    assert.match(String(bad.error.detail), /surface/i);

    // host:0（主屏）dry-run：无物理副作用，surface 路由 + 回执回显
    const ok = await svcPost('/click_mouse', { x: 0.5, y: 0.5, dry_run: true, surface: 'host:0' });
    assert.equal(ok.status, 'success', `host:0 dry-run 必须成功：${JSON.stringify(ok).slice(0, 300)}`);
    assert.strictEqual(ok.data.surface, 'host:0', '动作回执回显 surface');
    assert.ok(ok.data.pixel && typeof ok.data.pixel.x === 'number', '回执含像素审计');

    // 越界 host 索引（Windows 枚举是事实源）：invalid_args
    const oob = await svcPost('/click_mouse', { x: 0.5, y: 0.5, dry_run: true, surface: 'host:99' });
    assert.equal(oob.status, 'failure', '越界 host 索引必须失败');
    assert.equal(oob.error.kind, 'invalid_args');

    // move_mouse 对 android surface ⇒ 诚实拒绝（触屏无悬停语义）
    const mv = await svcPost('/move_mouse', { x: 0.5, y: 0.5, dry_run: true, surface: 'android:any' });
    assert.equal(mv.status, 'failure', 'android 悬停必须拒绝');
    assert.equal(mv.error.kind, 'invalid_args');
    assert.match(String(mv.error.detail), /hover|unsupported/i);
  });

  maybeE2E('W4-5④e: /health surfaces 能力申报（host 显示器入列；android 报缓存态不阻塞探活）', async () => {
    const h = (await (await fetch(`${svc!.baseUrl}/health`, { signal: AbortSignal.timeout(5000) })).json()) as {
      status: string;
      data: { surfaces: { host: string[]; android: string[]; android_probed: boolean } };
    };
    assert.equal(h.status, 'success');
    const surfaces = h.data.surfaces;
    assert.ok(surfaces && Array.isArray(surfaces.host), 'surfaces.host: string[]（显示器索引泛化）');
    assert.ok(surfaces.host.length >= 1, '至少 host:0（主屏）');
    assert.match(surfaces.host[0], /^host:0$/);
    assert.ok(Array.isArray(surfaces.android), 'surfaces.android: string[]');
    assert.equal(typeof surfaces.android_probed, 'boolean', 'android_probed：缓存探测态如实申报');
    if (devicesProbed && devicesDegraded && surfaces.android_probed) {
      assert.deepEqual(surfaces.android, [], '真机缺席 ⇒ health 的 android 面如实为空');
    }
  });
}
