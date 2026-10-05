// test/pan49-55.fixes.test.ts
// ΠΑΝ 修复潮执法册（工单 ΠΑΝ-49~55 —— F2-5：kernel 进化 / notary 公证 / prophecy
// 预言 / journal WAL 四面的深层数学与信任缺陷）。本册只做执法锁定：
//   ΠΑΝ-49 canonical 单源收编 —— 病态载荷（深嵌套/环形）全库同律 + 消费点同源
//          锁定（journal/notary/sandbox/log/memory/federation/skillLibrary 六处
//          不得再各自实现 canonical —— C1-9 H1 实证漂移的回归闸）；
//   ΠΑΝ-50 promoteFrom 护栏 —— 步长夹取 / Beta 回归守卫 / 血统记录 / 证据只升
//          不降 + promoteFromCli 通道（dryRun 演习面 / 垃圾注入诚实降级）；
//   ΠΑΝ-51 章②驱逐边界双错判 —— 驱逐+回长（旧虚假绿）与满容锚定+等长回长
//          （旧永久误红）都改判诚实 n/a；base=GENESIS 的缩容判红（真回滚）；
//   ΠΑΝ-52 校准证据语义 —— margin 外生化（对合振荡根除）+ 去删失（低于现值的
//          margin 入账 ⇒ 校准器可降阈）+ 记录点不得按当前阈值过滤（源码锁）；
//   ΠΑΝ-53 TSA/pin 分级 —— 签名验过而败 ⇒ 章③ degraded 黄章（ok 不动）；
//          genTime 倒退超容差 ⇒ 顶层 clockRollback 披露（前拨 ⇒ 仅注记）；
//   ΠΑΝ-54 prophecy 严格配对 —— prophecyId 按号结算（乱序 no-match 降级可观测）；
//          无效动作（success !== true）观察不回灌世界模型；
//   ΠΑΝ-55 journal WAL 深修 —— 逐行哈希校验（损坏行隔离不连坐）/ 轮转上界 /
//          创世记录（机器指纹 + 启动计数 + filePerms 密钥 HMAC —— 同机重写可检测）。
// 全离线：tmp 目录用后即清、注入时钟与种子 CSPRNG、零真网络（假 TSA 自铸密钥）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { canonicalJson, CANONICAL_DEFAULT_MAX_DEPTH } from '../src/dialects/index.ts';
import { journal, inspectJournalWal } from '../src/journal.ts';
import { notary, journalChainHash } from '../src/notary/index.ts';
import { canonicalFederationJson } from '../src/federation/sync.ts';
import { canonicalStringify } from '../src/skillLibrary.signatures.ts';
import {
  KernelRegistry, EvidenceLedger, kernelRegistry, resetKernelRuntime,
} from '../src/kernel/registry.ts';
import { KernelLineage } from '../src/kernel/lineage.ts';
import { KernelCalibrator } from '../src/kernel/calibrator.ts';
import { promoteFromCli } from '../src/kernel/index.ts';
import { ProphecyEngine } from '../src/prophecy/index.ts';
import { derEncode, derRead, derChildren } from '../src/notary/rfc3161.ts';
import type { WorldModel } from '../src/knowledge/contracts.ts';

// ════════════════════ ΠΑΝ-49：canonical 单源收编 ════════════════════

/** 深嵌套制造器：n 层 {child: …} 包裹（depth 0 = 根） */
function deepObj(n: number): Record<string, unknown> {
  let o: Record<string, unknown> = { v: 1 };
  for (let i = 0; i < n; i++) o = { child: o };
  return o;
}

test('ΠΑΝ-49①: canonicalJson 病态载荷守卫 —— 深度上限哨兵 / 真环哨兵 / DAG 合法 / undefined 键过滤 / BigInt 照实抛', () => {
  // 深度上限：64 层内合法序列化；超深 ⇒ **超深子树**降级哨兵（ΝΩ-24 语义：
  // 哨兵落在越界的那个节点上，浅层照常展开 —— 同一载荷每次铸出同一字节，
  // verify 重算同哨兵，链不断）
  const ok64 = deepObj(63); // 根 depth0 … 叶 depth63 ≤ 64
  const s64 = canonicalJson(ok64);
  assert.ok(s64.startsWith('{"child"'), '64 层内正常展开');
  assert.ok(!s64.includes('#unserializable'), '限内无哨兵');
  const deep = canonicalJson(deepObj(70));
  assert.match(deep, /"child":\s*"#unserializable"/, '越界子树降级哨兵（绝不无限递归）');
  assert.equal(deep, canonicalJson(deepObj(70)), '超深载荷确定性稳定（同构重铸逐字节一致 —— 哈希域前提）');
  // maxDepth 选项（合法注入收窄/放宽；非法值回落缺省）
  assert.ok(!canonicalJson(deepObj(70), { maxDepth: 100 }).includes('#unserializable'), '显式放宽 ⇒ 全展开');
  assert.equal(canonicalJson(deepObj(70), { maxDepth: NaN }), deep, '垃圾 maxDepth ⇒ 回落缺省 64');
  assert.equal(CANONICAL_DEFAULT_MAX_DEPTH, 64, '缺省深度上限与 journal ΝΩ-24 同值');

  // 真环 ⇒ 环边落点降级哨兵（根首次入域合法，回到环边时该值降级 —— WeakSet
  // 只记当前路径 ⇒ 序列化稳定、确定性一致）
  const cyc: Record<string, unknown> = { a: 1 };
  cyc.self = cyc;
  assert.equal(canonicalJson(cyc), '{"a":1,"self":"#unserializable"}', '环边落点 ⇒ 哨兵（绝不无限递归）');
  const cyc2: Record<string, unknown> = { a: 1 };
  cyc2.self = cyc2;
  assert.equal(canonicalJson(cyc), canonicalJson(cyc2), '环形载荷确定性稳定（同构同字节）');

  // DAG（同子对象被两键引用、非环）⇒ 合法逐处展开（JSON.stringify 同律）
  const shared = { x: 9 };
  const dag = { p: shared, q: shared };
  assert.equal(canonicalJson(dag), '{"p":{"x":9},"q":{"x":9}}', 'DAG 不误伤（出口即删的路径环检测）');

  // undefined 键与缺键同域（落盘-恢复往返哈希域不变的前提）
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  assert.equal(canonicalJson(undefined), 'null', '顶位 undefined ⇒ null（函数恒返回 string）');

  // 键排序稳定性 + BigInt 照实抛（journal append 防御 catch 依赖此契约）
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.throws(() => canonicalJson({ b: 10n }), 'BigInt ⇒ 照实抛（调用方防御收口）');
});

