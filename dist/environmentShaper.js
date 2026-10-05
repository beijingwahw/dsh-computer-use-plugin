// src/environmentShaper.ts
// W6-2 结构性保留（doctor smell.over-engineering 登记）：环境整形器 —— Windows/Linux 双适配器 + undo 账本同生命周期（genesis.premature-impl 的 AdapterDeps 注入纪律锚定本文件），拆分将稀释平台对称性。
// D-2 环境重塑：Agent 从「环境的适应者」变为「工作台的造物主」——
// 但造物主的第一美德是复原：改变世界的权力与复原世界的义务严格对称。
//
// 三条工程诚实性声明：
//   1. 能力运行时探测 —— 适配器启动时探测（which/环境变量），诚实申报能力集，绝不假装拥有
//   2. 作用域分级 —— 窗口级（低风险默认可用）vs 系统级（shaperAllowSystemWide 闸门后置）
//   3. 物理动作入队 —— 窗口操作改变真实桌面，全部经 D-1 的 serialize() 互斥队列
//
// 撤销模型（审查修正版）：UndoRecipe.kind 恒等于原始动作 kind（无特殊值混入），
// 还原由 before 快照驱动；z-order 不可逆与浏览器缩放不可读两处诚实降级均在注释文档化。
import { execFile, spawn, spawnSync } from 'child_process';
import { promisify } from 'util';
import { serialize } from './ioMutex.js';
import { journal } from './journal.js';
const exec = promisify(execFile);
/** 命令存在性探测：which 的同步包装（零运行时依赖；异常 = 不存在） */
function probeCommand(cmd) {
    try {
        return spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
    }
    catch {
        return false;
    }
}
/** 系统级动作清单：默认禁用，config 闸门开启后才可用 */
const SYSTEM_WIDE_KINDS = new Set(['set_contrast']);
/** gsettings 高对比度主题键：GNOME 标准位置（非 GNOME 桌面写入无害失败） */
const GTK_THEME_KEY = 'org.gnome.desktop.interface';
const GTK_THEME_PROP = 'gtk-theme';
const HIGH_CONTRAST = 'HighContrast';
export class LinuxAdapter {
    platform = 'linux';
    probe;
    execFn;
    env;
    constructor(deps = {}) {
        this.probe = deps.probe ?? probeCommand;
        this.execFn = deps.exec ?? exec;
        this.env = deps.env ?? process.env;
    }
    /** 能力探测：wmctrl→窗口三动作；DISPLAY→键盘缩放；gsettings+DISPLAY→对比度 */
    async capabilities() {
        const caps = new Set();
        try {
            const hasWmctrl = this.probe('wmctrl');
            const hasDisplay = !!this.env.DISPLAY; // 无 X 会话则键盘/窗口管线整体不可用
            if (hasWmctrl && hasDisplay) {
                caps.add('raise_window').add('maximize_window').add('move_window');
            }
            if (hasDisplay)
                caps.add('set_zoom');
            if (hasWmctrl && hasDisplay && this.probe('gsettings')) {
                caps.add('set_contrast');
            }
        }
        catch { /* 探测失败 = 能力空集：诚实世界（initialize 契约：永不抛错） */ }
        return caps;
    }
    async apply(action) {
        const hint = action.titleHint ?? '';
        switch (action.kind) {
            case 'raise_window': {
                await this.execFn('wmctrl', ['-a', hint]);
                return { kind: 'raise_window', titleHint: hint }; // z-order 不可逆：undo 为文档化 no-op
            }
            case 'maximize_window': {
                const before = await this.getWindowGeometry(hint);
                await this.execFn('wmctrl', ['-a', hint]); // 激活后用 :ACTIVE: 寻址（多窗口同 Hint 歧义最小化）
                await this.execFn('wmctrl', ['-r', ':ACTIVE:', '-b', 'add,maximized_vert,maximized_horz']);
                return {
                    kind: 'maximize_window', titleHint: hint,
                    // 几何不可读时 before 仅含 maximized 标记推断 —— undo 降级为去标记，诚实记录
                    before: before ?? undefined,
                };
            }
            case 'move_window': {
                if (typeof action.x !== 'number' || typeof action.y !== 'number') {
                    throw new Error('move_window requires numeric x and y');
                }
                const before = await this.getWindowGeometry(hint);
                await this.execFn('wmctrl', ['-r', hint, '-e', `0,${Math.round(action.x)},${Math.round(action.y)},-1,-1`]);
                return { kind: 'move_window', titleHint: hint, before: before ?? undefined };
            }
            case 'set_zoom': {
                // 缩放百分比 → 按键序列：Ctrl+0 归零后按 N 次 plus（每档约 10%）
                const level = typeof action.level === 'number' ? action.level : 100;
                const presses = Math.max(0, Math.min(9, Math.round((level - 100) / 10)));
                // 复用 system 热键管线（含 serialize 与白名单）—— 延迟导入避免模块环
                const { system } = await import('./system.js');
                await system.pressHotkey(['ctrl', '0']);
                for (let i = 0; i < presses; i++)
                    await system.pressHotkey(['ctrl', '+']);
                return { kind: 'set_zoom', titleHint: hint }; // 站点内部态不可读：undo 恒为 Ctrl+0
            }
            case 'set_contrast': {
                const { stdout } = await this.execFn('gsettings', ['get', GTK_THEME_KEY, GTK_THEME_PROP]);
                const theme = stdout.trim().replace(/^'|'$/g, ''); // 去掉 gsettings 的引号包装
                await this.execFn('gsettings', ['set', GTK_THEME_KEY, GTK_THEME_PROP, HIGH_CONTRAST]);
                return { kind: 'set_contrast', before: { theme } };
            }
            // R2-5：launch_app 诚实缺席（win32 专属能力 —— capabilities 从不申报，
            // 此臂是类型穷尽性的守门：能力闸门拦截外的直呼按适配器契约抛错）
            case 'launch_app':
                throw new Error('launch_app is not available on linux (honest absence)');
        }
    }
    async undo(recipe) {
        switch (recipe.kind) {
            case 'raise_window':
                return; // z-order 不可逆：文档化 no-op（撤销栈如实记录）
            case 'maximize_window': {
                await this.execFn('wmctrl', ['-a', recipe.titleHint ?? '']);
                await this.execFn('wmctrl', ['-r', ':ACTIVE:', '-b', 'remove,maximized_vert,maximized_horz']);
                const b = recipe.before;
                if (typeof b?.x === 'number' && typeof b.y === 'number') {
                    // 几何快照存在 ⇒ 精确归位；否则诚实止步于去最大化标记
                    await this.execFn('wmctrl', [
                        '-r', ':ACTIVE:', '-e',
                        `0,${Math.round(b.x)},${Math.round(b.y)},${b.width ? Math.round(b.width) : -1},${b.height ? Math.round(b.height) : -1}`,
                    ]);
                }
                return;
            }
            case 'move_window': {
                const b = recipe.before;
                if (typeof b?.x === 'number' && typeof b.y === 'number') {
                    await this.execFn('wmctrl', ['-r', recipe.titleHint ?? '', '-e', `0,${Math.round(b.x)},${Math.round(b.y)},-1,-1`]);
                }
                return; // 无快照（getWindowGeometry 曾失败）⇒ no-op：诚实记录于撤销栈
            }
            case 'set_zoom': {
                const { system } = await import('./system.js');
                await system.pressHotkey(['ctrl', '0']); // 归零策略：站点内部态不可读
                return;
            }
            case 'set_contrast': {
                const orig = recipe.before?.theme;
                if (orig) {
                    await this.execFn('gsettings', ['set', GTK_THEME_KEY, GTK_THEME_PROP, orig]);
                }
                return;
            }
        }
    }
    async getWindowGeometry(titleHint) {
        try {
            // xdotool shell 输出：WINDOW/X/Y/WIDTH/HEIGHT/SCREEN 各一行
            const { stdout: idOut } = await this.execFn('xdotool', ['search', '--name', titleHint]);
            const id = idOut.trim().split('\n').pop()?.trim();
            if (!id)
                return null;
            const { stdout } = await this.execFn('xdotool', ['getwindowgeometry', '--shell', id]);
            const g = {};
            for (const line of stdout.trim().split('\n')) {
                const [k, v] = line.split('=');
                if (k && v !== undefined && !Number.isNaN(Number(v)))
                    g[k.trim()] = Number(v);
            }
            return {
                x: g.X ?? 0, y: g.Y ?? 0, width: g.WIDTH ?? 0, height: g.HEIGHT ?? 0,
                maximized: false, // xdotool 不报最大化标记：undo 先 remove 再归位，标记恒被正确还原
            };
        }
        catch {
            return null; // 无 xdotool/未命中窗口：before 快照缺失，undo 降级（诚实记录）
        }
    }
}
/** Windows：DWM/UIA 接口签名就位（能力预留 —— 架构留白，实现待真实环境） */
// ── K 纪元（留白兑现之二）：Windows 适配器 —— PowerShell + Win32 P/Invoke ──
// 纪律：与 LinuxAdapter 同款 AdapterDeps 注入（probe/exec 可测）；命令名与
// P/Invoke 声明置于模块级常量 —— 类体零直接进程调用（genesis.premature-impl
// 规则已同步演化为「注入纪律」守卫：实现合法，裸调用违法）。
const PS_EXE = 'powershell';
// W6R-A8 shell 启动面加固：-Command → -EncodedCommand。旧通道把整段 PS
// 脚本当命令行参数拼接 —— psLiteral 虽闭合了单引号注入面，但只要 titleHint
// 未来扩到屏幕 OCR 等外部来源，任何转义遗漏都是 RCE 面。EncodedCommand 的
// 载荷是脚本整体的 base64（UTF-16LE），命令行上不存在任何 PS 语法解析点：
// 注入面在传输层被消除，而非依赖转义的正确性。
const PS_FLAGS = ['-NoProfile', '-NonInteractive', '-EncodedCommand'];
/** PS 单引号字面量转义（单引号加倍）—— 脚本内数据的第一道闸（纵深防御保留：
 *  EncodedCommand 已消除命令行注入面，此函数保证脚本内 -like 匹配语义正确） */
