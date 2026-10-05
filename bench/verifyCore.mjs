// bench/verifyCore.mjs — W2-3 E2:独立契约核查器(不信 agent 自报的终判通道)
//
// 世界级标准第一条:**核查通道与被测对象物理隔离**。本模块对世界的全部观察
// (文件系统 / tasklist / 注册表 / 窗口枚举 / 截图)都经由注入的 world 对象执行,
// 绝不询问 agent、不读会话自报文本 —— battery 会话轨迹只用于旧有的 expect 正则,
// 终判以本通道为准(expect 与 verify 双轨合一,verify 失败即任务失败)。
//
// 契约语义的来源与偏离说明(以 src/resultContract.ts 实读为准):resultContract
// 实际是「工具回执状态分类器」(锚点 JSON 强类型 status 字段 + [Error]/[System]
// 前缀回退 + STATUS_FOLD 登记表 + UNKNOWN 不瞎猜),并不含文件/进程/注册表谓词。
// 本模块按 resultContract 的四条原则定义 bench 侧 verify DSL:
//   1. 强类型判定优先(结构化观察),绝不靠字符串巧合嗅探;
//   2. 谓词登记表(PREDICATE_EVALUATORS)—— 未登记 kind ⇒ status 'error',不静默失明;
//   3. 「查了但不成立」(fail)与「核查通道坏了」(error)严格分离 —— 通道坏 ⇒
//      整体不放行(pass=false + channelError 标记),这是诚实降级而非瞎猜;
//   4. 原始观察(raw)随每个谓词落盘,证据可复核、可回放。
//
// world 协议(依赖注入 —— 单测/自检给 mock,真机给 createWindowsWorld):
//   stat(path) → {ok, exists, isFile, isDir, size, raw}
//   readFileHead(path, bytes) → {ok, text, raw}
//   sha256(path) → {ok, hex, raw}
//   listProcesses() → {ok, items:[{name, pid}], raw}
//   listWindowTitles() → {ok, titles:[string], raw}
//   queryRegistry(hive, key, value?) → {ok, exists, data, type, raw}
//   env(name) → {ok, value, raw}
//   captureScreenshot(destPath) → {ok, path?, error?, raw}
// 任一方法抛异常 ⇒ 该谓词 status 'error'(登记原则第 3 条)。

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const run = promisify(execFile);
const CHANNEL_TIMEOUT_MS = 20000; // 单条观察命令超时(截图/PS 较慢)

/** W2-3:中文 Windows 的控制台命令输出走 OEM 代码页(GBK)—— 按 utf8 解会得到
 *  替换符乱码,导致「键不存在」的合法 stderr 被误判为通道错误。先按 utf8 解,
 *  含 U+FFFD 则回退 GBK(TextDecoder 全 ICU 支持),再不行 latin1 —— 证据永不丢。 */
function decodeOem(x) {
  if (!Buffer.isBuffer(x)) return x === undefined || x === null ? '' : String(x);
  const utf8 = x.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  for (const enc of ['gbk', 'gb18030', 'latin1']) {
    try { return new TextDecoder(enc).decode(x); } catch { /* 该编码不可用,试下一个 */ }
  }
  return utf8;
}

// ─── 谓词登记表(唯一登记点:新增谓词加一行 + 一个求值器) ───
export const VERIFY_CHECK_KINDS = new Set([
  'fileExists', 'fileAbsent', 'dirExists',
  'processRunning', 'processAbsent',
  'windowExists', 'windowAbsent', 'windowCount',
  'registryKey', 'registryValue',
  'envVar',
  'not', 'allOf', 'anyOf',
]);

