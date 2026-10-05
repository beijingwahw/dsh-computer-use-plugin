// test/pan3437.fix.test.ts
// ΠΑΝ 修复潮 F2 波执法册（工单 ΠΑΝ-34~37）：
//   ΠΑΝ-34 escrow 生产通电（C1-2 H1 / C2-9 主题 1 A 级死器官）——
//     ① apply(enableReversibilityLanes) ⇒ armReversalEscrow 四命脉激活
//       （dispatchGate 钩子注册 / 结算钩子 / WAL 存储 / sweep 定时器），
//       开关关 ⇒ 零行为；卸载 ⇒ escrow.reset 键在册、模块态归零；
//     ② mintPlan 在途容量封顶（64 枚全在 TTL 内 ⇒ capacity-exceeded 拒绝；
//       过期预案收割腾位 ⇒ 补偿义务保留 + 新预案诚实降级标注）；
//     ③ 源级金丝雀：clickMouse 的 beginAttempt 携 laneGate 铸得的 planId
//       （dispatchGate 命脉的工具侧接线）、consume 消费点坐标级 hint。
//   ΠΑΝ-35 WAL 完整性 + 焦点校验（C1-2 H2/H3）——
//     ④ v3 行哈希链：篡改行弃置不应用（该事件不进内存态）、后继行不连坐、
//       walTamperedLines 观测面在册；
//     ⑤ 补偿前焦点校验：焦点不匹配 ⇒ 拒绝补偿转人工（fail-closed）、
//       采集失败同律；焦点匹配 ⇒ 补偿照常执行；预案无锚点 ⇒ 跳过（降级）；
//     ⑥ verifyThreshold 夹取：病态小值收编到 0.5 合理性下限、>1 夹到 1、
//       合法值原样。
//   ΠΑΝ-36 审批对接收尾 ——
//     ⑦ adjudicate 工具 confirm_code 贯通（string 单码 / per-id map 双形态；
//       无码 fail-closed + 指引；输出无码泄漏）；
//     ⑧ 坐标级 targetHint：绑定令牌的 consume/beginAttempt 携坐标比对，
//       不匹配拒绝且不焚毁（合法持有者携正确 hint 可再来）；
//     ⑨ mintResumedToken 继承原请求的目标绑定（续跑令牌同样限缩能力）。
//   ΠΑΝ-37 残余双花窗口闭合（F1-2 移交）——
//     ⑩ takeGranted 兑现 ⇒ 原交互令牌就地焚毁（窄窗内再交码也无敌二通道）；
//     ⑪ veto 撤销已批条目：交互 deny 传播撤销 granted（recordTokenDecision）
//       + adjudicate(grant=false) 工具面撤销（revoked_granted 计数），
//       撤销后 takeGranted 无从兑现。
// 全程离线确定性：注入时钟 / 注入端口 / tmp 目录存储；apply 用例走假 ctx
//（w0unload 同律）；不依赖 CSPRNG 具体取值（只断言格式与行为）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import { Config, type Config as ConfigType } from '../src/config.ts';
import {
  apply, lastUnloadActions,
} from '../src/index.ts';
import {
  approval, approvalQueue, resetApproval, setConfirmCodeChannel, type ConfirmCodeDelivery,
} from '../src/approval.ts';
import { escrowGateArmed } from '../src/approval.bypass.ts';
import { grantBucket } from '../src/approval.security.ts';
import {
  reversalEscrow, createEscrowFileStorage, type ReversalPlan,
} from '../src/reversalEscrow.ts';
import { createAdjudicateApprovalQueueTool } from '../src/tools/approvalTools.ts';
import { consumeApprovalWithHint } from '../src/tools/clickMouse.ts';

// ─── 测试基建（离线确定性） ───

