// test/p2b-fixes.test.ts
// P2b（杂项加固）执法册 —— 三处缺陷的出处均为**全库遍历报告**：
//   P2b-1 通道 EMA 跨任务/跨卸载存活（src/orchestrator.ts）：模块级 EMA 无人
//         在卸载时归零，违背「W-1 单例隔离律」；同时必须立法**跨任务保持**
//         （EMA 的学习价值在任务间，只有插件卸载才清零 —— 不得误杀学习记忆）。
//   P2b-2 uiMemory 容量驱逐排序失效（src/uiMemory.ts）：旧公式
//         successCount × lastUsedAt 是量纲失衡的乘积 —— epoch 毫秒与成功计数
//         相乘后只有一维真正决定排序，「低成功 + 陈旧」的二维设计意图退化。
//   P2b-3 click_element 审批令牌未接验收式消费（src/tools/clickElement.ts，
//         GENESIS 缝隙在册）：令牌的 beginAttempt→派发→验证→consume/
//         attemptFailed 闭环只在 click_mouse —— click_element 拿了令牌不烧毁。
// 全离线确定性：假 system（物理派发计数器）、假 accessibility provider、
// 假验收取证件（elementVerify 注入缝）—— 零真网络、零真截屏、零服务孵化。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Config } from '../src/config.ts';
import {
  runOrchestrator, createActor, actorChannelWeights, resetChannelArbitration,
} from '../src/orchestrator.ts';
import { uiMemory, LANDMARK_HALF_LIFE_H, type Landmark } from '../src/uiMemory.ts';
import { approval, resetApproval } from '../src/approval.ts';
import { system } from '../src/system.ts';
import { setAccessibilityProvider, extractInteractiveElements } from '../src/uiExtractor.ts';
import { createClickElementTool, elementVerify } from '../src/tools/clickElement.ts';
import type { BeforeState, CombinedEffect } from '../src/actionVerifier.ts';

// ═══ P2b-1：通道 EMA 的隔离边界（卸载归零 + 跨任务保持）═══

test('P2b-1a: 喂偏 EMA ⇒ resetChannelArbitration() ⇒ 回 Laplace 0.5 初值（W-1 隔离律）', async () => {
  resetChannelArbitration();
  assert.deepEqual(actorChannelWeights(), { agents: 0.5, skill: 0.5 }, '起点：平权先验');

  // 喂偏：双通道在场 + agents 抛异常 ⇒ hedgeUpdate('agents', false)；
  // agents 跌破平权后再跑一回合 ⇒ 技能重放接管，hedgeUpdate('skill', true)。
  const dirty = createActor({
    getAgentsRun: () => async () => { throw new Error('agents down'); },
    matchSkill: () => [{ id: 1, reliability: 0.9, steps: [{ tool: 't', args: {} }] }],
    replayStep: async () => 'ok',
    recordOutcome: () => { /* 旁路 */ },
  });
  await dirty('t1'); // agents 首败：0.5 → 0.425
  await dirty('t2'); // 仲裁让位 ⇒ skill 重放成功：0.5 → 0.575
  const fed = actorChannelWeights();
  assert.ok(fed.agents < 0.5, `agents 被喂低（${fed.agents}）`);
  assert.ok(fed.skill > 0.5, `skill 被喂高（${fed.skill}）`);

  // 卸载隔离缝：插件卸载（W-1）语义 —— 归零回初值，重载实例不继承幽灵权重
  resetChannelArbitration();
  assert.deepEqual(actorChannelWeights(), { agents: 0.5, skill: 0.5 }, 'reset ⇒ Laplace 0.5/0.5');
});

test('P2b-1b: runOrchestrator 两次调用之间 EMA 保持（跨任务学习不误杀）', async () => {
  resetChannelArbitration();
  // 喂偏到非平权态（同 P2b-1a 的脏化路径，只喂 agents 一次即可偏离开 0.5）
  const dirty = createActor({
    getAgentsRun: () => async () => { throw new Error('agents down'); },
    matchSkill: () => [{ id: 1, reliability: 0.9, steps: [{ tool: 't', args: {} }] }],
    replayStep: async () => 'ok',
    recordOutcome: () => { /* 旁路 */ },
  });
  await dirty('t');
  const fed = actorChannelWeights();
  assert.notDeepEqual(fed, { agents: 0.5, skill: 0.5 }, '确已偏离初值');

  // 两次完整编排回合（无 chat ⇒ Planner 空计划守卫路径，零 LLM、离线确定）：
  // 上一任务里学到的通道教训必须护着下一任务的仲裁 —— EMA 跨任务保持。
  const r1 = await runOrchestrator('task A', async () => '[SUCCESS] noop');
  const r2 = await runOrchestrator('task B', async () => '[SUCCESS] noop');
  assert.ok(r1.startsWith('[Planner]'), '空计划守卫方言（无 chat ⇒ 无拆解）');
  assert.ok(r2.startsWith('[Planner]'), '第二回合同律');
  assert.deepEqual(actorChannelWeights(), fed, '两次 runOrchestrator 之间 EMA 一字不动（学习不误杀）');

  // 只有显式 reset 才清零（隔离缝仍有效）
  resetChannelArbitration();
  assert.deepEqual(actorChannelWeights(), { agents: 0.5, skill: 0.5 });
});