/** verify 块结构校验(fail-fast:suite 声明错在跑前暴露,不烧真机预算) */
export function validateVerifyBlock(v) {
  const errors = [];
  if (!v || typeof v !== 'object') return { ok: false, errors: ['verify 必须是对象'] };
  if (v.mode !== undefined && v.mode !== 'all' && v.mode !== 'any') errors.push(`mode 须为 'all'|'any',得 ${JSON.stringify(v.mode)}`);
  if (v.screenshot !== undefined && typeof v.screenshot !== 'boolean') errors.push('screenshot 须为 boolean');
  if (!Array.isArray(v.checks) || v.checks.length === 0) { errors.push('verify.checks 必须是非空数组'); return { ok: false, errors }; }
  const walk = (c, where) => {
    if (!c || typeof c !== 'object') { errors.push(`${where}: 谓词须为对象`); return; }
    if (typeof c.kind !== 'string' || !VERIFY_CHECK_KINDS.has(c.kind)) {
      errors.push(`${where}: 未登记的谓词 kind ${JSON.stringify(c?.kind)}(登记表:${[...VERIFY_CHECK_KINDS].join(',')})`);
      return;
    }
    if (c.kind === 'not') { walk(c.check, `${where}.check`); return; }
    if (c.kind === 'allOf' || c.kind === 'anyOf') {
      if (!Array.isArray(c.checks) || c.checks.length === 0) { errors.push(`${where}.checks 须为非空数组`); return; }
      c.checks.forEach((cc, i) => walk(cc, `${where}.checks[${i}]`));
      return;
    }
    if ((c.kind === 'fileExists' || c.kind === 'fileAbsent' || c.kind === 'dirExists') && !c.path) errors.push(`${where}: ${c.kind} 缺 path`);
    if (c.kind === 'processRunning' || c.kind === 'processAbsent') {
      if (!c.name && !Array.isArray(c.names)) errors.push(`${where}: ${c.kind} 缺 name/names`);
    }
    if (c.kind === 'windowExists' || c.kind === 'windowAbsent') {
      if (!c.titleRegex) errors.push(`${where}: ${c.kind} 缺 titleRegex`);
      else { try { new RegExp(c.titleRegex, 'i'); } catch (e) { errors.push(`${where}: titleRegex 非法:${e.message}`); } }
    }
    // W8-B7:窗口计数谓词 —— titleRegex 必填(未过滤的顶层窗口总数含 Program Manager
    // 等系统固有窗口,是无信息量的噪声;计数断言必须锚定目标窗口域),
    // equals/gte/lte 至少一个、可组合(求值时全部合取),值须为非负整数。
    if (c.kind === 'windowCount') {
      if (!c.titleRegex) errors.push(`${where}: windowCount 缺 titleRegex(顶层窗口总数含系统固有窗口,恒噪声 —— 须用正则锚定目标窗口域)`);
      else { try { new RegExp(c.titleRegex, 'i'); } catch (e) { errors.push(`${where}: titleRegex 非法:${e.message}`); } }
      const ops = ['equals', 'gte', 'lte'].filter((k) => c[k] !== undefined);
      if (ops.length === 0) errors.push(`${where}: windowCount 缺比较子(equals/gte/lte 至少给一个)`);
      for (const k of ops) {
        if (!Number.isInteger(c[k]) || c[k] < 0) errors.push(`${where}: windowCount.${k} 须为非负整数(得 ${JSON.stringify(c[k])})`);
      }
    }
    if (c.kind === 'registryKey' || c.kind === 'registryValue') {
      if (!c.key) errors.push(`${where}: ${c.kind} 缺 key`);
      if (c.hive !== undefined && !/^HK(CU|LM|CR|U|CC)$|^HKEY_[A-Z_]+$/.test(c.hive)) errors.push(`${where}: hive 非法 ${JSON.stringify(c.hive)}`);
    }
    if (c.kind === 'registryValue' && !c.value) errors.push(`${where}: registryValue 缺 value(名)`);
    if (c.kind === 'envVar' && !c.name) errors.push(`${where}: envVar 缺 name`);
  };
  v.checks.forEach((c, i) => walk(c, `verify.checks[${i}]`));
  return { ok: errors.length === 0, errors };
}

/** %VAR% 展开(Windows 风格;未定义变量原样保留 —— 不吞不猜) */
export function expandPath(p) {
  return String(p).replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : m);
}

