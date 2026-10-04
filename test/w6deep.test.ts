// test/w6deep.test.ts
// W6-5「深化三连包」执法册:三个能力缺口的实质深化 —— 手算执法 + 行为兼容 + 防御绝不抛。
//
//   W6-5-1 水平滚动支持(motionEstimator):
//     · 列亮度横向相位相关手算 —— 线性斜坡纯窗移(整数位移精确恢复,残差=0)、
//       半列位移 2.5(平局裁决 + 三点抛物线顶点精确恢复 + 残差 5/182.5=0.027)、
//       短输入守卫(n<4 ⇒ 零位移满残差);
//     · judgeScroll 水平方向输出:列证据注入 ⇒ directionConsistent 可判
//       (scroll right ⇒ 内容左移 ⇒ shift<0 同律对偶);脏证据(NaN)视同缺席回落旧行为;
//     · 纵向零回归:estimateRowShift 与 estimateColShift 同输入逐字节同输出
//       (共享数学核的结构执法)+ 纵向判决/旧行为数值锁定;
//     · sharp 合成真图端到端:循环斜坡横向平移 8 列 ⇒ 列亮度序列精确恢复。
//   W6-5-2 技能骨架重蒸馏合并(skillLibrary):
//     · 回流:同骨架新证据 merge 模式 ⇒ parents 并 + 洞 Beta 门重算
//       (s=2,f=0 ⇒ 0.75 恰过门 → s=3,f=0 ⇒ 0.8)+ 版本号+1 + 绑定账本回流;
//     · 门不过 ⇒ 不合并('merge-gate' 拒绝),证据保留池(反证技能原样在库);
//     · 幂等护栏:无新支撑母体 ⇒ 版本不动;
//     · 旧行为锁定:merge 缺省 ⇒ 'skeleton-exists' 首酿优先原样;
//     · 版本演进跨快照 + 旧绑定产物不失效(按模板 id 继续命中)。
//   W6-5-3 多任务分段评分(processScore):
//     · AGENT_BEGIN 边界切分:多任务轨迹 ⇒ 段数组(每段过程分+终局分+首低分步)
//       + 步数加权汇总(口径注明:段间步数加权,段内 late-bias);
//     · 汇总手算:plain=Σnᵢpᵢ/Σnᵢ / weighted=Σnᵢwᵢ/Σnᵢ / final_mean / blended;
//     · prologue 段(首 BEGIN 前散布 ⇒ objective=null 诚实缺席;空则不成段);
//     · 旧单任务行为不变:scoreJournalText 多任务仍取最后 AGENT_END(旧行为锁定),
//       无 BEGIN ⇒ 单段且与旧口径数值一致;
//     · 防御:空轨迹/非字符串/垃圾行绝不抛;离线确定性(同输入深度相等)。
// 全程离线确定性:纯文本/纯符号输入、内存库(filePath='' ⇒ 零落盘)、零网络零截屏。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateRowShift, estimateColShift, judgeScroll, stillTranslating,
  type RowShiftEstimate,
} from '../src/motionEstimator.ts';
import {
  skillLibrary,
  TEMPLATE_MIN_PARENTS, TEMPLATE_HOLE_POSTERIOR_GATE,
  type SkillStep, type TemplateHoleSlot,
} from '../src/skillLibrary.ts';
import {
  scoreJournalText, scoreJournalSegmentsText, scoreJournalSegmentsLines,
  renderSegmentedScore,
} from '../src/processScore.ts';
import type { SharpLike } from '../src/_legacyDeps.ts';

const { getSharp } = await import('../src/_legacyDeps.ts');

// ═══ W6-5-1:水平滚动支持(列亮度横向相位相关) ═══

/** 线性斜坡序列(纯数学测试地:错位误差 e(s') = c·|s'-s| 处处精确可手算) */
const ramp = (n: number): number[] => Array.from({ length: n }, (_, i) => 10 * i);
/** 斜坡纯窗移:colsB[y] = 10·(y - s)(内容右移 s 列 —— 与亮度取值域无关的合成) */
const shiftedRamp = (n: number, s: number): number[] => Array.from({ length: n }, (_, y) => 10 * (y - s));