const dirs: string[] = [];
let dir: string;
function newDir(): string {
  dir = mkdtempSync(path.join(tmpdir(), 'pan3437-'));
  dirs.push(dir);
  return dir;
}
process.on('exit', () => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

/** 注入时钟（escrow TTL / 容量收割判定的唯一时间源 —— 步进确定） */
let clockBase = 0;
let clockOffset = 0;
function now(): number { return clockBase + clockOffset; }
function advance(ms: number): void { clockOffset += ms; }

const HASH_A = '0'.repeat(64);

// ── 可控端口（w3escrow 同律的剧本化最小面） ──
let focusNow: string | null = 'Window - Drafts';
const focusPort = { current: async () => focusNow };
const hashPort = { capture: async () => HASH_A };
const execLog: Array<{ label: string; method: string }> = [];
const executorPort = {
  execute: async (step: { method: string; label: string }, _plan: ReversalPlan): Promise<{ ok: boolean; detail?: string }> => {
    execLog.push({ label: step.label, method: step.method });
    return { ok: true };
  },
};

/** 标准武装：注入时钟 + 可选 WAL 文件 + 剧本端口 */
function armEscrow(o: { walFile?: string | null; withFocus?: boolean } = {}): void {
  reversalEscrow.arm({
    now,
    storage: o.walFile === undefined || o.walFile === null ? null : createEscrowFileStorage(o.walFile),
    hashPort,
    clipboardPort: null,
    focusPort: o.withFocus === false ? null : focusPort,
    interruptPort: null,
    executorPort,
  });
}

/** 铸造一枚已授予令牌（带外码经采集 sink —— 生产中人类读码的视角） */
function grantedToken(description = 'click 删除 to remove report.docx'): { token: string; code: string } {
  const sink: ConfirmCodeDelivery[] = [];
  setConfirmCodeChannel(d => { sink.push({ ...d }); });
  const pa = approval.request(description);
  const g = approval.grantDetailed(pa.token, true, { confirmCode: sink[0]?.confirmCode });
  assert.equal(g.ok, true, JSON.stringify(g));
  return { token: pa.token, code: sink[0]!.confirmCode };
}

/** 采集型带外通道（队列暂存资格 + 码采集） */
const deliveries: Array<{ token: string; confirmCode: string }> = [];
function armChannel(): void {
  deliveries.length = 0;
  setConfirmCodeChannel(d => { deliveries.push({ token: d.token, confirmCode: d.confirmCode }); });
}
function codeOf(token: string): string {
  return deliveries.find(d => d.token === token)?.confirmCode ?? '';
}

/** 暂存一枚条目（stagingTimeoutMs:0 即刻成熟 —— w0unload 同律） */
function stageOne(desc = 'pan3437：离线暂存测试条目'): { token: string; id: string } {
  const pa = approval.request(desc);
  const r = approvalQueue.stageAction({ token: pa.token, description: desc, stagingTimeoutMs: 0 });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) throw new Error('unreachable');
  return { token: pa.token, id: r.entry.id };
}

/** 工具执行面便捷转换（w1approval 同律） */
type Exec = (args: unknown) => Promise<string>;
function exec(t: unknown): Exec {
  return (t as unknown as { execute: (a: unknown) => Promise<string> }).execute.bind(t);
}

beforeEach(() => {
  resetApproval();          // 令牌/桶/观察者/带外通道/队列/托管钩子一并归零
  reversalEscrow.reset();   // 托管模块态归零（端口/存储/表/账册/链簿记）
  clockBase = Date.now();
  clockOffset = 0;
  focusNow = 'Window - Drafts';
  execLog.length = 0;
  dir = newDir();
});

// ═══ ΠΑΝ-34①：生产 apply 通电（组合根级 —— 真实 apply + 假 ctx） ═══

/** 假 ctx（w0unload makeFakeCtx 同律 —— tools/on/get/emit/effect/reflect） */
function makeFakeCtx() {
  const disposers: Array<() => void> = [];
  const ctx = {
    tools: { register: (_t: unknown) => { /* 计数不消费 */ } },
    on: (_event: string, _handler: unknown) => () => { /* off */ },
    get: (_name: string) => undefined,
    emit: (_event: string, _payload: unknown) => { /* 采集不消费 */ },
    effect: (register: () => () => void) => { disposers.push(register()); },
    reflect: { get: () => null },
  };
  return {
    ctx: ctx as unknown as Context,
    runDisposer: () => { for (const d of disposers) d(); },
  };
}