// ─── 真机 world(Windows 独立观察通道;非 win32 平台上 OS 命令类谓词诚实地报通道错误) ───
export function createWindowsWorld({ timeoutMs = CHANNEL_TIMEOUT_MS } = {}) {
  const isWin = process.platform === 'win32';
  const trunc = (s, n = 8000) => (s && s.length > n ? s.slice(0, n) + '…' : String(s ?? ''));

  async function osCmd(file, args, label) {
    if (!isWin) throw new Error(`channel[${label}]: 仅 win32 支持(当前 ${process.platform})`);
    const { stdout, stderr } = await run(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' });
    return { stdout: decodeOem(stdout), stderr: decodeOem(stderr) };
  }

  return {
    platform: process.platform,
    async stat(p) {
      const target = expandPath(p);
      try {
        const s = await stat(target);
        return { ok: true, exists: true, isFile: s.isFile(), isDir: s.isDirectory(), size: s.size, raw: `stat ${target}: size=${s.size} file=${s.isFile()}` };
      } catch (e) {
        if (e.code === 'ENOENT') return { ok: true, exists: false, isFile: false, isDir: false, size: 0, raw: `stat ${target}: ENOENT` };
        throw new Error(`stat ${target}: ${e.message}`);
      }
    },
    async readFileHead(p, bytes = 65536) {
      const target = expandPath(p);
      const buf = await readFile(target);
      const slice = buf.subarray(0, bytes);
      return { ok: true, text: slice.toString('utf8'), raw: `read ${target} (${buf.size}B, head ${slice.length}B): ${trunc(slice.toString('utf8'), 2000)}` };
    },
    async sha256(p) {
      const target = expandPath(p);
      const buf = await readFile(target);
      const hex = createHash('sha256').update(buf).digest('hex');
      return { ok: true, hex, raw: `sha256 ${target}: ${hex}` };
    },
    async listProcesses() {
      const { stdout } = await osCmd('tasklist', ['/FO', 'CSV', '/NH'], 'tasklist');
      const items = [];
      for (const line of String(stdout).split(/\r?\n/)) {
        if (!line.trim()) continue;
        const m = line.match(/^"([^"]+)","(\d+)"/); // CSV: "name","pid",… —— [^"] 锚住首列,防贪婪跨列
        if (m) items.push({ name: m[1], pid: Number(m[2]) });
      }
      return { ok: true, items, raw: trunc(stdout) };
    },
    async listWindowTitles() {
      // R6-1:窗口枚举通道改 EnumWindows(全量可见顶层标题窗)。旧通道 Get-Process
      // MainWindowTitle 每进程只报一个标题:①多窗共进程(Win11 explorer 外壳与全部
      // 文件窗同进程)只报其一;②进程主窗被无标题窗顶替(explorer 上打开的右键菜单
      // 是 explorer.exe 的无标题顶层窗)⇒ explorer 从枚举中整体消失 —— AGON 批2
      // T11 三败同签名实证(verify 时刻截图 explorer 在前台、Get-Process 清单缺)。
      // EnumWindows 通道失败(Add-Type 受限等)⇒ 回退旧通道(诚实降级,回执注明)。
      const enumScript = [
        '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
        "Add-Type -TypeDefinition 'using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;",
        'public static class WinEnum {',
        '  public delegate bool EnumCb(IntPtr h, IntPtr l);',
        '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool EnumWindows(EnumCb d, IntPtr l);',
        '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
        '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
        '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr h);',
        '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
        '  public static List<string> ListVisibleTitles() {',
        '    var outList = new List<string>();',
        '    EnumCb cb = (h, l) => {',
        '      if (IsWindowVisible(h)) {',
        '        int len = GetWindowTextLength(h);',
        '        if (len > 0) {',
        '          var sb = new StringBuilder(len + 1);',
        '          GetWindowText(h, sb, sb.Capacity);',
        '          string t = sb.ToString();',
        '          if (!String.IsNullOrWhiteSpace(t)) {',
        '            uint pid; GetWindowThreadProcessId(h, out pid);',
        '            outList.Add(pid.ToString() + "\\t" + t);',
        '          }',
        '        }',
        '      }',
        '      return true;',
        '    };',
        '    EnumWindows(cb, IntPtr.Zero);',
        '    return outList;',
        '  }',
        "}'",
        '[WinEnum]::ListVisibleTitles() | ForEach-Object { Write-Output $_ }',
      ].join('\n');
      // C# 源含双引号/换行 —— 走 -EncodedCommand(UTF-16LE base64),命令行上不存在
      // 任何 PS 语法解析点(W6R-A8/hostFocusGuardTick 同病灶同修法)。
      const encoded = Buffer.from(enumScript, 'utf16le').toString('base64');
      let titles = null;
      let channel = 'enumwindows';
      let fallbackNote = null;
      try {
        const { stdout } = await osCmd('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], 'windows');
        titles = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
          .map((l) => { const i = l.indexOf('\t'); return i >= 0 ? l.slice(i + 1) : l; });
        if (titles.length === 0) throw new Error('EnumWindows 通道零标题(疑似脚本失败)');
      } catch (e) {
        channel = 'get-process-fallback';
        fallbackNote = String(e.message ?? e).slice(0, 120);
        const { stdout } = await osCmd('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command',
            "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.MainWindowTitle }"],
          'windows');
        titles = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      }
      const raw = titles.join('\n') + (fallbackNote ? `\n[通道回退:${channel} ${fallbackNote}]` : '');
      return { ok: true, titles, raw, channel };
    },
    async queryRegistry(hive, key, value) {
      const root = `${hive}\\${String(key).replace(/^[\\/]+/, '')}`;
      const args = ['query', root];
      if (value) args.push('/v', value);
      let r;
      try {
        r = await osCmd('reg', args, 'registry');
      } catch (e) {
        // reg query 对「键/值不存在」以非零退出 + stderr 提示 —— 这是合法观察(absent),不是通道错误。
        // stderr 经 decodeOem 还原(中文 Windows 是 GBK,英文是 ASCII;两套短语都认)。
        const msg = `${decodeOem(e.stderr) || ''} ${e.message || ''}`;
        // 语法/参数类失败是**通道侧问题**(我们构造的命令坏了)⇒ 抛出,不伪装成 absent
        if (/无效语法|invalid syntax|参数不正确|incorrect (parameter|syntax)/i.test(msg)) {
          throw new Error(`reg query ${root}: 命令语法被拒(通道错误)—— ${msg.slice(0, 200)}`);
        }
        // reg query 对「键/值不存在」以退出码 1 + stderr 提示;短语命中或 status=1 且
        // 非语法错 ⇒ 合法观察 absent(英文/中文两套短语 + 退出码双保险)
        if (/unable to find|cannot find|0x00000002|系统找不到指定的|找不到指定的注册表/i.test(msg) || e.status === 1) {
          return { ok: true, exists: false, data: null, type: null, raw: `reg query ${root}${value ? ' /v ' + value : ''}: 不存在(${msg.trim().split(/\r?\n/)[0].slice(0, 120)})` };
        }
        throw new Error(`reg query ${root}: ${msg.slice(0, 300)}`);
      }
      // 解析 "    Name    REG_SZ    data"(reg 输出为四空格列对齐)
      let data = null, type = null;
      for (const line of String(r.stdout).split(/\r?\n/)) {
        const m = line.match(/^\s+(\S.*?)\s{2,}(REG_\S+)\s*(.*)$/);
        if (m && (!value || m[1].toLowerCase() === value.toLowerCase())) { type = m[2]; data = m[3]; break; }
      }
      if (value && data === null) return { ok: true, exists: true, hasValue: false, data: null, type: null, raw: trunc(r.stdout) };
      return { ok: true, exists: true, hasValue: true, data, type, raw: trunc(r.stdout) };
    },
    async env(name) {
      const v = process.env[name];
      return { ok: true, value: v, raw: `env ${name}: ${v === undefined ? '(undefined)' : trunc(String(v), 500)}` };
    },
    async captureScreenshot(destPath) {
      if (!isWin) throw new Error(`channel[screenshot]: 仅 win32 支持(当前 ${process.platform})`);
      await mkdir(path.dirname(destPath), { recursive: true });
      const psSafe = String(destPath).replace(/'/g, "''");
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        '$b=[System.Windows.Forms.SystemInformation]::VirtualScreen',
        '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height',
        '$g=[System.Drawing.Graphics]::FromImage($bmp)',
        '$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size)',
        `$bmp.Save('${psSafe}')`,
        '$g.Dispose();$bmp.Dispose()',
      ].join('; ');
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: timeoutMs, windowsHide: true });
      return { ok: true, path: destPath, raw: `screenshot saved: ${destPath}` };
    },
  };
}

