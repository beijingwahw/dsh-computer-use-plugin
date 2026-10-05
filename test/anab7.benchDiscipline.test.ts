// test/anab7.benchDiscipline.test.ts
// ΑΝΒ-7（决策 D9 升维）执法册：考核纪律 fail-closed 事前拦截。
//   7a 接线语义 —— opt-in 开 ⇒ mock 宿主 guard 收到 fail-closed 判决回调
//      （插件闭集全放行 / 宿主 shell·文件·run_code·未知一律拒）；
//      缺省关 ⇒ guard 零调用；通道缺席 ⇒ 诚实降级一行 log 绝不抛；
//   7b 单源锁 —— src 侧闭集镜像 === bench/anti-cheat.mjs PLUGIN_TOOL_NAMES
//      （逐名相等）+ HOST_TOOL_CLASS_MIRROR === HOST_TOOL_CLASSES（逐类相等）
//      + 装配面同源断言（buildAllTools 全开配置的注册名 ⊆ 放行闭集）；
//   7d 一行接线说明书在册（源级正则 —— 挂线说明不被无意抹除）。
// 全离线确定性：mock 宿主 ctx / 无网络 / 无真实守卫注册。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PLUGIN_TOOL_ALLOWLIST, NON_BARREL_PLUGIN_TOOLS, HOST_TOOL_CLASS_MIRROR,
  HOST_SESSION_CLASS_TOOLS, benchToolVerdict, applyBenchDiscipline,
} from '../src/guards/hostToolPolicy.ts';
import {
  PLUGIN_TOOL_NAMES, HOST_TOOL_CLASSES, classifyToolName,
} from '../bench/anti-cheat.mjs';
import { buildAllTools, MUTATING_TOOL_NAMES } from '../src/tools/index.ts';
import type { Config } from '../src/config.ts';

// ─── 测试基建：mock 宿主 ctx（tools.guard 通道 + effect 面）与 console 捕获 ───

interface GuardSpy {
  ctx: any;
  deciders: Array<(exec: unknown) => string | undefined>;
  effectFns: Array<() => unknown>;
  hostDisposed: () => number;
}
/** mock 宿主：guard 收回调（可注入「注册即抛」/「不返 disposer」两臂）。 */
function hostCtxWithGuard(opts: { throwOnGuard?: Error; noDisposer?: boolean } = {}): GuardSpy {
  const deciders: GuardSpy['deciders'] = [];
  const effectFns: GuardSpy['effectFns'] = [];
  let hostDisposed = 0;
  const ctx = {
    tools: {
      register: (_t: unknown) => {},
      guard(decider: (exec: unknown) => string | undefined) {
        if (opts.throwOnGuard) throw opts.throwOnGuard;
        deciders.push(decider);
        return opts.noDisposer ? undefined : () => { hostDisposed++; };
      },
    },
    effect(fn: () => unknown) { effectFns.push(fn); },
    on(_e: string, _h: unknown) {},
  };
  return { ctx, deciders, effectFns, hostDisposed: () => hostDisposed };
}

/** console 捕获（warn/log 各记一行原文；用后必须 restore）。 */
function captureConsole() {
  const warns: string[] = [];
  const logs: string[] = [];
  const ow = console.warn, ol = console.log;
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); };
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  return {
    warns, logs,
    restore() { console.warn = ow; console.log = ol; },
  };
}

const cfgOn = { benchDiscipline: true } as unknown as Config;
const cfgOff = { benchDiscipline: false } as unknown as Config;
const cfgUnset = {} as unknown as Config;

// ═══ 7b：单源锁（src 镜像 ↔ bench/anti-cheat ↔ tools 装配面）═══

