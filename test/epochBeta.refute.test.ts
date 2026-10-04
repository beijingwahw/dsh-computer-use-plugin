// test/epochBeta.refute.test.ts
// 纪元 Β（反驳法院）执法册 —— 执法编号：
//   Β-1 反驳执法：假第二脑返回 refuted + 理由 ⇒ 危险点击被拦（物理派发计数=0、
//          GUARD_BLOCKED 入链、next_step 人工复核指引、令牌不烧）。
//   Β-2 维持执法：upheld ⇒ 放行 + 锚点注记 refute:'upheld' 在场 + 审案计数。
//   Β-3 缺席审判：无第二脑 / 调用 throw / 超时 ⇒ uncertain 不拦、行为与法院
//          关闭时逐字节一致；非危险动作零法院调用（spy 计数=0）。
//   Β-4 同源剔除：全部庭员与主脑同源（providerId/baseUrl 双因子）⇒ 剔除后
//          无脑 ⇒ uncertain（诚实注记剔除数，零拨号）。
//   Β-5 提示词取证：反驳式提示词含怀疑铁律字样（正则断言）；第二脑请求面
//          （jsonMode / maxRetries=0 / timeoutMs）取证；统计面计数正确。
// 全离线确定性：假 system（物理派发计数器 + 假截屏）、假第二脑
// （attachRefuteFace 注入缝）—— 零真网络、零真截屏、零服务孵化。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Config } from '../src/config.ts';
import { approval, resetApproval, setConfirmCodeChannel, type ConfirmCodeDelivery } from '../src/approval.ts';
import { journal } from '../src/journal.ts';
import { system } from '../src/system.ts';
import { createClickMouseTool } from '../src/tools/clickMouse.ts';
import {
  attachRefuteFace,
  askRefutation,
  refuteCourtInSession,
  refuteStats,
  resetRefuteStats,
  buildRefutationSystemPrompt,
  buildRefutationUserPrompt,
  isSameRefuteSource,
  _overrideRefuteTimeoutForTest,
  type RefuteBrain,
} from '../src/vlm/refute.ts';

// ─── 假件工坊：物理派发计数器 + 假截屏 + 假第二脑 ───

const originalSystem = {
  clickMouse: system.clickMouse.bind(system),
  getScreenSize: system.getScreenSize.bind(system),
  captureScreen: system.captureScreen.bind(system),
};
let clicks = 0;

beforeEach(() => {
  resetApproval();
  journal.reset();
  clicks = 0;
  system.clickMouse = async () => { clicks++; };
  system.getScreenSize = async () => ({ width: 1920, height: 1080 });
  system.captureScreen = async () => Buffer.from('beta-court-evidence-frame');
  attachRefuteFace(null);
  _overrideRefuteTimeoutForTest(null);
  resetRefuteStats();
});

afterEach(() => {
  system.clickMouse = originalSystem.clickMouse;
  system.getScreenSize = originalSystem.getScreenSize;
  system.captureScreen = originalSystem.captureScreen;
  attachRefuteFace(null);
  _overrideRefuteTimeoutForTest(null);
});

/** 假第二脑的可控脚本 */
interface BrainScript {
  verdict?: { verdict: 'refuted' | 'upheld' | 'uncertain'; confidence?: number; reason?: string };
  /** chatJson 违约上抛 */
  throwMsg?: string;
  /** chatJson 返回 ok:false + error */
  okFalse?: string;
  /** 永不归来 —— 硬止损竞速的挂死面 */
  hang?: boolean;
  configured?: boolean;
  baseUrl?: string;
}

/** 铸假第二脑：脚本驱动 + 调用计数 + 末次请求取证（Β-5 消费） */
function fakeBrain(id: string, script: BrainScript = {}): RefuteBrain & { calls: number; lastReq: unknown } {
  let calls = 0;
  let lastReq: unknown = null;
  const brain: RefuteBrain & { calls: number; lastReq: unknown } = {
    id,
    ...(script.baseUrl !== undefined ? { baseUrl: script.baseUrl } : {}),
    configured: script.configured ?? true,
    get calls() { return calls; },
    get lastReq() { return lastReq; },
    async chatJson(req: Parameters<RefuteBrain['chatJson']>[0]) {
      calls++;
      lastReq = req;
      if (script.hang) await new Promise<void>(() => { /* 挂死：永不 resolve */ });
      if (script.throwMsg !== undefined) throw new Error(script.throwMsg);
      if (script.okFalse !== undefined) return { ok: false, error: script.okFalse, raw: '' };
      const v = script.verdict ?? { verdict: 'upheld' as const, confidence: 0.9, reason: '看起来一致' };
      return { ok: true, value: v, raw: JSON.stringify(v) };
    },
  };
  return brain;
}

/** 装配反驳面（主脑缺省 glm） */
function attachFace(brains: RefuteBrain[], primaryId = 'glm'): void {
  attachRefuteFace({ primaryId, brains });
}

// ─── 事件循环保活（DEBTS D-G1 悬挂收口债）───
// 挂死脑用例的在途等待，其结算依赖产品硬止损竞速的 unref 定时器
// （src/vlm/refute.ts withHardCap —— unref 是有意设计：不阻生产宿主进程退出；
// 宿主进程恒有 stdio/服务器句柄在场，unref 定时器照常触发）。但裸 node:test
// 子进程里无其他 ref'd 句柄 ⇒ 事件循环先行排干 ⇒ 根测试收割在途用例
// （cancelledByParent："Promise resolution is still pending but the event
//  loop has already resolved"），其后排队用例连带未跑。测试侧对策：等待期间
// 持一枚 ref'd 保活定时器、finally 收口 —— 若产品真挂死，保活到期后循环照常
// 排干、收割照常发生（防御不失守，只是给诚实的硬止损超时留出活窗）。
/** 持一枚 ref'd 保活定时器；返回收口函数（clearTimeout —— 调用方必须在 finally 里执行） */
function keepEventLoopAlive(ms: number): () => void {
  const t = setTimeout(() => { /* 保活哨：正常路径等不到这里触发 */ }, ms);
  return () => clearTimeout(t);
}

/** 工具级配置：验证/探针/公证全关（聚焦法院执法），反驳法院开。
 *  W6R：verifyActions=false 已不再单独构成危险令牌旁路 —— 本册聚焦法院执法，
 *  显式插入逃生门（两把钥匙齐备）保持「派发即消费」旧方言。 */