/** mock world(自检/单测的确定性事实源):未覆盖的方法一律走「通道错误」——不猜 */
export function createMockWorld(overrides = {}) {
  const broken = async (label) => { throw new Error(`mock world: 方法 ${label} 未提供(通道错误 —— mock 不猜)`); };
  const base = {
    platform: 'mock',
    stat: () => broken('stat'), readFileHead: () => broken('readFileHead'), sha256: () => broken('sha256'),
    listProcesses: () => broken('listProcesses'), listWindowTitles: () => broken('listWindowTitles'),
    queryRegistry: () => broken('queryRegistry'), env: () => broken('env'), captureScreenshot: () => broken('captureScreenshot'),
  };
  return { ...base, ...overrides };
}

// ─── 谓词求值(结构化观察 → 判定;绝不嗅探字符串格式巧合) ───

function finish(index, check, status, expected, observed, raw) {
  return {
    index, kind: check.kind, spec: check, status, expected, observed,
    raw: String(raw ?? '').slice(0, 4000), // 原始观察(证据落盘用)
  };
}

async function evalFileLike(index, check, world, wantDir) {
  const st = await world.stat(check.path);
  if (!st.exists) return finish(index, check, 'fail', `${check.kind}: 存在`, '不存在', st.raw);
  const shapeOk = wantDir ? st.isDir : st.isFile;
  if (!shapeOk) return finish(index, check, 'fail', wantDir ? '目录' : '普通文件', wantDir ? '非目录' : '非普通文件', st.raw);
  if (!wantDir && (check.minBytes !== undefined || check.maxBytes !== undefined)) {
    if (check.minBytes !== undefined && st.size < check.minBytes) return finish(index, check, 'fail', `size>=${check.minBytes}B`, `size=${st.size}B`, st.raw);
    if (check.maxBytes !== undefined && st.size > check.maxBytes) return finish(index, check, 'fail', `size<=${check.maxBytes}B`, `size=${st.size}B`, st.raw);
  }
  if (!wantDir && (check.contains !== undefined || check.containsRegex !== undefined)) {
    const head = await world.readFileHead(check.path, check.headBytes ?? 65536);
    if (check.contains !== undefined && !head.text.toLowerCase().includes(String(check.contains).toLowerCase())) {
      return finish(index, check, 'fail', `内容含子串 ${JSON.stringify(check.contains)}`, '未命中', head.raw);
    }
    if (check.containsRegex !== undefined && !new RegExp(check.containsRegex, 'i').test(head.text)) {
      return finish(index, check, 'fail', `内容匹配 /${check.containsRegex}/i`, '未命中', head.raw);
    }
  }
  if (!wantDir && check.sha256 !== undefined) {
    const h = await world.sha256(check.path);
    if (h.hex.toLowerCase() !== String(check.sha256).toLowerCase()) {
      return finish(index, check, 'fail', `sha256=${String(check.sha256).toLowerCase()}`, `sha256=${h.hex}`, h.raw);
    }
  }
  return finish(index, check, 'pass', check.kind, wantDir ? `目录存在(${st.size}B 条目)` : `文件存在(${st.size}B)`, st.raw);
}

