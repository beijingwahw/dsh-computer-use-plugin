// test/t2-10.sandboxM.test.ts
// ΤΕΛ-13（D-G16 留案 M3/M7/M8 三项独立立法的执法册）：
//   · M3（安全）门3 医生否决钉住 —— 256-FIFO 主缓存被普通流量挤出后，
//     rejected 判决仍在钉面拦截重放（旧病灶：latest===undefined 即放行）；
//   · M7（可维护性）肌肉记忆库遗忘淘汰 —— 容量上界 + 宿主重放崩塌除名 +
//     逐出台账（旧病灶：清除面完全缺席、污染只增不减）；
//   · M8（正确性）排练弃权语义 —— 场景角色贫乏（生产 uiMemory 供源常态）时
//     「未申报能力」是诚实缺席（null 弃权）不是世界反证（旧病灶：低可靠宏
//     被结构性误拒）；申报过角色/能力布尔的场景保持既有严格语义零回归。
// 纪律：绝不抛/诚实降级/fail-closed；纯弃权链仍 degraded 拒绝（宽纵红线不越）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { SandboxEngineImpl } from '../src/sandbox/engine.ts';
import { deterministicReplay } from '../src/sandbox/engine.ts';
import { MuscleMemoryStore, MUSCLE_MEMORY_MAX_ENTRIES } from '../src/sandbox/memory.ts';
import { VirtualScreen, asVirtualWidget } from '../src/sandbox/virtualScreen.ts';
import { buildVirtualScene, MacroRehearsalGate } from '../src/sandbox/macroRehearsal.ts';
import { sandboxLog } from '../src/sandbox/log.ts';
import { makeScore, type DoctorVerdictPayload } from '../src/doctorEvents.ts';
import { createDefaultIdGenerator, muscleReliability, type SandboxAction } from '../src/sandbox/types.ts';
import type { SkillStep } from '../src/skillLibrary.signatures.ts';

beforeEach(() => { sandboxLog.reset(); });

// ── 公共工坊 ──

const CLICK: SandboxAction = { kind: 'click_mouse', args: { x: 0.2, y: 0.15, target_description: 'save button' } };
const RICH_SCENE = [{ role: 'button', name: 'save', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } }];

function verdict(subject: string, v: DoctorVerdictPayload['verdict']): DoctorVerdictPayload {
  return { subject, chainTip: 'tip', verdict: v, score: makeScore(50)! };
}

/** 铸一条已固化肌肉记忆（排练 passed + 医生 approved ⇒ 入库），返回 entryId */
async function mintEntry(eng: SandboxEngineImpl, chainId: string): Promise<string> {
  const out = await eng.rehearse({
    id: chainId, origin: 'manual', virtualScene: RICH_SCENE, actions: [CLICK],
  });
  assert.equal(out.verdict, 'passed', `排练基线须 passed：${out.verdict}`);
  const res = eng.consolidate(out, 'approved');
  assert.ok(res.ok && res.value, '固化基线须入库');
  return res.value.id;
}

/** 门3 拦截计数（host-replay-gate × doctor-rejected） */
function doctorRejections(): number {
  return sandboxLog.list().filter(e =>
    e.kind === 'host-replay-gate' && e.data?.gate === 'doctor-rejected').length;
}

// ═══ M3：否决钉住（安全：否决权不以可失忆缓存为唯一事实源）═══

test('ΤΕΛ-13/M3a: 主缓存 256-FIFO 挤出后门3 仍拦截 —— 否决钉住（fail-closed 补口）', async () => {
  const eng = new SandboxEngineImpl(null, new MuscleMemoryStore());
  eng.configure({});
  const entryId = await mintEntry(eng, 'chain-veto');
  eng.noteDoctorVerdict(verdict('chain-veto', 'rejected'));
  // 洪水：300 条其它链的 approved 判决 ⇒ 主缓存（256 上限）把 chain-veto 挤出
  for (let i = 0; i < 300; i++) eng.noteDoctorVerdict(verdict(`other-${i}`, 'approved'));
  // 旧病灶在此时点：verdictCache 无 chain-veto ⇒ latest===undefined ⇒ 门3 放行。
  // 钉面立法后：rejected 判决仍拦截。
  const token = eng.requestReplayToken(entryId);
  const replay = await eng.replayOnHost(entryId, { confirmToken: token });
  assert.equal(replay.verdict, 'failed');
  assert.equal(doctorRejections(), 1, '门3 以 doctor-rejected 拦截（主缓存失忆不等于否决失忆）');
  eng.reset();
});