const parseConfig = Config as unknown as (over?: Record<string, unknown>) => ConfigType;
function offlineApplyConfig(tmp: string, over: Record<string, unknown> = {}): ConfigType {
  return parseConfig({
    vlmApiKey: 'pan3437-offline-no-network',
    checkpointPath: path.join(tmp, 'checkpoint.json'),
    skillLibraryPath: path.join(tmp, 'skills.json'),
    recoveryEfficacyPath: path.join(tmp, 'efficacy.json'),
    ...over,
  });
}

test('ΠΑΝ-34①: apply(lanes on) ⇒ escrow 四命脉通电；lanes off ⇒ 零行为；卸载 ⇒ escrow.reset 归零', async () => {
  // lanes 开：armReversalEscrow 生产接线 —— dispatchGate 钩子注册 + WAL 存储在场
  const tmpA = newDir();
  const ha = makeFakeCtx();
  await apply(ha.ctx, offlineApplyConfig(tmpA, { enableReversibilityLanes: true }));
  assert.equal(escrowGateArmed(), true, 'dispatchGate 前置闸门已注册（修复前：arm 零生产调用 ⇒ 恒 false）');
  const st = reversalEscrow.stats();
  assert.equal(st.armed, true, 'approval 托管钩子注册（settlement 结算命脉的消费者）');
  assert.equal(st.storageArmed, true, 'WAL 持久化武装（checkpoint 同目录 escrow-wal.jsonl）');
  ha.runDisposer();
  assert.ok(lastUnloadActions().includes('escrow.reset'), '卸载链登记 escrow.reset（w0unload 清单协同）');
  assert.equal(reversalEscrow.stats().armed, false, '模块态归零（sweep 定时器停 + 端口/账册/链簿记复位）');
  assert.equal(escrowGateArmed(), false, 'approval 侧钩子随 approval.reset 卸载（两侧隔离缝）');

  // lanes 关（缺省）：零行为 —— 与接线前逐字节等价（保守兼容律）
  const tmpB = newDir();
  const hb = makeFakeCtx();
  await apply(hb.ctx, offlineApplyConfig(tmpB));
  assert.equal(escrowGateArmed(), false, '开关关 ⇒ 不武装（annotate-only 旧路）');
  assert.equal(reversalEscrow.stats().armed, false);
  hb.runDisposer();
});

// ═══ ΠΑΝ-34②：mintPlan 在途容量封顶 ═══

test('ΠΑΝ-34②: 在途 64 枚全在 TTL 内 ⇒ capacity-exceeded；过期收割腾位 ⇒ 补偿保留 + 降级标注', async () => {
  armEscrow({ withFocus: false });
  // 铸满 64 枚（各异令牌 —— 不触发同令牌顶替）
  for (let i = 0; i < 64; i++) {
    const m = await reversalEscrow.mintPlan({ semantics: 'file-write', approvalToken: `APR-CAP-${i}` });
    assert.equal(m.ok, true, `第 ${i + 1} 枚铸造应成功`);
  }
  assert.equal(reversalEscrow.stats().inFlight, 64);
  assert.equal(reversalEscrow.stats().inFlightCap, 64);
  // 第 65 枚：全部在 TTL 内 ⇒ fail-closed 拒绝（无界累积上界）
  const over = await reversalEscrow.mintPlan({ semantics: 'file-write', approvalToken: 'APR-CAP-OVER' });
  assert.equal(over.ok, false);
  if (!over.ok) {
    assert.equal(over.reason, 'capacity-exceeded');
    assert.match(over.detail ?? '', /fail-closed/);
  }
  assert.equal(reversalEscrow.stats().inFlight, 64, '拒绝路径不挤占既有在途');
  // TTL 流逝 ⇒ 收割腾位：第 65 枚铸造成功 + 诚实降级标注 + 被收割预案照常补偿
  advance(31_000);
  const reaped = await reversalEscrow.mintPlan({ semantics: 'file-write', approvalToken: 'APR-CAP-REAP' });
  assert.equal(reaped.ok, true, JSON.stringify(reaped));
  if (reaped.ok) {
    assert.ok((reaped.plan.degraded ?? []).includes('inflight-capacity-pressure'), '容量压力诚实降级标注在册');
  }
  await reversalEscrow.idle(); // 排空 fire-and-forget 补偿
  const ledger = reversalEscrow.dumpLedger();
  const comp = ledger.find(x => x.trigger === 'ttl-expired');
  assert.ok(comp, '被收割预案的补偿账在册（补偿义务不因容量压力丢失）');
  assert.equal(comp!.outcome, 'compensated-verified'); // 哈希端口在场 ⇒ 验证通过
  assert.equal(reversalEscrow.stats().inFlight, 64, '收割一枚 + 新铸一枚 = 仍 64（有界）');
});

