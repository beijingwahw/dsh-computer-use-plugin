// test/w1exec.test.ts
// W1-1（执行层四连改）单测：A2 ROI 区域化验证 / A3 动作前预检+焦点短路 /
// A4 bbox 不确定性感知点击 / A5 稳态门控节奏。全离线确定性 —— 假探针
// （ExecWorldProbe 注入：脚本化帧样本 + 假区域指纹串）、假 system 键鼠
// （monkey-patch 可变对象字面量，测试恢复原样）、假焦点源、注入时钟零真睡。
// 每项能力覆盖正 / 反 / 降级三路径；另含纯函数判决矩阵与探针桥（Result →
// null 降级方言）的协议转写测试。参考 autonomy.integration.test.ts 注入风格。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { system } from '../src/system.ts';
import {
  createExecute,
  pickClickPoint,
  gridRetryOffsets,
  combineRoiVerdict,
  w1HashDistance,
  W1_EXEC_TUNING,
  type RuntimeDeps,
  type RuntimeWord,
  type W1ExecTuning,
} from '../src/autonomy/runtime.ts';
import { composeSnapshot, findInSnapshot, type WorldSnapshot } from '../src/autonomy/worldSnapshot.ts';
import type { GoalSpec, PolicyAction } from '../src/autonomy/index.ts';
import {
  createExecWorldProbe,
  type ExecWorldProbe,
  type FrameSample,
} from '../src/physicalExecution/execProbe.ts';
import type { PhysicalExecutionAdapter } from '../src/physicalExecution/contracts.ts';
import {
  focusTracker,
  predictedFresh,
  createExecFocusSource,
  NO_FOCUS,
  type ExecFocusSource,
} from '../src/focusTracker.ts';
import { estimateRowShift, stillTranslating } from '../src/motionEstimator.ts';

// ─── 假件工坊 ───

/** system 键鼠 monkey-patch（system 是可变对象字面量 —— 恢复器还原原样） */
type SystemPatch = Partial<Record<'clickMouse' | 'typeText' | 'scroll' | 'pressHotkey' | 'getScreenSize', unknown>>;
function patchSystem(over: SystemPatch): () => void {
  const saved: Record<string, unknown> = {};
  const host = system as unknown as Record<string, unknown>;
  for (const key of Object.keys(over)) {
    saved[key] = host[key];
    host[key] = (over as Record<string, unknown>)[key];
  }
  return () => { for (const key of Object.keys(over)) host[key] = saved[key]; };
}

/** 剧本键鼠世界：记录一切派发；屏幕 1920×1080 */
function patchWorld(): {
  clicks: Array<{ x: number; y: number }>;
  typed: string[];
  scrolled: Array<{ dir: unknown; amount: unknown }>;
  hotkeys: string[][];
  restore: () => void;
} {
  const clicks: Array<{ x: number; y: number }> = [];
  const typed: string[] = [];
  const scrolled: Array<{ dir: unknown; amount: unknown }> = [];
  const hotkeys: string[][] = [];
  const restore = patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async (x: number, y: number) => { clicks.push({ x, y }); },
    typeText: async (t: string) => { typed.push(t); },
    scroll: async (dir: unknown, amount: unknown) => { scrolled.push({ dir, amount }); },
    pressHotkey: async (keys: string[]) => { hotkeys.push(keys); },
  });
  return { clicks, typed, scrolled, hotkeys, restore };
}

/** 指纹串工厂：B(n) = 前 n 位 1 后 0 —— B(a) 与 B(b) 汉明距离恰为 |a-b| */
const B = (n: number): string => '1'.repeat(n) + '0'.repeat(64 - n);
const H0 = B(0);

/** 帧样本工厂（探针方言：1920×1080 采样帧） */
const S = (dh: string | null, rdh: string | null, id: number): FrameSample => ({
  dhash: dh, regionDhash: rdh, frameId: id, width: 1920, height: 1080,
});

/** 假探针：脚本化样本队列（耗尽 ⇒ null）+ 固定判决面 + 调用计数 */
interface ProbeScript {
  samples?: FrameSample[];
  hit?: { available: boolean; classification: 'control' | 'text' | 'unknown' | 'unavailable'; controlType: string | null } | null;
  cursor?: string | null;
  regions?: Array<{ x: number; y: number; width: number; height: number }> | null;
  rows?: Record<number, number[]>;
  throwHit?: boolean;
  throwSample?: boolean;
}
function makeProbe(script: ProbeScript): { probe: ExecWorldProbe; calls: Record<string, number> } {
  const calls = { samples: 0, diffs: 0, rows: 0, hits: 0, cursors: 0 };
  const queue = [...(script.samples ?? [])];
  const probe: ExecWorldProbe = {
    sampleFrame: async () => {
      calls.samples++;
      if (script.throwSample) throw new Error('样本采样故障');
      return queue.length > 0 ? (queue.shift() as FrameSample) : null;
    },
    frameDiff: async () => { calls.diffs++; return script.regions ?? null; },
    frameRowMeans: async (id: number) => { calls.rows++; return script.rows?.[id] ?? null; },
    hitTestPoint: async () => {
      calls.hits++;
      if (script.throwHit) throw new Error('UIA 探针故障');
      return script.hit ?? null;
    },
    cursorKind: async () => { calls.cursors++; return script.cursor ?? null; },
  };
  return { probe, calls };
}

/** 假焦点源（A3 注入） */
function fakeFocus(point: { x: number; y: number; extrapolated?: boolean }): {
  focus: ExecFocusSource; sets: Array<[number, number]>;
} {
  const sets: Array<[number, number]> = [];
  return {
    focus: {
      predicted: () => ({ x: point.x, y: point.y, extrapolated: point.extrapolated === true }),
      set: (nx: number, ny: number) => { sets.push([nx, ny]); },
    },
    sets,
  };
}

interface ExecOpts {
  probe?: ExecWorldProbe;
  focus?: ExecFocusSource;
  w1?: Partial<W1ExecTuning>;
  snapshot?: WorldSnapshot | null;
  readWords?: (buf: Buffer) => Promise<RuntimeWord[]>;
  dhashOf?: (buf: Buffer) => Promise<string | null>;
  /** ΑΩ-R12：drag 端口假件（缺席 ⇒ execute 走防御式降级路径） */
  drag?: RuntimeDeps['drag'];
  /** ΑΩ-R12：省略 deps.readWords（inspect 聚焦检视的诚实降级路径） */
  noReadWords?: boolean;
}

/** 铸造被测 execute + 观测账本（captures / sleeps 延迟读取）—— 全注入零真 IO */
function makeExecute(o: ExecOpts = {}): {
  execute: (action: PolicyAction) => Promise<import('../src/autonomy/runtime.ts').ExecOutcome>;
  getCaptures: () => number;
  sleeps: number[];
  /** ΝΩ-13：感知快照槽观测面（inspect 增量回流断言用 —— 与 deps 同一引用） */
  ref: () => { current: WorldSnapshot | null };
} {
  const captures: number[] = [];
  const sleeps: number[] = [];
  let clock = 1_000;
  const lastRef: { current: WorldSnapshot | null } = { current: o.snapshot === undefined ? null : o.snapshot };
  const deps: RuntimeDeps & { spec: GoalSpec; width: number; height: number } = {
    capture: async () => { captures.push(1); return Buffer.from([captures.length]); },
    imageSize: async () => ({ width: 512, height: 384 }),
    dhashOf: o.dhashOf ?? (async () => 'aaaaaaaaaaaaaaaa'),
    ...(o.noReadWords ? {} : { readWords: o.readWords ?? (async (): Promise<RuntimeWord[]> => []) }),
    ...(o.drag ? { drag: o.drag } : {}),
    now: () => (clock += 50),
    sleep: async (ms: number) => { sleeps.push(ms); },
    lastSnapshotRef: lastRef,
    ...(o.probe ? { probe: o.probe } : {}),
    ...(o.focus ? { focus: o.focus } : {}),
    ...(o.w1 ? { w1: o.w1 } : {}),
    spec: { goal: 'W1 执行层验证', successCriteria: ['完成'] },
    width: 512,
    height: 384,
  };
  return { execute: createExecute(deps), getCaptures: () => captures.length, sleeps, ref: () => lastRef };
}