test('ΤΕΛ-13/M3b: 换钉/解钉律 —— 最新判决语义分毫不变（approved 推翻 rejected 放行；再 rejected 再拦）', async () => {
  const eng = new SandboxEngineImpl(null, new MuscleMemoryStore());
  eng.configure({});
  const entryId = await mintEntry(eng, 'chain-flip');
  eng.noteDoctorVerdict(verdict('chain-flip', 'rejected'));
  let token = eng.requestReplayToken(entryId);
  await eng.replayOnHost(entryId, { confirmToken: token });
  assert.equal(doctorRejections(), 1, 'rejected 在钉 ⇒ 拦截');
  // 复核推翻：同 subject 新 approved ⇒ 解钉（被推翻的否决不永生）
  eng.noteDoctorVerdict(verdict('chain-flip', 'approved'));
  token = eng.requestReplayToken(entryId);
  const second = await eng.replayOnHost(entryId, { confirmToken: token });
  assert.equal(doctorRejections(), 1, 'approved 解钉 ⇒ 门3 放行');
  // 放行后的走向证明确实过了门3：可逆步 + 双侧指纹缺席 ⇒ 4B 降级道（无执行器诚实 failed）
  assert.ok(sandboxLog.list().some(e =>
    e.kind === 'host-replay-gate' && e.data?.gate === 'fingerprint-degraded-reversible'),
    '过了门3 落到门4B 降级道（不是 doctor-rejected 卡死）');
  assert.equal(second.verdict, 'failed', '无执行器 ⇒ 诚实 failed（not-wired 语义）');
  // 再否决 ⇒ 换钉再拦（新 rejected 覆盖旧 approved）
  eng.noteDoctorVerdict(verdict('chain-flip', 'rejected'));
  token = eng.requestReplayToken(entryId);
  await eng.replayOnHost(entryId, { confirmToken: token });
  assert.equal(doctorRejections(), 2, '再 rejected ⇒ 再拦截');
  eng.reset();
});

test('ΤΕΛ-13/M3c: 钉面容量逐出必入链告警 —— 否决失忆绝不静默（容量 1024）', async () => {
  const eng = new SandboxEngineImpl(null, new MuscleMemoryStore());
  eng.configure({});
  // 1025 条互异 rejected ⇒ 钉面满员（1024）逐出最旧一条
  for (let i = 0; i < 1025; i++) eng.noteDoctorVerdict(verdict(`pin-${i}`, 'rejected'));
  const evictions = sandboxLog.list().filter(e => e.kind === 'veto-pin-evicted');
  assert.equal(evictions.length, 1, '恰好一条钉面逐出告警');
  assert.equal(evictions[0]!.data?.subject, 'pin-0', '最旧钉（pin-0）被逐');
  assert.equal(evictions[0]!.data?.cap, 1024);
  // 链完整性：逐出告警走哈希链 append（verify 不因告警破链）
  const v = eng.verifyLog();
  assert.ok(v.ok, 'verifyLog 结构 ok');
  if (!v.ok) return;
  assert.ok(v.value.ok, `账本链完整：${JSON.stringify(v.value)}`);
  eng.reset();
});

test('ΤΕΛ-13/M3d: 源级金丝雀 —— 钉面字段/容量/告警链段/钉面优先读取式在场', () => {
  const src = readFileSync('src/sandbox/engine.ts', 'utf8');
  assert.ok(src.includes('private pinnedVetoes'), '钉面字段在场');
  assert.ok(src.includes('VETO_PIN_MAX = 1024'), '钉面容量常量在场');
  assert.ok(src.includes("'veto-pin-evicted'"), '逐出告警铸造点在场');
  assert.ok(src.includes('this.pinnedVetoes.get(entry.chainId)'), '门3 钉面优先读取式在场');
  assert.ok(src.includes('this.pinnedVetoes.clear()'), 'reset 归零钉面在场');
  const logSrc = readFileSync('src/sandbox/log.ts', 'utf8');
  assert.ok(logSrc.includes("| 'veto-pin-evicted'"), '账本 kind 契约收编在场');
});

