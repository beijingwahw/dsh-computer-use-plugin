// test/epochUpsilon.sleep.test.ts
// 纪元 Υ（认知睡眠周期）执法册：
//   Υ-1 六幕执法：注入计数 stub 的全 deps —— 六幕全部被调、幕序正确、报告字段
//      齐全；缺席 deps ⇒ 对应幕 skipped 不炸（含空 deps 全 skipped、mineMotifs
//      回退面、预算保险丝逐幕 timeout 的附测）；
//   Υ-2 幂等水位线：同一 journal 状态睡两次 —— 第二次六幕全 noop、消化面零
//      新增调用、零新增落盘；跨进程模拟（resetSleepCycle + trace 尾行恢复）同律；
//      journal 前进 ⇒ 水位线移动 ⇒ 重新实睡；
//   Υ-3 晨报落盘：sleepTracePath 指向 tmp 文件 —— 两轮睡眠追加两行报告（每行
//      完整 JSON）；截断最后半行后重睡不炸（断行容忍 + 断尾治疗后新行可读）；
//   Υ-4 永不抛：deps 混入会 throw 的假对象 + 非法 trace 路径 ⇒ runSleepCycle
//      吸收并在报告标 error，绝不向上抛。
// 全程离线、注入时钟、确定性（零真钟零网络零睡眠）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runSleepCycle, resetSleepCycle, DEFAULT_SLEEP_BUDGET_MS,
  type SleepDeps, type SleepReport,
} from '../src/sleep/index.ts';

// ─── 假件工厂（计数 stub —— 全离线、全确定性） ───

/** 固定步进时钟：每次读数 +step（durationMs 与预算判定皆可精确断言） */
function tickClock(start = 1_000_000, step = 10): { now: () => number } {
  let t = start;
  return { now: () => (t += step) };
}

