// test/f2-9.guards.test.ts
// ΠΑΝ 修复潮 工单 ΠΑΝ-76~80 执法册（守卫族 + checkpoint 防御缺陷）：
//   ΠΑΝ-76 会话 LRU 洪泛防护（分保护区 + 新会话速率限制 —— 洪泛不驱逐熔断/预算记忆）
//   ΠΑΝ-77 金丝雀多源证据（自述 + OCR 实读交叉，任一危险即拦）
//   ΠΑΝ-78 防死循环路径不变量（起终点包围盒 + 途经熵 —— 微调逃逸命中）
//   ΠΑΝ-79 守卫总兜底（守卫异常记账不阻断主流程）
//   ΠΑΝ-80 checkpoint approvalQueue 段完整性（HMAC 信封三态 + 死缓存移除）
//      + 金丝雀锚扩展到裁决面（adjudicate 路径也过 canary）
// 全离线确定性：物理端口/OCR 通道全部注入假件；时钟注入或真钟窗口内完成。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SessionLruCache } from '../src/guards/sessionLru.ts';
import { onToolPre, onToolPost } from '../src/guards/hooks.ts';
import { registerCircuitBreakerGuard } from '../src/guards/circuitBreakerGuard.ts';
import { registerRepeatActionGuard } from '../src/guards/repeatActionGuard.ts';
import {
  classifyCanaryTrigger, registerCanaryGuard, recentCanaryEvents,
  canaryBudgetSnapshot, resetCanaryGuard, productionCanaryPorts,
  type CanaryProbePorts,
} from '../src/guards/canaryGuard.ts';
import { kernelRegistry } from '../src/kernel/registry.ts';
import { approvalQueue, resetApproval } from '../src/approval.ts';
import { telemetry } from '../src/telemetry.ts';
import { journal } from '../src/journal.ts';
import { focusTracker } from '../src/focusTracker.ts';
import { updatePopupState, resetPopupState } from '../src/guards/popupGuard.ts';
import {
  saveCheckpoint, loadCheckpoint, checkpointSectionStats, resetCheckpointSectionCache,
} from '../src/checkpoint.ts';
import { uiMemory } from '../src/uiMemory.ts';
import { failureMemory } from '../src/failureMemory.ts';
import { skillLibrary } from '../src/skillLibrary.ts';
import type { Config } from '../src/config.ts';

// ─── 测试基建（epochY6/w2canary 同款） ───

interface RegisteredHandler {
  event: string;
  handler: (exec: any, result: any, next: () => Promise<any>) => Promise<any>;
}
function fakeCtx() {
  const handlers: RegisteredHandler[] = [];
  return { handlers, on(event: string, handler: any) { handlers.push({ event, handler }); return () => {}; } } as any;
}
function exec(name: string, args: unknown, sessionId?: string): any {
  return { name, arguments: args, ...(sessionId ? { agent: { id: sessionId } } : {}), token: {}, rootCallId: 'c1' };
}
async function drivePre(ctx: any, e: any): Promise<any> {
  const h = ctx.handlers.find((r: RegisteredHandler) => r.event === 'tools/pre-execute')!;
  return h.handler(e, async () => ({ kind: 'accept' }));
}
async function drivePost(ctx: any, e: any, result: any): Promise<any> {
  const h = ctx.handlers.find((r: RegisteredHandler) => r.event === 'tools/post-execute')!;
  return h.handler(e, result, async (v: any) => v ?? result);
}
const FAILED_RESULT = { isError: false, value: '{\n  "status": "FAILED",\n  "state_anchor": {}\n}' };
const OK_RESULT = { isError: false, value: '{\n  "status": "SUCCESS",\n  "state_anchor": {}\n}' };
async function act(ctx: any, name: string, args: unknown, sessionId: string): Promise<any> {
  const e = exec(name, args, sessionId);
  const v = await drivePre(ctx, e);
  if (v.kind === 'accept') await drivePost(ctx, e, OK_RESULT);
  return v;
}

