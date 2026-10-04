// test/tools.diffView.test.ts
// W6R-B7 补强：src/tools/diffView.ts 工具层直测（此前零直接覆盖）。
// 全离线确定性：
//   · 服务端帧路径：backend.noteFrameForDiff 摆帧 + _setAdapterForTests 假
//     frameDiff 回放 changed_regions / region_count / annotated_image_base64；
//   · 客户端 legacy 路径：contextManager 入窗两张 sharp 铸的微小 PNG（真实依赖，
//     离线确定性），computeDiffRegions/renderDiffOverlay 走真像素；
//   · 焦点位移：focusTracker.set 注入动作点（W₁ 空间位移的输入）。
// 覆盖面：素材不足拒绝、identical 分支、区域换算/排序/面积、差分图入窗
// （diff_screenshot 锚点）、持续性标注（G-1 三观测后 persistent）、空间位移
// 话术（H-1）、frameDiff 失败的诚实错误。
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as backend from '../src/physicalBackend.ts';
import { resetDiffFrameRing } from '../src/physicalBackend.surface.ts';
import { contextManager } from '../src/contextManager.ts';
import { focusTracker } from '../src/focusTracker.ts';
import { resetDiffPersistence } from '../src/visualDiff.ts';
import { createDiffViewTool } from '../src/tools/diffView.ts';
import { getSharp } from '../src/_legacyDeps.ts';

type Exec = (a: unknown) => Promise<string>;
const exec = (t: unknown): Exec => (t as unknown as { execute: Exec }).execute;
const tool = createDiffViewTool();

/** sharp 铸图（真实依赖 —— 离线确定性）：纯色小图 */
async function pngDataUrl(color: string, w = 16, h = 16): Promise<string> {
  const sharp = await getSharp();
  const buf = await sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
  return `data:image/png;base64,${buf.toString('base64')}`;
}
async function jpegBase64(color: string): Promise<string> {
  const sharp = await getSharp();
  const buf = await sharp({ create: { width: 8, height: 8, channels: 3, background: color } }).jpeg().toBuffer();
  return buf.toString('base64');
}

/** 摆帧 + 装 frameDiff 假面 */
function serverFrames(
  changed_regions: Array<{ x: number; y: number; width: number; height: number }>,
  opts: { annotated?: string } = {},
): void {
  backend._setAdapterForTests({
    frameDiff: async () => ({
      ok: true as const,
      value: {
        changed_regions,
        region_count: changed_regions.length,
        ...(opts.annotated ? { annotated_image_base64: opts.annotated } : {}),
      },
    }),
  } as never);
  backend.noteFrameForDiff(7);
  backend.noteFrameForDiff(8);
}

beforeEach(() => {
  resetDiffFrameRing();
  resetDiffPersistence();
  contextManager.reset();
  focusTracker.clear();
});

after(async () => {
  resetDiffFrameRing();
  resetDiffPersistence();
  contextManager.reset();
  focusTracker.clear();
  backend._setAdapterForTests(null);
});

test('diff_view: 素材不足 —— 上下文无图且无服务端帧 ⇒ [System] 指引', async () => {
  const out = await exec(tool)({});
  assert.match(out, /^\[System\]: Need at least 2 screenshots/);
  assert.match(out, /Take a screenshot, perform an action, then take another/);
});

test('diff_view: 服务端 identical（region_count=0）—— 像素级相同的诚实结论', async () => {
  serverFrames([]);
  const out = JSON.parse(await exec(tool)({}));
  assert.equal(out.status, 'SUCCESS');
  assert.equal(out.state_anchor.compared, 'server frames #7 -> #8');
  assert.equal(out.state_anchor.changed_fraction_pct, 0);
  assert.equal(out.state_anchor.regions, 0);
  assert.match(out.next_step, /pixel-identical/);
  assert.match(out.next_step, /NO visual effect/);
});

test('diff_view: 服务端单区域 —— 面积百分比 / tiles / bbox / center 换算', async () => {
  serverFrames([{ x: 0.1, y: 0.2, width: 0.2, height: 0.1 }]); // 面积 0.02
  const out = JSON.parse(await exec(tool)({}));
  assert.equal(out.status, 'SUCCESS');
  assert.equal(out.state_anchor.regions, 1);
  assert.equal(out.state_anchor.changed_fraction_pct, 2, 'round(0.02*10000)/100 = 2%');
  assert.equal(out.state_anchor.persistent_regions, 0, '首观测不自证持续');
  const line = out.state_anchor.region_list[0] as string;
  assert.match(line, /- Δ1: bbox=\(0\.10,0\.20\)-\(0\.30,0\.30\) center=\(0\.200, 0\.250\) size=5$/,
    'tiles = max(1, round(0.02*256)) = 5');
  assert.match(out.next_step, /Δ centers are click-ready coordinates/);
  assert.equal('diff_screenshot' in out.state_anchor, false, '无标注图 ⇒ 不入窗');
});

