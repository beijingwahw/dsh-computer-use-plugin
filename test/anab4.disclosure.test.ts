// test/anab4.disclosure.test.ts
// ΑΝΒ-4（D5 缺席披露制度）执法册 —— 「工具静默缺席」终结者的三面执法：
//   ① 缺省翻转（能力腿）：enableOcr 缺省 true ⇒ read_text/find_text 缺省配置即挂载；
//      autonomyEnabled/enableElementIdMode 保持缺省 false（D5-C 安全/资源边界）。
//   ② 披露清单精确性（升维核心）：三开/三关组合下，「因配置缺席未挂载的工具清单」
//      必须逐门逐工具精确（缺一个即红 —— 册、谓词、装配面三方对账）。
//   ③ 三通道在场：doctor 规则 config.silent-tool-absence 触发面；
//      观测面（get_metrics tool_face / dashboard 工具区行）消费组合根记账。
// 单源律：缺席计算全部经 src/config.ts 的 CONFIG_GATED_TOOLS 册 —— 本册不复制
// 清单，只对账（册上缺席的工具必须在缺席清单里；门开的工具必须在挂载集里）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config.ts';
import {
  CONFIG_GATED_TOOLS,
  predictConfigToolAbsence,
  observeToolFaceAbsence,
  recordToolFaceDisclosure,
  getToolFaceDisclosure,
} from '../src/config.ts';
import type { Config as ConfigType } from '../src/config.ts';
import { buildAllTools } from '../src/tools/index.ts';
import { createGetMetricsTool } from '../src/tools/observabilityTools.ts';
import { DOCTOR_RULES_CORE } from '../src/doctorRules.core.ts';
import type { ScanContext } from '../src/doctorTypes.ts';

// schemastery 节点即解析函数（configDocs.test.ts 同律）：缺省解析/部分覆写。
type ResolveFn = (input?: Record<string, unknown>) => Record<string, unknown>;
const resolve = (v?: Record<string, unknown>): ConfigType =>
  (Config as unknown as ResolveFn)(v) as unknown as ConfigType;

const runJson = async (t: unknown, a: unknown): Promise<any> =>
  JSON.parse(String(await (t as { execute: (a: unknown, e: unknown) => Promise<unknown> }).execute(a, undefined)));

const mkCtx = (config: unknown): ScanContext => ({
  sources: [],
  chain: { entries: [], chainIntact: true },
  snapshot: null,
  config: config as ConfigType,
  warn: () => {},
});

// D5 三开关族的工具面（册上单源取 —— 本册不复制清单字面）
const gateTools = (key: string): readonly string[] =>
  CONFIG_GATED_TOOLS.find(g => g.key === key)?.tools ?? [];

// ═══ ① 缺省翻转（ΑΝΒ-4a · 能力腿）═══

test('ΑΝΒ-4a: enableOcr 缺省翻 true（C 案能力腿）；autonomyEnabled/enableElementIdMode 保持缺省 false（D5-C 安全/资源边界）', () => {
  const d = resolve({});
  assert.equal(d.enableOcr, true, 'enableOcr 缺省 true —— read_text/find_text 部署首日即在场');
  assert.equal(d.autonomyEnabled, false, 'autonomyEnabled 保持 opt-in（安全姿态不变）');
  assert.equal(d.enableElementIdMode, false, 'enableElementIdMode 保持 opt-in（资源姿态不变）');
  // 显式 false 仍可关（能力腿不剥夺 opt-out）
  assert.equal(resolve({ enableOcr: false }).enableOcr, false);
});

