// test/w1gymnoise.test.ts
// W1-4 病态感知诊所（噪声注入 gym）测试：零漂移兼容（无 spec 时输出与现状
// 逐字节一致）/ 各噪声维度生效（OCR 换字降置信、VLM 漏检、bbox 抖动、瞬态
// 中间帧）/ 同 seed 重放一致 / 噪声越大成功率单调不升（诊所有分辨力）/
// noiseSweep 结构与预算 —— 全离线（sharp 合成帧是既有模式）、零网络零真钟。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AutonomyGym,
  GymWorld,
  noiseSweep,
  resolveGymNoise,
  type GymNoiseSpec,
  type GymTask,
  type GymWorldKind,
} from '../src/autonomy/gym.ts';
import type { PolicyAction } from '../src/autonomy/policyEngine.ts';

// ─── W1-4 测试基建 ───

const CRIT: Record<GymWorldKind, string[]> = {
  wizard: ['下一步完成'],
  'popup-maze': ['下一步完成'],
  'scroll-hunt': ['深页目标可见'],
  'danger-gate': ['提醒已安排'],
};

/** W1-4：直铸带可选噪声谱的单任务 */
function makeTask(kind: GymWorldKind, opts: { difficulty?: number; seed?: number; noise?: GymNoiseSpec } = {}): GymTask {
  const base: GymTask = {
    id: `w1-${kind}`,
    kind,
    goal: `w1 goal for ${kind}`,
    successCriteria: [...CRIT[kind]],
    seed: opts.seed ?? 7,
    difficulty: opts.difficulty ?? 1,
  };
  return opts.noise ? { ...base, noise: opts.noise } : base;
}

/** W1-4：按控件真相中心发一次点击动作（世界级直驱口径） */
function clickCenter(label: string, x0: number, y0: number, x1: number, y1: number): PolicyAction {
  return {
    kind: 'click',
    target: { bbox: { x0, y0, x1, y1 }, center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, label },
    rationale: 'w1-4 测试动作',
    expectedEffect: 'w1-4 测试预期',
    utility: 0.9,
    riskTier: 'benign',
  };
}

// ─── N1：零漂移兼容（硬约束：无 spec ⇒ 与现状逐字节一致） ───

test('N1: 零漂移 —— 无/全零噪声 spec 时世界读出与闭环报告与现状逐字节一致', async () => {
  // 解析层：缺席/垃圾/全零 ⇒ inactive（零漂移的规范形判据）
  assert.equal(resolveGymNoise(undefined).active, false);
  assert.equal(resolveGymNoise(null).active, false);
  assert.equal(resolveGymNoise('junk').active, false);
  assert.equal(resolveGymNoise(123).active, false);
  assert.equal(
    resolveGymNoise({ seed: 99, ocrSwapRate: 0, ocrConfDrop: 0, vlmMissRate: 0, bboxJitterPx: 0, transientFrame: 0 }).active,
    false,
    '全零 spec ⇒ inactive',
  );

  // 世界级：无 spec 与全零 spec 的读出逐字节一致（帧 + OCR + VLM）
  const plain = new GymWorld(makeTask('wizard'));
  const quiet = new GymWorld(makeTask('wizard', { noise: { seed: 9 } }));
  const zeroed = new GymWorld(
    makeTask('wizard', { noise: { seed: 123, ocrSwapRate: 0, ocrConfDrop: 0, vlmMissRate: 0, bboxJitterPx: 0, transientFrame: 0 } }),
  );
  const [bp, bq, bz] = await Promise.all([plain.capture(), quiet.capture(), zeroed.capture()]);
  assert.ok(bp.equals(bq) && bp.equals(bz), '同态帧字节恒等（噪声零漂移的帧指纹）');
  assert.deepEqual(quiet.wordsFor(bq), plain.wordsFor(bp));
  assert.deepEqual(zeroed.wordsFor(bz), plain.wordsFor(bp));
  assert.deepEqual(quiet.vlmFor(bq), plain.vlmFor(bp));
  assert.deepEqual(zeroed.vlmFor(bz), plain.vlmFor(bp));

  // 闭环级：馆级显式全零噪声谱 ⇒ train 报告与无谱现状逐字段一致
  const clean = await new AutonomyGym({ seed: 4242 }).train(4);
  const zeroGym = await new AutonomyGym({
    seed: 4242,
    noise: { seed: 12345, ocrSwapRate: 0, ocrConfDrop: 0, vlmMissRate: 0, bboxJitterPx: 0, transientFrame: 0 },
  }).train(4);
  assert.deepEqual(zeroGym, clean, '全零噪声谱闭环报告逐字段一致（零漂移铁律）');
});

