#!/usr/bin/env node
// bench/playground-reset.selftest.mjs — R2-7 单测:状态矩阵/路径卫兵/幂等性纯函数
// 运行: node bench/playground-reset.selftest.mjs   (期望 exit 0)
// 全程纯函数:无 fs 写、无 PowerShell、不触 playground——只验证复位器的判定核心。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TEMPLATE_FILES, SEED_CONTENTS, TASK_MATRIX, resolvePlayground, guardPlayground, isInside,
  planReset, WINDOW_SIGNATURE, PROCESS_RULES, classifyWindows, getTaskState,
} from './playground-reset.mjs';

const failures = [];
let n = 0;
const ok = (name, cond, detail = '') => { n++; if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
const PG = 'C:\\dsh3\\test-runs\\playground';
const task = (id) => getTaskState(id);

// ── A. 路径卫兵(guardPlayground / isInside)───────────────────────────────
{
  const g = guardPlayground(PG); ok('A1 卫兵接受本机部署路径', g.ok, g.reason);
  ok('A2 卫兵接受任意 test-runs 父名(大小写不敏感)', guardPlayground('C:\\foo\\TEST-RUNS\\Playground').ok);
  ok('A3 卫兵拒绝相对路径', !guardPlayground('playground').ok);
  ok('A4 卫兵拒绝叶目录非 playground', !guardPlayground('C:\\dsh3\\test-runs\\playground2').ok);
  ok('A5 卫兵拒绝父目录非 test-runs', !guardPlayground('C:\\dsh3\\myground\\playground').ok);
  ok('A6 卫兵拒绝 .. 穿越', !guardPlayground('C:\\dsh3\\test-runs\\..\\test-runs\\playground').ok);
  ok('A7 卫兵拒绝过浅路径', !guardPlayground('D:\\playground').ok);
  ok('A8 卫兵拒绝系统禁区', !guardPlayground('C:\\Windows\\test-runs\\playground').ok);
  ok('A9 卫兵拒绝空路径', !guardPlayground('').ok);

  ok('B1 isInside 接受场内子项', isInside(PG + '\\a.txt', PG));
  ok('B2 isInside 接受深层子项', isInside(PG + '\\full-drag-dst\\drag-me.txt', PG));
  ok('B3 isInside 拒绝兄弟前缀攻击(playground2)', !isInside('C:\\dsh3\\test-runs\\playground2\\a.txt', PG));
  ok('B4 isInside 拒绝场根本身', !isInside(PG, PG));
  ok('B5 isInside 拒绝场外', !isInside('C:\\dsh3\\test-runs\\results\\x', PG));
  ok('B6 isInside 大小写不敏感', isInside('c:\\DSH3\\TEST-RUNS\\PLAYGROUND\\a', PG));
  ok('B7 isInside 拒绝斜杠变体越界', !isInside('C:/dsh3/test-runs/results', PG));
}

// ── B. resolvePlayground 优先级 ──────────────────────────────────────────
{
  eq('C1 缺省=本机 R1-2 部署值', resolvePlayground({ env: {} }), PG);
  eq('C2 DSH_BENCH_TEST_RUNS 派生', resolvePlayground({ env: { DSH_BENCH_TEST_RUNS: 'C:\\x\\test-runs' } }), 'C:\\x\\test-runs\\playground');
  eq('C3 DSH_BENCH_PLAYGROUND 覆盖派生', resolvePlayground({ env: { DSH_BENCH_TEST_RUNS: 'C:\\x\\test-runs', DSH_BENCH_PLAYGROUND: 'D:\\y\\test-runs\\playground' } }), 'D:\\y\\test-runs\\playground');
  eq('C4 --playground 最高优先', resolvePlayground({ env: { DSH_BENCH_PLAYGROUND: 'D:\\y\\test-runs\\playground' }, cliPath: 'E:\\z\\test-runs\\playground' }), 'E:\\z\\test-runs\\playground');
  eq('C5 正斜杠归一为反斜杠', resolvePlayground({ env: { DSH_BENCH_TEST_RUNS: 'C:/x/test-runs/' } }), 'C:\\x\\test-runs\\playground');
}

// ── C. 状态矩阵完整性(对照 suite-full.json 真文件)──────────────────────
{
  const suitePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'suite-full.json');
  const suite = JSON.parse(fs.readFileSync(suitePath, 'utf8'));
  const suiteIds = suite.tasks.map((t) => t.id);
  const matrixIds = TASK_MATRIX.map((t) => t.id);
  eq('D1 矩阵 26 任务且与 suite-full 双向一致', matrixIds.slice().sort(), suiteIds.slice().sort());
  eq('D2 order 为 1..26 连续', TASK_MATRIX.map((t) => t.order), Array.from({ length: 26 }, (_, i) => i + 1));
  ok('D3 每任务必有 note/standalone 字段', TASK_MATRIX.every((t) => typeof t.note === 'string' && t.note.length > 0 && typeof t.standalone === 'boolean'));
  ok('D4 seed 引用的内容键全部存在', TASK_MATRIX.every((t) => Object.values(t.seed).every((k) => k in SEED_CONTENTS)));
  ok('D5 dsh-made 永不被播种', !TASK_MATRIX.some((t) => JSON.stringify(t.seed).includes('dsh-made')));
  ok('D6 模板树 5 文件与 R1-2 一致', JSON.stringify(TEMPLATE_FILES) === JSON.stringify(['note1.txt', 'todo-a.md', 'calc-result.txt', 'w2-note.txt', 'w2-draw.png']));

  // 假 PASS 防线逐任务
  eq('D7 T2 播种前 full-report.md 必须缺席', task('full-seed-report').absent, ['full-report.md']);
  eq('D8 T10 form.html 必须缺席', task('full-form-html-author').absent, ['form.html']);
  eq('D9 T14 full-drag-dst 目录必须缺席 + drag-me@root 在场', [task('full-drag-file-move').absentDirs, task('full-drag-file-move').seed['drag-me.txt']], [[ 'full-drag-dst' ], 'DRAG']);
  eq('D10 T16 calc-elem.txt 必须缺席', task('full-calc-element').absent, ['calc-elem.txt']);
  eq('D11 T19 trash-me@root 必须在场(fileAbsent 防假 PASS)', task('full-approval-delete-file').seed['trash-me.txt'], 'TRASH');
  eq('D12 T20 macro-proof.txt 必须缺席', task('full-macro-record-replay').absent, ['macro-proof.txt']);
  eq('D13 T22 auto-goal.txt 必须缺席', task('full-autonomous-goal').absent, ['auto-goal.txt']);
  eq('D14 T23 orch-proof.txt 必须缺席', task('full-orchestration-file').absent, ['orch-proof.txt']);
  eq('D15 T3 假物料 drag/trash 必须缺席', task('full-seed-extras').absent, ['drag-me.txt', 'trash-me.txt']);

  // reseed 内容与 verify 谓词逐字对齐
  const R = SEED_CONTENTS.REPORT, RU = SEED_CONTENTS.REPORT_UNDO, RE = SEED_CONTENTS.REPORT_EDITED;
  ok('D16 REPORT 含首尾锚(7 行)', R.includes('FULL-BATTERY-ANCHOR') && /\bROW-1\b/.test(R) && /\bROW-6\b/.test(R) && R.includes('ROW-2\r\nROW-3') && !R.includes('ROW-2-EDITED'));
  ok('D17 REPORT_UNDO = REPORT + HOTKEY 追加', RU.startsWith(R.slice(0, -2)) && RU.includes('HOTKEY-VERIFIED-OK') && !RU.includes('UNDO-PROBE-TMP'));
  ok('D18 REPORT_EDITED 第 3 行已替换且首尾完好', RE.includes('ROW-2-EDITED-FULL\r\n') && !/\bROW-2\r\n/.test(RE) && RE.includes('FULL-BATTERY-ANCHOR') && /\bROW-6\b/.test(RE) && !RE.includes('SCROLL-LL040'));
  ok('D19 T9(T8 后)播种 EDITED', task('full-scroll-deep').seed['full-report.md'] === 'REPORT_EDITED');
  ok('D20 T8 播种 UNDO 版(T7 后语境)', task('full-edit-precision').seed['full-report.md'] === 'REPORT_UNDO');
  const F = SEED_CONTENTS.FORM_HTML;
  ok('D21 FORM_HTML 三锚点齐', F.includes('Full-Battery-Form') && F.includes('FORM-CODE-8899') && F.includes('checkbox'));
  eq('D22 T21 purity 双脏标记禁入', task('full-skill-lifecycle').purity.map((p) => p.notContains).sort(), ['SCENE-BREAK-XYZ', 'SKILL-FULL-MARK'].sort());
  ok('D23 DRAG/TRASH 内容逐字', SEED_CONTENTS.DRAG === 'drag-me-content-123' && SEED_CONTENTS.TRASH === 'trash-me-content-456');
  const standalone = TASK_MATRIX.filter((t) => t.standalone).map((t) => t.id);
  eq('D24 standalone(文件面可单任务复跑)清单', standalone, ['full-setup-clean', 'full-seed-report', 'full-open-url-nav', 'full-drag-file-move', 'full-approval-delete-file', 'full-autonomous-goal', 'full-cognition-whatif', 'full-observability-panel', 'full-final-cleanup']);
  ok('D25 standalone ⇔ 无 req=true 链 app', TASK_MATRIX.every((t) => t.standalone === !t.apps.some((a) => a.req)));
  ok('D26 未知任务返回 null', getTaskState('no-such-task') === null);
}