/** 放宽 highProceed（w2canary 同款）：再现「部署放宽免检线」的试演前件 */
function relaxHighProceed(threshold = 0.7): void {
  kernelRegistry.register({ key: 'uncertainty.highProceed', organ: 'pan77-test', defaultValue: threshold, min: 0, max: 1 });
}
const CFG = {
  dangerPatterns: 'send,delete,支付',
  noopSimilarityThreshold: 0.97,
  probeRegionRadius: 0.06,
  dryRun: false,
  focusMaxAgeMs: 30_000,
} as unknown as Config;
const HIGH_RISK_CLICK = {
  x: 0.5, y: 0.5, target_description: 'Expand Advanced Options',
  expected_change: 'advanced settings panel expands', confidence: 0.95,
};

/** 可编程假端口（w2canary 同款）+ ΠΑΝ-77 的 OCR 通道脚本 */
function fakePorts(script: {
  h0?: string; h1?: string; h2?: string;
  regionText?: string | null;
} = {}) {
  const calls = { click: 0, typeChar: 0, backspace: 0, hash: 0, ocr: 0 };
  const hashes = [script.h0 ?? 'aaaaaaaa', script.h1 ?? '00000000', script.h2 ?? 'aaaaaaaa'];
  let hashIdx = 0;
  const ports: CanaryProbePorts = {
    click: async () => { calls.click++; return true; },
    typeChar: async () => { calls.typeChar++; return true; },
    backspace: async () => { calls.backspace++; return true; },
    regionHash: async () => { calls.hash++; const h = hashes[hashIdx % hashes.length]; hashIdx++; return h; },
    ...(script.regionText !== undefined
      ? {
        readRegionText: async () => {
          calls.ocr++;
          return script.regionText as string | null;
        },
      }
      : {}),
  };
  return { calls, ports };
}

