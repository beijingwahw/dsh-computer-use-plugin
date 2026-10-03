// src/vlm/codec.ts
// 纪元 Ω（Ω-2）：GLM-5.3-Flash 云脑皮层 —— VLM 图像编码 / 任务级配额 / 视觉 Token 估算。
//
// 职责（兄弟模块按精确契约依赖，签名一字不可偏离）：
//   1. encodeForVlm：任意截图 Buffer → VLM 最佳分辨率带宽内的 base64 JPEG
//      （长边默认 1568；可选像素坐标兴趣区先裁剪再编码）
//   2. VlmBudget：任务级视觉预算闸门（默认 200 张 / 512MB），check/commit
//      两段式 —— 超支在下发前被拒绝，而非事后补救
//   3. estimateVlmTokens：分辨率 → 视觉 Token 估算（宽高各封顶 2000 后
//      (w*h)/750 向上取整）—— 上下文窗口的记账尺
//
// 依赖纪律：sharp 经 src/_legacyDeps.ts 懒加载（复用 textReader.ts 先例，
// 批次 E 模式，不新增 npm 依赖）；sharp 不可用时走降级路径 —— 返回
// {ok:false,error}，**绝不抛错**：云脑缺席不能带崩本地反射层。
import { getSharp } from '../_legacyDeps.js';
import { kernelRegistry } from '../kernel/registry.js';
/** VLM 最佳分辨率带宽：长边超过则等比缩小（细节分辨率与视觉 Token 的平衡点） */
const DEFAULT_MAX_DIMENSION = 1568;
/** JPEG 默认质量（80：UI 文字边缘清晰且体积可控） */
const DEFAULT_QUALITY = 80;
/** 任务级默认配额：200 张 / 512MB（云脑单任务的视觉预算上限） */
const DEFAULT_MAX_IMAGES = 200;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
/** 字节规整：非有限/负值按 0 记（防御外部记账脏数据，绝不抛错） */
function cleanBytes(n) {
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}
/**
 * 把截图编码为 VLM 就绪的 base64 JPEG。
 * 管线（顺序固定）：可选像素坐标裁剪（先）→ 长边超限时等比缩小（后）→
 * JPEG(quality)。strategy 记录实际采用的策略；width/height 为**编码输出**
 * 的实际尺寸（裁剪/缩放之后），bytes 为 JPEG 二进制字节数。
 *
 * 失败路径一律返回 {ok:false,error}，绝不抛错：空 Buffer、非法 opts
 * （maxDimension<1 / quality 越界）、非法 region（x1<=x0 / 负坐标 / 越界）、
 * sharp 不可用（降级路径）、缓冲区不可解码。
 */