// ═══ M7：肌肉记忆库遗忘淘汰（容量上界 + 崩塌除名 + 审计台账）═══

test('ΤΕΛ-13/M7a: 容量律 —— 库满逐出最不值得留者（确定性：全新鲜同可靠度 ⇒ 最旧先走）+ 台账记账', () => {
  const store = new MuscleMemoryStore();
  const idGen = createDefaultIdGenerator();
  const stepOf = (i: number): SandboxAction => ({ kind: 'click_mouse', args: { x: 0.1, y: 0.1, n: i } });
  const firstId = store.consolidate(idGen, 't0', 'c0', [stepOf(0)], undefined).id;
  for (let i = 1; i < MUSCLE_MEMORY_MAX_ENTRIES; i++) {
    store.consolidate(idGen, `t${i}`, `c${i}`, [stepOf(i)], undefined);
  }
  assert.equal(store.size(), MUSCLE_MEMORY_MAX_ENTRIES, '满员不超限');
  // 第 257 条新签名入库 ⇒ 逐出一条（全新鲜条目可靠度同为 0.5 ⇒ 活动最旧 = 首条）
  store.consolidate(idGen, 't-new', 'c-new', [stepOf(9999)], undefined);
  assert.equal(store.size(), MUSCLE_MEMORY_MAX_ENTRIES, '容量执法后仍 ≤ 上限');
  assert.equal(store.get(firstId), undefined, '最旧条目被逐（确定性）');
  const ledger = store.evictionLog();
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]!.id, firstId);
  assert.equal(ledger[0]!.reason, 'capacity');
  assert.match(ledger[0]!.detail ?? '', /reliability=0\.500/, '台账携带逐出时的可靠度证据');
});

test('ΤΕΛ-13/M7b: 崩塌除名律 —— Laplace 举证门：3 败存活（后验恰 0.2 不越线）、4 败除名、成功永不除名', () => {
  const store = new MuscleMemoryStore();
  const idGen = createDefaultIdGenerator();
  const bad = store.consolidate(idGen, 'bad skill', 'c-bad',
    [{ kind: 'click_mouse', args: { x: 0.5, y: 0.5, tag: 'bad' } }], undefined);
  const good = store.consolidate(idGen, 'good skill', 'c-good',
    [{ kind: 'click_mouse', args: { x: 0.6, y: 0.6, tag: 'good' } }], undefined);
  // 3 次失败：后验 (0+1)/(3+2)=0.2 —— 不低于 0.2 线 ⇒ 举证不足，不除名
  for (let i = 0; i < 3; i++) {
    const r = store.recordHostReplay(bad.id, false);
    assert.ok(r, '回写返回条目（未除名）');
  }
  assert.ok(store.get(bad.id), '3 败仍存活（单凭三次失败不构成坏技能证据）');
  // 第 4 次失败：后验 (0+1)/(4+2)≈0.167 < 0.2 ⇒ 除名
  const terminal = store.recordHostReplay(bad.id, false);
  assert.equal(store.get(bad.id), undefined, '后验崩塌 + 举证足额 ⇒ 除名');
  assert.equal(terminal?.hostReplayCount, 4, '返回终态快照（除名后调用方仍可如实报告）');
  assert.equal(muscleReliability(terminal!), 1 / 6, '终态快照的崩塌可靠度可导出');
  const ledger = store.evictionLog();
  assert.equal(ledger[0]!.reason, 'host-replay-collapse');
  assert.match(ledger[0]!.detail ?? '', /trials=4/);
  // 成功路径永不除名
  for (let i = 0; i < 6; i++) store.recordHostReplay(good.id, true);
  assert.ok(store.get(good.id), '全成功绝不除名');
});

