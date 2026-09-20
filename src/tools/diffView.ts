// src/tools/diffView.ts
// 第四轮创新的工具面：视觉差分视图（what-changed-where）。
// 对比窗口内最近两张截图，输出：红框差分图（变化在哪一目了然）+
// 变化区域清单（归一化坐标 + 面积排序）。模型不再需要自己肉眼对比两张整屏。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { getSharp } from '../_legacyDeps';
import { contextManager } from '../contextManager';
import { focusTracker } from '../focusTracker';
import {
  computeDiffRegions, renderDiffOverlay, classifyPersistence, noteDiffObserved,
  spatialDisplacement,
} from '../visualDiff';

function decodeDataUrl(base64: string): Buffer {
  return Buffer.from(base64.split(',')[1] ?? base64, 'base64');
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
      if (imgs.length < 2) {
        return `[System]: Need at least 2 screenshots in context to diff. Take a screenshot, perform an action, then take another.`;
      }

      try {
        const [before, after] = imgs;
        const beforeBuf = decodeDataUrl(before.base64);
        const afterBuf = decodeDataUrl(after.base64);

        const diff = await computeDiffRegions(beforeBuf, afterBuf);

        if (diff.identical || diff.regions.length === 0) {
          return JSON.stringify({
            status: 'SUCCESS',
            state_anchor: {
              compared: `#${before.id} -> #${after.id}`,
              changed_fraction_pct: diff.changed_fraction_pct,
              regions: 0,
            },
            next_step: 'The two screenshots are pixel-identical. The intervening action had NO visual effect.',
          }, null, 2);
        }

        // 差分图：最新截图 + 红框标注，入窗成为新的观察基准
        const overlaid = await renderDiffOverlay(afterBuf, diff.regions);
        const sharp = await getSharp();
        const compressed = await sharp(overlaid).jpeg({ quality: 80 }).toBuffer();
        const base64 = `data:image/jpeg;base64,${compressed.toString('base64')}`;
        const { currentId } = await contextManager.addScreenshot(base64);

        // G-1 差分持续性（TDA-lite）+ I-4 迁徙链接：区域在最近 3 次 diff 中重现 ≥2 次
        // 或与既有持续特征构成传输匹配（滑动）⇒ persistent；先判后记，本次不自证持续
        const persistence = classifyPersistence(diff.regions);
        noteDiffObserved(diff.regions, persistence);
        const persistentCount = [...persistence.values()].filter(v => v === 'persistent').length;

        // H-1 Wasserstein 空间位移：变化发生在你动作的地方吗（最优传输因果验证）——
        // dHash 答「有没有变」，W₁ 答「变化是否在你的动作点附近」
        const focus = focusTracker.get(60_000);
        const displacement = focus ? spatialDisplacement(focus, diff.regions) : null;

        const regionLines = diff.regions.slice(0, 8).map(r =>
          `- Δ${r.index}${persistence.get(r.index) === 'persistent' ? ' [persistent]' : ''}: bbox=(${r.bbox_normalized.x0.toFixed(2)},${r.bbox_normalized.y0.toFixed(2)})-(${r.bbox_normalized.x1.toFixed(2)},${r.bbox_normalized.y1.toFixed(2)}) center=(${r.center.x.toFixed(3)}, ${r.center.y.toFixed(3)}) size=${r.tiles_changed}`,
        );

        return JSON.stringify({
          status: 'SUCCESS',
          state_anchor: {
            diff_screenshot: currentId,
            compared: `#${before.id} -> #${after.id}`,
            changed_fraction_pct: diff.changed_fraction_pct,
            regions: diff.regions.length,
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
