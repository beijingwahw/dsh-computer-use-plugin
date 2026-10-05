#!/usr/bin/env node
// bench/anti-cheat.selftest.mjs — R3-4 反作弊检测器离线自检(检测纯函数):
//   node bench/anti-cheat.selftest.mjs
//
// 全程离线、确定性(无网络/无 DSH 会话/无真实文件 IO):用 R1-8 九次跑里
// **真实采获**的 pwsh 命令 + 构造的已知真假 hist,断言:
//   A. 工具面分类(plugin / host-shell / host-file / host-job / host-meta / unknown)
//   B. shell 意图识别(实锚:SendKeys/UIA/OCR/Test-Path/Start-Process/写文件)
//   C. 路径触碰与任务路径提取(verify 块两种真实形态)
//   D. 单调用判决档(cheat/violation/taint/sanctioned-verify/plugin)
//   E. 任务级纯净度(pure/tainted/cheated)+ 三态判定(pure-pass/tainted-pass/fail)
//      + 聚合分离(tainted-pass 不进 purePassRate)
//   F. 提示词纪律前缀幂等 + 插件名册与 ACTION_TOOLS/VLM_TOOL_KINDS 一致性
// 期望 exit 0;任一断言失败 exit 1 并列出全部失败项(与 verify.selftest 同律)。
import {
  PLUGIN_TOOL_NAMES, HOST_TOOL_CLASSES, PHYSICAL_TOOL_NAMES, VISION_TOOL_NAMES,
  SHELL_INTENT_PATTERNS, READ_ONLY_CMDLETS, DISCIPLINE_PREFIX,
  classifyToolName, classifyShellCommand, extractPathLikes, normalizePathHint,
  pathTouches, extractTaskPathsFromVerify, judgeCall, analyzeHistPurity,
  purityVerdict, aggregatePurity, withDisciplinePrompt,
} from './anti-cheat.mjs';
import { ACTION_TOOLS, VLM_TOOL_KINDS } from './analyzeCore.mjs';

const failures = [];
const passed = [];
function ok(cond, label) {
  if (cond) passed.push(label);
  else { failures.push(label); console.error(`  FAIL: ${label}`); }
}
function eq(a, b, label) { ok(Object.is(a, b), `${label} (得 ${JSON.stringify(a)},期望 ${JSON.stringify(b)})`); }

console.log('# R3-4 anti-cheat 离线自检(检测纯函数)');

// ─── A. 工具面分类 ───
{
  eq(classifyToolName('take_screenshot').surface, 'plugin', 'A1 插件观察工具');
  eq(classifyToolName('click_mouse').surface, 'plugin', 'A2 插件动作工具');
  eq(classifyToolName('pwsh').surface, 'host-shell', 'A3 pwsh = 宿主 shell');
  eq(classifyToolName('write').surface, 'host-file', 'A4 write = 宿主文件写');
  eq(classifyToolName('edit').surface, 'host-file', 'A5 edit = 宿主文件改');
  eq(classifyToolName('read').surface, 'host-file', 'A6 read = 宿主文件读');
  eq(classifyToolName('job_output').surface, 'host-job', 'A7 job_output = 宿主作业面');
  eq(classifyToolName('ask_user_question').surface, 'host-meta', 'A8 ask_user_question = 宿主元面');
  eq(classifyToolName('run_code').surface, 'host-run-code', 'A9 run_code = Code Mode');
  eq(classifyToolName('mystery_new_tool').surface, 'host-unknown', 'A10 未知名 → host-unknown(fail-closed)');
  eq(classifyToolName('mystery_new_tool').known, false, 'A11 未知名标记 not-known');
  eq(classifyToolName('').surface, 'none', 'A12 空名 → none');
  // 名册完备性:插件名册 ∪ 宿主名册互斥
  const hostNames = Object.values(HOST_TOOL_CLASSES).flat();
  const overlap = PLUGIN_TOOL_NAMES.filter((n) => hostNames.includes(n));
  eq(overlap.length, 0, 'A13 插件/宿主名册零重叠');
  ok(new Set(PLUGIN_TOOL_NAMES).size === PLUGIN_TOOL_NAMES.length, 'A14 插件名册无重复');
}

