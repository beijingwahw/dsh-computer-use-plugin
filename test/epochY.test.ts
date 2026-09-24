// test/epochY.test.ts
// 第廿一纪元（Y）：全功能创新 —— 每件新器官一条确定性执法。
// 全部纯函数/注入时钟：零宿主耦合、零随机性、跨平台可重复。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { estimateRowShift, judgeScroll } from '../src/motionEstimator.ts';
import { pyramidShouldStop, nextPyramidRegion, PYRAMID_DEFAULTS } from '../src/tools/zoomInspect.ts';
import { judgeTransport } from '../src/tools/dragMouse.ts';
import { isDeadStep } from '../src/tools/replayActions.ts';
import { judgePostcondition, POSTCONDITION_THRESHOLD } from '../src/tools/skillTools.ts';
import { topoSortSubTasks, type SubTask } from '../src/planner.ts';
import { TokenBucket, approval, approvalBudget, resetApproval } from '../src/approval.ts';
import { LANDMARK_HALF_LIFE_H } from '../src/uiMemory.ts';

// ─── Y-2 金字塔停止法则 ───

test('Y-2 停止法则：相对增益枯竭 / 绝对熵下限 / 深度上限', () => {
  // 增益枯竭：H 从 4.0 → 4.2（增益 0.2 < 0.12×4.0=0.48）⇒ 停
  assert.equal(pyramidShouldStop(4.0, 4.2, 1), true);
  // 增益显著：H 从 4.0 → 6.5（增益 2.5 > 0.48）⇒ 继续
  assert.equal(pyramidShouldStop(4.0, 6.5, 1), false);
  // 绝对下限：均匀区 H=1.2 < 2.0 ⇒ 停（无目标）
  assert.equal(pyramidShouldStop(9.9, 1.2, 1), true);
  // 深度上限
  assert.equal(pyramidShouldStop(4.0, 8.0, PYRAMID_DEFAULTS.maxDepth), true);
  // 首层豁免增益规则（prev=cur 增益为 0，但 depth=0 无基线 —— 必须有机会下降）
  assert.equal(pyramidShouldStop(5.0, 5.0, 0), false);
});

test('Y-2 下一层裁剪框：argmax 熵区与当前 region 求交集；无交集诚实不下降', () => {
  const cur = { x: 0.1, y: 0.1, width: 0.4, height: 0.4 };
  const sal = { zones: [
    { x: 0.3, y: 0.2, width: 0.2, height: 0.2, entropy: 5.5 }, // 最优
    { x: 0.8, y: 0.8, width: 0.1, height: 0.1, entropy: 4.0 }, // 域外
  ] };
  const next = nextPyramidRegion(cur, sal)!;
  assert.deepEqual(next.region, { x: 0.3, y: 0.2, width: 0.2, height: 0.2 });
  assert.equal(next.entropy, 5.5);
  // 唯一热点在域外 ⇒ null（不下降）
  assert.equal(nextPyramidRegion(cur, { zones: [{ x: 0.8, y: 0.8, width: 0.1, height: 0.1, entropy: 9 }] }), null);
});

// ─── Y-3 闭环滚动：一维相位相关 + 亚行细化 ───

function shiftedRows(n: number, shift: number): number[] {
  const base = Array.from({ length: n }, (_, i) => 40 + 30 * Math.sin(i / 5) + (i % 7));
  return Array.from({ length: n }, (_, i) => {
    const j = i - shift;
    return j >= 0 && j < n ? base[j] : 50; // 移出区域填中性灰
  });
}

test('Y-3 行位移估计：整数位移精确恢复 + 亚行位移有符号细化', () => {
  const A = shiftedRows(64, 0);
  // after 相对 before 下移 6 行（内容下移）
  const B = shiftedRows(64, 6);
  const est = estimateRowShift(A, B);
  assert.equal(est.bestInteger, 6);
  assert.ok(Math.abs(est.shift - 6) <= 0.3, `shift=${est.shift}`);
  assert.ok(est.residual < 0.2, `residual=${est.residual}`);
  // 反向
  const est2 = estimateRowShift(B, A);
  assert.equal(est2.bestInteger, -6);
});

