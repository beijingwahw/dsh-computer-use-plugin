// test/epochChi.attestation.test.ts
// 纪元 Χ（沙箱重放证词）执法测试 —— Χ-1~Χ-4：
//   Χ-1 绿章：真实排练（虚拟屏世界+动作链）落账本 ⇒ attestReplayConsistency 重放
//        逐位一致 ⇒ green（detail 注明段长与步数）；verifyNotary 第四章 green
//   Χ-2 红章：链完整但内容与重放不符 ⇒ red + 首分歧步注记（两种构造：
//        (a) 正规追加铸伪段——真指纹配假动作；(b) 改写既有史——替换指纹字段后
//        重算全链 = 「合法重写」，chain-integrity 视角无篡改可见而重放章翻红）
//   Χ-3 确定性执法：同注入（时钟/随机源）重放两次指纹序列 deepEqual；
//        无沙箱段 ⇒ n/a 理由在场；旧格式无指纹 ⇒ n/a(legacy)；注入优先于单例
//   Χ-4 主路径零回归：rehearse 裁决语义 / log 追加-验证语义 / replayOnHost 门禁
// 威胁模型（Χ-2）：无密钥哈希链只证「未被无痕篡改」，不证「内容为真」—— 攻击者
// 持整链重写权（改内容后重算全部哈希，或持 append 权铸伪段）可保链完整。重放章
// 执法的正是这个缺口：内容必须仍与确定性世界重演的产物逐位一致。
// 全离线确定性：固定时钟、种子伪随机、notary endpoint 恒空（零网络）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { notary, attestReplayConsistency } from '../src/notary/index.ts';
import { journal } from '../src/journal.ts';
import { sandboxLog, SandboxLog } from '../src/sandbox/log.ts';
import { SandboxEngineImpl, deterministicReplay } from '../src/sandbox/engine.ts';
import type { SandboxAction, VirtualWidget } from '../src/sandbox/types.ts';

// ─── 测试基建：确定性世界 / 固定时钟 / 种子伪随机 / journal 播种 ───

const BTN: VirtualWidget = { role: 'button', name: 'save', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } };
const INPUT: VirtualWidget = { role: 'textbox', name: 'search', rect: { x: 0.5, y: 0.5, width: 0.3, height: 0.08 }, acceptsText: true };
const POPUP: VirtualWidget = { role: 'dialog', name: 'confirm', rect: { x: 0.3, y: 0.3, width: 0.4, height: 0.3 }, popup: true };
const SCENE: VirtualWidget[] = [BTN, INPUT, POPUP];

/** 四步链：聚焦输入框（焦点转移+缓冲开张）→ 落字（缓冲演化）→ esc 关弹窗
 *  （控件树消亡 —— 指纹漂移面）→ 命中按钮（L4 期望）。每步都真实转移世界状态。 */
const ACTIONS: SandboxAction[] = [
  { kind: 'click_mouse', args: { x: 0.6, y: 0.54 } },
  { kind: 'type_text', args: { text: 'hello chi' }, expect: { scale: 'text-level', expectedText: 'hello' } },
  { kind: 'press_hotkey', args: { keys: ['esc'] } },
  { kind: 'click_mouse', args: { x: 0.15, y: 0.12 }, expect: { scale: 'element-level' } },
];

/** 固定时钟（2025-01-01T00:00:00Z —— 重演簿记确定性） */
const fixedClock = (): number => 1735689600000;

/** 种子伪随机（仅测试 —— 世界零熵，注入面只验证「同种子同行为」的接口契约） */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s >>> 16) / 0x7fff;
  };
}

/** journal 播种：reset 后喂 n 条确定性动作（verifyNotary 章①③ 的诚实底座） */
async function seedJournal(n: number): Promise<void> {
  journal.reset();
  for (let i = 0; i < n; i++) {
    await journal.append({
      ts: 1700000000 + i, tool: 'click_mouse',
      args: { x: (i + 1) / 10, y: 0.5 }, status: 'SUCCESS', effect_detected: true,
    });
  }
}

// ── Χ-2(b) 的「合法重写」原语：复刻 log.ts 的 canonical/chainHash（纯密码学
//    原语复刻 —— notary 复刻 mintNonce、log 复刻 journal.canonical 的同一先例；
//    哈希域构造必须逐字节一致才能铸出链完整的改写史）──

