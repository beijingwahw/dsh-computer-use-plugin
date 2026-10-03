// test/w1som.test.ts
// W1-7（P4 稀疏 SoM + 抗遮挡标签路由）测试面：
//   纯函数（selectSparseMarkers / routeLabelPlacement / stableColor / somColorKey /
//   taskRelevance / SOM_COLOR_PALETTE）全部离线测（零 sharp）；
//   sharp 合成路径按仓库惯例懒加载 sharp（缺席则 t.skip，不红）——覆盖
//   稀疏名额、四向避让集成、染色稳定、确定性（同输入两次渲染逐字节一致）、
//   回退路径与降级（非图输入 ok:false 永不抛）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSharp, type SharpLike } from '../src/_legacyDeps.ts';
import type { SomMarker, SomMarkerScore, SomRect } from '../src/vlm/som.ts';

const {
  selectSparseMarkers, routeLabelPlacement, stableColor, somColorKey, taskRelevance,
  SOM_COLOR_PALETTE, renderSomOverlay,
} = await import('../src/vlm/som.ts');

/** 测试用 marker 构造（center 由 bbox 中心给出） */
function M(id: number, x0: number, y0: number, x1: number, y1: number, text?: string): SomMarker {
  return { id, bbox: { x0, y0, x1, y1 }, center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, ...(text !== undefined ? { text } : {}) };
}

/** 尝试取 sharp；缺席时返回 null（调用方 t.skip —— 批次 E 惯例） */
async function trySharp(): Promise<SharpLike | null> {
  try { return await getSharp(); } catch { return null; }
}

