// src/intent.ts
// C-1 意图感知验证引擎之魂：极简「物理规则引擎」。
// 让 Agent 拥有物理常识 —— 不读文字也能判断操作成败：
//   复选框点击 ⇒ 对勾出现 = 点击邻域对比度（细节丰富度）上升
//   菜单展开 ⇒ 点击点下方冒出新亮区
//   滚动 ⇒ 内容平移 = 行亮度序列错位匹配
//   输入聚焦 ⇒ 光标邻域微变而大邻域静止
// 每条规则 ≤30 行纯视觉启发式；规则表数据驱动注册，config 可裁剪（禁止硬编码红线）。
// 这是从「被动检测变化」到「主动验证意图」的升维：验证器带着预期找证据。
import sharp from 'sharp';
/** 平移检测的缩放网格边长（8×8=64 行亮度签名）—— 与 dHash 网格维度同源 */
const SHIFT_GRID = 64;
// ─── 视觉度量原语（规则共用） ───
/** 区域统计：均值（亮度）与标准差（细节丰富度/对比度） */
async function regionStats(buf, region) {
    const stats = await sharp(buf).extract(region).stats();
    const mean = stats.channels.reduce((n, c) => n + c.mean, 0) / stats.channels.length;
    const stdev = stats.channels.reduce((n, c) => n + c.stdev, 0) / stats.channels.length;
    return { mean, stdev };
}
/** 以归一化点为中心的像素裁剪框（越界夹取） */
async function focusRegion(buf, x, y, radius) {
    const meta = await sharp(buf).metadata();
    const W = meta.width, H = meta.height;
    const rx = Math.max(8, Math.round(radius * W));
    const ry = Math.max(8, Math.round(radius * H));
    const left = Math.max(0, Math.round(x * W) - rx);
    const top = Math.max(0, Math.round(y * H) - ry);
    return {
        left, top,
        width: Math.min(W - left, rx * 2),
        height: Math.min(H - top, ry * 2),
    };
}
// ─── 物理规则实现（每条编码一个物理直觉） ───
/** 对勾/选中标记是高对比度细节：邻域标准差上升 ⇒ 细节增多 */
const toggleOn = {
    kind: 'toggle_on',
    async check(ctx) {
        if (!ctx.focus)
            return { satisfied: false, evidence: 'no focus point', notApplicable: true };
        const r = await focusRegion(ctx.afterBuf, ctx.focus.x, ctx.focus.y, ctx.regionRadius);
        const [before, after] = await Promise.all([
            regionStats(ctx.beforeBuf, r), regionStats(ctx.afterBuf, r),
        ]);
        const detailGain = after.stdev - before.stdev;
        return {
            satisfied: detailGain > 2,
            evidence: `local detail ${before.stdev.toFixed(1)}→${after.stdev.toFixed(1)} ` +
                `(${detailGain > 2 ? 'check-mark-like detail appeared' : 'below threshold'})`,
        };
    },
};
const toggleOff = {
    kind: 'toggle_off',
    async check(ctx) {
        if (!ctx.focus)
            return { satisfied: false, evidence: 'no focus point', notApplicable: true };
        const r = await focusRegion(ctx.afterBuf, ctx.focus.x, ctx.focus.y, ctx.regionRadius);
        const [before, after] = await Promise.all([
            regionStats(ctx.beforeBuf, r), regionStats(ctx.afterBuf, r),
        ]);
        const detailLoss = before.stdev - after.stdev;
        return {
            satisfied: detailLoss > 2,
            evidence: `local detail ${before.stdev.toFixed(1)}→${after.stdev.toFixed(1)} ` +
                `(${detailLoss > 2 ? 'detail vanished as expected' : 'insufficient detail loss'})`,
        };
    },
};
/** 菜单/下拉展开 = 点击点下方冒出新内容区：下方带亮度或细节显著变化 */
const menuExpand = {
    kind: 'menu_expand',
    async check(ctx) {
        if (!ctx.focus)
            return { satisfied: false, evidence: 'no focus point', notApplicable: true };
        const afterMeta = await sharp(ctx.afterBuf).metadata();
        const W = afterMeta.width, H = afterMeta.height;
        const cx = ctx.focus.x * W, cy = ctx.focus.y * H;
        const depth = Math.max(8, Math.round(ctx.regionRadius * H * 2));
        const left = Math.max(0, Math.round(cx - ctx.regionRadius * W));
        const top = Math.min(H - 8, Math.round(cy + ctx.regionRadius * H * 0.3));
        const region = {
            left, top,
            width: Math.min(W - left, Math.round(ctx.regionRadius * W * 2)),
            height: Math.min(H - top, depth),
        };
        const [before, after] = await Promise.all([
            regionStats(ctx.beforeBuf, region), regionStats(ctx.afterBuf, region),
        ]);
        const changed = Math.abs(after.mean - before.mean) > 3 || Math.abs(after.stdev - before.stdev) > 4;
        return {
            satisfied: changed,
            evidence: `below-click zone ${changed ? 'changed' : 'static'} ` +
                `(brightness ${before.mean.toFixed(0)}→${after.mean.toFixed(0)}, detail ${before.stdev.toFixed(1)}→${after.stdev.toFixed(1)})`,
        };
    },
};
const menuCollapse = {
    kind: 'menu_collapse',
    async check(ctx) {
        const verdict = await menuExpand.check(ctx);
        return {
            satisfied: !verdict.satisfied,
            evidence: `menu area ${verdict.satisfied ? 'still changing (not collapsed)' : 'settled (collapsed)'}: ${verdict.evidence}`,
        };
    },
};
/**
 * 内容平移检测：把前后两帧各缩为 64 行亮度序列，找最优垂直错位量。
 * 正 shift = after 内容相对 before 下移；负 = 上移。这是滚动/拖拽的纯视觉签名。
 */