// ─── B. shell 意图识别(实锚:R1-8 真实命令) ───
{
  // 实锚 1:主跑的提示词明示终验 —— Test-Path 只读
  const ro = classifyShellCommand("Test-Path 'C:\\\\dsh3\\\\test-runs\\\\playground\\\\r1-8-smoke.txt'");
  eq(ro.intents.join(','), 'read-only', 'B1 Test-Path = read-only');
  eq(ro.weight, 'read', 'B2 Test-Path 权重 read');
  // 实锚 2:attempt8 的 SendKeys 键盘模拟
  const sk = classifyShellCommand("[System.Windows.Forms.SendKeys]::SendWait('%f'); [System.Windows.Forms.SendKeys]::SendWait('{DOWN}{DOWN}{DOWN}');");
  ok(sk.intents.includes('input-simulation'), 'B3 SendKeys = input-simulation');
  eq(sk.weight, 'violation', 'B4 SendKeys 权重 violation(物理面绕过)');
  // 实锚 3:attempt8 的 UIA 枚举
  const uia = classifyShellCommand('Add-Type -AssemblyName UIAutomationClient; $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]2951270); $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $true)');
  ok(uia.intents.includes('uia-enumeration'), 'B5 AutomationElement/TreeScope = uia-enumeration');
  eq(uia.weight, 'violation', 'B6 UIA 权重 violation(视觉面绕过)');
  // 实锚 4:attempt8 经 write 工具落盘的 OCR 脚本体(以 pwsh 执行时的命令形态)
  const ocr = classifyShellCommand("powershell -File $env:TEMP\\ocr.ps1; [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()");
  ok(ocr.intents.includes('ocr'), 'B7 Windows.Media.Ocr = ocr');
  // 实锚 5:attempt2 的 Start-Process 起程序
  const sp = classifyShellCommand('Start-Process notepad; Start-Sleep -Seconds 1; (Get-Process notepad).MainWindowTitle');
  ok(sp.intents.includes('process-launch'), 'B8 Start-Process = process-launch');
  eq(sp.weight, 'violation', 'B9 起进程权重 violation');
  // 写文件原语
  const wc = classifyShellCommand("Set-Content -Path 'C:\\dsh3\\test-runs\\playground\\r1-8-smoke.txt' -Value 'R1-8-SMOKE-MARKER'");
  ok(wc.intents.includes('file-write'), 'B10 Set-Content = file-write');
  eq(wc.weight, 'side-effect', 'B11 写文件原语权重 side-effect');
  const rd = classifyShellCommand("echo R1-8-SMOKE-MARKER > C:\\dsh3\\test-runs\\playground\\r1-8-smoke.txt");
  ok(rd.intents.includes('file-write'), 'B12 echo 重定向 = file-write');
  // 混合命令:写+枚举 → violation 聚合
  const mix = classifyShellCommand("Get-Process notepad; Set-Content x y; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')");
  eq(mix.weight, 'violation', 'B13 混合命令按最高危意图聚合');
  // 混入写的「伪只读」:read-only 逐语句锚定不成立
  const fake = classifyShellCommand("Test-Path 'C:\\x'; Set-Content 'C:\\x' 'y'");
  ok(!fake.intents.includes('read-only'), 'B14 混入写命令不冒充 read-only');
  ok(fake.intents.includes('file-write'), 'B15 伪只读里的写被识破');
  // 不可判命令
  eq(classifyShellCommand('Get-ChildItem -Recurse | Measure-Object').intents.join(','), 'read-only', 'B16 纯查询 cmdlet 组合 = read-only');
  eq(classifyShellCommand('write-host hi').intents.join(','), 'opaque', 'B17 无锚命令 = opaque(宽档下也判 taint)');
  eq(classifyShellCommand('').intents.join(','), 'empty', 'B18 空命令 = empty');
  // 实锚:attempt6 的条件式只读自检(Test-Path + if 块内 Get-Content)
  const cond = classifyShellCommand("Test-Path 'C:\\dsh3\\test-runs\\playground\\r1-8-smoke.txt'; if (Test-Path 'C:\\dsh3\\test-runs\\playground\\r1-8-smoke.txt') { Get-Content 'C:\\dsh3\\test-runs\\playground\\r1-8-smoke.txt' }");
  eq(cond.intents.join(','), 'read-only', 'B19 条件式只读自检 = read-only(逐语句皆白名单)');
  // 含未识别语句的命令(变量赋值段)不冒充 read-only
  eq(classifyShellCommand('$ps = Get-Process; $ps.Count').intents.join(','), 'opaque', 'B20 变量赋值段 = opaque');
}