/** 标准点击目标：bbox {200,160,312,224}（112×64）中心 (256,192) → 屏幕像素 (960,540) */
function clickAction(over: { bbox?: { x0: number; y0: number; x1: number; y1: number }; center?: { x: number; y: number } } = {}): PolicyAction {
  return {
    kind: 'click',
    target: {
      bbox: over.bbox ?? { x0: 200, y0: 160, x1: 312, y1: 224 },
      center: over.center ?? { x: 256, y: 192 },
      label: '目标',
    },
    rationale: 'W1 测试', expectedEffect: 'W1 测试', utility: 0.5, riskTier: 'benign',
  };
}

/** 含词级元素的感知快照（A2③ / A4 词质心的 before 侧证据；now 可注入 —— ΝΩ-13 回流断言用） */
function snapshotWithWords(
  words: Array<{ label: string; bbox: { x0: number; y0: number; x1: number; y1: number }; confidence?: number }>,
  now?: number,
): WorldSnapshot {
  return composeSnapshot({
    width: 512,
    height: 384,
    dhash: 'aaaaaaaaaaaaaaaa',
    localElements: words.map(w => ({ label: w.label, bbox: w.bbox, confidence: w.confidence ?? 0.9 })),
    ocrText: words.map(w => w.label).join(' '),
    ...(now !== undefined ? { now } : {}),
  });
}

// ─── A2：ROI 区域化验证 ───

test('A2 正：动作点 ROI 区域指纹变 ⇒ progress（免全帧截屏）', async () => {
  const world = patchWorld();
  try {
    // 样本序：before(H0) → 稳态门 g1(B10)/g2(B12)（门内距离 2 ≤ 2 判稳，g2 为 after 帧）
    const { probe } = makeProbe({ samples: [S(H0, H0, 1), S(B(10), B(10), 2), S(B(12), B(12), 3)] });
    const { execute, getCaptures } = makeExecute({ probe });
    const out = await execute(clickAction());
    assert.equal(out.outcome, 'progress');
    assert.ok(out.verification, 'verification 明细在场');
    assert.equal(out.verification?.roiChanged, true, 'ROI 区域指纹判变');
    assert.equal(out.verification?.fullscreenChanged, true);
    assert.equal(out.verification?.noise, false);
    assert.equal(out.verification?.steady, true, '稳态门判稳');
    assert.equal(world.clicks.length, 1);
    assert.equal(world.clicks[0].x, 960);
    assert.equal(world.clicks[0].y, 540);
    assert.equal(getCaptures(), 0, '探针路径未到抽查期 ⇒ 零全帧截屏');
  } finally {
    world.restore();
  }
});

test('A2 反：全屏变而 ROI 不动 ⇒ 判噪声（no_effect，防时钟/闪烁假阳性）', async () => {
  const world = patchWorld();
  try {
    // 全屏 B12 变化，区域指纹恒 H0；frameDiff 无变化区
    const { probe } = makeProbe({
      samples: [S(H0, H0, 1), S(B(10), H0, 2), S(B(12), H0, 3)],
      regions: [],
    });
    const { execute } = makeExecute({ probe });
    const out = await execute(clickAction());
    assert.equal(out.outcome, 'no_effect', '噪声不算进展');
    assert.equal(out.verification?.noise, true);
    assert.equal(out.verification?.roiChanged, false);
    assert.equal(out.verification?.expectedHit, false);
    assert.equal(out.verification?.fullscreenChanged, true);
    assert.ok(out.note?.includes('判噪声'), 'note 如实记噪声判决');
  } finally {
    world.restore();
  }
});

test('A2 反：世界真静止（全屏与 ROI 皆未动）⇒ 平凡 no_effect 非噪声', async () => {
  const world = patchWorld();
  try {
    const { probe } = makeProbe({ samples: [S(H0, H0, 1), S(H0, H0, 2), S(H0, H0, 3)] });
    const { execute } = makeExecute({ probe });
    const out = await execute(clickAction());
    assert.equal(out.outcome, 'no_effect');
    assert.equal(out.verification?.noise, false);
    assert.equal(out.verification?.roiChanged, false);
  } finally {
    world.restore();
  }
});

test('A2 正：frameDiff 变化区与预期区域交叠 ⇒ progress（区域指纹缺席时第二证补位）', async () => {
  const world = patchWorld();
  try {
    // 区域指纹全程 null ⇒ roiChanged null；变化区（归一化 0.45–0.55 方框）与
    // 目标框（0.391–0.609 × 0.417–0.583）交叠 ⇒ expectedHit true
    const { probe, calls } = makeProbe({
      samples: [S(H0, null, 1), S(H0, null, 2), S(H0, null, 3)],
      regions: [{ x: 864, y: 486, width: 192, height: 108 }],
    });
    const { execute } = makeExecute({ probe });
    const out = await execute(clickAction());
    assert.equal(out.outcome, 'progress');
    assert.equal(out.verification?.roiChanged, null, '区域指纹缺席');
    assert.equal(out.verification?.expectedHit, true, '交叠命中');
    assert.equal(calls.diffs, 1, 'frameDiff 恰调用一次');
  } finally {
    world.restore();
  }
});

test('A2 正：ROI 内 OCR 词级标签集变 ⇒ progress（第三证补位）', async () => {
  const world = patchWorld();
  try {
    const { probe } = makeProbe({ samples: [S(H0, null, 1), S(H0, null, 2), S(H0, null, 3)], regions: [] });
    const { execute, getCaptures } = makeExecute({
      probe,
      snapshot: snapshotWithWords([{ label: '旧词', bbox: { x0: 236, y0: 188, x1: 276, y1: 196 } }]),
      readWords: async () => [
        { label: '新词', bbox: { x0: 240, y0: 180, x1: 270, y1: 210 }, confidence: 0.9 },
      ],
    });
    const out = await execute(clickAction());
    assert.equal(out.outcome, 'progress');
    assert.equal(out.verification?.roiOcrChanged, true, 'ROI 词集判变');
    assert.equal(out.verification?.roiChanged, null);
    assert.ok(getCaptures() >= 1, 'OCR 补位需要一次全帧截屏');
  } finally {
    world.restore();
  }
});

test('A2 反：ROI 内 OCR 词未变 ⇒ no_effect（OCR 证据在场 ⇒ 不降级）', async () => {
  const world = patchWorld();
  try {
    const { probe } = makeProbe({ samples: [S(H0, null, 1), S(H0, null, 2), S(H0, null, 3)], regions: [] });
    const { execute } = makeExecute({
      probe,
      snapshot: snapshotWithWords([{ label: '旧词', bbox: { x0: 236, y0: 188, x1: 276, y1: 196 } }]),
      readWords: async () => [
        { label: '旧词', bbox: { x0: 240, y0: 180, x1: 270, y1: 210 }, confidence: 0.9 },
      ],
    });
    const out = await execute(clickAction());
    assert.equal(out.outcome, 'no_effect');
    assert.equal(out.verification?.roiOcrChanged, false);
    assert.ok(!out.verification?.degraded.includes('roi'), 'OCR 证据在场 ⇒ 不记 roi 降级');
  } finally {
    world.restore();
  }
});

test('A2 降级：探针缺席 ⇒ 诚实回退全屏 dhash（degraded 记 roi，行为与接线前一致）', async () => {
  const world = patchWorld();
  try {
    const { execute, getCaptures } = makeExecute({}); // 无探针
    const out = await execute(clickAction());
    assert.equal(out.outcome, 'progress', '旧管线：before 帧缺席 ⇒ 首见世界判变');
    assert.ok(out.verification?.degraded.includes('roi'));
    assert.equal(getCaptures(), 1, '降级路径恰一次截屏');
    assert.ok(out.note?.includes('点击像素 (960, 540)'), '点击 note 旧格式保持');
  } finally {
    world.restore();
  }
});

