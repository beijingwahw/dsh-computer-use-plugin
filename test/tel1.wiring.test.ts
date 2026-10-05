// test/tel1.wiring.test.ts
// ΤΕΛ-1（ΤΕΛΟΣ 纪元 · 工单 ΤΕΛ-1）执法册 —— census 在册 6 个 unwired-organ
// 的通电行为验证（不是只测「被调用」：每根线都验证接线后**行为真实发生**）。
//
//   ① setAccessibilityProvider —— L1 UIA 树 provider（createUiaTreeProvider：
//     role 方言归一 edit→textbox / hyperlink→link、退化几何过滤、通道故障诚实
//     降级为空清单）+ index.ts 组合根接线源级断言（enableElementIdMode 门控）。
//   ② armSkillFederationPersistence —— 组合根真 apply（offline 假 ctx）：checkpoint
//     目录派生 skill-federation.json、武装生效、receive 突变 + 卸载 disposer 冲账
//     落盘、摘武装（热重载不残留）；无 checkpointPath ⇒ 零接线零磁盘。
//   ③ enforceMinedProperties —— self_diagnose 的 mine→enforce 闭环：立法 → 新段
//     违例 AMBER 上报 → 违例性质被重立法淘汰（世界变了旧法作废）。
//   ④ configureFailureMemory —— failureMemoryCapacityFromEnv 解析律 + index.ts
//     env 接线源级断言（缺省关：env 未设零调用）。
//   ⑤ clearBlockers —— steer_answer A（人工确认「继续」）放行运行期阻塞：blocked
//     相经判定律自动回归 acting；无阻塞 A 零行为变化（w3drift 既有测试另册锁定）。
//   ⑥ mergeSimilarTypes —— 改判 internal-surface 的论证锚：pipeline run-end 的
//     maintainCapacity 接线源级锁定（治理已通电源于维护幕，直连反而破坏纪律）。
// 全离线确定性：假 ctx（w0unload 同款）、tmp 目录、零网络零截屏零服务孵化。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import { Config, type Config as ConfigType } from '../src/config.ts';
import { apply } from '../src/index.ts';
import {
  setAccessibilityProvider, createUiaTreeProvider, hasAccessibilityProvider,
  extractInteractiveElements, type UiaTreeSnapshotLike,
} from '../src/uiExtractor.ts';
import {
  skillFederation, skillFingerprintOf, skillFederationPersistenceStatus,
  createSkillFedFileStore, loadSkillFederationLedger, wireSwarmSkillFederation,
} from '../src/skillFederation.ts';
import { createSelfDiagnoseTool } from '../src/tools/observabilityTools.ts';
import { journal } from '../src/journal.ts';
import { system } from '../src/system.ts';
import { GoalStateMachine } from '../src/autonomy/goalState.ts';
import { createSteerSession } from '../src/tools/steerTools.ts';
import { failureMemoryCapacityFromEnv, failureMemory, configureFailureMemory } from '../src/failureMemory.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const INDEX_SRC = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8');
const PIPELINE_SRC = readFileSync(join(ROOT, 'src', 'knowledge', 'pipeline.ts'), 'utf8');

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ─── w0unload 同款假 ctx / 配置工厂 ───

function makeFakeCtx() {
  const disposers: Array<() => void> = [];
  const ctx = {
    tools: { register: (_t: unknown) => { /* 装配成功以 apply 不抛为准 */ } },
    on: (_event: string, _handler: unknown) => () => { /* off */ },
    get: (_name: string) => undefined,
    emit: () => { /* 不消费 */ },
    effect: (register: () => () => void) => { disposers.push(register()); },
    reflect: { get: () => null },
  };
  return {
    ctx: ctx as unknown as Context,
    runDisposer: () => { for (const d of disposers) d(); },
  };
}

const parseConfig = Config as unknown as (over?: Record<string, unknown>) => ConfigType;
function makeConfig(over: Record<string, unknown> = {}): ConfigType {
  return parseConfig(over);
}

// ═══ ① setAccessibilityProvider：L1 UIA 树 provider ═══

