// src/physicalExecution/execProbe.ts
// W1-1（执行层四连改 · A2/A3/A5）：执行层世界探针 —— PhysicalExecutionAdapter 的
// Result 方言 → 自治运行时（autonomy/runtime.createExecute）的 null 降级方言的桥。
//
// 存在理由：adapter 已有 hitTest / getCursorKind / frameDiff / keepFrame /
// wantRegionHash / frameRowmeans 能力，但闭环从未消费。本模块把这些能力铸成一个
// 最小探针端口（ExecWorldProbe），供 runtime 经依赖注入消费 —— 闭环侧只见
// 「成功给值、失败给 null」，绝不见 Result 分支与异常。
//
// 铁律（与 D-5 同源）：
//   · 零业务判决 —— 只做协议转写与脏值消毒，判决逻辑全在消费侧（可离线测试）；
//   · 探针失败绝不阻塞主路径 —— 一切异常/失败臂收敛为 null（调用方按能力缺席降级）；
//   · 绝不抛异常 —— 每个方法整体 try/catch 兜底。
//
// 接线说明：本模块属 physicalExecution 产权域；桶导出（index.ts）与 config 字段
// 由集成阶段统一接 —— 在此之前消费方直接 import 本文件（类型 + 工厂）。
import type { HitTestResult, PhysicalExecutionAdapter, ScreenshotResult } from './contracts.js';

/** W1-1：一次 meta-only 帧采样的最小证据（全屏指纹 / 区域指纹 / 帧环 id / 维度） */
export interface FrameSample {
  /** 干净帧全屏 dhash（hex 或 64 位串 —— 消费侧统一 normalize）；缺席 = null */
  dhash: string | null;
  /** wantRegionHash 请求的区域 dhash；未请求/失败 = null */
  regionDhash: string | null;
  /** keepFrame 帧环 id（frameDiff / frameRowmeans 的引用锚）；缺席 = null */
  frameId: number | null;
  /** 采样帧像素宽（0 = 未知 —— frameDiff 区域归一化的分母） */
  width: number;
  /** 采样帧像素高（0 = 未知） */
  height: number;
}

/** W1-1：UIA 单点结构查询的消毒形态（A3 预检的消费面） */
export interface HitTestProbeOutcome {
  /** 结构层查询是否真实可用（库缺席/COM 失败 = false ⇒ 消费方必须放行） */
  available: boolean;
  classification: 'control' | 'text' | 'unknown' | 'unavailable';
  /** 命中元素（或祖先链裁决元素）的控件类型；缺席 = null */
  controlType: string | null;
}

/** W1-1：执行层世界探针端口 —— 全部方法可选、全部 null 降级、绝不抛异常 */
export interface ExecWorldProbe {
  /** A3：UIA 单点判决（屏幕像素坐标）；能力缺席/失败 ⇒ null */
  hitTestPoint?(px: number, py: number): Promise<HitTestProbeOutcome | null>;
  /** A3：当前全局光标形态（hand/ibeam/arrow/…）；能力缺席/失败 ⇒ null */
  cursorKind?(): Promise<string | null>;
  /** A2/A5：meta-only 帧采样（服务端指纹 + 可选区域指纹 + 可选 keepFrame）；失败 ⇒ null */
  sampleFrame?(opts?: {
    keepFrame?: boolean;
    wantRegionHash?: { x: number; y: number; r: number };
  }): Promise<FrameSample | null>;
  /** A2：两缓存帧差分 → 变化区域清单（采样帧像素坐标）；失败 ⇒ null */
  frameDiff?(frameA: number, frameB: number): Promise<
    Array<{ x: number; y: number; width: number; height: number }> | null
  >;
  /** A5：缓存帧行亮度序列（内容平移检测）；失败 ⇒ null */
  frameRowMeans?(frameId: number, grid?: number): Promise<number[] | null>;
}

/** Result 臂的运行时形状卫兵（防假 adapter / 协议漂移 —— 绝不信任外部形状） */
function isResultLike(v: unknown): v is { ok: boolean; value?: unknown } {
  return (
    typeof v === 'object' && v !== null &&
    typeof (v as { ok?: unknown }).ok === 'boolean'
  );
}