test('W6-5-1: 列亮度整数位移手算 —— 斜坡纯窗移 ⇒ 精确恢复(残差=0)', () => {
  // 手算:a[x]=10x,b[y]=10(y-4) ⇒ e(s') = mean|10y-10(y+s'-4)| = 10|s'-4|
  // ⇒ 最优 s'=4 处 e=0;邻点 e(3)=e(5)=10 ⇒ 抛物线 frac=(10-10)/(2·20)=0 ⇒ shift=4.00
  // scale=(avg a+avg b)/2=(195+175)/2=185 ⇒ residual=min(1,0/185)=0
  const est = estimateColShift(ramp(40), shiftedRamp(40, 4));
  assert.equal(est.bestInteger, 4);
  assert.equal(est.shift, 4);
  assert.equal(est.residual, 0);

  // 左移(负位移)同律
  const neg = estimateColShift(ramp(40), shiftedRamp(40, -3));
  assert.equal(neg.bestInteger, -3);
  assert.equal(neg.shift, -3);
  assert.equal(neg.residual, 0);
});

test('W6-5-1: 亚列精度三点抛物线手算 —— 半列位移 2.5 精确恢复', () => {
  // 手算:b[y]=10y-25(= a[y-2.5]) ⇒ e(s') = mean|10y-(10(y+s')-25)| = |25-10s'|
  // s'=2 ⇒ 5,s'=3 ⇒ 5 平局 ⇒ 升序搜索先到者胜(best=2,bestE=5);
  // 抛物线:eM=e(1)=15,eP=e(3)=5,denom=15-2·5+5=10 ⇒ frac=(15-5)/(2·10)=0.5
  // ⇒ shift=2+0.5=2.5(顶点恰在两整数中点 —— 平局裁决的对称解)
  const b = Array.from({ length: 40 }, (_, y) => 10 * y - 25);
  const est = estimateColShift(ramp(40), b, 16);
  assert.equal(est.bestInteger, 2);
  assert.equal(est.shift, 2.5);
  // 残差手算:avg a=195,avg b=170 ⇒ scale=182.5 ⇒ 5/182.5=0.0274 ⇒ r3=0.027
  assert.equal(est.residual, 0.027);
});

test('W6-5-1: 短输入守卫 —— n<4 ⇒ 零位移满残差(纵向同律的防御面)', () => {
  assert.deepEqual(estimateColShift([1, 2], [1, 2]), { shift: 0, residual: 1, bestInteger: 0 });
  assert.deepEqual(estimateColShift([], []), { shift: 0, residual: 1, bestInteger: 0 });
});

test('W6-5-1: judgeScroll 水平方向输出 —— 列证据注入 ⇒ 方向一致性可判', () => {
  const rowZero: RowShiftEstimate = { shift: 0, residual: 1, bestInteger: 0 }; // 行证据无信息
  const right = { shift: 4, residual: 0.2, bestInteger: 4 };   // 内容右移 4 列
  const left = { shift: -4, residual: 0.2, bestInteger: -4 };  // 内容左移 4 列

  // 约定对偶:scroll left ⇒ 内容右移(shift>0)⇒ 一致;scroll right ⇒ 内容左移 ⇒ 一致
  assert.deepEqual(judgeScroll(rowZero, 'left', right),
    { effective: true, directionConsistent: true, atBoundary: false });
  assert.deepEqual(judgeScroll(rowZero, 'right', left),
    { effective: true, directionConsistent: true, atBoundary: false });
  // 反向:位移与请求方向相反 ⇒ directionConsistent=false(物理事实,非缺席)
  assert.deepEqual(judgeScroll(rowZero, 'right', right),
    { effective: true, directionConsistent: false, atBoundary: false });
  assert.deepEqual(judgeScroll(rowZero, 'left', left),
    { effective: true, directionConsistent: false, atBoundary: false });

  // 边界:低残差零位移 ⇒ 画面真实静止(atBoundary),方向一致性缺席(null)
  const still = { shift: 0.1, residual: 0.2, bestInteger: 0 };
  assert.deepEqual(judgeScroll(rowZero, 'right', still),
    { effective: false, directionConsistent: null, atBoundary: true });

  // 弱平移假设(高残差):动了也不算 effective —— 与纵向同尺执法
  const noisy = { shift: 5, residual: 0.7, bestInteger: 5 };
  assert.deepEqual(judgeScroll(rowZero, 'left', noisy),
    { effective: false, directionConsistent: null, atBoundary: false });
});