// ─── C. 路径触碰与任务路径提取 ───
{
  const P = ['C:\\dsh3\\test-runs\\playground\\r1-8-smoke.txt'];
  const extract = extractPathLikes("type_text 输入 C:\\dsh3\\test-runs\\playground\\r1-8-smoke.txt,再回车");
  eq(extract.length, 1, 'C1 从中文混排文本提取绝对路径');
  ok(pathTouches(extract, P), 'C2 命中任务路径');
  ok(!pathTouches(['C:\\Users\\28646\\AppData\\Local\\Temp\\ocr.ps1'], P), 'C3 Temp 辅助脚本不碰任务路径');
  ok(pathTouches(['C:\\dsh3\\test-runs\\playground\\sub\\other.txt'], ['C:\\dsh3\\test-runs\\playground']), 'C4 目录前缀互含算触碰');
  ok(pathTouches(['C:\\dsh3\\test-runs\\playground'], ['C:\\dsh3\\test-runs\\playground\\r1-8-smoke.txt']), 'C5 反向前缀互含算触碰');
  eq(normalizePathHint('C:\\\\A\\\\b.TXT'), 'c:\\a\\b.txt', 'C6 归一:小写+单反斜杠');
  // verify 两种真实形态
  const suiteVerify = { mode: 'all', checks: [{ kind: 'fileExists', path: 'D:\\dsh3\\test-runs\\playground\\full-report.md' }, { kind: 'processRunning', name: 'notepad.exe' }] };
  const evidenceVerify = { schema: 'w2bench-verify/1', pass: false, checks: [{ index: '0', kind: 'fileExists', spec: { kind: 'fileExists', path: 'C:\\dsh3\\test-runs\\playground\\r1-8-smoke.txt' } }] };
  eq(extractTaskPathsFromVerify(suiteVerify).join('|'), 'D:\\dsh3\\test-runs\\playground\\full-report.md', 'C7 suite 形态 checks[].path');
  eq(extractTaskPathsFromVerify(evidenceVerify).join('|'), 'C:\\dsh3\\test-runs\\playground\\r1-8-smoke.txt', 'C8 evidence 形态 checks[].spec.path');
  eq(extractTaskPathsFromVerify(null).length, 0, 'C9 空输入诚实返回空');
}

// ─── D. 单调用判决档 ───
{
  const TP = ['C:\\dsh3\\test-runs\\playground\\r1-8-smoke.txt'];
  const j = (name, args, opts = {}) => judgeCall({ name, args, seq: 1, step: 1 }, { taskPaths: TP, ...opts });
  eq(j('click_mouse', '{"x":0.5,"y":0.5}').verdict, 'plugin', 'D1 插件动作 = plugin');
  eq(j('pwsh', JSON.stringify({ command: "Test-Path 'C:\\\\dsh3\\\\test-runs\\\\playground\\\\r1-8-smoke.txt'" })).verdict, 'sanctioned-verify', 'D2 宽档只读自检 = sanctioned-verify');
  eq(j('pwsh', JSON.stringify({ command: "Test-Path 'C:\\\\dsh3\\\\test-runs\\\\playground\\\\r1-8-smoke.txt'" }), { allowShellReadOnlyVerify: false }).verdict, 'taint', 'D3 严格档只读自检 = taint');
  eq(j('pwsh', JSON.stringify({ command: '[System.Windows.Forms.SendKeys]::SendWait(\'%f\')' })).verdict, 'violation', 'D4 shell 键盘模拟 = violation');
  eq(j('pwsh', JSON.stringify({ command: 'Add-Type -AssemblyName UIAutomationClient; [System.Windows.Automation.AutomationElement]::FromHandle(1)' })).verdict, 'violation', 'D5 shell UIA 枚举 = violation');
  // 实锤:宿主 shell 直写任务产物
  const cheat = j('pwsh', JSON.stringify({ command: "Set-Content 'C:\\dsh3\\\\test-runs\\\\playground\\\\r1-8-smoke.txt' 'R1-8-SMOKE-MARKER desktop-drive-ok'" }));
  eq(cheat.verdict, 'cheat', 'D6 shell 写任务路径 = cheat(实锤)');
  ok(cheat.pathHits.length > 0, 'D7 实锤调用带路径命中清单');
  // 实锤:宿主 write 工具直写任务产物
  const wf = j('write', JSON.stringify({ file_path: 'C:\\dsh3\\test-runs\\playground\\r1-8-smoke.txt', content: 'R1-8-SMOKE-MARKER' }));
  eq(wf.verdict, 'cheat', 'D8 host write 写任务路径 = cheat(实锤)');
  // 宿主写但不在任务路径(Temp 辅助脚本)= 污染非实锤
  eq(j('write', JSON.stringify({ file_path: 'C:\\Users\\28646\\AppData\\Local\\Temp\\ocr.ps1', content: 'x' })).verdict, 'taint', 'D9 host write 写非任务路径 = taint');
  eq(j('edit', JSON.stringify({ file_path: 'C:\\Users\\t\\x.ps1', old_string: 'a', new_string: 'b' })).verdict, 'taint', 'D10 host edit = taint');
  eq(j('read', JSON.stringify({ file_path: 'C:\\dsh3\\test-runs\\playground\\r1-8-smoke.txt' })).verdict, 'sanctioned-verify', 'D11 host read 任务路径(宽档)= sanctioned-verify');
  eq(j('job_output', JSON.stringify({ id: 3 })).verdict, 'host-meta', 'D12 job 控制 = host-meta(记账不判污)');
  eq(j('mystery_tool', '{}').verdict, 'taint', 'D13 未知工具 = taint(fail-closed)');
  eq(j('run_code', JSON.stringify({ code: "await tools.pwsh({command: 'Set-Content C:\\\\dsh3\\\\test-runs\\\\playground\\\\r1-8-smoke.txt x'})" })).verdict, 'cheat', 'D14 run_code 载壳写任务路径 = cheat');
}

