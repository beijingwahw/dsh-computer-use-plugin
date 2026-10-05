// test/pan56-61.autonomy.test.ts
// ΠΑΝ 修复潮 工单 ΠΑΝ-56~61 的执法测试（F2-6）：自主环六处深缺陷的修复钉死。
// 覆盖（工单逐条）：
//   ΠΑΝ-56 宏执行入宪 —— 宏步 actionGate 逐步判定（删除步宏被拦）/ 环级宪法
//            审批路径（macroRiskScan 预扫描 ⇒ approval-required）/ macro-impact 档
//   ΠΑΝ-57 生产 popup 供方 —— 注入端口产 popupNotes 入快照 / 缺省供方（几何 +
//            词证 + 施密特迟滞）/ 缺席 ⇒ 逐字节旧路径（popups 恒 []）
//   ΠΑΝ-58 OCR 接线 —— config.ocrLang / enableOcr⇒ocrServerFirst / popupKeywords
//            铸栈回传（语言进血脉）
//   ΠΑΝ-59 clearBlockers 接线 —— 构造降级阻塞在 ①′ 相位转换处清账放行（0 步
//            死循环封堵）；运行期 addBlocker 阻塞不清
//   ΠΑΝ-60 多 pilot 隔离 —— steer 会话/岔路卡、世界模型接线、探索账本按
//            pilotId 分域；pilotStore 追加原子性 + 压缩并档不吞他进程档案
//   ΠΑΝ-61 否定判据三盲区 —— ⑧′ 强制重采当帧（瞬态逃逸封堵）/ 截断前全文扫
//            禁词 + digest-truncated 留痕 / 否定面 fuzzy 收紧 / 探索证据申报
// 全离线确定性：零真钟零真睡零网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetGlmClient } from '../src/vlm/index.ts';
import type { Config } from '../src/config.ts';
import {
  runAutonomousLoop,
  activeSteerSession,
  bindSteerSessionFactory,
  resetW4PilotWire,
  releasePilotW4Wire,
  classifyExpectedVisualEffect,
  type AutonomyDeps,
  type PilotSteerSession,
} from '../src/autonomy/autoPilot.ts';
import { GoalStateMachine } from '../src/autonomy/goalState.ts';
import { AutonomyConstitution } from '../src/autonomy/autonomyConstitution.ts';
import { composeSnapshot, type WorldSnapshot } from '../src/autonomy/worldSnapshot.ts';
import { evaluateCriteria, negativeFuzzyTolerance } from '../src/autonomy/criteriaEval.ts';
import { buildExplorationCandidates } from '../src/autonomy/explorationCore.ts';
import {
  wireCounterfactualWorldModel,
  counterfactualWorldModelWired,
  releaseCounterfactualWorldModel,
  type WorldModelReadPort,
} from '../src/autonomy/counterfactual.ts';
import {
  buildAutonomyStack,
  releaseExplorationLedger,
  PilotStore,
  type RuntimeDeps,
} from '../src/autonomy/index.ts';
import { createPerceive, gateMacroStepFor } from '../src/autonomy/runtime.ts';
import { makeDefaultPopupNotes, makeDefaultReadWords } from '../src/autonomy/runtime.perceive.ts';
import { skillLibrary } from '../src/skillLibrary.ts';

// ─── 公共假件 ───

function clearGlmEnv(): void {
  delete process.env.GLM_API_KEY;
  delete process.env.DSH_GLM_API_KEY;
  resetGlmClient();
}

/** 固定快照（clean textDigest） */
function cleanSnap(text = ''): WorldSnapshot {
  return {
    takenAt: 1, width: 800, height: 600, dhash: 'ab12cd34',
    elements: [], textDigest: text, popups: [], focusedRegion: null,
    sceneLabel: '', degraded: [],
  };
}

type Act = Parameters<AutonomyDeps['execute']>[0];

function clickAction(label: string): Act {
  return {
    kind: 'click',
    target: { bbox: { x0: 10, y0: 10, x1: 100, y1: 60 }, center: { x: 55, y: 35 }, label },
    rationale: `点击「${label}」`, expectedEffect: '界面变化', utility: 0.8, riskTier: 'benign',
  };
}

