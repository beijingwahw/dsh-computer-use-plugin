// test/epochDelta.perimeter.test.ts
// 纪元 Δ（全库跃迁）· 安全外围簇六项执法册（与 epochDelta.test.ts /
// epochDelta.safety.test.ts 分簇 —— 本册只执法本簇五文件 + 新测试）：
//   P-1 riskGate 全角折叠不对称：normalizeForRisk 迭代至不动点（≤3 遍）
//   P-2 riskGate 模式归一化零缓存：按生效 csv 记忆化（上限 32，满逐最旧）
//   P-3 telemetryGuard 延迟恒 0：以原始 exec 引用为键（pre/post 同对象命中）
//   P-4 resultContract 未登记状态致熔断失明：PARTIAL_FAILURE→失败、GRANTED/
//       REVOKED→成功；grant 限流拒绝经契约层透出真实成因 rateLimited
//   P-5 qualityCheckup 唯一裸奔 execute：异常降级 toolErr（action 名保留）
//   P-6 dragMouse 拖拽零安检：target_description + 危险词审批闸门（对齐 click）
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Config } from '../src/config.ts';
import { system } from '../src/system.ts';
import { telemetry } from '../src/telemetry.ts';
import { approval, approvalBudget, resetApproval, setConfirmCodeChannel, type ConfirmCodeDelivery } from '../src/approval.ts';
import { doctor } from '../src/qualityDoctor.ts';
import { matchesDangerPatterns, matchesRiskPatterns, riskPatternCacheSize } from '../src/riskGate.ts';
import { classifyResult, isFailure, isSuccess } from '../src/resultContract.ts';
import { registerTelemetryGuard } from '../src/guards/telemetryGuard.ts';
import { createQualityCheckupTool } from '../src/tools/qualityCheckup.ts';
import { createDragMouseTool } from '../src/tools/dragMouse.ts';

// ─── 公共脚手架：假 system（物理派发计数器 = 拦截断言的事实源）───

const sysOriginals = {
  getScreenSize: system.getScreenSize.bind(system),
  dragMouse: system.dragMouse.bind(system),
};
let drags = 0;
let dragSizeCalls = 0;

function installFakeDragSystem(): void {
  drags = dragSizeCalls = 0;
  system.getScreenSize = async () => { dragSizeCalls++; return { width: 1920, height: 1080 }; };
  system.dragMouse = async () => { drags++; };
}

beforeEach(() => {
  resetApproval();
  installFakeDragSystem();
});

afterEach(() => {
  system.getScreenSize = sysOriginals.getScreenSize;
  system.dragMouse = sysOriginals.dragMouse;
});

type Executable = { execute: (a: unknown) => Promise<string> };

/** W6R fail-closed：带外码采集 + 携码授予（无码 grant 已废除 —— 授予面一律走此助手） */
const oobSink: ConfirmCodeDelivery[] = [];
function armOob(): void {
  setConfirmCodeChannel(d => { oobSink.push({ ...d }); });
}
function grantOob(token: string): boolean {
  const hit = oobSink.find(d => d.token === token);
  return approval.grantDetailed(token, true, hit ? { confirmCode: hit.confirmCode } : {}).ok;
}

// ─── P-1 riskGate：全角折叠对称性（不动点迭代） ───

test('P-1: 全角折叠对称 —— ｓｕｂｍｉｔ/ｃｏｎｆｉｒｍ/全角混合变体全命中，正常文本不误伤', () => {
  // 审计复现：旧单遍归一下 ｓｕｂｍｉｔ → 'submit'（全角表折叠为 m 后不再动），
  // 而 ASCII 词表 'submit' 单遍即成 'subrnit'（CONFUSABLES_ASCII 的 m→rn）——
  // 两侧停在不同中间形态 ⇒ 匹配面被静默击穿。
  assert.equal(matchesDangerPatterns('submit', 'submit'), true, '半角基线（对称前提）');
  assert.equal(matchesDangerPatterns('ｓｕｂｍｉｔ', 'submit'), true, '全角 submit（审计逃逸样本归案）');
  assert.equal(matchesDangerPatterns('ｃｏｎｆｉｒｍ', ''), true, '全角 confirm 命中默认危险词');
  assert.equal(matchesDangerPatterns('点击 ｓＵｂｍｉｔ ｏｒｄｅｒ 按钮', ''), true, '全角+大小写混合 submit order');
  assert.equal(matchesDangerPatterns('拖到 ｄｅｌｅｔｅ 区', ''), true, '半全角混合 delete');
  // 风险词侧同律（全角凭据语义不再逃逸审批/风险闸门）
  assert.equal(matchesRiskPatterns('ｐ@ssｗ0rd', 'password'), true, '全角+leet 混合 password');
  assert.equal(matchesRiskPatterns('输入 ＡＰＩ ｋｅｙ', ''), true, '全角 api key');
  // 正常文本不误伤（保守方向的代价边界）
  assert.equal(matchesDangerPatterns('resize the window slider', ''), false);
  assert.equal(matchesDangerPatterns('菜单按钮', ''), false);
  assert.equal(matchesDangerPatterns('submission guidelines page', ''), false);
  assert.equal(matchesDangerPatterns('参考文献综述', ''), false);
  assert.equal(matchesRiskPatterns('hello world notes', ''), false);
});

