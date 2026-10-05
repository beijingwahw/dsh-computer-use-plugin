// test/w2bench.test.ts
// W2-3(bench 可信度包)回归:E2 契约核查器 + E3 方差感知 SPRT 回归门的可判核心。
// bench/ 是纯 Node .mjs 工作台(不经 TS 测试器的 strip-types 通道也能独立自检
// —— 见 bench/verify.selftest.mjs);此处以非字面量动态 import 挂载同一批模块,
// 使核心逻辑同时受 node:test 全量回归保护(说明符非字面量 ⇒ tsc 不做 .mjs 解析,
// tsconfig 无 allowJs 也能 typecheck 干净 —— 这是刻意的加载策略,不是绕过测试)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// 非字面量说明符:tsc 对 any 收声,运行时由 Node ESM 原生解析 bench/*.mjs
const load = (p: string): Promise<any> => import(p);
const benchUrl = (f: string): string => new URL(`../bench/${f}`, import.meta.url).href;

const verifyCore = await load(benchUrl('verifyCore.mjs'));
const sprtCore = await load(benchUrl('sprtCore.mjs'));
const battery = await load(benchUrl('battery.mjs')); // ΠΑΝ-98/99:compareWithBaseline / capUnverifiableVerdict / buildE2Coverage(import 守卫:不触发 main)