test('ΠΑΝ-49②: 病态载荷入链全库同律 —— journal 哈希链不断 + notary 章③前缀重走复算同字节（C1-9 H1 回归闸）', async () => {
  // 环形 args：journal 侧以哨兵入哈希域（链不断）——修复前 notary 的无守卫复刻
  // 重算出不同字节 ⇒ 章③永久误红 "re-walk diverges"；单源后逐字节同律 ⇒ 绿。
  journal.configure(true, '', 1000); // 纯内存
  journal.reset();
  notary.reset();
  notary.configure({ endpoint: '', tracePath: '' });
  const cyclicArgs: Record<string, unknown> = { x: 0.5 };
  cyclicArgs.self = cyclicArgs;
  await journal.append({ ts: 1, tool: 'click_mouse', args: { x: 0.1, y: 0.2 }, status: 'SUCCESS' });
  await journal.append({ ts: 2, tool: 'click_mouse', args: cyclicArgs as Record<string, any>, status: 'SUCCESS' });
  await journal.append({ ts: 3, tool: 'click_mouse', args: { deep: deepObj(80) } as Record<string, any>, status: 'SUCCESS' });

  const v = journal.verify();
  assert.equal(v.ok, true, `journal 哈希链对环形/超深 args 不断（实测 brokenAt=${v.brokenAt}）`);

  // 字节级奇偶：notary 的 journalChainHash（章③前缀重走原语）与 journal 自身 verify 同律
  const entries = journal.list(false);
  let prev = 'GENESIS';
  for (const e of entries) {
    assert.equal(e.hash, journalChainHash(prev, e), 'notary 复算与 journal 铸造逐字节一致（含病态载荷行）');
    prev = e.hash as string;
  }

  const a = await notary.anchorOnce({ now: () => 1_735_689_600_000, random: (n) => new Uint8Array(n).fill(7) });
  assert.ok(a, '病态载荷在场不阻铸锚');
  const r = notary.verifyNotary();
  assert.equal(r.badges['chain-integrity'].status, 'green');
  assert.equal(r.badges['mmr-membership'].status, 'green');
  assert.equal(r.badges['timestamp-anchor'].status, 'green', '章③前缀重走对病态载荷复算同哨兵 ⇒ 不误红（H1 修复面）');
  assert.equal(r.ok, true);
});

test('ΠΑΝ-49③: 消费点同源锁定 —— 全库 canonical 实现处一律 import dialects 单源（复刻即打红）', () => {
  const consumers = [
    'src/journal.ts',
    'src/notary/primitives.ts',
    'src/sandbox/log.ts',
    'src/sandbox/memory.ts',
    'src/federation/sync.ts',
    'src/skillLibrary.signatures.ts',
  ];
  for (const rel of consumers) {
    const src = readFileSync(resolve(process.cwd(), rel), 'utf8');
    assert.match(
      src, /import\s*\{[^}]*canonicalJson[^}]*\}\s*from\s*['"][./]*dialects(\/index)?['"]/,
      `${rel} 必须 import dialects 单源 canonicalJson`,
    );
    // 兼容名的薄包装合法、**自持实现非法**：若声明 function canonical，其函数体
    // 必须是 canonicalJson 的直代理（复刻一份排序/环检测/哨兵逻辑 ⇒ 此处打红）。
    const m = src.match(/function\s+canonical\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}/);
    if (m) {
      assert.match(
        m[1]!, /return\s+canonicalJson\(/,
        `${rel} 的 canonical 兼容名必须是 dialects 单源薄代理（不得复刻实现）`,
      );
    }
    const alias = src.match(/const\s+canonical\s*=\s*([^;]+);/);
    if (alias) {
      assert.equal(alias[1]!.trim(), 'canonicalJson', `${rel} 的 canonical 别名必须直指单源`);
    }
  }
  // 方言包装与单源在病态载荷域逐字节同律（再实现即分叉即红）
  const cyc: Record<string, unknown> = { a: 1 };
  cyc.self = cyc;
  const fixtures: unknown[] = [cyc, deepObj(70), { u: 1, v: undefined }, { b: 2, a: [1, { z: 'w' }, true, null] }, 3, 's', null, true];
  for (const f of fixtures) {
    assert.equal(canonicalFederationJson(f), canonicalJson(f), 'federation 方言同律');
    assert.equal(canonicalStringify(f), canonicalJson(f), 'skillLibrary 方言同律');
  }
});

// ════════════════════ ΠΑΝ-50：promoteFrom 护栏 + CLI 通道 ════════════════════

/** 造一枚 [0,1] 区间键（min 0 / max 1 —— 步长限 = maxStepPct × 1 便于手算） */
function reg1(): KernelRegistry {
  const r = new KernelRegistry();
  r.register({ key: 'k.bad', organ: 'demo', defaultValue: 0.5, min: 0, max: 1 });
  r.register({ key: 'k.good', organ: 'demo', defaultValue: 0.5, min: 0, max: 1 });
  return r;
}

/** 往 ledger 灌 n 条（succ 条成功）证据 */
function seedLedger(led: EvidenceLedger, key: string, n: number, succ: number): void {
  for (let i = 0; i < n; i++) led.record({ key, success: i < succ, ts: i });
}