// ─── P-2 riskGate：模式归一化记忆化 ───

test('P-2: 模式归一化记忆化 —— 同 csv 复用缓存，fallback 分键，上限 32', () => {
  const before = riskPatternCacheSize();
  matchesDangerPatterns('发送', 'probe-alpha,probe-beta');
  assert.equal(riskPatternCacheSize(), before + 1, '新 csv 入缓存');
  for (let i = 0; i < 10; i++) matchesDangerPatterns('再次发送', 'probe-alpha,probe-beta');
  assert.equal(riskPatternCacheSize(), before + 1, '同 csv 十连击零新增条目（缓存命中，零重复归一化）');
  // 键 = 生效 csv（csv || fallback）：双入口传同一非空 csv ⇒ 共用一条
  matchesRiskPatterns('secret', 'probe-alpha,probe-beta');
  assert.equal(riskPatternCacheSize(), before + 1, '跨 matches* 入口同 csv 复用同一条');
  // fallback 分键的行为证明：空 csv 时 danger 查危险词缺省、risk 查风险词缺省 ——
  // 若两入口共用了同一条缓存，后查的入口会拿错词表（危险词表查不出「密码」）
  assert.equal(matchesDangerPatterns('发送', ''), true, '空 csv → DEFAULT_DANGER_PATTERNS');
  assert.equal(matchesRiskPatterns('密码', ''), true, '空 csv → DEFAULT_RISK_PATTERNS（两缺省分键）');
  // 逐出策略：灌 33 个新 csv，缓存封顶 32（满逐最旧，不为词表组合无限付费）
  for (let i = 0; i < 33; i++) matchesDangerPatterns('x', `evict-probe-${i}`);
  assert.equal(riskPatternCacheSize(), 32, '缓存上限受控');
});

// ─── P-3 telemetryGuard：延迟指标以原始 exec 引用为键 ───

function makeFakeCtx() {
  const pre: { (exec: any, next: () => Promise<any>): Promise<any> }[] = [];
  const post: { (exec: any, result: any, next: (v: any) => Promise<any>): Promise<any> }[] = [];
  const ctx = {
    on: (ev: string, cb: any) => {
      if (ev === 'tools/pre-execute') pre.push(cb);
      else if (ev === 'tools/post-execute') post.push(cb);
    },
  };
  return { ctx, pre, post };
}

test('P-3: 同 exec 引用 pre/post ⇒ duration = 实测时长（旧实现恒 0）', async () => {
  telemetry.reset();
  const { ctx, pre, post } = makeFakeCtx();
  registerTelemetryGuard(ctx as any);
  assert.equal(pre.length, 1, 'pre 挂载在原始事件上');
  assert.equal(post.length, 1, 'post 挂载在原始事件上');

  const origNow = Date.now;
  let clock = 10_000;
  Date.now = () => clock;
  try {
    // rc.6 形状的 ToolExecution —— pre/post 发**同一对象**（审计缺陷的宿主事实）
    const exec = { name: 'click_mouse', arguments: { x: 0.5, y: 0.5 }, agent: { id: 'sess-1' } };
    await pre[0](exec, async () => 'pre-passthrough');
    clock = 10_075; // 工具执行 75ms
    const rawResult = { isError: false, value: JSON.stringify({ status: 'SUCCESS' }) };
    const passthrough = await post[0](exec, rawResult, async (r: any) => r);
    assert.equal(passthrough, rawResult, '原始 result 引用原样透传（观察者绝不改写）');

    const snap = telemetry.snapshot();
    assert.equal(snap.global.calls, 1, '计数准确');
    assert.equal(snap.global.successes, 1, 'value 臂经契约判 SUCCESS');
    const row = (snap.tools as any[]).find(t => t.tool === 'click_mouse');
    assert.ok(row, '遥测行在场');
    assert.equal(row.p50_ms, 75, '延迟 = pre→post 实测时长（旧实现 WeakMap 键永不命中 ⇒ 恒 0）');
  } finally {
    Date.now = origNow;
  }
});

