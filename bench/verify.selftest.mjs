#!/usr/bin/env node
// bench/verify.selftest.mjs — W2-3 离线自检(测试证据):node bench/verify.selftest.mjs
//
// 全程离线(无网络、无 DSH 会话、不驱动桌面交互),用临时目录构造**已知真假**的
// verify 块与模拟轨迹,断言:
//   A. E2 核查器谓词真假例(fs 真通道 + mock world 确定性事实源 + win32 真通道抽检)
//   B. 三态语义/组合子/通道错误分离/结构校验
//   C. E3 SPRT 三态判定 + 预算上限 + 边界公式(与 popupDetector 同式)
//   D. Wilson CI / 两比例 z 检验 / McNemar 精确检验的已知数值
//   E. suite-*.json 的 verify 块结构合法 + doctor 规则候选草稿字段
// 期望 exit 0;任一断言失败 exit 1 并列出全部失败项。
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import {
  validateVerifyBlock, evaluateVerify, evaluateCheck, expandPath,
  createWindowsWorld, createMockWorld, buildDoctorRuleCandidate,
} from './verifyCore.mjs';
import {
  createRegressionGate, BernoulliSprt, wilsonCI, twoProportionTest, mcNemarExact, normalCdf,
  SPRT_ALPHA, SPRT_BETA, SPRT_P0, SPRT_P1, MAX_RERUNS,
} from './sprtCore.mjs';

const failures = [];
const passed = [];
function ok(cond, label) {
  if (cond) { passed.push(label); }
  else { failures.push(label); console.error(`  FAIL: ${label}`); }
}
function eq(a, b, label) { ok(Object.is(a, b), `${label} (得 ${JSON.stringify(a)},期望 ${JSON.stringify(b)})`); }
function near(a, b, eps, label) { ok(Math.abs(a - b) <= eps, `${label} (得 ${a},期望 ${b}±${eps})`); }

const tmp = mkdtempSync(path.join(tmpdir(), 'w2bench-selftest-'));
const world = createWindowsWorld(); // fs 部分跨平台纯 Node;OS 命令类谓词在非 win32 会诚实报通道错误

console.log(`# W2-3 离线自检  tmp=${tmp}  platform=${process.platform}`);

// ─── A1. 文件谓词真例 ───
{
  const good = path.join(tmp, 'good.txt');
  writeFileSync(good, 'W2-3 verify selftest payload: final-switch-test line\nDONE\n', 'utf8');
  const sha = createHash('sha256').update(readFileSync(good)).digest('hex');
  const r = await evaluateVerify({ checks: [
    { kind: 'fileExists', path: good, contains: 'final-switch-test', minBytes: 10 },
    { kind: 'fileExists', path: good, sha256: sha },
    { kind: 'fileExists', path: good, containsRegex: 'DONE\\s*$' },
    { kind: 'fileAbsent', path: path.join(tmp, 'no-such-file.txt') },
    { kind: 'dirExists', path: tmp },
  ] }, world);
  ok(r.pass === true, 'A1 文件谓词真例整体 pass');
  eq(r.counts.pass, 5, 'A1 五谓词全 pass');
  ok(r.channelError === false, 'A1 无通道错误');
  ok(r.channel === 'independent-local', 'A1 核查通道标识');

  // 假例逐项:内容不含/哈希不符/大小越界/存在性反转
  const bad = await evaluateVerify({ checks: [
    { kind: 'fileExists', path: good, contains: '绝不存在的子串XYZ' },
    { kind: 'fileExists', path: good, sha256: 'deadbeef' },
    { kind: 'fileExists', path: good, minBytes: 1 << 20 },
    { kind: 'fileAbsent', path: good },
    { kind: 'dirExists', path: good },
  ] }, world);
  ok(bad.pass === false, 'A1 文件谓词假例整体 fail');
  eq(bad.counts.fail, 5, 'A1 五谓词全 fail');
  eq(bad.checks[4].status, 'fail', 'A1 dirExists 对普通文件判 fail(形状谓词)');
}