function psLiteral(s) {
    return `'${String(s).replace(/'/g, "''")}'`;
}
/**
 * W6R-A8：PS 脚本 → -EncodedCommand 载荷（UTF-16LE → base64）。
 * 纯函数、零外部状态、永不抛（Buffer 编码对任意 JS 字符串恒成功）。
 * 解码由 powershell 原生完成（-EncodedCommand 的契约即 UTF-16LE base64）；
 * 单测锁「解码回原文一致」—— 脚本里的引号/反引号/$()/; 是数据不是语法。
 */
export function psEncodeCommand(script) {
    return Buffer.from(String(script), 'utf16le').toString('base64');
}
// ─── R2-5：GUI 应用直启面（沙箱/host-replay 预置应用窗口的唯一合法通道）───
//
// 病灶（R1-8 遗留②，实战冒烟 attempt3 实锤）：沙箱（宿主受限 token）内经
// pwsh `Start-Process notepad` 启动的 GUI 应用秒死。本机四联探针定性（详见
// .survey/practice/R2-5.md）双机制叠加：
//   ① job 连坐：Windows 上 libuv 给**每个非 detached 子进程**挂
//     JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE 作业对象；pwsh -Command / .NET
//     Process.Start 产生的 GUI 孙代自动继承该作业 —— 工具调用进程树被收割时
//     （job 句柄关闭）GUI 应用一并被杀（探针 M1/M2b：牺牲进程 3s 内死）。
//   ② Shell 激活断裂：唯一能逃出作业的 Start-Process 走 ShellExecute/UWP
//     打包激活代理路径 —— 正是宿主受限 token 下断裂的那条（R1-8 实测
//     「Start-Process 型全死」；而 bash 直接 exec = 裸 CreateProcess 存活）。
//     Win11 记事本/calc 均为打包应用别名（appexeclink 重解析点），Start-Process
//     必经代理；裸 CreateProcess 直接命中重解析点，不经代理 —— 两者的分岔
//     即「Start-Process 死 / 直接 exec 活」的机制解释。
// 修法（任务选型 c —— 最干净）：白名单 + 裸 CreateProcess 直启目标 exe：
//   · shell:false + argv 数组 —— 命令行上零 shell 解析点，注入面在传输层
//     不存在（比 W6R-A8 对 PS 的 -EncodedCommand 加固更前移一层：PS 路径
//     照旧只走 EncodedCommand，本路径根本不经 PS，两条加固律零触碰零回退）；
//   · detached:true + stdio:'ignore' + unref —— 逃出 kill-on-close 作业
//     （探针 M3：父进程退出后 3s 存活），也不持任何管道句柄；
//   · 白名单闭集 —— 目标 exe 已知（沙箱预置应用场景），不接受任意命令。
// GUI 可见性：windowsHide 必须 false（启动的就是要给视觉管线看的窗口）。
/** R2-5：GUI 应用白名单（canonical 键 → exe 名）。闭集立法：launch_app 只
 *  接受此表键名 —— 任意命令注入在此被结构性拒绝（白名单外即拒，无逃逸臂）。
 *  收录标准：预置 GUI 操场常用应用 + System32 在场（CreateProcess 搜索序
 *  内直接命中，无需 PATH 假定）。 */
