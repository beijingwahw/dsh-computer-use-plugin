// test/w2canary.test.ts
// W2-7（R4 高风险链前金丝雀试演）：proceed×high 的可逆微探针 —— 触发/比对/
// 拦截降级/降级放行/预算/豁免全链。
//
// 全离线确定性：物理微动作与帧哈希全部经 CanaryProbePorts 注入假件 —— 零真实
// 截图、零真实鼠标、零服务孵化。锁死的内容：
//   1. 触发面：高危触发（proceed×high，经内核注册表放宽 highProceed 阈再现
//      「部署放宽免检线」的真实前件）/ 低危不触发 / 默认内核零回归
//      （highProceed 0.85 > 校准值域上限 0.8，数学上恒不可达）
//   2. 试演编排：点击回点 / 单字符退格的三帧取证（基线→探针中→复位后）
//   3. 比对：一致放行（证据链「金丝雀通过」）/ 无响应分歧拦截 / 未复原分歧拦截
//   4. 降级：端口缺席 / 派发失败 / 帧通道缺席 / 弹窗期 / 恶意注入件 ⇒ 放行原动作
//   5. 纪律：探针预算封顶 / destructive 豁免直审批 / 已授予令牌让位
//   6. 纯函数：costPriorOfCall / isIdempotentToggleLabel / compareCanaryObservation
//      / classifyCanaryTrigger 的逐分支判定
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyCanaryTrigger,
  compareCanaryObservation,
  attemptCanaryProbe,
  isIdempotentToggleLabel,
  registerCanaryGuard,
  recentCanaryEvents,
  canaryBudgetSnapshot,
  resetCanaryGuard,
  CANARY_PROBE_BUDGET_DEFAULT,
  productionCanaryPorts,
  type CanaryProbePorts,
} from '../src/guards/canaryGuard.ts';
import { costPriorOfCall } from '../src/autonomy/uncertainty.ts';
import { kernelRegistry } from '../src/kernel/registry.ts';
import { approval, resetApproval, setConfirmCodeChannel, type ConfirmCodeDelivery } from '../src/approval.ts';
import { telemetry } from '../src/telemetry.ts';
import { focusTracker } from '../src/focusTracker.ts';
import { updatePopupState } from '../src/guards/popupGuard.ts';
import type { Config } from '../src/config.ts';

// ─── 测试基建 ───

/** 放宽 highProceed 阈（再现「部署/内核进化放宽免检线」—— 金丝雀的前件）：
 *  0.7 ⇒ confidence 0.95 校准后 eff = 0.5+0.6×0.45 = 0.77 ≥ 0.7 ⇒ proceed×high。 */
function relaxHighProceed(threshold = 0.7): void {
  kernelRegistry.register({
    key: 'uncertainty.highProceed', organ: 'w2-7-test',
    defaultValue: threshold, min: 0, max: 1,
  });
}

const CFG = {
  dangerPatterns: 'send,delete,支付',
  noopSimilarityThreshold: 0.97,
  probeRegionRadius: 0.06,
  dryRun: false,
  focusMaxAgeMs: 30_000,
} as unknown as Config;

interface RegisteredHandler {
  event: string;
  handler: (exec: any, next: () => Promise<any>) => Promise<any>;
}

function fakeCtx() {
  const handlers: RegisteredHandler[] = [];
  return {
    handlers,
    on(event: string, handler: any) { handlers.push({ event, handler }); return () => {}; },
  } as any;
}

function exec(name: string, args: unknown, sessionId = 'w2-7-test'): any {
  return { name, arguments: args, agent: { id: sessionId }, token: {}, rootCallId: 'c1' };
}

async function drivePre(ctx: any, e: any): Promise<any> {
  const h = ctx.handlers.find((r: RegisteredHandler) => r.event === 'tools/pre-execute')!;
  return h.handler(e, async () => ({ kind: 'accept' }));
}