let dir: string;
const dirs: string[] = [];
beforeEach(() => {
  kernelRegistry.reset();
  resetCanaryGuard();
  resetPopupState();
  telemetry.reset();
  resetApproval();
  focusTracker.clear();
  updatePopupState(false);
  journal.reset();
  uiMemory.reset();
  failureMemory.reset();
  skillLibrary.reset();
  resetCheckpointSectionCache();
  dir = mkdtempSync(path.join(tmpdir(), 'pan-f29-'));
  dirs.push(dir);
});
process.on('exit', () => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

// ═══ ΠΑΝ-76：会话 LRU 洪泛防护 ═════════════════════════════════════

test('ΠΑΝ-76①: SessionLruCache —— 窗口限流（超限新键不驻留、不驱逐旧键）+ 翻窗恢复', () => {
  let t = 1_000_000;
  const clock = () => t;
  let limited = 0;
  const c = new SessionLruCache<{ prot: boolean; tag: string }>({
    capacity: 4, isProtected: v => v.prot, maxNewKeysPerWindow: 2, windowMs: 60_000, now: clock,
    onNewKeyLimited: () => { limited++; },
  });
  // 两个新键入窗（都带安全内容 ⇒ 保护）
  const a = c.admit('A', () => ({ prot: true, tag: 'a' }));
  const b = c.admit('B', () => ({ prot: true, tag: 'b' }));
  assert.equal(a.limited, false);
  assert.equal(b.limited, false);
  // 第 3 个新键超窗限 ⇒ 临时实例（不驻留、绝不驱逐 A/B）
  const c3 = c.admit('C', () => ({ prot: true, tag: 'c' }));
  assert.equal(c3.limited, true, '窗口内新键超限 ⇒ 降级无历史');
  assert.equal(limited, 1);
  assert.equal(c.get('A')?.tag, 'a', '洪泛不驱逐安全态键（A 在）');
  assert.equal(c.get('B')?.tag, 'b', 'B 在');
  assert.equal(c.has('C'), false, '限流键未驻留');
  // 翻窗（+61s）⇒ 新键额度重置
  t += 61_000;
  const c3b = c.admit('C', () => ({ prot: true, tag: 'c' }));
  assert.equal(c3b.limited, false, '翻窗后新键恢复接纳');
  assert.equal(c.get('C')?.tag, 'c');
});

test('ΠΑΝ-76②: SessionLruCache —— 容量上界：普通键先逐、安全键只经陈旧清扫离场', () => {
  let t = 1_000_000;
  const clock = () => t;
  const c = new SessionLruCache<{ prot: boolean }>({
    capacity: 3, isProtected: v => v.prot, maxNewKeysPerWindow: 99, windowMs: 1_000, protectedIdleMs: 30 * 60_000, now: clock,
  });
  c.admit('P', () => ({ prot: true }));
  c.admit('U1', () => ({ prot: false }));
  c.admit('U2', () => ({ prot: false })); // P+U1+U2 = 3（满）
  const u3 = c.admit('U3', () => ({ prot: false }));
  assert.equal(u3.limited, false);
  assert.equal(c.has('U1'), false, '容量满 ⇒ 逐最旧普通键（U1）');
  assert.equal(c.has('P'), true, '安全键优先保留（P 不为新键腾位）');
  // 逐普通键直至普通桶空（U2、U3 相继让位），桶内只剩安全态
  c.admit('P2', () => ({ prot: true }));
  c.admit('P3', () => ({ prot: true }));
  assert.equal(c.has('P2'), true);
  assert.equal(c.has('P3'), true);
  // 全安全态占满 ⇒ 新键拒收（绝不驱逐安全态来给新键腾位）
  const p4 = c.admit('P4', () => ({ prot: true }));
  assert.equal(p4.limited, true, '安全桶满 ⇒ 新键限流（不驱逐 P/P2/P3）');
  assert.equal(c.has('P') && c.has('P2') && c.has('P3'), true);
  // 陈旧清扫：安全键 30min 无 touch ⇒ 遗忘（洪泛触不到的离场通道）
  t += 30 * 60_000 + 1;
  const fresh = c.admit('NEW', () => ({ prot: false }));
  assert.equal(fresh.limited, false);
  assert.equal(c.has('P'), false, '陈旧安全键经清扫离场（有界周转）');
});

test('ΠΑΝ-76③: 熔断记忆洪泛不驱逐 —— 128 新会话冲不掉受害者会话的冷静期', async () => {
  const ctx = fakeCtx();
  registerCircuitBreakerGuard(ctx, 3);
  // 受害者会话：3 连败 ⇒ 第 4 次熔断（冷静期在场）
  for (let i = 0; i < 3; i++) {
    const e = exec('click_mouse', { x: 0.4, y: 0.4 }, 'victim');
    await drivePre(ctx, e);
    await drivePost(ctx, e, FAILED_RESULT);
  }
  const tripped = await drivePre(ctx, exec('click_mouse', { x: 0.4, y: 0.4 }, 'victim'));
  assert.equal(tripped.kind, 'deny', '受害者会话熔断触发');
  // 攻击：128 个新会话各来一次失败调用（旧实现按插入序逐出 ⇒ victim 冷静期蒸发）
  for (let i = 0; i < 128; i++) {
    const e = exec('click_mouse', { x: 0.1, y: 0.1 }, `flood-${i}`);
    await drivePre(ctx, e);
    await drivePost(ctx, e, FAILED_RESULT);
  }
  // victim 的记忆仍在：冷静期轮转语义保持 —— 半开探针位放行一次、拦截位照拦
  const probe = await drivePre(ctx, exec('click_mouse', { x: 0.4, y: 0.4 }, 'victim'));
  assert.equal(probe.kind, 'accept', '半开探针位（冷静期轮转的既有语义）');
  const still = await drivePre(ctx, exec('click_mouse', { x: 0.4, y: 0.4 }, 'victim'));
  assert.equal(still.kind, 'deny', '洪泛 128 会话后熔断冷静期仍在场（ΠΑΝ-76 执法点）');
  assert.match(String(still.reason), /Circuit Breaker cooldown/);
  // 限流记账在册（不静默）
  assert.ok(
    telemetry.snapshot().counters.some(c => c.counter === 'circuit-breaker:new-session-limited' && c.misses >= 1),
    '新会话限流以 miss 计数入遥测',
  );
});

test('ΠΑΝ-76④: 金丝雀预算账洪泛不重置 —— 受害者会话的已用次数逐字保留', async () => {
  relaxHighProceed();
  const ctx = fakeCtx();
  const fp = fakePorts({ h0: 'aaaaaaaa', h1: '00000000', h2: 'aaaaaaaa' });
  registerCanaryGuard(ctx, CFG, fp.ports);
  // 受害者会话消耗 2 次探针预算
  await drivePre(ctx, exec('click_mouse', HIGH_RISK_CLICK, 'victim'));
  await drivePre(ctx, exec('click_mouse', HIGH_RISK_CLICK, 'victim'));
  assert.equal(canaryBudgetSnapshot().get('victim'), 2);
  // 攻击：20 个新会话各触发一次试演（旧实现插入序淘汰 ⇒ 可挤掉 victim 的账）
  for (let i = 0; i < 20; i++) {
    await drivePre(ctx, exec('click_mouse', HIGH_RISK_CLICK, `flood-${i}`));
  }
  assert.equal(canaryBudgetSnapshot().get('victim'), 2, '洪泛不重置既有会话的探针预算（ΠΑΝ-76）');
  // 窗内新键额度 8 被 victim 占 1 ⇒ 洪泛会话中 7 个获预算、13 个被限流零试演
  // （限流新会话不试演：探针是真实物理动作，不给洪泛者无限量临时预算）
  assert.equal(fp.calls.click, 2 * 2 + 7 * 2, 'victim 2 次 + 获额度洪泛会话 7 次试演（各 2 击）；限流会话零派发');
  assert.ok(
    telemetry.snapshot().counters.some(c => c.counter === 'canary:budget-new-session-limited' && c.misses >= 1),
    '预算限流以 miss 计数入遥测',
  );
});

// ═══ ΠΑΝ-77：金丝雀多源证据（自述 + OCR 实读交叉） ═══════════════

test('ΠΑΝ-77①: 分类面 —— OCR 实读报危 ⇒ danger-cross；否证幂等 ⇒ 不可论证；缺席 ⇒ 零回归', () => {
  relaxHighProceed();
  const dp = { dangerPatterns: CFG.dangerPatterns };
  // 零回归：证据缺席（不传 regionText）⇒ 自述单源行为不变
  const none = classifyCanaryTrigger('click_mouse', HIGH_RISK_CLICK, dp);
  assert.equal(none.kind, 'rehearse', 'OCR 缺席 ⇒ 自述单源（逐字节旧行为）');
  // 自述无害 + 实读报危 ⇒ danger-cross（任一危险即拦）
  const danger = classifyCanaryTrigger('click_mouse', HIGH_RISK_CLICK, { ...dp, regionText: 'Send payment now' });
  assert.equal(danger.kind, 'danger-cross', 'OCR 实读命中危险词 ⇒ 交叉拦截');
  // 自述幂等 + 实读否证（非幂等文本）⇒ 论证不出可逆探针
  const veto = classifyCanaryTrigger('click_mouse', HIGH_RISK_CLICK, { ...dp, regionText: 'Article title' });
  assert.equal(veto.kind, 'skip');
  assert.equal((veto as any).why, 'no-reversible-probe', '实读否决自述幂等标签');
  // 自述幂等 + 实读同意 ⇒ 照常试演
  const agree = classifyCanaryTrigger('click_mouse', HIGH_RISK_CLICK, { ...dp, regionText: 'chevron menu' });
  assert.equal(agree.kind, 'rehearse');
  // 空串实读（区域无字）⇒ 无法证实幂等 ⇒ 否决
  const blank = classifyCanaryTrigger('click_mouse', HIGH_RISK_CLICK, { ...dp, regionText: '' });
  assert.equal((blank as any).why, 'no-reversible-probe', '空实读同律否决（不冒险试演）');
  // type 探针：焦点区实读带即时反应信号 ⇒ 并联降级
  const ir = classifyCanaryTrigger('type_text', {
    text: 'quarterly report', expected_change: 'typed text appears', confidence: 0.95,
  }, { ...dp, regionText: 'GitHub search box' });
  assert.equal((ir as any).why, 'no-reversible-probe', 'OCR 即时反应并联源命中');
});

test('ΠΑΝ-77②: 全链 —— 自述 "Expand Options" 而落点实读 "Send payment now" ⇒ 拦截 + 降级问人（探针零派发）', async () => {
  relaxHighProceed();
  const ctx = fakeCtx();
  const fp = fakePorts({ h0: 'aaaaaaaa', h1: '00000000', h2: 'aaaaaaaa', regionText: 'Send payment now' });
  registerCanaryGuard(ctx, CFG, fp.ports);
  const out = await drivePre(ctx, exec('click_mouse', HIGH_RISK_CLICK));
  assert.equal(out.kind, 'deny', '多源交叉报危 ⇒ 拦截');
  assert.match(out.reason, /\[Canary\]/);
  assert.match(out.reason, /多源证据交叉|danger-cross|OCR/, '拒绝消息说明证据矛盾');
  assert.match(out.reason, /APR-[0-9A-F]+/, '降级问人：审批令牌随行');
  assert.equal(fp.calls.click, 0, '不带矛盾证据试演（探针零派发）');
  assert.equal(fp.calls.ocr, 1, 'OCR 只对自述判 rehearse 的调用采集一次');
  const ev = recentCanaryEvents()[0];
  assert.equal(ev.action, 'blocked');
  assert.ok(ev.why.includes('交叉') || ev.why.includes('OCR'), '事件环记录交叉证据');
  assert.ok(telemetry.snapshot().counters.some(c => c.counter === 'canary:blocked' && c.hits === 1));
});

test('ΠΑΝ-77③: 全链 —— 实读否证幂等 ⇒ 跳过试演旁路记账；OCR 通道缺席 ⇒ 旧行为零回归', async () => {
  relaxHighProceed();
  const ctx = fakeCtx();
  const fp = fakePorts({ h0: 'aaaaaaaa', h1: '00000000', h2: 'aaaaaaaa', regionText: 'Submit article' });
  registerCanaryGuard(ctx, CFG, fp.ports);
  const out = await drivePre(ctx, exec('click_mouse', HIGH_RISK_CLICK));
  assert.equal(out.kind, 'accept', '否证 ⇒ 让位放行（不试演不拦截）');
  assert.equal(fp.calls.click, 0, '探针零派发');
  assert.equal(recentCanaryEvents().length, 0, '让位不产生试演事件');
  assert.equal(canaryBudgetSnapshot().size, 0, '预算不记账（未试演）');
  // 对照：无 OCR 通道 ⇒ 同一调用照常试演（零回归）
  const ctx2 = fakeCtx();
  const fp2 = fakePorts({ h0: 'aaaaaaaa', h1: '00000000', h2: 'aaaaaaaa' });
  registerCanaryGuard(ctx2, CFG, fp2.ports);
  const out2 = await drivePre(ctx2, exec('click_mouse', HIGH_RISK_CLICK));
  assert.equal(out2.kind, 'accept');
  assert.equal(fp2.calls.click, 2, 'OCR 缺席 ⇒ 点击回点探针照常（ΠΑΝ-77 前行为）');
});

// ═══ ΠΑΝ-78：防死循环路径不变量（微调逃逸收网） ═══════════════════

test('ΠΑΝ-78①: >0.05 步长三角轮换 —— 近参数臂失明的逃逸形状被路径不变量命中', async () => {
  const ctx = fakeCtx();
  registerRepeatActionGuard(ctx);
  // 三个两两间距 ≈0.12（>0.05，1080p 上 ~130px）的路径点轮换 —— 每点近参数
  // 计数 ≤3 < 5：旧实现对这条轨迹永不触发（C2-1 F16 的逃逸面）
  const tri: Array<[number, number]> = [[0.40, 0.40], [0.52, 0.40], [0.46, 0.52]];
  for (let i = 0; i < 8; i++) {
    const [x, y] = tri[i % 3]!;
    const v = await act(ctx, 'click_mouse', { x, y }, 'pan78-rot');
    if (i < 5) {
      assert.equal(v.kind, 'accept', `第 ${i + 1} 次轮换放行（同键形样本 ${i + 1} < 6）`);
    } else {
      assert.equal(v.kind, 'deny', '第 6 次起命中路径不变量（同区域往返）');
      assert.match(String(v.reason), /Region loop detected/, '路径不变量拦截文案');
      assert.match(String(v.reason), /bounding-box|waypoint entropy/, '文案指明不变量证据');
    }
  }
});

test('ΠΑΝ-78②: 不误杀面 —— 近距双目标乒乓 / 一次性多点选取 / 跨区域换目标全放行', async () => {
  const ctx = fakeCtx();
  registerRepeatActionGuard(ctx);
  // 近距双目标乒乓（0.50↔0.56，间距 0.06 > 近参数阈 —— 旧臂失明）：熵恒 ≤1 bit
  // ⇒ 路径不变量保持「交替双目标不得误杀」的既有豁免
  for (let i = 0; i < 8; i++) {
    const v = await act(ctx, 'click_mouse', { x: i % 2 === 0 ? 0.50 : 0.56, y: 0.5 }, 'pan78-ping');
    assert.equal(v.kind, 'accept', `近距双目标乒乓 ${i + 1}/8 放行（豁免保持）`);
  }
  // 一次性多点选取（紧凑区域内 6 个不同点、无折返）—— 不算往返
  const sweep = [0.40, 0.42, 0.44, 0.46, 0.48, 0.50];
  const ctx2 = fakeCtx();
  registerRepeatActionGuard(ctx2);
  for (const x of sweep) {
    const v = await act(ctx2, 'click_mouse', { x, y: 0.4 }, 'pan78-sweep');
    assert.equal(v.kind, 'accept', `一次性选取 ${x} 放行（无折返 ⇒ 非往返）`);
  }
  // 跨区域换目标（跨度 0.4 > 0.15）⇒ 包围盒越界不判
  const ctx3 = fakeCtx();
  registerRepeatActionGuard(ctx3);
  for (let i = 0; i < 8; i++) {
    const v = await act(ctx3, 'click_mouse', { x: i % 2 === 0 ? 0.1 : 0.5, y: 0.5 }, 'pan78-far');
    assert.equal(v.kind, 'accept', '跨区域往返不误杀');
  }
});

// ═══ ΠΑΝ-79：守卫总兜底（异常记账不阻断） ═════════════════════════

test('ΠΑΝ-79①: pre 守卫 handler 抛异常 ⇒ fail-open 放行 + 计数告警（不静默、不击穿管线）', async () => {
  const ctx = fakeCtx();
  onToolPre(ctx, async () => { throw new Error('guard-boom'); });
  const out = await drivePre(ctx, exec('click_mouse', { x: 0.5, y: 0.5 }, 's1'));
  assert.equal(out.kind, 'accept', '守卫异常绝不阻断主流程（fail-open）');
  assert.ok(
    telemetry.snapshot().counters.some(c => c.counter === 'guard:handler-crash' && c.misses >= 1),
    '计数告警在册（guard:handler-crash）',
  );
});

test('ΠΑΝ-79②: post 守卫 handler 抛异常 ⇒ 原结果透传（零伪造）+ 记账', async () => {
  const ctx = fakeCtx();
  onToolPost(ctx, async () => { throw new Error('post-boom'); });
  const out = await drivePost(ctx, exec('click_mouse', { x: 0.5, y: 0.5 }, 's1'), FAILED_RESULT);
  assert.equal(out.kind, 'accept');
  assert.equal(out.content[0].text, FAILED_RESULT.value, '守卫故障 ⇒ 原结果逐字透传');
  assert.ok(telemetry.snapshot().counters.some(c => c.counter === 'guard:handler-crash'));
});

test('ΠΑΝ-79③: next 已消费后 handler 抛错 ⇒ 下游异常如实上抛（不吞不双驱）', async () => {
  const ctx2: any = { handlers: [], on(ev: string, handler: any) { ctx2.handlers.push({ event: ev, handler }); return () => {}; } };
  let downstreamRuns = 0;
  (onToolPre as any)(ctx2, async (_call: any, next: () => any) => {
    await next(); // 瀑布已续行
    downstreamRuns++;
    throw new Error('after-next-boom');
  });
  await assert.rejects(
    () => drivePre(ctx2, exec('click_mouse', { x: 0.5, y: 0.5 }, 's1')),
    /after-next-boom/,
    'next 已消费 ⇒ 异常属下游，如实上抛（绝不二次驱动 next）',
  );
  assert.equal(downstreamRuns, 1, '下游恰好执行一次（无双跑）');
});

// ═══ ΠΑΝ-80：checkpoint approvalQueue 段完整性 + 死缓存 + 裁决面金丝雀 ═══

/** 造一枚合法队列条目（decision 可选 —— granted/pending 变体由调用方定） */
function grantedEntry(): Record<string, unknown> {
  return {
    id: 'QA-TEST0001', token: 'APR-TESTTOKEN', description: 'staged irreversible click',
    evidence: {}, enqueuedAt: 1_000, ttlMs: 3_600_000, expiresAt: 9_999_999_999_999,
    decision: { verdict: 'granted', at: 1_200 },
  };
}

test('ΠΑΝ-80①: 信封往返 —— 密钥档同生、盘面为 v2 信封、trusted 恢复 granted 照常', () => {
  approvalQueue.restoreQueue([grantedEntry()]);
  const file = path.join(dir, 'cp.json');
  assert.equal(saveCheckpoint(file).ok, true);
  assert.equal(existsSync(file + '.aq.key'), true, 'HMAC 密钥档与 checkpoint 同生');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
  assert.equal(raw.approvalQueue.v, 2, 'approvalQueue 段为信封形态（v2）');
  assert.equal(raw.approvalQueue.alg, 'hmac-sha256');
  assert.match(raw.approvalQueue.mac, /^[0-9a-f]{64}$/, 'mac 在场（sha256 hex）');
  // 可信往返：恢复后 granted 在场（可续跑语义保持）
  approvalQueue.restoreQueue([]); // 清内存面，独证恢复来源
  const r = loadCheckpoint(file);
  assert.equal(r.restored, true);
  assert.ok(r.report.every(x => !x.includes('TAMPERED') && !x.includes('INTEGRITY UNPROVEN')), r.report.join('; '));
  const entries = approvalQueue.dumpQueue();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.decision?.verdict, 'granted', 'trusted ⇒ granted 照常恢复');
});

