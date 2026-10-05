// test/r25.launchApp.test.ts
// R2-5 执法测试：GUI 应用直启面（沙箱 pwsh 启动 GUI 应用秒死问题的修复）。
// 病根（R1-8 遗留②，本机四联探针定性，证据见 .survey/practice/R2-5.md）：
//   ① Windows libuv 给每个非 detached 子进程挂 kill-on-close 作业对象 ——
//      pwsh 工具调用进程树被收割时，经 pwsh/.NET Process.Start 产生的 GUI
//      孙代一并被杀（job 连坐）；
//   ② 唯一逃逸口 Start-Process 走 ShellExecute/UWP 打包激活代理 —— 宿主受
//      限 token 下该路径断裂（R1-8 实测 Start-Process 型全死、bash 直 exec 活）。
// 修法：白名单 + 裸 CreateProcess 直启（detached + stdio ignore + shell false）。
// 本文件全离线确定性：spawn 经 AdapterDeps 注入假通道 —— 零真进程、零 GUI。
// 覆盖面：
//   1. guiLaunchSpawnOptions 四不变量（spawn 语义纯函数面 —— 单测钉死：
//      detached 作业逃逸 / stdio ignore 零管道 / shell false 零注入面 /
//      windowsHide false GUI 可见）；
//   2. resolveLaunchableApp 白名单闭集（结构性拒绝任意命令注入）；
//   3. WindowsAdapter.apply('launch_app')：happy/白名单拒/秒退拒/spawn 错拒
//      （诚实交付律：spawn 成功 ≠ 应用存活）；
//   4. WindowsAdapter.undoBatch kill 通道（taskkill argv 形状 + 幂等语义）；
//   5. capabilities 诚实申报（PS 缺席时 launch_app 仍在场 —— 零外部工具依赖）；
//   6. Shaper 层：pid 回传/撤销账本/能力闸门/白名单前置拒绝/restoreAll 复原；
//   7. 工具层：launch_app 话术与失败信封。
// 加固不回退锚点：本通道零 PowerShell 零 cmd —— W6R-A8（-EncodedCommand 律）
// 与 sec.cmd-shell 注入面在新增路径上根本不存在（见测试 1 的 shell:false 断言）。
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  WindowsAdapter,
  resolveLaunchableApp,
  guiLaunchSpawnOptions,
  GUI_LAUNCH_PROBE_MS,
  shaper,
  type AdapterDeps,
  type GuiAppSpawnChannel,
  type ShaperActionKind,
} from '../src/environmentShaper.ts';

// ── 假件：直启通道（记录调用形状，可编程触发 error/exit）──

interface FakeChild {
  pid: number | undefined;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void): unknown;
  unref(): void;
}

function makeFakeChannel(opts: {
  pid?: number;
  emitError?: Error;
  emitExit?: { code: number | null; signal: string | null };
} = {}) {
  const calls: Array<{ exe: string; args: readonly string[]; opts: unknown }> = [];
  const unreffed: boolean[] = [];
  const channel = ((exe: string, args: readonly string[], spawnOpts: unknown): FakeChild => {
    calls.push({ exe, args, opts: spawnOpts });
    const errCbs: Array<(e: Error) => void> = [];
    const exitCbs: Array<(c: number | null, s: string | null) => void> = [];
    const child: FakeChild = {
      pid: 'pid' in opts ? opts.pid : 4242, // 显式 undefined 保留（模拟 spawn 失败无 pid）
      on: ((event: string, cb: never) => {
        if (event === 'error') errCbs.push(cb as unknown as (e: Error) => void);
        if (event === 'exit') exitCbs.push(cb as unknown as (c: number | null, s: string | null) => void);
        return child;
      }) as FakeChild['on'],
      unref: () => { unreffed.push(true); },
    };
    // 可编程事件：下一微任务投递（模拟 node 异步 'error'/'exit' 事件）
    if (opts.emitError) {
      const e = opts.emitError;
      queueMicrotask(() => { for (const cb of errCbs) cb(e); });
    }
    if (opts.emitExit) {
      const x = opts.emitExit;
      queueMicrotask(() => { for (const cb of exitCbs) cb(x.code, x.signal); });
    }
    return child;
  }) as GuiAppSpawnChannel;
  return { channel, calls, unreffed };
}

/** exec 桩：记录 argv；可编程按子串匹配抛错（taskkill 演练用；code 可配置 —— 真机方言：退出码 128） */
function makeExecStub(failures: Array<{ match: string; message: string; code?: number }> = []) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec = async (cmd: string, args: string[]): Promise<{ stdout: string }> => {
    calls.push({ cmd, args });
    for (const f of failures) {
      if (`${cmd} ${args.join(' ')}`.includes(f.match)) {
        throw Object.assign(new Error(f.message), { code: f.code ?? 1 });
      }
    }
    return { stdout: '' };
  };
  return { exec, calls };
}