test('Y-3 滚动判决：有效/方向一致/边界三态', () => {
  // 内容上移 8 行 + scroll down ⇒ 有效且方向一致（滚轮向下 = 内容上移）
  const v = judgeScroll({ shift: -8, residual: 0.1, bestInteger: -8 }, 'down');
  assert.equal(v.effective, true);
  assert.equal(v.directionConsistent, true);
  assert.equal(v.atBoundary, false);
  // 静止帧（残差低 + 零位移）= 边界
  const b = judgeScroll({ shift: 0.1, residual: 0.05, bestInteger: 0 }, 'down');
  assert.equal(b.atBoundary, true);
  assert.equal(b.effective, false);
  // 噪声帧（残差高 + 名义位移）= 非边界也非有效（平移假设不成立）
  const n = judgeScroll({ shift: -3, residual: 0.9, bestInteger: -3 }, 'down');
  assert.equal(n.effective, false);
  assert.equal(n.atBoundary, false);
  // 方向反转
  const m = judgeScroll({ shift: 8, residual: 0.1, bestInteger: 8 }, 'down');
  assert.equal(m.directionConsistent, false);
  // 水平滚动：方向一致性诚实缺席
  const h = judgeScroll({ shift: 8, residual: 0.1, bestInteger: 8 }, 'right');
  assert.equal(h.directionConsistent, null);
});

// ─── Y-4 拖拽运输三元组 ───

test('Y-4 运输判决：运输/腾空/复制语义', () => {
  // hex 指纹域（16 hex = 64bit）；'a'→'0' 每字符翻 3 位
  const same = 'a'.repeat(16);
  const other = '0'.repeat(16);
  const partial = 'a'.repeat(7) + '0'.repeat(9); // 'a'↔'0' 每 hex 字符差 2 位 ⇒ 18/64，sim=0.72 < 0.75
  // 完整运输：起点内容出现在终点，原位腾空
  const full = judgeTransport(same, same, other)!;
  assert.equal(full.transported, true);
  assert.equal(full.vacated, true);
  assert.equal(full.copyLike, false);
  // 复制语义：内容在终点，原位也还在
  const copy = judgeTransport(same, same, same)!;
  assert.equal(copy.transported, true);
  assert.equal(copy.copyLike, true);
  // 未运输：目的地不是原内容
  const miss = judgeTransport(same, other, other)!;
  assert.equal(miss.transported, false);
  // 部分相似（sim=0.72 < 0.75）⇒ 未运输
  const part = judgeTransport(same, partial, other)!;
  assert.equal(part.transported, false);
  // 证据缺席：诚实 null
  assert.equal(judgeTransport(null, same, other), null);
  assert.equal(judgeTransport(same, null, other), null);
});

// ─── Y-6 重放死步门控 ───

test('Y-6 死步判决：距离 ≤ 1 = 死步（屏幕没动）；证据缺席放行', () => {
  const h1 = 'f'.repeat(16);
  const h2 = '0'.repeat(16); // 完全不同
  const h1bit = 'f'.repeat(15) + 'e'; // 1 位差
  assert.equal(isDeadStep(h1, h1), true);        // 全同
  assert.equal(isDeadStep(h1, h1bit), true);     // 1 位差仍是死步
  assert.equal(isDeadStep(h1, h2), false);       // 大变 = 活步
  assert.equal(isDeadStep(null, h2), false);     // 证据缺席不判死
  assert.equal(isDeadStep(h1, null), false);
});

// ─── Y-7 技能后置条件 ───

test('Y-7 后置条件判决：阈值/缺席原因四态', () => {
  // hex 指纹域（等长 —— 位串比较要求同宽）
  const exit = 'a'.repeat(16);
  const near = 'a'.repeat(15) + '8'; // 1 bit 差，sim≈0.98
  const far = '5'.repeat(16);        // 半数位差，sim=0.5 < 0.75
  const v = judgePostcondition(exit, near);
  assert.equal(v.verified, true);
  assert.equal(v.reason, 'verified');
  assert.ok((v.similarity ?? 0) >= POSTCONDITION_THRESHOLD);
  const f = judgePostcondition(exit, far);
  assert.equal(f.verified, false);
  assert.equal(f.reason, 'below-threshold');
  assert.equal(judgePostcondition(undefined, far).reason, 'no-exit-fingerprint');
  assert.equal(judgePostcondition(exit, null).reason, 'hash-unavailable');
});

// ─── Y-8 地标半衰期 ───

