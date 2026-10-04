// test/actionVerifier.stable.test.ts
// W6R-B6 补强：actionVerifier.stable 分区（W6-2 提取）的单测 —— CombinedEffect 结果
// 类型 + waitForStableHash / waitForStableFrame 自适应稳定帧轮询。
// 注入端口（全离线确定性）：
//   · 帧源：backend._setAdapterForTests 假 adapter（w4audio/w5cross 同律 —— 零 spawn
//     零网络）；hash 路径走 metaOnly 早退（不取图字节），frame 路径走 base64 往返
//     （system.captureScreen → captureCleanPng → readShm base64 分支）；
//   · 时间：pollMs=1 + 收敛式脚本 —— 每个用例的返回值与捕获次数由脚本内容唯一
//     决定（轮询预算 maxWaitMs=5000 留足裕量，真实耗时 < 10ms）；maxWaitMs=0 用例
//     把「预算耗尽 ⇒ 返回初始帧」做成纯确定性分支（零轮询）；
//   · 判距：kernelRegistry.register('verify.stableGap') 接线用例 + reset 隔离
//     （未注册 ⇒ getOrDefault 回声字面量 1 —— Ξ-D 生产接线契约）。
// 覆盖：
//   ① hash 路径：首轮即稳 / 扰动后收敛（hash 与 frameId 同帧配对）/ 零预算返回
//      初始帧配对 / 空指纹（dhash:null → ''）永不判稳 / 缺省 gap=1 的距离语义
//     （距离 2 拒稳）/ 注册 gap=6 生效 / frameId=null 透传 / 请求面 metaOnly+
//      wantHashes 恒真（meta-only 轮询契约）；
//   ② frame 路径（真 sharp 合成梯度图）：同帧即稳（返回字节等同 + hash=dhash）/
//      扰动后收敛 / 零预算返回初始帧 / 注册 gap=64 使互补指纹首轮判稳 —— 证明
//      判距读注册表在 buffer 路径同样生效；夹具自检（dhash(up)=全 1、dhash(down)=
//      全 0）防 sharp 行为漂移导致假绿；sharp 不可用 ⇒ 诚实 skip。
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import * as backend from '../src/physicalBackend.ts';
import { kernelRegistry } from '../src/kernel/registry.ts';
import { dhash, normalizeHash } from '../src/perceptualHash.ts';
import {
  waitForStableHash,
  waitForStableFrame,
  type CombinedEffect,
} from '../src/actionVerifier.stable.ts';

// ─── 假 adapter 工坊（w4audio 同律：META 形状，metaOnly 早退不取图字节）───

interface Shot { d: string | null; f: number | null }

/** 脚本化帧源：第 i 次捕获返回 script[i]（越界取末项 —— 收敛式脚本）；
 *  顺带记录每次 takeScreenshot 的请求面供轮询契约断言 */
function scriptedHashAdapter(script: Shot[]): { calls: Array<{ metaOnly?: boolean; wantHashes?: boolean }> } {
  const calls: Array<{ metaOnly?: boolean; wantHashes?: boolean }> = [];
  let i = 0;
  backend._setAdapterForTests({
    async takeScreenshot(opts: { metaOnly?: boolean; wantHashes?: boolean }) {
      calls.push(opts);
      const s = script[Math.min(i++, script.length - 1)]!;
      return {
        ok: true as const,
        value: {
          transport: 'none' as const, name: '', size: 0,
          shape: [1, 1, 3] as [number, number, number], dtype: 'uint8', stride: 3,
          format: 'META', width: 1, height: 1, captured_at: 1,
          image_base64: '', dhash: s.d, region_dhash: null, unchanged: true,
          frame_id: s.f, frame_count: 0,
        },
      };
    },
  } as never);
  return { calls };
}

const HEX_A = 'abcd1234abcd1234';
const HEX_B = '0123456789abcdef';
const BITS_A = '01'.repeat(32);
/** 与 BITS_A 汉明距离恰 2（翻转末两位 '01'→'10'） */
const BITS_D2 = BITS_A.slice(0, 62) + '10';

before(() => { backend._setAdapterForTests(null); });
after(() => { backend._setAdapterForTests(null); });
afterEach(() => { kernelRegistry.reset(); }); // 判距接线用例的注册不泄漏进邻居

// ═══ ① hash 路径（服务端指纹轮询）═══

test('W6R-st①a: 首轮即稳 —— 2 次捕获即返；请求面 metaOnly+wantHashes 恒真（meta-only 轮询契约）', async () => {
  const { calls } = scriptedHashAdapter([{ d: HEX_A, f: 7 }, { d: HEX_A, f: 8 }]);
  const r = await waitForStableHash(1, 5000);
  assert.deepEqual(r, { hash: normalizeHash(HEX_A), frameId: 8 }, '返回稳定帧（第 2 次捕获）的指纹与帧环 id');
  assert.equal(calls.length, 2, '初始捕获 + 1 次轮询（内容驱动的确定性计数）');
  for (const c of calls) {
    assert.equal(c.metaOnly, true, '稳定轮询不编码不传图');
    assert.equal(c.wantHashes, true, '轮询请求指纹');
  }
});