/** 纯色 raw → PNG（sharp 在场时的确定性底图） */
async function solidSharpPng(s: SharpLike, w: number, h: number): Promise<Buffer> {
  return s(Buffer.alloc(w * h * 3, 40), { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

// ─── 稀疏名额分配：交互置信 × 任务语义相关度 ──────────────────────

test('selectSparseMarkers: 高置信×高相关优先，Top-K 且保持原序', () => {
  const markers = [M(1, 0, 0, 10, 10), M(2, 0, 20, 10, 30), M(3, 0, 40, 10, 50), M(4, 0, 60, 10, 70)];
  const scores: SomMarkerScore[] = [
    { confidence: 0.97, relevance: 0.9 },  // w = 0.873
    { confidence: 0.3, relevance: 0.2 },   // w = 0.06
    { confidence: 0.95, relevance: 0.85 }, // w = 0.8075
    undefined as unknown as SomMarkerScore, // 无证据 → 0（输给全部有证据者）
  ];
  const sel = selectSparseMarkers(markers, scores, 2);
  assert.equal(sel.fallback, false);
  // 权重 Top-2 = {1, 3}，渲染序保持原数组序（跨帧视觉次序稳定）
  assert.deepEqual(sel.markers.map(m => m.id), [1, 3]);
  assert.ok(sel.weights !== undefined);
  assert.deepEqual(sel.weights, [0.873, 0.8075]);

  // 预算 3：无证据者仍输给最弱证据者（0.06 > 0）
  const sel3 = selectSparseMarkers(markers, scores, 3);
  assert.deepEqual(sel3.markers.map(m => m.id), [1, 2, 3]);
});

test('selectSparseMarkers: 单通道在场时按该通道加权（另一通道中性 1）', () => {
  const markers = [M(1, 0, 0, 10, 10), M(2, 0, 20, 10, 30), M(3, 0, 40, 10, 50)];
  const onlyConf: SomMarkerScore[] = [{ confidence: 0.2 }, { confidence: 0.9 }, {}];
  const sel = selectSparseMarkers(markers, onlyConf, 1);
  assert.equal(sel.fallback, false);
  assert.deepEqual(sel.markers.map(m => m.id), [2]); // 纯置信最大者胜
});

test('selectSparseMarkers: 平手按原始下标（确定性）', () => {
  const markers = [M(10, 0, 0, 10, 10), M(20, 0, 20, 10, 30), M(30, 0, 40, 10, 50)];
  const tied: SomMarkerScore[] = [{ confidence: 0.5, relevance: 0.5 }, { confidence: 0.25, relevance: 1 }, { confidence: 1, relevance: 0.25 }];
  // 三者权重同为 0.25 —— 平手取原始下标最小
  const sel = selectSparseMarkers(markers, tied, 1);
  assert.deepEqual(sel.markers.map(m => m.id), [10]);
});

test('selectSparseMarkers: 无置信/相关度输入时诚实回退全量', () => {
  const markers = [M(1, 0, 0, 10, 10), M(2, 0, 20, 10, 30)];
  // scores 缺省
  assert.deepEqual(selectSparseMarkers(markers, undefined, 1), { markers, fallback: true });
  // scores 全空对象（两通道皆缺席）
  const r2 = selectSparseMarkers(markers, [{}, {}], 1);
  assert.equal(r2.fallback, true);
  assert.equal(r2.markers.length, 2);
  // scores 非数组（防御）
  const r3 = selectSparseMarkers(markers, 'garbage' as unknown as SomMarkerScore[], 1);
  assert.equal(r3.fallback, true);
  // 预算非法（NaN/负数）→ 回退全量（配置错误不毒化渲染）
  assert.equal(selectSparseMarkers(markers, [{ confidence: 0.9 }], Number.NaN).fallback, true);
  assert.equal(selectSparseMarkers(markers, [{ confidence: 0.9 }], -3).fallback, true);
  // NaN 置信不构成在场证据
  const r4 = selectSparseMarkers(markers, [{ confidence: Number.NaN }], 1);
  assert.equal(r4.fallback, true);
});

test('selectSparseMarkers: 预算 ≥ 全量 / 预算 0 / 越界值钳制', () => {
  const markers = [M(1, 0, 0, 10, 10), M(2, 0, 20, 10, 30)];
  const scores: SomMarkerScore[] = [{ confidence: 0.9, relevance: 1 }, { confidence: 0.5, relevance: 0.5 }];
  assert.equal(selectSparseMarkers(markers, scores, 2).fallback, false);   // 预算=全量
  assert.equal(selectSparseMarkers(markers, scores, 99).markers.length, 2); // 超额钳到全量
  assert.deepEqual(selectSparseMarkers(markers, scores, 0).markers, []);   // 显式零名额
  // 置信/相关度越界（>1）钳到 1
  const over: SomMarkerScore[] = [{ confidence: 97, relevance: 1 }, { confidence: 0.5, relevance: 0.5 }];
  assert.deepEqual(selectSparseMarkers(markers, over, 1).markers.map(m => m.id), [1]);
});

// ─── 抗遮挡标签路由：四向避让 + 引线 ──────────────────────────────

test('routeLabelPlacement: 空闲时首选上方（方向序 first-fit）+ 引线端点', () => {
  const box: SomRect = { x0: 10, y0: 40, x1: 30, y1: 60 };
  const r = routeLabelPlacement(box, 30, 20, 200, 200, []);
  assert.equal(r.direction, 'up');
  assert.deepEqual(r.rect, { x0: 10, y0: 40 - 4 - 20, x1: 40, y1: 36 });
  // 引线：芯片中心 x=25（夹回框 x 范围 10..30 内仍是 25），从芯片底到框顶
  assert.deepEqual(r.leader, { x1: 25, y1: 36, x2: 25, y2: 40 });
});

test('routeLabelPlacement: 上方被占 → 下方；上/下皆被占 → 左/右', () => {
  const box: SomRect = { x0: 10, y0: 40, x1: 30, y1: 60 };
  // 上方横栏遮挡（up 芯片 [10..40, 16..36] 与之相交）
  const bar: SomRect = { x0: 0, y0: 0, x1: 200, y1: 38 };
  const down = routeLabelPlacement(box, 30, 20, 200, 200, [bar]);
  assert.equal(down.direction, 'down');
  assert.deepEqual(down.rect, { x0: 10, y0: 64, x1: 40, y1: 84 });

  // 再堵下方（down 芯片 [10..40, 64..84]）：left 芯片 x0=10-34=-24 出画幅 → 取 right
  const bar2: SomRect = { x0: 0, y0: 62, x1: 200, y1: 90 };
  const right = routeLabelPlacement(box, 30, 20, 200, 200, [bar, bar2]);
  assert.equal(right.direction, 'right');
  assert.deepEqual(right.rect, { x0: 34, y0: 40, x1: 64, y1: 60 });

  // 框右移让 left 芯片入画幅：上/下皆堵 → left 胜（方向序先于 right）
  const box2: SomRect = { x0: 60, y0: 40, x1: 80, y1: 60 };
  const left = routeLabelPlacement(box2, 30, 20, 200, 200, [bar, bar2]);
  assert.equal(left.direction, 'left');
  assert.deepEqual(left.rect, { x0: 26, y0: 40, x1: 56, y1: 60 });
});

test('routeLabelPlacement: 四向全冲突 → 重叠面积最小方向', () => {
  // box {100,100,140,120}，labelW=30 labelH=20，画幅 200×200
  // up 芯片 [100..130,76..96] 与 {120..200, 80..90} 交叠 10×10=100（最小）
  // down 芯片 [100..130,124..144] 与 {120..200,130..180} 交叠 10×14=140
  // left 芯片 [66..96,100..120] 与 {70..110,100..120} 交叠 26×20=520
  // right 芯片 [144..174,100..120] 与 {150..200,90..140} 交叠 24×20=480
  const box: SomRect = { x0: 100, y0: 100, x1: 140, y1: 120 };
  const occ: SomRect[] = [
    { x0: 120, y0: 80, x1: 200, y1: 90 },
    { x0: 120, y0: 130, x1: 200, y1: 180 },
    { x0: 70, y0: 100, x1: 110, y1: 120 },
    { x0: 150, y0: 90, x1: 200, y1: 140 },
  ];
  const r = routeLabelPlacement(box, 30, 20, 200, 200, occ);
  assert.equal(r.direction, 'up'); // 100 < 140 < 480 < 520
  assert.ok(r.leader !== null, '最小重叠兜底仍有引线');
});

test('routeLabelPlacement: 重叠面积平手 → 按方向序（上优先）', () => {
  // up 与 down 交叠同为 10×10=100，left/right 交叠更大 → 平手取 up
  const box: SomRect = { x0: 100, y0: 100, x1: 140, y1: 120 };
  const occ: SomRect[] = [
    { x0: 120, y0: 80, x1: 200, y1: 90 },   // up: 100
    { x0: 120, y0: 130, x1: 200, y1: 140 }, // down: 100
    { x0: 70, y0: 100, x1: 110, y1: 120 },  // left: 520
    { x0: 150, y0: 90, x1: 200, y1: 140 },  // right: 480
  ];
  const r = routeLabelPlacement(box, 30, 20, 200, 200, occ);
  assert.equal(r.direction, 'up');
});

test('routeLabelPlacement: 画幅边缘 = 隐形墙；四向全不可行回落传统位', () => {
  // 框贴顶（y0=6 < gap+labelH=24）：up 芯片出画幅 → 取 down
  const top = routeLabelPlacement({ x0: 10, y0: 6, x1: 30, y1: 26 }, 30, 20, 200, 200, []);
  assert.equal(top.direction, 'down');
  // 框贴右缘：right 芯片出画幅
  const right = routeLabelPlacement({ x0: 180, y0: 40, x1: 198, y1: 60 }, 30, 20, 200, 200, []);
  assert.notEqual(right.direction, 'right');

  // 病态小画幅：四向芯片全部出画幅 → direction null + 传统位几何 + 无引线
  const r = routeLabelPlacement({ x0: 5, y0: 5, x1: 35, y1: 35 }, 30, 20, 40, 40, []);
  assert.equal(r.direction, null);
  assert.equal(r.leader, null);
  // 传统位：y0=5 < 20 → 回落框内上沿
  assert.deepEqual(r.rect, { x0: 5, y0: 5, x1: 35, y1: 25 });

  // 防御：NaN 框 / 非法芯片尺寸 —— 不抛、回落 null
  const bad = routeLabelPlacement({ x0: Number.NaN, y0: 0, x1: 10, y1: 10 }, Number.NaN, -5, 200, 200, []);
  assert.equal(bad.direction, null);
});

// ─── 跨帧稳定染色 ────────────────────────────────────────────────

test('SOM_COLOR_PALETTE: 16 色 HSV 均匀分布 —— 格式合法、互异、逐字节稳定', () => {
  assert.equal(SOM_COLOR_PALETTE.length, 16);
  const set = new Set(SOM_COLOR_PALETTE);
  assert.equal(set.size, 16, '调色板色必须互异');
  for (const c of SOM_COLOR_PALETTE) assert.match(c, /^#[0-9A-F]{6}$/);
  // 确定性：同模块常量跨调用恒定（构造零随机）
  assert.deepEqual(stableColor('probe-key-α'), stableColor('probe-key-α'));
});

test('stableColor / somColorKey: 同文本同形状跨帧同键同色', () => {
  // 两个不同帧里的「登录」按钮：bbox 微移 + id 不同 + 画幅稍变
  const a = M(1, 10, 10, 26, 20, '登录');
  const b = M(7, 12, 12, 30, 22, '登录'); // 同形状类（归一化宽高同档）同文本
  const keyA = somColorKey(a, 200, 200);
  const keyB = somColorKey(b, 210, 210);
  assert.equal(keyA, keyB, '同文本同形状 ⇒ 同键');
  assert.equal(stableColor(keyA), stableColor(keyB));
  assert.ok(SOM_COLOR_PALETTE.includes(stableColor(keyA)), '染色必来自调色板');

  // 大小写/空白不敏感（键归一化）；不同文本通常异键
  const c = M(3, 10, 10, 26, 20, ' Login ');
  assert.equal(somColorKey(c, 200, 200), somColorKey(M(4, 10, 10, 26, 20, 'login'), 200, 200));
  assert.notEqual(somColorKey(M(5, 10, 10, 26, 20, '登录'), 200, 200), somColorKey(M(6, 10, 10, 26, 20, '退出'), 200, 200));

  // 缺席 text：纯形状键仍稳定（同形状跨帧同色）
  assert.equal(somColorKey(M(8, 10, 10, 26, 20), 200, 200), somColorKey(M(9, 12, 12, 28, 22), 200, 200));
});

test('taskRelevance: semanticHash 余弦 —— 相关 > 无关，空输入诚实回 0', () => {
  const rel = taskRelevance('登录按钮', '点击登录进入设置');
  const unrel = taskRelevance('天气预报', '点击登录进入设置');
  assert.ok(rel > unrel, `相关度必须高于无关（${rel} vs ${unrel}）`);
  assert.equal(taskRelevance('', '任务'), 0);
  assert.equal(taskRelevance('按钮', ''), 0);
  assert.ok(rel >= 0 && rel <= 1, '余弦钳在 0..1');
});

// ─── renderSomOverlay 集成：sharp 合成（缺席则 skip）──────────────

test('renderSomOverlay+W1-7: 稀疏预算只画 Top-K，决策面如实上报', async (t) => {
  const s = await trySharp();
  if (!s) return t.skip('[batch-E] sharp 不可用 —— 云端合成用例 SKIP');

  const png = await solidSharpPng(s, 80, 60);
  const markers = [M(1, 4, 4, 24, 16), M(2, 30, 10, 50, 30), M(3, 55, 30, 75, 50)];
  const scores: SomMarkerScore[] = [
    { confidence: 0.3, relevance: 0.2 },
    { confidence: 0.97, relevance: 0.9 }, // 最优
    { confidence: 0.5, relevance: 0.5 },
  ];
  const res = await renderSomOverlay(png, { markers, scores, sparseBudget: 1, routeLabels: true, stableColors: true });
  assert.equal(res.ok, true, `res.error=${res.error ?? ''}`);
  assert.deepEqual(res.selected, [2], '预算 1 只画权重最高者');
  assert.equal(res.sparseFallback, false);
  assert.ok(res.labelDirections !== undefined && res.labelDirections.length === 1);
  assert.equal(res.labelDirections![0].id, 2);
  assert.equal(res.width, 80);
  assert.equal(res.height, 60);
  // 稀疏图 ≠ 全量图（像素证据）
  const full = await renderSomOverlay(png, { markers, routeLabels: true, stableColors: true });
  assert.ok(!res.buffer!.equals(full.buffer!), 'Top-1 与全量渲染必须不同');
  assert.deepEqual(full.selected, [1, 2, 3]);
});

test('renderSomOverlay+W1-7: 无证据稀疏请求诚实回退全量', async (t) => {
  const s = await trySharp();
  if (!s) return t.skip('[batch-E] sharp 不可用 —— 云端合成用例 SKIP');

  const png = await solidSharpPng(s, 80, 60);
  const markers = [M(1, 4, 4, 24, 16), M(2, 30, 10, 50, 30)];
  const res = await renderSomOverlay(png, { markers, sparseBudget: 1 }); // 无 scores
  assert.equal(res.ok, true, `res.error=${res.error ?? ''}`);
  assert.equal(res.sparseFallback, true, '证据缺席必须如实标记回退');
  assert.deepEqual(res.selected, [1, 2]);
  // 预算 0（有证据）：显式清空 → plain 原样透传 + selected=[]
  const zero = await renderSomOverlay(png, { markers, scores: [{ confidence: 0.9 }], sparseBudget: 0 });
  assert.equal(zero.ok, true);
  assert.deepEqual(zero.selected, []);
  assert.ok(zero.buffer!.equals(png), '零名额 = 无叠加，原样返回');
});

test('renderSomOverlay+W1-7: 遮挡场景四向避让 + 引线（集成）', async (t) => {
  const s = await trySharp();
  if (!s) return t.skip('[batch-E] sharp 不可用 —— 云端合成用例 SKIP');

  // m1 = 上部横栏（宽 100，y0=28 给 up 芯片留足 24px 画幅）；m2 在其正下方 ——
  // m2 的 up 芯片 [20..40, 36..56] 必然与 m1 框（y1=48）相交 → down
  const w = 120, h = 120;
  const png = await solidSharpPng(s, w, h);
  const markers = [M(1, 10, 28, 110, 48), M(2, 20, 60, 60, 90)];
  const res = await renderSomOverlay(png, { markers, routeLabels: true });
  assert.equal(res.ok, true, `res.error=${res.error ?? ''}`);
  assert.deepEqual(res.labelDirections!.map(d => d.id), [1, 2]);
  assert.equal(res.labelDirections![0].direction, 'up', 'm1 上方空旷 → up');
  assert.equal(res.labelDirections![1].direction, 'down', 'm2 上方被 m1 遮挡 → down');
  assert.ok(!res.buffer!.equals(png), '叠加必须改写像素');
  // 结果可再解码（SVG 结构合法的证据）
  const meta = await s(res.buffer!).metadata();
  assert.equal(meta.width, w);
  assert.equal(meta.height, h);
});

test('renderSomOverlay+W1-7: 染色稳定性 —— 同文本跨帧同色、同图同色', async (t) => {
  const s = await trySharp();
  if (!s) return t.skip('[batch-E] sharp 不可用 —— 云端合成用例 SKIP');

  // 帧 A 与帧 B：同一组「保存/取消」按钮，bbox/画幅微移 —— 颜色必须一致
  const frameA = await renderSomOverlay(await solidSharpPng(s, 100, 80), {
    markers: [M(1, 5, 5, 30, 25, '保存'), M(2, 40, 5, 70, 25, '取消')],
    stableColors: true,
  });
  const frameB = await renderSomOverlay(await solidSharpPng(s, 104, 84), {
    markers: [M(5, 7, 7, 33, 27, '保存'), M(6, 42, 7, 73, 27, '取消')],
    stableColors: true,
  });
  assert.equal(frameA.ok && frameB.ok, true);
  const colorOf = (r: typeof frameA, id: number) => r.colors!.find(c => c.id === id)!.color;
  assert.equal(colorOf(frameA, 1), colorOf(frameB, 5), '「保存」跨帧同色');
  assert.equal(colorOf(frameA, 2), colorOf(frameB, 6), '「取消」跨帧同色');
  assert.notEqual(colorOf(frameA, 1), colorOf(frameA, 2), '不同文本通常异色');
  for (const c of [...frameA.colors!, ...frameB.colors!]) {
    assert.ok(SOM_COLOR_PALETTE.includes(c.color), `色 ${c.color} 必来自调色板`);
  }
});

test('renderSomOverlay+W1-7: 确定性 —— 同输入两次渲染逐字节一致', async (t) => {
  const s = await trySharp();
  if (!s) return t.skip('[batch-E] sharp 不可用 —— 云端合成用例 SKIP');

  const png = await solidSharpPng(s, 100, 80);
  const mkOpts = () => ({
    markers: [M(1, 4, 4, 24, 16, '搜索'), M(2, 30, 30, 60, 50, '提交'), M(3, 70, 10, 95, 40)],
    scores: [{ confidence: 0.97, relevance: 0.8 }, { confidence: 0.4, relevance: 0.3 }, { confidence: 0.6 }] as SomMarkerScore[],
    sparseBudget: 2,
    routeLabels: true,
    stableColors: true,
    gridDensity: 4,
  });
  const r1 = await renderSomOverlay(png, mkOpts());
  const r2 = await renderSomOverlay(png, mkOpts());
  assert.equal(r1.ok && r2.ok, true);
  assert.ok(r1.buffer!.equals(r2.buffer!), '三新能力全开：同输入必须逐字节一致');
  assert.deepEqual(r1.selected, r2.selected);
  assert.deepEqual(r1.labelDirections, r2.labelDirections);
  assert.deepEqual(r1.colors, r2.colors);

  // 默认路径（新开关全关）同样确定 —— 回归面
  const legacyOpts = () => ({ markers: [M(1, 4, 4, 24, 16), M(2, 30, 30, 60, 50)] });
  const l1 = await renderSomOverlay(png, legacyOpts());
  const l2 = await renderSomOverlay(png, legacyOpts());
  assert.ok(l1.buffer!.equals(l2.buffer!), '默认路径：同输入必须逐字节一致');
});

test('renderSomOverlay+W1-7: opt-in 契约 —— 默认路径不带新决策面', async (t) => {
  const s = await trySharp();
  if (!s) return t.skip('[batch-E] sharp 不可用 —— 云端合成用例 SKIP');

  const png = await solidSharpPng(s, 60, 40);
  const res = await renderSomOverlay(png, { markers: [M(1, 4, 4, 24, 16)] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.selected, [1], '默认全量');
  assert.equal(res.sparseFallback, undefined);
  assert.equal(res.labelDirections, undefined);
  assert.equal(res.colors, undefined);
});

test('renderSomOverlay+W1-7: 降级与防御 —— 非图输入 ok:false，垃圾参数不抛', async () => {
  const markers = [M(1, 4, 4, 24, 16, '按钮')];
  // 非图输入（sharp 解码失败路径）—— 三新能力全开也必须优雅降级
  const r1 = await renderSomOverlay(Buffer.from('definitely not an image'), {
    markers, scores: [{ confidence: 0.9, relevance: 1 }], sparseBudget: 1, routeLabels: true, stableColors: true,
  });
  assert.equal(r1.ok, false);
  assert.equal(typeof r1.error, 'string');
  // 非法 marker 混入 + 全开关：只跳过自身，不毒化整图（离线可测 —— sharp 缺席时同样不抛）
  const s = await trySharp();
  if (s) {
    const png = await solidSharpPng(s, 40, 30);
    const bad = [
      M(Number.NaN, Number.NaN, 0, 10, 10),          // id/bbox NaN → 跳过
      M(2, 20, 5, 2, 25),                            // 非正尺寸 → 跳过
      M(3, 500, 500, 900, 900),                      // 完全越界 → 跳过
      M(4, 2, 2, 18, 12, '好按钮'),                   // 合法 → 保留
    ];
    const res = await renderSomOverlay(png, {
      markers: bad, routeLabels: true, stableColors: true,
      scores: [{ confidence: 0.9 }, {}, {}, { confidence: 0.8, relevance: 0.9 }],
      sparseBudget: 3,
    });
    assert.equal(res.ok, true, `res.error=${res.error ?? ''}`);
    assert.deepEqual(res.selected, [4], '预算名额里只有合法 marker 落地');
    assert.deepEqual(res.colors!.map(c => c.id), [4]);
  }
});
