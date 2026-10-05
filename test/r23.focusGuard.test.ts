// test/r23.focusGuard.test.ts
// R2-3（焦点保卫）回归：宿主窗口回合结束自抬抢焦的双层防线离线单测。
//
// 覆盖面：
//   ① 插件侧纯函数：宿主标记判定 / 目标窗记账（src/windowFocusGuard.ts）；
//   ② guardTypingFocus 编排：unchecked/ok/refocused/blocked 四路与端口注入；
//   ③ type_text 集成：宿主前台 ⇒ 诚实 FAILED（绝不派发键入）；复焦成功 ⇒
//      SUCCESS + focus_guard 注记；开关关 ⇒ 零形状漂移（旧路径）；
//   ④ 驱动器纯逻辑（bench/driveCore.mjs）：钩子调度序（shouldRunHostFocusGuard
//      防抖）、宿主判决、PS 脚本构造（含管道强转回归钉）与标记行解析 ——
//      与 w2drive.test.ts 同策略（非字面量动态 import，tsc 不解析 .mjs）。
// 全程零真实 GUI / 零子进程（system 端口打桩，r29 census 同律 save/restore）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from '../src/config';
import { system } from '../src/system';
import { createTypeTextTool } from '../src/tools/typeText';
import {
  HOST_WINDOW_MARKERS_DEFAULT, parseHostMarkersCsv, isHostWindowTitle, markersOfConfig,
  recordTargetWindow, peekTargetWindow, clearTargetWindow, _resetWindowFocusGuardForTest,
  guardTypingFocus,
} from '../src/windowFocusGuard';

const load = (p: string): Promise<any> => import(p);
const benchUrl = (f: string): string => new URL(`../bench/${f}`, import.meta.url).href;
const drive = await load(benchUrl('driveCore.mjs'));

// ─── ① 纯函数：标记表 / 判定 / 记账 ───

test('R2-3 Pa: parseHostMarkersCsv —— CSV 解析 / 空白修剪 / 全空回退缺省表', () => {
  assert.deepEqual(parseHostMarkersCsv('DeepSeek Harness, dsh '), ['deepseek harness', 'dsh']);
  assert.deepEqual(parseHostMarkersCsv(''), [...HOST_WINDOW_MARKERS_DEFAULT]);
  assert.deepEqual(parseHostMarkersCsv(' , ,'), [...HOST_WINDOW_MARKERS_DEFAULT]);
  assert.deepEqual(parseHostMarkersCsv(undefined), [...HOST_WINDOW_MARKERS_DEFAULT]);
  assert.deepEqual(parseHostMarkersCsv(null), [...HOST_WINDOW_MARKERS_DEFAULT]);
  // markersOfConfig：部分 config（键缺席）⇒ 缺省表
  assert.deepEqual(markersOfConfig({} as Partial<Config>), [...HOST_WINDOW_MARKERS_DEFAULT]);
  assert.deepEqual(markersOfConfig({ hostWindowMarkersCsv: 'MyHost' } as Partial<Config>), ['myhost']);
});

test('R2-3 Pb: isHostWindowTitle —— 大小写不敏感子串；空/缺标题恒 false（证据缺失不算抢焦）', () => {
  const markers = ['DeepSeek Harness', 'dsh'];
  assert.equal(isHostWindowTitle('DeepSeek Harness', markers), true);
  assert.equal(isHostWindowTitle('deepseek harness — 会话 1', markers), true); // 子串 + 前缀方言
  assert.equal(isHostWindowTitle('DSH Desktop', markers), true); // 大小写不敏感
  assert.equal(isHostWindowTitle('*R1-8-SMOKE-MARKER - Notepad', markers), false);
  assert.equal(isHostWindowTitle('另存为', markers), false);
  assert.equal(isHostWindowTitle('', markers), false);
  assert.equal(isHostWindowTitle(null, markers), false);
  assert.equal(isHostWindowTitle(undefined, markers), false);
  assert.equal(isHostWindowTitle('DeepSeek Harness', []), false); // 空标记表：无判据不拦
  assert.equal(isHostWindowTitle('DSH Desktop', [' dsh ']), true); // 标记自身带空白（trim 后匹配）
});