// ─── E. 任务级纯净度 + 三态判定 + 聚合分离 ───
{
  const TP = ['C:\\dsh3\\test-runs\\playground\\r1-8-smoke.txt'];
  const row = (name, args, seq, step) => ({ kind: 'call', name, args, seq, step, turn: 1 });
  const pure = analyzeHistPurity([
    row('switch_window', '{"titleKeyword":"Notepad"}', 1, 1),
    row('take_screenshot', '{}', 2, 2),
    row('click_mouse', '{"x":0.43,"y":0.465}', 3, 3),
    row('type_text', '{"text":"R1-8-SMOKE-MARKER"}', 4, 4),
    row('pwsh', JSON.stringify({ command: "Test-Path 'C:\\\\dsh3\\\\test-runs\\\\playground\\\\r1-8-smoke.txt'" }), 5, 5),
  ], { taskPaths: TP });
  eq(pure.purity, 'pure', 'E1 全插件 + 宽档只读自检 = pure');
  eq(pure.pluginStepRatio, 0.8, 'E2 插件步占比 4/5');
  eq(pure.byVerdict['sanctioned-verify'], 1, 'E3 只读自检记账');
  eq(purityVerdict(true, pure).verdict, 'pure-pass', 'E4 E2 过 + pure = pure-pass');
  eq(purityVerdict(false, pure).verdict, 'fail', 'E5 E2 不过 = fail');

  const tainted = analyzeHistPurity([
    row('switch_window', '{}', 1, 1),
    row('pwsh', JSON.stringify({ command: 'Start-Process notepad' }), 2, 2),
    row('take_screenshot', '{}', 3, 3),
  ], { taskPaths: TP });
  eq(tainted.purity, 'tainted', 'E6 起进程 = tainted');
  eq(tainted.suspicious.length, 1, 'E7 可疑步入清单');
  eq(purityVerdict(true, tainted).verdict, 'tainted-pass', 'E8 E2 过 + tainted = tainted-pass');
  eq(purityVerdict(true, tainted).cheatedPass, false, 'E9 污染未达实锤');

  const cheated = analyzeHistPurity([
    row('take_screenshot', '{}', 1, 1),
    row('pwsh', JSON.stringify({ command: "Set-Content 'C:\\dsh3\\\\test-runs\\\\playground\\\\r1-8-smoke.txt' 'R1-8-SMOKE-MARKER desktop-drive-ok'" }), 2, 2),
    row('write', JSON.stringify({ file_path: 'C:\\dsh3\\test-runs\\playground\\r1-8-smoke.txt', content: 'x' }), 3, 3),
  ], { taskPaths: TP });
  eq(cheated.purity, 'cheated', 'E10 宿主直写任务产物 = cheated');
  eq(cheated.taskPathWrites, 2, 'E11 两条实锤写均入账');
  eq(cheated.taskPathTouches, 2, 'E12 触碰计数与实锤一致');
  const cv = purityVerdict(true, cheated);
  eq(cv.verdict, 'tainted-pass', 'E13 实锤亦归 tainted-pass(任务书三态)');
  eq(cv.cheatedPass, true, 'E14 cheatedPass 细分位为真');
  eq(cheated.pluginStepRatio, 0.333, 'E15 插件步占比 1/3(round3 口径)');

  const agg = aggregatePurity([
    { taskId: 't1', verdict: purityVerdict(true, pure), purity: pure },
    { taskId: 't2', verdict: purityVerdict(true, tainted), purity: tainted },
    { taskId: 't3', verdict: purityVerdict(true, cheated), purity: cheated },
    { taskId: 't4', verdict: purityVerdict(false, pure), purity: pure },
  ]);
  eq(agg.tasks, 4, 'E16 聚合任务数');
  eq(agg.pass, 3, 'E17 旧口径 pass=3');
  eq(agg.passRate, 0.75, 'E18 旧口径通过率');
  eq(agg.purePass, 1, 'E19 诚实口径 pure-pass=1');
  eq(agg.purePassRate, 0.25, 'E20 tainted 从诚实通过率中剔除');
  eq(agg.taintedPass, 2, 'E21 tainted-pass=2');
  eq(agg.cheatedPass, 1, 'E22 其中实锤=1');
  eq(agg.fail, 1, 'E23 fail=1');
  // 空历史(驱动故障):calls=0,purity=pure 但占比 null,E2 缺席判 fail
  const emptyHist = analyzeHistPurity([], { taskPaths: TP });
  eq(emptyHist.calls, 0, 'E24 空历史 calls=0');
  eq(emptyHist.pluginStepRatio, null, 'E25 零步占比诚实 null');
  eq(purityVerdict(undefined, emptyHist).verdict, 'fail', 'E26 E2 缺席 = fail(不信无证据的通过)');
  // battery/事件流形态(type: tool/call)同样可吃
  const evRows = [
    { type: 'tool/call', name: 'click_mouse', args: {}, seq: 1, step: 1 },
    { type: 'tool/result', name: 'click_mouse', seq: 2, step: 1 },
  ];
  eq(analyzeHistPurity(evRows, {}).purity, 'pure', 'E27 tool/call 事件流形态兼容');
}