// ── D. planReset 幂等性 ──────────────────────────────────────────────────
{
  const dirty = ['full-report.md', 'drag-me.txt', 'trash-me.txt', 'form.html', 'full-drag-dst\\', 'dsh-made\\', 'note1.txt', 'calc-elem.txt', 'auto-goal.txt', '.gitignore'];
  const clean = [...TEMPLATE_FILES];
  const st = task('full-drag-file-move');
  const p1 = planReset(dirty, st.seed), p2 = planReset(clean, st.seed), p3 = planReset([], st.seed);
  eq('E1 点锚永不入删除集', p1.kept, ['.gitignore']);
  ok('E2 残留全入删除集(含模板——随后重写)', ['full-report.md', 'full-drag-dst\\', 'dsh-made\\', 'calc-elem.txt', 'auto-goal.txt'].every((x) => p1.removals.includes(x)));
  const W = (p) => [...p.writes].sort();
  eq('E3 写集与当前态无关(幂等构造) dirty==clean', W(p1), W(p2));
  eq('E4 写集与当前态无关 clean==空场', W(p2), W(p3));
  eq('E5 写集 = 模板 + 矩阵 seed', W(p2), [...TEMPLATE_FILES, 'full-report.md', 'form.html', 'drag-me.txt'].sort());
  ok('E6 连续两次复位终态相等(写集固定点)', JSON.stringify(W(planReset(W(p1), st.seed))) === JSON.stringify(W(p1)));
  const p0 = planReset(dirty, {});
  eq('E7 --all 冷复位写集 = 模板树', W(p0), [...TEMPLATE_FILES].sort());
  ok('E8 删除集中无点锚', p0.removals.every((r) => !r.split('\\').pop().startsWith('.')));
}