test('W6-5-1: 旧行为逐字节锁定 —— 列证据缺席/脏证据 ⇒ 水平判决保持 W3-3 形态', () => {
  const row: RowShiftEstimate = { shift: 5, residual: 0.2, bestInteger: 5 };
  const legacy = { effective: true, directionConsistent: null, atBoundary: false };
  // 两参调用(既有调用方形态)⇒ directionConsistent=null 诚实缺席
  assert.deepEqual(judgeScroll(row, 'right'), legacy);
  assert.deepEqual(judgeScroll(row, 'left'), legacy);
  // 显式 undefined/null 列证据 ⇒ 同上
  assert.deepEqual(judgeScroll(row, 'right', undefined), legacy);
  assert.deepEqual(judgeScroll(row, 'right', null), legacy);
  // 脏证据(NaN/Infinity)⇒ 防御回落旧行为,绝不抛
  assert.deepEqual(judgeScroll(row, 'right', { shift: NaN, residual: 0.2, bestInteger: NaN }), legacy);
  assert.deepEqual(judgeScroll(row, 'right', { shift: Infinity, residual: 0.2, bestInteger: 1 }), legacy);
});

test('W6-5-1: 纵向零回归 —— 共享数学核 ⇒ 行/列同输入逐字节同输出', () => {
  const a = ramp(40);
  const b = shiftedRamp(40, 4);
  assert.deepEqual(estimateRowShift(a, b), estimateColShift(a, b));
  // 既有纵向数值锁定(手算同上文:e(s')=10|s'-4| ⇒ 精确 4.00 / 残差 0)
  const rowEst = estimateRowShift(a, b);
  assert.equal(rowEst.shift, 4);
  assert.equal(rowEst.bestInteger, 4);
  assert.equal(rowEst.residual, 0);
  // 纵向判决不受列证据干扰(纵向只认行证据 —— scroll down ⇒ 内容上移 ⇒ shift<0 一致)
  assert.deepEqual(
    judgeScroll({ shift: -3, residual: 0.1, bestInteger: -3 }, 'down', { shift: 9, residual: 0.1, bestInteger: 9 }),
    { effective: true, directionConsistent: true, atBoundary: false },
  );
  assert.deepEqual(
    judgeScroll({ shift: 3, residual: 0.1, bestInteger: 3 }, 'down'),
    { effective: true, directionConsistent: false, atBoundary: false },
  );
  // stillTranslating 轴无关纯判:列移估计同样可入参
  assert.equal(stillTranslating({ shift: 4, residual: 0.2, bestInteger: 4 }), true);
  assert.equal(stillTranslating({ shift: 0.5, residual: 0.2, bestInteger: 0 }), false);
  assert.equal(stillTranslating({ shift: 4, residual: 0.7, bestInteger: 4 }), false);
});

// ── sharp 合成(不可用时 SKIP —— 仓库先例) ──
let sharpCache: SharpLike | null = null;
async function requireSharp(): Promise<SharpLike> {
  if (!sharpCache) sharpCache = await getSharp();
  return sharpCache;
}
async function withSharp<T>(t: { skip(msg: string): void }, fn: (s: SharpLike) => Promise<T>): Promise<T | undefined> {
  let s: SharpLike;
  try {
    s = await requireSharp();
  } catch (e: unknown) {
    t.skip(`sharp not installed — ${String((e as { message?: string })?.message ?? e).slice(0, 240)}`);
    return undefined;
  }
  return fn(s);
}