function canonical(obj: any): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  return '{' + Object.keys(obj).sort()
    .map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

interface MutableEntry { ts: number; kind: string; data: Record<string, any>; hash?: string }

/** 从链基重算全链哈希（改写内容后让链重新「完整」—— 攻击者的整链重写权） */
function recomputeChain(entries: MutableEntry[]): void {
  let prev = 'GENESIS';
  for (const e of entries) {
    const { hash: _omit, ...domain } = e;
    void _omit;
    e.hash = createHash('sha256').update(prev + canonical(domain)).digest('hex');
    prev = e.hash;
  }
}

beforeEach(() => {
  sandboxLog.reset();
  notary.reset();
  notary.configure({ endpoint: '', tracePath: '' }); // 纯内存锚链、零网络
});

// ─── Χ-1 绿章：真实排练 ⇒ 重放逐位一致 ───

test('Χ-1: 真实排练落账本 ⇒ 重放逐位一致 ⇒ 绿章（独立面 + verifyNotary 第四章）', async () => {
  await seedJournal(3);
  const eng = new SandboxEngineImpl(null);
  eng.configure({});
  const out = await eng.rehearse({
    id: 'chain-x1', origin: 'manual', virtualScene: SCENE, actions: ACTIONS,
  });
  assert.equal(out.verdict, 'passed', '四步全真证据（K 纪元语义零回归的前提）');

  // 取证面：一段完整排练段（动作序列 + 指纹序列）
  const segs = sandboxLog.exportRehearsalSegments();
  assert.equal(segs.length, 1, '恰好一段');
  assert.equal(segs[0].chainId, 'chain-x1');
  assert.equal(segs[0].steps.length, ACTIONS.length, '四步全在册');
  // 记录路径与重放路径同一指纹函数的直接证据：链上指纹 = 重演重算指纹
  const replay = deterministicReplay(ACTIONS, { scene: segs[0].scene });
  assert.deepEqual(replay.fingerprints, segs[0].steps.map(s => s.fingerprint),
    '链上场景重入虚拟屏 ⇒ 指纹序列逐位一致');

  // 独立面：绿章 + detail 注明段长与步数
  const badge = attestReplayConsistency();
  assert.equal(badge.status, 'green');
  assert.match(badge.detail, /1 sandbox segment/);
  assert.match(badge.detail, /4 step/);

  // verifyNotary 第四章同绿（其余章不受沙箱面影响）
  const r = notary.verifyNotary();
  assert.equal(r.badges['replay-consistency'].status, 'green', '第四章绿');
  assert.match(r.badges['replay-consistency'].detail, /bit-for-bit/);
  assert.equal(r.badges['chain-integrity'].status, 'green');
  assert.equal(r.ok, true);
  eng.reset(); // 断言完毕后归零（reset 会清 sandboxLog —— 置于最后）
});

// ─── Χ-2 红章：链完整但内容与重放不符 ───

