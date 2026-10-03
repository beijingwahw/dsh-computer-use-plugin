// test/w3branch.test.ts
// W3-6（H3 反事实岔路卡 · Ghost Replay 纠偏）执法册 —— 全离线字面量验证，
// 零网络零真实感知；checkpoint 面用 tmp 目录 + 注入时钟。覆盖：
//   H3-1 Top-3 落盘 —— 排序/效用账（手算对照）/rank1 ≡ scoreOptions 胜者/
//      空候选不落账/记账纯度（改输入不动账面）
//   H3-2 环形有界 —— 容量淘汰最旧、只保最近 K 步、注入时钟、段版本钉
//   H3-3 失败相触发 —— failed/aborted 铸卡；acting/achieved/blocked/planning
//      与空账 ⇒ 无卡（诚实降级）
//   H3-4 卡片字段完整 —— 三候选各附效用+归因（R1 根因+W2-5 恢复梯+探针链）
//      +支点引用（checkpoint 步账位置）；JSON 序列化往返；归因缺席 ⇒ unknown 兜底
//   H3-5 换支重放 —— applyBranchChoice 偏置载荷经 withSteerBias 铸入
//      scoreOptions 注入缝翻盘；效用账不被偏置污染；落选理由如实申报偏置
//   H3-6 支点防御恢复 —— 锚漂移/账无支点 ⇒ 拒绝换支；k 域防御；缺卡降级
//   H3-7 重放预算执法 —— 预算内放行、超支诚实终止（exhausted 终局）、
//      completed 后拒绝计步、非法预算 ⇒ 缺省
//   H3-8 checkpoint 段往返 —— 岔路账随档存活（第六段 branchLedger OK +
//      dump 无损往返 + 恢复后换支全链路）
//   H3-9 checkpoint 段垃圾恢复 —— 结构坏段 ⇒ 归零+SKIPPED；坏步弃置保好
//      （DROPPED 注记）；缺段 ⇒ 不触账；整段非对象 ⇒ 归零
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  BranchLedgerBook,
  branchLedger,
  generateBranchCard,
  applyBranchChoice,
  withSteerBias,
  BRANCH_REPLAY_BUDGET_STEPS,
} from '../src/branchCards.ts';
import { scoreOptions, rankTopK, actionSignature } from '../src/autonomy/counterfactual.ts';
import type { ScoringContext } from '../src/autonomy/counterfactual.ts';
import type { AutonomyActionKind, PolicyAction } from '../src/autonomy/policyEngine.ts';
import type { SnapshotElement, WorldSnapshot } from '../src/autonomy/worldSnapshot.ts';
import { ROOT_CAUSE_LADDER, type RootCauseReport } from '../src/diagnosis.ts';
import { saveCheckpoint, loadCheckpoint } from '../src/checkpoint.ts';
import { uiMemory } from '../src/uiMemory.ts';
import { failureMemory } from '../src/failureMemory.ts';
import { skillLibrary } from '../src/skillLibrary.ts';
import { telemetry } from '../src/telemetry.ts';
import { journal } from '../src/journal.ts';

// ─── 测试基建（离线确定性；与 autonomy.counterfactual.test.ts 同式工厂） ───

const close = (actual: number, expected: number, msg = '', tol = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tol, `期望 ${actual} ≈ ${expected}${msg ? `（${msg}）` : ''}（容差 ${tol}）`)

function elem(label: string): SnapshotElement {
  return {
    label, role: 'button',
    bbox: { x0: 0, y0: 0, x1: 100, y1: 40 }, center: { x: 50, y: 20 },
    confidence: 0.9, source: 'vlm', interactive: true,
  }
}

function snap(o: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    takenAt: 1, width: 1920, height: 1080, dhash: null,
    elements: o.elements ?? [], textDigest: '', popups: [], focusedRegion: null,
    sceneLabel: 'desktop', degraded: [],
  }
}