test('W6R-st①b: 扰动后收敛 —— 3 次捕获返回稳定帧，hash 与 frameId 同帧配对', async () => {
  const { calls } = scriptedHashAdapter([{ d: HEX_A, f: 1 }, { d: HEX_B, f: 2 }, { d: HEX_B, f: 3 }]);
  const r = await waitForStableHash(1, 5000);
  assert.deepEqual(r, { hash: normalizeHash(HEX_B), frameId: 3 },
    '第 2 次捕获与初帧不同 ⇒ 继续轮询；第 3 次与第 2 次同帧 ⇒ 收敛，frameId 取第 3 帧（配对不错位）');
  assert.equal(calls.length, 3);
});

test('W6R-st①c: 零预算（maxWaitMs=0）—— 单次捕获即返初始帧的 (hash, frameId) 配对', async () => {
  const { calls } = scriptedHashAdapter([{ d: HEX_A, f: 42 }]);
  const r = await waitForStableHash(1, 0);
  assert.deepEqual(r, { hash: normalizeHash(HEX_A), frameId: 42 },
    '预算耗尽 ⇒ 返回已见帧 —— 指纹与帧环 id 必须同帧（超时路径的配对纪律）');
  assert.equal(calls.length, 1, '不进轮询循环');
});

test('W6R-st①d: 空指纹（dhash:null → hash=""）永不判稳 —— 恢复真指纹后才收敛', async () => {
  // 捕获序列 A → null → A → A：null 帧 hash='' 使稳定判据短路（falsy）；
  // 随后 A 与 '' 汉明距 64 仍不稳，直到连续两个真 A 才收敛
  const { calls } = scriptedHashAdapter([
    { d: HEX_A, f: 1 }, { d: null, f: 2 }, { d: HEX_A, f: 3 }, { d: HEX_A, f: 4 },
  ]);
  const r = await waitForStableHash(1, 5000);
  assert.deepEqual(r, { hash: normalizeHash(HEX_A), frameId: 4 });
  assert.equal(calls.length, 4, '空指纹帧本身不能当稳定帧（hash 真值性检查）');
});

test('W6R-st①e: 缺省 stableGap=1 —— 汉明距离 2 拒稳（3 次捕获），同帧距离 0 受（①a 已证）', async () => {
  assert.equal(kernelRegistry.has('verify.stableGap'), false, '未注册 ⇒ getOrDefault 回声字面量');
  const { calls } = scriptedHashAdapter([{ d: BITS_A, f: 1 }, { d: BITS_D2, f: 2 }, { d: BITS_D2, f: 3 }]);
  const r = await waitForStableHash(1, 5000);
  assert.equal(r.hash, BITS_D2, '位串域指纹原样透传（normalizeHash 宽容归一）');
  assert.equal(r.frameId, 3);
  assert.equal(calls.length, 3, '距离 2 > gap 1 ⇒ 首次比较被拒；若误受则 2 次即返 —— 计数即判据');
});

test('W6R-st①f: 注册表接线 —— 注册 verify.stableGap=6 后距离 2 首轮即稳', async () => {
  kernelRegistry.register({ key: 'verify.stableGap', organ: 'verify', defaultValue: 6, min: 0, max: 6 });
  const { calls } = scriptedHashAdapter([{ d: BITS_A, f: 1 }, { d: BITS_D2, f: 2 }]);
  const r = await waitForStableHash(1, 5000);
  assert.deepEqual(r, { hash: BITS_D2, frameId: 2 });
  assert.equal(calls.length, 2, '汉明距 2 ≤ 注册判距 6 ⇒ 首轮即稳（Ξ-D 读点真消费注册表）');
});

test('W6R-st①g: frameId=null 透传 —— 服务端无帧环时稳定帧 id 诚实为 null', async () => {
  scriptedHashAdapter([{ d: HEX_A, f: null }, { d: HEX_A, f: null }]);
  const r = await waitForStableHash(1, 5000);
  assert.deepEqual(r, { hash: normalizeHash(HEX_A), frameId: null });
});

// ═══ ② frame 路径（buffer 轮询 —— 真 sharp 合成梯度图 + base64 往返）═══

/** 9×8 灰度水平梯度图：升梯度 ⇒ 每行右>左 ⇒ dhash 全 1；降梯度 ⇒ 全 0（距离 64） */
async function gradientPng(sharpMod: NonNullable<Awaited<ReturnType<typeof loadSharp>>>, rising: boolean): Promise<Buffer> {
  const W = 9, H = 8;
  const raw = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) raw[y * W + x] = rising ? x * 28 : 224 - x * 28;
  }
  return sharpMod(raw, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
}