/** 可编程假端口：三帧哈希脚本 + 逐端口调用计数 + 可编程派发失败 */
function fakePorts(script: {
  h0?: string;
  h1?: string;
  h2?: string;
  failFirstDispatch?: boolean;
  failRestore?: boolean;
  throwHash?: boolean;
} = {}) {
  const calls = { click: 0, typeChar: 0, backspace: 0, hash: 0 };
  const hashes = [script.h0 ?? 'aaaaaaaa', script.h1 ?? 'bbbbbbbb', script.h2 ?? 'aaaaaaaa'];
  let hashIdx = 0;
  const ports: CanaryProbePorts = {
    click: async () => {
      calls.click++;
      if (script.failFirstDispatch && calls.click === 1) return false;
      if (script.failRestore && calls.click >= 2) return false; // 回点一族全部失败（含尽力重试）
      return true;
    },
    typeChar: async () => {
      calls.typeChar++;
      if (script.failFirstDispatch && calls.typeChar === 1) return false;
      return true;
    },
    backspace: async () => {
      calls.backspace++;
      if (script.failRestore && calls.backspace === 1) return false;
      return true;
    },
    regionHash: async () => {
      calls.hash++;
      if (script.throwHash) throw new Error('hash-boom');
      // 三帧脚本循环发放：每次探针恰取 3 帧（基线/探针中/复位后），多轮探针对齐复用
      const h = hashes[hashIdx % hashes.length];
      hashIdx++;
      return h;
    },
  };
  return { calls, ports };
}

/** 标准高危点击（幂等切换标签 + 显式预期后果 + 高自报置信） */
const HIGH_RISK_CLICK = {
  x: 0.5,
  y: 0.5,
  target_description: 'Expand Advanced Options',
  expected_change: 'advanced settings panel expands',
  confidence: 0.95,
};

beforeEach(() => {
  kernelRegistry.reset();
  resetCanaryGuard();
  telemetry.reset();
  resetApproval();
  focusTracker.clear();
  updatePopupState(false);
});

/** W6R fail-closed：带外码采集 + 携码授予（无码 grant 已废除 —— 授予面一律走此助手） */
const oobSink: ConfirmCodeDelivery[] = [];
function armOob(): void {
  setConfirmCodeChannel(d => { oobSink.push({ ...d }); });
}
function grantOob(token: string): boolean {
  const hit = oobSink.find(d => d.token === token);
  return approval.grantDetailed(token, true, hit ? { confirmCode: hit.confirmCode } : {}).ok;
}

// ─── 1. 纯函数：代价先验 / 幂等词汇表 ───

test('W2-7①: costPriorOfCall —— 声明档优先、后果断言次之、缺省 medium', () => {
  assert.equal(costPriorOfCall('click', { declaredTier: 'benign' }), 'low');
  assert.equal(costPriorOfCall('click', { declaredTier: 'sensitive' }), 'high');
  assert.equal(costPriorOfCall('type', { declaredTier: 'destructive' }), 'high');
  assert.equal(costPriorOfCall('click', { consequenceDeclared: true }), 'high');
  // 非法声明档不采信（不因脏输入收紧或放宽）⇒ 落结构先验 / 缺省
  assert.equal(costPriorOfCall('click', { declaredTier: 'garbage' }), 'medium');
  assert.equal(costPriorOfCall('click', {}), 'medium');
  assert.equal(costPriorOfCall('click', { declaredTier: 'garbage', consequenceDeclared: true }), 'high');
  // 绝不抛：脏入参直通
  assert.equal(costPriorOfCall('click', null as any), 'medium');
});

test('W2-7①: isIdempotentToggleLabel —— 幂等切换候选的准入判据', () => {
  assert.equal(isIdempotentToggleLabel('Expand Advanced Options'), true);
  assert.equal(isIdempotentToggleLabel('展开高级设置'), true);
  assert.equal(isIdempotentToggleLabel('show more'), true);
  assert.equal(isIdempotentToggleLabel('Submit article'), false, '一次性按钮绝不入选（试演它=二次伤害）');
  assert.equal(isIdempotentToggleLabel(''), false);
  assert.equal(isIdempotentToggleLabel(undefined), false);
  assert.equal(isIdempotentToggleLabel(123), false);
});

// ─── 2. 纯函数：触发分类（默认内核零回归 + 各让位分支） ───

test('W2-7②: 默认内核零回归 —— highProceed 0.85 > 校准上限 0.8，proceed×high 恒不可达', () => {
  const t = classifyCanaryTrigger('click_mouse', { ...HIGH_RISK_CLICK }, { dangerPatterns: CFG.dangerPatterns });
  assert.equal(t.kind, 'skip');
  assert.equal((t as any).why, 'not-proceed');
  // 自报置信满格也一样 —— 出厂参数下金丝雀是纯旁路
  const t2 = classifyCanaryTrigger('click_mouse', { ...HIGH_RISK_CLICK, confidence: 1 }, { dangerPatterns: CFG.dangerPatterns });
  assert.equal((t2 as any).why, 'not-proceed');
});

