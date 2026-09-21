// test/realWorldWinHarness.ts
// 真机世界 harness（Windows 孪生）—— O 纪元（#1）真机基准的「真实」侧：
//   屏幕   = 真实桌面（服务 health 报尺寸 —— 归一化坐标系的事实源）
//   应用   = tkinter Record Cleaner（test/fixtures/realWorldWin.py —— topmost 置顶）
//   感知   = D-5 服务真截屏（mmap-file PNG）→ tesseract.js OCR（行级元素）
//   执行   = D-5 服务 /v1/click（真 pyautogui —— 真鼠标、真光标、真事件）
//   裁决   = 世界状态文件（绝无 mock hitElement —— 世界自己说话）
// 与 Linux 版（realWorldHarness.ts）同构：'delete item' 陷阱 + 'clear log' 活路。
// 零侵入红线：本文件只经适配器端口注入真实源，不碰 pipeline 内部。
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AtomicAction, ExecutionResult, ScenePatch } from '../src/knowledge/contracts.ts';
import { resolvePythonBin } from '../src/physicalExecution/pythonBin.ts';
import { dispatchElementsToGrid } from '../src/knowledge/stations.ts';
import { createPhysicalExecution } from '../src/physicalExecution/index.ts';

const APP = join(import.meta.dirname, 'fixtures', 'realWorldWin.py');

// 服务环境（与 adapter e2e 测试同律 —— 服务必须已在 8421 活着）
const BASE_URL = process.env.DSH_PHYSICAL_BASE_URL ?? 'http://127.0.0.1:8421/v1';
const KEY_PATH = process.env.DSH_PHYSICAL_KEY_PATH ?? '';

export interface RealWorldWin {
  readonly statePath: string;
  readonly screenWidth: number;
  readonly screenHeight: number;
  reset(): Promise<void>;
  state(): { clicks: Array<{ button: string }>; done: boolean };
  dispose(): Promise<void>;
}

export async function startRealWorldWin(): Promise<RealWorldWin> {
  const dir = mkdtempSync(join(tmpdir(), 'd7-real-win-'));
  const statePath = join(dir, 'state.json');
  let app: ChildProcess | null = null;

  // 服务探活 + 屏幕尺寸事实源
  const health = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(3000) });
  if (!health.ok) throw new Error('D-5 physical service not reachable — start it before the Windows bench');
  const screen = ((await health.json() as any).data?.screen) ?? { width: 2560, height: 1440 };

  function killApp(): void {
    if (!app) return;
    try { spawn('taskkill', ['/F', '/T', '/PID', String(app.pid)], { stdio: 'ignore' }); } catch { /* dead */ }
    try { app.kill(); } catch { /* dead */ }
    app.unref();
    app = null;
  }

  async function reset(): Promise<void> {
    if (app) {
      killApp();
      await new Promise(r => setTimeout(r, 250));
    }
    try { rmSync(statePath); } catch { /* not exist */ }
    app = spawn(resolvePythonBin(), [APP, statePath], { stdio: 'ignore', detached: true });
    for (let i = 0; i < 60; i++) {
      if (existsSync(statePath)) {
        try { JSON.parse(readFileSync(statePath, 'utf8')); break; } catch { /* 写一半 */ }
      }
      await new Promise(r => setTimeout(r, 100));
    }
    if (!existsSync(statePath)) throw new Error('real world (win) app failed to start (no state file)');
    // 窗口映射 + topmost 生效的物理等待（Win32 与 X11 同竞态，多等一拍）
    await new Promise(r => setTimeout(r, 500));
  }

  await reset();
  return {
    statePath,
    screenWidth: screen.width,
    screenHeight: screen.height,
    reset,
    state() {
      try {
        return JSON.parse(readFileSync(statePath, 'utf8'));
      } catch {
        return { clicks: [], done: false };
      }
    },
    async dispose() {
      killApp();
    },
  };
}

// ─── 真机感知源（服务截屏 → OCR → 网格分区）───

