// test/pan114-119.fix.test.ts
// ΠΑΝ 修复潮 F3 波执法册（工单 ΠΑΝ-114~119 —— 各工位移交的残留对接点清账）：
//   ΠΑΝ-114（F2-1 移交项①）actionGate validate 侧 targetHint —— 与 consume 同
//     标准：绑定令牌携完整形状（replay 全量 args）在闸门可兑现；缺坐标仍
//     fail-closed；未绑定令牌零行为；validate 非消费（不焚毁）。
//   ΠΑΝ-115（F2-1 移交项②）OCR 焦点锚质量闸（diagnosis 纯函数 + index.ts
//     focusPort 接线）：残片/无词证/无测量/低中位 ⇒ 不作硬依据；好读数放行；
//     任意垃圾输入绝不抛。
//   ΠΑΝ-116（F2-1 移交项⑤）doctor 消费 WAL 篡改计数：escrow walTamperedLines>0
//     ⇒ critical 红action finding；journal chainIntact=false ⇒ 同律；双清 ⇒ 零
//     命中（CLI 语境无误报）；真实篡改档 → 规则红。
//   ΠΑΝ-117（F2-9 移交项④ / C2-1 F7）检疫地板×ε 乘性误伤：ε=0.1 源的 DP 噪声
//     偏差不再吃票（永试用期终结）、真离群照常计票、ε=1 旧律逐字节（回归锚）、
//     显式阈全权接管、校准注记在册。
//   ΠΑΝ-118（F2-3 移交项②）pipeline 消费 planner chain 臂：planReadyChain 注入
//     决策语境、毒链不入场、缺席零回归、宿主事件面广播。
//   ΠΑΝ-119（F2-6 移交 · C1-4 中-2）弹窗确认 bounds：落点在栖息地内放行、带外
//     /不可解析/陷阱属性 ⇒ Esc 回退（fail-closed）、非弹窗动作零行为 + 主循环
//     接线金丝雀 + 栖息地镜像与 popupDetector 源常量的锁死。
// 全程离线确定性：注入端口 / tmp 目录存储 / 零真屏零网络零真钟睡眠。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config.ts';
import { approval, resetApproval, setConfirmCodeChannel, type ConfirmCodeDelivery } from '../src/approval.ts';
import { grantBucket } from '../src/approval.security.ts';
import { assertActionAllowed } from '../src/tools/actionGate.ts';
import { consumeApprovalWithHint } from '../src/tools/clickMouse.ts';
import { ocrFocusAnchorQuality } from '../src/diagnosis.ts';
import { DOCTOR_RULES_CORE } from '../src/doctorRules.core.ts';
import { reversalEscrow, createEscrowFileStorage } from '../src/reversalEscrow.ts';
import { robustMergeDigests, dpNoiseFloorOf, OUTLIER_FLOOR, OUTLIER_NOISE_SCALES } from '../src/federation/aggregate.ts';
import { PipelineOrchestratorImpl } from '../src/orchestration/pipeline.ts';
import type { ActionChain, SandboxAction } from '../src/sandbox/types.ts';
import type {
  AttentionEnvelope, DecisionContext, DecisionOutput, ExecutionOrder, ExecutionResult,
  PerceptionRequest, ScenePatch,
} from '../src/orchestration/contracts.ts';
import { pan119PopupConfirmBoundsGate, POPUP_HABITAT_NORM } from '../src/autonomy/autoPilot.ts';
import type { PolicyAction } from '../src/autonomy/policyEngine.ts';

// ─── 测试基建（离线确定性） ───

const dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'pan114119-'));
  dirs.push(d);
  return d;
}
process.on('exit', () => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

const srcOf = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** 铸造一枚已授予的（可选目标绑定）令牌 —— 带外码经采集 sink（pan3437 同律） */
function grantedBoundToken(description: string, target?: Record<string, unknown>): string {
  const sink: ConfirmCodeDelivery[] = [];
  setConfirmCodeChannel(d => { sink.push({ ...d }); });
  const pa = approval.request(description, target ? { target: target as never } : undefined);
  const g = approval.grantDetailed(pa.token, true, { confirmCode: sink[0]?.confirmCode });
  assert.equal(g.ok, true, JSON.stringify(g));
  return pa.token;
}

beforeEach(() => {
  resetApproval();
  grantBucket.reset();
  reversalEscrow.reset();
});

// ═══ ΠΑΝ-114：actionGate validate 侧 targetHint（与 consume 同标准） ═══

test('ΠΑΝ-114a: 绑定令牌携完整形状（坐标级）在闸门可兑现 —— 与 consume 同一摘要管道', () => {
  const token = grantedBoundToken('click 删除 to remove report.docx', {
    tool: 'click_mouse', x: 0.5, y: 0.5, target_description: '删除按钮',
  });
  const cfg = { dangerPatterns: '删除', enableApprovalGate: true };
  // replay 形态的 args（全量参数在场）—— 危险命中 + 令牌 + 匹配 hint ⇒ 放行
  const d = assertActionAllowed('click_mouse', {
    target_description: '删除按钮', approval_token: token, x: 0.5, y: 0.5,
  }, cfg);
  assert.equal(d.allowed, true, JSON.stringify(d));
  assert.equal(d.requiresApproval, true, '危险域动作放行时仍申报审批域（下游验收链挂钩）');
  assert.equal(d.dangerous, true);
});

test('ΠΑΝ-114b: 同一令牌缺坐标（live clickMouse 闸门 args 形态）⇒ fail-closed 拒绝且不焚毁', () => {
  const token = grantedBoundToken('click 删除 to remove draft.docx', {
    tool: 'click_mouse', x: 0.25, y: 0.75, target_description: '删除图标',
  });
  const cfg = { dangerPatterns: '删除', enableApprovalGate: true };
  const d = assertActionAllowed('click_mouse', {
    target_description: '删除图标', approval_token: token, // 无 x/y —— 摘要缺坐标域
  }, cfg);
  assert.equal(d.allowed, false, '坐标绑定令牌缺坐标 hint ⇒ 摘要不匹配 ⇒ 闸门拒绝（安全方向保持）');
  assert.equal(d.reason, 'token-not-granted-or-expired');
  // validate 是只查不烧：令牌仍可携正确形状兑换（consume 同标准）
  const consumed = consumeApprovalWithHint(token, { tool: 'click_mouse', x: 0.25, y: 0.75, target_description: '删除图标' });
  assert.equal(consumed, true, '拒绝先于焚毁 —— 合法持有者携完整提示可再来（ΠΑΝ-5 律保持）');
});

test('ΠΑΝ-114c: hotkey 臂 hint 方言 —— context_description 映射 target_description 槽', () => {
  const token = grantedBoundToken('press enter on 确认删除 dialog', {
    tool: 'press_hotkey', target_description: '确认删除对话框的默认钮',
  });
  const cfg = { dangerPatterns: '删除', enableApprovalGate: true };
  const d = assertActionAllowed('press_hotkey', {
    keys: ['enter'], context_description: '确认删除对话框的默认钮', approval_token: token,
  }, cfg);
  assert.equal(d.allowed, true, JSON.stringify(d));
  // 同令牌换描述（危险词命中但与绑定摘要不匹配）⇒ 拒绝：令牌授权的是「这个目标」
  const d2 = assertActionAllowed('press_hotkey', {
    keys: ['enter'], context_description: '删除完全无关的另一个面板', approval_token: token,
  }, cfg);
  assert.equal(d2.allowed, false, '绑定令牌在闸门按摘要强制比对（macaroon caveat 闸门侧兑现）');
});

test('ΠΑΝ-114d: 未绑定令牌对 hint 免疫（零回归）+ 期待与 expected_text 通道同序', () => {
  const token = grantedBoundToken('click 删除 to remove memo.txt'); // 无 target ⇒ 无绑定
  const cfg = { dangerPatterns: '删除', enableApprovalGate: true };
  const d = assertActionAllowed('click_mouse', {
    target_description: '删除', approval_token: token, x: 0.9, y: 0.1, // hint 形状无关紧要
  }, cfg);
  assert.equal(d.allowed, true, '未绑定令牌：hint 在场与否不影响判定（ΠΑΝ-5 兼容律）');
  // expected_text 兜底描述通道（consume 面同序：target_description ?? expected_text）
  const token2 = grantedBoundToken('click danger', {
    tool: 'click_mouse', x: 0.5, y: 0.5, target_description: '提交订单',
  });
  const d2 = assertActionAllowed('click_mouse', {
    expected_text: '提交订单', approval_token: token2, x: 0.5, y: 0.5,
  }, cfg);
  assert.equal(d2.allowed, true, 'expected_text 兜底进 hint 与 consume 面同一优先序');
});

test('ΠΑΝ-114e: 源级金丝雀 —— actionGate 两处 validate 均携 hint（回改即红）', () => {
  const src = srcOf('../src/tools/actionGate.ts');
  assert.equal((src.match(/approval\.validate\(approval_token,/g) ?? []).length, 2,
    '两处 validate 调用（click 判定核 + hotkey 判定面）均以 targetHint 开参');
  assert.equal(src.includes('approval.validate(approval_token)'), false,
    '无裸 validate 残留（未携 hint 的调用即回改）');
});

// ═══ ΠΑΝ-115：OCR 焦点锚质量闸（低置信锚不作硬依据） ═══

test('ΠΑΝ-115a: 判决序逐档 —— 残片/无词证/无测量/低中位 ⇒ 拒；好读数 ⇒ 过', () => {
  assert.deepEqual(ocrFocusAnchorQuality({ text: '×', words: [{ text: '×', confidence: 99 }] }),
    { usable: false, note: 'anchor-too-short' }, '残片（<4 字符）对任何标题都无法寻址');
  assert.deepEqual(ocrFocusAnchorQuality({ text: 'Settings Window', words: [] }),
    { usable: false, note: 'no-word-evidence' }, '词证全被 floor 滤走（legacy 路径）= 整带垃圾的确定性信号');
  assert.deepEqual(ocrFocusAnchorQuality({
    text: '订单管理 Chrome',
    words: [
      { text: '订单管理', confidence: 90, confidenceAssumed: true },
      { text: 'Chrome', confidence: 90, confidenceAssumed: true },
    ],
  }), { usable: false, note: 'confidence-unmeasured' }, '假设值（旧服务方言）不构成质量证据 —— 无测量即无主张');
  assert.deepEqual(ocrFocusAnchorQuality({
    text: '订单管理 Chrome',
    words: [{ text: '订单', confidence: 40 }, { text: '管理', confidence: 42 }, { text: 'Chrome', confidence: 95 }],
  }), { usable: false, note: 'low-confidence-median:42' }, '测量中位数低于下限 ⇒ 低置信锚不作硬依据');
  const ok = ocrFocusAnchorQuality({
    text: '订单管理 - Google Chrome',
    words: [
      { text: '订单管理', confidence: 88 },
      { text: 'Google', confidence: 93, confidenceAssumed: false },
      { text: 'Chrome', confidence: 91 },
    ],
  });
  assert.equal(ok.usable, true, '高置信整带读数可作硬依据');
  assert.match(ok.note, /^measured:3 median:91$/);
});

test('ΠΑΝ-115b: 防御面 —— 任意垃圾输入绝不抛、一律不作硬依据', () => {
  for (const junk of [null, undefined, {}, { text: null, words: null }, { text: 42, words: 'x' },
    { text: '好长的一个标题栏读数', words: [null, 7, { confidence: NaN }] }]) {
    const q = ocrFocusAnchorQuality(junk as never);
    assert.equal(q.usable, false, `垃圾输入 ${JSON.stringify(junk)} 不得判 usable`);
    assert.equal(typeof q.note, 'string');
  }
});

test('ΠΑΝ-115c: 生产接线金丝雀 —— index.ts focusPort 过质量闸（回改即红）', () => {
  const src = srcOf('../src/index.ts');
  assert.ok(src.includes('ocrFocusAnchorQuality({ text: title, words: strip.words })'),
    'focusPort 的 OCR 读数必须过 ocrFocusAnchorQuality 质量闸（ΠΑΝ-115 消费接线）');
  assert.ok(src.includes('ΠΑΝ-115'),
    '接线处注释携带工单号（威胁模型叙述在案）');
});

// ═══ ΠΑΝ-116：doctor 消费 WAL 篡改计数（红action报告） ═══

const doctorCtx = (chainIntact: boolean) => ({
  sources: [],
  chain: { entries: [], chainIntact },
  snapshot: null,
  config: {} as Config,
  warn: (_m: string) => { /* 测试面：warnings 面静默 */ },
});

const walTamperedRule = () => DOCTOR_RULES_CORE.find(r => r.id === 'chain.wal-tampered')!;

test('ΠΑΝ-116a: escrow walTamperedLines>0 ⇒ critical 红action；journal 链断 ⇒ 同律；双清 ⇒ 零命中', async () => {
  const rule = walTamperedRule();
  assert.equal(rule.severity, 'critical', '档完整性被触碰是安全事件 —— 红action 档');
  // 双清（CLI 语境：模块态全新）⇒ 零命中（无误报面）
  assert.deepEqual(await rule.scan(doctorCtx(true)), []);
  // journal 链断 ⇒ 红action
  const journalFindings = await rule.scan(doctorCtx(false));
  assert.equal(journalFindings.length, 1);
  assert.match(journalFindings[0].location.snippet, /chainIntact=false/);
  assert.match(journalFindings[0].recommendation, /RED ACTION/);
});

test('ΠΑΝ-116b: 真实篡改档（铸链→篡改行→重载）⇒ 规则在医生报告里红', async () => {
  const dir = newDir();
  const wal = path.join(dir, 'escrow-wal.jsonl');
  const clock = { now: 0 };
  const arm = (): void => {
    reversalEscrow.arm({
      now: () => clock.now,
      storage: createEscrowFileStorage(wal),
      hashPort: { capture: async () => 'a'.repeat(64) },
      clipboardPort: null,
      focusPort: null,
      interruptPort: null,
      executorPort: null,
    });
  };
  arm();
  const m = await reversalEscrow.mintPlan({ semantics: 'file-write', approvalToken: 'APR-PAN116' });
  assert.equal(m.ok, true, JSON.stringify(m));
  await reversalEscrow.settleVerified('APR-PAN116');
  await reversalEscrow.idle();
  assert.equal(reversalEscrow.stats().walTamperedLines, 0, '篡改前清白');
  // 本地篡改：改 settle 行载荷（不动 prev/hash —— 无链年代经典注入形态，pan3437 35④ 同律）
  const lines = readFileSync(wal, 'utf8').split('\n').filter(l => l.trim() !== '');
  const settleIdx = lines.findIndex(l => {
    try { return (JSON.parse(l) as { event?: string }).event === 'settle'; } catch { return false; }
  });
  assert.ok(settleIdx >= 0, '定位 settle 行');
  const tampered = JSON.parse(lines[settleIdx]) as { payload: { record: { description?: string } } };
  tampered.payload.record.description = 'INJECTED-BY-ATTACKER';
  lines[settleIdx] = JSON.stringify(tampered);
  writeFileSync(wal, lines.join('\n') + '\n', 'utf8');
  arm(); // 崩溃重启：重放面链校验
  assert.equal(reversalEscrow.stats().walTamperedLines, 1, '篡改观测在册');
  // 医生消费：规则红（恢复面已弃置篡改行 —— 规则义务是让检视在报告里红着）
  const findings = await walTamperedRule().scan(doctorCtx(true));
  assert.equal(findings.length, 1);
  assert.match(findings[0].location.snippet, /walTamperedLines=1/);
  assert.match(findings[0].evidence, /rejected 1 tampered line/);
  assert.match(findings[0].recommendation, /RED ACTION/);
  assert.equal(findings[0].severity, 'critical');
});

// ═══ ΠΑΝ-117：检疫地板×ε 乘性误伤校准（诚实源不再永试用期） ═══

/** 铸一份合法摘要（单 key、16 格同值 base —— IQR=0 ⇒ 地板臂独裁判决） */
function digestOf(epsilon: number | undefined, cellValue: (b: number, col: number) => number): {
  v: 1; mintedAt: number; epsilon: number | undefined;
  keys: Array<{ key: string; n: number; bins: number[][] }>;
} {
  return {
    v: 1,
    mintedAt: 1,
    epsilon,
    keys: [{
      key: 'k',
      n: 10,
      bins: Array.from({ length: 8 }, (_unused, b) => [cellValue(b, 0), cellValue(b, 1)]),
    }],
  };
}

test('ΠΑΝ-117a: ε=0.1 源的 DP 噪声偏差（|Δ|=6，中位噪声≈6.9）不再吃票 —— 永试用期终结', () => {
  // 4 诚实 ε=1 源坐共识 100；1 诚实 ε=0.1 源带 ±6 的 DP 噪声偏差（旧地板 3 逐格计票）
  const sources = [
    digestOf(1, () => 100),
    digestOf(1, () => 100),
    digestOf(1, () => 100),
    digestOf(1, () => 100),
    digestOf(0.1, (b, col) => 100 + (b % 2 === 0 ? 6 : -6) + col),
  ];
  const r = robustMergeDigests(sources, { sourceIds: ['a', 'b', 'c', 'd', 'noisy'] });
  assert.equal(r.quarantined.noisy ?? 0, 0,
    `ε=0.1 源的噪声级偏差（≤3/ε=30）不吃票（旧律 16 格全计票 = 永试用期）—— notes: ${r.notes.join('|')}`);
  assert.ok(r.notes.some(n => n.includes('ΠΑΝ-117') && n.includes('floor=30')),
    '校准注记在册（透明面：哪些源在 ε 噪声带下被放宽）');
});

test('ΠΑΝ-117b: 同一 ε=0.1 源的真离群（+500）照常计票 —— 放宽的是噪声带，不是牙齿', () => {
  const sources = [
    digestOf(1, () => 100),
    digestOf(1, () => 100),
    digestOf(1, () => 100),
    digestOf(1, () => 100),
    digestOf(0.1, () => 600), // 自称同 key 的毒值 —— 远超 3/ε=30 的地板
  ];
  const r = robustMergeDigests(sources, { sourceIds: ['a', 'b', 'c', 'd', 'poison'] });
  assert.equal(r.quarantined.poison ?? 0, 16, '真离群逐格计票（检疫牙齿不因校准钝化）');
});

test('ΠΑΝ-117c: ε=1/缺席/非法 ⇒ 地板 3 旧律逐字节（回归锚）+ 显式阈全权接管', () => {
  // ε=1 源 ±2 噪声偏差：新旧律都不计票（回归锚）
  const honestEps1 = [
    digestOf(1, () => 100), digestOf(1, () => 100), digestOf(1, () => 100),
    digestOf(1, (b, col) => 100 + (b % 2 === 0 ? 2 : -2) + col),
  ];
  const r1 = robustMergeDigests(honestEps1, { sourceIds: ['a', 'b', 'c', 'w'] });
  assert.equal(r1.quarantined.w ?? 0, 0, 'ε=1 的 ±2 偏差不吃票（旧律保持）');
  assert.ok(!r1.notes.some(n => n.includes('ΠΑΝ-117')), 'ε=1 无校准注记（行为逐字节旧律）');
  // 缺席/非法 ε ⇒ ε=1 镜像
  const absent = [
    digestOf(undefined, () => 100), digestOf(undefined, () => 100), digestOf(undefined, () => 100),
    digestOf(0, () => 100), digestOf(Number.NaN, () => 100), // 非法 ε（≤0/NaN）
    digestOf(undefined, () => 104), // 4 偏差 > 地板 3 ⇒ 计票（旧律同判）
  ];
  const r2 = robustMergeDigests(absent, { sourceIds: ['a', 'b', 'c', 'z', 'n', 'w'] });
  assert.equal(r2.quarantined.w ?? 0, 16, '缺席/非法 ε ⇒ 地板 3：偏差 4 照旧计票（零回归）');
  // 显式阈注入 ⇒ 全权接管（源 ε 不参与 —— 测试缝方言不变）：far 偏差 30 > 25 ⇒ 计票
  const r3 = robustMergeDigests(honestEps1.concat([digestOf(0.1, () => 130)]),
    { sourceIds: ['a', 'b', 'c', 'w', 'far'], outlierThreshold: 25 });
  assert.equal(r3.quarantined.far ?? 0, 16, '显式阈 25 下偏差 30 计票（ε=0.1 的校准不越权覆盖显式阈）');
  assert.ok(!r3.notes.some(n => n.includes('ΠΑΝ-117')), '显式阈全权接管：无 ε 校准注记');
});

test('ΠΑΝ-117d: dpNoiseFloorOf 纯函数律（地板= max(3, 3/ε)；ε 越小越宽；ε≥1 恒 3）', () => {
  assert.equal(dpNoiseFloorOf(1), OUTLIER_FLOOR);
  assert.equal(dpNoiseFloorOf(10), OUTLIER_FLOOR, 'ε>1 ⇒ 噪声更小 ⇒ 常数地板兜底');
  assert.equal(dpNoiseFloorOf(undefined), OUTLIER_FLOOR, '缺席 ⇒ ε=1 镜像');
  assert.equal(dpNoiseFloorOf(0), OUTLIER_FLOOR, '非法 ε ⇒ 保守镜像');
  assert.equal(dpNoiseFloorOf(Number.POSITIVE_INFINITY), OUTLIER_FLOOR);
  assert.equal(dpNoiseFloorOf(0.1), OUTLIER_NOISE_SCALES / 0.1, 'ε=0.1 ⇒ 地板 30（中位噪声 6.9 << 30）');
  assert.equal(dpNoiseFloorOf(0.5), 6, '线性放宽：3/0.5=6');
});

// ═══ ΠΑΝ-118：pipeline 消费 planner chain 臂（决策语境接线） ═══

/** 最小工位脚手架：一区一补丁 / 决策捕获语境后产单步动作 / 执行恒真验收 */
function stubStations(): {
  vision: { perceive(env: AttentionEnvelope<'vision', PerceptionRequest>): AsyncIterable<ScenePatch> };
  decision: { decide(env: AttentionEnvelope<'decision', DecisionContext>): Promise<DecisionOutput> };
  execution: { execute(env: AttentionEnvelope<'execution', ExecutionOrder>): Promise<ExecutionResult> };
  captured: Array<Record<string, unknown>>;
} {
  const captured: Array<Record<string, unknown>> = [];
  const patch: ScenePatch = {
    region: { id: 'c0', x: 0, y: 0, width: 1, height: 1 },
    elements: [], funnelDepth: 'L2', capturedAt: Date.now(),
  };
  return {
    captured,
    vision: {
      async *perceive(env) {
        void env;
        yield patch;
      },
    },
    decision: {
      async decide(env) {
        captured.push(env.payload as unknown as Record<string, unknown>);
        return {
          kind: 'click_mouse', args: { x: 0.5, y: 0.5 },
          rationale: 'stub 单步动作（执法脚手架）',
        };
      },
    },
    execution: {
      async execute(env) {
        return {
          seq: env.payload.seq, effectDetected: true, latencyMs: 1, rehearsed: false,
        };
      },
    },
  };
}

function newOrchestrator(
  stations: ReturnType<typeof stubStations>,
  events?: Array<[string, Record<string, unknown>]>,
): PipelineOrchestratorImpl {
  const o = new PipelineOrchestratorImpl();
  const cfg = o.configure({
    maxDecisionRetries: 1,
    regionGrid: { cols: 1, rows: 1 },
    stationTokenBudgets: { vision: 10, decision: 10, execution: 0 },
    rehearseBeforeExecute: false,
    attemptTimeoutMs: 1000,
    perceptionDeadlineMs: 1000,
    consumePlanReady: false,
  });
  assert.equal(cfg.ok, true, JSON.stringify(cfg));
  o.wire({
    vision: stations.vision,
    decision: stations.decision,
    execution: stations.execution,
    ...(events
      ? { emit: (ev: string, p: Record<string, unknown>) => { events.push([ev, p]); } }
      : {}),
  });
  return o;
}

const chainFixture: ActionChain = {
  id: 'chain-pan118',
  actions: [
    { kind: 'click_mouse', args: { x: 0.5, y: 0.4 } },
    { kind: 'type_text', args: { text: 'hello' } },
  ] as SandboxAction[],
  origin: 'cognition',
};

test('ΠΑΝ-118a: planReadyChain 注入决策语境（opts 显式载荷）+ 宿主事件面广播', async () => {
  const stations = stubStations();
  const events: Array<[string, Record<string, unknown>]> = [];
  const o = newOrchestrator(stations, events);
  const report = await o.run(
    { id: 'intent-118a', goal: '执行两步链', source: 'cognition' },
    { planReadyChain: chainFixture },
  );
  assert.equal(report.verdict, 'completed', report.terminalReason);
  assert.ok(stations.captured.length >= 1, '决策工位被调用');
  assert.deepEqual(stations.captured[0].planReadyChain, chainFixture,
    'planner 铸就的链对决策工位可见（决策语境接线 —— 不再只有 prose goal）');
  assert.ok(events.some(([ev, p]) => ev === 'pipeline/plan-ready-chain' && p.chainId === 'chain-pan118'),
    '宿主事件面广播消费留痕');
});

test('ΠΑΝ-118b: intent 随行 chain 字段（事件载荷直挂方言）同过闸；毒链不入场；缺席零回归', async () => {
  // intent 直挂方言（事件载荷原样挂 chain 字段的调用形态）
  const s1 = stubStations();
  const o1 = newOrchestrator(s1);
  const intentWithChain = {
    id: 'i118b1', goal: 'g', source: 'cognition' as const, chain: chainFixture,
  };
  await o1.run(intentWithChain as never);
  assert.deepEqual(s1.captured[0].planReadyChain, chainFixture, 'intent 运行时随行 chain 同样进入决策语境');
  // 毒链（无 id / 空 actions / 坏 kind）⇒ 诚实缺席
  for (const poison of [
    { actions: [{ kind: 'click_mouse', args: {} }] },
    { id: 'x', actions: [] },
    { id: 'x', actions: [{ args: {} }] },
    null,
  ]) {
    const s = stubStations();
    const o = newOrchestrator(s);
    await o.run({ id: 'i118b2', goal: 'g', source: 'user' }, { planReadyChain: poison as never });
    assert.equal('planReadyChain' in s.captured[0], false,
      `毒链 ${JSON.stringify(poison)?.slice(0, 40)} 不入场（半截接线 = 假接线）`);
  }
  // 缺席 ⇒ 决策语境与接线前逐字节同形（键不存在）
  const s3 = stubStations();
  const o3 = newOrchestrator(s3);
  await o3.run({ id: 'i118b3', goal: 'g', source: 'user' });
  assert.equal('planReadyChain' in s3.captured[0], false, '缺席零回归（键形稳定）');
  assert.deepEqual(Object.keys(s3.captured[0]).sort(), ['intent', 'scene'], '基形分毫不动');
});

// ═══ ΠΑΝ-119：弹窗确认点击的落点 bounds 校验 ═══

const confirmClick = (x: number, y: number): PolicyAction => ({
  kind: 'click',
  target: { bbox: { x0: x - 0.02, y0: y - 0.02, x1: x + 0.02, y1: y + 0.02 }, center: { x, y }, label: '确定' },
  payload: { popup: '确认删除订单？' },
  rationale: '检测到弹窗，点击确认类元素',
  expectedEffect: '弹窗关闭',
  utility: 0.9,
  riskTier: 'benign',
});

test('ΠΑΝ-119a: 落点在弹窗栖息地内 ⇒ 原动作透传（弹窗内确认钮照常派发）', () => {
  const a = confirmClick(0.5, 0.5); // 中央带内
  const r = pan119PopupConfirmBoundsGate(a);
  assert.equal(r.note, null, '带内零行为（零回归律）');
  assert.equal(r.action, a, '原动作引用透传（不复制不改装）');
});

test('ΠΑΝ-119b: 落点在栖息地外 ⇒ 替换 Esc 回退 + 注记（防误点弹窗外）', () => {
  for (const [x, y] of [[0.05, 0.5], [0.5, 0.95], [0.9, 0.1]]) {
    const r = pan119PopupConfirmBoundsGate(confirmClick(x, y));
    assert.notEqual(r.note, null, `(${x},${y}) 带外必须拦截`);
    assert.equal(r.action.kind, 'hotkey', '回退动作 = Esc 热键（policyEngine ① 级回退臂同方言）');
    assert.deepEqual((r.action.payload as { keys: string[] }).keys, ['esc']);
    assert.equal(r.action.riskTier, 'benign');
    assert.match(r.action.rationale, /ΠΑΝ-119/);
    assert.match(r.note ?? '', /弹窗矩形外|落点不可解析/);
  }
});

test('ΠΑΝ-119c: 落点不可解析（center/bbox 双缺）与陷阱属性 ⇒ fail-closed 回退', () => {
  const noPoint = { ...confirmClick(0.5, 0.5), target: { label: '确定' } } as unknown as PolicyAction;
  const r1 = pan119PopupConfirmBoundsGate(noPoint);
  assert.equal(r1.action.kind, 'hotkey', '读不出落点 = 不点（fail-closed）');
  const trap = confirmClick(0.5, 0.5);
  Object.defineProperty(trap, 'target', {
    get(): { center: { x: number; y: number }; bbox: object; label: string } { throw new Error('trap'); },
  });
  const r2 = pan119PopupConfirmBoundsGate(trap);
  assert.equal(r2.action.kind, 'hotkey', '校验面故障（陷阱属性）⇒ 不让读不出的目标成为派发依据');
});

test('ΠΑΝ-119d: 非弹窗方言零行为（普通点击/热键/无 popup 载荷）', () => {
  const plain = { ...confirmClick(0.05, 0.95), payload: { criterion: 'c' } } as PolicyAction;
  assert.equal(pan119PopupConfirmBoundsGate(plain).note, null, '普通 ② 级点击不受辖（即便落点在带外）');
  const hotkey: PolicyAction = {
    kind: 'hotkey', payload: { keys: ['esc'] }, rationale: 'r', expectedEffect: 'e', utility: 0.9, riskTier: 'benign',
  };
  assert.equal(pan119PopupConfirmBoundsGate(hotkey).note, null, '非点击动作不受辖');
  assert.equal(pan119PopupConfirmBoundsGate({} as PolicyAction).note, null, '防御：空动作透传（后续相位自会收敛）');
});

test('ΠΑΝ-119e: 主循环接线金丝雀 + 栖息地镜像与 popupDetector 源常量锁死（漂移即红）', () => {
  const src = srcOf('../src/autonomy/autoPilot.ts');
  assert.ok(src.includes('const pan119 = pan119PopupConfirmBoundsGate(action);'),
    'bounds 闸在主循环 ③″ 探索拦截之后接线（探索替换后的最终动作受辖）');
  assert.ok(src.includes('pan119.note !== null'), '拦截 ⇒ action 替换 + decision.note 入账');
  // 镜像锁：popupDetector 的弹窗栖息地假设仍为中央 40% 带（fraction=0.4 ⇒ inset 0.3）
  const detectorSrc = srcOf('../src/popupDetector.ts');
  assert.ok(detectorSrc.includes('function centerRegionNorm(fraction = 0.4)'),
    'POPUP_HABITAT_NORM 的单源（popupDetector centerRegionNorm(0.4)）仍在 —— 改源常量须同步镜像');
  assert.equal(POPUP_HABITAT_NORM.x0, 0.3, '镜像 inset = 0.3（与源同律）');
  assert.equal(POPUP_HABITAT_NORM.x1, 0.7, '镜像右界 = 0.7（与源同律）');
  assert.equal(POPUP_HABITAT_NORM.y0, 0.3, '镜像 inset = 0.3（与源同律）');
  assert.equal(POPUP_HABITAT_NORM.y1, 0.7, '镜像下界 = 0.7（与源同律）');
});
