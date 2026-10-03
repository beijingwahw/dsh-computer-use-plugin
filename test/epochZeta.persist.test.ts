// test/epochZeta.persist.test.ts
// 纪元 Ζ（持久化与标定接线）执法册 —— 两条登记在册缝隙的闭合验收：
//   Ζ-1 selfModel 账 checkpoint 往返：铸账（含衰减态）→ save → load ⇒ 账逐字段
//      复活（含半衰期懒衰减续结算正确）；坏 selfModel 段 ⇒ SKIPPED 空模型 +
//      其余子系统照常水合（坏段隔离不连坐）；段内坏行 ⇒ 半水合（Ι 语义穿层）。
//   Ζ-2 v4 旧档读入：无 selfModel 段 = 诚实冷启动；锚补 null 的旧档零锚告警
//      误报；锚机制未被 Ζ 削弱（篡改锚照常 MISMATCH 置顶）。
//   Ζ-3 睡眠④幕接线：足样本（journal 坐标漂移对 + telemetry 延迟尾统计）⇒
//      晨报含标定建议书（≥1 原子建议值在场，GPD 值与直接重算确定性相等）；
//      样本不足 ⇒ 建议书诚实缺席（缺席注记在案，绝不伪造）。
//   Ζ-4 旁路律：selfModel.dump/restore 注入 throw、标定数据面 throw ⇒
//      checkpoint 原子落盘照常完成 + 睡眠六幕照演，error 只作注记绝不炸主流程。
// 全程离线、注入时钟、确定性（零网络零真钟零真睡）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveCheckpoint, loadCheckpoint } from '../src/checkpoint.ts';
import { selfModel, resetSelfModel } from '../src/selfmodel/index.ts';
import { uiMemory } from '../src/uiMemory.ts';
import { failureMemory } from '../src/failureMemory.ts';
import { skillLibrary } from '../src/skillLibrary.ts';
import { telemetry } from '../src/telemetry.ts';
import { journal } from '../src/journal.ts';
import { runSleepCycle, resetSleepCycle, type SleepDeps } from '../src/sleep/index.ts';
import { gpdAdCriticalTable } from '../src/calibration.ts';

let dir: string;
const dirs: string[] = [];
beforeEach(() => {
  uiMemory.reset();
  failureMemory.reset();
  skillLibrary.reset();
  telemetry.reset();
  journal.reset();
  resetSelfModel();
  resetSleepCycle();
  dir = mkdtempSync(join(tmpdir(), 'epoch-zeta-'));
  dirs.push(dir); // 每用例一个目录 —— 退出时逐个回收（测试自洁）
});

// ─── Ζ-1：selfModel 账的 checkpoint 往返 ───

