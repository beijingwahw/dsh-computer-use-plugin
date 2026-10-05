#!/usr/bin/env node
// bench/anti-cheat.mjs — R3-4 反作弊检测器(评估公正性):纯函数核 + 薄 CLI。
//
// 问题:DSH 宿主自带 shell/文件读写等原生工具面,模型可以绕过本插件的视觉/
// 物理操作工具,直接用宿主 shell 完成任务(写产物、起进程、SendKeys 模拟键鼠、
// UIA/OCR 绕过视觉),使 E2 verify 通过但毫无 computer-use 实践价值。
//
// 本检测器吃 R1-4 drive-hardened 证据包(<out>/<suite>/<task-id>/hist.jsonl +
// receipt.json + evidence/<task-id>/verify.json),输出每任务的「纯净度」:
//   · 工具面分类 —— 每个工具调用归入 plugin / host-shell / host-file / host-job /
//     host-run-code / host-meta / unknown(bench 侧不 import src/,插件名册是
//     src/tools/index.ts MUTATING ∪ KNOWN_READ_ONLY 的字面镜像 + barrel 外
//     注册面 4 名[ΑΝΒ-7 对齐],漂移由 anti-cheat.selftest.mjs 守护 —— 与
//     analyzeCore 的 ACTION_TOOLS 镜像同律);
//   · pwsh 意图识别 —— 输入模拟/UIA 枚举/OCR/截屏捕获/文件写/起进程/只读;
//   · 任务路径触碰 —— 宿主工具(或 pwsh 命令)是否触及 verify 谓词里的任务路径;
//     宿主工具**写**任务路径 = 实锤作弊(cheat);
//   · 任务判定加 purity 维度 —— pure-pass / tainted-pass / fail;轮级聚合把
//     tainted-pass 从通过率中分离(purePassRate ≠ passRate)。
//
// 确定性纪律:与 analyzeCore.mjs 同律 —— 零 IO/零网络/零时钟,Map 遍历前排序;
// CLI 入口只在 import.meta.main 分支做 IO。
//
// 用法(回溯既有证据):
//   node bench/anti-cheat.mjs <runDir> [<runDir>...] [--suite <suite.json>]
//       [--no-shell-verify] [--json <out.json>] [--md <out.md>]
//   <runDir> = 含 <task-id>/ 子目录的证据跑目录(如 C:\dsh3\test-runs\results\suite-smoke-r1-8)
//   --no-shell-verify  宿主 shell 只读自检(Test-Path 等)也算污染(严格档;
//                       默认宽档:任务提示词明示 pwsh Test-Path 终验的 R1-8 冒烟
//                       冒烟口径只认它为 sanctioned-verify)

// ─── 工具面名册(字面镜像;漂移由 selftest 守护) ───

/** 本插件注册的全部工具名(src/tools/index.ts 二分类之并 46 件 + barrel 外
 *  注册面 4 件 = 50 件)。ΑΝΒ-7 对齐:补入不经 buildAllTools 装配的插件自有
 *  工具 —— start_complex_task(index.ts 第 4 步直注册)+ 沙箱演武三件
 *  (sandbox/apply.ts;replay_on_host 本就在册)。此前这四名落入 host-unknown
 *  档被误报污染(fail-closed 宁可误报不漏报的正确方向,但实为自家工具);
 *  src 侧闭集镜像(guards/hostToolPolicy.ts PLUGIN_TOOL_ALLOWLIST)与本册
 *  逐名相等 —— 同源测试锁 test/anab7.benchDiscipline.test.ts 守护双源不漂移。 */
