// test/r33.maxturns.test.ts
// R3-3（GAP-4 会话轮数护栏）回归：bench/driveCore.mjs 纯函数 ——
//   sessionTurnCount（事件流轮号提取，page 帧/直接事件双形状）
//   turnCapDecision（轮数护栏判定：缺省 60 开、0 关、无证据不拦、≥ 上限即超限）。
// 与 w2drive.test.ts 同策略：非字面量动态 import 挂载 .mjs（tsc 不解析，typecheck
// 干净）；零 IO / 零网络 / 零时钟。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const load = (p: string): Promise<any> => import(p);
const benchUrl = (f: string): string => new URL(`../bench/${f}`, import.meta.url).href;

const drive = await load(benchUrl('driveCore.mjs'));

test('R3-3 GAP-4a: sessionTurnCount —— 双形状取最大 turn，脏值防御，无证据 ⇒ null', () => {
  // 桌面 page 帧（api.history 返回形状）：{type:'event',event:{seq,type,data:{turn,step}}}
  const pageFrames = [
    { type: 'event', event: { seq: 1, type: 'tool/call', data: { turn: 0, step: 1, name: 'take_screenshot' } } },
    { type: 'event', event: { seq: 2, type: 'tool/result', data: { turn: 0, step: 1 } } },
    { type: 'event', event: { seq: 3, type: 'tool/call', data: { turn: 1, step: 1, name: 'click_mouse' } } },
    { type: 'event', event: { seq: 4, type: 'user/message', data: { content: [] } } }, // 无 turn 字段
  ];
  assert.equal(drive.sessionTurnCount(pageFrames), 1, 'page 帧 ⇒ data.turn 最大值');
  // 直接事件形状（compactHistory/trimEvents 兼容方言）
  assert.equal(drive.sessionTurnCount([{ turn: 7 }, { turn: 3 }]), 7);
  // 脏值防御：非有限/负数不入账
  assert.equal(
    drive.sessionTurnCount([
      { event: { data: { turn: 'x' } } },
      { event: { data: { turn: -2 } } },
      { event: { data: {} } },
      null,
      'garbage',
    ]),
    null,
    '全部无有效 turn ⇒ null（证据缺失）',
  );
  assert.equal(drive.sessionTurnCount([]), null);
  assert.equal(drive.sessionTurnCount(null), null);
  assert.equal(drive.sessionTurnCount(undefined), null);
  assert.equal(drive.sessionTurnCount([{ event: { data: { turn: 5 } } }, { data: { turn: 9 } }]), 9, '两种形状混排同判');
});

test('R3-3 GAP-4b: turnCapDecision —— 缺省 60 开；0/负/NaN 关；无证据不拦；≥ 上限即超限', () => {
  // 缺省上限 60：59 不拦、60 拦（第 60 轮已在跑，不再放行第 61 轮 —— 成本闸宁早半轮）
  const d59 = drive.turnCapDecision({ turnCount: 59 });
  assert.deepEqual(
    { enabled: d59.enabled, limit: d59.limit, turnCount: d59.turnCount, exceeded: d59.exceeded },
    { enabled: true, limit: 60, turnCount: 59, exceeded: false },
  );
  assert.equal(drive.turnCapDecision({ turnCount: 60 }).exceeded, true);
  assert.equal(drive.turnCapDecision({ turnCount: 61 }).exceeded, true);
  // 自定义上限
  assert.equal(drive.turnCapDecision({ maxTurnsPerSession: 3, turnCount: 2 }).exceeded, false);
  assert.equal(drive.turnCapDecision({ maxTurnsPerSession: 3, turnCount: 3 }).exceeded, true);
  // 0=关 / 负 / 非有限 ⇒ 恒不拦（--max-turns-per-session 0 语义）
  for (const off of [0, -5, Number.NaN, Infinity]) {
    const d = drive.turnCapDecision({ maxTurnsPerSession: off, turnCount: 1e9 });
    assert.deepEqual({ enabled: d.enabled, limit: d.limit, exceeded: d.exceeded }, { enabled: false, limit: 0, exceeded: false }, `cap=${off} ⇒ 关`);
  }
  // 证据缺失（老宿主事件流无 turn 字段）⇒ 不拦 —— 只认正证据（hostGuardVerdict 同律）
  const noEv = drive.turnCapDecision({ turnCount: null });
  assert.equal(noEv.exceeded, false);
  assert.equal(noEv.turnCount, null);
  assert.equal(noEv.enabled, true);
  // 全缺省参 ⇒ {enabled:true, limit:60, turnCount:null, exceeded:false}
  assert.deepEqual(drive.turnCapDecision(), { enabled: true, limit: 60, turnCount: null, exceeded: false });
  // 缺省常量钉死（R2-8 §2.3 标定）
  assert.equal(drive.MAX_TURNS_PER_SESSION_DEFAULT, 60);
});

test('R3-3 GAP-4c: 端到端口径 —— R1-8 attempt8 型失控事件流喂判定', () => {
  // 49 调用失控场景的形态抽象：每轮 ≈3 事件，turn 单调爬升
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({
    event: { seq: i + 1, type: 'tool/call', data: { turn: Math.floor(i / 3), step: 1 } },
  }));
  const events = mk(153); // 51 轮
  const turns = drive.sessionTurnCount(events);
  assert.equal(turns, 50);
  assert.equal(drive.turnCapDecision({ turnCount: turns }).exceeded, false, '51 轮常态上界不被缺省 60 误伤');
  assert.equal(drive.turnCapDecision({ maxTurnsPerSession: 50, turnCount: turns }).exceeded, true, '闸 50 ⇒ 立即拦');
  // 轮号乱序（事件流按 seq 排但 turn 可能交错）⇒ max 语义稳
  assert.equal(drive.sessionTurnCount([{ event: { data: { turn: 9 } } }, { event: { data: { turn: 4 } } }, { event: { data: { turn: 6 } } }]), 9);
});
