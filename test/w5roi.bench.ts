// test/w5roi.bench.ts  ——  W5-6 效能基准包 · A2 ROI 三证验证开销守护
//
// 被测声明（W1-1 A2，autonomy/runtime ROI 区域化验证）：ROI 三证（区域
// 指纹 / frameDiff 交叠 / ROI 内 OCR 词）是质量改进（全屏变而三证皆无 ⇒
// 判噪声，防时钟/闪烁假阳性）。本基准守护其「不倒贴」：ROI 路径的开销
// 不得劣化超出容差（质量改进不许倒贴性能）。
//
// 口径（声明值 vs 实测值，逐项入 console 表）：
//   · 基线臂（全屏 dhash 方案）= 探针缺席的生产降级路径：每动作 1 次全帧
//     截屏（capture）+ 1 次 JS 侧全帧 dhash（dhashOf）+ 1 次尺寸探测 +
//     snapshotChanged 全屏比对 —— 与接线前逐字节同路径；
//   · ROI 臂（三证方案）= 探针在场：每动作 3 次 meta-only 采样（后端哈希、
//     零图像字节过桥），全帧截屏只在判据抽查（每 3 步）与第三证 OCR 补位
//     （区域指纹缺席）时发生；
//   · 开销当量（主计量）= 图像字节过桥量：capture 返回全帧缓冲的字节和
//     （FRAME_BYTES = 800×600×3 原始当量，声明常量）；meta 采样计 0 字节；
//   · 次计量 = 端口调用次数（轻 重同权，只作监控）：容差 ≤1.5× 基线；
//     重端口（截屏 / JS 全帧哈希）必须严格不增；
//   · 质量守护 = 噪声判决在岗（全屏变而 ROI 不动 ⇒ no_effect+noise ——
//     这是全屏 dhash 方案会误判 progress 的用例，开销买的就是它）。
//
// 确定性：假探针脚本化样本、monkey-patch 键鼠（finally 复原）、注入时钟；
// 同机两次运行逐计数一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { system } from '../src/system.ts';
import { createExecute, type RuntimeDeps, type RuntimeWord, type W1ExecTuning } from '../src/autonomy/runtime.ts';
import { composeSnapshot, type WorldSnapshot } from '../src/autonomy/worldSnapshot.ts';
import type { GoalSpec, PolicyAction } from '../src/autonomy/index.ts';
import type { ExecWorldProbe, FrameSample } from '../src/physicalExecution/execProbe.ts';

// ─── 假件工坊（w1exec.test.ts 同律） ───

const FRAME_BYTES = 800 * 600 * 3; // 全帧缓冲字节当量（口径常量）

type SystemPatch = Partial<Record<'clickMouse' | 'getScreenSize', unknown>>;
function patchSystem(over: SystemPatch): () => void {
  const saved: Record<string, unknown> = {};
  const host = system as unknown as Record<string, unknown>;
  for (const key of Object.keys(over)) {
    saved[key] = host[key];
    host[key] = (over as Record<string, unknown>)[key];
  }
  return () => { for (const key of Object.keys(over)) host[key] = saved[key]; }
}

const B = (n: number): string => '1'.repeat(n) + '0'.repeat(64 - n);
const H0 = B(0);
const S = (dh: string | null, rdh: string | null, id: number): FrameSample => ({
  dhash: dh, regionDhash: rdh, frameId: id, width: 1920, height: 1080,
});

/** 假探针（脚本化样本 + 变化区脚本 + 全调用计数） */
function makeProbe(samples: FrameSample[], regions: Array<{ x: number; y: number; width: number; height: number }> | null): {
  probe: ExecWorldProbe;
  calls: { samples: number; diffs: number };
} {
  const calls = { samples: 0, diffs: 0 };
  const queue = [...samples];
  return {
    calls,
    probe: {
      sampleFrame: async () => { calls.samples++; return queue.length > 0 ? queue.shift()! : null; },
      frameDiff: async () => { calls.diffs++; return regions; },
      frameRowMeans: async () => null,
      hitTestPoint: async () => null,
      cursorKind: async () => null,
    },
  };
}

