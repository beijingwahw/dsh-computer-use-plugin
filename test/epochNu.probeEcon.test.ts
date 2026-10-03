// test/epochNu.probeEcon.test.ts
// 纪元 Ν（探索经济学）：通道经济学账 + bitsPerMs 择序 + 停止法则 + 判决零回归。
//
// 实验设计理论（主动学习/信息增益）第一次进入 GUI agent 的探针层：通道不再是
// 固定降序，而是按学习到的「比特/成本」后验花钱；熵减足额即停，不探满三通道。
// 全离线确定性：假物理世界经 _setAdapterForTests 注入（零 spawn、零真实鼠标、
// 零真实 UIA）——判决矩阵（fuseVerdict/uiaVerdict）已在 Z 纪元测试锁死，本纪元
// 只锁「顺序与何时停」的经济学，及判决语义的零回归。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  probePoints, economyChannelOrder, economyShouldStop, verdictBits,
  PROBE_ECON_STOP_BITS, PROBE_ECON_MIN_SAMPLES,
} from '../src/interactivityProbe.ts';
import { probeMemory, type ProbeChannel, type ChannelEcon } from '../src/probeMemory.ts';
import * as backend from '../src/physicalBackend.ts';
import type { Config } from '../src/config.ts';
import type { ProbeResult } from '../src/interactivityProbe.ts';

// ─── 测试配置面：记忆关闭（短路/入册与账本解耦 ⇒ 通道序测试确定性）───
function cfg(over: Record<string, unknown> = {}): Config {
  return {
    enableProbeMemory: false,
    enableProbeEconomy: true,
    dryRun: false,
    probeDwellMs: 150,          // ⇒ 1 步重绘轮询（ceil(150/150)=1）
    probeRegionRadius: 0.06,
    probeRepaintThreshold: 0.985,
    ...over,
  } as unknown as Config;
}

// 带记忆面的配置（召回短路测试用）
function cfgMem(over: Record<string, unknown> = {}): Config {
  return cfg({
    enableProbeMemory: true,
    probeMemoryTtlMs: 300_000,
    probeMemoryCapacity: 128,
    probeMemorySceneSimilarity: 0.9,
    probeRecallRadius: 0.015,
    ...over,
  });
}

// ─── 假物理世界：调用序列 + 可编程通道响应 ───
interface WorldOpts {
  hit?: { classification: string; control_type?: string | null; name?: string };
  cursorKind?: string;
  /** 区域指纹应答队列（pre-hash、轮询 after 依次出队；空 ⇒ 基线原样 ⇒ 无重绘） */
  regionDhashes?: string[];
  /** 整屏指纹（enableProbeMemory 时的场景锚） */
  sceneDhash?: string;
}

const BASELINE = '0000000000000000';   // 16-hex 区域基线
const REPAINTED = 'ffffffffffffffff';  // 全位翻转 ⇒ 相似度 0 ⇒ 重绘检出

