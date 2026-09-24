// src/tools/diffView.ts
// 第四轮创新的工具面：视觉差分视图（what-changed-where）。
// 对比窗口内最近两张截图，输出：红框差分图（变化在哪一目了然）+
// 变化区域清单（归一化坐标 + 面积排序）。模型不再需要自己肉眼对比两张整屏。
//
// 双路径（本轮接线）：D-5 服务端 frame_diff（帧环缓存上的分块差分 + 红框标注）
// 优先；sharp 本地路径保留（legacy/开发仓）。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { getSharp } from '../_legacyDeps';
import { contextManager } from '../contextManager';
import { focusTracker } from '../focusTracker';
import * as backend from '../physicalBackend';
import {
  computeDiffRegions, renderDiffOverlay, classifyPersistence, noteDiffObserved,
  spatialDisplacement, type DiffRegion,
} from '../visualDiff';

function decodeDataUrl(base64: string): Buffer {
  return Buffer.from(base64.split(',')[1] ?? base64, 'base64');
}

/** 服务端差分区域 → visualDiff 的 DiffRegion 形状（G-1/I-4/H-1 器官继续可用） */
function adaptServerRegions(
  regions: Array<{ x: number; y: number; width: number; height: number }>,
): DiffRegion[] {
  return regions
    .map((r, i) => ({
      index: i + 1,
      bbox_normalized: { x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height },
      center: { x: r.x + r.width / 2, y: r.y + r.height / 2 },
      tiles_changed: Math.max(1, Math.round(r.width * r.height * 256)),
    }))
    .sort((a, b) => b.tiles_changed - a.tiles_changed)
    .map((r, i) => ({ ...r, index: i + 1 }));
}

export function createDiffViewTool() {
  return defineTool({
    name: 'diff_view',
    description:
      'Compares the two most recent screenshots and highlights WHAT changed and WHERE: ' +
      'returns a diff image with numbered red boxes plus a coordinate list of changed regions. ' +
      'Use this after an action when you need to know exactly what the action changed.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      const imgs = contextManager.recentImages(2);
      const serverFrames = backend.lastTwoDiffFrames();

      if (imgs.length < 2 && !serverFrames) {
        return `[System]: Need at least 2 screenshots in context to diff. Take a screenshot, perform an action, then take another.`;
      }

      try {
        let regions: DiffRegion[];
        let changedPct: number;
        let identical: boolean;
        let diffBase64: string | null = null;

        const [before, after] = imgs;
        if (serverFrames) {
          // D-5 服务端路径：帧环差分 + 红框标注图
          const d = await backend.frameDiff({ frameA: serverFrames[0], frameB: serverFrames[1], annotate: true });
          regions = adaptServerRegions(d.changed_regions);
          changedPct = Math.round(
            regions.reduce((s, r) => s + (r.bbox_normalized.x1 - r.bbox_normalized.x0) * (r.bbox_normalized.y1 - r.bbox_normalized.y0), 0) * 10000,
          ) / 100;
          identical = d.region_count === 0;
          diffBase64 = d.annotated_image_base64
            ? `data:image/jpeg;base64,${d.annotated_image_base64}`
            : null;
        } else {
          const beforeBuf = decodeDataUrl(before.base64);
          const afterBuf = decodeDataUrl(after.base64);
          const diff = await computeDiffRegions(beforeBuf, afterBuf);
          regions = diff.regions;
          changedPct = diff.changed_fraction_pct;
          identical = diff.identical || diff.regions.length === 0;
          if (!identical) {
            const overlaid = await renderDiffOverlay(afterBuf, diff.regions);
            const sharp = await getSharp();
            const compressed = await sharp(overlaid).jpeg({ quality: 80 }).toBuffer();
            diffBase64 = `data:image/jpeg;base64,${compressed.toString('base64')}`;
          }
        }

        const comparedNote = before && after
          ? `#${before.id} -> #${after.id}`
          : `server frames #${serverFrames![0]} -> #${serverFrames![1]}`;

        if (identical || regions.length === 0) {
          return JSON.stringify({
            status: 'SUCCESS',
            state_anchor: {
              compared: comparedNote,
              changed_fraction_pct: changedPct,
              regions: 0,
            },
            next_step: 'The two screenshots are pixel-identical. The intervening action had NO visual effect.',
          }, null, 2);
        }

        // 差分图：最新截图 + 红框标注，入窗成为新的观察基准
        let currentId: number | null = null;
        if (diffBase64) {
          const rec = await contextManager.addScreenshot(diffBase64);
          currentId = rec.currentId;
        }

        // G-1 差分持续性（TDA-lite）+ I-4 迁徙链接：区域在最近 3 次 diff 中重现 ≥2 次
        // 或与既有持续特征构成传输匹配（滑动）⇒ persistent；先判后记，本次不自证持续
        const persistence = classifyPersistence(regions);
        noteDiffObserved(regions, persistence);
        const persistentCount = [...persistence.values()].filter(v => v === 'persistent').length;

        // H-1 Wasserstein 空间位移：变化发生在你动作的地方吗（最优传输因果验证）
        const focus = focusTracker.get(60_000);
        const displacement = focus ? spatialDisplacement(focus, regions) : null;

        const regionLines = regions.slice(0, 8).map(r =>
          `- Δ${r.index}${persistence.get(r.index) === 'persistent' ? ' [persistent]' : ''}: bbox=(${r.bbox_normalized.x0.toFixed(2)},${r.bbox_normalized.y0.toFixed(2)})-(${r.bbox_normalized.x1.toFixed(2)},${r.bbox_normalized.y1.toFixed(2)}) center=(${r.center.x.toFixed(3)}, ${r.center.y.toFixed(3)}) size=${r.tiles_changed}`,
        );

        return JSON.stringify({
          status: 'SUCCESS',
          state_anchor: {
            diff_screenshot: currentId ?? undefined,
            compared: comparedNote,
            changed_fraction_pct: changedPct,
            regions: regions.length,
            persistent_regions: persistentCount,
            ...(displacement ? {
              spatial_displacement: {
                focus: { x: Math.round(focus!.x * 1000) / 1000, y: Math.round(focus!.y * 1000) / 1000 },
                w1: displacement.w1,
                nearest_region: displacement.nearestIndex,
                reading: displacement.w1 <= 0.15
                  ? 'change centered where you acted (direct effect — expected)'
                  : displacement.w1 >= 0.35
                    ? 'change happened FAR from your action — side-effect or your causal model is wrong'
                    : 'change partly near your action',
              },
            } : {}),
            region_list: regionLines,
          },
          next_step: 'Red dashed boxes in the diff screenshot mark every changed region (numbered by size). ' +
            (persistentCount > 0
              ? `${persistentCount} region(s) marked [persistent] have recurred across recent diffs — treat them as STRUCTURAL changes (likely the real effect of your action); ` +
                'unmarked regions are likely transient noise (caret blink, animation). '
              : 'No region has persisted across diffs — all changes may be transient noise; verify with take_screenshot before concluding. ') +
            (displacement && displacement.w1 >= 0.35
              ? 'Spatial displacement is LARGE: the change occurred away from where you acted — check whether it is an intended side-effect before trusting it. ' : '') +
            'Δ centers are click-ready coordinates.',
        }, null, 2);
      } catch (error: any) {
        return `[Error]: Diff failed: ${error.message}`;
      }
    },
  });
}
