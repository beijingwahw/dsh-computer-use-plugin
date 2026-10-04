// test/w5wire.test.ts
// W5-0（第四批集成接线收官包）执法册：把第四批器官的接线面逐条验证「接通且受控」：
//   ① incremental 键 + observer（index.ts 铸 visualDiff.incremental 内核键（缺省 0）
//      + buildAutonomyStack 在总闸开时就地补挂 deps.incrementalObserver —— runtime
//      的注入缝在组合根接通；总闸关 ⇒ 槽缺席零行为，显式注入优先）；
//   ② 联邦 wireSkill（wireSwarmSkillFederation 适配端口 + receive → noteLocalHit×2
//      两段激活经端口 addDormantSkill 登记 + match_skill 本地命中挂点源级断言 +
//      run_skill 排练场景源接通源级断言）；
//   ③ 派发分道三路（gateByReversibility：缺省关 / 未知语义不分道 / reversible 快道 /
//      compensable 托管道铸预案 / irreversible 人道拦截；arm 的 failureMemory
//      负证据端口行为 + index.ts 组合根接线源级断言）；
//   ④ 拍卖开关与状态面（config 缺省关 + enableStepAuction 接线源级断言 +
//      auctionStatus/auctionLedger 经 swarm_dispatch status 面投递 + 市场关 ⇒
//      附段缺席零回归）；
//   ⑤ GENESIS 数字一致（第四批九器官审判数字 8/37/12/32/12/12/0/11/9 与
//      Python 自测 58 断言申报在册 + INNOVATION.md 状态表同步）。
// 全离线确定性：注入随机源/时钟零真睡、无网络、单例测试后归位。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Config as ConfigSchema, type Config } from '../src/config.ts';
import { kernelRegistry } from '../src/kernel/index.ts';
// ① 的被测面（observer 缝在 buildAutonomyStack 接 —— runtime.ts 禁改）
import { buildAutonomyStack, type RuntimeDeps } from '../src/autonomy/index.ts';
import type { MacroTrace } from '../src/autonomy/index.ts';
// ② 的被测面
import {
  skillFederation, wireSwarmSkillFederation, skillFingerprintOf,
} from '../src/skillFederation.ts';
// ③ 的被测面
import { reversibilityRegistry, dispatchLaneFor } from '../src/riskGate.ts';
import { gateByReversibility } from '../src/tools/clickMouse.ts';
import { reversalEscrow } from '../src/reversalEscrow.ts';
import { failureMemory } from '../src/failureMemory.ts';
// ④ 的被测面
import { coordinator, AUCTION_EPOCH_K, type ConvergenceEvidence } from '../src/subAgent.ts';
import { createSwarmDispatchTool } from '../src/tools/swarmDispatch.ts';

// ─── 测试基建（离线确定性 + 单例归位） ───

/** 手写最小配置（缺字段按 falsy 缺省走零行为臂 —— w4wire 同法） */
function makeConfig(over: Partial<Config> = {}): Config {
  return {
    autonomyEnabled: false,
    ...(over as object),
  } as Config;
}

beforeEach(() => {
  reversibilityRegistry.reset(); // S5 注册表证据账/查询端口归零（w4reverse 同律）
  reversalEscrow.reset();        // 托管在途预案/账册归零
  failureMemory.reset();
  skillFederation.reset();       // 联邦候选/端口归零
  coordinator.reset();           // 名册/黑板/拍卖市场归零
});

afterEach(() => {
  reversibilityRegistry.reset();
  reversalEscrow.reset();
  failureMemory.reset();
  skillFederation.reset();
  coordinator.reset();
});

// ─── ① incremental 键 + observer（A 接线） ───