const normProc = (n) => String(n).toLowerCase();
function procMatch(items, spec) {
  const wanted = (spec.names ?? [spec.name]).map(normProc);
  return items.filter((p) => {
    const pn = normProc(p.name);
    if (spec.pid !== undefined && p.pid === spec.pid) return true;
    return wanted.some((w) => pn === w || pn === w.replace(/\.exe$/, '') + '.exe' || pn === w.replace(/\.exe$/, ''));
  });
}

async function evalProcess(index, check, world, want) {
  const r = await world.listProcesses();
  const hits = procMatch(r.items, check);
  const found = hits.length > 0;
  if (found !== want) return finish(index, check, 'fail', want ? `进程在运行:${check.name ?? check.names.join('/')}` : `进程不在运行:${check.name ?? check.names.join('/')}`,
    `tasklist 命中 ${hits.length} 条:${hits.slice(0, 5).map((h) => `${h.name}(${h.pid})`).join(', ')}`, r.raw);
  return finish(index, check, 'pass', want ? '进程在运行' : '进程不在运行',
    `tasklist 命中 ${hits.length} 条:${hits.slice(0, 5).map((h) => `${h.name}(${h.pid})`).join(', ')}`, r.raw);
}

async function evalWindow(index, check, world, want) {
  const r = await world.listWindowTitles();
  const re = new RegExp(check.titleRegex, 'i');
  const hits = r.titles.filter((t) => re.test(t));
  const found = hits.length > 0;
  if (found !== want) return finish(index, check, 'fail', want ? `存在标题匹配 /${check.titleRegex}/i 的窗口` : `不存在标题匹配 /${check.titleRegex}/i 的窗口`,
    `窗口清单(${r.titles.length} 个顶层标题):${hits.slice(0, 8).join(' | ') || '(无命中)'}`, r.raw);
  return finish(index, check, 'pass', want ? '窗口存在' : '窗口不存在', `命中:${hits.slice(0, 8).join(' | ')}`, r.raw);
}

/** W8-B7:窗口计数谓词 —— 与 windowExists 同通道(listWindowTitles,复用同一观察
 *  命令,不另开旁路),对 titleRegex 过滤后的窗口数做 equals/gte/lte 断言
 *  (比较子可组合,全部合取)。语义:「跑前跑后窗口数不变/归零」这类编排终态
 *  契约的机器等价物 —— 终态计数是绝对值,套件状态机保证跑前的确定值。 */
async function evalWindowCount(index, check, world) {
  const r = await world.listWindowTitles();
  const re = new RegExp(check.titleRegex, 'i');
  const hits = r.titles.filter((t) => re.test(t));
  const n = hits.length;
  const want = [];
  if (check.equals !== undefined) want.push(`=${check.equals}`);
  if (check.gte !== undefined) want.push(`>=${check.gte}`);
  if (check.lte !== undefined) want.push(`<=${check.lte}`);
  const okCount = (check.equals === undefined || n === check.equals)
    && (check.gte === undefined || n >= check.gte)
    && (check.lte === undefined || n <= check.lte);
  return finish(index, check, okCount ? 'pass' : 'fail',
    `匹配 /${check.titleRegex}/i 的窗口数 ${want.join(' 且 ')}`,
    `实测 ${n} 个(顶层标题共 ${r.titles.length} 个):${hits.slice(0, 8).join(' | ') || '(无命中)'}`,
    r.raw);
}

