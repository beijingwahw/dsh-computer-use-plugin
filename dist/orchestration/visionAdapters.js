import { extractInteractiveElements, hasAccessibilityProvider, } from '../uiExtractor.js';
/** 像素 rect → 归一化 rect（StructuredSource 契约：坐标归一化责任在适配器） */
function normalizeRect(rect, size) {
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
function centerInRegion(cx, cy, region) {
    const inX = cx >= region.x && (cx < region.x + region.width || region.x + region.width >= 1);
    const inY = cy >= region.y && (cy < region.y + region.height || region.y + region.height >= 1);
    return inX && inY;
}
/**
 * L1 适配器（<1ms 预算域的诚实边界：无障碍树提取本身 <1ms，屏幕尺寸查询是
 * 一次性异步开销）。就绪条件 = 宿主已注入 AccessibilityProvider
 * （setAccessibilityProvider —— uiExtractor 既有契约，本适配器不越权代注入）。
 */
export function createStructuredFromUiExtractor(opts) {
    return {
        name: opts.name ?? 'uiExtractor-a11y(L1-adapter)',
        isReady() {
            return hasAccessibilityProvider();
        },
        async extract(region) {
            if (!hasAccessibilityProvider())
                return [];
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
            if (!region)
                return normalized;
            return normalized.filter(e => centerInRegion(e.rect.x + e.rect.width / 2, e.rect.y + e.rect.height / 2, region));
        },
    };
}
/**
 * L2 适配器（<50ms 预算域）：全屏 OCR 一次 + 分区词过滤（词中心落区即入区）。
 * 词框 bbox_normalized 已是全屏归一化域 —— 与 UIElement.rect 同域直通（零换算）。
 * tesseract/sharp 是原生二进制依赖 —— 惰性动态引入（首次 detect 才加载）。
 * J 纪元修正：故障向上抛（工位 safeDetect 记 fault），并带**负缓存** ——
 * OCR 持续失败时同一 TTL 窗口内不重复整屏截屏+OCR（旧实现 4 分区 = 4 次重试）。
 */
export function createTraditionalFromOcr(opts) {
    const lang = opts.lang ?? 'eng';
    const ttl = opts.cacheTtlMs ?? 1500;
    let cache = null;
    let failCache = null;
    async function ocrWords() {
        const now = Date.now();
        if (cache && now - cache.at < ttl)
            return cache.words;
        if (failCache && now - failCache.at < ttl)
            throw failCache.error; // 负缓存命中
        try {
            const { readText } = await import('../textReader.js');
            const buffer = await opts.capture();
            const result = await readText(buffer, lang);
            const words = result.words.map(w => ({
                role: 'text',
                name: w.text.slice(0, 20),
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
        }
        catch (e) {
            failCache = { at: now, error: e instanceof Error ? e : new Error(String(e)) };
            throw failCache.error;
        }
    }
    return {
        name: 'textReader-ocr(L2-adapter)',
        isReady() {
            return true; // capture 端口在场即就绪（结构就绪）；运行时故障在 detect 诚实归因
        },
        async detect(region) {
            // J 纪元修正：不再吞错 —— OCR/截屏故障向上抛，工位记 fault 补丁
            const words = await ocrWords();
            // 词中心落区过滤（region 是归一化域 —— 与词框同域零换算；半开语义
            // 见 centerInRegion：格线中心不重复入区）
            return words.filter(w => centerInRegion(w.rect.x + w.rect.width / 2, w.rect.y + w.rect.height / 2, region));
        },
    };
}
