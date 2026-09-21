// src/visualDiff.ts
// 第四轮创新之一：视觉差分引擎（what-changed-where）。
// 模型自己对比两张整屏截图既费 Token 又容易看漏；本引擎在像素层直接算出
// 「哪些区域变了」：降采样 → 逐像素差 → 分块聚合 → 连通域合并 → 变化区域清单。
// 输出归一化坐标的变化框，可叠加红框渲染成差分图 —— 模型一眼看到变化在哪。
// 批次 E 迁移：sharp 懒动态导入（_legacyDeps.getSharp）。
import { getSharp } from './_legacyDeps';

export interface DiffRegion {
  index: number;
  bbox_normalized: { x0: number; y0: number; x1: number; y1: number };
  center: { x: number; y: number }; // 点击友好的区域中心
  tiles_changed: number;            // 覆盖的变化分块数（面积代理）
}

export interface DiffResult {
  regions: DiffRegion[];            // 按面积降序
  changed_fraction_pct: number;     // 全屏变化像素占比
  identical: boolean;
}

const DIFF_WIDTH = 480; // 差分分辨率：够定位，无需高清
const PIXEL_THRESHOLD = 70; // RGB 三通道差之和超此值算变化（容忍 JPEG 噪声）

export async function computeDiffRegions(
  beforeBuf: Buffer,
  afterBuf: Buffer,
  tileCols = 16,
): Promise<DiffResult> {
  const sharp = await getSharp();
  const afterMeta = await sharp(afterBuf).metadata();
  const W = DIFF_WIDTH;
  const H = Math.max(1, Math.round(W * (afterMeta.height! / afterMeta.width!)));

  const [a, b] = await Promise.all([
    sharp(beforeBuf).resize(W, H, { fit: 'fill' }).raw().toBuffer(),
    sharp(afterBuf).resize(W, H, { fit: 'fill' }).raw().toBuffer(),
  ]);

  // 分块变化图：像素级变化累积到块级，天然过滤零星噪点
  const rows = Math.max(6, Math.round(tileCols * H / W));
  const tileW = Math.max(1, Math.floor(W / tileCols));
  const tileH = Math.max(1, Math.floor(H / rows));
  const changedTiles = new Uint8Array(tileCols * rows);
  let totalChanged = 0;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (d > PIXEL_THRESHOLD) {
        totalChanged++;
        const ty = Math.min(rows - 1, Math.floor(y / tileH));
        const tx = Math.min(tileCols - 1, Math.floor(x / tileW));
        changedTiles[ty * tileCols + tx] = 1;
      }
    }
  }

  const changedFraction = totalChanged / (W * H);

  // 连通域合并（4 邻域）：相邻变化块聚成区域
  const visited = new Uint8Array(tileCols * rows);
  const regions: DiffRegion[] = [];
  for (let t = 0; t < tileCols * rows; t++) {
    if (!changedTiles[t] || visited[t]) continue;
    const queue = [t];
    visited[t] = 1;
    let minX = tileCols, minY = rows, maxX = 0, maxY = 0, tiles = 0;
    while (queue.length) {
      const cur = queue.pop()!;
      const cx = cur % tileCols, cy = Math.floor(cur / tileCols);
      tiles++;
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
      const nb: Array<[number, number]> = [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]];
      for (const [nx, ny] of nb) {
        if (nx < 0 || ny < 0 || nx >= tileCols || ny >= rows) continue;
        const ni = ny * tileCols + nx;
        if (changedTiles[ni] && !visited[ni]) { visited[ni] = 1; queue.push(ni); }
      }
    }
    regions.push({
      index: 0,
      bbox_normalized: { x0: minX / tileCols, y0: minY / rows, x1: (maxX + 1) / tileCols, y1: (maxY + 1) / rows },
      center: { x: (minX + maxX + 1) / 2 / tileCols, y: (minY + maxY + 1) / 2 / rows },
      tiles_changed: tiles,
    });
  }

  regions.sort((r1, r2) => r2.tiles_changed - r1.tiles_changed);
  regions.forEach((r, i) => { r.index = i + 1; });

  return {
    regions,
    changed_fraction_pct: Math.round(changedFraction * 1000) / 10,
    identical: changedFraction < 0.001,
  };
}