test('P2b-1c: 隔离边界立法在册（源码注释 = W-1 契约，epochS 源码断言先例）', () => {
  const src = readFileSync(new URL('../src/orchestrator.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('卸载（dispose）时由 src/index.ts'), '卸载调用点立法在场（W-1 隔离律）');
  assert.ok(src.includes('runOrchestrator 之间绝不重置'), '跨任务保持边界立法在场（不误杀学习记忆）');
});

// ═══ P2b-2：容量驱逐评分 = 衰减成功 × 新近度（半衰律）═══

/** 构造确定性 landmark（绕过 remember 的 Date.now()，直接落时间戳） */
function mk(id: number, description: string, successCount: number, lastUsedAt: number): Landmark {
  return { id, description, normalized: { x: id * 0.1, y: id * 0.1 }, successCount, lastUsedAt };
}

test('P2b-2a: 同新近度下 successCount 高者留、低者逐（成功计数有真实话语权）', () => {
  uiMemory.reset();
  uiMemory.configure(1); // 容量 1：再记一条 ⇒ 3>1 ⇒ 驱逐到只剩 1 条
  const t = Date.now() - 3_600_000; // 1 小时前 —— 两条目完全同新近度（衰减因子同值）
  uiMemory.restore({
    landmarks: [
      mk(1, 'low success', 1, t),   // log1p(1) ≈ 0.69
      mk(2, 'high success', 8, t),  // log1p(8) ≈ 2.20
    ],
    nextId: 3,
  });
  uiMemory.remember('fresh trigger', 0.9, 0.9); // 触发驱逐
  assert.equal(uiMemory.get(2)?.description, 'high success', '同新近度：s=8 留下');
  assert.equal(uiMemory.get(1), undefined, '同新近度：s=1 被逐 —— 成功计数独占排序话语');
});

test('P2b-2b: 时间极旧但成功极多 ⇒ 按半衰公式裁决（成功不能无限赎买陈旧；旧乘积公式下此断言必挂）', () => {
  uiMemory.reset();
  uiMemory.configure(2);
  const H = LANDMARK_HALF_LIFE_H * 3_600_000; // 半衰期（ms）—— 库内既有放射性常量
  const now = Date.now();
  uiMemory.restore({
    landmarks: [
      // s=100（log1p≈4.62）但 3 个半衰期前：4.62 × 2^-3 ≈ 0.58 < 0.69（新鲜 s=1）
      mk(1, 'ancient champion', 100, now - 3 * H),
      // s=2（log1p≈1.10）新鲜 ⇒ ≈1.10
      mk(2, 'fresh runner', 2, now),
    ],
    nextId: 3,
  });
  uiMemory.remember('fresh trigger', 0.9, 0.9); // 3>2 ⇒ 逐一条
  // 执法即证明：旧公式 successCount × lastUsedAt 下 100×T_old > 2×T_new 恒成立
  //（时间维话语权≈0）⇒ ancient champion 错误存活；半衰公式恢复时间维否决权。
  assert.equal(uiMemory.get(1), undefined, 's=100 但 3 半衰期旧（≈0.58）⇒ 被逐');
  assert.ok(uiMemory.get(2), 's=2 新鲜（≈1.10）⇒ 留下');
  assert.equal(uiMemory.size, 2);
});

test('P2b-2c: 驱逐公式在册 —— log1p × 库内半衰常量（无新魔法数，epochS 源码断言先例）', () => {
  const src = readFileSync(new URL('../src/uiMemory.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('Math.log1p(l.successCount) * Math.pow(2,'), '衰减×对数评分公式在场');
  assert.ok(src.includes('LANDMARK_HALF_LIFE_H)'), '复用 Y-8 半衰期常量（不引入新魔法数）');
  assert.ok(!src.includes('successCount * b.lastUsedAt'), '旧乘积公式已退役');
});

// ═══ P2b-3：click_element 审批令牌的验收式消费闭环 ═══

// ─── 假件工坊：物理派发计数器 + 假 accessibility provider + 假验收取证件 ───

const originalSystem = {
  clickMouse: system.clickMouse.bind(system),
  getScreenSize: system.getScreenSize.bind(system),
};
const originalVerify = {
  captureBefore: elementVerify.captureBefore,
  settleAndVerify: elementVerify.settleAndVerify,
};
let clicks = 0;
let verifyCalls = 0;
/** 假验收判决：true=世界变化被验证 / false=未生效（no-effect） */
let detectedOutcome = true;

/** 假 CombinedEffect（完整形状 —— 测试文件在 tsc --noEmit 覆盖内） */
function fakeEffect(detected: boolean): CombinedEffect {
  return {
    detected,
    screen: { effect_detected: detected, similarity_pct: detected ? 50 : 99.9, distance: detected ? 32 : 1 },
    region: null,
    scale: detected ? 'page-level' : 'none',
    afterBuffer: Buffer.alloc(0),
    afterHash: '',
    oscillation: null,
  };
}

beforeEach(() => {
  resetApproval();
  clicks = 0;
  verifyCalls = 0;
  detectedOutcome = true;
  system.clickMouse = async () => { clicks++; };
  system.getScreenSize = async () => ({ width: 1920, height: 1080 });
  // 元素树：id 1 = 危险（删除全部）；id 2 = 安全（保存设置）。
  // uiExtractor 的 ID 发号器跨提取递增 —— 测试内按名动态取 ID，不硬编码。
  setAccessibilityProvider(async () => ({
    children: [
      { role: 'button', name: '删除全部', rect: { x: 400, y: 500, width: 100, height: 40 } },
      { role: 'button', name: '保存设置', rect: { x: 700, y: 500, width: 100, height: 40 } },
    ],
  }));
  // P2b-3 注入缝（notaryEvidence 同律）：真取证面要拉起 D-5 物理微服务 ——
  // 离线确定性测试注入假件驱动 verified / no-effect 分支。
  elementVerify.captureBefore = async (): Promise<BeforeState> => {
    verifyCalls++;
    return { screen: 'ab', region: null, focus: null };
  };
  elementVerify.settleAndVerify = async (): Promise<CombinedEffect> => {
    verifyCalls++;
    return fakeEffect(detectedOutcome);
  };
});

afterEach(() => {
  system.clickMouse = originalSystem.clickMouse;
  system.getScreenSize = originalSystem.getScreenSize;
  elementVerify.captureBefore = originalVerify.captureBefore;
  elementVerify.settleAndVerify = originalVerify.settleAndVerify;
  setAccessibilityProvider(null as any);
});

/** click_element 工具配置：审批闸门开、公证通道关（聚焦验收式消费）、验证开（取证走假件） */
const elCfg = {
  enableApprovalGate: true,
  dangerPatterns: 'send,发送,delete,删除',
  enableRiskGate: false,
  riskPatterns: '',
  maxTextLength: 1000,
  focusMaxAgeMs: 60_000,
  enableNotarizationLock: false,
  verifyActions: true,
  dryRun: false,
  adaptiveSettle: false,
  actionSettleMs: 1,
  noopSimilarityThreshold: 0.97,
  regionVerifyRadius: 0.15,
  physicsRules: '',
  intentVerify: false,
  enableOcr: false,
  autoRemember: false,
  enableInteractivityProbe: false,
} as unknown as Config;

type Executable = { execute: (a: unknown) => Promise<string> };

async function runJson(tool: unknown, args: unknown): Promise<any> {
  const out = await (tool as Executable).execute(args);
  return JSON.parse(out);
}

/** 按元素名取当前缓存 ID（ID 发号器跨提取递增，不可硬编码） */
async function elId(name: string): Promise<number> {
  const els = await extractInteractiveElements(true);
  const hit = els.find(e => e.name === name);
  assert.ok(hit, `元素树含「${name}」`);
  return hit.id;
}

/** 铸一枚已授予的令牌（Y-10 桶在 resetApproval 后满格） */
function grantedToken(desc: string): string {
  const pa = approval.request(desc);
  assert.equal(approval.grant(pa.token, true), true, '令牌授予');
  return pa.token;
}

test('P2b-3a: 在途互斥 —— 另一回合持预留时同令牌派发被拒（双花封堵，clickMouse Δ-3 同律）', async () => {
  const tool = createClickElementTool(elCfg);
  const token = grantedToken('点击「删除全部」清空列表');
  assert.equal(approval.beginAttempt(token), true, '模拟另一在途回合持预留');
  const denied = await runJson(tool, { id: await elId('删除全部'), approval_token: token });
  assert.equal(denied.status, 'ACTION_REQUIRED');
  assert.equal(denied.state_anchor.reason, 'attempt-in-flight-or-budget-exhausted');
  assert.equal(clicks, 0, '无预留不得派发');
  approval.attemptFailed(token, 'no-effect'); // 结算在途，交还令牌给后续用例语义
});

test('P2b-3b: 带令牌 + 验证成功 ⇒ consume 焚毁（再 beginAttempt 被拒 —— 一次同意一次世界验证）', async () => {
  const tool = createClickElementTool(elCfg);
  const token = grantedToken('点击「删除全部」清空列表');
  detectedOutcome = true; // 世界变化被验证
  const out = await runJson(tool, { id: await elId('删除全部'), approval_token: token });
  assert.equal(out.status, 'SUCCESS');
  assert.equal(clicks, 1, '物理点击恰派发一次');
  assert.ok(verifyCalls >= 2, '快照 + 验收取证面被调用（验收判决有证据源）');
  assert.equal(out.state_anchor.approval_gate, 'notarized-approved', '过闸方言保持');
  assert.equal(out.state_anchor.acceptance.verdict, 'verified', '验收通过');
  assert.equal(approval.validate(token), false, '令牌已焚毁（validate 拒绝）');
  assert.equal(approval.beginAttempt(token), false, '焚毁后再预留被拒');
  assert.equal(approval.status(token).present, false, '审批簿记中已除名');
});

test('P2b-3c: 验证失败（no-effect）⇒ attemptFailed 续期可重试；重试验收通过 ⇒ 焚毁', async () => {
  const tool = createClickElementTool(elCfg);
  const token = grantedToken('点击「删除全部」清空列表');
  // 第一击：派发了但世界未变 —— 未生效的尝试不消耗用户的同意
  detectedOutcome = false;
  const miss = await runJson(tool, { id: await elId('删除全部'), approval_token: token });
  assert.equal(miss.status, 'SUCCESS', '派发成功返回（验收裁决在锚点，不在 status）');
  assert.equal(clicks, 1);
  assert.equal(miss.state_anchor.acceptance.verdict, 'retry-allowed', '未生效 ⇒ 允许重试');
  assert.equal(miss.state_anchor.acceptance.remaining_attempts, 4, '默认预算 5，已用 1');
  assert.match(miss.next_step, /RETRY within the SAME approval/, '重试指引前置（免二次打扰）');
  assert.equal(approval.validate(token), true, '令牌保留（TTL 已续期）');
  assert.equal(approval.status(token).attempts, 1, '全链路 attempts 恰 +1');
  // 第二击（同一授权内）：纠正后世界变化被验证 ⇒ 同意兑现，焚毁
  detectedOutcome = true;
  const hit = await runJson(tool, { id: await elId('删除全部'), approval_token: token });
  assert.equal(hit.state_anchor.acceptance.verdict, 'verified');
  assert.equal(clicks, 2);
  assert.equal(approval.validate(token), false, '重试验收通过 ⇒ 令牌焚毁');
});

test('P2b-3d: 派发异常 ⇒ attemptFailed 结算预留，令牌保留可重试（B-3 异常语义同律）', async () => {
  const tool = createClickElementTool(elCfg);
  const token = grantedToken('点击「删除全部」清空列表');
  system.clickMouse = async () => { clicks++; throw new Error('dispatch boom'); };
  const out = await runJson(tool, { id: await elId('删除全部'), approval_token: token });
  assert.equal(out.status, 'FAILED', '异常统一 FAILED 方言（运行层永不抛）');
  assert.match(out.next_step, /still valid for one retry/, '异常不烧令牌的指引在场');
  assert.equal(approval.validate(token), true, '预留已结算（attemptFailed），令牌保留');
  assert.equal(approval.status(token).attempts, 1, '预留 + 结算恰 +1（不重复计数）');
});

test('P2b-3e: 无令牌普通点击零变化（快照/预留/验收全链路零触碰）', async () => {
  const tool = createClickElementTool(elCfg);
  detectedOutcome = false; // 即便世界无变化：无令牌 ⇒ 根本不进入验收链
  const out = await runJson(tool, { id: await elId('保存设置') });
  assert.equal(out.status, 'SUCCESS');
  assert.equal(clicks, 1);
  assert.equal(out.state_anchor.approval_gate, 'described', '安全元素过闸方言保持');
  assert.equal(out.state_anchor.acceptance, undefined, '验收键不入场');
  assert.equal(out.state_anchor.effect, undefined, '效果键不入场');
  assert.equal(verifyCalls, 0, '验收取证面零调用（无令牌路径逐字节旧路径）');
  assert.equal(out.next_step, "Call 'take_screenshot' to verify the interaction took effect.", '指引原样');
});