test('ΠΑΝ-50①: 回归守卫 —— lab 证据显著更差 ⇒ 跳过并留审计；血统两套计数器同律；证据只升不降', () => {
  const prod = reg1();
  const prodLed = new EvidenceLedger();
  seedLedger(prodLed, 'k.bad', 40, 36); // 生产率 0.9
  seedLedger(prodLed, 'k.good', 40, 36);
  prod.addEvidence('k.bad'); prod.addEvidence('k.bad'); // k.bad 生产计数 2（证据只升不降的测试基线）
  const lab = reg1();
  lab.set('k.bad', 0.52); // 步长限内（|Δ|=0.02 < 0.1）—— 唯一拦截面是回归守卫
  lab.set('k.good', 0.52);
  const labLed = new EvidenceLedger();
  seedLedger(labLed, 'k.bad', 40, 8); // lab 率 0.2 —— Beta(9,33) 后验 P(<0.9) ≈ 1 ⇒ 拒
  seedLedger(labLed, 'k.good', 40, 38); // lab 率 0.95 —— P(Beta(39,3)<0.9) ≈ 0.44 < 0.9 ⇒ 放行
  const lineage = new KernelLineage();
  let t = 1000;
  const changes = prod.promoteFrom(lab, {
    labLedger: labLed, ledger: prodLed, lineage,
    minLabEvidence: 30, rollbackPosteriorMass: 0.9, now: () => ++t,
  });

  assert.deepEqual(changes.map(c => c.key), ['k.good'], '只有证据健康的键晋升（k.bad 被守卫拦下）');
  assert.equal(prod.get('k.bad'), 0.5, '被拦键现值分毫不动');
  assert.equal(prod.get('k.good'), 0.52, '健康键照常晋升（守卫不误伤）');
  const skips = prod.promoteSkips;
  assert.equal(skips.length, 1);
  assert.equal(skips[0]!.key, 'k.bad');
  assert.match(skips[0]!.reason, /regression-guard/, '跳过理由结构化申报（posterior 读数在场）');

  // 血统同律：现代快照（gen0）+ 新一代（gen1）—— 注册表代与血统代两套计数器合一
  const gens = lineage.generations('k.good');
  assert.equal(gens.length, 2, '晋升登记现代快照 + 新一代');
  assert.equal(gens[0]!.generation, 0);
  assert.equal(gens[1]!.generation, 1);
  assert.equal(gens[1]!.value, 0.52, '新代落值 = 晋升值');
  assert.equal(gens[1]!.fitness, 0.9, 'fitness = 生产窗成功率（诚实来源）');
  assert.equal(prod.list().find(p => p.key === 'k.good')!.generation, 1, '注册表代与血统最新代同值');
  assert.equal(lineage.generations('k.bad').length, 0, '被拦键不留血统（未发生换血）');

  // 证据只升不降（registry 计数面）：生产 2 → lab 3 ⇒ 3 → lab 10 ⇒ 10 → lab 1 ⇒ 仍 10
  //（旧语义「取 lab 的」会把生产累计覆写成实验室小样本 —— C1-9 M2 的第 4 罪状）
  const lab3 = reg1();
  lab3.set('k.bad', 0.51, 3);
  prod.promoteFrom(lab3, { keys: ['k.bad'] });
  assert.equal(prod.list().find(p => p.key === 'k.bad')!.evidence, 3, 'max(生产 2, lab 3) = 3');
  const lab10 = reg1();
  lab10.set('k.bad', 0.52, 10);
  prod.promoteFrom(lab10, { keys: ['k.bad'] });
  assert.equal(prod.list().find(p => p.key === 'k.bad')!.evidence, 10, '只升不降（3 → 10）');
  const lab1 = reg1();
  lab1.set('k.bad', 0.53, 1);
  prod.promoteFrom(lab1, { keys: ['k.bad'] });
  assert.equal(prod.list().find(p => p.key === 'k.bad')!.evidence, 10, 'max(生产 10, lab 1) = 10 —— 生产累计不被实验室小样本覆写');
});

test('ΠΑΝ-50②: promoteFromCli —— 全副护栏直达 / dryRun 不动生产单例 / 垃圾注入诚实降级不抛', () => {
  resetKernelRuntime();
  try {
    kernelRegistry.register({ key: 'demo.cli', organ: 'demo', defaultValue: 0.5, min: 0, max: 1 });
    const lab = new KernelRegistry();
    lab.register({ key: 'demo.cli', organ: 'demo', defaultValue: 0.5, min: 0, max: 1 });
    lab.set('demo.cli', 0.95); // 远距：单步 0.1 ⇒ 只走 0.5 → 0.6

    // dryRun：同一护栏判定但落值进影子册 —— 生产单例分毫不动
    const before = kernelRegistry.snapshot();
    const dry = promoteFromCli(lab, { dryRun: true });
    assert.equal(dry.ok, true);
    assert.equal(dry.promoted[0]!.to, 0.6, '演习面照常执行步长夹取判定');
    assert.equal(dry.lineageGenerations, 0, '演习不登记血统代');
    assert.deepEqual(kernelRegistry.snapshot(), before, 'dryRun 后生产 snapshot 逐字节不变');

    // 实弹：通道走完 + 血统账在场
    const real = promoteFromCli(lab);
    assert.equal(real.ok, true);
    assert.equal(real.promoted[0]!.to, 0.6, '生产单例被推进一小步（0.5 → 0.6）');
    assert.equal(kernelRegistry.get('demo.cli'), 0.6);
    assert.equal(real.lineageGenerations, 1, '实弹晋升登记血统代');

    // 垃圾注入：非 KernelRegistry ⇒ ok:false + error（绝不抛 —— CLI 退出码语义清晰）
    const bad = promoteFromCli({} as never);
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? '', /not a KernelRegistry/);
    const bad2 = promoteFromCli(null as never, { maxStepPct: 'x' as never });
    assert.equal(bad2.ok, false, '垃圾 opts 不炸通道（护栏消毒在 promoteFrom 内回落缺省）');
  } finally {
    resetKernelRuntime();
  }
});

