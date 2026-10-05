// test/r61.eventCapture.test.ts
// R6-1 回归执法册（事件窗口截断修复的钉子）：
//   宿主 session/page 只保留最近 ~250 事件（R5-1 §5 条件②，批2 T8 六轮双实证：
//   长任务收口一次性导出必截断早期轨迹）。修复 = 驱动器等待环每 tick 增量拉取
//   事件流（driveCore.eventCaptureDelta 按 seq 去重 + 空洞如实记账），任务收口
//   与终局快照按 seq 合并（eventCaptureMerge，终局为准）——证据不再受窗口截断。
// 纯函数面：零 IO / 零网络 / 零时钟。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const load = (p: string): Promise<any> => import(p);
const benchUrl = (f: string): string => new URL(`../bench/${f}`, import.meta.url).href;
const drive = await load(benchUrl('driveCore.mjs'));

// session/page 帧形状（与 compactHistory 同方言）：{type:'event',event:{seq,...}}
const frame = (seq: number, type = 'tool/call', data: Record<string, unknown> = {}): any =>
  ({ type: 'event', event: { seq, type, data } });
// 直接事件形状（容错方言）
const bare = (seq: number): any => ({ seq, type: 'user/message', data: {} });
// 连续 seq 帧 [a,b]
const span = (a: number, b: number): any[] =>
  Array.from({ length: b - a + 1 }, (_, i) => frame(a + i));

// ═══ ① eventCaptureDelta：增量折叠 ═══

test('R6-1a: 首拉全收（seq 自 0 起 ⇒ 无空洞）；重叠窗口二拉只出新增', () => {
  let st = drive.eventCaptureInit();
  assert.equal(st.maxSeq, null);
  const d1 = drive.eventCaptureDelta(st, span(0, 9));
  assert.equal(d1.records.length, 10, '首拉全收');
  assert.deepEqual(d1.state.gaps, [], 'seq 自 0 起 ⇒ 无空洞');
  st = d1.state;
  assert.equal(st.maxSeq, 9);
  assert.equal(st.captured, 10);
  // 宿主 250 窗口重叠：二拉窗口 [5,19]，只有 [10,19] 是新的
  const d2 = drive.eventCaptureDelta(st, span(5, 19));
  assert.equal(d2.records.length, 10, '重叠窗口去重后只出新增');
  assert.equal(d2.state.maxSeq, 19);
  assert.equal(d2.state.captured, 20);
  assert.deepEqual(d2.records[0].event.seq, 10);
  // 幂等：同窗口再折叠 ⇒ 零新增、状态不变
  const d3 = drive.eventCaptureDelta(d2.state, span(5, 19));
  assert.equal(d3.records.length, 0);
  assert.equal(d3.state.maxSeq, 19);
});

test('R6-1b: 空洞如实记账 —— 首拉未从 0 起 / 两拍间跳段（事件风暴超窗口容量）', () => {
  // 首拉 minSeq=5（宿主 seq 自 0 起的实证方言）⇒ afterSeq:null 空洞
  const d1 = drive.eventCaptureDelta(drive.eventCaptureInit(), span(5, 9));
  assert.deepEqual(d1.state.gaps, [{ afterSeq: null, fromSeq: 5, missing: 5 }]);
  // 跳段：maxSeq=9 后下一拍直接从 25 起（20-24 被风暴挤出窗口）
  const d2 = drive.eventCaptureDelta(d1.state, span(25, 30));
  assert.deepEqual(d2.state.gaps, [
    { afterSeq: null, fromSeq: 5, missing: 5 },
    { afterSeq: 9, fromSeq: 25, missing: 15 },
  ], '空洞累积上账，不静默吞');
});

test('R6-1c: 无 seq 记录跳过并计数；双形状方言（page 帧/直接事件）同读；空输入零扰动', () => {
  const d = drive.eventCaptureDelta(drive.eventCaptureInit(), [
    frame(0), bare(1), frame(2),
    { type: 'event', event: { type: 'assistant/message' } }, // 无 seq
    null, undefined, 'junk',
  ]);
  assert.equal(d.records.length, 3, '有 seq 的全收（双方言）');
  assert.deepEqual(d.records.map((r: any) => r.event?.seq ?? r.seq), [0, 1, 2]);
  assert.equal(d.skippedNoSeq, 4, '无 seq/垃圾条目诚实计数');
  // 空输入/undefined 状态容错
  const d0 = drive.eventCaptureDelta(drive.eventCaptureInit(), []);
  assert.equal(d0.records.length, 0);
  const dU = drive.eventCaptureDelta(undefined, span(0, 2));
  assert.equal(dU.records.length, 3);
});