/** 字符串指纹卫兵：非空字符串才可信（空串 = 无指纹，绝不充数） */
function hashOrNone(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** 有限正数卫兵（维度/帧 id 的消毒） */
function finiteNumOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * W1-1：把 PhysicalExecutionAdapter 铸成执行层世界探针。
 * 生产接线位（集成阶段）：`createExecute({ ..., probe: createExecWorldProbe(adapter) })`。
 * 每个方法：Result 失败臂 / 异常 / 形状不符 ⇒ null —— 探针失败绝不阻塞主路径。
 */
export function createExecWorldProbe(adapter: PhysicalExecutionAdapter): ExecWorldProbe {
  const hitTestPoint = async (px: number, py: number): Promise<HitTestProbeOutcome | null> => {
    try {
      const r = await adapter.hitTest({ x: px, y: py });
      if (!isResultLike(r) || !r.ok) return null;
      const h = r.value as HitTestResult | undefined;
      if (!h || typeof h !== 'object') return null;
      const cls = h.classification;
      return {
        available: h.available === true,
        classification:
          cls === 'control' || cls === 'text' || cls === 'unknown' ? cls : 'unavailable',
        controlType: typeof h.control_type === 'string' && h.control_type !== '' ? h.control_type : null,
      };
    } catch {
      return null;
    }
  };

  const cursorKind = async (): Promise<string | null> => {
    try {
      const r = await adapter.getCursorKind();
      if (!isResultLike(r) || !r.ok) return null;
      const k = r.value as { kind?: unknown } | undefined;
      return typeof k?.kind === 'string' && k.kind !== '' ? k.kind : null;
    } catch {
      return null;
    }
  };

  const sampleFrame = async (opts?: {
    keepFrame?: boolean;
    wantRegionHash?: { x: number; y: number; r: number };
  }): Promise<FrameSample | null> => {
    try {
      const r = await adapter.takeScreenshot({
        metaOnly: true,
        wantHashes: true,
        keepFrame: opts?.keepFrame === true,
        // undefined ⇒ JSON 序列化丢键 ⇒ 请求字节与现状等同（兼容铁律）
        wantRegionHash: opts?.wantRegionHash,
      });
      if (!isResultLike(r) || !r.ok) return null;
      const s = r.value as ScreenshotResult | undefined;
      if (!s || typeof s !== 'object') return null;
      return {
        dhash: hashOrNone(s.dhash),
        regionDhash: hashOrNone(s.region_dhash),
        frameId:
          typeof s.frame_id === 'number' && Number.isFinite(s.frame_id) ? s.frame_id : null,
        width: finiteNumOr(s.width, 0),
        height: finiteNumOr(s.height, 0),
      };
    } catch {
      return null;
    }
  };

  const frameDiff = async (
    frameA: number,
    frameB: number,
  ): Promise<Array<{ x: number; y: number; width: number; height: number }> | null> => {
    try {
      const r = await adapter.frameDiff({ frameA, frameB });
      if (!isResultLike(r) || !r.ok) return null;
      const v = r.value as { changed_regions?: unknown } | undefined;
      if (!v || !Array.isArray(v.changed_regions)) return null;
      const regions: Array<{ x: number; y: number; width: number; height: number }> = [];
      for (const raw of v.changed_regions) {
        if (!raw || typeof raw !== 'object') continue;
        const g = raw as Record<string, unknown>;
        const { x, y, width, height } = g as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
        if (
          [x, y, width, height].every(n => typeof n === 'number' && Number.isFinite(n)) &&
          (width as number) > 0 && (height as number) > 0
        ) {
          regions.push({ x: x as number, y: y as number, width: width as number, height: height as number });
        }
      }
      return regions;
    } catch {
      return null;
    }
  };

  const frameRowMeans = async (frameId: number, grid?: number): Promise<number[] | null> => {
    try {
      const r = await adapter.frameRowmeans(frameId, grid ?? 64);
      if (!isResultLike(r) || !r.ok) return null;
      const rows = (r.value as { rows?: unknown } | undefined)?.rows;
      if (
        !Array.isArray(rows) ||
        rows.length === 0 ||
        !rows.every(n => typeof n === 'number' && Number.isFinite(n))
      ) {
        return null;
      }
      return rows as number[];
    } catch {
      return null;
    }
  };

  return { hitTestPoint, cursorKind, sampleFrame, frameDiff, frameRowMeans };
}