test('diff_view: 服务端多区域 —— 面积降序重编号（Δ1 = 大区域）', async () => {
  serverFrames([
    { x: 0.0, y: 0.0, width: 0.1, height: 0.1 },  // tiles round(2.56)=3
    { x: 0.5, y: 0.5, width: 0.4, height: 0.2 },  // tiles round(20.48)=20
  ]);
  const out = JSON.parse(await exec(tool)({}));
  assert.equal(out.state_anchor.regions, 2);
  const lines = out.state_anchor.region_list as string[];
  assert.match(lines[0], /- Δ1: bbox=\(0\.50,0\.50\)-\(0\.90,0\.70\)/, '大区域排前且重编号');
  assert.match(lines[1], /- Δ2: bbox=\(0\.00,0\.00\)-\(0\.10,0\.10\)/);
  assert.equal(out.state_anchor.changed_fraction_pct, 9, 'round((0.01+0.08)*10000)/100');
});

test('diff_view: 标注图在场 —— 差分图入窗成新观察基准（diff_screenshot 锚点）', async () => {
  const annotated = await jpegBase64('#7f7f7f');
  serverFrames([{ x: 0.2, y: 0.2, width: 0.1, height: 0.1 }], { annotated });
  const out = JSON.parse(await exec(tool)({}));
  assert.equal(out.status, 'SUCCESS');
  assert.ok(Number.isInteger(out.state_anchor.diff_screenshot), '差分图入窗（currentId 锚点）');
  assert.ok(contextManager.imageCount() >= 1, 'contextManager 确实持有差分图');
  assert.match(out.next_step, /Red dashed boxes/);
});

test('diff_view: H-1 空间位移 —— 动作点远处的变化给 FAR 话术 + w1 数值', async () => {
  serverFrames([{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }]); // 中心 (0.2, 0.2)
  focusTracker.set(0.9, 0.9); // 动作点远离变化区
  const out = JSON.parse(await exec(tool)({}));
  const sd = out.state_anchor.spatial_displacement;
  assert.ok(sd, '有焦点 ⇒ spatial_displacement 在场');
  assert.deepEqual(sd.focus, { x: 0.9, y: 0.9 });
  assert.equal(sd.w1, 0.99, '单区域质量全押：hypot(0.9-0.2, 0.9-0.2)=0.98995 → round 千分位');
  assert.equal(sd.nearest_region, 1);
  assert.equal(sd.reading, 'change happened FAR from your action — side-effect or your causal model is wrong');
  assert.match(out.next_step, /Spatial displacement is LARGE/);
});

test('diff_view: G-1 持续性 —— 同区域三次观测后标 persistent + STRUCTURAL 话术', async () => {
  serverFrames([{ x: 0.3, y: 0.3, width: 0.1, height: 0.1 }]);
  const first = JSON.parse(await exec(tool)({}));
  assert.equal(first.state_anchor.persistent_regions, 0, '首观测：先判后记（不自证持续）');
  const second = JSON.parse(await exec(tool)({}));
  assert.equal(second.state_anchor.persistent_regions, 0, '第二次：窗口内仅 1 次历史观测（门槛 ≥2）');
  assert.doesNotMatch(second.state_anchor.region_list[0], /\[persistent\]/);
  const third = JSON.parse(await exec(tool)({}));
  assert.equal(third.state_anchor.persistent_regions, 1, '第三次：2 次历史观测 ⇒ persistent');
  assert.match(third.state_anchor.region_list[0], /\[persistent\]/);
  assert.match(third.next_step, /STRUCTURAL changes/);
});

test('diff_view: 客户端 legacy 路径 —— 上下文两同图 ⇒ pixel-identical', async () => {
  const png = await pngDataUrl('#404040');
  await contextManager.addScreenshot(png);
  await contextManager.addScreenshot(png);
  const out = JSON.parse(await exec(tool)({}));
  assert.equal(out.status, 'SUCCESS');
  assert.match(out.state_anchor.compared, /^#\d+ -> #\d+$/);
  assert.equal(out.state_anchor.regions, 0);
  assert.match(out.next_step, /pixel-identical/);
});

test('diff_view: 客户端 legacy 路径 —— 黑白两图 ⇒ 检出区域 + 差分图入窗', async () => {
  const black = await pngDataUrl('#000000', 64, 64);
  const white = await pngDataUrl('#ffffff', 64, 64);
  const r1 = await contextManager.addScreenshot(black);
  const r2 = await contextManager.addScreenshot(white);
  const out = JSON.parse(await exec(tool)({}));
  assert.equal(out.status, 'SUCCESS');
  assert.equal(out.state_anchor.compared, `#${r1.currentId} -> #${r2.currentId}`);
  assert.ok(out.state_anchor.regions >= 1, '全屏变化至少一个区域');
  assert.ok(out.state_anchor.changed_fraction_pct > 50, '黑白全反：变化占比过半');
  assert.ok(Number.isInteger(out.state_anchor.diff_screenshot), '差分图入窗');
});

test('diff_view: frameDiff 失败 —— [Error] 诚实透传', async () => {
  backend._setAdapterForTests({
    frameDiff: async () => ({ ok: false as const, error: { kind: 'internal_error', detail: 'ring corrupt' } }),
  } as never);
  backend.noteFrameForDiff(7);
  backend.noteFrameForDiff(8);
  const out = await exec(tool)({});
  assert.match(out, /^\[Error\]: Diff failed: /);
});
