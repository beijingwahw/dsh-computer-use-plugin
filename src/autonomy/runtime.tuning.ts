// src/autonomy/runtime.tuning.ts
// W8-B2（doctor smell.over-engineering 清偿 · D-F2 千行文件群）：自 runtime.ts
// 低风险分区提取 —— W1-1 执行层节奏与阈值参数面（W1ExecTuning 全集 + 缺省常量
// W1_EXEC_TUNING）。逐字节搬迁、零依赖；runtime.ts 以再导出保持导入面不变。
// 不接 config —— 集成阶段统一接（宿主经 RuntimeDeps.w1 注入覆盖，同律保持）。

/** W1-1：执行层可调参数全集（A2 ROI 验证 / A3 预检 / A4 落点 / A5 稳态门） */
export interface W1ExecTuning {
  /** A2：动作点 ROI 半径（像素 —— 按捕获图短边归一） */
  roiRadiusPx: number;
  /** A2：ROI 区域指纹判「变」的汉明阈值（距离 > 此值即变） */
  roiHammingTolerance: number;
  /** A3：焦点短路半径（归一化距离 ≤ 此值即短路） */
  focusShortcutRadius: number;
  /** A4：大框阈值（长边 ≥ 此值 ⇒ 词级质心落点） */
  largeBboxPx: number;
  /** A4：小框阈值（短边 < 此值 ⇒ 落点向几何中心收缩） */
  smallBboxPx: number;
  /** A4：小框收缩比（0.2 = 向中心收 20%） */
  smallShrinkRatio: number;
  /** A4：词级元素面积上限（占目标框面积比 —— 超过视为目标自身，不入词集） */
  wordMaxAreaRatio: number;
  /** A4：网格重试上限（3×3 去中心 = 最多 8 邻位） */
  clickRetryMax: number;
  /** A4：网格步长（目标框短边比例） */
  gridStepRatio: number;
  /** A4：网格步长下限（像素） */
  gridStepMinPx: number;
  /** A4：网格步长上限（像素） */
  gridStepMaxPx: number;
  /** A5：稳态门轮询间隔（毫秒） */
  steadyPollMs: number;
  /** A5：稳态门强制放行超时（毫秒，超时记 degraded） */
  steadyTimeoutMs: number;
  /** A5：稳态汉明阈值（连续两帧距离 ≤ 此值判稳） */
  steadyHamming: number;
  /** A5：行亮度网格（frameRowmeans 的 grid 参数） */
  rowMeansGrid: number;
  /** A5：行位移搜索窗（estimateRowShift 的 searchRange） */
  rowShiftSearchRange: number;
}

/** W1-1：缺省参数（128px ROI / 汉明 2 / 150ms 轮询 / 2s 强制放行 / 8 邻位重试） */
export const W1_EXEC_TUNING: Readonly<W1ExecTuning> = {
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
