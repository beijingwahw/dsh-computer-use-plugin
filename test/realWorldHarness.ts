// test/realWorldHarness.ts
// 真机世界 harness —— D-7 基准的「真实」侧：
//   屏幕   = Xvfb :77（800x600）
//   应用   = tkinter Record Cleaner（test/fixtures/realWorld.py —— 陷阱/活路按钮）
//   感知   = import 截图 → tesseract.js OCR（行级元素）→ dispatchElementsToGrid
//   执行   = xdotool mousemove+click（真实 X11 事件）→ 应用回调真实触发
//   裁决   = 世界状态文件（绝无 mock hitElement —— 世界自己说话）
//
// 与 stub 世界（ablation.bench.ts）同构：'delete item' 陷阱 + 'clear log' 活路。
// 零侵入红线：本文件只经适配器端口注入真实源，不碰 pipeline 内部。
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AtomicAction, ExecutionResult, ScenePatch } from '../src/knowledge/contracts.ts';
import { dispatchElementsToGrid } from '../src/knowledge/stations.ts';

export const DISPLAY = ':77';
const SCREEN_W = 800;
const SCREEN_H = 600;
const APP = join(import.meta.dirname, 'fixtures', 'realWorld.py');

// ─── 真机世界进程管理 ───

export interface RealWorld {
  readonly statePath: string;
  /** 世界复位：杀旧进程 → 起新应用 → 等就绪（状态文件出现 started=true） */
  reset(): Promise<void>;
  /** 读世界真相（应用原子写的状态文件） */
  state(): { clicks: Array<{ button: string }>; done: boolean };
  /** 真实点击（像素坐标 —— 归一化→像素换算在执行端口） */
  click(px: number, py: number): void;
  dispose(): Promise<void>;
}

function sh(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { env: { ...process.env, DISPLAY }, stdio: 'ignore' });
}

export async function startRealWorld(): Promise<RealWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'd7-real-'));
  const statePath = join(dir, 'state.json');
  let app: ChildProcess | null = null;

  /** 杀进程（进程组）：tkinter mainloop 在 C 层阻塞 —— SIGTERM 的 python handler
   *  不执行，必须 SIGKILL；detached+负 pid 杀全组（shim→python 子孙无幸存），
   *  否则子进程句柄悬住，node 进程无法退出。 */
  function killApp(): void {
    if (!app) return;
    console.error(`[harness] killApp pid=${app.pid} pgid=${app.pid}`);
    try { process.kill(-app.pid!, 'SIGKILL'); } catch (e: any) { console.error(`[harness] group kill failed: ${e.message}`); }
    try { app.kill('SIGKILL'); } catch { /* already dead */ }
    app.unref();
    app = null;
  }

  async function reset(): Promise<void> {
    if (app) {
      killApp();
      await new Promise(r => setTimeout(r, 150));
    }
    // 状态文件必须清空：残留文件会让「等新世界就绪」立即假通过（窗口未 map 竞态）
    try { rmSync(statePath); } catch { /* not exist */ }
    app = spawn('python3', [APP, statePath], {
      env: { ...process.env, DISPLAY },
      stdio: 'ignore',
      detached: true, // 独立进程组（killApp 用 -pid 杀全组）
    });
    // 等待世界就绪：新状态文件出现（应用 persist() 首写 = Python 已活）
    for (let i = 0; i < 40; i++) {
      if (existsSync(statePath)) {
        try { JSON.parse(readFileSync(statePath, 'utf8')); break; } catch { /* 写一半 */ }
      }
      await new Promise(r => setTimeout(r, 100));
    }
    if (!existsSync(statePath)) throw new Error('real world app failed to start (no state file)');
    // persist() 先于 mainloop()：状态文件出现 ≠ 窗口已映射。
    // 多等一拍让 X server 完成 map —— 感知才不会截到 196B 黑屏。
    await new Promise(r => setTimeout(r, 300));
  }

  function state(): { clicks: Array<{ button: string }>; done: boolean } {
    try {
      return JSON.parse(readFileSync(statePath, 'utf8'));
    } catch {
      return { clicks: [], done: false };
    }
  }

  function click(px: number, py: number): void {
    sh('xdotool', ['mousemove', String(Math.round(px)), String(Math.round(py)), 'click', '1']);
  }

  await reset();
  return {
    statePath,
    reset,
    state,
    click,
    async dispose() {
      killApp();
    },
  };
}