const RECALL_ACTION: Act = {
  kind: 'recall_skill',
  payload: { skillId: 1, description: '安全流程' },
  rationale: '召回技能', expectedEffect: '宏流程展开', utility: 0.6, riskTier: 'benign',
};

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    autonomyEnabled: true,
    autonomyMaxSteps: 24,
    autonomyTimeBudgetSec: 300,
    autonomyAllowTiers: 'benign',
    autonomyVlmWhenUncertain: true,
    autonomyForbiddenKeywords: '',
    ...over,
  } as Config;
}

/** 一决策一动作的最小策略桩 */
function policyOf(actions: Act[]): AutonomyDeps['policy'] {
  let i = 0;
  return {
    decide: async () => ({ action: actions[Math.min(i++, actions.length - 1)], uncertain: false, degraded: false }),
  };
}

// ═══ ΠΑΝ-56：宏执行入宪 ═══

test('ΠΑΝ-56-a: 宏步 actionGate 逐步判定 —— click 落点标签命中危险词 ⇒ 审批域拦截', () => {
  const snap = composeSnapshot({
    width: 100, height: 100,
    localElements: [{ label: '删除订单', bbox: { x0: 40, y0: 40, x1: 60, y1: 60 }, confidence: 0.9 }],
    ocrText: '删除订单',
  });
  const verdict = gateMacroStepFor({ tool: 'click_mouse', args: { x: 0.5, y: 0.5 } }, snap);
  assert.ok(verdict, 'click 步入闸（ActionKind 闭集在册）');
  assert.equal(verdict.allowed, false, '危险落点（删除订单）不派发');
  assert.equal(verdict.requiresApproval, true, '属审批域 —— 与直接点击危险目标同档');
  // 干净标签 ⇒ 放行（同律对照）
  const snapClean = composeSnapshot({
    width: 100, height: 100,
    localElements: [{ label: '下一步', bbox: { x0: 40, y0: 40, x1: 60, y1: 60 }, confidence: 0.9 }],
    ocrText: '下一步',
  });
  const ok = gateMacroStepFor({ tool: 'click_mouse', args: { x: 0.5, y: 0.5 } }, snapClean);
  assert.equal(ok?.allowed, true, '干净标签照常放行（宏能力不被一刀切）');
  // 无快照证据且无自述 ⇒ undescribed 前置 fail-closed
  const blind = gateMacroStepFor({ tool: 'click_mouse', args: { x: 0.5, y: 0.5 } }, null);
  assert.equal(blind?.allowed, false, '无证据落点按 undescribed 拒绝（N 纪元硬前置同律）');
  assert.equal(blind?.reason, 'undescribed-click');
});

test('ΠΑΝ-56-b: 宏步 type/hotkey/scroll 闸 —— 凭据文本拦截 / 视口滚动放行 / 未登记工具不判', () => {
  const cred = gateMacroStepFor({ tool: 'type_text', args: { text: '我的密码是123456' } }, null);
  assert.equal(cred?.allowed, false, 'type 步携凭据语义 ⇒ sensitive-input 拦截（与 typeText 工具同律）');
  assert.equal(cred?.reason, 'sensitive-input');
  const okType = gateMacroStepFor({ tool: 'type_text', args: { text: '普通备注' } }, null);
  assert.equal(okType?.allowed, true, '普通文本照常放行');
  const scroll = gateMacroStepFor({ tool: 'scroll_page', args: { direction: 'down' } }, null);
  assert.equal(scroll?.allowed, true, '视口导航恒放行（ΠΑΝ-14 闭集占位）');
  const unknown = gateMacroStepFor({ tool: 'switch_tab', args: {} }, null);
  assert.equal(unknown, null, '未登记工具不判（派发面自会 unresolved）');
});