test('A2 降级：探针采样失败 ⇒ 回退截屏管线并记 steady-sample', async () => {
  const world = patchWorld();
  try {
    const { probe } = makeProbe({ samples: [] }); // 样本耗尽 ⇒ null
    const { execute, getCaptures } = makeExecute({ probe });
    const out = await execute(clickAction());
    assert.equal(out.outcome, 'progress');
    assert.ok(out.verification?.degraded.includes('steady-sample'));
    assert.ok(out.verification?.degraded.includes('roi'));
    assert.equal(getCaptures(), 1);
    assert.ok(out.note?.includes('W1降级'));
  } finally {
    world.restore();
  }
});

test('A2：type 动作 ROI = 外推焦点（焦点源注入），ROI 变 ⇒ progress', async () => {
  const world = patchWorld();
  try {
    const { probe } = makeProbe({ samples: [S(H0, H0, 1), S(B(10), B(10), 2), S(B(12), B(12), 3)] });
    const { focus } = fakeFocus({ x: 0.5, y: 0.5 });
    const { execute } = makeExecute({ probe, focus });
    const out = await execute({
      kind: 'type', payload: { text: 'hello' },
      rationale: 't', expectedEffect: 't', utility: 0.5, riskTier: 'benign',
    });
    assert.equal(out.outcome, 'progress');
    assert.equal(out.verification?.roiChanged, true);
    assert.deepEqual(world.typed, ['hello']);
  } finally {
    world.restore();
  }
});

// ─── A3：动作前预检 + 焦点短路 ───

test('A3 正：hitTest 判纯文本且光标无反证 ⇒ 免截屏短路 no_effect', async () => {
  const world = patchWorld();
  try {
    const { probe, calls } = makeProbe({
      samples: [S(H0, H0, 1)],
      hit: { available: true, classification: 'text', controlType: 'TextControl' },
      cursor: 'ibeam',
    });
    const { execute, getCaptures } = makeExecute({ probe });
    const out = await execute(clickAction());
    assert.equal(out.outcome, 'no_effect');
    assert.ok(out.note?.includes('预检否决'), 'note 记预检否决');
    assert.equal(world.clicks.length, 0, '未派发点击');
    assert.equal(getCaptures(), 0, '免一轮截屏');
    assert.equal(calls.samples, 0, '连帧采样都省了');
    assert.equal(calls.cursors, 1, '光标交叉印证恰一次');
  } finally {
    world.restore();
  }
});

test('A3 反证：hitTest 判文本但光标 hand ⇒ 物理证据优先放行点击', async () => {
  const world = patchWorld();
  try {
    const { probe } = makeProbe({
      samples: [S(H0, H0, 1), S(B(10), B(10), 2), S(B(12), B(12), 3)],
      hit: { available: true, classification: 'text', controlType: 'TextControl' },
      cursor: 'hand',
    });
    const { execute } = makeExecute({ probe });
    const out = await execute(clickAction());
    assert.equal(world.clicks.length, 1, '冲突时按物理证据放行');
    assert.equal(out.outcome, 'progress');
  } finally {
    world.restore();
  }
});

test('A3 容错：hitTest 不可用 / 抛异常 / unknown ⇒ 一律放行（绝不阻塞主路径）', async () => {
  const world = patchWorld();
  try {
    const cases: ProbeScript[] = [
      { hit: { available: false, classification: 'unavailable', controlType: null } },
      { throwHit: true },
      { hit: { available: true, classification: 'unknown', controlType: null } },
    ];
    for (const script of cases) {
      script.samples = [S(H0, H0, 1), S(B(10), B(10), 2), S(B(12), B(12), 3)];
      const { probe } = makeProbe(script);
      const { execute } = makeExecute({ probe });
      const out = await execute(clickAction());
      assert.equal(world.clicks.length, cases.indexOf(script) + 1, '每种降级都放行派发');
      assert.equal(out.outcome, 'progress');
    }
  } finally {
    world.restore();
  }
});

test('A3 容错：Edit 控件虽分类 text 但可点击聚焦 ⇒ 放行', async () => {
  const world = patchWorld();
  try {
    const { probe, calls } = makeProbe({
      samples: [S(H0, H0, 1), S(B(10), B(10), 2), S(B(12), B(12), 3)],
      hit: { available: true, classification: 'text', controlType: 'EditControl' },
    });
    const { execute } = makeExecute({ probe });
    await execute(clickAction());
    assert.equal(world.clicks.length, 1);
    assert.equal(calls.cursors, 0, 'Edit 判定在前 —— 光标印证不必发起');
  } finally {
    world.restore();
  }
});

test('A3 正：外推焦点已在目标 ⇒ 焦点短路跳过点击', async () => {
  const world = patchWorld();
  try {
    const { probe, calls } = makeProbe({ samples: [S(H0, H0, 1)] });
    const { focus, sets } = fakeFocus({ x: 0.5, y: 0.5 });
    const { execute } = makeExecute({ probe, focus });
    const out = await execute(clickAction());
    assert.equal(out.outcome, 'no_effect');
    assert.ok(out.note?.includes('焦点短路'));
    assert.equal(world.clicks.length, 0, '跳过点击派发');
    assert.equal(sets.length, 0, '未派发 ⇒ 不登记焦点');
    assert.equal(calls.samples, 0, '零采样零截屏');
  } finally {
    world.restore();
  }
});

test('A3 反：焦点远点 ⇒ 正常派发并登记落点（下次短路的证据源）', async () => {
  const world = patchWorld();
  try {
    const { probe } = makeProbe({ samples: [S(H0, H0, 1), S(B(10), B(10), 2), S(B(12), B(12), 3)] });
    const { focus, sets } = fakeFocus({ x: 0.1, y: 0.1 });
    const { execute } = makeExecute({ probe, focus });
    const out = await execute(clickAction());
    assert.equal(out.outcome, 'progress');
    assert.equal(world.clicks.length, 1);
    assert.deepEqual(sets, [[0.5, 0.5]], '点击后登记归一化落点');
  } finally {
    world.restore();
  }
});

test('A3 默认：未注入焦点源 ⇒ 禁用态哨兵远点，行为与接线前一致', async () => {
  const world = patchWorld();
  try {
    const { probe } = makeProbe({ samples: [S(H0, H0, 1), S(B(10), B(10), 2), S(B(12), B(12), 3)] });
    const { execute } = makeExecute({ probe });
    await execute(clickAction());
    assert.equal(world.clicks.length, 1, '禁用态绝不短路');
  } finally {
    world.restore();
  }
});

// ─── A4：bbox 不确定性感知点击 ───

test('A4 正：大框（400×300）点击词级 bbox 质心（文字重心）而非几何中心', async () => {
  const world = patchWorld();
  try {
    const { probe } = makeProbe({ samples: [S(H0, H0, 1), S(B(10), B(10), 2), S(B(12), B(12), 3)] });
    const { execute } = makeExecute({
      probe,
      snapshot: snapshotWithWords([
        { label: '提交', bbox: { x0: 150, y0: 150, x1: 210, y1: 190 }, confidence: 0.9 },
        { label: '取消', bbox: { x0: 380, y0: 300, x1: 440, y1: 340 }, confidence: 0.6 },
      ]),
    });
    // 加权重心 = (0.9×180 + 0.6×410)/1.5 = 272，(0.9×170 + 0.6×320)/1.5 = 230
    // 屏幕像素 = round(272/512×1920)=1020，round(230/384×1080)=647
    const out = await execute(clickAction({
      bbox: { x0: 100, y0: 100, x1: 500, y1: 400 },
      center: { x: 300, y: 250 },
    }));
    assert.equal(world.clicks.length, 1);
    assert.equal(world.clicks[0].x, 1020, '词级质心 x');
    assert.equal(world.clicks[0].y, 647, '词级质心 y');
    assert.ok(out.note?.includes('词级质心 2 词'));
  } finally {
    world.restore();
  }
});