// ─── N2：OCR 噪声维度（词形混淆换字 + 置信跌落） ───

test('N2: OCR 换字与降置信 —— 混淆矩阵按词形换字、置信 0.92→0.46、bbox 不动、ground truth 不动', async () => {
  const w = new GymWorld(makeTask('wizard', { noise: { seed: 5, ocrSwapRate: 1, ocrConfDrop: 1 } }));
  const buf = await w.capture();
  const words = w.wordsFor(buf);
  // rate=1 ⇒ 可混淆字符全换：页→贝、下→不（一/步 无映射不动）
  assert.deepEqual(
    words.map(x => x.label),
    ['第1贝 共3贝', '不一步'],
    '混淆矩阵换字生效（词面腐蚀）',
  );
  assert.ok(words.every(x => x.confidence === 0.46), '置信跌落 0.92→0.46（低于匹配置信门槛 0.55）');
  // bbox 维度未开 ⇒ 坐标分毫不动
  assert.deepEqual(
    words.map(x => x.bbox),
    [
      { x0: 60, y0: 60, x1: 320, y1: 110 },
      { x0: 90, y0: 420, x1: 260, y1: 500 },
    ],
    'bboxJitterPx=0 ⇒ 框坐标不动',
  );
  // 世界 ground truth 不为噪声所动（控件真相与 OCR 真相口径原样）
  assert.deepEqual(
    w.controls().map(c => c.label),
    ['第1页 共3页', '下一步'],
  );
  assert.ok(w.ocrText().includes('第1页') && w.ocrText().includes('下一步'), 'ground truth OCR 口径原样');
});

// ─── N3：VLM 噪声维度（漏检） ───

test('N3: VLM 漏检 —— miss=1 全漏、miss=0 不漏、中间档按种子确定性部分漏', async () => {
  // miss=1：全部元素漏检（双源失衡 ⇒ 仲裁只能走单源）
  const full = new GymWorld(makeTask('danger-gate', { noise: { seed: 1, vlmMissRate: 1 } }));
  const bufFull = await full.capture();
  assert.equal(full.vlmFor(bufFull).length, 0, '漏检率 1 ⇒ VLM 读出为空');
  assert.equal(full.wordsFor(bufFull).length, 3, 'OCR 通道不受 VLM 漏检牵连');

  // 中间档：danger-gate 门态 3 控件、seed 钉死 ⇒ 确定性漏 2 存 1
  const mid = new GymWorld(makeTask('danger-gate', { seed: 2, noise: { seed: 2, vlmMissRate: 0.5 } }));
  const bufMid = await mid.capture();
  const vlmMid = mid.vlmFor(bufMid);
  assert.equal(vlmMid.length, 1, 'seed=2 ⇒ 恰漏 2 存 1（种子钉死的确定性部分漏检）');
  assert.ok(vlmMid[0].id === 'e1' || vlmMid[0].id === 'e2' || vlmMid[0].id === 'e3');

  // 同 spec 重放逐字节一致（VLM 种子流钉死）
  const mid2 = new GymWorld(makeTask('danger-gate', { noise: { seed: 2, vlmMissRate: 0.5 } }));
  const bufMid2 = await mid2.capture();
  assert.deepEqual(mid2.vlmFor(bufMid2), vlmMid, '同 seed 重放 ⇒ VLM 漏检序列一致');
});

