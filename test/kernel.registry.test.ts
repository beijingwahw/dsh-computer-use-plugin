// test/kernel.registry.test.ts
// 纪元 Θ（Θ-1 内核注册表与证据账本）：入册幂等 / 垃圾忽略 / 夹取 / 证据累计 /
// 深拷贝防御 / 漂移手算 / 快照往返 / 实验室晋升 / 生产单例隔离 / 账本滑窗 200。
// 全离线纯内存断言，零依赖零墙钟假设。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  KernelRegistry,
  kernelRegistry,
  EvidenceLedger,
  evidenceLedger,
  resetKernelRuntime,
  type KernelParamSpec,
  type KernelOutcome,
} from '../src/kernel/registry.ts';

/** 测试规格工厂：缺省 [0,1] 区间、缺省 0.5（区间内一点 —— params.ts 律） */
function spec(key: string, over: Partial<KernelParamSpec> = {}): KernelParamSpec {
  return { key, organ: 'test-organ', defaultValue: 0.5, min: 0, max: 1, note: '测试区间', ...over };
}

// ─── Θ-1 注册：入册 / 幂等 / 规格重夹 ───

test('Θ-1a register 新 key：value=夹取后缺省、evidence=0、generation=0；返回防御副本；越界缺省入册即夹取', () => {
  const reg = new KernelRegistry();
  const r = reg.register(spec('k0', { defaultValue: 0.5 }));
  assert.equal(r.key, 'k0');
  assert.equal(r.value, 0.5);
  assert.equal(r.evidence, 0);
  assert.equal(r.generation, 0);
  assert.ok(Number.isFinite(r.updatedAt) && r.updatedAt > 0, 'updatedAt 应为有效时间戳');
  assert.ok(reg.has('k0'));
  assert.equal(reg.get('k0'), 0.5);
  // 防御副本：篡改返回值不穿透注册表
  r.value = 42;
  assert.equal(reg.get('k0'), 0.5);
  // defaultValue 越界 ⇒ 入册即夹取（区间不变式从第 0 毫秒成立）
  const r2 = reg.register(spec('k1', { defaultValue: 9, min: 0, max: 1 }));
  assert.equal(r2.defaultValue, 1);
  assert.equal(r2.value, 1);
});

test('Θ-1b register 幂等：重注册保持现值/证据/代际，只换规格（organ/default/note），无重复条目', () => {
  const reg = new KernelRegistry();
  reg.register(spec('k', { organ: 'old-organ', defaultValue: 0.5, note: '旧注记' }));
  reg.set('k', 0.8, 3);
  reg.addEvidence('k'); // 证据 4
  const r = reg.register(spec('k', { organ: 'new-organ', defaultValue: 0.2, note: '新注记' }));
  assert.equal(r.value, 0.8, '现值保持（幂等重注册不动值）');
  assert.equal(r.evidence, 4, '证据保持');
  assert.equal(r.generation, 0, '代际保持（重注册不是晋升）');
  assert.equal(r.organ, 'new-organ', '规格更新：organ');
  assert.equal(r.defaultValue, 0.2, '规格更新：defaultValue');
  assert.equal(r.note, '新注记', '规格更新：note');
  assert.equal(reg.list().length, 1, '同 key 重注册不产生重复条目');
});

test('Θ-1c register 规格更新重夹：现值越新 bounds 即重夹', () => {
  const reg = new KernelRegistry();
  reg.register(spec('k', { defaultValue: 0.5, min: 0, max: 1 }));
  reg.set('k', 0.8);
  const r = reg.register(spec('k', { defaultValue: 0.5, min: 0, max: 0.6 }));
  assert.equal(r.max, 0.6);
  assert.equal(r.value, 0.6, '现值 0.8 被新上界 0.6 重夹');
  assert.equal(reg.get('k'), 0.6);
});