test('A4 正：小框（短边 8px < 24）落点向几何中心收缩 20%', async () => {
  const world = patchWorld();
  try {
    const { probe } = makeProbe({ samples: [S(H0, H0, 1), S(B(10), B(10), 2), S(B(12), B(12), 3)] });
    const { execute } = makeExecute({ probe });
    // 框 {248,188,264,196} 中点 (256,192)；脏 center (260,195) 收 20% ⇒ (259.2, 194.4)
    // 屏幕像素 = round(259.2/512×1920)=972，round(194.4/384×1080)=547
    const out = await execute(clickAction({
      bbox: { x0: 248, y0: 188, x1: 264, y1: 196 },
      center: { x: 260, y: 195 },
    }));
    assert.equal(world.clicks.length, 1);
    assert.equal(world.clicks[0].x, 972);
    assert.equal(world.clicks[0].y, 547);
    assert.ok(out.note?.includes('小框收缩'));
  } finally {
    world.restore();
  }
});

test('A4 正：miss 后 3×3 去中心网格重试，邻位命中即停（ROI 验证）', async () => {
  const world = patchWorld();
  try {
    // 首发全静 ⇒ miss；第 1 邻位（上，步长 16px）ROI 变 ⇒ 命中即停
    const { probe } = makeProbe({
      samples: [
        S(H0, H0, 1), S(H0, H0, 2), S(H0, H0, 3),          // 首发：miss
        S(H0, H0, 4), S(B(10), B(10), 5), S(B(12), B(12), 6), // 邻位 (256,176)：命中
      ],
    });
    const { execute } = makeExecute({ probe });
    const out = await execute(clickAction());
    assert.equal(out.outcome, 'progress');
    assert.equal(world.clicks.length, 2, '首发 + 1 次重试即停');
    assert.deepEqual(world.clicks, [{ x: 960, y: 540 }, { x: 960, y: 495 }]);
    assert.equal(out.verification?.retries, 1);
    assert.ok(out.note?.includes('第 1 次网格重试命中'));
  } finally {
    world.restore();
  }
});

test('A4 反：8 邻位全部 miss ⇒ 穷尽收兵，如实记 no_effect', async () => {
  const world = patchWorld();
  try {
    const samples = Array.from({ length: 30 }, (_, i) => S(H0, H0, i + 1)); // 9 次点击 × 3 样本
    const { probe } = makeProbe({ samples });
    const { execute } = makeExecute({ probe });
    const out = await execute(clickAction());
    assert.equal(out.outcome, 'no_effect');
    assert.equal(world.clicks.length, 9, '首发 + 8 邻位');
    assert.equal(out.verification?.retries, 8);
    assert.ok(out.note?.includes('网格重试 8/8 邻位未命中'));
    const ys = new Set(world.clicks.map(c => `${c.x},${c.y}`));
    assert.equal(ys.size, 9, '9 个落点互不重复');
  } finally {
    world.restore();
  }
});

test('A4 降级：探针缺席 ⇒ ROI 判决缺席，miss 不触发网格盲扫（重试克制）', async () => {
  const world = patchWorld();
  try {
    const snap = composeSnapshot({ width: 512, height: 384, dhash: 'aaaaaaaaaaaaaaaa' });
    const { execute } = makeExecute({ snapshot: snap }); // 无探针；前后 dhash 同 ⇒ no_effect
    const out = await execute(clickAction());
    assert.equal(out.outcome, 'no_effect');
    assert.equal(world.clicks.length, 1, '不重试 —— 单发');
    assert.equal(out.verification?.retries, 0);
    assert.ok(out.verification?.degraded.includes('roi'));
  } finally {
    world.restore();
  }
});

// ─── A5：稳态门控节奏 ───

test('A5 正：连续两帧（150ms 间隔）汉明 ≤ 2 ⇒ 判稳放行，零多余等待', async () => {
  const world = patchWorld();
  try {
    const { probe } = makeProbe({ samples: [S(H0, H0, 1), S(B(10), B(10), 2), S(B(12), B(12), 3)] });
    const { execute, sleeps } = makeExecute({ probe });
    const out = await execute(clickAction());
    assert.equal(out.verification?.steady, true);
    assert.equal(out.verification?.steadyPolls, 1, '一次轮询即稳');
    assert.deepEqual(sleeps, [150], '恰睡一个轮询间隔');
    assert.equal(out.outcome, 'progress');
  } finally {
    world.restore();
  }
});

test('A5 降级：连续抖动超时 ⇒ 强制放行并记 steady-timeout（degraded）', async () => {
  const world = patchWorld();
  try {
    // 每帧都与前帧差 ≥ 4 位 ⇒ 永不稳；w1 覆盖缩短节奏：100ms 轮询 / 600ms 超时
    const gateSamples = Array.from({ length: 9 }, (_, i) => S(B(4 * (i + 1)), null, i + 1));
    const { probe } = makeProbe({ samples: [S(H0, null, 0), ...gateSamples] });
    const { execute, sleeps } = makeExecute({ probe, w1: { steadyPollMs: 100, steadyTimeoutMs: 600 } });
    const out = await execute(clickAction());
    assert.equal(out.verification?.steady, false, '未达稳态');
    assert.ok(out.verification?.degraded.includes('steady-timeout'));
    assert.ok(out.note?.includes('W1降级'));
    assert.equal(sleeps.length, 7, 'maxPolls = ceil(600/100)+1 = 7 次轮询封顶（防死循环）');
    assert.equal(out.verification?.steadyPolls, 7);
    assert.equal(world.clicks.length, 1, '超时强制放行 —— 动作照常完成');
  } finally {
    world.restore();
  }
});

test('A5 滚动：哈希已稳但内容仍平移 ⇒ motionEstimator 续等至静止', async () => {
  const world = patchWorld();
  try {
    // 三帧哈希全同（hashSteady 恒真），但 g1→g2 行亮度平移 5 行 ⇒ 续等；g2→g3 静止 ⇒ 稳
    const ramp = Array.from({ length: 64 }, (_, i) => i * 0.01);
    const rampShift5 = Array.from({ length: 64 }, (_, i) => (i + 5) * 0.01);
    const { probe, calls } = makeProbe({
      samples: [S(H0, null, 10), S(H0, null, 11), S(H0, null, 12), S(H0, null, 13)],
      rows: { 11: ramp, 12: rampShift5, 13: rampShift5 },
    });
    const { execute } = makeExecute({ probe });
    const out = await execute({
      kind: 'scroll', payload: { direction: 'down', amount: 5 },
      rationale: 's', expectedEffect: 's', utility: 0.5, riskTier: 'benign',
    });
    assert.deepEqual(world.scrolled, [{ dir: 'down', amount: 5 }]);
    assert.equal(out.verification?.steady, true);
    assert.equal(out.verification?.steadyPolls, 2, '平移期续等一轮后判稳');
    assert.equal(calls.rows, 4, '两对帧各取两次行亮度');
  } finally {
    world.restore();
  }
});

test('A5 滚动：行亮度缺席 ⇒ 回退纯哈希门（第一轮即稳）', async () => {
  const world = patchWorld();
  try {
    const { probe, calls } = makeProbe({
      samples: [S(H0, null, 1), S(H0, null, 2), S(H0, null, 3)],
      rows: {},
    });
    const { execute } = makeExecute({ probe });
    const out = await execute({
      kind: 'scroll', payload: { direction: 'up' },
      rationale: 's', expectedEffect: 's', utility: 0.5, riskTier: 'benign',
    });
    assert.equal(out.verification?.steady, true);
    assert.equal(out.verification?.steadyPolls, 1);
    assert.equal(calls.rows, 2, '行亮度取过但缺席（null）⇒ 不阻塞');
  } finally {
    world.restore();
  }
});

test('A5 降级：探针缺席 ⇒ 不走稳态门（零等待，steady=null）', async () => {
  const world = patchWorld();
  try {
    const snap = composeSnapshot({ width: 512, height: 384, dhash: 'aaaaaaaaaaaaaaaa' });
    const { execute, sleeps } = makeExecute({ snapshot: snap });
    await execute(clickAction());
    assert.equal(sleeps.length, 0, '零睡眠零等待');
    assert.equal((await execute(clickAction())).verification?.steady ?? null, null);
  } finally {
    world.restore();
  }
});