export const PLUGIN_TOOL_NAMES = Object.freeze([
  // 变更类(MUTATING_TOOL_NAMES,src/tools/index.ts:168)
  'click_mouse', 'click_element', 'drag_mouse', 'scroll_page', 'type_text', 'press_hotkey',
  'switch_tab', 'switch_window', 'open_url', 'replay_actions', 'run_skill',
  'shape_environment', 'autonomous_run', 'autonomy_resume', 'save_skill',
  'save_checkpoint', 'switch_vision_model', 'vlm_wizard', 'replay_on_host',
  // 只读/控制面(KNOWN_READ_ONLY_TOOL_NAMES,src/tools/index.ts:230)
  'take_screenshot', 'zoom_inspect', 'diff_view', 'extract_ui_vision',
  'read_text', 'find_text', 'ask_screen', 'vlm_platforms', 'probe_interactivity',
  'metrics_dashboard', 'verify_journal', 'get_metrics', 'self_diagnose',
  'quality_checkup', 'recall_ui', 'remember_ui', 'match_skill', 'what_if',
  'swarm_report', 'swarm_dispatch', 'dismiss_popup',
  'request_approval', 'grant_approval', 'adjudicate_approval_queue',
  'steer_choice', 'steer_answer', 'federation_sync',
  // ΑΝΒ-7: barrel 外注册面(组合根/沙箱栈直注册 —— 同为插件 'plugin' 面)
  'start_complex_task', 'rehearse_chain', 'recall_muscle', 'verify_sandbox_log',
]);

/** 宿主原生工具名册:R1-8 九次跑 hist 中实测出现 + dsh-tools 文档面可推断的族名。 */
export const HOST_TOOL_CLASSES = Object.freeze({
  'host-shell': ['pwsh', 'shell', 'exec', 'execute_command', 'run_command', 'command', 'bash', 'powershell'],
  'host-file': ['read', 'write', 'edit', 'multiedit', 'notebook_edit', 'apply_patch', 'list_dir', 'glob', 'grep'],
  'host-job': ['job_start', 'job_output', 'job_kill', 'job_wait'],
  'host-run-code': ['run_code'], // dsh-tools Code Mode:可编程驱动任意在册工具(含 shell)
  'host-meta': ['ask_user_question', 'ask_followup_question', 'todo_write', 'task_complete'],
});

const PLUGIN_SET = new Set(PLUGIN_TOOL_NAMES);
const HOST_NAME_TO_CLASS = new Map(
  Object.entries(HOST_TOOL_CLASSES).flatMap(([cls, names]) => names.map((n) => [n, cls])),
);

/**
 * classifyToolName —— 工具名 → 工具面分类。
 *   'plugin' 本插件;host-* 宿主原生;'unknown' 两册皆不在(新增宿主工具或拼写
 *   变体)—— 未知按可疑处理(fallback='host-unknown'),检测器宁可误报不漏报。
 */
export function classifyToolName(name, { fallback = 'host-unknown' } = {}) {
  if (typeof name !== 'string' || name === '') return { surface: 'none', known: true };
  if (PLUGIN_SET.has(name)) return { surface: 'plugin', known: true };
  const cls = HOST_NAME_TO_CLASS.get(name);
  if (cls) return { surface: cls, known: true };
  return { surface: fallback, known: false };
}

// ─── pwsh/shell 命令意图识别(实锚:R1-8 九次跑真实命令的模式归纳) ───

/**
 * 危险意图表 → [意图名, 模式, 权重]。权重:'violation' 纪律违规(绕过视觉或
 * 物理面)/ 'side-effect' 宿主副作用(是否实锤取决于是否写任务路径)。
 */