test('P-3b: 宿主复制 exec（非同引用）⇒ 优雅降级 —— 计数仍准、延迟 0；isError 臂判 FAILED', async () => {
  telemetry.reset();
  const { ctx, pre, post } = makeFakeCtx();
  registerTelemetryGuard(ctx as any);

  const origNow = Date.now;
  let clock = 5_000;
  Date.now = () => clock;
  try {
    await pre[0]({ name: 'type_text', arguments: { text: 'hi' } }, async () => undefined);
    clock = 5_120;
    const rawResult = { isError: true, content: [{ type: 'text', text: '[Error]: boom' }] };
    const out = await post[0]({ name: 'type_text', arguments: { text: 'hi' } }, rawResult, async (r: any) => r);
    assert.equal(out, rawResult, '透传不改写');
    const snap = telemetry.snapshot();
    assert.equal(snap.global.calls, 1, '降级只丢延迟精度，不丢计数');
    assert.equal(snap.global.failures, 1, 'isError 臂的错误文本经契约判 FAILED');
    const row = (snap.tools as any[]).find(t => t.tool === 'type_text');
    assert.equal(row.p50_ms, 0, '非同引用降级为 0（既有宽限语义保持）');
  } finally {
    Date.now = origNow;
  }
});

test('P-3c: P-3×P-4 联合 —— PARTIAL_FAILURE 结果经遥测守卫计为失败（熔断不再失明）', async () => {
  telemetry.reset();
  const { ctx, pre, post } = makeFakeCtx();
  registerTelemetryGuard(ctx as any);
  const origNow = Date.now;
  let clock = 1_000;
  Date.now = () => clock;
  try {
    const exec = { name: 'replay_actions', arguments: { confirm: true } };
    await pre[0](exec, async () => undefined);
    clock = 1_040;
    await post[0](exec, { value: JSON.stringify({ status: 'PARTIAL_FAILURE' }) }, async (r: any) => r);
    const snap = telemetry.snapshot();
    assert.equal(snap.global.failures, 1, '登记映射贯穿三消费者（此处为遥测臂）');
    const row = (snap.tools as any[]).find(t => t.tool === 'replay_actions');
    assert.equal(row.p50_ms, 40, '延迟与分类同一次修复后均如实');
  } finally {
    Date.now = origNow;
  }
});

// ─── P-4 resultContract：未登记状态 + 限流拒绝精化 ───

test('P-4: 状态登记 —— PARTIAL_FAILURE 计失败（熔断可见），GRANTED/REVOKED 计成功；字面经 rawStatus 保留', () => {
  const partial = classifyResult(JSON.stringify({ status: 'PARTIAL_FAILURE', execution_log: ['step0 FAILED'] }));
  assert.equal(partial.status, 'FAILED', 'replay_actions / run_skill 的部分失败 → 失败语义');
  assert.ok(isFailure(partial), '进入熔断/失败记忆计数（旧实现判 UNKNOWN 完全失明）');
  assert.equal(partial.rawStatus, 'PARTIAL_FAILURE', '线上字面保留（journal/调试面血缘可追溯）');

  const granted = classifyResult(JSON.stringify({ status: 'GRANTED', state_anchor: { token: 'APR-X' } }));
  assert.equal(granted.status, 'SUCCESS', 'grant_approval 授予回执 → 成功语义');
  assert.ok(isSuccess(granted), '计成功（重置连续失败计数）');
  assert.equal(granted.rawStatus, 'GRANTED');

  const revoked = classifyResult(JSON.stringify({ status: 'REVOKED', state_anchor: { token: 'APR-X' } }));
  assert.equal(revoked.status, 'SUCCESS', '作废回执 → 成功语义（动作本身执行成功）');
  assert.ok(isSuccess(revoked));
  assert.equal(revoked.rawStatus, 'REVOKED');

  // 登记面是白名单不是通配：未登记状态照旧 UNKNOWN
  assert.equal(classifyResult('{"status":"WEIRD"}').status, 'UNKNOWN');
  assert.equal(classifyResult('{"status":"SUCCESS_UNVERIFIED"}').status, 'UNKNOWN',
    'SUCCESS_UNVERIFIED 未在本簇登记面内（保持既有语义）');
});

