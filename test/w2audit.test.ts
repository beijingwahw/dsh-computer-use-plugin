// test/w2audit.test.ts
// W2-2（安全双包）执法测试：S4 全动作先行审计（fail-closed WAL）+ S3 派发前
// 接地新鲜度探针 + W1-2 批注消费接线（click/drag/clickElement 三工具）。
//
// S4 铁律：
//   · 审计覆盖面 = 全部变更类工具（click_mouse/click_element/drag_mouse/
//     scroll_page/type_text/press_hotkey），观察类工具不入列；
//   · 审计行（脱敏后）在 next()（= 工具派发位）之前已入 journal 哈希链；
//   · 追加失败 ⇒ 短路拒派（结构化 deny JSON，绝不抛）—— fail-closed；
//   · WAL 通道（journalPath+'.wal'）同步先行落盘；磁盘故障 ⇒ fail-closed；
//   · enableJournal=false 是配置态（skipped 诚实注记），不是故障 —— 放行。
// S3 铁律：
//   · 危险 click 派发前（beginAttempt 之前）探针比对接地指纹与当前快图；
//   · 漂移 ⇒ 阻断 + 「需重新截图定位」结构化结果（令牌未烧、零物理派发）；
//   · W6R 收口：端口缺席/失败 ⇒ degraded ⇒ 危险令牌动作**拒绝派发**
//     （fail-closed；出路 = 重试/开探针/逃生门 allowUnverifiedDangerous=true，
//     逃生门下才恢复 fail-open + 观测注记的旧方言）；
//   · 非危险路径探针不入场（叠加防御只挂在危险面上）。
// W1-2 铁律：
//   · 三工具在闸门判定**之前**消费 applyAmendment patch —— 批注修正后的
//     描述参与危险判定（批注不得成为绕闸通道）；
//   · 修正生效 ⇒ 坐标/描述按批注派发 + state_anchor.amendment 透明化；
//   · 无令牌/无批注/越界修正 ⇒ 零行为（旧路径不变）。
// 全部用例离线确定性：假 ctx（pre-execute 挂载位）、假 system（派发计数器）、
// 假新鲜度端口（setFreshnessPort 注入缝）—— 零真网络、零真截屏、零服务孵化。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config.ts';
import { approval, resetApproval, setConfirmCodeChannel, type ConfirmCodeDelivery } from '../src/approval.ts';
import { journal, flushJournal, journalDiskStats } from '../src/journal.ts';
import { system } from '../src/system.ts';
import { setAccessibilityProvider } from '../src/uiExtractor.ts';
import { registerAuditGuard, MUTATING_TOOL_NAMES as GUARD_SIDE_BINDING } from '../src/guards/auditGuard.ts';
// ΑΩ-R28（注册处单源）：名单自工具装配唯一事实源只读引入 —— 单源恒等与
// 装配期完备性执法的受试面（桶在测试环境可静态导入，register.mjs 解析钩同源）。
import {
  MUTATING_TOOL_NAMES as TOOLS_SIDE_REGISTRY,
  assertToolAuditClassification,
  buildAllTools,
} from '../src/tools/index.ts';
import {
  setFreshnessPort, resetFreshnessProbe, probeGroundingFreshness,
  GROUNDING_FRESHNESS_THRESHOLD, freshnessPortInstalled,
  type GroundingFreshnessPort,
} from '../src/popupDetector.ts';
import { createClickMouseTool, consumeApprovalAmendment } from '../src/tools/clickMouse.ts';
import { createClickElementTool } from '../src/tools/clickElement.ts';
import { createDragMouseTool } from '../src/tools/dragMouse.ts';

// ─── 假件工坊 ───

const originalSystem = {
  clickMouse: system.clickMouse.bind(system),
  dragMouse: system.dragMouse.bind(system),
  getScreenSize: system.getScreenSize.bind(system),
};
let clicks: Array<{ x: number; y: number; button?: string }> = [];
let drags = 0;

/** 静默 console.warn（审计观察通道的噪声不进测试输出；断言走链上事实） */
function withSilencedWarn<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const orig = console.warn;
  console.warn = () => { /* 静默 */ };
  try {
    return fn();
  } finally {
    console.warn = orig;
  }
}

beforeEach(() => {
  resetApproval();
  journal.reset();
  journal.configure(true, '', 1000); // 内存链（无磁盘路径 ⇒ WAL 通道跳过）
  resetFreshnessProbe();
  clicks = [];
  drags = 0;
  system.clickMouse = async (x: number, y: number, button?: string) => { clicks.push({ x, y, button }); };
  system.dragMouse = async () => { drags++; };
  system.getScreenSize = async () => ({ width: 1920, height: 1080 });
});

afterEach(() => {
  system.clickMouse = originalSystem.clickMouse;
  system.dragMouse = originalSystem.dragMouse;
  system.getScreenSize = originalSystem.getScreenSize;
  resetFreshnessProbe();
  setAccessibilityProvider(null as any);
});

/** fake cordis ctx：采集 tools/pre-execute 挂载位（guard 的接线面） */
function makeFakeCtx() {
  const pre: Array<(exec: any, next: () => Promise<any>) => Promise<any>> = [];
  const ctx = {
    on: (ev: string, cb: any) => { if (ev === 'tools/pre-execute') pre.push(cb); },
  };
  return { ctx, pre };
}

/** 工具级配置：验证/探针/公证/法院全关（聚焦 S3/W1-2 执法，不碰 D-5 后端）。
 *  W6R：verifyActions=false 已不再单独构成危险令牌旁路 —— 本册聚焦 S3/W1-2，
 *  显式插入逃生门（两把钥匙齐备）保持「派发即消费」旧方言；探针 fail-closed
 *  新语义见 S3-4（显式关掉逃生门复现执法态）。 */
const toolCfg = {
  enableApprovalGate: true,
  dangerPatterns: 'send,发送,delete,删除,pay,支付',
  enableRiskGate: false,
  riskPatterns: '',
  maxTextLength: 1000,
  focusMaxAgeMs: 60_000,
  enableNotarizationLock: false,
  notarySemanticHandshake: true,
  enableOcr: false,
  ocrLang: 'eng',
  dryRun: false,
  verifyActions: false,
  allowUnverifiedDangerous: true,
  intentVerify: false,
  autoRemember: false,
  adaptiveSettle: false,
  actionSettleMs: 1,
  noopSimilarityThreshold: 0.97,
  regionVerifyRadius: 0.15,
  physicsRules: '',
  enableInteractivityProbe: false,
  enableRefuteCourt: false,
  enableDemonstrations: false,
} as unknown as Config;

type Executable = { execute: (a: unknown) => Promise<string> };
async function runJson(tool: unknown, args: unknown): Promise<any> {
  return JSON.parse(await (tool as Executable).execute(args));
}

/** 已授予的危险动作令牌（W6R fail-closed：授予须带外码 —— 内联武装采集 sink，
 *  正是生产中人类读码交回的视角；无码 grant 已废除） */
function grantedToken(description: string, note?: string): string {
  const sink: ConfirmCodeDelivery[] = [];
  setConfirmCodeChannel(d => { sink.push({ ...d }); });
  const pa = approval.request(description);
  const r = note !== undefined
    ? approval.grantDetailed(pa.token, true, { note, confirmCode: sink[0]?.confirmCode })
    : approval.grantDetailed(pa.token, true, { confirmCode: sink[0]?.confirmCode });
  assert.equal(r.ok, true, '令牌授予成功（测试前置）');
  return pa.token;
}

// ─── S4：auditGuard 先行审计（管线位） ───