test('ΠΑΝ-56-c: 环级宪法审批路径 —— macroRiskScan 预扫描命中危险词面 ⇒ approval-required 终局零执行', async () => {
  clearGlmEnv();
  const goal = new GoalStateMachine({ goal: '安全搁置订单', successCriteria: ['已搁置'] }, () => 1);
  let execCalls = 0;
  const deps: AutonomyDeps = {
    perceive: async () => cleanSnap(),
    policy: policyOf([RECALL_ACTION]),
    execute: async () => { execCalls++; return { outcome: 'progress' }; },
    goal,
    constitution: new AutonomyConstitution(),
    // 预扫描端口：宏链词面含「删除」（危险步）
    macroRiskScan: () => 'click_mouse {"x":0.5,"y":0.5,"target_description":"删除订单"}',
    sleep: async () => {},
    now: () => 1,
  };
  const res = await runAutonomousLoop(deps);
  assert.equal(res.escalated, true, '危险宏升级移交');
  assert.equal(res.escalateReason, 'approval-required', '与直接点击危险目标同档：宪法审批路径');
  assert.equal(execCalls, 0, '被拦宏不入执行（宏序列不再以 benign 身份绕宪）');
  assert.match(res.summary, /审批/);
  // 对照：扫描缺席（null）⇒ 判决回旧路径照常执行
  const goal2 = new GoalStateMachine({ goal: '安全搁置订单', successCriteria: ['已搁置'] }, () => 1);
  let execCalls2 = 0;
  const deps2: AutonomyDeps = {
    perceive: async () => cleanSnap(),
    policy: policyOf([RECALL_ACTION]),
    execute: async () => { execCalls2++; return { outcome: 'progress', criteriaEvidence: [{ index: 0, status: 'met' }] }; },
    goal: goal2,
    constitution: new AutonomyConstitution(),
    macroRiskScan: () => null,
    sleep: async () => {},
    now: () => 1,
  };
  const res2 = await runAutonomousLoop(deps2);
  assert.equal(res2.escalated, false, '干净宏照常执行（端口返回 null 按缺席）');
  assert.equal(execCalls2, 1);
});

test('ΠΑΝ-56-d: buildAutonomyStack 缺省 macroRiskScan —— 真宏链词面可扫（技能库解析）', () => {
  clearGlmEnv();
  const skill = skillLibrary.induce('ΠΑΝ-56 危险流程演示', [
    { tool: 'click_mouse', args: { x: 0.5, y: 0.5, target_description: '删除订单' } },
  ]);
  assert.ok(skill, '演示技能入册');
  const stack = buildAutonomyStack(makeConfig(), {});
  assert.equal(typeof stack.macroRiskScan, 'function', '缺省预扫描端口随栈在场（安全修复直接生效）');
  const scan = stack.macroRiskScan!(
    { kind: 'recall_skill', payload: { skillId: skill!.id, description: '危险流程' } } as unknown as Act,
    { goalText: '危险流程' },
  );
  assert.ok(scan !== null && scan.includes('删除订单'), `宏步词面进扫描串：${scan}`);
  const cleanSkill = skillLibrary.induce('ΠΑΝ-56 干净流程演示', [
    { tool: 'scroll_page', args: { direction: 'down' } },
  ]);
  const scanClean = stack.macroRiskScan!(
    { kind: 'recall_skill', payload: { skillId: cleanSkill!.id } } as unknown as Act,
    { goalText: '干净流程' },
  );
  assert.ok(scanClean !== null && !scanClean.includes('删除'), `干净宏词面：${scanClean}`);
  // 无定位的 recall_skill ⇒ 与 runtime 同律按 goal 召回最佳
  const byGoal = stack.macroRiskScan!(
    { kind: 'recall_skill', payload: {} } as unknown as Act,
    { goalText: 'ΠΑΝ-56 危险流程演示' },
  );
  assert.ok(byGoal !== null && byGoal.includes('删除订单'), `goal 召回路径可扫：${byGoal}`);
});

test('ΠΑΝ-56-e: macro-impact 档 —— recall_skill 不再归 no-impact（免看门控不可跳 / prophecy 开始铸造）', () => {
  assert.equal(classifyExpectedVisualEffect(RECALL_ACTION), 'macro-impact', '宏冲击新档在册');
  assert.notEqual(classifyExpectedVisualEffect(RECALL_ACTION), 'no-impact');
  for (const kind of ['inspect', 'declare', 'ask_vlm'] as const) {
    assert.equal(
      classifyExpectedVisualEffect({ kind, rationale: 'r', expectedEffect: 'e', utility: 0.5, riskTier: 'benign' }),
      'no-impact',
      `${kind} 仍为无影响（观察族不变）`,
    );
  }
});

// ═══ ΠΑΝ-57：生产 popup 供方 ═══