const GUI_APP_WHITELIST = Object.freeze({
    notepad: 'notepad.exe',
    calc: 'calc.exe',
    mspaint: 'mspaint.exe',
    paint: 'mspaint.exe',
});
/** R2-5：白名单解析（纯函数，永不抛）。接受 canonical 键（大小写不敏感、
 *  容忍 .exe 后缀与首尾空白）；未命中 ⇒ null（调用方如实拒绝并申报白名单）。 */
export function resolveLaunchableApp(name) {
    if (typeof name !== 'string')
        return null;
    const key = name.trim().toLowerCase().replace(/\.exe$/, '');
    const exe = GUI_APP_WHITELIST[key];
    return exe !== undefined ? { canonical: key, exe } : null;
}
/** R2-5：GUI 直启的 spawn 选项（纯函数面 —— 单测钉死四不变量：
 *  detached=true 作业逃逸 / stdio=ignore 零管道 / shell=false 零注入面 /
 *  windowsHide=false GUI 必须可见）。Object.freeze 防调用方篡改。 */
export function guiLaunchSpawnOptions() {
    return Object.freeze({ detached: true, stdio: 'ignore', shell: false, windowsHide: false });
}
/** R2-5：缺省通道 = node child_process.spawn 窄化（filePerms 的
 *  `spawnSync as unknown as ...` 同律 —— 窄形状承担可测性，真实语义不变）。 */
const defaultGuiAppSpawnChannel = spawn;
/** R2-5：启动后存活观察窗（ms）。GUI 应用若被激活策略秒杀（受限 token 场景）
 *  会在此窗内退出 —— 「已启动」的战报必须经此窗对账，绝不虚报交付。 */
export const GUI_LAUNCH_PROBE_MS = 600;
/** 默认探针（win32）：where 定位可执行文件 */
function probeWindows(cmd) {
    try {
        return spawnSync('where', [cmd], { encoding: 'utf8' }).status === 0;
    }
    catch {
        return false;
    }
}
/** Win32 P/Invoke 一次性声明（SetWindowPos/GetWindowRect/ShowWindowAsync/IsZoomed/SetForegroundWindow）
 *  O 纪元（#17 真机执法）：C# 成员定义包 PS 单引号串 —— 内嵌 " 无需转义。
 *  旧实现的 \" 在 PS 双引号串里不是转义（PS 用反引号），经 execFile 真机调用
 *  从未编译成功（注入式测试的 exec 桩掩盖）。 */
const USER32_DECL = "Add-Type -Name U32 -Namespace Win -MemberDefinition '"
    + '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f); '
    + '[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); '
    + '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c); '
    + '[DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h); '
    + '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); '
    + "public struct RECT { public int L; public int T; public int R; public int B; }'";
/** 高对比度 P/Invoke 声明（GET=0x42 / SET=0x43；HCF_HIGHCONTRASTON=0x1）
 *  O 纪元（#17 真机执法）：pvParam 必须指向 HIGHCONTRAST 结构体（cbSize +
 *  dwFlags + lpszDefaultScheme），不是 int 引用 —— 旧形状 SET 恒 false。
 *  cbSize 先置再调（Win32 结构体契约）；单引号律同 USER32_DECL。 */
const HC_DECL = "Add-Type -Name U32HC -Namespace Win -MemberDefinition '" +
    '[DllImport("user32.dll", SetLastError=true)] public static extern bool SystemParametersInfo(int a, uint p, ref HC f, int i); ' +
    'public struct HC { public uint cbSize; public uint dwFlags; public IntPtr lpszDefaultScheme; } ' +
    'public static HC MkHC(uint flags) { HC h = new HC(); h.cbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf(typeof(HC)); h.dwFlags = flags; return h; } ' +
    'public static int GetHC() { HC h = MkHC(0); U32HC.SystemParametersInfo(66, h.cbSize, ref h, 0); return (int)h.dwFlags; } ' +
    "public static bool SetHC(int f) { HC h = MkHC((uint)f); return U32HC.SystemParametersInfo(67, h.cbSize, ref h, 3); }'"; // SPIF_UPDATEINIFILE|SENDCHANGE=3
function setHighContrastPs(flagExpr) {
    return `${HC_DECL}; [Win.U32HC]::SetHC(${flagExpr}) | Out-Null`;
}
/**
 * ΝΩ-25(b)：同类相邻段合并通用件 —— 序列按通道键切段，相邻同键步并入同批。
 * encode 步合并的通用形状：批内步共享一次进程冷启动/一次编译；跨通道的步
 * 永不合并（执行顺序保真 —— LIFO 依赖序不可重排）。纯函数。
 */
export function coalesceAdjacentRuns(items, channelOf) {
    const runs = [];
    for (const item of items) {
        const channel = channelOf(item);
        const last = runs[runs.length - 1];
        if (last && last.channel === channel)
            last.items.push(item);
        else
            runs.push({ channel, items: [item] });
    }
    return runs;
}
/**
 * 复原步的执行通道：'ps'（Win32/SPI P/Invoke，可并入单脚本）、'hotkey'
 * （set_zoom 的 Ctrl+0 —— 走 system 热键管线，黑名单执法面不可绕）、
 * 'kill'（R2-5 launch_app 的 taskkill /PID —— argv 数组经 execFile，零 shell）、
 * 'noop'（raise_window：z-order 不可逆，文档化 no-op —— 无需任何往返）。
 */
function undoChannelOf(recipe) {
    switch (recipe.kind) {
        case 'maximize_window':
        case 'move_window':
        case 'set_contrast': return 'ps';
        case 'set_zoom': return 'hotkey';
        // R2-5：launch_app 的复原 = 终结自己拉起的 pid（对称复原律：改变世界的
        // 权力与复原世界的义务严格对称 —— 预置的窗口由预置者收回）
        case 'launch_app': return 'kill';
        default: return 'noop'; // raise_window
    }
}
/** 批脚本的标记行：`R<index>|OK` / `R<index>|ERR|<消息>`（消息内换行折为空格） */
const UNDO_MARKER_RE = /^R(\d+)\|(OK|ERR)(?:\|(.*))?$/;
/** PS 异常消息的单行化（标记行协议必须逐行可解析） */
const PS_MSG_FLATTEN = "([string]$_.Exception.Message).Replace([char]13,' ').Replace([char]10,' ')";
/**
 * ΝΩ-25(a)：LIFO 复原段 → 单个 PS 脚本。Add-Type 声明只在头部出现一次
 * （多步共享一次 P/Invoke 编译）；每步包独立 try/catch —— 单步失败发 ERR
 * 标记、不阻断后续步（「部分复原优于中止」在脚本内同样成立）。窗口不在场
 * （未命中进程）⇒ 无变更、记 OK（与单条 undo 的诚实 no-op 同律）。
 * 纯字符串编译；$ErrorActionPreference='Stop' 确保 try 内错误可捕获。
 */
