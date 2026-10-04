// test/epochSigma.dashboard.test.ts
// 纪元 Σ（Σ-7 遥测仪表盘）执法册：
//   Σ-7① 假遥测数据 ⇒ 四分区文本齐整（≤80 列）+ JSON 锚点结构
//   Σ-7② section 筛选（单区只渲染本区；非法值 toolErr；大小写/空白宽容）
//   Σ-7③ 空 telemetry/vlmMeter/战绩账 ⇒ 各区诚实「暂无」
//   Σ-7④ hooks deny 打点：伪 ctx 驱动 boundsGuard 真实 deny 路径 ⇒
//        counters 出现 guard:<工具名>（放行路径不打点）
//   Σ-7⑤ tools/index.ts 注册取证：新块在既有块之后、askScreen 挂载门原行未动、
//        恒注册（空配置运行时也在册）
//   Σ-7⑥（ΑΩ-R36）能力区：默认关闭功能面的透明账 —— 缺省 OFF (default) 计数
//        与文案格式、config 视图点亮 ⇒ ON、运行时单例实测 ⇒ ON (runtime)
// 全离线：telemetry/vlmMeter 直接灌数，伪 ctx 驱动守卫，零网络零截屏。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { telemetry } from '../src/telemetry.ts';
import { vlmMeter } from '../src/vlm/metering.ts';
import { resetGlmClient, configureVlm } from '../src/vlm/index.ts';
import {
  createMetricsDashboardTool,
  noteAutonomyOutcome,
  resetAutonomyLedger,
} from '../src/tools/metricsDashboard.ts';
import { registerBoundsGuard } from '../src/guards/boundsGuard.ts';

// ─── 环境卫兵：云脑全平台键清空 + 单例重置（「未配置」断言的确定性前提） ───

