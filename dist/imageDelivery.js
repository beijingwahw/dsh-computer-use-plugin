// src/imageDelivery.ts
// 图像投递层：把截图送进模型的唯一通道（DSH 0.1.0-rc.6 事件面）。
//
// 为什么存在：旧版的 `llm/pre-request` 注入事件在 rc.6 宿主上已不存在
// （事件面重构）——截图只进滑动窗口、模型只看到文本锚点。rc.6 的正道：
//   1. ctx.attachments.saveImage(bytes) → ImageAttachmentRef（附件服务，
//      内容寻址、跨请求持久）
//   2. 工具结果的 render 输出追加 {type:'image', attachment: ref} 内容块
//      —— 工具结果消息是 user 角色，图像块随请求直达模型
//
// 降级：附件服务缺席（宿主未注入）时返回 null，工具只回文本锚点 ——
// 与旧行为一致，绝不阻塞截图主流程。
//
// W3-3（P2+C3 脏矩形增量编码）增补：补丁投递协议 —— 主帧（关键帧）附件 +
// 后续补丁小图附件，锚点文本说明替换关系（「这是同一屏幕的增量」），供 VLM
// 在上下文里重建当前屏幕；模型请求整帧的逃生口（forceFullFrame —— 补丁模式
// 可显式关闭）。缺省不启用：现有投递路径（saveScreenshotAttachment）零变化。
import { encodePatchForVlm } from './vlm/codec.js';
let store = null;
/** index.ts 启动时注入附件服务（缺席 = 宿主未提供，图像投递诚实降级） */
export function setImageDeliveryStore(attachments) {
    store = attachments && typeof attachments.saveImage === 'function'
        ? attachments
        : null;
}
export function imageDeliveryAvailable() {
    return store !== null;
}
/** 保存 JPEG 截图为附件；失败/缺席返回 null（调用方降级为纯文本锚点） */
export async function saveScreenshotAttachment(jpeg, name) {
    if (!store)
        return null;
    try {
        return await store.saveImage({
            data: new Uint8Array(jpeg),
            mediaType: 'image/jpeg',
            name,
        });
    }
    catch {
        return null;
    }
}
/**
 * 工具 render 辅助：解析工具返回的 JSON 值，若携带 image_attachment 则
 * 产出图像内容块（与文本块并列 —— 模型同轮即见文见图）。
 */
export function imageBlockFromValue(value) {
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        const ref = parsed?.image_attachment;
        if (ref && typeof ref.attachmentId === 'string') {
            return [{ type: 'image', attachment: ref }];
        }
    }
    catch { /* 纯文本值 */ }
    return [];
}
/**
 * W3-3：增量投递 —— 账本判决 → 附件 + 锚点文本。
 *
 * 投递协议：
 *   · keyframe（或 forceFullFrame 逃生口）：当前帧整图为附件 + 「这是新的
 *     基准关键帧，后续补丁相对它解释」；
 *   · patch：每块脏矩形经 encodePatchForVlm 原生裁出（小图附件），锚点文本
 *     声明「patch@(x,y,w,h) 替换主帧该区 —— 其余区域自关键帧以来未变」；
 *   · scroll：新入内容条带附件 + 滚动向量文本（「主帧内容下移 Npx，条带补在
 *     顶部/底部」）；
 *   · silent：无附件（屏幕未变 —— 复用上一重建态）。
 *
 * 防御式绝不抛：
 *   · 附件服务缺席（端口缺席）⇒ 返回 null —— 调用方降级为既有的整帧投递
 *     路径（saveScreenshotAttachment），行为与现状一致；
 *   · 补丁编码失败（sharp 缺席/矩形脏值）⇒ 诚实回退整帧投递（degraded 注记）；
 *   · 判决脏值 ⇒ null（不猜）。
 *
 * 模块开关：本函数不读 visualDiff.incremental（调用方在入账前检查
 * incrementalEncodingEnabled —— 账本与投递是同一开关辖下的两个被动件）；
 * forceFullFrame 是单次调用的逃生口（模型请求整帧 / 补丁模式显式关闭）。
 */
export async function deliverIncremental(verdict, currentFrame, opts) {
    try {
        if (!store)
            return null; // 附件服务缺席：调用方降级整帧（端口缺席降级整帧）
        const KINDS = new Set(['keyframe', 'patch', 'scroll', 'silent']);
        if (!verdict || typeof verdict !== 'object' || !KINDS.has(verdict.kind))
            return null; // 脏判决：不猜
        if (!Buffer.isBuffer(currentFrame) || currentFrame.length === 0)
            return null;
        const generation = typeof verdict.generation === 'number' && Number.isFinite(verdict.generation)
            ? Math.max(0, Math.floor(verdict.generation)) : 0;
        // 逃生口 / keyframe / 编码降级回退共用：整帧投递
        const deliverFullFrame = async (degraded) => {
            const attachment = await saveScreenshotAttachment(currentFrame, `keyframe-gen${generation}.jpg`);
            if (!attachment)
                return null; // 附件服务失败：调用方降级纯文本（与现状一致）
            return {
                mode: 'keyframe',
                keyframeAttachment: attachment,
                patchParts: [],
                scrollAttachment: null,
                narration: `[Screen keyframe — generation ${generation}]\n` +
                    'This image is the NEW FULL-SCREEN BASELINE. Subsequent updates will be described as patches against it.\n' +
                    (degraded ? `Note: ${degraded}\n` : '') +
                    'If you need the full screen again later, request a full-frame delivery.',
                degraded,
            };
        };
        if (opts?.forceFullFrame === true) {
            return deliverFullFrame('full frame explicitly requested (patch mode bypassed)');
        }
        if (verdict.kind === 'keyframe') {
            return deliverFullFrame(null);
        }
        if (verdict.kind === 'silent') {
            return {
                mode: 'silent',
                keyframeAttachment: null,
                patchParts: [],
                scrollAttachment: null,
                narration: '[Screen unchanged]\n' +
                    'The screen is visually identical to the last delivered state (keyframe + patches). ' +
                    'Reuse the previous reconstruction; nothing new to see.',
                degraded: null,
            };
        }
        if (verdict.kind === 'scroll') {
            const scroll = verdict.scroll;
            const band = Array.isArray(verdict.patches) ? verdict.patches[0] : undefined;
            if (!scroll || typeof scroll.dyPx !== 'number' || !Number.isFinite(scroll.dyPx) || !band) {
                return deliverFullFrame('scroll verdict missing vector/band — degraded to full frame');
            }
            const encoded = await encodePatchForVlm(currentFrame, band, {
                quality: opts?.patchEncode?.quality,
                maxDimension: opts?.patchEncode?.maxDimension,
                keyframeEncoded: opts?.patchEncode?.keyframeEncoded,
            });
            if (!encoded.ok || !encoded.value) {
                return deliverFullFrame(`scroll band encoding failed (${encoded.error}) — degraded to full frame`);
            }
            const bytes = Buffer.from(encoded.value.base64, 'base64');
            const attachment = await saveScreenshotAttachment(bytes, `scrollband-gen${generation}.jpg`);
            if (!attachment)
                return null;
            const absDy = Math.abs(Math.round(scroll.dyPx));
            const where = scroll.dyPx > 0 ? 'TOP' : 'BOTTOM';
            return {
                mode: 'scroll',
                keyframeAttachment: null,
                patchParts: [],
                scrollAttachment: attachment,
                narration: `[Screen scrolled — generation ${generation}]\n` +
                    `The screen content shifted ${scroll.dyPx > 0 ? 'DOWN' : 'UP'} by ${absDy}px (source pixels).\n` +
                    `Mentally shift your current view of the keyframe${scroll.dyPx > 0 ? ' down' : ' up'} by ${absDy}px, ` +
                    `then place the attached strip (newly revealed content) at the ${where} edge${scroll.dyPx > 0 ? ` (rows 0..${absDy})` : ` (bottom ${absDy} rows)`}.\n` +
                    `Anchor: ${encoded.value.anchorText}`,
                degraded: null,
            };
        }
        // patch 模式：逐块原生裁出 + 锚点文本
        const patches = Array.isArray(verdict.patches) ? verdict.patches : [];
        if (patches.length === 0) {
            return {
                mode: 'silent',
                keyframeAttachment: null,
                patchParts: [],
                scrollAttachment: null,
                narration: '[Screen effectively unchanged — no patches to deliver]',
                degraded: null,
            };
        }
        const parts = [];
        for (let i = 0; i < patches.length; i++) {
            const p = patches[i];
            const encoded = await encodePatchForVlm(currentFrame, p, {
                quality: opts?.patchEncode?.quality,
                maxDimension: opts?.patchEncode?.maxDimension,
                keyframeEncoded: opts?.patchEncode?.keyframeEncoded,
            });
            if (!encoded.ok || !encoded.value) {
                return deliverFullFrame(`patch #${i + 1} encoding failed (${encoded.error}) — degraded to full frame`);
            }
            const bytes = Buffer.from(encoded.value.base64, 'base64');
            const attachment = await saveScreenshotAttachment(bytes, `patch-gen${generation}-${i + 1}.jpg`);
            if (!attachment)
                return null;
            parts.push({
                attachment,
                anchorText: encoded.value.anchorText,
                patch: { x: p.x, y: p.y, w: p.w, h: p.h },
            });
        }
        const lines = parts.map((p, i) => `  ${i + 1}. ${p.anchorText}`).join('\n');
        return {
            mode: 'patch',
            keyframeAttachment: null,
            patchParts: parts,
            scrollAttachment: null,
            narration: `[Incremental screen update — generation ${generation}, ${parts.length} patch(es)]\n` +
                'The attached small image(s) are PATCHES of the SAME screen, not new screens.\n' +
                'Reconstruct the current screen = keyframe + apply each patch:\n' + lines + '\n' +
                'Regions not covered by any patch are UNCHANGED since the keyframe. ' +
                'Ground coordinates against the FULL reconstructed screen.\n' +
                'Need the full screen again? Request a full-frame delivery.',
            degraded: null,
        };
    }
    catch {
        return null; // 防御式收口：任何意外降级为 null（调用方走整帧旧路径）
    }
}
