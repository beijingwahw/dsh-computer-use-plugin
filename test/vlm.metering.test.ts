// test/vlm.metering.test.ts
// 纪元 Ω（Ω-10）：云脑计量器官的离线全参数测试 —— 计量 / 限流 / 熔断 / 退避四面。
// 铁律：时间全部注入（构造/方法传 now），统计值全部手算对照 —— 零墙钟；
// jitterBackoff 只断言范围与上界单调（内部直用 Math.random，不播种）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  VlmMeter, vlmMeter, VlmRateLimiter, VlmApiBreaker, jitterBackoff,
} = await import('../src/vlm/metering.ts');

// ─── Ω-10a VlmMeter：记录 / summary / exportJsonl / reset ───

test('Ω-10a: 记录与 summary 数值手算对照（计数 / 令牌 / byKind / 失败）', () => {
  const m = new VlmMeter();
  m.record({ ts: 1000, kind: 'screen', model: 'glm-5.3-flash', latencyMs: 120, ok: true, promptTokens: 100, completionTokens: 20 });
  m.record({ ts: 2000, kind: 'screen', model: 'glm-5.3-flash', latencyMs: 80, ok: true, promptTokens: 50, completionTokens: 10 });
  m.record({ ts: 3000, kind: 'ocr', model: 'glm-5.3-flash', latencyMs: 200, ok: false, error: 'timeout' });
  const s = m.summary();
  assert.equal(s.calls, 3);
  assert.equal(s.failures, 1);
  assert.equal(s.totalLatencyMs, 120 + 80 + 200); // 400
  assert.equal(s.promptTokens, 150);
  assert.equal(s.completionTokens, 30);
  assert.deepEqual(s.byKind, { screen: 2, ocr: 1 });
  // 3 样本最近邻秩法：sorted [80,120,200]，p50 idx=min(2,⌊0.5·3⌋)=1 → 120；p95 idx=min(2,⌊2.85⌋)=2 → 200
  assert.equal(s.p50LatencyMs, 120);
  assert.equal(s.p95LatencyMs, 200);
});

test('Ω-10a: p50/p95 最近邻秩法（乱序录入，10 样本手算：p50=sorted[5]=60、p95=sorted[9]=100）', () => {
  const m = new VlmMeter();
  const latencies = [60, 100, 20, 80, 40, 10, 90, 30, 70, 50]; // 乱序录入
  for (let i = 0; i < latencies.length; i++) {
    m.record({ ts: i, kind: 'screen', model: 'glm-5.3-flash', latencyMs: latencies[i], ok: true });
  }
  const s = m.summary();
  // sorted = [10,20,30,40,50,60,70,80,90,100]，n=10：p50 idx=⌊5⌋=5 → 60；p95 idx=min(9,⌊9.5⌋)=9 → 100
  assert.equal(s.p50LatencyMs, 60);
  assert.equal(s.p95LatencyMs, 100);
  assert.equal(s.calls, 10);
  assert.equal(s.promptTokens, 0); // 未申报令牌 ⇒ 0（诚实缺席）
  assert.equal(s.completionTokens, 0);
});

test('Ω-10a: 分位数只看最近 1000 个延迟样本（最早的 5 个异常大值不入分位账）', () => {
  const m = new VlmMeter();
  for (let i = 0; i < 1005; i++) {
    const latencyMs = i < 5 ? 999_999 : 1000 + i; // 前 5 个 999999；其余 1005..2004
    m.record({ ts: i, kind: 'bulk', model: 'glm-5.3-flash', latencyMs, ok: true });
  }
  const s = m.summary();
  assert.equal(s.calls, 1005); // 台账全量（calls 不受分位窗口影响）
  assert.equal(s.totalLatencyMs, 5 * 999_999 + (1005 + 2004) * 1000 / 2); // 4999995 + 1504500 = 6504495
  // 窗口 = 最近 1000 样本 = [1005..2004]，sorted idx=⌊500⌋ → 1505；idx=⌊950⌋ → 1955
  assert.equal(s.p50LatencyMs, 1505);
  assert.equal(s.p95LatencyMs, 1955);
});