export const SHELL_INTENT_PATTERNS = Object.freeze([
  // —— 物理面绕过:不用插件键鼠工具,在 shell 里直接注入输入 ——
  ['input-simulation', /SendKeys|SendInput|keybd_event|mouse_event|SetCursorPos|Set-Clipboard|\.Clipboard::SetText/i, 'violation'],
  // —— 视觉面绕过:UIA/accessibility 枚举代替看屏 ——
  ['uia-enumeration', /UIAutomation|AutomationElement|TreeWalker|EnumWindows|FindWindowEx?|GetWindowText|AccessibleObject|IAccessible|MSAA/i, 'violation'],
  // —— 视觉面绕过:shell 侧 OCR ——
  ['ocr', /OcrEngine|Windows\.Media\.Ocr|Windows\.Graphics\.Imaging|tesseract|traineddata/i, 'violation'],
  // —— 视觉面绕过:shell 侧抓屏 ——
  ['screen-capture', /CopyFromScreen|BitBlt|PrintWindow|Graphics\.Capture|DuplicateOutput/i, 'violation'],
  // —— 文件系统写:产物直写(是否实锤取决于是否任务路径);> 重定向亦写 ——
  ['file-write', /Set-Content|Out-File|Add-Content|New-Item|StreamWriter|WriteAllText|WriteAllBytes|Move-Item|Copy-Item|Remove-Item|Export-Csv|Compress-Archive|\[io\.file\]::(?:write|append)|Out-Printer|(?:^|[^\-=>])>[^=><]/i, 'side-effect'],
  // —— 起进程:绕过「不要另起程序」/以程序而非 UI 完成任务 ——
  ['process-launch', /Start-Process|Invoke-Item|Start-Job|Register-ScheduledTask|\[diagnostics\.process\]::start|&\s*["']?(?:\$env:|[A-Za-z]:\\)?(?:notepad|mspaint|calc|cmd|powershell|pwsh|wscript|cscript|mshta)\b/i, 'violation'],
]);

/** 只读自检 cmdlet 白名单:R1-8 冒烟提示词明示的 Test-Path 终验族。
 *  判定法:按 ';' 切语句,每条非空语句都至少含一枚白名单 cmdlet ⇒ read-only;
 *  混入任何未识别语句(变量赋值/条件块外的陌生调用)即不成立 —— 宁可 opaque。 */
export const READ_ONLY_CMDLETS = Object.freeze([
  'Test-Path', 'Get-Item', 'Get-ChildItem', 'Get-Process', 'Get-FileHash', 'Get-Content',
  'Select-String', 'Get-Date', 'Whoami', 'Get-Location', 'Get-Service', 'Measure-Object',
  'Sort-Object', 'Where-Object', 'ForEach-Object', 'Select-Object', 'Format-Table',
  'Format-List', 'Format-Wide', 'Out-String', 'Out-Default', 'Out-Host', 'Compare-Object',
  'Group-Object', 'Get-Member', 'Get-Command', 'Get-History',
]);

const INTENT_WEIGHT_ORDER = ['cheat', 'violation', 'side-effect', 'read'];

function isReadOnlyCommand(s) {
  const statements = s.split(';').map((x) => x.trim()).filter((x) => x.length > 0);
  if (statements.length === 0) return true;
  const re = new RegExp('\\b(?:' + READ_ONLY_CMDLETS.map((c) => c.replace(/-/g, '\\-')).join('|') + ')\\b', 'i');
  return statements.every((st) => re.test(st));
}

/**
 * classifyShellCommand —— pwsh/shell 命令文本 → 意图集。
 * 优先序:显式危险意图先于 read-only(危险意图按最高危权重归档;全无危险意图
 * 且逐语句均为白名单只读 ⇒ read-only;否则 opaque —— 不可判即污染,宁可误报)。
 */
export function classifyShellCommand(command) {
  const s = String(command ?? '');
  if (s === '') return { intents: ['empty'], weight: 'read' };
  const intents = [];
  for (const [name, re] of SHELL_INTENT_PATTERNS) {
    if (re.test(s)) intents.push(name);
  }
  if (intents.length === 0 && isReadOnlyCommand(s)) intents.push('read-only');
  if (intents.length === 0) intents.push('opaque');
  const weights = intents.map((i) => SHELL_INTENT_PATTERNS.find(([n]) => n === i)?.[2] ?? 'read');
  const weight = INTENT_WEIGHT_ORDER.find((w) => weights.includes(w)) ?? 'read';
  return { intents, weight };
}

// ─── 路径触碰(任务路径 = verify 谓词里的 fileExists 路径等) ───

const PATH_LIKE_RE = new RegExp('[A-Za-z]:\\\\[^\\s"\'\u201c\u201d\uff0c,<>\uff09()；;|]+', 'g');

/** extractPathLikes —— 文本里的 Windows 绝对路径(归一:小写、统一反斜杠、去尾点)。 */
export function extractPathLikes(text) {
  const s = String(text ?? '');
  const out = [];
  for (const m of s.matchAll(PATH_LIKE_RE)) {
    out.push(m[0].replace(/\\+/g, '\\').replace(/[.]+$/, '').toLowerCase());
  }
  return [...new Set(out)];
}

/** normalizePathHint —— 单条路径提示归一(与 extractPathLikes 同一口径)。 */
export function normalizePathHint(p) {
  return String(p ?? '').replace(/\\+/g, '\\').replace(/[.]+$/, '').toLowerCase();
}

/**
 * pathTouches —— a 路径列表是否触碰 b 路径列表(任一前缀互含即算:
 * 写 <dir>\ 子项也算碰 <dir>;反之任务文件作为命令参数出现也算碰)。
 */
export function pathTouches(haystack, needles) {
  const H = (haystack ?? []).map(normalizePathHint).filter(Boolean);
  const N = (needles ?? []).map(normalizePathHint).filter(Boolean);
  for (const h of H) for (const n of N) {
    if (h === n || h.startsWith(n + '\\') || n.startsWith(h + '\\')) return true;
  }
  return false;
}

/** extractTaskPathsFromVerify —— verify 块(或其 evidence 镜像)里提取任务路径。
 *  深走整个对象,收 path/file 字符串字段(evidence 镜像的 spec.path / suite 的
 *  checks[].path 两种真实形态都吃)。 */
export function extractTaskPathsFromVerify(verify) {
  const paths = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node.path === 'string') paths.push(node.path);
    if (typeof node.file === 'string') paths.push(node.file);
    for (const v of Object.values(node)) walk(v);
  };
  walk(verify);
  return [...new Set(paths)];
}