// ─── 真机感知源（截图 → OCR → 网格分区）───

/** OCR 词级输出（tesseract.js v7：blocks → paragraphs → lines → words） */
interface TessLine { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }

/** OCR worker 形状（tesseract.js v7：blocks 输出在运行时存在但未进其类型定义 —— 防御性铸型） */
interface OcrWorker {
  recognize(img: Buffer, langs?: string, opts?: object): Promise<{ data: { blocks?: any[] } }>;
  terminate(): Promise<void>;
}

let workerPromise: Promise<OcrWorker> | null = null;

async function getWorker(): Promise<OcrWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      const w = await createWorker('eng');
      return w as unknown as OcrWorker;
    })();
  }
  return workerPromise;
}

/** 全局 OCR worker 生命周期清理（bench 结束时调用） */
export async function disposeOcr(): Promise<void> {
  if (workerPromise) {
    try { (await workerPromise).terminate(); } catch { /* already dead */ }
    workerPromise = null;
  }
}

/** 截屏（ImageMagick import → PNG Buffer —— 真实像素，非 mock） */
function captureScreen(): Buffer {
  return execFileSync('import', ['-window', 'root', 'png:-'], {
    env: { ...process.env, DISPLAY },
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** OCR 行级提取（相邻词合并成行 —— 按钮文字 'delete item' 是一个 UI 元素） */
async function ocrLines(png: Buffer): Promise<TessLine[]> {
  const worker = await getWorker();
  if (!worker) throw new Error('ocr worker unavailable');
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

/** 真机视觉工位源：截屏 → OCR 行元素 → 归一化 → 网格分派（'g{col}x{row}' 方言） */
export function createRealVisionStation() {
  return {
    async perceive(env: any): Promise<ScenePatch[]> {
      const png = captureScreen();
      const lines = await ocrLines(png);
      const els = lines.map(l => ({
        role: 'text',
        name: l.text.slice(0, 40),
        rect: {
          x: l.bbox.x0 / SCREEN_W,
          y: l.bbox.y0 / SCREEN_H,
          width: (l.bbox.x1 - l.bbox.x0) / SCREEN_W,
          height: (l.bbox.y1 - l.bbox.y0) / SCREEN_H,
        },
      }));
      if (els.length === 0) {
        throw new Error(`real vision: OCR found no elements (lines=${lines.length}, png=${png.length}B — window not mapped yet?)`);
      }
      const depth: 'L1' | 'L2' = 'L2'; // 真机纪元：像素→OCR = L2 通道（诚实层级）
      return dispatchElementsToGrid(els, env.payload.grid, depth, 'L2-ocr');
    },
  };
}

// ─── 真机执行端口（归一化坐标 → X11 真实点击 → 世界状态裁决）───

/**
 * 真机执行工位：click_mouse {x,y}（归一化）→ 屏幕像素 → xdotool 真实点击。
 * 成败裁决 = 世界状态文件（点击前后的 clicks 差集）：
 *   新 click 'clear log' ⇒ success（世界宣告任务达成）
 *   新 click 'delete item' ⇒ failure（按钮坏了 —— 世界不撒谎）
 *   无新 click ⇒ failure（没点中任何可交互元素）
 */
export function createRealExecutionStation(world: RealWorld) {
  return {
    async execute(env: any): Promise<ExecutionResult> {
      const action = env.payload as AtomicAction;
      const before = world.state().clicks.length;
      const t0 = Date.now();

      if (action.kind === 'click_mouse' && typeof action.args?.x === 'number' && typeof action.args?.y === 'number') {
        world.click(action.args.x * SCREEN_W, action.args.y * SCREEN_H);
        // 等待应用回调入账（X11 事件 → tkinter command → 状态文件原子写）
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 50));
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
          failure: { kind: 'host-error', detail: 'real world: click hit no element (ocr bbox drift)' },
        };
      }

      return {
        action, status: 'failure', durationMs: Date.now() - t0,
        failure: { kind: 'host-error', detail: `real world: unsupported action ${action.kind}` },
      };
    },
  };
}
