// src/physicalBackend.surface.ts
// W6-2（doctor smell.over-engineering 清偿）：自 physicalBackend.ts 低风险分区提取
// （>500 行拆分信号）—— W4-5 移动 Surface 方言（surface id 解析/铸造，纯函数）
// 与 diff_view 帧登记环（模块态 + 纯登记函数）整体搬迁。行为零变化；
// physicalBackend.ts 以再导出保持导入面不变（w4mobile / takeScreenshot / diffView 零改动）。

// ─── W4-5 移动 Surface：surface id 方言 + 设备清单 + surfaces 能力申报 ───
//
// 方言（与 Python 端 dsh_physical/android.py 的 parse_surface_id 严格镜像）：
//   'host:<i>'      主机显示器（/v1/displays 清单序，0 起 —— Σ-5 display 索引
//                   泛化为字符串 id）
//   'android:<s>'   adb 设备 serial（scrcpy/ADB 设备入列虚拟显示器）

export type SurfaceSpec = { kind: 'host'; index: number } | { kind: 'android'; serial: string };

/** surface id → 结构化（畸形 id throw —— 调用方契约错误的快速失败）。 */
export function parseSurfaceId(spec: string): SurfaceSpec {
  const m = /^(host|android):(.+)$/.exec(spec.trim());
  if (!m) {
    throw new Error(`[physicalBackend] invalid surface id ${JSON.stringify(spec)} (expected 'host:<index>' or 'android:<serial>')`);
  }
  if (m[1] === 'host') {
    if (!/^\d+$/.test(m[2])) {
      throw new Error(`[physicalBackend] invalid surface id ${JSON.stringify(spec)}: host index must be a non-negative integer`);
    }
    return { kind: 'host', index: parseInt(m[2], 10) };
  }
  if (!m[2]) {
    throw new Error(`[physicalBackend] invalid surface id ${JSON.stringify(spec)}: android serial must be non-empty`);
  }
  return { kind: 'android', serial: m[2] };
}

/** 显示器索引 → 'host:<i>'（Σ-5 display 的泛化形态）。 */
export function hostSurface(index: number): string {
  return `host:${index}`;
}

/** adb serial → 'android:<serial>'。 */
export function androidSurface(serial: string): string {
  return `android:${serial}`;
}

// ─── diff_view 帧登记：最近两张 keepFrame 截图的服务端帧 id ───

const diffFrameRing: number[] = [];

/** take_screenshot（keepFrame 捕获）登记帧 id —— diff_view 的默认对比对 */
export function noteFrameForDiff(frameId: number | null): void {
  if (frameId == null) return;
  diffFrameRing.push(frameId);
  while (diffFrameRing.length > 2) diffFrameRing.shift();
}

/** 最近两张已登记帧（旧在前）；不足两张返回 null */
export function lastTwoDiffFrames(): [number, number] | null {
  if (diffFrameRing.length < 2) return null;
  return [diffFrameRing[diffFrameRing.length - 2], diffFrameRing[diffFrameRing.length - 1]];
}

/** W6-2：帧环归零（原 physicalBackend.stopBackend 的 diffFrameRing.length = 0 同义搬迁） */
export function resetDiffFrameRing(): void {
  diffFrameRing.length = 0;
}
