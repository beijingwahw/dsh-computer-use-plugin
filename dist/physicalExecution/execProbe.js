/** Result 臂的运行时形状卫兵（防假 adapter / 协议漂移 —— 绝不信任外部形状） */
function isResultLike(v) {
    return (typeof v === 'object' && v !== null &&
        typeof v.ok === 'boolean');
}
/** 字符串指纹卫兵：非空字符串才可信（空串 = 无指纹，绝不充数） */
function hashOrNone(v) {
    return typeof v === 'string' && v.trim() !== '' ? v : null;
}
/** 有限正数卫兵（维度/帧 id 的消毒） */
function finiteNumOr(v, fallback) {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
/**
 * W1-1：把 PhysicalExecutionAdapter 铸成执行层世界探针。
 * 生产接线位（集成阶段）：`createExecute({ ..., probe: createExecWorldProbe(adapter) })`。
 * 每个方法：Result 失败臂 / 异常 / 形状不符 ⇒ null —— 探针失败绝不阻塞主路径。
 */
export function createExecWorldProbe(adapter) {
    const hitTestPoint = async (px, py) => {
        try {
            const r = await adapter.hitTest({ x: px, y: py });
            if (!isResultLike(r) || !r.ok)
                return null;
            const h = r.value;
            if (!h || typeof h !== 'object')
                return null;
            const cls = h.classification;
            return {
                available: h.available === true,
                classification: cls === 'control' || cls === 'text' || cls === 'unknown' ? cls : 'unavailable',
                controlType: typeof h.control_type === 'string' && h.control_type !== '' ? h.control_type : null,
            };
        }
        catch {
            return null;
        }
    };
    const cursorKind = async () => {
        try {
            const r = await adapter.getCursorKind();
            if (!isResultLike(r) || !r.ok)
                return null;
            const k = r.value;
            return typeof k?.kind === 'string' && k.kind !== '' ? k.kind : null;
        }
        catch {
            return null;
        }
    };
    const sampleFrame = async (opts) => {
        try {
            const r = await adapter.takeScreenshot({
                metaOnly: true,
                wantHashes: true,
                keepFrame: opts?.keepFrame === true,
                // undefined ⇒ JSON 序列化丢键 ⇒ 请求字节与现状等同（兼容铁律）
                wantRegionHash: opts?.wantRegionHash,
            });
            if (!isResultLike(r) || !r.ok)
                return null;
            const s = r.value;
            if (!s || typeof s !== 'object')
                return null;
            return {
                dhash: hashOrNone(s.dhash),
                regionDhash: hashOrNone(s.region_dhash),
                frameId: typeof s.frame_id === 'number' && Number.isFinite(s.frame_id) ? s.frame_id : null,
                width: finiteNumOr(s.width, 0),
                height: finiteNumOr(s.height, 0),
            };
        }
        catch {
            return null;
        }
    };
    const frameDiff = async (frameA, frameB) => {
        try {
            const r = await adapter.frameDiff({ frameA, frameB });
            if (!isResultLike(r) || !r.ok)
                return null;
            const v = r.value;
            if (!v || !Array.isArray(v.changed_regions))
                return null;
            const regions = [];
            for (const raw of v.changed_regions) {
                if (!raw || typeof raw !== 'object')
                    continue;
                const g = raw;
                const { x, y, width, height } = g;
                if ([x, y, width, height].every(n => typeof n === 'number' && Number.isFinite(n)) &&
                    width > 0 && height > 0) {
                    regions.push({ x: x, y: y, width: width, height: height });
                }
            }
            return regions;
        }
        catch {
            return null;
        }
    };
    const frameRowMeans = async (frameId, grid) => {
        try {
            const r = await adapter.frameRowmeans(frameId, grid ?? 64);
            if (!isResultLike(r) || !r.ok)
                return null;
            const rows = r.value?.rows;
            if (!Array.isArray(rows) ||
                rows.length === 0 ||
                !rows.every(n => typeof n === 'number' && Number.isFinite(n))) {
                return null;
            }
            return rows;
        }
        catch {
            return null;
        }
    };
    return { hitTestPoint, cursorKind, sampleFrame, frameDiff, frameRowMeans };
}