test('ΠΑΝ-57-a: 注入 popupNotes 端口 —— 生产感知产出弹窗注记入快照 popups', async () => {
  clearGlmEnv();
  let portCalls = 0;
  const deps: RuntimeDeps = {
    capture: async () => Buffer.from('fake-frame'),
    imageSize: async () => ({ width: 100, height: 80 }),
    dhashOf: async () => 'ab12',
    readWords: async () => [{ label: '允许通知', bbox: { x0: 10, y0: 10, x1: 40, y1: 20 }, confidence: 0.9 }],
    groundVlm: async () => [],
    popupNotes: async (buf, ocrText) => {
      portCalls++;
      assert.ok(Buffer.isBuffer(buf), '截屏帧入端口');
      assert.ok(ocrText.includes('允许通知'), '全帧 OCR 语料入端口');
      return ['弹窗在场（测试注入）'];
    },
  };
  const perceive = createPerceive(deps);
  const snap = await perceive();
  assert.deepEqual(snap.popups, ['弹窗在场（测试注入）'], '弹窗注记入快照（策略①弹窗优先律的供血）');
  assert.equal(portCalls, 1);
});

test('ΠΑΝ-57-b: 缺省 popup 供方 —— 词证命中经施密特迟滞产注记；清洁帧 null；通道缺席 ⇒ 旧路径', async () => {
  clearGlmEnv();
  const producer = makeDefaultPopupNotes('allow,confirm,cookie');
  const hit = await producer(Buffer.from('fake'), '系统提示 please allow notifications');
  assert.ok(hit !== null && hit.length === 1 && /弹窗在场/.test(hit[0]) && /语义词证/.test(hit[0]),
    `词证通道命中 ⇒ 迟滞 ON 产注记：${JSON.stringify(hit)}`);
  const clean1 = await producer(Buffer.from('fake'), 'hello world');
  assert.ok(clean1 !== null && /迟滞保持/.test(clean1[0]),
    `单帧清洁不立即 OFF（施密特迟滞带 —— 传感器抖动不震荡）：${JSON.stringify(clean1)}`);
  const clean2 = await producer(Buffer.from('fake'), 'hello world');
  assert.equal(clean2, null, '连续清洁跌破 OFF 线 ⇒ 退出弹窗态（有界迟滞）');
  // 通道缺席（无端口无词表）⇒ popups 恒 []（与接线前逐字节一致）
  const deps: RuntimeDeps = {
    capture: async () => Buffer.from('fake-frame'),
    imageSize: async () => ({ width: 100, height: 80 }),
    dhashOf: async () => 'ab12',
    readWords: async () => [],
    groundVlm: async () => [],
  };
  const snap = await createPerceive(deps)();
  assert.deepEqual(snap.popups, [], '词表缺席 ⇒ 弹窗通道整体不点亮（零回归）');
});

// ═══ ΠΑΝ-58：OCR 接线 ═══

test('ΠΑΝ-58: config.ocrLang / enableOcr ⇒ 铸栈回传（ocrServerFirst + popupKeywords）', () => {
  clearGlmEnv();
  const deps: RuntimeDeps = {};
  buildAutonomyStack(makeConfig({
    ocrLang: 'chi_sim+eng',
    enableOcr: true,
    popupKeywords: 'cookie,allow,登录',
  }), deps);
  assert.equal(deps.ocrLang, 'chi_sim+eng', 'OCR 语言进自主环血脉（中文判据链恢复的前提）');
  assert.equal(deps.ocrServerFirst, true, 'OCR 总开 ⇒ 服务端 L2 优先路径点亮');
  assert.equal(deps.popupKeywords, 'cookie,allow,登录', '弹窗语义词表随栈入感知（ΠΑΝ-57 门控）');
  // 缺省向：不开 OCR ⇒ 三键全缺席（缺省旧路径，零回归）
  const deps2: RuntimeDeps = {};
  buildAutonomyStack(makeConfig(), deps2);
  assert.equal(deps2.ocrLang, undefined, 'config 缺 ocrLang（旧调用方）⇒ 不补挂');
  assert.equal(deps2.ocrServerFirst, undefined);
  assert.equal(deps2.popupKeywords, undefined);
  // 缺省词级 OCR 工厂签名兼容（serverFirst 缺席 ⇒ legacy 直读）
  const words = makeDefaultReadWords('chi_sim+eng');
  assert.equal(typeof words, 'function', '工厂形态不变（buf → 词清单）');
});

// ═══ ΠΑΝ-59：clearBlockers 接线 ═══