test('Ζ-1: 铸 selfModel 账（含衰减态）→ save → load ⇒ 逐字段复活；坏段隔离不连坐', async () => {
  const T0 = 1_700_000_000_000;
  const HALF = 3_600_000; // halfLifeH=1 的一个半衰期（ms）
  selfModel.configure({ now: () => T0, halfLifeH: 1, minEvidence: 2 });
  // 铸账：click_mouse 单轴格 10 成 2 败 + 场景格 5 成（全部 @T0）
  for (let i = 0; i < 10; i++) selfModel.recordOutcome({ actionKind: 'click_mouse' }, true, T0);
  for (let i = 0; i < 2; i++) selfModel.recordOutcome({ actionKind: 'click_mouse' }, false, T0);
  for (let i = 0; i < 5; i++) selfModel.recordOutcome({ actionKind: 'click_mouse', sceneBucket: 'f3a0' }, true, T0);

  const T1 = T0 + HALF;
  selfModel.configure({ now: () => T1 }); // 推进一个半衰期（部分覆盖语义：只换钟）

  const file = join(dir, 'cp.json');
  const saved = saveCheckpoint(file);
  assert.equal(saved.ok, true);
  assert.equal(saved.warnings, undefined, 'dump 面（Ι 立法永不抛）零告警');

  // 落盘段的懒结算快照：T0 计数 × 2⁻¹（dump 内结算，O(1) 折算）
  const dumped = selfModel.dump();
  assert.equal(dumped.settledAt, T1);
  const cellA = dumped.cells.find(c => c.key === 'click_mouse')!;
  assert.equal(cellA.s, 5, '10 成 × 0.5');
  assert.equal(cellA.f, 1, '2 败 × 0.5');
  assert.equal(cellA.lastTs, T1);
  const cellB = dumped.cells.find(c => c.key === 'click_mouse|f3a0')!;
  assert.equal(cellB.s, 2.5, '场景格同律衰减');

  // 模拟崩溃：账本归零（配置保留）⇒ 诚实冷启动
  resetSelfModel();
  assert.equal(selfModel.competence({ actionKind: 'click_mouse' }), null);

  // 恢复：账逐字段复活（含 settledAt 与 Map 插入序）
  const { restored, report } = loadCheckpoint(file);
  assert.equal(restored, true);
  assert.ok(report.includes('selfModel: OK'), report.join('; '));
  assert.deepEqual(selfModel.dump(), dumped, '复活账与落盘结算快照逐字段等价');

  // 半衰期懒衰减结算正确：恢复后续推一个半衰期 ⇒ T0 计数 × 2⁻²（恢复不重复折算）
  const T2 = T1 + HALF;
  selfModel.configure({ now: () => T2 });
  const r2 = selfModel.competence({ actionKind: 'click_mouse' })!;
  assert.ok(Math.abs(r2.n - 3) < 1e-9, `s=2.5, f=0.5 ⇒ n=3（实测 ${r2.n}）`);
  assert.ok(Math.abs(r2.mean - 0.7) < 1e-9, `Beta(3.5,1.5) 均值 0.7（实测 ${r2.mean}）`);
  const advice = selfModel.adviseConfidence('click_mouse');
  assert.ok(advice && Math.abs(advice.confidence - 0.7) < 1e-9 && Math.abs(advice.n - 3) < 1e-9,
    '衰减后的经验置信照常进闸门建议面');
  const scene = selfModel.competence({ actionKind: 'click_mouse', sceneBucket: 'f3a0' })!;
  assert.ok(Math.abs(scene.n - 1.25) < 1e-9, '场景格 2.5 × 0.5 = 1.25');
  assert.ok(Math.abs(scene.mean - (1.25 + 1) / (1.25 + 2)) < 1e-9);

  // ── 坏 selfModel 段（结构坏）⇒ SKIPPED + 空模型；其余子系统照常水合 ──
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  raw.selfModel = 42;
  const badFile = join(dir, 'cp-bad.json');
  writeFileSync(badFile, JSON.stringify(raw));
  resetSelfModel();
  const bad = loadCheckpoint(badFile);
  assert.equal(bad.restored, true);
  const selfLine = bad.report.find(l => l.startsWith('selfModel:'));
  assert.ok(selfLine && selfLine.includes('SKIPPED'), bad.report.join('; '));
  assert.ok(bad.report.filter(l => !l.startsWith('selfModel:')).every(l => l.endsWith(': OK')),
    '坏段隔离不连坐 —— 其余子系统全部照常水合');
  assert.equal(selfModel.competence({ actionKind: 'click_mouse' }), null, '坏段 ⇒ 空模型（非残留旧账）');

  // ── 段内坏行 ⇒ 半水合（好行入账、坏行弃置 —— Ι 纪元语义穿过 checkpoint 层）──
  // 注：行锚 lastTs=T2（当前钟）—— 好行读数不被懒结算再折算，期望值可手算硬编码
  raw.selfModel = {
    version: 1, settledAt: T2,
    cells: [
      { key: 'type_text', s: 4, f: 1, lastTs: T2 }, // 好行
      { key: '', s: 9, f: 9, lastTs: T2 },          // 空键 ⇒ 弃
      { key: 'neg', s: -1, f: 1, lastTs: T2 },      // 负计数 ⇒ 弃
      { key: 'zero', s: 0, f: 0, lastTs: T2 },      // 空格子 ⇒ 弃
    ],
  };
  const halfFile = join(dir, 'cp-half.json');
  writeFileSync(halfFile, JSON.stringify(raw));
  resetSelfModel();
  const half = loadCheckpoint(halfFile);
  assert.ok(half.report.includes('selfModel: OK'), '段结构合法 ⇒ 半水合不是 SKIPPED');
  const good = selfModel.competence({ actionKind: 'type_text' })!;
  assert.ok(Math.abs(good.mean - 5 / 7) < 1e-9, '好行 Beta(5,2) 均值 5/7');
  assert.equal(selfModel.stats().cells, 1, '三行坏账被半水合吸收（只余好行）');
});