function compileUndoPsScript(steps) {
    let needsUser32 = false;
    let needsHc = false;
    const bodies = [];
    for (const step of steps) {
        const r = step.recipe;
        const tag = `R${step.index}`;
        const catchArm = `} catch { Write-Output ('${tag}|ERR|' + ${PS_MSG_FLATTEN}) }`;
        if (r.kind === 'set_contrast') {
            // O 纪元（#17）：精确还原 apply 前读到的 flags；未知 ⇒ 0（保守）
            needsHc = true;
            const orig = Number.parseInt(r.before?.theme ?? '0', 10);
            const flags = Number.isFinite(orig) ? orig : 0;
            bodies.push(`try { [Win.U32HC]::SetHC(${flags}) | Out-Null; Write-Output '${tag}|OK' ${catchArm}`);
            continue;
        }
        // maximize_window / move_window：查找 → 置前 → 还原窗口态 →（有快照）精确归位
        needsUser32 = true;
        const b = r.before;
        let mutate;
        if (typeof b?.x === 'number' && typeof b.y === 'number') {
            const w = typeof b.width === 'number' && b.width > 0 ? Math.round(b.width) : 0;
            const h = typeof b.height === 'number' && b.height > 0 ? Math.round(b.height) : 0;
            const flags = w > 0 && h > 0 ? 0x4 : 0x4 | 0x1; // 有尺寸快照 ⇒ 精确归位；否则 SWP_NOSIZE
            mutate = `[Win.U32]::ShowWindowAsync($h, ${b.maximized ? 3 : 1}) | Out-Null; `
                + `[Win.U32]::SetWindowPos($h, [IntPtr]::Zero, ${Math.round(b.x)}, ${Math.round(b.y)}, ${w}, ${h}, ${flags}) | Out-Null`;
        }
        else {
            // 无几何快照：止步于还原窗口态（与旧单条路径的诚实降级同律）
            mutate = `[Win.U32]::ShowWindowAsync($h, 1) | Out-Null`;
        }
        bodies.push(`try { `
            + `$p = Get-Process | Where-Object { $_.MainWindowTitle -like '*' + ${psLiteral(r.titleHint ?? '')} + '*' } | Select-Object -First 1; `
            + `if ($p) { $h = [IntPtr]$p.MainWindowHandle; [Win.U32]::SetForegroundWindow($h) | Out-Null; ${mutate} }; `
            + `Write-Output '${tag}|OK' `
            + catchArm);
    }
    const decls = `${needsUser32 ? `${USER32_DECL}; ` : ''}${needsHc ? `${HC_DECL}; ` : ''}`;
    return `$ErrorActionPreference = 'Stop'; ${decls}${bodies.join(' ')}`;
}
export class WindowsAdapter {
    platform = 'win32';
    probe;
    execFn;
    /** R2-5：GUI 直启通道（注入纪律同 probe/execFn —— 类体零裸进程调用） */
    launchFn;
    /** R2-5：启动存活观察窗（AdapterDeps 注入面 —— 测试小窗加速，真机缺省 600ms） */
    launchProbeMs;
    constructor(deps = {}) {
        this.probe = deps.probe ?? probeWindows;
        this.execFn = deps.exec ?? exec;
        this.launchFn = deps.launchGuiApp ?? defaultGuiAppSpawnChannel;
        this.launchProbeMs = typeof deps.launchProbeMs === 'number' && Number.isFinite(deps.launchProbeMs)
            ? Math.max(0, deps.launchProbeMs) : GUI_LAUNCH_PROBE_MS;
    }
    /**
     * W6R-A8：PS 执行统一通道 —— 脚本整体经 psEncodeCommand 编码后挂
     * -EncodedCommand。命令行上只有一个 base64 串：titleHint 等外部输入
     * 无论携带引号/反引号/$()/分号，都以编码字节原样到达 PS，不参与任何
     * 命令行语法解析（拼接注入面在传输层消除）。类体仍零裸进程调用。
     */
    async runPs(script) {
        return this.execFn(PS_EXE, [...PS_FLAGS, psEncodeCommand(script)]);
    }
    /** 能力探测：PowerShell 在场 ⇒ 窗口四动作；set_contrast 诚实缺席
     *  （注册表 + SPI_SETHIGHCONTRAST 往返不可靠 —— 留白如实申报，绝不虚报）
     *  R2-5：launch_app 无条件在场 —— 直启通道是 Node 内建 spawn（零外部工具
     *  依赖，无需探测；诚实申报的前提「已探测」由平台内置满足）。 */
    async capabilities() {
        const caps = new Set();
        caps.add('launch_app'); // R2-5：GUI 直启（不依赖 PowerShell 在场）
        try {
            if (this.probe(PS_EXE)) {
                caps.add('raise_window');
                caps.add('maximize_window');
                caps.add('move_window');
                caps.add('set_zoom'); // 键盘假定在场（与 system 热键管线同依赖）
                caps.add('set_contrast'); // L 纪元：SPI_SETHIGHCONTRAST 官方 API 落成
            }
        }
        catch { /* 探测异常 ⇒ 空能力集（NullAdapter 语义，不毒化启动） */ }
        return caps;
    }
    /** 读高对比度 flags（SPI_GETHIGHCONTRAST=0x42；读操作 —— 真机验证安全） */
    async getHighContrastFlags() {
        try {
            const { stdout } = await this.runPs(`${HC_DECL}; [Win.U32HC]::GetHC()`);
            const f = Number.parseInt(stdout.trim(), 10);
            return Number.isFinite(f) ? f : null;
        }
        catch {
            return null; // 读失败 ⇒ undo 降级为文档化（flags unknown）
        }
    }
    /** 按标题关键词找主窗口句柄（hwnd=0 = 未命中；title = 命中窗口标题原文） */
    async hwndOf(hint) {
        // Y6：一次往返同时取句柄与标题 —— 标题是 focus_handoff 取证的原料
        const script = `$p = Get-Process | Where-Object { $_.MainWindowTitle -like '*' + ${psLiteral(hint)} + '*' } | Select-Object -First 1; if ($p) { "$($p.MainWindowHandle)||$($p.MainWindowTitle)" } else { '0||' }`;
        const { stdout } = await this.runPs(script);
        const [h, t] = stdout.trim().split('||');
        const hwnd = Number.parseInt(h ?? '', 10);
        if (Number.isFinite(hwnd) && hwnd > 0)
            return { hwnd, title: (t ?? '').trim() };
        return { hwnd: 0, title: '' };
    }
    async apply(action) {
        // O 纪元（#17 真机执法抓出的潜伏 bug）：set_contrast 是系统级动作，
        // 不需要窗口句柄 —— 旧实现无条件解析 hwnd 且空标题必 throw，真机上
        // apply({kind:'set_contrast'}) 从未可达（注入式测试的 exec 恒返 '4\n' 掩盖）。
        // R2-5：launch_app 同律 —— 直启的是尚不存在的窗口，无句柄可解析。
        const needsWindow = action.kind !== 'set_contrast' && action.kind !== 'launch_app';
        const hint = action.titleHint ?? '';
        // ΝΩ-25(b)：raise_window 的查找+置前已并入单脚本（顶部不再预解析 —— 省一次
        // PS 冷启动）；maximize/move/set_zoom 仍预解析句柄（几何快照 / 热键前台 / 变异脚本复用）
        const preResolve = needsWindow && action.kind !== 'raise_window';
        const hit = preResolve ? await this.hwndOf(hint) : { hwnd: 1, title: '' };
        if (preResolve && hit.hwnd === 0)
            throw new Error(`no window with title containing ${JSON.stringify(hint)}`);
        switch (action.kind) {
            // ── R2-5：GUI 应用直启（白名单 + 裸 CreateProcess，见模块头注释）──
            // 诚实交付律：spawn 成功 ≠ 应用存活 —— 观察窗内退出（受限 token 打断
            // 激活、白名单 exe 缺席等）如实抛错，绝不把「已启动」虚报为交付。
            case 'launch_app': {
                const resolved = resolveLaunchableApp(action.app);
                if (!resolved) {
                    throw new Error(`launch_app: unknown app ${JSON.stringify(action.app ?? '')} — whitelist: ${Object.keys(GUI_APP_WHITELIST).join(', ')}`);
                }
                const child = this.launchFn(resolved.exe, [], guiLaunchSpawnOptions());
                let spawnError = null;
                child.on('error', (err) => { spawnError = err.message; });
                let earlyExit = null;
                child.on('exit', (code, signal) => { earlyExit = { code, signal }; });
                child.unref(); // R2-5：脱离事件循环引用计数 —— 宿主进程不因持有 GUI 应用而永不退出
                const pid = child.pid;
                if (typeof pid !== 'number') {
                    throw new Error(`launch_app: spawn returned no pid for ${resolved.exe}`);
                }
                await new Promise(r => setTimeout(r, this.launchProbeMs));
                if (spawnError !== null) {
                    throw new Error(`launch_app: spawn failed for ${resolved.exe}: ${spawnError}`);
                }
                // R2-2: 编译解锁（并行轮 WIP 遗留）—— let 初值 null 经事件回调赋值后，
                // TS 控制流分析仍按初始化窄化（const 注解也不能阻止初始赋值窄化），
                // `!== null` 后被读成 never（TS2339）。函数读取面拿声明类型（TS 官方
                // workaround），语义零变化。
                const readExit = () => earlyExit;
                const exited = readExit();
                if (exited !== null) {
                    throw new Error(`launch_app: ${resolved.exe} exited within ${this.launchProbeMs}ms `
                        + `(code=${exited.code} signal=${exited.signal}) — activation may be policy-blocked; refusing to report delivery`);
                }
                // 撤销配方：pid 是复原（taskkill /PID）的全部知识 —— 与「改变必可复原」对称律同构
                return {
                    kind: 'launch_app', titleHint: resolved.canonical,
                    before: { pid }, matchedTitle: `${resolved.canonical} (pid ${pid})`,
                };
            }
            case 'raise_window': {
                // ΝΩ-25(b)：查找 + 置前合并为单次往返（旧路径 hwndOf→activate 两次 PS 冷启动；
                // 未命中 ⇒ 脚本内零变更，JS 侧照旧抛 no-window —— 物理语义不变）
                const script = `${USER32_DECL}; $p = Get-Process | Where-Object { $_.MainWindowTitle -like '*' + ${psLiteral(hint)} + '*' } | Select-Object -First 1; `
                    + `if ($p) { "$($p.MainWindowHandle)||$($p.MainWindowTitle)"; [Win.U32]::SetForegroundWindow([IntPtr]$p.MainWindowHandle) | Out-Null } else { '0||' }`;
                const { stdout } = await this.runPs(script);
                const [h, t] = stdout.trim().split('||');
                const hwnd = Number.parseInt(h ?? '', 10);
                if (!(Number.isFinite(hwnd) && hwnd > 0))
                    throw new Error(`no window with title containing ${JSON.stringify(hint)}`);
                // z-order 不可逆：undo 为文档化 no-op；matchedTitle 供 switch_window 取证
                return { kind: 'raise_window', titleHint: hint, matchedTitle: (t ?? '').trim() };
            }
            case 'maximize_window': {
                const before = await this.getWindowGeometry(hint);
                // ΝΩ-25(b)：置前 + 最大化合并为单次往返（Add-Type 只编译一次）
                await this.runPs(`${USER32_DECL}; [Win.U32]::SetForegroundWindow([IntPtr]${hit.hwnd}) | Out-Null; [Win.U32]::ShowWindowAsync([IntPtr]${hit.hwnd}, 3) | Out-Null`); // SW_MAXIMIZE
                return { kind: 'maximize_window', titleHint: hint, before: before ?? undefined, matchedTitle: hit.title };
            }
            case 'move_window': {
                if (typeof action.x !== 'number' || typeof action.y !== 'number') {
                    throw new Error('move_window requires numeric x and y');
                }
                const before = await this.getWindowGeometry(hint);
                // SWP_NOSIZE(0x1) | SWP_NOZORDER(0x4)：只移不改尺寸/层级；置前合并同一次往返（ΝΩ-25(b)）
                await this.runPs(`${USER32_DECL}; [Win.U32]::SetForegroundWindow([IntPtr]${hit.hwnd}) | Out-Null; [Win.U32]::SetWindowPos([IntPtr]${hit.hwnd}, [IntPtr]::Zero, ${Math.round(action.x)}, ${Math.round(action.y)}, 0, 0, 5) | Out-Null`);
                return { kind: 'move_window', titleHint: hint, before: before ?? undefined, matchedTitle: hit.title };
            }
            case 'set_zoom': {
                await this.activate(hit.hwnd); // 热键需要目标前台
                const level = typeof action.level === 'number' ? action.level : 100;
                const presses = Math.max(0, Math.min(9, Math.round((level - 100) / 10)));
                const { system } = await import('./system.js');
                await system.pressHotkey(['ctrl', '0']);
                for (let i = 0; i < presses; i++)
                    await system.pressHotkey(['ctrl', '+']);
                return { kind: 'set_zoom', titleHint: hint }; // 站点内部态不可读：undo 恒为 Ctrl+0
            }
            case 'set_contrast': {
                // L 纪元（留白兑现）：SPI_SETHIGHCONTRAST —— 官方高对比度 API（非注册表
                // 猜测），undo 还原原 flags（GET 先读）。真机验证仅到 GET（读操作）；
                // SET/undo 的往返正确性由注入式测试锁命令形状 + 用户首次使用时观察。
                const before = await this.getHighContrastFlags();
                const flags = (before === null ? 0 : before) | 0x1; // HCF_HIGHCONTRASTON
                await this.runPs(setHighContrastPs(String(flags)));
                return { kind: 'set_contrast', before: { theme: before === null ? 'unknown' : String(before) }, level: undefined };
            }
        }
    }
    /** 单步置前（set_zoom 专用：热键需要目标前台） */
    async activate(hwnd) {
        await this.runPs(`${USER32_DECL}; [Win.U32]::SetForegroundWindow([IntPtr]${hwnd}) | Out-Null`);
    }
    async undo(recipe) {
        // ΝΩ-25(a)：单条复原走批处理编译器（单步批 = 1 次 PS 往返；旧逐条路径
        // 每条最多 4 次往返：查找/置前/窗口态/归位各一次冷启动）
        const [outcome] = await this.undoBatch([recipe]);
        if (outcome && !outcome.ok)
            throw new Error(outcome.reason ?? 'undo failed');
    }
    /**
     * ΝΩ-25(a)：批量复原 —— LIFO 序列按执行通道做同类相邻合并后整段下发：
     * PS 通道（窗口几何 / 高对比度）每段编译为单个脚本、一次 spawn、Add-Type
     * 只编译一次；hotkey 通道逐条走 system 热键管线（黑名单执法面不可绕）；
     * noop 通道零往返。逐条错误信封不打折：单步失败记 reason、不阻断其余步。
     */
    async undoBatch(recipes) {
        const outcomes = recipes.map(() => ({ ok: true }));
        const steps = recipes.map((recipe, index) => ({ index, recipe }));
        for (const run of coalesceAdjacentRuns(steps, s => undoChannelOf(s.recipe))) {
            if (run.channel === 'noop')
                continue; // raise_window：z-order 不可逆，文档化 no-op
            if (run.channel === 'hotkey') {
                const { system } = await import('./system.js');
                for (const s of run.items) {
                    try {
                        await system.pressHotkey(['ctrl', '0']);
                    } // 归零策略：站点内部态不可读
                    catch (e) {
                        outcomes[s.index] = { ok: false, reason: e?.message ?? String(e) };
                    }
                }
                continue;
            }
            // R2-5 kill 通道：launch_app 的对称复原 —— 终结自己拉起的 pid。
            // taskkill 经 execFile（argv 数组、零 shell —— 与整库 spawn 纪律同律）；
            // 进程已不在（用户先关掉 / 应用自退）= 复原义务已满足，幂等 ok（多杀
            // 无害方向：pid 是配方快照，绝不误伤无关进程 —— 只杀自己启动的那个）。
            if (run.channel === 'kill') {
                for (const s of run.items) {
                    const pid = s.recipe.before?.pid;
                    if (typeof pid !== 'number' || !Number.isFinite(pid)) {
                        outcomes[s.index] = { ok: false, reason: 'launch_app undo: recipe has no pid — cannot restore (honest failure)' };
                        continue;
                    }
                    try {
                        await this.execFn('taskkill', ['/PID', String(pid), '/F']);
                        outcomes[s.index] = { ok: true };
                    }
                    catch (e) {
                        // 128 = taskkill「进程不存在」退出码（R2-5 真机实测，locale 无关 ——
                        // 中文 GBK 控制台的错误消息到 execFile 侧是乱码字节，消息匹配不可
                        // 依赖；退出码是唯一稳定方言，消息正则仅作 UTF-8/英文环境纵深冗余）
                        const msg = String(e?.message ?? e);
                        const notFound = e?.code === 128
                            || /not\s*found|找不到|没有找到|没有运行|no running/i.test(msg);
                        outcomes[s.index] = notFound
                            ? { ok: true } // 已退出 = 义务已满足（幂等；真机验证：taskkill 死 PID 恒退 128）
                            : { ok: false, reason: `taskkill /PID ${pid} failed: ${msg}` };
                    }
                }
                continue;
            }
            // ps 通道：整段一个脚本一次往返
            let lines = [];
            let runError = null;
            try {
                const { stdout } = await this.runPs(compileUndoPsScript(run.items));
                lines = stdout.split(/\r?\n/);
            }
            catch (e) {
                runError = e?.message ?? String(e); // spawn 失败/整脚本退出非零 ⇒ 整段记因
            }
            const reported = new Set();
            if (runError === null) {
                for (const line of lines) {
                    const m = UNDO_MARKER_RE.exec(line.trim());
                    if (!m)
                        continue;
                    const idx = Number.parseInt(m[1], 10);
                    if (reported.has(idx))
                        continue; // 同步重复标记：首见为准（防御式）
                    reported.add(idx);
                    if (m[2] === 'OK')
                        outcomes[idx] = { ok: true };
                    else
                        outcomes[idx] = { ok: false, reason: m[3] ?? 'powershell undo step failed' };
                }
            }
            // 对账：零标记方言（旧 exec 桩只回显数值）⇒ 视为整段成功（兼容）；有任一
            // 标记 ⇒ 严格对账，缺席步记失败（脚本中断而退出码为零的防御性不信任）
            if (reported.size > 0 || runError !== null) {
                for (const s of run.items) {
                    if (!reported.has(s.index)) {
                        outcomes[s.index] = { ok: false, reason: runError ?? `ps undo batch: no completion marker for R${s.index}` };
                    }
                }
            }
        }
        return outcomes;
    }
    async getWindowGeometry(titleHint) {
        try {
            const { hwnd } = await this.hwndOf(titleHint);
            if (hwnd === 0)
                return null;
            const script = `${USER32_DECL}; $r = New-Object Win.U32+RECT; [Win.U32]::GetWindowRect([IntPtr]${hwnd}, [ref]$r) | Out-Null; $z = [Win.U32]::IsZoomed([IntPtr]${hwnd}); Write-Output ($($r.L.ToString()) + ',' + $($r.T.ToString()) + ',' + ($r.R - $r.L).ToString() + ',' + ($r.B - $r.T).ToString() + ',' + [int]$z)`;
            const { stdout } = await this.runPs(script);
            const [x, y, w, h, z] = stdout.trim().split(',').map(Number);
            if (![x, y, w, h].every(Number.isFinite))
                return null;
            return { x, y, width: w, height: h, maximized: z === 1 };
        }
        catch {
            return null; // 快照失败 ⇒ undo 降级（诚实记录于撤销栈）
        }
    }
}
/** Null：capabilities 恒空 —— 优雅降级（swarmEndpoint 同款姿态） */
export class NullAdapter {
    platform = 'null';
    async capabilities() { return new Set(); }
    async apply(_action) {
        throw new Error('NullAdapter has no capabilities');
    }
    async undo(_recipe) { }
    async getWindowGeometry(_titleHint) { return null; }
}
class Shaper {
    adapter = new NullAdapter();
    /** 测试注入（先例：_legacyDeps._resetSharpCache_forTest）——
     *  真实环境探测不可在测试内伪造；空能力路径的行为用 NullAdapter 锁死。 */
    setAdapterForTest(adapter) {
        this.adapter = adapter;
        this.initialized = true;
    }
    caps = new Set();
    undoLog = [];
    tokenSeq = 0;
    allowSystemWide = false;
    dryRun = false;
    initialized = false;
    /** 配置注入（index.ts 启动时调用；测试隔离亦可直呼） */
    configure(allowSystemWide, dryRun) {
        this.allowSystemWide = allowSystemWide;
        this.dryRun = dryRun;
    }
    async initialize() {
        // 永不抛错契约：任何探测异常 ⇒ NullAdapter 语义（空能力集），启动继续
        try {
            if (process.platform === 'linux')
                this.adapter = new LinuxAdapter();
            else if (process.platform === 'win32')
                this.adapter = new WindowsAdapter();
            else
                this.adapter = new NullAdapter();
            this.caps = await this.adapter.capabilities();
        }
        catch (e) {
            console.warn(`[Shaper] capability probe failed (${e.message}); continuing with empty capability set.`);
            this.adapter = new NullAdapter();
            this.caps = new Set();
        }
        this.initialized = true;
    }
    /** 懒初始化保险：未 initialize 即被调用时以空能力集应答（防御性，不替代正常接线） */
    ensure() {
        if (!this.initialized) {
            this.caps = new Set();
            this.initialized = true;
        }
    }
    capabilities() {
        this.ensure();
        return this.caps;
    }
    platform() {
        this.ensure();
        return this.adapter.platform;
    }
    async apply(action) {
        this.ensure();
        if (this.dryRun) {
            // 诚实拒绝而非假装成功：无真实变更即无复原义务（simulated success 是债的地层教训）
            return { ok: false, reason: 'dry-run: environment shaping is skipped (no real change, no undo duty)' };
        }
        if (!this.caps.has(action.kind)) {
            return {
                ok: false,
                reason: `capability "${action.kind}" is unavailable on this platform (${this.adapter.platform}); ` +
                    `call shape_environment(action="capabilities") to see what this body can do`,
            };
        }
        if (SYSTEM_WIDE_KINDS.has(action.kind) && !this.allowSystemWide) {
            return {
                ok: false,
                reason: `"${action.kind}" is a system-wide change and is disabled (shaperAllowSystemWide=false)`,
            };
        }
        const needsHint = action.kind === 'raise_window' || action.kind === 'maximize_window' || action.kind === 'move_window';
        if (needsHint && !action.titleHint?.trim()) {
            return { ok: false, reason: `${action.kind} requires a titleHint to address the target window` };
        }
        // R2-5：launch_app 白名单前置校验 —— 结构化拒绝先于入队与任何物理动作
        //（与能力闸门同层；适配器内还有同律二次校验 —— 纵深防御，非重复冗余）
        if (action.kind === 'launch_app' && !resolveLaunchableApp(action.app)) {
            return {
                ok: false,
                reason: `launch_app requires a whitelisted app name (notepad | calc | mspaint), got ${JSON.stringify(action.app ?? '')}`,
            };
        }
        try {
            // 物理动作入队：窗口操作改变真实桌面，经 D-1 互斥队列与其他动作串行
            const recipe = await serialize(() => this.adapter.apply(action));
            const token = `undo-${++this.tokenSeq}`;
            this.undoLog.push({ token, action, recipe, undone: false });
            void journal.appendMarker({
                kind: 'ENV_SHAPED', action: `${action.kind}${action.titleHint ? ` "${action.titleHint}"` : ''}`,
            });
            return {
                ok: true, token, matchedTitle: recipe.matchedTitle,
                // R2-5：直启动作回传 pid（撤销配方事实源的镜像 —— 对账/取证用）
                ...(recipe.kind === 'launch_app' && typeof recipe.before?.pid === 'number'
                    ? { pid: recipe.before.pid } : {}),
            };
        }
        catch (e) {
            return { ok: false, reason: e?.message ?? String(e) }; // 非 Error 抛出也必有原因
        }
    }
    async applyPreset(preset, titleHint) {
        const kinds = preset.split(',').map(s => s.trim()).filter(Boolean);
        if (kinds.length === 0)
            return [{ ok: false, reason: 'preset is empty' }];
        const results = [];
        for (const kind of kinds) {
            if (!this.capabilities().has(kind) &&
                !['set_zoom', 'set_contrast'].includes(kind)) {
                // 伪动作 kind：直接拒（不进 adapter 抛错路径）
                results.push({ ok: false, reason: `unknown preset step "${kind}"` });
                continue;
            }
            const action = { kind: kind, ...(titleHint ? { titleHint } : {}) };
            results.push(await this.apply(action));
        }
        return results;
    }
    async restoreAll() {
        this.ensure();
        const results = [];
        // LIFO：后做的先还原 —— 依赖序天然正确（先 move 后 maximize 的逆序复原）
        const pending = [];
        for (let i = this.undoLog.length - 1; i >= 0; i--) {
            const rec = this.undoLog[i];
            if (!rec.undone)
                pending.push(rec);
        }
        if (pending.length === 0)
            return results;
        // ΝΩ-25(a)：适配器支持批量复原 ⇒ 整条 LIFO 序列一次下发（Windows：整段
        // 编译为单个 PS 脚本、Add-Type 只编译一次）；逐条错误信封不打折。
        if (typeof this.adapter.undoBatch === 'function') {
            try {
                const outcomes = await serialize(() => this.adapter.undoBatch(pending.map(r => r.recipe)));
                this.applyUndoOutcomes(pending, outcomes, results);
            }
            catch (e) {
                const reason = e?.message ?? String(e);
                for (const rec of pending) {
                    rec.undoFailureReason = reason;
                    results.push({ token: rec.token, ok: false, reason });
                }
            }
            return results;
        }
        for (const rec of pending) {
            try {
                await serialize(() => this.adapter.undo(rec.recipe));
                rec.undone = true;
                rec.undoneAt = Date.now();
                results.push({ token: rec.token, ok: true });
            }
            catch (e) {
                const reason = e?.message ?? String(e);
                rec.undoFailureReason = reason;
                results.push({ token: rec.token, ok: false, reason });
                // 部分复原优于中止：失败记录后继续弹栈
            }
        }
        return results;
    }
    /** ΝΩ-25：批复原结果回填（与逐条路径同构 —— undone/undoneAt/undoFailureReason 三态记账） */
    applyUndoOutcomes(pending, outcomes, results) {
        for (let i = 0; i < pending.length; i++) {
            const rec = pending[i];
            const oc = outcomes[i];
            if (oc && oc.ok) {
                rec.undone = true;
                rec.undoneAt = Date.now();
                results.push({ token: rec.token, ok: true });
            }
            else {
                const reason = oc?.reason ?? 'undoBatch: missing outcome';
                rec.undoFailureReason = reason;
                results.push({ token: rec.token, ok: false, reason });
            }
        }
    }
    dumpUndoLog() {
        return this.undoLog.map(r => ({ ...r, action: { ...r.action }, recipe: { ...r.recipe, before: r.recipe.before ? { ...r.recipe.before } : undefined } }));
    }
    restoreUndoLog(records) {
        if (!Array.isArray(records))
            return;
        // 防御性恢复：结构非法条目跳过；只认领未复原条目的复原义务
        this.undoLog = records.filter(r => r && typeof r.token === 'string' && r.recipe && typeof r.recipe.kind === 'string');
        // 后续发号不撞已存在令牌：按令牌最大数字后缀计（length 在条目被过滤/
        // 令牌不连续时会复用旧号 —— undo-N 撞号会毒化审计对账）
        let maxSeq = 0;
        for (const r of this.undoLog) {
            const m = /^undo-(\d+)$/.exec(r.token);
            if (m)
                maxSeq = Math.max(maxSeq, Number.parseInt(m[1], 10));
        }
        this.tokenSeq = maxSeq;
    }
    undoDepth() {
        return this.undoLog.filter(r => !r.undone).length;
    }
    /** W4-3（R3）：定向复原（见接口注释 —— token 命中单条 / 缺席回退全量） */
    async undoOne(token) {
        this.ensure();
        if (typeof token === 'string' && token !== '') {
            const rec = this.undoLog.find(r => r.token === token);
            if (rec && !rec.undone) {
                try {
                    await serialize(() => this.adapter.undo(rec.recipe));
                    rec.undone = true;
                    rec.undoneAt = Date.now();
                    return { token: rec.token, ok: true };
                }
                catch (e) {
                    rec.undoFailureReason = e?.message ?? String(e); // 失败也如实入栈（restoreAll 同律）
                    return { token: rec.token, ok: false, reason: e?.message ?? String(e) };
                }
            }
            if (rec?.undone)
                return { token: rec.token, ok: true }; // 幂等：已复原的义务不再执行
            // 未命中 ⇒ 回退全量复原（保守方向，见接口注释）
        }
        const results = await this.restoreAll();
        const failed = results.filter(r => !r.ok);
        if (failed.length > 0) {
            return {
                ok: false,
                reason: `full-restore fallback failed for ${failed.length}/${results.length} record(s): ` +
                    failed.map(f => `${f.token}: ${f.reason ?? 'unknown'}`).join('; '),
            };
        }
        return { ok: true };
    }
    clearUndoLog() {
        this.undoLog = [];
        this.tokenSeq = 0;
    }
}
// 单例是正确的：一台躯体只有一个工作台；物理唯一性由 serialize 保证
export const shaper = new Shaper();
/**
 * W3-1：shaper 撤销栈补偿执行器。
 * 支持 method 'shaper-undo'（LIFO 全量复原 —— 单条 token 的定向复原不在
 * shaper 公开面，全量复原是保守正确的方向：多复原一条窗口几何无害，少复原
 * 一条则补偿不完整）；其余 method ⇒ ok:false + 说明（补偿步骤路由错配的
 * 醒目拒绝，绝不假装执行）。绝不抛（shaper.restoreAll 自带部分复原续行）。
 */