// ════════════════════ ΠΑΝ-51：章②驱逐边界双错判 ════════════════════

/** 小容量 journal + 铸一枚本地锚（确定性时钟与 nonce） */
async function anchorTinyJournal(capacity: number, seedN: number): Promise<void> {
  journal.configure(true, '', capacity);
  journal.reset();
  notary.reset();
  notary.configure({ endpoint: '', tracePath: '' });
  for (let i = 0; i < seedN; i++) {
    await journal.append({ ts: 1_700_000_000 + i, tool: 'click_mouse', args: { x: 0.1 * (i + 1), y: 0.5 }, status: 'SUCCESS' });
  }
  const a = await notary.anchorOnce({ now: () => 1_735_689_600_000, random: (n) => new Uint8Array(n).fill(11) });
  assert.ok(a, '铸锚成功');
}

async function appendMore(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await journal.append({ ts: 1_800_000_000 + i, tool: 'click_mouse', args: { x: 0.9, y: 0.1 }, status: 'SUCCESS' });
  }
}

test('ΠΑΝ-51①: 驱逐+回长（长度反超锚 seq）⇒ 章②诚实 n/a —— 旧「增长世界」虚假绿封死', async () => {
  // 容量 6：锚 seq=4 → 灌 6 条（驱逐 4 条、回长到 6 > 4）。旧判据走增长分支对
  // 当前存活 index 3（另一条全局条目）铸证对当前根验证 ⇒ 恒绿（被锚条目根本
  // 不在窗口）。修复后 base≠GENESIS ⇒ n/a + 重新锚定提示。
  await anchorTinyJournal(6, 4);
  await appendMore(6);
  assert.equal(journal.list(false).length, 6, '灌满回长到容量');
  assert.notEqual(journal.base, 'GENESIS', '驱逐事实在场（链基前滚）');
  const r = notary.verifyNotary();
  const b2 = r.badges['mmr-membership'];
  assert.equal(b2.status, 'n/a', '驱逐后的回长段是新前缀 —— 旧锚既不可证绿也不可证红');
  assert.match(b2.detail, /capacity eviction|not determinable/, '驱逐边界如实申报');
  assert.match(b2.detail, /mint a fresh anchor/, '重新锚定开新前缀的提示在场');
  assert.equal(r.ok, true, 'n/a 不翻红（诚实降级 ≠ 指控篡改）');
});

test('ΠΑΝ-51②: 满容锚定+等长回长（length === seq）⇒ 章②诚实 n/a —— 旧「静止世界」永久误红封死', async () => {
  // 容量 6：锚 seq=6（满容）→ 追加 2 条（各驱逐一条、长度仍 6）。旧判据
  // entries.length === last.seq 走静止分支：对回长段新末条以旧锚根验证 ⇒ 必败
  // 恒红 "journal prefix rewritten"（detail 误指篡改）。修复后同走 n/a。
  await anchorTinyJournal(6, 6);
  await appendMore(2);
  assert.equal(journal.list(false).length, 6, '等长回长（6 === 锚 seq）');
  const r = notary.verifyNotary();
  assert.equal(r.badges['mmr-membership'].status, 'n/a', '等长回长不再误红 —— 驱逐判据以链基为准');
  assert.equal(r.ok, true, '无误报篡改');
  // 对照组：未驱逐世界的等长静止仍精确执法（绿）
  await anchorTinyJournal(50, 5);
  const r2 = notary.verifyNotary();
  assert.equal(r2.badges['mmr-membership'].status, 'green', '无驱逐时静止世界照旧对锚根验证（绿）');
});

test('ΠΑΝ-51③: base=GENESIS 却条数少于锚 seq ⇒ 章②红（真回滚）—— 未驱逐时缩容只有回滚一种解释', async () => {
  await anchorTinyJournal(50, 5);
  journal.reset(); // 清空回滚（链基回 GENESIS）
  for (let i = 0; i < 3; i++) {
    await journal.append({ ts: 1_900_000_000 + i, tool: 'click_mouse', args: { x: 0.2, y: 0.3 }, status: 'SUCCESS' });
  }
  const r = notary.verifyNotary();
  assert.equal(r.badges['mmr-membership'].status, 'red', '无驱逐记录的缩水 = 账本回滚（红，不再是旧「驱逐」n/a 误标）');
  assert.match(r.badges['mmr-membership'].detail, /rolled back or reset/);
  assert.equal(r.ok, false);
});

// ════════════════════ ΠΑΝ-52：校准证据语义（margin 外生 + 去删失） ════════════════════