// ─── Ζ-2：v4 旧档读入（版本协商 + 锚零误报）───

test('Ζ-2: v4 旧档 —— 无 selfModel 段诚实冷启动；null 锚零误报；篡改锚照常告警', async () => {
  const T0 = 1_700_000_100_000;
  selfModel.configure({ now: () => T0, halfLifeH: 1, minEvidence: 2 });
  for (let i = 0; i < 8; i++) selfModel.recordOutcome({ actionKind: 'click_mouse' }, true, T0);
  for (let i = 0; i < 3; i++) {
    await journal.append({ ts: Date.now() + i, tool: 'click_mouse', args: { x: i / 8 }, status: 'SUCCESS', effect_detected: true });
  }
  const file = join(dir, 'cp.json');
  assert.equal(saveCheckpoint(file).ok, true);

  // 铸 v4 旧档：无 selfModel 段 + 双锚 null（v3→v4 迁移档同形；Ζ 为原地扩展，版本不变）
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.version, 4, '原地扩展（D-1/D-2/D-3 同律）—— 版本字段钉 4');
  delete raw.selfModel;
  raw.journalMmrRoot = null;
  raw.sandboxMmrRoot = null;
  const v4File = join(dir, 'cp-v4.json');
  writeFileSync(v4File, JSON.stringify(raw));

  resetSelfModel();
  journal.reset();
  const r = loadCheckpoint(v4File);
  assert.equal(r.restored, true, r.report.join('; '));
  // 无锚告警误报：null 锚 = 旧档诚实缺席，恢复不触发 MISMATCH
  assert.ok(!r.report.some(l => l.includes('EVIDENCE ANCHOR MISMATCH')), r.report.join('; '));
  // 无 selfModel 段 = 诚实冷启动（空账本，非错误行）
  assert.equal(selfModel.competence({ actionKind: 'click_mouse' }), null);
  assert.equal(selfModel.stats().cells, 0);
  // 日志链照常复活续链（崩溃恢复核心承诺零回归）
  await journal.append({ ts: Date.now() + 99, tool: 'type_text', args: { text: 'x' }, status: 'SUCCESS' });
  assert.equal(journal.verify().ok, true);
  assert.equal(journal.list().length, 4);

  // 锚机制未被 Ζ 削弱：真锚被篡改 ⇒ 告警照常置顶
  const raw2 = JSON.parse(readFileSync(file, 'utf8'));
  delete raw2.selfModel;
  raw2.journalMmrRoot = '0'.repeat(64);
  const tampered = join(dir, 'cp-tampered.json');
  writeFileSync(tampered, JSON.stringify(raw2));
  journal.reset();
  const t = loadCheckpoint(tampered);
  assert.equal(t.restored, true);
  assert.ok(t.report.some(l => l.includes('EVIDENCE ANCHOR MISMATCH')), t.report.join('; '));
});

// ─── Ζ-3：睡眠④幕标定接线 ───

/** 假 journal 条目方言（click 坐标剧集 —— Kalman 漂移对的数据源） */
interface ZEntry {
  ts: number;
  tool: string;
  args: Record<string, unknown>;
  status: string;
  hash?: string;
}

function zEntry(over: Partial<ZEntry> = {}): ZEntry {
  return {
    ts: 1_700_000_200_000,
    tool: 'click_mouse',
    args: { x: 0.5, y: 0.5, target_description: '提交按钮' },
    status: 'SUCCESS',
    hash: 'zeta-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ...over,
  };
}