test('ΑΝΒ-4a 装配面执法: 缺省配置 buildAllTools 即挂载 read_text/find_text；显式关则缺席（部署陷阱根除）', () => {
  const names = (c: ConfigType) => buildAllTools(c).map(t => t.name);
  const def = names(resolve({}));
  assert.ok(def.includes('read_text'), '缺省配置 read_text 在场（此前「部署首日即不可达」）');
  assert.ok(def.includes('find_text'), '缺省配置 find_text 在场');
  // 显式 opt-out：缺席成立且披露面看得见（observe 用真实装配集对账）
  const off = names(resolve({ enableOcr: false }));
  assert.ok(!off.includes('read_text') && !off.includes('find_text'), '显式 false ⇒ 两工具不挂载');
  const absent = observeToolFaceAbsence(off, resolve({ enableOcr: false }), { vlmLive: false });
  const ocrGate = absent.find(g => g.key === 'enableOcr');
  assert.ok(ocrGate, '缺席清单点名 enableOcr 门');
  assert.deepEqual([...(ocrGate?.tools ?? [])], ['read_text', 'find_text'], '缺席工具逐名精确');
  assert.equal(ocrGate?.gateOn, false, '门当前态如实（关而缺席 = opt-in）');
});

// ═══ ② 披露清单精确性（ΑΝΒ-4b · 升维核心）═══

test('ΑΝΒ-4b 三关组合: 缺席清单逐门逐工具精确（D5 三开关 + 缺省关的端点/复合门；缺一个即红）', () => {
  const cfg = resolve({
    enableOcr: false, enableElementIdMode: false, autonomyEnabled: false, enableSandboxStack: false,
  });
  // 观察面：真实装配集（此组合下沙箱栈不装配 ⇒ 四件演武工具缺席）
  const mounted = new Set(buildAllTools(cfg).map(t => t.name));
  const absent = observeToolFaceAbsence(mounted, cfg, { vlmLive: false });
  const byKey = new Map(absent.map(g => [g.key, g]));

  // D5 三开关门：工具名与门键精确配对（gateTools 从册上单源取）
  assert.deepEqual([...(byKey.get('enableOcr')?.tools ?? [])], [...gateTools('enableOcr')], 'enableOcr 门缺席面');
  assert.deepEqual([...(byKey.get('enableElementIdMode')?.tools ?? [])], [...gateTools('enableElementIdMode')], 'elementId 门缺席面');
  assert.deepEqual([...(byKey.get('autonomyEnabled')?.tools ?? [])], [...gateTools('autonomyEnabled')], 'autonomy 门缺席面（四件元工具）');
  assert.deepEqual([...(byKey.get('enableSandboxStack??autonomyEnabled')?.tools ?? [])], [...gateTools('enableSandboxStack??autonomyEnabled')], '沙箱门缺席面（桶外装配面照点名）');

  // 缺省关的端点/复合/env 门也在清单里（任何配置组合的缺席都可被机器看见）
  for (const key of ['localVisionApi', 'vlmApiKey(+env)', 'checkpointPath', 'kernelEvolutionEnabled||federationEndpoint']) {
    assert.ok(byKey.has(key), `缺省关门 ${key} 必须在缺席清单`);
  }

  // 精确性负空间：缺省开门（UIMemory/Journal/Telemetry 等）不在缺席清单
  for (const key of ['enableUIMemory', 'enableJournal', 'enableTelemetry', 'enableSkillLibrary', 'enableApprovalGate']) {
    assert.ok(!byKey.has(key), `开门 ${key} 不得出现在缺席清单（缺一个即红的反面：多报一个也红）`);
  }
  // 挂载集与缺席清单零交集（对账不变量）
  for (const g of absent) for (const t of g.tools) assert.ok(!mounted.has(t), `${t} 不得同时挂载又缺席`);
});

