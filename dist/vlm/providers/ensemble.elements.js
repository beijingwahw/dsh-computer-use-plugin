import { arbitrateElements } from '../arbitration.js';
// ─── 内部：元素方言归一（askElements 的逐家规整层） ───
/** label 兜底与截断上限（对齐 grounding.ts 的防注入纪律） */
const LABEL_FALLBACK = '未知元素';
const LABEL_MAX = 80;
const ROLE_FALLBACK = 'unknown';
const ROLE_MAX = 24;
/** VLM 未给 confidence 时的中性记账值（对齐 grounding.ts） */
const DEFAULT_CONFIDENCE = 0.5;
/** bbox 双形态解析：[x0,y0,x1,y1] 数组或 {x0,y0,x1,y1} 对象 → 对象；非法 ⇒ null（不做 clamp） */
function parseBbox(raw) {
    let ns;
    if (Array.isArray(raw)) {
        if (raw.length < 4)
            return null;
        ns = [raw[0], raw[1], raw[2], raw[3]];
    }
    else if (raw !== null && typeof raw === 'object') {
        const o = raw;
        ns = [o.x0, o.y0, o.x1, o.y1];
    }
    else {
        return null;
    }
    if (!ns.every(v => typeof v === 'number' && Number.isFinite(v)))
        return null;
    return { x0: ns[0], y0: ns[1], x1: ns[2], y1: ns[3] };
}
/** 字符串兜底：非字符串/空白 → fallback；超长截断（防注入纪律） */
function strOr(raw, fallback, max) {
    if (typeof raw !== 'string')
        return fallback;
    const s = raw.trim();
    return s.length === 0 ? fallback : s.slice(0, max);
}
/** confidence 兜底：非有限数字 → 中性 0.5；数字夹 [0,1]（越界值不外溢） */
export function confOr(raw) {
    if (typeof raw !== 'number' || !Number.isFinite(raw))
        return DEFAULT_CONFIDENCE;
    return Math.min(1, Math.max(0, raw));
}
/**
 * 逐家元素归一：成员 chatJson 载荷的 elements 数组 → 仓库标准 GroundedElement[]。
 * 规整律（与 grounding.ts 同调，但不做 clamp / NMS —— 交由 arbitrateElements 配对）：
 *   - bbox 数组/对象双形态转 {x0,y0,x1,y1} 像素对象，非法元素整条丢弃（宁可少报）；
 *   - id 归一 'e1'.. 序号；label/role 兜底 + 截断；confidence 夹 [0,1] 缺省 0.5；
 *   - center 取 bbox 中点；source 恒 'vlm'（本庭成员全是云脑信道）。
 */
export function normalizeElements(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const item of raw) {
        if (item === null || typeof item !== 'object')
            continue;
        const o = item;
        const bbox = parseBbox(o.bbox);
        if (bbox === null)
            continue;
        out.push({
            id: `e${out.length + 1}`,
            label: strOr(o.label ?? o.name, LABEL_FALLBACK, LABEL_MAX),
            role: strOr(o.role ?? o.type, ROLE_FALLBACK, ROLE_MAX),
            bbox,
            center: { x: (bbox.x0 + bbox.x1) / 2, y: (bbox.y0 + bbox.y1) / 2 },
            confidence: confOr(o.confidence),
            source: 'vlm',
        });
    }
    return out;
}
/** 四坐标精确相等（arbitrateElements 对未配对元素 bbox 原样直通 —— 可作身份指纹） */
function sameBbox(a, b) {
    return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
}
/**
 * 两家元素经真 arbitrateElements 融合（vlm 源语义）：acc 为左席（vlm 侧）、
 * next 为右席（local 侧 —— GroundedElement 结构上满足 LocalElement 三测度）。
 * 仲裁输出回映 GroundedElement：前 acc.length 个输出与 acc 按序一一对应
 * （融合或直通，role 原位继承 acc）；其后追加的右席单源元素 bbox 原样直通，
 * 以 bbox 指纹回查 next 找回 role（查无兜底 'unknown'）。id 统一重排 'e1'..。
 * ΝΩ-47：opts 透传 arbitrateElements 的融合置信模式（fuseMode 'classic' 缺省
 * 旧行为 / 'loglinear' 连折有界累积）与已折家数（foldedFamilies —— askElements
 * 累进折叠时供加成衰减因子；缺省 2 = 单对融合，零行为变化）。
 */
export function fusePair(acc, next, opts) {
    const verdict = arbitrateElements(acc, next, {
        ...(opts?.fuseMode !== undefined ? { fuseMode: opts.fuseMode } : {}),
        ...(opts?.foldedFamilies !== undefined ? { foldedFamilies: opts.foldedFamilies } : {}),
    });
    return verdict.elements.map((el, i) => {
        let role;
        if (i < acc.length) {
            role = acc[i].role; // 左席位序保持 —— 融合/直通均原位继承
        }
        else {
            const hit = next.find(n => sameBbox(n.bbox, el.bbox));
            role = hit !== undefined ? hit.role : ROLE_FALLBACK;
        }
        return {
            id: `e${i + 1}`,
            label: el.label,
            role,
            bbox: el.bbox,
            center: el.center,
            confidence: Math.min(1, Math.max(0, el.confidence)),
            source: 'vlm',
        };
    });
}
