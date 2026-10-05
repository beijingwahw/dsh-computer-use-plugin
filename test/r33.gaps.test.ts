// test/r33.gaps.test.ts
// R3-3 实战缺口收割回归：GAP-1（vlm 限流键注册）+ GAP-2（VlmBudget 可调）。
//   GAP-1：configureVlm 的 register 面补注册 vlm.maxPerMinute / vlm.maxPerHour
//     （R2-8 §6：此前消费点在、键不在册 ⇒ set 'unregistered' 静默拒收，本地
//     限流闸配置层开不了）。执法断言：注册键可调（含越界夹取的区间执法）+
//     rewireVlmRateGate 铸闸响应（缺省 0=null 摘除；set>0 ⇒ 单例 chatJson 前置
//     拒绝 —— openai 无钥降级臂零网络观测，w3wire ΝΩ-18⑤ 同法）。
//   GAP-2：codec.maxImagesPerTask / maxBytesPerTask 入册（productionSpecs）+
//     runtime.resolveVlmBudget 消费 —— 预算生效（set 2 ⇒ 第 3 张被闸拒）且
//     未注册态回声 200/512MB 字面量（零行为变化律的活体证明）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  configureVlm, rewireVlmRateGate, getGlmClient, resetGlmClient,
} from '../src/vlm/index.ts';
import { kernelRegistry, registerProductionKernels, resetKernelRuntime } from '../src/kernel/index.ts';
import { resolveVlmBudget } from '../src/autonomy/runtime.ts';

// ─── GAP-1：限流键注册与区间执法 ───

test('R3-3 GAP-1a: configureVlm 补注册 vlm.maxPerMinute/maxPerHour —— 键在册可调、越界夹取、重入幂等', () => {
  resetKernelRuntime();
  try {
    assert.equal(kernelRegistry.has('vlm.maxPerMinute'), false, 'configureVlm 前不在册（消费面 getOrDefault 回声 0=关 —— 旧行为）');
    configureVlm(null); // 全空配置：不动单例、不铸池，只走注册与闸接线面（零网络）
    assert.equal(kernelRegistry.has('vlm.maxPerMinute'), true, 'GAP-1 病灶修复：键入册');
    assert.equal(kernelRegistry.has('vlm.maxPerHour'), true);
    assert.equal(kernelRegistry.get('vlm.maxPerMinute'), 0, '缺省 0=关（零行为变化律）');
    assert.equal(kernelRegistry.get('vlm.maxPerHour'), 0, '缺省 0 ⇒ 铸闸回落 分钟×60');
    // 注册键可调 —— 此前 set 返回 {ok:false,reason:'unregistered'} 静默拒收
    assert.deepEqual(kernelRegistry.set('vlm.maxPerMinute', 30), { ok: true });
    assert.equal(kernelRegistry.get('vlm.maxPerMinute'), 30);
    assert.deepEqual(kernelRegistry.set('vlm.maxPerHour', 1200), { ok: true });
    assert.equal(kernelRegistry.get('vlm.maxPerHour'), 1200);
    // 区间执法（registry.set 夹取不变式）：越界 ⇒ 'clamped' 夹回 [min,max]
    assert.deepEqual(kernelRegistry.set('vlm.maxPerMinute', 999999), { ok: true, reason: 'clamped', clampedTo: 600 });
    assert.deepEqual(kernelRegistry.set('vlm.maxPerHour', 999999), { ok: true, reason: 'clamped', clampedTo: 36000 });
    // 重入幂等：重复 configureVlm 不清值（register 保持现值只刷规格）
    configureVlm(null);
    assert.equal(kernelRegistry.get('vlm.maxPerMinute'), 600);
    assert.equal(kernelRegistry.get('vlm.maxPerHour'), 36000);
  } finally {
    resetKernelRuntime();
  }
});

