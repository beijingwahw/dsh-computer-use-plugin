// src/orchestration/visionAdapters.ts
// D-6 视觉源适配器（P1-4 落地）：把插件自身既有的视觉能力（uiExtractor 无障碍树 /
// textReader OCR）适配为 D-6 三级漏斗的 L1/L2 端口方言 —— D-3→中枢边从死线变为
// 「外部服务优先，内部能力回退，双缺席诚实降级」的三级供给。
// 产权纪律：端口类型 import orchestration/stations（D-6 主权）；能力模块 import
// 根空间（uiExtractor 纯 JS 可静态引入；textReader 依赖 sharp/tesseract 原生二进制
// —— 惰性动态引入，沙箱环境零污染 D-6 模块图）。
// 异常诚实：适配器永不抛错毒化工位 —— 失败 = 空元素集 + fault 归因交工位记录。
import type { RegionSpec, UIElement } from './contracts';
import type { StructuredSource, TraditionalVisionSource } from './stations';
import {
  extractInteractiveElements, hasAccessibilityProvider,
} from '../uiExtractor';

/** 屏幕尺寸供给口（像素 → 归一化的除数源；真机由 system.getScreenSize 注入） */
export type ScreenSizeFn = () => Promise<{ width: number; height: number }>;

/** 像素 rect → 归一化 rect（StructuredSource 契约：坐标归一化责任在适配器） */
function normalizeRect(
  rect: { x: number; y: number; width: number; height: number },
  size: { width: number; height: number },
): UIElement['rect'] {
  return {
    x: rect.x / size.width,
    y: rect.y / size.height,
    width: rect.width / size.width,
    height: rect.height / size.height,
  };
}

// ─── L1 结构化源适配器：uiExtractor（无障碍树）→ StructuredSource ───

export interface StructuredAdapterOpts {
  /** 屏幕尺寸供给（像素坐标归一化的除数源）；缺席/故障 ⇒ extract 返回空集 */
  screenSize: ScreenSizeFn;
  /** 适配器审计名（工位 funnelFaultDetail 归因用） */
  name?: string;
}

/**
 * L1 适配器（<1ms 预算域的诚实边界：无障碍树提取本身 <1ms，屏幕尺寸查询是
 * 一次性异步开销）。就绪条件 = 宿主已注入 AccessibilityProvider
 * （setAccessibilityProvider —— uiExtractor 既有契约，本适配器不越权代注入）。
 */
export function createStructuredFromUiExtractor(opts: StructuredAdapterOpts): StructuredSource {
  return {
    name: opts.name ?? 'uiExtractor-a11y(L1-adapter)',
    isReady(): boolean {
      return hasAccessibilityProvider();
    },
    async extract(): Promise<Array<Pick<UIElement, 'role' | 'name' | 'state' | 'rect'>>> {
      if (!hasAccessibilityProvider()) return [];
      try {
        const [els, size] = await Promise.all([
          extractInteractiveElements(),
          opts.screenSize(),
        ]);
        return els.map(e => ({
          role: e.role,
          name: e.name,
          rect: normalizeRect(e.rect, size),
        }));
      } catch {
        return []; // 契约违约（provider 抛错/尺寸查询失败）⇒ 空集，工位记 fault
      }
    },
  };
}

// ─── L2 传统视觉源适配器：textReader（OCR）→ TraditionalVisionSource ───

export interface TraditionalAdapterOpts {
  /** 截屏供给（像素缓冲；真机由 system.captureScreen 注入） */
  capture: () => Promise<Buffer>;
  /** 屏幕尺寸供给（OCR 词框已是全屏归一化域 —— 尺寸仅作就绪审计） */
  screenSize: ScreenSizeFn;
  /** OCR 语言（textReader 缺省 'eng'） */
  lang?: string;
  /** 捕获+OCR 缓存窗口（一次扫描多分区共享一次全屏 OCR；缺省 1500ms 对齐 uiExtractor） */
  cacheTtlMs?: number;
}

/** OCR 全屏词缓存条目（多分区共享 —— L2 预算域的效率前提） */
interface OcrCache {
  at: number;
  words: Array<Pick<UIElement, 'role' | 'name' | 'rect'>>;
}

/**
 * L2 适配器（<50ms 预算域）：全屏 OCR 一次 + 分区词过滤（词中心落区即入区）。
 * 词框 bbox_normalized 已是全屏归一化域 —— 与 UIElement.rect 同域直通（零换算）。
 * tesseract/sharp 是原生二进制依赖 —— 惰性动态引入（首次 detect 才加载），
 * 沙箱/无网环境 detect 返回空集（诚实降级，不毒化工位）。
 */
export function createTraditionalFromOcr(opts: TraditionalAdapterOpts): TraditionalVisionSource {
  const lang = opts.lang ?? 'eng';
  const ttl = opts.cacheTtlMs ?? 1500;
  let cache: OcrCache | null = null;

  async function ocrWords(): Promise<OcrCache['words']> {
    const now = Date.now();
    if (cache && now - cache.at < ttl) return cache.words;
    // 惰性加载（原生依赖隔离）：失败 = 空集 —— 工位漏斗降 L3/空补丁
    const { readText } = await import('../textReader');
    const buffer = await opts.capture();
    const result = await readText(buffer, lang);
    const words = result.words.map(w => ({
      role: 'text',
      name: w.text.slice(0, 20), // D-3 LABEL_MAX 先例：元素名 ≤20 字符
      rect: {
        x: w.bbox_normalized.x0,
        y: w.bbox_normalized.y0,
        width: w.bbox_normalized.x1 - w.bbox_normalized.x0,
        height: w.bbox_normalized.y1 - w.bbox_normalized.y0,
      },
    }));
    cache = { at: now, words };
    return words;
  }

  return {
    name: 'textReader-ocr(L2-adapter)',
    isReady(): boolean {
      return true; // capture 端口在场即就绪（结构就绪）；运行时故障在 detect 诚实降级
    },
    async detect(region: RegionSpec): Promise<Array<Pick<UIElement, 'role' | 'name' | 'rect'>>> {
      try {
        const words = await ocrWords();
        // 词中心落区过滤（region 是归一化域 —— 与词框同域零换算）
        return words.filter(w =>
          w.rect.x + w.rect.width / 2 >= region.x &&
          w.rect.x + w.rect.width / 2 <= region.x + region.width &&
          w.rect.y + w.rect.height / 2 >= region.y &&
          w.rect.y + w.rect.height / 2 <= region.y + region.height,
        );
      } catch {
        return []; // OCR/截屏故障 ⇒ 空集（工位漏斗继续降级，绝不毒化）
      }
    },
  };
}
