// test/kernel.store.test.ts
// 纪元 Ξ（Ξ-A 进化存档）执法册：save/load/applyTo 全离线往返 ——
// tmp 目录真实文件 IO + 手造 registry/ledger（绝不碰生产单例）：
//   Ξ-S① save→load 三账往返（savedAt 注入 / params / evidence / generations）；
//   Ξ-S② 原子写执法：落盘后目录无 .tmp 残留（多次 save 亦然）；
//   Ξ-S③ 空路径纯内存：save no-op ok:true、load 恒 null、applyTo 恒空；
//   Ξ-S④ 防御读档：文件缺席 / 坏 JSON / 非对象 JSON ⇒ null（绝不抛）；
//   Ξ-S⑤ applyTo：未注册 key 忽略 / 值夹取 / 证据增量补（升与降）/ 代际跳过；
//   Ξ-S⑥ 跨注册表往返：A 落盘 → B（同规格）复载，值与证据计数对齐；
//   Ξ-S⑦ 落盘失败：不可写路径 ok:false 不抛、无 tmp 残留、存档器仍可用；
//   Ξ-S⑧ 部分损坏降级：坏条目剔除、健全条目照常返回；
//   Ξ-S⑨ ledger 参数在场不消费（滑窗不可从平面账重建）；
//   Ξ-S⑩ reset 复位目录一次化标志后 save 照常、覆写语义（旧档被替换）。
// 零网络、零墙钟假设（savedAt 全注入）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { KernelStore, type KernelStateFile } from '../src/kernel/store.ts';
import { KernelRegistry, EvidenceLedger } from '../src/kernel/registry.ts';
import type { KernelParamSpec } from '../src/kernel/registry.ts';

/** 一次性 tmp 目录（finally rmSync 兜底） */
function tmpDir(tag: string): string {
  return mkdtempSync(path.join(tmpdir(), `kernel-store-${tag}-`));
}

/** 测试规格工厂（Θ-1 测试同款缺省 [0,1] / 0.5） */
function spec(key: string, over: Partial<KernelParamSpec> = {}): KernelParamSpec {
  return { key, organ: 'xi-store-test', defaultValue: 0.5, min: 0, max: 1, ...over };
}

/** 摆好两参数的注册表：a（[0,10] 现值 2.5 / 证据 3）+ b（[0,1] 缺省 0.5 / 证据 0） */
function seededRegistry(): KernelRegistry {
  const reg = new KernelRegistry();
  reg.register(spec('a', { min: 0, max: 10 }));
  reg.register(spec('b'));
  reg.set('a', 2.5, 3);
  return reg;
}

// ─── Ξ-S①：save→load 三账往返 ───

