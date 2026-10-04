// test/tools.openUrl.test.ts
// W6R-B7 补强：src/tools/openUrl.ts 工具层直测（此前零直接覆盖）。
// 全离线确定性：
//   · 安检阶梯（urlSense 纯函数分支经工具面暴露）：scheme 白名单 / 裸域名拒绝 /
//     OCR 自由文本提取 / 多候选结构化拒绝 / 空参拒绝；
//   · 正常路径回执：经 system._setOpenUrlSpawnForTest 注入假 spawn —— 工具 →
//     system.openUrl → rundll32 数组参数通道全链落网（启动面安全属性属工具契约
//     的一部分：URL 原样 argv、无 cmd /c）；
//   · 故障路径：system.openUrl 抛错（monkey-patch 可变对象字面量，先例
//     w1exec.test.ts patchSystem）→ 诚实 FAILED 回执 + 手工兜底指引。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { system, _setOpenUrlSpawnForTest } from '../src/system.ts';
import { createOpenUrlTool } from '../src/tools/openUrl.ts';

type Exec = (a: unknown) => Promise<string>;
const exec = (t: unknown): Exec => (t as unknown as { execute: Exec }).execute;

/** 假 spawn：捕获启动参数（同 w6r.shellhardening 的 fakeSpawnFactory 方言） */
interface Launch { cmd: string; args: string[]; opts: Record<string, unknown> }
function fakeSpawnFactory() {
  const launches: Launch[] = [];
  const spawn = (cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
    const rec: Launch = { cmd, args: [...args], opts };
    launches.push(rec);
    return {
      on: (_ev: string, _cb: (e: Error) => void) => rec, // 不触发 error：主通道成功
      unref: () => { /* fire-and-forget 半边照走 */ },
    };
  };
  return { launches, spawn };
}

/** system.openUrl monkey-patch（system 是可变对象字面量 —— 恢复器还原原样） */
function patchOpenUrl(fn: (url: string) => Promise<{ method: string }>): () => void {
  const host = system as unknown as Record<string, unknown>;
  const saved = host.openUrl;
  host.openUrl = fn;
  return () => { host.openUrl = saved; };
}

const tool = createOpenUrlTool({} as never);

test('open_url: 空白 url 拒绝 —— 结构化 FAILED 而非抛错', async () => {
  const out = JSON.parse(await exec(tool)({ url: '   ' }));
  assert.equal(out.status, 'FAILED');
  assert.equal(out.action, 'open_url validation failed.');
  assert.equal(out.state_anchor.error, 'Empty url argument.');
  assert.match(out.next_step, /Provide the URL/);
});

test('open_url: 非字符串 url 在协议层被拒（ToolArgsError）', async () => {
  await assert.rejects(
    exec(tool)({ url: 42 }),
    (e: Error) => {
      assert.match(e.constructor.name, /ToolArgsError/);
      return true;
    },
  );
});

test('open_url: scheme 白名单 —— file:// 拒绝且错误点名 allowlist', async () => {
  const out = JSON.parse(await exec(tool)({ url: 'file:///C:/Windows/system.ini' }));
  assert.equal(out.status, 'FAILED');
  assert.equal(out.action, 'open_url refused: URL validation failed.');
  assert.match(out.state_anchor.error, /scheme 'file:' outside allowlist \[http, https\]/);
  assert.match(out.next_step, /Only http\/https URLs are opened/);
});

test('open_url: scheme 白名单 —— javascript: 拒绝（不做事发协议启动器）', async () => {
  const out = JSON.parse(await exec(tool)({ url: 'javascript:alert(1)' }));
  assert.equal(out.status, 'FAILED');
  assert.match(out.state_anchor.error, /outside allowlist/);
});

test('open_url: scheme 白名单 —— data: 载荷拒绝', async () => {
  const out = JSON.parse(await exec(tool)({ url: 'data:text/plain;base64,SGVsbG8=' }));
  assert.equal(out.status, 'FAILED');
  assert.match(out.state_anchor.error, /scheme 'data:' outside allowlist/);
});

// ═ W8 归因精确性：scheme 拒因优先于字符拒因 ═
// 旧行为缺陷：data:text/html,<script>… 同时命中「scheme 白名单外」与「含尖
// 括号/空白」两个拒绝通道，字符安检在先 ⇒ state_anchor.error 报「字符噪声」
// —— 模型拿到错误的改正方向（清洗字符救不了 data:）。第一性拒因优先。