// ─── A2. %VAR% 展开 ───
{
  process.env.W2_SELFTEST_VAR = tmp;
  const r = await evaluateVerify({ checks: [{ kind: 'fileExists', path: '%W2_SELFTEST_VAR%/good.txt' }] }, world);
  ok(r.pass === true, 'A2 %VAR% 展开后命中真文件');
  eq(expandPath('%W2_UNDEFINED_VAR_XYZ%\\x'), '%W2_UNDEFINED_VAR_XYZ%\\x', 'A2 未定义变量原样保留(不吞不猜)');
}

// ─── A3. mock world:进程/窗口/注册表/env 谓词真假表 ───
{
  const mock = createMockWorld({
    listProcesses: async () => ({ ok: true, items: [{ name: 'notepad.exe', pid: 123 }, { name: 'Code.exe', pid: 456 }], raw: 'mock tasklist' }),
    listWindowTitles: async () => ({ ok: true, titles: ['无标题 - 记事本', 'Google Chrome'], raw: 'mock windows' }),
    queryRegistry: async (hive, key, value) => key === 'Software\\W2Present'
      ? { ok: true, exists: true, hasValue: true, data: value === 'Counter' ? '42' : 'x', type: 'REG_SZ', raw: 'mock reg present' }
      : { ok: true, exists: false, data: null, type: null, raw: 'mock reg absent' },
    env: async (name) => ({ ok: true, value: name === 'W2PATH' ? 'C:\\Windows;C:\\tools' : undefined, raw: 'mock env' }),
  });
  const truthy = await evaluateVerify({ checks: [
    { kind: 'processRunning', name: 'Notepad.EXE' },          // 大小写不敏感
    { kind: 'processAbsent', name: 'mspaint.exe' },
    { kind: 'windowExists', titleRegex: '记事本|Notepad' },
    { kind: 'windowAbsent', titleRegex: '计算器|Calculator' },
    { kind: 'registryKey', hive: 'HKCU', key: 'Software\\W2Present' },
    { kind: 'registryValue', hive: 'HKCU', key: 'Software\\W2Present', value: 'Counter', equals: '42' },
    { kind: 'registryKey', hive: 'HKCU', key: 'Software\\W2Absent', exists: false }, // 断言缺席
    { kind: 'envVar', name: 'W2PATH', contains: 'windows' },   // 大小写不敏感包含
    { kind: 'windowCount', titleRegex: '记事本|Notepad', equals: 1 }, // W8-B7:mock 两窗中记事本域恰 1
    { kind: 'windowCount', titleRegex: '.', gte: 1, lte: 3 },          // W8-B7:gte+lte 组合区间(实测 2)
  ] }, mock);
  ok(truthy.pass === true && truthy.counts.pass === 10, `A3 mock 真例 10 谓词全 pass(得 ${JSON.stringify(truthy.counts)})`);
  eq(truthy.checks[8].status, 'pass', 'A3 windowCount equals 真例(记事本域=1)');
  eq(truthy.checks[9].status, 'pass', 'A3 windowCount gte+lte 区间真例(全窗 2 ∈ [1,3])');

  const falsy = await evaluateVerify({ checks: [
    { kind: 'processRunning', name: 'mspaint.exe' },
    { kind: 'processAbsent', name: 'notepad.exe' },
    { kind: 'windowExists', titleRegex: '计算器' },
    { kind: 'windowAbsent', titleRegex: '记事本' },
    { kind: 'registryKey', hive: 'HKCU', key: 'Software\\W2Absent' },
    { kind: 'registryValue', hive: 'HKCU', key: 'Software\\W2Present', value: 'Counter', equals: '999' },
    { kind: 'registryValue', hive: 'HKCU', key: 'Software\\W2Absent', value: 'Whatever' },
    { kind: 'envVar', name: 'W2_MISSING', contains: 'x' },
    { kind: 'windowCount', titleRegex: 'Chrome', equals: 0 },  // W8-B7:实测 1,equals=0 假
    { kind: 'windowCount', titleRegex: '记事本', gte: 2 },      // W8-B7:实测 1,gte=2 假
  ] }, mock);
  ok(falsy.pass === false && falsy.counts.fail === 10, `A3 mock 假例 10 谓词全 fail(得 ${JSON.stringify(falsy.counts)})`);
  eq(falsy.checks[8].status, 'fail', 'A3 windowCount equals 假例(Chrome 域=1≠0)');
  eq(falsy.checks[9].status, 'fail', 'A3 windowCount gte 假例(记事本域 1<2)');
}