// ─── N4：bbox 抖动维度 ───

test('N4: bbox 抖动 —— 四边各 ±n 像素、夹画布、保序、双源同律、同 seed 重放一致', async () => {
  const mkJitterWorld = (): GymWorld => new GymWorld(makeTask('danger-gate', { seed: 6, noise: { seed: 6, bboxJitterPx: 30 } }));
  const w = mkJitterWorld();
  const buf = await w.capture();
  const truth = w.controls();
  const words = w.wordsFor(buf);
  const vlm = w.vlmFor(buf);
  assert.equal(words.length, truth.length);

  let moved = 0;
  const checkBbox = (b: { x0: number; y0: number; x1: number; y1: number }, t: (typeof truth)[number]): void => {
    for (const key of ['x0', 'y0', 'x1', 'y1'] as const) {
      assert.ok(
        Math.abs(b[key] - t[key]) <= 30,
        `边 ${key} 偏差 |${b[key]}−${t[key]}| ≤ 30（真相 ${t.label}）`,
      );
    }
    assert.ok(b.x0 <= b.x1 && b.y0 <= b.y1, '抖动后保序（x0≤x1 / y0≤y1）');
    assert.ok(b.x0 >= 0 && b.x1 < 800 && b.y0 >= 0 && b.y1 < 600, '抖动夹在画布内');
    if (b.x0 !== t.x0 || b.y0 !== t.y0 || b.x1 !== t.x1 || b.y1 !== t.y1) moved += 1;
  };
  words.forEach((x, i) => checkBbox(x.bbox, truth[i]));
  vlm.forEach((x, i) => checkBbox(x.bbox, truth[i]));
  assert.ok(moved >= 1, `至少一个框发生抖动（实测 ${moved} 处移动）`);
  // 词面与置信不受抖动牵连（维度正交）
  assert.deepEqual(
    words.map(x => x.label),
    truth.map(c => c.label),
  );
  assert.ok(words.every(x => x.confidence === 0.92));

  // 同 seed 重放 ⇒ 双源抖动序列逐字节一致
  const w2 = mkJitterWorld();
  const buf2 = await w2.capture();
  assert.deepEqual(w2.wordsFor(buf2), words, 'OCR 抖动重放一致');
  assert.deepEqual(w2.vlmFor(buf2), vlm, 'VLM 抖动重放一致');
});

// ─── N5：瞬态中间帧维度（考自适应等待） ───

test('N5: 瞬态中间帧 —— 动作翻态后下一帧回放旧态一拍、再下一帧入新态；无翻态不武装', async () => {
  const w = new GymWorld(makeTask('wizard', { noise: { seed: 11, transientFrame: 1 } }));
  const before = await w.capture();
  // 点击「下一步」（第 0 页按钮 90..260 × 420..500）⇒ 世界翻页 + 武装瞬态
  w.applyAction(clickCenter('下一步', 90, 420, 260, 500));
  assert.equal(w.page, 1, '世界真相已翻页');
  assert.equal(w.transientArmed, true, '翻态后瞬态武装');

  const lag = await w.capture();
  assert.equal(
    JSON.stringify(w.wordsFor(lag).map(x => x.label)),
    JSON.stringify(['第1页 共3页', '下一步']),
    '瞬态帧回放旧态（第 1 页）——屏幕慢于世界一拍',
  );
  const lagBtn = w.wordsFor(lag)[1].bbox;
  assert.equal(lagBtn.x0, 90, '瞬态帧的按钮还是旧页位置（bx=90）');

  const settle = await w.capture();
  assert.equal(
    JSON.stringify(w.wordsFor(settle).map(x => x.label)),
    JSON.stringify(['第2页 共3页', '下一步']),
    '第二帧入新态（第 2 页）——瞬态恰一拍',
  );
  assert.equal(w.wordsFor(settle)[1].bbox.x0, 220, '新态按钮在新位置（bx=220）');
  assert.ok(!lag.equals(settle) && !lag.equals(before), '瞬态帧字节异于新旧态（dhash 可分）');
  assert.equal(w.captures, 3);

  // 无翻态动作（落空点击）不武装瞬态
  w.applyAction(clickCenter('落空', 400, 100, 402, 102));
  assert.equal(w.transientArmed, false, 'stateKey 未动 ⇒ 不武装');
  const steady = await w.capture();
  assert.equal(w.wordsFor(steady)[0].label, '第2页 共3页', '落空动作后照常直读现态');

  // 瞬态不改世界真相账本
  assert.deepEqual(w.clickLedger, ['下一步', null]);
  assert.equal(w.mutations, 1);
});