// ═══ ΠΑΝ-34③：dispatchGate 命脉的工具侧接线（源级金丝雀） ═══

test('ΠΑΝ-34③: 源级金丝雀 —— clickMouse beginAttempt 携 escrow planId + 消费点坐标级 hint', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/tools/clickMouse.ts', import.meta.url)), 'utf8');
  assert.ok(src.includes('escrow: { planId: laneGate.escrowPlanId'),
    'beginAttempt 携带 laneGate 铸得的预案 id（dispatchGate 执法链的工具侧闭合）');
  assert.ok(src.includes("tool: 'click_mouse', x, y,"),
    'beginAttempt/consume 携坐标级 target（绑定令牌的兑换面比对）');
  const consumeCalls = src.match(/consumeApprovalWithHint\(approval_token, \{ tool: 'click_mouse',[^}]*\}\)/g) ?? [];
  assert.ok(consumeCalls.length >= 2, '两个验收消费点均在册');
  assert.ok(consumeCalls.every(c => c.includes('x, y')), '全部消费点携带坐标级 hint（ΠΑΝ-36）');
  const idxSrc = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
  assert.ok(idxSrc.includes('if (config.enableReversibilityLanes)') && idxSrc.includes('armReversalEscrow({'),
    '组合根在 lanes 开启路径调用 armReversalEscrow（ΠΑΝ-34 生产接线）');
});

// ═══ ΠΑΝ-35④：WAL 行哈希链篡改检测 ═══

test('ΠΑΝ-35④: 篡改行弃置不应用、后继好行不连坐、观测面在册', async () => {
  const wal = path.join(dir, 'chain-wal.json');
  armEscrow({ walFile: wal });
  // 两枚预案各自完整结算（mint-A → settle-A → mint-B → settle-B）
  const ta = grantedToken('写入 a.txt');
  const ma = await reversalEscrow.mintPlan({ semantics: 'file-write', approvalToken: ta.token });
  assert.equal(ma.ok, true);
  await reversalEscrow.settleVerified(ta.token);
  await reversalEscrow.idle();
  const tb = grantedToken('写入 b.txt');
  const mb = await reversalEscrow.mintPlan({ semantics: 'file-write', approvalToken: tb.token });
  assert.equal(mb.ok, true);
  await reversalEscrow.settleVerified(tb.token);
  await reversalEscrow.idle();

  // 本地篡改：改 settle-A 行的载荷内容（不动 prev/hash —— 无链年代的经典注入形态）
  const lines = readFileSync(wal, 'utf8').split('\n').filter(l => l.trim() !== '');
  const settleAIdx = lines.findIndex(l => {
    const p = JSON.parse(l) as { event?: string; payload?: { record?: { planId?: string } } };
    return p.event === 'settle' && p.payload?.record?.planId === (ma.ok ? ma.plan.planId : '');
  });
  assert.ok(settleAIdx > 0, '定位 settle-A 行');
  const tampered = JSON.parse(lines[settleAIdx]) as { payload: { record: { description: string } } };
  tampered.payload.record.description = 'INJECTED-BY-ATTACKER';
  lines[settleAIdx] = JSON.stringify(tampered);
  writeFileSync(wal, lines.join('\n') + '\n', 'utf8');

  // 崩溃重启（重新装载同档）：链校验逐行执法
  armEscrow({ walFile: wal });
  assert.equal(reversalEscrow.stats().walTamperedLines, 1, '篡改行检测在册（C1-2 H2：此前零完整性保护）');
  const ledger = reversalEscrow.dumpLedger();
  assert.equal(ledger.find(x => x.outcome === 'verified' && x.planId === mb.plan.planId)?.outcome, 'verified',
    '后继好行不连坐（settle-B 照常重放 —— 链尖推进到被弃置行的存储指纹）');
  const recA = ledger.find(x => x.planId === ma.plan.planId);
  assert.equal(recA?.outcome, 'recovered-human-attention',
    '被篡改的 settle 行弃置 ⇒ 预案 A 滞留在途 ⇒ 醒目转人工（fail-closed：不冒充已结算）');
  assert.equal(reversalEscrow.stats().walSkippedLines, 0, '链校验失败 ≠ 坏行跳过（两类观测分账）');
});