test('ΑΝΒ-4b 三开组合: 三开关全开 ⇒ 相关工具零缺席（含沙箱门 —— 桶外装配面对账）', () => {
  const cfg = resolve({
    enableOcr: true, enableElementIdMode: true, autonomyEnabled: true, enableSandboxStack: true,
  });
  const mounted = new Set(buildAllTools(cfg).map(t => t.name));
  // 沙箱门开 ⇒ 四件演武工具按组合根观察面并入挂载集（index.ts 同律）
  for (const n of gateTools('enableSandboxStack??autonomyEnabled')) mounted.add(n);
  const absent = observeToolFaceAbsence(mounted, cfg, { vlmLive: false });
  const absentAll = absent.flatMap(g => g.tools);
  const family = [
    ...gateTools('enableOcr'), ...gateTools('enableElementIdMode'),
    ...gateTools('autonomyEnabled'), ...gateTools('enableSandboxStack??autonomyEnabled'),
  ];
  for (const t of family) {
    assert.ok(!absentAll.includes(t), `三开后 ${t} 不得再缺席`);
    assert.ok(mounted.has(t), `三开后 ${t} 必须在挂载集`);
  }
});

test('ΑΝΒ-4b 装配面反哺对账: 门开的每个工具都真实装配（册 ↔ buildAllTools 单源不漂移）', () => {
  // 全开配置（w2audit allOnCfg 同族 + 沙箱 + 端点/env 门全点亮）
  const cfg = resolve({
    enableOcr: true, enableElementIdMode: true, autonomyEnabled: true, enableSandboxStack: true,
    localVisionApi: 'http://localhost:1/vision', vlmApiKey: 'anab4-test-key',
    checkpointPath: 'anab4-checkpoint.json', kernelEvolutionEnabled: true, federationEndpoint: 'http://localhost:1/f',
  });
  const mounted = new Set(buildAllTools(cfg).map(t => t.name));
  for (const n of gateTools('enableSandboxStack??autonomyEnabled')) mounted.add(n);
  const absent = observeToolFaceAbsence(mounted, cfg, { vlmLive: true });
  assert.equal(absent.length, 0, `全开 ⇒ 缺席清单为空（实际缺席: ${JSON.stringify(absent)}）`);
  // 每个开门的工具都确实装配（册上新增门控工具而装配面未跟 ⇒ 此处红）
  for (const g of CONFIG_GATED_TOOLS) {
    const on = g.envSensitive ? true : g.mounted(cfg);
    if (on) for (const t of g.tools) assert.ok(mounted.has(t), `门 ${g.key} 开 ⇒ ${t} 必须装配`);
  }
});

test('ΑΝΒ-4b 预测面（医生视角）: 纯 config 谓词缺席清单 + env 敏感门的 envView 注入', () => {
  const cfg = resolve({ enableOcr: true, autonomyEnabled: false });
  // envLive=false：vlm 门缺席（config 字面关且无 env）
  let absence = predictConfigToolAbsence(cfg, { vlmLive: false });
  assert.ok(absence.some(g => g.key === 'vlmApiKey(+env)'), 'env 关 ⇒ vlm 门缺席');
  // envLive=true：env 在场 = 已挂载，不误报（config 字面关 ≠ 真缺席）
  absence = predictConfigToolAbsence(cfg, { vlmLive: true });
  assert.ok(!absence.some(g => g.key === 'vlmApiKey(+env)'), 'env 在场 ⇒ vlm 门不误报缺席');
  // 缺省开 OCR 不在预测缺席清单（翻转后的能力面缺省）
  assert.ok(!absence.some(g => g.key === 'enableOcr'), '缺省开的 OCR 不缺席');
});

// ═══ ③ 三通道在场（doctor 规则 + 观测面）═══