test('W6-5-1: sharp 合成真图 —— 循环斜坡横向平移 8 列 ⇒ 列亮度序列精确恢复', async (t) => {
  await withSharp(t, async (s) => {
    const W = 64, H = 32;
    // 逐列灰度纹理 v(x)=4·((x-offset) mod W)(竖向均匀 —— 列移估计的理想输入;
    // 循环移位消除窗效应:PNG 无损往返下列均值恒等)
    const build = (offset: number): Buffer => {
      const raw = Buffer.alloc(W * H * 3);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const g = 4 * (((x - offset) % W + W) % W);
          const i = (y * W + x) * 3;
          raw[i] = raw[i + 1] = raw[i + 2] = g;
        }
      }
      return raw;
    };
    const colMeans = async (raw: Buffer): Promise<number[]> => {
      const png = await s(raw, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
      const { data } = await s(png).raw().toBuffer({ resolveWithObject: true }) as unknown as { data: Buffer };
      const cols: number[] = [];
      for (let x = 0; x < W; x++) {
        let sum = 0;
        for (let y = 0; y < H; y++) {
          const i = (y * W + x) * 3;
          sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
        }
        cols.push(sum / H);
      }
      return cols;
    };
    const before = await colMeans(build(0));
    const after = await colMeans(build(8)); // 内容右移 8 列
    // 手算:循环斜坡 ⇒ e(8)=0 精确(bestInteger=8,residual=0)。亚列小量偏移是
    // 已知边界行为:循环缝(值 252→0 跳变)落在 e(7) 的有效窗内而在 e(9) 窗外
    // ⇒ 三点抛物线邻点不对称 ⇒ 顶点略偏(约 +0.18)。执法口径:整数位移精确、
    // 亚列位移在 ±0.5 合同带内(纯序列的精确手算在上文两个 ramp 用例)。
    const est = estimateColShift(before, after);
    assert.equal(est.bestInteger, 8);
    assert.ok(Math.abs(est.shift - 8) <= 0.5, `shift=${est.shift} 应在 8±0.5 亚列合同带内`);
    assert.ok(est.residual <= 0.05, `residual=${est.residual} 应近零`);
    // 端到端判决:内容右移 ⇒ scroll left 方向一致
    const verdict = judgeScroll({ shift: 0, residual: 1, bestInteger: 0 }, 'left', est);
    assert.equal(verdict.effective, true);
    assert.equal(verdict.directionConsistent, true);
    assert.equal(verdict.atBoundary, false);
    const opposite = judgeScroll({ shift: 0, residual: 1, bestInteger: 0 }, 'right', est);
    assert.equal(opposite.directionConsistent, false);
  });
});

// ═══ W6-5-2:技能骨架重蒸馏合并(同骨架新证据回流) ═══

beforeEach(() => {
  skillLibrary.configure(true, '', 50); // filePath='' ⇒ save() 零落盘(离线确定性)
  skillLibrary.reset();
});

const clickX = (x: number): SkillStep => ({ tool: 'click_mouse', args: { x } });
const hotkey = (keys: string): SkillStep => ({ tool: 'press_hotkey', args: { keys } });
/** 同骨架两步技能:click(x 洞位) + hotkey(ctrl+a 常量) */
const twoStep = (x: number): SkillStep[] => [clickX(x), hotkey('ctrl+a')];

/** 洞槽读取助手(类型收窄) */
function holeOf(x: unknown): TemplateHoleSlot {
  assert.ok(x && typeof x === 'object' && (x as TemplateHoleSlot).kind === 'hole');
  return x as TemplateHoleSlot;
}

test('W6-5-2: 重蒸馏回流 —— 同骨架新证据合并既有模板(parents 并/Beta 门重算/版本+1)', () => {
  const a = skillLibrary.induce('工作流 A', twoStep(0.1))!;
  const b = skillLibrary.induce('工作流 B', twoStep(0.9))!;
  assert.ok(a && b);

  const first = skillLibrary.distillTemplates();
  assert.equal(first.created.length, 1);
  assert.equal(first.merged.length, 0); // 新增字段缺省空账(形状纯增量)
  const tpl = first.created[0];
  assert.equal(tpl.version, 1);         // 首酿版本 1
  assert.deepEqual(tpl.parents, [a.id, b.id]);
  // 洞后验手算:s=2,f=0 ⇒ (2+1)/(2+0+2)=0.75 —— 恰过门(门限 0.75 非「<」即拒)
  assert.equal(TEMPLATE_MIN_PARENTS, 2);
  const hole = holeOf(tpl.steps[0].args.x);
  assert.equal(hole.posteriorMean, 0.75);
  assert.equal(hole.bindings.length, 2);

  // 新证据:第三个同骨架技能(x=0.5)
  const c = skillLibrary.induce('工作流 C', twoStep(0.5))!;

  // 旧行为锁定:merge 缺省 ⇒ 'skeleton-exists' 首酿优先,模板纹丝不动
  const legacy = skillLibrary.distillTemplates();
  assert.equal(legacy.created.length, 0);
  assert.ok(legacy.rejected.some(r => r.reason === 'skeleton-exists'));
  const untouched = skillLibrary.getTemplate(tpl.id)!;
  assert.equal(untouched.version, 1);
  assert.deepEqual(untouched.parents, [a.id, b.id]);
  assert.equal(holeOf(untouched.steps[0].args.x).posteriorMean, 0.75);

  // 合并模式:新证据回流既有模板
  const mergedRun = skillLibrary.distillTemplates(64, { merge: true });
  assert.equal(mergedRun.merged.length, 1); // (A,B) 触发回流;(A,C)/(B,C) 幂等不再并
  const m = mergedRun.merged[0];
  assert.equal(m.templateId, tpl.id);       // id 不变
  assert.equal(m.version, 2);               // 版本 +1
  assert.deepEqual(m.addedParents, [c.id]); // 增量 = 新支撑母体
  assert.deepEqual(m.parents, [a.id, b.id, c.id]); // parents 集合并
  const t2 = skillLibrary.getTemplate(tpl.id)!;
  assert.equal(t2.version, 2);
  assert.deepEqual(t2.parents, [a.id, b.id, c.id]);
  // 洞 Beta 门重算手算:s=3,f=0 ⇒ (3+1)/(3+0+2)=0.8;绑定账本回流 3 母体实值
  const hole2 = holeOf(t2.steps[0].args.x);
  assert.equal(hole2.posteriorMean, 0.8);
  assert.deepEqual(hole2.bindings.map(v => v.value).sort(), [0.1, 0.5, 0.9]);
  assert.deepEqual(hole2.bindings.map(v => v.skillId).sort(), [a.id, b.id, c.id].sort());
  assert.ok(m.worstPosterior >= TEMPLATE_HOLE_POSTERIOR_GATE); // 过门数值的审计面

  // 幂等护栏:无新支撑母体再跑合并 ⇒ 版本不动
  const again = skillLibrary.distillTemplates(64, { merge: true });
  assert.equal(again.merged.length, 0);
  assert.equal(skillLibrary.getTemplate(tpl.id)!.version, 2);
  assert.ok(again.rejected.some(r => r.reason === 'skeleton-exists'));
});