const toolCfg = {
  enableApprovalGate: true,
  dangerPatterns: 'send,发送,delete,删除,pay,支付',
  enableRiskGate: false,
  riskPatterns: '',
  maxTextLength: 1000,
  focusMaxAgeMs: 60_000,
  enableNotarizationLock: false,
  notarySemanticHandshake: true,
  enableRefuteCourt: true,
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
  enableJournal: true,
} as unknown as Config;

type Executable = { execute: (a: unknown) => Promise<string> };

async function runJson(tool: unknown, args: unknown): Promise<any> {
  const out = await (tool as Executable).execute(args);
  return JSON.parse(out);
}

/** 铸一枚已授予的令牌（危险点击的通行证）。
 *  W6R fail-closed：授予须带外码 —— 内联武装采集 sink（人类读码的视角）。 */
function grantedToken(desc = '点击发送按钮提交表单'): string {
  const sink: ConfirmCodeDelivery[] = [];
  setConfirmCodeChannel(d => { sink.push({ ...d }); });
  const pa = approval.request(desc);
  assert.equal(approval.grantDetailed(pa.token, true, { confirmCode: sink[0]?.confirmCode }).ok, true, '令牌授予成功');
  return pa.token;
}

// ─── Β-1 反驳执法 ───

test('Β-1: 第二脑 refuted + 理由 ⇒ 危险点击被拦（零派发 + GUARD 入链 + 人工复核 + 令牌不烧）', async () => {
  const brain = fakeBrain('openai', {
    verdict: { verdict: 'refuted', confidence: 0.82, reason: '该位置实际显示的是广告横幅，与「发送按钮」不符' },
  });
  attachFace([brain]);
  const tool = createClickMouseTool(toolCfg);
  const token = grantedToken();
  const out = await runJson(tool, { x: 0.5, y: 0.5, target_description: '发送按钮', approval_token: token });
  assert.equal(out.status, 'FAILED', 'refuted ⇒ 拦截');
  assert.match(out.state_anchor.error, /refute-court/, 'guard 归因在错误面');
  assert.match(out.state_anchor.error, /CONTRADICTING/i, '反驳证据进错误面');
  assert.match(out.state_anchor.error, /广告横幅/, '第二脑理由随行');
  assert.match(out.next_step, /manually verify/i, 'next_step 指引人工复核该目标');
  assert.match(out.next_step, /do NOT retry/i);
  assert.equal(clicks, 0, '物理派发计数 = 0');
  assert.equal(brain.calls, 1, '第二脑恰被问一次（单脑单次不重试）');
  // 审计留痕：GUARD_BLOCKED（refute-court）入防篡改链（notary-lock 同方言）
  assert.ok(
    journal.list(false).some(e => e.tool === 'GUARD_BLOCKED' && e.args?.guard === 'refute-court'),
    '反驳拦截以 GUARD 方言入链',
  );
  // 拦截发生在 beginAttempt 之前：令牌不烧，人工复核后可原令牌重试
  assert.equal(approval.validate(token), true, '令牌未被消费');
  assert.equal(refuteStats().refuted, 1, '年报表记 refuted 一票');
});

// ─── Β-2 维持执法 ───

test('Β-2: upheld ⇒ 放行派发 + 锚点注记 refute:"upheld" + 审案计数', async () => {
  const brain = fakeBrain('anthropic', {
    verdict: { verdict: 'upheld', confidence: 0.93, reason: '目标确为「发送」按钮' },
  });
  attachFace([brain]);
  const tool = createClickMouseTool(toolCfg);
  const token = grantedToken();
  const before = refuteStats();
  const out = await runJson(tool, { x: 0.5, y: 0.5, target_description: '发送按钮', approval_token: token });
  assert.equal(out.status, 'SUCCESS', '维持 ⇒ 放行');
  assert.equal(clicks, 1, '物理派发恰一次');
  assert.equal(out.state_anchor.refute, 'upheld', '锚点注记在场');
  assert.equal(brain.calls, 1);
  const after = refuteStats();
  assert.equal(after.cases, before.cases + 1, '审案 +1');
  assert.equal(after.upheld, before.upheld + 1, 'upheld 计票');
  // 验收闭环不受法院影响（验证关闭 ⇒ 派发即消费）
  assert.equal(out.state_anchor.acceptance.verdict, 'unverified-dispatch-consumed');
  assert.equal(approval.validate(token), false, '令牌照常按旧律消费');
});

// ─── Β-3 缺席审判（零回归红律；三段分立 —— 审批同意桶容量 3/10min，段间 beforeEach 重置）───

test('Β-3a: 无第二脑 ⇒ 窄门不开零调用；非危险动作零法院调用', async () => {
  const tool = createClickMouseTool(toolCfg);
  // (a) 无第二脑：refuteCourtInSession=false —— 连 askRefutation 都不叫
  attachRefuteFace(null);
  assert.equal(refuteCourtInSession(), false);
  const statsA = refuteStats();
  const a = await runJson(tool, { x: 0.5, y: 0.5, target_description: '发送按钮', approval_token: grantedToken() });
  assert.equal(a.status, 'SUCCESS', '缺席不拦');
  assert.equal(clicks, 1);
  assert.equal(a.state_anchor.refute, undefined, '缺席 ⇒ 锚点键不入场');
  assert.deepEqual(refuteStats(), statsA, '零法院调用（年报表纹丝不动）');

  // (d) 非危险动作零法院调用（性能铁律：法院只审不可逆）
  const spy = fakeBrain('openai', { verdict: { verdict: 'refuted', confidence: 0.99, reason: '不应被问' } });
  attachFace([spy]);
  const d = await runJson(tool, { x: 0.5, y: 0.5, target_description: 'File menu' });
  assert.equal(d.status, 'SUCCESS');
  assert.equal(spy.calls, 0, '非危险点击零法院调用');
  assert.equal(d.state_anchor.refute, undefined);
  assert.deepEqual(refuteStats(), statsA, '年报表仍纹丝不动');
  assert.equal(clicks, 2, 'a + d = 2 次放行');
});

