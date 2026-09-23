// test/complexWorldWinHarness.ts
// 复杂世界 harness（Windows）—— 大规模真机验证的「真实」侧：
//   屏幕   = 真实桌面（服务 health 报尺寸 —— 归一化坐标系的事实源）
//   应用   = tkinter Data Console（test/fixtures/complexWorldWin.py —— 5 页 × 6 控件）
//   感知   = D-5 服务真截屏（mmap-file PNG）→ tesseract.js OCR（行级元素）
//   执行   = D-5 服务 /v1/click（真 pyautogui —— 真鼠标、真光标、真事件）
//   裁决   = 世界状态文件（事件序号 / 页面 / 开关 / 陷阱标记 —— 世界自己说话）
// 与 realWorldWinHarness 同律（零侵入红线：只经适配器端口注入真实源），
// 差异只在世界更复杂：任务 = 「先导航后操作」的多步链，陷阱族跨 3 页分布。
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AtomicAction, ExecutionResult, ScenePatch } from '../src/knowledge/contracts.ts';
import { resolvePythonBin } from '../src/physicalExecution/pythonBin.ts';
import { dispatchElementsToGrid } from '../src/knowledge/stations.ts';
import { createPhysicalExecution } from '../src/physicalExecution/index.ts';

const APP = join(import.meta.dirname, 'fixtures', 'complexWorldWin.py');

// 服务环境（与 adapter e2e 测试同律 —— 服务必须已在 8421 活着）
const BASE_URL = process.env.DSH_PHYSICAL_BASE_URL ?? 'http://127.0.0.1:8421/v1';
const KEY_PATH = process.env.DSH_PHYSICAL_KEY_PATH ?? '';

/** 世界窗 800×600 锚在屏幕 +0+0（物理像素 —— 夹具已 DPI 感知） */
const WIN_W = 800, WIN_H = 600;

export interface WorldEvent {
  seq: number; widget: string; page: string; trap: boolean; at: number;
}

export interface ComplexWorldState {
  started: boolean; page: string; events: WorldEvent[]; toggles: Record<string, boolean>; seq: number;
  /** 笔迹纪元：可输入框内容（世界真相 —— 每次击键原子落盘） */
  entries: Record<string, string>;
  /** 当前聚焦的可输入框名（FocusIn 真相） */
  focus: string | null;
}

export interface ComplexWorldWin {
  readonly statePath: string;
  readonly screenWidth: number;
  readonly screenHeight: number;
  reset(): Promise<void>;
  state(): ComplexWorldState;
  dispose(): Promise<void>;
}

export async function startComplexWorldWin(): Promise<ComplexWorldWin> {
  const dir = mkdtempSync(join(tmpdir(), 'd7-complex-win-'));
  const statePath = join(dir, 'state.json');
  let app: ChildProcess | null = null;

  const health = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(3000) });
  if (!health.ok) throw new Error('D-5 physical service not reachable — start it before the large-scale bench');
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
    if (!existsSync(statePath)) throw new Error('complex world (win) app failed to start (no state file)');
    // 窗口映射 + topmost 生效的物理等待（与真机 W 基准同竞态律，多等一拍）
    await new Promise(r => setTimeout(r, 500));
  }

  await reset();
  return {
    statePath,
    screenWidth: screen.width,
    screenHeight: screen.height,
    reset,
    state(): ComplexWorldState {
      try {
        return JSON.parse(readFileSync(statePath, 'utf8'));
      } catch {
        return { started: false, page: '', events: [], toggles: {}, seq: 0, entries: {}, focus: null };
      }
    },
    async dispose() {
      killApp();
    },
  };
}

// ─── 真机感知源（服务截屏 → 裁世界窗 → OCR → 网格分区）───

function makeAdapter() {
  return createPhysicalExecution({
    baseUrl: BASE_URL, timeoutMs: 10_000, keyPath: KEY_PATH,
    tokenTtlSeconds: 60, enableAuth: true,
  } as never);
}

/** 世界窗口区域截屏（服务全屏截屏 → sharp 裁 800×600 左上窗区 —— 世界在 +0+0） */
export async function captureComplexWorld(world: ComplexWorldWin): Promise<Buffer> {
  const adapter = makeAdapter();
  await adapter.init();
  try {
    const r = await adapter.takeScreenshotHandle({ format: 'png' });
    if (!r.ok) throw new Error(`service screenshot failed: ${r.error.detail}`);
    const full = await r.value.read();
    await r.value.release();
    const { default: sharp } = await import('sharp');
    return await sharp(full)
      .extract({ left: 0, top: 0, width: Math.min(WIN_W, world.screenWidth), height: Math.min(WIN_H, world.screenHeight) })
      .png().toBuffer();
  } finally {
    (adapter as any).dispose?.();
  }
}