test('R2-3 Pc: 目标窗记账 —— 记/读/清；空关键词不入账（无复焦价值的账不记）', () => {
  _resetWindowFocusGuardForTest();
  assert.equal(peekTargetWindow(), null);
  recordTargetWindow({ keyword: 'Notepad', matchedTitle: '无标题 - 记事本' });
  const t = peekTargetWindow();
  assert.ok(t);
  assert.equal(t.keyword, 'Notepad');
  assert.equal(t.matchedTitle, '无标题 - 记事本');
  recordTargetWindow({ keyword: '   ' }); // 空白关键词：拒绝
  assert.equal(peekTargetWindow()?.keyword, 'Notepad');
  recordTargetWindow({ keyword: '记事本' }); // matchedTitle 缺席：仍可复焦（标题只是取证）
  assert.equal(peekTargetWindow()?.keyword, '记事本');
  assert.equal(peekTargetWindow()?.matchedTitle, '');
  clearTargetWindow();
  assert.equal(peekTargetWindow(), null);
});

// ─── ② guardTypingFocus 编排（端口注入，四路判决） ───

const HOST = 'DeepSeek Harness';

/** 判决视图：blocked 臂无 status 键 —— 视图函数统一取形（TS 联合窄化的诚实替代） */
function outcomeShape(o: import('../src/windowFocusGuard').FocusGuardOutcome): { blocked: boolean; status?: string } {
  return o.blocked ? { blocked: true } : { blocked: false, status: o.status };
}

test('R2-3 Pd: 探测缺席（null / 抛错）⇒ unchecked 放行 —— 校验能力不可用不拦死正常输入', async () => {
  _resetWindowFocusGuardForTest();
  const a = await guardTypingFocus(['dsh'], { probeForeground: async () => null });
  assert.deepEqual(outcomeShape(a), { blocked: false, status: 'unchecked' });
  const b = await guardTypingFocus(['dsh'], {
    probeForeground: async () => { throw new Error('backend down'); },
  });
  assert.deepEqual(outcomeShape(b), { blocked: false, status: 'unchecked' });
});

test('R2-3 Pe: 正常前台 ⇒ ok 放行（应用自身对话框换焦是合法流，泛化拦截会打断）', async () => {
  _resetWindowFocusGuardForTest();
  const a = await guardTypingFocus(['dsh', 'deepseek harness'], { probeForeground: async () => '另存为' });
  assert.deepEqual(outcomeShape(a), { blocked: false, status: 'ok' });
});

test('R2-3 Pf: 宿主前台 ∧ 无目标记账 ⇒ blocked（无复焦依据，诚实失败优于盲打）', async () => {
  _resetWindowFocusGuardForTest();
  const a = await guardTypingFocus(['deepseek harness'], { probeForeground: async () => HOST });
  assert.equal(a.blocked, true);
  assert.match((a as { reason: string }).reason, /no refocus target is recorded/);
});

test('R2-3 Pg: 宿主前台 ∧ 有记账 ⇒ 自动复焦一次；复测脱离宿主 ⇒ refocused 放行', async () => {
  _resetWindowFocusGuardForTest();
  recordTargetWindow({ keyword: 'Notepad', matchedTitle: '记事本' });
  const calls: string[] = [];
  const probes: Array<string | null> = [HOST, '*marker - Notepad'];
  let i = 0;
  const a = await guardTypingFocus(['deepseek harness'], {
    probeForeground: async () => probes[Math.min(i++, probes.length - 1)] ?? null,
    refocus: async (kw) => { calls.push(kw); return { matched: '记事本' }; },
  });
  assert.equal(a.blocked, false);
  assert.equal(a.status, 'refocused');
  assert.deepEqual(calls, ['Notepad']); // 复焦用记账关键词，且只试一次
  assert.equal((a as { foreground_title: string }).foreground_title, '*marker - Notepad');
  assert.equal((a as { was_host_title: string }).was_host_title, HOST);
});

