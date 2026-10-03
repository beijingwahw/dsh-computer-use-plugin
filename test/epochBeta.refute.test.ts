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
import type { Config } from '../src/config.ts';
import { approval, resetApproval } from '../src/approval.ts';
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

/** 工具级配置：验证/探针/公证全关（聚焦法院执法），反驳法院开 */
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

/** 铸一枚已授予的令牌（危险点击的通行证） */
function grantedToken(desc = '点击发送按钮提交表单'): string {
  const pa = approval.request(desc);
  assert.equal(approval.grant(pa.token, true), true, '令牌授予成功');
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