test('Ω-10a: exportJsonl 每行一个 JSON 且字段往返无损（未申报的可选字段不出现）', () => {
  const m = new VlmMeter();
  m.record({ ts: 1, kind: 'screen', model: 'm1', latencyMs: 50, ok: true, promptTokens: 7, completionTokens: 3 });
  m.record({ ts: 2, kind: 'ocr', model: 'm1', latencyMs: 90, ok: false, error: 'boom' });
  const out = m.exportJsonl();
  const lines = out.split('\n');
  assert.equal(lines.length, 2);
  const a = JSON.parse(lines[0]);
  const b = JSON.parse(lines[1]);
  assert.equal(a.model, 'm1');
  assert.equal(a.promptTokens, 7);
  assert.equal(a.completionTokens, 3);
  assert.equal(a.ok, true);
  assert.equal(b.error, 'boom');
  assert.equal(b.ok, false);
  assert.equal('promptTokens' in b, false); // 未申报 ⇒ 键不出现
});

test('Ω-10a: 空台账 exportJsonl 为空串；reset 后一切归零', () => {
  const m = new VlmMeter();
  assert.equal(m.exportJsonl(), '');
  const zeros = {
    calls: 0, failures: 0, totalLatencyMs: 0,
    p50LatencyMs: 0, p95LatencyMs: 0,
    promptTokens: 0, completionTokens: 0, byKind: {},
  };
  assert.deepEqual(m.summary(), zeros);
  m.record({ ts: 1, kind: 'screen', model: 'm1', latencyMs: 10, ok: true, promptTokens: 1, completionTokens: 1 });
  m.record({ ts: 2, kind: 'ocr', model: 'm1', latencyMs: 20, ok: false, error: 'x' });
  assert.equal(m.summary().calls, 2);
  m.reset();
  assert.deepEqual(m.summary(), zeros);
  assert.equal(m.exportJsonl(), '');
});

test('Ω-10a: vlmMeter 模块级单例是 VlmMeter 实例且可往返（用毕复位防跨测试污染）', () => {
  assert.ok(vlmMeter instanceof VlmMeter);
  vlmMeter.reset();
  vlmMeter.record({ ts: 42, kind: 'screen', model: 'glm-5.3-flash', latencyMs: 33, ok: true, promptTokens: 5, completionTokens: 2 });
  assert.equal(vlmMeter.summary().calls, 1);
  vlmMeter.reset();
  assert.equal(vlmMeter.summary().calls, 0);
});

test('Ω-10a: 垃圾输入绝不抛异常（非对象丢弃、非有限数值诚实归零）', () => {
  const m = new VlmMeter();
  m.record(null as never);
  m.record(undefined as never);
  assert.equal(m.summary().calls, 0); // 非对象不入账
  m.record({ ts: Number.NaN, kind: 42, model: 'x', latencyMs: Number.NaN, ok: 1 } as never);
  const s = m.summary();
  assert.equal(s.calls, 1);
  assert.equal(s.totalLatencyMs, 0); // NaN 延迟归零，绝不产生 NaN 污染
  assert.equal(s.failures, 1);       // ok !== true ⇒ 失败
  assert.deepEqual(s.byKind, { unknown: 1 }); // 非字符串类别归 unknown
});

// ─── Ω-10b VlmRateLimiter：双桶滑动窗 ───