test('R2-3 Ph: 复焦失败路径三连 —— refocus 抛错 / 复测仍宿主 / 无 refocus 端口 ⇒ 均 blocked', async () => {
  _resetWindowFocusGuardForTest();
  recordTargetWindow({ keyword: 'Notepad' });
  const throwCase = await guardTypingFocus(['deepseek harness'], {
    probeForeground: async () => HOST,
    refocus: async () => { throw new Error('element not found'); },
  });
  assert.equal(throwCase.blocked, true);
  assert.match((throwCase as { reason: string }).reason, /refocus via "Notepad" failed/);

  _resetWindowFocusGuardForTest();
  recordTargetWindow({ keyword: 'Notepad' });
  let probes = 0;
  const stillHost = await guardTypingFocus(['deepseek harness'], {
    probeForeground: async () => { probes += 1; return HOST; }, // 复测仍宿主
    refocus: async () => ({ matched: 'whatever' }),
  });
  assert.equal(stillHost.blocked, true);
  assert.match((stillHost as { reason: string }).reason, /did not move the foreground off the host/);
  assert.equal(probes, 2); // 复测确实发生（判定依据是第二探，不是猜测）

  _resetWindowFocusGuardForTest();
  recordTargetWindow({ keyword: 'Notepad' });
  const noPort = await guardTypingFocus(['deepseek harness'], { probeForeground: async () => HOST });
  assert.equal(noPort.blocked, true);
  assert.match((noPort as { reason: string }).reason, /refocus channel is unavailable/);
});

// ─── ③ type_text 集成（system 打桩：save/restore，r29 census 同律） ───

type Exec = (a: unknown) => Promise<string>;
const exec = (t: unknown): Exec => (t as unknown as { execute: Exec }).execute;

/** 与 epochDelta.safety clickCfg 同族：闸门语义开、验证/OCR 全关（离线确定性）+ R2-3 开关可注入 */
function makeCfg(extra: Record<string, unknown> = {}): Config {
  return {
    enableApprovalGate: false, dangerPatterns: '',
    enableRiskGate: true, riskPatterns: '',
    maxTextLength: 1000, focusMaxAgeMs: 60_000,
    verifyActions: false, dryRun: false,
    enableOcr: false, ocrLang: 'eng',
    adaptiveSettle: false, actionSettleMs: 1,
    noopSimilarityThreshold: 0.97, regionVerifyRadius: 0.15,
    ...extra,
  } as unknown as Config;
}

interface SystemStubs {
  /** 可变前台标题（stubSystem 捕获闭包引用 —— 测试中途改它即改探测结果） */
  foreground: string | null;
  typed: number;
  switched: string[];
  switchResult?: { method: string; matched: string | null };
  switchThrows?: Error;
}

function stubSystem(s: SystemStubs): () => void {
  const host = system as unknown as Record<string, unknown>;
  const saved = {
    getForegroundWindowTitle: host.getForegroundWindowTitle,
    switchWindowByTitle: host.switchWindowByTitle,
    typeText: host.typeText,
  };
  host.getForegroundWindowTitle = async (): Promise<string | null> => s.foreground;
  host.switchWindowByTitle = async (kw: string): Promise<{ method: string; matched: string | null }> => {
    s.switched.push(kw);
    if (s.switchThrows) throw s.switchThrows;
    return s.switchResult ?? { method: 'native', matched: kw };
  };
  host.typeText = async (): Promise<void> => { s.typed += 1; };
  return () => Object.assign(host, saved);
}

test('R2-3 Pi: type_text 宿主前台 + 无记账 ⇒ FAILED（无 state_anchor 方言）且绝不派发键入', async () => {
  _resetWindowFocusGuardForTest();
  const s: SystemStubs = { foreground: HOST, typed: 0, switched: [] };
  const restore = stubSystem(s);
  try {
    const raw = await exec(createTypeTextTool(makeCfg({ typeFocusGuard: true })))({ text: 'hello' });
    const out = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(out.status, 'FAILED');
    assert.ok(String(out.error).includes('foreground window is the agent host itself'));
    assert.ok('next_step' in out);
    assert.ok(!('state_anchor' in out), 'FAILED 无 state_anchor（与 catch 臂同款在册方言）');
    assert.equal(s.typed, 0, '键入绝不能派发（防打字落进宿主输入框污染下一回合 prompt）');
    assert.equal(s.switched.length, 0, '无记账 ⇒ 不盲试切窗');
  } finally {
    restore();
  }
});

