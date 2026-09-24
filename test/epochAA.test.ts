// test/epochAA.test.ts
// AA 纪元（AA-1 世界跳转引擎）：URL 感知判决矩阵 —— 纯函数锁死。
// 「自动跳转网页链接」的可判部分在此回归：提取无损、归一无猜、安检无情。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeUrlCandidate, extractUrls } from '../src/urlSense.ts';

// ─── AA-1a 归一与安检 ───

test('AA-1a: 显式 http(s) URL 原样放行（查询参数含 & 不受壳层解析伤害）', () => {
  const v = normalizeUrlCandidate('https://example.com/docs?a=1&b=2');
  assert.equal(v.kind, 'ok');
  if (v.kind === 'ok') assert.equal(v.url, 'https://example.com/docs?a=1&b=2');
});

test('AA-1a: OCR 尾随标点剥离 —— 中文句号/逗号/全角括号是文本粘连不是 URL', () => {
  const cases: Array<[string, string]> = [
    ['https://example.com/p?x=1。', 'https://example.com/p?x=1'],
    ['https://example.com/a)，', 'https://example.com/a'],
    ['（www.deepseek.com）', 'https://www.deepseek.com/'], // 注意：www 无路径归一出尾 /
  ];
  for (const [raw, want] of cases) {
    const v = normalizeUrlCandidate(raw);
    assert.equal(v.kind, 'ok', raw);
    if (v.kind === 'ok') assert.equal(v.url, want, raw);
  }
});

test('AA-1a: www. 前缀补全 https:// —— 唯一被授权的猜测（www 是显式网页自声明）', () => {
  const v = normalizeUrlCandidate('www.deepseek.com/docs');
  assert.equal(v.kind, 'ok');
  if (v.kind === 'ok') assert.equal(v.url, 'https://www.deepseek.com/docs');
});

test('AA-1a: 裸域名不猜 —— 精确性优先（打错一个字的 URL 与没打开一样）', () => {
  for (const raw of ['example.com', 'not-a-url', 'hello world', '']) {
    const v = normalizeUrlCandidate(raw);
    assert.equal(v.kind, 'refused', raw);
  }
});

test('AA-1a: scheme 白名单 —— file/javascript/data/vbscript 一律拒绝（不做任意协议启动器）', () => {
  for (const raw of [
    'file:///C:/Windows/win.ini',
    'javascript:alert(1)',
    'data:text/html;base64,SGVsbG8=',
    'vbscript:msgbox(1)',
    'ftp://files.example.com/pub',
  ]) {
    const v = normalizeUrlCandidate(raw);
    assert.equal(v.kind, 'refused', raw);
    if (v.kind === 'refused') assert.match(v.reason, /allowlist|scheme/);
  }
});

test('AA-1a: 主机健全性 —— 无点主机拒绝（http://foo 是词不是站）；localhost 例外', () => {
  assert.equal(normalizeUrlCandidate('http://foo').kind, 'refused');
  const local = normalizeUrlCandidate('http://localhost:3000/admin');
  assert.equal(local.kind, 'ok');
});

test('AA-1a: 大小写归一 —— HTTP://EXAMPLE.COM 与小写同判（host 解析归一小写）', () => {
  const v = normalizeUrlCandidate('HTTP://Example.COM/Path');
  assert.equal(v.kind, 'ok');
  if (v.kind === 'ok') assert.equal(v.url, 'http://example.com/Path');
});

test('AA-1a: 括号平衡律 —— 维基百科式成对括号是 URL 的一部分，不许误剥', () => {
  const v = normalizeUrlCandidate('https://en.wikipedia.org/wiki/Python_(programming_language)');
  assert.equal(v.kind, 'ok');
  if (v.kind === 'ok') {
    assert.equal(v.url, 'https://en.wikipedia.org/wiki/Python_(programming_language)');
  }
});

test('AA-1a: 超长拒绝 —— 超过 2048 的是解析噪声不是链接', () => {
  const long = 'https://example.com/' + 'a'.repeat(2100);
  const v = normalizeUrlCandidate(long);
  assert.equal(v.kind, 'refused');
});

// ─── AA-1b 自由文本提取（read_text / 闸门改道的感知面） ───

test('AA-1b: OCR 噪声中的多 URL 提取 —— 尾随标点剥离 + www 补全 + 保序', () => {
  const text = '详见 https://a.com/p?x=1&y=2。 以及 www.b.com/docs#c 也可（www.c.org）';
  assert.deepEqual(extractUrls(text), [
    'https://a.com/p?x=1&y=2',
    'https://www.b.com/docs#c',
    'https://www.c.org/',
  ]);
});

test('AA-1b: 去重保序 —— 同一 URL 出现两次只报一次', () => {
  assert.deepEqual(extractUrls('https://a.com 和 https://a.com 再 https://b.com'), [
    'https://a.com/',
    'https://b.com/',
  ]);
});

test('AA-1b: 非法 scheme 在提取层即被滤除（file:// 不会因裹在文本里而漏网）', () => {
  assert.deepEqual(extractUrls('看 file:///C:/secret.ini 和 https://ok.com'), ['https://ok.com/']);
});

test('AA-1b: 纯文本/空输入 ⇒ 空集（诚实的无发现）', () => {
  assert.deepEqual(extractUrls('普通文本 123 没有链接'), []);
  assert.deepEqual(extractUrls(''), []);
});

test('AA-1b: 提取上限 16 —— URL 潮是正则误报潮，防爆量', () => {
  const text = Array.from({ length: 20 }, (_, i) => `https://x${i}.com`).join(' ');
  assert.equal(extractUrls(text).length, 16);
});