test('Ω-10b: 分钟桶容量拒绝（retryAfterMs 精确到释放边界）+ 窗口滑出后恢复', () => {
  const rl = new VlmRateLimiter({ maxPerMinute: 3 }); // 小时桶缺省 180，不参与
  const t0 = 1_000_000;
  assert.deepEqual(rl.tryAcquire(t0), { allowed: true, retryAfterMs: 0 });
  assert.deepEqual(rl.tryAcquire(t0 + 10_000), { allowed: true, retryAfterMs: 0 });
  assert.deepEqual(rl.tryAcquire(t0 + 20_000), { allowed: true, retryAfterMs: 0 });
  // 第 4 次：分钟窗内 3 戳 ≥ 3 ⇒ 拒；最早戳 t0 于 t0+60000 滑出 ⇒ 等 30000
  assert.deepEqual(rl.tryAcquire(t0 + 30_000), { allowed: false, retryAfterMs: 30_000 });
  assert.deepEqual(rl.tryAcquire(t0 + 45_000), { allowed: false, retryAfterMs: 15_000 });
  // t0+60000：t0 恰滑出（严格 > 窗界）⇒ 窗内 2 戳 ⇒ 放行
  assert.deepEqual(rl.tryAcquire(t0 + 60_000), { allowed: true, retryAfterMs: 0 });
  // 再满 3 戳（10000/20000/60000 偏移）⇒ 拒；最早窗内戳 t0+10000 ⇒ 等 5000
  assert.deepEqual(rl.tryAcquire(t0 + 65_000), { allowed: false, retryAfterMs: 5_000 });
  // t0+70001：t0+10000 滑出 ⇒ 窗内 2 戳 ⇒ 恢复放行
  assert.deepEqual(rl.tryAcquire(t0 + 70_001), { allowed: true, retryAfterMs: 0 });
});

test('Ω-10b: 小时桶独立限幅（maxPerHour 显式注入）+ 整点滑出恢复', () => {
  const rl = new VlmRateLimiter({ maxPerMinute: 100, maxPerHour: 3 }); // 分钟桶全程不参与
  const t0 = 2_000_000;
  assert.deepEqual(rl.tryAcquire(t0), { allowed: true, retryAfterMs: 0 });
  assert.deepEqual(rl.tryAcquire(t0 + 1_000), { allowed: true, retryAfterMs: 0 });
  assert.deepEqual(rl.tryAcquire(t0 + 2_000), { allowed: true, retryAfterMs: 0 });
  // 小时窗内 3 戳 ≥ 3 ⇒ 拒；最早戳 t0 于 t0+3600000 滑出 ⇒ 等 3597000
  const denied = rl.tryAcquire(t0 + 3_000);
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterMs, 3_600_000 - 3_000);
  assert.deepEqual(rl.tryAcquire(t0 + 3_600_000), { allowed: true, retryAfterMs: 0 }); // t0 滑出 ⇒ 恢复
});

test('Ω-10b: 缺省小时桶 = 分钟桶 × 60（60 分钟满速后恰于整点释放）', () => {
  const rl = new VlmRateLimiter({ maxPerMinute: 1 }); // 缺省 maxPerHour = 60
  const t0 = 1_000_000;
  for (let k = 0; k < 60; k++) {
    // 每分钟 1 次：前戳恰在窗界上（严格 > 排除）⇒ 分钟桶每次都空 ⇒ 全放行
    assert.deepEqual(rl.tryAcquire(t0 + k * 60_000), { allowed: true, retryAfterMs: 0 }, `k=${k}`);
  }
  // 第 61 次（仍在首戳滑出前）：分钟桶 1/1、小时桶 60/60 双满，两边界同为 t0+3600000
  assert.deepEqual(rl.tryAcquire(t0 + 3_540_001), { allowed: false, retryAfterMs: 59_999 });
  // t0+3600000：首戳滑出 ⇒ 两桶同时腾位 ⇒ 放行（与显式小时桶测试共同锁定缺省值）
  assert.deepEqual(rl.tryAcquire(t0 + 3_600_000), { allowed: true, retryAfterMs: 0 });
});