test('Χ-2: 链完整但内容与重放不符 ⇒ 红章 + 首分歧步注记（合法重写威胁模型）', async () => {
  // (a) 铸伪段：正规 append 走链推进（链必然完整），真指纹配假动作 ——
  //     step 0 指纹一致、step 1（被改的动作）起分歧 ⇒ 首分歧步精确定位
  const truth = deterministicReplay(ACTIONS, { scene: SCENE });
  const forged: SandboxAction[] = JSON.parse(JSON.stringify(ACTIONS));
  (forged[1].args as Record<string, unknown>).text = 'TAMPERED';
  await sandboxLog.append('rehearsal-begin', {
    chainId: 'chain-x2a', snapshotId: 'snap-x2a', actions: forged.length,
    fpFormat: 1, scene: SCENE,
  });
  for (let i = 0; i < forged.length; i++) {
    await sandboxLog.append('rehearsal-step', {
      chainId: 'chain-x2a', index: i, kind: forged[i].kind, latencyMs: 1,
      effectDetected: true, expectationMet: null, virtualFocus: null,
      fpFormat: 1, action: forged[i], screenFingerprint: truth.fingerprints[i],
    });
  }
  await sandboxLog.append('rehearsal-end', {
    chainId: 'chain-x2a', verdict: 'passed', score: 50,
    totalLatencyMs: 4, steps: forged.length, reportPath: 'in-memory',
  });
  assert.equal(sandboxLog.verify().ok, true, '正规追加 ⇒ 链完整（chain-integrity 视角无可见篡改）');
  const a = attestReplayConsistency();
  assert.equal(a.status, 'red', '内容与确定性世界重演不符 ⇒ 红章');
  assert.match(a.detail, /step 1/, '首分歧步注记（step 0 仍逐位一致 —— 分歧被精确定位）');
  assert.match(a.detail, /NOT reproducible/);

  // (b) 改写既有史：真实排练后原地替换 step 2 的指纹字段（list() 返回内部活引用
  //     —— Π-2 同法），再重算全链哈希。链保持完整（verify 绿）而重放章翻红：
  //     这就是「链完整但内容与重放不符」的最强形态 —— 攻击者重写了一致的历史。
  sandboxLog.reset();
  const eng = new SandboxEngineImpl(null);
  eng.configure({});
  await eng.rehearse({ id: 'chain-x2b', origin: 'manual', virtualScene: SCENE, actions: ACTIONS });
  const entries = sandboxLog.list() as unknown as MutableEntry[];
  const step2 = entries.find(e => e.kind === 'rehearsal-step' && e.data?.index === 2)!;
  assert.ok(step2, 'step 2 在册');
  step2.data.screenFingerprint = 'f'.repeat(64); // 伪指纹（形状合法 —— 不是断链式破坏）
  recomputeChain(entries);
  assert.equal(sandboxLog.verify().ok, true, '重算后链完整 —— 篡改对 chain-integrity 不可见');
  const b = attestReplayConsistency();
  assert.equal(b.status, 'red', '重放重算 ≠ 链上伪指纹 ⇒ 红章（重放章补位哈希链的本征让步）');
  assert.match(b.detail, /step 2/, '首分歧步 = 2（前两步逐位一致）');
  eng.reset();
});

// ─── Χ-3 确定性执法 ───

test('Χ-3: 同注入重放两次 deepEqual；无沙箱段 n/a 理由在场；旧格式 n/a(legacy)；注入优先', async () => {
  // (a) 同一注入（时钟/随机源/场景/动作）重放两次 ⇒ 指纹序列与裁决逐位同
  const r1 = deterministicReplay(ACTIONS, { scene: SCENE, now: fixedClock, rng: makeRng(0xc41) });
  const r2 = deterministicReplay(ACTIONS, { scene: SCENE, now: fixedClock, rng: makeRng(0xc41) });
  assert.deepEqual(r1.fingerprints, r2.fingerprints, '同 seed ⇒ 指纹序列 deepEqual');
  assert.equal(r1.verdict, r2.verdict);
  assert.equal(r1.verdict, 'passed', '重演裁决与排练同律');
  // 指纹非平凡：动作漂移 ⇒ 指纹漂移（校验和有权重，非恒等函数）
  const drifted = deterministicReplay(
    [ACTIONS[0], { ...ACTIONS[1], args: { text: 'other text' } }], { scene: SCENE });
  assert.notEqual(r1.fingerprints[1], drifted.fingerprints[1], '不同输入 ⇒ 不同指纹');
  // 步间指纹亦非平凡：世界状态演化 ⇒ 指纹演化（缓冲上屏/弹窗消亡可见）
  assert.notEqual(r1.fingerprints[0], r1.fingerprints[1]);
  assert.notEqual(r1.fingerprints[1], r1.fingerprints[2], 'esc 关弹窗 ⇒ 控件树变化入指纹');

  // (b) 无沙箱段 ⇒ n/a（真机 journal 段不可复现 —— 理由在场）
  await seedJournal(2);
  const none = attestReplayConsistency();
  assert.equal(none.status, 'n/a');
  assert.ok(none.detail.length > 20, 'n/a 理由说明在场');
  assert.match(none.detail, /non-deterministic|no sandbox rehearsal/i);

  // 注入优先：单例铸一段后，注入空账本 ⇒ 以注入面为准（压过自动发现）
  const eng = new SandboxEngineImpl(null);
  eng.configure({});
  await eng.rehearse({ id: 'chain-x3-inj', origin: 'manual', virtualScene: SCENE, actions: [ACTIONS[0]] });
  assert.equal(attestReplayConsistency().status, 'green', '单例有段（对照）');
  assert.equal(attestReplayConsistency({ sandboxLedger: new SandboxLog() }).status, 'n/a',
    '注入的空账本优先于持有段的单例');
  eng.reset();

  // (c) 旧格式无指纹 ⇒ n/a(legacy)（Χ 前账本 —— begin/step 无 fpFormat/指纹字段）
  sandboxLog.reset();
  await sandboxLog.append('rehearsal-begin', { chainId: 'legacy-1', snapshotId: 'snap', actions: 2 });
  await sandboxLog.append('rehearsal-step', {
    chainId: 'legacy-1', index: 0, kind: 'click_mouse', latencyMs: 1,
    effectDetected: true, expectationMet: null, virtualFocus: null,
  });
  await sandboxLog.append('rehearsal-step', {
    chainId: 'legacy-1', index: 1, kind: 'type_text', latencyMs: 1,
    effectDetected: true, expectationMet: null, virtualFocus: null,
  });
  await sandboxLog.append('rehearsal-end', {
    chainId: 'legacy-1', verdict: 'degraded', score: 0,
    totalLatencyMs: 2, steps: 2, reportPath: 'in-memory',
  });
  const legacy = attestReplayConsistency();
  assert.equal(legacy.status, 'n/a(legacy)', '旧格式 ⇒ 诚实 n/a(legacy) 而非误红/虚绿');
  assert.match(legacy.detail, /legacy/i);
  // verifyNotary 面：n/a(legacy) 是诚实降级非失败（红才否决 ok）
  const r = notary.verifyNotary();
  assert.equal(r.badges['replay-consistency'].status, 'n/a(legacy)');
  assert.equal(r.ok, true);
});