// ─── A4. mock world 未覆盖方法 ⇒ 通道错误(fail/error 严格分离) ───
{
  const broken = createMockWorld({ stat: async () => { throw new Error('disk channel down'); } });
  const r = await evaluateVerify({ checks: [{ kind: 'fileExists', path: 'C:\\whatever' }] }, broken);
  eq(r.checks[0].status, 'error', 'A4 观察命令异常 ⇒ status=error(非 fail)');
  ok(r.pass === false && r.channelError === true, 'A4 通道坏 ⇒ 整体不放行(pass=false + channelError)');
  const partial = await evaluateVerify({ checks: [{ kind: 'envVar', name: 'PATH' }] }, createWindowsWorld());
  ok(partial.pass === true, 'A4 envVar 真通道 pass');
}

// ─── B1. 组合子与 mode ───
{
  const mock = createMockWorld({
    listProcesses: async () => ({ ok: true, items: [{ name: 'node.exe', pid: 1 }], raw: 'mock' }),
    listWindowTitles: async () => ({ ok: true, titles: [], raw: 'mock' }),
  });
  const notR = await evaluateVerify({ checks: [{ kind: 'not', check: { kind: 'processRunning', name: 'mspaint.exe' } }] }, mock);
  ok(notR.pass === true, 'B1 not:取反缺席进程 ⇒ pass');
  const notErr = await evaluateVerify({ checks: [{ kind: 'not', check: { kind: 'registryKey', key: 'x' } }] }, mock); // mock 无 registry ⇒ error
  eq(notErr.checks[0].status, 'error', 'B1 not:通道错误穿透(取反不能把 error 变好)');
  const anyOf = await evaluateVerify({ mode: 'any', checks: [
    { kind: 'processRunning', name: 'mspaint.exe' },
    { kind: 'processRunning', name: 'node.exe' },
  ] }, mock);
  ok(anyOf.pass === true, 'B1 mode=any:一真即真');
  const allOf = await evaluateVerify({ checks: [
    { kind: 'allOf', checks: [{ kind: 'processRunning', name: 'node.exe' }, { kind: 'processAbsent', name: 'a.exe' }] },
    { kind: 'anyOf', checks: [{ kind: 'processRunning', name: 'zz.exe' }, { kind: 'processAbsent', name: 'zz.exe' }] },
  ] }, mock);
  ok(allOf.pass === true, 'B1 allOf/anyOf 嵌套');
}