const PREDICATE_EVALUATORS = {
  fileExists: (i, c, w) => evalFileLike(i, c, w, false),
  fileAbsent: async (i, c, w) => {
    const st = await w.stat(c.path);
    return st.exists ? finish(i, c, 'fail', '文件不存在', `存在(${st.size}B)`, st.raw) : finish(i, c, 'pass', '文件不存在', '不存在', st.raw);
  },
  dirExists: (i, c, w) => evalFileLike(i, c, w, true),
  processRunning: (i, c, w) => evalProcess(i, c, w, true),
  processAbsent: (i, c, w) => evalProcess(i, c, w, false),
  windowExists: (i, c, w) => evalWindow(i, c, w, true),
  windowAbsent: (i, c, w) => evalWindow(i, c, w, false),
  windowCount: (i, c, w) => evalWindowCount(i, c, w),
  registryKey: async (i, c, w) => {
    const r = await w.queryRegistry(c.hive ?? 'HKCU', c.key);
    const want = c.exists !== false; // 默认要求存在;c.exists=false 断言缺席
    return r.exists === want
      ? finish(i, c, 'pass', `注册表键 ${c.hive ?? 'HKCU'}\\${c.key} ${want ? '存在' : '不存在'}`, `实际 ${r.exists ? '存在' : '不存在'}`, r.raw)
      : finish(i, c, 'fail', `注册表键 ${c.hive ?? 'HKCU'}\\${c.key} ${want ? '存在' : '不存在'}`, `实际 ${r.exists ? '存在' : '不存在'}`, r.raw);
  },
  registryValue: async (i, c, w) => {
    const r = await w.queryRegistry(c.hive ?? 'HKCU', c.key, c.value);
    if (!r.exists) return finish(i, c, 'fail', `注册表值 ${c.hive ?? 'HKCU'}\\${c.key}\\${c.value}`, '键不存在', r.raw);
    if (!r.hasValue) return finish(i, c, 'fail', `注册表值 ${c.value}`, '键存在但值缺席', r.raw);
    if (c.equals !== undefined && String(r.data) !== String(c.equals)) return finish(i, c, 'fail', `=${JSON.stringify(c.equals)}`, `实际 ${JSON.stringify(r.data)}`, r.raw);
    if (c.contains !== undefined && !String(r.data).toLowerCase().includes(String(c.contains).toLowerCase())) return finish(i, c, 'fail', `含 ${JSON.stringify(c.contains)}`, `实际 ${JSON.stringify(r.data)}`, r.raw);
    return finish(i, c, 'pass', `注册表值 ${c.value}`, `${r.type} ${JSON.stringify(r.data)}`, r.raw);
  },
  envVar: async (i, c, w) => {
    const r = await w.env(c.name);
    if (r.value === undefined) return finish(i, c, 'fail', `环境变量 ${c.name} 有值`, 'undefined', r.raw);
    if (c.equals !== undefined && r.value !== c.equals) return finish(i, c, 'fail', `=${JSON.stringify(c.equals)}`, `实际 ${JSON.stringify(r.value)}`, r.raw);
    if (c.contains !== undefined && !r.value.toLowerCase().includes(String(c.contains).toLowerCase())) return finish(i, c, 'fail', `含 ${JSON.stringify(c.contains)}`, `实际 ${JSON.stringify(String(r.value).slice(0, 200))}`, r.raw);
    return finish(i, c, 'pass', `环境变量 ${c.name}`, String(r.value).slice(0, 200), r.raw);
  },
  not: async (i, c, w) => {
    const inner = await evaluateCheck(c.check, w, i);
    // 通道错误穿透取反(error 仍 error —— 通道坏不能靠取反变好)
    const status = inner.status === 'error' ? 'error' : inner.status === 'pass' ? 'fail' : 'pass';
    return { ...inner, index: i, kind: 'not', status, expected: `NOT(${inner.kind}:${inner.status})`, observed: `实际 ${inner.status}` };
  },
  allOf: async (i, c, w) => {
    const subs = [];
    for (let j = 0; j < c.checks.length; j++) subs.push(await evaluateCheck(c.checks[j], w, `${i}.${j}`));
    const status = subs.some((s) => s.status === 'fail') ? 'fail' : subs.some((s) => s.status === 'error') ? 'error' : 'pass';
    return { index: i, kind: 'allOf', spec: c, status, expected: '全部子谓词成立', observed: subs.map((s) => `${s.index}:${s.status}`).join(', '), raw: JSON.stringify(subs.map((s) => ({ index: s.index, kind: s.kind, status: s.status }))) , subs };
  },
  anyOf: async (i, c, w) => {
    const subs = [];
    for (let j = 0; j < c.checks.length; j++) subs.push(await evaluateCheck(c.checks[j], w, `${i}.${j}`));
    const status = subs.some((s) => s.status === 'pass') ? 'pass' : subs.every((s) => s.status === 'error') ? 'error' : 'fail';
    return { index: i, kind: 'anyOf', spec: c, status, expected: '任一子谓词成立', observed: subs.map((s) => `${s.index}:${s.status}`).join(', '), raw: JSON.stringify(subs.map((s) => ({ index: s.index, kind: s.kind, status: s.status }))), subs };
  },
};