// ── E. 窗口签名 + 进程白名单 ────────────────────────────────────────────
{
  const hit = ['full-report.md - 记事本', '*full-report.md - 记事本', 'playground', 'full-drag-dst - 文件资源管理器', 'Full-Battery-Form 和另外 2 个标签页 - Microsoft Edge', 'w2-draw.png - 画图', 'trash-me.txt - 记事本', 'form.html - 记事本'];
  const miss = ['会议纪要.txt - 记事本', 'Microsoft Edge', '计算器', '设置', '任务管理器', 'README - Notepad', 'play - 记事本'];
  ok('F1 签名命中全部 playground 特征标题', hit.every((t) => WINDOW_SIGNATURE.test(t)));
  ok('F2 签名不误伤用户窗口', miss.every((t) => !WINDOW_SIGNATURE.test(t)));
  eq('F3 explorer 只 wmclose 绝不杀进程', PROCESS_RULES['explorer.exe'].method, 'wmclose');
  eq('F4 msedge 只 wmclose 绝不杀进程', PROCESS_RULES['msedge.exe'].method, 'wmclose');
  ok('F5 白名单恰 4 进程,计算器不在内', Object.keys(PROCESS_RULES).sort().join() === 'explorer.exe,msedge.exe,mspaint.exe,notepad.exe' && !('CalculatorApp.exe' in PROCESS_RULES));
  const wins = [
    { pid: 101, process: 'notepad.exe', hwnd: 1, title: 'full-report.md - 记事本' },
    { pid: 202, process: 'notepad.exe', hwnd: 2, title: '会议纪要.txt - 记事本' },
    { pid: 303, process: 'explorer.exe', hwnd: 304, title: 'playground' },
    { pid: 404, process: 'explorer.exe', hwnd: 405, title: '下载' },
    { pid: 505, process: 'msedge.exe', hwnd: 506, title: 'Full-Battery-Form - Microsoft Edge' },
    { pid: 606, process: 'CalculatorApp.exe', hwnd: 607, title: '计算器' },
    { pid: 707, process: 'OUTLOOK.EXE', hwnd: 708, title: 'playground 邮件归档' },
  ];
  const acts = classifyWindows(wins);
  eq('F6 仅 3 窗命中双门槛(进程白名单∧标题特征)', acts.map((a) => a.pid).sort(), [101, 303, 505]);
  eq('F7 notepad 命中→taskkill', acts.find((a) => a.pid === 101).action, 'taskkill');
  eq('F8 explorer 命中→wmclose', acts.find((a) => a.pid === 303).action, 'wmclose');
  eq('F9 用户记事本(标题无特征)跳过', acts.find((a) => a.pid === 202), undefined);
  eq('F10 白名单外进程(OUTLOOK)即使标题含词也跳过', acts.find((a) => a.pid === 707), undefined);
  eq('F11 wmclose 无 hwnd 降级为 skip', classifyWindows([{ pid: 9, process: 'msedge.exe', hwnd: 0, title: 'playground' }])[0].action, 'skip');
  ok('F12 classifyWindows 为纯函数(不触世界)', Array.isArray(classifyWindows([])) && classifyWindows([]).length === 0);
  // 回归:Get-Process 的 ProcessName 无 .exe 后缀(实测 "Notepad"),大小写混合也必须命中
  const suffixless = classifyWindows([{ pid: 11, process: 'Notepad', hwnd: 12, title: 'full-report.md - 记事本' }, { pid: 21, process: 'msedge', hwnd: 22, title: 'playground 预览页' }]);
  eq('F13 无后缀/混合大小写进程名仍命中白名单', suffixless.map((a) => a.action), ['taskkill', 'wmclose']);
  ok('F14 无后缀进程名在白名单外仍跳过', classifyWindows([{ pid: 31, process: 'OUTLOOK', hwnd: 32, title: 'playground 邮件' }]).length === 0);
}

// ── 汇总 ────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`FAIL ${failures.length}/${n}:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`playground-reset.selftest: ${n} 断言全过 (矩阵 ${TASK_MATRIX.length} 任务 | 模板 ${TEMPLATE_FILES.length} | standalone ${TASK_MATRIX.filter((t) => t.standalone).length})`);