function makeWorld(opts: WorldOpts) {
  const calls: string[] = [];
  const regionQueue = [...(opts.regionDhashes ?? [])];
  const world = {
    calls,
    adapter: {
      async takeScreenshot() {
        world.calls.push('take_screenshot');
        return {
          ok: true as const,
          value: {
            transport: 'none' as const, name: '', size: 0,
            shape: [1, 1, 3] as [number, number, number], dtype: 'uint8', stride: 3,
            format: 'META', width: 1, height: 1, captured_at: Date.now() / 1000,
            image_base64: '',
            dhash: opts.sceneDhash ?? '0123456789abcdef',
            region_dhash: regionQueue.length > 0 ? regionQueue.shift()! : BASELINE,
            unchanged: true, frame_id: null, frame_count: 0,
          },
        };
      },
      async hitTest() {
        world.calls.push('hit_test');
        if (!opts.hit) {
          return { ok: true as const, value: { available: false, classification: 'unavailable' } };
        }
        return {
          ok: true as const,
          value: {
            available: true,
            classification: opts.hit.classification,
            control_type: opts.hit.control_type ?? null,
            name: opts.hit.name ?? '',
            matched_depth: null,
          },
        };
      },
      async moveMouse(args: { x: number; y: number }) {
        world.calls.push('move_mouse');
        return { ok: true as const, value: { x: args.x, y: args.y } };
      },
      async getCursorKind() {
        world.calls.push('cursor_kind');
        return { ok: true as const, value: { kind: opts.cursorKind ?? 'arrow' } };
      },
      async getCursor() {
        world.calls.push('get_cursor');
        return { ok: true as const, value: { x: 960, y: 540 } };
      },
      async health() {
        world.calls.push('health');
        return {
          ok: true as const,
          value: {
            status: 'ok' as const, version: 't', platform: 'win32' as const, python: '',
            screen: { width: 1920, height: 1080 }, capabilities: [],
            switch_window_method: 'native' as const,
            ui_funnel: { l1_tree: 'available' as const, l2_ocr: 'available' as const, l3_vlm: '', l3_arbitration_enabled: false },
            screenshot_transport: 'base64' as const,
            auth: { pid_attestation: false, capability_token: false },
          },
        };
      },
    },
  };
  return world;
}

/** 账本注入：前 flips 次改写（inconclusive→control）、其余弃权 —— 只看聚合数 */
function prime(ch: ProbeChannel, trials: number, flips: number, totalMs: number) {
  assert.ok(totalMs % trials === 0, '确定性：均摊毫秒须整除');
  const ms = totalMs / trials;
  for (let i = 0; i < trials; i++) {
    probeMemory.noteChannel(ch, ms, 'inconclusive', i < flips ? 'control' : null);
  }
}

/** 网页世界账本：光标通道高翻转/低耗时，UIA 低翻转/高耗时，重绘最贵 */
function primeWebLedger() {
  prime('cursor', 20, 18, 600);   // bitsPerMs = 0.9/30  = 0.03
  prime('repaint', 10, 8, 3000);  // bitsPerMs = 0.8/300 ≈ 0.00267
  prime('uia', 20, 2, 1000);      // bitsPerMs = 0.1/50  = 0.002
}

function econByChannel(list: ChannelEcon[]): Record<ProbeChannel, ChannelEcon> {
  return Object.fromEntries(list.map(e => [e.channel, e])) as Record<ProbeChannel, ChannelEcon>;
}

beforeEach(() => { probeMemory.reset(); });
afterEach(() => { backend._setAdapterForTests(null); });

// ═══ Ν-1 账本数学：bitsPerMs 排序 + flips 语义 ═══

test('Ν-1a: 账本聚合数学 —— bitsEstimate=r、bitsPerMs=bitsEstimate/meanMs、排序正确', () => {
  prime('uia', 20, 18, 1000);     // r=0.9, meanMs=50,  bitsPerMs=0.018
  prime('cursor', 20, 18, 600);   // r=0.9, meanMs=30,  bitsPerMs=0.03
  prime('repaint', 10, 8, 3000);  // r=0.8, meanMs=300, bitsPerMs=0.8/300

  const e = econByChannel(probeMemory.channelEconomics());
  assert.equal(e.uia.trials, 20);
  assert.equal(e.uia.flips, 18);
  assert.equal(e.uia.totalMs, 1000);
  assert.ok(Math.abs(e.uia.bitsEstimate - 0.9) < 1e-12);
  assert.ok(Math.abs(e.uia.meanMs - 50) < 1e-12);
  assert.ok(Math.abs(e.uia.bitsPerMs - 0.018) < 1e-12);
  assert.ok(Math.abs(e.cursor.bitsPerMs - 0.03) < 1e-12);
  assert.ok(Math.abs(e.repaint.bitsPerMs - 0.8 / 300) < 1e-12);

  // 同成本下判别率高者先；同判别率下快者先：cursor(0.03) > uia(0.018) > repaint(0.0027)
  assert.deepEqual(economyChannelOrder(probeMemory.channelEconomics()), ['cursor', 'uia', 'repaint']);
});