test('W6-5-2: 门不过 ⇒ 不合并(merge-gate 拒绝),证据保留池', () => {
  const a = skillLibrary.induce('工作流 A', twoStep(0.1))!;
  const b = skillLibrary.induce('工作流 B', twoStep(0.9))!;
  const first = skillLibrary.distillTemplates();
  assert.equal(first.created.length, 1);
  const tpl = first.created[0];

  // 反证证据:同骨架但 click 步缺 x 槽 —— 该槽位在同骨架工作流上不守恒
  const d = skillLibrary.induce('工作流 D', [{ tool: 'click_mouse', args: {} }, hotkey('ctrl+a')])!;

  const res = skillLibrary.distillTemplates(64, { merge: true });
  assert.equal(res.merged.length, 0);
  const gate = res.rejected.find(r => r.reason === 'merge-gate');
  assert.ok(gate, `merge-gate 拒绝在场: ${JSON.stringify(res.rejected.map(r => r.reason))}`);
  // 门数值手算:pool=[A,B,D] ⇒ D 的 x 槽缺席 ⇒ s=2,f=1 ⇒ (2+1)/(2+1+2)=0.6 < 0.75
  assert.ok(gate!.detail!.includes('0.6'), gate!.detail);
  // 模板不动(版本/母体/后验原样)
  const t = skillLibrary.getTemplate(tpl.id)!;
  assert.equal(t.version, 1);
  assert.deepEqual(t.parents, [a.id, b.id]);
  assert.equal(holeOf(t.steps[0].args.x).posteriorMean, 0.75);
  // 证据保留池:反证技能原样在库(后续蒸馏随证据积累可再试 —— 不销毁任何证据)
  assert.ok(skillLibrary.get(d.id));
  assert.equal(skillLibrary.get(d.id)!.steps.length, 2);
});