export async function encodeForVlm(buffer, opts) {
    try {
        if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
            return { ok: false, error: 'encodeForVlm: empty buffer (nothing to encode)' };
        }
        const rawDim = opts?.maxDimension;
        if (rawDim !== undefined && (!Number.isFinite(rawDim) || rawDim < 1)) {
            return { ok: false, error: `encodeForVlm: invalid maxDimension=${String(rawDim)} (need finite >= 1)` };
        }
        const rawQuality = opts?.quality;
        if (rawQuality !== undefined && (!Number.isFinite(rawQuality) || rawQuality < 1 || rawQuality > 100)) {
            return { ok: false, error: `encodeForVlm: invalid quality=${String(rawQuality)} (need 1-100)` };
        }
        // 纪元 Ξ（Ξ-D 生产接线）：缺省单点读内核注册表 —— codec.maxDim（缺省
        // 1568，区间 512..4096）/ codec.quality（缺省 80，区间 50..95）。显式
        // 入参恒压过注册表；未注册 ⇒ getOrDefault 回声常量，六个调用方的缺省
        // 路径逐字节不变（本 ?? 缺省缝是唯一的缺省求值点）。
        const maxDimension = Math.round(rawDim ?? kernelRegistry.getOrDefault('codec.maxDim', DEFAULT_MAX_DIMENSION));
        const quality = Math.round(rawQuality ?? kernelRegistry.getOrDefault('codec.quality', DEFAULT_QUALITY));
        // sharp 懒加载：缺席 = 云脑编码降级路径，诚实报错而不抛出
        let sharp;
        try {
            sharp = await getSharp();
        }
        catch (e) {
            return { ok: false, error: `sharp unavailable for VLM encoding: ${e?.message ?? String(e)}` };
        }
        let W = 0;
        let H = 0;
        try {
            const meta = await sharp(buffer).metadata();
            W = meta.width ?? 0;
            H = meta.height ?? 0;
        }
        catch (e) {
            return { ok: false, error: `cannot decode image: ${e?.message ?? String(e)}` };
        }
        if (W < 1 || H < 1) {
            return { ok: false, error: `image has no usable dimensions (${W}x${H})` };
        }
        // 兴趣区校验 + 取整（浮点像素坐标 → sharp extract 需要的整数矩形）
        let crop = null;
        const region = opts?.region;
        if (region) {
            const { x0, y0, x1, y1 } = region;
            if (![x0, y0, x1, y1].every(Number.isFinite)) {
                return { ok: false, error: 'invalid region: coordinates must be finite numbers' };
            }
            if (x1 <= x0 || y1 <= y0) {
                return { ok: false, error: `invalid region: need x1>x0 and y1>y0 (got (${x0},${y0})..(${x1},${y1}))` };
            }
            if (x0 < 0 || y0 < 0) {
                return { ok: false, error: `invalid region: negative origin (${x0},${y0})` };
            }
            if (x1 > W || y1 > H) {
                return { ok: false, error: `invalid region: exceeds image bounds ${W}x${H} (x1=${x1}, y1=${y1})` };
            }
            crop = {
                left: Math.round(x0),
                top: Math.round(y0),
                width: Math.max(1, Math.round(x1) - Math.round(x0)),
                height: Math.max(1, Math.round(y1) - Math.round(y0)),
            };
        }
        // 管线：flatten（JPEG 无 alpha：透明像素压白底，防黑底黑字对 VLM 不可读）
        // → crop → resize → jpeg。flatten 未纳入批次 E 的 SharpChainLike 结构类型，
        // 运行时防御性探测（缺席则跳过，sharp 自会把 alpha 压到默认底色）。
        const srcW = crop ? crop.width : W;
        const srcH = crop ? crop.height : H;
        let pipe = sharp(buffer);
        const flatten = pipe.flatten;
        if (typeof flatten === 'function') {
            pipe = flatten.call(pipe, { background: '#ffffff' });
        }
        if (crop)
            pipe = pipe.extract(crop);
        let resized = false;
        const longEdge = Math.max(srcW, srcH);
        if (longEdge > maxDimension) {
            resized = true;
            // 长边钉在 maxDimension，短边等比四舍五入；fit:'fill' 保证输出尺寸精确可断言
            const tw = srcW >= srcH
                ? maxDimension
                : Math.max(1, Math.round((srcW * maxDimension) / longEdge));
            const th = srcH > srcW
                ? maxDimension
                : Math.max(1, Math.round((srcH * maxDimension) / longEdge));
            pipe = pipe.resize({ width: tw, height: th, fit: 'fill' });
        }
        // toBuffer 的结构类型首选 Promise<Buffer> 重载，这里经 unknown 中转断言
        // resolveWithObject 形态（真实 sharp 返回 {data, info}）
        const out = (await pipe
            .jpeg({ quality })
            .toBuffer({ resolveWithObject: true }));
        const data = Buffer.from(out.data);
        const outW = out.info?.width ?? srcW;
        const outH = out.info?.height ?? srcH;
        const strategy = crop
            ? (resized ? 'crop+resize' : 'crop')
            : (resized ? `resize-${maxDimension}` : 'as-is');
        return {
            ok: true,
            value: {
                base64: data.toString('base64'),
                mime: 'image/jpeg',
                width: outW,
                height: outH,
                bytes: data.length,
                strategy,
            },
        };
    }
    catch (e) {
        return { ok: false, error: `encodeForVlm failed: ${e?.message ?? String(e)}` };
    }
}
/**
 * 任务级视觉配额闸门：check（只读试探）→ commit（真正记账）两段式。
 * check 返回当前用量快照（usedImages/usedBytes 为**本次之前**的累计），
 * 超限时 allowed:false 且 reason 说明原因（张数与字节可能同时超限，reason
 * 以 '; ' 连接）。所有方法对脏输入（NaN/负数/缺字段）安全，绝不抛错。
 */
export class VlmBudget {
    maxImages;
    maxBytes;
    usedImages = 0;
    usedBytes = 0;
    constructor(opts) {
        const rawImages = opts?.maxImagesPerTask;
        const rawBytes = opts?.maxBytesPerTask;
        this.maxImages = typeof rawImages === 'number' && Number.isFinite(rawImages)
            ? Math.max(0, Math.floor(rawImages))
            : DEFAULT_MAX_IMAGES;
        this.maxBytes = typeof rawBytes === 'number' && Number.isFinite(rawBytes)
            ? Math.max(0, Math.floor(rawBytes))
            : DEFAULT_MAX_BYTES;
    }
    /** 只读试探：这张图还允不允许下发？不改变任何用量状态 */
    check(encoded) {
        const bytes = cleanBytes(encoded?.bytes);
        const reasons = [];
        if (this.usedImages + 1 > this.maxImages) {
            reasons.push(`image quota exceeded: ${this.usedImages}+1 > ${this.maxImages} (maxImagesPerTask)`);
        }
        if (this.usedBytes + bytes > this.maxBytes) {
            reasons.push(`byte quota exceeded: ${this.usedBytes}+${bytes} > ${this.maxBytes} (maxBytesPerTask)`);
        }
        return {
            allowed: reasons.length === 0,
            reason: reasons.length > 0 ? reasons.join('; ') : undefined,
            usedImages: this.usedImages,
            usedBytes: this.usedBytes,
        };
    }
    /** 真正记账：张数 +1、字节累计（先 check 后 commit 是调用方的纪律） */
    commit(encoded) {
        this.usedImages += 1;
        this.usedBytes += cleanBytes(encoded?.bytes);
    }
    /** 清零用量（新任务开始时复用同一闸门实例） */
    reset() {
        this.usedImages = 0;
        this.usedBytes = 0;
    }
    /** 用量与上限快照 */
    summary() {
        return {
            usedImages: this.usedImages,
            usedBytes: this.usedBytes,
            maxImages: this.maxImages,
            maxBytes: this.maxBytes,
        };
    }
}
/**
 * 视觉 Token 估算：宽、高各先封顶 2000（超出 2000 的分辨率对估算无增益 ——
 * 上游已按 maxDimension 缩放进带宽），再 (w*h)/750 向上取整。
 * 非有限/负值按 0 记；对宽、高各自单调不减。
 */
export function estimateVlmTokens(width, height) {
    const clamp = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.min(2000, n) : 0;
    const w = clamp(width);
    const h = clamp(height);
    return Math.ceil((w * h) / 750);
}