/** 断行判别：一行是否为完整可解析 JSON（断尾容忍断言用） */
function isParsableJson(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

/** 假 journal 条目（JournalEntry 的合法子集；hash 供水位线指纹） */
interface FakeEntry {
  ts: number;
  tool: string;
  args: Record<string, unknown>;
  status: string;
  hash?: string;
  thought?: string;
  observe?: string;
  effect_detected?: boolean;
}

function entry(over: Partial<FakeEntry> = {}): FakeEntry {
  return {
    ts: 1700000000,
    tool: 'click_mouse',
    args: { x: 0.5, y: 0.5, target_description: 'Submit 按钮' },
    status: 'SUCCESS',
    effect_detected: true,
    thought: '提交表单前先确认必填项已填',
    observe: 'scene-login-001',
    hash: 'hash-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ...over,
  };
}

/** 假 journal：可控条目 + 逐方法调用计数 */
function fakeJournal(entries: FakeEntry[]) {
  const calls = { list: 0, verify: 0, findDecisionPoints: 0, currentTask: 0 };
  return {
    calls,
    list(actionOnly = true): FakeEntry[] {
      calls.list++;
      return actionOnly ? entries.filter(e => e.tool === 'click_mouse') : entries;
    },
    verify() {
      calls.verify++;
      return { ok: true, length: entries.length, brokenAt: null };
    },
    findDecisionPoints() {
      calls.findDecisionPoints++;
      return [{ index: 0, entry: entries[0] ?? entry(), thought: null, alternatives: [] }];
    },
    currentTask() {
      calls.currentTask++;
      return '登录门户并导出报表';
    },
  };
}

/** 假技能库：只有 induceFromJournal（能力探测应选它，不触 mineMotifs） */
function fakeSkillLibrary() {
  const calls = { induceFromJournal: 0, mineMotifs: 0 };
  return {
    calls,
    induceFromJournal(description: string) {
      calls.induceFromJournal++;
      return { id: 7, name: 'skill-7', description, steps: [{ tool: 'click_mouse', args: {} }] };
    },
    mineMotifs() {
      calls.mineMotifs++;
      return [];
    },
  };
}

/** 假知识库：consolidate 返回固定免疫战报 */
function fakeKnowledgeBase() {
  const calls = { consolidate: 0 };
  return {
    calls,
    consolidate() {
      calls.consolidate++;
      return {
        ok: true,
        value: { episodes: 6, clusters: 2, consolidated: 2, episodedDecayed: 5, durationMs: 3 },
      };
    },
  };
}

/** 假校准器：tick 产出一份固定校准报告 */
function fakeCalibrator() {
  const calls = { tick: 0 };
  return {
    calls,
    tick() {
      calls.tick++;
      return [{ key: 'popup.offThreshold', from: 0.35, to: 0.37, reason: 'optimal-threshold', generation: 2 }];
    },
  };
}

/** 全 digest 调用计数的聚合快照（幂等断言用；不含 list —— 那是水位线指纹的
 *  必读面，单独以 +1 断言，不与消化面混算） */
function digestCalls(
  j: ReturnType<typeof fakeJournal>,
  s: ReturnType<typeof fakeSkillLibrary>,
  k: ReturnType<typeof fakeKnowledgeBase>,
  c: ReturnType<typeof fakeCalibrator>,
): string {
  const { list: _fingerprintRead, ...digest } = j.calls;
  void _fingerprintRead;
  return JSON.stringify([digest, s.calls, k.calls, c.calls]);
}

// ─── Υ-1：六幕执法 ───

test('Υ-1: 六幕执法 —— 全 deps 计数 stub 逐幕被调、幕序正确、报告字段齐全', async () => {
  resetSleepCycle();
  const fj = fakeJournal([entry(), entry({ tool: 'type_text', hash: 'hash-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })]);
  const fskill = fakeSkillLibrary();
  const fkb = fakeKnowledgeBase();
  const fcal = fakeCalibrator();
  let auditCalls = 0;
  let auditedSteps = -1;
  const fakeAudit: SleepDeps['selfAudit'] = steps => {
    auditCalls++;
    auditedSteps = steps.length;
    return { verdict: 'healthy', findings: [{ severity: 'info', code: 'AUD-0', detail: 'x' }], score: 100, advice: [] };
  };
  const meterCalls = { summary: 0 };
  const deps: SleepDeps = {
    journal: fj,
    skillLibrary: fskill,
    knowledgeBase: fkb,
    calibrator: fcal,
    selfAudit: fakeAudit,
    meter: {
      summary() {
        meterCalls.summary++;
        return { calls: 12, failures: 1, promptTokens: 3400, completionTokens: 800 };
      },
    },
    log: () => { /* 测试静音 */ },
  };

  const report = await runSleepCycle(deps, { now: tickClock().now }); // tracePath 空 = 仅内存水位线

  // 幕序与全 ok
  assert.deepEqual(
    report.acts.map(a => a.name),
    ['replay', 'distill', 'immune', 'calibrate', 'audit', 'report'],
    '六幕按 回放→蒸馏→免疫→校准→审计→晨报 次序演出',
  );
  assert.ok(report.acts.every(a => a.status === 'ok'), JSON.stringify(report.acts));

  // 全部被调（消化面各恰好一次；list 另有水位线指纹读 +1）
  assert.equal(fj.calls.verify, 1, '回放幕：哈希链结算');
  assert.equal(fj.calls.findDecisionPoints, 1, '回放幕：决策点分析');
  assert.equal(fskill.calls.induceFromJournal, 1, '蒸馏幕：induceFromJournal');
  assert.equal(fskill.calls.mineMotifs, 0, 'induceFromJournal 在场 ⇒ 不触 mineMotifs 回退');
  assert.equal(fkb.calls.consolidate, 1, '免疫幕：consolidate');
  assert.equal(fcal.calls.tick, 1, '校准幕：calibrator.tick');
  assert.equal(auditCalls, 1, '审计幕：auditTrajectory 纯函数面');
  assert.equal(meterCalls.summary, 1, '晨报幕：用量台账快照');
  assert.equal(fj.calls.currentTask, 1, '蒸馏幕的归纳描述源 = journal.currentTask');

  // 报告字段齐全
  assert.equal(typeof report.startedAt, 'number');
  assert.ok(Number.isFinite(report.durationMs) && report.durationMs >= 0);
  assert.equal(typeof report.watermark, 'string');
  assert.equal(report.timeout, false);
  for (const a of report.acts) {
    assert.equal(typeof a.name, 'string');
    assert.equal(typeof a.status, 'string');
    assert.ok(a.counts && typeof a.counts === 'object', `幕 ${a.name} 的 counts 在场`);
  }

  // 幕内容抽查
  const [replay, distill, immune, calibrate, audit, morning] = report.acts;
  assert.equal(replay.counts.chainOk, 1);
  assert.equal(replay.counts.decisionPoints, 1);
  assert.equal(replay.counts.entries, 2);
  assert.equal(distill.counts.skills, 1);
  assert.equal(immune.counts.consolidated, 2);
  assert.equal(immune.counts.episodes, 6);
  assert.equal(calibrate.counts.calibrations, 1);
  assert.equal(audit.counts.steps, 1, 'list(true) 只含动作条（click_mouse）');
  assert.ok((audit.detail ?? '').includes('verdict=healthy'), audit.detail);
  assert.ok((morning.detail ?? '').includes('仅内存'), morning.detail);
  assert.equal(report.usage?.calls, 12);
  assert.equal(report.usage?.failures, 1);

  // ── 缺席 deps：只留 journal ⇒ 四幕 skipped、回放/晨报 ok、不炸 ──
  resetSleepCycle();
  const r2 = await runSleepCycle(
    { journal: fakeJournal([entry()]), log: () => {} },
    { now: tickClock().now },
  );
  const byName = Object.fromEntries(r2.acts.map(a => [a.name, a]));
  assert.equal(byName.replay.status, 'ok');
  assert.equal(byName.report.status, 'ok');
  for (const name of ['distill', 'immune', 'calibrate', 'audit']) {
    assert.equal(byName[name].status, 'skipped', `${name} 缺席 ⇒ 诚实 skipped`);
    assert.ok((byName[name].detail ?? '').length > 0, 'skipped 幕带原因附注');
  }

  // ── 空 deps：五幕全 skipped + 晨报 ok；watermark null（无法指纹 = 无法去重，诚实）──
  resetSleepCycle();
  const r3 = await runSleepCycle({}, { now: tickClock().now });
  assert.ok(r3.acts.slice(0, 5).every(a => a.status === 'skipped'));
  assert.equal(r3.acts[5].status, 'ok');
  assert.equal(r3.watermark, null);

  // ── mineMotifs 回退面：无 induceFromJournal 的库 ⇒ motifs 计数 ──
  resetSleepCycle();
  const r4 = await runSleepCycle(
    {
      journal: fakeJournal([entry()]),
      skillLibrary: { mineMotifs: () => [{ steps: [], usage: 3, motifLength: 2 }] },
      log: () => {},
    },
    { now: tickClock().now },
  );
  assert.equal(r4.acts[1].status, 'ok');
  assert.equal(r4.acts[1].counts.motifs, 1, '蒸馏幕回退到动机挖掘');

  // ── 附测：预算保险丝 —— 时钟步进超过预算 ⇒ 逐幕 timeout、半程报告照铸 ──
  resetSleepCycle();
  assert.equal(DEFAULT_SLEEP_BUDGET_MS, 2000, '缺省睡眠预算 2s（与卸载路径保险丝同值）');
  const fast = tickClock(0, 1000); // 每读数 +1000；budgetMs=500 ⇒ 首幕后任何检查必超
  const r5 = await runSleepCycle(
    { journal: fakeJournal([entry()]), log: () => {} },
    { now: fast.now, budgetMs: 500 },
  );
  assert.ok(r5.acts.every(a => a.status === 'timeout'), JSON.stringify(r5.acts));
  assert.equal(r5.timeout, true, '半程报告的 timeout 标志位');
  assert.equal(typeof r5.watermark, 'string', '超时报告仍携带水位线（指纹先行）');
});

// ─── Υ-2：幂等水位线 ───

test('Υ-2: 幂等水位线 —— 同一状态二睡零新增；跨进程（trace 尾行恢复）同律；journal 前进则重新实睡', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'upsilon-y2-'));
  try {
    const trace = join(dir, 'sleep.jsonl');
    const entries = [
      entry({ hash: 'wmk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
      entry({ hash: 'wmk-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
    ];
    const fj = fakeJournal(entries);
    const fskill = fakeSkillLibrary();
    const fkb = fakeKnowledgeBase();
    const fcal = fakeCalibrator();
    const deps: SleepDeps = {
      journal: fj, skillLibrary: fskill, knowledgeBase: fkb, calibrator: fcal,
      selfAudit: () => ({ verdict: 'healthy', findings: [], score: 100, advice: [] }),
      log: () => {},
    };

    // 一睡：实睡一轮，落一行晨报
    const r1: SleepReport = await runSleepCycle(deps, { sleepTracePath: trace, now: tickClock().now });
    assert.ok(r1.acts.every(a => a.status === 'ok'), JSON.stringify(r1.acts));
    assert.equal(readFileSync(trace, 'utf8').trim().split('\n').length, 1, '一睡 = 一行');

    // 二睡（同一 journal 状态）：六幕全 noop、消化面零新增调用、零新增落盘
    const listReadsBefore = fj.calls.list;
    const digestBefore = digestCalls(fj, fskill, fkb, fcal);
    const r2 = await runSleepCycle(deps, { sleepTracePath: trace, now: tickClock().now });
    assert.ok(r2.acts.every(a => a.status === 'noop'), JSON.stringify(r2.acts));
    assert.equal(r2.watermark, r1.watermark, '水位线未动');
    assert.equal(fj.calls.list, listReadsBefore + 1, '唯一的新增读数 = 水位线指纹（list）—— 指纹必读，消化零触');
    assert.equal(digestCalls(fj, fskill, fkb, fcal), digestBefore, 'verify/induce/consolidate/tick/audit 全部零新增');
    assert.equal(readFileSync(trace, 'utf8').trim().split('\n').length, 1, 'noop 不落盘（零新增的严格义）');

    // 跨进程模拟：内存水位线清零（新进程），trace 尾行恢复 ⇒ 仍 noop
    resetSleepCycle();
    const r3 = await runSleepCycle(deps, { sleepTracePath: trace, now: tickClock().now });
    assert.ok(r3.acts.every(a => a.status === 'noop'), 'trace 尾行是有效的跨进程水位线');
    assert.equal(readFileSync(trace, 'utf8').trim().split('\n').length, 1);

    // journal 前进一条 ⇒ 水位线移动 ⇒ 重新实睡 + 追加第二行
    entries.push(entry({ hash: 'wmk-ccccccccccccccccccccccccccccccc' }));
    const r4 = await runSleepCycle(deps, { sleepTracePath: trace, now: tickClock().now });
    assert.ok(r4.acts.every(a => a.status === 'ok'), '新状态 = 实睡');
    assert.notEqual(r4.watermark, r1.watermark);
    const lines = readFileSync(trace, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, '第二次实睡 = 第二行');
    const lastLine = JSON.parse(lines[1]);
    assert.equal(lastLine.watermark, r4.watermark, '晨报行携带水位线（下次跨进程幂等的锚）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Υ-3：晨报落盘 ───

test('Υ-3: 晨报落盘 —— 两轮追加两行完整 JSON；截断最后半行后重睡不炸（断行容忍 + 断尾治疗）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'upsilon-y3-'));
  try {
    const trace = join(dir, 'sleep-trace.jsonl');
    const mk = (n: number): FakeEntry[] =>
      Array.from({ length: n }, (_, i) => entry({ hash: `y3h${i}${'x'.repeat(14)}xxxxxxxxxxxxxxxxxx` }));

    // 第一轮（2 条）与第二轮（3 条 —— 状态前移）各落一行
    await runSleepCycle({ journal: fakeJournal(mk(2)), log: () => {} }, { sleepTracePath: trace, now: tickClock().now });
    await runSleepCycle({ journal: fakeJournal(mk(3)), log: () => {} }, { sleepTracePath: trace, now: tickClock().now });

    const text = readFileSync(trace, 'utf8');
    const lines = text.trim().split('\n');
    assert.equal(lines.length, 2, '两轮睡眠 = 两行晨报');
    for (const l of lines) {
      const obj = JSON.parse(l); // 每行皆完整 JSON（行级 append 语义）
      assert.equal(obj.type, 'sleep');
      assert.equal(typeof obj.watermark, 'string');
      assert.ok(Array.isArray(obj.acts));
      assert.ok(obj.acts.length === 6, '行内六幕齐全（含晨报幕自录）');
    }

    // 断行容忍：截掉末行尾部 20 字符 ⇒ 最后一行残缺（模拟进程被杀的半行）
    const torn = text.slice(0, Math.max(0, text.length - 20));
    writeFileSync(trace, torn, 'utf8');

    // 重睡（模拟新进程 —— reset 后只能靠 trace 恢复水位线）：断行被跳过、
    // 水位线回退到上一完整行（2 条）⇒ 实睡一次；断尾被 '\n' 治疗后新行可读
    resetSleepCycle();
    const r3 = await runSleepCycle(
      { journal: fakeJournal(mk(3)), log: () => {} },
      { sleepTracePath: trace, now: tickClock().now },
    );
    assert.ok(r3.acts.every(a => a.status === 'ok' || a.status === 'skipped'), '断尾文件不炸睡眠，照常实睡');
    assert.equal(r3.acts[0].status, 'ok', '回放幕照常演出（journal 在场）');
    assert.equal(r3.acts[5].status, 'ok', '晨报幕照常落盘（断尾被治疗）');
    assert.equal(r3.acts[5].counts.appended, 1);
    const healed = readFileSync(trace, 'utf8');
    const parsable = healed.split('\n').filter(l => l.trim() !== '' && isParsableJson(l));
    assert.equal(parsable.length, 2, '断行被跳过、治疗后的新行可读（旧行 1 + 新行 1）');

    // 治疗后的新行成为有效水位线 ⇒ 同状态再睡（新进程模拟）= noop
    resetSleepCycle();
    const r4 = await runSleepCycle(
      { journal: fakeJournal(mk(3)), log: () => {} },
      { sleepTracePath: trace, now: tickClock().now },
    );
    assert.ok(r4.acts.every(a => a.status === 'noop'), '断尾治疗的行参与水位线恢复');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Υ-4：永不抛 ───

test('Υ-4: 永不抛 —— 会 throw 的假 deps + 非法 trace 路径 ⇒ 吸收并在报告标 error，绝不向上抛', async () => {
  resetSleepCycle();
  const bomb = (msg: string): never => {
    throw new Error(msg);
  };
  // journal.list 抛 ⇒ 水位线无法指纹（null）⇒ 不去重、每睡皆实睡（诚实方向）
  const deps: SleepDeps = {
    journal: {
      list: () => bomb('journal.list 炸'),
      verify: () => bomb('journal.verify 炸'),
      findDecisionPoints: () => bomb('findDecisionPoints 炸'),
      currentTask: () => bomb('currentTask 炸'),
    },
    skillLibrary: { induceFromJournal: () => bomb('induceFromJournal 炸') },
    knowledgeBase: { consolidate: () => bomb('consolidate 炸') },
    calibrator: { tick: () => bomb('tick 炸') },
    selfAudit: () => bomb('auditTrajectory 炸'),
    meter: { summary: () => bomb('meter.summary 炸') },
    log: () => { /* 测试静音 */ },
  };

  // 非法 trace：父路径是一个普通文件 ⇒ mkdir/append 必炸 ⇒ 晨报幕 error
  const dir = mkdtempSync(join(tmpdir(), 'upsilon-y4-'));
  try {
    const blocker = join(dir, 'blocker.txt');
    writeFileSync(blocker, 'x', 'utf8');
    const badTrace = join(blocker, 'sleep.jsonl');

    const report = await runSleepCycle(deps, { sleepTracePath: badTrace, now: tickClock().now });

    // 五幕全 error（各幕独立隔离，互不毒化）；meter 炸被吞为 usage 缺席
    const five = report.acts.filter(a => a.name !== 'report');
    assert.equal(five.length, 5);
    assert.ok(five.every(a => a.status === 'error'), JSON.stringify(report.acts));
    for (const a of five) assert.ok((a.detail ?? '').length > 0, 'error 幕带错误摘要');
    const morning = report.acts.find(a => a.name === 'report');
    assert.equal(morning?.status, 'error', '落盘失败 ⇒ 晨报幕 error');
    assert.ok((morning?.detail ?? '').includes('落盘失败'), morning?.detail);
    assert.equal(report.watermark, null, 'journal 炸 ⇒ 无法指纹 ⇒ null');
    assert.equal(report.usage, undefined, 'meter 炸 ⇒ 台账缺席（不伪造零）');

    // 再睡一次：仍不抛（水位线 null ⇒ 每次诚实重试）
    const again = await runSleepCycle(deps, { sleepTracePath: badTrace, now: tickClock().now });
    assert.ok(again.acts.some(a => a.status === 'error'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
