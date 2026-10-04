import { extractInteractiveElements, hasAccessibilityProvider, } from '../uiExtractor.js';
import { isGlmConfigured, getGlmClient } from '../vlm/glmClient.js';
// W2-0（C 接线）：Zoom 复核开关读内核注册表（宿主 index.ts 以 config.vlmZoomVerify
// 铸入 grounding.verifyZoom；未注册 ⇒ 回声 1=开 —— grounding.nmsIou 同款缺省律）
import { kernelRegistry } from '../kernel/registry.js';
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
 * ΝΩ-26（帧缓存）：无障碍树是全屏提取 —— 2×2 网格每轮 4 分区 = 4 次全屏
 * 提取（L2 OCR 自 J 纪元起就有 1500ms 帧缓存，L1 一直没有）。现加同款 TTL
 * 帧缓存：窗口内一次提取、多区中心落区过滤；故障带负缓存（同窗口不重试，
 * a11y 持续故障时不放大为每分区一次全屏重试）。
 */
export function createStructuredFromUiExtractor(opts) {
    const ttl = opts.cacheTtlMs ?? 1500;
    let cache = null;
    let failCache = null;
    // 单飞（in-flight 去重）：并发 extract（多区齐发）共享同一次在途提取 ——
    // 缓存只挡「已完成」的重复，挡不住「进行中」的竞速（4 区齐发 = 4 次全屏提取）。
    let inFlight = null;
    async function loadFrame() {
        try {
            const [els, size] = await Promise.all([
                extractInteractiveElements(),
                opts.screenSize(),
            ]);
            const normalized = els.map(e => ({
                role: e.role,
                name: e.name,
                rect: normalizeRect(e.rect, size),
            }));
            cache = { at: Date.now(), els: normalized };
            failCache = null;
            return normalized;
        }
        catch (e) {
            failCache = { at: Date.now(), error: e instanceof Error ? e : new Error(String(e)) };
            throw failCache.error;
        }
    }
    async function frameElements() {
        const now = Date.now();
        if (cache && now - cache.at < ttl)
            return cache.els;
        if (failCache && now - failCache.at < ttl)
            throw failCache.error; // 负缓存命中
        if (!inFlight) {
            inFlight = loadFrame();
            // 落定即让位（成功/失败都清 —— 失败走负缓存挡后续，不挡重试语义本身）
            inFlight.then(() => { inFlight = null; }, () => { inFlight = null; });
        }
        return inFlight;
    }
    return {
        name: opts.name ?? 'uiExtractor-a11y(L1-adapter)',
        isReady() {
            return hasAccessibilityProvider();
        },
        async extract(region) {
            if (!hasAccessibilityProvider())
                return [];
            const normalized = await frameElements();
            // 区域过滤（中心落区即入区）：无障碍树是全屏提取 —— 不过滤会把整套
            // 元素重复贴进每个分区补丁（2×2 网格 = 每元素 4 份，决策 prompt 被污染）。
            // 无 region（全屏）时防御拷贝：缓存条目绝不暴露给消费方突变（毒化帧）。
            if (!region)
                return normalized.slice();
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
// ─── W8-C1（会话键供电）：模块级会话 id 武装（setAccessibilityProvider 同款先例） ───
/**
 * W8-C1：进程级会话 id 供给槽 —— 宿主（src/index.ts 的 session/event 面）把
 * 「当前会话 id」的现取闭包武装进来；适配器自铸点（orchestration/index.ts 的
 * createSemanticFromVlm 调用）无需逐处传 sessionId 即得同源键。供给是闭包
 * （每次 ground 现取 —— 适配器跨会话长存，键须随调用语境走，与
 * SemanticAdapterOpts.sessionId 同律）。裁决序：显式入参 opts.sessionId >
 * 本模块级武装 > 缺席（⇒ 缺省账本旧路径）。武装 null / 未武装 / 供给故障 ⇒
 * 诚实缺席，绝不毒化 ground 主管线（防御式）。
 */
let armedSessionId = null;
/**
 * 武装/卸下进程级会话 id 供给（宿主组合根专用面）：
 *  · setVisionSessionIdProvider(() => 'sess-42') —— 武装（供给现取）；
 *  · setVisionSessionIdProvider(null) —— 卸下（供给缺席 ⇒ 缺省账本）。
 * 供给闭包抛错/返回空串 ⇒ 键缺席（ground 内部吞掉，见 sessionKey 铸造处）。
 */
export function setVisionSessionIdProvider(fn) {
    armedSessionId = typeof fn === 'function' ? fn : null;
}
/**
 * L3 适配器（花钱层 —— 仅 ceiling='L3' 时工位才会调用，闸门主权在中枢）。
 * 就绪条件 = GLM 云脑已配置（isGlmConfigured：config 铸造的单例或环境变量）。
 * ground 管线：截全屏 → [W5-4] 稀疏 SoM 叠加（预算>0 且证据在场 ⇒ renderSomOverlay
 * 同尺寸合成，叠加图替代原图）→ groundElements（question 聚焦，坐标 = 屏幕像素系）
 * → 像素 bbox ÷ 屏幕尺寸归一化 → 中心落区过滤（与 L1/L2 同律）。
 * 故障约定与 L1/L2 同（J 纪元立法）：**故障向上抛** —— groundElements 的
 * ok:false（云脑失败/降级）转 throw，由工位 safeGround 捕获归因为
 * 'L3 source fault' 补丁（失败空 ≠ 真空）；ok:true 空 elements 是诚实空集，
 * 原样返回 []。
 *
 * W5-4 坐标闭环（叠加是视觉辅助，坐标仍以原图系为准）：renderSomOverlay 在
 * **同一 buffer 的元数据尺寸**上合成（SVG W×H = 原图尺寸、top/left=0、无裁剪
 * 无缩放）⇒ 叠加图与原图逐像素同尺寸 —— 模型在叠加图上作答的 bbox 天然就在
 * 原图像素系，groundElements 的 clamp/反算/本适配器的归一化全部沿用原图基准，
 * 零换算、零平移（测试 W5-4⑥ 四重闭环断言）。
 */
export function createSemanticFromVlm(opts) {
    // W5-4: 叠加事件账本（适配器级累积；somEventLog 防御拷贝读出）+ 遥测回调
    const somLog = [];
    const emitSom = (ev) => {
        somLog.push(ev);
        try {
            opts.onSomEvent?.(ev);
        }
        catch { /* 遥测面绝不毒化主管线（防御式） */ }
    };
    // ΝΩ-26：L3 帧缓存（buffer + 尺寸成对缓存 —— 坐标系一致性前提）。截屏失败
    // 向上抛（不缓存失败）；缓存条目只读共享（applySparseSom 合成新 buffer，
    // 绝不变异原帧 —— 多区叠加互不污染）。
    const frameTtl = opts.frameCacheTtlMs ?? 1500;
    let frameCache = null;
    async function captureFrame() {
        const now = Date.now();
        if (frameCache && now - frameCache.at < frameTtl)
            return frameCache;
        const [buffer, size] = await Promise.all([opts.capture(), opts.screenSize()]);
        frameCache = { at: now, buffer, size };
        return frameCache;
    }
    /**
     * W5-4: 稀疏 SoM 叠加步（编码前挂点 —— groundElements 内部才走 encodeForVlm，
     * 此处替换进编码的 buffer 即「叠加图替代原图」）。幂等可降级四律 + 防御绝不抛：
     *   1. 预算 <=0 / 非有限 ⇒ 原图直通（budget-off；缺省路径，逐字节现状）；
     *   2. 种子供给口缺席（probe/元素证据链缺席）⇒ 直通（marker-port-absent）；
     *   3. 元素面为空（供给空/全脏/区域外全滤）⇒ 直通（elements-empty）；
     *   4. 叠加失败（sharp 缺席/解码失败/供给口抛错）⇒ 原图直通 + degraded 注记。
     * scores 组装：confidence = 种子随行的 probe 置信（缺席省略键），relevance =
     * taskRelevance(种子文本, question)—— assembleSomScores 纯函数成形。种子按
     * 中心落区过滤（与 L1/L2 同一分派律：预算花在当前扫描区）。routeLabels /
     * stableColors 随稀疏模式一并开（抗遮挡标签路由 + 跨帧稳定染色）。
     */
    async function applySparseSom(buffer, size, region, question) {
        // 预算裁决：显式入参 > 内核键 som.sparseBudget（config.somSparseBudget 的
        // 宿主铸入通道）> 回声 0。非法（NaN/±∞/负）一律按关处理 —— 配置错误不毒化管线。
        const rawOpt = opts.somSparseBudget;
        const budget = typeof rawOpt === 'number' && Number.isFinite(rawOpt)
            ? rawOpt
            : kernelRegistry.getOrDefault('som.sparseBudget', 0);
        if (!Number.isFinite(budget) || budget <= 0) {
            emitSom({ applied: false, reason: 'budget-off', budget: 0, elementsIn: 0 });
            return buffer;
        }
        if (typeof opts.somMarkers !== 'function') {
            emitSom({ applied: false, reason: 'marker-port-absent', budget, elementsIn: 0 });
            return buffer;
        }
        // 防御式绝不抛：供给口故障 / som 模块加载故障 / 渲染故障 ⇒ 原图直通 + degraded
        try {
            const supplied = await opts.somMarkers();
            const seeds = Array.isArray(supplied) ? supplied : [];
            // 种子规整 + 中心落区过滤（与 L1/L2 适配器同一分派语义）；脏种子跳过不毒化
            const markers = [];
            const scoreSeeds = [];
            for (const s of seeds) {
                if (s === null || typeof s !== 'object')
                    continue;
                const b = s.bbox;
                if (!b || ![b.x0, b.y0, b.x1, b.y1].every(Number.isFinite))
                    continue;
                if (!(b.x1 > b.x0) || !(b.y1 > b.y0))
                    continue;
                const cx = ((b.x0 + b.x1) / 2) / size.width;
                const cy = ((b.y0 + b.y1) / 2) / size.height;
                if (!centerInRegion(cx, cy, region))
                    continue;
                markers.push({
                    id: markers.length + 1,
                    bbox: { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 },
                    center: { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 },
                    ...(typeof s.text === 'string' && s.text !== '' ? { text: s.text } : {}),
                });
                // scores 种子与 marker 平行对齐（text/probeConfidence 原样随行；缺席证据
                // 的键省略语义由 assembleSomScores 收口 —— 无证据 ≠ 0 分）
                scoreSeeds.push({ text: s.text, probeConfidence: s.probeConfidence });
            }
            if (markers.length === 0) {
                emitSom({ applied: false, reason: 'elements-empty', budget, elementsIn: 0 });
                return buffer;
            }
            const { renderSomOverlay, assembleSomScores } = await import('../vlm/som.js');
            const scores = assembleSomScores(scoreSeeds, question);
            const res = await renderSomOverlay(buffer, {
                markers,
                scores,
                sparseBudget: budget,
                routeLabels: true, // W5-4: 抗遮挡标签路由随稀疏模式一并开
                stableColors: true, // W5-4: 跨帧稳定染色随稀疏模式一并开
            });
            if (res.ok && Buffer.isBuffer(res.buffer)) {
                emitSom({
                    applied: true,
                    budget,
                    elementsIn: markers.length,
                    selected: res.selected,
                    ...(res.sparseFallback !== undefined ? { sparseFallback: res.sparseFallback } : {}),
                });
                return res.buffer;
            }
            emitSom({
                applied: false, reason: 'overlay-failed', degraded: true,
                budget, elementsIn: markers.length,
                ...(res.error ? { detail: res.error.slice(0, 200) } : {}),
            });
            return buffer;
        }
        catch (e) {
            // 供给口抛错 / som 模块图加载失败等未知异常 —— 诚实降级原图直通，绝不抛
            emitSom({
                applied: false, reason: 'marker-source-fault', degraded: true,
                budget, elementsIn: 0,
                detail: (e instanceof Error ? e.message : String(e)).slice(0, 200),
            });
            return buffer;
        }
    }
    const source = {
        name: opts.name ?? 'glm-vision(L3-adapter)',
        isReady() {
            return isGlmConfigured();
        },
        /** W5-4: 叠加事件账本读出（防御拷贝 —— 观察面与账本解耦） */
        somEventLog() {
            return [...somLog];
        },
        async ground(region, question) {
            // 截屏 + 尺寸（任一故障向上抛 —— 工位记 fault，两种空两种决策）；
            // ΝΩ-26：经帧缓存供给（窗口内多区共享同一帧 —— capture 计数不随分区数膨胀）
            const { buffer, size } = await captureFrame();
            if (!Number.isFinite(size.width) || size.width < 1 || !Number.isFinite(size.height) || size.height < 1) {
                throw new Error(`invalid screen size ${size.width}x${size.height}`);
            }
            // W5-4: 编码前稀疏 SoM 叠加（条件直通/降级见 applySparseSom；绝不抛 ——
            // 叠加失败时 groundElements 收到的仍是原图，行为与无 SoM 时逐字节一致）
            const groundBuffer = await applySparseSom(buffer, size, region, question);
            // 云脑接地：坐标语义 = width×height 屏幕像素系（groundElements 内部编码+规整+NMS）
            const { groundElements } = await import('../vlm/grounding.js');
            // W8-B2：复核预算作用域键 —— 会话供给在场才铸键（`session:<id>` 与宿主回合
            // 边界的 resetVerifyGateBudget 同键闭环，见 SemanticAdapterOpts.sessionId）；
            // 缺席/脏值/供给抛错 ⇒ 键缺席 ⇒ 缺省账本（逐字节旧路径）。
            // W8-C1（会话键供电）：裁决序 = 显式入参 opts.sessionId > 模块级武装
            //（setVisionSessionIdProvider —— 宿主 session/event 面武装的当前会话现取
            // 闭包，本适配器自铸点无需逐处传键）> 缺席。
            const sessionKey = (() => {
                try {
                    const supply = typeof opts.sessionId === 'function' ? opts.sessionId : armedSessionId;
                    const id = typeof supply === 'function' ? supply() : undefined;
                    return typeof id === 'string' && id.trim() !== '' ? `session:${id}` : undefined;
                }
                catch {
                    return undefined; // 供给故障 ⇒ 诚实回落缺省账本，绝不毒化主管线
                }
            })();
            const result = await groundElements(groundBuffer, {
                width: size.width, height: size.height, question,
                ...(sessionKey ? { verifyTaskId: sessionKey } : {}),
                ...(opts.client ? { client: opts.client } : {}),
                // W2-0（C 接线）：Zoom 复核端口（W1-8 P3）—— grounding.verifyZoom 内核键
                //（宿主以 config.vlmZoomVerify 铸入，缺省 1=开）控制；显式 verifyClient 优先，
                // 次选本适配器 client，再回落已配置单例（未配置 ⇒ 缺席 ⇒ port-absent 放行）。
                ...(kernelRegistry.getOrDefault('grounding.verifyZoom', 1) > 0.5
                    ? {
                        verifyClient: opts.verifyClient ??
                            opts.client ??
                            (isGlmConfigured() ? getGlmClient() : undefined),
                    }
                    : {}),
            });
            if (!result.ok) {
                throw new Error(result.error ?? 'vlm grounding failed');
            }
            // 像素 → 归一化 + 中心落区过滤（与 L1/L2 适配器同一分派语义）
            const normalized = result.elements.map(el => {
                const rect = {
                    x: el.bbox.x0 / size.width,
                    y: el.bbox.y0 / size.height,
                    width: (el.bbox.x1 - el.bbox.x0) / size.width,
                    height: (el.bbox.y1 - el.bbox.y0) / size.height,
                };
                return {
                    role: el.role,
                    name: el.label.slice(0, 20), // D-3 LABEL_MAX 先例：元素名 ≤20 字符
                    rect,
                };
            });
            return normalized.filter(e => centerInRegion(e.rect.x + e.rect.width / 2, e.rect.y + e.rect.height / 2, region));
        },
    };
    // W5-4: 适配器返回结构携带叠加事件账本读出面（SemanticSource 契约零变更 ——
    // 只加不自夺；既有消费方按 SemanticSource 面消费不受影响）
    return source;
}