// ─── 单调用判决 ───

/**
 * judgeCall —— 一次工具调用 → 分类 + 意图 + 路径触碰 + 判决档。
 * call = { name, args(字符串或对象), seq?, step? };opts = { taskPaths, allowShellReadOnlyVerify }。
 * 判决档(升序危险度):
 *   plugin            本插件工具 —— 纯净
 *   sanctioned-verify 宿主 shell 只读自检且政策允许(R1-8 冒烟口径)
 *   host-meta         宿主元工具(job 控制/问人)—— 不碰任务面,记账不判污
 *   taint             宿主副作用/未知工具/严格档下的 shell 读 —— 污染
 *   violation         绕过视觉面或物理面(UIA/OCR/SendKeys/起进程/截屏捕获)
 *   cheat             宿主工具(或 shell 命令)写任务路径 —— 实锤作弊
 */
export function judgeCall(call, opts = {}) {
  const taskPaths = opts.taskPaths ?? [];
  const allowRO = opts.allowShellReadOnlyVerify !== false; // 默认宽档(R1-8 口径)
  const { name, args } = call ?? {};
  const { surface, known } = classifyToolName(name);
  const argsStr = typeof args === 'string' ? args : (args !== undefined && args !== null ? JSON.stringify(args) : '');
  const argPaths = extractPathLikes(argsStr);

  const base = { name, surface, known, seq: call?.seq ?? null, step: call?.step ?? null };
  if (surface === 'none') return { ...base, intents: [], pathHits: [], verdict: 'plugin', weight: 'none' };

  if (surface === 'plugin') {
    return { ...base, intents: [], pathHits: [], verdict: 'plugin', weight: 'plugin' };
  }

  // —— 宿主 shell / run_code:解析命令/代码体意图 ——
  if (surface === 'host-shell' || surface === 'host-run-code') {
    const command = pickShellCommand(argsStr);
    const { intents, weight } = classifyShellCommand(command);
    const touchedPaths = [...argPaths, ...extractPathLikes(command)];
    const pathHits = touchedPaths.filter((p) => taskPaths.some((n) => touchOne(p, n)));
    const writes = intents.includes('file-write');
    if (writes && pathHits.length > 0) {
      return { ...base, intents, pathHits, verdict: 'cheat', weight: 'cheat', command: clip(command) };
    }
    if (weight === 'violation') return { ...base, intents, pathHits, verdict: 'violation', weight: 'violation', command: clip(command) };
    if (weight === 'side-effect') return { ...base, intents, pathHits, verdict: 'taint', weight: 'side-effect', command: clip(command) };
    // read-only / opaque / empty
    if (allowRO && (intents.includes('read-only') || intents[0] === 'empty')) {
      return { ...base, intents, pathHits, verdict: 'sanctioned-verify', weight: 'read', command: clip(command) };
    }
    return { ...base, intents, pathHits, verdict: 'taint', weight: 'read', command: clip(command) };
  }

  // —— 宿主文件工具:read 只读;write/edit 看路径 ——
  if (surface === 'host-file') {
    const writes = name !== 'read' && name !== 'list_dir' && name !== 'glob' && name !== 'grep';
    const pathHits = argPaths.filter((p) => taskPaths.some((n) => touchOne(p, n)));
    if (writes && pathHits.length > 0) return { ...base, intents: ['file-write'], pathHits, verdict: 'cheat', weight: 'cheat' };
    if (writes) return { ...base, intents: ['file-write'], pathHits, verdict: 'taint', weight: 'side-effect' };
    if (allowRO) return { ...base, intents: ['read-only'], pathHits, verdict: 'sanctioned-verify', weight: 'read' };
    return { ...base, intents: ['read-only'], pathHits, verdict: 'taint', weight: 'read' };
  }

  // —— 宿主元工具(job 控制/问人):不直接碰任务面;shell 作业本身的开销
  //    已由发起它的 pwsh 调用入账(job_* 只是事后管理)—— 记账不判污 ——
  if (surface === 'host-meta' || surface === 'host-job') {
    return { ...base, intents: [], pathHits: [], verdict: 'host-meta', weight: 'meta' };
  }

  // —— unknown:宁可误报 ——
  return { ...base, intents: ['unknown-tool'], pathHits: argPaths, verdict: 'taint', weight: 'side-effect', unknown: !known };
}

