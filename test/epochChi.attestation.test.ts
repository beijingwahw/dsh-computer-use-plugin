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
// ΝΩ-1（P0 沙箱宿主安全链）追加段：第五门拦截危险步 / dryRun 拒绝 /
//        黑名单热键 system 层拦截 / SANDBOX_HOST_REPLAY 存证 marker（三态脱敏）/
//        指纹位宽域 [01]{32,256} 摄取与前缀比对协同 / replay_on_host 审计登记。
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
import { SandboxEngineImpl, deterministicReplay, fpSimilarity } from '../src/sandbox/engine.ts';
import type { SandboxAction, VirtualWidget, RehearsalOutcome, HostExecutor } from '../src/sandbox/types.ts';
import { makeScore } from '../src/doctorEvents.ts';

// ─── 测试基建：确定性世界 / 固定时钟 / 种子伪随机 / journal 播种 ───

const BTN: VirtualWidget = { role: 'button', name: 'save', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } };
const INPUT: VirtualWidget = { role: 'textbox', name: 'search', rect: { x: 0.5, y: 0.5, width: 0.3, height: 0.08 }, acceptsText: true };
const POPUP: VirtualWidget = { role: 'dialog', name: 'confirm', rect: { x: 0.3, y: 0.3, width: 0.4, height: 0.3 }, popup: true };
const SCENE: VirtualWidget[] = [BTN, INPUT, POPUP];

/** 四步链：聚焦输入框（焦点转移+缓冲开张）→ 落字（缓冲演化）→ esc 关弹窗
 *  （控件树消亡 —— 指纹漂移面）→ 命中按钮（L4 期望）。每步都真实转移世界状态。
 *  ΝΩ-30：首步落点自 (0.6,0.54) 移至 (0.75,0.54) —— z-order/遮挡模型落成后
 *  弹窗（popup 铸高层，rect x∈[0.3,0.7]）不可再被穿透点击：0.6 在弹窗覆盖区
 *  内会命中弹窗而非输入框（旧行为正是本工单修复的穿透缺陷）。0.75 仍在输入
 *  框（x∈[0.5,0.8]）内且在弹窗覆盖区外 —— 本测的证词语义（指纹/绿章）不变。 */