test('ΤΕΛ-13/M7c: 强化路径不触发容量执法；被逐条目同签名重铸走新条目（旧账不复活）', () => {
  const store = new MuscleMemoryStore();
  const idGen = createDefaultIdGenerator();
  const steps: SandboxAction[] = [{ kind: 'click_mouse', args: { x: 0.2, y: 0.2 } }];
  const e1 = store.consolidate(idGen, 't', 'c', steps, undefined);
  for (let i = 0; i < 5; i++) store.consolidate(idGen, 't', 'c', steps, undefined);
  assert.equal(store.size(), 1, '同签名强化不增长库容');
  assert.equal(e1.rehearsalPassCount, 6, '强化计数累积');
  assert.equal(store.evictionLog().length, 0, '强化零逐出');
  // 手工除名后再固化同签名 ⇒ 新 id 新账（先验重置 —— 旧计数不复活）
  const r = store.recordHostReplay(e1.id, false);
  const r2 = store.recordHostReplay(e1.id, false);
  const r3 = store.recordHostReplay(e1.id, false);
  const r4 = store.recordHostReplay(e1.id, false);
  void r; void r2; void r3; void r4; // 4 败 ⇒ 除名（M7b 律）
  assert.equal(store.get(e1.id), undefined);
  const reborn = store.consolidate(idGen, 't', 'c', steps, undefined);
  assert.notEqual(reborn.id, e1.id, '重铸新条目（新先验）');
  assert.equal(reborn.rehearsalPassCount, 1);
  assert.equal(reborn.hostReplayCount, 0, '旧失败计数不连坐新条目');
});

