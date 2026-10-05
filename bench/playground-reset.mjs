#!/usr/bin/env node
// bench/playground-reset.mjs — R2-7 playground 播种/复位器
//
// 目标:保证 suite-full 26 任务每个都从**确定性初始状态**开始(可重复实战的前提)。
// 三个作用面:
//   文件面 —— 清空 playground → 重建 R1-2 模板树 + 该任务的确定性 reseed(前驱落盘产物直写);
//             点锚(.gitignore 类)保留;results/ 与 README 在场外,天然不碰。
//   进程面 —— 白名单制:只关「进程名在白名单 ∧ 窗口标题含 playground 特征」的窗口。
//             explorer/msedge 只 PostMessage WM_CLOSE(绝不杀壳/浏览器进程);
//             notepad/mspaint 按 PID taskkill(保存对话框会模态阻塞,等价 prompt 的"不保存")。
//   布局面 —— 可选 --minimize-all:Shell.Application MinimizeAll(默认关)。
//
// 安全律(硬约束,违反即 exit 2):
//   S1 只在 playground 内操作:叶目录必须名为 playground,父目录必须名为 test-runs,
//      绝对路径、无 ..、非系统区;每个删除/写入目标再做 isInside 前缀复核。
//   S2 永不删除 playground 目录本身,只清其子项;点文件(.开头)一律保留。
//   S3 进程白名单制 + 窗口标题特征双门槛;计算器等无 playground 特征标题的应用一概不碰
//      (那是 suite 自己的 full-setup-clean/full-final-cleanup 任务的事)。
//
// 用法:
//   node bench/playground-reset.mjs --list [--json]                # 状态矩阵
//   node bench/playground-reset.mjs --task <id> [--dry-run] [--minimize-all] [--json]
//   node bench/playground-reset.mjs --all     [--dry-run] [--minimize-all] [--json]  # 整轮冷复位(S0)
//   node bench/playground-reset.mjs --check <id> [--strict-chain] [--json]           # 只读预检
// 路径解析(与 bench/config.mjs 同名变量同优先级):--playground > DSH_BENCH_PLAYGROUND
//   > DSH_BENCH_TEST_RUNS\playground > 缺省 C:\dsh3\test-runs\playground(本机 R1-2 部署值)。
// 退出码:0 成功/无发现;1 check 发现世界与矩阵不符(或复位后置校验失败);2 安全律拒绝;3 用法错误。
// 幂等:清空+重建模型,连跑 N 次终态恒同;实测 <2s。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// ───────────────────────── 纯核心(供 selftest 导入) ─────────────────────────

// R1-2 模板树:5 个 0 字节保存目标(空内容不满足任何 verify 谓词)。dsh-made 故意不预置。
export const TEMPLATE_FILES = ['note1.txt', 'todo-a.md', 'calc-result.txt', 'w2-note.txt', 'w2-draw.png'];

// 确定性 reseed 内容(与 suite-full 各任务 verify 谓词逐字对齐)
const L = (lines) => lines.join('\r\n') + '\r\n'; // 记事本 ctrl+s 落盘形态
export const SEED_CONTENTS = {
  // T2 产物:7 行主锚
  REPORT: L(['FULL-BATTERY-ANCHOR', 'ROW-1', 'ROW-2', 'ROW-3', 'ROW-4', 'ROW-5', 'ROW-6']),
  // T7 产物:错字已撤销、HOTKEY-VERIFIED-OK 已追加保存
  REPORT_UNDO: L(['FULL-BATTERY-ANCHOR', 'ROW-1', 'ROW-2', 'ROW-3', 'ROW-4', 'ROW-5', 'ROW-6', 'HOTKEY-VERIFIED-OK']),
  // T8 产物:第 3 行整行替换(此后的链上基线)
  REPORT_EDITED: L(['FULL-BATTERY-ANCHOR', 'ROW-1', 'ROW-2-EDITED-FULL', 'ROW-3', 'ROW-4', 'ROW-5', 'ROW-6', 'HOTKEY-VERIFIED-OK']),
  // T10 产物:表单页(后续浏览器任务物料,prompt 原样 HTML)
  FORM_HTML: `<html><head><title>Full-Battery-Form</title></head><body><h1>Full-Battery-Form</h1><label><input type="checkbox" id="c1">Option-A</label><br><input id="name" placeholder="YourName"><br><button onclick="document.getElementById('out').textContent='FORM-CODE-8899'">Submit</button><p id="out"></p></body></html>`,
  // T3 产物:拖拽物料 / 审批删除物料
  DRAG: 'drag-me-content-123',
  TRASH: 'trash-me-content-456',
};