test('open_url: data: 带尖括号脚本 —— 归因报 scheme 而非字符（第一性拒因）', async () => {
  const out = JSON.parse(await exec(tool)({ url: 'data:text/html,<script>alert(1)</script>' }));
  assert.equal(out.status, 'FAILED');
  assert.match(out.state_anchor.error, /^scheme 'data:' outside allowlist \[http, https\]/);
});

test('open_url: javascript: 带引号载荷 —— 归因报 scheme', async () => {
  const out = JSON.parse(await exec(tool)({ url: "javascript:alert('x')" }));
  assert.equal(out.status, 'FAILED');
  assert.match(out.state_anchor.error, /^scheme 'javascript:' outside allowlist \[http, https\]/);
});

test('open_url: data: 带空白载荷 —— 归因报 scheme（清洗空白救不了 data:）', async () => {
  const out = JSON.parse(await exec(tool)({ url: 'data:text/html, hello world' }));
  assert.equal(out.status, 'FAILED');
  assert.match(out.state_anchor.error, /^scheme 'data:' outside allowlist \[http, https\]/);
});

test('open_url: 大写 DATA: 带尖括号 —— scheme 归一小写后仍报 scheme 拒因', async () => {
  const out = JSON.parse(await exec(tool)({ url: 'DATA:text/plain,<b>x</b>' }));
  assert.equal(out.status, 'FAILED');
  assert.match(out.state_anchor.error, /^scheme 'data:' outside allowlist \[http, https\]/);
});

test('open_url: file:// 路径含空格 —— 第一性拒因是 scheme 不是空格', async () => {
  const out = JSON.parse(await exec(tool)({ url: 'file:///C:/My Files/report.pdf' }));
  assert.equal(out.status, 'FAILED');
  assert.match(out.state_anchor.error, /^scheme 'file:' outside allowlist \[http, https\]/);
});

test('open_url: 合法 https 带空格且不可提取 —— 如实报字符原因（不误报 scheme）', async () => {
  // 'https://exa mple.com/x'：直判 whitespace/quotes 拒；自由文本提取的候选
  // 'https://exa' 又因无点主机被拒 ⇒ 零候选 ⇒ 拒因保持字符通道
  const out = JSON.parse(await exec(tool)({ url: 'https://exa mple.com/x' }));
  assert.equal(out.status, 'FAILED');
  assert.match(out.state_anchor.error, /^URL contains whitespace\/quotes \(text noise, not a link\)/);
});

test('open_url: 合法 https 带空格但可无损提取 —— 噪声容忍不改（提取单候选跳转）', async () => {
  if (process.platform !== 'win32') return; // spawn 注入缝只在 win32 分支生效
  const { launches, spawn } = fakeSpawnFactory();
  _setOpenUrlSpawnForTest(spawn as never);
  try {
    const out = JSON.parse(await exec(tool)({ url: 'https://example.com/a b' }));
    assert.equal(out.status, 'SUCCESS', '带尾随噪声词的 https 走提取通道，不是拒绝');
    assert.equal(out.state_anchor.url, 'https://example.com/a');
    assert.equal(launches[0]!.args[1], 'https://example.com/a');
  } finally {
    _setOpenUrlSpawnForTest(null);
  }
});

test('open_url: 裸域名拒绝 —— 无 scheme 无 www. 不猜（精确性优先）', async () => {
  const out = JSON.parse(await exec(tool)({ url: 'example.com/docs' }));
  assert.equal(out.status, 'FAILED');
  assert.match(out.state_anchor.error, /no scheme and no www\. prefix/);
  assert.match(out.next_step, /bare domains without a scheme are not guessed/);
});