test('ΠΑΝ-80②: 篡改（改 payload 保 mac）⇒ 整段拒绝、队列归零、报告置顶', () => {
  approvalQueue.restoreQueue([grantedEntry()]);
  const file = path.join(dir, 'cp.json');
  saveCheckpoint(file);
  // 篡改：payload 内塞一枚伪造 granted 条目，mac 保持旧值
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
  const payload = JSON.parse(raw.approvalQueue.payload) as { entries: unknown[] };
  payload.entries.push({ ...grantedEntry(), id: 'QA-EVIL', token: 'APR-EVIL' });
  raw.approvalQueue.payload = JSON.stringify(payload);
  writeFileSync(file, JSON.stringify(raw));
  approvalQueue.restoreQueue([]);
  const r = loadCheckpoint(file);
  assert.equal(r.restored, true);
  assert.ok(r.report[0]!.includes('TAMPERED'), '报告置顶：篡改拒绝');
  assert.equal(approvalQueue.dumpQueue().length, 0, '伪造 granted 无从恢复（整段归零）');
});

test('ΠΑΝ-80③: 不可信三态 —— 密钥缺席 / 旧版明文段 ⇒ 条目恢复但 granted 剥离（fail-closed）', () => {
  approvalQueue.restoreQueue([grantedEntry()]);
  const file = path.join(dir, 'cp.json');
  saveCheckpoint(file);
  // 密钥缺席（跨机迁移/只读介质）：内容读回但不可信 ⇒ granted 剥回待批
  unlinkSync(file + '.aq.key');
  approvalQueue.restoreQueue([]);
  let r = loadCheckpoint(file);
  assert.ok(r.report.some(x => x.includes('INTEGRITY UNPROVEN') && x.includes('stripped')), '不可信注记在册');
  let entries = approvalQueue.dumpQueue();
  assert.equal(entries.length, 1, '条目本体照常恢复（晨报可见）');
  assert.equal(entries[0]!.decision, undefined, 'granted 裁决被剥离（不可凭不可信盘面铸已授予令牌）');

  // 旧版明文段（ΠΑΝ-80 前的 checkpoint）：结构兼容读回但同律剥离
  saveCheckpoint(file); // 重新生成（信封 + 密钥）
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
  raw.approvalQueue = { entries: [grantedEntry()] }; // 降级为旧版明文段
  writeFileSync(file, JSON.stringify(raw));
  approvalQueue.restoreQueue([]);
  r = loadCheckpoint(file);
  assert.ok(r.report.some(x => x.includes('INTEGRITY UNPROVEN')), '旧版明文段同律不可信');
  entries = approvalQueue.dumpQueue();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.decision, undefined, '旧版段的 granted 同律剥离（升级部署不丢队列）');
});