test('P-4b: grant 限流拒绝 —— 契约层透出真实成因 rateLimited（invalid-or-expired-token 字面失实）', () => {
  resetApproval();
  armOob(); // W6R：授予须带外码（限流语义测试前提：先耗干桶再验证拒绝成因）
  // Y-10 令牌桶：容量 3 —— 三次授予耗尽同意预算（冷静期 10min，测试内不可回填）
  for (let i = 0; i < 3; i++) {
    const d = approval.request(`drain-${i}`);
    assert.equal(grantOob(d.token), true);
  }
  assert.equal(approvalBudget(), 0, '测试前提：桶空');
  const pa = approval.request('click 发送');
  assert.equal(grantOob(pa.token), false, '限流拒绝（令牌留在簿上、未授予、未过期）');

  // approvalTools 的失败字面（写侧归别簇所有，保持原样输入）
  const raw = JSON.stringify({
    status: 'FAILED',
    state_anchor: { token: pa.token, granted: false, reason: 'invalid-or-expired-token' },
  });
  const c = classifyResult(raw);
  assert.equal(c.status, 'FAILED');
  assert.equal(c.reason, 'rateLimited', '真实成因：同意预算耗尽（Y-10 限流），而非无效/过期令牌');
  assert.equal(c.approvalBudgetRemaining, 0, '限流时刻的预算余量随行（透明化锚点）');

  // 对照：伪令牌（从未铸造）—— 字面如实，不精化（在场缺席指纹不匹配）
  const fake = classifyResult(JSON.stringify({
    status: 'FAILED',
    state_anchor: { token: 'APR-NEVER-MINTED', granted: false, reason: 'invalid-or-expired-token' },
  }));
  assert.equal(fake.status, 'FAILED');
  assert.equal(fake.reason, undefined, '无效令牌不误标为限流');
  resetApproval();
});

// ─── P-5 qualityCheckup：唯一裸奔 execute 的结构化兜底 ───