test('Θ-1d register 垃圾 spec：静默忽略不入册（has 假 / list 查无 / 绝不抛），回声 note 打「忽略」标', () => {
  const reg = new KernelRegistry();
  reg.register(spec('good'));
  const garbage: Array<unknown> = [
    { key: '', organ: 'o', defaultValue: 0.5, min: 0, max: 1 },           // key 空
    { key: 'nan1', organ: 'o', defaultValue: Number.NaN, min: 0, max: 1 }, // defaultValue NaN
    { key: 'nan2', organ: 'o', defaultValue: 0.5, min: Number.NaN, max: 1 },
    { key: 'nan3', organ: 'o', defaultValue: 0.5, min: 0, max: Number.NaN },
    { key: 'inf', organ: 'o', defaultValue: Infinity, min: 0, max: 1 },    // 非有限同罪
    { key: 'eq', organ: 'o', defaultValue: 0.5, min: 1, max: 1 },          // min === max
    { key: 'gt', organ: 'o', defaultValue: 0.5, min: 2, max: 1 },          // min > max
    { key: 'noorgan', defaultValue: 0.5, min: 0, max: 1 },                 // organ 缺失
    null,
    undefined,
  ];
  garbage.forEach((g, i) => {
    const echo = reg.register(g as KernelParamSpec); // 绝不抛（跑到这里即证明）
    assert.match(echo.note ?? '', /忽略/, `垃圾 #${i} 的回声应打「忽略」标`);
  });
  assert.equal(reg.list().length, 1, '只有 good 入册');
  for (const badKey of ['', 'nan1', 'nan2', 'nan3', 'inf', 'eq', 'gt', 'noorgan']) {
    assert.equal(reg.has(badKey), false, `垃圾 key「${badKey}」不得在册`);
  }
  assert.equal(reg.get('eq'), null, '未注册读数 = null');
});

// ─── Θ-1 读数与设值 ───

test('Θ-1e getOrDefault：未注册回退 fallback（生产缺省零行为变化）；已注册返回区间内现值', () => {
  const reg = new KernelRegistry();
  reg.register(spec('k', { defaultValue: 0.5 }));
  // 未注册 ⇒ fallback 原样回声 —— 消费方以字面量兜底时与写死阈值时代逐字节一致
  assert.equal(reg.getOrDefault('ghost', 0.42), 0.42);
  assert.equal(reg.get('ghost'), null);
  // 已注册 ⇒ 现值（不变式：恒在区间内）
  reg.set('k', 0.9);
  assert.equal(reg.getOrDefault('k', 0.42), 0.9);
});

test('Θ-1f set：区间内 ok / 越界夹取 ok+clampedTo / 未注册与垃圾值 ok:false+reason / 证据增量', () => {
  const reg = new KernelRegistry();
  reg.register(spec('k', { defaultValue: 0.5, min: 0, max: 1 }));
  // 区间内：ok 且无 reason/clampedTo
  const ok = reg.set('k', 0.3, 2);
  assert.deepEqual(ok, { ok: true });
  assert.equal(reg.get('k'), 0.3);
  assert.equal(reg.list()[0].evidence, 2, 'evidenceDelta=2 已入账');
  // 越界上界：夹取是成功（生产读数永远在区间内），reason + clampedTo 齐报
  const up = reg.set('k', 5);
  assert.equal(up.ok, true);
  assert.equal(up.reason, 'clamped');
  assert.equal(up.clampedTo, 1);
  assert.equal(reg.get('k'), 1);
  // 越界下界
  const down = reg.set('k', -3);
  assert.equal(down.ok, true);
  assert.equal(down.clampedTo, 0);
  assert.equal(reg.get('k'), 0);
  // 未注册
  assert.deepEqual(reg.set('ghost', 0.5), { ok: false, reason: 'unregistered' });
  // 垃圾值：现值不动
  assert.deepEqual(reg.set('k', Number.NaN), { ok: false, reason: 'invalid-value' });
  assert.equal(reg.get('k'), 0);
});

test('Θ-1g addEvidence：缺省 +1 / 自定义增量 / 地板 0 / 垃圾增量按 0 / 未注册静默', () => {
  const reg = new KernelRegistry();
  reg.register(spec('k'));
  reg.addEvidence('k');
  reg.addEvidence('k');
  reg.addEvidence('k', 10);
  assert.equal(reg.list()[0].evidence, 12, '缺省 +1 两次 + 增量 10');
  reg.addEvidence('k', -100); // 证据是计数，不穿地板
  assert.equal(reg.list()[0].evidence, 0);
  reg.addEvidence('k', Number.NaN); // 垃圾增量按 0 计
  assert.equal(reg.list()[0].evidence, 0);
  reg.addEvidence('ghost', 5); // 未注册静默
  assert.equal(reg.list().length, 1);
  assert.equal(reg.has('ghost'), false);
});

