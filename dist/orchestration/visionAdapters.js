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
        async extract() {
            if (!hasAccessibilityProvider())
                return [];
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
            }
            catch {
                return []; // 契约违约（provider 抛错/尺寸查询失败）⇒ 空集，工位记 fault
            }
        },
    };
}
/**
 * L2 适配器（<50ms 预算域）：全屏 OCR 一次 + 分区词过滤（词中心落区即入区）。
 * 词框 bbox_normalized 已是全屏归一化域 —— 与 UIElement.rect 同域直通（零换算）。
 * tesseract/sharp 是原生二进制依赖 —— 惰性动态引入（首次 detect 才加载），
 * 沙箱/无网环境 detect 返回空集（诚实降级，不毒化工位）。
 */
export function createTraditionalFromOcr(opts) {
    const lang = opts.lang ?? 'eng';
    const ttl = opts.cacheTtlMs ?? 1500;
    let cache = null;
    async function ocrWords() {
        const now = Date.now();
        if (cache && now - cache.at < ttl)
            return cache.words;
        // 惰性加载（原生依赖隔离）：失败 = 空集 —— 工位漏斗降 L3/空补丁
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
        return words;
    }
    return {
        name: 'textReader-ocr(L2-adapter)',
        isReady() {
            return true; // capture 端口在场即就绪（结构就绪）；运行时故障在 detect 诚实降级
        },
        async detect(region) {
            try {
                const words = await ocrWords();
                // 词中心落区过滤（region 是归一化域 —— 与词框同域零换算）
                return words.filter(w => w.rect.x + w.rect.width / 2 >= region.x &&
                    w.rect.x + w.rect.width / 2 <= region.x + region.width &&
                    w.rect.y + w.rect.height / 2 >= region.y &&
                    w.rect.y + w.rect.height / 2 <= region.y + region.height);
            }
            catch {
                return []; // OCR/截屏故障 ⇒ 空集（工位漏斗继续降级，绝不毒化）
            }
        },
    };
}