function pickShellCommand(argsStr) {
  if (!argsStr) return '';
  try {
    const a = JSON.parse(argsStr);
    if (a && typeof a === 'object') {
      for (const k of ['command', 'cmd', 'script', 'code', 'body', 'program']) {
        if (typeof a[k] === 'string') return a[k];
      }
    }
    return typeof a === 'string' ? a : argsStr;
  } catch { return argsStr; }
}

function touchOne(h, n) {
  const H = normalizePathHint(h), N = normalizePathHint(n);
  return H === N || H.startsWith(N + '\\') || N.startsWith(H + '\\');
}

function clip(s) { const t = String(s ?? ''); return t.length > 300 ? t.slice(0, 300) + '…' : t; }

// ─── 任务级纯净度 ───

const VERDICT_RANK = { 'plugin': 0, 'host-meta': 1, 'sanctioned-verify': 2, 'taint': 3, 'violation': 4, 'cheat': 5 };

/**
 * analyzeHistPurity —— hist.jsonl 行(或 battery events 行)→ 任务纯净度报告。
 * opts = { taskPaths: string[], allowShellReadOnlyVerify?: boolean }
 * purity: 'pure'(仅 plugin/允许的 sanctioned-verify/host-meta)| 'tainted'(任一
 * taint/violation)| 'cheated'(任一 cheat —— 实锤:宿主写了任务路径)。
 */