test('W2-7②: 放宽 highProceed 后触发；predictedEffects 只读随行', () => {
  relaxHighProceed();
  const t = classifyCanaryTrigger('click_mouse', HIGH_RISK_CLICK, { dangerPatterns: CFG.dangerPatterns });
  assert.equal(t.kind, 'rehearse');
  const r = t as Extract<typeof t, { kind: 'rehearse' }>;
  assert.equal(r.probe.kind, 'click-toggle');
  assert.deepEqual(r.probe.point, { x: 0.5, y: 0.5 });
  assert.equal(r.report.advise, 'proceed');
  assert.ok(r.predictedEffects.length >= 1, '反事实预测在场');
  assert.ok(r.predictedEffects.some(e => e.includes('Expand Advanced Options')), 'click 预测含激活目标');
});

test('W2-7②: 让位分支逐个判定（非动作工具 / 低危 / 非幂等标签 / 预算 / 危险词）', () => {
  relaxHighProceed();
  const dp = { dangerPatterns: CFG.dangerPatterns };
  assert.equal((classifyCanaryTrigger('read_text', {}, dp) as any).why, 'not-action-tool');
  // 低危：无 expected_change / expected_text / 声明档 ⇒ medium
  const low = classifyCanaryTrigger('click_mouse', { x: 0.5, y: 0.5, target_description: 'Expand menu', confidence: 0.95 }, dp);
  assert.equal((low as any).why, 'low-cost');
  // 高危但非幂等标签 ⇒ 论证不出可逆探针
  const noRev = classifyCanaryTrigger('click_mouse', { ...HIGH_RISK_CLICK, target_description: 'Submit article' }, dp);
  assert.equal((noRev as any).why, 'no-reversible-probe');
  // 预算耗尽
  const budget = classifyCanaryTrigger('click_mouse', HIGH_RISK_CLICK, { ...dp, probeBudgetUsed: 6, probeBudgetCap: 6 });
  assert.equal((budget as any).why, 'budget-exhausted');
  // 危险词命中 ⇒ destructive 豁免（不试演）
  const danger = classifyCanaryTrigger('click_mouse', { ...HIGH_RISK_CLICK, target_description: 'send the email' }, dp);
  assert.equal(danger.kind, 'exempt-destructive');
  // 显式 destructive 分层同律
  const tier = classifyCanaryTrigger('type_text', { text: 'hi', expected_change: 'x', confidence: 0.95, risk_tier: 'destructive' }, dp);
  assert.equal(tier.kind, 'exempt-destructive');
});

test('W2-7②: 已授予令牌让位（人已裁决）；未授予令牌不让位', () => {
  relaxHighProceed();
  armOob(); // W6R：授予须带外码
  const pa = approval.request('pre-test');
  grantOob(pa.token);
  const t = classifyCanaryTrigger('click_mouse', { ...HIGH_RISK_CLICK, approval_token: pa.token }, { dangerPatterns: CFG.dangerPatterns });
  assert.equal((t as any).why, 'approval-present');
  // 未授予的令牌（request 后未 grant）不构成让位 —— 照常试演
  const pb = approval.request('pending-only');
  const t2 = classifyCanaryTrigger('click_mouse', { ...HIGH_RISK_CLICK, approval_token: pb.token }, { dangerPatterns: CFG.dangerPatterns });
  assert.equal(t2.kind, 'rehearse');
});

// ─── 3. 纯函数：预测-验证比对 ───