test('ΤΕΛ-13/M7d: load 恢复面超限执法 —— 外部文件堆积逐出至 ≤ 上限（capacity-on-load 台账）', () => {
  const dir = mkdtempSync(join(tmpdir(), 't2-10-muscle-'));
  try {
    const file = join(dir, 'muscle.json');
    const bulk = Array.from({ length: MUSCLE_MEMORY_MAX_ENTRIES + 44 }, (_, i) => ({
      id: `m${i}`, trigger: `t${i}`, chainId: `c${i}`,
      steps: [{ kind: 'click_mouse', args: { x: 0.1, y: 0.1, n: i } }],
      rehearsalPassCount: 1, hostReplayCount: 0, hostSuccessCount: 0,
      lastRehearsedAt: 1_000_000 + i, lastHostReplayedAt: 0, origin: 'rehearsal',
    }));
    writeFileSync(file, JSON.stringify(bulk), 'utf8');
    const store = new MuscleMemoryStore();
    store.configure(file);
    const restored = store.load();
    assert.equal(restored, bulk.length, '全部水合');
    assert.equal(store.size(), MUSCLE_MEMORY_MAX_ENTRIES, '恢复后执法至 ≤ 上限');
    const ledger = store.evictionLog();
    assert.equal(ledger.length, 44, '超限 44 条全部记账');
    assert.ok(ledger.every(e => e.reason === 'capacity-on-load'), '恢复面逐出理由专属');
    assert.equal(store.get('m0'), undefined, '最旧（最久未活动）先走 —— 确定性');
    assert.ok(store.get(`m${bulk.length - 1}`), '最新存活');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ═══ M8：排练弃权语义（贫乏场景缺席 ≠ 反证；申报场景严格语义零回归）═══

test('ΤΕΛ-13/M8a: 三态保真 —— asVirtualWidget/buildVirtualScene 不再把缺席折叠成 false（缺键 = 未申报）', () => {
  const base = { name: 'box', rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 } };
  const undeclared = asVirtualWidget(base)!;
  assert.equal(undeclared.acceptsText, undefined, '缺席 = 未申报');
  assert.equal(undeclared.scrollable, undefined);
  // 不铸 undefined 值键（ΠΑΝ-49 canonical「undefined 值自有键与缺键同域」——
  // 直接缺键让哈希域/JSON 往返零分歧，epochChi 复刻 canonical 兼容面保持）
  assert.ok(!('acceptsText' in undeclared) && !('scrollable' in undeclared), '缺席不铸键');
  assert.equal(asVirtualWidget({ ...base, acceptsText: true })?.acceptsText, true, '申报布尔透传');
  assert.equal(asVirtualWidget({ ...base, acceptsText: false, scrollable: false })?.acceptsText, false);
  const scene = buildVirtualScene([{ label: 'L', bbox: { x0: 0, y0: 0, x1: 0.5, y1: 0.5 } }]);
  assert.equal(scene[0]!.role, 'unknown', '供源无角色 ⇒ 缺省 unknown（贫乏信号）');
  assert.ok(!('acceptsText' in scene[0]!) && !('scrollable' in scene[0]!), '宏供源缺席不铸键');
  const declared = buildVirtualScene([{ label: 'L', bbox: { x0: 0, y0: 0, x1: 0.5, y1: 0.5 }, acceptsText: true, scrollable: true }]);
  assert.equal(declared[0]!.acceptsText, true, '宏供源申报布尔透传');
});

test('ΤΕΛ-13/M8b: type_text —— 贫乏场景未申报接受性 ⇒ 弃权（null+零层+假设性入账）；富场景旧律零回归', () => {
  const poor = new VirtualScreen([{ name: 'field', rect: { x: 0.2, y: 0.2, width: 0.3, height: 0.1 } }]);
  const click = poor.applyAction({ kind: 'click_mouse', args: { x: 0.3, y: 0.25 } });
  assert.equal(click.effectDetected, true, '命中是几何事实 —— 贫乏不弃权几何');
  const t = poor.applyAction({ kind: 'type_text', args: { text: 'hello' } });
  assert.equal(t.effectDetected, null, '贫乏 + 未申报 ⇒ 弃权（旧律 false ⇒ 链 failed 的结构性误拒闭合）');
  assert.equal(t.expectationMet, null);
  assert.equal(t.layers.length, 0, '弃权不计任何验证层');
  assert.match(t.note, /does not declare text acceptance/, '弃权注记可归因');
  // 假设性入账：下游在同一乐观世界可读（不因我方无知制造下游反证）
  poor.applyAction({ kind: 'type_text', args: { text: ' world' } });
  assert.ok(poor.sceneOcr(0.3, 0.25).includes('hello world'), '缓冲假设性入账（弃权判定不入、世界演化按真机假设）');
  // 富场景零回归：申报角色 ⇒ 旧律反证保持
  const rich = new VirtualScreen([{ role: 'button', name: 'b', rect: { x: 0.2, y: 0.2, width: 0.3, height: 0.1 } }]);
  rich.applyAction({ kind: 'click_mouse', args: { x: 0.3, y: 0.25 } });
  assert.equal(rich.applyAction({ kind: 'type_text', args: { text: 'x' } }).effectDetected, false,
    '富场景未申报 ⇒ 旧律反证（curated 世界按申报面执法）');
  // 显式申报 false：世界明断不可 ⇒ 反证（任何场景）
  const declaredNo = new VirtualScreen([{ name: 'n', rect: { x: 0.2, y: 0.2, width: 0.3, height: 0.1 }, acceptsText: false }]);
  declaredNo.applyAction({ kind: 'click_mouse', args: { x: 0.3, y: 0.25 } });
  assert.equal(declaredNo.applyAction({ kind: 'type_text', args: { text: 'x' } }).effectDetected, false,
    '申报 false ⇒ 反证（宣言优先于贫乏）');
  // 申报 true：贫乏不弃权申报（宣言即是证据）
  const declaredYes = new VirtualScreen([{ name: 'n', rect: { x: 0.2, y: 0.2, width: 0.3, height: 0.1 }, acceptsText: true }]);
  declaredYes.applyAction({ kind: 'click_mouse', args: { x: 0.3, y: 0.25 } });
  assert.equal(declaredYes.applyAction({ kind: 'type_text', args: { text: 'x' } }).effectDetected, true,
    '申报 true ⇒ 证据（申报即知识）');
});

test('ΤΕΛ-13/M8c: scroll_page —— 贫乏零申报 ⇒ 弃权；申报布尔在场 ⇒ 反证保持；富场景 K-7a 语义零回归', () => {
  const poor = new VirtualScreen([{ name: 'page', rect: { x: 0, y: 0, width: 1, height: 1 } }]);
  const s1 = poor.applyAction({ kind: 'scroll_page', args: { direction: 'down', amount: 3 } });
  assert.equal(s1.effectDetected, null, '贫乏 + 全场景零滚动申报 ⇒ 弃权（旧律 false）');
  assert.equal(s1.layers.length, 0);
  const s2 = poor.applyAction({ kind: 'scroll_page', args: { direction: 'down', amount: 3, x: 0.5, y: 0.5 } });
  assert.equal(s2.effectDetected, null, '贫乏 + 落点控件未申报 ⇒ 弃权');
  assert.match(s2.note, /does not declare scrollability/);
  // 申报 false（世界明断不可滚）⇒ 反证保持 —— 宣言优先于贫乏
  const declaredNo = new VirtualScreen([{ name: 'panel', rect: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 }, scrollable: false }]);
  assert.equal(declaredNo.applyAction({ kind: 'scroll_page', args: { direction: 'down', amount: 3 } }).effectDetected, false,
    '申报 false ⇒ 反证');
  // 申报 true ⇒ 证据（即使角色未知）
  const declaredYes = new VirtualScreen([{ name: 'list', rect: { x: 0.1, y: 0.3, width: 0.8, height: 0.5 }, scrollable: true }]);
  const ok = declaredYes.applyAction({ kind: 'scroll_page', args: { direction: 'down', amount: 3 } });
  assert.equal(ok.effectDetected, true, '申报 true ⇒ 证据');
  // 富场景零回归（K-7a「无处可滚 = 世界回击」）
  const rich = new VirtualScreen([{ role: 'button', name: 'save', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } }]);
  assert.equal(rich.applyAction({ kind: 'scroll_page', args: { direction: 'down', amount: 3 } }).effectDetected, false,
    '富场景（申报角色）无容器 ⇒ 旧律反证');
});