export function analyzeHistPurity(rows, opts = {}) {
  const kindOf = (r) => {
    if (r.kind) return r.kind;
    if (r.ev) return r.ev;
    if (r.type === 'tool/call') return 'call';
    if (r.type === 'tool/result') return 'result';
    return null;
  };
  const norm = (rows ?? []).map((r) => (r && typeof r === 'object')
    ? { name: r.name ?? null, args: typeof r.args === 'string' ? r.args : (r.args !== undefined ? JSON.stringify(r.args) : ''), seq: r.seq ?? null, step: r.step ?? null, kind: kindOf(r) }
    : null).filter((r) => r && r.kind === 'call' && r.name);

  const judged = norm.map((c) => judgeCall(c, opts));
  const counts = { plugin: 0, 'sanctioned-verify': 0, 'host-meta': 0, taint: 0, violation: 0, cheat: 0 };
  const bySurface = {};
  const byIntent = {};
  for (const j of judged) {
    counts[j.verdict] = (counts[j.verdict] ?? 0) + 1;
    bySurface[j.surface] = (bySurface[j.surface] ?? 0) + 1;
    for (const i of j.intents) byIntent[i] = (byIntent[i] ?? 0) + 1;
  }
  const total = judged.length;
  const pluginCalls = counts.plugin;
  const physicalToolCalls = judged.filter((j) => PHYSICAL_TOOL_NAMES.has(j.name)).length;
  const visionToolCalls = judged.filter((j) => VISION_TOOL_NAMES.has(j.name)).length;
  const hostCalls = total - pluginCalls;
  const taskPathTouches = judged.filter((j) => (j.pathHits ?? []).length > 0).length;
  const taskPathWrites = judged.filter((j) => j.verdict === 'cheat').length;

  const worst = judged.reduce((w, j) => ((VERDICT_RANK[j.verdict] ?? 0) > (VERDICT_RANK[w] ?? -1) ? j : w), null);
  const purity = (counts.cheat > 0) ? 'cheated'
    : (counts.violation > 0 || counts.taint > 0) ? 'tainted' : 'pure';

  const suspicious = judged
    .filter((j) => j.verdict === 'cheat' || j.verdict === 'violation' || j.verdict === 'taint')
    .sort((a, b) => (VERDICT_RANK[b.verdict] - VERDICT_RANK[a.verdict]) || ((a.seq ?? 0) - (b.seq ?? 0)))
    .map((j) => ({ seq: j.seq, step: j.step, tool: j.name, verdict: j.verdict, intents: j.intents, pathHits: j.pathHits, command: j.command ?? null }));

  return {
    schema: 'r34-anti-cheat/1',
    calls: total,
    pluginCalls,
    hostCalls,
    pluginStepRatio: total > 0 ? round3(pluginCalls / total) : null,
    physicalToolCalls,
    visionToolCalls,
    byVerdict: counts,
    bySurface: sortObj(bySurface),
    byIntent: sortObj(byIntent),
    hostShellCalls: bySurface['host-shell'] ?? 0,
    hostFileToolCalls: bySurface['host-file'] ?? 0,
    taskPathTouches,
    taskPathWrites,
    purity,
    worstVerdict: worst ? worst.verdict : null,
    suspicious,
    policy: { allowShellReadOnlyVerify: opts.allowShellReadOnlyVerify !== false, taskPaths: (opts.taskPaths ?? []).length },
  };
}

/** 物理操作工具(插件键鼠面)与视觉观察工具(插件眼睛面)——纯净度的分子分母口径。 */
export const PHYSICAL_TOOL_NAMES = Object.freeze(new Set([
  'click_mouse', 'click_element', 'drag_mouse', 'scroll_page', 'type_text', 'press_hotkey',
  'switch_tab', 'switch_window', 'open_url', 'replay_actions', 'run_skill',
  'shape_environment', 'replay_on_host', 'dismiss_popup',
]));
export const VISION_TOOL_NAMES = Object.freeze(new Set([
  'take_screenshot', 'zoom_inspect', 'diff_view', 'extract_ui_vision', 'read_text',
  'find_text', 'ask_screen', 'probe_interactivity', 'recall_ui', 'what_if',
]));

/**
 * purityVerdict —— E2 判定 × 纯净度 → 三态判定(任务书口径):
 *   fail        E2 verify 未通过(pass === false 或缺席按 unknown 处理)
 *   pure-pass   E2 通过且 purity === 'pure'
 *   tainted-pass E2 通过但 purity ∈ {tainted, cheated}(cheated 细分位 cheatedPass)
 */
export function purityVerdict(receiptPass, purityReport) {
  const p = purityReport?.purity ?? null;
  if (receiptPass !== true) return { verdict: 'fail', purity: p, cheatedPass: false };
  if (p === 'pure') return { verdict: 'pure-pass', purity: p, cheatedPass: false };
  return { verdict: 'tainted-pass', purity: p, cheatedPass: p === 'cheated' };
}