// ─── B2. 结构校验(fail-fast:坏声明跑前暴露) ───
{
  ok(validateVerifyBlock({ checks: [{ kind: 'fileExists', path: 'C:\\x' }] }).ok === true, 'B2 合法块通过');
  ok(validateVerifyBlock({}).ok === false, 'B2 缺 checks 拒绝');
  ok(validateVerifyBlock({ checks: [{ kind: 'fileExists' }] }).errors.some((e) => e.includes('path')), 'B2 缺 path 拒绝');
  ok(validateVerifyBlock({ checks: [{ kind: 'telepathyExists' }] }).errors.some((e) => e.includes('未登记')), 'B2 未登记 kind 拒绝(resultContract 同律:不瞎猜)');
  ok(validateVerifyBlock({ checks: [{ kind: 'windowExists', titleRegex: '(' }] }).ok === false, 'B2 非法正则拒绝');
  ok(validateVerifyBlock({ checks: [{ kind: 'fileExists', path: 'x' }] , mode: 'sometimes' }).ok === false, 'B2 非法 mode 拒绝');
  // W8-B7:windowCount 结构合法性(fail-fast 双保险:suite 声明错在跑前暴露)
  ok(validateVerifyBlock({ checks: [{ kind: 'windowCount', titleRegex: '记事本', equals: 1 }] }).ok === true, 'B2 windowCount 合法块通过');
  ok(validateVerifyBlock({ checks: [{ kind: 'windowCount', equals: 0 }] }).errors.some((e) => e.includes('titleRegex')), 'B2 windowCount 缺 titleRegex 拒绝(顶层总数含系统窗口,恒噪声)');
  ok(validateVerifyBlock({ checks: [{ kind: 'windowCount', titleRegex: 'x' }] }).errors.some((e) => e.includes('比较子')), 'B2 windowCount 缺 equals/gte/lte 拒绝');
  ok(validateVerifyBlock({ checks: [{ kind: 'windowCount', titleRegex: 'x', equals: -1 }] }).ok === false, 'B2 windowCount 负数拒绝');
  ok(validateVerifyBlock({ checks: [{ kind: 'windowCount', titleRegex: 'x', gte: 1.5 }] }).ok === false, 'B2 windowCount 非整数拒绝');
  ok(validateVerifyBlock({ checks: [{ kind: 'windowCount', titleRegex: '(', lte: 2 }] }).ok === false, 'B2 windowCount 非法正则拒绝');
  const runtime = await evaluateCheck({ kind: 'telepathyExists' }, createMockWorld());
  eq(runtime.status, 'error', 'B2 运行期未登记 kind ⇒ error(双防线)');
  const wcErr = await evaluateCheck({ kind: 'windowCount', titleRegex: 'x', equals: 0 }, createMockWorld());
  eq(wcErr.status, 'error', 'B2 windowCount 通道坏(listWindowTitles 未提供)⇒ error 非 fail(与 A4 同律)');
}

// ─── C1. SPRT 边界公式与 popupDetector 同式 ───
{
  const s = new BernoulliSprt();
  near(s.acceptBound, Math.log((1 - SPRT_BETA) / SPRT_ALPHA), 1e-12, 'C1 A=ln((1−β)/α)');
  near(s.rejectBound, Math.log(SPRT_BETA / (1 - SPRT_ALPHA)), 1e-12, 'C1 B=ln(β/(1−α))');
  near(s.acceptBound, Math.log(19), 1e-9, 'C1 α=β=0.05 ⇒ A=ln(19)≈2.944(popupDetector 注释同值)');
  near(SPRT_P1 / SPRT_P0, 0.8 / 0.3, 1e-12, 'C1 默认 P0=0.30 P1=0.80');
}