test('7b-①: 插件闭集镜像 === anti-cheat PLUGIN_TOOL_NAMES（逐名相等，双源不漂移）', () => {
  assert.equal(PLUGIN_TOOL_ALLOWLIST.size, PLUGIN_TOOL_NAMES.length, '两侧规模相等（无单侧增删）');
  for (const name of PLUGIN_TOOL_NAMES) {
    assert.ok(PLUGIN_TOOL_ALLOWLIST.has(name), `anti-cheat 在册而 src 镜像缺席: ${name}`);
  }
  for (const name of PLUGIN_TOOL_ALLOWLIST) {
    assert.ok(PLUGIN_TOOL_NAMES.includes(name), `src 镜像在册而 anti-cheat 缺席: ${name}`);
  }
  // 闭集与宿主名册零重叠（anti-cheat A13 同律的 src 侧对偶）
  const hostNames = Object.values(HOST_TOOL_CLASSES).flat();
  for (const name of hostNames) {
    assert.ok(!PLUGIN_TOOL_ALLOWLIST.has(name), `插件闭集混入宿主名: ${name}`);
  }
});

test('7b-②: 装配面同源断言 —— buildAllTools 全开注册名 + barrel 外注册面 ⊆ 放行闭集', () => {
  const allOnCfg = {
    enableElementIdMode: true,
    localVisionApi: 'http://localhost:1/vision',
    enableUIMemory: true,
    enableJournal: true,
    enableOcr: true,
    vlmApiKey: 'anab7-test-key',
    autonomyEnabled: true,
    enableInteractivityProbe: true,
    enableOpenUrl: true,
    enableSkillLibrary: true,
    enableQualityDoctor: true,
    enableSubAgents: true,
    enableEnvironmentShaper: true,
    enableApprovalGate: true,
    enableTelemetry: true,
    checkpointPath: 'anab7-checkpoint.json',
    kernelEvolutionEnabled: true,
    federationEndpoint: 'http://localhost:1/federation',
  } as unknown as Config;
  // barrel 装配面（ΑΩ-R28 立法：注册名全员二分类 ⇒ 全员必须在闭集内；全开实配
  // 45 件 —— replay_on_host 实配注册在沙箱面，不在 barrel 输出）
  const registered = new Set(buildAllTools(allOnCfg).map((t) => t.name));
  // barrel 外注册面（w2audit S4-12 同款口径：沙箱四件 + 组合根元工具 = 5 名）
  for (const name of NON_BARREL_PLUGIN_TOOLS) registered.add(name);
  assert.ok(registered.size >= PLUGIN_TOOL_NAMES.length, `全开注册面不小于名册（${registered.size} ≥ ${PLUGIN_TOOL_NAMES.length}）`);
  for (const name of registered) {
    const v = benchToolVerdict(name);
    assert.equal(v.allow, true, `装配面工具被误拦（D9-A 回归风险面）: ${name}`);
    assert.equal(v.surface, 'plugin', `装配面工具分类须为 plugin: ${name}`);
  }
  // 变更类登记处（单源导出面）⊆ 闭集
  for (const name of MUTATING_TOOL_NAMES) {
    assert.ok(PLUGIN_TOOL_ALLOWLIST.has(name), `MUTATING 登记名缺席闭集: ${name}`);
  }
});

test('7b-③: HOST_TOOL_CLASS_MIRROR === anti-cheat HOST_TOOL_CLASSES（逐类相等）+ session 面派生单源', () => {
  assert.deepEqual(Object.keys(HOST_TOOL_CLASS_MIRROR).sort(), Object.keys(HOST_TOOL_CLASSES).sort(), '分类键一致');
  for (const [cls, names] of Object.entries(HOST_TOOL_CLASSES)) {
    assert.deepEqual(
      [...(HOST_TOOL_CLASS_MIRROR[cls] ?? [])].sort(),
      [...names].sort(),
      `分类 ${cls} 名单逐名相等`,
    );
  }
  // session 放行面只经分类表派生（host-meta ∪ host-job），不手抄
  const derived = new Set([...HOST_TOOL_CLASS_MIRROR['host-meta'], ...HOST_TOOL_CLASS_MIRROR['host-job']]);
  assert.deepEqual([...HOST_SESSION_CLASS_TOOLS].sort(), [...derived].sort(), 'session 面与分类表派生一致');
});