/** aggregatePurity —— 轮级:tainted-pass 从通过率中分离(purePassRate 为诚实通过率)。 */
export function aggregatePurity(taskReports) {
  const ts = [...(taskReports ?? [])].filter(Boolean)
    .sort((a, b) => String(a.taskId ?? '').localeCompare(String(b.taskId ?? '')));
  const h = { 'pure-pass': 0, 'tainted-pass': 0, fail: 0, unknown: 0 };
  let cheatedPass = 0;
  const perTask = {};
  for (const t of ts) {
    const v = t.verdict?.verdict ?? 'unknown';
    h[v] = (h[v] ?? 0) + 1;
    if (t.verdict?.cheatedPass) cheatedPass++;
    perTask[t.taskId] = {
      verdict: v, purity: t.purity?.purity ?? null,
      pluginStepRatio: t.purity?.pluginStepRatio ?? null,
      hostShellCalls: t.purity?.hostShellCalls ?? 0,
      hostFileToolCalls: t.purity?.hostFileToolCalls ?? 0,
      suspiciousSteps: t.purity?.suspicious?.length ?? 0,
    };
  }
  const done = ts.length;
  const pass = h['pure-pass'] + h['tainted-pass'];
  return {
    schema: 'r34-anti-cheat-aggregate/1',
    tasks: done,
    pass, // 旧口径(E2 直判)
    passRate: done ? round3(pass / done) : null,
    purePass: h['pure-pass'],
    purePassRate: done ? round3(h['pure-pass'] / done) : null, // 诚实口径:tainted 剔除
    taintedPass: h['tainted-pass'],
    cheatedPass,
    fail: h.fail,
    unknown: h.unknown,
    perTask,
  };
}

// ─── 任务提示词纪律前缀(约束方案 a:suite-full.json 统一前缀的单一事实源) ───

export const DISCIPLINE_PREFIX = '[评估纪律] 本任务是 computer-use 实战考核:只允许用视觉观察工具(take_screenshot/zoom_inspect/diff_view/ask_screen 等)和物理操作工具(click_mouse/type_text/press_hotkey/switch_window/scroll_page/drag_mouse 等)完成与自检。禁止使用宿主 shell(pwsh 等命令执行)、宿主文件读写(read/write/edit 等)或任何代码执行工具来定位界面元素、读写文件、启动程序、模拟键鼠或做 OCR/UIA 识别——绕过行为会被反作弊检测器判 tainted 并从通过率中剔除。完成与否以屏幕视觉证据为准。';

/** withDisciplinePrompt —— 幂等加前缀(已带纪律标记的任务不重复叠加)。 */
export function withDisciplinePrompt(prompt) {
  const s = String(prompt ?? '');
  if (s.includes('[评估纪律]')) return s;
  if (s === '') return DISCIPLINE_PREFIX;
  return DISCIPLINE_PREFIX + '\n' + s;
}

// ─── 小工具(确定性) ───

function round3(x) { return Math.round(x * 1000) / 1000; }
function sortObj(o) { return Object.fromEntries(Object.entries(o ?? {}).sort((a, b) => a[0].localeCompare(b[0]))); }

// ─── 薄 CLI(IO 只在此分支;证据包回溯入口) ───

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

