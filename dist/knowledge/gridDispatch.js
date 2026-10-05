// ─── 网格分区铸造（'g{col}x{row}' —— D-6 坐标同一性方案复刻，跨轮稳定）───
// exempt(ΝΩ-41 BC-5)：与 orchestration/pipeline.helpers.ts 同体有意双份（knowledge 与 orchestration 互不 import 的器官边界律，行为由 D-6 同一性测试锁定）—— 知情申报
// ΠΑΝ-127：件内私有（下沉前即 stations 私有函数 —— 不新增导出面，wiring census 零新孤）。
function gridRegions(grid) {
    const regions = [];
    for (let col = 0; col < grid.cols; col++) {
        for (let row = 0; row < grid.rows; row++) {
            regions.push({
                id: `g${col}x${row}`,
                x: col / grid.cols, y: row / grid.rows,
                width: 1 / grid.cols, height: 1 / grid.rows,
            });
        }
    }
    return regions;
}
/** 故障补丁铸造：扫描失败 ≠ 真空（两种空，两种决策 —— 对齐 D-6 ScenePatch.fault 契约）。
 *  导出：D-5 微服务感知端口（d7HostPort）同方言复用 —— 感知失败的形状全机体统一。 */
export function faultPatches(grid, detail) {
    const capturedAt = Date.now();
    return gridRegions(grid).map(region => ({
        region,
        elements: [],
        funnelDepth: 'empty',
        fault: { source: 'L1', detail },
        capturedAt,
    }));
}
/** 感知分派公用件：归一化元素（中心落区即入区）→ 网格分区补丁。
 *  capability 源（本机 a11y/OCR）与 D-5 微服务源（远端 UI 树）共用同一分派律 ——
 *  'g{col}x{row}' 坐标同一性方言跨源稳定。
 *  分派语义：半开区间 [x0, x1) —— 中心恰落在格线上归属右侧分区（最右/最下
 *  边缘夹回末区）。双闭区间会把居中元素（中心恰为 0.5）重复派进两个分区，
 *  破坏 reflexArc 的最优/次优区分与 deliberate 的亚军比较。 */
export function dispatchElementsToGrid(els, grid, depth, sourceLabel) {
    const capturedAt = Date.now();
    const byRegion = new Map();
    for (const e of els) {
        const col = Math.max(0, Math.min(grid.cols - 1, Math.floor((e.rect.x + e.rect.width / 2) * grid.cols)));
        const row = Math.max(0, Math.min(grid.rows - 1, Math.floor((e.rect.y + e.rect.height / 2) * grid.rows)));
        const id = `g${col}x${row}`;
        const bucket = byRegion.get(id);
        if (bucket)
            bucket.push(e);
        else
            byRegion.set(id, [e]);
    }
    return gridRegions(grid).map(region => {
        const inRegion = byRegion.get(region.id) ?? [];
        return {
            region,
            elements: inRegion.map(e => ({ source: sourceLabel, ...e })),
            funnelDepth: inRegion.length > 0 ? depth : 'empty',
            capturedAt,
        };
    });
}