interface TessLine { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }
interface OcrWorker {
  recognize(img: Buffer, langs?: string, opts?: object): Promise<{ data: { blocks?: any[] } }>;
  terminate(): Promise<void>;
}

let workerPromise: Promise<OcrWorker> | null = null;

async function getWorker(): Promise<OcrWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const tesseract = await import('tesseract.js');
      // 离线语言包：仓根 eng.traineddata（langPath 指仓根 —— 零网络下载）
      const langPath = join(import.meta.dirname, '..');
      const createWorker = (tesseract as any).createWorker as
        (l?: string, oem?: number, opts?: Record<string, unknown>) => Promise<OcrWorker>;
      return await createWorker('eng', 1, { langPath });
    })();
  }
  return workerPromise;
}

export async function disposeOcrWin(): Promise<void> {
  if (workerPromise) {
    try { (await workerPromise).terminate(); } catch { /* already dead */ }
    workerPromise = null;
  }
}

/** 世界窗口区域截屏（服务全屏截屏 → sharp 裁 800×600 左上窗区 —— 世界在 +0+0） */
export async function captureWorldRegion(world: RealWorldWin): Promise<Buffer> {
  const adapter = createPhysicalExecution({
    baseUrl: BASE_URL, timeoutMs: 10_000, keyPath: KEY_PATH,
    tokenTtlSeconds: 60, enableAuth: true,
  } as never);
  await adapter.init();
  try {
    const r = await adapter.takeScreenshotHandle({ format: 'png' });
    if (!r.ok) throw new Error(`service screenshot failed: ${r.error.detail}`);
    const full = await r.value.read();
    await r.value.release();
    const { default: sharp } = await import('sharp');
    return await sharp(full)
      .extract({ left: 0, top: 0, width: Math.min(800, world.screenWidth), height: Math.min(600, world.screenHeight) })
      .png().toBuffer();
  } finally {
    (adapter as any).dispose?.();
  }
}

/** OCR 行级提取（相邻词合并成行 —— 按钮文字 'delete item' 是一个 UI 元素） */
export async function ocrLines(png: Buffer): Promise<TessLine[]> {
  const worker = await getWorker();
  const { data } = await worker.recognize(png, 'eng', { blocks: true, text: false });
  const lines: TessLine[] = [];
  for (const b of data.blocks ?? []) {
    for (const p of b.paragraphs ?? []) {
      for (const l of p.lines ?? []) {
        const words: Array<{ text: string; bbox: TessLine['bbox'] }> = l.words ?? [];
        if (words.length === 0) continue;
        const text = words.map(w => w.text).join(' ').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const bbox = {
          x0: Math.min(...words.map(w => w.bbox.x0)),
          y0: Math.min(...words.map(w => w.bbox.y0)),
          x1: Math.max(...words.map(w => w.bbox.x1)),
          y1: Math.max(...words.map(w => w.bbox.y1)),
        };
        lines.push({ text, bbox });
      }
    }
  }
  return lines;
}

/** 世界窗内坐标 → 全屏归一化（世界窗 800×600 锚在屏幕 +0+0） */
const WIN_W = 800, WIN_H = 600;