test('ΠΑΝ-52①: 外生 margin 收敛仿真 —— 去删失证据可降阈、单调走近判别分位、到点即稳（对合振荡根除）', () => {
  // 证据面：40 条 (margin, success) 真标签，判别分位在 (0.44, 0.55) 的间隙里。
  // 现值 0.8 ⇒ 20 条低于现值的样本在旧删失结构下根本不入账（低于置信门不执行/
  // 不记录）⇒ 阈学习只见 ≥0.8 区间 ⇒ 永远无法降阈（单向棘轮）。去删失后这些
  // 样本在册 ⇒ optimalThreshold 学得唯一分离点 (0.44+0.55)/2，校准器逐 tick 走近。
  const registry = new KernelRegistry();
  registry.register({ key: 'demo.match', organ: 'policy', defaultValue: 0.8, min: 0.3, max: 0.9 });
  const ledger = new EvidenceLedger();
  for (let i = 0; i < 20; i++) ledger.record({ key: 'demo.match', success: false, margin: 0.25 + 0.01 * i, ts: i }); // 0.25..0.44
  for (let i = 0; i < 20; i++) ledger.record({ key: 'demo.match', success: true, margin: 0.55 + 0.01 * i, ts: 40 + i }); // 0.55..0.74
  const margins = ledger.stats('demo.match').margins;
  assert.ok(margins.some(m => m < 0.8), '低于现值的 margin 在册（去删失的前置事实）');

  const cal = new KernelCalibrator({
    registry, ledger, lineage: new KernelLineage(),
    safetyCriticalKeys: [], now: () => 42,
  });
  const expectedT = (0.25 + 0.01 * 19 + (0.55 + 0.01 * 0)) / 2; // 与实现同一浮点算式
  const values: number[] = [];
  let firstReport: unknown = null;
  for (let tick = 0; tick < 12; tick++) {
    const reports = cal.tick();
    if (tick === 0) firstReport = reports[0] ?? null;
    values.push(registry.get('demo.match') as number);
  }
  assert.ok(firstReport, '首 tick 有换血报告');
  assert.match(String((firstReport as { reason: string }).reason), /optimal-threshold/, '阈学习报告');
  assert.equal(String((firstReport as { labelSource: string }).labelSource), 'records', '真逐样本标签（ΑΩ-R39）');

  assert.equal(values[0] < 0.8, true, '首 tick 即降阈（去删失让「降」决策第一次有数据面）');
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i]! <= values[i - 1]!, `单调不升（tick ${i}：${values[i - 1]} → ${values[i]}）—— 对合振荡（x → q − x 的来回换向）不存在`);
  }
  assert.equal(values[values.length - 1], expectedT, '终值 = 外生判别分位（手算 (0.44+0.55)/2）');
  const stableTicks = values.filter(v => v === expectedT).length;
  assert.ok(stableTicks >= 5, `到点后保持稳定（实测 ${stableTicks} tick 不动 —— 内生反馈的结构性翻转已根除）`);
  assert.deepEqual(cal.tick(), [], '稳态 tick 零报告（不再空转）');
});

test('ΠΑΝ-52②: 记录点源码锁 —— 免费证据不得按当前阈值过滤（matchConfident 删失面）+ margin 外生申报在场', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/tools/autonomousRun.ts'), 'utf8');
  assert.ok(!src.includes("getOrDefault('policy.matchConfident'"), '记账路径不读置信门（读门在 policyEngine 决策面 —— 记录面按 outcome 全样本入账）');
  assert.match(src, /ΠΑΝ-52（去删失 · 双向证据）/, '去删失立法注释在场');
  assert.match(src, /ΠΑΝ-52（margin 去内生）/, 'margin 外生化立法注释在场');
  assert.match(src, /margin:\s*truth\.distance/, 'hammingTolerance 的 margin = 原始 dhash 距离（外部观测量）');
});

// ════════════════════ ΠΑΝ-53：TSA 签名/pin 分级 + 时间回拨披露 ════════════════════
//（最小 CMS 构造面 —— 与 aor5 执法册同律的测试侧独立复刻，双执法）

const enc = new TextEncoder();
function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
const dInt = (bytes: number[]) => derEncode(0x02, Uint8Array.from(bytes));
const dOid = (arms: number[]) => derEncode(0x06, Uint8Array.from(arms));
const dOct = (b: Uint8Array) => derEncode(0x04, b);
const dSeq = (...p: Uint8Array[]) => derEncode(0x30, cat(...p));
const dSet = (...p: Uint8Array[]) => derEncode(0x31, cat(...p));
const dA0 = (b: Uint8Array) => derEncode(0xa0, b);
const SHA256_ARMS = [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];
const RSA_ENC_ARMS = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const ID_SIGNED_DATA_ARMS = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02];
const ID_CT_TSTINFO_ARMS = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x01, 0x04];
const ATTR_MSG_DIGEST_ARMS = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x04];
const ATTR_CONTENT_TYPE_ARMS = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x03];
const CN_ARMS = [0x55, 0x04, 0x03];

const rsaMain = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaSpki = new Uint8Array(rsaMain.publicKey.export({ format: 'der', type: 'spki' }));
const rsaForger = generateKeyPairSync('rsa', { modulusLength: 2048 });
const NAME = dSeq(dSeq(dOid(CN_ARMS), derEncode(0x13, enc.encode('Mock TSA'))));

function buildCert(spkiDer: Uint8Array): Uint8Array {
  const validity = dSeq(derEncode(0x17, enc.encode('260102030405Z')), derEncode(0x17, enc.encode('350102030405Z')));
  const tbs = dSeq(dInt([0x01]), dSeq(dOid(RSA_ENC_ARMS)), NAME, validity, NAME, spkiDer);
  return dSeq(tbs, dSeq(dOid(RSA_ENC_ARMS)), derEncode(0x03, Uint8Array.of(0x00)));
}

function buildTstInfo(digest: Uint8Array, nonce: Uint8Array, genTimeText: string): Uint8Array {
  return dSeq(
    dInt([1]), dOid(ID_CT_TSTINFO_ARMS),
    dSeq(dSeq(dOid(SHA256_ARMS)), dOct(digest)),
    dInt([0x0a]),
    derEncode(0x18, enc.encode(genTimeText)),
    derEncode(0x02, nonce),
  );
}

/** 签名 CMS token（signedAttrs 形态 —— 真 TSA 常态）；priv 可换伪造者钥 */
function buildCms(digest: Uint8Array, nonce: Uint8Array, genTimeText: string, priv: KeyObject, spki: Uint8Array): Uint8Array {
  const tst = buildTstInfo(digest, nonce, genTimeText);
  const md = createHash('sha256').update(tst).digest();
  const attrs = cat(
    dSeq(dOid(ATTR_CONTENT_TYPE_ARMS), dSet(dOid(ID_CT_TSTINFO_ARMS))),
    dSeq(dOid(ATTR_MSG_DIGEST_ARMS), dSet(dOct(md))),
  );
  const signature = new Uint8Array(sign('sha256', derEncode(0x31, attrs), priv));
  const signerInfo = dSeq(dInt([1]), dSeq(NAME, dInt([0x01])), dSeq(dOid(SHA256_ARMS)), dA0(attrs), dSeq(dOid(RSA_ENC_ARMS)), dOct(signature));
  const signedData = dSeq(dInt([1]), dSet(dSeq(dOid(SHA256_ARMS))), dSeq(dOid(ID_CT_TSTINFO_ARMS), dA0(dOct(tst))), dA0(buildCert(spki)), dSet(signerInfo));
  return dSeq(dOid(ID_SIGNED_DATA_ARMS), dA0(signedData));
}

