// test/r31.typingPollution.test.ts
// R3-1(打字防串窗)回归:bench/driveCore.mjs scanTypingPollution 纯函数 ——
// type_text 类回执的「宿主输入框特征」与「非驱动下发的 user/message」两类污染
// 判定,以及插件焦点保卫已拦下(blocked ⇒ 字没打出去)的 near-miss 不算污染。
// 与 w2drive/r23 同策略:非字面量动态 import,tsc 不解析 .mjs;零 GUI 零网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const load = (p: string): Promise<any> => import(p);
const benchUrl = (f: string): string => new URL(`../bench/${f}`, import.meta.url).href;
const drive = await load(benchUrl('driveCore.mjs'));

const MARKERS = ['DeepSeek Harness'];
const NEEDLE = '任务:打开记事本并保存到 playground';

const call = (seq: number, name: string) => ({ kind: 'call', seq, name, args: {}, turn: 1, step: 1 });
const result = (seq: number, text: string, isError = false) => ({ kind: 'result', seq, callId: 'c', isError, text, turn: 1, step: 1 });
const user = (seq: number, text: string) => ({ kind: 'user', seq, text });

test('R3-1 a: 干净轨迹 —— 正常 type_text 成功回执 + 驱动 prompt 的 user/message,零检出', () => {
  const rows = [
    user(1, NEEDLE + '……(后续话术)'),
    user(2, 'Current runtime context. This snapshot shows the desktop state.'), // 宿主回合机制注入(合法)
    user(3, '<system-reminder>\nA skill is a reusable capability definition.'), // 同上
    call(4, 'take_screenshot'), result(5, '{"status":"SUCCESS","state_anchor":{"focus_guard":{"status":"ok","foreground_title":"无标题 - 记事本"}}}'),
    call(6, 'type_text'), result(7, '{"status":"SUCCESS","state_anchor":{"focus_guard":{"status":"ok","foreground_title":"*full-report - 记事本"},"typed_content":"FULL-BATTERY-ANCHOR"}}'),
  ];
  const s = drive.scanTypingPollution(rows, { promptNeedle: NEEDLE, markers: MARKERS });
  assert.equal(s.polluted, false);
  assert.deepEqual(s.findings, []);
});

test('R3-1 b: typed-into-host —— type_text 回执 foreground_title 命中宿主标记 ⇒ 污染', () => {
  const rows = [
    user(1, NEEDLE),
    call(2, 'type_text'),
    result(3, '{"status":"SUCCESS","state_anchor":{"focus_guard":{"status":"unchecked","reason":"…"},"typed_content":"FULL-BATTERY-ANCHOR"}} 截图显示输入落在 DeepSeek Harness 主窗口'),
  ];
  const s = drive.scanTypingPollution(rows, { promptNeedle: NEEDLE, markers: MARKERS });
  assert.equal(s.polluted, true);
  assert.equal(s.findings.length, 1);
  assert.equal(s.findings[0].kind, 'typed-into-host');
  assert.equal(s.findings[0].tool, 'type_text');
});

test('R3-1 c: near-miss 不算污染 —— 插件焦点保卫拦下(FAILED + blocked 方言)', () => {
  const rows = [
    user(1, NEEDLE),
    call(2, 'type_text'),
    result(3, '{"status":"FAILED","error":"Focus guard: typing was blocked — the foreground window is the agent host itself.","next_step":"…"}'),
  ];
  const s = drive.scanTypingPollution(rows, { promptNeedle: NEEDLE, markers: MARKERS });
  assert.equal(s.polluted, false);
});

test('R3-1 d: self-injected-message —— 非驱动下发的 user/message(注入已成事实)⇒ 污染', () => {
  const rows = [
    user(1, NEEDLE),
    call(2, 'type_text'), result(3, '{"status":"SUCCESS","typed_content":"ROW-1-EDITED-FULL"}'),
    user(4, 'ROW-1-EDITED-FULL\nROW-2'), // 打进宿主输入框后被提交
  ];
  const s = drive.scanTypingPollution(rows, { promptNeedle: NEEDLE, markers: MARKERS });
  assert.equal(s.polluted, true);
  assert.equal(s.findings[0].kind, 'self-injected-message');
});

test('R3-1 e: 结果配对纪律 —— 宿主标记只对 type_text 类回执生效;其他工具命中不误报', () => {
  const rows = [
    user(1, NEEDLE),
    call(2, 'ask_screen'),
    result(3, '{"answer":"前台是 DeepSeek Harness 窗口,内容为会话列表"}'), // ask_screen 提到宿主:合法
  ];
  const s = drive.scanTypingPollution(rows, { promptNeedle: NEEDLE, markers: MARKERS });
  assert.equal(s.polluted, false);
});

test('R3-1 f: 空 needle —— promptNeedle 缺席时 user/message 一律不算(缺判据不猜)', () => {
  const s = drive.scanTypingPollution([user(1, '任意文本')], { markers: MARKERS });
  assert.equal(s.polluted, false);
});

test('R3-1 g: TYPING_TOOLS 出口 —— 打字类工具名单含 type_text(扩面时的唯一改点)', () => {
  assert.deepEqual([...drive.TYPING_TOOLS], ['type_text']);
});