test('ΠΑΝ-59-a: 构造降级阻塞在 ①′ 相位转换处清账放行 —— 0 步死循环封堵', async () => {
  clearGlmEnv();
  // 空 successCriteria ⇒ goalState 构造降级 blocker（旧行为：环顶立即 blocked，0 步收场；
  // resume 以同 spec 重铸 ⇒ 永远 0 步 —— 上膛自毙）
  const goal = new GoalStateMachine({ goal: '清理演示桌面', successCriteria: [] }, () => 1);
  assert.ok(goal.constructionBlockers().length >= 1, '构造降级 blocker 在册');
  let execCalls = 0;
  const deps: AutonomyDeps = {
    perceive: async () => cleanSnap(),
    policy: policyOf([{ kind: 'declare', rationale: '宣告', expectedEffect: 'e', utility: 0.5, riskTier: 'benign' }]),
    execute: async () => {
      execCalls++;
      return { outcome: 'no_effect', criteriaEvidence: [{ index: 0, status: 'met' }] };
    },
    goal,
    constitution: new AutonomyConstitution(),
    sleep: async () => {},
    now: () => 1,
  };
  const res = await runAutonomousLoop(deps);
  assert.equal(res.steps, 1, '清账放行后以降级规格继续跑（不再 0 步 blocked）');
  assert.equal(execCalls, 1);
  assert.match(res.summary, /ΠΑΝ-59/, '放行留痕入总汇报');
  assert.equal(res.phase, 'achieved', '降级判据（goal 原文）照常可核');
});

test('ΠΑΝ-59-b: 运行期 addBlocker 阻塞不清（窄类放行不误伤人工阻塞）', async () => {
  clearGlmEnv();
  const goal = new GoalStateMachine({ goal: '正常任务', successCriteria: ['完成'] }, () => 1);
  goal.addBlocker('人工要求的驻足');
  let execCalls = 0;
  const deps: AutonomyDeps = {
    perceive: async () => cleanSnap(),
    policy: policyOf([clickAction('任意')]),
    execute: async () => { execCalls++; return { outcome: 'progress' }; },
    goal,
    constitution: new AutonomyConstitution(),
    sleep: async () => {},
    now: () => 1,
  };
  const res = await runAutonomousLoop(deps);
  assert.equal(res.phase, 'blocked', '运行期阻塞照旧熔断');
  assert.equal(res.steps, 0, '零步零执行');
  assert.equal(execCalls, 0);
  // goalState 结构面：clearConstructionBlockers 只清构造降级项
  const g2 = new GoalStateMachine({ goal: 'x', successCriteria: [] }, () => 1);
  g2.addBlocker('后加阻塞');
  const removed = g2.clearConstructionBlockers();
  assert.ok(removed.length >= 1, '构造项被清');
  assert.deepEqual(g2.progress.blockers, ['后加阻塞'], '后加阻塞保持');
});

// ═══ ΠΑΝ-60：多 pilot 隔离 ═══

test('ΠΑΝ-60-a: steer 会话 per-pilot 域 —— 并发 pilot 互不覆盖；无参读取最近登记域', async () => {
  clearGlmEnv();
  resetW4PilotWire();
  const mkSession = (tag: string): PilotSteerSession => ({
    maybeCheckAndAsk: () => null, // 不出题（本用例只验证域登记）
    pending: () => null,
    answer: () => ({ status: 'ignored' }),
  });
  const sessions = { p1: mkSession('p1'), p2: mkSession('p2') };
  let mintTag = 'p1';
  bindSteerSessionFactory(() => sessions[mintTag as 'p1' | 'p2']);
  try {
    const runOnce = async (pilotId: string): Promise<void> => {
      const goal = new GoalStateMachine({ goal: '隔离演示', successCriteria: ['完成'] }, () => 1);
      const deps: AutonomyDeps = {
        perceive: async () => cleanSnap(),
        policy: policyOf([{ kind: 'escalate', rationale: '收束', expectedEffect: 'e', utility: 0.4, riskTier: 'benign' }]),
        execute: async () => ({ outcome: 'no_effect' }),
        goal,
        steer: { enabled: true },
        sleep: async () => {},
        now: () => 1,
        ...(pilotId !== '' ? { pilotId } : {}),
      };
      await runAutonomousLoop(deps);
    };
    await runOnce('p1');
    assert.equal(activeSteerSession('p1'), sessions.p1, 'p1 域登记自己的会话');
    mintTag = 'p2';
    await runOnce('p2');
    assert.equal(activeSteerSession('p2'), sessions.p2, 'p2 域登记自己的会话');
    assert.equal(activeSteerSession('p1'), sessions.p1, 'p2 铸栈不再覆盖 p1 的会话（隔离执法）');
    assert.equal(activeSteerSession(), sessions.p2, '无参读取最近登记域（既有工具转发面零回归）');
    releasePilotW4Wire('p2');
    assert.equal(activeSteerSession('p2'), null, 'pilot 结束清账（p2 域释放）');
    assert.equal(activeSteerSession('p1'), sessions.p1, 'p1 域不受 p2 释放影响');
    assert.equal(activeSteerSession(), sessions.p1, '释放后最近登记回落 p1');
  } finally {
    bindSteerSessionFactory(null);
    resetW4PilotWire();
  }
});