function tgt(label: string): NonNullable<PolicyAction['target']> {
  const bbox = { x0: 10, y0: 20, x1: 110, y1: 60 }
  return { bbox, center: { x: (bbox.x0 + bbox.x1) / 2, y: (bbox.y0 + bbox.y1) / 2 }, label }
}

function act(kind: AutonomyActionKind, o: Partial<PolicyAction> = {}): PolicyAction {
  return {
    kind,
    ...(o.target !== undefined ? { target: o.target } : {}),
    ...(o.payload !== undefined ? { payload: o.payload } : {}),
    rationale: o.rationale ?? '测试动作',
    expectedEffect: o.expectedEffect ?? '世界状态改变',
    utility: o.utility ?? 0.5,
    riskTier: o.riskTier ?? 'benign',
  }
}

function ctx(o: { goalKeywords?: string[]; snapshot?: WorldSnapshot } = {}): ScoringContext {
  return { goalKeywords: o.goalKeywords ?? [], snapshot: o.snapshot ?? snap() }
}

/** 五名固定候选（缺省权重 0.5/0.3/0.2 手算效用）：
 *  clickLogin   1/3 / 0.3 / 0.05 ⇒ U ≈ 0.2467；scroll 0.25/0.8/0.05 ⇒ U = 0.355；
 *  clickStranger 0 / 0.4 / 0.05 ⇒ U = 0.11；askVlm 0.35/0.6/0.05 ⇒ U = 0.345；
 *  wait 0.2/0/0.05 ⇒ U = 0.09。Top-3 = scroll > ask_vlm > clickLogin。 */
const S = snap({ elements: [elem('登录')] });
const KW = ['打开', '登录', '页面'];
const clickLogin = () => act('click', { target: tgt('登录') });
const scrollDown = () => act('scroll', { payload: { direction: 'down' } });
const clickStranger = () => act('click', { target: tgt('神秘入口') });
const askVlm = () => act('ask_vlm');
const waitAct = () => act('wait');