test('Ω-10b: 被拒不占配额（denied 的戳不入账，等待边界不前移）', () => {
  const rl = new VlmRateLimiter({ maxPerMinute: 2 });
  const t0 = 5_000_000;
  assert.deepEqual(rl.tryAcquire(t0), { allowed: true, retryAfterMs: 0 });
  assert.deepEqual(rl.tryAcquire(t0 + 1), { allowed: true, retryAfterMs: 0 });
  const d1 = rl.tryAcquire(t0 + 2); // 拒：等最早戳 t0 滑出
  assert.equal(d1.allowed, false);
  assert.equal(d1.retryAfterMs, 60_000 - 2);
  const d2 = rl.tryAcquire(t0 + 3); // 若前次被拒入账，此界将前移 ⇒ 以同锚断言
  assert.equal(d2.allowed, false);
  assert.equal(d2.retryAfterMs, 60_000 - 3);
  assert.deepEqual(rl.tryAcquire(t0 + 60_000), { allowed: true, retryAfterMs: 0 }); // 仍只剩 1 戳在窗内
});

// ─── Ω-10c VlmApiBreaker：closed → open → 冷却 → closed 状态机 ───

test('Ω-10c: 全迁移：closed →(缺省阈值 5 连败)→ open →(冷却 60000ms 期满 state() 内判定)→ closed', () => {
  const b = new VlmApiBreaker(); // 缺省 5 次 / 60000ms
  const t0 = 10_000_000;
  assert.equal(b.state(t0), 'closed');
  assert.equal(b.retryAt(t0), null);
  for (let i = 0; i < 4; i++) b.onFailure(t0 + i); // 4 连败 < 5
  assert.equal(b.state(t0 + 4), 'closed');
  assert.equal(b.retryAt(t0 + 4), null);
  const t1 = t0 + 100;
  b.onFailure(t1); // 第 5 连败 ⇒ open
  assert.equal(b.state(t1), 'open');
  assert.equal(b.retryAt(t1), t1 + 60_000);
  assert.equal(b.state(t1 + 59_999), 'open'); // 冷却差 1ms 仍拒
  assert.equal(b.retryAt(t1 + 59_999), t1 + 60_000);
  assert.equal(b.state(t1 + 60_000), 'closed'); // 期满自动回闭（惰性判定，无需定时器）
  assert.equal(b.retryAt(t1 + 60_000), null);
});

test('Ω-10c: 冷却回闭后连续失败清零 —— 半开还给完整机会（单败不即刻复燃）', () => {
  const b = new VlmApiBreaker(); // 缺省 5 / 60000
  const t0 = 20_000_000;
  for (let i = 0; i < 5; i++) b.onFailure(t0 + i);
  assert.equal(b.state(t0 + 4), 'open');
  assert.equal(b.state(t0 + 4 + 59_999), 'open');   // 冷却差 1ms 仍拒
  assert.equal(b.state(t0 + 4 + 60_000), 'closed'); // 冷却期满回闭 ⇒ 连败清零（openedAt=t0+4）
  b.onFailure(t0 + 70_000); // 回闭后的第 1 败：若未清零此处连败=6 ≥ 5 会复燃
  assert.equal(b.state(t0 + 70_001), 'closed');
  assert.equal(b.retryAt(t0 + 70_001), null);
});

test('Ω-10c: 成功清零连续失败（交替成败型坏路线永不误熔断）+ 自定义阈值熔断', () => {
  const b = new VlmApiBreaker({ failureThreshold: 3, cooldownMs: 1000 });
  const t0 = 0;
  b.onFailure(t0);       // 连败 1
  b.onSuccess(t0 + 100); // 清零
  b.onFailure(t0 + 200); // 连败 1（若未清零此处 = 2）
  b.onSuccess(t0 + 300); // 清零
  b.onFailure(t0 + 400); // 连败 1（若未清零 = 3 已 open）
  assert.equal(b.state(t0 + 500), 'closed');
  assert.equal(b.retryAt(t0 + 500), null);
  b.onFailure(t0 + 600); // 连败 2
  b.onFailure(t0 + 700); // 连败 3 ≥ 3 ⇒ open
  assert.equal(b.state(t0 + 800), 'open');
  assert.equal(b.retryAt(t0 + 800), t0 + 700 + 1000); // openedAt + cooldownMs
});

