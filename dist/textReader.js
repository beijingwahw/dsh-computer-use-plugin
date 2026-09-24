// src/textReader.ts
// 第四轮创新之二：文字感知层（本地 OCR）。
// 纯视觉架构的最后一道认知缺口：模型「看得见」却难以百分百确认文字内容。
// OCR 补上语义闭环的三块拼图：
//   1. find_text：文字 → 精确坐标（带文字标签的元素不再靠坐标估算）
//   2. read_text：区域文字读取（用文本替代截图，Token 数量级下降）
//   3. semanticConfirm：动作后自动核对「预期文字是否出现」
//
// 双路径（本轮接线）：D-5 服务端 L2 OCR（RapidOCR，getUiTree）优先；
// tesseract.js（懒动态导入）保留为 legacy 路径。enableOcr 语义不变。
import { fuzzyIncludes } from './fuzzy.js';
import { getSharp, getTesseract, } from './_legacyDeps.js';
import * as backend from './physicalBackend.js';
let workerPromise = null;
let workerLang = '';
async function getWorker(lang) {
    if (workerPromise && workerLang === lang)
        return workerPromise;
    workerLang = lang;
    const prev = workerPromise;
    // 同步占位：并发首次调用共享同一个创建中的 worker（否则会各建一个，泄漏其一）
    const creating = getTesseract().then(tess => tess.createWorker(lang));
    workerPromise = creating;
    creating.catch(() => {
        if (workerPromise === creating)
            workerPromise = null; // 失败后允许重试（网络恢复时）
    });
    // 语言切换：新 worker 接班后终止旧 worker（否则旧实例存活到 disposeOcr）
    if (prev) {
        try {
            (await prev).terminate();
        }
        catch { /* already dead */ }
    }
    return creating;
}
/** 生命周期清理：插件卸载时终止 OCR worker（DSH 注册即效果模型的良好公民） */
export async function disposeOcr() {
    if (workerPromise) {
        try {
            (await workerPromise).terminate();
        }
        catch { /* already dead */ }
        workerPromise = null;
    }
}
const normalize = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
// ─── D-5 服务端 L2 OCR 路径 ───
/**
 * 服务端 L2 OCR 可用性探测缓存。失败只做**限时负缓存**（60s）—— 引擎可能
 * 随部署修复/依赖安装恢复，一次失败锁死整个会话会把语义验证层饿死。
 */
const OCR_RETRY_MS = 60000;
let serverOcrFailedAt = 0;
async function readScreenTextServer(region) {
    if (Date.now() - serverOcrFailedAt < OCR_RETRY_MS)
        return null;
    let tree;
    try {
        tree = await backend.getUiTree({ source: 'ocr', region, funnelCeiling: 'L2' });
    }
    catch {
        serverOcrFailedAt = Date.now();
        return null;
    }
    if (tree.funnel_depth === 'empty' && tree.fault) {
        // L2 引擎缺席/出错 —— 限时负缓存后降级（不锁死）
        serverOcrFailedAt = Date.now();
        return null;
    }
    serverOcrFailedAt = 0;
    const words = tree.elements
        .filter(el => el.source === 'L2-ocr')
        .map(el => ({
        text: el.name,
        // 服务端已按 score≥0.5 过滤；这里给固定置信度（词级分数未跨线传）
        confidence: 90,
        bbox_normalized: {
            x0: el.rect.x, y0: el.rect.y,
            x1: el.rect.x + el.rect.width, y1: el.rect.y + el.rect.height,
        },
        center_normalized: {
            x: el.rect.x + el.rect.width / 2,
            y: el.rect.y + el.rect.height / 2,
        },
    }));
    return { text: words.map(w => w.text).join(' '), words };
}
/**
 * 双路径区域读取：服务端 L2 优先 → legacy tesseract（buffer+sharp）→ 抛错。
 * region 缺省 = 全屏。
 */
export async function readTextAny(region, lang = 'eng') {
    // 1) 服务端 L2
    const server = await readScreenTextServer(region);
    if (server)
        return server;
    // 2) legacy：tesseract.js + sharp（开发仓 / DSH_FORCE_LEGACY_SYSTEM）
    const buf = await backend.captureCleanPng(region);
    return readText(buf, lang);
}
/** legacy 路径：tesseract.js 识别既有 buffer（开发/测试路径，需 sharp+tesseract） */
export async function readText(buffer, lang = 'eng') {
    const worker = await getWorker(lang);
    const { data } = await worker.recognize(buffer);
    const sharp = await getSharp();
    const meta = await sharp(buffer).metadata();
    const W = meta.width, H = meta.height;
    // tesseract v5 的词级输出结构随版本有差异，防御性兼容 words / lines.words
    const anyData = data;
    const rawWords = anyData.words
        ?? anyData.lines?.flatMap((l) => l.words ?? []) ?? [];
    const words = rawWords
        .filter(w => (w.confidence ?? 0) > 60 && w.text?.trim())
        .map(w => {
        const b = w.bbox;
        return {
            text: w.text.trim(),
            confidence: w.confidence,
            bbox_normalized: { x0: b.x0 / W, y0: b.y0 / H, x1: b.x1 / W, y1: b.y1 / H },
            center_normalized: { x: (b.x0 + b.x1) / 2 / W, y: (b.y0 + b.y1) / 2 / H },
        };
    });
    return { text: data.text ?? '', words };
}
/**
 * 语义核对：在动作点邻域内 OCR，检查预期文字是否出现。
 * 大小写/空白不敏感的包含匹配。任何失败返回 null（调用方降级为 ocr-unavailable）。
 * fullBuf 在 D-5 路径下可为 null（服务端 OCR 直接读屏，无需本地解码）。
 */
export async function semanticConfirm(fullBuf, cxPct, cyPct, radiusPct, expected, lang = 'eng') {
    try {
        const left = Math.max(0, cxPct - radiusPct);
        const top = Math.max(0, cyPct - radiusPct);
        const width = Math.min(1 - left, radiusPct * 2);
        const height = Math.min(1 - top, radiusPct * 2);
        if (width < 0.005 || height < 0.005)
            return null;
        const region = { x: left, y: top, width, height };
        let text;
        const server = await readScreenTextServer(region);
        if (server) {
            text = server.text;
        }
        else if (fullBuf && fullBuf.length > 0) {
            // legacy 放大路径：区域裁剪 + resize 1200（小字命中率关键）
            const sharp = await getSharp();
            const meta = await sharp(fullBuf).metadata();
            const W = meta.width, H = meta.height;
            const pxLeft = Math.round(left * W);
            const pxTop = Math.round(top * H);
            const pxW = Math.max(1, Math.round(width * W));
            const pxH = Math.max(1, Math.round(height * H));
            const crop = await sharp(fullBuf)
                .extract({ left: pxLeft, top: pxTop, width: pxW, height: pxH })
                .resize(1200)
                .toBuffer();
            text = (await readText(crop, lang)).text;
        }
        else {
            return null;
        }
        const hay = normalize(text);
        const needle = normalize(expected);
        // R 纪元（R-1 模糊层）：OCR 容错判决 —— 逐字节 includes 在真机 OCR 上必然
        // 漏判（l→1 / O→0 / 吞空格）；编辑距离 ≤ ⌈m/6⌉ 的近似命中取代之。
        return {
            confirmed: hay.includes(needle) || fuzzyIncludes(needle, hay),
            snippet: text.replace(/\s+/g, ' ').trim().slice(0, 120),
        };
    }
    catch {
        return null;
    }
}