/** 假 TSA：从请求 DER 取 digest+nonce 回完整 token（genTime / 签名钥可注入） */
function fakeTsa(genTimeText: string, priv: KeyObject = rsaMain.privateKey, spki: Uint8Array = rsaSpki): typeof fetch {
  return (async (_url: unknown, init: { body: Uint8Array }) => {
    const req = init.body;
    const kids = derChildren(derRead(req)!, req);
    const imprintKids = derChildren(kids[1]!, req);
    const digest = new Uint8Array(req.subarray(imprintKids[1]!.contentStart, imprintKids[1]!.contentEnd));
    const nonce = new Uint8Array(req.subarray(kids[2]!.contentStart, kids[2]!.contentEnd));
    const token = buildCms(digest, nonce, genTimeText, priv, spki);
    const reply = dSeq(dSeq(dInt([0])), token); // PKIStatusInfo{granted} + token
    return {
      ok: true, status: 200,
      arrayBuffer: async () => reply.buffer.slice(reply.byteOffset, reply.byteOffset + reply.byteLength) as ArrayBuffer,
    };
  }) as unknown as typeof fetch;
}

/** 2025-01-01T00:00:00Z —— 锚定注入钟 */
const NOW = 1_735_689_600_000;
const seededRandom = (n: number) => new Uint8Array(n).map((_, i) => (i + 5) & 0x7f || 0x01);

async function seedCleanJournal(n: number): Promise<void> {
  journal.configure(true, '', 1000);
  journal.reset();
  for (let i = 0; i < n; i++) {
    await journal.append({ ts: 1_700_000_000 + i, tool: 'click_mouse', args: { x: 0.5, y: 0.5 }, status: 'SUCCESS' });
  }
}

test('ΠΑΝ-53①: TSA 签名验过而败 ⇒ 章③ degraded 黄章（绑定在场、背书未证；ok 聚合面不动）', async () => {
  notary.reset();
  notary.configure({ endpoint: '', tracePath: '' });
  await seedCleanJournal(2);
  // 伪造者钥签名（证书嵌正主张 —— 恶意 endpoint 形态）：imprint+nonce 绑定成立、
  // 签名数学不成立。旧语义一行注记吞掉 ⇒ 四绿；ΠΑΝ-53 升为黄章。
  const a = await notary.anchorOnce({
    endpoint: 'https://evil.example/tsr', fetchImpl: fakeTsa('20250101030405Z', rsaForger.privateKey, rsaSpki),
    now: () => NOW, random: seededRandom,
  });
  assert.ok(a);
  assert.equal(a.timestamp.signatureVerified, false, '领取时判决随锚入册（验过而败）');
  const r = notary.verifyNotary();
  assert.equal(r.badges['timestamp-anchor'].status, 'degraded', '签名失败 ⇒ 黄章（不再是注记级全绿）');
  assert.equal(r.ok, true, '黄 ≠ 红 —— 不指控篡改（imprint+nonce 绑定维度在场）');
  assert.match(r.badges['timestamp-anchor'].detail, /FAILED/, '失败事实在 detail 申报');
});

test('ΠΑΝ-53②: genTime 倒退超容差 ⇒ 顶层 clockRollback 披露；前拨 ⇒ 仅注记不披露（方向性执法）', async () => {
  // 倒退：genTime 2020（落后锚钟 ~5 年）—— 本地钟被前拨/回拨的时钟证据
  notary.reset();
  notary.configure({ endpoint: '', tracePath: '' });
  await seedCleanJournal(2);
  await notary.anchorOnce({ endpoint: 'https://tsa.example/tsr', fetchImpl: fakeTsa('20200102030405Z'), now: () => NOW, random: seededRandom });
  const back = notary.verifyNotary();
  assert.notEqual(back.clockRollback, null, '倒退超差 ⇒ 顶层披露（不读 detail 的下游不再盲区）');
  assert.equal(back.clockRollback!.anchorIndex, 0);
  assert.ok(back.clockRollback!.skewMs < 0, '方向为倒退（skew = genTime − anchoredAt < 0）');
  assert.equal(back.clockRollback!.anchoredAt, NOW);
  assert.equal(back.badges['timestamp-anchor'].status, 'green', '回拨是注记级（不翻章不降级 —— 披露面独立执法）');
  assert.match(back.badges['timestamp-anchor'].detail, /genTime-skew/);

  // 前拨：genTime 2026（超前 ~1 年）—— 偏差注记在场，但不是回拨证据 ⇒ 不披露
  notary.reset();
  notary.configure({ endpoint: '', tracePath: '' });
  await seedCleanJournal(2);
  await notary.anchorOnce({ endpoint: 'https://tsa.example/tsr', fetchImpl: fakeTsa('20260102030405Z'), now: () => NOW, random: seededRandom });
  const fwd = notary.verifyNotary();
  assert.equal(fwd.clockRollback, null, '前拨方向 ⇒ 不披露（只有倒退是回拨证据）');
  assert.match(fwd.badges['timestamp-anchor'].detail, /genTime-skew/, '偏差注记照常在场');
  assert.equal(fwd.badges['timestamp-anchor'].status, 'green');
});

// ════════════════════ ΠΑΝ-54：prophecy 严格配对 + 动作有效性 ════════════════════

/** 世界模型间谍：只数 observe 回灌（predict 恒无知 ⇒ mint 走 no-model 直通） */
class SpyWorld implements WorldModel {
  observes: Array<[string, string, string, boolean]> = [];
  typeOf(): string | null { return null; }
  observe(from: string, action: string, to: string, success: boolean) {
    this.observes.push([from, action, to, success]);
    return { ok: true as const, value: undefined };
  }
  predict() { return { ok: true as const, value: null }; }
  surprise() { return { ok: false as const, error: { kind: 'spy', message: 'no surprise face' } as never }; }
}

