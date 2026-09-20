// src/orchestration/visionAdapters.ts
// D-6 视觉源适配器（P1-4 落地）：把插件自身既有的视觉能力（uiExtractor 无障碍树 /
// textReader OCR）适配为 D-6 三级漏斗的 L1/L2 端口方言 —— D-3→中枢边从死线变为
// 「外部服务优先，内部能力回退，双缺席诚实降级」的三级供给。
// 产权纪律：端口类型 import orchestration/stations（D-6 主权）；能力模块 import
// 根空间（uiExtractor 纯 JS 可静态引入；textReader 依赖 sharp/tesseract 原生二进制
// —— 惰性动态引入，沙箱环境零污染 D-6 模块图）。
// 异常诚实（J 纪元修正）：适配器**不再吞错**——故障向上抛，由工位的 safe*
// 包装捕获并归因为 fault 补丁（「失败空 ≠ 真空」）。旧实现内部 catch 后返回
// []，工位看来是"层 ready 但真空"，fault 文案谎报 `L1:ready, L2:ready`，
// 归因链断裂；且 OCR 持续失败时每分区重试一次全屏 OCR（4 分区 = 4 次整屏）。
// 返回 [] 只保留一个语义：诚实空集（真的什么都没提取到）。
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

/** 中心落区判定（L1/L2 同律）：半开 [x0, x1) —— 恰落在格线上的中心归属右侧
 *  分区；最右/最下边缘区（右/下界 = 1.0）例外闭合，防边缘元素被所有分区漏掉。
 *  与 knowledge/stations.dispatchElementsToGrid 的分派语义同源。 */
function centerInRegion(cx: number, cy: number, region: RegionSpec): boolean {
  const inX = cx >= region.x && (cx < region.x + region.width || region.x + region.width >= 1);
  const inY = cy >= region.y && (cy < region.y + region.height || region.y + region.height >= 1);
  return inX && inY;
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
    async extract(region?: RegionSpec): Promise<Array<Pick<UIElement, 'role' | 'name' | 'state' | 'rect'>>> {
      if (!hasAccessibilityProvider()) return [];
      // J 纪元修正：不再吞错 —— provider 抛错/尺寸查询失败向上抛，
      // 工位 safeExtract 记 fault 补丁（失败空 ≠ 真空，归因链不断裂）
      const [els, size] = await Promise.all([
        extractInteractiveElements(),
        opts.screenSize(),
      ]);
      const normalized = els.map(e => ({
        role: e.role,
        name: e.name,
        rect: normalizeRect(e.rect, size),
      }));
      // 区域过滤（中心落区即入区）：无障碍树是全屏提取 —— 不过滤会把整套
      // 元素重复贴进每个分区补丁（2×2 网格 = 每元素 4 份，决策 prompt 被污染）
      if (!region) return normalized;
      return normalized.filter(e =>
        centerInRegion(e.rect.x + e.rect.width / 2, e.rect.y + e.rect.height / 2, region));
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
 * tesseract/sharp 是原生二进制依赖 —— 惰性动态引入（首次 detect 才加载）。
 * J 纪元修正：故障向上抛（工位 safeDetect 记 fault），并带**负缓存** ——
 * OCR 持续失败时同一 TTL 窗口内不重复整屏截屏+OCR（旧实现 4 分区 = 4 次重试）。
 */
export function createTraditionalFromOcr(opts: TraditionalAdapterOpts): TraditionalVisionSource {
  const lang = opts.lang ?? 'eng';
  const ttl = opts.cacheTtlMs ?? 1500;
  let cache: OcrCache | null = null;
  let failCache: { at: number; error: Error } | null = null;

  async function ocrWords(): Promise<OcrCache['words']> {
    const now = Date.now();
    if (cache && now - cache.at < ttl) return cache.words;
    if (failCache && now - failCache.at < ttl) throw failCache.error; // 负缓存命中
    try {
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
      failCache = null;
      return words;
    } catch (e: any) {
      failCache = { at: now, error: e instanceof Error ? e : new Error(String(e)) };
      throw failCache.error;
    }
  }

  return {
    name: 'textReader-ocr(L2-adapter)',
    isReady(): boolean {
      return true; // capture 端口在场即就绪（结构就绪）；运行时故障在 detect 诚实归因
    },
    async detect(region: RegionSpec): Promise<Array<Pick<UIElement, 'role' | 'name' | 'rect'>>> {
      // J 纪元修正：不再吞错 —— OCR/截屏故障向上抛，工位记 fault 补丁
      const words = await ocrWords();
      // 词中心落区过滤（region 是归一化域 —— 与词框同域零换算；半开语义
      // 见 centerInRegion：格线中心不重复入区）
      return words.filter(w =>
        centerInRegion(w.rect.x + w.rect.width / 2, w.rect.y + w.rect.height / 2, region));
    },
  };
}