// ═══ ② eventCaptureMerge：增量 × 终局快照合并 ═══

test('R6-1d: 同 seq 终局为准、按 seq 升序、统计口径 inc/fin/unique/noSeq', () => {
  const inc = [frame(0), frame(1), frame(2, 'tool/result', { v: 1 })];
  const fin = [frame(2, 'tool/result', { v: 2 }), frame(3)]; // 终局窗口更晚（seq2 覆盖）
  const m = drive.eventCaptureMerge(inc, fin);
  assert.equal(m.records.length, 4);
  assert.deepEqual(m.records.map((r: any) => r.event.seq), [0, 1, 2, 3]);
  const seq2 = m.records.find((r: any) => r.event.seq === 2);
  assert.equal(seq2.event.data.v, 2, '同 seq 终局覆盖增量');
  assert.deepEqual(m.stats, { incremental: 3, final: 2, unique: 4, noSeq: 0 });
  // 无 seq 条目计 noSeq 不进合并
  const m2 = drive.eventCaptureMerge([{ foo: 1 }], [frame(0), { bar: 2 }]);
  assert.equal(m2.records.length, 1);
  assert.equal(m2.stats.noSeq, 2);
});

test('R6-1e: 端到端截断修复钉子 —— 250 事件窗口下的长任务证据完整', () => {
  // 复刻病灶形态：会话 0..499 共 500 事件;宿主窗口 250 ⇒ 任意时刻 page 只见
  // 最近 ~250。等待环按 tick 增量吃满 0..499;收口终局快照只见 [250,499]。
  let st = drive.eventCaptureInit();
  const incFile: any[] = [];
  for (let tick = 0; tick < 10; tick++) {
    const windowStart = Math.max(0, (tick + 1) * 50 - 250);
    const win = span(windowStart, (tick + 1) * 50 - 1); // 宿主窗口（截断下界）
    const d = drive.eventCaptureDelta(st, win);
    st = d.state;
    incFile.push(...d.records);
  }
  assert.equal(st.captured, 500, '增量吃满全量（每 tick 窗口虽截断、增量游标不丢）');
  assert.deepEqual(st.gaps, [], '窗口未真正溢出 ⇒ 零空洞');
  const finalSnapshot = span(250, 499); // 收口导出只见最后 250（旧版病灶面）
  const m = drive.eventCaptureMerge(incFile, finalSnapshot);
  assert.equal(m.stats.unique, 500, '合并后 0..499 完整');
  assert.equal(m.records[0].event.seq, 0);
  assert.equal(m.records[499].event.seq, 499);
  // 对照：旧版（只用终局快照）恰丢 250 条早期事件 —— 这就是本修复消灭的缺口
  assert.equal(500 - finalSnapshot.length, 250);
});

// ═══ ③ 与消费面方言兼容（compactHistory/trimEvents 零改动消费合并产物） ═══

test('R6-1f: 合并产物保持 session/page 帧形状 —— compactHistory 同方言可读', async () => {
  // compactHistory 在 drive-desktop.mjs（CLI 守卫下 import 不触发 main）
  const dd = await load(benchUrl('drive-desktop.mjs'));
  const m = drive.eventCaptureMerge(
    [frame(0, 'tool/call', { name: 'take_screenshot', arguments: {}, turn: 1, step: 1 }), bare(1)],
    [frame(1), frame(2, 'tool/result', { message: { content: [{ type: 'text', text: '{"ok":true}' }], toolCallId: 'c1' }, turn: 1 })],
  );
  const rows = dd.compactHistory({ events: m.records });
  assert.equal(rows.length, 3, 'call/result/user 三行都被消费（方言零改动）');
  assert.equal(rows[0].kind, 'call');
  assert.equal(rows[0].name, 'take_screenshot');
  assert.equal(rows[2].kind, 'result');
  assert.equal(rows[2].text, '{"ok":true}');
});