test('R2-3 Pj: type_text 宿主前台 + 复焦成功 ⇒ SUCCESS + focus_guard=refocused，键入派发一次', async () => {
  _resetWindowFocusGuardForTest();
  recordTargetWindow({ keyword: 'Notepad', matchedTitle: '记事本' });
  const s: SystemStubs = { foreground: HOST, typed: 0, switched: [], switchResult: { method: 'native', matched: '无标题 - 记事本' } };
  const restore = stubSystem(s);
  // 复焦成功后前台换成目标窗（第二探脱离宿主）：switchWindowByTitle 打桩已计数，
  // 探测桩读同一个可变 state —— 切窗后手动翻 foreground
  const host = system as unknown as Record<string, unknown>;
  const probe = host.getForegroundWindowTitle;
  host.getForegroundWindowTitle = async (): Promise<string | null> =>
    s.switched.length > 0 ? '*marker - Notepad' : s.foreground;
  try {
    const raw = await exec(createTypeTextTool(makeCfg({ typeFocusGuard: true })))({ text: 'hello world' });
    const out = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(out.status, 'SUCCESS');
    const fg = (out.state_anchor as Record<string, unknown>).focus_guard as Record<string, unknown>;
    assert.equal(fg.status, 'refocused');
    assert.equal(fg.foreground_title, '*marker - Notepad');
    assert.deepEqual(s.switched, ['Notepad'], '复焦用记账关键词，只试一次');
    assert.equal(s.typed, 1, '复焦脱离宿主后键入正常派发');
  } finally {
    host.getForegroundWindowTitle = probe;
    restore();
  }
});

test('R2-3 Pk: type_text 正常前台 ⇒ SUCCESS + focus_guard.status=ok；SUCCESS 顶层键序零漂移', async () => {
  _resetWindowFocusGuardForTest();
  const s: SystemStubs = { foreground: '*marker - Notepad', typed: 0, switched: [] };
  const restore = stubSystem(s);
  try {
    const raw = await exec(createTypeTextTool(makeCfg({ typeFocusGuard: true })))({ text: 'hello world' });
    const out = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(out.status, 'SUCCESS');
    assert.deepEqual(Object.keys(out), ['status', 'action', 'state_anchor', 'next_step'],
      'SUCCESS 顶层键序 = toolOk 工厂方言（ΑΩ-R29 形状铁律不因 R2-3 漂移）');
    const fg = (out.state_anchor as Record<string, unknown>).focus_guard as Record<string, unknown>;
    assert.equal(fg.status, 'ok');
    assert.equal(fg.foreground_title, '*marker - Notepad');
    assert.equal(s.typed, 1);
  } finally {
    restore();
  }
});

test('R2-3 Pl: 开关关（undefined，测试部分配置）⇒ 完全旧路径：宿主前台也照打、锚点零 focus_guard 键', async () => {
  _resetWindowFocusGuardForTest();
  const s: SystemStubs = { foreground: HOST, typed: 0, switched: [] };
  const restore = stubSystem(s);
  try {
    const raw = await exec(createTypeTextTool(makeCfg({})))({ text: 'hello' }); // typeFocusGuard 未设
    const out = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(out.status, 'SUCCESS');
    assert.equal(s.typed, 1, '开关关 = 旧行为（guard 不介入）');
    assert.ok(!('focus_guard' in (out.state_anchor as Record<string, unknown>)), '锚点形状与旧路逐字节一致');
  } finally {
    restore();
  }
});

test('R2-3 Pm: dry-run 下 guard 跳过（无真实键入即无串窗面）', async () => {
  _resetWindowFocusGuardForTest();
  const s: SystemStubs = { foreground: HOST, typed: 0, switched: [] };
  const restore = stubSystem(s);
  try {
    const raw = await exec(createTypeTextTool(makeCfg({ typeFocusGuard: true, dryRun: true })))({ text: 'x' });
    const out = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(out.status, 'SUCCESS');
    assert.ok(!('focus_guard' in (out.state_anchor as Record<string, unknown>)));
  } finally {
    restore();
  }
});

// ─── ④ 驱动器纯逻辑（bench/driveCore.mjs） ───

test('R2-3 Va: shouldRunHostFocusGuard 调度序 —— 首拍立即 / 间隔防抖 / 0=关 / 边界即到即跑', () => {
  assert.equal(drive.shouldRunHostFocusGuard({ nowMs: 1000, lastGuardMs: null, intervalMs: 9000 }), true, '首拍立即');
  assert.equal(drive.shouldRunHostFocusGuard({ nowMs: 9999, lastGuardMs: 1000, intervalMs: 9000 }), false, '间隔内不重入');
  assert.equal(drive.shouldRunHostFocusGuard({ nowMs: 10000, lastGuardMs: 1000, intervalMs: 9000 }), true, '到点即跑（≥）');
  assert.equal(drive.shouldRunHostFocusGuard({ nowMs: 1000, lastGuardMs: 0, intervalMs: 0 }), false, '0=关闭');
  assert.equal(drive.shouldRunHostFocusGuard({ nowMs: 0, lastGuardMs: null }), true, '缺省间隔 9000');
});