test('ΤΕΛ-13/M8d: switch_tab —— 贫乏场景 <2 标签 ⇒ 弃权；申报场景（单标签/无标签）旧律反证零回归', () => {
  const poor = new VirtualScreen([
    { name: 'a', rect: { x: 0.05, y: 0.05, width: 0.1, height: 0.04 } },
    { name: 'b', rect: { x: 0.2, y: 0.05, width: 0.1, height: 0.04 } },
  ]);
  const e = poor.applyAction({ kind: 'switch_tab', args: { direction: 'next' } });
  assert.equal(e.effectDetected, null, '贫乏（全 unknown 角色）⇒ 切签不可证伪（真机 ctrl+tab 可行）');
  assert.equal(e.layers.length, 0);
  assert.match(e.note, /unclassified/);
  // 申报场景零回归（epochO O-#14 e5/e6 语义复刻）
  const lone = new VirtualScreen([{ role: 'tab', name: 'Only', rect: { x: 0.05, y: 0.05, width: 0.1, height: 0.04 } }]);
  assert.equal(lone.applyAction({ kind: 'switch_tab', args: { direction: 'next' } }).effectDetected, false,
    '申报场景单标签 ⇒ 反证（无处可切）');
  const noTabs = new VirtualScreen([{ role: 'button', name: 'OK', rect: { x: 0.4, y: 0.4, width: 0.1, height: 0.06 } }]);
  assert.equal(noTabs.applyAction({ kind: 'switch_tab', args: { direction: 'next' } }).effectDetected, false,
    '申报场景无标签 ⇒ 反证');
});

test('ΤΕΛ-13/M8e: click 的 text-level 无 expectedText 期望 —— 贫乏未申报 ⇒ 期望弃权；富场景旧律', () => {
  const poor = new VirtualScreen([{ name: 'n', rect: { x: 0.2, y: 0.2, width: 0.3, height: 0.1 } }]);
  const e = poor.applyAction({
    kind: 'click_mouse', args: { x: 0.3, y: 0.25 }, expect: { scale: 'text-level' },
  });
  assert.equal(e.effectDetected, true);
  assert.equal(e.expectationMet, null, '贫乏 + 命中控件未申报接受性 ⇒ 期望不可判（弃权非反证）');
  const rich = new VirtualScreen([{ role: 'button', name: 'b', rect: { x: 0.2, y: 0.2, width: 0.3, height: 0.1 } }]);
  const e2 = rich.applyAction({
    kind: 'click_mouse', args: { x: 0.3, y: 0.25 }, expect: { scale: 'text-level' },
  });
  assert.equal(e2.expectationMet, false, '富场景旧律零回归（未申报可输入 ⇒ 期望不满足）');
});