const ACTIONS: SandboxAction[] = [
  { kind: 'click_mouse', args: { x: 0.75, y: 0.54 } },
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

// ─── ΝΩ-1（P0）：沙箱宿主执行器接入宿主安全链 —— 五门 / dryRun / 黑名单 / 存证 marker / 位宽域 ───
//
// 离线确定性策略：宿主 system 单例按 p1-fixes.test.ts 先例 monkey-patch（用毕
// 复原，不毒化后续用例）；dryRun 用例经 system.configure 真实切换（dryRun 早退
// 路径零服务接触）。宿主账本存证经捕获 sink 断言提交契约（kind/三态/脱敏）。

import * as systemNs from '../src/system.ts';
import type { Config as ConfigType } from '../src/config.ts';
import { physicalBackendHostExecutor } from '../src/sandbox/index.ts';
import {
  sniffFingerprint, FINGERPRINT_MIN_BITS, FINGERPRINT_MAX_BITS, isBinaryFingerprint,
} from '../src/sandbox/events.ts';
import { MUTATING_TOOL_NAMES } from '../src/tools/index.ts';

/** system 单例方法的确定性替身（p1-fixes.test.ts:270 同法）：装上假躯体、返回复原句柄 */
function patchSystem<K extends keyof typeof systemNs.system>(
  key: K, fn: (typeof systemNs.system)[K],
): () => void {
  const orig = systemNs.system[key];
  (systemNs.system as Record<string, unknown>)[key as string] = fn;
  return () => { (systemNs.system as Record<string, unknown>)[key as string] = orig; };
}

/** 铸造一条已固化肌肉记忆（绕开排练 —— 第五门/重放路径的确定性底座） */
function consolidatedEntry(
  eng: SandboxEngineImpl,
  steps: SandboxAction[],
  entryFp: string,
): string {
  const outcome: RehearsalOutcome = {
    chainId: `chain-no1-${entryFp.length}`, snapshotId: 'snap-no1', verdict: 'passed',
    steps: steps.map((action, index) => ({
      index, action, effectDetected: true, expectationMet: null, latencyMs: 1,
    })),
    failedAtIndex: null, score: makeScore(50)!, verificationLayers: [],
    totalLatencyMs: steps.length, chainTip: 'tip-no1', reportPath: 'in-memory',
    entrySceneFingerprint: entryFp, createdAt: 1,
  };
  const r = eng.consolidate(outcome, 'approved');
  assert.ok(r.ok && r.value, 'passed × approved ⇒ 固化入库');
  return r.value.id;
}

test('ΝΩ-1a: 第五门 —— 无令牌危险步整链拒绝，归因首犯步且零派发', async () => {
  const eng = new SandboxEngineImpl(null);
  eng.configure({});
  const dispatched: SandboxAction[] = [];
  const fake: HostExecutor = {
    executeAction: async a => { dispatched.push(a); return { ok: true, note: 'faked' }; },
  };
  eng.wireHostExecutor(fake);
  const fp = '01'.repeat(32);
  const entryId = consolidatedEntry(eng, [
    { kind: 'click_mouse', args: { x: 0.5, y: 0.5, target_description: 'save button' } },
    { kind: 'click_mouse', args: { x: 0.5, y: 0.6, target_description: 'delete the database' } },
  ], fp);
  eng.noteHostObservation(fp);
  const token = eng.requestReplayToken(entryId);
  const out = await eng.replayOnHost(entryId, { confirmToken: token });

  assert.equal(out.verdict, 'failed', '危险步无令牌 ⇒ 拒绝（重放不豁免安全闸）');
  assert.equal(dispatched.length, 0, '扫描先于派发 —— 链中段的危险步也不产生部分执行');
  // 链上归因：safety-scan 门禁行 + 首犯步索引 + 拒因
  const gateEntry = sandboxLog.list().find(e => e.kind === 'host-replay-gate'
    && (e.data as Record<string, unknown>).gate === 'safety-scan');
  assert.ok(gateEntry, 'safety-scan 门禁行入沙箱链');
  assert.equal((gateEntry!.data as Record<string, unknown>).stepIndex, 1, '归因首犯步 = 1');
  assert.equal((gateEntry!.data as Record<string, unknown>).reason, 'irreversible-action');
  eng.reset();
});

test('ΝΩ-1b: 安全链五门全过 ⇒ 真派发 confirmed；128 位宿主指纹摄取 + 前缀比对协同', async () => {
  const eng = new SandboxEngineImpl(null);
  eng.configure({});
  const dispatched: SandboxAction[] = [];
  eng.wireHostExecutor({
    executeAction: async a => { dispatched.push(a); return { ok: true, note: 'faked' }; },
  });
  const fp128 = ('01'.repeat(32)) + ('10'.repeat(32)); // 128 位宿主观察（格式演进）
  const entryFp64 = fp128.slice(0, 64); // 排练入口指纹仍为 64 位（公共前缀）
  const entryId = consolidatedEntry(eng, [
    { kind: 'click_mouse', args: { x: 0.5, y: 0.5, target_description: 'save button' } },
    { kind: 'type_text', args: { text: 'hello no1' } },
  ], entryFp64);
  // 摄取侧（ΝΩ-1 位宽域 [01]{32,256}）：128 位可入缓存（ΑΩ-R19 后 truncatedTo 分支自此可达）
  eng.noteHostObservation(fp128);
  const snap = await eng.createSnapshot();
  assert.ok(snap.ok && snap.value.screenDhash === fp128, '128 位指纹可摄取（快照镜像为证）');

  const token = eng.requestReplayToken(entryId);
  const out = await eng.replayOnHost(entryId, { confirmToken: token });
  assert.equal(out.verdict, 'confirmed', '安全链五门全过（含 64↔128 前缀比对）⇒ 真派发');
  assert.equal(dispatched.length, 2, '逐步派发');
  assert.equal(out.divergences.length, 0);
  // 可靠度回写：0 成功重放后 (0+1)/(0+2) → (1+1)/(1+2)
  assert.ok(Math.abs(out.reliabilityAfter - 2 / 3) < 1e-9);
  // 比对侧协同的直接证据：等前缀不等宽 ⇒ 前缀比对 + truncatedTo 注记
  const cmp = fpSimilarity(entryFp64, fp128);
  assert.equal(cmp.similarity, 1);
  assert.equal(cmp.truncatedTo, 64);
  eng.reset();
});

test('ΝΩ-1c: guardDryRun 在场 ⇒ 宿主重放拒绝派发并诚实报错（离线零服务接触）', async () => {
  await systemNs.system.configure({ dryRun: true } as ConfigType);
  try {
    const markers: Array<Record<string, unknown>> = [];
    const ex = physicalBackendHostExecutor(systemNs, {
      appendMarker: m => { markers.push(m); return Promise.resolve(); },
    }, {
      // F4-4（终验工单）：本册文件契约「全离线确定性、零网络」—— ΠΑΝ-42 的
      // before 基线取证走生产路径会拉起真实 D-5 服务（spawn python），被拉起
      // 的服务持有子进程句柄 ⇒ node:test 子进程永不退出、全量套件挂起。注入
      // 缺席基线（既有诚实降级路径）；效果验证语义由 pan39-42 另册执法。
      captureBeforeProbe: async () => null,
    });
    const r = await ex.executeAction({ kind: 'type_text', args: { text: 'topsecret' } });
    assert.equal(r.ok, false, 'dryRun 宿主上拒绝派发');
    assert.match(r.note, /dry-run/, '归因 guardDryRun（诚实报错，不把被吞当交付）');
    // 存证 marker：三态 = failed（拒绝发生在参数/派发之前 —— 脱敏事实面随之缺席）；
    // 内容零明文纪律不受影响
    assert.equal(markers.length, 1);
    assert.equal(markers[0].kind, 'SANDBOX_HOST_REPLAY');
    assert.equal(markers[0].action, 'type_text');
    assert.equal(markers[0].result, 'failed');
    assert.ok(!JSON.stringify(markers).includes('topsecret'), '文本内容零明文（GUARD_PROBE 脱敏同律）');
  } finally {
    await systemNs.system.configure({ dryRun: false } as ConfigType);
  }
});

test('ΝΩ-1d: 黑名单热键被 system 层拦截（第四通道不再绕过黑名单）', async () => {
  await systemNs.system.configure({ dryRun: false, hotkeyBlacklist: 'alt+f4,meta' } as ConfigType);
  const restoreScroll = patchSystem('scroll', async () => { /* 探针隔离：离线不触服务 */ });
  try {
    const markers: Array<Record<string, unknown>> = [];
    const ex = physicalBackendHostExecutor(systemNs, {
      appendMarker: m => { markers.push(m); return Promise.resolve(); },
    }, {
      // F4-4（终验工单）：本册文件契约「全离线确定性、零网络」—— ΠΑΝ-42 的
      // before 基线取证走生产路径会拉起真实 D-5 服务（spawn python），被拉起
      // 的服务持有子进程句柄 ⇒ node:test 子进程永不退出、全量套件挂起。注入
      // 缺席基线（既有诚实降级路径）；效果验证语义由 pan39-42 另册执法。
      captureBeforeProbe: async () => null,
    });
    const r = await ex.executeAction({ kind: 'press_hotkey', args: { keys: ['alt', 'f4'] } });
    assert.equal(r.ok, false);
    assert.match(String(r.note), /系统级热键被黑名单拦截/, '拦截事实明说（system 层执法）');
    assert.match(String(r.note), /alt\+f4/, '命中和弦归因');
    assert.equal(markers[0].result, 'failed', '政策拒绝 = failed（世界未被触碰）');
  } finally {
    restoreScroll();
    await systemNs.system.configure({ dryRun: false, hotkeyBlacklist: '' } as ConfigType);
  }
});

test('ΝΩ-1e: 存证 marker 三态 + 坐标经 system 换算派发 + 无机械动作步免审计', async () => {
  const px: Array<number | string> = [];
  const r0 = patchSystem('scroll', async () => {});
  const r1 = patchSystem('getScreenSize', async () => ({ width: 1000, height: 500 }));
  const r2 = patchSystem('clickMouse', async (x: number, y: number, b: string) => { px.push(x, y, b); });
  try {
    const markers: Array<Record<string, unknown>> = [];
    const ex = physicalBackendHostExecutor(systemNs, {
      appendMarker: m => { markers.push(m); return Promise.resolve(); },
    }, {
      // F4-4（终验工单）：本册文件契约「全离线确定性、零网络」—— ΠΑΝ-42 的
      // before 基线取证走生产路径会拉起真实 D-5 服务（spawn python），被拉起
      // 的服务持有子进程句柄 ⇒ node:test 子进程永不退出、全量套件挂起。注入
      // 缺席基线（既有诚实降级路径）；效果验证语义由 pan39-42 另册执法。
      captureBeforeProbe: async () => null,
    });
    // ok 态：归一坐标 → system 像素域换算（0.5,0.5)×(1000,500) = (500,250)
    const okClick = await ex.executeAction({
      kind: 'click_mouse', args: { x: 0.5, y: 0.5, button: 'right' },
    });
    assert.equal(okClick.ok, true);
    assert.deepEqual(px, [500, 250, 'right'], '派发经 system 层（像素换算方言）');
    assert.equal(markers[0].kind, 'SANDBOX_HOST_REPLAY');
    assert.equal(markers[0].result, 'ok');
    assert.deepEqual(markers[0].point, { x: 0.5, y: 0.5 }, 'marker 记归一化坐标（脱敏域）');
    // threw 态：派发通道异常（非政策拒绝）
    const r3 = patchSystem('getScreenSize', async () => { throw new Error('backend gone'); });
    const threw = await ex.executeAction({ kind: 'click_mouse', args: { x: 0.5, y: 0.5 } });
    assert.equal(threw.ok, false);
    assert.match(threw.note, /dispatch error/);
    assert.equal(markers[1].result, 'threw');
    r3();
    // failed 态（参数执法）：越界坐标 ⇒ 派发前拒绝
    const bad = await ex.executeAction({ kind: 'click_mouse', args: { x: 1.5, y: 0.5 } });
    assert.equal(bad.ok, false);
    assert.equal(markers[2].result, 'failed');
    // 无机械动作步：免探测免审计（noop 无派发即无存证行）
    const noop = await ex.executeAction({ kind: 'noop', args: {} });
    assert.equal(noop.ok, true);
    assert.equal(markers.length, 3, 'noop 不产存证行（与宿主 replayOne 无害占位同律）');
  } finally {
    r2(); r1(); r0();
  }
});

test('ΝΩ-1f: 指纹位宽域执法 —— [01]{32,256} 摄取；域外拒收；64 位零回归', async () => {
  const b = (n: number) => '01'.repeat(n / 2);
  assert.equal(FINGERPRINT_MIN_BITS, 32);
  assert.equal(FINGERPRINT_MAX_BITS, 256);
  // 嗅探面：JSON 载荷中的各宽度指纹字段
  const sniff = (v: string) =>
    sniffFingerprint(JSON.stringify({ state_anchor: { scene_fingerprint: v } }));
  assert.equal(sniff(b(64)), b(64), '64 位零回归');
  assert.equal(sniff(b(128)), b(128), '128 位可嗅探');
  assert.equal(sniff(b(256)), b(256), '上界含端');
  assert.equal(sniff(b(30) + '0'), null, '低于下界 ⇒ 拒收（证据量不足）');
  assert.equal(sniff(b(258)), null, '超过上界 ⇒ 拒收（非已知方言）');
  assert.equal(isBinaryFingerprint('0'.repeat(64) + '2'), false, '非二进制字符拒收');
  // 摄取面（engine.noteHostObservation 同一判据 —— 单源不漂移）
  const eng = new SandboxEngineImpl(null);
  eng.configure({});
  eng.noteHostObservation(b(32));
  eng.noteHostObservation(b(16)); // 域外：不覆盖已摄取缓存（保守拒收非清空）
  const snap = await eng.createSnapshot();
  assert.ok(snap.ok && snap.value.screenDhash === b(32), '摄取侧与嗅探侧同域');
  eng.reset();
});

test('ΝΩ-1g: 审计登记 —— replay_on_host 入 MUTATING_TOOL_NAMES（先行审计 WAL 面）', () => {
  assert.ok(MUTATING_TOOL_NAMES.has('replay_on_host'),
    '宿主重放 = 物理动作面工具，必须在变更类名单（ΑΩ-R28 立法）');
  assert.ok(MUTATING_TOOL_NAMES.size >= 18, 'W6R-A9 WAL 下限守护保持绿');
});
