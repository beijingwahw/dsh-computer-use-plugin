// test/pan122.popupSchmitt.test.ts
// ΠΑΝ-122 执法册：popupDetector 施密特五键窗口参数的数值推导锁定。
// 参数依据成文于 src/popupDetector.ts 的 ΠΑΝ-122 注记块；本册用闭式复算
// （LOGIT/SIGMOID）锁定五个缺省字面量（priorWeight 0.05 / evidenceGeo 4.0 /
// evidenceSem 5.0 / evidenceClean −1.5 / on 0.6 / off 0.35）与真机弹窗时序
// 的适配不变量：
//   · 单帧强证据（几何/语义）⇒ 立即 ON（弹窗出现的下一次截图即拦截 —— 零漏帧）；
//   · ON 态单帧清洁 ⇒ 落入迟滞带保持（一帧 OCR 抖动不放行）；
//   · 双清洁帧 ⇒ 退出（真关了才放行 —— 确认成本 = 1 个动作步）；
//   · 语义证据强度序 > 几何（先验序立法）；
//   · 迟滞带宽 = 单帧清洁的信念跳变幅度（一帧噪声数学上不可能翻转状态）。
// 全离线确定性（SchmittPopupFilter 是纯类 —— 确定性事实源）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SchmittPopupFilter, resetPopupBelief } from '../src/popupDetector.ts';

// 与实现同式的闭式原子（测试侧独立复算 —— 参数推导的对照面）
const LOGIT = (p: number): number => Math.log(p / (1 - p));
const SIGMOID = (x: number): number => 1 / (1 + Math.exp(-x));
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

// 五键缺省字面量（与 src/popupDetector.ts 的 F-3 常量同值 —— 改参数 = 改推导）
const PRIOR = 0.05, EV_GEO = 4.0, EV_SEM = 5.0, EV_CLEAN = -1.5, ON = 0.6, OFF = 0.35;

beforeEach(() => { resetPopupBelief(); });

test('ΠΑΝ-122: 单帧几何证据 ⇒ 立即 ON，belief = σ(logit(0.05)+4.0) ≈ 0.743', () => {
  const f = new SchmittPopupFilter();
  const r = f.update({ geometric: true, semantic: false });
  assert.equal(r.active, true, '弹窗出现后的下一次截图即拦截（零漏帧窗口）');
  const expected = r3(SIGMOID(LOGIT(PRIOR) + EV_GEO));
  assert.ok(Math.abs(r.belief - expected) < 0.002,
    `几何帧信念推导锁定（实测 ${r.belief}，闭式 ${expected}）`);
  assert.ok(r.belief >= ON && r.belief < 0.8, `落在 ON 线上方的合理带（实测 ${r.belief}）`);
});

test('ΠΑΝ-122: 单帧语义证据更强 ⇒ ON，belief = σ(logit(0.05)+5.0) ≈ 0.786 > 几何', () => {
  const g = new SchmittPopupFilter().update({ geometric: true, semantic: false });
  const s = new SchmittPopupFilter().update({ geometric: false, semantic: true });
  assert.equal(s.active, true);
  assert.ok(s.belief > g.belief, `词表命中强于几何启发式（先验序立法：${s.belief} > ${g.belief}）`);
});

test('ΠΑΝ-122: ON 态单帧清洁 ⇒ 落迟滞带保持；双清洁 ⇒ 退出（确认成本 1 步）', () => {
  const f = new SchmittPopupFilter();
  f.update({ geometric: true, semantic: false });            // ON @ ≈0.743
  const one = f.update({ geometric: false, semantic: false }); // −1.5 nats
  const expectedOne = r3(SIGMOID(LOGIT(PRIOR) + EV_GEO + EV_CLEAN));
  assert.equal(one.active, true, '一帧清洁（OCR 抖动/关键词漏读）不放行');
  assert.ok(one.belief > OFF && one.belief < ON,
    `信念落迟滞带 (0.35,0.6)（实测 ${one.belief}，闭式 ${expectedOne}）`);
  assert.ok(Math.abs(one.belief - expectedOne) < 0.002, '清洁帧信念推导锁定');
  const two = f.update({ geometric: false, semantic: false });  // 再 −1.5 nats
  assert.equal(two.active, false, '连续两帧无证据 ⇒ 放行（真关了才放行）');
  assert.ok(two.belief <= OFF, `跌破 OFF 线（实测 ${two.belief}）`);
});

test('ΠΑΝ-122: 单帧清洁幅度（1.5 nats）< 触发态到 OFF 线的对数距离 —— 一帧噪声不可能直通放行', () => {
  // 结构不变量（对数域）：单帧强证据触发的 ON 态 log-odds ≈ +1.06；OFF 线
  // logit(0.35) ≈ −0.62；二者距离 1.68 nats > 单帧清洁幅度 1.5 nats ⇒ 单帧
  // 清洁只能把信念送进迟滞带（≈0.39），数学上不可能从触发态直通退出。
  const logitOn = LOGIT(PRIOR) + EV_GEO;            // 单帧几何触发态 ≈ 1.056
  const logitAfterClean = logitOn + EV_CLEAN;       // ≈ −0.444
  assert.ok(logitOn - LOGIT(OFF) > Math.abs(EV_CLEAN),
    `触发态到 OFF 线的 nats 距离（${(logitOn - LOGIT(OFF)).toFixed(2)}）> 清洁帧幅度 ` +
    `(${Math.abs(EV_CLEAN)}) —— 带内保持的对数域根据`);
  const beliefAfterClean = SIGMOID(logitAfterClean);
  assert.ok(beliefAfterClean > OFF && beliefAfterClean < ON,
    `单帧清洁落迟滞带（实测 ${beliefAfterClean.toFixed(3)} ∈ (0.35, 0.6)）`);
});

test('ΠΑΝ-122: 清洁场景恒 OFF（先验低 + 清洁证据单调降）—— 不误拦', () => {
  const f = new SchmittPopupFilter();
  for (let i = 0; i < 8; i++) {
    const r = f.update({ geometric: false, semantic: false });
    assert.equal(r.active, false, `清洁世界第 ${i + 1} 帧不放行（belief ${r.belief}）`);
  }
});

test('ΠΑΝ-122: OFF→ON 无死区 —— 弹窗关闭后立刻重弹走单帧强证据路径', () => {
  const f = new SchmittPopupFilter();
  f.update({ geometric: true, semantic: false });             // ON
  f.update({ geometric: false, semantic: false });            // 带内保持
  f.update({ geometric: false, semantic: false });            // OFF
  const again = f.update({ geometric: true, semantic: false }); // 重弹 ⇒ 立即再 ON
  assert.equal(again.active, true, 'cookie 横幅复现：单帧强证据即再拦截');
});
