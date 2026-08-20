// src/_legacyDeps.ts
// 批次 E 共享：废弃原生依赖的懒加载 + 一致迁移错误消息。
//
// 所有 sharp / tesseract.js 的调用点经此处统一：
//   - D-7 主路径（KnowledgePipeline → D7PhysicalHostPort → D-5 microservice）不使用本模块
//   - D-1 老工具层（takeScreenshot / zoomInspect / textReader / perceptualHash 等）
//     保留在代码库中但不再强依赖这些包 —— 实际调用时给出清晰的迁移指引。
//
// 回退模式（谨慎使用）：DSH_FORCE_LEGACY_DEPS=1 开启后，错误消息聚焦「包没装」，
// 方便还没完成迁移的老插件使用者自行恢复依赖。

const LEGACY_NOTICE =
  'Legacy native dependencies (sharp, tesseract.js) removed in batch-E migration. ' +
  'Use the D-7 default execution path or D-5 PhysicalExecutionAdapter instead: ' +
  'screenshots via takeScreenshotHandle(), OCR via getUiTree(funnelCeiling="L2"), ' +
  'image processing via Python Pillow endpoint. If you must use the old D-1 tools layer, ' +
  'reinstall sharp and/or tesseract.js and set DSH_FORCE_LEGACY_DEPS=1.';

function legacyError(pkg: 'sharp' | 'tesseract.js', hint?: string): Error {
  const envForce = process.env.DSH_FORCE_LEGACY_DEPS === '1';
  if (envForce) {
    return new Error(
      `[legacy-deps] ${pkg} is not installed. DSH_FORCE_LEGACY_DEPS=1 requires you to ` +
      `manually install it via npm.`,
    );
  }
  return new Error(
    `[legacy-deps] ${pkg} removed (batch-E). ${LEGACY_NOTICE}` +
    (hint ? ` Hint: ${hint}` : ''),
  );
}

// ─── sharp 懒加载（缓存 + 错误记忆）───────────────────────────────

export type SharpLike = (
  input?: Buffer | string | Uint8Array,
  options?: { raw?: { width: number; height: number; channels: number }; density?: number; [k: string]: any },
) => SharpChainLike;

export interface SharpChainLike {
  // 允许对象式 resize({ width }) 以及位置式 resize(w, h, opts)
  resize(width: number | { width?: number; height?: number; fit?: string; [k: string]: any }, height?: number, opts?: any): SharpChainLike;
  crop(opts: any): SharpChainLike;
  extract(opts: any): SharpChainLike;
  rotate(angle?: number): SharpChainLike;
  composite(arr: any[]): SharpChainLike;
  toFormat(fmt: string, opts?: any): SharpChainLike;
  png(opts?: any): SharpChainLike;
  jpeg(opts?: any): SharpChainLike;
  grayscale(): SharpChainLike;
  raw(): SharpChainLike;
  toBuffer(opts?: any): Promise<Buffer>;
  toBuffer<T>(opts: { resolveWithObject: true } & T): Promise<{ data: Uint8Array | Buffer; info: any }>;
  toFile(p: string): Promise<any>;
  metadata(): Promise<{ width: number; height: number; format?: string; channels?: number; size?: number }>;
  stats(): Promise<any>;
  clone(): SharpChainLike;
}

let _sharp: SharpLike | null = null;
let _sharpError: Error | null = null;

/** 懒加载 sharp 模块 —— 使用模式同原 `import sharp from 'sharp'`，返回函数式 API。 */
export async function getSharp(): Promise<SharpLike> {
  if (_sharp) return _sharp as SharpLike;
  if (_sharpError) throw _sharpError;
  try {
    // 动态 import 不提供 sharp 的类型 —— 这里 all-as-any，由 SharpLike 接口约束下游。
    const mod: any = await import('sharp');
    // sharp v0.33 ESM/CJS 混导：mod / mod.default / mod.default.default 都有可能
    const fn: any = mod?.default?.default ?? mod?.default ?? mod;
    if (typeof fn !== 'function') {
      throw new Error(`sharp export is not a function: ${typeof fn}`);
    }
    _sharp = fn;
    return _sharp as SharpLike;
  } catch (e: any) {
    _sharpError = legacyError('sharp',
      'Image resizing/cropping is now handled on the D-5 Python microservice side via Pillow.');
    throw _sharpError;
  }
}

/** 重置 sharp 缓存（仅测试用） */
export function _resetSharpCache_forTest(): void {
  _sharp = null;
  _sharpError = null;
}

// ─── tesseract.js 懒加载（缓存 + 错误记忆）─────────────────────────

export interface TesseractWorkerLike {
  recognize(image: Buffer | Uint8Array | string, langs?: string, opts?: any): Promise<{
    data: {
      text: string;
      confidence: number;
      words: Array<{ text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }>;
      lines: any[];
      paragraphs: any[];
    };
  }>;
  terminate(): Promise<void>;
  setParameters?(params: Record<string, any>): Promise<void>;
  loadLanguage?(langs?: string): Promise<void>;
  initialize?(langs?: string, oem?: any): Promise<void>;
}

export interface TesseractLike {
  createWorker(langs?: string, oem?: any, opts?: any): Promise<TesseractWorkerLike>;
}

let _tesseract: TesseractLike | null = null;
let _tesseractError: Error | null = null;

/** 懒加载 tesseract.js —— 使用模式：const worker = await (await getTesseract()).createWorker() */
export async function getTesseract(): Promise<TesseractLike> {
  if (_tesseract) return _tesseract as TesseractLike;
  if (_tesseractError) throw _tesseractError;
  try {
    const mod: any = await import('tesseract.js');
    const mod2: any = mod?.default?.default ?? mod?.default ?? mod;
    if (typeof mod2?.createWorker !== 'function') {
      throw new Error(`tesseract.js missing createWorker (got ${typeof mod2?.createWorker})`);
    }
    _tesseract = mod2 as TesseractLike;
    return _tesseract as TesseractLike;
  } catch (e: any) {
    _tesseractError = legacyError('tesseract.js',
      'OCR is now provided by the D-5 microservice: adapter.getUiTree({ funnelCeiling: "L2" }).');
    throw _tesseractError;
  }
}

/** 重置 tesseract 缓存（仅测试用） */
export function _resetTesseractCache_forTest(): void {
  _tesseract = null;
  _tesseractError = null;
}