test('R3-3 GAP-1b: set 后限流闸响应 —— rewireVlmRateGate 铸闸/摘除 + chatJson 前置拒绝（全程零网络）', async () => {
  resetKernelRuntime();
  const savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY; // openai 无钥 + 远端 baseUrl ⇒ configured:false 降级臂零 fetch
  try {
    configureVlm(null); // 注册（缺省 0）
    assert.equal(rewireVlmRateGate(), null, '缺省 0 ⇒ 无闸摘除（未供参部署逐字节不变）');

    // 闸本体响应注册键：分钟桶 1/1 ⇒ 第二次被拒并给出诚实 retryAfterMs
    kernelRegistry.set('vlm.maxPerMinute', 1);
    const gate = rewireVlmRateGate();
    assert.ok(gate, 'set>0 ⇒ 铸闸');
    assert.deepEqual(gate!.tryAcquire(1000), { allowed: true, retryAfterMs: 0 });
    const denied = gate!.tryAcquire(1500);
    assert.equal(denied.allowed, false);
    assert.ok(denied.retryAfterMs > 0);

    // 端到端（零网络）：openai 无钥单例上，供参 1/min 的闸使第二次 chatJson 前置拒绝
    configureVlm({ vlmProvider: 'openai' }); // 重铸降级臂单例 + 重焊闸（新闸配额从 1/1 起算）
    const r1 = await getGlmClient().chatJson({ images: [], prompt: 'p', maxRetries: 0 });
    assert.equal(r1.ok, false);
    assert.match(r1.error!, /not configured/, '首次放行（新闸 1/1 已耗）⇒ 降级臂诚实失败（零 fetch）');
    const r2 = await getGlmClient().chatJson({ images: [], prompt: 'p', maxRetries: 0 });
    assert.equal(r2.ok, false);
    assert.match(r2.error!, /rate limited \(retry after \d+ms\)/, '第二次前置拒绝 —— 注册键供参的限流闸真实生效（GAP-1 收割判据）');

    // 小时桶方言：maxPerHour 0 ⇒ 铸闸回落 分钟×60（不收紧日预算）
    kernelRegistry.set('vlm.maxPerMinute', 2);
    kernelRegistry.set('vlm.maxPerHour', 0);
    const g2 = rewireVlmRateGate();
    assert.ok(g2);
    assert.equal(g2!.tryAcquire(0).allowed, true);
    assert.equal(g2!.tryAcquire(1000).allowed, true);
    assert.equal(g2!.tryAcquire(2000).allowed, false, '分钟桶 2/2 ⇒ 第三次拒（小时桶 120 未紧）');
  } finally {
    resetKernelRuntime(); // 清册 ⇒ 键缺席回声 0
    rewireVlmRateGate(); // 注册表空 ⇒ 摘除闸，不留模块级状态给后续用例
    resetGlmClient(); // 单例归零（下次按 env 缺省解析）
    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
  }
});

// ─── GAP-2：VlmBudget 可调（codec.maxImagesPerTask / maxBytesPerTask） ───

test('R3-3 GAP-2a: 预算双键入册 —— 缺省 200/512MB 字面量锚 + 越界夹取', () => {
  resetKernelRuntime();
  try {
    registerProductionKernels();
    assert.equal(kernelRegistry.get('codec.maxImagesPerTask'), 200, '缺省 = codec.DEFAULT_MAX_IMAGES 字面量锚');
    assert.equal(kernelRegistry.get('codec.maxBytesPerTask'), 536870912, '缺省 = codec.DEFAULT_MAX_BYTES（512MB）字面量锚');
    assert.deepEqual(kernelRegistry.set('codec.maxImagesPerTask', 99999), { ok: true, reason: 'clamped', clampedTo: 2000 });
    assert.deepEqual(kernelRegistry.set('codec.maxBytesPerTask', 1), { ok: true, reason: 'clamped', clampedTo: 16777216 });
  } finally {
    resetKernelRuntime();
  }
});

test('R3-3 GAP-2b: resolveVlmBudget 预算生效 —— set 键 ⇒ 闸响应；未注册态回声 200/512MB（零变化）', () => {
  resetKernelRuntime();
  try {
    // 未注册态（reset 后）：字面量兜底 —— 与 GAP-2 修复前 `new VlmBudget()` 行为逐字节一致
    const echo = resolveVlmBudget();
    assert.deepEqual(
      echo.summary(),
      { usedImages: 0, usedBytes: 0, maxImages: 200, maxBytes: 512 * 1024 * 1024 },
      '未注册 ⇒ 回声 codec 缺省（单测/reset 态零回归）',
    );
    // 注册 + set ⇒ 预算生效（消费点 = createExecute 构造期，本函数即其唯一解析点）
    registerProductionKernels();
    kernelRegistry.set('codec.maxImagesPerTask', 2);
    const b = resolveVlmBudget();
    assert.equal(b.summary().maxImages, 2, 'set 2 ⇒ 任务预算 2 图');
    assert.equal(b.check({ bytes: 1 }).allowed, true);
    b.commit({ bytes: 1 });
    assert.equal(b.check({ bytes: 1 }).allowed, true);
    b.commit({ bytes: 1 });
    const deniedImg = b.check({ bytes: 1 });
    assert.equal(deniedImg.allowed, false, '第 3 张被闸拒 —— 预算生效（GAP-2 收割判据）');
    assert.match(deniedImg.reason!, /image quota exceeded: 2\+1 > 2/);
    // 字节维度独立可调（夹到区间下限 16MB）
    kernelRegistry.set('codec.maxBytesPerTask', 16777216);
    assert.equal(resolveVlmBudget().summary().maxBytes, 16777216);
  } finally {
    resetKernelRuntime();
  }
});