// ─── N6：同 seed 重放一致（种子钉死逐字节确定性） ───

test('N6: 同 seed 重放 —— 噪声世界读出序列与闭环报告重放逐字节/逐字段一致', async () => {
  // 世界级：帧字节 + 双源读出 + 瞬态序列全一致
  const runWorld = async (): Promise<string> => {
    const w = new GymWorld(
      makeTask('popup-maze', {
        seed: 31,
        noise: { seed: 4242, ocrSwapRate: 0.6, ocrConfDrop: 0.4, vlmMissRate: 0.5, bboxJitterPx: 22, transientFrame: 1 },
      }),
    );
    const frames: string[] = [];
    let buf = await w.capture();
    frames.push(buf.toString('base64'));
    frames.push(JSON.stringify(w.wordsFor(buf)), JSON.stringify(w.vlmFor(buf)));
    // 一路点完向导（含弹窗），沿途回收每帧读出
    for (let page = 0; page < 3; page++) {
      const btns = w.wordsFor(buf).filter(x => x.label === '下一步' || x.label === '确认' || x.label === '完成');
      const target = btns[0];
      if (!target) break;
      w.applyAction(clickCenter(target.label, target.bbox.x0, target.bbox.y0, target.bbox.x1, target.bbox.y1));
      buf = await w.capture();
      frames.push(JSON.stringify(w.wordsFor(buf)), JSON.stringify(w.vlmFor(buf)));
    }
    return frames.join('|');
  };
  assert.equal(await runWorld(), await runWorld(), '噪声世界读出序列重放逐字节一致');

  // 闭环级：全谱噪声 gym 两次 train(4) 报告逐字段一致
  const spec: GymNoiseSpec = {
    seed: 4242,
    ocrSwapRate: 0.5,
    ocrConfDrop: 0.4,
    vlmMissRate: 0.5,
    bboxJitterPx: 20,
    transientFrame: 1,
  };
  const a = await new AutonomyGym({ seed: 99, noise: spec }).train(4);
  const b = await new AutonomyGym({ seed: 99, noise: spec }).train(4);
  assert.deepEqual(a, b, '同 seed 同 spec ⇒ 噪声闭环报告逐字段一致');
  assert.equal(a.rounds.length, 4);
});

// ─── N7：诊所有分辨力 —— 完美感知下校准、噪声下退化可测 ───