test('ΤΕΛ-1①a: createUiaTreeProvider 真行为 —— role 方言归一（edit→textbox / hyperlink→link）+ 交互提取', async () => {
  const snapshot: UiaTreeSnapshotLike = {
    elements: [
      // python L1 词表方言：edit / hyperlink 在提取层 interactiveRoles 之外 —— 不归一则两大交互主力被滤空
      { role: 'Edit', name: 'search box', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 } },
      { role: 'Hyperlink', name: 'docs', rect: { x: 0.5, y: 0.5, width: 0.05, height: 0.02 } },
      { role: 'Button', name: 'OK', rect: { x: 0.8, y: 0.8, width: 0.05, height: 0.04 } },
      { role: 'checkbox', name: 'agree', rect: { x: 0.2, y: 0.6, width: 0.02, height: 0.02 } },
      // 非交互角色透传（提取层角色闸门自滤 —— 工厂不重复立法）
      { role: 'text', name: 'label', rect: { x: 0.3, y: 0.3, width: 0.1, height: 0.02 } },
      // 退化几何（零宽/NaN/负高）⇒ 永不入清单
      { role: 'button', name: 'degenerate', rect: { x: 0, y: 0, width: 0, height: 5 } },
      { role: 'button', name: 'nan', rect: { x: Number.NaN, y: 0, width: 5, height: 5 } },
      // 缺席 name ⇒ 提取层 [role] 占位（ΠΑΝ-110 三级 fallback 的工厂侧供料）
      { role: 'button', name: undefined, rect: { x: 0.9, y: 0.1, width: 0.03, height: 0.03 } },
      // 垃圾条目（null / 非对象）防御过滤
      null,
      42,
    ] as UiaTreeSnapshotLike['elements'],
  };
  setAccessibilityProvider(createUiaTreeProvider(async () => snapshot));
  assert.equal(hasAccessibilityProvider(), true, 'provider 已注入（组合根同款工厂）');
  const els = await extractInteractiveElements(true);
  const roles = els.map(e => e.role).sort();
  assert.deepEqual(roles, ['button', 'button', 'checkbox', 'link', 'textbox'],
    'edit→textbox、hyperlink→link 归一；退化几何/非交互角色/垃圾条目全部滤除');
  assert.ok(els.some(e => e.role === 'textbox' && e.name === 'search box'), 'edit 映射后可寻址');
  assert.ok(els.some(e => e.role === 'link' && e.name === 'docs'), 'hyperlink 映射后可寻址');
  assert.ok(els.some(e => e.role === 'button' && e.name === '[button]'), '缺席 name ⇒ [role] 占位（不回显 value）');
  // ID 稳定（缓存窗内重复提取不漂移 —— click_element 与 take_screenshot 握手基石）
  const again = await extractInteractiveElements();
  assert.deepEqual(again.map(e => e.id), els.map(e => e.id), '缓存窗内 ID 稳定');
});

test('ΤΕΛ-1①b: 通道故障诚实降级 —— fetchTree 抛错 ⇒ 空清单（与无 provider 时代的降级语义同构）', async () => {
  setAccessibilityProvider(createUiaTreeProvider(async () => {
    throw new Error('D-5 microservice unavailable');
  }));
  const els = await extractInteractiveElements(true);
  assert.deepEqual(els, [], '通道缺席 ⇒ 空清单（诚实降级，绝不孵化假树）');
  // 残缺快照（elements 缺席/非数组）同律防御
  setAccessibilityProvider(createUiaTreeProvider(async () => ({ elements: 'garbage' } as unknown as UiaTreeSnapshotLike)));
  assert.deepEqual(await extractInteractiveElements(true), [], '残缺快照 ⇒ 空清单');
});

