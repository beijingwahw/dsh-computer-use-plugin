/**
 * dump 返回值 → 失败记录数组（纯函数，绝不抛）：双方言防御 ——
 * {records: 数组}（failureMemory.dump 的形状）取 records；裸数组（测试直投
 * FailureRecord[]/DreamFailureTrajectory[]）原样；其余垃圾 ⇒ []。
 * 记录条目自身的净化归 dreamTrajectories（同一净化律 —— 无 id 的轨迹不成梦）。
 */
function recordsOf(dump) {
    if (Array.isArray(dump))
        return dump;
    if (dump && typeof dump === 'object') {
        const rs = dump.records;
        if (Array.isArray(rs))
            return rs;
    }
    return [];
}
/**
 * W8（D-B4）: 梦 deps 铸造 —— 组合根一行接线的可复用面：
 *
 *   dream: createDreamDeps({ dumpFailures: () => failureMemory.dump() })
 *
 * 缺省零漂移：本工装只有被组合根接进 SleepDeps 才生效；生产接线位于
 * src/index.ts 卸载路径的 enableSleepCycle（缺省 false）块内 —— 开关关 ⇒
 * 投喂永不发生（六幕零漂移的现状逐字节保持），开关开且失败记忆非空 ⇒
 * 梦回放激活（D-B4 的点亮语义：「enableSleepCycle 开且投喂后激活」）。
 */
export function createDreamDeps(faces) {
    const f = faces && typeof faces === 'object' ? faces : {};
    return {
        // 失败轨迹源：dump 故障原样上抛（诚实归因）；数据垃圾 ⇒ 空集（净化归梦管线）
        failures: () => recordsOf(f.dumpFailures()),
        ...(f.evolution ? { evolution: f.evolution } : {}),
        ...(f.spectrum ? { spectrum: f.spectrum } : {}),
        ...(f.budget ? { budget: f.budget } : {}),
    };
}