// ─── 纯函数判决矩阵 ───

test('纯函数：combineRoiVerdict 判决矩阵全覆盖', () => {
  const cap = (v: Partial<import('../src/autonomy/runtime.ts').RoiVerdictInput>) => ({
    roiChanged: null, expectedHit: null, roiOcrChanged: null, fullscreenChanged: null,
    roiCapability: true, ...v,
  });
  // ROI 能力缺席 ⇒ 降级全屏
  assert.deepEqual(combineRoiVerdict(cap({ roiCapability: false, fullscreenChanged: true })), { outcome: 'progress', noise: false, degraded: ['roi'] });
  assert.deepEqual(combineRoiVerdict(cap({ roiCapability: false, fullscreenChanged: false })), { outcome: 'no_effect', noise: false, degraded: ['roi'] });
  assert.deepEqual(combineRoiVerdict(cap({ roiCapability: false, fullscreenChanged: null })), { outcome: 'no_effect', noise: false, degraded: ['roi'] });
  // 三证任一 ⇒ progress
  assert.equal(combineRoiVerdict(cap({ roiChanged: true })).outcome, 'progress');
  assert.equal(combineRoiVerdict(cap({ expectedHit: true, fullscreenChanged: false })).outcome, 'progress');
  assert.equal(combineRoiVerdict(cap({ roiOcrChanged: true })).outcome, 'progress');
  // 三证皆无 ⇒ 全屏变 ⇒ 噪声；全屏未变 ⇒ 平凡 no_effect
  const noise = combineRoiVerdict(cap({ roiChanged: false, expectedHit: false, roiOcrChanged: false, fullscreenChanged: true }));
  assert.deepEqual(noise, { outcome: 'no_effect', noise: true, degraded: [] });
  const still = combineRoiVerdict(cap({ roiChanged: false, fullscreenChanged: false }));
  assert.deepEqual(still, { outcome: 'no_effect', noise: false, degraded: [] });
});

test('纯函数：gridRetryOffsets —— 8 邻位、无中心、无重复、确定性序', () => {
  const offs = gridRetryOffsets();
  assert.equal(offs.length, 8);
  assert.ok(!offs.some(o => o.dx === 0 && o.dy === 0), '去中心');
  assert.equal(new Set(offs.map(o => `${o.dx},${o.dy}`)).size, 8, '无重复');
  assert.deepEqual(gridRetryOffsets(), offs, '确定性序');
});

test('纯函数：pickClickPoint 边界 —— 无框直通 / 脏 center 夹回 / 词出安全带不入集', () => {
  // 无合法框 ⇒ 中心直通
  const d1 = pickClickPoint({ center: { x: 10, y: 20 } }, []);
  assert.deepEqual({ x: d1.x, y: d1.y, via: d1.via }, { x: 10, y: 20, via: 'center' });
  // 脏 center（框外）⇒ 夹回框内
  const d2 = pickClickPoint({ bbox: { x0: 0, y0: 0, x1: 100, y1: 50 }, center: { x: 500, y: -5 } }, []);
  assert.equal(d2.x, 100);
  assert.equal(d2.y, 0);
  // 大框无内嵌词 ⇒ 几何中心
  const d3 = pickClickPoint({ bbox: { x0: 0, y0: 0, x1: 400, y1: 300 }, center: { x: 200, y: 150 } }, []);
  assert.equal(d3.via, 'center');
  assert.equal(d3.words, 0);
  // 词中心在内缩 10% 安全带之外 ⇒ 不入词集（贴边词不可信）
  const d4 = pickClickPoint(
    { bbox: { x0: 0, y0: 0, x1: 400, y1: 300 }, center: { x: 200, y: 150 } },
    [{ label: '贴边词', bbox: { x0: 1, y0: 150, x1: 30, y1: 170 }, confidence: 0.9 }],
  );
  assert.equal(d4.via, 'center', '安全带外词不入集');
  // 近自尺寸元素（面积 > 60% 目标）⇒ 视为目标镜像，不入词集
  const d5 = pickClickPoint(
    { bbox: { x0: 0, y0: 0, x1: 400, y1: 300 }, center: { x: 200, y: 150 } },
    [{ label: '大块', bbox: { x0: 10, y0: 10, x1: 390, y1: 290 }, confidence: 0.9 }],
  );
  assert.equal(d5.via, 'center');
});

test('纯函数：w1HashDistance —— hex/位串统一、无效与不可比诚实缺席', () => {
  assert.equal(w1HashDistance(B(3), B(5)), 2);
  assert.equal(w1HashDistance('0'.repeat(64), '0'.repeat(63) + '1'), 1);
  assert.equal(w1HashDistance('ab12', 'ab12'), 0);
  assert.equal(w1HashDistance(null, 'ab'), null);
  assert.equal(w1HashDistance('', 'ab'), null);
  assert.equal(w1HashDistance('abcd', 'ab'), null, '归一后长度不齐 ⇒ 不可比');
});

// ─── motionEstimator / focusTracker 的 W1-1 新面 ───

test('motionEstimator：stillTranslating 判决矩阵（脏输入不炸）', () => {
  assert.equal(stillTranslating({ shift: 5, residual: 0.1, bestInteger: 5 }), true);
  assert.equal(stillTranslating({ shift: -3.2, residual: 0.4, bestInteger: -3 }), true);
  assert.equal(stillTranslating({ shift: 0.2, residual: 0.1, bestInteger: 0 }), false, '位移不足');
  assert.equal(stillTranslating({ shift: 5, residual: 0.8, bestInteger: 5 }), false, '平移假设不成立');
  assert.equal(stillTranslating({ shift: Number.NaN, residual: 0.1, bestInteger: 0 }), false);
  assert.equal(stillTranslating(null), false);
  // 与 estimateRowShift 的集成事实：平移 5 行的行亮度序列 ⇒ 仍在平移
  const a = Array.from({ length: 64 }, (_, i) => i * 0.01);
  const b = Array.from({ length: 64 }, (_, i) => (i + 5) * 0.01);
  assert.equal(stillTranslating(estimateRowShift(a, b)), true);
});

test('focusTracker：predictedFresh 只认自家 origin 标签的新鲜记录', () => {
  focusTracker.clear();
  try {
    assert.deepEqual(predictedFresh('w1-exec'), NO_FOCUS, '无记录 ⇒ 哨兵远点');
    focusTracker.set(0.5, 0.5, false, 'w1-exec');
    assert.deepEqual(predictedFresh('w1-exec'), { x: 0.5, y: 0.5, extrapolated: false });
    focusTracker.set(0.2, 0.2); // 工具层无标签记录
    assert.deepEqual(predictedFresh('w1-exec'), NO_FOCUS, '外来记录不构成短路证据');
    focusTracker.set(0.4, 0.4, false, 'w1-exec');
    assert.deepEqual(predictedFresh('w1-exec', -1), NO_FOCUS, '过期 ⇒ 哨兵（maxAge 门槛）');
  } finally {
    focusTracker.clear();
  }
});

test('focusTracker：createExecFocusSource 工厂 —— 登记即外推、脏坐标不入账', () => {
  focusTracker.clear();
  try {
    const src = createExecFocusSource('w1-test');
    assert.deepEqual(src.predicted(), { x: -9, y: -9, extrapolated: false });
    src.set(0.25, 0.75);
    assert.deepEqual(src.predicted(), { x: 0.25, y: 0.75, extrapolated: false });
    src.set(Number.NaN, 0);
    assert.equal(src.predicted().x, 0.25, '脏坐标被拒 ⇒ 焦点保持');
  } finally {
    focusTracker.clear();
  }
});

// ─── 探针桥：PhysicalExecutionAdapter Result 方言 → null 降级方言 ───

const ok = <T,>(value: T) => ({ ok: true as const, value });
const fail = { ok: false as const, error: { kind: 'internal_error' as const, detail: 'boom' } };

function adapt(methods: Record<string, unknown>): PhysicalExecutionAdapter {
  return methods as unknown as PhysicalExecutionAdapter;
}