test('Ζ-3: 足样本 ⇒ 晨报含标定建议书（建议值确定性在场）；样本不足 ⇒ 诚实缺席注记', async () => {
  // 12 幕同目标坐标剧集（漂移带噪声 —— 非退化序列）：每轴 11 漂移 ⇒ 10 对，双轴 20 对
  const xs = [0.5, 0.512, 0.531, 0.533, 0.56, 0.574, 0.575, 0.601, 0.615, 0.616, 0.64, 0.652];
  const ys = [0.3, 0.305, 0.298, 0.31, 0.309, 0.318, 0.322, 0.321, 0.33, 0.334, 0.333, 0.341];
  const entries = xs.map((x, i) => zEntry({
    ts: 1_700_000_200_000 + i,
    args: { x, y: ys[i], target_description: '提交按钮' },
    hash: `z3h${i}${'x'.repeat(60)}`,
  }));
  const fj = {
    list: (_actionOnly = true) => entries,
    verify: () => ({ ok: true, length: entries.length, brokenAt: null }),
  };
  const fcal = { tick: () => [{ key: 'popup.offThreshold', from: 0.35, to: 0.37, reason: 'optimal-threshold', generation: 2 }] };
  const ftel = { tailReport: () => ({ xi: 0.3, tailCount: 40, sigma: 120, threshold: 900, p999: 5000, adStat: 0.9, fit: 'ok' as const }) };

  const trace = join(dir, 'sleep.jsonl');
  const report = await runSleepCycle(
    { journal: fj, calibrator: fcal, telemetry: ftel, log: () => {} } as SleepDeps,
    { sleepTracePath: trace, now: () => 42 },
  );

  const cal = report.acts.find(a => a.name === 'calibrate')!;
  assert.equal(cal.status, 'ok');
  assert.equal(cal.counts.calibrations, 1, '校准 tick 照常执法');
  assert.equal(cal.counts.recommendations, 2, '两原子建议在场');
  const advice = cal.calibrationAdvice!;
  assert.equal(advice.length, 2);

  // Kalman Q/R 原子：20 对（12 剧集 × 双轴 − 双轴各 1 先验热身）喂入网格 MLE
  const kal = advice.find(a => a.atom === 'calibrateKalmanQR')!;
  assert.equal(kal.n, 20);
  assert.equal(kal.values.r, 1);
  assert.equal(kal.values.ratio, kal.values.q, '比值即 q（r 归一）');
  assert.ok([0.03, 0.1, 0.3, 1, 3, 10, 30].includes(kal.values.q), 'q ∈ 对数网格');
  assert.ok(Number.isFinite(kal.values.mse) && kal.values.mse >= 0);
  assert.ok(kal.consumer.includes('swarm'), '建议书申报消费方属地');
  assert.ok(kal.source.includes('前史漂移均值'), '先验代用口径如实申报');

  // GPD A² 临界表原子：与同参直接重算确定性相等（播种可复现可审计）
  const gpd = advice.find(a => a.atom === 'gpdAdCriticalTable')!;
  const expected = gpdAdCriticalTable({ xi: 0.3, nSample: 40, nSims: 800, seed: 20261003 });
  assert.deepEqual(gpd.values, { alpha10: expected.alpha10, alpha05: expected.alpha05, alpha01: expected.alpha01 });
  assert.equal(gpd.current, '3.0', '只对照不落值（tailReport 拒绝阈字面量在册）');
  assert.equal(gpd.n, 40);

  // 晨报行携带建议书（白天决定者的读档面）
  const line = JSON.parse(readFileSync(trace, 'utf8').trim().split('\n')[0]);
  const lineCal = line.acts.find((a: { name: string }) => a.name === 'calibrate');
  assert.equal(lineCal.calibrationAdvice.length, 2, 'JSONL 晨报行内建议书随行');
  assert.ok((cal.detail ?? '').includes('睡眠出建议、白天做决定'), cal.detail);

  // ── 样本不足 ⇒ 建议书诚实缺席（注记在案，绝不伪造标定）──
  const thin = [zEntry({ hash: 'z3thin-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' })];
  const r2 = await runSleepCycle(
    {
      journal: { list: () => thin, verify: () => ({ ok: true, length: 1, brokenAt: null }) },
      calibrator: fcal,
      log: () => {},
    } as SleepDeps,
    { now: () => 43 },
  );
  const cal2 = r2.acts.find(a => a.name === 'calibrate')!;
  assert.equal(cal2.status, 'ok', '样本不足是缺席不是故障');
  assert.equal(cal2.counts.recommendations, 0);
  assert.equal(cal2.calibrationAdvice, undefined, '零建议 ⇒ 不携带空册（不伪造）');
  const d = cal2.detail ?? '';
  assert.ok(d.includes('漂移对不足'), d);
  assert.ok(d.includes('telemetry 统计面不在睡眠依赖'), d);
  assert.ok(d.includes('calibrateSchmittEvidence 缺席'), '缺数据原子在册申报');
  assert.ok(d.includes('calibrateNcdThreshold 缺席'), '缺数据原子在册申报');
});