// ─── C2. 三态判定(序贯收口) ───
{
  // 三连败 ⇒ deterministic-fail(LLR 3×ln(0.2/0.7)≈−3.76 ≤ B≈−2.94)
  const g1 = createRegressionGate();
  let st = g1.push(false);
  eq(st.action, 'continue', 'C2 单败不收口(P0=0.30 给复跑通道开口)');
  st = g1.push(false);
  eq(st.action, 'continue', 'C2 两败仍不收口(LLR≈−2.51 > −2.94)');
  st = g1.push(false);
  eq(st.action, 'settled', 'C2 三败收口');
  eq(st.verdict.verdict, 'deterministic-fail', 'C2 deterministic-fail');
  eq(st.verdict.runs, 3, 'C2 预算节俭:3 次运行即停(期望样本量最优性)');
  ok(st.verdict.ci.low <= st.verdict.pHat && st.verdict.pHat <= st.verdict.ci.high, 'C2 CI 包含 p̂');

  // 首发即过(现实中不触发门,但语义上):零失败 ⇒ deterministic-pass
  const g2 = createRegressionGate();
  st = g2.push(true);
  eq(st.action, 'settled', 'C2 零失败即收口');
  eq(st.verdict.verdict, 'deterministic-pass', 'C2 deterministic-pass ⇔ 零失败观测');
  eq(st.verdict.flavor, 'zero-failure', 'C2 flavor=zero-failure');

  // 1 败 + 连过 ⇒ SPRT 接受 H1 但有失败 ⇒ flaky(high-rate),不冒充 deterministic-pass
  const g3 = createRegressionGate();
  st = g3.push(false);
  let n3 = 1;
  while (st.action === 'continue') { n3 += 1; st = g3.push(true); }
  eq(st.verdict.verdict, 'flaky', 'C2 有失败观测的 H1 接受 ⇒ flaky(统计诚实)');
  eq(st.verdict.flavor, 'high-rate', 'C2 flavor=high-rate');
  near(st.verdict.pHat, (n3 - 1) / n3, 1e-4, `C2 p̂=${n3 - 1}/${n3}`);
  eq(st.verdict.sprt.decision, 'H1', 'C2 SPRT 判 H1');

  // 交替胜负至预算耗尽 ⇒ flaky(indifference-zone)
  const g4 = createRegressionGate();
  st = g4.push(false);
  let i = 0;
  while (st.action === 'continue') { i += 1; st = g4.push(i % 2 === 1); }
  eq(st.verdict.verdict, 'flaky', 'C2 无差别区 ⇒ flaky');
  eq(st.verdict.flavor, 'indifference-zone', 'C2 flavor=indifference-zone');
  eq(st.verdict.runs, 1 + MAX_RERUNS, `C2 预算上限强制(总运行=${1 + MAX_RERUNS})`);
  near(st.verdict.pHat, 3 / 6, 1e-4, 'C2 p̂=3/6');
  ok(st.verdict.ci.high - st.verdict.ci.low > 0.3, 'C2 小样本 CI 宽(Wilson 不假装精度)');
}

// ─── D. 统计函数已知数值 ───
{
  // 手算:10/50 vs 20/50 ⇒ z≈−2.182,p≈0.0291(双侧)
  const t = twoProportionTest(10, 50, 20, 50);
  near(t.z, -2.1822, 0.001, 'D1 z 值(手算 −2.182)');
  near(t.p, 0.0291, 0.0005, 'D1 p 值(手算 0.0291)');
  eq(twoProportionTest(5, 10, 5, 10).p, 1, 'D1 同比例 ⇒ p=1');
  ok(twoProportionTest(0, 10, 10, 10).p < 0.001, 'D1 极端差 ⇒ p<0.001');
  near(normalCdf(0), 0.5, 1e-9, 'D1 Φ(0)=0.5');
  near(normalCdf(1.959963984540054), 0.975, 1e-4, 'D1 Φ(1.96)=0.975');
  // McNemar 精确:b=0,c=3 ⇒ p=2×(1/8)=0.25
  near(mcNemarExact(0, 3).p, 0.25, 1e-9, 'D2 McNemar(0,3)=0.25');
  eq(mcNemarExact(0, 0).p, 1, 'D2 无不一致对 ⇒ p=1');
  // Wilson:9/10 ⇒ 约 [0.596, 0.982](手算:z=1.95996,denom=1.38415,half=0.19314)
  const ci = wilsonCI(9, 10);
  near(ci.low, 0.5959, 0.001, 'D3 Wilson 9/10 下界');
  near(ci.high, 0.9821, 0.001, 'D3 Wilson 9/10 上界');
  const w1 = wilsonCI(5, 10), w2 = wilsonCI(50, 100);
  ok(w2.high - w2.low < w1.high - w1.low, 'D3 CI 随 n 收窄');
  ok(wilsonCI(0, 5).low === 0 && wilsonCI(0, 5).high > 0, 'D3 0 失败的 CI 不塌缩到 [0,0]');
}