test('探针桥：成功臂的协议转写（hitTest/cursor/sample/frameDiff/rowMeans）', async () => {
  const probe = createExecWorldProbe(adapt({
    hitTest: async () => ok({ available: true, classification: 'text', control_type: 'TextControl' }),
    getCursorKind: async () => ok({ kind: 'hand' }),
    takeScreenshot: async () => ok({
      dhash: 'ab12cd34', region_dhash: '', frame_id: 7, width: 1920, height: 1080,
      transport: 'base64', name: '', size: 0, shape: [0, 0, 0], dtype: '', stride: 0,
      format: '', captured_at: 0, image_base64: '',
    }),
    frameDiff: async () => ok({
      changed_regions: [{ x: 1, y: 2, width: 3, height: 4 }, { x: 'a', y: 2, width: 3, height: 4 }, null],
      frame_a: 1, frame_b: 2, region_count: 3, block_threshold: 24,
    }),
    frameRowmeans: async () => ok({ frame_id: 7, rows: [1, 2, 3] }),
  }));
  assert.deepEqual(await probe.hitTestPoint?.(1, 2), { available: true, classification: 'text', controlType: 'TextControl' });
  assert.equal(await probe.cursorKind?.(), 'hand');
  assert.deepEqual(await probe.sampleFrame?.({ keepFrame: true }), {
    dhash: 'ab12cd34', regionDhash: null, frameId: 7, width: 1920, height: 1080,
  });
  assert.deepEqual(await probe.frameDiff?.(1, 2), [{ x: 1, y: 2, width: 3, height: 4 }], '脏区域被消毒剔除');
  assert.deepEqual(await probe.frameRowMeans?.(7), [1, 2, 3]);
});

test('探针桥：失败臂 / 异常 / 脏形状 ⇒ 一律 null（绝不抛、绝不阻塞主路径）', async () => {
  const bad = createExecWorldProbe(adapt({
    hitTest: async () => fail,
    getCursorKind: async () => { throw new Error('cursor 端点故障'); },
    takeScreenshot: async () => ok('不是对象'),
    frameDiff: async () => ok({ changed_regions: '不是数组' }),
    frameRowmeans: async () => ok({ rows: [1, Number.NaN] }),
  }));
  assert.equal(await bad.hitTestPoint?.(1, 2), null);
  assert.equal(await bad.cursorKind?.(), null);
  assert.equal(await bad.sampleFrame?.(), null);
  assert.equal(await bad.frameDiff?.(1, 2), null);
  assert.equal(await bad.frameRowMeans?.(1), null);
});

test('探针桥：未知 classification / 空光标形态 ⇒ 消毒为保守值', async () => {
  const probe = createExecWorldProbe(adapt({
    hitTest: async () => ok({ available: true, classification: 'weird', control_type: 42 }),
    getCursorKind: async () => ok({ kind: '' }),
    takeScreenshot: async () => ok({ frame_id: 'x' }),
    frameDiff: async () => fail,
    frameRowmeans: async () => ok({ rows: [] }),
  }));
  assert.deepEqual(await probe.hitTestPoint?.(0, 0), { available: true, classification: 'unavailable', controlType: null });
  assert.equal(await probe.cursorKind?.(), null);
  const s = await probe.sampleFrame?.();
  assert.ok(s);
  assert.equal(s?.frameId, null, '非数字帧 id 消毒为 null');
  assert.equal(s?.dhash, null);
  assert.equal(await probe.frameRowMeans?.(1), null, '空行亮度序列 = 无证据');
});

test('W1_EXEC_TUNING 缺省值契约（集成阶段接 config 的对照基线）', () => {
  assert.equal(W1_EXEC_TUNING.roiRadiusPx, 128);
  assert.equal(W1_EXEC_TUNING.roiHammingTolerance, 2);
  assert.equal(W1_EXEC_TUNING.steadyPollMs, 150);
  assert.equal(W1_EXEC_TUNING.steadyTimeoutMs, 2000);
  assert.equal(W1_EXEC_TUNING.steadyHamming, 2);
  assert.equal(W1_EXEC_TUNING.clickRetryMax, 8);
  assert.equal(W1_EXEC_TUNING.smallBboxPx, 24);
  assert.equal(W1_EXEC_TUNING.smallShrinkRatio, 0.2);
});

// ─── ΑΩ-R12：inspect 聚焦检视 / drag 拖拽端口（执行面落地） ───
// inspect：围绕检视点开 ROI 窗（W1 tuning roiRadiusPx=128）词级 OCR —— 窗内词
// 入摘要（信息增益）、窗外词不入；绝不移动鼠标绝不点击（零像素影响）；OCR
// 端口缺席/检视点缺席 ⇒ 诚实降级 no_effect + 注记。
// drag：像素换算（与 click 同律）后经 deps.drag 端口派发；端口缺席 ⇒ no_effect
// + 诚实注记；端口报失败 ⇒ error 诚实归因。

test('ΑΩ-R12 inspect 正：ROI 窗内词入摘要、窗外词不入（payload.region 方言，零键鼠）', async () => {
  const world = patchWorld();
  try {
    const { execute, getCaptures } = makeExecute({
      readWords: async () => [
        { label: '窗内词', bbox: { x0: 240, y0: 180, x1: 280, y1: 200 }, confidence: 0.9 },
        { label: '窗外词', bbox: { x0: 8, y0: 8, x1: 48, y1: 28 }, confidence: 0.9 },
      ],
    });
    // 策略引擎僵局切换方言：payload.region（快照像素域）中心 (256,192)
    const out = await execute({
      kind: 'inspect',
      payload: { region: { x0: 200, y0: 160, x1: 312, y1: 224 } },
      rationale: 'ΑΩ-R12', expectedEffect: '无像素影响', utility: 0.5, riskTier: 'benign',
    });
    assert.equal(out.outcome, 'no_effect', '观察性动作 —— 零像素影响照旧');
    assert.ok(out.note?.includes('窗内词'), 'ROI 窗内词进摘要（信息增益）');
    assert.ok(!out.note?.includes('窗外词'), 'ROI 窗外词不进摘要');
    assert.ok(out.note?.includes('读到 1 词'), '词数如实记账');
    assert.ok(out.note?.includes('聚焦检视'), 'note 记检视归因');
    assert.equal(world.clicks.length, 0, '绝不点击');
    assert.equal(world.typed.length, 0, '绝不键入');
    assert.equal(world.scrolled.length, 0, '绝不滚动');
    assert.equal(world.hotkeys.length, 0, '绝不按键');
    assert.ok(getCaptures() >= 1, '检视需一帧截屏做 OCR');
    assert.equal(out.verification?.noise, false, '零世界动作的诚实账');
    assert.deepEqual(out.verification?.degraded, []);
  } finally {
    world.restore();
  }
});

test('ΑΩ-R12 inspect 正：target.center 优先于 payload.region（换算链同 click）', async () => {
  const world = patchWorld();
  try {
    const { execute } = makeExecute({
      readWords: async () => [
        { label: '近点词', bbox: { x0: 90, y0: 100, x1: 130, y1: 120 }, confidence: 0.9 },
        { label: '远点词', bbox: { x0: 280, y0: 280, x1: 320, y1: 320 }, confidence: 0.9 },
      ],
    });
    const out = await execute({
      kind: 'inspect',
      target: { bbox: { x0: 60, y0: 60, x1: 140, y1: 140 }, center: { x: 100, y: 100 }, label: '焦点区' },
      payload: { region: { x0: 400, y0: 300, x1: 500, y1: 360 } }, // region 在场但 target.center 优先
      rationale: 'ΑΩ-R12', expectedEffect: '无像素影响', utility: 0.5, riskTier: 'benign',
    });
    assert.equal(out.outcome, 'no_effect');
    assert.ok(out.note?.includes('近点词'), 'target.center 邻域词入摘要');
    assert.ok(!out.note?.includes('远点词'), '远点词不入摘要');
  } finally {
    world.restore();
  }
});

