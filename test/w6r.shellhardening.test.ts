// test/w6r.shellhardening.test.ts
// W6R-A8：shell 启动面加固的执法测试（两处 —— 防御式、永不抛）。
//   1. system.openUrl（win32）：rundll32 url.dll,FileProtocolHandler 数组参数
//      通道 —— URL 含 %VAR%、&、|、" 等攻击字符时不经任何 shell 解释
//      （无 cmd.exe、无 /c、无手工引号、无 windowsVerbatimArguments）；
//      rundll32 启动失败回退 explorer.exe，回退同样数组形态（不比主通道宽）。
//   2. WindowsAdapter：powershell -EncodedCommand —— 命令行上只有 base64 载荷，
//      外部输入（titleHint）零字面出现；psEncodeCommand 纯函数解码回原文一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { system, _setOpenUrlSpawnForTest } from '../src/system.ts';
import { WindowsAdapter, psEncodeCommand } from '../src/environmentShaper.ts';

// ─── W6R-1/2：openUrl win32 通道（注入假 spawn 捕获启动参数）───

/** 假 spawn：捕获 (cmd, args, opts) 并可手动触发 'error'（模拟 rundll32 缺席） */
interface Launch { cmd: string; args: string[]; opts: Record<string, unknown>; errorCbs: Array<(e: Error) => void> }
function fakeSpawnFactory() {
  const launches: Launch[] = [];
  const spawn = (cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
    const rec: Launch = { cmd, args: [...args], opts, errorCbs: [] };
    launches.push(rec);
    return {
      on: (_ev: string, cb: (e: Error) => void) => { rec.errorCbs.push(cb); },
      unref: () => { /* fire-and-forget 半边照走 */ },
    };
  };
  return { launches, spawn };
}

test('W6R-1: openUrl win32 —— rundll32 数组参数，URL 攻击字符零 shell 解释', async () => {
  if (process.platform !== 'win32') return; // 本组执法绑定 win32 分支（其余分支未动）
  // 注入用例：环境变量引用（%PATH%/%COMSPEC%）、cmd 元字符（& | > ,）、
  // 双引号（旧实现会剥除）、^ 转义符 —— 旧 cmd /c start 通道里这些都是解释面
  const url = 'https://example.com/a?x=%PATH%&y=1|2&z=3>4&q=a,b&qu="quoted"^&c=%COMSPEC%';
  const { launches, spawn } = fakeSpawnFactory();
  _setOpenUrlSpawnForTest(spawn as never);
  try {
    const r = await system.openUrl(url);
    assert.equal(r.method, 'rundll32:FileProtocolHandler', '新通道回执');
    assert.equal(launches.length, 1, 'fire-and-forget：只发一次启动');
    const l = launches[0];
    assert.equal(l.cmd, 'rundll32.exe', '不经 cmd.exe');
    assert.deepEqual(l.args, ['url.dll,FileProtocolHandler', url],
      'URL 原样占据独立 argv 元素（无引号包裹、无变量展开、无字符剥除）');
    assert.ok(!l.args.includes('/c') && !l.args.includes('start') && !l.args.includes('""'),
      '无 cmd /c start 语法残留');
    assert.notEqual(l.opts.windowsVerbatimArguments, true,
      '关闭 verbatim —— argv 引用交给 spawn 数组语义，不再手工拼引号');
    assert.equal(l.opts.detached, true);
    assert.equal(l.opts.stdio, 'ignore');
    // 注入字符逐字核验：未被展开 / 转义 / 剥除（数组 argv = 数据不是语法）
    assert.ok(l.args[1].includes('%PATH%') && l.args[1].includes('%COMSPEC%'), '环境变量名不展开');
    assert.ok(l.args[1].includes('&') && l.args[1].includes('|') && l.args[1].includes('>'), 'cmd 元字符不解释');
    assert.ok(l.args[1].includes('"quoted"'), '双引号原样保留（旧实现会剥引号）');
    assert.ok(l.args[1].includes('^'), '^ 转义符原样保留');
  } finally {
    _setOpenUrlSpawnForTest(null); // 复位真实通道（测试隔离铁律）
  }
});

test('W6R-2: openUrl 回退 —— rundll32 启动失败 ⇒ explorer.exe 数组参数（回退不比主通道宽）', async () => {
  if (process.platform !== 'win32') return;
  const url = 'https://example.com/?q=%TEMP%&x="a|b"';
  const { launches, spawn } = fakeSpawnFactory();
  _setOpenUrlSpawnForTest(spawn as never);
  try {
    await system.openUrl(url);
    assert.equal(launches.length, 1);
    // 模拟异步 'error' 事件（ENOENT：rundll32 缺席）
    for (const cb of [...launches[0].errorCbs]) cb(new Error('spawn rundll32.exe ENOENT'));
    assert.equal(launches.length, 2, '恰好一次安全回退');
    const fb = launches[1];
    assert.equal(fb.cmd, 'explorer.exe', '回退走 explorer.exe');
    assert.deepEqual(fb.args, [url], '回退同样数组参数 —— URL 原样、无 shell 拼接');
    assert.notEqual(fb.opts.windowsVerbatimArguments, true, '回退也不开 verbatim');
    // 回退自身的 error 也被吞掉（永不炸宿主），且不再级联
    for (const cb of [...fb.errorCbs]) cb(new Error('spawn explorer.exe ENOENT'));
    assert.equal(launches.length, 2, '回退失败封崩溃面，无第二次级联');
  } finally {
    _setOpenUrlSpawnForTest(null);
  }
});