const tmp = mkdtempSync(path.join(tmpdir(), 'w2bench-test-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

// ─── E2:谓词真假表(mock world 确定性事实源) ───

test('W2-3 E2a: mock 进程/窗口/注册表谓词真例全过', async () => {
  const mock = verifyCore.createMockWorld({
    listProcesses: async () => ({ ok: true, items: [{ name: 'notepad.exe', pid: 7 }], raw: 'mock' }),
    listWindowTitles: async () => ({ ok: true, titles: ['无标题 - 记事本'], raw: 'mock' }),
    queryRegistry: async (_h: string, key: string) => ({ ok: true, exists: key === 'K\\Present', hasValue: true, data: '42', type: 'REG_SZ', raw: 'mock' }),
    env: async (n: string) => ({ ok: true, value: n === 'W2V' ? 'abc' : undefined, raw: 'mock' }),
  });
  const r = await verifyCore.evaluateVerify({ checks: [
    { kind: 'processRunning', name: 'NOTEPAD.exe' },        // 大小写不敏感
    { kind: 'windowExists', titleRegex: '记事本' },
    { kind: 'registryValue', key: 'K\\Present', value: 'V', equals: '42' },
    { kind: 'envVar', name: 'W2V', equals: 'abc' },
    { kind: 'not', check: { kind: 'processRunning', name: 'mspaint.exe' } },
  ] }, mock);
  assert.equal(r.pass, true);
  assert.equal(r.channelError, false);
  assert.equal(r.channel, 'independent-local'); // 核查通道标识:不经 agent、不信自报
});

test('W2-3 E2b: mock 假例全挂(谓词否定方向)', async () => {
  const mock = verifyCore.createMockWorld({
    listProcesses: async () => ({ ok: true, items: [], raw: 'mock' }),
    listWindowTitles: async () => ({ ok: true, titles: ['X'], raw: 'mock' }),
  });
  const r = await verifyCore.evaluateVerify({ checks: [
    { kind: 'processRunning', name: 'notepad.exe' },
    { kind: 'windowExists', titleRegex: '记事本' },
  ] }, mock);
  assert.equal(r.pass, false);
  assert.equal(r.counts.fail, 2);
});

test('W2-3 E2c: 文件谓词真通道(fs)+ 哈希/内容/尺寸', async () => {
  const world = verifyCore.createWindowsWorld();
  const f = path.join(tmp, 'probe.txt');
  const body = 'W2-3 marker-ALPHA\n';
  writeFileSync(f, body, 'utf8');
  const sha = createHash('sha256').update(readFileSync(f)).digest('hex');
  const good = await verifyCore.evaluateVerify({ checks: [
    { kind: 'fileExists', path: f, contains: 'marker-alpha', sha256: sha, minBytes: 1 },
    { kind: 'fileAbsent', path: path.join(tmp, 'ghost.txt') },
    { kind: 'dirExists', path: tmp },
  ] }, world);
  assert.equal(good.pass, true);
  const bad = await verifyCore.evaluateVerify({ checks: [
    { kind: 'fileExists', path: f, sha256: '00' },
    { kind: 'fileAbsent', path: f },
  ] }, world);
  assert.equal(bad.pass, false);
  assert.equal(bad.counts.fail, 2);
});

test('W2-3 E2d: 通道错误与判定失败严格分离(resultContract 诚实降级原则)', async () => {
  const broken = verifyCore.createMockWorld({ listProcesses: async () => { throw new Error('channel down'); } });
  const r = await verifyCore.evaluateVerify({ checks: [{ kind: 'processRunning', name: 'x.exe' }] }, broken);
  assert.equal(r.checks[0].status, 'error'); // 观察通道坏 ≠ 条件为假
  assert.equal(r.pass, false);
  assert.equal(r.channelError, true);       // 但通道坏 ⇒ 绝不放行
});

test('W2-3 E2e: 未登记谓词被拒(结构校验 fail-fast + 运行期双防线)', async () => {
  assert.equal(verifyCore.validateVerifyBlock({ checks: [{ kind: 'telepathy' }] }).ok, false);
  assert.equal(verifyCore.validateVerifyBlock({ checks: [{ kind: 'fileExists' }] }).ok, false);
  assert.equal(verifyCore.validateVerifyBlock({ mode: 'sometimes', checks: [{ kind: 'envVar', name: 'X' }] }).ok, false);
  const rt = await verifyCore.evaluateCheck({ kind: 'telepathy' }, verifyCore.createMockWorld());
  assert.equal(rt.status, 'error');
});

test('W2-3 E2f: suite-*.json 的 verify 块全部结构合法', () => {
  const benchDir = fileURLToPath(new URL('../bench/', import.meta.url));
  const files = readdirSync(benchDir).filter((f) => /^suite-.*\.json$/.test(f));
  assert.ok(files.length >= 5, `suite 文件数(得 ${files.length})`);
  let blocks = 0;
  for (const f of files) {
    const parsed = JSON.parse(readFileSync(path.join(benchDir, f), 'utf8'));
    const suite: any[] = Array.isArray(parsed) ? parsed : parsed.tasks; // ΝΩ-39 新格式 {sprp,tasks} 同律装载
    for (const t of suite) {
      if (!t.verify) continue;
      blocks += 1;
      const v = verifyCore.validateVerifyBlock(t.verify);
      assert.ok(v.ok, `${f}#${t.id}: ${v.errors.join('; ')}`);
    }
  }
  assert.ok(blocks >= 3, `verify 块示例数(得 ${blocks})`);
});

test('W2-3 E2g: doctor 规则候选草稿 —— 人工蒸馏前置字段齐全', async () => {
  const mock = verifyCore.createMockWorld({ listProcesses: async () => ({ ok: true, items: [], raw: 'mock' }) });
  const vr = await verifyCore.evaluateVerify({ checks: [{ kind: 'processRunning', name: 'notepad.exe' }] }, mock);
  const cand = verifyCore.buildDoctorRuleCandidate({
    suiteFile: 'bench/suite-w2.json', task: { id: 't', expect: ['x'] },
    runRecord: { failedExpectations: [] }, verifyResult: vr,
    gateVerdict: { verdict: 'flaky', runs: 6, pHat: 0.5, ci: sprtCore.wilsonCI(3, 6) },
  });
  assert.equal(cand.schema, 'doctor-rule-candidate/draft-1');
  assert.equal(cand.status, 'needs-human-distillation'); // 草稿不自动入库
  assert.equal(cand.failingPredicates.length, 1);
  assert.ok(cand.hypothesis.includes('自报')); // 轨迹匹配+核查失败 ⇒ 假阳性自报假设
  assert.equal(cand.proposedRule.severity, 'major'); // flaky ⇒ major(非 critical)
});

// ─── E3:SPRT 三态 + 预算 + 统计函数 ───

test('W2-3 E3a: 边界公式与 src/popupDetector.ts 的 SprtPopupFilter 同式', () => {
  const s = new sprtCore.BernoulliSprt();
  assert.ok(Math.abs(s.acceptBound - Math.log((1 - sprtCore.SPRT_BETA) / sprtCore.SPRT_ALPHA)) < 1e-12);
  assert.ok(Math.abs(s.rejectBound - Math.log(sprtCore.SPRT_BETA / (1 - sprtCore.SPRT_ALPHA))) < 1e-12);
  assert.ok(Math.abs(s.acceptBound - Math.log(19)) < 1e-9); // α=β=0.05 ⇒ A=ln(19)
});

test('W2-3 E3b: 三连败 ⇒ deterministic-fail(3 次即收口,期望样本量最优)', () => {
  const g = sprtCore.createRegressionGate();
  assert.equal(g.push(false).action, 'continue'); // P0=0.30:单败不收口,复跑通道开口
  assert.equal(g.push(false).action, 'continue'); // 两败 LLR≈−2.51 > B≈−2.94
  const st = g.push(false);
  assert.equal(st.action, 'settled');
  assert.equal(st.verdict.verdict, 'deterministic-fail');
  assert.equal(st.verdict.runs, 3);
});

test('ΠΑΝ-97 E3c: 零失败须凑满 MIN_PASS_N=5 才判 deterministic-pass(双侧触发,首发通过不再 n=1 放行)', () => {
  const g = sprtCore.createRegressionGate();
  let st = g.push(true); // 首发通过进门 —— 旧版在此即判 deterministic-pass(C2-6 H-4 单侧放行,已封堵)
  assert.equal(st.action, 'continue');
  assert.equal(g.runCount(), 1);
  st = g.push(true); st = g.push(true); st = g.push(true);
  assert.equal(st.action, 'continue'); // n=4 < 5:SPRT 即便已向 H1 漂移也不收口
  st = g.push(true);
  assert.equal(st.action, 'settled');
  assert.equal(st.verdict.verdict, 'deterministic-pass');
  assert.equal(st.verdict.flavor, 'zero-failure');
  assert.equal(st.verdict.runs, sprtCore.MIN_PASS_N);
  assert.equal(sprtCore.MIN_PASS_N, 5);
});

test('ΠΑΝ-97 E3c2: 零失败但复跑预算凑不满下限 ⇒ flaky(below-min-sample),不得冒称确定性', () => {
  const g = sprtCore.createRegressionGate({ maxReruns: 2 }); // 最多 1+2=3 跑 < 5
  let st = g.push(true);
  st = g.push(true);
  st = g.push(true);
  assert.equal(st.action, 'settled');
  assert.equal(st.verdict.verdict, 'flaky');
  assert.equal(st.verdict.flavor, 'below-min-sample');
  assert.equal(st.verdict.pHat, 1); // 观测全过 —— 但样本未达下限,只能诚实报 flaky
  assert.ok(st.verdict.ci.low > 0); // Wilson CI 不塌缩到 [1,1]
});

test('ΠΑΝ-97 E3c3: PASS 臂开门后照样抓失败(首发过 + 四连败 ⇒ deterministic-fail)', () => {
  const g = sprtCore.createRegressionGate();
  let st = g.push(true); // 双侧:PASS 首发进门,复跑通道已开
  st = g.push(false); st = g.push(false); st = g.push(false);
  assert.equal(st.action, 'continue'); // LLR≈−2.78 仍未越 B≈−2.94
  st = g.push(false);
  assert.equal(st.action, 'settled');
  assert.equal(st.verdict.verdict, 'deterministic-fail');
  assert.equal(st.verdict.runs, 5);
});

test('W2-3 E3d: 一败 + 连胜至 H1 ⇒ flaky(high-rate)—— 有失败不得冒充确定性', () => {
  const g = sprtCore.createRegressionGate();
  let st = g.push(false);
  while (st.action === 'continue') st = g.push(true);
  assert.equal(st.verdict.verdict, 'flaky');
  assert.equal(st.verdict.flavor, 'high-rate');
  assert.equal(st.verdict.sprt.decision, 'H1');
  assert.ok(st.verdict.pHat > 0.8 && st.verdict.pHat < 1);
});

test('W2-3 E3e: 交替胜负 ⇒ flaky(indifference-zone),预算上限强制收口', () => {
  const g = sprtCore.createRegressionGate();
  let st = g.push(false);
  let i = 0;
  while (st.action === 'continue') { i += 1; st = g.push(i % 2 === 1); }
  assert.equal(st.verdict.verdict, 'flaky');
  assert.equal(st.verdict.flavor, 'indifference-zone');
  assert.equal(st.verdict.runs, 1 + sprtCore.MAX_RERUNS); // 复跑上限防预算爆炸
  assert.ok(Math.abs(st.verdict.pHat - 0.5) < 1e-4);
  assert.ok(st.verdict.ci.high - st.verdict.ci.low > 0.3); // 小样本 CI 宽,不假装精度
});

test('W2-3 E3f: 两比例 z 检验已知数值(10/50 vs 20/50 ⇒ p≈0.0291)', () => {
  const t = sprtCore.twoProportionTest(10, 50, 20, 50);
  assert.ok(Math.abs(t.z - -2.1822) < 0.001);
  assert.ok(Math.abs(t.p - 0.0291) < 0.0005);
  assert.equal(sprtCore.twoProportionTest(5, 10, 5, 10).p, 1);
  assert.ok(sprtCore.twoProportionTest(0, 10, 10, 10).p < 0.001);
});

test('W2-3 E3g: McNemar 精确 + Wilson CI 数值', () => {
  assert.ok(Math.abs(sprtCore.mcNemarExact(0, 3).p - 0.25) < 1e-9); // 2×(1/8)
  assert.equal(sprtCore.mcNemarExact(0, 0).p, 1);
  const ci = sprtCore.wilsonCI(9, 10);
  assert.ok(Math.abs(ci.low - 0.5959) < 0.001);
  assert.ok(Math.abs(ci.high - 0.9821) < 0.001);
  assert.ok(sprtCore.wilsonCI(50, 100).high - sprtCore.wilsonCI(50, 100).low
          < sprtCore.wilsonCI(5, 10).high - sprtCore.wilsonCI(5, 10).low); // CI 随 n 收窄
});

// ─── ΠΑΝ-97/98/99:bench 统计门语义修复(C2-6 H-4/H-5/M-6) ───

test('ΠΑΝ-98: compareWithBaseline 只用两版本共有任务子集(同总体),新增任务不进 z 检验', () => {
  const prevPath = path.join(tmp, 'pan98-prev.json');
  writeFileSync(prevPath, JSON.stringify({ schema: 'w2bench-report/1', results: [
    { id: 'alpha', pass: true }, { id: 'beta', pass: false }, { id: 'retired', pass: true },
  ] }), 'utf8');
  const cur = [
    { id: 'alpha', gate: { verdict: 'deterministic-pass' } },
    { id: 'beta', gate: { verdict: 'deterministic-pass' } }, // 共有任务上的真实改善
    { id: 'fresh', gate: { verdict: 'deterministic-pass' } }, // 当前新增:旧口径会进 z 的分子分母(不同总体)
  ];
  const cmp = battery.compareWithBaseline(cur, prevPath);
  assert.equal(cmp.shared.tasks, 2);
  assert.equal(cmp.shared.currentPass, 2);
  assert.equal(cmp.shared.baselinePass, 1);
  assert.deepEqual(cmp.current.currentOnlyTasks, ['fresh']); // 新增任务单列,不进检验
  assert.deepEqual(cmp.current.baselineOnlyTasks, ['retired']);
  assert.equal(cmp.mcNemar.b, 0); // 配对不一致对也只在共有子集上数
  assert.equal(cmp.mcNemar.c, 1); // beta:旧败新过
  // 手算(共有子集同总体 2/2 vs 1/2):pooled=0.75,z=0.5/sqrt(0.1875)≈1.1547;
  // 旧「当前全量 vs 基线子集」口径(3/3 vs 1/2)会得 z≈1.3693 —— 两个不同总体相比的伪口径
  assert.ok(Math.abs(cmp.twoProportionZ.z - 1.1547) < 0.001);
  assert.equal(cmp.twoProportionZ.p1Hat, 1);  // 共有子集,非全量 3/3
  assert.equal(cmp.twoProportionZ.p2Hat, 0.5);
  assert.equal(cmp.wilson.current.n, 2);       // Wilson CI 亦为共有子集口径
  assert.equal(cmp.mder.n1, 2);                // MDER 功效前置保留,按共有子集两侧 n 计算
  assert.equal(cmp.mder.value, 1);             // n=2 vs 2 ⇒ MDER 夹上限(功效前置如实报)
  assert.ok(cmp.verdictHint.includes('样本不足')); // n<20 拒判不变
});

test('ΠΑΝ-98: 两版本无共有任务 ⇒ 一切比例检验诚显拒绝,不造数', () => {
  const disjointPath = path.join(tmp, 'pan98-disjoint.json');
  writeFileSync(disjointPath, JSON.stringify({ results: [{ id: 'old', pass: true }] }), 'utf8');
  const cmp = battery.compareWithBaseline([{ id: 'new', gate: { verdict: 'deterministic-pass' } }], disjointPath);
  assert.equal(cmp.shared.tasks, 0);
  assert.equal(cmp.twoProportionZ, null);
  assert.equal(cmp.mcNemar, null);
  assert.equal(cmp.mder, null);
  assert.ok(cmp.verdictHint.includes('无共有任务'));
});

test('ΠΑΝ-99: 无 verify 块 ⇒ deterministic-* 降格 self-reported-*(不计入 deterministic 判定)', () => {
  const detPass = { schema: 'w2bench-gate-verdict/1', verdict: 'deterministic-pass', flavor: 'zero-failure', runs: 5, passes: 5, failures: 0, pHat: 1, ci: { low: 0.57, high: 1 } };
  const verified = { id: 'v', verify: { checks: [{ kind: 'dirExists', path: 'C:\\x' }] } };
  const bare = { id: 'u', verifyAbsentReason: '内存态,谓词域不可达' };
  assert.equal(battery.capUnverifiableVerdict(detPass, verified), detPass); // 有 E2 核查 ⇒ 原判原样(同一引用)
  const capped = battery.capUnverifiableVerdict(detPass, bare);
  assert.equal(capped.verdict, 'self-reported-pass');
  assert.equal(capped.downgradedFrom, 'deterministic-pass');
  assert.equal(capped.e2Absent, true);
  assert.equal(capped.verifyAbsentReason, '内存态,谓词域不可达');
  assert.equal(capped.runs, 5); // 统计字段不因降格改动
  const cappedFail = battery.capUnverifiableVerdict({ ...detPass, verdict: 'deterministic-fail', passes: 0, failures: 3, pHat: 0 }, bare);
  assert.equal(cappedFail.verdict, 'self-reported-fail'); // 失败侧保守(不放行),降格只为命名诚实
  assert.equal(battery.capUnverifiableVerdict({ ...detPass, verdict: 'flaky' }, bare).verdict, 'flaky'); // flaky 不降格
});

test('ΠΑΝ-99: buildE2Coverage 显性化盲区(哪些任务 verify=null 仅自报,缺因如实透传)', () => {
  const cov = battery.buildE2Coverage([
    { id: 'v', verify: { checks: [{ kind: 'dirExists', path: 'C:\\x' }] } },
    { id: 'u1', verifyAbsentReason: '插件内存态' },
    { id: 'u2' }, // 未登记缺因
  ]);
  assert.equal(cov.schema, 'w2bench-e2-coverage/1');
  assert.equal(cov.tasksTotal, 3);
  assert.deepEqual(cov.verified.ids, ['v']);
  assert.equal(cov.unverifiable.count, 2);
  assert.equal(cov.unverifiable.tasks[0].reason, '插件内存态'); // 已登记缺因透传
  assert.equal(cov.unverifiable.tasks[1].reason, null);          // 未登记 ⇒ null(如实,不编造)
  assert.ok(Math.abs(cov.coverage - 1 / 3) < 1e-4);
});

test('ΠΑΝ-99: suite-4.json 的 8 个无 verify 任务全部登记了缺 E2 原因', () => {
  const benchDir = fileURLToPath(new URL('../bench/', import.meta.url));
  const suite4 = JSON.parse(readFileSync(path.join(benchDir, 'suite-4.json'), 'utf8'));
  const tasks: any[] = Array.isArray(suite4) ? suite4 : suite4.tasks;
  const bare = tasks.filter((t) => !t.verify);
  assert.equal(bare.length, 8); // C2-6 M-6 的 8/26 盲区,现全部显性登记
  for (const t of bare) {
    assert.ok(typeof t.verifyAbsentReason === 'string' && t.verifyAbsentReason.length > 0, `${t.id} 未登记 verifyAbsentReason`);
  }
});