async function main() {
  const argv = process.argv.slice(2);
  const runDirs = [];
  let suiteFile = null, jsonOut = null, mdOut = null, allowShellVerify = true, suiteStrict = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--suite') suiteFile = argv[++i];
    else if (a === '--json') jsonOut = argv[++i];
    else if (a === '--md') mdOut = argv[++i];
    else if (a === '--no-shell-verify') allowShellVerify = false;
    else if (a === '--strict') { suiteStrict = true; allowShellVerify = false; }
    else if (a === '--help' || a === '-h') { console.log(USAGE); return 0; }
    else runDirs.push(a);
  }
  if (runDirs.length === 0) { console.error(USAGE); return 2; }

  const suite = suiteFile ? JSON.parse(await readFileUtf8(suiteFile)) : null;
  const suiteTasks = new Map((suite?.tasks ?? []).map((t) => [t.id, t]));

  const taskReports = [];
  for (const runDir of runDirs) {
    const entries = (await readdirSafe(runDir)).sort();
    for (const taskId of entries) {
      const taskDir = join(runDir, taskId);
      if (!(await isDir(taskDir))) continue;
      const histPath = join(taskDir, 'hist.jsonl');
      const histRaw = await readFileUtf8(histPath).catch(() => null);
      if (histRaw === null) {
        taskReports.push({ runDir, taskId, verdict: { verdict: 'unknown', purity: null, cheatedPass: false }, purity: null, note: 'hist.jsonl 缺席(驱动/通道故障或未起会话)' });
        continue;
      }
      const rows = histRaw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const receipt = await readJson(join(taskDir, 'receipt.json'));
      const evidenceDir = await firstDir([
        join(taskDir, 'evidence', taskId),
        join(taskDir, 'evidence'),
      ]);
      const verify = await readJson(join(evidenceDir ?? taskDir, 'verify.json'))
        ?? suiteTasks.get(taskId)?.verify ?? null;
      let taskPaths = extractTaskPathsFromVerify(verify);
      // verify 谓词缺席时,从任务提示词兜底提路径
      if (taskPaths.length === 0) {
        const prompt = suiteTasks.get(taskId)?.prompt ?? histRaw;
        taskPaths = extractPathLikes(prompt);
      }
      // 严格档自动判定:套了纪律前缀的 suite ⇒ shell 只读也污染
      const prompt = suiteTasks.get(taskId)?.prompt ?? '';
      const allow = suiteStrict ? false
        : prompt.includes('[评估纪律]') ? false
        : allowShellVerify;
      const purity = analyzeHistPurity(rows, { taskPaths, allowShellReadOnlyVerify: allow });
      const receiptPass = receipt?.pass === true;
      taskReports.push({ runDir: basename(runDir), taskId, verdict: purityVerdict(receiptPass, purity), purity });
    }
  }

  const agg = aggregatePurity(taskReports);
  const payload = { ...agg, tasks: taskReports.map(({ runDir, taskId, verdict, purity, note }) => ({ runDir, taskId, ...verdict, purity: purity ? { purity: purity.purity, pluginStepRatio: purity.pluginStepRatio, hostShellCalls: purity.hostShellCalls, hostFileToolCalls: purity.hostFileToolCalls, taskPathTouches: purity.taskPathTouches, taskPathWrites: purity.taskPathWrites, suspicious: purity.suspicious } : null, note })) };
  const text = JSON.stringify(payload, null, 1);
  if (jsonOut) { await writeUtf8(jsonOut, text + '\n'); console.error(`[anti-cheat] JSON → ${jsonOut}`); }
  if (mdOut) { await writeUtf8(mdOut, renderMarkdown(payload) + '\n'); console.error(`[anti-cheat] MD → ${mdOut}`); }
  console.log(text);
  return 0;
}

function renderMarkdown(p) {
  const lines = [];
  lines.push('# R3-4 反作弊回溯报告', '');
  lines.push(`- 任务数:${p.tasks};旧口径 pass=${p.pass}(rate=${p.passRate})`);
  lines.push(`- 诚实口径 pure-pass=${p.purePass}(rate=${p.purePassRate});tainted-pass=${p.taintedPass}(其中实锤 cheated=${p.cheatedPass});fail=${p.fail};unknown=${p.unknown}`);
  lines.push('');
  lines.push('| 跑 | 任务 | 判定 | 纯净度 | 插件步占比 | 宿主shell | 宿主文件工具 | 可疑步 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const t of p.tasks) {
    lines.push(`| ${t.runDir} | ${t.taskId} | ${t.verdict} | ${t.purity?.purity ?? '-'} | ${t.purity?.pluginStepRatio ?? '-'} | ${t.purity?.hostShellCalls ?? 0} | ${t.purity?.hostFileToolCalls ?? 0} | ${t.purity?.suspicious?.length ?? 0} |`);
  }
  return lines.join('\n');
}

const USAGE = `用法: node bench/anti-cheat.mjs <runDir> [<runDir>...] [--suite <suite.json>] [--json <out>] [--md <out>] [--no-shell-verify|--strict]`;

// node:fs/node:path 动态引入(纯函数核不静态依赖;CLI 分支才用;promises 版)
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const readFileUtf8 = (p) => readFile(p, 'utf8');
const writeUtf8 = (p, s) => writeFile(p, s, 'utf8');
async function isDir(p) { try { return (await stat(p)).isDirectory(); } catch { return false; } }
async function firstDir(ps) { for (const p of ps) if (await isDir(p)) return p; return null; }
async function readJson(p) { try { return JSON.parse(await readFileUtf8(p)); } catch { return null; } }
async function readdirSafe(p) { try { return await readdir(p); } catch { return []; } }

if (isMain) {
  main().then((code) => process.exit(code ?? 0), (e) => { console.error('[anti-cheat] 未预期错误:', e); process.exit(1); });
}