async function loadSharp() {
  const { getSharp } = await import('../src/_legacyDeps.ts');
  return getSharp();
}

/** 脚本化 base64 帧源（captureCleanPng → readShm base64 分支 —— 零文件零网络） */
function scriptedFrameAdapter(bufs: Buffer[]): { calls: number } {
  const state = { calls: 0 };
  let i = 0;
  backend._setAdapterForTests({
    async takeScreenshot() {
      state.calls++;
      const buf = bufs[Math.min(i++, bufs.length - 1)]!;
      return {
        ok: true as const,
        value: {
          transport: 'base64' as const, name: '', size: buf.length,
          shape: [8, 9, 3] as [number, number, number], dtype: 'uint8', stride: 27,
          format: 'PNG', width: 9, height: 8, captured_at: 1,
          image_base64: buf.toString('base64'), dhash: null, region_dhash: null,
          unchanged: false, frame_id: null, frame_count: 0,
        },
      };
    },
  } as never);
  return state;
}

test('W6R-st②: frame 路径 —— 同帧即稳 / 扰动收敛 / 零预算 / 注册判距（真 sharp 合成图）', async (t) => {
  let sharpMod: Awaited<ReturnType<typeof loadSharp>>;
  try {
    sharpMod = await loadSharp();
  } catch (e) {
    return t.skip(`sharp 不可用（${(e as Error).message}）—— buffer 路径需要本地 dhash，诚实跳过`);
  }
  const up = await gradientPng(sharpMod, true);
  const down = await gradientPng(sharpMod, false);
  // 夹具自检：防 sharp 行为漂移导致假绿（dhash 契约：升梯度全 1 / 降梯度全 0）
  assert.equal(await dhash(up), '1'.repeat(64), '夹具自检：升梯度指纹全 1');
  assert.equal(await dhash(down), '0'.repeat(64), '夹具自检：降梯度指纹全 0');

  // (a) 同帧即稳：2 次捕获，返回字节等同 + hash === dhash(该帧)
  let st = scriptedFrameAdapter([up, up]);
  let r = await waitForStableFrame(1, 5000);
  assert.equal(st.calls, 2);
  assert.ok(r.buffer.equals(up), '返回稳定帧原始字节（物理规则下游消费面）');
  assert.equal(r.hash, '1'.repeat(64), 'hash 为本地 dhash 产物');

  // (b) 扰动后收敛：up → down → down ⇒ 返回 down，3 次捕获
  st = scriptedFrameAdapter([up, down, down]);
  r = await waitForStableFrame(1, 5000);
  assert.equal(st.calls, 3, '互补指纹（距离 64）首比被拒');
  assert.ok(r.buffer.equals(down));
  assert.equal(r.hash, '0'.repeat(64));

  // (c) 零预算：单次捕获返回初始帧
  st = scriptedFrameAdapter([up]);
  r = await waitForStableFrame(1, 0);
  assert.equal(st.calls, 1);
  assert.ok(r.buffer.equals(up), '预算耗尽 ⇒ 初始帧字节');
  assert.equal(r.hash, '1'.repeat(64));

  // (d) 注册判距在 buffer 路径同样生效：gap=64 ⇒ 互补指纹（距离 64）首轮即稳
  kernelRegistry.register({ key: 'verify.stableGap', organ: 'verify', defaultValue: 64, min: 0, max: 64 });
  st = scriptedFrameAdapter([up, down]);
  r = await waitForStableFrame(1, 5000);
  assert.equal(st.calls, 2, '距离 64 ≤ 注册判距 64 ⇒ 首轮即稳 —— 判距读注册表与 hash 路径同源');
  assert.ok(r.buffer.equals(down));
});

// ═══ ③ 类型面：CombinedEffect 结果契约（编译期类型 + 运行期字段存在性锚）═══

test('W6R-st③: CombinedEffect 契约锚 —— 判决主字段与旁路车道键的类型面编译通过', () => {
  const probe: CombinedEffect = {
    detected: false,
    screen: { effect_detected: false, similarity_pct: 100, distance: 0 },
    region: null,
    scale: 'none',
    afterBuffer: Buffer.alloc(0),
    afterHash: '0'.repeat(64),
    oscillation: null,
  };
  assert.equal(probe.detected, false);
  assert.equal(probe.screen.similarity_pct, 100);
  assert.equal(probe.region, null, '无焦点/禁用时区域报告缺席');
  assert.ok(Buffer.isBuffer(probe.afterBuffer), 'D-5 路径可能为空 buffer，但恒为 Buffer 类型');
});