test('7b-④: 判决与 anti-cheat classifyToolName 七分类口径对齐（全量交叉）', () => {
  for (const name of PLUGIN_TOOL_NAMES) {
    assert.equal(classifyToolName(name).surface, 'plugin', `anti-cheat 侧插件面: ${name}`);
    assert.equal(benchToolVerdict(name).allow, true);
  }
  for (const [cls, names] of Object.entries(HOST_TOOL_CLASSES)) {
    const sessionCls = cls === 'host-meta' || cls === 'host-job';
    for (const name of names) {
      assert.equal(classifyToolName(name).surface, cls, `anti-cheat 侧 ${cls} 面: ${name}`);
      const v = benchToolVerdict(name);
      assert.equal(v.allow, sessionCls, `${cls} 工具 ${name} 的放行=${sessionCls}（session 类放行，其余拒）`);
      assert.equal(v.surface, cls);
    }
  }
  // 未知名：anti-cheat fail-closed 归 host-unknown；本侧同律拒
  const unk = classifyToolName('dsh_mystery_new_tool');
  assert.equal(unk.surface, 'host-unknown');
  const v = benchToolVerdict('dsh_mystery_new_tool');
  assert.equal(v.allow, false);
  assert.equal(v.surface, 'host-unknown');
});

// ═══ 7a：判决纯函数语义（total —— 任意输入必有判决，绝不抛）═══

test('7a-v1: 宿主写/shell/代码面拒 —— 理由成文且点名 surface', () => {
  for (const name of ['pwsh', 'bash', 'write', 'edit', 'read', 'grep', 'run_code']) {
    const v = benchToolVerdict(name);
    assert.equal(v.allow, false, `${name} 必拒（严格档：宿主文件只读也拒）`);
    assert.ok(!('allow' in v && v.allow));
    if (!v.allow) {
      assert.match(v.reason, /bench discipline: host-(shell|file|run-code|unknown|meta|job)/, `${name} 理由点名分类`);
      assert.match(v.reason, new RegExp(`"${name}"`), `${name} 理由点名工具名`);
    }
  }
});

test('7a-v2: session 类放行 —— host-meta / host-job 全量', () => {
  for (const name of HOST_SESSION_CLASS_TOOLS) {
    const v = benchToolVerdict(name);
    assert.equal(v.allow, true, `${name}（session 类）放行`);
    assert.ok(v.surface === 'host-meta' || v.surface === 'host-job');
  }
});

test('7a-v3: 空名/非字符串/病态输入 ⇒ fail-closed 拒且绝不抛（与 anti-cheat 空名归 plugin 的事后口径有意分歧并成文）', () => {
  for (const bad of ['', undefined, null, 42, {}, [], Symbol('x')]) {
    assert.doesNotThrow(() => benchToolVerdict(bad), `病态输入 ${String(bad)} 不抛`);
    const v = benchToolVerdict(bad);
    assert.equal(v.allow, false, `病态输入 ${String(bad)} 拒`);
    assert.equal(v.surface, 'none');
  }
});

// ═══ 7a：applyBenchDiscipline 接线语义 ═══

test('7a-w1: 缺省关 ⇒ disabled + guard 零调用 + 零日志（接线后不开启 = 逐字节等价）', () => {
  for (const cfg of [cfgOff, cfgUnset]) {
    const spy = hostCtxWithGuard();
    const cap = captureConsole();
    try {
      const out = applyBenchDiscipline(spy.ctx, cfg);
      assert.equal(out.status, 'disabled', '缺省关 ⇒ disabled');
      assert.equal(spy.deciders.length, 0, 'guard 零调用');
      assert.equal(spy.effectFns.length, 0, 'effect 零登记');
      assert.equal(cap.warns.length + cap.logs.length, 0, '零日志（关闭态静默 —— 不惊扰常规部署）');
    } finally { cap.restore(); }
  }
});