/** 含词级元素的感知快照（第三证 OCR 补位的 before 侧证据） */
function snapshotWithWords(): WorldSnapshot {
  return composeSnapshot({
    width: 512,
    height: 384,
    dhash: H0,
    localElements: [{ label: '旧词', bbox: { x0: 236, y0: 188, x1: 276, y1: 196 }, confidence: 0.9 }],
    ocrText: '旧词',
  });
}

interface Counts { captures: number; dhashes: number; sizes: number; ocr: number }

/** 铸造被测 execute + 全端口计数（capture 返回全帧字节当量缓冲） */
function makeExecute(o: {
  probe?: ExecWorldProbe;
  withSnapshot?: boolean;
  readWords?: (buf: Buffer) => Promise<RuntimeWord[]>;
  w1?: Partial<W1ExecTuning>;
} = {}): {
  execute: (action: PolicyAction) => Promise<{
    outcome: string;
    verification?: { roiChanged: boolean | null; roiOcrChanged: boolean | null; noise: boolean };
    note?: string;
  }>;
  counts: Counts;
} {
  const counts: Counts = { captures: 0, dhashes: 0, sizes: 0, ocr: 0 };
  let clock = 1_000;
  const deps: RuntimeDeps & { spec: GoalSpec; width: number; height: number } = {
    capture: async () => { counts.captures++; return Buffer.alloc(FRAME_BYTES); },
    imageSize: async () => { counts.sizes++; return ({ width: 512, height: 384 }); },
    dhashOf: async () => { counts.dhashes++; return B(12); },
    readWords: o.readWords ?? (async (): Promise<RuntimeWord[]> => { counts.ocr++; return []; }),
    now: () => (clock += 50),
    sleep: async () => { /* 零真睡 */ },
    lastSnapshotRef: { current: o.withSnapshot === true ? snapshotWithWords() : null },
    ...(o.probe ? { probe: o.probe } : {}),
    ...(o.w1 ? { w1: o.w1 } : {}),
    spec: { goal: 'W5-6 ROI 开销守护', successCriteria: ['完成'] },
    width: 512,
    height: 384,
  };
  return { execute: createExecute(deps), counts };
}

function clickAction(): PolicyAction {
  return {
    kind: 'click',
    target: { bbox: { x0: 200, y0: 160, x1: 312, y1: 224 }, center: { x: 256, y: 192 }, label: '目标' },
    rationale: 'W5-6 基准', expectedEffect: 'W5-6 基准', utility: 0.5, riskTier: 'benign',
  };
}

// ─── ROI 开销守护基准 ───