test('Ω-10c: open 态再失败重燃冷却期（自该失败重新起算，冷静期不缩水）', () => {
  const b = new VlmApiBreaker({ failureThreshold: 2, cooldownMs: 1000 });
  const t0 = 30_000_000;
  b.onFailure(t0);
  b.onFailure(t0 + 100); // 2 连败 ⇒ open（openedAt = t0+100）
  assert.equal(b.state(t0 + 1099), 'open'); // 999ms < 1000ms
  b.onFailure(t0 + 500); // open 态失败 ⇒ 冷却自 t0+500 重燃
  assert.equal(b.state(t0 + 1200), 'open'); // 若未重燃：1200-100=1100 ≥ 1000 会误判 closed
  assert.equal(b.retryAt(t0 + 1200), t0 + 1500);
  assert.equal(b.state(t0 + 1500), 'closed'); // 重燃后的冷却期满
});

test('Ω-10c: open 态试探成功即治愈（onSuccess 直接闭合）', () => {
  const b = new VlmApiBreaker({ failureThreshold: 2, cooldownMs: 1000 });
  const t0 = 40_000_000;
  b.onFailure(t0);
  b.onFailure(t0 + 10); // open
  assert.equal(b.state(t0 + 10), 'open');
  b.onSuccess(t0 + 500); // 冷却未满，但成功 = API 已痊愈
  assert.equal(b.state(t0 + 500), 'closed');
  assert.equal(b.retryAt(t0 + 500), null);
});

// ─── ΝΩ-18：recordServer429 回填 + onExtractionFailure 半权 ───

test('ΝΩ-18: recordServer429 —— 回填记一次本地配额并给出释放边界提示；桶未满回 0', () => {
  const rl = new VlmRateLimiter({ maxPerMinute: 3 }); // 小时桶缺省 180 不参与
  const t0 = 7_000_000;
  rl.tryAcquire(t0);
  rl.tryAcquire(t0 + 10_000);
  rl.tryAcquire(t0 + 20_000); // 分钟窗 3/3 满
  // 回填：第 4 戳入账（t0+30000），提示 = 最早戳 t0 滑出边界 60000 − 30000
  assert.equal(rl.recordServer429(t0 + 30_000), 30_000, '回填后等待提示精确到释放边界');
  // 回填收紧生效：下一次 tryAcquire 被拒（4 戳 ≥ 3），等待锚仍是 t0
  assert.deepEqual(rl.tryAcquire(t0 + 31_000), { allowed: false, retryAfterMs: 29_000 });
  // 桶未满时回填 ⇒ 提示 0（无等待可提示），但戳照记（下次判断如实收紧）
  const rl2 = new VlmRateLimiter({ maxPerMinute: 5 });
  assert.equal(rl2.recordServer429(t0), 0, '桶未满 ⇒ 0');
  assert.deepEqual(rl2.tryAcquire(t0), { allowed: true, retryAfterMs: 0 }, '1 戳 < 5 仍放行');
  // 脏入参防御：非有限 now 按 Date.now 计（不抛，返回有限数）
  const rl3 = new VlmRateLimiter({ maxPerMinute: 1 });
  rl3.tryAcquire(100);
  const hint = rl3.recordServer429(Number.NaN);
  assert.ok(Number.isFinite(hint) && hint > 0, '脏 now 兜底 Date.now 仍给出有限提示');
});