test('N7: 受控分辨 —— popup-maze 完美感知达成、同任务加噪（瞬态）失败；世界 ground truth 不因噪声漂移', async () => {
  const cleanTask = makeTask('popup-maze', { seed: 7 });
  const clean = (await new AutonomyGym({ seed: 4242 }).runTasks([cleanTask]))[0];
  assert.equal(clean.success, true, '完美感知 ⇒ 弹窗优先律闭环达成');
  assert.equal(clean.steps, 5);

  const noisy = (
    await new AutonomyGym({ seed: 4242 }).runTasks([
      { ...cleanTask, noise: { seed: 3, transientFrame: 1 } },
    ])
  )[0];
  assert.equal(noisy.success, false, '仅瞬态一维噪声 ⇒ 固定策略可观测退化（诊所分辨力）');
  assert.notEqual(noisy.steps, clean.steps, '退化同时改变步数账（自适应等待病理可见）');

  // 噪声不漂移世界真相：同动作序列下噪声世界与净世界的状态机轨迹一致
  const mkDrive = (): GymWorld => new GymWorld(makeTask('danger-gate', { seed: 7 }));
  const drive = (w: GymWorld): string => {
    w.applyAction(clickCenter('稍后提醒', 100, 380, 300, 460));
    w.applyAction(clickCenter('稍后提醒', 100, 380, 300, 460));
    return JSON.stringify([w.done, w.mutations, w.clickLedger, w.ocrText()]);
  };
  const plainW = mkDrive();
  const noisyW = new GymWorld(makeTask('danger-gate', { seed: 7, noise: { seed: 8, ocrSwapRate: 0.9, vlmMissRate: 0.9, bboxJitterPx: 50, transientFrame: 1 } }));
  assert.equal(drive(noisyW), drive(plainW), '世界 ground truth（状态机/账本/判据口径）不因噪声漂移');
});

test('N7b: noiseSweep 鲁棒性曲线 —— 噪声越大成功率单调不升，且存在档位成功率可观测下降', async () => {
  const sweep = await noiseSweep({
    kind: 'wizard',
    roundsPerLevel: 4,
    seed: 4242,
    levels: [
      { label: 'clean' },
      { label: 'mild', noise: { ocrSwapRate: 0.08, ocrConfDrop: 0.1, vlmMissRate: 0.1, bboxJitterPx: 4 } },
      { label: 'moderate', noise: { ocrSwapRate: 0.3, ocrConfDrop: 0.3, vlmMissRate: 0.35, bboxJitterPx: 14, transientFrame: 1 } },
      { label: 'severe', noise: { ocrSwapRate: 0.85, ocrConfDrop: 0.5, vlmMissRate: 0.75, bboxJitterPx: 60, transientFrame: 1 } },
    ],
  });
  assert.equal(sweep.points.length, 4);
  assert.equal(sweep.points[0].label, 'clean');
  assert.equal(sweep.points[0].successRate, 1, '基线档（完美感知）成功率 100%');
  assert.equal(sweep.points[0].noise, null, '基线档噪声回声为 null');
  for (let i = 1; i < sweep.points.length; i++) {
    assert.ok(
      sweep.points[i].successRate <= sweep.points[i - 1].successRate,
      `成功率单调不升：${sweep.points[i - 1].label}(${sweep.points[i - 1].successRate}) → ${sweep.points[i].label}(${sweep.points[i].successRate})`,
    );
  }
  assert.ok(
    sweep.points[sweep.points.length - 1].successRate < sweep.points[0].successRate,
    '至少一档噪声使固定策略成功率可观测下降（诊所能分辨）',
  );
  assert.ok(sweep.points.every(p => p.avgSteps >= 0 && p.rounds > 0 && p.successes <= p.rounds));
  assert.ok(sweep.points.some(p => p.avgSteps > sweep.points[0].avgSteps), '噪声档平均步数上升（退化另一面）');
  assert.ok(typeof sweep.summary === 'string' && sweep.summary.includes('诊所'));
  assert.equal(sweep.roundsRun, 16);
  assert.deepEqual(sweep.budget, { cap: 48, truncated: false });
});

// ─── N8：noiseSweep 结构 / 预算 / 确定性 ───