test('7a-w2: opt-in 开 + 通道在场 ⇒ enforced：guard 收到 fail-closed 判决回调（插件闭集全放行/宿主三类与未知拒）', () => {
  const spy = hostCtxWithGuard();
  const cap = captureConsole();
  try {
    const out = applyBenchDiscipline(spy.ctx, cfgOn);
    assert.equal(out.status, 'enforced');
    assert.equal(spy.deciders.length, 1, 'guard 恰注册一次');
    const decide = spy.deciders[0]!;
    // 全部插件工具名（与 anti-cheat 名册同源）⇒ undefined 放行
    for (const name of PLUGIN_TOOL_NAMES) {
      assert.equal(decide({ toolName: name }), undefined, `插件工具放行: ${name}`);
    }
    // 宿主 shell/文件/代码执行/未知 ⇒ 字符串拒
    for (const name of ['pwsh', 'shell', 'bash', 'powershell', 'write', 'edit', 'read', 'multiedit', 'apply_patch', 'list_dir', 'glob', 'grep', 'run_code', 'totally_unknown_tool']) {
      const deny = decide({ toolName: name });
      assert.ok(typeof deny === 'string' && deny.length > 0, `${name} 被拒且理由非空`);
      assert.match(deny!, /bench discipline/);
    }
    // session 类放行
    for (const name of HOST_SESSION_CLASS_TOOLS) {
      assert.equal(decide({ toolName: name }), undefined, `session 类放行: ${name}`);
    }
    // enforced 概要一行 log（审计可见性）
    assert.equal(cap.logs.length, 1, 'enforced 概要恰一行');
    assert.match(cap.logs[0]!, /BenchDiscipline.*Enforced/);
    assert.equal(cap.warns.length, 0, '无降级 warn');
    if (out.status === 'enforced') {
      assert.equal(out.allowedPluginTools, PLUGIN_TOOL_ALLOWLIST.size);
      assert.equal(out.allowedHostSessionTools, HOST_SESSION_CLASS_TOOLS.size);
    }
  } finally { cap.restore(); }
});

test('7a-w3: 宿主 exec 形状防御 —— toolName / name / tool.name 三读皆判，病态 exec 拒而不抛', () => {
  const spy = hostCtxWithGuard();
  applyBenchDiscipline(spy.ctx, cfgOn);
  const decide = spy.deciders[0]!;
  // R3-4 §3c 实证签名 exec.toolName；hooks.ts 事件面 exec.name —— 双形状都吃
  assert.equal(decide({ toolName: 'take_screenshot' }), undefined);
  assert.equal(decide({ name: 'take_screenshot' }), undefined);
  assert.ok(typeof decide({ toolName: 'pwsh' }) === 'string');
  assert.ok(typeof decide({ name: 'pwsh' }) === 'string');
  assert.ok(typeof decide({ tool: { name: 'write' } }) === 'string', 'tool.name 兜底读');
  // 病态 exec：绝不抛（抛进宿主瀑布 = 语义不可论），fail-closed 拒
  for (const bad of [null, undefined, 0, {}, { toolName: 42 }, { name: null }]) {
    assert.doesNotThrow(() => { decide(bad); }, `病态 exec ${JSON.stringify(bad) ?? String(bad)} 不抛`);
    const r = decide(bad);
    assert.ok(typeof r === 'string' && r.length > 0, '病态 exec ⇒ 拒（fail-closed）');
  }
});

test('7a-w4: disposer 回收 —— 宿主返 disposer ⇒ outcome.dispose 可用 + ctx.effect 登记回收臂', () => {
  const spy = hostCtxWithGuard();
  const out = applyBenchDiscipline(spy.ctx, cfgOn);
  assert.equal(out.status, 'enforced');
  assert.equal(spy.hostDisposed(), 0, '注册期不误触回收');
  assert.equal(spy.effectFns.length, 1, 'effect 登记一次');
  const cleanup = spy.effectFns[0]!();
  assert.equal(typeof cleanup, 'function', 'effect 回调返清理函数（cordis 注册即效果模型）');
  (cleanup as () => void)();
  assert.equal(spy.hostDisposed(), 1, '清理臂驱动宿主 disposer 恰一次');
  if (out.status === 'enforced' && out.dispose) {
    out.dispose();
    assert.equal(spy.hostDisposed(), 2, 'outcome.dispose 同样可用（测试/手动回收面）');
    out.dispose(); // 幂等性由宿主 disposer 自律；本侧吞其二次故障（不炸 unload）
    assert.equal(spy.hostDisposed(), 3);
  }
});