test('P-5: 诊断路径崩溃 ⇒ toolErr 结构化 FAILED（不抛、action 名保留、指引在场）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'perimeter-doctor-'));
  try {
    // 预装配（ensureDoctorConfigured 见 reportPath() 已设即直通 —— 测试不付真扫描）
    await doctor.configure({ sourceRoot: resolve(process.cwd(), 'src'), memoryPath: join(dir, 'mem.json'), strict: false });
    const tool = createQualityCheckupTool({} as unknown as Config);

    const origDiagnose = doctor.diagnose;
    doctor.diagnose = async () => { throw new Error('scan exploded on chained audit'); };
    try {
      // 旧实现：异常裸抛炸穿工具管线（全工具面唯一无兜底的 execute）
      const out = await (tool as Executable).execute({ action: 'diagnose' });
      const o = JSON.parse(out);
      assert.equal(o.status, 'FAILED');
      assert.ok(o.action.includes('diagnose'), 'action 名保留（模型知道哪次出诊炸了）');
      assert.match(o.state_anchor.error, /scan exploded/, '错误事实入锚点（不含堆栈）');
      assert.ok(typeof o.next_step === 'string' && o.next_step.length > 0, '恢复指引在场（换轻动作/收窄审计）');
    } finally {
      delete (doctor as any).diagnose; // 移除实例遮蔽，原型方法还原
      void origDiagnose;
    }

    // 既有语义回归：未知动作的 FAILED 形状不受 try 包裹影响
    const unknown = JSON.parse(await (tool as Executable).execute({ action: 'nope' }));
    assert.equal(unknown.status, 'FAILED');
    assert.match(unknown.reason, /unknown action/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── P-6 dragMouse：拖拽安检（对齐 clickMouse 的闸门形态） ───

const dragCfg = {
  enableApprovalGate: true,
  dangerPatterns: 'send,发送,delete,删除,pay,支付',
  verifyActions: false,
  dryRun: false,
  adaptiveSettle: false,
  actionSettleMs: 1,
  noopSimilarityThreshold: 0.97,
  regionVerifyRadius: 0.15,
} as unknown as Config;

test('P-6: 危险目的地 drag 被拦（无令牌/伪令牌归因分叉），有效令牌放行且随派发消费', async () => {
  const tool = createDragMouseTool(dragCfg);

  // 危险词（删除区）且无令牌 ⇒ ACTION_REQUIRED；闸门前置（连屏幕尺寸都未读）
  const blocked = JSON.parse(await (tool as Executable).execute({
    startX: 0.1, startY: 0.1, endX: 0.5, endY: 0.5,
    target_description: '把 report.doc 拖到删除区',
  }));
  assert.equal(blocked.status, 'ACTION_REQUIRED');
  assert.equal(blocked.state_anchor.reason, 'irreversible-action');
  assert.equal(blocked.state_anchor.danger_signal, 'target_description', '信号通道归因（与 click 闸门同形）');
  assert.equal(drags, 0, '物理拖拽未派发');
  assert.equal(dragSizeCalls, 0, '闸门前置：连屏幕尺寸都未读');

  // 伪令牌 ⇒ 归因令牌未授予（与 click 闸门同律）
  const fakeTok = JSON.parse(await (tool as Executable).execute({
    startX: 0.1, startY: 0.1, endX: 0.5, endY: 0.5,
    target_description: '拖到 删除 zone', approval_token: 'APR-FAKE',
  }));
  assert.equal(fakeTok.state_anchor.reason, 'token-not-granted-or-expired');
  assert.equal(drags, 0);

  // 有效令牌：request → grant → 放行；一次性令牌律（派发即消费）
  armOob(); // W6R：授予须带外码
  const pa = approval.request('drag report.doc onto the delete zone');
  grantOob(pa.token);
  const ok = JSON.parse(await (tool as Executable).execute({
    startX: 0.1, startY: 0.1, endX: 0.5, endY: 0.5,
    target_description: '拖到 删除 zone', approval_token: pa.token,
  }));
  assert.equal(ok.status, 'SUCCESS');
  assert.equal(drags, 1, '持有效令牌放行派发');
  assert.equal(ok.state_anchor.approval_gate.token_consumed_on_dispatch, true, '安检透明化锚点');
  assert.equal(approval.validate(pa.token), false, '一次性令牌律：派发即焚');
});

test('P-6b: 普通 drag 放行（无描述/无害描述/闸门关闭），全角混淆目的地不逃逸，坐标校验回归', async () => {
  const tool = createDragMouseTool(dragCfg);
  // 无描述（可选通道）：滑块/窗口类拖拽照常 —— 不设 click 式 undescribed 硬前置
  const plain = JSON.parse(await (tool as Executable).execute({ startX: 0.2, startY: 0.2, endX: 0.4, endY: 0.4 }));
  assert.equal(plain.status, 'SUCCESS');
  assert.equal(drags, 1, '普通拖拽照常派发');

  const harmless = JSON.parse(await (tool as Executable).execute({
    startX: 0.2, startY: 0.2, endX: 0.4, endY: 0.4, target_description: 'resize the window slider',
  }));
  assert.equal(harmless.status, 'SUCCESS');
  assert.equal(drags, 2);

  // 全角混淆（P-1 修法在拖拽面的执法）：ｄｅｌｅｔｅ 不再逃逸
  const fullwidth = JSON.parse(await (tool as Executable).execute({
    startX: 0.1, startY: 0.1, endX: 0.5, endY: 0.5, target_description: '拖到 ｄｅｌｅｔｅ 区',
  }));
  assert.equal(fullwidth.status, 'ACTION_REQUIRED', '全角危险词命中（旧实现零安检 + 折叠逃逸双盲）');
  assert.equal(drags, 2);

  // 审批闸门关闭 ⇒ 危险语义不拦（危险词语义只属审批域 —— 与 click 同律）
  const off = createDragMouseTool({ ...dragCfg, enableApprovalGate: false } as unknown as Config);
  const through = JSON.parse(await (off as Executable).execute({
    startX: 0.1, startY: 0.1, endX: 0.5, endY: 0.5, target_description: '拖到 删除 zone',
  }));
  assert.equal(through.status, 'SUCCESS');
  assert.equal(drags, 3);

  // 四坐标 bounds 校验回归（既有语义不动）
  const badCoords = await (tool as Executable).execute({ startX: 1.5, startY: 0.2, endX: 0.4, endY: 0.4 });
  assert.match(badCoords, /^\[Error\]: Invalid drag coordinates/);
});