test('S4-1: 五类变更工具全覆盖 —— 审计行在派发位（next）之前已入哈希链', async () => {
  const { ctx, pre } = makeFakeCtx();
  registerAuditGuard(ctx as never);
  assert.equal(pre.length, 1, 'pre-execute 挂载一次');

  const mutating = [
    'click_mouse', 'click_element', 'drag_mouse', 'scroll_page', 'type_text', 'press_hotkey',
  ];
  // 宿主 next 的非字符串回执（hooks.toPreDecision 只把字符串转 deny ——
  // 真实管线里 next() 返回宿主决策对象；此处以对象标记透传）
  const PASSTHROUGH = { passthrough: true };
  for (const tool of mutating) {
    let auditMarkersAtDispatch = -1;
    const out = await withSilencedWarn(() => pre[0](
      { name: tool, arguments: { x: 0.5, y: 0.5, text: 'hi', keys: ['ctrl'] } },
      async () => {
        auditMarkersAtDispatch = journal.list(false)
          .filter(e => e.tool === 'AUDIT_PRE' && e.args?.tool === tool).length;
        return PASSTHROUGH;
      },
    ));
    assert.deepEqual(out, PASSTHROUGH, `${tool} 提交成功 ⇒ 放行（透传 next 回执）`);
    assert.equal(auditMarkersAtDispatch, 1, `${tool}: next() 执行时 AUDIT_PRE 已在链上（先行性）`);
  }

  // 观察类工具不入先行审计（审计的是「世界将被打改」的意图）
  await pre[0]({ name: 'take_screenshot', arguments: {} }, async () => PASSTHROUGH);
  assert.equal(
    journal.list(false).some(e => e.tool === 'AUDIT_PRE' && e.args?.tool === 'take_screenshot'),
    false,
    '观察类工具不产生先行审计行',
  );

  // 六条 AUDIT_PRE 全部入链且链校验全绿（哈希链防篡改承诺未被破坏）
  const markers = journal.list(false).filter(e => e.tool === 'AUDIT_PRE');
  assert.equal(markers.length, mutating.length);
  const v = journal.verify();
  assert.equal(v.ok, true, `哈希链完整（len=${v.length}）`);
  // AUDIT_PRE 是 MARKER：不进 ACTION_TOOLS 视图（重放/技能归纳零污染）
  assert.equal(journal.list(true).some(e => e.tool === 'AUDIT_PRE'), false, '重放视图排除审计标记');
});

test('S4-2: 脱敏复用 —— type_text 的 text 字段在审计行中 [REDACTED]', async () => {
  const { ctx, pre } = makeFakeCtx();
  registerAuditGuard(ctx as never);
  await withSilencedWarn(() => pre[0](
    { name: 'type_text', arguments: { text: 'hunter2-secret', clearFirst: true } },
    async () => 'OK',
  ));
  const marker = journal.list(false).find(e => e.tool === 'AUDIT_PRE');
  assert.ok(marker, '审计行在场');
  assert.equal((marker!.args as any).args.text, '[REDACTED]', 'text 脱敏');
  assert.equal((marker!.args as any).args.clearFirst, true, '非敏感字段保留');
  assert.ok(!JSON.stringify(marker).includes('hunter2'), '审计行无明文秘密');
});

test('S4-3: 追加失败 ⇒ 拒派（fail-closed）—— 结构化 deny、next 不被调用', async () => {
  const { ctx, pre } = makeFakeCtx();
  registerAuditGuard(ctx as never);
  const original = journal.appendPreDispatch;
  (journal as any).appendPreDispatch = () => ({ ok: false, error: 'E_DISK_FULL' });
  try {
    let nextCalled = false;
    const out = await withSilencedWarn(() => pre[0](
      { name: 'click_mouse', arguments: { x: 0.5, y: 0.5 } },
      async () => { nextCalled = true; return { dispatched: true }; },
    )) as { kind: string; reason: string };
    assert.equal(nextCalled, false, '派发位从未执行（短路）');
    // hooks 方言：守卫字符串 → PreToolDecision deny（结构化拒绝面）
    assert.equal(out.kind, 'deny');
    const deny = JSON.parse(out.reason);
    assert.equal(deny.status, 'ACTION_REQUIRED');
    assert.equal(deny.state_anchor.audit_gate, 'fail-closed');
    assert.equal(deny.state_anchor.reason, 'pre-dispatch-audit-commit-failed');
    assert.equal(deny.state_anchor.tool, 'click_mouse');
    assert.match(deny.state_anchor.detail, /E_DISK_FULL/);
    assert.match(deny.state_anchor.note, /NOT dispatched/, '锚点写明动作未派发');
    assert.match(deny.next_step, /RETRY once/, '恢复指引');
  } finally {
    journal.appendPreDispatch = original;
  }
});

test('S4-4: fail-closed 绝不抛 —— 提交通道自身抛异常也被捕获为拒派', async () => {
  const { ctx, pre } = makeFakeCtx();
  registerAuditGuard(ctx as never);
  const original = journal.appendPreDispatch;
  (journal as any).appendPreDispatch = () => { throw new Error('canonical explosion'); };
  try {
    const out = await withSilencedWarn(() => pre[0](
      { name: 'type_text', arguments: { text: 'x' } },
      async () => ({ dispatched: true }),
    )) as { kind: string; reason: string };
    const deny = JSON.parse(out.reason);
    assert.equal(deny.state_anchor.reason, 'pre-dispatch-audit-commit-failed');
    assert.match(deny.state_anchor.detail, /canonical explosion/);
  } finally {
    journal.appendPreDispatch = original;
  }
});