// ─── E1. suite-*.json 的 verify 块结构合法(fail-fast 通道的自证) ───
{
  const benchDir = fileURLToPath(new URL('./', import.meta.url));
  const files = readdirSync(benchDir).filter((f) => /^suite-.*\.json$/.test(f));
  ok(files.length > 0, `E1 发现 suite 文件(${files.length} 个)`);
  let verifyBlocks = 0;
  for (const f of files) {
    const suite = JSON.parse(readFileSync(path.join(benchDir, f), 'utf8'));
    for (const t of suite) {
      if (!t.verify) continue;
      verifyBlocks += 1;
      const v = validateVerifyBlock(t.verify);
      ok(v.ok, `E1 ${f}#${t.id} verify 块合法${v.ok ? '' : ':' + v.errors.join('; ')}`);
    }
  }
  ok(verifyBlocks >= 3, `E1 至少 3 个 verify 块示例(得 ${verifyBlocks})`);
}

// ─── E2. doctor 规则候选草稿 ───
{
  const mock = createMockWorld({ listProcesses: async () => ({ ok: true, items: [], raw: 'mock 空 tasklist' }) });
  const vr = await evaluateVerify({ checks: [{ kind: 'processRunning', name: 'notepad.exe' }] }, mock);
  const cand = buildDoctorRuleCandidate({
    suiteFile: 'bench/suite-w2.json', task: { id: 'demo-task', expect: ['switch_window'] },
    runRecord: { failedExpectations: [], toolErrors: 0, turnErrors: 0, sessionId: 's-demo' },
    verifyResult: vr, gateVerdict: { verdict: 'deterministic-fail', runs: 3, pHat: 0, ci: wilsonCI(0, 3), rationale: 'x' },
  });
  ok(cand.schema === 'doctor-rule-candidate/draft-1', 'E2 候选 schema');
  ok(cand.status === 'needs-human-distillation', 'E2 候选须人工蒸馏(不自动入库)');
  eq(cand.failingPredicates.length, 1, 'E2 失败谓词入草稿');
  ok(cand.hypothesis.includes('自报'), 'E2 轨迹匹配+核查失败 ⇒ 假阳性自报假设(说明假设)');
  eq(cand.proposedRule.severity, 'critical', 'E2 deterministic-fail ⇒ critical');
  ok(cand.reproduction.ci.low <= cand.reproduction.pHat, 'E2 复现块带 CI');
}

// ─── A5. win32 真通道抽检(tasklist/reg/env/screenshot —— 本机为 win32 时执行) ───
if (process.platform === 'win32') {
  const r = await evaluateVerify({ checks: [
    { kind: 'processRunning', name: 'node.exe' },   // 自检本身跑在 node 下 —— tasklist 必有 node.exe
    { kind: 'processAbsent', name: 'w2-no-such-proc-xyz.exe' },
    { kind: 'registryKey', hive: 'HKCU', key: 'Environment' }, // 每用户必有
    { kind: 'registryKey', hive: 'HKCU', key: 'Software\\W2-No-Such-Key-XYZ' }, // 不存在 ⇒ fail
    { kind: 'envVar', name: 'PATH', contains: 'windows' },
  ] }, world);
  eq(r.checks[0].status, 'pass', 'A5 真通道 tasklist:node.exe 在运行');
  eq(r.checks[1].status, 'pass', 'A5 真通道 tasklist:幻影进程缺席');
  eq(r.checks[2].status, 'pass', 'A5 真通道 reg:HKCU\\Environment 存在');
  eq(r.checks[3].status, 'fail', 'A5 真通道 reg:幻影键不存在 ⇒ fail(absent 是合法观察非通道错误)');
  eq(r.checks[4].status, 'pass', 'A5 真通道 env:PATH 含 windows');
  ok(r.pass === false && r.channelError === false, 'A5 幻影键失败 ⇒ 整体 fail 且无通道错误');

  // 截图通道:结构化结果 + 不抛异常;成功则文件落盘
  const shot = path.join(tmp, 'shot.png');
  try {
    const s = await world.captureScreenshot(shot);
    ok(s.ok === true && existsSync(shot), 'A5 真通道截图:落盘成功');
  } catch (e) {
    ok(false, `A5 真通道截图异常(不允许抛):${e.message}`);
  }
}