test('W2-7③: compareCanaryObservation —— 无响应分歧 / 一致 / 未复原分歧 / 弃权', () => {
  const th = { responseCeiling: 0.97, restoreFloor: 0.9 };
  // 无响应：探针期间纹丝不动（相似度 1 ≥ 0.97）⇒ 与「世界会响应」全矛盾
  const noResp = compareCanaryObservation(['激活元素「X」'], { responseSimilarity: 1, restoreSimilarity: 1, steps: [], degradedNotes: [] }, th);
  assert.equal(noResp.diverged, true);
  assert.equal(noResp.divergence, 1);
  // 响应显著 + 复原完好 ⇒ 一致（分歧度量 = 残余响应相似度 0.2，低于阈不判分歧）
  const agree = compareCanaryObservation(['激活元素「X」'], { responseSimilarity: 0.2, restoreSimilarity: 1, steps: [], degradedNotes: [] }, th);
  assert.equal(agree.diverged, false);
  assert.ok(Math.abs(agree.divergence! - 0.2) < 1e-12, '剧变 ⇒ 低分歧度量');
  // 未复原：净变化（复位相似度 0 < 地板 0.9）⇒ 「幂等切换」预测被否决
  const dirty = compareCanaryObservation(['激活元素「X」'], { responseSimilarity: 0.1, restoreSimilarity: 0.3, steps: [], degradedNotes: [] }, th);
  assert.equal(dirty.diverged, true);
  assert.ok(Math.abs(dirty.divergence! - 0.7) < 1e-12, '分歧度量 = 1 − 复位相似度');
  // 两通道皆缺席 ⇒ 诚实弃权（null / null —— 调用方降级放行）
  const none = compareCanaryObservation(['激活元素「X」'], { responseSimilarity: null, restoreSimilarity: null, steps: [], degradedNotes: [] }, th);
  assert.equal(none.diverged, null);
  assert.equal(none.divergence, null);
  // 非有限数按通道缺席处理（不伪造观察）
  const nan = compareCanaryObservation(['激活元素「X」'], { responseSimilarity: Number.NaN, restoreSimilarity: 1, steps: [], degradedNotes: [] }, th);
  assert.equal(nan.responseSimilarity, null);
  assert.equal(nan.diverged, false, '复位通道独证复原完好');
  // 空预测 ⇒ 响应通道弃权
  assert.equal(compareCanaryObservation([], { responseSimilarity: 1, restoreSimilarity: null, steps: [], degradedNotes: [] }, th).diverged, null);
});

// ─── 4. 探针编排（注入假件，离线） ───

test('W2-7④: attemptCanaryProbe —— 点击回点三帧取证 / 单字符退格 / 端口缺席', async () => {
  // 点击回点：click×2 + hash×3（基线/探针中/复位后）
  const fp = fakePorts({ h0: 'aaaaaaaa', h1: '00000000', h2: 'aaaaaaaa' });
  const r1 = await attemptCanaryProbe({ kind: 'click-toggle', point: { x: 0.5, y: 0.5 }, char: 'x' }, fp.ports, {});
  assert.equal(r1.status, 'observed');
  if (r1.status === 'observed') {
    assert.equal(r1.observation.responseSimilarity, 0, '探针中剧变');
    assert.equal(r1.observation.restoreSimilarity, 1, '复位完好');
  }
  assert.equal(fp.calls.click, 2, '点击 + 回点');
  assert.equal(fp.calls.hash, 3);
  assert.equal(fp.calls.typeChar, 0);

  // 单字符退格：typeChar×1 + backspace×1
  const fp2 = fakePorts({ h0: 'aaaaaaaa', h1: '00000000', h2: 'aaaaaaaa' });
  const r2 = await attemptCanaryProbe({ kind: 'type-char', point: null, char: 'x' }, fp2.ports, {});
  assert.equal(r2.status, 'observed');
  assert.equal(fp2.calls.typeChar, 1);
  assert.equal(fp2.calls.backspace, 1);
  assert.equal(fp2.calls.click, 0);

  // 端口缺席 / 空端口 / 无基线帧 ⇒ unavailable（未触世界）
  assert.equal((await attemptCanaryProbe({ kind: 'type-char', point: null, char: 'x' }, undefined)).status, 'unavailable');
  assert.equal((await attemptCanaryProbe({ kind: 'type-char', point: null, char: 'x' }, {})).status, 'unavailable');
  const fp3 = fakePorts({ h0: '', h1: 'x', h2: 'y' });
  assert.equal((await attemptCanaryProbe({ kind: 'click-toggle', point: { x: 0.5, y: 0.5 }, char: 'x' }, fp3.ports, {})).status, 'unavailable');
  assert.equal(fp3.calls.click, 0, '无基线 ⇒ 不派发物理动作');
});

test('W2-7④: 首步派发失败 ⇒ unavailable（世界未被触碰）；复位失败重试后仍败 ⇒ failed', async () => {
  const fp = fakePorts({ failFirstDispatch: true });
  const r = await attemptCanaryProbe({ kind: 'click-toggle', point: { x: 0.5, y: 0.5 }, char: 'x' }, fp.ports, {});
  assert.equal(r.status, 'unavailable');
  assert.equal(fp.calls.click, 1, '只试了首步（失败即停，无回点可做）');

  const fp2 = fakePorts({ failRestore: true });
  const r2 = await attemptCanaryProbe({ kind: 'click-toggle', point: { x: 0.5, y: 0.5 }, char: 'x' }, fp2.ports, {});
  assert.equal(r2.status, 'failed');
  assert.equal(fp2.calls.click, 3, '点击 + 回点失败 + 尽力重试一次');
  assert.ok(r2.notes.some(n => n.includes('回点派发失败')), '诚实记注世界可能未复原');
});