// ─── Θ-1 报表与深拷贝 ───

test('Θ-1h list：防御深拷贝，篡改返回值（含 pop/note）不穿透注册表', () => {
  const reg = new KernelRegistry();
  reg.register(spec('k1', { note: '原始注记' }));
  const stolen = reg.list();
  stolen[0].value = 99;
  stolen[0].note = 'hacked';
  stolen.pop();
  assert.equal(reg.get('k1'), 0.5);
  const fresh = reg.list();
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].value, 0.5);
  assert.equal(fresh[0].note, '原始注记');
});

test('Θ-1i drift：driftPct=|value−default|/(max−min)×100 手算核对，仅列偏离者', () => {
  const reg = new KernelRegistry();
  reg.register(spec('d1', { defaultValue: 0.5, min: 0, max: 1 })); // 未动 ⇒ 不入 drift
  reg.register(spec('d2', { defaultValue: 1, min: 0, max: 4 }));
  reg.register(spec('d3', { defaultValue: 0.5, min: 0, max: 1 }));
  reg.set('d3', 0.75, 5); // 手算：|0.75−0.5|/(1−0)×100 = 25
  reg.set('d2', 3, 2);    // 手算：|3−1|/(4−0)×100 = 50
  const d = reg.drift();
  assert.deepEqual(d.map(x => x.key).sort(), ['d2', 'd3'], 'd1 值=缺省，不入列');
  const d3 = d.find(x => x.key === 'd3')!;
  assert.equal(d3.driftPct, 25);
  assert.equal(d3.organ, 'test-organ');
  assert.equal(d3.evidence, 5);
  assert.equal(d3.generation, 0);
  const d2 = d.find(x => x.key === 'd2')!;
  assert.equal(d2.driftPct, 50);
});

// ─── Θ-1 快照往返 ───

test('Θ-1j snapshot/restore：值复原 / 未注册 key 忽略 / 越界值重夹 / 垃圾快照静默 / 证据不动', () => {
  const reg = new KernelRegistry();
  reg.register(spec('s1', { defaultValue: 0.5 }));
  reg.register(spec('s2', { defaultValue: 0.5 }));
  reg.set('s1', 0.8, 1);
  const snap = reg.snapshot();
  assert.deepEqual(snap, { s1: 0.8, s2: 0.5 });
  // 偏离后恢复：ghost 未注册 ⇒ 忽略；s1/s2 复原
  reg.set('s1', 0.1);
  reg.set('s2', 0.9);
  reg.restore({ ...snap, ghost: 99 });
  assert.equal(reg.get('s1'), 0.8);
  assert.equal(reg.get('s2'), 0.5);
  assert.equal(reg.has('ghost'), false);
  // restore 只动数值：证据原样
  assert.equal(reg.list().find(p => p.key === 's1')!.evidence, 1);
  // 快照值越界 ⇒ 重夹当时 bounds
  reg.restore({ s1: 42 });
  assert.equal(reg.get('s1'), 1);
  // 垃圾快照静默
  reg.restore(null as never);
  assert.equal(reg.get('s1'), 1);
});

// ─── Θ-1 实验室晋升 ───