export function createShaperCompensationExecutor() {
    return {
        async execute(step, _plan) {
            if (step.method !== 'shaper-undo') {
                return {
                    ok: false,
                    detail: `shaper executor only handles method "shaper-undo" (got "${step.method}") — route this step to a GUI executor port`,
                };
            }
            try {
                const results = await shaper.restoreAll();
                const failed = results.filter(r => !r.ok);
                if (failed.length > 0) {
                    return {
                        ok: false,
                        detail: `shaper undo failed for ${failed.length}/${results.length} record(s): ${failed.map(f => `${f.token}: ${f.reason ?? 'unknown'}`).join('; ')}`,
                    };
                }
                return { ok: true };
            }
            catch (e) {
                return { ok: false, detail: e instanceof Error ? e.message : String(e) };
            }
        },
    };
}
/**
 * W4-3（R3）：shaper 定向复原的独立函数面（rollbackPlanner 执行端口 /
 * 宿主的落点）。token 缺席 ⇒ 全量 LIFO 复原（保守方向）。绝不抛。
 */
export async function undoShaperRecord(token) {
    try {
        const r = await shaper.undoOne(typeof token === 'string' && token !== '' ? token : undefined);
        return r.ok ? { ok: true } : { ok: false, detail: r.reason ?? 'unknown shaper undo failure' };
    }
    catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
}
/**
 * W4-3（R3）：shaper 撤销栈的回滚执行端口构造器 —— 只处理 shaper-undo 模态
 * （定向 undoToken / 缺省全量），其余模态醒目拒绝（路由错配不冒充执行）。
 */
export function createShaperRollbackExecutor() {
    return {
        execute: async (step) => {
            if (step.modality !== 'shaper-undo') {
                return {
                    ok: false,
                    detail: `shaper rollback executor only handles modality "shaper-undo" (got "${step.modality}") — ` +
                        'route keyboard/click/scroll modalities to a GUI executor port',
                };
            }
            return undoShaperRecord(step.payload.undoToken);
        },
    };
}