test('ΠΑΝ-60-b: 世界模型接线 per-pilot 域 —— off 栈只清自己域', () => {
  const portA: WorldModelReadPort = { predict: () => ({ top: null }) };
  wireCounterfactualWorldModel(portA, 'p1');
  wireCounterfactualWorldModel(null, 'p2'); // p2 的 off 栈
  assert.equal(counterfactualWorldModelWired('p1'), true, 'p1 接线保持（不再被 off 栈清掉）');
  assert.equal(counterfactualWorldModelWired('p2'), false, 'p2 自己的域被清');
  assert.equal(counterfactualWorldModelWired(), true, '无参回落最近有效登记域（p1）');
  releaseCounterfactualWorldModel('p1');
  assert.equal(counterfactualWorldModelWired('p1'), false, 'pilot 结束清账');
  // 缺省域 '' 旧语义：无参 wire（旧调用面）⇒ 共享域
  wireCounterfactualWorldModel(portA);
  assert.equal(counterfactualWorldModelWired(), true, '缺省域兼容旧单位语义');
  wireCounterfactualWorldModel(null);
  assert.equal(counterfactualWorldModelWired(), false);
});

test('ΠΑΝ-60-c: 探索账本 per-pilot 域 —— 不同 pilot 各持账本；同 pilot 复用；释放后重铸', () => {
  clearGlmEnv();
  const cfg = makeConfig({ enableExploration: true });
  const s1 = buildAutonomyStack(cfg, { pilotId: 'p1' });
  const s2 = buildAutonomyStack(cfg, { pilotId: 'p2' });
  assert.ok(s1.exploration && s2.exploration, '探索端口随栈在场');
  assert.notEqual(s1.exploration, s2.exploration, '并发 pilot 各持独立账本（reset 不再互踩）');
  const s1b = buildAutonomyStack(cfg, { pilotId: 'p1' });
  assert.equal(s1b.exploration, s1.exploration, '同 pilot 复铸 ⇒ attach 共享实例（ΑΩ-R23 语义保持）');
  const shared1 = buildAutonomyStack(cfg, {});
  const shared2 = buildAutonomyStack(cfg, {});
  assert.equal(shared1.exploration, shared2.exploration, 'pilotId 缺席 ⇒ 共享域（单 pilot 零回归）');
  releaseExplorationLedger('p1');
  const s1c = buildAutonomyStack(cfg, { pilotId: 'p1' });
  assert.notEqual(s1c.exploration, s1.exploration, 'pilot 结束清账 ⇒ 重铸新账本');
});