test('open_url: 裸 https URL —— rundll32 数组参数通道 + 诚实回执（win32）', async () => {
  if (process.platform !== 'win32') return; // spawn 注入缝只在 win32 分支生效
  const { launches, spawn } = fakeSpawnFactory();
  _setOpenUrlSpawnForTest(spawn as never);
  try {
    const out = JSON.parse(await exec(tool)({ url: 'https://example.com/docs', reasoning: '查文档' }));
    assert.equal(out.status, 'SUCCESS');
    assert.equal(out.action, 'OS asked to open https://example.com/docs (via rundll32:FileProtocolHandler).');
    assert.equal(out.state_anchor.url, 'https://example.com/docs');
    assert.equal(out.state_anchor.transport, 'rundll32:FileProtocolHandler');
    assert.match(out.state_anchor.note, /fire-and-forget/, '回执不伪造「页面已加载」');
    assert.match(out.next_step, /take_screenshot/);
    // 工具契约携带启动面安全属性：数组 argv、URL 原样、无 cmd /c
    assert.equal(launches.length, 1);
    assert.equal(launches[0]!.cmd, 'rundll32.exe');
    assert.deepEqual(launches[0]!.args, ['url.dll,FileProtocolHandler', 'https://example.com/docs']);
    assert.ok(!launches[0]!.args.some(a => a.includes('/c') || a.includes('start')));
    assert.equal(launches[0]!.opts.detached, true);
    assert.equal(launches[0]!.opts.stdio, 'ignore');
  } finally {
    _setOpenUrlSpawnForTest(null);
  }
});

test('open_url: www. 前缀补全为 https（唯一被授权的猜测）', async () => {
  if (process.platform !== 'win32') return;
  const { launches, spawn } = fakeSpawnFactory();
  _setOpenUrlSpawnForTest(spawn as never);
  try {
    const out = JSON.parse(await exec(tool)({ url: 'www.example.com' }));
    assert.equal(out.status, 'SUCCESS');
    assert.equal(out.state_anchor.url, 'https://www.example.com/');
    assert.deepEqual(launches[0]!.args, ['url.dll,FileProtocolHandler', 'https://www.example.com/']);
  } finally {
    _setOpenUrlSpawnForTest(null);
  }
});

test('open_url: OCR 自由文本单 URL —— 无损提取后跳转', async () => {
  if (process.platform !== 'win32') return;
  const { launches, spawn } = fakeSpawnFactory();
  _setOpenUrlSpawnForTest(spawn as never);
  try {
    const out = JSON.parse(await exec(tool)({ url: '详见 https://example.com/a?x=1 即可' }));
    assert.equal(out.status, 'SUCCESS');
    assert.equal(out.state_anchor.url, 'https://example.com/a?x=1');
    assert.equal(launches[0]!.args[1], 'https://example.com/a?x=1', '提取的 URL 原样直达壳层');
  } finally {
    _setOpenUrlSpawnForTest(null);
  }
});

test('open_url: 多 URL 候选 —— 结构化拒绝，绝不掷硬币', async () => {
  const out = JSON.parse(await exec(tool)({
    url: 'see https://a.example.com/x and https://b.example.com/y for details',
  }));
  assert.equal(out.status, 'FAILED');
  assert.equal(out.action, 'open_url refused: multiple URL candidates.');
  assert.match(out.state_anchor.error, /Found 2 URLs: https:\/\/a\.example\.com\/x \| https:\/\/b\.example\.com\/y/);
  assert.match(out.next_step, /exactly ONE of these URLs/);
});

test('open_url: 大小写 scheme 归一后放行（HTTPS:// 同白名单）', async () => {
  if (process.platform !== 'win32') return;
  const { launches, spawn } = fakeSpawnFactory();
  _setOpenUrlSpawnForTest(spawn as never);
  try {
    const out = JSON.parse(await exec(tool)({ url: 'HTTPS://Example.COM' }));
    assert.equal(out.status, 'SUCCESS');
    assert.equal(out.state_anchor.url, 'https://example.com/');
    assert.equal(launches.length, 1);
  } finally {
    _setOpenUrlSpawnForTest(null);
  }
});

test('open_url: 壳层启动抛错 —— 诚实 FAILED + press_hotkey 手工兜底指引', async () => {
  const restore = patchOpenUrl(async () => { throw new Error('spawn xdg-open ENOENT'); });
  try {
    const out = JSON.parse(await exec(tool)({ url: 'https://example.com/fail' }));
    assert.equal(out.status, 'FAILED');
    assert.equal(out.action, 'open_url failed for https://example.com/fail.');
    assert.equal(out.state_anchor.error, 'spawn xdg-open ENOENT');
    assert.match(out.next_step, /press_hotkey/);
  } finally {
    restore();
  }
});