test('N8: noiseSweep 预算截断与重放确定 —— 预算封顶、档序截断、同 opts 逐字段一致', async () => {
  // 预算：4 档 × 5 轮 = 20 > cap 8 ⇒ 前两档跑 5+3、后两档截断
  const levels = [0, 1, 2, 3].map(i => ({ label: `L${i}`, noise: { seed: i, ocrSwapRate: 0.2, bboxJitterPx: 8 } }));
  const cut = await noiseSweep({ kind: 'wizard', levels, roundsPerLevel: 5, maxTotalRounds: 8, seed: 4242 });
  assert.equal(cut.roundsRun, 8, '实跑轮数恰为预算上限');
  assert.deepEqual(cut.budget, { cap: 8, truncated: true });
  assert.deepEqual(
    cut.points.map(p => p.rounds),
    [5, 3],
    '预算耗尽处截断：后两档不入曲线',
  );

  // 重放确定：同 opts 两次扫频逐字段一致（任务种子与各轮噪声种子全钉死）
  const again = await noiseSweep({ kind: 'wizard', levels, roundsPerLevel: 5, maxTotalRounds: 8, seed: 4242 });
  assert.deepEqual(again, cut);

  // 结构：噪声回声为规范形（夹取后的六维 + active）
  const one = await noiseSweep({ kind: 'danger-gate', levels: [{ label: 'a', noise: { ocrSwapRate: 3, bboxJitterPx: 1e9, vlmMissRate: -1, transientFrame: 1 } }], seed: 7 });
  assert.equal(one.points.length, 1);
  assert.deepEqual(
    one.points[0].noise,
    { seed: 0, ocrSwapRate: 1, ocrConfDrop: 0, vlmMissRate: 0, bboxJitterPx: 80, transientFrame: 1, active: true },
    '档位噪声回声为防御式规范形',
  );
});

// ─── N9：防弹承诺（垃圾输入绝不抛） ───

test('N9: 防弹 —— 垃圾噪声谱/垃圾扫频选项全部收敛不抛', async () => {
  // 垃圾噪声谱：非有限率夹 0、巨幅抖动夹 80、瞬态只认 0/1、NaN 种子按 0
  assert.deepEqual(
    resolveGymNoise({ seed: Number.NaN, ocrSwapRate: Number.NaN, ocrConfDrop: -5, vlmMissRate: 2, bboxJitterPx: 1e9, transientFrame: 2 }),
    { seed: 0, ocrSwapRate: 0, ocrConfDrop: 0, vlmMissRate: 1, bboxJitterPx: 80, transientFrame: 0, active: true },
  );
  const junkWorld = new GymWorld(
    makeTask('wizard', { noise: { seed: Number.NaN, ocrSwapRate: Number.NaN, ocrConfDrop: 'x' as never, vlmMissRate: -3, bboxJitterPx: 1e9, transientFrame: 99 as never } }),
  );
  const jb = await junkWorld.capture();
  assert.ok(Array.isArray(junkWorld.wordsFor(jb)) && junkWorld.wordsFor(jb).length === 2);
  assert.ok(Array.isArray(junkWorld.vlmFor(jb)));
  junkWorld.applyAction(clickCenter('下一步', 90, 420, 260, 500));
  assert.equal(junkWorld.transientArmed, false, '瞬态只认 0/1 —— 99 按关闭记');
  assert.equal(junkWorld.page, 1);

  // 垃圾扫频选项：null opts / 非数组 levels / 垃圾档位 ⇒ 空曲线或兜底档，绝不抛
  const empty = await noiseSweep(null as never);
  assert.deepEqual(empty.points, []);
  assert.equal(empty.roundsRun, 0);
  const junkLevels = await noiseSweep({ levels: 'junk' as never, seed: Number.NaN });
  assert.deepEqual(junkLevels.points, []);
  const junkEntries = await noiseSweep({
    levels: [null, 42, { label: '  ', noise: 'x' as never }] as never,
    roundsPerLevel: 1,
    maxSteps: 2,
  });
  assert.equal(junkEntries.points.length, 3, '垃圾档位按 L<i> 兜底成基线档');

  // runTasks 垃圾输入 ⇒ 空数组（评估批防弹）
  const gym = new AutonomyGym({ seed: 1 });
  assert.deepEqual(await gym.runTasks(null as never), []);
  assert.deepEqual(await gym.runTasks('junk' as never), []);
});