// ── 状态矩阵:每任务确定性前置(文件面 reseed / 假 PASS 防线 / 链上 app 面) ──
// seed: 复位后 playground 内除模板外的确定性文件(relPath -> SEED_CONTENTS key)
// absent / absentDirs: 假 PASS 防线——残留即允许 agent 不动手也 PASS,必须清掉
// purity: 复位后文件必须**不含**的标记(canonical reseed 天然保证;--check 复核)
// apps: 链上 app 面前置(req=true 为 verify/prompt 硬依赖;复位器只清不种,单任务复跑不可代播)
// standalone: 文件面可完全确定性单任务复跑(apps 无 req=true)
const NP = 'full-report|记事本|Notepad';   // suite 自带的记事本窗口域正则
const EX = 'playground|文件资源管理器|File Explorer';
export const TASK_MATRIX = [
  { id: 'full-setup-clean', order: 1, cat: 'setup', seed: {}, absent: [], absentDirs: [], purity: [], apps: [], standalone: true,
    note: '开场清理任务自关残留窗;S0 pristine 即标准前置' },
  { id: 'full-seed-report', order: 2, cat: 'real', seed: {}, absent: ['full-report.md'], absentDirs: [], purity: [], apps: [], standalone: true,
    note: '残留旧 full-report.md 含 ANCHOR ⇒ 不动手也 PASS,必须清;notepad 残窗由复位器按标题特征关闭' },
  { id: 'full-seed-extras', order: 3, cat: 'real', seed: { 'full-report.md': 'REPORT' }, absent: ['drag-me.txt', 'trash-me.txt'], absentDirs: [], purity: [], apps: [{ p: 'notepad.exe', re: NP, req: true }], standalone: false,
    note: 'verify windowCount(记事本域)=1 ⇒ 前驱须恰留 1 个 full-report 记事本;假物料 drag/trash 清掉防混淆' },
  { id: 'full-ocr-locate', order: 4, cat: 'ocr', seed: { 'full-report.md': 'REPORT' }, absent: [], absentDirs: [], purity: [], apps: [{ p: 'notepad.exe', re: NP, req: true }], standalone: false,
    note: '记事本须在场且可 switch 到前台' },
  { id: 'full-zoom-tray', order: 5, cat: 'zoom', seed: { 'full-report.md': 'REPORT' }, absent: [], absentDirs: [], purity: [], apps: [{ p: 'notepad.exe', re: NP, req: true }], standalone: false,
    note: 'zoom 目标含记事本小 UI 元素' },
  { id: 'full-probe-interactivity', order: 6, cat: 'probe', seed: { 'full-report.md': 'REPORT' }, absent: [], absentDirs: [], purity: [], apps: [{ p: 'notepad.exe', re: NP, req: true }], standalone: false,
    note: '探针对象是打开中的记事本' },
  { id: 'full-hotkey-undo-save', order: 7, cat: 'hotkey', seed: { 'full-report.md': 'REPORT' }, absent: [], absentDirs: [], purity: [{ path: 'full-report.md', notContains: 'UNDO-PROBE-TMP' }], apps: [{ p: 'notepad.exe', re: NP, req: true }], standalone: false,
    note: 'verify not(UNDO-PROBE-TMP 落盘):canonical reseed 双保险(前一轮若撤销失败落了错字,复位即洗净)' },
  { id: 'full-edit-precision', order: 8, cat: 'real', seed: { 'full-report.md': 'REPORT_UNDO' }, absent: [], absentDirs: [], purity: [], apps: [{ p: 'notepad.exe', re: NP, req: true }], standalone: false,
    note: '第 3 行须是 ROW-2(T7 后语境 = REPORT_UNDO)' },
  { id: 'full-scroll-deep', order: 9, cat: 'scroll', seed: { 'full-report.md': 'REPORT_EDITED' }, absent: [], absentDirs: [], purity: [{ path: 'full-report.md', notContains: 'SCROLL-LL040' }], apps: [{ p: 'notepad.exe', re: NP, req: true }], standalone: false,
    note: 'verify contains ROW-2-EDITED-FULL ∧ not SCROLL-LL040:T8 前产物直写' },
  { id: 'full-form-html-author', order: 10, cat: 'real', seed: { 'full-report.md': 'REPORT_EDITED' }, absent: ['form.html'], absentDirs: [], purity: [], apps: [{ p: 'notepad.exe', re: NP, req: true }], standalone: false,
    note: '残留 form.html 含三锚点 ⇒ 假 PASS,必须清;终态 windowCount(记事本)=1' },
  { id: 'full-edge-open-form', order: 11, cat: 'browser', seed: { 'full-report.md': 'REPORT_EDITED', 'form.html': 'FORM_HTML' }, absent: [], absentDirs: [], purity: [], apps: [{ p: 'notepad.exe', re: NP, req: true }], standalone: false,
    note: 'form.html 三锚点(Full-Battery-Form/FORM-CODE-8899/checkbox)直写;Edge 须为默认浏览器;残留 playground 标题 Edge 窗复位器会关' },
  { id: 'full-open-url-nav', order: 12, cat: 'browser', seed: { 'full-report.md': 'REPORT_EDITED', 'form.html': 'FORM_HTML' }, absent: [], absentDirs: [], purity: [], apps: [{ p: 'msedge.exe', re: 'Edge', req: false }], standalone: true,
    note: 'open_url 自开浏览器,文件面无硬前置(链上语境 Edge 在场更好)' },
  { id: 'full-ask-screen', order: 13, cat: 'vision', seed: { 'full-report.md': 'REPORT_EDITED', 'form.html': 'FORM_HTML' }, absent: [], absentDirs: [], purity: [], apps: [{ p: 'notepad.exe', re: NP, req: true }, { p: 'msedge.exe', re: 'Edge', req: true }, { p: 'explorer.exe', re: EX, req: true }], standalone: false,
    note: 'prompt 语境"当前桌面开着三窗";verify absent,app 面是任务语义前提' },
  { id: 'full-drag-file-move', order: 14, cat: 'drag', seed: { 'full-report.md': 'REPORT_EDITED', 'form.html': 'FORM_HTML', 'drag-me.txt': 'DRAG' }, absent: [], absentDirs: ['full-drag-dst'], purity: [], apps: [{ p: 'explorer.exe', re: EX, req: false }], standalone: true,
    note: '假 PASS 防线:full-drag-dst\\drag-me.txt 残留 ⇒ 不动手也 PASS,dir 必须不存在;drag-me.txt@root 直写(prompt 自愈只是兜底)' },
  { id: 'full-triple-window-switch', order: 15, cat: 'window', seed: { 'full-report.md': 'REPORT_EDITED' }, absent: [], absentDirs: [], purity: [], apps: [{ p: 'notepad.exe', re: NP, req: true }, { p: 'msedge.exe', re: 'Edge', req: true }, { p: 'explorer.exe', re: EX, req: true }], standalone: false,
    note: 'verify 三窗进程+窗口双证据:三窗都必须在场(链产物)' },
  { id: 'full-calc-element', order: 16, cat: 'element', seed: { 'full-report.md': 'REPORT_EDITED' }, absent: ['calc-elem.txt'], absentDirs: [], purity: [], apps: [{ p: 'notepad.exe', re: NP, req: true }], standalone: false,
    note: '残留 calc-elem.txt 含 144 ⇒ 假 PASS;计算器由任务自开(标题无 playground 特征,复位器不碰);终态 windowCount(记事本)=1' },
  { id: 'full-diff-action-locate', order: 17, cat: 'diff', seed: { 'full-report.md': 'REPORT_EDITED' }, absent: [], absentDirs: [], purity: [], apps: [{ p: 'CalculatorApp.exe', re: '计算器|Calculator', req: true }], standalone: false,
    note: '计算器打开中(T16 链产物;进程名跨方言任一:CalculatorApp/Calculator/calc)' },
  { id: 'full-memory-landmark', order: 18, cat: 'memory', seed: { 'full-report.md': 'REPORT_EDITED' }, absent: [], absentDirs: [], purity: [], apps: [{ p: 'CalculatorApp.exe', re: '计算器|Calculator', req: true }], standalone: false,
    note: '同 T17' },
  { id: 'full-approval-delete-file', order: 19, cat: 'approval', seed: { 'full-report.md': 'REPORT_EDITED', 'trash-me.txt': 'TRASH' }, absent: [], absentDirs: [], purity: [], apps: [{ p: 'explorer.exe', re: EX, req: false }], standalone: true,
    note: 'verify fileAbsent(trash-me):残留"已删"状态 ⇒ 不动手也 PASS,必须**在场**播种(prompt 自愈只是兜底);严禁预放进回收站' },
  { id: 'full-macro-record-replay', order: 20, cat: 'macro', seed: { 'full-report.md': 'REPORT_EDITED' }, absent: ['macro-proof.txt'], absentDirs: [], purity: [], apps: [{ p: 'notepad.exe', re: NP, req: true }], standalone: false,
    note: '残留 macro-proof.txt 含 MACRO-ROUND-ONE ⇒ 假 PASS;verify windowCount(记事本)=1' },
  { id: 'full-skill-lifecycle', order: 21, cat: 'skill', seed: { 'full-report.md': 'REPORT_EDITED' }, absent: [], absentDirs: [], purity: [{ path: 'full-report.md', notContains: 'SCENE-BREAK-XYZ' }, { path: 'full-report.md', notContains: 'SKILL-FULL-MARK' }], apps: [{ p: 'notepad.exe', re: NP, req: true }], standalone: false,
    note: 'verify 双 not(脏标记落盘):canonical reseed 把上一轮污染洗净' },
  { id: 'full-autonomous-goal', order: 22, cat: 'autonomy', seed: { 'full-report.md': 'REPORT_EDITED' }, absent: ['auto-goal.txt'], absentDirs: [], purity: [], apps: [], standalone: true,
    note: '残留 auto-goal.txt ⇒ 自主环不动手也 PASS;verify 仅文件谓词' },
  { id: 'full-orchestration-file', order: 23, cat: 'orchestration', seed: { 'full-report.md': 'REPORT_EDITED' }, absent: ['orch-proof.txt'], absentDirs: [], purity: [], apps: [{ p: 'notepad.exe', re: NP, req: true }], standalone: false,
    note: '残留 orch-proof.txt ⇒ 假 PASS;verify processRunning notepad ⇒ full-report 记事本须在场' },
  { id: 'full-cognition-whatif', order: 24, cat: 'cognition', seed: { 'full-report.md': 'REPORT_EDITED' }, absent: [], absentDirs: [], purity: [], apps: [], standalone: true,
    note: '纯只读问答;journal 轨迹语境在链上' },
  { id: 'full-observability-panel', order: 25, cat: 'observability', seed: { 'full-report.md': 'REPORT_EDITED' }, absent: [], absentDirs: [], purity: [], apps: [], standalone: true,
    note: '只读面板巡检,文件面无硬前置' },
  { id: 'full-final-cleanup', order: 26, cat: 'setup', seed: {}, absent: [], absentDirs: [], purity: [], apps: [], standalone: true,
    note: '终局清理自带关窗;整轮结束用 --all 冷复位' },
];