test('Ξ-S①: save→load 往返 —— savedAt 注入、params/evidence/generations 逐位对齐、filePath 可读', () => {
  const dir = tmpDir('roundtrip');
  try {
    const file = path.join(dir, 'state.json');
    const store = new KernelStore(file);
    assert.equal(store.filePath, file);
    const ledger = new EvidenceLedger();
    ledger.record({ key: 'a', success: true, ts: 1 }); // ledger 在场：save 不消费、不抛
    const saved = store.save(seededRegistry(), ledger, 424242);
    assert.deepEqual(saved, { ok: true }, 'save 应成功且无 error 字段');
    const state = store.load();
    assert.notEqual(state, null, '落盘后必有档');
    const expect: KernelStateFile = {
      savedAt: 424242,
      params: { a: 2.5, b: 0.5 },
      evidence: { a: 3, b: 0 },
      generations: { a: 0, b: 0 },
    };
    assert.deepEqual(state, expect, '三账逐位对齐（手算：a=2.5/3/0、b=0.5/0/0）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Ξ-S②：原子写执法（无 .tmp 残留） ───

test('Ξ-S②: 原子写 —— 落盘后目录恰一枚 state.json，多次 save 亦无 .tmp 残留', () => {
  const dir = tmpDir('atomic');
  try {
    const file = path.join(dir, 'state.json');
    const store = new KernelStore(file);
    const reg = seededRegistry();
    store.save(reg, new EvidenceLedger(), 1);
    assert.deepEqual(readdirSync(dir), ['state.json'], '首存后目录只有正式档');
    assert.equal(existsSync(file + '.tmp'), false, '无 tmp 残留');
    // 二存（值再漂移）+ 三存：tmp 全程即生即灭
    reg.set('a', 4.5, 5);
    store.save(reg, new EvidenceLedger(), 2);
    store.save(reg, new EvidenceLedger(), 3);
    assert.deepEqual(readdirSync(dir), ['state.json'], '三存后仍只有正式档');
    assert.equal(store.load()!.savedAt, 3, '覆写语义：读到最后一档');
    assert.equal(store.load()!.params.a, 4.5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Ξ-S③：空路径纯内存 no-op ───

test('Ξ-S③: 空路径纯内存 —— filePath null、save no-op ok:true、load 恒 null、applyTo 恒空', () => {
  for (const store of [new KernelStore(), new KernelStore('')]) {
    assert.equal(store.filePath, null, '空路径归一为 null');
    assert.deepEqual(store.save(seededRegistry(), new EvidenceLedger()), { ok: true }, '纯内存 save 是 no-op 成功');
    assert.equal(store.load(), null, '纯内存无档可读');
    const reg = new KernelRegistry();
    reg.register(spec('k'));
    assert.deepEqual(store.applyTo(reg), [], '无档 ⇒ 复载空清单');
    assert.equal(reg.get('k'), 0.5, '注册表未被触碰');
  }
});

// ─── Ξ-S④：防御读档（坏 JSON / 缺席 ⇒ null） ───

test('Ξ-S④: load 防御 —— 文件缺席 / 坏 JSON / 非对象 JSON ⇒ null（绝不抛）', () => {
  const dir = tmpDir('badjson');
  try {
    // 缺席：从未写过
    assert.equal(new KernelStore(path.join(dir, 'absent.json')).load(), null, '文件缺席 ⇒ null');
    // 坏 JSON 与非对象形态：逐个手写（写入用的是 fs 直写，绕过 save 的消毒面）
    for (const [i, content] of ['{oops', '42', '"str"', '[]', 'null'].entries()) {
      const file = path.join(dir, `bad-${i}.json`);
      writeFileSync(file, content, 'utf8');
      assert.equal(new KernelStore(file).load(), null, `坏档 #${i}（${content}）⇒ null`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Ξ-S⑤：applyTo 四律（忽略未注册 / 夹取 / 证据增量 / 代际跳过） ───

test('Ξ-S⑤: applyTo —— 未注册 key 忽略、值经 set 夹取、证据增量补（升与降）、代际跳过', () => {
  const dir = tmpDir('apply');
  try {
    const file = path.join(dir, 'state.json');
    // 手造档：k 越界值 42（现区间 [0,1] ⇒ 应夹到 1）、ghost 未注册、d 证据降向
    writeFileSync(file, JSON.stringify({
      savedAt: 9,
      params: { k: 42, d: 0.25, ghost: 0.5 },
      evidence: { k: 5, d: 1, ghost: 9 },
      generations: { k: 7, d: 3 },
    }), 'utf8');

    const reg = new KernelRegistry();
    reg.register(spec('k'));            // [0,1] 缺省 0.5
    reg.register(spec('d', { min: 0, max: 1 }));
    reg.addEvidence('k'); reg.addEvidence('k'); // k 现证据 2 → 存档 5（升：+3）
    reg.addEvidence('d'); reg.addEvidence('d'); reg.addEvidence('d'); reg.addEvidence('d'); // d 现证据 4 → 存档 1（降：−3）

    const changes = new KernelStore(file).applyTo(reg, new EvidenceLedger());
    // 未注册 ghost 静默忽略；已注册 k/d 皆入清单（含夹取后落值）
    assert.deepEqual(changes, [
      { key: 'k', from: 0.5, to: 1 },   // 42 越界 ⇒ set 夹到上界 1
      { key: 'd', from: 0.5, to: 0.25 },
    ], '回放清单：ghost 不在、k 夹到 1、d 落 0.25');
    assert.equal(reg.get('k'), 1, '夹取后现值 = 1');
    assert.equal(reg.get('d'), 0.25);
    assert.equal(reg.has('ghost'), false, '未注册 key 不被存档凭空入册');
    const kP = reg.list().find(p => p.key === 'k')!;
    const dP = reg.list().find(p => p.key === 'd')!;
    assert.equal(kP.evidence, 5, '证据增量补（升向）：2 + (5−2) = 5');
    assert.equal(dP.evidence, 1, '证据增量补（降向）：4 + (1−4) = 1');
    assert.equal(kP.generation, 0, '代际跳过：registry 无公开写 API，不伪造世系');
    assert.equal(dP.generation, 0, '代际跳过（存档 3 不回放）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Ξ-S⑥：跨注册表往返（A 落盘 → 同规格 B 复载对齐） ───

test('Ξ-S⑥: 跨注册表往返 —— A 的进化成果交棒 B，值与证据计数对齐、清单 from→to 如实', () => {
  const dir = tmpDir('cross');
  try {
    const file = path.join(dir, 'state.json');
    const regA = new KernelRegistry();
    regA.register(spec('p', { min: 0, max: 10 }));
    regA.register(spec('q', { defaultValue: 0.2 }));
    regA.set('p', 3.5, 7); // p：值 3.5 / 证据 7；q：缺省 0.2 / 证据 0
    assert.equal(new KernelStore(file).save(regA, new EvidenceLedger(), 100).ok, true);

    // B：同规格 + 多一颗 r；p 已被本地动过（值 0.5 / 证据 1）⇒ 复载应整体对齐 A
    const regB = new KernelRegistry();
    regB.register(spec('p', { min: 0, max: 10 }));
    regB.register(spec('q', { defaultValue: 0.2 }));
    regB.register(spec('r'));
    regB.set('p', 0.5, 1);

    const changes = new KernelStore(file).applyTo(regB, new EvidenceLedger());
    assert.deepEqual(changes, [
      { key: 'p', from: 0.5, to: 3.5 },
      { key: 'q', from: 0.2, to: 0.2 }, // 值未变也入清单（证据账已补 —— 恢复事件）
    ], '清单只含存档 ∩ 注册（r 不在档）');
    assert.equal(regB.get('p'), 3.5, '值对齐 A');
    assert.equal(regB.list().find(x => x.key === 'p')!.evidence, 7, '证据对齐 A（1 + (7−1)）');
    assert.equal(regB.get('r'), 0.5, '不在档的 r 原样');
    assert.equal(regB.list().find(x => x.key === 'r')!.evidence, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Ξ-S⑦：落盘失败（不抛 / ok:false / 无残留 / 存档器仍可用） ───

test('Ξ-S⑦: save 失败 —— 不可写路径 ok:false 带 error、绝不抛、无 tmp 残留、好路径照常可用', () => {
  const dir = tmpDir('fail');
  try {
    const blocker = path.join(dir, 'blocker');
    writeFileSync(blocker, 'x', 'utf8'); // 文件占位目录名 ⇒ 中间组件非目录
    const doomed = new KernelStore(path.join(blocker, 'state.json'));
    let result: { ok: boolean; error?: string } | null = null;
    assert.doesNotThrow(() => { result = doomed.save(seededRegistry(), new EvidenceLedger()); }, 'save 绝不抛');
    assert.equal(result!.ok, false, '不可写路径 ⇒ ok:false');
    assert.ok(typeof result!.error === 'string' && result!.error.length > 0, 'error 带可读原因');
    assert.equal(existsSync(path.join(blocker, 'state.json.tmp')), false, '失败不留 tmp');
    // 同一 tmp 树里的好路径：存档器无残留状态、照常落盘
    const good = new KernelStore(path.join(dir, 'good.json'));
    assert.deepEqual(good.save(seededRegistry(), new EvidenceLedger(), 5), { ok: true });
    assert.equal(good.load()!.savedAt, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Ξ-S⑧：部分损坏的防御性降级 ───

test('Ξ-S⑧: load 部分损坏降级 —— 坏条目（null/字符串/空 key）剔除、健全条目与 savedAt 垃圾归零照常返回', () => {
  const dir = tmpDir('dirty');
  try {
    const file = path.join(dir, 'state.json');
    writeFileSync(file, JSON.stringify({
      savedAt: 'not-a-number',
      params: { good: 0.5, badNull: null, badStr: 'x', '': 0.9 },
      evidence: { good: 3, badNeg: -2 }, // -2 是有限值：保留（证据地板由 addEvidence 执法）
      generations: { good: 2 },
    }), 'utf8');
    const state = new KernelStore(file).load();
    assert.deepEqual(state, {
      savedAt: 0,
      params: { good: 0.5 },
      evidence: { good: 3, badNeg: -2 },
      generations: { good: 2 },
    }, '健全条目存活、坏条目剔除、savedAt 非法归 0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Ξ-S⑨：ledger 参数在场不消费 ───

test('Ξ-S⑨: save/applyTo 的 ledger 参数在场不消费 —— 滑窗不被读写（接线对称性的诚实面）', () => {
  const dir = tmpDir('ledger');
  try {
    const file = path.join(dir, 'state.json');
    const ledger = new EvidenceLedger();
    ledger.record({ key: 'k', success: true, margin: 0.5, ts: 1 });
    const reg = new KernelRegistry();
    reg.register(spec('k'));
    reg.set('k', 0.8, 2);
    assert.equal(new KernelStore(file).save(reg, ledger, 1).ok, true);
    const fresh = new KernelRegistry();
    fresh.register(spec('k'));
    new KernelStore(file).applyTo(fresh, ledger);
    // ledger 滑窗原样（save 未序列化它、applyTo 未重建它）
    assert.deepEqual(ledger.stats('k'), { n: 1, successRate: 1, margins: [0.5] });
    assert.deepEqual(fresh.list().find(p => p.key === 'k')!.evidence, 2, '证据计数来自注册表三账，与滑窗无关');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Ξ-S⑩：reset + 覆写语义 ───

test('Ξ-S⑩: reset 复位目录一次化标志 —— 复位后 save 照常、目录重建幂等、旧档被新档替换', () => {
  const dir = tmpDir('reset');
  try {
    const file = path.join(dir, 'state.json');
    const store = new KernelStore(file);
    const reg = seededRegistry();
    assert.equal(store.save(reg, new EvidenceLedger(), 1).ok, true);
    store.reset(); // 复位 dirEnsured（测试隔离面）
    reg.set('a', 9, 10);
    assert.equal(store.save(reg, new EvidenceLedger(), 2).ok, true, '复位后首存重建目录保证（幂等）');
    const state = store.load()!;
    assert.equal(state.savedAt, 2, '新档替换旧档');
    assert.equal(state.params.a, 9);
    assert.deepEqual(readdirSync(dir), ['state.json'], '仍无 tmp 残留');
    assert.equal(store.filePath, file, 'reset 不动 filePath（构造事实）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