// ═══ ΠΑΝ-35⑤：补偿前焦点校验 ═══

test('ΠΑΝ-35⑤: 焦点不匹配/采集失败 ⇒ 拒绝补偿转人工；匹配 ⇒ 照常补偿；无锚点 ⇒ 跳过', async () => {
  // 场景一：铸造后用户切窗 —— 补偿被拒（C1-2 H3：Ctrl+Z 打进无关应用 = 第二次事故）
  armEscrow();
  const { token: t1 } = grantedToken('删除 report.docx');
  const m1 = await reversalEscrow.mintPlan({ semantics: 'file-write', approvalToken: t1 });
  assert.equal(m1.ok, true);
  focusNow = 'Window - Browser'; // 用户已切窗（30s TTL 内的常态）
  await reversalEscrow.settleFailed(t1, 'no-effect');
  await reversalEscrow.idle();
  assert.equal(execLog.length, 0, '补偿动作零执行（拦截而非注记）');
  const rec1 = reversalEscrow.dumpLedger().find(x => x.planId === (m1.ok ? m1.plan.planId : ''));
  assert.equal(rec1?.outcome, 'compensation-failed', '焦点不匹配 ⇒ 补偿拒绝 + 转人工（fail-closed）');
  assert.match(rec1?.escalation?.failureDetail ?? '', /focus moved/);
  assert.ok((reversalEscrow.pendingHumanAttention().length ?? 0) >= 1, '升级报告持续可见（绝不静默）');

  // 场景二：焦点采集失败（端口故障）⇒ 无法确认寻址 ⇒ 同律拒绝
  grantBucket.reset(); // Y-10 桶回满（本测试四枚令牌 —— 限流是补充不是替代）
  const { token: t2 } = grantedToken('删除 draft.txt');
  const m2 = await reversalEscrow.mintPlan({ semantics: 'file-write', approvalToken: t2 });
  assert.equal(m2.ok, true);
  focusNow = null; // 端口返回垃圾/故障
  await reversalEscrow.settleFailed(t2, 'no-effect');
  await reversalEscrow.idle();
  assert.equal(execLog.length, 0, '采集失败同样零执行');
  const rec2 = reversalEscrow.dumpLedger().find(x => x.planId === (m2.ok ? m2.plan.planId : ''));
  assert.equal(rec2?.outcome, 'compensation-failed');
  assert.match(rec2?.escalation?.failureDetail ?? '', /could not be verified/);

  // 场景三：焦点匹配（标题动态后缀容忍）⇒ 补偿照常执行
  grantBucket.reset();
  const { token: t3 } = grantedToken('删除 memo.txt');
  const m3 = await reversalEscrow.mintPlan({ semantics: 'file-write', approvalToken: t3 });
  assert.equal(m3.ok, true);
  focusNow = 'Window - Drafts — 3 items (Recovered)'; // 包含关系容忍
  await reversalEscrow.settleFailed(t3, 'no-effect');
  await reversalEscrow.idle();
  assert.ok(execLog.length > 0, '锚点匹配 ⇒ 补偿路径执行（file-write 的 Ctrl+Z + 菜单步）');
  const rec3 = reversalEscrow.dumpLedger().find(x => x.planId === (m3.ok ? m3.plan.planId : ''));
  assert.equal(rec3?.outcome, 'compensated-verified', '补偿执行且屏幕哈希回预案态（哈希端口在场）');

  // 场景四：预案无焦点锚点（铸造时端口缺席）⇒ 校验跳过（可用性优先的降级方向）
  grantBucket.reset();
  armEscrow({ withFocus: false });
  const { token: t4 } = grantedToken('删除 cache.bin');
  const m4 = await reversalEscrow.mintPlan({ semantics: 'file-write', approvalToken: t4 });
  assert.equal(m4.ok, true);
  assert.equal(m4.ok ? m4.plan.focusWindow : 'present', undefined, '无端口 ⇒ 锚点诚实缺席');
  await reversalEscrow.settleFailed(t4, 'no-effect');
  await reversalEscrow.idle();
  const rec4 = reversalEscrow.dumpLedger().find(x => x.planId === (m4.ok ? m4.plan.planId : ''));
  assert.equal(rec4?.outcome, 'compensated-verified', '锚点缺席 ⇒ 补偿照常（诚实降级，非拦截）');
});