test('W5-6/A2: ROI 三证 vs 全屏 dhash —— 开销不劣化 + 噪声判决在岗（守护「不倒贴」）', async () => {
  const M = 6;
  const restore = patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async () => { /* 剧本键鼠 */ },
  });
  try {
    // ── 基线臂：全屏 dhash 方案（探针缺席的生产降级路径） ──
    const full = makeExecute({}); // 无探针、无快照
    for (let i = 0; i < M; i++) {
      const out = await full.execute(clickAction());
      assert.equal(out.outcome, 'progress', '全屏臂每动作首见判变 progress');
    }

    // ── ROI 臂：三证方案 ──
    // 点击 1-4：区域指纹在场（before H0 → 稳态门后 B12 ⇒ ROI 判变）；
    // 点击 5-6：区域指纹缺席 ⇒ 第三证 OCR 补位（快照旧词 → 新词 ⇒ 判变）
    const samples: FrameSample[] = [];
    let id = 0;
    for (let i = 0; i < 4; i++) samples.push(S(H0, H0, ++id), S(B(10), B(10), ++id), S(B(12), B(12), ++id));
    for (let i = 0; i < 2; i++) samples.push(S(H0, null, ++id), S(B(10), null, ++id), S(B(12), null, ++id));
    const roiProbe = makeProbe(samples, []);
    const roi = makeExecute({
      probe: roiProbe.probe,
      withSnapshot: true,
      readWords: async () => [{ label: '新词', bbox: { x0: 240, y0: 180, x1: 270, y1: 210 }, confidence: 0.9 }],
    });
    const roiOutcomes = [];
    for (let i = 0; i < M; i++) roiOutcomes.push(await roi.execute(clickAction()));

    // ── 计量 ──
    const fullBytes = full.counts.captures * FRAME_BYTES;
    const roiBytes = roi.counts.captures * FRAME_BYTES;
    const fullCalls = full.counts.captures + full.counts.dhashes + full.counts.sizes + full.counts.ocr;
    const roiCalls = roi.counts.captures + roi.counts.sizes + roi.counts.ocr + roiProbe.calls.samples;
    const byteReduction = 1 - roiBytes / fullBytes;

    // ── 质量守护：噪声判决（全屏变而 ROI 不动 ⇒ no_effect+noise） ──
    const noiseSamples = [S(H0, H0, 90), S(B(10), H0, 91), S(B(12), H0, 92)];
    const noiseProbe = makeProbe(noiseSamples, []);
    const noiseExec = makeExecute({ probe: noiseProbe.probe, w1: { clickRetryMax: 0 } });
    const noiseOut = await noiseExec.execute(clickAction());

    console.log([
      `── W5-6/A2 ROI 三证 vs 全屏 dhash（M=${M} 次点击，帧当量 ${FRAME_BYTES} B）──`,
      `全屏臂: 截屏=${full.counts.captures} JS全帧哈希=${full.counts.dhashes} 尺寸=${full.counts.sizes} OCR=${full.counts.ocr} ⇒ 字节 ${fullBytes} B / 调用 ${fullCalls} 次`,
      `ROI臂:  截屏=${roi.counts.captures}（判据抽查@3 + OCR补位@5,6） JS全帧哈希=${roi.counts.dhashes} meta采样=${roiProbe.calls.samples} ⇒ 字节 ${roiBytes} B / 调用 ${roiCalls} 次`,
      `字节当量缩减 = 1 − ${roi.counts.captures}/${full.counts.captures} = ${(byteReduction * 100).toFixed(1)}%；调用次数比 = ${(roiCalls / fullCalls).toFixed(2)}（容差 ≤1.5）`,
      `噪声判决: 全屏变+ROI不动 ⇒ outcome=${noiseOut.outcome} noise=${noiseOut.verification?.noise}（全屏 dhash 方案在此用例误判 progress —— 质量所得）`,
    ].join('\n'));

    // ── 断言（开销不劣化 + 质量在岗） ──
    assert.ok(roiBytes < fullBytes, `图像字节当量必须严格下降（${roiBytes} vs ${fullBytes}）`);
    assert.equal(roi.counts.captures, 3, 'ROI 臂截屏恰 3（抽查 1 + OCR 补位 2）');
    assert.equal(full.counts.captures, M, '全屏臂每动作 1 截屏');
    assert.equal(roi.counts.dhashes, 0, 'ROI 臂零 JS 侧全帧哈希（指纹随 meta 采样走）');
    assert.ok(full.counts.dhashes >= M, '全屏臂每动作 1 全帧哈希');
    assert.ok(roiCalls <= fullCalls * 1.5, `调用次数不劣化超容差（${roiCalls} vs ${fullCalls}×1.5）`);
    assert.equal(roiProbe.calls.samples, 3 * M, 'meta 采样每动作恰 3（before + 门内两帧）');
    // 两臂验证语义等价：全部 progress（该判变的都判变）
    for (const out of roiOutcomes) {
      assert.equal(out.outcome, 'progress');
    }
    // 质量守护：噪声判决在岗（开销买到的能力）
    assert.equal(noiseOut.outcome, 'no_effect', '噪声不算进展');
    assert.equal(noiseOut.verification?.noise, true, 'noise 标志如实记账');
    assert.equal(noiseOut.verification?.roiChanged, false, 'ROI 指纹判不动');
    // 第三证在岗：OCR 补位路径的判决字段
    assert.equal(roiOutcomes[4]!.verification?.roiOcrChanged, true, '点击 5 走第三证判变');
    assert.equal(roiOutcomes[0]!.verification?.roiChanged, true, '点击 1 走第一证判变');
  } finally {
    restore();
  }
});
