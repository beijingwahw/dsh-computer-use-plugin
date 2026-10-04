// src/autonomy/runtime.tuning.ts
// W8-B2（doctor smell.over-engineering 清偿 · D-F2 千行文件群）：自 runtime.ts
// 低风险分区提取 —— W1-1 执行层节奏与阈值参数面（W1ExecTuning 全集 + 缺省常量
// W1_EXEC_TUNING）。逐字节搬迁、零依赖；runtime.ts 以再导出保持导入面不变。
// 不接 config —— 集成阶段统一接（宿主经 RuntimeDeps.w1 注入覆盖，同律保持）。
/** W1-1：缺省参数（128px ROI / 汉明 2 / 150ms 轮询 / 2s 强制放行 / 8 邻位重试） */
export const W1_EXEC_TUNING = {
    roiRadiusPx: 128,
    roiHammingTolerance: 2,
    focusShortcutRadius: 0.01,
    largeBboxPx: 96,
    smallBboxPx: 24,
    smallShrinkRatio: 0.2,
    wordMaxAreaRatio: 0.6,
    clickRetryMax: 8,
    gridStepRatio: 0.25,
    gridStepMinPx: 4,
    gridStepMaxPx: 40,
    steadyPollMs: 150,
    steadyTimeoutMs: 2000,
    steadyHamming: 2,
    rowMeansGrid: 64,
    rowShiftSearchRange: 16,
};