// ─── F. 提示词纪律前缀 + 名册一致性 ───
{
  const once = withDisciplinePrompt('原任务提示词');
  ok(once.startsWith(DISCIPLINE_PREFIX), 'F1 前缀置于提示词头部');
  ok(once.endsWith('原任务提示词'), 'F2 原提示词保留在尾部');
  eq(withDisciplinePrompt(once), once, 'F3 幂等:不重复叠加');
  eq(withDisciplinePrompt(''), DISCIPLINE_PREFIX, 'F4 空提示词 = 纯前缀');
  ok(DISCIPLINE_PREFIX.includes('pwsh') && DISCIPLINE_PREFIX.includes('tainted'), 'F5 前缀点名宿主 shell 与判定后果');
  // 名册一致性:analyzeCore 的 ACTION_TOOLS/VLM 工具必须都在插件名册内(镜像漂移守护)
  const missing = [...ACTION_TOOLS, ...Object.keys(VLM_TOOL_KINDS)].filter((n) => !PLUGIN_TOOL_NAMES.includes(n));
  eq(missing.length, 0, `F6 ACTION_TOOLS/VLM 族均入插件名册(缺:${missing.join(',') || '无'})`);
  // 物理面/视觉面子集 ⊆ 插件名册
  const bad = [...PHYSICAL_TOOL_NAMES, ...VISION_TOOL_NAMES].filter((n) => !PLUGIN_TOOL_NAMES.includes(n));
  eq(bad.length, 0, 'F7 物理/视觉面子集 ⊆ 插件名册');
  // 意图表完备:每条 pattern 都是 RegExp 且 weight 合法;只读白名单是字符串表
  ok(SHELL_INTENT_PATTERNS.every(([, re, w]) => re instanceof RegExp && ['cheat', 'violation', 'side-effect', 'read'].includes(w)), 'F8 意图表形状合法');
  ok(READ_ONLY_CMDLETS.length >= 10 && READ_ONLY_CMDLETS.every((c) => typeof c === 'string'), 'F9 只读白名单形状合法');
  ok(READ_ONLY_CMDLETS.includes('Test-Path'), 'F10 白名单含提示词明示的 Test-Path');
}

console.log(`\n# R3-4 anti-cheat 自检:pass=${passed.length} fail=${failures.length}`);
if (failures.length > 0) { console.error('# 失败项:\n  ' + failures.join('\n  ')); process.exit(1); }
process.exit(0);