test('W6R-2b: openUrl 测试缝防御式 —— 注入非函数按 null（真实通道）处理', () => {
  // 永不抛契约：坏注入不得让后续调用走假通道或崩在 setter 里
  _setOpenUrlSpawnForTest(undefined as never);
  _setOpenUrlSpawnForTest(null);
});

// ─── W6R-3/4：WindowsAdapter -EncodedCommand 通道 ───

test('W6R-3: psEncodeCommand 纯函数 —— 解码回原文一致（含中文/引号/反引号/$()/元字符）', () => {
  const backtick = String.fromCharCode(96); // 反引号（模板串里书写易误读，显式构造）
  const samples = [
    '',
    'Write-Output 1',
    "$p = Get-Process | Where-Object { $_.MainWindowTitle -like '*' + 'O''Brien' + '*' }",
    "x'; Start-Process calc; #" + backtick + '$(whoami)&|<>^%" ',
    '窗口标题中文引号「」『』与 emoji 🪟 —— UTF-16LE 全量字符域',
  ];
  for (const s of samples) {
    const enc = psEncodeCommand(s);
    assert.match(enc, /^[A-Za-z0-9+/]*={0,2}$/,
      '载荷纯 base64 —— 空格/引号/反引号/元字符不可能出现在命令行');
    assert.equal(Buffer.from(enc, 'base64').toString('utf16le'), s, '解码回原文一致');
  }
});

test('W6R-4: WindowsAdapter 执行通道 —— -EncodedCommand + 命令行零外部输入字面', async () => {
  const seen: Array<{ cmd: string; args: string[] }> = [];
  const a = new WindowsAdapter({
    probe: () => true,
    exec: async (cmd, args) => {
      seen.push({ cmd, args: [...args] });
      const last = String(args[args.length - 1]);
      const script = args.includes('-EncodedCommand')
        ? Buffer.from(last, 'base64').toString('utf16le')
        : last;
      if (script.includes('MainWindowHandle')) return { stdout: '4242\n' };
      if (script.includes('GetWindowRect')) return { stdout: '10,20,300,200,0\n' };
      return { stdout: 'True\n' };
    },
  });
  // titleHint 携带注入串：旧 -Command 通道里这是待闭合的拼接面（psLiteral
  // 兜着，但脆弱）；新通道的命令行上不允许出现它的任何字面片段
  const evil = 'x\'; Start-Process calc; #' + String.fromCharCode(96) + '$env:PATH & | < > " %PATH%';
  await a.apply({ kind: 'raise_window', titleHint: evil });
  await a.apply({ kind: 'move_window', titleHint: evil, x: 5, y: 6 });
  assert.ok(seen.length >= 3, `窗口动作均经执行通道（实际 ${seen.length} 次调用）`);
  for (const { cmd, args } of seen) {
    assert.equal(cmd, 'powershell', '命令名不变');
    assert.ok(args.includes('-EncodedCommand'), 'EncodedCommand 通道在场');
    assert.ok(!args.includes('-Command'), '旧 -Command 拼接通道退役');
    const payload = String(args[args.indexOf('-EncodedCommand') + 1]);
    assert.match(payload, /^[A-Za-z0-9+/]*={0,2}$/, '载荷纯 base64（无空格/引号/元字符）');
    // 命令行上不得出现注入片段字面（% 与引号/空格/连字符组合不在 base64 字母表内）
    assert.ok(!args.some(x => x.includes('%PATH%')), '环境变量引用不落命令行');
    assert.ok(!args.some(x => x.includes("x'; Start-Process")), '注入语句不落命令行');
    // 载荷解码回脚本：外部输入仍经 psLiteral 单引号律转义（纵深防御保留，语义不丢）
    const script = Buffer.from(payload, 'base64').toString('utf16le');
    if (script.includes('MainWindowHandle')) {
      assert.ok(script.includes(`'${evil.replace(/'/g, "''")}'`),
        '脚本内 hint 仍经单引号律转义（EncodedCommand 之上保留纵深防御）');
    }
  }
});

test('W6R-4b: 源码守卫 —— runPs 是 PS 执行唯一出口（无 -Command 拼接残留）', async () => {
  const { readFileSync } = await import('fs');
  const src = readFileSync(new URL('../src/environmentShaper.ts', import.meta.url), 'utf8');
  assert.ok(src.includes("'-EncodedCommand'"), 'PS_FLAGS 已切换 EncodedCommand');
  assert.ok(!src.includes("'-Command'"), '旧 -Command 通道退役');
  // genesis.premature-impl 注入纪律：类体零裸进程调用（runPs 内经 this.execFn）
  const start = src.indexOf('class WindowsAdapter');
  const block = src.slice(start, src.indexOf('export class', start + 10));
  assert.ok(/this\.(execFn|probe)/.test(block), '类体执行仍经 AdapterDeps 注入');
});