/** 把变化区域以红色虚线框 + Δ编号 渲染到 after 图上（差分可视化） */
export async function renderDiffOverlay(afterBuf: Buffer, regions: DiffRegion[]): Promise<Buffer> {
  const sharp = await getSharp();
  const meta = await sharp(afterBuf).metadata();
  const W = meta.width!, H = meta.height!;
  const boxes = regions.slice(0, 12).map(r => {
    const x = Math.round(r.bbox_normalized.x0 * W), y = Math.round(r.bbox_normalized.y0 * H);
    const w = Math.max(8, Math.round((r.bbox_normalized.x1 - r.bbox_normalized.x0) * W));
    const h = Math.max(8, Math.round((r.bbox_normalized.y1 - r.bbox_normalized.y0) * H));
    const label = `Δ${r.index}`;
    const labelW = label.length * 9 + 8;
    return (
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#FF3B30" stroke-width="3" stroke-dasharray="8,4" />` +
      `<rect x="${x}" y="${Math.max(0, y - 20)}" width="${labelW}" height="20" fill="#FF3B30" />` +
      `<text x="${x + 4}" y="${Math.max(14, y - 5)}" font-family="monospace" font-size="14" font-weight="bold" fill="#fff">${label}</text>`
    );
  }).join('');
  const svg = Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${boxes}</svg>`);
  return sharp(afterBuf).composite([{ input: svg, top: 0, left: 0 }]).png().toBuffer();
}

// ─── G-1 差分持续性（第七维·过程感知）：0 维持久同调的工程最小形态 ───
//
// 理论根基（Edelsbrunner–Harer 持久同调）：把连续 diff 视为对「变化特征」的
// 反复观测流 —— 特征的「寿命」（在多少个连续 diff 中重现）即 0 维持续性：
//   长寿命特征 = 稳定的结构变化（内容真的变了 —— 菜单展开了、面板出现了）
//   短寿命特征 = 瞬态噪声（光标闪烁、视频帧、动画残影 —— 一次闪现即消亡）
// 拓扑数据处理（TDA）的核心洞见在此最小化：不看单帧快照，看特征的生存时间。
//
// 实现：区域中心量化到 12×12 网格（抖动容忍键）；最近 6 次 diff 的键集合成
// 观测史；特征在最近 3 次观测中出现 ≥2 次 ⇒ persistent（寿命门槛 ≥2）。
// 诚实边界：网格量化键无方向性（相邻格不合并 —— 漂移的持续变化会被误判
// transient）；域敏感的 Vietoris–Rips 复形是留白。

const PERSIST_RING = 6;       // 观测史容量（最近 6 次 diff）
const PERSIST_WINDOW = 3;     // 寿命判定窗口（最近 3 次观测）
const PERSIST_MIN_LIFE = 2;   // 寿命门槛：窗口内出现 ≥2 次 ⇒ 持续
const KEY_GRID = 12;          // 中心量化网格（12×12 —— 抖动容忍 vs 定位分辨的平衡）
/** I-4 迁徙半径（归一化坐标）：≤0.10 的位移视为同一特征的移动（约 1.2 格） */
const MIGRATE_RADIUS = 0.10;
/** O 纪元（#24）瞬移链接：无距离证据时的更硬形状判据 —— 质量窗收紧 + 长宽比容差 */
const TELEPORT_MASS_LO = 2 / 3, TELEPORT_MASS_HI = 1.5;
const TELEPORT_ASPECT_TOL = 0.35;
/** O 纪元（#24）相干位移容差（归一化坐标）：两对位移矢量同轴判定 */
const COHERENT_TOL = 0.05;

/** 区域 → 量化键（中心坐标的网格量化 —— ±1/24 内的抖动同键） */
export function regionKey(r: Pick<DiffRegion, 'center'>): string {
  return `${Math.round(r.center.x * KEY_GRID)},${Math.round(r.center.y * KEY_GRID)}`;
}

// ─── H-6 双格点量化（创世纪）：偿还 G-1 的漂移债务 ───
//
// G-1 诚实边界原文：「网格量化键无方向性 —— 漂移的持续变化会被误判 transient」。
// 偿还方案（重叠格点经典技巧）：每个区域铸**两把键**——主格点（12×12 网格）+
// 副格点（同网格平移半格 1/24）。任何点距其中至少一个格点系的_cell 内边界
// 足够远：主格点跨界的漂移，副格点必在界内（反之亦然）—— 两条 1/24 容差的
// 量化证据链，任何一条存活 ⇒ 持续性存活。数学上这是双射覆盖（double
// covering）：两套平移格点的交集界宽 ≥ 半格，联合量化误差上界从 1/24 的
// 「运气题」变为 1/24 的「保证题」。

/** 半格偏移（副格点系的平移量） */
const HALF_CELL = 1 / (KEY_GRID * 2);

/** 区域 → 双格点键集（主格点 + 平移半格的副格点）。导出：测试与 H-6 执法面 */
export function regionKeys(r: Pick<DiffRegion, 'center'>): [string, string] {
  const primary = regionKey(r);
  const secondary =
    `s${Math.round((r.center.x - HALF_CELL) * KEY_GRID)},${Math.round((r.center.y - HALF_CELL) * KEY_GRID)}`;
  return [primary, secondary];
}

/**
 * 持续性分类（纯函数 —— 可注入任意观测史，测试的确定性事实源）：
 * 区域的**任一**格点键在观测史最近 PERSIST_WINDOW 次中出现 ≥PERSIST_MIN_LIFE 次
 * ⇒ persistent（H-6 双格点：主键跨界漂移由副键兜底 —— 联合证据链）。
 *
 * I-4 迁徙链接（默认模式，history 未注入时）：键断链（漂移超半格）的区域，
 * 若与窗口内**已被判 persistent** 的历史特征构成传输匹配 —— 距离 ≤0.10 且
 * 质量比 ∈[0.5,2] —— 则视为**同一持续特征的迁徙**（同一条菜单滑了半屏，
 * 不是旧特征死了新特征生了）。闭合 G-1/H-6 的债务链：亚半格漂移由双格点
 * 兜底，超半格漂移由传输兜底 —— 持续性对任意速度的连续漂移全程存活。
 * 注入 history 的纯键模式保持不变（epochG/H 测试的既有语义零回归）。
 */
export function classifyPersistence(
  regions: readonly DiffRegion[],
  history?: readonly Set<string>[],
): Map<number, 'persistent' | 'transient'> {
  const verdict = new Map<number, 'persistent' | 'transient'>();

  if (history) {
    // 纯键模式（注入观测史 —— 测试与确定性判据的固定面）
    const window = history.slice(-PERSIST_WINDOW);
    for (const r of regions) {
      const keys = regionKeys(r);
      const life = window.reduce((n, set) => n + (keys.some(k => set.has(k)) ? 1 : 0), 0);
      verdict.set(r.index, life >= PERSIST_MIN_LIFE ? 'persistent' : 'transient');
    }
    return verdict;
  }

  // 默认模式：内部富观测史（键 + 持续特征快照）—— 键判据 + I-4 迁徙/瞬移链接
  const window = richRing.slice(-PERSIST_WINDOW);
  for (const r of regions) {
    const keys = regionKeys(r);
    const life = window.reduce(
      (n, obs) => n + (keys.some(k => obs.keys.has(k)) ? 1 : 0), 0);
    if (life >= PERSIST_MIN_LIFE) {
      verdict.set(r.index, 'persistent');
      continue;
    }
    // I-4 迁徙链接：与窗口内 persistent 特征的传输匹配（距离 + 质量比守恒）
    const migrated = window.some(obs =>
      obs.persistent.some(p =>
        Math.hypot(p.center.x - r.center.x, p.center.y - r.center.y) <= MIGRATE_RADIUS &&
        (() => { const ratio = r.tiles_changed / p.mass; return ratio >= 0.5 && ratio <= 2; })(),
      ));
    if (migrated) { verdict.set(r.index, 'persistent'); continue; }
    // O 纪元（#24）瞬移链接（相干位移场版）：极端 UI 变化（窗口移动/布局重排）
    // 位移远超半径，迁徙链断裂 ⇒ 同一批特征被误判 transient。单帧上「远处同形
    // 新盒」与「特征瞬移」不可区分（I-4 反例立法）—— 判别子是**相干场**：
    // 真实重排必携带 ≥2 个特征以一致位移矢量共移（刚体平移）；凑齐相干对 ⇒
    // 这批区域判 persistent，单个候选维持 transient（证据不足，诚实）。
    // 形状判据（无距离证据时更硬）：质量窗 [2/3,1.5] + 长宽比相对差 ≤0.35。
    if (coherentTeleport(r, window, regions)) {
      verdict.set(r.index, 'persistent');
      continue;
    }
    verdict.set(r.index, 'transient');
  }
  return verdict;
}

/** 区域 × persistent 快照的形状守恒判据（#24：无距离证据 ⇒ 形状更硬） */
function shapeConserved(r: DiffRegion, p: { mass: number; aspect?: number }): boolean {
  const ratio = r.tiles_changed / p.mass;
  if (ratio < TELEPORT_MASS_LO || ratio > TELEPORT_MASS_HI) return false;
  if (typeof p.aspect !== 'number' || !Number.isFinite(p.aspect) || p.aspect <= 0) return false;
  const aspect = (r.bbox_normalized.x1 - r.bbox_normalized.x0) /
    Math.max(1e-6, r.bbox_normalized.y1 - r.bbox_normalized.y0);
  return Math.abs(aspect - p.aspect) / Math.max(aspect, p.aspect) <= TELEPORT_ASPECT_TOL;
}

/** O 纪元（#24）：相干瞬移判定 —— 本区域与另一区域相对窗口内 persistent
 *  特征的位移矢量一致（刚体平移证据）⇒ 瞬移场成立。纯函数、确定性。 */
function coherentTeleport(
  r: DiffRegion,
  window: RichObservation[],
  allRegions: readonly DiffRegion[],
): boolean {
  for (const obs of window) {
    for (const p of obs.persistent) {
      if (!shapeConserved(r, p)) continue;
      const dx = r.center.x - p.center.x, dy = r.center.y - p.center.y;
      if (Math.hypot(dx, dy) <= MIGRATE_RADIUS) continue; // 已由迁徙链管辖
      // 找共移证人：另一区域 q，其相对某个 persistent 特征的位移与 (dx,dy) 一致
      for (const q of allRegions) {
        if (q.index === r.index) continue;
        for (const obs2 of window) {
          for (const p2 of obs2.persistent) {
            if (!shapeConserved(q, p2)) continue;
            const ddx = q.center.x - p2.center.x, ddy = q.center.y - p2.center.y;
            if (Math.hypot(ddx, ddy) <= MIGRATE_RADIUS) continue;
            if (Math.abs(ddx - dx) <= COHERENT_TOL && Math.abs(ddy - dy) <= COHERENT_TOL) {
              return true; // 两个形状守恒特征同矢量共移 —— 刚体重排证据
            }
          }
        }
      }
    }
  }
  return false;
}

/** 富观测条目：键集合 + 当时的持续特征快照（I-4 迁徙/瞬移链接的锚点） */
interface RichObservation {
  keys: Set<string>;
  /** aspect = bbox 宽/高（#24 瞬移链接的形状指纹；旧环条目无此字段 ⇒ undefined 守卫） */
  persistent: Array<{ center: { x: number; y: number }; mass: number; aspect?: number }>;
}

/** 内部富观测史（与键环同容量同窗口 —— 双轨合一的存储面） */
const richRing: RichObservation[] = [];

/**
 * 观测登记：先判后记（本次不自证持续）。verdict 可选注入（diff_view 已算过）；
 * 缺席时内部判定。登记键集合 + persistent 特征快照（供下一轮迁徙链接）。
 */
export function noteDiffObserved(
  regions: readonly DiffRegion[],
  verdict?: Map<number, 'persistent' | 'transient'>,
): void {
  const v = verdict ?? classifyPersistence(regions);
  const keys = new Set<string>();
  for (const r of regions) for (const k of regionKeys(r)) keys.add(k);
  const persistent = regions
    .filter(r => v.get(r.index) === 'persistent')
    .map(r => ({
      center: { x: r.center.x, y: r.center.y },
      mass: r.tiles_changed,
      aspect: (r.bbox_normalized.x1 - r.bbox_normalized.x0) /
        Math.max(1e-6, r.bbox_normalized.y1 - r.bbox_normalized.y0),
    }));
  richRing.push({ keys, persistent });
  while (richRing.length > PERSIST_RING) richRing.shift();
}

/** 生命周期归零（插件卸载 / 测试隔离） */
export function resetDiffPersistence(): void {
  richRing.length = 0;
}

// ─── H-1 Wasserstein 空间位移（创世纪）：最优传输的行动因果验证 ───

/**
 * H-1 最优传输空间位移：W₁(δ_a, μ) = Σ wᵢ·d(a, cᵢ)，wᵢ = tiles_changedᵢ/Σ
 * （质量 = 区域面积代理）。Dirac↔离散分布的 W₁ 有闭式解 —— 无需求解传输
 * 线性规划（一维情形的最优传输退化为加权平均距离）。
 *
 * 认知价值：dHash 只答「有没有变」，W₁ 答「**变化发生在你动作的地方吗**」——
 * 「点了这里侧栏在那边展开」是正确的因果（副作用），而「点了这里、别处闪了
 * 一下」可能只是巧合。空间因果与像素变化正交，是验证栈的第五个维度。
 * 纯函数导出：数学原子的测试面。
 */
export interface SpatialDisplacement {
  /** W₁（1-Wasserstein / 推土机距离）：δ_动作点 与 变化质量分布 μ 的最优传输成本。
   *  归一化坐标域：0 = 变化就在动作点；0.5+ = 变化远离动作点 */
  w1: number;
  /** O 纪元（#25）：信息熵加权的 W₁ —— wᵢ ∝ tᵢ·(1−λ+λ·(−ln pᵢ)/ln n)，λ=0.5。
   *  面积 ≠ 信息量：大面积均匀变化（滚动/闪屏）在质量视图里称王，但它承载的
   *  信息稀薄；小面积独特变化（弹窗出现）信息量高。w1Info 是「信息视图」下
   *  的传输距离 —— 单区域时熵项退化（ln n=0），与 w1 相等。 */
  w1Info: number;
  /** O 纪元（#25）：两视图分歧度 = w1Info / max(w1, ε)。≈1 = 质量与信息视图
   *  同判；显著 >1 = 一个远处小而独特的变化正被近处大面积冲刷掩蔽 ——
   *  差分归因的粗粒度由此显形（消费方按分歧提示模型细看 minority 区域）。 */
  infoRatio: number;
  /** 距动作点最近的变化区域（变化中心是谁） */
  nearestIndex: number | null;
  /** 质量加权最近距离（最近的「重要」变化离你多远） */
  nearestDistance: number;
}

/**
 * H-1 最优传输空间位移：W₁(δ_a, μ) = Σ wᵢ·d(a, cᵢ)，wᵢ = tiles_changedᵢ/Σ
 * （质量 = 区域面积代理）。Dirac↔离散分布的 W₁ 有闭式解 —— 无需求解传输
 * 线性规划（一维情形的最优传输退化为加权平均距离）。
 *
 * 认知价值：dHash 只答「有没有变」，W₁ 答「**变化发生在你动作的地方吗**」——
 * 「点了这里侧栏在那边展开」是正确的因果（副作用），而「点了这里、别处闪了
 * 一下」可能只是巧合。空间因果与像素变化正交，是验证栈的第五个维度。
 * 纯函数导出：数学原子的测试面。
 */
export function spatialDisplacement(
  action: { x: number; y: number },
  regions: readonly DiffRegion[],
): SpatialDisplacement {
  if (regions.length === 0) {
    return { w1: 0, w1Info: 0, infoRatio: 1, nearestIndex: null, nearestDistance: 0 };
  }
  const totalMass = regions.reduce((n, r) => n + r.tiles_changed, 0);
  if (totalMass <= 0) {
    return { w1: 0, w1Info: 0, infoRatio: 1, nearestIndex: null, nearestDistance: 0 };
  }
  const LAMBDA = 0.5;   // 信息温度：熵视图的话语权（0 = 纯质量，1 = 纯自信息）
  const logn = Math.log(regions.length);
  const dists = new Map<number, number>();
  let w1 = 0;
  let w1InfoNum = 0, infoWeightSum = 0;
  let nearestIndex: number | null = null;
  let nearestDistance = Infinity;
  for (const r of regions) {
    const d = Math.hypot(action.x - r.center.x, action.y - r.center.y);
    dists.set(r.index, d);
    const w = r.tiles_changed / totalMass;
    w1 += w * d;
    // 信息熵加权（#25）：自信息 −ln pᵢ 按区域数归一后经 λ 注入质量权
    if (logn > 0) {
      const p = r.tiles_changed / totalMass;
      const iw = r.tiles_changed * (1 - LAMBDA + LAMBDA * (-Math.log(p)) / logn);
      w1InfoNum += iw * d;
      infoWeightSum += iw;
    } else {
      w1InfoNum += w * d * totalMass; // 单区域：熵退化为质量
      infoWeightSum += totalMass;
    }
    if (d < nearestDistance) { nearestDistance = d; nearestIndex = r.index; }
  }
  const w1Info = w1InfoNum / infoWeightSum;
  return {
    w1: Math.round(w1 * 1000) / 1000,
    w1Info: Math.round(w1Info * 1000) / 1000,
    infoRatio: Math.round((w1Info / Math.max(w1, 1e-6)) * 1000) / 1000,
    nearestIndex,
    nearestDistance: Math.round(nearestDistance * 1000) / 1000,
  };
}