test('ΤΕΛ-13/M8f: 引擎面 —— 真证据步 + 弃权步混合链 verdict passed（不再连坐 failed）；纯弃权链 degraded', () => {
  const scene = [{ name: 'field', rect: { x: 0.4, y: 0.4, width: 0.2, height: 0.1 } }]; // 贫乏
  const mixed = deterministicReplay([
    { kind: 'click_mouse', args: { x: 0.5, y: 0.45 } },
    { kind: 'type_text', args: { text: 'hi' } },
  ], { scene });
  assert.equal(mixed.verdict, 'passed', 'click 真证据 + type 弃权 ⇒ passed（旧律：type 反证 ⇒ failed）');
  const pure = deterministicReplay([
    { kind: 'switch_tab', args: { direction: 'next' } },
  ], { scene });
  assert.equal(pure.verdict, 'degraded', '纯弃权链零验证层 ⇒ 诚实 degraded（fail-closed 红线不越）');
});

test('ΤΕΛ-13/M8g: 宏门禁端到端 —— 贫乏锚点场景的低可靠 [click+type] 宏放行（结构性误拒闭合）；纯切签宏诚实拒绝', () => {
  const gate = new MacroRehearsalGate(new MuscleMemoryStore());
  const steps: SkillStep[] = [
    { tool: 'click_mouse', args: { x: 0.5, y: 0.5 } },
    { tool: 'type_text', args: { text: 'alice' } },
  ];
  // 生产供源形状：uiMemory 锚点 —— label/bbox 无角色（role 缺席 ⇒ unknown ⇒ 贫乏）
  const v = gate.gate({
    reliability: 0.3,
    steps,
    scene: [{ label: 'Field', bbox: { x0: 0.3, y0: 0.4, x1: 0.7, y1: 0.6 } }],
  });
  assert.equal(v.verdict, 'passed', 'click 命中 + type 弃权 ⇒ 排练通过（旧律 type 反证 ⇒ failed ⇒ 拒绝）');
  assert.equal(v.allowed, true, '低可靠宏不再被元数据贫乏结构性误拒');
  const lone = new MacroRehearsalGate(new MuscleMemoryStore()).gate({
    reliability: 0.3,
    steps: [{ tool: 'press_hotkey', args: { keys: ['ctrl', 'tab'] } }],
    scene: [{ label: 'X', bbox: { x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.4 } }],
  });
  assert.equal(lone.verdict, 'degraded', '纯切签弃权（零证据）⇒ degraded —— 诚实拒绝不放行');
  assert.equal(lone.allowed, false, 'fail-closed 保持：弃权 ≠ 宽纵');
});

test('ΤΕΛ-13/M8h: 源级金丝雀 —— 贫乏门/弃权规范形/三态铸造在场', () => {
  const vs = readFileSync('src/sandbox/virtualScreen.ts', 'utf8');
  assert.ok(vs.includes('private readonly rolePoor'), '贫乏门字段在场');
  assert.ok(vs.includes('function abstentionEvidence'), '弃权规范形铸造点在场');
  assert.ok(vs.includes("typeof rawAccepts === 'boolean'"), 'asVirtualWidget 三态铸造在场');
  assert.ok(vs.includes('this.rolePoor && !this.widgets.some(w => w.scrollable !== undefined)'), '滚动弃权的申报豁免式在场');
  const mr = readFileSync('src/sandbox/macroRehearsal.ts', 'utf8');
  assert.ok(mr.includes("typeof w.acceptsText === 'boolean'"), 'buildVirtualScene 三态铸造在场');
});
