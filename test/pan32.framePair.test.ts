// test/pan32.framePair.test.ts
// ΠΑΝ-32（settleAndVerify 终帧同帧原子采用律）执法册 —— 批判 C1-1 M4：
//   D-5 路径先 waitForStableHash 得到稳定 (hash, frameId)，随后又一次
//   captureProcessed 作终帧。旧实现逐字段独立覆盖：
//     · 终帧带 dhash 无 frameId ⇒ afterScreen 被终帧顶替、afterFrameId 留在
//       稳定环 —— 「hash 来自终帧、frameId 来自稳定环」的跨帧错配对（下游
//       物理规则/语义锚按 frameId 取服务端帧统计，验的是另一帧）；
//     · 终帧带 frameId 无 dhash ⇒ 反向错配（hash 留稳定帧、frameId 跳终帧）；
//     · 终帧 dhash 无条件顶替还作废了稳定轮询的「已稳定」保证。
//   修法：终帧哈希只在 ① 携带同帧 frameId（原子元组）或 ② 本就无稳定配对
//   可错位（非自适应路径）时被采纳；配对纪律与 actionVerifier.stable.ts:90
//   的「frameId 与 hash 同帧配对」立法同源。
// 全离线确定性：假 adapter 经 _setAdapterForTests 注入（w4audio/w5cross 同律，
// unchanged 早退不取图字节）；轮询节奏经 kernelRegistry 注册 verify.pollMs=1。
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import * as backend from '../src/physicalBackend.ts';
import { kernelRegistry } from '../src/kernel/registry.ts';
import { normalizeHash } from '../src/perceptualHash.ts';
import { settleAndVerify, type BeforeState, type SettleOptions, type CombinedEffect } from '../src/actionVerifier.ts';

interface Shot { d: string | null; f: number | null }

/**
 * 双脚本帧源：metaOnly 请求走稳定轮询脚本（waitForStableHash），非 metaOnly
 * 请求走终帧脚本（settleAndVerify 的 finalCap）。unchanged=true 使
 * captureProcessed 早退（零图像字节往返 —— 离线确定性）。
 */
function pairingAdapter(stable: Shot[], fin: Shot[]): { stableCalls: number; finalCalls: number } {
  const count = { stableCalls: 0, finalCalls: 0 };
  let si = 0, fi = 0;
  backend._setAdapterForTests({
    async takeScreenshot(opts: { metaOnly?: boolean }) {
      const isStable = opts.metaOnly === true;
      const s = isStable ? stable[Math.min(si++, stable.length - 1)]! : fin[Math.min(fi++, fin.length - 1)]!;
      if (isStable) count.stableCalls++; else count.finalCalls++;
      return {
        ok: true as const,
        value: {
          transport: 'none' as const, name: '', size: 0,
          shape: [1, 1, 3] as [number, number, number], dtype: 'uint8', stride: 3,
          format: 'META', width: 1, height: 1, captured_at: 1,
          image_base64: '', dhash: s.d,
          region_dhash: null, unchanged: true, frame_id: s.f, frame_count: 0,
        },
      };
    },
  } as never);
  return count;
}

const H_STABLE = 'abcd1234abcd1234';   // 稳定轮询收敛帧指纹
const H_FINAL = '0123456789abcdef';    // 终帧指纹（构造上与稳定帧不同）
const H_BEFORE = 'fedcba9876543210';   // 动作前指纹（与两者皆异）

const BASE_OPTS: SettleOptions = { adaptive: true, settleMs: 5, threshold: 0.98, regionRadius: 0 };

function makeBefore(): BeforeState {
  return { screen: H_BEFORE, phash: null, region: null, focus: null };
}

before(() => { backend._setAdapterForTests(null); });
beforeEach(() => {
  kernelRegistry.register({ key: 'verify.pollMs', organ: 'verify', defaultValue: 1, min: 1, max: 1000 });
});
after(() => { backend._setAdapterForTests(null); });
afterEach(() => { kernelRegistry.reset(); });

// ═══ ① 错配对的靶场景：终帧带 dhash 无 frameId ═══

test('ΠΑΝ-32①: 终帧 dhash 无 frameId ⇒ 保留稳定 (hash, frameId) 配对（不跨帧错配）', async () => {
  // 稳定轮询：初始帧 (A,10) → 轮询帧 (A,11) 同指纹 ⇒ 收敛于 (A,11)
  // 终帧：指纹 B、frame_id=null（服务端未回帧环引用）
  const count = pairingAdapter(
    [{ d: H_STABLE, f: 10 }, { d: H_STABLE, f: 11 }],
    [{ d: H_FINAL, f: null }],
  );
  const r: CombinedEffect = await settleAndVerify(makeBefore(), BASE_OPTS);
  assert.equal(r.afterHash, normalizeHash(H_STABLE), 'afterHash 保持稳定帧指纹（不被无 frameId 的终帧顶替）');
  assert.equal(r.afterFrameId, 11, 'afterFrameId 保持稳定帧帧环 id（与 hash 同帧）');
  assert.ok(!(r.afterHash === normalizeHash(H_FINAL) && r.afterFrameId === 11),
    '旧实现错配对（hash=终帧 B / frameId=稳定环 11）必须绝迹');
  // 采集序：终帧请求严格发生在稳定轮询之后（验证用的帧就是动作后的帧）
  assert.ok(count.stableCalls >= 2 && count.finalCalls === 1, `稳定轮询 ${count.stableCalls} 次先行，终帧恰 1 次`);
});

// ═══ ② 正常路径回归：终帧携带同帧 frameId ⇒ 原子元组被采纳 ═══

test('ΠΑΝ-32②: 终帧 dhash + frameId 成对在场 ⇒ 原子采用（正常路径零回归）', async () => {
  pairingAdapter(
    [{ d: H_STABLE, f: 10 }, { d: H_STABLE, f: 11 }],
    [{ d: H_FINAL, f: 20 }],
  );
  const r = await settleAndVerify(makeBefore(), BASE_OPTS);
  assert.equal(r.afterHash, normalizeHash(H_FINAL), '终帧指纹被采纳');
  assert.equal(r.afterFrameId, 20, '终帧帧环 id 同帧随行（原子元组）');
});

// ═══ ③ 反向错配：终帧带 frameId 无 dhash ═══

test('ΠΑΝ-32③: 终帧 frameId 无 dhash ⇒ 稳定配对整体保留（frameId 不单方面跳终帧）', async () => {
  pairingAdapter(
    [{ d: H_STABLE, f: 10 }, { d: H_STABLE, f: 11 }],
    [{ d: null, f: 20 }],
  );
  const r = await settleAndVerify(makeBefore(), BASE_OPTS);
  assert.equal(r.afterHash, normalizeHash(H_STABLE), '稳定帧指纹保留');
  assert.equal(r.afterFrameId, 11, 'frameId 不跳到无指纹终帧的 20（旧实现反向错配）');
});

// ═══ ④ 非自适应路径：无稳定配对可错位 ⇒ 终帧 hash 可用、帧环引用诚实缺席 ═══

test('ΠΑΝ-32④: 非自适应 + 终帧无 frameId ⇒ 采用终帧 hash，frameId 诚实为 null', async () => {
  pairingAdapter([], [{ d: H_FINAL, f: null }]);
  const r = await settleAndVerify(makeBefore(), { ...BASE_OPTS, adaptive: false, settleMs: 1 });
  assert.equal(r.afterHash, normalizeHash(H_FINAL), '无稳定配对可错位 ⇒ 终帧指纹直接采用');
  assert.equal(r.afterFrameId, null, '帧环引用诚实缺席（而非错配到别帧）');
});