test('7a-w5: 宿主不返 disposer ⇒ dispose=null 诚实申报 + 不登记 effect', () => {
  const spy = hostCtxWithGuard({ noDisposer: true });
  const out = applyBenchDiscipline(spy.ctx, cfgOn);
  assert.equal(out.status, 'enforced');
  if (out.status === 'enforced') assert.equal(out.dispose, null, '无 disposer ⇒ null（不伪造）');
  assert.equal(spy.effectFns.length, 0, '无可回收物 ⇒ 不登记 effect');
});

test('7a-w6: 通道缺席 ⇒ 诚实降级一行 log 绝不抛（guard 面不在的宿主版本不受罚）', () => {
  const ctxNoTools = {} as any;
  const ctxEmptyTools = { tools: {} } as any;
  const ctxRegisterOnly = { tools: { register: () => {}, guard: 'not-a-function' } } as any;
  for (const ctx of [ctxNoTools, ctxEmptyTools, ctxRegisterOnly]) {
    const cap = captureConsole();
    try {
      let out: ReturnType<typeof applyBenchDiscipline> | null = null;
      try { out = applyBenchDiscipline(ctx, cfgOn); }
      catch (e) { assert.fail(`通道缺席不得抛（got: ${e instanceof Error ? e.message : String(e)}）`); }
      assert.ok(out !== null);
      assert.equal(out.status, 'degraded');
      assert.equal(out.status === 'degraded' && out.reason, 'host-guard-channel-absent');
      assert.equal(cap.warns.length, 1, '恰一行降级 log');
      assert.match(cap.warns[0]!, /benchDiscipline requested but host guard channel \(ctx\.tools\.guard\) is absent/, '降级文案点名请求与通道缺席');
      assert.equal(cap.logs.length, 0, '无 enforced log');
    } finally { cap.restore(); }
  }
});

test('7a-w7: guard 注册即抛 ⇒ 诚实降级（threw 档）绝不抛', () => {
  const spy = hostCtxWithGuard({ throwOnGuard: new Error('host guard exploded') });
  const cap = captureConsole();
  try {
    let out: ReturnType<typeof applyBenchDiscipline> | null = null;
    try { out = applyBenchDiscipline(spy.ctx, cfgOn); }
    catch (e) { assert.fail(`通道故障不得炸插件装载（got: ${e instanceof Error ? e.message : String(e)}）`); }
    assert.ok(out !== null);
    assert.equal(out.status, 'degraded');
    assert.equal(out.status === 'degraded' && out.reason, 'host-guard-channel-threw');
    assert.equal(cap.warns.length, 1);
    assert.match(cap.warns[0]!, /host guard channel threw/);
    assert.match(cap.warns[0]!, /host guard exploded/);
  } finally { cap.restore(); }
});

// ═══ 7d：一行接线说明书在册（源级正则锁定 —— 挂线指引不被无意抹除）═══

test('7d-①: hostToolPolicy.ts 尾部携带一行接线说明书（ΑΝΒ-4 挂线消费）', () => {
  const src = readFileSync(new URL('../src/guards/hostToolPolicy.ts', import.meta.url), 'utf8');
  assert.match(src, /applyBenchDiscipline\(ctx, config\);/, '接线说明书含成品调用式');
  assert.match(src, /import \{ applyBenchDiscipline \} from '\.\/guards\/hostToolPolicy';/, '接线说明书含 import 行');
  assert.match(src, /ΑΝΒ-7（D9 升维）/, '说明书锚定工单与决策号');
});

test('7d-②: config.benchDiscipline 缺省 false（opt-in 立法位）+ 接线函数缺省门', () => {
  const cfgSrc = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
  assert.match(cfgSrc, /benchDiscipline: Schema\.boolean\(\)\.default\(false\)/, 'schema 缺省 false');
  assert.match(cfgSrc, /benchDiscipline: boolean;/, 'interface 字段在册');
  // 缺省门源级锁定：applyBenchDiscipline 的唯一早退在一切 ctx 触达之前
  const polSrc = readFileSync(new URL('../src/guards/hostToolPolicy.ts', import.meta.url), 'utf8');
  assert.match(polSrc, /config\.benchDiscipline !== true[\s\S]{0,200}?return \{ status: 'disabled'/, '缺省关在通道探测前早退');
});