// ─── E3. runVerification:证据落盘组合通道(截图引用 + 原始观察文件 + verify.json) ───
{
  const { runVerification } = await import('./verifyCore.mjs');
  const reportDir = path.join(tmp, 'report');
  const marker = path.join(tmp, 'marker.txt');
  writeFileSync(marker, 'W2-3 evidence roundtrip\n', 'utf8');
  const { result, evidence } = await runVerification({
    taskId: 'demo/task-1',
    verify: { checks: [{ kind: 'fileExists', path: marker, contains: 'roundtrip' }] },
    world, reportDir,
    captureScreenshot: false, // 离线自检不强制截图(截图通道在 A5 单测)
  });
  ok(result.pass === true, 'E3 runVerification 判定 pass');
  ok(result.screenshot && result.screenshot.captured === false, 'E3 截图关闭时诚实记录 captured=false');
  ok(exvidenceExists(evidence.files), 'E3 逐谓词原始观察文件落盘');
  ok(existsSync(path.join(evidence.evidenceDir, 'verify.json')), 'E3 verify.json 落盘');
  const saved = JSON.parse(readFileSync(path.join(evidence.evidenceDir, 'verify.json'), 'utf8'));
  ok(saved.checks[0].raw.includes('read ') || saved.checks[0].raw.length > 0, 'E3 落盘 JSON 含原始观察字段');
  ok(evidence.files.every((f) => existsSync(f)), 'E3 证据文件全部存在');
}
function exvidenceExists(files) { return Array.isArray(files) && files.length >= 1; }

// ─── E4. battery.compareWithBaseline:跨版本比例差检验(离线喂假报告) ───
{
  const { compareWithBaseline } = await import('./battery.mjs'); // import 守卫:不触发 main
  const prevPath = path.join(tmp, 'prev-report.json');
  writeFileSync(prevPath, JSON.stringify({ schema: 'w2bench-report/1', results: [
    { id: 'alpha', pass: true }, { id: 'beta', pass: false }, { id: 'vanished', pass: true },
  ] }), 'utf8');
  const cur = [
    { id: 'alpha', gate: { verdict: 'deterministic-pass' } },
    { id: 'beta', gate: { verdict: 'deterministic-fail' } },
    { id: 'fresh', gate: { verdict: 'deterministic-pass' } },
  ];
  const cmp = compareWithBaseline(cur, prevPath);
  eq(cmp.baseline.tasks, 2, 'E4 基线仅统计共享任务(alpha/beta;vanished 不入)');
  eq(cmp.baseline.pass, 1, 'E4 基线共享任务通过数=1');
  eq(cmp.current.tasks, 3, 'E4 当前全部任务入分母');
  eq(cmp.current.pass, 2, 'E4 当前 deterministic-pass=2');
  ok(typeof cmp.twoProportionZ.p === 'number' && cmp.twoProportionZ.p >= 0 && cmp.twoProportionZ.p <= 1, 'E4 比例差 p 值 ∈ [0,1]');
  ok(typeof cmp.mcNemar.p === 'number', 'E4 McNemar p 在场');
  ok(typeof cmp.verdictHint === 'string' && cmp.verdictHint.length > 0, 'E4 结论提示非空');
  // 手算:2/3 vs 1/2 ⇒ pooled=3/5,z=(0.6667−0.5)/sqrt(0.6·0.4·(1/3+1/2))=0.1667/0.4472≈0.3727,p≈0.7094
  near(cmp.twoProportionZ.z, 0.3727, 0.001, 'E4 z 手算值');
  near(cmp.twoProportionZ.p, 0.7094, 0.001, 'E4 p 手算值');
}

// ─── 收尾 ───
rmSync(tmp, { recursive: true, force: true });
console.log(`\n# W2-3 自检结果: ${passed.length} 断言通过, ${failures.length} 失败`);
if (failures.length > 0) {
  console.error('失败清单:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log('# OK — E2 契约核查器 + E3 SPRT 回归门离线自检通过(exit 0)');
process.exit(0);