test('R2-3 Vb: hostGuardVerdict —— 大小写不敏感子串；空标题不算（证据缺失方向）', () => {
  assert.deepEqual(drive.hostGuardVerdict('DeepSeek Harness', ['DeepSeek Harness']), { hostForeground: true });
  assert.deepEqual(drive.hostGuardVerdict('deepseek HARNESS (2)', ['deepseek harness']), { hostForeground: true });
  assert.deepEqual(drive.hostGuardVerdict('*marker - Notepad', ['DeepSeek Harness']), { hostForeground: false });
  assert.deepEqual(drive.hostGuardVerdict('', ['dsh']), { hostForeground: false });
  assert.deepEqual(drive.hostGuardVerdict(null, ['dsh']), { hostForeground: false });
});

test('R2-3 Vc: parseHostMarkersCsv（驱动侧）+ psQuote —— CSV 解析 / 单引号加倍（PS 字面量注入闸）', () => {
  assert.deepEqual(drive.parseHostMarkersCsv('My Host, x '), ['My Host', 'x']);
  assert.deepEqual(drive.parseHostMarkersCsv(''), ['DeepSeek Harness']);
  assert.deepEqual(drive.parseHostMarkersCsv(undefined), ['DeepSeek Harness']);
  assert.equal(drive.psQuote("O'Brien"), "'O''Brien'");
  assert.equal(drive.psQuote('plain'), "'plain'");
});

test('R2-3 Vd: buildHostGuardPs —— 只压宿主窗（SW_MINIMIZE=6）/ 标记转义进数组 / 管道强转回归钉', () => {
  const ps = drive.buildHostGuardPs(["Deepse'ek Harness"]);
  assert.match(ps, /GetForegroundWindow/, 'P/Invoke 前台读取在场');
  assert.match(ps, /GetWindowText/, '标题读取在场');
  assert.match(ps, /ShowWindowAsync\(\$h, 6\)/, '命中才最小化（SW_MINIMIZE=6 —— 只压宿主窗）');
  assert.match(ps, /'Deepse''ek Harness'/, '标记经 psQuote 转义（单引号加倍）');
  assert.doesNotMatch(ps, /\[void\]\s*\S+\|\s*Out-Null/, '管道强转回归钉：[void]X | Out-Null 在 PS 是语法错误（实测战果）');
  assert.match(ps, /HOSTGUARD\|suppressed\|/, 'suppress 标记行协议在场');
  assert.match(ps, /HOSTGUARD\|pass\|/, 'pass 标记行协议在场');
});

test('R2-3 Ve: parseHostGuardLine —— suppressed/pass/unknown 三态；标题内管道符回拼', () => {
  assert.deepEqual(drive.parseHostGuardLine('HOSTGUARD|suppressed|DeepSeek Harness'), { action: 'suppressed', title: 'DeepSeek Harness' });
  assert.deepEqual(drive.parseHostGuardLine('noise\r\nHOSTGUARD|pass|a|b'), { action: 'pass', title: 'a|b' }, '标题含管道符：slice(2).join 保持原文');
  assert.deepEqual(drive.parseHostGuardLine(''), { action: 'unknown', title: null });
  assert.deepEqual(drive.parseHostGuardLine('garbage output'), { action: 'unknown', title: null });
  assert.deepEqual(drive.parseHostGuardLine('HOSTGUARD|weird|x'), { action: 'unknown', title: null }, '方言漂移按 unknown（不猜）');
});

test('R2-3 Vf: 守卫常量 —— 缺省间隔 9s 与标记表 DeepSeek Harness（实测宿主窗口标题）', () => {
  assert.equal(drive.HOST_FOCUS_GUARD_INTERVAL_MS, 9000);
  assert.deepEqual(drive.HOST_WINDOW_MARKERS_DEFAULT, ['DeepSeek Harness']);
});

// ─── 收尾：全态复位（测试隔离纪律） ───

test('R2-3 teardown: 焦点保卫全局态复位', () => {
  _resetWindowFocusGuardForTest();
  assert.equal(peekTargetWindow(), null);
});