test('ΠΑΝ-54①: prophecyId 严格配对 —— 按号结算不张冠李戴；乱序/重复 ⇒ no-match 降级可观测', () => {
  const spy = new SpyWorld();
  const eng = new ProphecyEngine({ worldModel: spy, now: () => 1000 });
  const HEX = 'aaaaaaaaaaaaaaaa';
  const idA = eng.mint(HEX, 'click@11');
  const idB = eng.mint('bbbbbbbbbbbbbbbb', 'click@22');
  assert.ok(idA !== null && idB !== null && idA !== idB, '铸造发号（单调、非空屏型）');

  // 乱序结算：B 的见证先到（带 B 的号）⇒ 只动 B —— A 动作的结果绝不记到 B 头上
  const settledB = eng.settle('cccccccccccccccc', true, idB);
  assert.equal(settledB?.actionKey, 'click@22', '按号配对命中 B');
  const settledA = eng.settle('dddddddddddddddd', true, idA);
  assert.equal(settledA?.actionKey, 'click@11', 'A 的见证后到照常结算（乱序无罪）');

  // 重复/未知号 ⇒ no-match 诚实降级（计数可观测 —— C1-9 M5「错配不可观测」清偿）
  assert.equal(eng.settle('eeeeeeeeeeeeeeee', true, idA), null, '已结算的号再结算 ⇒ null');
  assert.equal(eng.settle('eeeeeeeeeeeeeeee', true, 9999), null, '未知号 ⇒ null（绝不转嫁给其他挂起预言）');
  assert.equal(eng.stats().noMatch, 2, '失配计数入统计面');
  assert.equal(eng.stats().pending, 0);
});

test('ΠΑΝ-54②: 动作有效性闸 —— success !== true 的观察不回灌世界模型（审计照铸）', () => {
  const spy = new SpyWorld();
  const eng = new ProphecyEngine({ worldModel: spy, now: () => 2000 });
  const HEX = 'aaaaaaaaaaaaaaaa';
  const id = eng.mint(HEX, 'click@00');
  assert.ok(id !== null);

  // 无效动作（success === false）：结算记录照铸（审计完整）但 observe 零调用
  const rec = eng.settle('cccccccccccccccc', false, id);
  assert.ok(rec, '无效动作的结算记录照铸（审计与学习分道）');
  assert.equal(spy.observes.length, 0, '无效动作后的屏幕不是该动作的转移证据 —— 不回灌');

  // 缺省 success（undefined）：视为未证有效 —— 同不回灌（旧「缺省按成功」口径废弃）
  const id2 = eng.mint(HEX, 'click@01') as number;
  const rec2 = eng.settle('dddddddddddddddd', undefined, id2);
  assert.ok(rec2, '结算照铸');
  assert.equal(spy.observes.length, 0, '未证有效 ⇒ 不回灌（停滞世界不再学自我转移）');

  // 有效动作（success === true）：三写回灌 {原始, 量化, 粗格}（去重后 3 键）
  const id3 = eng.mint(HEX, 'click@02') as number;
  const rec3 = eng.settle('ffffffffffffffff', true, id3);
  assert.ok(rec3);
  assert.equal(spy.observes.length, 3, 'exact + quant + coarse 三写（from 侧去重）');
  // ΑΩ-R18 语义：to 侧一律**量化身份**入表（表内键与铸造梯级/结算比对同一把尺）
  assert.ok(spy.observes.every(([, , to]) => to === 'ffffffffffff0000'), 'to 侧 = 量化身份（低 4 hex 掩没）');
  assert.ok(spy.observes.every(([from]) => from === HEX || from === 'aaaaaaaaaaaa0000' || from === 'aaaaaaaa'), 'from 侧三键如法');
});

test('ΠΑΝ-54③: 无号 LIFO 兼容面 —— 单挂起宿主（autoPilot 形态）结算最近铸造', () => {
  const spy = new SpyWorld();
  const eng = new ProphecyEngine({ worldModel: spy, now: () => 3000 });
  eng.mint('aaaaaaaaaaaaaaaa', 'click@11');
  const settled = eng.settle('cccccccccccccccc', true); // 无号 ⇒ LIFO（既有宿主零改动）
  assert.equal(settled?.actionKey, 'click@11');
  assert.equal(eng.stats().noMatch, 0, '无号路径不计失配');
});

// ════════════════════ ΠΑΝ-55：journal WAL 深修 ════════════════════