test('ΠΑΝ-60-d: pilotStore 写入原子性 —— 追加行完整落盘 + 压缩并档不吞他进程档案', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pan60-pilot-'));
  const file = join(dir, 'pilots.jsonl');
  try {
    // 本进程：1 条 running 档
    const store = new PilotStore(file, { maxRuns: 10 });
    const own = store.begin({ goal: '本进程任务', successCriteria: ['完成'] }, 1_000);
    assert.ok(own.startsWith('AUTO-'), 'begin 铸 token');
    // 模拟他进程：直接向档尾追加一条完整 snapshot 行（原子追加的外部视角）
    const foreign = {
      type: 'snapshot',
      record: {
        token: 'AUTO-FOREIGN1', goal: { goal: '他进程任务', successCriteria: ['x'] },
        startedAt: 2_000, updatedAt: 2_000, status: 'done', phase: 'achieved',
        steps: 1, trajectory: [], criteriaStatus: [{ criterion: 'x', status: 'met' }],
      },
    };
    writeFileSync(file, readFileSync(file, 'utf8') + JSON.stringify(foreign) + '\n', 'utf8');
    // 触发压缩：begin+finish 12 条 done 档 ⇒ 容量驱逐 ≥ 阈值（⌊10/10⌋=1）⇒ compactFile
    for (let i = 0; i < 12; i++) {
      const t = store.begin({ goal: `批量${i}`, successCriteria: ['完成'] }, 3_000 + i);
      store.finish(t, 'achieved', 'ok', 3_100 + i);
    }
    // 重载：他进程档案必须存活（ΠΑΝ-60 并档执法）
    const reloaded = new PilotStore(file, { maxRuns: 10 });
    const foreignRec = reloaded.load('AUTO-FOREIGN1');
    assert.ok(foreignRec, '压缩重写不吞他进程追加的档案（先并档后压缩）');
    assert.equal(foreignRec!.goal.goal, '他进程任务');
    assert.ok(reloaded.load(own), '本进程 running 档存活（running 永不驱逐）');
    // 追加原子性：档内无半行（每行皆可 JSON.parse）
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      assert.doesNotThrow(() => JSON.parse(line), `行完整（追加原子）：${line.slice(0, 60)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ═══ ΠΑΝ-61：否定判据三盲区 ═══

test('ΠΑΝ-61-a: ⑧′ 强制重采当帧 —— 瞬态违规不再逃逸（旧 digest 透支盲区封堵）', async () => {
  clearGlmEnv();
  // 剧本：环顶感知快照恒 clean（模拟免看门控跳过轮次/策略①点掉弹窗后的旧账），
  // 当帧重采端口读到禁词 ⇒ violated ⇒ failed 终局。
  const goal = new GoalStateMachine({ goal: '监控演示', successCriteria: ['mustNotAppear:出错提示'] }, () => 1);
  const deps: AutonomyDeps = {
    perceive: async () => cleanSnap(), // 旧 digest 恒空（违规不可见于旧账）
    policy: policyOf([clickAction('继续')]),
    execute: async () => ({ outcome: 'progress' }),
    goal,
    constitution: new AutonomyConstitution(),
    negativeRecheck: async () => '操作完成 出错提示 已自动处理', // 当帧实读见禁词
    sleep: async () => {},
    now: () => 1,
  };
  const res = await runAutonomousLoop(deps);
  assert.equal(res.phase, 'failed', '瞬态违规入账 ⇒ 证伪终局（不再逃逸）');
  // 对照：端口缺席 ⇒ 旧路径（旧 digest 语料缺席 ⇒ 零证据，不 failed）
  const goal2 = new GoalStateMachine({ goal: '监控演示', successCriteria: ['mustNotAppear:出错提示'] }, () => 1);
  const deps2: AutonomyDeps = {
    perceive: async () => cleanSnap(),
    policy: policyOf([clickAction('继续'), { kind: 'escalate', rationale: '收束', expectedEffect: 'e', utility: 0.4, riskTier: 'benign' }]),
    execute: async () => ({ outcome: 'progress' }),
    goal: goal2,
    constitution: new AutonomyConstitution(),
    sleep: async () => {},
    now: () => 1,
  };
  const res2 = await runAutonomousLoop(deps2);
  assert.notEqual(res2.phase, 'failed', '端口缺席 ⇒ 诚实降级零证据（否定判据不自动为真）');
});

test('ΠΑΝ-61-b: 截断前先扫禁词 —— 全文语料命中 + digest-truncated 诚实留痕', () => {
  // 禁词恰在 2000 字截断线之后：旧律下 textDigest 不可见 ⇒ 假 met
  const tail = '前奏'.repeat(1100) + '删除';
  const snap = composeSnapshot({ width: 10, height: 10, ocrText: tail });
  assert.equal(snap.textDigest.length, 2000, '截断律保持（上下文带宽礼仪）');
  assert.ok(!snap.textDigest.includes('删除'), '截断后禁词不可见（盲区的事实源）');
  assert.ok(snap.degraded.includes('digest-truncated'), '截断诚实留痕（部分证据不冒充全量）');
  // ΠΑΝ-61 执法面：以未截断全文评估（⑧′ 重采端口的语料形态）⇒ violated
  const ev = evaluateCriteria([{ text: 'mustNotAppear:删除', index: 0 }], tail);
  assert.equal(ev.evidence[0]?.status, 'violated', '全文（截断前）扫禁词 ⇒ 证伪不漏');
});

test('ΠΑΝ-61-c: 否定面 fuzzy 容错收紧 —— OCR 单字噪声不再假 violated', () => {
  // 容差律单元：两字禁词收紧到 0（精确）；长禁词逐渐放回 ⌈m/6⌉
  assert.equal(negativeFuzzyTolerance(2), 0, 'm=2 ⇒ 0（「册除」不再匹配「删除」）');
  assert.equal(negativeFuzzyTolerance(3), 1);
  assert.equal(negativeFuzzyTolerance(6), 1, 'm=6 三闸同值（长禁词既有容错不收紧）');
  assert.equal(negativeFuzzyTolerance(12), 2);
  assert.equal(negativeFuzzyTolerance(18), 3);
  // 否定面：单字噪声不假 violated
  const noise = evaluateCriteria([{ text: 'mustNotAppear:删除', index: 0 }], '页面显示 册除 完成');
  assert.equal(noise.evidence[0]?.status, 'met', 'OCR 单字噪声（册除≈删除）不再假 violated');
  const exact = evaluateCriteria([{ text: 'mustNotAppear:删除', index: 0 }], '页面显示 删除 完成');
  assert.equal(exact.evidence[0]?.status, 'violated', '精确命中照常证伪');
  // 肯定面零回归：宽容原律保持（⌈m/6⌉ 不受影响）
  const pos = evaluateCriteria([{ text: '删除文件夹', index: 0 }], '操作 册除文件夹 完成');
  assert.equal(pos.evidence[0]?.status, 'met', '肯定面 fuzzy 容错照旧（宽容是美德）');
});

test('ΠΑΝ-61-d: 探索步证据申报 —— 危险 label 申报 destructive / 未名元素携未知性标注入宪法 backgroundRisk', () => {
  const snap = composeSnapshot({
    width: 800, height: 600,
    localElements: [
      { label: '删除订单', bbox: { x0: 100, y0: 100, x1: 220, y1: 150 }, confidence: 0.9 },
      { label: '', bbox: { x0: 300, y0: 100, x1: 420, y1: 150 }, confidence: 0.7 },
      { label: '下一步', bbox: { x0: 500, y0: 100, x1: 620, y1: 150 }, confidence: 0.9 },
    ],
    ocrText: '删除订单 下一步',
  });
  const cands = buildExplorationCandidates(snap, { width: 800, height: 600 });
  const danger = cands.find(c => c.riskText === '删除订单');
  assert.ok(danger, '危险元素有候选');
  assert.equal(danger!.action.riskTier, 'destructive', '危险 label 证据申报 ⇒ destructive（宪法硬法恒审批）');
  const unnamed = cands.find(c => c.riskText === '' && c.modality === 'click');
  assert.ok(unnamed, '未名元素有候选');
  assert.equal(unnamed!.action.riskTier, 'benign', '未名元素保持 benign（不凭空猜险）');
  assert.equal((unnamed!.action.payload as { exploration?: { unknown?: boolean } }).exploration?.unknown, true,
    '未知性标注随步携带（诚实申报「语义未知」）');
  const plain = cands.find(c => c.riskText === '下一步');
  assert.equal(plain!.action.riskTier, 'benign');
  assert.equal((plain!.action.payload as { exploration?: { unknown?: boolean } }).exploration?.unknown, undefined,
    '具名元素不带未知标注');
  // 宪法消费面：unknownTarget ⇒ backgroundRisk 审计留痕（纯审计不顶格）
  const constitution = new AutonomyConstitution();
  const act = unnamed!.action as Act;
  const verdictUnknown = constitution.check(act, { goalText: '干净目标', consecutiveNoEffect: 0, stepsTaken: 0, unknownTarget: true });
  assert.equal(verdictUnknown.backgroundRisk, 'elevated', '未知目标 ⇒ 背景风险留痕');
  assert.match(verdictUnknown.reason, /ΠΑΝ-61/);
  const verdictPlain = constitution.check(act, { goalText: '干净目标', consecutiveNoEffect: 0, stepsTaken: 0 });
  assert.equal(verdictPlain.backgroundRisk, undefined, '无标注 ⇒ 判决形态与旧律一致');
  assert.equal(verdictUnknown.allowed, verdictPlain.allowed, '纯审计不顶格（裁决不变）');
});