test('Β-3b: 第二脑 throw ⇒ uncertain 不拦、行为与法院关闭时逐字节一致', async () => {
  const tool = createClickMouseTool(toolCfg);
  const offTool = createClickMouseTool({ ...toolCfg, enableRefuteCourt: false });
  const statsB = refuteStats();
  const throwing = fakeBrain('openai', { throwMsg: 'second brain exploded' });
  attachFace([throwing]);
  const bOn = await runJson(tool, { x: 0.4, y: 0.4, target_description: '发送按钮', approval_token: grantedToken() });
  const bOff = await runJson(offTool, { x: 0.4, y: 0.4, target_description: '发送按钮', approval_token: grantedToken() });
  assert.equal(bOn.status, 'SUCCESS', 'throw ⇒ 缺席审判不拦');
  assert.equal(JSON.stringify(bOn), JSON.stringify(bOff), 'uncertain 行为与关闭时逐字节一致');
  assert.equal(bOn.state_anchor.refute, undefined);
  assert.equal(refuteStats().uncertain, statsB.uncertain + 1, 'throw 收敛 uncertain 记账');
  assert.equal(throwing.calls, 1);
  assert.equal(clicks, 2);
});

test('Β-3c: 超时（挂死脑 + 硬止损）⇒ uncertain 不拦、诚实归因', async () => {
  const tool = createClickMouseTool(toolCfg);
  const statsC = refuteStats();
  // 测试缝 60ms 硬止损（生产法定 8s 单次不重试）
  _overrideRefuteTimeoutForTest(60);
  const hanging = fakeBrain('gemini', { hang: true });
  attachFace([hanging]);
  // 收口债 D-G1：挂死脑下唯一在途宏任务是产品硬止损的 unref 定时器（工具级 +
  // 直调两段各 60+500ms ≈ 1.2s）—— 持保活定时器防裸测试进程事件循环先行排干
  // （保活宽放 2s；finally 收口，断言失败也不残留句柄）。
  const releaseLoop = keepEventLoopAlive(2_000);
  try {
    const c = await runJson(tool, { x: 0.6, y: 0.6, target_description: '发送按钮', approval_token: grantedToken() });
    assert.equal(c.status, 'SUCCESS', '超时 ⇒ 缺席审判不拦');
    assert.equal(c.state_anchor.refute, undefined);
    assert.equal(refuteStats().uncertain, statsC.uncertain + 1, '超时收敛 uncertain 记账');
    assert.equal(clicks, 1);
    // 直调取证：超时归因注记
    const tv = await askRefutation({ imageBase64: 'QUJD', description: '发送按钮' });
    assert.equal(tv.verdict, 'uncertain');
    assert.match(tv.note ?? '', /timeout/, '诚实归因到超时');
    _overrideRefuteTimeoutForTest(null);
    const s = refuteStats();
    assert.equal(s.cases, statsC.cases + 2, '工具级一案 + 直调一案');
  } finally {
    releaseLoop();
  }
});

// ─── Β-4 同源剔除（诚实）───

test('Β-4: 全部庭员与主脑同源 ⇒ 剔除后无脑 ⇒ uncertain（诚实注记，零拨号）', async () => {
  const glmA = fakeBrain('glm');
  const glmB = fakeBrain('GLM'); // 大小写方言同源
  const sameUrl = fakeBrain('other-vendor', { baseUrl: 'https://open.bigmodel.cn/api/paas/v4/' }); // 基址同源（尾斜杠归一）
  attachRefuteFace({
    primaryId: 'glm',
    primaryBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    brains: [glmA, glmB, sameUrl],
  });
  assert.equal(refuteCourtInSession(), false, '剔除后无脑 ⇒ 窄门不开');
  const v = await askRefutation({ imageBase64: 'QUJD', description: '发送按钮' });
  assert.equal(v.verdict, 'uncertain', '无脑 ⇒ 缺席审判');
  assert.equal(v.confidence, 0);
  assert.equal(v.excludedSameSource, 3, '诚实注记剔除数');
  assert.match(v.note ?? '', /no-heterogeneous-second-brain/);
  assert.equal(glmA.calls + glmB.calls + sameUrl.calls, 0, '同源脑零拨号（不烧主脑配额）');

  // 混合名册：主脑同源被剔、首颗异构脑作证
  const primaryTwin = fakeBrain('glm', { verdict: { verdict: 'refuted', confidence: 1, reason: '主脑不该作证' } });
  const hetero = fakeBrain('openai', { verdict: { verdict: 'upheld', confidence: 0.88, reason: '异构维持' } });
  attachFace([primaryTwin, hetero]);
  assert.equal(refuteCourtInSession(), true);
  const v2 = await askRefutation({ imageBase64: 'QUJD', description: '发送按钮' });
  assert.equal(v2.verdict, 'upheld');
  assert.equal(v2.secondOpinionId, 'openai', '异构脑作证');
  assert.equal(v2.excludedSameSource, 1, '剔除主脑一枚');
  assert.equal(primaryTwin.calls, 0, '主脑同源零拨号');
  assert.equal(hetero.calls, 1);

  // 纯函数面：providerId / baseUrl 双因子
  assert.equal(isSameRefuteSource({ id: 'glm' }, { id: 'glm' }), true);
  assert.equal(isSameRefuteSource({ id: 'glm' }, { id: 'openai' }), false);
  assert.equal(isSameRefuteSource({ id: 'a', baseUrl: 'https://x/api/' }, { id: 'b', baseUrl: 'https://X/api' }), true, '基址归一同源');
  assert.equal(isSameRefuteSource({ id: 'a' }, { id: 'b' }), false, '身份因子缺席 ⇒ 不误剔');
});

// ─── Β-5 提示词取证 + 统计面 ───