/** 单谓词求值:登记表派发;异常 ⇒ 'error'(fail 与 error 严格分离,见模块头) */
export async function evaluateCheck(check, world, index = '0') {
  if (!check || typeof check.kind !== 'string' || !VERIFY_CHECK_KINDS.has(check.kind)) {
    return finish(index, check ?? {}, 'error', '登记表内谓词', `未登记 kind ${JSON.stringify(check?.kind)}(STATUS_FOLD 同律:未登记不瞎猜)`, '');
  }
  try {
    return await PREDICATE_EVALUATORS[check.kind](index, check, world);
  } catch (e) {
    return finish(index, check, 'error', `${check.kind} 观察成功`, `核查通道异常:${e.message}`, '');
  }
}

/**
 * evaluateVerify —— verify 块整体判定(纯观察求值;证据落盘由 writeVerifyEvidence 负责)。
 * 返回 { pass, channelError, mode, checks[], startedAt, finishedAt, channel }。
 * mode='all'(默认):任一 fail ⇒ fail;无 fail 但有 error ⇒ 通道不可信 ⇒ pass=false。
 * mode='any':任一 pass 即 pass(error 不否决已成立的 pass —— 「存在一个可核实的成功」)。
 */
export async function evaluateVerify(verify, world) {
  const v = validateVerifyBlock(verify);
  const startedAt = new Date().toISOString();
  if (!v.ok) return { pass: false, channelError: true, mode: verify?.mode ?? 'all', checks: [], schemaErrors: v.errors, startedAt, finishedAt: new Date().toISOString(), channel: 'independent-local' };
  const mode = verify.mode ?? 'all';
  const checks = [];
  for (let i = 0; i < verify.checks.length; i++) checks.push(await evaluateCheck(verify.checks[i], world, String(i)));
  const hasPass = checks.some((c) => c.status === 'pass');
  const hasFail = checks.some((c) => c.status === 'fail');
  const hasError = checks.some((c) => c.status === 'error');
  const pass = mode === 'any' ? hasPass : !hasFail && !hasError;
  return {
    schema: 'w2bench-verify/1',
    pass, channelError: hasError, mode,
    counts: { pass: checks.filter((c) => c.status === 'pass').length, fail: checks.filter((c) => c.status === 'fail').length, error: checks.filter((c) => c.status === 'error').length },
    checks,
    startedAt, finishedAt: new Date().toISOString(),
    channel: 'independent-local', // 核查通道标识:本地直查,不经 agent、不信自报
  };
}

/** 证据落盘:逐谓词原始观察 txt + verify JSON(截图路径已在 result.screenshot 引用) */
export async function writeVerifyEvidence(reportDir, taskId, verifyResult) {
  const dir = path.join(reportDir, 'evidence', String(taskId).replace(/[^\w.-]/g, '_'));
  await mkdir(dir, { recursive: true });
  const files = [];
  for (const c of verifyResult.checks ?? []) {
    const f = path.join(dir, `check-${c.index}-${c.kind}-${c.status}.txt`);
    await writeFile(f, [
      `# W2-3 E2 独立核查证据`,
      `task:        ${taskId}`,
      `check:       #${c.index} ${c.kind}`,
      `status:      ${c.status}`,
      `expected:    ${c.expected}`,
      `observed:    ${c.observed}`,
      `spec:        ${JSON.stringify(c.spec)}`,
      `channel:     independent-local (不经 agent / 不信自报)`,
      `# ─── 原始观察 ───`,
      c.raw || '(空)',
    ].join('\n'), 'utf8');
    files.push(f);
  }
  const j = path.join(dir, 'verify.json');
  await writeFile(j, JSON.stringify(verifyResult, null, 1), 'utf8');
  files.push(j);
  return { evidenceDir: dir, files };
}