test('W5-A①: visualDiff.incremental 内核键生产铸入（源级）+ 缺省 0 = 总闸关', async () => {
  // index.ts 组合根铸键表达式（registerProductionKernels 同批——幂等注册）
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(
    src,
    /kernelRegistry\.register\(\{ key: 'visualDiff\.incremental', organ: 'perception', defaultValue: 0, min: 0, max: 1,/,
    'index.ts 必须铸 visualDiff.incremental（0/1，perception 域，缺省 0）',
  );
  // 测试进程内同键注册（幂等 —— 与生产铸入共存；值已存在则不覆写）
  kernelRegistry.register({ key: 'visualDiff.incremental', organ: 'perception', defaultValue: 0, min: 0, max: 1, note: 'W5-0 w5wire：测试内幂等注册' });
  assert.equal(kernelRegistry.getOrDefault('visualDiff.incremental', 0) <= 1, true, '键在册且域 [0,1]');
});

test('W5-A②: 总闸两向 —— 关 ⇒ observer 槽缺席（零回归）；开 ⇒ buildAutonomyStack 就地补挂；显式注入优先', async () => {
  kernelRegistry.register({ key: 'visualDiff.incremental', organ: 'perception', defaultValue: 0, min: 0, max: 1, note: 'W5-0 w5wire：测试内幂等注册' });
  const cfg = makeConfig({ autonomyEnabled: true });
  try {
    // 关向：缺省 0 ⇒ 槽缺席（感知行为与接线前逐字节一致）
    await kernelRegistry.set('visualDiff.incremental', 0);
    const depsOff: RuntimeDeps = {};
    buildAutonomyStack(cfg, depsOff);
    assert.equal(depsOff.incrementalObserver, undefined, '总闸关 ⇒ 观察槽不补挂（零回归红律）');

    // 开向：总闸开 ⇒ 槽就地补挂（runtime 的 incrementalObserver 注入缝在组合根接通）
    await kernelRegistry.set('visualDiff.incremental', 1);
    const depsOn: RuntimeDeps = {};
    buildAutonomyStack(cfg, depsOn);
    assert.ok(depsOn.incrementalObserver && typeof depsOn.incrementalObserver === 'object',
      '总闸开 ⇒ 观察槽在场（perceive 每帧写入 verdict + delivery）');
    assert.equal(depsOn.incrementalObserver!.current, null, '冷启动槽为空（诚实起点）');

    // 显式注入优先（只填缺席位 —— 测试假件不被覆盖）
    const own: NonNullable<RuntimeDeps['incrementalObserver']> = { current: null };
    const depsOwn: RuntimeDeps = { incrementalObserver: own };
    buildAutonomyStack(cfg, depsOwn);
    assert.equal(depsOwn.incrementalObserver, own, '调用方显式注入的观察槽优先（不覆盖）');
  } finally {
    await kernelRegistry.set('visualDiff.incremental', 0); // 归位（键值不外溢同文件后续测试）
  }
});

test('W5-A③: MacroTrace 桶导出补全（autonomy/index 的宏轨迹类型面）', () => {
  // type-only 断言：MacroTrace 经桶可导入且形状在册（编译期执法 + 运行时零面）
  const trace: MacroTrace | null = null;
  assert.equal(trace, null);
});

test('W5-A④: run_skill 排练场景源接通 + match_skill 联邦命中挂点（skillTools 源级）', () => {
  const src = readFileSync(new URL('../src/tools/skillTools.ts', import.meta.url), 'utf8');
  // 场景源接通：uiMemory 元素面 + contextManager 场景指纹加成（放行低可靠度排练）
  assert.match(src, /function rehearsalSceneFromMemory/, '排练场景铸造原语在册');
  assert.match(
    src,
    /scene: rehearsalSceneFromMemory\(/,
    'run_skill 的排练门禁场景源必须接 rehearsalSceneFromMemory（低可靠宏不再恒诚实拒绝）',
  );
  assert.match(src, /uiMemory\.recall\(/, '元素面 = uiMemory.recall（验证生效过的真实控件位）');
  assert.match(src, /contextManager\.lastImageRecord\(\)\?\.hash/, '场景指纹加成源 = contextManager（gaze 同源语境物料）');
  // 联邦本地命中挂点：match_skill 命中 ⇒ noteLocalHit（上传/激活同键指纹）
  assert.match(src, /noteFederationLocalHits\(hits\)/, 'match_skill 命中处回调联邦本地命中记账');
  assert.match(src, /skillFingerprintOf\(d\.sceneFingerprint, d\.stepsDigest\)/, '命中指纹与上传侧同键（联邦对账律）');
});

// ─── ② 联邦 wireSkill（B 接线） ───

/** index.ts 组合根同形状的适配端口（联邦草案 → 库登记方言的翻译面） */
function makeFedAdapter(): {
  port: Parameters<typeof wireSwarmSkillFederation>[0];
  registered: Array<{ skillId: string; origin: string; stepsDigest: Array<Record<string, number>> }>;
} {
  const registered: Array<{ skillId: string; origin: string; stepsDigest: Array<Record<string, number>> }> = [];
  return {
    registered,
    port: {
      // 闸①的本地证据面：本地有技能生态才掺外源候选（防外源漂移 —— 联邦立法）；
      // 闸②份额帽 cap = floor(0.5 × 本地 2 技) = 1 —— 恰容一个外源候选
      listSkillDigests: () => [
        { skillId: 'skill-1', sceneFingerprint: 'aabbccdd', stepsDigest: [{ dx: 1 }], reliability: 0.8 },
        { skillId: 'skill-2', sceneFingerprint: 'eeaabbcc', stepsDigest: [{ dy: 3 }], reliability: 0.6 },
      ],
      addDormantSkill: (draft) => {
        try {
          const entries = Object.entries(draft?.slotStats ?? {}).filter(([, v]) =>
            v && typeof v.median === 'number' && Number.isFinite(v.median));
          if (entries.length === 0) return false;
          const rec = {
            skillId: `fed-${draft.fingerprint}`,
            origin: 'federated',
            stepsDigest: entries.map(([k, v]) => ({ [k]: Math.round((v as { median: number }).median * 1000) / 1000 })),
          };
          registered.push(rec);
          return true;
        } catch {
          return false;
        }
      },
    },
  };
}

test('W5-B①: wireSwarmSkillFederation 两向 —— null 摘线诚实成功；形状坏端口拒绝', () => {
  assert.equal(wireSwarmSkillFederation(null), true, '显式摘线也是成功语义（缺省未接线态）');
  assert.equal(skillFederation.ledgerStats().wired, false, '摘线后账本观测面如实申报未接线');
  assert.equal(
    wireSwarmSkillFederation({ listSkillDigests: () => [] } as never),
    false,
    '形状坏端口（缺 addDormantSkill）⇒ 拒绝接线（诚实 false）',
  );
});

test('W5-B②: 接线 + receive → noteLocalHit×2 两段激活 —— 登记草案经适配端口落库方言', () => {
  const { port, registered } = makeFedAdapter();
  assert.equal(wireSwarmSkillFederation(port), true, '适配端口接线成功');
  assert.equal(skillFederation.ledgerStats().wired, true, '账本观测面申报已接线');

  // 聚合产物（k≥3 同指纹）注入：高 uniform ⇒ Thompson 采样通过、候选登记为 dormant
  const fp = skillFingerprintOf('aabbccdd', [{ dx: 1 }, { dy: 2 }]);
  const rep = skillFederation.receive(
    [{ fingerprint: fp, aggregatedFrom: 3, slotStats: { dx: { median: 1, iqr: 0 }, dy: { median: 2, iqr: 0 } }, reliability: 0.9, useCount: 5 }],
    { rng: () => 0.99 },
  );
  assert.equal(rep.injected, 1, '配额内候选通过 Thompson 采样登记');
  assert.equal(skillFederation.ledgerStats().dormant, 1, '登记即 dormant（绝不进匹配池）');

  // 两段激活：第一次命中只记账；第二次 ⇒ 经端口 addDormantSkill 登记并转 active
  const hit1 = skillFederation.noteLocalHit(fp);
  assert.equal(hit1.state, 'dormant', '首次命中不激活（本地证据门槛 2）');
  const hit2 = skillFederation.noteLocalHit(fp);
  assert.equal(hit2.activated, true, '第二次命中 ⇒ 激活');
  assert.equal(hit2.registered, true, '激活经端口登记（联邦无直达匹配池的写径）');
  assert.equal(registered.length, 1, '适配端口收到恰一份登记草案');
  assert.equal(registered[0].skillId, `fed-${fp}`, '登记方言：skillId = fed-<指纹>（溯源）');
  assert.equal(registered[0].origin, 'federated', '溯源 origin = federated');
  assert.deepEqual(registered[0].stepsDigest, [{ dx: 1 }, { dy: 2 }], '槽统计翻译为数值步摘要（中位数）');

  // 未知指纹的命中诚实忽略（本地巧合不臆造联邦候选）
  assert.equal(skillFederation.noteLocalHit('noscene:nothing').ok, false);

  // index.ts 组合根接线源级断言（生产血脉）
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(src, /wireSwarmSkillFederation\(\{/, 'index.ts 装载处一次 wireSwarmSkillFederation(skillLibrary 适配端口)');
  assert.match(src, /listSkillDigests: \(\) => skillLibrary\.listSkillDigests\(\)/, '摘要面直通真库契约');
});

// ─── ③ 派发分道三路（C 接线） ───

test('W5-C①: 缺省关零行为 —— enableReversibilityLanes 缺省 false ⇒ applied:false', async () => {
  const resolved = (ConfigSchema as unknown as (o: unknown) => Record<string, unknown>)({});
  assert.equal(resolved.enableReversibilityLanes, false, '分道开关缺省关（Schema 立法）');
  const gate = await gateByReversibility(makeConfig({ enableReversibilityLanes: false }), {
    tool: 'click_mouse', description: 'click 删除 to remove report.docx',
  });
  assert.deepEqual(gate, { applied: false, reason: 'disabled' }, '关 ⇒ 未分道（派发逐字节旧路）');
});

test('W5-C②: 三路执法 —— reversible 快道放行 / compensable 托管道铸预案 / irreversible 人道拦截', async () => {
  const cfg = makeConfig({ enableReversibilityLanes: true });

  // 快道：滚动语义可逆 —— 零新要求（与现状一致）
  const fast = await gateByReversibility(cfg, { tool: 'click_mouse', description: 'click 滚动 the page' });
  assert.equal(fast.applied, true);
  assert.equal(fast.verdict.level, 'reversible');
  assert.equal(fast.lane.lane, 'fast');
  assert.equal(fast.blocked, null, '快道不拦');

  // 托管道：file-delete 可补偿（escrow 策略表 compensate 键）—— 危险审批路径
  // 先铸 W3-1 逆转预案（approvalToken 随行 —— 结算钩子按令牌对账）再放行
  const escrow = await gateByReversibility(cfg, {
    tool: 'click_mouse', description: 'click 删除 to remove report.docx',
    approvalToken: 'APR-W5-C2', enforceEscrow: true,
  });
  assert.equal(escrow.applied, true);
  assert.equal(escrow.verdict.level, 'compensable');
  assert.equal(escrow.verdict.semantics, 'file-delete');
  assert.equal(escrow.lane.lane, 'escrow');
  assert.ok(typeof escrow.escrowPlanId === 'string' && escrow.escrowPlanId !== '', '预案 id 随行（补偿在途的审计锚点）');
  assert.equal(escrow.blocked, null, '预案铸成 ⇒ 放行');
  // W6-3 扩表后更新：text-input 已增补补偿路径（Ctrl+Z）⇒ 托管道铸成放行。
  // 原断言「策略表外的 compensable 语义（text-input）⇒ no-strategy fail-closed」
  // 编码的缺口已由 W6-3 策略表增补修复 —— riskGate 判 compensable 而策略表无键
  // 的自相矛盾不再存在；fail-closed 执法面由下方 manual-only 覆盖臂继续执法
  // （no-strategy 与 manual-only 是「没有可铸造的补偿路径 = 人类亲办或扩表」
  // 同一立法的两臂；mint 层的 no-strategy 面由 w3escrow S1-2a 未知语义执法）。
  const textInput = await gateByReversibility(cfg, {
    tool: 'type_text', approvalToken: 'APR-W5-C3', enforceEscrow: true,
  });
  assert.equal(textInput.applied, true);
  assert.equal(textInput.verdict.semantics, 'text-input');
  assert.ok(typeof textInput.escrowPlanId === 'string' && textInput.escrowPlanId !== '', 'text-input 预案铸成（W6-3 增补 Ctrl+Z 补偿路径）');
  assert.equal(textInput.blocked, null, '策略表命中 ⇒ 放行（fail-closed 只对无策略/manual-only 生效）');
  // fail-closed 执法面仍在：注入扩展把 navigation 覆盖为 manual-only ⇒ 铸造被拒
  //（gate 层经自然词表已无法产生 no-strategy —— 全部 builtin compensable 键
  //  扩表后都有策略，以注入覆盖臂执法同一条 fail-closed 路径）
  reversalEscrow.arm({ strategies: [{ kind: 'manual-only', semantics: 'navigation', reason: 'deployment override: back-navigation compensation disabled — the HUMAN must perform this personally' }] });
  const noStrategy = await gateByReversibility(cfg, {
    tool: 'open_url', approvalToken: 'APR-W5-C3b', enforceEscrow: true,
  });
  assert.equal(noStrategy.applied, true);
  assert.ok(noStrategy.blocked !== null, 'manual-only 覆盖的 compensable 执法路径 fail-closed');
  const nsBody = JSON.parse(noStrategy.blocked!) as { state_anchor: { reason: string; reversibility: { mint_failure: string } } };
  assert.equal(nsBody.state_anchor.reason, 'reversibility-escrow-unavailable');
  assert.equal(nsBody.state_anchor.reversibility.mint_failure, 'manual-only');
  reversalEscrow.arm({ strategies: [] }); // 撤销注入覆盖（恢复内置表 —— 用例内隔离）
  // 非执法路径（enforceEscrow 缺省 false）：只注记不铸造（无结算语义的铸造 = 泄漏面）
  const noteOnly = await gateByReversibility(cfg, { tool: 'type_text' });
  assert.equal(noteOnly.applied, true);
  assert.equal(noteOnly.escrowPlanId, undefined, '非审批路径不铸预案（诚实注记）');

  // 人道：发送语义不可逆 —— 交还人类（自动化派发被拒）
  const human = await gateByReversibility(cfg, { tool: 'click_mouse', description: 'click 发送 to send the email' });
  assert.equal(human.applied, true);
  assert.equal(human.verdict.level, 'irreversible');
  assert.equal(human.lane.lane, 'human');
  assert.deepEqual(human.lane, dispatchLaneFor('irreversible'), '与 dispatchLaneFor 纯函数同判');
  assert.ok(human.blocked !== null, 'irreversible ⇒ 结构化拒绝回执');
  const body = JSON.parse(human.blocked!) as { status: string; state_anchor: { reason: string } };
  assert.equal(body.status, 'ACTION_REQUIRED');
  assert.equal(body.state_anchor.reason, 'reversibility-human-lane');
});

test('W5-C③: 未知语义不分道（分级知识缺席交回危险词闸门）+ 分道闸绝不抛', async () => {
  const cfg = makeConfig({ enableReversibilityLanes: true });
  const unknown = await gateByReversibility(cfg, { tool: 'click_mouse', description: 'frobnicate the quux widget' });
  assert.deepEqual(unknown, { applied: false, reason: 'unknown-semantics' }, '未注册语义 ⇒ 未分道（两道保守律各守各的门）');
  // 防御式：脏输入收敛为未分道，绝不抛
  const dirty = await gateByReversibility(cfg, null as never);
  assert.equal(dirty.applied, false);
});

test('W5-C④: arm 负证据端口 —— failureMemory.match 计数折算 adverse ⇒ 证据门翻级（组合根接线源级）', async () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(
    src,
    /reversibilityRegistry\.arm\(\{\s*\r?\n\s*negativeEvidenceQuery: \(semantics: string\): number => \{/,
    'index.ts 必须 arm failureMemory 负证据只读查询端口',
  );
  assert.match(src, /failureMemory\.match\(semantics, undefined, 5\)\.length/, '计数源 = failureMemory.match 命中数（k=5）');

  // 行为：2 条可召回的同语义失败记忆 ⇒ adverse=2、posterior 3/4 ≥ 0.5 ⇒ 证据门升一级
  // （record 是位置参数：query, approach, symptom —— 同语义词面使 match 命中）
  failureMemory.record('viewport-scroll scroll the page', 'wheel', 'viewport-scroll not moved');
  failureMemory.record('viewport-scroll again', 'keys', 'viewport-scroll stuck');
  reversibilityRegistry.arm({ negativeEvidenceQuery: s => failureMemory.match(s, undefined, 5).length });
  const one = reversibilityRegistry.classify({ description: '滚动 the page down' });
  assert.equal(one.source, 'calibrated', '瞬态负证据合并触发证据门');
  assert.equal(one.level, 'compensable', 'reversible + adverse 2 ⇒ 升一级（单事件不翻级、双证据升一级的门槛）');
  assert.equal(dispatchLaneFor(one.level).lane, 'escrow', '派发道随级切换（fast → escrow）');
  // 再 2 条（adverse=4、posterior 5/6 ≈ 0.83 ≥ 0.75）⇒ 两级直升 —— 分道面换人道
  failureMemory.record('viewport-scroll third', 'drag', 'viewport-scroll still stuck');
  failureMemory.record('viewport-scroll fourth', 'hotkey', 'viewport-scroll dead');
  const two = reversibilityRegistry.classify({ description: '滚动 the page down' });
  assert.equal(two.level, 'irreversible', 'adverse 4 + posterior ≥0.75 ⇒ 两级直升（人道）');
  assert.equal(dispatchLaneFor(two.level).humanExecution, true, '翻级同步改变派发道（S5 → S5-5 的组合律）');
});

// ─── ④ 拍卖开关与状态面（D 接线） ───

test('W5-D①: enableStepAuction 缺省关 + 组合根接线源级（经验晶体聚合端口）', () => {
  const resolved = (ConfigSchema as unknown as (o: unknown) => Record<string, unknown>)({});
  assert.equal(resolved.enableStepAuction, false, '拍卖开关缺省关（各代理独立预算逐字节旧路）');
  assert.equal(resolved.stepAuctionBudget, 0, '外注预算缺省 0 = 名册推导（Σ maxSteps，总额与现状等价）');

  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(src, /if \(config\.enableStepAuction\) \{/, 'index.ts 按配置开启市场');
  assert.match(src, /coordinator\.enableStepAuction\(\{/, 'enableStepAuction 组合根接线（budget/port）');
  assert.match(src, /swarm\.counterfactual\(seed, 8\)/, '证据端口从经验晶体按出生场景指纹聚合（counterfactual 同源）');
});

test('W5-D②: 市场开 ⇒ swarm_dispatch status 附拍卖摘要面；chargeStep 过 K ⇒ 账本记拍卖轮', async () => {
  const tool = createSwarmDispatchTool(makeConfig({ enableStepAuction: true }));
  const exec = (tool as unknown as { execute: (a: unknown) => Promise<string> }).execute.bind(tool);

  // 组队 + 开市（证据端口注入：确定性收敛证据）
  coordinator.configure(3, 10);
  coordinator.spawn([
    { id: 'a', role: 'r1', objective: 'o1', maxSteps: 6 },
    { id: 'b', role: 'r2', objective: 'o2', maxSteps: 6 },
  ]);
  const evidence = (agentId: string): ConvergenceEvidence | null =>
    agentId === 'a' ? { successes: 3, attempts: 4 } : { successes: 1, attempts: 4 };
  assert.equal(coordinator.enableStepAuction({ port: { evidence } }), true, '开市成功（幂等）');

  const st = coordinator.auctionStatus();
  assert.equal(st.enabled, true);
  assert.equal(st.budget, null, '未外注预算 ⇒ 名册推导（12 步池）');
  assert.equal(st.poolRemaining, 12, '池 = Σ maxSteps（总预算与现状等价）');

  // 状态面投递：spawn 组队行 + status 名册行都携带拍卖摘要
  const spawnOut = await exec({ action: 'spawn', specs: JSON.stringify([{ id: 'c', role: 'r3', objective: 'o3', maxSteps: 2 }]) });
  assert.match(spawnOut, /\[Step auction\] pool \d+ steps remaining/, 'spawn 输出附池况摘要');
  const statusOut = await exec({ action: 'status' });
  assert.match(statusOut, /\[Step auction\]/, 'status 输出附市场全貌');
  assert.match(statusOut, /epoch step \d+\/10/, 'K=10 轮内步进可见');

  // 扣费跨过 K ⇒ 重拍卖落账（genesis 轮 + 至少一轮实际拍卖）
  for (let i = 0; i <= AUCTION_EPOCH_K + 1; i++) coordinator.chargeStep('click_mouse');
  const ledger = coordinator.auctionLedger();
  assert.ok(ledger.length >= 2, '账本 ≥ 2 轮（genesis + 实际拍卖）');
  const last = ledger[ledger.length - 1];
  assert.ok(last.agents.length >= 3, '在市代理各有配额分账（饿死防护每代理 ≥1 步）');
  assert.ok(last.agents.every(b => b.quota >= 1), '每代理每轮至少 1 步保底');
  // 证据端口消费：a 的先验（3/4 收敛）应高于 b（1/4）⇒ 出价差在场
  const aBid = last.agents.find(x => x.agentId === 'a');
  const bBid = last.agents.find(x => x.agentId === 'b');
  assert.ok(aBid && bBid && aBid.prior > bBid.prior, '经验晶体聚合的收敛先验进入出价（a 3/4 > b 1/4）');

  // 关闭向：市场关 ⇒ 附段缺席（输出与接线前逐字节一致 —— 零回归红律）
  coordinator.disableStepAuction();
  const off = await exec({ action: 'status' });
  assert.doesNotMatch(off, /\[Step auction\]/, '市场关 ⇒ 摘要附段缺席');
  assert.equal(coordinator.auctionStatus().enabled, false);
});

// ─── ⑤ GENESIS 数字一致（E 收官） ───

test('W5-E①: GENESIS 第四批九器官审判数字在册且与执法册一致（8/37/12/32/12/12/0/11/9）', () => {
  const genesis = readFileSync(new URL('../GENESIS.md', import.meta.url), 'utf8');
  // 第四批纪元段在册
  assert.match(genesis, /纪元 W4/, 'GENESIS 登记 W4 纪元');
  // 段内提取审判列的 N/0 数字（按行序）
  const section = genesis.split(/## /).find(s => s.includes('纪元 W4')) ?? '';
  assert.ok(section.length > 0, 'W4 纪元段落可定位');
  const nums = [...section.matchAll(/\| (\d+)\/0/g)].map(m => Number(m[1]));
  assert.deepEqual(
    nums,
    [8, 37, 12, 32, 12, 12, 0, 11, 9],
    '九器官审判数字（集成接线/宏重放/策略联邦/可逆性体系/PCG训练营/移动Surface/零API设备面/步数拍卖/声学通道）',
  );
  assert.match(genesis, /Python ?自测 ?58 ?断言/, '零 API 设备面的 Python 自测 58 断言申报在册');
  // 九器官名在册
  for (const organ of ['集成接线', '宏重放', '策略联邦', '可逆性体系', 'PCG', '训练营|移动', 'Surface', '零 ?API', '步数拍卖', '声学']) {
    assert.ok(section.includes(organ.replace(/\|/, '')) || new RegExp(organ).test(section), `器官面在册：${organ}`);
  }
});

test('W5-E②: INNOVATION 状态表同步 —— W4 潮段 + 九行接线状态在册', () => {
  const innovation = readFileSync(new URL('../INNOVATION.md', import.meta.url), 'utf8');
  assert.match(innovation, /W4 .{0,12}(潮|批)/, 'INNOVATION 登记第四批（W4 潮）状态段');
  assert.match(innovation, /W4-1 宏重放/, '宏重放行在册');
  assert.match(innovation, /W4-2 策略联邦/, '策略联邦行在册');
  assert.match(innovation, /W4-3 可逆性体系/, '可逆性体系行在册');
  assert.match(innovation, /W4-7 步数拍卖/, '步数拍卖行在册');
  assert.match(innovation, /W4-8 声学/, '声学通道行在册');
  assert.match(innovation, /W5-0/, 'W5-0 集成接线收官在册');
});