async function detectShift(ctx) {
    const rowMeans = async (buf) => {
        const { data, info } = await sharp(buf)
            .grayscale().resize(SHIFT_GRID, SHIFT_GRID, { fit: 'fill' }).raw()
            .toBuffer({ resolveWithObject: true });
        const rows = [];
        for (let y = 0; y < info.height; y++) {
            let s = 0;
            for (let x = 0; x < info.width; x++)
                s += data[y * info.width + x];
            rows.push(s / info.width);
        }
        return rows;
    };
    const A = await rowMeans(ctx.beforeBuf);
    const B = await rowMeans(ctx.afterBuf);
    let bestShift = 0, bestErr = Infinity;
    for (let s = -8; s <= 8; s++) {
        let err = 0, n = 0;
        for (let y = 0; y < SHIFT_GRID; y++) {
            const y2 = y + s;
            if (y2 < 0 || y2 >= SHIFT_GRID)
                continue;
            err += Math.abs(A[y] - B[y2]);
            n++;
        }
        if (n > 0 && err / n < bestErr) {
            bestErr = err / n;
            bestShift = s;
        }
    }
    return bestShift;
}
/** 内容上移 = 用户向下滚动看到新内容（after 行序列相对 before 上移） */
const scrollContentUp = {
    kind: 'scroll_content_up',
    async check(ctx) {
        const s = await detectShift(ctx);
        return {
            satisfied: s <= -2,
            evidence: `content shifted ${s <= -2 ? 'upward' : s >= 2 ? 'downward (opposite of expectation)' : 'negligibly'} (row offset ${s})`,
        };
    },
};
const scrollContentDown = {
    kind: 'scroll_content_down',
    async check(ctx) {
        const s = await detectShift(ctx);
        return {
            satisfied: s >= 2,
            evidence: `content shifted ${s >= 2 ? 'downward' : s <= -2 ? 'upward (opposite of expectation)' : 'negligibly'} (row offset ${s})`,
        };
    },
};
/** 输入聚焦：光标出现/边框高亮 = 极小邻域微变但大邻域静止 */
const inputFocus = {
    kind: 'input_focus',
    async check(ctx) {
        if (!ctx.focus)
            return { satisfied: false, evidence: 'no focus point', notApplicable: true };
        const rSmall = await focusRegion(ctx.afterBuf, ctx.focus.x, ctx.focus.y, ctx.regionRadius * 0.4);
        const rLarge = await focusRegion(ctx.afterBuf, ctx.focus.x, ctx.focus.y, ctx.regionRadius * 2.5);
        const [sBefore, sAfter, lBefore, lAfter] = await Promise.all([
            regionStats(ctx.beforeBuf, rSmall), regionStats(ctx.afterBuf, rSmall),
            regionStats(ctx.beforeBuf, rLarge), regionStats(ctx.afterBuf, rLarge),
        ]);
        const localChanged = Math.abs(sAfter.stdev - sBefore.stdev) > 1 || Math.abs(sAfter.mean - sBefore.mean) > 2;
        const largeStatic = Math.abs(lAfter.mean - lBefore.mean) < 6;
        return {
            satisfied: localChanged && largeStatic,
            evidence: `cursor zone ${localChanged ? 'micro-changed' : 'static'} while surroundings ${largeStatic ? 'static' : 'changed'} — ` +
                `${localChanged && largeStatic ? 'consistent with caret/focus appearance' : 'not a focus-like change'}`,
        };
    },
};
/** 规则注册表：数据驱动的单一事实源 */
const RULES = {
    toggle_on: toggleOn,
    toggle_off: toggleOff,
    menu_expand: menuExpand,
    menu_collapse: menuCollapse,
    scroll_content_up: scrollContentUp,
    scroll_content_down: scrollContentDown,
    input_focus: inputFocus,
};
/** 语义/委托类 kind：物理引擎不裁决，由既有通道处理 */
const NON_PHYSICS_KINDS = new Set(['text_appear', 'text_vanish', 'page_navigate', 'any_change']);
/**
 * 按配置取用启用的规则。
 * @param enabledKinds 逗号分隔的启用清单；空串 = 全部启用；未注册的 kind 静默忽略
 */
export function getEnabledPhysicsRules(enabledKinds) {
    const out = new Map();
    const allow = enabledKinds.split(',').map(s => s.trim()).filter(Boolean);
    for (const [kind, rule] of Object.entries(RULES)) {
        if (allow.length === 0 || allow.includes(kind))
            out.set(kind, rule);
    }
    return out;
}
/** 解析工具参数中的期望声明（JSON 字符串或简写 kind 字符串） */
export function parseExpectation(raw) {
    if (!raw)
        return null;
    const s = raw.trim();
    if (!s)
        return null;
    try {
        const obj = JSON.parse(s);
        if (obj && typeof obj.kind === 'string') {
            // 无 text 时省键而非置 undefined —— 结构稳定，deepEqual/canonical 双友好
            return {
                kind: obj.kind,
                ...(typeof obj.text === 'string' ? { text: obj.text } : {}),
            };
        }
    }
    catch { /* 非 JSON：尝试整串作为 kind 简写 */ }
    if (s in RULES || NON_PHYSICS_KINDS.has(s)) {
        return { kind: s };
    }
    return null;
}