test('ΠΑΝ-80④: 死缓存移除（C1-1 M3）—— journal 快路径保持、非 journal 段计数如实每保必付', async () => {
  await journal.append({ ts: 1_000, tool: 'click_mouse', args: { x: 0.5 }, status: 'SUCCESS' });
  const file = path.join(dir, 'cp.json');
  saveCheckpoint(file);
  const stats1 = checkpointSectionStats();
  assert.equal(stats1['journal'], 1);
  saveCheckpoint(file);
  const stats2 = checkpointSectionStats();
  assert.equal(stats2['journal'], 1, 'journal 指纹未变 ⇒ 零重序列化（快路径保持）');
  assert.equal(stats2['uiMemory'], 2, '非 journal 段如实计数：每保必付（指纹缓存剧场已移除）');
  await journal.append({ ts: 2_000, tool: 'type_text', args: { text: 'hi' }, status: 'SUCCESS' });
  saveCheckpoint(file);
  assert.equal(checkpointSectionStats()['journal'], 2, '日志变更 ⇒ 该段全量重算');
});

test('ΠΑΝ-80⑤: 金丝雀锚扩展到裁决面 —— 无码 grant 被拦、携码放行、deny 永远可行', async () => {
  const ctx = fakeCtx();
  const fp = fakePorts();
  registerCanaryGuard(ctx, CFG, fp.ports);
  // 无码 grant（模型自述同意）⇒ fail-closed 拦截（与队列侧 ΠΑΝ-1 同律）
  const noCode = await drivePre(ctx, exec('adjudicate_approval_queue', { grant: true }, 's1'));
  assert.equal(noCode.kind, 'deny');
  assert.match(noCode.reason, /confirm_code/, '出路指明：带外确认码');
  assert.match(noCode.reason, /grant=false|拒绝/, '出路指明：deny 不需要码');
  const ev = recentCanaryEvents()[0];
  assert.equal(ev.action, 'blocked', '事件环记 blocked');
  assert.ok(telemetry.snapshot().counters.some(c => c.counter === 'canary:blocked' && c.hits === 1));
  // 携码 grant（证据在场性 ✓ —— 码真伪由队列侧执法）⇒ 放行
  const withCode = await drivePre(ctx, exec('adjudicate_approval_queue', { grant: true, confirm_code: '123456' }, 's1'));
  assert.equal(withCode.kind, 'accept', '携码 grant 过金丝雀（队列侧 ΠΑΝ-1 校验真伪）');
  const withMap = await drivePre(ctx, exec('adjudicate_approval_queue', { grant: true, confirm_code: { 'QA-1': '654321' } }, 's1'));
  assert.equal(withMap.kind, 'accept', '逐条目码表形态同律');
  // deny 永远可行（不需要人证）
  const deny = await drivePre(ctx, exec('adjudicate_approval_queue', { grant: false }, 's1'));
  assert.equal(deny.kind, 'accept');
  // 审批闸关闭 ⇒ 队列 inactive，金丝雀不越权拦截
  const ctxOff = fakeCtx();
  registerCanaryGuard(ctxOff, { ...CFG, enableApprovalGate: false } as unknown as Config, fp.ports);
  const off = await drivePre(ctxOff, exec('adjudicate_approval_queue', { grant: true }, 's1'));
  assert.equal(off.kind, 'accept', '审批闸关闭 ⇒ 裁决面金丝雀让位');
});

// ═══ 回归防线：生产端口新面零孵化纪律（ΠΑΝ-77 读屏通道同律） ═════════

test('ΠΑΝ-77④: productionCanaryPorts.readRegionText —— 后端不在场 ⇒ 诚实缺席（零孵化）', async () => {
  const ports = productionCanaryPorts(CFG);
  assert.equal(await ports.readRegionText!({ x: 0.5, y: 0.5 }, 0.06), null, '不孵化服务来读屏');
  assert.equal(await ports.readRegionText!(null, 0.06), null, '焦点槽缺席同律');
});