test('Ν-1b: flips 语义 —— 后通道改写前判决才计（弃权与维持原判不计）', () => {
  // 首判改写：standing 默认 inconclusive → control（改写前判决）
  probeMemory.noteChannel('cursor', 10, 'inconclusive', 'control');
  assert.equal(econByChannel(probeMemory.channelEconomics()).cursor.flips, 1);
  // 维持原判：control → control（同标签确认，不是改写）
  probeMemory.noteChannel('cursor', 10, 'control', 'control');
  assert.equal(econByChannel(probeMemory.channelEconomics()).cursor.flips, 1);
  // 弃权：text → null（通道缺席/无判决力证据，不是证据）
  probeMemory.noteChannel('cursor', 10, 'text', null);
  assert.equal(econByChannel(probeMemory.channelEconomics()).cursor.flips, 1);
  // 改写：control → text（后通道推翻前判决 —— 最有价值的翻转）
  probeMemory.noteChannel('repaint', 10, 'control', 'text');
  assert.equal(econByChannel(probeMemory.channelEconomics()).repaint.flips, 1);
  // 执行数含弃权/失败（成本真实发生了）
  assert.equal(econByChannel(probeMemory.channelEconomics()).cursor.trials, 3);
});

// ═══ Ν-2 顺序自适应：bitsPerMs 后验择序 + 关开关固定序逐字节 ═══

test('Ν-2a: 光标通道历史高翻转、UIA 低 ⇒ 新探针光标先于 UIA', async () => {
  primeWebLedger();
  // arrow 光标 + 无重绘 + UIA unknown：三通道全跑 ⇒ 调用序列可证执行序
  const w = makeWorld({ hit: { classification: 'unknown' }, cursorKind: 'arrow' });
  backend._setAdapterForTests(w.adapter as never);

  const [r] = await probePoints(cfg(), [{ x: 0.5, y: 0.5 }]);
  assert.ok(r.economics);
  assert.deepEqual(r.economics.channel_order, ['cursor', 'repaint', 'uia']);
  assert.ok(r.economics.bits_per_ms.cursor > r.economics.bits_per_ms.uia);
  // 悬停先动（cursor_kind 在前），UIA 后问（hit_test 在后）
  assert.ok(w.calls.includes('cursor_kind') && w.calls.includes('hit_test'), '三通道须全跑（熵不足）');
  assert.ok(w.calls.indexOf('cursor_kind') < w.calls.indexOf('hit_test'), '光标通道先于 UIA');
  assert.equal(r.economics.stopped_early, false);
});

test('Ν-2b: 关开关 ⇒ 固定三通道降序逐字节旧行为（且不记账）', async () => {
  // 同一假世界：UIA 可判 ⇒ 旧行为是 UIA 判决、鼠标根本不动、无 economics 注记
  const w = makeWorld({
    hit: { classification: 'control', control_type: 'Button', name: '登录' },
    cursorKind: 'hand',
  });
  backend._setAdapterForTests(w.adapter as never);

  const [r] = await probePoints(cfg({ enableProbeEconomy: false }), [{ x: 0.5, y: 0.5 }]);
  // 逐字节：Z 纪元原形状（无 economics 字段）
  assert.deepStrictEqual(r, {
    point: { x: 0.5, y: 0.5 },
    verdict: 'control',
    confidence: 0.97,
    evidence: {
      via: 'uia', cursor_kind: 'n/a', hover_repaint: false, repaint_similarity: null, dwell_ms: 0,
      hit_test: { control_type: 'Button', name: '登录', classification: 'control', matched_depth: null },
    },
  });
  assert.ok(w.calls.includes('hit_test'));
  assert.ok(!w.calls.includes('cursor_kind'), 'UIA 已判 ⇒ 旧行为不做悬停实验（无光标本体感觉）；原位复位照旧');
  // 旧行为不产生账目（通道序测试不受历史探针污染）
  assert.ok(probeMemory.channelEconomics().every(e => e.trials === 0));
});