/**
 * runVerification —— battery 用的组合通道:先截图(定格核查时刻的屏幕状态),
 * 再逐谓词求值,最后证据落盘。截图失败不掩盖谓词结果(screenshot.ok=false 记录在案)。
 */
export async function runVerification({ taskId, verify, world, reportDir, captureScreenshot = true }) {
  const startedAt = new Date().toISOString();
  const screenshot = { captured: false };
  if (captureScreenshot && verify.screenshot !== false) {
    try {
      const dest = path.join(reportDir, 'screenshots', `${String(taskId).replace(/[^\w.-]/g, '_')}-${Date.now()}.png`);
      const r = await world.captureScreenshot(dest);
      screenshot.captured = true;
      screenshot.path = r.path;
      screenshot.raw = r.raw;
    } catch (e) {
      screenshot.captured = false;
      screenshot.error = e.message; // 诚实降级:记录,不中断谓词核查
    }
  }
  const result = await evaluateVerify(verify, world);
  result.screenshot = screenshot;
  result.finishedAt = new Date().toISOString();
  result.startedAt = startedAt;
  const evidence = await writeVerifyEvidence(reportDir, taskId, result);
  return { result, evidence };
}

/**
 * buildDoctorRuleCandidate —— verify 失败任务的「doctor 规则候选」草稿(结构化 JSON,
 * 供人工蒸馏 —— bench 不越权自动入库;与 src/doctorRules.ts 的 DoctorRule 是启发关系
 * 而非同构:静态扫描规则需人工转写,这里提供的是机器可复核的触发事实与谓词)。
 */
export function buildDoctorRuleCandidate({ suiteFile, task, runRecord, verifyResult, gateVerdict }) {
  const failing = (verifyResult?.checks ?? []).filter((c) => c.status !== 'pass');
  const trajMatched = Array.isArray(task.expect) && (!runRecord || runRecord.failedExpectations?.length === 0);
  const bothFailed = !trajMatched && failing.length > 0;
  const hypothesis = failing.length === 0
    ? `轨迹判定失败(${(runRecord?.failedExpectations ?? []).join('; ') || '无 expect 声明'})且无 verify 谓词 —— 纯轨迹侧回归候选`
    : bothFailed
      ? `轨迹与独立核查双失败 —— 疑似真实回归(动作未达成目标状态)`
      : `轨迹匹配但独立核查失败 —— 疑似 agent 自报成功而客观状态未达成(假阳性轨迹判定 / 动作无效果 / noop),这是 E2 通道存在的理由`;
  return {
    schema: 'doctor-rule-candidate/draft-1',
    status: 'needs-human-distillation',
    provenance: { generatedBy: 'W2-3 bench E2 独立核查通道', suiteFile, taskId: task.id, sessionId: runRecord?.sessionId, timestamp: new Date().toISOString() },
    reproduction: {
      verdict: gateVerdict?.verdict ?? 'initial-fail',
      flavor: gateVerdict?.flavor,
      runs: gateVerdict?.runs ?? 1,
      pHat: gateVerdict?.pHat ?? null,
      ci: gateVerdict?.ci ?? null,
      rationale: gateVerdict?.rationale ?? '首轮失败,未进 SPRT 门(或门未触发)',
    },
    failingPredicates: failing.map((c) => ({ index: c.index, kind: c.kind, status: c.status, expected: c.expected, observed: c.observed, spec: c.spec, rawObservation: String(c.raw).slice(0, 2000) })),
    trajectorySignal: {
      failedExpectations: runRecord?.failedExpectations ?? null,
      toolErrors: runRecord?.toolErrors ?? null,
      turnErrors: runRecord?.turnErrors ?? null,
      timedOut: runRecord?.timedOut ?? null,
      trajectoryMatched: trajMatched === true,
    },
    hypothesis,
    proposedRule: {
      id: `bench.${task.id}.${failing[0]?.kind ?? 'trajectory'}`,
      category: 'smell',
      severity: gateVerdict?.verdict === 'deterministic-fail' ? 'critical' : 'major',
      description: `[候选] 任务 ${task.id} 的可复核谓词:${failing.map((c) => c.kind).join(', ') || 'expect 正则'} 稳定/间歇失败`,
      check: failing[0]?.spec ?? { expect: task.expect ?? [] },
      note: '由 bench E2 独立核查通道自动产出;须人工蒸馏为 doctor 规则后入库,不得自动生效',
    },
  };
}