// ═══ ΠΑΝ-35⑥：verifyThreshold 夹取 ═══

test('ΠΑΝ-35⑥: 病态阈值收编 —— 1e-9 ⇒ 0.5 下限；5 ⇒ 1；0.95 原样', async () => {
  reversalEscrow.arm({
    now,
    executorPort,
    strategies: [
      {
        kind: 'compensate', semantics: 'cap-tiny',
        steps: [{ method: 'hotkey', label: 'undo', keys: ['ctrl', 'z'] }],
        verify: { mode: 'screen-hash', threshold: 1e-9 },
      },
      {
        kind: 'compensate', semantics: 'cap-huge',
        steps: [{ method: 'hotkey', label: 'undo', keys: ['ctrl', 'z'] }],
        verify: { mode: 'screen-hash', threshold: 5 },
      },
      {
        kind: 'compensate', semantics: 'cap-sane',
        steps: [{ method: 'hotkey', label: 'undo', keys: ['ctrl', 'z'] }],
        verify: { mode: 'screen-hash', threshold: 0.95 },
      },
    ],
  });
  const tiny = await reversalEscrow.mintPlan({ semantics: 'cap-tiny' });
  assert.equal(tiny.ok, true);
  if (tiny.ok) assert.equal(tiny.plan.verifyThreshold, 0.5, '病态小值收编到合理性下限（1e-9 = 验证恒真的攻击面）');
  const huge = await reversalEscrow.mintPlan({ semantics: 'cap-huge' });
  assert.equal(huge.ok, true);
  if (huge.ok) assert.equal(huge.plan.verifyThreshold, 1, '越界大值夹到 1');
  const sane = await reversalEscrow.mintPlan({ semantics: 'cap-sane' });
  assert.equal(sane.ok, true);
  if (sane.ok) assert.equal(sane.plan.verifyThreshold, 0.95, '合法值原样通过');
});

// ═══ ΠΑΝ-36⑦：adjudicate 工具 confirm_code 贯通 ═══

test('ΠΑΝ-36⑦: adjudicate 工具带码贯通（单码 string / per-id map / 无码 fail-closed / 无码泄漏）', async () => {
  armChannel();
  approvalQueue.arm({ stagingTimeoutMs: 0 }); // 内存队列 + 即刻成熟
  const cfg = { enableApprovalGate: true, enableDemonstrations: false } as unknown as ConfigType;
  const tool = createAdjudicateApprovalQueueTool(cfg);
  // 两枚来自不同审批的条目（各自的码 —— 批量晨报的真实形态）
  const e1 = stageOne('pan3437：发送日报给 Alice');
  const e2 = stageOne('pan3437：提交订单 #42');
  assert.notEqual(codeOf(e1.token), codeOf(e2.token), '两枚条目锚定各自的码');

  // 无码 ⇒ 全项 confirm-code-required（fail-closed + 正确出路指引）
  const noCode = JSON.parse(await exec(tool)({ grant: true })) as {
    per_item: Array<{ outcome: string }>; next_step: string;
  };
  assert.equal(noCode.per_item.length, 2);
  assert.ok(noCode.per_item.every(x => x.outcome === 'confirm-code-required'), '无码 ⇒ 工具边界结构性拒绝（模型自批链封死）');
  assert.match(noCode.next_step, /OUT-OF-BAND confirm code/, '码要求的指引在案');

  // per-id map 形态：逐条目各交各码
  const batch = JSON.parse(await exec(tool)({
    grant: true,
    confirm_code: { [e1.id]: codeOf(e1.token), [e2.id]: codeOf(e2.token) },
  })) as { per_item: Array<{ outcome: string }>; state_anchor: { granted: number } };
  assert.deepEqual(batch.per_item.map(x => x.outcome).sort(), ['granted', 'granted'], 'per-id map 双码批量贯通');
  assert.equal(batch.state_anchor.granted, 2);

  // 输出无码泄漏（安全核心 —— 码只经带外，模型上下文不可见）
  const raw = await exec(tool)({ grant: false, ids: [] }); // 再来一次调用观察输出面（deny 无条目）
  assert.ok(!raw.includes(codeOf(e1.token)) && !raw.includes(codeOf(e2.token)), '工具输出绝无码');

  // string 形态：单条目人体工学（新暂存一枚）
  const e3 = stageOne('pan3437：归档周报');
  const single = JSON.parse(await exec(tool)({ grant: true, ids: [e3.id], confirm_code: codeOf(e3.token) })) as {
    per_item: Array<{ outcome: string }>;
  };
  assert.equal(single.per_item[0].outcome, 'granted', 'string 单码形态贯通');
});