test('ΠΑΝ-55①: WAL 逐行哈希校验 —— 完好行全过 / 单行损坏隔离不连坐 / 断链单独申报', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pan55-a-'));
  try {
    const jPath = join(dir, 'j.jsonl');
    journal.configure(true, jPath, 1000);
    journal.reset();
    for (let i = 0; i < 3; i++) {
      const r = journal.appendPreDispatch('click_mouse', { x: 0.1 * (i + 1), y: 0.5 });
      assert.equal(r.ok, true, `第 ${i + 1} 行先行落盘成功`);
    }
    const walPath = jPath + '.wal';
    assert.ok(existsSync(walPath), 'WAL 文件在场');

    // 基线：genesis + 3 审计行全过（创世 mac 用本机密钥可判）
    const clean = inspectJournalWal(walPath);
    assert.equal(clean.ok, true);
    assert.equal(clean.lines, 4, '创世 + 3 行');
    assert.equal(clean.valid, 4);
    assert.equal(clean.quarantined, 0);
    assert.ok(clean.genesis, '创世记录读数在场');
    assert.equal(clean.genesis!.boot, 1, '首铸启动计数 = 1');
    assert.match(clean.genesis!.machine, /^[0-9a-f]{16}$/, '机器指纹 16 hex（hostname|platform|arch|user）');
    assert.equal(clean.genesis!.mac, true, 'filePerms 密钥 HMAC 复算一致（同机可判）');

    // 单行损坏（中行 args 被改一字节）：该行隔离（hash-mismatch），前后行照常过验
    const pristine = readFileSync(walPath, 'utf8').split('\n').filter(l => l !== '');
    const rows = pristine.slice();
    const tampered = JSON.parse(rows[2]!) as { tool: string };
    tampered.tool = 'type_text';
    rows[2] = JSON.stringify(tampered);
    writeFileSync(walPath, rows.join('\n') + '\n');
    const q = inspectJournalWal(walPath);
    assert.equal(q.ok, false);
    assert.equal(q.quarantined, 1, '只有被改的行进隔离（不连坐）');
    assert.equal(q.quarantinedLines[0]!.line, 2, '0 基行号定位');
    assert.equal(q.quarantinedLines[0]!.seq, 2, '审计序号随隔离申报');
    assert.match(q.quarantinedLines[0]!.reason, /hash-mismatch/);
    assert.equal(q.valid, 3, 'genesis + 第 1/3 行照常过验（前一行完好 ⇒ 链对照不受损行牵连）');
    const lastRow = JSON.parse(rows[3]!) as { wal_hash: string };
    assert.equal(q.walTip, lastRow.wal_hash, '链尖 = 最末有效行（续链锚点不受损行影响）');

    // 断链：恢复完好档后删除中行 ⇒ 后行 prev_wal 对不上前行 wal_hash ⇒
    // chain-discontinuity 单独申报（与哈希损坏分型；受损行的后继豁免链对照）
    const dropped = pristine.filter((_, i) => i !== 1);
    writeFileSync(walPath, dropped.join('\n') + '\n');
    const d = inspectJournalWal(walPath);
    assert.equal(d.quarantined, 1);
    assert.match(d.quarantinedLines[0]!.reason, /chain-discontinuity/, '断链形态与哈希损坏分型申报');
    assert.equal(d.valid, 2, 'genesis + 末行过验（被删行的后继豁免链对照 —— 不连坐）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ΠΑΝ-55②: WAL 创世 HMAC —— 同机整档重写可检测（mac=false 披露且不连坐行判）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pan55-b-'));
  try {
    const jPath = join(dir, 'j.jsonl');
    journal.configure(true, jPath, 1000);
    journal.reset();
    journal.appendPreDispatch('click_mouse', { x: 0.5, y: 0.5 });
    const walPath = jPath + '.wal';

    // 攻击者重造 WAL 史：重写 genesis 行但铸不出合法 genesis_mac（无 .key 读权）
    const rows = readFileSync(walPath, 'utf8').split('\n').filter(l => l !== '');
    const g = JSON.parse(rows[0]!) as Record<string, unknown> & { genesis_mac: string };
    g.genesis_mac = '00'.repeat(32); // 伪造 mac（wal_hash 域不含 genesis_mac ⇒ 行自验仍过）
    rows[0] = JSON.stringify(g);
    writeFileSync(walPath, rows.join('\n') + '\n');
    const r = inspectJournalWal(walPath);
    assert.equal(r.quarantined, 0, 'mac 失败不是行损坏（不连坐审计行）');
    assert.equal(r.genesis!.mac, false, '同机重写证据：HMAC 复算不一致 ⇒ mac=false 顶层披露');
    assert.equal(r.ok, true, '行级全部完好（重写证据另立字段申报 —— 两维度分治）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ΠΑΝ-55③: WAL 轮转上界 —— 2MB 阈值先轮转再追加（.wal.1 退役、当前代从创世重开）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pan55-c-'));
  try {
    const jPath = join(dir, 'j.jsonl');
    const walPath = jPath + '.wal';
    // 预置 2.2MB 旧档（任意字节 —— 轮转只看尺寸；模拟长会话 WAL 增长到界）
    writeFileSync(walPath, 'x'.repeat(2_200_000));
    journal.configure(true, jPath, 1000);
    journal.reset();
    const r = journal.appendPreDispatch('click_mouse', { x: 0.5, y: 0.5 });
    assert.equal(r.ok, true, '轮转是旁路义务 —— 追加照常成功');
    assert.ok(existsSync(walPath + '.1'), '退役代右移为 .wal.1');
    assert.ok(statSync(walPath + '.1').size > 2_000_000, '退役代承载旧档全量');
    assert.ok(statSync(walPath).size < 100_000, '当前代从创世重开（磁盘面有界：≤2MB + 两代保留）');
    const insp = inspectJournalWal(walPath);
    assert.equal(insp.ok, true, '轮转后新代自洽（genesis + 新审计行）');
    assert.equal(insp.genesis!.boot, 1, '退役代无创世行 ⇒ 接班计数从 1 起');
    assert.ok(!existsSync(walPath + '.2'), '保留两代（.2 尚未产生）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ΠΑΝ-55④: 隔离报告上界 —— 50 行封顶 + 汇总行申报（内存有界承诺）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pan55-d-'));
  try {
    const walPath = join(dir, 'j.jsonl.wal');
    const junk = Array.from({ length: 60 }, (_, i) => JSON.stringify({ i, junk: true }) + ' <corrupted>');
    writeFileSync(walPath, junk.join('\n') + '\n');
    const r = inspectJournalWal(walPath);
    assert.equal(r.lines, 60);
    assert.equal(r.quarantined, 60, '全部损坏行计入总数');
    assert.equal(r.quarantinedLines.length, 51, '报告面 50 行 + 1 汇总行');
    assert.match(r.quarantinedLines[50]!.reason, /capped at 50/, '超出上界以汇总申报');
    assert.equal(r.quarantinedLines[50]!.line, -1, '汇总行行号哨兵');
    assert.equal(r.ok, false);
    // 无路径 / 读不得 ⇒ 诚实回执（绝不抛）
    assert.equal(inspectJournalWal('').error, 'no wal path configured');
    const missing = inspectJournalWal(join(dir, 'nope.wal'));
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? '', /wal unreadable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