// ─── Ζ-4：旁路律（旁路故障绝不炸主流程）───

test('Ζ-4: selfModel.dump/restore 注入 throw 与标定数据面 throw ⇒ checkpoint/睡眠照常完成，error 只作注记', async () => {
  const T0 = 1_700_000_300_000;
  selfModel.configure({ now: () => T0, halfLifeH: 1, minEvidence: 2 });
  for (let i = 0; i < 4; i++) selfModel.recordOutcome({ actionKind: 'press_hotkey' }, true, T0);

  // 单例方法注入面（测试缝）：实例自有属性遮蔽原型方法，测毕即还原
  const sm = selfModel as unknown as { dump: () => unknown; restore: (s: unknown) => void };
  const origDump = sm.dump.bind(selfModel);
  const origRestore = sm.restore.bind(selfModel);

  // (a) dump 炸 ⇒ checkpoint 原子落盘照常完成 + warnings 注记 + 缺段冷启动
  sm.dump = () => { throw new Error('dump 炸'); };
  const file = join(dir, 'cp.json');
  const saved = saveCheckpoint(file);
  assert.equal(saved.ok, true, '旁路律：dump 故障绝不炸保存主流程');
  assert.ok(saved.warnings?.some(w => w.includes('selfModel') && w.includes('dump 炸')),
    JSON.stringify(saved.warnings ?? []));
  sm.dump = origDump;
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.selfModel, undefined, '坏段不落盘');
  assert.ok('journalMmrRoot' in onDisk, '其余段照铸（证据锚在场）');

  // (b) restore 炸 ⇒ load 的防御水合吸收为 SKIPPED，其余子系统照常水合
  const goodFile = join(dir, 'cp-good.json');
  assert.equal(saveCheckpoint(goodFile).ok, true);
  resetSelfModel();
  sm.restore = () => { throw new Error('restore 炸'); };
  const loaded = loadCheckpoint(goodFile);
  assert.equal(loaded.restored, true, '旁路律：restore 故障绝不炸恢复主流程');
  assert.ok(loaded.report.some(l => l.startsWith('selfModel:') && l.includes('SKIPPED')),
    loaded.report.join('; '));
  assert.ok(loaded.report.filter(l => !l.startsWith('selfModel:')).every(l => l.endsWith(': OK')),
    '单段故障不连坐');
  sm.restore = origRestore;

  // (c) 睡眠：标定数据面 throw（telemetry.tailReport 炸）⇒ ④幕 error 注记、六幕照演
  const one = [zEntry({ hash: 'z4one-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })];
  const r = await runSleepCycle(
    {
      journal: { list: () => one, verify: () => ({ ok: true, length: 1, brokenAt: null }) },
      calibrator: { tick: () => [] },
      telemetry: { tailReport: () => { throw new Error('tailReport 炸'); } },
      log: () => {},
    } as SleepDeps,
    { now: () => 7 },
  );
  const cal = r.acts.find(a => a.name === 'calibrate')!;
  assert.equal(cal.status, 'error', '建议书故障如实注记 error');
  assert.equal(cal.counts.calibrations, 0, 'tick 已完成（counts 保留不回滚）');
  assert.ok((cal.detail ?? '').includes('标定建议书故障'), cal.detail);
  assert.ok((cal.detail ?? '').includes('tailReport 炸'), cal.detail);
  assert.ok(r.acts.filter(a => a.name !== 'calibrate').every(a => a.status !== 'error'),
    '④幕旁挂故障不连坐其余幕');
  assert.equal(typeof r.watermark, 'string', '睡眠照常完成（指纹照铸）');
});

// 清理全部临时目录（测试自洁 —— 世界级标准：测试不留垃圾）
process.on('exit', () => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });
