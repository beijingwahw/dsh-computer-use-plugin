/** 数值卫兵：非有限数 ⇒ 0（clampBbox 的私有卫兵，随件同迁） */
const finiteOr0 = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/**
 * 纯函数：把 bbox 夹回 [0,width]×[0,height] 图内，并保证 x1>x0、y1>y0。
 * 倒置坐标（VLM 偶发 x0>x1）先交换；压扁/贴边的零面积盒扩为 1px；
 * 最终 floor(x0)/ceil(x1) 整数化 —— 整数盒**包含**原浮点盒且不出图。
 */
export function clampBbox(bbox, width, height) {
    const w = Number.isFinite(width) && width >= 1 ? Math.floor(width) : 1;
    const h = Number.isFinite(height) && height >= 1 ? Math.floor(height) : 1;
    const src = (bbox && typeof bbox === 'object' ? bbox : {});
    let x0 = Math.min(Math.max(finiteOr0(src.x0), 0), w);
    let y0 = Math.min(Math.max(finiteOr0(src.y0), 0), h);
    let x1 = Math.min(Math.max(finiteOr0(src.x1), 0), w);
    let y1 = Math.min(Math.max(finiteOr0(src.y1), 0), h);
    if (x1 < x0) {
        const t = x0;
        x0 = x1;
        x1 = t;
    } // 倒置交换
    if (y1 < y0) {
        const t = y0;
        y0 = y1;
        y1 = t;
    }
    let rx0 = Math.floor(x0), ry0 = Math.floor(y0);
    let rx1 = Math.ceil(x1), ry1 = Math.ceil(y1);
    if (rx1 <= rx0) {
        rx0 = Math.min(rx0, w - 1);
        rx1 = rx0 + 1;
    } // 零面积 → 1px
    if (ry1 <= ry0) {
        ry0 = Math.min(ry0, h - 1);
        ry1 = ry0 + 1;
    }
    return { x0: rx0, y0: ry0, x1: rx1, y1: ry1 };
}