/** WindowsAdapter 快装：假通道 + exec 桩 + 5ms 观察窗（测试加速） */
function makeAdapter(chanOpts: Parameters<typeof makeFakeChannel>[0] = {}, execFailures: Parameters<typeof makeExecStub>[0] = []) {
  const chan = makeFakeChannel(chanOpts);
  const ex = makeExecStub(execFailures);
  const adapter = new WindowsAdapter({
    launchGuiApp: chan.channel,
    launchProbeMs: 5,
    exec: ex.exec,
    probe: () => false, // PS 缺席：隔离 launch_app 的零外部依赖性
  } satisfies AdapterDeps);
  return { adapter, chan, ex };
}

// ── 1. spawn 语义纯函数面 ──

test('R2-5 guiLaunchSpawnOptions: 四不变量 —— detached 逃逸 job / 零管道 / 零 shell / GUI 可见', () => {
  const o = guiLaunchSpawnOptions();
  assert.equal(o.detached, true, 'detached=true：逃出 libuv kill-on-close 作业（探针 M3 语义）');
  assert.equal(o.stdio, 'ignore', 'stdio=ignore：不持任何管道句柄');
  assert.equal(o.shell, false, 'shell=false：命令行零 shell 解析点（注入面传输层不存在）');
  assert.equal(o.windowsHide, false, 'windowsHide=false：启动的是给视觉管线看的窗口');
  assert.equal(Object.isFrozen(o), true, '冻结对象：调用方不可篡改语义');
});

test('R2-5 guiLaunchSpawnOptions: 纯函数 —— 重复调用同值（零外部状态）', () => {
  assert.deepEqual(guiLaunchSpawnOptions(), guiLaunchSpawnOptions());
  assert.equal(GUI_LAUNCH_PROBE_MS, 600, '缺省观察窗 600ms（战报对账窗口的单一事实源）');
});

// ── 2. 白名单闭集 ──

test('R2-5 resolveLaunchableApp: 白名单命中（大小写/后缀/空白容差）', () => {
  assert.deepEqual(resolveLaunchableApp('notepad'), { canonical: 'notepad', exe: 'notepad.exe' });
  assert.deepEqual(resolveLaunchableApp('  NOTEPAD '), { canonical: 'notepad', exe: 'notepad.exe' });
  assert.deepEqual(resolveLaunchableApp('Notepad.exe'), { canonical: 'notepad', exe: 'notepad.exe' });
  assert.deepEqual(resolveLaunchableApp('paint'), { canonical: 'paint', exe: 'mspaint.exe' });
  assert.deepEqual(resolveLaunchableApp('calc'), { canonical: 'calc', exe: 'calc.exe' });
});

test('R2-5 resolveLaunchableApp: 闭集外结构性拒绝（任意命令/路径/参数注入面不存在）', () => {
  assert.equal(resolveLaunchableApp('cmd'), null, 'cmd 不是 GUI 白名单成员');
  assert.equal(resolveLaunchableApp('notepad calc'), null, '参数拼接拒绝');
  assert.equal(resolveLaunchableApp('notepad&calc'), null, 'shell 元字符拒绝');
  assert.equal(resolveLaunchableApp('C:\\Windows\\System32\\notepad.exe'), null, '路径形态拒绝（只认键名）');
  assert.equal(resolveLaunchableApp(''), null);
  assert.equal(resolveLaunchableApp(undefined), null);
  assert.equal(resolveLaunchableApp(42), null);
  assert.equal(resolveLaunchableApp(null), null);
});

// ── 3. WindowsAdapter.apply('launch_app') ──

test('R2-5 adapter.apply: 直启白名单 exe —— 裸 argv + 语义选项 + pid 入撤销配方', async () => {
  const { adapter, chan } = makeAdapter();
  const recipe = await adapter.apply({ kind: 'launch_app', app: 'notepad' });
  assert.equal(recipe.kind, 'launch_app');
  assert.deepEqual(recipe.before, { pid: 4242 }, 'pid 是撤销（taskkill /PID）的全部知识');
  assert.equal(recipe.titleHint, 'notepad');
  assert.match(recipe.matchedTitle ?? '', /\(pid 4242\)/);
  // spawn 形状执法：exe 白名单解析结果、零参数、语义选项逐位同 guiLaunchSpawnOptions
  assert.equal(chan.calls.length, 1);
  assert.equal(chan.calls[0]!.exe, 'notepad.exe');
  assert.deepEqual(chan.calls[0]!.args, []);
  assert.deepEqual(chan.calls[0]!.opts, guiLaunchSpawnOptions());
  assert.equal(chan.unreffed.length, 1, 'unref：宿主进程不因持有 GUI 应用而永不退出');
});