// ─── 词级 OCR 元素提取（行级合并的教训：跨列同基线词会被 tesseract 并行）───

interface TessWord { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }
interface OcrWorker {
  recognize(img: Buffer, langs?: string, opts?: object): Promise<{ data: { blocks?: any[] } }>;
  terminate(): Promise<void>;
}

let wordWorkerPromise: Promise<OcrWorker> | null = null;

async function getWordWorker(): Promise<OcrWorker> {
  if (!wordWorkerPromise) {
    wordWorkerPromise = (async () => {
      const tesseract = await import('tesseract.js');
      // 离线语言包：仓根 eng.traineddata（langPath 指仓根 —— 零网络下载）
      const langPath = join(import.meta.dirname, '..');
      const createWorker = (tesseract as any).createWorker as
        (l?: string, oem?: number, opts?: Record<string, unknown>) => Promise<OcrWorker>;
      return await createWorker('eng', 1, { langPath });
    })();
  }
  return wordWorkerPromise;
}

/** OCR worker 生命周期归零（bench 收尾义务 —— 不终止 ⇒ node 事件循环不退出） */
export async function disposeComplexOcr(): Promise<void> {
  if (wordWorkerPromise) {
    try { (await wordWorkerPromise).terminate(); } catch { /* already dead */ }
    wordWorkerPromise = null;
  }
}

/** 词级元素分组阈值：同一元素内词间距（px）。真实按钮标签词距 ≤15px；
 *  跨控件同基线词距 ≥80px（列布局空隙）——45px 居中分离两族。 */
const WORD_GROUP_GAP_PX = 45;

/** 导航条带宽度（导航按钮右缘 180px + 余量）—— 分条带识别的切分线 */
const NAV_STRIP_W = 200;

export interface OcrElement { name: string; bbox: { x0: number; y0: number; x1: number; y1: number } }

/** 最近一次感知的场景词表（失败明细的取证面 —— 感知缺席时看得见读了什么） */
let lastPerceivedNames: string[] = [];
export function getLastSceneNames(): string[] { return [...lastPerceivedNames]; }

/** 单条带词提取：裁剪 → 2× lanczos 等比放大 → 识别 → bbox 折回原域并平移条带原点。
 *  放大只指定宽度（高度等比）⇒ 实际比例 = 放大图宽 / 条带宽，折回用同一比例。 */
async function ocrStripWords(
  worker: OcrWorker, png: Buffer, left: number, width: number, scale: number,
): Promise<TessWord[]> {
  const { default: sharp } = await import('sharp');
  const H = (await sharp(png).metadata()).height ?? WIN_H;
  const big = await sharp(png)
    .extract({ left, top: 0, width, height: H })
    .resize({ width: width * scale, kernel: 'lanczos3' })
    .png().toBuffer();
  const { data } = await worker.recognize(big, 'eng', { blocks: true, text: false });
  const words: TessWord[] = [];
  for (const b of data.blocks ?? []) {
    for (const p of b.paragraphs ?? []) {
      for (const l of p.lines ?? []) {
        for (const w of l.words ?? []) {
          // 词面卫生：剥离首尾标点（按钮右缘的 ':' ';' 尾巴是 OCR 噪声）
          const text = String(w.text ?? '').trim().replace(/^[^a-z0-9]+/i, '').replace(/[^a-z0-9]+$/i, '');
          if (!/[a-z0-9]/i.test(text)) continue; // 纯符号噪声（边框浮雕字形）
          if (text.replace(/[^a-z0-9]/gi, '').length < 2) continue; // 单字符噪声
          if (typeof (w as any).confidence === 'number' && (w as any).confidence < 35) continue;
          words.push({
            text,
            bbox: {
              x0: left + w.bbox.x0 / scale, y0: w.bbox.y0 / scale,
              x1: left + w.bbox.x1 / scale, y1: w.bbox.y1 / scale,
            },
          });
        }
      }
    }
  }
  return words;
}