test('Β-5: 反驳式提示词含怀疑铁律字样；请求面取证；统计面计数正确', async () => {
  // 系统词铁律（风格随 som.ts：不臆造）
  const sys = buildRefutationSystemPrompt();
  assert.match(sys, /怀疑/, '默认怀疑态度');
  assert.match(sys, /找出反驳证据/, '找反驳而非确认');
  assert.match(sys, /宁可输出 uncertain 也不附和/, '宁 uncertain 不附和');
  assert.match(sys, /不要臆造/, '不臆造铁律');
  // 用户词：请反驳句式 + 区域聚焦注记
  const usr = buildRefutationUserPrompt('发送按钮');
  assert.match(usr, /请反驳/, '反驳式指令');
  assert.match(usr, /真的是「发送按钮」/, '被审陈述呈堂');
  assert.doesNotMatch(usr, /归一化区域/, '无区域不注记');
  const usrRegion = buildRefutationUserPrompt('发送按钮', { x: 0.4, y: 0.3, width: 0.2, height: 0.1 });
  assert.match(usrRegion, /归一化区域/);
  assert.match(usrRegion, /0\.400/);

  // 请求面取证：第二脑收到的 system/prompt 铁律 + 单次不重试 + 超时透传
  const brain = fakeBrain('openai', { verdict: { verdict: 'upheld', confidence: 0.7, reason: 'ok' } });
  attachFace([brain]);
  await askRefutation({ imageBase64: 'QUJD', description: '发送按钮', timeoutMs: 1234 });
  const req = brain.lastReq as {
    images: Array<{ base64: string; mime?: string }>; system: string; prompt: string;
    jsonMode: boolean; maxRetries: number; timeoutMs: number;
  };
  assert.ok(req, '第二脑被实际问询');
  assert.equal(req.jsonMode, true, '结构化输出');
  assert.equal(req.maxRetries, 0, '单次不重试');
  assert.equal(req.timeoutMs, 1234, '超时透传');
  assert.equal(req.images[0]!.base64, 'QUJD', '截图证据随行');
  assert.equal(req.images[0]!.mime, 'image/jpeg');
  assert.match(req.system, /怀疑/);
  assert.match(req.prompt, /请反驳/);

  // 统计面（法院年报表）：refuted/upheld/uncertain 各记各账，审案数守恒
  resetRefuteStats();
  attachFace([fakeBrain('a', { verdict: { verdict: 'refuted', confidence: 0.8, reason: 'r' } })]);
  await askRefutation({ imageBase64: 'QUJD', description: '发送' });
  attachFace([fakeBrain('b', { verdict: { verdict: 'upheld', confidence: 0.8, reason: 'r' } })]);
  await askRefutation({ imageBase64: 'QUJD', description: '发送' });
  attachFace([fakeBrain('c', { okFalse: 'remote down' })]);
  await askRefutation({ imageBase64: 'QUJD', description: '发送' });
  attachFace([fakeBrain('d', { verdict: { verdict: 'uncertain', confidence: 0.5, reason: '不敢断言' } })]);
  await askRefutation({ imageBase64: 'QUJD', description: '发送' });
  attachRefuteFace(null);
  await askRefutation({ imageBase64: 'QUJD', description: '发送' });
  const s = refuteStats();
  assert.equal(s.cases, 5, '审案数守恒');
  assert.equal(s.refuted, 1);
  assert.equal(s.upheld, 1);
  assert.equal(s.uncertain, 3, 'ok:false / uncertain 载荷 / 无面 —— 三种缺席形态');
});

// ─── ΑΩ-R35 有限顺延：首席失败 ⇒ 剩余预算内最多再请 1 颗备选脑 ───

test('ΑΩ-R35: 有限顺延 —— 首席失败/垃圾载荷后次席救场；双败仍缺席审判', async () => {
  // (a) 首席 ok:false ⇒ 顺延次席，次席 upheld 归因
  const fail1 = fakeBrain('openai', { okFalse: 'remote down' });
  const hero = fakeBrain('anthropic', { verdict: { verdict: 'upheld', confidence: 0.9, reason: '次席维持' } });
  attachFace([fail1, hero]);
  const a = await askRefutation({ imageBase64: 'QUJD', description: '发送按钮' });
  assert.equal(a.verdict, 'upheld', '首席失败 ⇒ 次席救场');
  assert.equal(a.secondOpinionId, 'anthropic', '归因到实际作证的次席');
  assert.equal(fail1.calls, 1);
  assert.equal(hero.calls, 1);
  assert.equal(refuteStats().upheld >= 1, true);

  // (b) 首席垃圾载荷（ok:true 但 verdict 非法）⇒ 同样顺延
  const garbage = fakeBrain('gemini', {
    verdict: { verdict: 'banana', confidence: 0.9 } as never,
  });
  const hero2 = fakeBrain('qwen', { verdict: { verdict: 'refuted', confidence: 0.7, reason: '次席反驳成立' } });
  attachFace([garbage, hero2]);
  const b = await askRefutation({ imageBase64: 'QUJD', description: '发送按钮' });
  assert.equal(b.verdict, 'refuted', '垃圾载荷也触发顺延');
  assert.equal(b.secondOpinionId, 'qwen');
  assert.equal(garbage.calls, 1);
  assert.equal(hero2.calls, 1);

  // (c) 双败 ⇒ 缺席审判（顺延只到次席，不无限续命）
  const failA = fakeBrain('a', { okFalse: 'err-a' });
  const failB = fakeBrain('b', { okFalse: 'err-b' });
  const unused = fakeBrain('c', { verdict: { verdict: 'upheld', confidence: 1 } });
  attachFace([failA, failB, unused]);
  const c = await askRefutation({ imageBase64: 'QUJD', description: '发送按钮' });
  assert.equal(c.verdict, 'uncertain');
  assert.match(c.note ?? '', /second-opinion-failed: err-b/, '末次失败归因（次席）');
  assert.equal(failA.calls, 1);
  assert.equal(failB.calls, 1);
  assert.equal(unused.calls, 0, '至多顺延 1 颗 —— 第三席不请');
});

test('ΑΩ-R35: 顺延预算纪律 —— 首席超时耗尽 8s 硬帽 ⇒ 不顺延，维持缺席审判', async () => {
  // 测试缝 60ms 硬止损（生产法定 8s）：挂死首席把预算烧光，次席零拨号
  _overrideRefuteTimeoutForTest(60);
  const hanging = fakeBrain('gemini', { hang: true });
  const healthy = fakeBrain('openai', { verdict: { verdict: 'upheld', confidence: 0.9, reason: '不该被问' } });
  attachFace([hanging, healthy]);
  // D-G1 收口债同 Β-3c：挂死脑在途等待依赖 unref 硬止损定时器，持保活定时器
  const releaseLoop = keepEventLoopAlive(2_000);
  try {
    const v = await askRefutation({ imageBase64: 'QUJD', description: '发送按钮' });
    assert.equal(v.verdict, 'uncertain', '超时 ⇒ 缺席审判');
    assert.match(v.note ?? '', /timeout/, '诚实归因到超时');
    assert.equal(healthy.calls, 0, '预算已耗尽 ⇒ 次席零拨号（总硬帽语义不动）');
    assert.equal(hanging.calls, 1);
  } finally {
    releaseLoop();
  }
});