test('ΑΩ-R12 inspect 降级：deps.readWords 缺席 ⇒ no_effect + 诚实注记（不伪读）', async () => {
  const { execute, getCaptures } = makeExecute({ noReadWords: true });
  const out = await execute({
    kind: 'inspect',
    payload: { region: { x0: 200, y0: 160, x1: 312, y1: 224 } },
    rationale: 'ΑΩ-R12', expectedEffect: '无像素影响', utility: 0.5, riskTier: 'benign',
  });
  assert.equal(out.outcome, 'no_effect');
  assert.ok(out.note?.includes('deps.readWords'), 'note 诚实归因 OCR 端口缺席');
  assert.equal(getCaptures(), 0, '端口缺席 ⇒ 不截屏（零浪费）');
  assert.deepEqual(out.verification?.degraded, []);
});

test('ΑΩ-R12 inspect 降级：检视点缺席（无 target.center / payload.region）⇒ 不动作', async () => {
  const world = patchWorld();
  try {
    const { execute, getCaptures } = makeExecute({ readWords: async () => [] });
    const out = await execute({
      kind: 'inspect',
      rationale: 'ΑΩ-R12', expectedEffect: '无像素影响', utility: 0.5, riskTier: 'benign',
    });
    assert.equal(out.outcome, 'no_effect');
    assert.ok(out.note?.includes('检视点缺席'), 'note 诚实归因');
    assert.equal(getCaptures(), 0);
  } finally {
    world.restore();
  }
});

test('ΑΩ-R12 drag 正：端口注入 ⇒ 换算像素四元组派发（快照像素 → 归一化 → 屏幕像素）', async () => {
  const world = patchWorld();
  try {
    const calls: Array<[number, number, number, number]> = [];
    const { focus, sets } = fakeFocus({ x: -9, y: -9 });
    const { execute } = makeExecute({
      focus,
      drag: async (sx, sy, ex, ey) => { calls.push([sx, sy, ex, ey]); return { ok: true }; },
    });
    const out = await execute({
      kind: 'drag',
      target: { bbox: { x0: 200, y0: 160, x1: 312, y1: 224 }, center: { x: 256, y: 192 }, label: '滑块' },
      payload: { end: { x: 400, y: 300 } },
      rationale: 'ΑΩ-R12', expectedEffect: '滑块右移', utility: 0.5, riskTier: 'benign',
    });
    assert.deepEqual(calls, [[960, 540, 1500, 844]], '起点/终点均按 click 同律换算为屏幕像素');
    assert.deepEqual(sets, [[400 / 512, 300 / 384]], '落点登记于终点（归一化）');
    assert.equal(world.clicks.length, 0, 'drag 不经 system.clickMouse（端口破环）');
    assert.ok(out.verification, '世界动作走三区判决管线');
    assert.equal(out.outcome, 'progress', '无探针 ⇒ 全屏降级判决：before 帧缺席首见判变');
    assert.ok(out.verification?.degraded.includes('roi'), '探针缺席记 roi 降级');
    assert.ok(out.note?.includes('拖拽像素 (960, 540) → (1500, 844)'), 'note 记派发轨迹');
  } finally {
    world.restore();
  }
});

test('ΑΩ-R12 drag 降级：端口缺席 / 终点缺席 ⇒ no_effect + 诚实注记（不动作）', async () => {
  const world = patchWorld();
  try {
    const { execute } = makeExecute(); // 不注入 drag 端口
    const base: PolicyAction = {
      kind: 'drag',
      target: { bbox: { x0: 200, y0: 160, x1: 312, y1: 224 }, center: { x: 256, y: 192 }, label: '滑块' },
      rationale: 'ΑΩ-R12', expectedEffect: '滑块右移', utility: 0.5, riskTier: 'benign',
    };
    const out1 = await execute({ ...base, payload: { end: { x: 400, y: 300 } } });
    assert.equal(out1.outcome, 'no_effect', '端口缺席 ⇒ 与接线前 default 空转同结局');
    assert.ok(out1.note?.includes('deps.drag'), '多一句可审计归因');

    const calls: Array<[number, number, number, number]> = [];
    const { execute: execute2 } = makeExecute({
      drag: async (sx, sy, ex, ey) => { calls.push([sx, sy, ex, ey]); return { ok: true }; },
    });
    const out2 = await execute2({ ...base }); // 有端口但 payload.end 缺席
    assert.equal(out2.outcome, 'no_effect');
    assert.ok(out2.note?.includes('payload.end'), 'note 诚实归因终点缺席');
    assert.equal(calls.length, 0, '绝不派发');
  } finally {
    world.restore();
  }
});

test('ΑΩ-R12 drag 失败：端口报 ok:false ⇒ error 诚实归因（外层收口不抛）', async () => {
  const world = patchWorld();
  try {
    const { execute } = makeExecute({ drag: async () => ({ ok: false, error: '物理层拒绝' }) });
    const out = await execute({
      kind: 'drag',
      target: { bbox: { x0: 200, y0: 160, x1: 312, y1: 224 }, center: { x: 256, y: 192 }, label: '滑块' },
      payload: { end: { x: 400, y: 300 } },
      rationale: 'ΑΩ-R12', expectedEffect: '滑块右移', utility: 0.5, riskTier: 'benign',
    });
    assert.equal(out.outcome, 'error', '端口失败 = 派发失败 ⇒ error（与 click 派发异常同律）');
    assert.ok(out.note?.includes('物理层拒绝'), 'note 携端口错误归因');
    assert.ok(out.note?.includes('execute:'), '外层 error 收口格式保持');
  } finally {
    world.restore();
  }
});

// ─── ΝΩ-13（执行回路三修）：inspect 产物回流 / 重试抽查去重 / type 焦点回填 ───
// 一修：handleInspect 的 ROI 新词合成 LocalElement 增量，经 composeSnapshot 单源
// 重铸进 lastSnapshotRef（takenAt 刷新、degraded 记 'inspect-merged'、dhash 原样
// 透传）—— 下一步 policy.decide 可见；幂等闸防重复检视虚增，防御式保旧快照。
// 二修：click 网格重试传 spotOverride:false —— spotDue 到期时抽查在首发消费
// 一次即止，8 邻位重试不再重复截屏+OCR。
// 三修：type 的外推焦点是哨兵远点（焦点源禁用）而 hitTest 端口在场 ⇒ 用最近
// click 派发落点经 hitTest 证实后回填 ROI 判决；端口缺席/证实失败 ⇒ 全屏（旧行为）。

test('ΝΩ-13 一修正：ROI 新词重铸进快照槽 —— decide 检索面可见、幂等不虚增', async () => {
  const world = patchWorld();
  try {
    const before = snapshotWithWords(
      [{ label: '旧词', bbox: { x0: 236, y0: 188, x1: 276, y1: 196 } }],
      1_000,
    );
    const { execute, ref } = makeExecute({
      snapshot: before,
      readWords: async () => [
        { label: '检视新词', bbox: { x0: 240, y0: 180, x1: 280, y1: 200 }, confidence: 0.9 },
        { label: '窗外词', bbox: { x0: 8, y0: 8, x1: 48, y1: 28 }, confidence: 0.9 },
      ],
    });
    const action: PolicyAction = {
      kind: 'inspect',
      payload: { region: { x0: 200, y0: 160, x1: 312, y1: 224 } },
      rationale: 'ΝΩ-13', expectedEffect: '无像素影响', utility: 0.5, riskTier: 'benign',
    };
    const out = await execute(action);
    assert.equal(out.outcome, 'no_effect', '观察性动作结局照旧');
    assert.ok(out.note?.includes('增量回流 1 词'), 'note 记回流账');
    const merged = ref().current;
    assert.ok(merged, '快照槽在位');
    assert.ok(findInSnapshot(merged, '检视新词').length >= 1, '检视新词对检索面可见（decide 同源）');
    assert.ok(!merged.elements.some(el => el.label === '窗外词'), 'ROI 窗外词不入增量');
    assert.ok(merged.elements.some(el => el.label === '旧词'), '旧元素保持');
    assert.ok(merged.degraded.includes('inspect-merged'), 'degraded 诚实记 inspect-merged');
    assert.equal(merged.dhash, before.dhash, '零像素影响 —— 指纹原样透传');
    assert.ok(merged.takenAt > before.takenAt, 'takenAt 刷新（注入时钟步进）');
    assert.ok(merged.textDigest.includes('检视新词'), '文本摘要携带增量');
    // 幂等闸：重复检视同一区域 —— 同标签同位置词已在账上 ⇒ 零新增量零重铸
    const out2 = await execute(action);
    assert.ok(!out2.note?.includes('增量回流'), '全在账 ⇒ 不再记回流');
    assert.equal(ref().current, merged, '无增量 ⇒ 快照对象不换（零虚增零抖动）');
  } finally {
    world.restore();
  }
});