test('Θ-1k promoteFrom：交集拷入 / lab 宽区间值重夹生产 bounds / generation+1 / ΠΑΝ-50 步长夹取 + 证据只升不降 / lab 不被消耗', () => {
  const prod = new KernelRegistry();
  prod.register(spec('a', { defaultValue: 0.5, min: 0, max: 1 })); // 生产窄区间
  prod.register(spec('b', { defaultValue: 0.5 }));
  prod.register(spec('c', { defaultValue: 0.5 }));
  prod.addEvidence('a');
  prod.addEvidence('a'); // 生产 a 证据 2（ΠΑΝ-50：晋升后证据只升不降 —— max(2,4)=4）

  const lab = new KernelRegistry();
  lab.register(spec('a', { defaultValue: 0.5, min: 0, max: 2 })); // 实验室宽区间
  lab.set('a', 1.7, 4); // lab 值 1.7（宽区间内合法），lab 证据 4
  lab.register(spec('b', { defaultValue: 0.5 }));
  lab.set('b', 0.2, 7); // lab b 证据 7
  // lab 无 c ⇒ 缺省交集 = {a, b}

  // ΠΑΝ-50 重锚：晋升不再一次跳到 [min,max] 任意点 —— 单步 ≤ maxStepPct(缺省 0.1)
  // × 区间宽。a：0.5 →（重夹 1）→ 截到 0.5+0.1×1 = 0.6（step-capped）；b：0.5 →
  // 0.2 截到 0.5−0.1×1 = 0.4（step-capped）。远距值经多次晋升逐步走近（每次都
  // 过证据门）—— 老断言「一次跳到 1 / 直落 0.2」是被立法废弃的零护栏语义。
  const changes = prod.promoteFrom(lab);
  assert.deepEqual(changes.map(ch => ch.key).sort(), ['a', 'b'], '只晋升交集，c 不在');
  const chA = changes.find(ch => ch.key === 'a')!;
  assert.equal(chA.from, 0.5);
  assert.equal(chA.to, 0.6, 'lab 值 1.7 重夹 [0,1] ⇒ 1，再被步长夹取截到 0.6（ΠΑΝ-50）');
  assert.equal(chA.reason, 'step-capped', '步长截断形态如实标注（ΠΑΝ-50 审计面）');
  assert.equal(prod.get('a'), 0.6);
  assert.equal(prod.get('b'), 0.4, '0.5 → 0.2 被步长截到 0.4（ΠΑΝ-50）');
  const pa = prod.list().find(p => p.key === 'a')!;
  assert.equal(pa.generation, 1, '晋升 +1 代');
  assert.equal(pa.evidence, 4, '证据只升不降：max(生产 2, lab 4) = 4（ΠΑΝ-50 —— 不覆写不相加）');
  assert.equal(prod.list().find(p => p.key === 'b')!.evidence, 7);
  assert.equal(prod.list().find(p => p.key === 'c')!.generation, 0, '未晋升者代际不动');
  // 晋升是拷贝不是移动 —— lab 不被消耗
  assert.equal(lab.get('a'), 1.7);
  assert.equal(lab.list().find(p => p.key === 'a')!.evidence, 4);

  // 显式 keys：lab 未注册的 key（c/zzz）跳过；b 继续步进（0.4 → 0.4−0.1 仍 step-capped；
  // IEEE 浮点直书 0.30000000000000004 —— 与实现同律不四舍五入）
  const again = prod.promoteFrom(lab, { keys: ['b', 'c', 'zzz'] });
  assert.deepEqual(again, [{ key: 'b', from: 0.4, to: 0.30000000000000004, reason: 'step-capped' }]);
  assert.equal(prod.get('b'), 0.30000000000000004);
  assert.equal(prod.list().find(p => p.key === 'b')!.generation, 2, '二次晋升再 +1');
  // 垃圾 lab / 空 keys 静默
  assert.deepEqual(prod.promoteFrom(null as never), []);
  assert.deepEqual(prod.promoteFrom(lab, { keys: [] }), []);
});

test('Θ-1l reset：清空注册表（has/list/snapshot/drift 全空）', () => {
  const reg = new KernelRegistry();
  reg.register(spec('a'));
  reg.set('a', 0.9, 3);
  reg.reset();
  assert.equal(reg.has('a'), false);
  assert.equal(reg.get('a'), null);
  assert.deepEqual(reg.list(), []);
  assert.deepEqual(reg.snapshot(), {});
  assert.deepEqual(reg.drift(), []);
});

// ─── Θ-1 生产单例隔离与运行时复位 ───