// ─── Χ-4 主路径零回归 ───

test('Χ-4: 主路径零回归 —— rehearse 裁决 / 账本追加-验证 / replayOnHost 门禁全保持', async () => {
  const eng = new SandboxEngineImpl(null);
  eng.configure({});

  // rehearse 三裁决（K-1a/K-1b/K-1c 语义不变）
  const hit = await eng.rehearse({
    id: 'chain-x4-hit', origin: 'manual', virtualScene: SCENE,
    actions: [{ kind: 'click_mouse', args: { x: 0.15, y: 0.12 }, expect: { scale: 'element-level' } }],
  });
  assert.equal(hit.verdict, 'passed');
  const miss = await eng.rehearse({
    id: 'chain-x4-miss', origin: 'manual', virtualScene: SCENE,
    actions: [{ kind: 'click_mouse', args: { x: 0.95, y: 0.95 } }],
  });
  assert.equal(miss.verdict, 'failed');
  assert.equal(miss.failedAtIndex, 0);
  const noScene = await eng.rehearse({
    id: 'chain-x4-none', origin: 'manual',
    actions: [{ kind: 'click_mouse', args: { x: 0.15, y: 0.12 } }],
  });
  assert.equal(noScene.verdict, 'degraded');
  assert.equal(noScene.steps[0].effectDetected, null, '无场景 ⇒ 诚实 null（非 false）');

  // 账本追加-验证语义：新字段入链后链仍完整；无痕篡改仍翻红
  assert.equal(sandboxLog.verify().ok, true, '指纹入链不破坏哈希链语义');
  assert.equal(eng.verifyLog().ok, true);
  const entries = sandboxLog.list() as unknown as MutableEntry[];
  const anyStep = entries.find(e => e.kind === 'rehearsal-step')!;
  anyStep.data.latencyMs = 99999; // 无痕篡改（不重算哈希）
  assert.equal(sandboxLog.verify().ok, false, 'append-only 防篡改语义零回归（断链即证物）');

  // replayOnHost 门禁：未知条目 ⇒ 诚实 failed（THE HOST IS SACRED 主路径未触碰）
  sandboxLog.reset();
  const replay = await eng.replayOnHost('muscle-missing', { confirmToken: 'SBX-DEADBEEF' });
  assert.equal(replay.verdict, 'failed');
  assert.ok(replay.divergences.length >= 0, '战报形状完整（永不抛）');
  eng.reset();
});