// ─── 5. 守卫接线：全链（fake ctx + 注入端口） ───

test('W2-7⑤: 高危触发 + 探针一致 ⇒ 放行，证据链记「金丝雀通过」', async () => {
  relaxHighProceed();
  const ctx = fakeCtx();
  const fp = fakePorts({ h0: 'aaaaaaaa', h1: '00000000', h2: 'aaaaaaaa' });
  registerCanaryGuard(ctx, CFG, fp.ports);

  const out = await drivePre(ctx, exec('click_mouse', HIGH_RISK_CLICK));
  assert.equal(out.kind, 'accept', '一致 ⇒ 放行（next 透传）');
  assert.equal(fp.calls.click, 2, '探针点击回点各一次');

  const events = recentCanaryEvents();
  assert.equal(events[0].action, 'passed');
  assert.equal(events[0].predictedEffects!.length >= 1, true);
  assert.equal(events[1].action, 'triggered');
  assert.equal(events[1].epistemics!.includes('proceed'), true);
  const counters = telemetry.snapshot().counters;
  assert.ok(counters.some(c => c.counter === 'canary:passed' && c.hits === 1));
  assert.ok(counters.some(c => c.counter === 'canary:triggered' && c.hits === 1));
  assert.equal(canaryBudgetSnapshot().get('w2-7-test'), 1, '预算记账一次');
});

test('W2-7⑤: 低危不触发（探针零消费）；type_text 同律', async () => {
  relaxHighProceed();
  const ctx = fakeCtx();
  const fp = fakePorts();
  registerCanaryGuard(ctx, CFG, fp.ports);
  const out = await drivePre(ctx, exec('click_mouse', { x: 0.5, y: 0.5, target_description: 'Expand menu', confidence: 0.95 }));
  assert.equal(out.kind, 'accept');
  assert.equal(fp.calls.click + fp.calls.typeChar, 0, '低危 ⇒ 探针零消费');
  assert.equal(recentCanaryEvents().length, 0, '不产生事件');
});

test('W2-7⑤: type_text 高危试演 —— 单字符退格探针，一致放行', async () => {
  relaxHighProceed();
  const ctx = fakeCtx();
  const fp = fakePorts({ h0: 'aaaaaaaa', h1: '00000000', h2: 'aaaaaaaa' });
  registerCanaryGuard(ctx, CFG, fp.ports);
  const out = await drivePre(ctx, exec('type_text', {
    text: 'quarterly report summary',
    expected_change: 'typed text appears in the focused field',
    confidence: 0.95,
  }));
  assert.equal(out.kind, 'accept');
  assert.equal(fp.calls.typeChar, 1);
  assert.equal(fp.calls.backspace, 1);
  assert.equal(fp.calls.click, 0);
  assert.equal(recentCanaryEvents()[0].action, 'passed');
  assert.equal(recentCanaryEvents()[0].probe, 'type-char');
});

test('W2-7⑤: 无响应分歧 ⇒ 拦截 + approval.request 降级问人（只读：present 且未授予）', async () => {
  relaxHighProceed();
  const ctx = fakeCtx();
  const fp = fakePorts({ h0: 'aaaaaaaa', h1: 'aaaaaaaa', h2: 'aaaaaaaa' }); // 探针期间纹丝不动
  registerCanaryGuard(ctx, CFG, fp.ports);

  const out = await drivePre(ctx, exec('click_mouse', HIGH_RISK_CLICK));
  assert.equal(out.kind, 'deny');
  assert.match(out.reason, /\[Canary\]/);
  assert.match(out.reason, /APR-[0-9A-F]+/, '拒绝消息携带审批令牌');

  const token = (out.reason.match(/APR-[0-9A-F]+/) ?? [])[0];
  const st = approval.status(token);
  assert.equal(st.present, true, '令牌已铸造（approval.request）');
  assert.equal(st.granted, false, '只读调用：未授予 —— 同意仍归 grant_approval 协议');

  const ev = recentCanaryEvents()[0];
  assert.equal(ev.action, 'blocked');
  assert.equal(ev.approvalToken, token);
  assert.equal(ev.divergence, 1, '无响应 = 全矛盾');
  assert.ok(ev.why.includes('分歧'));
  assert.ok(telemetry.snapshot().counters.some(c => c.counter === 'canary:blocked' && c.hits === 1));
});