test('ΑΝΒ-4b 通道 a: doctor 规则 config.silent-tool-absence 触发面（info 级；点名工具+开键；全亮零命中；未绑配置零伪造）', async () => {
  const rule = DOCTOR_RULES_CORE.find(r => r.id === 'config.silent-tool-absence')!;
  assert.ok(rule, '规则在册（doctorRules.core）');
  assert.equal(rule.severity, 'info', 'info 级 —— 缺席不是病，静默才是');
  assert.equal(rule.category, 'genesis');
  assert.deepEqual(rule.laws, ['honest-degradation', 'config-driven']);

  // 触发：绑定缺省配置（autonomy/elementId 缺省关）⇒ 单 finding 点名工具与键
  const findings = await rule.scan(mkCtx(resolve({})));
  assert.equal(findings.length, 1, '缺席即披露（单 finding 汇总，不按工具碎片化）');
  const f = findings[0]!;
  // 缺席清单载体 = location.snippet（absent=[...]）；evidence 尾部含 R5-1 历史注记
  //（read_text/find_text day-one trap —— 病史描述，不是缺席名单）
  assert.match(f.location.snippet, /^absent=\[.*autonomous_run/, '缺席清单点名缺席工具');
  assert.ok(!f.location.snippet.includes('read_text'), '缺省开的 read_text 不在缺席清单（翻转后能力面）');
  assert.match(f.evidence, /autonomyEnabled/, 'evidence 逐门列出开键');
  assert.match(f.recommendation, /autonomyEnabled/, 'recommendation 给出开键行动面');

  // 全亮配置 ⇒ 零命中（缺席披露不虚报）
  const allOn = await rule.scan(mkCtx(resolve({
    enableOcr: true, enableElementIdMode: true, autonomyEnabled: true, enableSandboxStack: true,
    localVisionApi: 'http://localhost:1/vision', vlmApiKey: 'anab4-test-key',
    checkpointPath: 'anab4-checkpoint.json', kernelEvolutionEnabled: true, federationEndpoint: 'http://localhost:1/f',
  })));
  assert.equal(allOn.length, 0, `全亮 ⇒ 零命中（实际: ${JSON.stringify(allOn)}）`);

  // 未绑配置（CLI 语境 {} cast）⇒ 零伪造（绝不拿空 config 报「全缺席」洪水）
  const cli = await rule.scan(mkCtx({}));
  assert.equal(cli.length, 0, '未绑配置 = 无从观察 ⇒ 诚实缺席');
});

test('ΑΝΒ-4b 通道 c: get_metrics 暴露 tool_face（mounted/absent 计数 + 缺席键名清单）；未记账 ⇒ 字段整体缺席', async () => {
  // 未记账 ⇒ 字段缺席（老消费者零感知）
  let j = await runJson(createGetMetricsTool(), {});
  assert.equal(j.tool_face, undefined, '组合根未记账 ⇒ tool_face 诚实缺席');
  // 记账 ⇒ 计数与清单在场
  recordToolFaceDisclosure({
    mounted: 43,
    absentTools: ['autonomous_run', 'autonomy_resume', 'steer_choice', 'steer_answer'],
    absentGates: [{
      key: 'autonomyEnabled',
      tools: ['autonomous_run', 'autonomy_resume', 'steer_choice', 'steer_answer'],
      gateOn: false,
      note: 'opt-in（D5-C）：自主环缺省不放行 —— 安全姿态由主人显式背书',
    }],
  });
  try {
    j = await runJson(createGetMetricsTool(), {});
    assert.equal(j.tool_face.mounted_tools, 43, 'mountedTools 计数');
    assert.equal(j.tool_face.absent_tools, 4, 'absentTools 计数');
    assert.equal(j.tool_face.absent_gates[0].key, 'autonomyEnabled', '缺席键名');
    assert.equal(j.tool_face.absent_gates[0].gate_on, false, '门当前态（分诊线索）');
    assert.deepEqual(j.tool_face.absent_gates[0].tools, ['autonomous_run', 'autonomy_resume', 'steer_choice', 'steer_answer']);
  } finally {
    // 会话账复位为全挂载形状（不污染后续测试宇宙的观察面）
    recordToolFaceDisclosure({ mounted: 0, absentTools: [], absentGates: [] });
  }
  assert.ok(getToolFaceDisclosure(), '披露状态可回读（观测面单源）');
});