// ═══ Ν-3 停止法则：熵减足额即停 ═══

test('Ν-3a: 熵减近似数学 —— 决定性判决 1−H₂(c)，弃权不减熵', () => {
  assert.equal(PROBE_ECON_STOP_BITS, 0.5);
  // 最弱决定性判决（ibeam 0.92）的熵减 = 1−H₂(0.92) ≈ 0.598 > 阈值 ⇒ 必触发停止
  assert.ok(Math.abs(verdictBits('text', 0.92) - 0.59782) < 1e-4);
  assert.ok(Math.abs(verdictBits('control', 0.97) - 0.80560) < 1e-4);
  assert.ok(Math.abs(verdictBits('control', 0.95) - 0.71360) < 1e-4);
  // 重绘单证（0.85）的熵减 ≈ 0.390 < 阈值 ⇒ 单凭重绘不触发停止（还可能被更高
  // 优先级通道改写，判决语义不许停）
  assert.ok(Math.abs(verdictBits('control', 0.85) - 0.39016) < 1e-4);
  assert.ok(verdictBits('control', 0.85) < PROBE_ECON_STOP_BITS);
  // 非决定性是诚实弃权：弃权不减熵
  assert.equal(verdictBits('inconclusive', 0.3), 0);
});

test('Ν-3b: 停止法则判决矩阵（纯函数）', () => {
  const web = probeMemory.channelEconomics(); // 空账本（先验分参与律 B 判定）
  // 无判决 ⇒ 永不停止（还可能给出判决的通道绝不砍）
  assert.equal(economyShouldStop(null, ['uia', 'cursor', 'repaint'], web), false);
  assert.equal(
    economyShouldStop({ verdict: 'inconclusive', confidence: 0.3, channel: 'uia' }, ['cursor'], web),
    false,
  );
  // 律 A：ibeam 判决（0.598 bits ≥ 0.5）⇒ 砍掉余下所有通道（含更高优先级的 UIA——
  // 提前停已足熵的合法面：ibeam 与 UIA-control 在物理上互斥）
  assert.equal(
    economyShouldStop({ verdict: 'text', confidence: 0.92, channel: 'cursor' }, ['repaint', 'uia'], web),
    true,
  );
  // 律 A 不过时（重绘单证 0.85 ⇒ 0.390 bits）：有改写权的 UIA（先验秩更高）不砍
  assert.equal(
    economyShouldStop({ verdict: 'control', confidence: 0.85, channel: 'repaint' }, ['uia'], web),
    false,
  );
  // 同理光标（秩 2）对重绘判决（秩 3）有改写权 ⇒ 不砍
  assert.equal(
    economyShouldStop({ verdict: 'control', confidence: 0.85, channel: 'repaint' }, ['cursor'], web),
    false,
  );
  // 无剩余通道 ⇒ 谈不上停止
  assert.equal(
    economyShouldStop({ verdict: 'control', confidence: 0.97, channel: 'uia' }, [], web),
    false,
  );
});