test('R2-5 adapter.apply: 白名单外目标 —— 结构化拒绝且零 spawn（先于任何物理动作）', async () => {
  const { adapter, chan } = makeAdapter();
  await assert.rejects(
    adapter.apply({ kind: 'launch_app', app: 'cmd /c evil' }),
    /unknown app .*whitelist: notepad/u,
  );
  assert.equal(chan.calls.length, 0, '拒绝先于 spawn —— 无部分执行');
});

test('R2-5 adapter.apply: 观察窗内秒退 —— 诚实拒绝（spawn 成功≠交付；受限 token 激活断裂的战报形态）', async () => {
  const { adapter } = makeAdapter({ emitExit: { code: -1073741515, signal: null } });
  await assert.rejects(
    adapter.apply({ kind: 'launch_app', app: 'notepad' }),
    /exited within .*refusing to report delivery/u,
  );
});

test('R2-5 adapter.apply: spawn 错误（如 ENOENT）—— 诚实拒绝', async () => {
  const { adapter } = makeAdapter({ emitError: new Error('spawn ENOENT') });
  await assert.rejects(
    adapter.apply({ kind: 'launch_app', app: 'mspaint' }),
    /spawn failed .*ENOENT/u,
  );
});

test('R2-5 adapter.apply: spawn 无 pid —— 诚实拒绝（拒绝把不可对账的启动报成交付）', async () => {
  const { adapter } = makeAdapter({ pid: undefined });
  await assert.rejects(
    adapter.apply({ kind: 'launch_app', app: 'calc' }),
    /spawn returned no pid/u,
  );
});

// ── 4. undoBatch kill 通道 ──

test('R2-5 undoBatch: taskkill /PID <pid> /F —— argv 数组形状（零 shell）+ ok 回执', async () => {
  const { adapter, ex } = makeAdapter();
  await adapter.apply({ kind: 'launch_app', app: 'notepad' });
  const outcomes = await adapter.undoBatch([{ kind: 'launch_app', titleHint: 'notepad', before: { pid: 4242 } }]);
  assert.deepEqual(outcomes, [{ ok: true }]);
  assert.equal(ex.calls.length, 1);
  assert.equal(ex.calls[0]!.cmd, 'taskkill');
  assert.deepEqual(ex.calls[0]!.args, ['/PID', '4242', '/F'], 'argv 数组直达 execFile —— 命令行零拼接解析点');
});

test('R2-5 undoBatch: 进程已退出 = 复原义务已满足（幂等 ok —— 用户先关/应用自退）', async () => {
  const { adapter, ex } = makeAdapter({}, [{ match: 'taskkill', message: '错误: 没有运行的任务匹配指定标准。 (128)' }]);
  await adapter.apply({ kind: 'launch_app', app: 'notepad' });
  const outcomes = await adapter.undoBatch([{ kind: 'launch_app', titleHint: 'notepad', before: { pid: 4242 } }]);
  assert.equal(outcomes[0]!.ok, true, 'not-found 方言 = 已满足');
  assert.equal(ex.calls.length, 1);
});

test('R2-5 undoBatch: GBK 乱码消息 + 退出码 128 —— 退出码方言兜底（真机实锤场景）', async () => {
  // 真机验证实录：中文 GBK 控制台的「没有找到进程」到 execFile 侧已成乱码字节，
  // 消息正则不可依赖 —— 退出码 128（taskkill 死 PID 的 locale 无关方言）是唯一稳定判据
  const { adapter } = makeAdapter({}, [{ match: 'taskkill', message: '锟斤拷锟斤拷: 没锟斤拷锟斤拷 "4242"', code: 128 }]);
  const outcomes = await adapter.undoBatch([{ kind: 'launch_app', titleHint: 'notepad', before: { pid: 4242 } }]);
  assert.equal(outcomes[0]!.ok, true, 'code=128 ⇒ 幂等 ok（消息乱码无关）');
});

test('R2-5 undoBatch: taskkill 真失败 —— 错误信封不打折（ok:false + reason）', async () => {
  const { adapter } = makeAdapter({}, [{ match: 'taskkill', message: 'access denied' }]);
  const outcomes = await adapter.undoBatch([{ kind: 'launch_app', titleHint: 'notepad', before: { pid: 4242 } }]);
  assert.equal(outcomes[0]!.ok, false);
  assert.match(outcomes[0]!.reason ?? '', /taskkill \/PID 4242 failed/u);
});

