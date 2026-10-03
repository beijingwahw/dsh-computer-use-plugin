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
    const suite = JSON.parse(readFileSync(path.join(benchDir, f), 'utf8'));
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

test('W2-3 E3c: 零失败观测 ⇒ deterministic-pass(SPRT 无法证 p=1,以观测为准)', () => {
  const g = sprtCore.createRegressionGate();
  const st = g.push(true);
  assert.equal(st.action, 'settled');
  assert.equal(st.verdict.verdict, 'deterministic-pass');
  assert.equal(st.verdict.flavor, 'zero-failure');
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