test('Ν-3c: 第一通道判决熵减已足 ⇒ 不再执行剩余通道（执行计数断言 + stopped_early 注记）', async () => {
  primeWebLedger(); // 序 [cursor, repaint, uia]：光标第一
  const w = makeWorld({ hit: { classification: 'control' }, cursorKind: 'ibeam' });
  backend._setAdapterForTests(w.adapter as never);

  const [r] = await probePoints(cfg(), [{ x: 0.5, y: 0.5 }]);
  // ibeam ⇒ text 0.92 ⇒ 0.598 bits ≥ 0.5 ⇒ 停：UIA 从未询问、重绘从未轮询
  assert.ok(!w.calls.includes('hit_test'), '停止法则须砍掉未执行的 UIA 通道');
  assert.equal(w.calls.filter(c => c === 'take_screenshot').length, 1, '重绘未轮询（仅悬停前基线指纹一次）');
  assert.equal(w.calls.filter(c => c === 'cursor_kind').length, 1);
  assert.equal(r.verdict, 'text');
  assert.equal(r.confidence, 0.92);
  assert.equal(r.evidence.via, 'hover');
  assert.ok(r.economics);
  assert.equal(r.economics.stopped_early, true);
  assert.ok(r.economics.spent_ms > 0, '判决带已花成本注记');
  assert.ok(r.economics.spent_ms >= 60, '光标通道成本含 60ms 沉降');
});

test('Ν-3d: 熵不足 ⇒ 全通道执行（弃权链永不触发停止）', async () => {
  primeWebLedger();
  // arrow + 无重绘 + UIA unknown：三通道全弃权 ⇒ 谁也不能砍
  const w = makeWorld({ hit: { classification: 'unknown' }, cursorKind: 'arrow' });
  backend._setAdapterForTests(w.adapter as never);

  const [r] = await probePoints(cfg(), [{ x: 0.5, y: 0.5 }]);
  assert.equal(w.calls.filter(c => c === 'cursor_kind').length, 1, '光标通道执行');
  assert.equal(w.calls.filter(c => c === 'hit_test').length, 1, 'UIA 通道执行');
  assert.ok(w.calls.filter(c => c === 'take_screenshot').length >= 2, '重绘通道执行（悬停前基线 + 轮询）');
  assert.equal(r.economics?.stopped_early, false);
  assert.equal(r.verdict, 'inconclusive');
  assert.equal(r.evidence.repaint_similarity, 1.0); // 无重绘
});

// ═══ Ν-4 冷启动：账本空 ⇒ 先验序不动 ═══

test('Ν-4a: 账本空 ⇒ 先验序（判别力降序）逐字节不动', () => {
  assert.deepEqual(economyChannelOrder(probeMemory.channelEconomics()), ['uia', 'cursor', 'repaint']);
  // 积分：bits_per_ms 全零（无后验）
  assert.ok(probeMemory.channelEconomics().every(e => e.bitsPerMs === 0 && e.trials === 0));
});

test('Ν-4b: 部分采样不乱序 —— 样本 <5 的通道保先验分（噪声分不晋级）', () => {
  // 光标仅 4 次执行、表观 bitsPerMs=1.0（4 flips / 4ms）—— 样本不足 ⇒ 信先验
  // （0.0075 < UIA 先验 0.02）⇒ 不得跳到 UIA 之前
  prime('cursor', 4, 4, 4);
  assert.equal(PROBE_ECON_MIN_SAMPLES, 5);
  assert.deepEqual(economyChannelOrder(probeMemory.channelEconomics()), ['uia', 'cursor', 'repaint']);
  // 光标采样足额（≥5）且真的更优 ⇒ 晋级；UIA/重绘仍保先验相对序
  prime('cursor', 6, 6, 6); // bitsPerMs = 1.0 ≥ 5 样本
  assert.deepEqual(economyChannelOrder(probeMemory.channelEconomics()), ['cursor', 'uia', 'repaint']);
});

test('Ν-4c: 冷启动集成 —— 探针先问 UIA（结构层），鼠标不动', async () => {
  const w = makeWorld({
    hit: { classification: 'control', control_type: 'Button', name: '登录' },
    cursorKind: 'hand',
  });
  backend._setAdapterForTests(w.adapter as never);

  const [r] = await probePoints(cfg(), [{ x: 0.5, y: 0.5 }]);
  assert.deepEqual(r.economics?.channel_order, ['uia', 'cursor', 'repaint']);
  assert.ok(w.calls.includes('hit_test'));
  assert.ok(!w.calls.includes('move_mouse'), '冷启动先验序 = 旧行为：UIA 已判不动鼠标');
});

