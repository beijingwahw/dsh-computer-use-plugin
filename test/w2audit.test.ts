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
//   · 端口缺席/失败 ⇒ degraded 放行（fail-open + 观测注记）；
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
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config.ts';
import { approval, resetApproval } from '../src/approval.ts';
import { journal } from '../src/journal.ts';
import { system } from '../src/system.ts';
import { setAccessibilityProvider } from '../src/uiExtractor.ts';
import { registerAuditGuard } from '../src/guards/auditGuard.ts';
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

/** 工具级配置：验证/探针/公证/法院全关（聚焦 S3/W1-2 执法，不碰 D-5 后端） */
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

/** 已授予（无码降级）的危险动作令牌 */
function grantedToken(description: string, note?: string): string {
  const pa = approval.request(description);
  const r = note !== undefined
    ? approval.grantDetailed(pa.token, true, { note })
    : approval.grantDetailed(pa.token, true);
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
  const dir = mkdtempSync(path.join(tmpdir(), 'w2audit-wal-'));
  try {
    // 健康通道：同步落盘（appendFileSync —— 调用返回即已交割 OS）
    journal.configure(true, path.join(dir, 'j.jsonl'), 100);
    const { ctx, pre } = makeFakeCtx();
    registerAuditGuard(ctx as never);
    const out1 = await pre[0]({ name: 'click_mouse', arguments: { x: 0.5, y: 0.5 } }, async () => ({ ok: 1 }));
    assert.deepEqual(out1, { ok: 1 }, '健康通道放行');
    const walRaw = readFileSync(path.join(dir, 'j.jsonl.wal'), 'utf8');
    const line1 = JSON.parse(walRaw.trim().split('\n')[0]);
    assert.equal(line1.tool, 'click_mouse', 'WAL 行携带工具名');
    assert.equal(line1.seq, 1, 'WAL 序号单调');
    assert.match(line1.wal_hash, /^[0-9a-f]{64}$/, 'WAL 自身哈希链');
    assert.equal(line1.main_tip_before, 'GENESIS', '首行引用主链尖端（交叉锚）');

    await pre[0]({ name: 'type_text', arguments: { text: 'a' } }, async () => ({ ok: 2 }));
    const line2 = JSON.parse(readFileSync(path.join(dir, 'j.jsonl.wal'), 'utf8').trim().split('\n')[1]);
    assert.equal(line2.seq, 2);
    assert.equal(line2.prev_wal, line1.wal_hash, 'WAL 链连续（第二行 prev = 第一行哈希）');

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
    await new Promise(r => setTimeout(r, 100));
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

test('S3-4: 探针缺席 ⇒ degraded 放行（fail-open + 观测注记）；非危险路径探针不入场', async () => {
  resetFreshnessProbe(); // 端口缺席（默认态）
  const tool = createClickMouseTool(toolCfg);
  const token = grantedToken('点击发送按钮发出邮件');
  const out = await runJson(tool, { x: 0.5, y: 0.5, target_description: '发送按钮', approval_token: token });
  assert.equal(out.status, 'SUCCESS', 'fail-open：叠加防御缺席不瘫痪危险动作面');
  assert.equal(clicks.length, 1);
  assert.equal(out.state_anchor.freshness.verdict, 'degraded', '降级不静默 —— 锚点观测');
  assert.equal(out.state_anchor.freshness.note, 'probe-port-absent');

  // 非危险点击（无令牌）：探针完全不入场（键缺席 —— 叠加防御只挂危险面）
  const plain = await runJson(tool, { x: 0.3, y: 0.3, target_description: '菜单按钮' });
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