test('ΝΩ-18: onExtractionFailure 半权 —— 阈值 N 需 2N 次剥壳失败才 open；真失败全权同速；成功清零分数账', () => {
  const b = new VlmApiBreaker({ failureThreshold: 2, cooldownMs: 1000 });
  const t0 = 50_000_000;
  b.onExtractionFailure(t0); // 0.5
  b.onExtractionFailure(t0 + 1); // 1.0
  b.onExtractionFailure(t0 + 2); // 1.5 < 2
  assert.equal(b.state(t0 + 3), 'closed', '3 次剥壳失败（1.5 权）< 阈值 2 ⇒ 不熔断');
  b.onExtractionFailure(t0 + 3); // 2.0 ≥ 2 ⇒ open
  assert.equal(b.state(t0 + 4), 'open', '第 4 次（2N）恰熔断 —— 半权语义');
  assert.equal(b.retryAt(t0 + 4), t0 + 3 + 1000);

  // 真实拨号失败全权（与既有 onFailure 同速）：1 全权 + 1 半权 = 1.5 < 2，再 1 半权 ⇒ open
  const b2 = new VlmApiBreaker({ failureThreshold: 2, cooldownMs: 1000 });
  b2.onFailure(t0);
  b2.onExtractionFailure(t0 + 1); // 1.5
  assert.equal(b2.state(t0 + 2), 'closed');
  b2.onExtractionFailure(t0 + 2); // 2.0
  assert.equal(b2.state(t0 + 3), 'open', '混合计数：全权 1 + 半权×2 = 2 ⇒ 熔断');

  // 成功清零分数累计（好 JSON 一次即治愈 —— 交替型不误熔断）
  const b3 = new VlmApiBreaker({ failureThreshold: 2, cooldownMs: 1000 });
  b3.onExtractionFailure(t0);
  b3.onExtractionFailure(t0 + 1);
  b3.onExtractionFailure(t0 + 2); // 1.5
  b3.onSuccess(t0 + 3); // 清零
  b3.onExtractionFailure(t0 + 4); // 0.5
  assert.equal(b3.state(t0 + 5), 'closed', '成功清零后分数账从 0 重计');
});

// ─── Ω-10d jitterBackoff：全抖动 uniform(0, min(cap, base·2^attempt)) ───

test('Ω-10d: 缺省 base=500 / cap=8000 的全抖动范围 [0, min(cap, base·2^attempt)]', () => {
  for (const attempt of [0, 1, 2, 3, 4, 5, 20]) {
    const upper = Math.min(8000, 500 * 2 ** attempt); // attempt=4 起 cap 压顶
    for (let d = 0; d < 40; d++) {
      const v = jitterBackoff(attempt);
      assert.ok(v >= 0 && v <= upper, `attempt=${attempt} v=${v} upper=${upper}`);
    }
  }
});

test('Ω-10d: 自定义 base/cap 尊重更紧的上界（cap 压过指数、指数压过 cap 均可能）', () => {
  const cases: Array<[attempt: number, baseMs: number, capMs: number, upper: number]> = [
    [1, 200, 500, 400],   // base·2^1=400 < cap=500 ⇒ 指数为界
    [3, 1000, 3000, 3000], // base·2^3=8000 > cap=3000 ⇒ cap 为界
    [0, 100, 10000, 100],  // attempt=0 ⇒ base 本身
  ];
  for (const [attempt, baseMs, capMs, upper] of cases) {
    for (let d = 0; d < 40; d++) {
      const v = jitterBackoff(attempt, baseMs, capMs);
      assert.ok(v >= 0 && v <= upper, `a=${attempt} b=${baseMs} c=${capMs} v=${v}`);
    }
  }
});

test('Ω-10d: 上界随 attempt 单调不减（封顶前指数爬升、封顶后恒为 cap）', () => {
  const bound = (a: number) => Math.min(8000, 500 * 2 ** a);
  for (let a = 0; a < 10; a++) {
    assert.ok(bound(a) <= bound(a + 1), `a=${a}`);
  }
  assert.equal(bound(4), 8000); // 500·2^4 = 8000 恰触顶
  for (let a = 4; a <= 12; a++) assert.equal(bound(a), 8000); // 触顶后恒 cap（指数溢出兜底）
});