// ═══ ΝΩ-32：帧票据（frame ticket）—— 截图帧贯穿管线执法册 ═══
// 病灶：一次 dangerous+token 的 click_mouse 派发前独立截屏最多 4 次
//（notary OCR 自截 / 反驳证据 / 记忆预验 / captureBefore 基线）+ after 帧 = 5 次
// 服务端往返。立法后全链 = notary(1，诚实边界自截) + 票据(1) + after(1) ≤ 3。
// 全离线确定性：假铸票面（frameTicketing 注入缝，notaryEvidence 同律）+
// 假验收面（mouseVerify 注入缝，clickElement.elementVerify 同律）+ 假第二脑。

test('ΝΩ-32a: 危险点击全链捕获数 5→≤3 —— 票据贯穿（反驳证据/记忆预验/captureBefore 复用；after 帧恰一次新截）', async () => {
  const { default: sharp } = await import('sharp');
  const { regionDhash } = await import('../src/perceptualHash.ts');
  const { uiMemory } = await import('../src/uiMemory.ts');
  const { frameTicketing, mouseVerify, notaryEvidence, createClickMouseTool: mkClick } =
    await import('../src/tools/clickMouse.ts');
  type Executable = { execute: (a: unknown) => Promise<string> };

  // 真像素票帧（regionDhash 要真解码）+ 预验地标（指纹 = 票帧同区域指纹 ⇒ 必匹配）
  const ticketBuf = await sharp(Buffer.alloc(400 * 300 * 3, 128), {
    raw: { width: 400, height: 300, channels: 3 },
  }).png().toBuffer();
  const regionHash = await regionDhash(ticketBuf, 0.5, 0.5, 0.15);
  uiMemory.reset();
  const lm = uiMemory.remember('发送按钮', 0.5, 0.5, undefined, undefined, regionHash);

  // 计数假件：铸票 / 自截 / 验收面 / 公证 OCR
  let mints = 0, selfCaptures = 0, beforeCalls = 0, settleCalls = 0, notaryReads = 0;
  const savedFace = { mintable: frameTicketing.mintable, mint: frameTicketing.mint };
  const savedVerify = { captureBefore: mouseVerify.captureBefore, settleAndVerify: mouseVerify.settleAndVerify };
  const savedCapture = system.captureScreen;
  const savedNotary = notaryEvidence.readOcrLabel;
  frameTicketing.mintable = () => true;
  frameTicketing.mint = async () => {
    mints++;
    return {
      buffer: ticketBuf, dhash: 'ab'.repeat(8), phash: null, regionDhash: null, frameId: null,
      capturedAt: Date.now(), width: 400, height: 300, keptFrame: false,
    };
  };
  system.captureScreen = async () => { selfCaptures++; return ticketBuf; };
  notaryEvidence.readOcrLabel = async () => { notaryReads++; return '发送'; };
  mouseVerify.captureBefore = async (): Promise<{ screen: string; region: null; focus: null }> => {
    beforeCalls++;
    return { screen: 'zz', region: null, focus: null };
  };
  mouseVerify.settleAndVerify = async () => {
    settleCalls++;
    return {
      detected: true,
      screen: { effect_detected: true, similarity_pct: 50, distance: 32 },
      region: null, scale: 'page-level',
      afterBuffer: Buffer.alloc(0), afterHash: '', oscillation: null,
    };
  };

  const brain = fakeBrain('openai', { verdict: { verdict: 'upheld', confidence: 0.9, reason: '目标确为「发送」' } });
  attachFace([brain]);
  // 全开危险链：公证锁 + 反驳法院 + 记忆预验 + 效果验证（探针关 —— 污染用例见 ΝΩ-32c）
  const tool = mkClick({
    ...toolCfg,
    enableNotarizationLock: true,
    enableOcr: true,
    verifyActions: true,
  } as unknown as Config);
  const token = grantedToken();
  try {
    const out = await JSON.parse(String(await (tool as unknown as Executable).execute({
      x: 0.5, y: 0.5, target_description: '发送按钮', approval_token: token, from_memory_id: lm.id,
    })));
    assert.equal(out.status, 'SUCCESS', '全链放行');
    assert.equal(clicks, 1, '物理点击恰一次');
    assert.equal(out.state_anchor.refute, 'upheld', '法院维持注记在场');
    assert.ok(out.pre_verified, '记忆预验经票帧通过（顶层 pre_verified 键）');
    assert.equal(out.state_anchor.acceptance.verdict, 'verified');
    // ── 捕获计数执法（核心账）──
    assert.equal(mints, 1, '单链恰铸一票（反驳法院 = 最早铸票口）');
    assert.equal(selfCaptures, 0, '反驳证据/记忆预验零自截（票帧覆盖）');
    assert.equal(beforeCalls, 0, 'captureBefore 复用票据（零额外服务端往返）');
    assert.equal(settleCalls, 1, 'after 帧恰一次验收取证（新截 —— 绝不复用票据）');
    assert.equal(notaryReads, 1, 'notary OCR 按诚实边界自截一次（readTextAny 不吃外部帧）');
    assert.equal(mints + selfCaptures + beforeCalls + settleCalls + notaryReads, 3,
      '全链截屏总数 = 票据(1) + after(1) + notary(1) = 3 ≤ 3（旧链 5 次）');
  } finally {
    Object.assign(frameTicketing, savedFace);
    Object.assign(mouseVerify, savedVerify);
    system.captureScreen = savedCapture;
    notaryEvidence.readOcrLabel = savedNotary;
    uiMemory.reset();
  }
});