test('W6-5-2: 版本演进跨快照 + 旧绑定产物不失效(按模板 id 继续命中)', () => {
  const a = skillLibrary.induce('工作流 A', twoStep(0.1))!;
  const b = skillLibrary.induce('工作流 B', twoStep(0.9))!;
  const first = skillLibrary.distillTemplates();
  const tpl = first.created[0];
  const c = skillLibrary.induce('工作流 C', twoStep(0.5))!;
  const m = skillLibrary.distillTemplates(64, { merge: true });
  assert.equal(m.merged.length, 1);

  // 快照往返:版本与合并后 parents 不丢
  const snap = skillLibrary.dump();
  skillLibrary.reset();
  skillLibrary.restore(snap);
  const t = skillLibrary.getTemplate(tpl.id)!;
  assert.equal(t.version, 2);
  assert.deepEqual(t.parents, [a.id, b.id, c.id]);

  // 旧绑定产物不失效:合并后按 id 绑定照常(洞读值 + 常量槽原样回放)
  const bind = skillLibrary.bindTemplate(tpl.id, req => (req.key === 'x' ? 0.7 : undefined));
  assert.equal(bind.ok, true);
  assert.deepEqual(bind.steps, [clickX(0.7), hotkey('ctrl+a')]);
  // 骨架召回仍命中(matchTemplates 的 skeleton-hash 通道)
  const hits = skillLibrary.matchTemplates({ skeleton: ['click_mouse', 'press_hotkey'] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, tpl.id);
  // 合并后仍可继续演进:第四个同骨架证据 ⇒ 版本 3
  skillLibrary.induce('工作流 E', twoStep(0.7));
  const m3 = skillLibrary.distillTemplates(64, { merge: true });
  assert.equal(m3.merged.length, 1);
  assert.equal(m3.merged[0].version, 3);
  assert.equal(skillLibrary.getTemplate(tpl.id)!.version, 3);
  // 洞后验持续回流:s=4,f=0 ⇒ (4+1)/(4+0+2)≈0.833
  assert.equal(holeOf(skillLibrary.getTemplate(tpl.id)!.steps[0].args.x).posteriorMean, 0.833);
});

// ═══ W6-5-3:多任务分段评分(AGENT_BEGIN 边界切分) ═══

// ── 构造工坊(与 w3score 同律的行助手 —— 手算例的最小证据面) ──

function click(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { tool: 'click_mouse', ts: 1700000000000, status: 'SUCCESS', args: { x: 0.5, y: 0.5 }, ...over };
}
const BEGIN = (taskId: string, objective: string): Record<string, unknown> =>
  ({ tool: 'AGENT_BEGIN', ts: 1, status: 'MARKER', args: { taskId, role: 'main', objective } });
const END = (taskId: string, status: string): Record<string, unknown> =>
  ({ tool: 'AGENT_END', ts: 9, status: 'MARKER', args: { taskId, status } });
const jl = (...lines: Record<string, unknown>[]): string => lines.map(l => JSON.stringify(l)).join('\n');

/** 好步:全证据 ⇒ 1.0(w3score 手算同款) */
const good = () => click({
  args: { x: 1, y: 1 },
  effect_detected: true, scale: 'page-level',
  intent: { expected: 'a', satisfied: true, evidence: 'x' },
});
/** 坏步:effect=0 + intent=0 + wait=0.6 ⇒ 0.2·1+0.2·0.6=0.32(w3score 手算同款) */
const bad = () => ({
  tool: 'press_hotkey', ts: 2, status: 'SUCCESS', args: { keys: 'enter' },
  effect_detected: false, intent: { expected: 'b', satisfied: false, evidence: 'x' },
});
/** 中性步:全缺席 ⇒ 0.6 */
const mid = () => ({ tool: 'type_text', ts: 3, status: 'SUCCESS', args: { text: 'hi' } });

/** 两任务轨迹:任务一(good+bad ⇒ [1.0,0.32])成功;任务二(mid ⇒ [0.6])失败 */
function multiTaskText(): string {
  return jl(
    BEGIN('t1', '任务一:填写表单'),
    good(), bad(),
    END('t1', 'success'),
    BEGIN('t2', '任务二:发送邮件'),
    mid(),
    END('t2', 'failed'),
  );
}

test('W6-5-3: 多任务切分 —— 段数组(过程分+终局分+首低分步)+ 步数加权汇总手算', () => {
  const rep = scoreJournalSegmentsText(multiTaskText());
  assert.equal(rep.ok, true);
  assert.equal(rep.caliber_version, 'E4-v1');
  assert.equal(rep.generated_by, 'W6-5 processScore.segments');
  assert.equal(rep.segment_count, 2);
  assert.equal(rep.totals.lines_total, 7);
  assert.equal(rep.totals.marker_lines, 4);
  assert.equal(rep.totals.action_steps, 3);

  // 段一:[1.0, 0.32] ⇒ plain=0.66,weighted=0.49(w3score 锁定值),final=1,blended=0.643
  const s0 = rep.segments[0];
  assert.equal(s0.index, 0);
  assert.equal(s0.objective, '任务一:填写表单');
  assert.equal(s0.report.task.step_count, 2);
  assert.equal(s0.report.task.plain_mean, 0.66);
  assert.equal(s0.report.task.weighted_mean, 0.49);
  assert.equal(s0.report.task.final_score, 1);
  assert.equal(s0.report.task.final_status, 'success');
  assert.equal(s0.report.task.blended, 0.643);
  assert.equal(s0.report.first_low_step?.index, 1); // 0.32 < 0.35 ⇒ 首低分步在段内锚定
  assert.equal(s0.report.first_low_step?.score, 0.32);

  // 段二:[0.6] ⇒ plain=weighted=0.6,final=0(failed),blended=0.7·0.6=0.42
  const s1 = rep.segments[1];
  assert.equal(s1.index, 1);
  assert.equal(s1.objective, '任务二:发送邮件');
  assert.equal(s1.report.task.step_count, 1);
  assert.equal(s1.report.task.plain_mean, 0.6);
  assert.equal(s1.report.task.weighted_mean, 0.6);
  assert.equal(s1.report.task.final_score, 0);
  assert.equal(s1.report.task.final_status, 'failed');
  assert.equal(s1.report.task.blended, 0.42);
  assert.equal(s1.report.first_low_step, null); // 0.6 ≥ 0.35 ⇒ 段内无低分步

  // 汇总手算(口径:段间步数加权,段内 late_bias):
  //   plain = (2·0.66 + 1·0.6)/3 = 1.92/3 = 0.64
  //   weighted = (2·0.49 + 1·0.6)/3 = 1.58/3 = 0.527
  //   final_mean = (1+0)/2 = 0.5;blended = 0.7·0.527+0.3·0.5 = 0.519
  const sm = rep.summary;
  assert.equal(sm.method, 'step-weighted');
  assert.equal(sm.total_steps, 3);
  assert.equal(sm.plain_mean, 0.64);
  assert.equal(sm.weighted_mean, 0.527);
  assert.deepEqual(sm.final_scores, [1, 0]);
  assert.equal(sm.final_mean, 0.5);
  assert.equal(sm.blended, 0.519);
});

test('W6-5-3: 旧单任务行为不变 —— scoreJournalText 多任务仍取最后 AGENT_END(旧行为锁定)', () => {
  // 现状口径:objective=首个 BEGIN;final=最后 END('failed' ⇒ 0);三步全局 late-bias
  const rep = scoreJournalText(multiTaskText());
  assert.equal(rep.task.objective, '任务一:填写表单');
  assert.equal(rep.task.final_status, 'failed');
  assert.equal(rep.task.final_score, 0);
  // 手算:n=3 ⇒ w=[0.5,1.0,1.5] ⇒ weighted=(0.5·1+1·0.32+1.5·0.6)/3=1.72/3=0.573
  // (与分段口径 0.527 不同恰是刻度差异的执法证据:late_bias 段内独立 vs 全局)
  assert.equal(rep.task.weighted_mean, 0.573);
  assert.equal(rep.task.plain_mean, 0.64); // plain 两口径一致(加权只差在权重)
  assert.equal(rep.task.blended, 0.401);   // 0.7·0.573+0.3·0

  // 单任务(无 BEGIN)⇒ 与旧口径逐值一致,分段入口套单段壳数值相同
  const single = jl(good(), bad(), END('t1', 'success'));
  const legacySingle = scoreJournalText(single);
  const segSingle = scoreJournalSegmentsText(single);
  assert.equal(segSingle.segment_count, 1);
  assert.equal(segSingle.segments[0].objective, null); // 无 BEGIN ⇒ 无任务语境(诚实缺席)
  assert.equal(segSingle.summary.weighted_mean, legacySingle.task.weighted_mean); // 0.49
  assert.equal(segSingle.summary.plain_mean, legacySingle.task.plain_mean);       // 0.66
  assert.equal(segSingle.summary.final_mean, legacySingle.task.final_score);      // 1
  assert.equal(segSingle.summary.blended, legacySingle.task.blended);             // 0.643
  assert.deepEqual(segSingle.segments[0].report.steps, legacySingle.steps);       // 步分逐位一致
});

test('W6-5-3: prologue 段 —— 首 BEGIN 前散步成段(objective=null),空则不成段', () => {
  const withPrologue = jl(
    mid(), // 任务语境外的头部散步
    BEGIN('t1', '任务一'),
    good(),
    END('t1', 'success'),
    BEGIN('t2', '任务二'),
    bad(),
    END('t2', 'failed'),
  );
  const rep = scoreJournalSegmentsText(withPrologue);
  assert.equal(rep.segment_count, 3);
  assert.deepEqual(rep.segments.map(s => s.objective), [null, '任务一', '任务二']);
  assert.equal(rep.segments[0].report.task.step_count, 1);
  assert.equal(rep.segments[0].report.task.final_score, null); // prologue 无终局标记 ⇒ 诚实 null
  assert.equal(rep.summary.final_scores.length, 3);
  assert.deepEqual(rep.summary.final_scores, [null, 1, 0]);    // 缺席段不计入 final_mean
  assert.equal(rep.summary.final_mean, 0.5);
  // blended 需要 weighted+final_mean 齐备:两者都在 ⇒ 有值(缺席终局只影响 final_mean 口径)
  assert.equal(rep.summary.total_steps, 3);

  // 空 prologue(首行即 BEGIN)⇒ 不成段
  const noPrologue = scoreJournalSegmentsText(jl(BEGIN('t1', '任务一'), good(), END('t1', 'success')));
  assert.equal(noPrologue.segment_count, 1);
  assert.equal(noPrologue.segments[0].objective, '任务一');
});

test('W6-5-3: 防御 —— 空轨迹/非字符串/垃圾行/缺 BEGIN 单段,绝不抛', () => {
  const empty = scoreJournalSegmentsText('');
  assert.equal(empty.ok, true);
  assert.equal(empty.segment_count, 1);   // 无 BEGIN 边界 ⇒ 单段(空段,套段壳的现状)
  assert.equal(empty.summary.total_steps, 0);
  assert.equal(empty.summary.plain_mean, null);
  assert.equal(empty.summary.weighted_mean, null);
  assert.equal(empty.summary.final_mean, null);
  assert.equal(empty.summary.blended, null);

  const weird = scoreJournalSegmentsText(undefined as unknown as string);
  assert.equal(weird.ok, true);
  assert.equal(weird.segments.length, 1);
  assert.equal(weird.segments[0].report.task.step_count, 0);

  const garbage = scoreJournalSegmentsText('not json\n42\nnull');
  assert.equal(garbage.ok, true);
  assert.equal(garbage.totals.lines_garbage, 3);
  assert.equal(garbage.totals.lines_total, 3);
  assert.equal(garbage.summary.total_steps, 0);

  const nullLines = scoreJournalSegmentsLines(null as unknown as readonly unknown[]);
  assert.equal(nullLines.ok, true);
  assert.equal(nullLines.segment_count, 1);

  // 混合垃圾+好行+多任务:垃圾计数并入整体 totals,好行照评
  const mixed = scoreJournalSegmentsText('garbage\n' + multiTaskText() + '\n{"tool":1}');
  assert.equal(mixed.ok, true);
  assert.equal(mixed.segment_count, 2);
  assert.equal(mixed.totals.lines_garbage, 2);
  assert.equal(mixed.totals.lines_total, 9);
  assert.equal(mixed.summary.total_steps, 3);
});

test('W6-5-3: 选项注入与离线确定性 —— 同输入深度相等;权重注入透传到每段', () => {
  const text = multiTaskText();
  assert.deepEqual(scoreJournalSegmentsText(text), scoreJournalSegmentsText(text));
  // 单通道隔离注入 ⇒ 每段的 calibration 同值(段间共享同一执法刻度)
  const injected = scoreJournalSegmentsText(text, { weights: { effect: 1, intent: 0, oscillation: 0, wait: 0 } });
  assert.deepEqual(injected.segments[0].report.calibration.weights, { effect: 1, intent: 0, oscillation: 0, wait: 0 });
  assert.deepEqual(injected.segments[1].report.calibration.weights, { effect: 1, intent: 0, oscillation: 0, wait: 0 });
});

test('W6-5-3: 渲染 —— 段清单 + 汇总口径自解释', () => {
  const text = renderSegmentedScore(scoreJournalSegmentsText(multiTaskText()));
  assert.match(text, /ProcessScore\.segments/);
  assert.match(text, /segments=2/);
  assert.match(text, /seg#0 : 任务一:填写表单/);
  assert.match(text, /seg#1 : 任务二:发送邮件/);
  assert.match(text, /method=step-weighted/);
  assert.match(text, /weighted=0\.527/);
  assert.match(text, /blended=0\.519/);
  const bad2 = renderSegmentedScore(scoreJournalSegmentsLines(null as unknown as readonly unknown[]));
  assert.match(bad2, /internal-error|segments/);
});