// ── 路径解析(优先级同 bench/config.mjs)──
export function resolvePlayground({ env = process.env, cliPath } = {}) {
  const normWin = (p) => p.replace(/\//g, '\\').replace(/\\+$/, '');
  if (cliPath) return normWin(cliPath);
  if (env.DSH_BENCH_PLAYGROUND) return normWin(env.DSH_BENCH_PLAYGROUND);
  const root = normWin(env.DSH_BENCH_TEST_RUNS ?? 'C:\\dsh3\\test-runs');
  return `${root}\\playground`;
}

// ── 安全律 S1:playground 路径卫兵(纯函数)──
const FORBIDDEN_PREFIXES = ['c:\\windows\\', 'c:\\program files\\', 'c:\\program files (x86)\\', 'c:\\programdata\\'];
export function guardPlayground(p) {
  if (!p || typeof p !== 'string') return { ok: false, reason: '路径为空' };
  const norm = p.replace(/\//g, '\\');
  if (!/^[A-Za-z]:\\/.test(norm)) return { ok: false, reason: `必须是绝对 Windows 路径(盘符:\\…),收到 "${p}"` };
  if (norm.includes('..')) return { ok: false, reason: '路径含 .. 段,拒绝' };
  const parts = norm.split('\\').filter(Boolean);
  if (parts.length < 3) return { ok: false, reason: `路径过浅:期望 <盘>\\…\\test-runs\\playground(≥3 段),收到 "${p}"` };
  const leaf = parts[parts.length - 1];
  if (leaf.toLowerCase() !== 'playground') return { ok: false, reason: `叶目录必须名为 playground,收到 "${leaf}"` };
  const parent = parts[parts.length - 2];
  if (parent.toLowerCase() !== 'test-runs') return { ok: false, reason: `父目录必须名为 test-runs,收到 "${parent}"` };
  const lower = (norm + '\\').toLowerCase();
  if (FORBIDDEN_PREFIXES.some((f) => lower.startsWith(f))) return { ok: false, reason: `系统禁区,拒绝:${norm}` };
  return { ok: true, reason: 'guard passed', norm };
}

// ── 安全律 S1/S2:child 是否严格位于 root 内(前缀 + 分隔符,防兄弟目录前缀攻击)──
export function isInside(child, root) {
  const c = child.replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');
  const r = root.replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');
  return c.startsWith(r + '\\');
}

// ── 文件面计划:清空非点项 → 重写模板 + seed(幂等:写集与当前态无关)──
export function planReset(currentEntries, seedFiles = {}) {
  const kept = currentEntries.filter((e) => e.split('\\').pop().startsWith('.'));
  const removals = currentEntries.filter((e) => !kept.includes(e));
  const writes = [...TEMPLATE_FILES, ...Object.keys(seedFiles)];
  return { removals, writes, kept };
}

// ── 进程面:白名单 + playground 窗口标题特征 ──
export const WINDOW_SIGNATURE = /playground|full-report|drag-me|trash-me|full-drag-dst|form\.html|full-battery-form|calc-elem|macro-proof|auto-goal|orch-proof|note1\.txt|todo-a|calc-result|w2-note|w2-draw/i;
export const PROCESS_RULES = {
  'notepad.exe': { method: 'taskkill', why: '保存对话框会模态阻塞;按 PID 强杀=丢弃脏缓冲,等价 prompt 的"不保存"' },
  'mspaint.exe': { method: 'taskkill', why: '同上(脏画布保存提示)' },
  'explorer.exe': { method: 'wmclose', why: '壳进程绝不可杀;只对命中窗口 PostMessage WM_CLOSE' },
  'msedge.exe': { method: 'wmclose', why: '浏览器进程承载用户全部标签;只关命中窗口' },
};
// 注:计算器(CalculatorApp/Calculator/calc)标题无 playground 特征且不在白名单——
// suite 的 full-setup-clean/full-final-cleanup 自己负责,复位器不越权。

// Get-Process 的 ProcessName 无 .exe 后缀(如 "Notepad"/"msedge"),统一补齐再查白名单
export const procName = (s) => { const x = String(s ?? '').toLowerCase(); return x.endsWith('.exe') ? x : `${x}.exe`; };

/** 对枚举到的窗口清单分类 → 动作列表(纯函数;不动世界) */
export function classifyWindows(windows) {
  const actions = [];
  for (const w of windows) {
    const rule = PROCESS_RULES[procName(w.process)];
    if (!rule) continue;                       // 白名单外一律跳过
    if (!WINDOW_SIGNATURE.test(w.title || '')) continue; // 标题无 playground 特征一律跳过
    if (rule.method === 'wmclose' && !Number(w.hwnd)) { actions.push({ ...w, action: 'skip', reason: '无 hwnd,无法安全关窗' }); continue; }
    actions.push({ ...w, action: rule.method, process: procName(w.process) });
  }
  return actions;
}

export function getTaskState(id) {
  const e = TASK_MATRIX.find((t) => t.id === id);
  if (!e) return null;
  return { ...e, seedResolved: Object.fromEntries(Object.entries(e.seed).map(([k, v]) => [k, SEED_CONTENTS[v]])) };
}

// ───────────────────────── 世界通道(仅 win32 实机;selftest 不触达) ─────────────────────────

function runPs(script, { timeoutMs = 15000 } = {}) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${script}`], { encoding: 'utf8', timeout: timeoutMs }).toString();
}

function enumerateWindows() {
  if (process.platform !== 'win32') return { windows: [], skipped: `platform=${process.platform}` };
  const out = runPs(`Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.Id,$_.ProcessName,$_.MainWindowHandle,$_.MainWindowTitle }`);
  const windows = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [pid, process, hwnd, ...titleParts] = l.split('|');
    return { pid: Number(pid), process, hwnd: Number(hwnd), title: titleParts.join('|') };
  });
  return { windows };
}

function applyCloses(actions) {
  const results = [];
  const wm = actions.filter((a) => a.action === 'wmclose');
  if (wm.length) {
    const sig = `[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);`;
    const posts = wm.map((a) => `[W.ResetU32]::PostMessage([IntPtr]${a.hwnd},0x0010,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null`).join(';');
    try {
      runPs(`$sig='${sig}'; Add-Type -MemberDefinition $sig -Name ResetU32 -Namespace W; ${posts}`);
      for (const a of wm) results.push({ ...a, result: 'wmclose posted' });
    } catch (e) { for (const a of wm) results.push({ ...a, result: `wmclose 失败:${String(e.message).slice(0, 120)}` }); }
  }
  for (const a of actions.filter((x) => x.action === 'taskkill')) {
    try {
      execFileSync('taskkill', ['/PID', String(a.pid), '/F'], { encoding: 'utf8', stdio: 'pipe', timeout: 15000 });
      results.push({ ...a, result: 'terminated' });
    } catch (e) {
      const msg = String(e.message || e);
      results.push({ ...a, result: /没有|not found|128/i.test(msg) ? '已不在(视为清理完成)' : `taskkill 失败:${msg.slice(0, 120)}` });
    }
  }
  for (const a of actions.filter((x) => x.action === 'skip')) results.push({ ...a, result: a.reason });
  return results;
}

function minimizeAll() {
  runPs(`(New-Object -ComObject Shell.Application).MinimizeAll()`);
}

// ───────────────────────── 文件面执行(带安全律复核) ─────────────────────────

function listEntries(pgAbs) {
  if (!fs.existsSync(pgAbs)) return [];
  return fs.readdirSync(pgAbs, { withFileTypes: true }).map((d) => (d.isDirectory() ? d.name + '\\' : d.name));
}

function applyFilePlan(pgAbs, plan, dryRun) {
  const done = { removed: [], written: [], kept: plan.kept };
  if (dryRun) return done;
  fs.mkdirSync(pgAbs, { recursive: true });
  for (const rel of plan.removals) {
    const isDir = rel.endsWith('\\');
    const abs = path.join(pgAbs, isDir ? rel.slice(0, -1) : rel);
    if (!isInside(abs, pgAbs)) throw new Error(`安全律拒绝:越界删除目标 ${abs}`);
    fs.rmSync(abs, { recursive: true, force: true });
    done.removed.push(rel);
  }
  return done;
}

function writeSeeds(pgAbs, seedResolved, dryRun) {
  const written = [];
  for (const rel of TEMPLATE_FILES) {
    const abs = path.join(pgAbs, rel);
    if (!isInside(abs, pgAbs)) throw new Error(`安全律拒绝:越界写入目标 ${abs}`);
    if (!dryRun) fs.writeFileSync(abs, '');
    written.push(rel);
  }
  for (const [rel, content] of Object.entries(seedResolved)) {
    const abs = path.join(pgAbs, rel);
    if (!isInside(abs, pgAbs)) throw new Error(`安全律拒绝:越界写入目标 ${abs}`);
    if (path.dirname(abs) !== pgAbs) fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (!dryRun) fs.writeFileSync(abs, content, 'utf8');
    written.push(rel);
  }
  return written;
}

// ───────────────────────── check(只读) ─────────────────────────

function checkState(pgAbs, st, windows) {
  const findings = [];
  for (const [rel, content] of Object.entries(st.seedResolved)) {
    const abs = path.join(pgAbs, rel);
    if (!fs.existsSync(abs)) findings.push({ level: 'fail', item: `seed 缺失:${rel}` });
    else if (fs.readFileSync(abs, 'utf8') !== content) findings.push({ level: 'fail', item: `seed 内容偏离 canonical:${rel}` });
  }
  for (const rel of st.absent) if (fs.existsSync(path.join(pgAbs, rel))) findings.push({ level: 'fail', item: `假 PASS 残留在场:${rel}` });
  for (const rel of st.absentDirs) if (fs.existsSync(path.join(pgAbs, rel))) findings.push({ level: 'fail', item: `假 PASS 残留目录在场:${rel}` });
  for (const p of st.purity) {
    const abs = path.join(pgAbs, p.path);
    if (fs.existsSync(abs) && fs.readFileSync(abs, 'utf8').includes(p.notContains)) findings.push({ level: 'fail', item: `脏标记残留:${p.path} 含 ${p.notContains}` });
  }
  for (const t of TEMPLATE_FILES) if (!fs.existsSync(path.join(pgAbs, t))) findings.push({ level: 'warn', item: `模板缺失:${t}` });
  const chainApps = st.apps.map((a) => {
    const re = new RegExp(a.re, 'i');
    const hit = windows.find((w) => procName(w.process) === a.p && re.test(w.title || ''))
      // 计算器进程名跨 Win10/Win11/旧版方言(names 任一在跑即在场的同款口径)
      ?? windows.find((w) => /^(calculatorapp|calculator|calc)(\.exe)?$/.test(String(w.process).toLowerCase()) && a.p === 'CalculatorApp.exe' && re.test(w.title || ''));
    return { process: a.p, titleRegex: a.re, required: a.req, present: Boolean(hit), title: hit?.title ?? null };
  });
  return { findings, chainApps };
}

// ───────────────────────── CLI ─────────────────────────

function usage() {
  return [
    '用法: node bench/playground-reset.mjs --list [--json]',
    '      node bench/playground-reset.mjs --task <id> [--dry-run] [--minimize-all] [--json]',
    '      node bench/playground-reset.mjs --all     [--dry-run] [--minimize-all] [--json]',
    '      node bench/playground-reset.mjs --check <id> [--strict-chain] [--json] [--dry-run]',
    '路径: --playground <p> > $DSH_BENCH_PLAYGROUND > $DSH_BENCH_TEST_RUNS\\playground > C:\\dsh3\\test-runs\\playground',
  ].join('\n');
}

function main(argv) {
  const t0 = Date.now();
  const opt = { mode: null, task: null, dryRun: false, minimizeAll: false, json: false, strictChain: false, pgOverride: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') opt.mode = 'list';
    else if (a === '--all') opt.mode = 'all';
    else if (a === '--task') { opt.mode = 'task'; opt.task = argv[++i]; }
    else if (a === '--check') { opt.mode = 'check'; opt.task = argv[++i]; }
    else if (a === '--dry-run') opt.dryRun = true;
    else if (a === '--minimize-all') opt.minimizeAll = true;
    else if (a === '--strict-chain') opt.strictChain = true;
    else if (a === '--json') opt.json = true;
    else if (a === '--playground') opt.pgOverride = argv[++i];
    else { console.error(`未知参数:${a}\n${usage()}`); process.exit(3); }
  }
  if (!opt.mode) { console.log(usage()); process.exit(0); }

  // 安全律 S1:路径卫兵
  const pg = resolvePlayground({ cliPath: opt.pgOverride });
  const guard = guardPlayground(pg);
  if (!guard.ok) { console.error(`[GUARD] 安全律拒绝:${guard.reason}(playground="${pg}")`); process.exit(2); }
  const pgAbs = guard.norm;

  const emit = (obj) => {
    if (opt.json) console.log(JSON.stringify({ tool: 'playground-reset', playground: pgAbs, durationMs: Date.now() - t0, ...obj }, null, 2));
  };

  if (opt.mode === 'list') {
    if (opt.json) { console.log(JSON.stringify({ tool: 'playground-reset', playground: pgAbs, tasks: TASK_MATRIX }, null, 2)); process.exit(0); }
    for (const t of TASK_MATRIX) {
      const seed = Object.keys(t.seed).join(',') || '(模板树)';
      const absent = [...t.absent, ...t.absentDirs.map((d) => `${d}\\`)].join(',') || '-';
      const apps = t.apps.map((a) => `${a.p}${a.req ? '' : '?'}`).join(',') || '-';
      console.log(`${String(t.order).padStart(2)} ${t.id.padEnd(28)} seed=[${seed}] absent=[${absent}] apps=[${apps}] ${t.standalone ? 'standalone' : 'chain'}`);
    }
    process.exit(0);
  }

  const st = opt.mode === 'all'
    ? { id: '(all/S0 冷复位)', seedResolved: {}, absent: [], absentDirs: [], purity: [], apps: [], standalone: true, note: '整轮冷复位:模板树 pristine' }
    : getTaskState(opt.task);
  if (!st) {
    console.error(`未知任务 id:"${opt.task}"。合法 id:\n${TASK_MATRIX.map((t) => `  ${t.id}`).join('\n')}`);
    process.exit(3);
  }

  if (opt.mode === 'check') {
    const { windows, skipped } = enumerateWindows();
    const { findings, chainApps } = checkState(pgAbs, st, windows);
    const fails = findings.filter((f) => f.level === 'fail');
    const chainMissing = chainApps.filter((a) => a.required && !a.present);
    const bad = fails.length > 0 || (opt.strictChain && chainMissing.length > 0);
    if (opt.json) emit({ mode: 'check', task: st.id, findings, chainApps, ok: !bad, windowsSkipped: skipped ?? null });
    else {
      console.log(`[CHECK] task=${st.id} playground=${pgAbs}`);
      for (const f of findings) console.log(`  ${f.level === 'fail' ? '✗' : '!'} ${f.item}`);
      for (const a of chainApps) console.log(`  app ${a.process}(${a.titleRegex}) ${a.present ? `在场:"${a.title}"` : '缺席'}${a.required ? '(链上必需)' : '(可选)'}`);
      console.log(bad ? '结论:世界与矩阵不符' : '结论:文件面符合矩阵');
    }
    process.exit(bad ? 1 : 0);
  }

  // ── reset(task|all) ──
  const report = { mode: opt.mode, task: st.id, dryRun: opt.dryRun, removed: [], written: [], kept: [], process: null, layout: { minimizeAll: opt.minimizeAll && !opt.dryRun ? 'done' : 'skipped' }, unmetChainPreconditions: [], ok: true };
  try {
    const current = listEntries(pgAbs);
    const plan = planReset(current, st.seedResolved);
    report.kept = plan.kept;
    const fileDone = applyFilePlan(pgAbs, plan, opt.dryRun);
    report.removed = opt.dryRun ? plan.removals : fileDone.removed; // 干跑报告"将删清单",不执行
    report.written = writeSeeds(pgAbs, st.seedResolved, opt.dryRun);
    // 进程面
    const { windows, skipped } = enumerateWindows();
    const actions = classifyWindows(windows);
    report.process = { scanned: windows.length, skippedPlatform: skipped ?? null, actions: opt.dryRun ? actions : applyCloses(actions), dryRunNotApplied: opt.dryRun };
    // 布局面
    if (opt.minimizeAll && !opt.dryRun) minimizeAll();
    // 后置校验(非干跑):终态=模板+seed,无残留
    if (!opt.dryRun) {
      const after = listEntries(pgAbs).filter((e) => !e.split('\\').pop().startsWith('.'));
      const expected = [...TEMPLATE_FILES, ...Object.keys(st.seedResolved)].sort();
      const actual = after.map((e) => (e.endsWith('\\') ? e.slice(0, -1) : e)).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        report.ok = false;
        report.postCheck = { expected, actual };
      }
    }
    // 链上 app 面(复位器只清不种):报告未满足项供编排器决策
    report.unmetChainPreconditions = st.apps.filter((a) => a.req).map((a) => ({ kind: 'app', process: a.p, titleRegex: a.re, why: '复位器不代开 GUI 应用;须由链上前驱任务或顺序整跑提供' }));
  } catch (e) {
    if (opt.json) emit({ ...report, ok: false, error: String(e.message || e) });
    else console.error(`[RESET] 失败:${e.message}`);
    process.exit(e.message?.startsWith('安全律拒绝') ? 2 : 1);
  }
  if (opt.json) emit(report);
  else {
    console.log(`[RESET] task=${st.id} dryRun=${opt.dryRun} playground=${pgAbs} (${Date.now() - t0}ms)`);
    console.log(`  移除 ${report.removed.length} 项 | 写入 ${report.written.length} 项 | 保留点锚 [${report.kept.join(', ')}]`);
    const p = report.process;
    console.log(`  进程面:扫描 ${p.scanned} 窗口,命中 ${p.actions.length}${opt.dryRun ? '(干跑未执行)' : ''}${p.actions.map((a) => ` ${a.process}#${a.pid}"${a.title}"→${a.action === 'skip' ? a.result : a.action}`).join(';')}`);
    if (report.unmetChainPreconditions.length) console.log(`  链上 app 面未满足(须前驱提供):${report.unmetChainPreconditions.map((u) => u.process).join(', ')}`);
    console.log(report.ok ? '  结果:OK(幂等终态 = 模板树 + 矩阵 seed)' : '  结果:后置校验不符!');
  }
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