/** 词级元素提取：**分条带识别**（导航条带 | 内容条带）→ 噪声过滤 → x-间隙聚类。
 *  词级分组解决了行级提取的**分组面**缺陷（跨列同基线并成一行），但 X 纪元
 *  真机再执法出**识别面**的腐蚀：导航词与内容词同基线时 tesseract 的行分割
 *  被大间隙拉伸，单词被腐蚀（'settings' 与 'format disk' 同排 ⇒ 读出
 *  'setines' conf=0，被置信过滤静默吞掉）。分条带让跨列行混合在构造上
 *  不可能 —— 侧栏/表格 OCR 的标准技艺。
 *  载荷纪律：2× 放大远离小字误读带（bbox 折回原域）。 */
export async function ocrWordElements(png: Buffer): Promise<OcrElement[]> {
  const worker = await getWordWorker();
  const { default: sharp } = await import('sharp');
  const W = (await sharp(png).metadata()).width ?? WIN_W;
  const scale = 2;
  const stripW = Math.min(NAV_STRIP_W, W);
  const words: TessWord[] = [
    ...(await ocrStripWords(worker, png, 0, stripW, scale)),
    ...(W > stripW ? await ocrStripWords(worker, png, stripW, W - stripW, scale) : []),
  ];
  // x-间隙聚类：同基线（垂直重叠 ≥50%矮者）且水平间隙 ≤45px 的词聚成一个元素
  const groups: Array<{ words: TessWord[]; x0: number; y0: number; x1: number; y1: number }> = [];
  for (const w of [...words].sort((a, b) => a.bbox.x0 - b.bbox.x0 || a.bbox.y0 - b.bbox.y0)) {
    const h = w.bbox.y1 - w.bbox.y0;
    let attached = false;
    for (const g of groups) {
      const gh = g.y1 - g.y0;
      const overlap = Math.min(w.bbox.y1, g.y1) - Math.max(w.bbox.y0, g.y0);
      const gap = Math.max(w.bbox.x0 - g.x1, g.x0 - w.bbox.x1); // 负值 = x 重叠
      if (overlap >= 0.5 * Math.min(h, gh) && gap <= WORD_GROUP_GAP_PX) {
        g.words.push(w);
        g.x0 = Math.min(g.x0, w.bbox.x0); g.y0 = Math.min(g.y0, w.bbox.y0);
        g.x1 = Math.max(g.x1, w.bbox.x1); g.y1 = Math.max(g.y1, w.bbox.y1);
        attached = true;
        break;
      }
    }
    if (!attached) {
      groups.push({ words: [w], x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 });
    }
  }
  return groups.map(g => ({
    name: g.words.sort((a, b) => a.bbox.x0 - b.bbox.x0).map(w => w.text).join(' ').replace(/\s+/g, ' ').slice(0, 40),
    bbox: { x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1 },
  })).filter(e => e.name.length > 0);
}

/** 导航不变量（分条带后收紧为全词在场）：导航条带区（x ≤ NAV_STRIP_W）
 *  六词（files/network/reports/settings/archive/editor）全部在场才放行。
 *  内容区词（如 reports 页的 'archive logs'）不参与 —— 只数导航带内的词。
 *  世界重置后状态文件先于窗口上屏（tkinter persist 在 mainloop 绘制前落盘），
 *  首帧截屏可能抓到部分绘制的窗口；reset 的 kill→spawn 间隙更长时甚至截到
 *  桌面既有窗口 —— 违反不变量 ⇒ 250ms 后重采样（世界渲染完备性守卫，
 *  不触碰决策管线；好路径首轮即返）。 */
const NAV_WORDS = ['files', 'network', 'reports', 'settings', 'archive', 'editor'];

async function captureStableElements(world: ComplexWorldWin): Promise<OcrElement[]> {
  let elements: OcrElement[] = [];
  // 最多 8 次 × 250ms ≈ 2s：耐心按最坏路径给足，好路径首轮即返
  for (let attempt = 0; attempt < 8; attempt++) {
    elements = await ocrWordElements(await captureComplexWorld(world));
    const navZone = new Set(
      elements.filter(e => e.bbox.x1 <= NAV_STRIP_W).map(e => e.name.toLowerCase()));
    if (NAV_WORDS.every(w => navZone.has(w))) return elements;
    await new Promise(r => setTimeout(r, 250));
  }
  return elements; // 皆退化 ⇒ 如实返回（下游元素数守卫接手报错）
}

/** 真机视觉工位源（Windows）：服务截屏 → 裁世界窗 → 词级 OCR → 归一化 → 网格分派。
 *  装饰带/标题过滤：顶 45px 标题栏（§ console - X）与大标题 'console' ——
 *  非可操作元素，词面判据剥掉（几何 + 词面双判据）。 */