test('W2-7⑤: 未复原分歧（复位相似度 < 地板）⇒ 同律拦截', async () => {
  relaxHighProceed();
  const ctx = fakeCtx();
  const fp = fakePorts({ h0: 'aaaaaaaa', h1: '00000000', h2: 'cccccccc' }); // 响应了但没复原
  registerCanaryGuard(ctx, CFG, fp.ports);
  const out = await drivePre(ctx, exec('click_mouse', HIGH_RISK_CLICK));
  assert.equal(out.kind, 'deny');
  const ev = recentCanaryEvents()[0];
  assert.equal(ev.action, 'blocked');
  assert.equal(ev.restoreSimilarity, 0);
  assert.ok(ev.divergence! >= 0.99, '未复原通道主导分歧度量');
});

test('W2-7⑤: 端口缺席（生产后端未孵化）⇒ 降级放行 + degraded 记注', async () => {
  relaxHighProceed();
  const ctx = fakeCtx();
  registerCanaryGuard(ctx, CFG); // 不注入端口 ⇒ 生产端口 ⇒ healthSnapshot 缺席 ⇒ 全降级
  const out = await drivePre(ctx, exec('click_mouse', HIGH_RISK_CLICK));
  assert.equal(out.kind, 'accept', '可用性优先：探针缺席放行原动作');
  const ev = recentCanaryEvents()[0];
  assert.equal(ev.action, 'degraded');
  assert.equal(ev.action === 'degraded' && ev.degradedNotes!.length > 0, true, '降级注记在场');
  assert.ok(telemetry.snapshot().counters.some(c => c.counter === 'canary:degraded'));
});

test('W2-7⑤: dry-run ⇒ 生产端口拒绝派发 ⇒ 降级放行（不动物理世界）', async () => {
  relaxHighProceed();
  const ctx = fakeCtx();
  const cfgDry = { ...CFG, dryRun: true } as unknown as Config;
  registerCanaryGuard(ctx, cfgDry); // 生产端口在 dry-run 下全部拒派
  const out = await drivePre(ctx, exec('click_mouse', HIGH_RISK_CLICK));
  assert.equal(out.kind, 'accept');
  assert.equal(recentCanaryEvents()[0].action, 'degraded');
});

test('W2-7⑤: 弹窗活跃期 ⇒ 不试演（隔着对话框动指针不安全）', async () => {
  relaxHighProceed();
  const ctx = fakeCtx();
  const fp = fakePorts();
  registerCanaryGuard(ctx, CFG, fp.ports);
  updatePopupState(true);
  const out = await drivePre(ctx, exec('click_mouse', HIGH_RISK_CLICK));
  updatePopupState(false);
  assert.equal(out.kind, 'accept');
  assert.equal(fp.calls.click, 0, '弹窗期物理探针零派发');
  assert.equal(recentCanaryEvents()[0].action, 'degraded');
});

test('W2-7⑤: 恶意注入件（getter 即抛 / 端口抛错）⇒ 绝对不抛，降级放行', async () => {
  relaxHighProceed();
  const ctx = fakeCtx();
  const hostile: any = {};
  Object.defineProperty(hostile, 'click', { get() { throw new Error('hostile getter'); } });
  registerCanaryGuard(ctx, CFG, hostile);
  const out = await drivePre(ctx, exec('click_mouse', HIGH_RISK_CLICK));
  assert.equal(out.kind, 'accept', '守卫整体 try 兜底 —— 主流程零感知');

  const ctx2 = fakeCtx();
  const throwing = fakePorts({ throwHash: true });
  registerCanaryGuard(ctx2, CFG, throwing.ports);
  const out2 = await drivePre(ctx2, exec('click_mouse', HIGH_RISK_CLICK));
  assert.equal(out2.kind, 'accept', '帧通道抛错 ⇒ 降级放行');
  assert.equal(throwing.calls.click, 0, '哈希取不到基线 ⇒ 不派发物理动作');
});