// ═══ Ν-5 判决零回归：同输入开/关经济最终判决一致 ═══

/** 同一世界开/关经济各跑一次（账本清零起跑）⇒ 返回 [on, off] 判决对 */
async function runPair(opts: WorldOpts, cfgOver: Record<string, unknown> = {}): Promise<[ProbeResult, ProbeResult]> {
  probeMemory.reset();
  const wOn = makeWorld(opts);
  backend._setAdapterForTests(wOn.adapter as never);
  const on = (await probePoints(cfg(cfgOver), [{ x: 0.5, y: 0.5 }]))[0];

  probeMemory.reset();
  const wOff = makeWorld(opts);
  backend._setAdapterForTests(wOff.adapter as never);
  const off = (await probePoints(cfg({ ...cfgOver, enableProbeEconomy: false }), [{ x: 0.5, y: 0.5 }]))[0];
  return [on, off];
}

test('Ν-5a: 同输入开/关经济 —— 最终判决逐字一致（证据矩阵五格）', async () => {
  // (1) UIA control + 光标 hand（双通道同向）
  {
    const [on, off] = await runPair({ hit: { classification: 'control' }, cursorKind: 'hand' });
    assert.equal(on.verdict, off.verdict); assert.equal(on.verdict, 'control');
    assert.equal(on.confidence, off.confidence); // 冷启动序 = 先验序 ⇒ UIA 先判，逐字同
    assert.deepEqual(on.evidence, off.evidence);
  }
  // (2) UIA 弃权 + 光标 hand（悬停判决）
  {
    const [on, off] = await runPair({ hit: { classification: 'unknown' }, cursorKind: 'hand' });
    assert.equal(on.verdict, 'control'); assert.equal(on.confidence, 0.95);
    assert.equal(on.verdict, off.verdict); assert.equal(on.confidence, off.confidence);
    assert.deepEqual(on.evidence, off.evidence);
  }
  // (3) UIA 弃权 + arrow + 悬停重绘（重绘单证）
  {
    const [on, off] = await runPair({
      hit: { classification: 'unknown' }, cursorKind: 'arrow',
      regionDhashes: [BASELINE, REPAINTED],
    });
    assert.equal(on.verdict, 'control'); assert.equal(on.confidence, 0.85);
    assert.equal(on.verdict, off.verdict); assert.equal(on.confidence, off.confidence);
    assert.equal(on.evidence.hover_repaint, true);
    assert.deepEqual(on.evidence, off.evidence);
  }
  // (4) 全弃权（arrow 无重绘 + UIA unknown）⇒ 同为诚实弃权
  {
    const [on, off] = await runPair({ hit: { classification: 'unknown' }, cursorKind: 'arrow' });
    assert.equal(on.verdict, 'inconclusive'); assert.equal(on.verdict, off.verdict);
    assert.deepEqual(on.evidence, off.evidence);
  }
  // (5) UIA text（静态正文——本探针对症失败模式的核心判决）
  {
    const [on, off] = await runPair({
      hit: { classification: 'text', control_type: 'Text', name: '点击登录按钮即可进入' },
      cursorKind: 'ibeam',
    });
    assert.equal(on.verdict, 'text'); assert.equal(on.confidence, 0.93);
    assert.equal(on.verdict, off.verdict); assert.equal(on.confidence, off.confidence);
    assert.deepEqual(on.evidence, off.evidence);
  }
});