const ENV_KEYS = [
  'GLM_API_KEY', 'ZHIPUAI_API_KEY', 'ZAI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'DASHSCOPE_API_KEY', 'ALIYUN_API_KEY', 'MOONSHOT_API_KEY',
  'ARK_API_KEY', 'VOLCENGINE_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY', 'SILICONFLOW_API_KEY',
  'OPENROUTER_API_KEY',
] as const;
type EnvSnapshot = Array<readonly [string, string | undefined]>;
function snapshotEnv(): EnvSnapshot {
  return ENV_KEYS.map(k => [k, process.env[k]] as const);
}
function clearEnvKeys(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}
function restoreEnv(snap: EnvSnapshot): void {
  for (const [k, v] of snap) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ─── 视觉宽度镜像（≤80 列断言的事实源 —— 与 metricsDashboard.visualWidth 同律） ───

function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

type ToolLike = { execute: (a: unknown, e: unknown) => Promise<unknown> };
async function runTool(tool: ToolLike, args: unknown): Promise<any> {
  return JSON.parse(String(await tool.execute(args, undefined)));
}

/** 灌一套四分区假数据（tools / vlm / autonomy / guards 各就各位） */
function seedAll(): void {
  telemetry.reset();
  vlmMeter.reset();
  resetAutonomyLedger();
  // tools 面：click_mouse 3 调 2 成（66.7%）、autonomous_run 2 调 1 成（50%）
  telemetry.observe('click_mouse', 'SUCCESS', 120);
  telemetry.observe('click_mouse', 'SUCCESS', 140);
  telemetry.observe('click_mouse', 'FAILED', 900);
  telemetry.observe('autonomous_run', 'SUCCESS', 2500);
  telemetry.observe('autonomous_run', 'FAILED', 3000);
  // guards 面：deny 打点 2 次（与 hooks.ts deny 分支同一 counter 键律）
  telemetry.note('guard:click_mouse', false);
  telemetry.note('guard:click_mouse', false);
  // vlm 面：screen 2 成 / ocr 1 败（延迟 [300, 900, 1500]）
  vlmMeter.record({ ts: 1000, kind: 'screen', model: 'glm-4v', latencyMs: 900, ok: true, promptTokens: 1200, completionTokens: 210 });
  vlmMeter.record({ ts: 2000, kind: 'screen', model: 'glm-4v', latencyMs: 1500, ok: true, promptTokens: 800, completionTokens: 90 });
  vlmMeter.record({ ts: 3000, kind: 'ocr', model: 'glm-4v', latencyMs: 300, ok: false, error: 'timeout' });
  // 自主区轻量战绩账
  noteAutonomyOutcome('achieved');
  noteAutonomyOutcome('achieved');
  noteAutonomyOutcome('aborted');
}

// ─── Σ-7① 四分区文本 + 锚点结构 ───

test('Σ-7①: 假遥测数据 ⇒ 四分区文本齐整（≤80 列）+ toolOk 四件套锚点结构', async () => {
  const savedEnv = snapshotEnv();
  clearEnvKeys();
  resetGlmClient();
  seedAll();
  try {
    const out = await runTool(createMetricsDashboardTool(), {});
    assert.equal(out.status, 'SUCCESS', 'toolOk 四件套之 status');
    assert.ok(typeof out.action === 'string' && out.action.includes('metrics_dashboard'));
    assert.ok(typeof out.next_step === 'string' && out.next_step.length > 0);

    // 锚点结构：section / sections / dashboard / health
    assert.equal(out.state_anchor.section, 'all', '缺省 section = all');
    // Θ-4 追加 'kernel' 第五分区、ΑΩ-R36 追加 'capability' 第六分区：all 的
    // sections 枚举全集随之扩一（原断言由「在场」类断言（下行分区头循环）继续
    // 覆盖，此处全集枚举与实现同步更新 —— 与 Θ-4 扩区同律）
    assert.deepEqual(out.state_anchor.sections, ['tools', 'vlm', 'autonomy', 'guards', 'kernel', 'capability']);
    const dash = String(out.state_anchor.dashboard);
    assert.ok(dash.includes('\n'), 'dashboard 为多行文本');

    // 四分区头齐
    for (const pane of ['工具区', '云脑区', '自主区', '守卫区']) {
      assert.ok(dash.includes(pane), `分区头在场：${pane}`);
    }

    // tools 区：top-10 表行（click_mouse 3 调 66.7% p50=140 p95=900）
    assert.match(dash, /工具名\s+调用\s+成功率\s+p50ms\s+p95ms/, '表头中文标签');
    assert.match(dash, /click_mouse\s+3\s+66\.7%\s+140\s+900/, 'click_mouse 行数据准确');
    assert.match(dash, /autonomous_run\s+2\s+50%\s+3000\s+3000/, 'autonomous_run 行数据准确');

    // 延迟尾：样本不足 GPD 拒绝拟合 ⇒ 「若在」语义（在/不在与 tailReport 同判）
    const tail = telemetry.tailReport();
    assert.equal(dash.includes('延迟尾'), tail !== null, '延迟尾行与 tailReport 可用性一致');

    // vlm 区：计量读数 + 配置态
    assert.match(dash, /配置态: 未配置/, 'isGlmConfigured 实时态（env 清空 ⇒ 未配置）');
    assert.match(dash, /调用 3 │ 失败 1（33\.3%）/, 'vlm 调用/失败账');
    assert.match(dash, /延迟: p50 900ms │ p95 1500ms │ 均摊 900ms/, 'vlm 延迟分位');
    assert.match(dash, /令牌: 入 2000 │ 出 300/, 'vlm 令牌账');
    assert.match(dash, /类别: screen 2 · ocr 1/, 'vlm byKind');

    // autonomy 区：遥测战绩 + 轻量账 + 进化账本如实申报
    assert.match(dash, /autonomous_run 战绩: 调用 2 │ 成功率 50%/, 'autonomous_run 遥测战绩');
    assert.match(dash, /轻量战绩账: achieved 2 · aborted 1/, '轻量战绩账（noteAutonomyOutcome 打点）');
    assert.match(dash, /进化账本未接线/, '进化引擎不可达 ⇒ 如实一行');

    // guards 区：deny 拦截计数
    assert.match(dash, /guard:click_mouse\s+拦截 2/, '守卫拦截计数行');

    // 全局行（all 模式专属）
    assert.match(dash, /总调用 5 │ 全局成功率 60%/, '全局摘要行');

    // 80 列纪律：每行视觉宽度 ≤ 80
    for (const line of dash.split('\n')) {
      assert.ok(
        visualWidth(line) <= 80,
        `行宽 ${visualWidth(line)} > 80：${line}`,
      );
    }

    // health 机读速览（与文本同源同刻）
    const h = out.state_anchor.health;
    assert.equal(h.uptime_sec, telemetry.snapshot().uptime_sec);
    assert.equal(h.global_calls, 5);
    assert.equal(h.global_success_rate, 60);
    assert.equal(h.vlm_configured, false);
    assert.equal(h.vlm_calls, 3);
    assert.equal(h.autonomous_run_calls, 2);
    assert.equal(h.autonomous_run_success_rate, 50);
    assert.equal(h.guard_blocks, 2);
  } finally {
    restoreEnv(savedEnv);
    resetGlmClient();
  }
});

// ─── Σ-7② section 筛选 ───

test('Σ-7②: section 筛选 —— 单区只渲染本区；非法值 toolErr；大小写/空白宽容', async () => {
  seedAll();
  const tool = createMetricsDashboardTool();

  const vlm = await runTool(tool, { section: 'vlm' });
  assert.equal(vlm.status, 'SUCCESS');
  assert.equal(vlm.state_anchor.section, 'vlm', '锚点回显规范化后的 section');
  assert.deepEqual(vlm.state_anchor.sections, ['vlm']);
  const dashV = String(vlm.state_anchor.dashboard);
  assert.match(dashV, /云脑区/, 'vlm 单区渲染云脑区');
  assert.doesNotMatch(dashV, /工具区|自主区|守卫区/, '其余三区缺席');

  const guards = await runTool(tool, { section: 'guards' });
  const dashG = String(guards.state_anchor.dashboard);
  assert.match(dashG, /守卫区/, 'guards 单区渲染守卫区');
  assert.doesNotMatch(dashG, /工具区|云脑区|自主区/, '其余三区缺席');
  assert.match(dashG, /guard:click_mouse\s+拦截 2/, '守卫计数照常渲染');

  const tools = await runTool(tool, { section: 'tools' });
  assert.match(String(tools.state_anchor.dashboard), /click_mouse/, 'tools 单区渲染工具表');

  const autonomy = await runTool(tool, { section: 'autonomy' });
  assert.match(String(autonomy.state_anchor.dashboard), /进化账本未接线/, 'autonomy 单区含如实申报行');

  // 大小写/空白宽容：' VLM ' ⇒ vlm
  const sloppy = await runTool(tool, { section: ' VLM ' });
  assert.equal(sloppy.status, 'SUCCESS');
  assert.equal(sloppy.state_anchor.section, 'vlm');

  // 非法值 ⇒ 结构化 toolErr（绝不抛）
  const bad = await runTool(tool, { section: 'nope' });
  assert.equal(bad.status, 'FAILED');
  assert.match(String(bad.state_anchor.error), /all \| tools \| vlm \| autonomy \| guards/, '错误信息列全合法值');
  assert.match(String(bad.next_step), /tools.*vlm.*autonomy.*guards/s, '恢复指引给出合法值');

  // 非字符串类型：宿主 defineTool 的参数校验在 execute 之前先行拒绝
  //（框架第一道门 —— 工具面之内恒见 string|undefined，防御分支为纵深）
  await assert.rejects(
    () => (tool as ToolLike).execute({ section: 42 }, undefined),
    (err: any) => err?.code === 'INVALID_ARGS',
    '非字符串 section 被宿主参数校验拒绝',
  );
});

// ─── Σ-7③ 空数据诚实降级 ───

test('Σ-7③: 空 telemetry/vlmMeter/战绩账 ⇒ 各区诚实「暂无」（SUCCESS 不误报）', async () => {
  const savedEnv = snapshotEnv();
  clearEnvKeys();
  resetGlmClient();
  telemetry.reset();
  vlmMeter.reset();
  resetAutonomyLedger();
  try {
    const out = await runTool(createMetricsDashboardTool(), {});
    assert.equal(out.status, 'SUCCESS', '空数据仍成功渲染（只读仪表不因无数据失败）');
    const dash = String(out.state_anchor.dashboard);

    // 四区头齐 + 各区诚实行
    for (const pane of ['工具区', '云脑区', '自主区', '守卫区']) {
      assert.ok(dash.includes(pane), `分区头在场：${pane}`);
    }
    assert.ok(dash.includes('（暂无数据 —— 尚无工具调用被观测）'), '工具区诚实降级');
    assert.ok(dash.includes('配置态: 未配置'), '配置态实时读数仍在（非数据，是事实）');
    assert.ok(dash.includes('（暂无数据 —— 云脑零调用记录）'), '云脑区诚实降级');
    assert.ok(dash.includes('autonomous_run 战绩: 暂无数据'), '自主战绩诚实降级');
    assert.ok(dash.includes('轻量战绩账: 暂无记录'), '轻量账诚实降级');
    assert.ok(dash.includes('进化账本未接线'), '进化账本不可达申报恒在');
    assert.ok(dash.includes('（暂无守卫拦截记录'), '守卫区诚实降级');

    // health 全零/空（机读面同刻诚实）
    const h = out.state_anchor.health;
    assert.equal(h.global_calls, 0);
    assert.equal(h.global_success_rate, null);
    assert.equal(h.vlm_calls, 0);
    assert.equal(h.autonomous_run_calls, 0);
    assert.equal(h.autonomous_run_success_rate, null);
    assert.equal(h.guard_blocks, 0);
  } finally {
    restoreEnv(savedEnv);
    resetGlmClient();
  }
});

// ─── Σ-7④ hooks deny 打点（真实 boundsGuard 路径 + 伪 ctx） ───

test('Σ-7④: boundsGuard deny ⇒ counters 出现 guard:click_mouse（misses=拦截数）；放行不打点', async () => {
  telemetry.reset();
  const handlers: Array<{ event: string; handler: (exec: any, next: () => Promise<any>) => Promise<any> }> = [];
  const ctx = {
    on(event: string, handler: any) { handlers.push({ event, handler }); return () => {}; },
  } as any;
  registerBoundsGuard(ctx);
  const pre = handlers.find(h => h.event === 'tools/pre-execute')!.handler;
  assert.ok(pre, 'boundsGuard 经 onToolPre 挂载');

  // 放行先行：合法坐标 ⇒ accept，且此刻零守卫计数
  const pass = await pre(
    { name: 'click_mouse', arguments: { x: 0.5, y: 0.5 }, agent: { id: 'sess-1' } },
    async () => ({ kind: 'accept' }),
  );
  assert.equal(pass.kind, 'accept', '合法坐标放行');
  assert.equal(
    telemetry.snapshot().counters.filter(c => c.counter.startsWith('guard:')).length,
    0,
    '放行路径不打点',
  );

  // deny 路径：非法坐标（x>1）⇒ 守卫返回字符串 ⇒ toPreDecision deny + guard 打点
  const deny = await pre(
    { name: 'click_mouse', arguments: { x: 1.5, y: 0.5 }, agent: { id: 'sess-1' } },
    async () => ({ kind: 'accept' }),
  );
  assert.equal(deny.kind, 'deny', 'deny 决策形状不变（转译点未被改写）');
  assert.match(String(deny.reason), /Invalid coordinates/, '拦截文案照旧');

  const g = telemetry.snapshot().counters.find(c => c.counter === 'guard:click_mouse');
  assert.ok(g, 'guard:click_mouse 计数在场');
  assert.equal(g!.misses, 1, 'deny 一次 ⇒ 拦截计数 1（note hit=false 语义）');
  assert.equal(g!.hits, 0);

  // 仪表盘守卫区消费此计数
  const out = await runTool(createMetricsDashboardTool(), { section: 'guards' });
  assert.match(String(out.state_anchor.dashboard), /guard:click_mouse\s+拦截 1/, '守卫区如实渲染拦截账');
  assert.equal(out.state_anchor.health.guard_blocks, 1);
});

// ─── Σ-7⑤ 注册取证：新块在场 + 挂载门原行未动 + 恒注册 ───

test('Σ-7⑤: tools/index.ts —— dashboard 新块在既有块之后，askScreen/autonomy 门未动，恒注册', async () => {
  const src = readFileSync(new URL('../src/tools/index.ts', import.meta.url), 'utf8');

  // askScreen 挂载门原行未动（vlm.integration.test.ts 源码正则锁定的立法文本）
  assert.match(
    src,
    /if\s*\(config\.vlmApiKey \|\| isGlmConfigured\(\)\)\s*\{\s*tools\.push\(createAskScreenTool\(config\)\);/,
    'askScreen 挂载门原样',
  );
  // autonomy 块未动
  assert.match(
    src,
    /if\s*\(config\.autonomyEnabled\)\s*\{\s*tools\.push\(createAutonomousRunTool\(config\)\);/,
    'autonomous_run 挂载门原样',
  );
  assert.match(
    src,
    /if\s*\(config\.autonomyEnabled\)\s*\{\s*tools\.push\(createAutonomyResumeTool\(config\)\);/,
    'autonomy_resume 挂载门原样',
  );

  // 新块：语句级无条件 push（行首恰好两空格缩进 + 行尾即分号 —— 不在任何
  // if 体内，无配置门；恒注册的源码证明。运行时导入 amounts 不可行：同桶的
  // takeScreenshot.ts 含仅类型导入（UIElement），node 直载会 SyntaxError ——
  // 既有测试（epochSigma.resume.test.ts Σ-3⑥）同用源码正则取证）
  const dashMatch = src.match(/^  tools\.push\(createMetricsDashboardTool\(\)\);$/m);
  assert.ok(dashMatch, 'metrics_dashboard 无条件注册（恒挂载，无配置门）');
  assert.match(src, /import \{ createMetricsDashboardTool \} from '\.\/metricsDashboard';/, '导入行在场');

  // 顺序：末尾既有块（checkpoint）之后另起新块
  const cpIdx = src.indexOf('createSaveCheckpointTool(config)');
  assert.ok(cpIdx >= 0 && cpIdx < src.indexOf(dashMatch![0]), '新块在既有块之后另起');

  // 与 observabilityTools 的 get_metrics 不重名（工具面唯一性）
  const obsSrc = readFileSync(new URL('../src/tools/observabilityTools.ts', import.meta.url), 'utf8');
  assert.match(obsSrc, /name: 'get_metrics'/, 'get_metrics 原名未动');
  assert.match(
    readFileSync(new URL('../src/tools/metricsDashboard.ts', import.meta.url), 'utf8'),
    /name: 'metrics_dashboard'/,
    '仪表盘工具名不与 get_metrics 重名',
  );
});

// ─── Σ-7⑥（ΑΩ-R36）能力区：默认关闭功能面的透明账 ───

/** ΑΩ-R36：能力面 14 开关的点亮键全集（工单点名 12 项 + 自主环/故障切换池） */
const CAPABILITY_KEYS = [
  'enableSleepCycle', 'enableExploration', 'enableReversibilityLanes', 'enableStepAuction',
  'curriculumEnabled', 'kernelEvolutionEnabled', 'federationEndpoint', 'autonomyEnabled',
  'vlmProviderTiers', 'vlmFallbackProviders', 'enableApprovalGate', 'allowUnverifiedDangerous',
  'enableUIMemory', 'enableSkillLibrary',
] as const;

/** 能力区行尾状态列 + 点亮键的合法格式（溯源标签三态） */
const CAP_ROW_RE = /\s(ON \(default\)|OFF \(default\)|ON \(runtime\)|ON|OFF)\s+([a-zA-Z][A-Za-z]*)$/;

test('Σ-7⑥: 能力区缺省账 —— OFF (default) 计数/文案格式 + 机读速览（诚实账立法）', async () => {
  configureVlm(null); // 运行时单例归零（故障切换池/级联未铸 ⇒ 缺省账不受残迹污染）
  try {
    const out = await runTool(createMetricsDashboardTool(), { section: 'capability' });
    assert.equal(out.status, 'SUCCESS', '只读探测绝不抛');
    assert.equal(out.state_anchor.section, 'capability');
    assert.deepEqual(out.state_anchor.sections, ['capability'], '单区只渲染能力区');
    const dash = String(out.state_anchor.dashboard);
    const lines = dash.split('\n');

    // 分区头 + 口径行 + 三列表头
    assert.ok(dash.includes('能力区'), '能力区分区头在场');
    assert.match(
      dash,
      /口径: config 未接线 ⇒ 缺省按 D-B 立法；池\/级联为运行时单例实测/,
      '未接线口径如实申报（不伪装实配）',
    );
    assert.match(dash, /能力\s+状态\s+点亮键/, '三列表头（能力/状态/点亮键）');

    // 14 开关全覆盖：每键一行（状态标签合法 + 行尾即键名）+ 缩进一句话描述行
    for (const key of CAPABILITY_KEYS) {
      const row = lines.find(l => l.endsWith(key));
      assert.ok(row, `点亮键行在场：${key}`);
      const m = row.match(CAP_ROW_RE);
      assert.ok(m, `${key} 行含合法状态标签：${row}`);
      assert.equal(m![2], key, '状态标签之后即点亮键（可复制行动面）');
      const desc = lines[lines.indexOf(row!) + 1];
      assert.match(desc, /^  \S/, `${key} 描述行（两空格缩进一句话）`);
    }

    // 工单点名的缺省关开关逐条 OFF (default)（D-B 立法默认形态一眼可见）
    for (const [name, key] of [
      ['睡眠周期', 'enableSleepCycle'], ['探索前沿', 'enableExploration'],
      ['可逆性分道', 'enableReversibilityLanes'], ['步数拍卖', 'enableStepAuction'],
      ['惊异课程', 'curriculumEnabled'], ['内核进化', 'kernelEvolutionEnabled'],
      ['万脑联邦', 'federationEndpoint'], ['自主环', 'autonomyEnabled'],
      ['云脑级联', 'vlmProviderTiers'], ['故障切换池', 'vlmFallbackProviders'],
    ] as const) {
      assert.match(dash, new RegExp(`${name}\\s+OFF \\(default\\)\\s+${key}`), `${name} 缺省关如实标注`);
    }

    // 缺省开四条（反向误读同样透明 —— 审批闸门/金丝雀/UI 记忆/技能库缺省在场）
    for (const [name, key] of [
      ['审批闸门', 'enableApprovalGate'], ['金丝雀试演', 'allowUnverifiedDangerous'],
      ['UI 记忆', 'enableUIMemory'], ['技能库', 'enableSkillLibrary'],
    ] as const) {
      assert.match(dash, new RegExp(`${name}\\s+ON \\(default\\)\\s+${key}`), `${name} 缺省开如实标注`);
    }

    // 页脚计数 + 机读速览（与文本同源同刻）
    assert.match(dash, /OFF \(default\) 10\/14 ——/, '页脚缺省关计数（10/14）');
    assert.deepEqual(
      out.state_anchor.health.capability,
      { total: 14, off_default: 10, on: 4 },
      'health.capability 机读账',
    );

    // 80 列纪律（能力区同样受辖）
    for (const line of lines) {
      assert.ok(visualWidth(line) <= 80, `行宽 ${visualWidth(line)} > 80：${line}`);
    }
  } finally {
    configureVlm(null);
  }
});

test('Σ-7⑥: config 视图点亮 ⇒ 裸 ON 在场（溯源标签随实配剥落，未传键仍走缺省账）', async () => {
  configureVlm(null);
  try {
    const tool = createMetricsDashboardTool({
      enableSleepCycle: true,
      federationEndpoint: 'https://fed.example/api',
    });
    const out = await runTool(tool, { section: 'capability' });
    assert.equal(out.status, 'SUCCESS');
    const dash = String(out.state_anchor.dashboard);
    assert.match(dash, /口径: config 已接线（实配呈现）/, '口径切换为实配呈现');
    assert.match(dash, /睡眠周期\s+ON\s+enableSleepCycle/, '布尔点亮 ⇒ 裸 ON（无 (default)）');
    assert.match(dash, /万脑联邦\s+ON\s+federationEndpoint/, '非空端点点亮 ⇒ 裸 ON');
    assert.match(
      dash,
      /可逆性分道\s+OFF \(default\)\s+enableReversibilityLanes/,
      '未传键仍走缺省账（混合口径诚实）',
    );
    assert.match(dash, /OFF \(default\) 8\/14 ——/, '缺省关计数随实配收敛 10→8');
    assert.deepEqual(
      out.state_anchor.health.capability,
      { total: 14, off_default: 8, on: 6 },
      '机读账同刻收敛',
    );
  } finally {
    configureVlm(null);
  }
});

test('Σ-7⑥: 运行时单例实测 —— 铸池/级联 ⇒ ON (runtime)；拆卸 ⇒ 回落缺省账', async () => {
  configureVlm(null);
  try {
    const before = await runTool(createMetricsDashboardTool(), { section: 'capability' });
    assert.match(
      String(before.state_anchor.dashboard),
      /故障切换池\s+OFF \(default\)\s+vlmFallbackProviders/,
      '前置：未铸池 ⇒ 缺省 OFF',
    );

    // 生产铸造路径（configureVlm —— 铸造面零网络，只是适配器落座）：
    // 备选链非空 ⇒ 铸池；tier 表含 cheap 档 ⇒ 铸级联
    configureVlm({ vlmFallbackProviders: 'anthropic', vlmProviderTiers: 'anthropic=cheap' });
    const after = await runTool(createMetricsDashboardTool(), { section: 'capability' });
    const dash = String(after.state_anchor.dashboard);
    assert.match(dash, /故障切换池\s+ON \(runtime\)\s+vlmFallbackProviders/, '池单例在场 ⇒ 实测 ON');
    assert.match(dash, /云脑级联\s+ON \(runtime\)\s+vlmProviderTiers/, '级联单例在场 ⇒ 实测 ON');
    assert.equal(after.state_anchor.health.capability.on, 6, '机读账计入场实测点亮');
  } finally {
    configureVlm(null); // 拆卸（单例归零 —— 不残留给后续测试）
  }
  const reset = await runTool(createMetricsDashboardTool(), { section: 'capability' });
  assert.match(
    String(reset.state_anchor.dashboard),
    /故障切换池\s+OFF \(default\)\s+vlmFallbackProviders/,
    '拆卸后回落缺省账（探测只读、拆卸即还原）',
  );
});