test('W2-7⑤: 预算封顶 —— 每会话 N 次后让位放行，探针零消费', async () => {
  relaxHighProceed();
  const ctx = fakeCtx();
  const fp = fakePorts({ h0: 'aaaaaaaa', h1: '00000000', h2: 'aaaaaaaa' });
  registerCanaryGuard(ctx, CFG, fp.ports);
  for (let i = 0; i < CANARY_PROBE_BUDGET_DEFAULT; i++) {
    const out = await drivePre(ctx, exec('click_mouse', HIGH_RISK_CLICK));
    assert.equal(out.kind, 'accept');
  }
  assert.equal(canaryBudgetSnapshot().get('w2-7-test'), CANARY_PROBE_BUDGET_DEFAULT);
  assert.equal(fp.calls.click, CANARY_PROBE_BUDGET_DEFAULT * 2);
  const clicksBefore = fp.calls.click;

  const outOver = await drivePre(ctx, exec('click_mouse', HIGH_RISK_CLICK));
  assert.equal(outOver.kind, 'accept', '超支 ⇒ 让位放行（增益有度）');
  assert.equal(fp.calls.click, clicksBefore, '超支后探针零消费');
  assert.ok(telemetry.snapshot().counters.some(c => c.counter === 'canary:skip-budget-exhausted'));
  // 预算按会话分键：另一会话不受本会话超支牵连
  const other = await drivePre(ctx, exec('click_mouse', HIGH_RISK_CLICK, 'w2-7-other-session'));
  assert.equal(other.kind, 'accept');
  assert.equal(fp.calls.click, clicksBefore + 2, '新会话有自己的预算');
});

test('W2-7⑤: destructive 豁免直审批 —— 危险词/显式分层不试演，放行给既有审批闸门', async () => {
  relaxHighProceed();
  const ctx = fakeCtx();
  const fp = fakePorts();
  registerCanaryGuard(ctx, CFG, fp.ports);

  const out1 = await drivePre(ctx, exec('click_mouse', { ...HIGH_RISK_CLICK, target_description: 'send the email' }));
  assert.equal(out1.kind, 'accept', '不拦截 —— 交给 actionGate 直接审批');
  const out2 = await drivePre(ctx, exec('click_mouse', { ...HIGH_RISK_CLICK, risk_tier: 'destructive' }));
  assert.equal(out2.kind, 'accept');
  assert.equal(fp.calls.click + fp.calls.typeChar, 0, 'destructive ⇒ 探针零消费');
  const evs = recentCanaryEvents();
  assert.equal(evs.length, 2);
  assert.ok(evs.every(e => e.action === 'exempt-destructive'));
  assert.ok(telemetry.snapshot().counters.some(c => c.counter === 'canary:destructive-exempt' && c.hits === 2));
});

test('W2-7⑤: 已授予令牌的调用 ⇒ 金丝雀让位（人已裁决，不再打扰）', async () => {
  relaxHighProceed();
  armOob(); // W6R：授予须带外码
  const ctx = fakeCtx();
  const fp = fakePorts();
  registerCanaryGuard(ctx, CFG, fp.ports);
  const pa = approval.request('user consented');
  grantOob(pa.token);
  const out = await drivePre(ctx, exec('click_mouse', { ...HIGH_RISK_CLICK, approval_token: pa.token }));
  assert.equal(out.kind, 'accept');
  assert.equal(fp.calls.click, 0);
  assert.equal(recentCanaryEvents().length, 0, '让位不产生试演事件');
  assert.ok(telemetry.snapshot().counters.some(c => c.counter === 'canary:skip-approval-present'));
});

test('W2-7⑤: 默认内核零回归 —— 全链放行、探针零消费（出厂 highProceed 不可达）', async () => {
  const ctx = fakeCtx();
  const fp = fakePorts();
  registerCanaryGuard(ctx, CFG, fp.ports);
  const out = await drivePre(ctx, exec('click_mouse', { ...HIGH_RISK_CLICK, confidence: 1 }));
  assert.equal(out.kind, 'accept');
  assert.equal(fp.calls.click, 0);
  assert.equal(recentCanaryEvents().length, 0);
});

test('W2-7⑤: 事件环有界（16 条环形淘汰）+ resetCanaryGuard 归零', async () => {
  relaxHighProceed();
  const ctx = fakeCtx();
  const fp = fakePorts({ h0: 'aaaaaaaa', h1: '00000000', h2: 'aaaaaaaa' });
  registerCanaryGuard(ctx, CFG, fp.ports);
  for (let s = 0; s < 3; s++) {
    for (let i = 0; i < CANARY_PROBE_BUDGET_DEFAULT; i++) {
      await drivePre(ctx, exec('click_mouse', HIGH_RISK_CLICK, `w2-7-session-${s}`));
    }
  }
  // 3 会话 × 6 次 = 18 对 triggered/passed = 36 条 ⇒ 环只留 16
  assert.equal(recentCanaryEvents().length, 16);
  resetCanaryGuard();
  assert.equal(recentCanaryEvents().length, 0);
  assert.equal(canaryBudgetSnapshot().size, 0, '预算账本一并归零');
});

// ─── 6. 生产端口：零孵化纪律 ───