// ═══ ΠΑΝ-36⑧：坐标级 targetHint（clickMouse 消费点契约） ═══

test('ΠΑΝ-36⑧: 绑定令牌的坐标级兑换 —— 匹配放行、不匹配拒绝且不焚毁', async () => {
  armChannel();
  const target = { tool: 'click_mouse', x: 0.42, y: 0.61, target_description: '发送按钮' };
  const minted = approval.mintBoundToken('click 发送 to submit', { target });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const g = approval.grantDetailed(minted.pa.token, true, { confirmCode: codeOf(minted.pa.token) });
  assert.equal(g.ok, true, JSON.stringify(g));

  // beginAttempt：坐标级 target 比对（clickMouse 派发预留携带的同一形状）
  assert.equal(approval.beginAttempt(minted.pa.token, { target }), true, '匹配坐标 ⇒ 预留成功');
  assert.equal(approval.attemptFailed(minted.pa.token, 'no-effect').valid, true, '释放预留（重试语义）');
  assert.equal(
    approval.beginAttempt(minted.pa.token, { target: { ...target, x: 0.9 } }),
    false,
    '错坐标 ⇒ 预留拒绝（拒绝先于簿记变异 —— 不烧尝试）',
  );

  // consume（consumeApprovalWithHint —— clickMouse 验收消费的统一落点）：
  assert.equal(consumeApprovalWithHint(minted.pa.token, { ...target, x: 0.9 }), false, '错坐标 ⇒ 消费拒绝');
  assert.equal(approval.status(minted.pa.token).present, true, '不匹配不焚毁（合法持有者可再来）');
  assert.equal(consumeApprovalWithHint('APR-NOPE', target), false, '伪令牌防御式拒绝（绝不抛）');
  assert.equal(consumeApprovalWithHint(minted.pa.token, target), true, '正确坐标级 hint ⇒ 验收消费成功');
  assert.equal(approval.status(minted.pa.token).present, false, '消费后焚毁（一次性）');
});

// ═══ ΠΑΝ-36⑨ + ΠΑΝ-37⑩：续跑令牌继承绑定 + 原令牌焚毁 ═══