test('ΝΩ-32b: 票据过期（capturedAt 距使用点 > 2s）⇒ 各阶段自截回退（零回归兜底；单链不重铸）', async () => {
  const { default: sharp } = await import('sharp');
  const { regionDhash } = await import('../src/perceptualHash.ts');
  const { uiMemory } = await import('../src/uiMemory.ts');
  const { frameTicketing, mouseVerify, notaryEvidence, createClickMouseTool: mkClick } =
    await import('../src/tools/clickMouse.ts');
  type Executable = { execute: (a: unknown) => Promise<string> };

  const ticketBuf = await sharp(Buffer.alloc(400 * 300 * 3, 128), {
    raw: { width: 400, height: 300, channels: 3 },
  }).png().toBuffer();
  const regionHash = await regionDhash(ticketBuf, 0.5, 0.5, 0.15);
  uiMemory.reset();
  const lm = uiMemory.remember('发送按钮', 0.5, 0.5, undefined, undefined, regionHash);

  let mints = 0, selfCaptures = 0, beforeCalls = 0, settleCalls = 0;
  const savedFace = { mintable: frameTicketing.mintable, mint: frameTicketing.mint };
  const savedVerify = { captureBefore: mouseVerify.captureBefore, settleAndVerify: mouseVerify.settleAndVerify };
  const savedCapture = system.captureScreen;
  frameTicketing.mintable = () => true;
  // 过期票：capturedAt 落在新鲜度阈值（2s）之外 —— 铸出即不可复用
  frameTicketing.mint = async () => {
    mints++;
    return {
      buffer: ticketBuf, dhash: 'ab'.repeat(8), phash: null, regionDhash: null, frameId: null,
      capturedAt: Date.now() - 10_000, width: 400, height: 300, keptFrame: false,
    };
  };
  system.captureScreen = async () => { selfCaptures++; return ticketBuf; };
  mouseVerify.captureBefore = async (): Promise<{ screen: string; region: null; focus: null }> => {
    beforeCalls++;
    return { screen: 'zz', region: null, focus: null };
  };
  mouseVerify.settleAndVerify = async () => {
    settleCalls++;
    return {
      detected: true,
      screen: { effect_detected: true, similarity_pct: 50, distance: 32 },
      region: null, scale: 'page-level',
      afterBuffer: Buffer.alloc(0), afterHash: '', oscillation: null,
    };
  };

  attachFace([fakeBrain('openai')]);
  const tool = mkClick({
    ...toolCfg,
    enableNotarizationLock: false, // 本册聚焦票据新鲜度：公证关（notary 零截屏）
    verifyActions: true,
  } as unknown as Config);
  const token = grantedToken();
  try {
    const out = await JSON.parse(String(await (tool as unknown as Executable).execute({
      x: 0.5, y: 0.5, target_description: '发送按钮', approval_token: token, from_memory_id: lm.id,
    })));
    assert.equal(out.status, 'SUCCESS', '过期票不阻塞 —— 回退自截后全链照常');
    assert.equal(clicks, 1);
    // 过期执法：铸票尝试恰一次（不重铸）；反驳证据/记忆预验各自回退自截；
    // captureBefore 不吃过期票（基线必须新鲜）
    assert.equal(mints, 1, '单链至多铸一票（铸败/过期不重试）');
    assert.equal(selfCaptures, 2, '反驳证据 + 记忆预验各回退一次自截（旧行为）');
    assert.equal(beforeCalls, 1, '过期票不得充当 before 基线 ⇒ captureBefore 自截');
    assert.equal(settleCalls, 1, 'after 帧照常恰一次');
  } finally {
    Object.assign(frameTicketing, savedFace);
    Object.assign(mouseVerify, savedVerify);
    system.captureScreen = savedCapture;
    uiMemory.reset();
  }
});

test('ΝΩ-32c: 交互性探针悬停 = 票据污染源 ⇒ captureBefore 回退自截（hover 高亮不得入「无变化」基线）', async () => {
  const backend = await import('../src/physicalBackend.ts');
  const { frameTicketing, mouseVerify, createClickMouseTool: mkClick } =
    await import('../src/tools/clickMouse.ts');
  type Executable = { execute: (a: unknown) => Promise<string> };

  let mints = 0, beforeCalls = 0, settleCalls = 0;
  const savedFace = { mintable: frameTicketing.mintable, mint: frameTicketing.mint };
  const savedVerify = { captureBefore: mouseVerify.captureBefore, settleAndVerify: mouseVerify.settleAndVerify };
  const staleBuf = Buffer.from('probe-pollution-frame'); // 污染用例不消费票帧字节（无预验）
  frameTicketing.mintable = () => true;
  frameTicketing.mint = async () => {
    mints++;
    return {
      buffer: staleBuf, dhash: 'ab'.repeat(8), phash: null, regionDhash: null, frameId: null,
      capturedAt: Date.now(), width: 400, height: 300, keptFrame: false,
    };
  };
  mouseVerify.captureBefore = async (): Promise<{ screen: string; region: null; focus: null }> => {
    beforeCalls++;
    return { screen: 'zz', region: null, focus: null };
  };
  mouseVerify.settleAndVerify = async () => {
    settleCalls++;
    return {
      detected: true,
      screen: { effect_detected: true, similarity_pct: 50, distance: 32 },
      region: null, scale: 'page-level',
      afterBuffer: Buffer.alloc(0), afterHash: '', oscillation: null,
    };
  };

  // 探针的 UIA 判决通道：假 adapter（classification=control ⇒ 判决性「控件」，
  // 不触发悬停二遍 —— 悬停污染标记不依赖实验是否真的移动了鼠标：探针阶段
  // 一经运行，票帧的「世界未被本链触碰」前提即失效）
  backend._setAdapterForTests({
    hitTest: async () => ({
      ok: true as const,
      value: { available: true, control_type: 'Button', name: '发送', classification: 'control', matched_depth: 1 },
    }),
  } as never);
  attachFace([fakeBrain('openai')]);
  const tool = mkClick({
    ...toolCfg,
    enableNotarizationLock: false,
    verifyActions: true,
    enableInteractivityProbe: true,
    enableProbeMemory: false,
  } as unknown as Config);
  const token = grantedToken();
  try {
    const out = await JSON.parse(String(await (tool as unknown as Executable).execute({
      x: 0.5, y: 0.5, target_description: '发送按钮', approval_token: token, allow_text_click: true,
    })));
    assert.equal(out.status, 'SUCCESS');
    assert.equal(clicks, 1);
    assert.equal(mints, 1, '反驳法院照常铸票（探针之前 —— 票据对反驳证据仍然有效）');
    assert.equal(beforeCalls, 1, '探针污染 ⇒ captureBefore 回退自截（不票帧复用）');
    assert.equal(settleCalls, 1);
  } finally {
    backend._setAdapterForTests(null);
    Object.assign(frameTicketing, savedFace);
    Object.assign(mouseVerify, savedVerify);
  }
});