// ─── 5b. W6R 收口：令牌路径（审批域活口）探针缺席/失败 ⇒ fail-closed ───

test('W6R: 携带审批令牌的调用 + 探针缺席 ⇒ fail-closed 拦截（出路指明；非令牌调用不受扰）', async () => {
  relaxHighProceed();
  const ctx = fakeCtx();
  registerCanaryGuard(ctx, CFG); // 不注入端口 ⇒ 生产端口 ⇒ healthSnapshot 缺席 ⇒ unavailable
  // 悬置令牌（request 未 grant）：既不构成 approval-present 让位、也不命中危险词
  // —— 这是「携带审批令牌且进入试演」的唯一活口（W6R 注释法条）
  const pa = approval.request('expand options under token protocol');

  const out = await drivePre(ctx, exec('click_mouse', { ...HIGH_RISK_CLICK, approval_token: pa.token }));
  assert.equal(out.kind, 'deny', '令牌路径探针缺席 ⇒ 拦截（fail-closed，不再降级放行）');
  assert.match(out.reason, /\[Canary\]/);
  assert.match(out.reason, /fail-closed/);
  assert.match(out.reason, /allowUnverifiedDangerous=true/, '出路三：显式逃生门');
  assert.match(out.reason, /重试|①/, '出路一：重试');
  const ev = recentCanaryEvents()[0];
  assert.equal(ev.action, 'blocked', '事件环记 blocked（fail-closed 拦截）');
  assert.ok(ev.why.includes('fail-closed'));
  assert.ok(ev.degradedNotes!.length > 0, '探针缺席注记随行（证据链）');
  assert.ok(telemetry.snapshot().counters.some(c => c.counter === 'canary:blocked' && c.hits === 1));

  // 对照组（非令牌）：同一探针缺席 ⇒ 仍降级放行（旧行为不变，避免大面积误杀）
  const benign = await drivePre(ctx, exec('click_mouse', HIGH_RISK_CLICK));
  assert.equal(benign.kind, 'accept', '非令牌动作探针缺席 ⇒ 降级放行（旧行为）');
  assert.equal(recentCanaryEvents()[0].action, 'degraded');
});

test('W6R: 逃生门 allowUnverifiedDangerous=true ⇒ 令牌路径探针缺席恢复降级放行；dry-run 豁免同律', async () => {
  relaxHighProceed();
  // 逃生门开：令牌路径探针缺席 ⇒ 恢复 degraded 放行（部署显式接受未验证危险派发）
  const ctxEsc = fakeCtx();
  registerCanaryGuard(ctxEsc, { ...CFG, allowUnverifiedDangerous: true } as unknown as Config);
  const pa = approval.request('escape hatch armed');
  const out = await drivePre(ctxEsc, exec('click_mouse', { ...HIGH_RISK_CLICK, approval_token: pa.token }));
  assert.equal(out.kind, 'accept', '逃生门 ⇒ 降级放行（旧 fail-open 方言）');
  const ev = recentCanaryEvents()[0];
  assert.equal(ev.action, 'degraded');
  assert.ok(!ev.why.includes('fail-closed'));

  // dry-run 豁免：无物理世界可探，令牌路径也不因探针缺席被拦（防模拟误杀）
  const ctxDry = fakeCtx();
  registerCanaryGuard(ctxDry, { ...CFG, dryRun: true } as unknown as Config);
  const pb = approval.request('dry-run token');
  const outDry = await drivePre(ctxDry, exec('click_mouse', { ...HIGH_RISK_CLICK, approval_token: pb.token }));
  assert.equal(outDry.kind, 'accept', 'dry-run ⇒ 不拦截（探针拒绝派发属设计，非故障）');
  assert.equal(recentCanaryEvents()[0].action, 'degraded');
});

test('W2-7⑥: productionCanaryPorts —— 后端不在场 ⇒ 派发拒绝 + 帧通道缺席（零孵化）', async () => {
  const ports = productionCanaryPorts(CFG);
  assert.equal(await ports.click!({ x: 0.5, y: 0.5 }), false, '不孵化服务来试演');
  assert.equal(await ports.typeChar!('x'), false);
  assert.equal(await ports.backspace!(), false);
  assert.equal(await ports.regionHash!({ x: 0.5, y: 0.5 }, 0.06), null, '帧通道诚实缺席');
  // type 探针的焦点槽：焦点缺席 ⇒ regionHash(null) 仍诚实缺席（不伪造）
  assert.equal(await ports.regionHash!(null, 0.06), null);
});