test('S4-5: WAL 先行落盘 —— 派发前 .wal 同步行在场且自带链；磁盘故障 ⇒ fail-closed', async () => {
  // w2audit 修复：join 未导入（本册其余处均 path.join）—— 测试自身缺陷，非行为变化
  const dir = mkdtempSync(path.join(tmpdir(), 'w2audit-wal-'));
  try {
    // 健康通道：同步落盘（appendFileSync —— 调用返回即已交割 OS）
    journal.configure(true, path.join(dir, 'j.jsonl'), 100);
    const { ctx, pre } = makeFakeCtx();
    registerAuditGuard(ctx as never);
    const out1 = await pre[0]({ name: 'click_mouse', arguments: { x: 0.5, y: 0.5 } }, async () => ({ ok: 1 }));
    assert.deepEqual(out1, { ok: 1 }, '健康通道放行');
    const walRaw = readFileSync(path.join(dir, 'j.jsonl.wal'), 'utf8');
    // ΠΑΝ-55：首行是 genesis（机器指纹 + 启动计数 + 本地密钥 HMAC），审计行随后
    const walLines = walRaw.trim().split('\n');
    const genesis = JSON.parse(walLines[0]);
    assert.equal(genesis.kind, 'genesis', 'ΠΑΝ-55：WAL 首行 = 创世记录');
    assert.equal(genesis.seq, 0, '创世 seq=0（不占审计序号）');
    assert.equal(genesis.boot, 1, '首次铸造 ⇒ 启动计数 1');
    assert.match(genesis.genesis_mac, /^[0-9a-f]{64}$/, 'filePerms 保护密钥的 HMAC 在场');
    const line1 = JSON.parse(walLines[1]);
    assert.equal(line1.tool, 'click_mouse', 'WAL 行携带工具名');
    assert.equal(line1.seq, 1, 'WAL 序号单调');
    assert.match(line1.wal_hash, /^[0-9a-f]{64}$/, 'WAL 自身哈希链');
    assert.equal(line1.main_tip_before, 'GENESIS', '首审计行引用主链尖端（交叉锚）');
    assert.equal(line1.prev_wal, genesis.wal_hash, '审计行接续创世链尖（WAL 链连续）');

    await pre[0]({ name: 'type_text', arguments: { text: 'a' } }, async () => ({ ok: 2 }));
    const line2 = JSON.parse(readFileSync(path.join(dir, 'j.jsonl.wal'), 'utf8').trim().split('\n')[2]);
    assert.equal(line2.seq, 2);
    assert.equal(line2.prev_wal, line1.wal_hash, 'WAL 链连续（第二审计行 prev = 第一审计行哈希）');

    // 故障通道：路径父级是文件（mkdir/append 必败）⇒ fail-closed，且主链无半提交
    const blocker = path.join(dir, 'blocker.txt');
    writeFileSync(blocker, 'not a directory');
    journal.configure(true, path.join(blocker, 'sub', 'j.jsonl'), 100);
    const entriesBefore = journal.list(false).length;
    const out = await withSilencedWarn(() => pre[0](
      { name: 'drag_mouse', arguments: { startX: 0.1, startY: 0.1, endX: 0.2, endY: 0.2 } },
      async () => ({ dispatched: true }),
    )) as { kind: string; reason: string };
    const deny = JSON.parse(out.reason);
    assert.equal(deny.state_anchor.reason, 'pre-dispatch-audit-commit-failed', 'WAL 磁盘故障拒派');
    assert.equal(journal.list(false).length, entriesBefore, '失败路径主链零残留（无半提交）');
    // 主 JSONL 的异步取证副本落定后再清理（避免清理竞态的 ENOENT 噪声）
    // ΝΩ-38 真睡治理：固定 100ms 改为对可观察完成面（两条健康派发的取证副本落定）的有界轮询；超时放行（失败面与旧固定等待等同）。
    const forensicSettled = (): boolean => {
      try {
        const ls = readFileSync(path.join(dir, 'j.jsonl'), 'utf8').trim();
        return ls.length > 0 && ls.split('\n').length >= 2;
      } catch { return false; }
    };
    const settleBy = Date.now() + 2_000;
    while (!forensicSettled()) {
      if (Date.now() > settleBy) break;
      await new Promise(r => setTimeout(r, 5));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S4-6: enableJournal=false 是配置态非故障 —— skipped 注记 + 放行', async () => {
  const { ctx, pre } = makeFakeCtx();
  registerAuditGuard(ctx as never);
  journal.configure(false, '', 100);
  const before = journal.list(false).length;
  const out = await pre[0]({ name: 'click_mouse', arguments: { x: 0.5, y: 0.5 } }, async () => ({ passthrough: true }));
  assert.deepEqual(out, { passthrough: true }, '审计子系统未武装 ⇒ 放行（配置态不瘫痪动作面）');
  assert.equal(journal.list(false).length, before, '未武装时不产生审计行');
  // 直接调用面的同一语义
  journal.configure(true, '', 100);
  const r = journal.appendPreDispatch('click_mouse', { x: 0.5 });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, undefined, '武装后正常提交');
  assert.ok(r.hash, '提交返回链哈希');
});

// ─── S4 扩面（W6R-A9）：漏网变更工具补齐 —— 覆盖面修复的执法测试 ───

test('S4-7: W6R-A9 补齐的 12 件变更工具全覆盖 —— 派发位之前审计行已入哈希链', async () => {
  const { ctx, pre } = makeFakeCtx();
  registerAuditGuard(ctx as never);
  const PASSTHROUGH = { passthrough: true };

  // 名单依据（src/tools/index.ts 注册面 × README 工具表盘点，证据见 auditGuard 注释）：
  //  · 物理动作面：switch_tab/switch_window（真实键击/前台切换）、open_url（OS 壳层
  //    跳转）、replay_actions/run_skill（宏重放 = 一串物理动作）、shape_environment
  //    （窗口整形/缩放/对比度）；
  //  · 绕过宿主管线的动作批次：autonomous_run/autonomy_resume（环内 PolicyAction 经
  //    runtime.createExecute 直驱 system 键鼠，不经本守卫 —— 入口审计是唯一 WAL）；
  //  · 文件写入族：save_skill（技能库落盘）、save_checkpoint（快照写盘）、
  //    switch_vision_model（连接档案持久化 + 热换脑）、vlm_wizard（system.openUrl
  //    打开浏览器窗口）。
  const newlyCovered = [
    'switch_tab', 'switch_window', 'open_url', 'replay_actions', 'run_skill',
    'shape_environment', 'autonomous_run', 'autonomy_resume',
    'save_skill', 'save_checkpoint', 'switch_vision_model', 'vlm_wizard',
  ];
  for (const tool of newlyCovered) {
    let auditMarkersAtDispatch = -1;
    const out = await withSilencedWarn(() => pre[0](
      { name: tool, arguments: { goal: 'x', url: 'https://example.com', action: 'apply' } },
      async () => {
        auditMarkersAtDispatch = journal.list(false)
          .filter(e => e.tool === 'AUDIT_PRE' && e.args?.tool === tool).length;
        return PASSTHROUGH;
      },
    ));
    assert.deepEqual(out, PASSTHROUGH, `${tool} 提交成功 ⇒ 放行`);
    assert.equal(auditMarkersAtDispatch, 1, `${tool}: 派发位执行时 AUDIT_PRE 已在链上（先行性）`);
  }

  // 边界不入列（有理由的缺席，不是漏网）：
  //  · dismiss_popup —— 零副作用元工具（只返回重分析指令字符串）
  //  · probe_interactivity / zoom_inspect —— 观察探针（悬停实验是探针自身语义）
  //  · swarm_dispatch —— 控制面记账（物理 IO 走常规动作工具，逐次被审计）
  //  · remember_ui —— 会话内存笔记本（无磁盘持久化）
  for (const observer of ['dismiss_popup', 'probe_interactivity', 'zoom_inspect', 'swarm_dispatch', 'remember_ui']) {
    await pre[0]({ name: observer, arguments: {} }, async () => PASSTHROUGH);
    assert.equal(
      journal.list(false).some(e => e.tool === 'AUDIT_PRE' && e.args?.tool === observer),
      false,
      `${observer} 不产生先行审计行（观察/控制面）`,
    );
  }

  const v = journal.verify();
  assert.equal(v.ok, true, `哈希链完整（len=${v.length}，新增 12 件全入链）`);
});

test('S4-8: 新增覆盖面同等 fail-closed —— switch_window 审计提交失败 ⇒ 拒派', async () => {
  const { ctx, pre } = makeFakeCtx();
  registerAuditGuard(ctx as never);
  const original = journal.appendPreDispatch;
  (journal as any).appendPreDispatch = () => ({ ok: false, error: 'E_DISK_FULL' });
  try {
    let nextCalled = false;
    const out = await withSilencedWarn(() => pre[0](
      { name: 'switch_window', arguments: { titleKeyword: 'Chrome' } },
      async () => { nextCalled = true; return { dispatched: true }; },
    )) as { kind: string; reason: string };
    assert.equal(nextCalled, false, '新增面的派发位从未执行（短路）');
    assert.equal(out.kind, 'deny', '结构化 deny（方言 JSON）');
    const deny = JSON.parse(out.reason);
    assert.equal(deny.state_anchor.audit_gate, 'fail-closed');
    assert.equal(deny.state_anchor.tool, 'switch_window');
    assert.equal(deny.state_anchor.reason, 'pre-dispatch-audit-commit-failed');
  } finally {
    journal.appendPreDispatch = original;
  }
});

// ─── S4 子动作精化（D-D12）：shape_environment 按参数子动作分流 ───
// 名单计数不变（18 —— sec.audit-wal-floor 下限不松动），分流只发生在派发位：
// 只读子动作（capabilities/undo_log）不进提交通道，变更子动作（apply/restore）
// 与未知 action（不可证明只读 ⇒ 当作变更）照旧先行入链。

test('S4-9: shape_environment 子动作分流 —— 只读无 AUDIT_PRE、变更有、fail-closed 保持', async () => {
  const { ctx, pre } = makeFakeCtx();
  registerAuditGuard(ctx as never);
  const PASSTHROUGH = { passthrough: true };
  const auditCount = () =>
    journal.list(false).filter(e => e.tool === 'AUDIT_PRE' && e.args?.tool === 'shape_environment').length;

  // 只读子动作：capabilities（能力申报）/ undo_log（账本视图）—— 纯查询，
  // 不派发审计 WAL 行（D-D12 前被过度审计：调用即入链）
  for (const action of ['capabilities', 'undo_log']) {
    const out = await withSilencedWarn(() => pre[0](
      { name: 'shape_environment', arguments: { action } },
      async () => PASSTHROUGH,
    ));
    assert.deepEqual(out, PASSTHROUGH, `只读子动作 ${action} 放行`);
    assert.equal(auditCount(), 0, `${action} 不产生先行审计行（无世界变更意图）`);
  }

  // 变更子动作：apply（五 kind 全整形）与 restore（复原 = 再整形）—— 先行入链
  const mutatingArgs = [
    { action: 'apply', kind: 'raise_window', title_hint: 'Chrome' },
    { action: 'apply', kind: 'set_zoom', level: 125 },
    { action: 'restore' },
  ];
  for (const args of mutatingArgs) {
    const before = auditCount();
    const out = await withSilencedWarn(() => pre[0](
      { name: 'shape_environment', arguments: args },
      async () => PASSTHROUGH,
    ));
    assert.deepEqual(out, PASSTHROUGH, `${args.action} 提交成功 ⇒ 放行`);
    assert.equal(auditCount(), before + 1, `${args.action} 变更子动作 ⇒ AUDIT_PRE 先行入链`);
  }

  // fail-closed 闭集：未知/缺席 action 不可证明只读 ⇒ 当作变更审计
  for (const args of [{ action: 'apply-typo' }, {}, null]) {
    const before = auditCount();
    await withSilencedWarn(() => pre[0](
      { name: 'shape_environment', arguments: args },
      async () => PASSTHROUGH,
    ));
    assert.equal(auditCount(), before + 1, `未知/缺席 action（${JSON.stringify(args)}）仍审计`);
  }

  // 提交通道全坏时的分流语义：只读照常放行（不经通道 = 免故障牵连）；
  // 变更子动作提交失败 ⇒ 短路拒派（fail-closed 语义在新分流面上原样保持）
  const original = journal.appendPreDispatch;
  (journal as any).appendPreDispatch = () => ({ ok: false, error: 'E_DISK_FULL' });
  try {
    const outRo = await withSilencedWarn(() => pre[0](
      { name: 'shape_environment', arguments: { action: 'capabilities' } },
      async () => PASSTHROUGH,
    ));
    assert.deepEqual(outRo, PASSTHROUGH, '只读子动作不经提交通道 ⇒ 通道故障不影响');

    let nextCalled = false;
    const out = await withSilencedWarn(() => pre[0](
      { name: 'shape_environment', arguments: { action: 'apply', kind: 'set_contrast' } },
      async () => { nextCalled = true; return { dispatched: true }; },
    )) as { kind: string; reason: string };
    assert.equal(nextCalled, false, '变更子动作提交失败 ⇒ 派发位从未执行（短路）');
    assert.equal(out.kind, 'deny', '结构化 deny');
    const deny = JSON.parse(out.reason);
    assert.equal(deny.state_anchor.audit_gate, 'fail-closed');
    assert.equal(deny.state_anchor.tool, 'shape_environment');
    assert.equal(deny.state_anchor.reason, 'pre-dispatch-audit-commit-failed');
  } finally {
    journal.appendPreDispatch = original;
  }

  assert.equal(journal.verify().ok, true, '哈希链完整（分流不破坏防篡改承诺）');
});

// ─── S4 注册处单源 + 完备性执法（ΑΩ-R28）───
// 名单搬到家门口（tools/index.ts —— 工具装配唯一事实源）：登记处单源导出，
// auditGuard 只读引入；装配期断言对注册面全员二分类 —— 未分类名字装配即炸
//（配置期 fail-fast），「新增变更类工具忘登记 ⇒ 静默漏审计」的 fail-open
// 病灶（W6R-A9 历史事故）就此关闭。

test('S4-10: ΑΩ-R28 名单单源 —— tools 注册处与 auditGuard 执法面同一 Set，逐名执法全通', async () => {
  // 对象恒等：守卫面再导出的绑定 === 工具装配唯一事实源导出的绑定（同体，非拷贝/非影子名单）
  assert.equal(GUARD_SIDE_BINDING, TOOLS_SIDE_REGISTRY, '单源：两侧引用同一 Set 对象');
  // 名单下限（sec.audit-wal-floor 同律 —— 防误删回缩；下限语义给未来登记留增长空间）
  assert.ok(TOOLS_SIDE_REGISTRY.size >= 18, `变更类名单下限 18（实际 ${TOOLS_SIDE_REGISTRY.size}）`);

  // 执法面 = 注册面：登记的每个变更类工具经守卫管线都产生先行审计行
  //（shape_environment 以缺席 action 走 fail-closed 闭集 —— 同样入链）
  const { ctx, pre } = makeFakeCtx();
  registerAuditGuard(ctx as never);
  const PASSTHROUGH = { passthrough: true };
  for (const name of TOOLS_SIDE_REGISTRY) {
    const out = await withSilencedWarn(() => pre[0]({ name, arguments: {} }, async () => PASSTHROUGH));
    assert.deepEqual(out, PASSTHROUGH, `${name} 提交成功 ⇒ 放行`);
    assert.ok(
      journal.list(false).some(e => e.tool === 'AUDIT_PRE' && e.args?.tool === name),
      `${name}：注册处登记 ⇒ 执法面先行入链`,
    );
  }

  // 名单外仍是观察面（二分类不是全员审计 —— 白名单工具不入先行审计）
  await pre[0]({ name: 'take_screenshot', arguments: {} }, async () => PASSTHROUGH);
  assert.equal(
    journal.list(false).some(e => e.tool === 'AUDIT_PRE' && e.args?.tool === 'take_screenshot'),
    false,
    '白名单工具不产生先行审计行',
  );
  assert.equal(journal.verify().ok, true, '哈希链完整（单源执法不破坏防篡改承诺）');
});

/** 全开配置：buildAllTools 的每个挂载门都点亮（最大注册面）。cast 走 Config
 *  缝（与 toolCfg 同法 —— 工厂只读字段建定义，不触网、不落盘）。 */
const allOnCfg = {
  enableElementIdMode: true,
  localVisionApi: 'http://localhost:1/vision',
  enableUIMemory: true,
  enableJournal: true,
  enableOcr: true,
  vlmApiKey: 'w2audit-test-key',
  autonomyEnabled: true,
  enableInteractivityProbe: true,
  enableOpenUrl: true,
  enableSkillLibrary: true,
  enableQualityDoctor: true,
  enableSubAgents: true,
  enableEnvironmentShaper: true,
  enableApprovalGate: true,
  enableTelemetry: true,
  checkpointPath: 'w2audit-checkpoint.json',
  kernelEvolutionEnabled: true,
  federationEndpoint: 'http://localhost:1/federation',
} as unknown as Config;

test('S4-11: ΑΩ-R28 装配期完备性执法 —— 未分类名字装配即炸；全开配置全员二分类', () => {
  // 断言路径直驱：假工具名注入 ⇒ 如实 throw（配置期 fail-fast —— 报错点名
  // 假名并指回登记处，新工具作者第一眼就知道去哪登记）
  assert.throws(
    () => assertToolAuditClassification([
      { name: 'click_mouse' }, { name: 'take_screenshot' }, { name: 'dsh_unregistered_probe_tool' },
    ]),
    /dsh_unregistered_probe_tool[\s\S]*MUTATING_TOOL_NAMES[\s\S]*KNOWN_READ_ONLY_TOOL_NAMES/,
    '未分类名字 ⇒ 装配期如实报错（fail-fast）',
  );
  // 已分类两翼（变更类 + 只读/控制面白名单）⇒ 安静通过
  assert.doesNotThrow(() => assertToolAuditClassification([
    { name: 'click_mouse' }, { name: 'take_screenshot' }, { name: 'federation_sync' },
  ]), '已分类全员通过');

  // 全开配置真实装配：最大注册面全员二分类（buildAllTools 收尾断言不炸自证），
  // 且登记处无死名 —— 每个登记的变更类工具都确实会被装配出来
  const tools = buildAllTools(allOnCfg);
  const registered = new Set(tools.map(t => t.name));
  // ΝΩ-1：沙箱插件（sandbox/index.ts 的 apply）是第二注册面 —— 它的四件工具
  // 不经 buildAllTools 装配，但同样受审计分类账管辖（replay_on_host ∈ MUTATING）。
  // 硬编码四名与沙箱注册处同步：沙箱侧改名/删件时本断言即红（fail-fast 不弱化）。
  for (const name of ['rehearse_chain', 'recall_muscle', 'replay_on_host', 'verify_sandbox_log']) {
    registered.add(name);
  }
  for (const name of TOOLS_SIDE_REGISTRY) {
    assert.ok(registered.has(name), `登记处无死名：${name} 出现在全开注册面中`);
  }
  assert.ok(tools.length >= TOOLS_SIDE_REGISTRY.size, `装配面不小于登记面（${tools.length} ≥ ${TOOLS_SIDE_REGISTRY.size}）`);
});

// ─── S3：接地新鲜度探针 ───

/** 64 位位串，翻转前 n 位 —— 相似度 = 1 - n/64 */
function bitsWithFlips(n: number): string {
  return '1'.repeat(n) + '0'.repeat(64 - n);
}
const GROUNDING = '0'.repeat(64);

test('S3-1: 探针纯函数 —— 阈值边界判决与降级注记', async () => {
  // 端口缺席 ⇒ degraded（默认态：组合根接线前/离线测试）
  resetFreshnessProbe();
  assert.equal(freshnessPortInstalled(), false);
  const absent = await probeGroundingFreshness();
  assert.equal(absent.verdict, 'degraded');
  assert.equal(absent.note, 'probe-port-absent');

  // 接地指纹缺席 ⇒ degraded
  setFreshnessPort({ groundingHash: () => null, captureCurrentHash: async () => '0'.repeat(64) });
  assert.equal((await probeGroundingFreshness()).note, 'grounding-fingerprint-absent');

  // 当前帧端口失败/抛出 ⇒ degraded（fail-open + 观测）
  setFreshnessPort({ groundingHash: () => GROUNDING, captureCurrentHash: async () => { throw new Error('frame port down'); } });
  const failed = await probeGroundingFreshness();
  assert.equal(failed.verdict, 'degraded');
  assert.match(failed.note!, /probe-error/);

  // 阈值边界：8/64 位翻转 = 0.875 ≥ 0.85 ⇒ fresh；12/64 = 0.8125 < 0.85 ⇒ drifted
  setFreshnessPort({ groundingHash: () => GROUNDING, captureCurrentHash: async () => bitsWithFlips(8) });
  const fresh = await probeGroundingFreshness();
  assert.equal(fresh.verdict, 'fresh', '0.875 ≥ 0.85 放行');
  assert.equal(fresh.similarity_pct, 87.5);
  setFreshnessPort({ groundingHash: () => GROUNDING, captureCurrentHash: async () => bitsWithFlips(12) });
  const drifted = await probeGroundingFreshness();
  assert.equal(drifted.verdict, 'drifted', '0.8125 < 0.85 阻断');
  assert.equal(drifted.threshold_pct, Math.round(GROUNDING_FRESHNESS_THRESHOLD * 1000) / 10);
});

test('S3-2: 危险 click 漂移 ⇒ 阻断派发（零物理点击、令牌未烧、GUARD_BLOCKED 入链）', async () => {
  setFreshnessPort({ groundingHash: () => GROUNDING, captureCurrentHash: async () => '1'.repeat(64) });
  const tool = createClickMouseTool(toolCfg);
  const token = grantedToken('点击发送按钮发出邮件');

  const out = await runJson(tool, { x: 0.5, y: 0.5, target_description: '发送按钮', approval_token: token });
  assert.equal(out.status, 'ACTION_REQUIRED');
  assert.equal(out.state_anchor.reason, 'grounding-stale');
  assert.equal(out.state_anchor.freshness_probe.verdict, 'drifted');
  assert.equal(out.state_anchor.freshness_probe.similarity_pct, 0, '全翻转 ⇒ 相似度 0');
  assert.match(out.next_step, /STALE GROUNDING/, '结构化「需重新截图定位」指引');
  assert.equal(clicks.length, 0, '物理点击零派发');
  // 阻断在 beginAttempt 之前：令牌完整保留（attempts=0、validate=true）
  assert.equal(approval.validate(token), true, '令牌未烧 —— 同一授权内重感知后可重试');
  assert.equal(approval.status(token).attempts, 0, '未占用尝试预算');
  assert.ok(
    journal.list(false).some(e => e.tool === 'GUARD_BLOCKED' && e.args?.guard === 'freshness-probe'),
    '新鲜度拦截以 GUARD 方言入防篡改链',
  );
});

test('S3-3: 不漂移 ⇒ 放行派发（fresh 判决透明化）', async () => {
  setFreshnessPort({ groundingHash: () => GROUNDING, captureCurrentHash: async () => GROUNDING });
  const tool = createClickMouseTool(toolCfg);
  const token = grantedToken('点击发送按钮发出邮件');
  const out = await runJson(tool, { x: 0.5, y: 0.5, target_description: '发送按钮', approval_token: token });
  assert.equal(out.status, 'SUCCESS');
  assert.equal(clicks.length, 1, '物理点击已派发');
  assert.equal(out.state_anchor.freshness.verdict, 'fresh');
  assert.equal(out.state_anchor.freshness.similarity_pct, 100);
});

test('S3-4: 探针缺席 ⇒ 危险令牌派发被拒（W6R fail-closed + 观测注记）；逃生门 ⇒ 恢复 degraded 放行；非危险路径探针不入场', async () => {
  resetFreshnessProbe(); // 端口缺席（默认态）
  // 执法态（逃生门关闭）：fail-closed —— 叠加防御缺席不再放行不可逆动作
  const strictTool = createClickMouseTool({ ...toolCfg, allowUnverifiedDangerous: false });
  const token = grantedToken('点击发送按钮发出邮件');
  const out = await runJson(strictTool, { x: 0.5, y: 0.5, target_description: '发送按钮', approval_token: token });
  assert.equal(out.status, 'ACTION_REQUIRED', 'W6R：探针缺席 ⇒ 拒绝派发（fail-closed）');
  assert.equal(out.state_anchor.reason, 'freshness-probe-unavailable');
  assert.equal(out.state_anchor.freshness_probe.note, 'probe-port-absent', '缺席原因如实随锚点');
  assert.match(out.next_step, /allowUnverifiedDangerous=true/, '出路：显式逃生门');
  assert.equal(clicks.length, 0, '物理点击零派发');
  assert.equal(approval.validate(token), true, '令牌未烧（阻断在预留之前）');
  assert.equal(approval.status(token).attempts, 0, '未占用尝试预算');
  assert.ok(
    journal.list(false).some(e => e.tool === 'GUARD_BLOCKED' && e.args?.guard === 'freshness-probe'
      && String(e.args?.reason).includes('probe-unavailable')),
    'fail-closed 拦截以 GUARD 方言入防篡改链',
  );

  // 逃生门（allowUnverifiedDangerous=true）：恢复旧 fail-open 方言（降级不静默）
  const escapeTool = createClickMouseTool(toolCfg);
  const relaxed = await runJson(escapeTool, { x: 0.5, y: 0.5, target_description: '发送按钮', approval_token: token });
  assert.equal(relaxed.status, 'SUCCESS', '逃生门 ⇒ 探针缺席降级放行（旧行为）');
  assert.equal(clicks.length, 1);
  assert.equal(relaxed.state_anchor.freshness.verdict, 'degraded', '降级不静默 —— 锚点观测');
  assert.equal(relaxed.state_anchor.freshness.note, 'probe-port-absent');
  assert.equal(approval.validate(token), false, '逃生门下维持派发即消费旧方言（用后即焚）');

  // 非危险点击（无令牌）：探针完全不入场（键缺席 —— 叠加防御只挂危险面）
  const plain = await runJson(escapeTool, { x: 0.3, y: 0.3, target_description: '菜单按钮' });
  assert.equal(plain.status, 'SUCCESS');
  assert.equal(plain.state_anchor.freshness, undefined, '非危险路径零探针开销');
});

test('S3-5: click_element 漂移 ⇒ 阻断（ID 寻址通道的接地时距更长）', async () => {
  setAccessibilityProvider(async () => ({
    children: [
      { role: 'button', name: '发送', rect: { x: 400, y: 500, width: 100, height: 40 } }, // id 1
    ],
  }));
  setFreshnessPort({ groundingHash: () => GROUNDING, captureCurrentHash: async () => '1'.repeat(64) });
  const tool = createClickElementTool(toolCfg);
  const token = grantedToken('点击发送');
  const out = await runJson(tool, { id: 1, approval_token: token });
  assert.equal(out.status, 'ACTION_REQUIRED');
  assert.equal(out.state_anchor.reason, 'grounding-stale');
  assert.equal(out.state_anchor.freshness_probe.verdict, 'drifted');
  assert.equal(clicks.length, 0);
  assert.equal(approval.validate(token), true, '令牌未烧');
});

// ─── W1-2：批注消费接线 ───

test('W1-2a: click_mouse —— 批注修正目标描述生效并透明化', async () => {
  const tool = createClickMouseTool(toolCfg);
  const NOTE = '点右下角的小发送按钮，别点工具栏那个';
  const token = grantedToken('点击发送', NOTE);
  const out = await runJson(tool, { x: 0.5, y: 0.5, target_description: '发送', approval_token: token });
  assert.equal(out.status, 'SUCCESS');
  assert.equal(clicks.length, 1, '批注放行路径照常派发');
  assert.equal(out.state_anchor.amendment.applied, true);
  assert.equal(out.state_anchor.amendment.note, NOTE, '批注原文随锚点');
  assert.equal(out.state_anchor.amendment.corrected.target_description, NOTE, '描述被批注修正');
});

test('W1-2b: click_mouse —— 批注修正坐标 ⇒ 派发落点按修正坐标', async () => {
  const tool = createClickMouseTool(toolCfg);
  const token = grantedToken('点击发送');
  // 描写批注 x/y 修正的读取面（未来铸造面可产；此处直接驱动消费原语）
  const original = approval.applyAmendment;
  approval.applyAmendment = ((_t: string, plan: any) => ({ ...plan, x: 0.25, y: 0.75 })) as typeof original;
  try {
    const out = await runJson(tool, { x: 0.5, y: 0.5, target_description: '发送', approval_token: token });
    assert.equal(out.status, 'SUCCESS');
    assert.equal(clicks.length, 1);
    assert.equal(clicks[0].x, Math.round(0.25 * 1920), 'x 落点 = 批注修正坐标');
    assert.equal(clicks[0].y, Math.round(0.75 * 1080), 'y 落点 = 批注修正坐标');
    assert.equal(out.state_anchor.amendment.corrected.x, 0.25, '修正透明化');
  } finally {
    approval.applyAmendment = original;
  }
});

test('W1-2c: drag_mouse —— 批注修正后的描述参与危险判定（批注不得绕闸）', async () => {
  const tool = createDragMouseTool(toolCfg);
  // 模型自述无害（移动文件）；用户批注把目的地改述为删除区 —— 危险判定必须看到批注语义
  const token = grantedToken('整理文件', '拖到左下角删除区再放');
  const out = await runJson(tool, {
    startX: 0.2, startY: 0.2, endX: 0.4, endY: 0.4,
    target_description: '移动文件到文件夹', approval_token: token,
  });
  assert.equal(out.status, 'SUCCESS');
  assert.equal(drags, 1, '危险拖拽持已授予令牌 ⇒ 派发');
  assert.ok(out.state_anchor.approval_gate, '安检闸门被批注语义触发（described+consumed）');
  assert.equal(out.state_anchor.amendment.applied, true);
  assert.equal(out.state_anchor.amendment.corrected.target_description, '拖到左下角删除区再放');

  // 反向控制：无批注、无令牌、无害描述 ⇒ 旧路径（零安检注记、零 amendment 键）
  const plain = await runJson(tool, {
    startX: 0.2, startY: 0.2, endX: 0.4, endY: 0.4, target_description: '移动文件到文件夹',
  });
  assert.equal(plain.status, 'SUCCESS');
  assert.equal(plain.state_anchor.approval_gate, undefined, '无害拖拽不经安检（描述可选通道）');
  assert.equal(plain.state_anchor.amendment, undefined, '无批注零行为');
});

test('W1-2d: click_element —— 批注修正元素描述参与闸门 + 透明化', async () => {
  setAccessibilityProvider(async () => ({
    children: [
      { role: 'button', name: '整理列表', rect: { x: 700, y: 500, width: 100, height: 40 } }, // id 1
    ],
  }));
  const tool = createClickElementTool(toolCfg);
  // 元素名无害；批注把目标改述为危险语义 ⇒ 闸门按批注后的描述审判（需令牌）
  const token = grantedToken('点击整理列表', '其实是要点旁边的删除全部按钮');
  const out = await runJson(tool, { id: 1, approval_token: token });
  assert.equal(out.status, 'SUCCESS');
  assert.equal(clicks.length, 1, '持已授予令牌放行');
  assert.equal(out.state_anchor.approval_gate, 'notarized-approved', '闸门按批注后描述判危险并验令牌');
  assert.equal(out.state_anchor.amendment.applied, true);
  assert.equal(out.state_anchor.amendment.corrected.target_description, '其实是要点旁边的删除全部按钮');
});

test('W1-2e: 越界批注修正被忽略并注记（防御式 —— 批注是人写的自然语言铸造物）', async () => {
  const original = approval.applyAmendment;
  approval.applyAmendment = ((_t: string, plan: any) => ({
    ...plan, x: 1.5, target_description: plan.target_description,
  })) as typeof original;
  try {
    // 混合修正：x 越界（忽略+注记）、描述未变 —— 零生效字段 ⇒ 零行为
    const out = consumeApprovalAmendment('APR-ANY', { tool: 'click_mouse', x: 0.5, y: 0.5, target_description: '发送' });
    assert.equal(out.x, undefined, '越界 x 修正被忽略');
    assert.deepEqual(out, {}, '无生效修正 ⇒ 零行为（旧路径不变）');
    // 与生效修正并存时：越界事实随 stamp 注记（观测面）
    approval.applyAmendment = ((_t: string, plan: any) => ({
      ...plan, x: 1.5, y: 0.75, target_description: '改述后的发送按钮',
    })) as typeof original;
    const mixed = consumeApprovalAmendment('APR-ANY', { tool: 'click_mouse', x: 0.5, y: 0.5, target_description: '发送' });
    assert.equal(mixed.y, 0.75, '合法修正生效');
    assert.equal(mixed.x, undefined, '越界修正仍被忽略');
    assert.deepEqual(mixed.stamp!.ignored_out_of_range, ['x=1.5'], '忽略事实注记（透明化）');
    assert.equal(mixed.stamp!.corrected.target_description, '改述后的发送按钮');
  } finally {
    approval.applyAmendment = original;
  }
  // 无令牌 ⇒ 零行为
  assert.deepEqual(consumeApprovalAmendment(undefined, { tool: 'click_mouse', x: 0.5 }), {});
});

// ─── S4 与工具链的合成执法：审计先行 + 新鲜度阻断共存 ───

test('合成: 先行审计在链、新鲜度阻断在派发前 —— 两道防线互不干扰', async () => {
  const { ctx, pre } = makeFakeCtx();
  registerAuditGuard(ctx as never);
  setFreshnessPort({ groundingHash: () => GROUNDING, captureCurrentHash: async () => '1'.repeat(64) });
  const tool = createClickMouseTool(toolCfg);
  const token = grantedToken('点击发送');

  // 经守卫管线执行危险点击：审计行先行入链（S4），随后工具内新鲜度阻断（S3）。
  // 宿主 next 回执形（ToolExecutionResult 同形对象 —— 字符串会被 hooks 转译 deny）
  const execArgs = { x: 0.5, y: 0.5, target_description: '发送按钮', approval_token: token };
  const decision = await withSilencedWarn(() => pre[0](
    { name: 'click_mouse', arguments: execArgs },
    async () => ({ isError: false, value: await (tool as Executable).execute(execArgs) }),
  )) as { isError: boolean; value: string };
  const out = JSON.parse(decision.value);
  assert.equal(out.status, 'ACTION_REQUIRED');
  assert.equal(out.state_anchor.reason, 'grounding-stale', 'S3 阻断生效');
  assert.ok(
    journal.list(false).some(e => e.tool === 'AUDIT_PRE' && e.args?.tool === 'click_mouse'),
    'S4 先行审计行已在链（被阻断的动作同样有审计轨迹）',
  );
  assert.ok(
    journal.list(false).some(e => e.tool === 'GUARD_BLOCKED' && e.args?.guard === 'freshness-probe'),
    'S3 阻断留痕入链',
  );
  assert.equal(journal.verify().ok, true, '链完整');
});

// ─── ΝΩ-2：审计 WAL 顺序倒置修复 —— 拦截路径的 journal 行序执法 ───
//
// 注册序 = 瀑布执行序（src/guards/index.ts）：拦截型 pre 守卫（popup/repeat/
// canary）必须先于 auditGuard 的 pre-WAL 提交。被拦截的动作**不得**留下
// 「即将派发」的 AUDIT_PRE 幽灵行（回滚系统按 WAL 对账会对未发生的动作回滚）；
// 通过全部拦截的动作仍保持「审计先行于派发」（W2-2 fail-closed 语义不变）。

test('ΝΩ-2: 弹窗拦截 ⇒ 零 AUDIT_PRE（幽灵审计行消灭）；放行动作 ⇒ 审计先行于派发', async () => {
  const { registerAllGuards } = await import('../src/guards/index.ts');
  const { TACTICAL_PAUSE, updatePopupState } = await import('../src/guards/popupGuard.ts');
  // fake ctx：按事件名收集挂载位（注册序保留 —— 瀑布序的受试面）
  const handlers: Array<{ event: string; handler: any }> = [];
  const ctx = { on(event: string, handler: any) { handlers.push({ event, handler }); return () => {}; } };
  const cfg = {
    maxConsecutiveFailures: 99,
    dangerPatterns: 'send,delete,支付',
    noopSimilarityThreshold: 0.97,
    probeRegionRadius: 0.06,
    dryRun: false,
    focusMaxAgeMs: 30_000,
    enableInteractivityProbe: false,
    enableJournal: true, journalPath: '',
    enableTelemetry: false,
  } as unknown as Config;
  registerAllGuards(ctx as never, cfg);
  const pres = handlers.filter(h => h.event === 'tools/pre-execute').map(h => h.handler);
  assert.ok(pres.length >= 6, `六层 pre 瀑布在册（实际 ${pres.length}）`);
  // 宿主瀑布：handler[i] 的 next ⇒ handler[i+1]；末位 next ⇒ 工具派发位
  const drivePre = (e: any, dispatch?: () => void): Promise<any> => {
    const run = (i: number): Promise<any> =>
      i >= pres.length ? Promise.resolve(dispatch ? dispatch() : { kind: 'accept' }) : pres[i](e, () => run(i + 1));
    return run(0);
  };
  const exec = (name: string, args: unknown): any =>
    ({ name, arguments: args, agent: { id: 'now2-audit' }, token: {}, rootCallId: 'c1' });

  // ① 弹窗活跃 ⇒ popup 拦截：AUDIT_PRE 零落盘（旧序会先落 WAL 再被拦 —— 幽灵行）
  updatePopupState(true, 'now2-audit'); // ΑΩ-R24：弹窗态按会话分键（exec 带 agent.id）
  let dispatchCalled = false;
  const blocked = await withSilencedWarn(() => drivePre(exec('click_mouse', { x: 0.5, y: 0.5 }), () => {
    dispatchCalled = true;
    return { kind: 'accept' };
  }));
  updatePopupState(false, 'now2-audit');
  assert.equal(blocked.kind, 'deny');
  assert.equal(blocked.reason, TACTICAL_PAUSE, 'popup 拦截话术（话术单一事实源）');
  assert.equal(dispatchCalled, false, '派发位未执行');
  assert.equal(
    journal.list(false).some(e => e.tool === 'AUDIT_PRE' && e.args?.tool === 'click_mouse'),
    false,
    '被拦截动作零 AUDIT_PRE —— 有意图无动作的幽灵审计行消灭',
  );

  // ② 弹窗解除 ⇒ 同一动作放行：AUDIT_PRE 在派发位执行时已在链上（先行性不变）
  let auditAtDispatch = -1;
  const out = await withSilencedWarn(() => drivePre(exec('click_mouse', { x: 0.5, y: 0.5 }), () => {
    auditAtDispatch = journal.list(false).filter(e => e.tool === 'AUDIT_PRE' && e.args?.tool === 'click_mouse').length;
    return { kind: 'accept' };
  }));
  assert.deepEqual(out, { kind: 'accept' }, '全链放行');
  assert.equal(auditAtDispatch, 1, 'audit 仍在工具派发之前提交（W2-2 先行性零回归）');
});

test('ΝΩ-2: 防重拦截 ⇒ 不新增 AUDIT_PRE（只记真正派发的两次）；金丝雀 fail-closed 同律', async () => {
  const { registerAllGuards } = await import('../src/guards/index.ts');
  const { updatePopupState } = await import('../src/guards/popupGuard.ts');
  const { kernelRegistry } = await import('../src/kernel/registry.ts');
  const { recentCanaryEvents, resetCanaryGuard } = await import('../src/guards/canaryGuard.ts');
  const handlers: Array<{ event: string; handler: any }> = [];
  const ctx = { on(event: string, handler: any) { handlers.push({ event, handler }); return () => {}; } };
  const cfg = {
    maxConsecutiveFailures: 99,
    dangerPatterns: 'send,delete,支付',
    noopSimilarityThreshold: 0.97,
    probeRegionRadius: 0.06,
    dryRun: false,
    focusMaxAgeMs: 30_000,
    enableInteractivityProbe: false,
    enableJournal: true, journalPath: '',
    enableTelemetry: false,
  } as unknown as Config;
  registerAllGuards(ctx as never, cfg);
  const pres = handlers.filter(h => h.event === 'tools/pre-execute').map(h => h.handler);
  const posts = handlers.filter(h => h.event === 'tools/post-execute').map(h => h.handler);
  const drivePre = (e: any, dispatch?: () => any): Promise<any> => {
    const run = (i: number): Promise<any> =>
      i >= pres.length ? Promise.resolve(dispatch ? dispatch() : { kind: 'accept' }) : pres[i](e, () => run(i + 1));
    return run(0);
  };
  const drivePost = async (e: any, result: any): Promise<any> => {
    const run = async (i: number): Promise<any> =>
      i >= posts.length ? result : posts[i](e, result, () => run(i + 1));
    return run(0);
  };
  const exec = (name: string, args: unknown): any =>
    ({ name, arguments: args, agent: { id: 'now2-audit' }, token: {}, rootCallId: 'c1' });
  const FAILED_RESULT = { isError: false, value: '{\n  "status": "FAILED",\n  "state_anchor": {}\n}' };
  const countAudit = (): number =>
    journal.list(false).filter(e => e.tool === 'AUDIT_PRE' && e.args?.tool === 'click_mouse').length;
  updatePopupState(false);

  // ① 第一次点击：全链放行（AUDIT_PRE=1），post 判失败（防重守卫记忆同签名失败）
  const o1 = await withSilencedWarn(() => drivePre(exec('click_mouse', { x: 0.5, y: 0.5 })));
  assert.deepEqual(o1, { kind: 'accept' });
  assert.equal(countAudit(), 1, '第一次真实派发 ⇒ 先行审计行在册');
  await withSilencedWarn(() => drivePost(exec('click_mouse', { x: 0.5, y: 0.5 }), FAILED_RESULT));

  // ② 第二次原样重试 ⇒ repeatAction 拦截：零新增 AUDIT_PRE
  //   （旧序 audit 先于 repeat ⇒ 这里会是 2 —— 有意图无动作的幽灵行，本测试执法消灭）
  let dispatchCalled = false;
  const o2 = await withSilencedWarn(() => drivePre(exec('click_mouse', { x: 0.5, y: 0.5 }), () => {
    dispatchCalled = true;
    return { kind: 'accept' };
  }));
  assert.equal(o2.kind, 'deny', '原样重试被防重守卫拦截');
  assert.match(o2.reason, /Repeated identical action/, '拦截方言（换策略指引）');
  assert.equal(dispatchCalled, false);
  assert.equal(countAudit(), 1, '被拦截重试零新增 AUDIT_PRE —— 行序执法：只记真正派发的动作');

  // ③ 金丝雀 fail-closed（令牌路径 + 探针缺席）⇒ 拦截同样零 AUDIT_PRE；
  //    非令牌对照 ⇒ 降级放行 + AUDIT_PRE 落盘（金丝雀之后 audit 照常执法）
  kernelRegistry.register({ key: 'uncertainty.highProceed', organ: 'now2-audit', defaultValue: 0.7, min: 0, max: 1 });
  try {
    const pa = approval.request('expand options under token protocol');
    const blockedToken = await withSilencedWarn(() => drivePre(exec('click_mouse', {
      x: 0.6, y: 0.6, target_description: 'Expand Advanced Options',
      expected_change: 'advanced settings panel expands', confidence: 0.95, approval_token: pa.token,
    })));
    assert.equal(blockedToken.kind, 'deny', 'W6R：令牌路径探针缺席 ⇒ fail-closed 拦截');
    assert.match(blockedToken.reason, /\[Canary\]/);
    assert.equal(countAudit(), 1, '金丝雀拦截 ⇒ 零新增 AUDIT_PRE（幽灵行同律消灭）');
    assert.equal(recentCanaryEvents()[0].action, 'blocked', '拦截留痕走金丝雀自身观察面（语义=被拦截）');

    const before = countAudit();
    const benign = await withSilencedWarn(() => drivePre(exec('click_mouse', {
      x: 0.7, y: 0.7, target_description: 'Expand Advanced Options',
      expected_change: 'advanced settings panel expands', confidence: 0.95,
    })));
    assert.deepEqual(benign, { kind: 'accept' }, '非令牌 ⇒ 探针缺席降级放行（可用性优先）');
    assert.equal(countAudit(), before + 1, '放行路径 audit 照常先行提交（顺序修复不废 fail-closed 审计）');
  } finally {
    kernelRegistry.reset();
    resetCanaryGuard();
    updatePopupState(false);
  }
});

// ─── ΝΩ-45：组提交窗口内的 WAL 同步执法（W2-2 语义零回归的增量执法） ───
// 主 JSONL 改组提交（行缓冲 + 按批 fsync）后，先行审计的底线由 WAL 独立承担：
// appendPreDispatch 的 appendFileSync 同步通道**绝不入队** —— 派发前返回即已
// 交割 OS。本用例在主 JSONL 尚处组提交窗口（未冲刷）时即读 .wal，执法该不变量。

test('ΝΩ-45: WAL 仍同步执法 —— 主 JSONL 在组提交窗口内未落，.wal 已先行在盘', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'w2audit-no45-'));
  try {
    journal.reset();
    journal.configure(true, path.join(dir, 'j.jsonl'), 100);
    const r = journal.appendPreDispatch('click_mouse', { x: 0.5 });
    assert.equal(r.ok, true, '健康通道提交成功');
    // 主 JSONL：仍在内存行缓冲（异步取证副本 —— 吞吐导向，W2-2 立法的另一半）
    assert.equal(existsSync(path.join(dir, 'j.jsonl')), false, '主 JSONL 在组提交窗口内（未冲刷）');
    assert.equal(journalDiskStats().buffered, 1, 'AUDIT_PRE 的主 JSONL 副本走队列（WAL 为同步底线）');
    // WAL：同步先行在盘 —— appendFileSync 返回即交割 OS（fail-closed 的物理根基）
    // ΠΑΝ-55：首行 genesis（创世记录），首审计行第二 —— 结构如实解析
    const wal = readFileSync(path.join(dir, 'j.jsonl.wal'), 'utf8');
    const walRows = wal.trim().split('\n').map(l => JSON.parse(l));
    assert.equal(walRows[0].kind, 'genesis', 'ΠΑΝ-55：WAL 首行 = 创世记录');
    const row = walRows[1];
    assert.equal(row.tool, 'click_mouse', 'WAL 行携带工具名');
    assert.equal(row.seq, 1, 'WAL 序号单调');
    assert.match(row.wal_hash, /^[0-9a-f]{64}$/, 'WAL 自身哈希链在场');
    assert.equal(row.main_tip_before, 'GENESIS', '首审计行引用主链尖端（交叉锚）');
    // 冲刷后主 JSONL 取证副本补齐（与 WAL 行同源对账）
    assert.equal(flushJournal(), 1);
    const disk = JSON.parse(readFileSync(path.join(dir, 'j.jsonl'), 'utf8').trim());
    assert.equal(disk.tool, 'AUDIT_PRE');
    assert.equal(disk.hash, row.hash, '主链行哈希 = WAL 交叉锚（崩溃后可对账复原）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    journal.configure(true, '', 1000);
  }
});