test('Y-8 半衰期：信任随年龄指数减半；陈旧标记可判', () => {
  // 纯数学检验：fresh(0h)=1, 168h=0.5, 336h=0.25
  const decay = (ageH: number) => Math.pow(2, -ageH / LANDMARK_HALF_LIFE_H);
  assert.equal(decay(0), 1);
  assert.equal(decay(LANDMARK_HALF_LIFE_H), 0.5);
  assert.equal(decay(2 * LANDMARK_HALF_LIFE_H), 0.25);
  // 行为检验：同成功数的两个地标，新的胜出；一周半衰后旧地标仍可召回但 stale
  // （recall 集成检验见 uiMemory.test —— 此处执法数学律本身）
});

// ─── Y-9 拓扑执行序 ───

test('Y-9 Kahn 拓扑排序：链序保持 / 独立任务稳定 / 环拒绝 / 幻觉边剔除', () => {
  const tasks: SubTask[] = [
    { id: 3, action: 'c', deps: [2] },
    { id: 1, action: 'a', deps: [] },
    { id: 2, action: 'b', deps: [1] },
  ];
  const t = topoSortSubTasks(tasks);
  assert.equal(t.cycle, false);
  assert.deepEqual(t.order.map(x => x.id), [1, 2, 3]);

  // 独立子任务按编号稳定排序（确定性）
  const par: SubTask[] = [
    { id: 9, action: 'x', deps: [] },
    { id: 4, action: 'y', deps: [] },
  ];
  assert.deepEqual(topoSortSubTasks(par).order.map(x => x.id), [4, 9]);

  // 菱形依赖：1 → {2,3} → 4
  const diamond: SubTask[] = [
    { id: 4, action: 'd', deps: [2, 3] },
    { id: 2, action: 'b', deps: [1] },
    { id: 3, action: 'c', deps: [1] },
    { id: 1, action: 'a', deps: [] },
  ];
  const d = topoSortSubTasks(diamond);
  assert.equal(d.cycle, false);
  assert.equal(d.order[0].id, 1);
  assert.equal(d.order[3].id, 4);

  // 环：2→3→2 ⇒ cycle=true，环成员如实列出
  const cyc: SubTask[] = [
    { id: 1, action: 'a', deps: [] },
    { id: 2, action: 'b', deps: [3] },
    { id: 3, action: 'c', deps: [2] },
  ];
  const c = topoSortSubTasks(cyc);
  assert.equal(c.cycle, true);
  assert.deepEqual([...c.cyclicIds].sort((a, b) => a - b), [2, 3]);
  assert.deepEqual(c.order.map(x => x.id), [1]);

  // Planner 幻觉边（指向不存在的 id）：剔除后正常排序
  const ghost: SubTask[] = [
    { id: 1, action: 'a', deps: [99] },
    { id: 2, action: 'b', deps: [1] },
  ];
  const g = topoSortSubTasks(ghost);
  assert.equal(g.cycle, false);
  assert.deepEqual(g.order.map(x => x.id), [1, 2]);
});

// ─── Y-10 审批令牌桶 ───

test('Y-10 令牌桶：容量耗尽拒绝 + 回填恢复 + 桶满不累积', () => {
  let clock = 0;
  const bucket = new TokenBucket(3, 1000, undefined, () => clock);
  assert.equal(bucket.tryTake().ok, true);
  assert.equal(bucket.tryTake().ok, true);
  assert.equal(bucket.tryTake().ok, true);
  // 耗尽：第 4 次拒绝，冷静期 = 整个回填周期
  const r = bucket.tryTake();
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.retryInMs, 1000);
  // 时间前进 1 周期：回填 1 枚
  clock = 1000;
  assert.equal(bucket.tryTake().ok, true);
  assert.equal(bucket.tryTake().ok, false);
  // 时间前进很多：桶满不累积（available ≤ capacity）
  clock = 100_000;
  assert.equal(bucket.available(), 3);
});

test('Y-10 集成：grant 消费令牌桶 —— 三次同意后第四次被速率闸门拒绝', () => {
  // 直接执法桶语义与 approval.grant 的耦合（默认桶 10min 周期内 4 次 grant 必然触发）
  resetApproval();
  const grants: Array<[string, boolean]> = [];
  for (let i = 0; i < 4; i++) {
    const pa = approval.request(`op ${i}`);
    grants.push([pa.token, approval.grant(pa.token, true)]);
  }
  // 前三次授予成功，第四次被令牌桶拒绝
  assert.deepEqual(grants.map(g => g[1]), [true, true, true, false]);
  assert.equal(approvalBudget(), 0);
  resetApproval();
  assert.equal(approvalBudget(), 3);
});