/** 真机视觉工位源（Windows）：服务截屏 → 裁世界窗 → OCR → 归一化 → 网格分派 */
export function createRealVisionStationWin(world: RealWorldWin) {
  return {
    async perceive(env: any): Promise<ScenePatch[]> {
      const png = await captureWorldRegion(world);
      const lines = await ocrLines(png);
      // Windows 装饰带过滤：标题栏行（"§ Record Cleaner - X"）不是可操作元素，
      // 但反射弧会按词面匹配到它（意图 "record" vs 标题 "Record Cleaner"）——
      // Linux Xvfb 截屏无此行（无装饰），Windows 孪生必须剥掉。几何判据：
      // 标题栏区 ≈ 顶 45px；词面判据兜底（§ 前缀 / 窗口铭牌行）。
      const actionLines = lines.filter(l =>
        l.bbox.y1 > 45 &&
        !/^[§▪•]/.test(l.text) &&
        !/record\s*cleaner|cleanup\s*utility\s*-?\s*x$/i.test(l.text));
      const els = actionLines.map(l => ({
        role: 'text',
        name: l.text.slice(0, 40),
        rect: {
          x: l.bbox.x0 / WIN_W,
          y: l.bbox.y0 / WIN_H,
          width: (l.bbox.x1 - l.bbox.x0) / WIN_W,
          height: (l.bbox.y1 - l.bbox.y0) / WIN_H,
        },
      }));
      if (els.length === 0) {
        throw new Error(`real vision (win): OCR found no elements (png=${png.length}B — window not mapped?)`);
      }
      // 归一化域与世界窗一致：网格分派后执行站以同域换算回屏幕像素
      return dispatchElementsToGrid(els, { cols: env?.payload?.grid?.cols ?? 2, rows: env?.payload?.grid?.rows ?? 2 }, 'L2', 'L2-ocr');
    },
  };
}

/** 真机执行工位（Windows）：D-5 服务 /v1/click = 真 pyautogui 真鼠标 */
export function createRealExecutionStationWin(world: RealWorldWin) {
  const adapter = createPhysicalExecution({
    baseUrl: BASE_URL, timeoutMs: 10_000, keyPath: KEY_PATH,
    tokenTtlSeconds: 60, enableAuth: true,
  } as never);
  let inited = false;
  return {
    async execute(env: any): Promise<ExecutionResult> {
      const action = env.payload as AtomicAction;
      const before = world.state().clicks.length;
      const t0 = Date.now();
      if (action.kind === 'click_mouse' && typeof action.args?.x === 'number' && typeof action.args?.y === 'number') {
        if (!inited) { await adapter.init(); inited = true; }
        // 归一化（世界窗域）→ 世界窗像素 → 屏幕像素（世界窗锚在 +0+0）
        const px = action.args.x * WIN_W;
        const py = action.args.y * WIN_H;
        const r = await adapter.clickMouse({
          x: px / world.screenWidth, y: py / world.screenHeight, button: 'left',
        });
        if (!r.ok) {
          return { action, status: 'failure', durationMs: Date.now() - t0,
            failure: { kind: 'host-error', detail: `service click failed: ${r.error.detail}` } };
        }
        // 等待应用回调入账（Win32 事件 → tkinter command → 状态文件原子写）
        for (let i = 0; i < 30; i++) {
          await new Promise(r2 => setTimeout(r2, 50));
          const clicks = world.state().clicks;
          if (clicks.length > before) {
            const hit = clicks[clicks.length - 1].button;
            if (hit === 'clear log') {
              return { action, status: 'success', durationMs: Date.now() - t0 };
            }
            return {
              action, status: 'failure', durationMs: Date.now() - t0,
              failure: { kind: 'host-error', detail: `real world: '${hit}' button is broken` },
            };
          }
        }
        return {
          action, status: 'failure', durationMs: Date.now() - t0,
          failure: { kind: 'host-error', detail: 'real world: click hit no element (ocr bbox drift / window not foreground)' },
        };
      }
      return {
        action, status: 'failure', durationMs: Date.now() - t0,
        failure: { kind: 'host-error', detail: `real world (win): action kind '${action.kind}' outside bench vocabulary` },
      };
    },
    async dispose() { (adapter as any).dispose?.(); },
  };
}

/** 平台闸：仅在 win32 + 活服务 + pyautogui 就绪时放行 */
export async function windowsRealMachineGate(): Promise<{ ok: boolean; reason: string }> {
  if (process.platform !== 'win32') return { ok: false, reason: `platform=${process.platform} (Windows-only twin)` };
  try {
    const resp = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!resp.ok) return { ok: false, reason: 'D-5 service not reachable on :8421' };
  } catch (e: any) {
    return { ok: false, reason: `D-5 service unreachable: ${e.message}` };
  }
  return { ok: true, reason: 'win32 + live D-5 service' };
}

export { execFileSync };