test('ΤΕΛ-1①c: 组合根接线源级断言 —— index.ts 经 createUiaTreeProvider 注入 D-5 L1 通道且受 enableElementIdMode 门控', () => {
  assert.match(INDEX_SRC, /setAccessibilityProvider\(\s*\n?\s*createUiaTreeProvider\(\(\) => backend\.getUiTree\(\{ source: 'tree', funnelCeiling: 'L1' \}\)\)/,
    '组合根真接线：工厂包 D-5 L1 通道（不是只 import 不调用）');
  assert.match(INDEX_SRC, /if \(config\.enableElementIdMode\) \{/, '既有 config 开关门控在场');
  assert.match(INDEX_SRC, /import \{ setAccessibilityProvider, createUiaTreeProvider \} from '\.\/uiExtractor';/, '值导入在册');
});

// ═══ ② armSkillFederationPersistence：组合根武装 + 卸载收账 ═══

/** w7wire 同款聚合候选（接收端资格面 k=3） */
function aggCandidate(fp: string) {
  return {
    fingerprint: fp, aggregatedFrom: 3,
    slotStats: { dx: { median: 1, iqr: 0 }, dy: { median: 2, iqr: 0 } },
    reliability: 0.9, useCount: 5,
  };
}

test('ΤΕΛ-1②a: 组合根真 apply ⇒ 武装生效 + 突变经卸载冲账落盘 + 热重载摘武装', async () => {
  const tmp = tmpDir('tel1-skillfed-');
  const harness = makeFakeCtx();
  await apply(harness.ctx, makeConfig({
    vlmApiKey: 'tel1-offline-no-network',
    checkpointPath: join(tmp, 'checkpoint.json'),
  }));
  assert.equal(skillFederationPersistenceStatus().armed, true, 'checkpointPath 在场 ⇒ 组合根已武装（armSkillFederationPersistence 生产通电）');
  // 账本突变（1 次 < 节流阈值 8 ⇒ 尚未落盘 —— 卸载冲账是唯一通道）。
  // localSkillCount 显式注入（w7wire localPort 同形证据面：cap=⌊0.5×2⌋=1 ⇒ 注入 1 ⇒ 突变计数 +1）
  const fp = skillFingerprintOf('aabbccdd', [{ dx: 1 }, { dy: 2 }]);
  const rep = skillFederation.receive([aggCandidate(fp)], { rng: () => 0.99, localSkillCount: 2 });
  assert.equal(rep.injected, 1, '接收照常执法（持久化是旁路义务）');
  const fedPath = join(tmp, 'skill-federation.json');
  assert.equal(existsSync(fedPath), false, '未达节流阈值 ⇒ 尚无档');
  harness.runDisposer(); // 卸载链：skillFed.persist（flush 最后一程 + 摘武装）
  assert.equal(existsSync(fedPath), true, '卸载冲账把节流未及的突变落盘');
  const doc = JSON.parse(readFileSync(fedPath, 'utf8')) as { v: number; candidates: Array<{ fingerprint: string }> };
  assert.equal(doc.v, 1, '档 schema 版本');
  assert.ok(doc.candidates.some(c => c.fingerprint === fp), '落盘内容即账本态（候选在场）');
  assert.equal(skillFederationPersistenceStatus().armed, false, '卸载摘除武装（热重载不残留旧端口）');
  // 下次装载防御恢复：档可读、候选归位
  const restored = loadSkillFederationLedger(createSkillFedFileStore(fedPath));
  assert.equal(restored.restored, 1, '恢复即权威 —— 候选从档归位');
});

test('ΤΕΛ-1②b: 缺省零回归 —— checkpointPath 空 ⇒ 不武装不落盘（与接线前逐字节一致）', async () => {
  const tmp = tmpDir('tel1-skillfed-off-');
  const harness = makeFakeCtx();
  await apply(harness.ctx, makeConfig({
    vlmApiKey: 'tel1-offline-no-network',
    checkpointPath: '',
    skillLibraryPath: join(tmp, 'skills.json'),
  }));
  assert.equal(skillFederationPersistenceStatus().armed, false, '无 checkpoint 目录 ⇒ 纯内存（不建端口不武装）');
  harness.runDisposer(); // 卸载链 skillFed.persist 幂等 no-op
  assert.equal(existsSync(join(tmp, 'skill-federation.json')), false, '零磁盘');
});

// ═══ ③ enforceMinedProperties：self_diagnose 的 mine→enforce 闭环 ═══

async function appendTrace(tools: string[]): Promise<void> {
  for (const tool of tools) {
    // ACTION_TOOLS 词表内的真工具名（journal.append 对表外工具静默弃条 —— 立法门控）
    await journal.append({ ts: 0, tool, args: {}, status: 'ok' });
  }
}

async function runDiagnose(config: ConfigType): Promise<Array<{ subsystem: string; status: string; detail: string }>> {
  const tool = createSelfDiagnoseTool(config);
  const out = await (tool as unknown as { execute: (a: unknown) => Promise<string> }).execute({});
  return (JSON.parse(out) as { checks: Array<{ subsystem: string; status: string; detail: string }> }).checks;
}

test('ΤΕΛ-1③: mine→enforce 闭环 —— 立法 → 新段违例 AMBER 上报 → 违例旧法被重立法淘汰', async () => {
  const config = makeConfig({});
  journal.reset();
  journal.configure(true, '', 1000);
  // 隔离真截屏（self_diagnose 活体检查的旁路面 —— 观察行不参与本判决；w2audit 桩替换同律）
  const origCapture = system.captureScreen;
  system.captureScreen = async () => Buffer.from([0]);
  // 双工具交替（ACTION_TOOLS 词表内）：click→type 有界响应 + click/type 各自 repeat-guard
  const CLICK = 'click_mouse', TYPE = 'type_text';
  try {
    // 立法窗口：交替 6 步 ⇒ mined-response[click→type] + repeat-guard 双族铁律
    await appendTrace([CLICK, TYPE, CLICK, TYPE, CLICK, TYPE]);
    let checks = await runDiagnose(config);
    let row = checks.find(c => c.subsystem === 'mined-invariant-enforcement');
    assert.ok(row, '立法窗口开出执法行（性质库升格在线规约）');
    assert.equal(row!.status, 'GREEN');
    assert.match(row!.detail, /legislated/);
    // 新段零违例：再跑一次（无新迹）⇒ armed 状态如实申报
    checks = await runDiagnose(config);
    row = checks.find(c => c.subsystem === 'mined-invariant-enforcement');
    assert.equal(row!.status, 'GREEN', '无新段 ⇒ armed 待命');
    // 新段违例：click 紧接自身 ⇒ mined-repeat-guard[click_mouse] 违例（旧法执法于未来 —— AMBER 可见）
    await appendTrace([CLICK, CLICK]);
    checks = await runDiagnose(config);
    row = checks.find(c => c.subsystem === 'mined-invariant-enforcement');
    assert.equal(row!.status, 'AMBER', '违例 = 世界变了或立法过拟合 —— 两者都该被看见');
    assert.match(row!.detail, /mined-repeat-guard\[click_mouse\]/, '违例性质逐位点名');
    // 重立法后：全迹含反例 ⇒ repeat-guard[click_mouse] 不再立法（零反例律自动淘汰旧法）
    await appendTrace([TYPE, CLICK, TYPE]);
    checks = await runDiagnose(config);
    row = checks.find(c => c.subsystem === 'mined-invariant-enforcement');
    assert.ok(!row || row.status !== 'AMBER', '违例旧法已出局 —— 不再 AMBER（诚实：法随世界重铸）');
  } finally {
    system.captureScreen = origCapture;
    journal.reset();
  }
});

// ═══ ④ configureFailureMemory：env 解析律 + 组合根接线 ═══

test('ΤΕΛ-1④a: failureMemoryCapacityFromEnv 解析律 —— 合法正整数过闸，其余一律 null（缺省关）', () => {
  assert.equal(failureMemoryCapacityFromEnv(undefined), null, 'env 未设 ⇒ 零配置（缺省 30 钉死）');
  assert.equal(failureMemoryCapacityFromEnv(''), null, '空串 ⇒ 零配置');
  assert.equal(failureMemoryCapacityFromEnv('  '), null, '空白 ⇒ 零配置');
  assert.equal(failureMemoryCapacityFromEnv('5'), 5);
  assert.equal(failureMemoryCapacityFromEnv(' 128 '), 128, '首尾空白容忍');
  assert.equal(failureMemoryCapacityFromEnv('999999'), 999999, '上限内最大值过闸');
  for (const bad of ['0', '-3', '2.5', 'abc', '30x', '9999999']) {
    assert.equal(failureMemoryCapacityFromEnv(bad), null, `${bad} ⇒ 拒收（部署拼错不静默改库容）`);
  }
});

test('ΤΕΛ-1④b: 行为链 —— 解析值经 configureFailureMemory 真改库容（收缩即刻显著性淘汰）', () => {
  failureMemory.reset();
  const cap = failureMemoryCapacityFromEnv('3');
  assert.equal(cap, 3);
  configureFailureMemory({ capacity: cap! });
  for (let i = 0; i < 5; i++) failureMemory.record(`tel1-q${i}`, `tel1-a${i}`, 'no change');
  assert.equal(failureMemory.size, 3, '组合根同款链路（env→parse→configure）下库容 3 执法');
  failureMemory.reset();
  configureFailureMemory({ capacity: 30 }); // 归位（会话内测试隔离）
});

test('ΤΕΛ-1④c: 组合根接线源级断言 —— index.ts 消费解析器并受「未设零调用」缺省关纪律', () => {
  assert.match(INDEX_SRC, /failureMemoryCapacityFromEnv\(process\.env\.DSH_FAILURE_MEMORY_CAPACITY\)/, 'env 消费在册');
  assert.match(INDEX_SRC, /configureFailureMemory\(\{ capacity: fmCap \}\)/, '解析值直达配置面');
  assert.match(INDEX_SRC, /import \{ configureFailureMemory, failureMemoryCapacityFromEnv \} from '\.\/failureMemory';/, '值导入在册');
});

// ═══ ⑤ clearBlockers：steer_answer A = 人工确认放行 ═══

test('ΤΕΛ-1⑤: A 应答放行运行期阻塞 —— blocked 相经判定律自动回归 acting（含 C 后改主意的可逆路径）', () => {
  // w5steer 同源语料：英文锚点 × 中文屏幕零词重合 ⇒ sem≈1 ⇒ 漂移必超阈（出题确定性）
  const goal = new GoalStateMachine(
    { goal: 'open notepad and type hello', successCriteria: ['notepad window visible', 'hello typed'] },
    () => 1_000,
  );
  goal.begin();
  goal.addBlocker('W3-5 steer：用户在漂移评分 0.9 的抉择中选择终止（C）');
  assert.equal(goal.evaluate().phase, 'blocked', '前置：C 终止已铸运行期阻塞');
  const s = createSteerSession({ goal, screenText: () => '购物车 结算 优惠券 立即支付' });
  assert.ok(s.maybeCheckAndAsk(3, null) !== null, '前置：漂移出题在册');
  const r = s.answer('A');
  assert.equal(r.status, 'answered');
  assert.equal(r.choice, 'A');
  assert.match(r.hint ?? '', /放行/, '放行如实回显');
  assert.equal(goal.progress.blockers.length, 0, 'clearBlockers 已清账（人工确认 = 设计上的放行通道）');
  assert.equal(goal.evaluate().phase, 'acting', '相位由判定律自动回归（纯推导，无需显式转相）');
});

// ═══ ⑥ mergeSimilarTypes：改判 internal-surface 的论证锚 ═══

test('ΤΕΛ-1⑥: 治理已通电的源级锚 —— pipeline run-end 经 maintainCapacity 单点执法（mergeSimilarTypes 是其实现核）', () => {
  assert.match(PIPELINE_SRC, /sharedModel\.maintainCapacity\(\)/,
    'ΠΑΝ-47 维护幕在 pipeline run-end 生产接线（收拢+容量执法单点 —— mergeSimilarTypes 在其体内执法）');
  assert.match(PIPELINE_SRC, /WORLD_MODEL_MERGE_SWEEP_TYPES/, '触发阈值立法在源（碎片收拢门槛）');
});