test('Θ-1m 生产单例：实验室自建实例的任何改动后，生产 snapshot 逐字节不变', () => {
  resetKernelRuntime(); // 隔离本文件此前/此后的单例痕迹
  assert.ok(kernelRegistry instanceof KernelRegistry);
  assert.ok(evidenceLedger instanceof EvidenceLedger);
  kernelRegistry.register(spec('prod.threshold', { organ: 'production' }));
  kernelRegistry.set('prod.threshold', 0.7, 2);
  const before = JSON.stringify(kernelRegistry.snapshot());
  const lab = new KernelRegistry(); // 实验室自建实例
  lab.register(spec('prod.threshold', { defaultValue: 0.1 }));
  lab.set('prod.threshold', 0.95, 9);
  lab.register(spec('lab.only'));
  lab.promoteFrom(lab); // 自晋升也不许波及生产
  const after = JSON.stringify(kernelRegistry.snapshot());
  assert.equal(after, before, '生产快照逐字节不变');
  assert.equal(kernelRegistry.has('lab.only'), false);
  assert.equal(kernelRegistry.get('prod.threshold'), 0.7);
  assert.equal(lab.get('prod.threshold'), 0.95);
});

test('Θ-1n resetKernelRuntime：两单例齐清（registry + ledger）', () => {
  kernelRegistry.register(spec('prod.k'));
  kernelRegistry.set('prod.k', 0.9, 3);
  evidenceLedger.record({ key: 'prod.k', success: true, ts: 1 });
  assert.ok(kernelRegistry.has('prod.k'));
  assert.deepEqual(evidenceLedger.keys(), ['prod.k']);
  resetKernelRuntime();
  assert.equal(kernelRegistry.has('prod.k'), false);
  assert.equal(kernelRegistry.get('prod.k'), null);
  assert.equal(kernelRegistry.getOrDefault('prod.k', 0.123), 0.123, '复位后回到零行为变化兜底');
  assert.deepEqual(kernelRegistry.snapshot(), {});
  assert.deepEqual(evidenceLedger.keys(), []);
  assert.deepEqual(evidenceLedger.stats('prod.k'), { n: 0, successRate: 0, margins: [] });
});

// ─── Θ-1 证据账本 ───

test('Θ-1o EvidenceLedger 滑窗 200：第 201 条挤最旧（FIFO），stats 逐位核对，每 key 独立', () => {
  const led = new EvidenceLedger();
  // i=0 是唯一失败且带 margin=0 —— 恰好是被挤出的最旧者；margin=i 供逐位核对
  for (let i = 0; i <= 200; i++) {
    led.record({ key: 'w', success: i !== 0, margin: i, ts: i });
  }
  const s = led.stats('w');
  assert.equal(s.n, 200, '窗口容量 200');
  assert.equal(s.successRate, 1, '唯一失败（i=0）已被挤出窗口');
  assert.equal(s.margins.length, 200);
  assert.equal(s.margins[0], 1, '最旧幸存者 = i=1（i=0 被挤）');
  assert.equal(s.margins[199], 200, '最新 = i=200');
  // 每 key 独立滑窗；无 margin 条目不进 margins
  led.record({ key: 'w2', success: true, ts: 1 });
  assert.deepEqual(led.stats('w2'), { n: 1, successRate: 1, margins: [] });
  led.record({ key: 'w3', success: true, ts: 1 });
  led.record({ key: 'w3', success: false, ts: 2 });
  assert.deepEqual(led.stats('w3'), { n: 2, successRate: 0.5, margins: [] });
  assert.deepEqual(led.keys().sort(), ['w', 'w2', 'w3']);
});

test('Θ-1p EvidenceLedger：未知名诚实归零 / 垃圾 record 静默 / margins 防御拷贝 / reset', () => {
  const led = new EvidenceLedger();
  assert.deepEqual(led.stats('nope'), { n: 0, successRate: 0, margins: [] });
  // 垃圾输入静默（绝不抛）：非对象 / key 空 / success 缺失 / success 非布尔
  led.record(null as never);
  led.record(undefined as never);
  led.record({ key: '', success: true, ts: 1 });
  led.record({ key: 'x', ts: 1 } as KernelOutcome);
  led.record({ key: 'x', success: 'yes' as unknown as boolean, ts: 1 });
  assert.deepEqual(led.keys(), [], '垃圾输入一条不入账');
  // margins 防御拷贝：篡改返回数组不污染内部滑窗
  led.record({ key: 'm', success: true, margin: 0.5, ts: 1 });
  const stolen = led.stats('m');
  stolen.margins.push(99);
  assert.deepEqual(led.stats('m').margins, [0.5]);
  // reset
  led.reset();
  assert.deepEqual(led.keys(), []);
  assert.deepEqual(led.stats('m'), { n: 0, successRate: 0, margins: [] });
});