test('R2-5 undoBatch: 配方无 pid —— 诚实失败（绝不盲杀）', async () => {
  const { adapter, ex } = makeAdapter();
  const outcomes = await adapter.undoBatch([{ kind: 'launch_app', titleHint: 'notepad' }]);
  assert.equal(outcomes[0]!.ok, false);
  assert.match(outcomes[0]!.reason ?? '', /no pid/u);
  assert.equal(ex.calls.length, 0, '无 pid ⇒ 零 taskkill —— 拒绝无对账的杀');
});

// ── 5. capabilities 诚实申报 ──

test('R2-5 capabilities: PS 缺席 ⇒ 仅 launch_app（零外部工具依赖的直启通道仍在场）', async () => {
  const { adapter } = makeAdapter();
  const caps = await adapter.capabilities();
  assert.ok(caps.has('launch_app'), '直启 = Node 内建 spawn：无条件在场（诚实申报）');
  assert.equal(caps.has('raise_window'), false, 'PS 缺席 ⇒ 窗口动作诚实缺席（既有语义零回归）');
});

// ── 6. Shaper 层（单例方言同 tools.shapeEnvironment.test.ts：假适配器 + caps 私注）──

function useWinAdapter(adapter: WindowsAdapter, caps: ShaperActionKind[]): void {
  shaper.setAdapterForTest(adapter);
  (shaper as unknown as { caps: ReadonlySet<ShaperActionKind> }).caps = new Set(caps);
}

beforeEach(() => {
  shaper.clearUndoLog();
  shaper.configure(false, false);
});

after(() => {
  shaper.clearUndoLog();
  shaper.configure(false, false);
  (shaper as unknown as { caps: ReadonlySet<ShaperActionKind> }).caps = new Set();
});

test('R2-5 shaper.apply: 成功 ⇒ pid 回传 + 撤销账本登记', async () => {
  const { adapter, ex } = makeAdapter();
  useWinAdapter(adapter, ['launch_app']);
  const r = await shaper.apply({ kind: 'launch_app', app: 'notepad' });
  assert.equal(r.ok, true);
  assert.equal(r.pid, 4242);
  assert.match(r.token ?? '', /^undo-\d+$/);
  assert.equal(shaper.undoDepth(), 1);
  // restoreAll ⇒ kill 通道终结自己拉起的 pid（对称复原律）
  const restored = await shaper.restoreAll();
  assert.equal(restored[0]!.ok, true);
  assert.equal(ex.calls.filter(c => c.cmd === 'taskkill').length, 1);
  assert.equal(shaper.undoDepth(), 0);
});

test('R2-5 shaper.apply: 白名单前置拒绝（结构化 reason，零 spawn）', async () => {
  const { adapter, chan } = makeAdapter();
  useWinAdapter(adapter, ['launch_app']);
  const r = await shaper.apply({ kind: 'launch_app', app: 'regedit' });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /whitelisted app name \(notepad \| calc \| mspaint\)/u);
  assert.equal(chan.calls.length, 0);
  assert.equal(shaper.undoDepth(), 0, '拒绝不产生复原义务');
});

test('R2-5 shaper.apply: 能力闸门先于白名单（caps 缺席 ⇒ 既有拒绝话术零回归）', async () => {
  const { adapter } = makeAdapter();
  useWinAdapter(adapter, []);
  const r = await shaper.apply({ kind: 'launch_app', app: 'notepad' });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /capability "launch_app" is unavailable/u);
});

// ── 7. 工具层 ──

type Exec = (a: unknown) => Promise<string>;
let toolExec: Exec | null = null;
let loadNote: string | null = null;
try {
  const mod = await import('../src/tools/shapeEnvironment.ts');
  toolExec = (mod.createShapeEnvironmentTool() as unknown as { execute: Exec }).execute;
} catch (e: unknown) {
  loadNote = `工具模块在 Node strip-types 运行时不可加载：${e instanceof Error ? e.message : String(e)}`;
}
const skipReason = loadNote ? { skip: loadNote } : {};

test('R2-5 工具层: launch_app 成功话术 —— pid + 存活语义 + 撤销指引', skipReason, async () => {
  const { adapter } = makeAdapter();
  useWinAdapter(adapter, ['launch_app']);
  const out = await toolExec!({ action: 'apply', kind: 'launch_app', app: 'notepad' });
  assert.match(out, /SUCCESS/u);
  assert.match(out, /pid 4242/u);
  assert.match(out, /survives this tool call/u);
  shaper.clearUndoLog();
});

test('R2-5 工具层: 白名单外 —— FAILED 信封带白名单指引（模型可自纠）', skipReason, async () => {
  const { adapter } = makeAdapter();
  useWinAdapter(adapter, ['launch_app']);
  const out = await toolExec!({ action: 'apply', kind: 'launch_app', app: 'evil.exe' });
  assert.match(out, /FAILED/u);
  assert.match(out, /notepad \| calc \| mspaint/u);
  shaper.clearUndoLog();
});