test('ΠΑΝ-36⑨/ΠΑΝ-37⑩: takeGranted ⇒ 续跑令牌继承原绑定 + 原交互令牌就地焚毁', async () => {
  armChannel();
  approvalQueue.arm({ stagingTimeoutMs: 0 });
  // 绑定令牌的原请求（macaroon caveat 携带坐标）
  const pa = approval.request('pan3437：删除归档文件', {
    target: { tool: 'click_mouse', x: 0.3, y: 0.7, target_description: '删除' },
  });
  const staged = approvalQueue.stageAction({ token: pa.token, description: 'pan3437：删除归档文件', stagingTimeoutMs: 0 });
  assert.equal(staged.ok, true);
  const grant = approvalQueue.adjudicate([staged.ok ? staged.entry.id : ''], true, undefined, codeOf(pa.token));
  assert.equal(grant.results[0].outcome, 'granted', JSON.stringify(grant.results));
  assert.equal(approval.status(pa.token).present, true, 'take 前原交互令牌仍在簿（窄窗敞开的起点）');

  const taken = approvalQueue.takeGranted();
  assert.ok(taken, 'takeGranted 兑现成功');
  // ΠΑΝ-37⑩：原令牌焚毁 —— 执行权已转移，交互通道不得再武装第二次兑现
  assert.equal(approval.status(pa.token).present, false, '原交互令牌随 take 就地焚毁（修复前：TTL 内再交码可武装第二通道）');
  assert.deepEqual(approval.grantDetailed(pa.token, true, { confirmCode: codeOf(pa.token) }),
    { ok: false, reason: 'invalid-token' }, '焚毁后携码也无法复活原令牌');
  // ΠΑΝ-36⑨：续跑令牌继承原请求的 target 绑定（能力限缩随执行权转移）
  assert.equal(approval.status(taken!.executionToken).targetBound, true, '续跑令牌携带目标绑定');
  const hint = { tool: 'click_mouse', x: 0.3, y: 0.7, target_description: '删除' };
  assert.equal(approval.validate(taken!.executionToken, hint), true, '原请求坐标 ⇒ 兑换通过');
  const drifted = approval.validateDetailed(taken!.executionToken, { ...hint, x: 0.8 });
  assert.equal(drifted.ok, false);
  if (!drifted.ok) assert.equal(drifted.reason, 'target-mismatch', '漂移坐标 ⇒ 结构化拒绝（续跑令牌不是不记名能力）');
});

// ═══ ΠΑΝ-37⑪：veto 撤销已批条目（交互传播面 + 工具裁决面） ═══

test('ΠΑΝ-37⑪: veto 撤销已批条目 —— 交互 deny 传播与 adjudicate(grant=false) 双面闭合', async () => {
  // 面 A：adjudicate 批准后用户交互式喊停（grantDetailed false ⇒ recordTokenDecision）
  {
    armChannel();
    approvalQueue.arm({ stagingTimeoutMs: 0 });
    const e = stageOne('pan3437：发送月报');
    approvalQueue.adjudicate([e.id], true, undefined, codeOf(e.token));
    assert.equal(approvalQueue.pendingSummary().grantedAwaitingResume, 1, '已批待续跑');
    const veto = approval.grantDetailed(e.token, false, { note: '用户喊停：收件人错了' });
    assert.equal(veto.ok, true, '否决恒可行');
    assert.equal(approvalQueue.pendingSummary().grantedAwaitingResume, 0,
      '交互 deny 撤销已批条目（修复前：只传播 undecided ⇒ 已批条目在用户否决后仍可被 take 兑现）');
    assert.equal(approvalQueue.takeGranted(), null, '撤销后无从兑现');
  }
  // 面 B：adjudicate 工具 veto（grant=false ⇒ revokeGrantedEntries 透传）
  {
    armChannel();
    approvalQueue.arm({ stagingTimeoutMs: 0 });
    const cfg = { enableApprovalGate: true, enableDemonstrations: false } as unknown as ConfigType;
    const tool = createAdjudicateApprovalQueueTool(cfg);
    const e = stageOne('pan3437：提交报销单');
    approvalQueue.adjudicate([e.id], true, undefined, codeOf(e.token));
    assert.equal(approvalQueue.pendingSummary().grantedAwaitingResume, 1);
    const out = JSON.parse(await exec(tool)({ grant: false, ids: [e.id] })) as {
      state_anchor: { revoked_granted?: number }; next_step: string;
    };
    assert.equal(out.state_anchor.revoked_granted, 1, 'veto 撤销计数透明化');
    assert.match(out.next_step, /REVOKED/);
    assert.equal(approvalQueue.pendingSummary().grantedAwaitingResume, 0, '已批条目改判 denied');
    assert.equal(approvalQueue.takeGranted(), null, '撤销后无从兑现（一次否决压倒一切先前批准）');
  }
});