// checkpoint 面：每用例干净世界（子系统 + 单例岔路账 + 独立 tmp 目录）
let dir: string;
const dirs: string[] = [];
beforeEach(() => {
  uiMemory.reset();
  failureMemory.reset();
  skillLibrary.reset();
  telemetry.reset();
  journal.reset();
  branchLedger.reset();
  dir = mkdtempSync(path.join(tmpdir(), 'w3b-'));
  dirs.push(dir);
});
process.on('exit', () => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

// ─── H3-1 Top-3 落盘 ───

test('H3-1: Top-3 落盘 —— 排序、效用手算对照、rank1 ≡ scoreOptions 胜者、空候选不落账、记账纯度', () => {
  const book = new BranchLedgerBook({ now: () => 1000 });
  const c = ctx({ goalKeywords: KW, snapshot: S });
  const five = [clickLogin(), scrollDown(), clickStranger(), askVlm(), waitAct()];
  const rec = book.record(five, c, { stepIndex: 3, journalLength: 7, chainTip: 'TIP7' });
  assert.ok(rec, '五候选 ⇒ 必有账');
  assert.equal(rec.candidates.length, 3, 'Top-3 截断');
  assert.deepEqual(rec.candidates.map(x => x.signature), ['scroll:', 'ask_vlm:', 'click:登录'], '按效用降序');
  assert.deepEqual(rec.candidates.map(x => x.rank), [1, 2, 3]);
  close(rec.candidates[0].utility, 0.355);
  close(rec.candidates[1].utility, 0.345);
  close(rec.candidates[2].utility, 0.5 * (1 / 3) + 0.3 * 0.3 - 0.2 * 0.05);
  assert.deepEqual(rec.candidates.map(x => x.wasChosen), [true, false, false], 'rank1 = 当步采纳者');
  assert.equal(rec.candidates[0].action.kind, 'scroll');
  assert.ok(rec.candidates[0].predictedEffects.length >= 1, '预期效果清单随行');
  assert.equal(rec.stepIndex, 3);
  assert.equal(rec.recordedAt, 1000, '注入时钟');
  assert.deepEqual(rec.anchor, { journalLength: 7, chainTip: 'TIP7' }, '支点引用 = checkpoint 步账位置');

  // rank1 ≡ scoreOptions 胜者（同一择优引擎 —— 效用账与决策账互证）
  const plan = scoreOptions(five, c);
  assert.ok(plan);
  assert.equal(actionSignature(plan.chosen.action), rec.candidates[0].signature);
  // rankTopK 直测：深度防御（0 夹 1 / NaN ⇒ 缺省 3）
  assert.equal(rankTopK(five, c, 0)!.length, 1);
  assert.equal(rankTopK(five, c, Number.NaN)!.length, 3);
  assert.equal(rankTopK([], c), null, '空候选 ⇒ null 不伪造');
  // 空候选 / 全脏候选 ⇒ 不落账
  assert.equal(book.record([], c), null);
  assert.equal(book.record([null, 3] as unknown as PolicyAction[], c), null);
  assert.equal(book.size, 1);
  // 记账纯度：落账后改写输入动作，账面不动（深拷贝隔离）
  five[0].expectedEffect = '被改写的预期';
  assert.ok(!JSON.stringify(book.dump()).includes('被改写的预期'));
});

// ─── H3-2 环形有界 ───

test('H3-2: 环形有界 —— 容量淘汰最旧，只保最近 K 步；段版本钉', () => {
  let t = 0;
  const book = new BranchLedgerBook({ capacity: 3, now: () => ++t * 100 });
  for (let i = 1; i <= 5; i++) {
    assert.ok(book.record([scrollDown(), waitAct()], ctx(), { stepIndex: i }));
  }
  assert.equal(book.size, 3, '容量 3 —— 环形有界');
  const dump = book.dump();
  assert.deepEqual(dump.entries.map(e => e.stepIndex), [3, 4, 5], '最旧两步被淘汰');
  assert.deepEqual(dump.entries.map(e => e.recordedAt), [300, 400, 500], '注入时钟随步递增');
  assert.equal(dump.version, 1, '段内版本钉（checkpoint 主体沿原地扩展律保持 v4）');
  assert.equal(dump.capacity, 3);
  assert.equal(book.latest()?.stepIndex, 5);
  // 缺省容量 8
  const big = new BranchLedgerBook({ now: () => 1 });
  for (let i = 1; i <= 12; i++) big.record([scrollDown()], ctx(), { stepIndex: i });
  assert.equal(big.size, 8);
  assert.deepEqual(big.dump().entries.map(e => e.stepIndex), [5, 6, 7, 8, 9, 10, 11, 12]);
  // 脏容量夹 1
  const odd = new BranchLedgerBook({ capacity: -5, now: () => 1 });
  odd.record([scrollDown()], ctx(), { stepIndex: 1 });
  odd.record([waitAct()], ctx(), { stepIndex: 2 });
  assert.equal(odd.size, 1, '脏容量 -5 ⇒ 夹 1');
  assert.equal(odd.latest()?.stepIndex, 2);
});

// ─── H3-3 失败相触发 ───

test('H3-3: 失败相触发 —— failed/aborted 铸卡；非失败相与空账 ⇒ 无卡（诚实降级）', () => {
  const book = new BranchLedgerBook({ now: () => 42 });
  book.record([clickLogin(), scrollDown(), clickStranger()], ctx({ goalKeywords: KW, snapshot: S }), {
    stepIndex: 2, journalLength: 5, chainTip: 'tip5',
  });
  // 非失败终局相：不铸卡（岔路卡只在失败后有意义）
  assert.equal(generateBranchCard(book, { phase: 'acting', reason: '执行中' }), null);
  assert.equal(generateBranchCard(book, { phase: 'achieved', reason: '达成' }), null);
  assert.equal(generateBranchCard(book, { phase: 'blocked', reason: '阻塞' }), null);
  assert.equal(generateBranchCard(book, { phase: 'planning' }), null);
  assert.equal(generateBranchCard(book, { phase: 'garbage' }), null, '脏相 ⇒ null 不抛');
  // 空账（未武装 / 崩溃后未恢复）⇒ 卡片缺席
  assert.equal(generateBranchCard(new BranchLedgerBook(), { phase: 'failed', reason: 'x' }), null);
  assert.equal(generateBranchCard(null, { phase: 'failed', reason: 'x' }), null);
  // 失败终局相 ⇒ 铸卡
  const cardF = generateBranchCard(book, { phase: 'failed', reason: '第 1 条判据被违反', now: () => 99 });
  assert.ok(cardF);
  assert.equal(cardF.goalPhase, 'failed');
  assert.equal(cardF.goalReason, '第 1 条判据被违反');
  assert.equal(cardF.createdAt, 99);
  assert.equal(cardF.cardVersion, 1);
  const cardA = generateBranchCard(book, { phase: 'aborted', reason: '超步' });
  assert.ok(cardA);
  assert.equal(cardA.goalPhase, 'aborted');
});

// ─── H3-4 卡片字段完整 ───

test('H3-4: 卡片字段完整 —— 效用 + 归因（根因/恢复梯/探针链）+ 支点；JSON 往返；归因缺席 ⇒ unknown', () => {
  const book = new BranchLedgerBook({ now: () => 1 });
  book.record([clickLogin(), scrollDown(), clickStranger()], ctx({ goalKeywords: KW, snapshot: S }), {
    stepIndex: 2, journalLength: 5, chainTip: 'tip5',
  });
  const report: RootCauseReport = {
    tool: 'click_mouse',
    rootCause: 'blind-spot-text',
    candidates: [{
      rootCause: 'blind-spot-text', score: 0.92,
      hypothesis: 'Switch modality: keyboard via press_hotkey (tab/enter).', chain: [],
    }],
    trail: [
      { probe: 'visual-diff', symptom: 's0', differential: 'd0', observation: 'identical=true' },
      { probe: 'hover-cursor', symptom: 's1', differential: 'd1', observation: 'cursor=ibeam' },
    ],
    degraded: false, degradedNotes: [],
  };
  const card = generateBranchCard(book, { phase: 'failed', reason: '判据违反', attribution: report, now: () => 7 });
  assert.ok(card);
  assert.equal(card.candidates.length, 3);
  for (const c of card.candidates) {
    assert.equal(typeof c.signature, 'string');
    assert.ok(c.signature.length > 0);
    assert.ok(c.action && typeof c.action.kind === 'string', '动作形状随行');
    assert.ok(Array.isArray(c.predictedEffects) && c.predictedEffects.length >= 1, '预期效果随行');
    assert.ok(Number.isFinite(c.utility), '预测效用在账');
    assert.ok(Number.isFinite(c.progressProbability) && Number.isFinite(c.informationGain) && Number.isFinite(c.risk));
    assert.equal(c.attribution.rootCause, 'blind-spot-text', 'diagnosis 根因只读消费');
    assert.equal(c.attribution.hypothesis, 'Switch modality: keyboard via press_hotkey (tab/enter).');
    assert.deepEqual(c.attribution.recoveryLadder, ROOT_CAUSE_LADDER['blind-spot-text'], 'W2-5 恢复梯随行');
    assert.equal(c.attribution.recoveryLadder[0], 'switch-modality');
    assert.deepEqual(c.attribution.probeTrail, ['visual-diff: identical=true', 'hover-cursor: cursor=ibeam'], '探针链可回放');
    assert.equal(c.attribution.degraded, false);
  }
  close(card.candidates[0].utility, 0.355, '效用账面 = 诚实预测（未被任何偏置污染）');
  assert.ok(card.candidates[0].utility >= card.candidates[1].utility && card.candidates[1].utility >= card.candidates[2].utility);
  assert.equal(card.pivot.stepIndex, 2, '支点 = 失败前最近的可岔步');
  assert.deepEqual(card.pivot.anchor, { journalLength: 5, chainTip: 'tip5' }, '支点引用 = checkpoint 步账位置');
  // 可序列化往返（结构化卡片）
  assert.deepEqual(JSON.parse(JSON.stringify(card)), card);
  // 归因缺席 / 垃圾 ⇒ unknown 兜底（R1 兜底律）
  const cardUnk = generateBranchCard(book, { phase: 'failed', attribution: null });
  assert.ok(cardUnk);
  assert.equal(cardUnk.candidates[0].attribution.rootCause, 'unknown');
  assert.deepEqual(cardUnk.candidates[0].attribution.recoveryLadder, ROOT_CAUSE_LADDER.unknown);
  const cardJunk = generateBranchCard(book, {
    phase: 'failed',
    attribution: { rootCause: '垃圾值' } as unknown as RootCauseReport,
  });
  assert.ok(cardJunk);
  assert.equal(cardJunk.candidates[0].attribution.rootCause, 'unknown', '垃圾根因防御解析 ⇒ unknown');
});

// ─── H3-5 换支重放：偏置注入缝 ───

test('H3-5: 换支重放 —— steer(2) 偏置经 preferredActionKeys 注入缝翻盘；效用账不被污染', () => {
  const book = new BranchLedgerBook({ now: () => 1 });
  const base = ctx({ goalKeywords: KW, snapshot: S });
  const cands = [clickLogin(), scrollDown(), askVlm()]; // 缺省胜者 = scroll（0.355）
  book.record(cands, base, { stepIndex: 4, journalLength: 9, chainTip: 'tip9' });
  const card = generateBranchCard(book, { phase: 'failed', reason: '违反' });
  assert.ok(card);
  assert.equal(card.candidates[0].signature, 'scroll:', '原路胜者在卡面 rank1');

  const res = applyBranchChoice(card, 2); // 用户改选候选 2（ask_vlm）
  assert.equal(res.ok, true);
  assert.equal(res.k, 2);
  assert.equal(res.choice!.signature, 'ask_vlm:');
  close(res.choice!.utility, 0.345, '选中候选的诚实预测效用');
  assert.deepEqual(res.bias!.preferredActionKeys, ['ask_vlm:'], '偏置载荷 = 选中者签名');

  // 注入缝消费：withSteerBias 铸入后，scoreOptions 择优翻盘
  const biased = withSteerBias(base, res.bias!.preferredActionKeys);
  assert.deepEqual(biased.preferredActionKeys, ['ask_vlm:']);
  assert.equal(base.preferredActionKeys, undefined, '原 ctx 不被改动（纯函数）');
  const planB = scoreOptions(cands, biased);
  assert.ok(planB);
  assert.equal(planB.chosen.action.kind, 'ask_vlm', '改选候选 2 ⇒ ask_vlm 胜');
  const rejScroll = planB.rejected.find(r => r.option.action.kind === 'scroll');
  assert.ok(rejScroll);
  assert.ok(rejScroll.why.includes('改选偏置'), `落选理由如实申报偏置：${rejScroll.why}`);
  assert.ok(rejScroll.why.includes('0.36') || rejScroll.why.includes('0.35'), `理由带诚实效用数值：${rejScroll.why}`);

  // 效用账不被偏置污染：rankTopK 偏置后 rank1 = ask_vlm，但账面 utility 仍诚实
  const rkB = rankTopK(cands, biased, 3);
  assert.ok(rkB);
  assert.equal(rkB[0].option.action.kind, 'ask_vlm');
  assert.equal(rkB[0].steered, true, '偏置审计标记');
  close(rkB[0].utility, 0.345, '偏置只改名次，不改账面');
  close(rkB[1].utility, 0.355, '让位的 scroll 账面原值保留');
  assert.equal(rkB[1].steered, false);

  // 无偏置 ctx 行为不变（决策纯度：偏置不泄漏）
  const planA = scoreOptions(cands, ctx({ goalKeywords: KW, snapshot: S }));
  assert.ok(planA);
  assert.equal(planA.chosen.action.kind, 'scroll');
  // withSteerBias 对脏 ctx 防御（null ⇒ 最小上下文 + 偏置键仍在）
  const dirty = withSteerBias(null as unknown as ScoringContext, ['ask_vlm:']);
  assert.deepEqual(dirty.preferredActionKeys, ['ask_vlm:']);
});

// ─── H3-6 支点防御恢复与 k 域 ───

test('H3-6: 支点防御 —— 锚漂移/账无支点 ⇒ 拒绝换支；k 域防御；缺卡降级', () => {
  const book = new BranchLedgerBook({ now: () => 1 });
  book.record([scrollDown(), askVlm()], ctx(), { stepIndex: 6, journalLength: 11, chainTip: 'tip11' });
  const card = generateBranchCard(book, { phase: 'aborted', reason: '超步' });
  assert.ok(card);
  // 缺卡 / 坏卡 ⇒ 诚实拒绝
  assert.equal(applyBranchChoice(null, 1).ok, false);
  assert.equal(applyBranchChoice(undefined, 1).ok, false);
  assert.equal(applyBranchChoice({ cardVersion: 9 } as unknown as never, 1).ok, false, '坏版本钉 ⇒ 拒绝');
  // k 域防御
  for (const bad of [0, 3, 2.5, Number.NaN, '2', null]) {
    const r = applyBranchChoice(card, bad as unknown as number);
    assert.equal(r.ok, false, `k=${String(bad)} ⇒ 拒绝`);
    assert.ok(r.error!.includes('invalid choice') || r.error!.includes('no branch card'));
  }
  // 锚校验通过 ⇒ ok + 如实注记
  const okRes = applyBranchChoice(card, 1, { verifyAnchor: { journalLength: 11, chainTip: 'tip11' } });
  assert.equal(okRes.ok, true);
  assert.ok(okRes.restore!.note.includes('校验通过'), okRes.restore!.note);
  assert.deepEqual(okRes.restore!.anchor, { journalLength: 11, chainTip: 'tip11' });
  // 锚漂移（journal 条数 / 链尖任一不等）⇒ 拒绝（防御式：不从错位世界重放）
  const drift1 = applyBranchChoice(card, 1, { verifyAnchor: { journalLength: 12, chainTip: 'tip11' } });
  assert.equal(drift1.ok, false);
  assert.ok(drift1.error!.includes('mismatch'), drift1.error);
  const drift2 = applyBranchChoice(card, 2, { verifyAnchor: { journalLength: 11, chainTip: 'OTHER' } });
  assert.equal(drift2.ok, false);
  assert.ok(drift2.error!.includes('mismatch'));
  // 当前账无该支点步（环形淘汰 / 段未恢复）⇒ 拒绝
  const evicted = new BranchLedgerBook({ capacity: 1, now: () => 1 });
  evicted.record([scrollDown()], ctx(), { stepIndex: 99, journalLength: 11, chainTip: 'tip11' }); // 支点步 6 已被淘汰
  const noPivot = applyBranchChoice(card, 1, { ledger: evicted });
  assert.equal(noPivot.ok, false);
  assert.ok(noPivot.error!.includes('无支点'), noPivot.error);
  // 账中有支点 ⇒ 放行（checkpoint 段恢复后的常规路径）
  const hasPivot = applyBranchChoice(card, 1, { ledger: book });
  assert.equal(hasPivot.ok, true);
  // 未提供校验锚 ⇒ 如实申报「未经强校验」（不伪造强保证）
  const noVerify = applyBranchChoice(card, 1);
  assert.equal(noVerify.ok, true);
  assert.ok(noVerify.restore!.note.includes('未经强校验'), noVerify.restore!.note);
});

// ─── H3-7 重放预算执法 ───

test('H3-7: 重放预算 —— 预算内放行计步、超支诚实终止（终局）、非法预算 ⇒ 缺省', () => {
  const book = new BranchLedgerBook({ now: () => 1 });
  book.record([scrollDown(), askVlm(), clickLogin()], ctx(), { stepIndex: 1, journalLength: 2, chainTip: 't' });
  const card = generateBranchCard(book, { phase: 'failed', reason: 'r' });
  assert.ok(card);

  const res = applyBranchChoice(card, 1, { budgetSteps: 3 });
  assert.equal(res.ok, true);
  const ctl = res.replay!;
  assert.deepEqual(ctl.state, { status: 'armed', stepsUsed: 0, budgetSteps: 3 });
  for (let i = 1; i <= 3; i++) {
    const s = ctl.spend();
    assert.equal(s.proceed, true, `第 ${i} 步预算内放行`);
    assert.equal(s.stepsUsed, i);
    assert.equal(s.status, 'stepping');
  }
  const over = ctl.spend();
  assert.equal(over.proceed, false, '第 4 步超支 ⇒ 拒绝');
  assert.equal(over.status, 'exhausted');
  assert.ok(over.note!.includes('诚实终止'), over.note!);
  assert.equal(over.stepsUsed, 3, '超支不偷偷计步');
  assert.deepEqual(ctl.state, { status: 'exhausted', stepsUsed: 3, budgetSteps: 3 });
  ctl.complete(); // exhausted 是终局 —— complete 不改判
  assert.equal(ctl.state.status, 'exhausted');
  assert.equal(ctl.spend().proceed, false, '超支后继续 spend 仍拒绝');

  // 正常收尾：completed 后拒绝计步（调用方账目混乱防御）
  const res2 = applyBranchChoice(card, 2, { budgetSteps: 1 });
  const ctl2 = res2.replay!;
  assert.equal(ctl2.spend().proceed, true);
  ctl2.complete();
  assert.equal(ctl2.state.status, 'completed');
  const late = ctl2.spend();
  assert.equal(late.proceed, false);
  assert.ok(late.note!.includes('已完成'), late.note!);

  // 非法预算 ⇒ 缺省 12（BRANCH_REPLAY_BUDGET_STEPS）
  assert.equal(applyBranchChoice(card, 1, { budgetSteps: Number.NaN }).replay!.state.budgetSteps, BRANCH_REPLAY_BUDGET_STEPS);
  assert.equal(applyBranchChoice(card, 3, { budgetSteps: 0 }).replay!.state.budgetSteps, 1, '0 夹 1');
  assert.equal(applyBranchChoice(card, 1).replay!.state.budgetSteps, 12, '缺省预算 12');
});

// ─── H3-8 checkpoint 段往返 ───

test('H3-8: checkpoint 段往返 —— 岔路账随档存活，恢复后换支全链路', () => {
  // 单例账播种（生产接线同款：每步决策后 record）
  branchLedger.record([clickLogin(), scrollDown(), clickStranger()], ctx({ goalKeywords: KW, snapshot: S }), {
    stepIndex: 2, journalLength: 3, chainTip: 'A1',
  });
  branchLedger.record([askVlm()], ctx(), { stepIndex: 3, journalLength: 4, chainTip: 'A2' });
  const before = branchLedger.dump();
  assert.equal(before.entries.length, 2);

  const file = path.join(dir, 'cp.json');
  assert.equal(saveCheckpoint(file).ok, true);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.version, 4, '主体版本沿原地扩展律保持 v4（W3-6 段自带版本钉）');
  assert.ok(Array.isArray(saved.branchLedger?.entries) && saved.branchLedger.entries.length === 2, '岔路账随档落盘');

  // 模拟崩溃：账面清零
  branchLedger.reset();
  assert.equal(branchLedger.size, 0);

  const { restored, report } = loadCheckpoint(file);
  assert.equal(restored, true);
  assert.ok(report.includes('branchLedger: OK'), report.join('; '));
  assert.deepEqual(branchLedger.dump(), before, '岔路账无损往返（原地满血）');

  // 恢复后的账直接换支（Ghost Replay 纠偏链路：恢复 → 铸卡 → 选支 → 预算）
  const card = generateBranchCard(branchLedger, { phase: 'aborted', reason: '超步' });
  assert.ok(card);
  assert.equal(card.pivot.stepIndex, 3);
  const pick = applyBranchChoice(card, 1, {
    verifyAnchor: { journalLength: 4, chainTip: 'A2' },
    ledger: branchLedger,
    budgetSteps: 5,
  });
  assert.equal(pick.ok, true, '支点锚校验 + 账内支点在场 ⇒ 换支放行');
  assert.equal(pick.replay!.state.budgetSteps, 5);
});