test('ΝΩ-32d: after 帧绝不复用票据 —— 立法在册（源码契约断言，P2b-1c 先例）', () => {
  const src = readFileSync(new URL('../src/tools/clickMouse.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('after 帧必须新截'), 'settleAndVerify 不接票据的立法注释在场（ ΝΩ-32 绝对边界）');
  assert.ok(src.includes('票据只在派发前阶段共享'), '票据共享边界立法在场');
  assert.ok(src.includes('待服务端补该 API 后此处可改吃票据'), 'notary 诚实边界登记在场（不虚报覆盖面）');
});

// ═══ ΝΩ-47：合议庭点亮（多脑多数票）+ 反驳置信带 ═══
// 多脑路径：真 EnsembleCourt + 假陪审脑（VisionProvider 方言投票）—— 多数票
// 数学走真 askVerdict；置信带：verdict+confidence 双阈值两臂执法。

/** 假陪审脑：入真 EnsembleCourt 作证（chatJson 投裁决票；调用计数） */
function juror(id: string, vote: { verdict: 'confirmed' | 'refuted'; confidence: number }) {
  let calls = 0;
  const model = `m-${id}`;
  return {
    id,
    protocol: 'openai' as const,
    model,
    configured: true,
    get calls() { return calls; },
    async chat() {
      calls++;
      return { ok: true, text: '', latencyMs: 1, model, providerId: id };
    },
    async chatJson<T>(): Promise<{ ok: boolean; value?: T; error?: string; raw: string }> {
      calls++;
      return { ok: true, value: vote as T, raw: JSON.stringify(vote) };
    },
  };
}

test('ΝΩ-47a: 多脑裁决路径 —— 真合议庭多数票替代单脑（单脑零拨号）+ census 透传 + 方言映射', async () => {
  const { EnsembleCourt } = await import('../src/vlm/providers/ensemble.ts');
  // 2:1 refuted 多数：conf = mean(0.9,0.7)×2/3 = 0.8×2/3 ≈ 0.533 ≥ 0.5 带内
  const jury = new EnsembleCourt([
    juror('openai', { verdict: 'refuted', confidence: 0.9 }),
    juror('anthropic', { verdict: 'refuted', confidence: 0.7 }),
    juror('gemini', { verdict: 'confirmed', confidence: 0.9 }),
  ]);
  const single = fakeBrain('qwen', { verdict: { verdict: 'upheld', confidence: 1, reason: '单脑不该被问' } });
  attachRefuteFace({ primaryId: 'glm', brains: [single], quorum: { askVerdict: req => jury.askVerdict(req) } });
  const v = await askRefutation({ imageBase64: 'QUJD', description: '发送按钮', timeoutMs: 500 });
  assert.equal(v.verdict, 'refuted', '多数 refuted（2:1）⇒ 判词 refuted（票面直通）');
  assert.equal(v.secondOpinionId, 'ensemble-quorum', '归因到合议庭');
  assert.ok(Math.abs(v.confidence - 0.8 * 2 / 3) < 1e-9, '胜方均值×占比透传');
  assert.equal(v.note, undefined, '带内 ⇒ 无置信带注记');
  assert.match(v.reason ?? '', /合议庭多脑多数票反驳/);
  assert.match(v.reason ?? '', /gemini:confirmed/, '少数异议点名随行');
  assert.deepEqual(
    (v.census ?? []).map(c => [c.id, c.ok]),
    [['openai', true], ['anthropic', true], ['gemini', true]],
    'census 透传：三席普查',
  );
  assert.equal(single.calls, 0, '多脑在场 ⇒ 单脑通道整体替代（qwen 零拨号）');
  assert.equal(refuteStats().refuted, 1, '年报表记 refuted 一票');

  // upheld 臂：confirmed 2:1、conf = 0.9×2/3 = 0.6 ≥ 0.55 带内（方言映射 confirmed→upheld）
  const jury2 = new EnsembleCourt([
    juror('openai', { verdict: 'confirmed', confidence: 0.9 }),
    juror('anthropic', { verdict: 'confirmed', confidence: 0.9 }),
    juror('gemini', { verdict: 'refuted', confidence: 0.5 }),
  ]);
  attachRefuteFace({ primaryId: 'glm', brains: [single], quorum: { askVerdict: req => jury2.askVerdict(req) } });
  const u = await askRefutation({ imageBase64: 'QUJD', description: '发送按钮', timeoutMs: 500 });
  assert.equal(u.verdict, 'upheld', 'confirmed 多数 ⇒ upheld');
  assert.ok(Math.abs(u.confidence - 0.9 * 2 / 3) < 1e-9);
  assert.equal(u.note, undefined);
  assert.match(u.reason ?? '', /合议庭多脑多数票维持/);
});

test('ΝΩ-47b: 反驳置信带两臂 —— 弱 upheld 不背书（uncertain 零行为）/ 弱 refuted 仍拦但注记', async () => {
  // 臂一：upheld conf 0.4 < 0.55 ⇒ 降级 uncertain「提示不背书」（不硬放行注记弱背书）
  attachFace([fakeBrain('openai', { verdict: { verdict: 'upheld', confidence: 0.4, reason: '勉强像' } })]);
  const a = await askRefutation({ imageBase64: 'QUJD', description: '发送按钮' });
  assert.equal(a.verdict, 'uncertain', '弱背书不背书 —— 法院弃权');
  assert.equal(a.confidence, 0);
  assert.equal(a.reason, undefined, '判词不携带弱背书理由');
  assert.match(a.note ?? '', /weak-upheld/);
  assert.match(a.note ?? '', /0\.400/);
  assert.equal(refuteStats().uncertain >= 1, true, '年报表记 uncertain 桶');

  // 工具级执法：弱 upheld 点击照常放行且无 upheld 锚点注记（弱背书不注记）
  const tool = createClickMouseTool(toolCfg);
  const out = await runJson(tool, { x: 0.5, y: 0.5, target_description: '发送按钮', approval_token: grantedToken() });
  assert.equal(out.status, 'SUCCESS', '弱背书不构成拦截（法院是增益不是依赖）');
  assert.equal(out.state_anchor.refute, undefined, '不硬放行注记弱背书 —— 锚点键不入场');
  assert.equal(clicks, 1);

  // 臂二：refuted conf 0.45 < 0.5 ⇒ 弱反驳仍拦（保守方向）但注记
  attachFace([fakeBrain('anthropic', { verdict: { verdict: 'refuted', confidence: 0.45, reason: '疑似钓鱼' } })]);
  const b = await askRefutation({ imageBase64: 'QUJD', description: '发送按钮' });
  assert.equal(b.verdict, 'refuted', '弱反驳仍拦 —— 不可逆闸门失败安全取多拦');
  assert.equal(b.confidence, 0.45);
  assert.equal(b.reason, '疑似钓鱼', '反驳理由保留');
  assert.match(b.note ?? '', /weak-refuted/);
  // 工具级执法：弱 refuted 照拦（零派发 + GUARD 入链 + 令牌不烧）
  const token2 = grantedToken();
  const out2 = await runJson(createClickMouseTool(toolCfg), {
    x: 0.5, y: 0.5, target_description: '发送按钮', approval_token: token2,
  });
  assert.equal(out2.status, 'FAILED', '弱反驳仍拦（人工复核指引）');
  assert.equal(clicks, 1, '物理派发不增');
  assert.equal(approval.validate(token2), true, '令牌不烧');
  assert.ok(
    journal.list(false).some(e => e.tool === 'GUARD_BLOCKED' && e.args?.guard === 'refute-court'),
    '弱反驳拦截以 GUARD 方言入链',
  );
});

test('ΝΩ-47c: 多脑通道故障收敛 —— 挂死/上抛/平票/垃圾载荷/敌意面皆 uncertain 绝不抛', async () => {
  // 挂死：硬止损竞速（测试缝 60ms）⇒ quorum-timeout 诚实归因
  _overrideRefuteTimeoutForTest(60);
  attachRefuteFace({
    primaryId: 'glm',
    brains: [],
    quorum: { askVerdict: () => new Promise(() => { /* 挂死 */ }) },
  });
  assert.equal(refuteCourtInSession(), true, 'quorum 在场即开庭（空单脑名册亦然）');
  const releaseLoop = keepEventLoopAlive(2_000);
  try {
    const t = await askRefutation({ imageBase64: 'QUJD', description: '发送按钮' });
    assert.equal(t.verdict, 'uncertain');
    assert.match(t.note ?? '', /quorum-timeout-after-60ms/);
  } finally {
    releaseLoop();
  }
  _overrideRefuteTimeoutForTest(null);
  // 上抛：收敛 quorum-failed（缺席审判）
  attachRefuteFace({
    primaryId: 'glm',
    brains: [],
    quorum: { askVerdict: async () => { throw new Error('jury exploded'); } },
  });
  const c = await askRefutation({ imageBase64: 'QUJD', description: '发送按钮' });
  assert.equal(c.verdict, 'uncertain');
  assert.match(c.note ?? '', /quorum-failed: jury exploded/);
  // 平票：1:1 ⇒ uncertain + quorum-split 注记 + census 仍透传
  attachRefuteFace({
    primaryId: 'glm',
    brains: [],
    quorum: {
      askVerdict: async () => ({
        verdict: 'uncertain' as const,
        confidence: 0,
        dissents: ['a:confirmed', 'b:refuted'],
        members: [{ id: 'a', ok: true }, { id: 'b', ok: true }],
      }),
    },
  });
  const s = await askRefutation({ imageBase64: 'QUJD', description: '发送按钮' });
  assert.equal(s.verdict, 'uncertain');
  assert.match(s.note ?? '', /quorum-split/);
  assert.equal((s.census ?? []).length, 2, '平票也透传 census');
  // 垃圾载荷：verdict 非法 ⇒ quorum-payload-unusable
  attachRefuteFace({
    primaryId: 'glm',
    brains: [],
    quorum: {
      askVerdict: async () =>
        ({ verdict: 'banana', confidence: 1, dissents: [], members: [] }) as never,
    },
  });
  const g = await askRefutation({ imageBase64: 'QUJD', description: '发送按钮' });
  assert.equal(g.verdict, 'uncertain');
  assert.match(g.note ?? '', /quorum-payload-unusable/);
  // 敌意 quorum（askVerdict 非函数）⇒ 视为缺席，退回单脑路径（旧行为）
  attachRefuteFace({
    primaryId: 'glm',
    brains: [fakeBrain('openai', { verdict: { verdict: 'upheld', confidence: 0.9, reason: 'ok' } })],
    quorum: { notAskVerdict: true } as never,
  });
  const h = await askRefutation({ imageBase64: 'QUJD', description: '发送按钮' });
  assert.equal(h.verdict, 'upheld', '敌意 quorum 安静忽略 ⇒ 单脑路径照旧');
  assert.equal(h.secondOpinionId, 'openai');
});

test('ΝΩ-47d: 缺省兼容 + 装配面 —— quorum 缺席单脑路径逐字节保持；buildRefuteQuorumFace 异构门', async () => {
  // 缺省：无 quorum ⇒ 单脑照旧（secondOpinionId = 脑 id、census 缺席、无带注记）
  const brain = fakeBrain('openai', { verdict: { verdict: 'upheld', confidence: 0.9, reason: 'ok' } });
  attachFace([brain]);
  const v = await askRefutation({ imageBase64: 'QUJD', description: '发送按钮' });
  assert.equal(v.verdict, 'upheld');
  assert.equal(v.secondOpinionId, 'openai');
  assert.equal(v.census, undefined, '单脑路径无 census');
  assert.equal(v.note, undefined, '0.9 带内无注记');
  assert.equal(brain.calls, 1);

  // 装配面（vlm/index.ts）：同源剔除 + ≥2 异构门
  const { EnsembleCourt } = await import('../src/vlm/providers/ensemble.ts');
  const vlmIndex = await import('../src/vlm/index.ts');
  const glmSeat = juror('glm', { verdict: 'refuted', confidence: 1 }); // 主脑不该作证
  const oSeat = juror('openai', { verdict: 'confirmed', confidence: 0.9 });
  const aSeat = juror('anthropic', { verdict: 'confirmed', confidence: 0.9 });
  const face = vlmIndex.buildRefuteQuorumFace(new EnsembleCourt([glmSeat, oSeat, aSeat]), { id: 'glm' });
  assert.ok(face !== null, '剔除同源主脑后双异构 ⇒ 铸成');
  const jv = await face.askVerdict({ images: [{ base64: 'QUJD' }], prompt: 'x', timeoutMs: 200 });
  assert.equal(jv.verdict, 'confirmed', '双异构一致 ⇒ confirmed');
  assert.equal(glmSeat.calls, 0, '主脑同源零拨号');
  assert.equal(oSeat.calls + aSeat.calls, 2, '双异构各投一票');
  // 异构 <2 ⇒ null（成不了合议 —— 退回单脑路径的诚实形态）
  assert.equal(vlmIndex.buildRefuteQuorumFace(new EnsembleCourt([glmSeat, oSeat]), { id: 'glm' }), null);
  assert.equal(vlmIndex.buildRefuteQuorumFace(new EnsembleCourt([glmSeat]), { id: 'glm' }), null);
});