export function createComplexVisionStation(world: ComplexWorldWin) {
  return {
    async perceive(env: any): Promise<ScenePatch[]> {
      const elements = await captureStableElements(world);
      const actionEls = elements.filter(e =>
        e.bbox.y1 > 45 &&
        !/^console\b/i.test(e.name));
      const els = actionEls.map(e => ({
        role: 'text',
        name: e.name,
        rect: {
          x: e.bbox.x0 / WIN_W,
          y: e.bbox.y0 / WIN_H,
          width: (e.bbox.x1 - e.bbox.x0) / WIN_W,
          height: (e.bbox.y1 - e.bbox.y0) / WIN_H,
        },
      }));
      if (els.length < 8) {
        throw new Error(`complex vision (win): OCR found only ${els.length} elements (${elements.length} raw — window not mapped?)`);
      }
      lastPerceivedNames = els.map(e => e.name);
      return dispatchElementsToGrid(els, { cols: env?.payload?.grid?.cols ?? 2, rows: env?.payload?.grid?.rows ?? 2 }, 'L2', 'L2-ocr');
    },
  };
}

// ─── 真机执行工位（Windows）：D-5 服务 /v1/click = 真 pyautogui 真鼠标 ───

export interface ExecProbe { executions: number; trapEvents: WorldEvent[] }

export function createComplexExecutionStation(world: ComplexWorldWin) {
  const adapter = makeAdapter();
  let inited = false;
  return {
    async execute(env: any): Promise<ExecutionResult> {
      const action = env.payload as AtomicAction;
      const before = world.state().events.length;
      const t0 = Date.now();
      if (action.kind === 'click_mouse' && typeof action.args?.x === 'number' && typeof action.args?.y === 'number') {
        if (!inited) { await adapter.init(); inited = true; }
        // 归一化（世界窗域）→ 世界窗像素 → 屏幕归一化（世界窗锚在 +0+0 物理像素）
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
          const events = world.state().events;
          if (events.length > before) {
            const hit = events[events.length - 1];
            if (hit.trap) {
              return {
                action, status: 'failure', durationMs: Date.now() - t0,
                failure: { kind: 'host-error', detail: `complex world: '${hit.widget}' button is broken` },
              };
            }
            return { action, status: 'success', durationMs: Date.now() - t0 };
          }
        }
        return {
          action, status: 'failure', durationMs: Date.now() - t0,
          failure: { kind: 'host-error', detail: 'complex world: click hit no element (ocr bbox drift / window not foreground)' },
        };
      }
      if (action.kind === 'type_text' && typeof action.args?.text === 'string') {
        // 笔迹纪元（X）：真键盘（pyautogui typewrite）→ tkinter Entry → 世界真相。
        // 世界裁决 = L4：聚焦框内容必须**包含**载荷（自证锚的世界执法面 ——
        // 打错/丢键/焦点丢失三类隐形事故在此现形）。
        if (!inited) { await adapter.init(); inited = true; }
        const text = action.args.text;
        const beforeEntries = JSON.stringify(world.state().entries);
        const r = await adapter.typeText({ text, clearFirst: action.args.clearFirst === true });
        if (!r.ok) {
          return { action, status: 'failure', durationMs: Date.now() - t0,
            failure: { kind: 'host-error', detail: `service type failed: ${r.error.detail}` } };
        }
        for (let i = 0; i < 40; i++) {
          await new Promise(r2 => setTimeout(r2, 50));
          const s = world.state();
          if (JSON.stringify(s.entries) !== beforeEntries) {
            const target = s.focus;
            if (target && (s.entries[target] ?? '').includes(text)) {
              return { action, status: 'success', durationMs: Date.now() - t0 };
            }
            return {
              action, status: 'failure', durationMs: Date.now() - t0,
              failure: {
                kind: 'host-error',
                detail: `complex world: typed text did not land in focused field '${target}' (entries=${JSON.stringify(s.entries)})`,
              },
            };
          }
        }
        return {
          action, status: 'failure', durationMs: Date.now() - t0,
          failure: { kind: 'host-error', detail: 'complex world: typing produced no world change (no focused field / keystrokes lost)' },
        };
      }
      return {
        action, status: 'failure', durationMs: Date.now() - t0,
        failure: { kind: 'host-error', detail: `complex world (win): action kind '${action.kind}' outside bench vocabulary` },
      };
    },
    async dispose() { (adapter as any).dispose?.(); },
  };
}

export { disposeComplexOcr as disposeOcrWin };