// ─── H3-9 checkpoint 段垃圾恢复 ───

test('H3-9: checkpoint 段垃圾恢复 —— 结构坏段归零+SKIPPED；坏步弃置保好；缺段不触账', () => {
  branchLedger.record([scrollDown()], ctx(), { stepIndex: 1, journalLength: 2, chainTip: 'B1' });
  branchLedger.record([askVlm()], ctx(), { stepIndex: 2, journalLength: 3, chainTip: 'B2' });
  const file = path.join(dir, 'cp.json');
  assert.equal(saveCheckpoint(file).ok, true);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const goodEntries = raw.branchLedger.entries;
  assert.equal(goodEntries.length, 2);

  // ① 结构坏段（entries 非数组）⇒ 归零 + SKIPPED 注记
  raw.branchLedger = { version: 1, capacity: 8, entries: '垃圾' };
  writeFileSync(file, JSON.stringify(raw));
  branchLedger.reset();
  const r1 = loadCheckpoint(file);
  assert.equal(r1.restored, true, '单段损坏不拖垮整档');
  assert.ok(r1.report.some(l => l.startsWith('branchLedger: SKIPPED')), r1.report.join('; '));
  assert.equal(branchLedger.size, 0, '垃圾段 ⇒ 空账冷启动（不残留旧账冒充恢复产物）');

  // ② 坏步弃置保好：两步好 + 两步坏 ⇒ DROPPED 2 注记、好步照常复活
  raw.branchLedger = { version: 1, capacity: 8, entries: [{ stepIndex: 'x' }, ...goodEntries, null] };
  writeFileSync(file, JSON.stringify(raw));
  branchLedger.reset();
  const r2 = loadCheckpoint(file);
  assert.equal(r2.restored, true);
  assert.ok(r2.report.some(l => l.includes('branchLedger: DROPPED 2 malformed steps')), r2.report.join('; '));
  assert.equal(branchLedger.size, 2);
  assert.deepEqual(branchLedger.dump().entries.map(e => e.stepIndex), [1, 2]);
  // 恢复后的账仍可铸卡换支（坏账不连坐好路；该步只落 1 候选 ⇒ k 域为 1..1）
  const card = generateBranchCard(branchLedger, { phase: 'failed', reason: 'r' });
  assert.ok(card);
  assert.equal(card.pivot.stepIndex, 2);
  assert.equal(applyBranchChoice(card, 1, { ledger: branchLedger }).ok, true);

  // ③ 缺段（W3-6 前旧档形态）⇒ 不触账（既不归零也不覆盖 —— 诚实冷启动语义）
  delete raw.branchLedger;
  writeFileSync(file, JSON.stringify(raw));
  branchLedger.reset();
  branchLedger.record([waitAct()], ctx(), { stepIndex: 8, journalLength: 9, chainTip: 'C' });
  const r3 = loadCheckpoint(file);
  assert.ok(r3.report.includes('branchLedger: OK'), '缺段 = 非错误（防御性恢复的红利）');
  assert.equal(branchLedger.size, 1, '缺段 ⇒ 账面不动');
  assert.equal(branchLedger.latest()?.stepIndex, 8);

  // ④ 整段非对象垃圾 ⇒ 归零 + SKIPPED
  raw.branchLedger = 'garbage';
  writeFileSync(file, JSON.stringify(raw));
  branchLedger.record([scrollDown()], ctx(), { stepIndex: 9, journalLength: 10, chainTip: 'D' });
  const r4 = loadCheckpoint(file);
  assert.ok(r4.report.some(l => l.startsWith('branchLedger: SKIPPED')), r4.report.join('; '));
  assert.equal(branchLedger.size, 0, '整段垃圾 ⇒ 归零冷启动');
});