test('Ν-5b: 顺序自适应改变执行序，判决标签不变（提前停已足熵的合法面）', async () => {
  // 网页世界账本 ⇒ 光标先于 UIA。hand 判 control 0.95 后停止（0.714 bits ≥ 0.5），
  // UIA（本会判 control 0.97）不再询问：置信/通道可不同（提前停的合法代价），
  // 但判决标签（control）与开关经济完全一致——两通道同向时改序不改判。
  primeWebLedger();
  const w = makeWorld({ hit: { classification: 'control' }, cursorKind: 'hand' });
  backend._setAdapterForTests(w.adapter as never);
  const on = (await probePoints(cfg(), [{ x: 0.5, y: 0.5 }]))[0];

  probeMemory.reset();
  const wOff = makeWorld({ hit: { classification: 'control' }, cursorKind: 'hand' });
  backend._setAdapterForTests(wOff.adapter as never);
  const off = (await probePoints(cfg({ enableProbeEconomy: false }), [{ x: 0.5, y: 0.5 }]))[0];

  assert.equal(on.verdict, 'control');
  assert.equal(on.verdict, off.verdict, '顺序变判决标签不变');
  assert.equal(on.evidence.via, 'hover');           // 提前停 ⇒ 光标通道判决
  assert.equal(off.evidence.via, 'uia');
  assert.ok(on.confidence < off.confidence);        // 0.95 < 0.97（判别力天花板律仍立）
  assert.equal(on.economics?.stopped_early, true);
});

test('Ν-5c: 记忆召回优先零回归 —— 召回短路不记账、不带经济注记', async () => {
  // 预存同场景判决：点 (0.5,0.5) text（悬停 ibeam 判决）
  const FP = '0123456789abcdef';
  const stored: ProbeResult = {
    point: { x: 0.5, y: 0.5 },
    verdict: 'text', confidence: 0.92,
    evidence: { via: 'hover', cursor_kind: 'ibeam', hover_repaint: false, repaint_similarity: null, dwell_ms: 150 },
  };
  probeMemory.store(FP, stored, cfgMem() as never);
  const w = makeWorld({ sceneDhash: FP, hit: { classification: 'control' }, cursorKind: 'hand' });
  backend._setAdapterForTests(w.adapter as never);

  const [on] = await probePoints(cfgMem(), [{ x: 0.5, y: 0.5 }]);
  assert.equal(on.evidence.via, 'memory', '召回优先于一切实验（第 0 遍不变）');
  assert.equal(on.verdict, 'text');
  assert.equal(on.confidence, 0.89, '召回降级律原语义：0.92 − 0.03（未到 0.9 封顶）');
  assert.equal(on.economics, undefined, '召回短路的判决不带经济注记（原形状零回归）');
  assert.ok(!w.calls.includes('hit_test') && !w.calls.includes('move_mouse'), '零实验');
  // 被记忆召回短路的不记账
  assert.ok(probeMemory.channelEconomics().every(e => e.trials === 0));
});

test('Ν-5d: 永不抛 —— 坏账本 = 清零重来（回先验序），探针照常判决', async () => {
  probeMemory.noteChannel('uia', NaN, 'inconclusive', 'control');   // 坏值入账
  probeMemory.noteChannel('cursor', -50, 'inconclusive', 'control'); // 负耗时入账
  // 读面体检：坏账本整体清零 ⇒ 全零回先验
  assert.ok(probeMemory.channelEconomics().every(e => e.trials === 0 && e.bitsPerMs === 0));
  assert.deepEqual(economyChannelOrder(probeMemory.channelEconomics()), ['uia', 'cursor', 'repaint']);

  // 探针在坏账本上照常运行（先验序），判决不抛不漂
  const w = makeWorld({
    hit: { classification: 'text', control_type: 'Text', name: '正文' },
    cursorKind: 'ibeam',
  });
  backend._setAdapterForTests(w.adapter as never);
  const [r] = await probePoints(cfg(), [{ x: 0.5, y: 0.5 }]);
  assert.equal(r.verdict, 'text');
  assert.equal(r.confidence, 0.93);
  assert.deepEqual(r.economics?.channel_order, ['uia', 'cursor', 'repaint']);
});