test('ΝΩ-13 一修防御：OCR 读取失败 ⇒ 旧快照原样保持（检视诚实降级不伪读）', async () => {
  const world = patchWorld();
  try {
    const before = snapshotWithWords(
      [{ label: '旧词', bbox: { x0: 236, y0: 188, x1: 276, y1: 196 } }],
      1_000,
    );
    const { execute, ref } = makeExecute({
      snapshot: before,
      readWords: async () => { throw new Error('OCR 端口故障'); },
    });
    const out = await execute({
      kind: 'inspect',
      payload: { region: { x0: 200, y0: 160, x1: 312, y1: 224 } },
      rationale: 'ΝΩ-13', expectedEffect: '无像素影响', utility: 0.5, riskTier: 'benign',
    });
    assert.equal(out.outcome, 'no_effect');
    assert.ok(out.note?.includes('读取失败'), '诚实降级注记保持');
    assert.equal(ref().current, before, '旧快照原样保持（回流绝不伪造）');
  } finally {
    world.restore();
  }
});

test('ΝΩ-13 二修：spotDue 到期首发抽查恰一次，8 邻位重试零抽查', async () => {
  const world = patchWorld();
  try {
    // 样本序：两发命中（各 3 帧）+ 第三发全静 miss（首发 3 帧 + 8 邻位各 3 帧）
    const hitFrames = (base: number): FrameSample[] => [
      S(H0, H0, base), S(B(10), B(10), base + 1), S(B(12), B(12), base + 2),
    ];
    const missAll = Array.from({ length: 27 }, (_, i) => S(H0, H0, 100 + i));
    const { probe } = makeProbe({ samples: [...hitFrames(1), ...hitFrames(4), ...missAll] });
    let readCalls = 0;
    const { execute, getCaptures } = makeExecute({
      probe,
      readWords: async (): Promise<RuntimeWord[]> => { readCalls++; return []; },
    });
    await execute(clickAction()); // verifiedCount→1（1%3≠0）
    await execute(clickAction()); // verifiedCount→2（2%3≠0）
    assert.equal(readCalls, 0, '未到期零抽查');
    assert.equal(getCaptures(), 0, '探针在场且无 OCR 需求 ⇒ 零全帧截屏');
    const out = await execute(clickAction()); // verifiedCount→3 ⇒ spotDue 首发；重试全 miss
    assert.equal(out.outcome, 'no_effect');
    assert.equal(world.clicks.length, 2 + 9, '前两发命中 + 第三发首发与 8 邻位全 miss');
    assert.equal(out.verification?.retries, 8);
    assert.equal(readCalls, 1, '判据抽查恰首发一次 —— 重试期不再抽查');
    assert.equal(getCaptures(), 1, '抽查截屏恰一次（重试零截屏）');
  } finally {
    world.restore();
  }
});

test('ΝΩ-13 三修正：哨兵焦点 + hitTest 在场 ⇒ click 落点回填 ROI 判决', async () => {
  const world = patchWorld();
  try {
    // click 命中（3 帧）→ type：before 区域指纹 B(10) → 门后 B(14)（距 4 > 2 ⇒ ROI 变而全屏静）
    const { probe, calls } = makeProbe({
      samples: [
        S(H0, H0, 1), S(B(10), B(10), 2), S(B(12), B(12), 3),
        S(H0, B(10), 4), S(H0, B(10), 5), S(H0, B(14), 6),
      ],
      hit: { available: true, classification: 'control', controlType: 'EditControl' },
    });
    const { execute } = makeExecute({ probe }); // 不注入 focus ⇒ 禁用态哨兵远点
    await execute(clickAction()); // 真实派发 ⇒ 闭包记落点 (0.5, 0.5)
    const out = await execute({
      kind: 'type', payload: { text: 'hello' },
      rationale: 't', expectedEffect: 't', utility: 0.5, riskTier: 'benign',
    });
    assert.deepEqual(world.typed, ['hello']);
    assert.equal(out.outcome, 'progress');
    assert.equal(out.verification?.roiChanged, true, '回填焦点 ⇒ ROI 三区判决（非全屏降级）');
    assert.equal(out.verification?.fullscreenChanged, false, '全屏静 —— Toast 类局部反馈不漏');
    assert.ok(!out.verification?.degraded.includes('roi'), 'ROI 证据链在场');
    assert.ok(out.note?.includes('hitTest 回填'), 'note 记回填归因');
    assert.equal(calls.hits, 2, 'click 预检 + type 回填各恰一次 hitTest');
  } finally {
    world.restore();
  }
});

test('ΝΩ-13 三修降级：hitTest 端口缺席 ⇒ 哨兵焦点保持全屏判决（旧行为）', async () => {
  const world = patchWorld();
  try {
    // 最小探针：只有帧采样（hitTestPoint 方法缺席 —— 端口缺席的诚实降级面）
    const queue: FrameSample[] = [
      S(H0, H0, 1), S(B(10), B(10), 2), S(B(12), B(12), 3), // click：命中（落点已记）
      S(H0, null, 4), S(B(6), null, 5), S(B(10), null, 6),  // type：全屏变（降级判决面）
    ];
    const minimal: ExecWorldProbe = {
      sampleFrame: async () => queue.shift() ?? null,
      frameDiff: async () => null,
      frameRowMeans: async () => null,
    };
    const { execute } = makeExecute({ probe: minimal }); // 不注入 focus ⇒ 哨兵
    await execute(clickAction());
    const out = await execute({
      kind: 'type', payload: { text: 'hello' },
      rationale: 't', expectedEffect: 't', utility: 0.5, riskTier: 'benign',
    });
    assert.deepEqual(world.typed, ['hello']);
    assert.equal(out.verification?.roiChanged, null, '无 ROI 判决');
    assert.ok(out.verification?.degraded.includes('roi'), '诚实降级记 roi（与接线前一致）');
    assert.ok(!out.note?.includes('回填'), '无回填归因');
    assert.equal(out.outcome, 'progress', '全屏变 ⇒ progress（旧行为保持）');
  } finally {
    world.restore();
  }
});

test('ΝΩ-13 三修降级：hitTest 证实失败（unavailable）⇒ 全屏判决（诚实降级）', async () => {
  const world = patchWorld();
  try {
    const { probe, calls } = makeProbe({
      samples: [
        S(H0, H0, 1), S(B(10), B(10), 2), S(B(12), B(12), 3),
        S(H0, null, 4), S(B(6), null, 5), S(B(10), null, 6),
      ],
      hit: { available: false, classification: 'unavailable', controlType: null },
    });
    const { execute } = makeExecute({ probe }); // 不注入 focus ⇒ 哨兵
    await execute(clickAction());
    const out = await execute({
      kind: 'type', payload: { text: 'hello' },
      rationale: 't', expectedEffect: 't', utility: 0.5, riskTier: 'benign',
    });
    assert.deepEqual(world.typed, ['hello']);
    assert.equal(out.verification?.roiChanged, null, '证实失败 ⇒ 不回填');
    assert.ok(out.verification?.degraded.includes('roi'), '诚实降级记 roi');
    assert.ok(!out.note?.includes('回填'), '无回填归因');
    assert.equal(calls.hits, 2, 'click 预检 + type 证实尝试各恰一次');
    assert.equal(out.outcome, 'progress', '全屏变 ⇒ progress（旧行为保持）');
  } finally {
    world.restore();
  }
});
