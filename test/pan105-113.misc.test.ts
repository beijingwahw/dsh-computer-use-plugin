// test/pan105-113.misc.test.ts
// ΠΑΝ-105~113（F3-9 波次 · src 根杂项中危）执法测试：
//   105 config 数值域校验（Schema 层 min/max 墙）
//   106 crossMachine barrier 对端鉴权（会话密钥 HMAC 握手，fail-closed）
//   107 planner 重复 id（结构化去重留痕，绝不静默吞任务）
//   108 resultContract 前缀协议行首锚定 + 转义规则
//   109 processScore MARKER 副本与 journal 权威面同源锁
//   110 uiExtractor 不回显 node.value（隐私）
//   111 NaN 卫兵族 + find_text 空 keyword 拒绝/结果上限
//   112 telemetry 键域上界（LRU + 溢出诚实标注）
//   113 sleep 梦回放教训 heuristic 降格 + 六幕单幕预算上限
// 全离线确定性：零网络、零真实键鼠、假时钟注入。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ─── ΠΑΝ-105：config 域执法 ───
import { Config as ConfigSchemaValue } from '../src/config.ts';

test('ΠΑΝ-105: 数值域墙 —— 域外值在配置解析期被拒（fail-loud，绝不静默钳制）', () => {
  const resolve = (v: unknown): Record<string, unknown> =>
    (ConfigSchemaValue as unknown as (x: unknown) => Record<string, unknown>)(v);
  // 缺省解析：全部字段落位（既有行为零漂移）
  const d = resolve({});
  assert.equal(d.maxImageCount, 3, '缺省 maxImageCount');
  assert.equal(d.federationEpsilon, 1, '缺省 federationEpsilon');

  // 域外值：装载期即抛 ValidationError（「配置面不许撒谎」方言）
  assert.throws(() => resolve({ maxImageCount: 0 }), /expected number/, 'maxImageCount=0（即入即逐 churn 源）被拒');
  assert.throws(() => resolve({ maxImageCount: 33 }), /expected number/, 'maxImageCount > 32 被拒');
  assert.throws(() => resolve({ federationEpsilon: 11 }), /expected number/, 'ε > 10 被拒（差分隐私域）');
  assert.throws(() => resolve({ federationEpsilon: 0 }), /expected number/, 'ε = 0 被拒（开区间 (0,10] 的下界近似）');
  assert.throws(() => resolve({ noopSimilarityThreshold: 1.5 }), /expected number/, '比率 > 1 被拒');
  assert.throws(() => resolve({ mouseSpeed: 0 }), /expected number/, '超时/速度类 > 0');
  assert.throws(() => resolve({ probeMemoryCapacity: 0 }), /expected number/, '容量 ≥ 1 类');
  assert.throws(() => resolve({ vlmOnboardingPort: 70000 }), /expected number/, '端口域');

  // 域内边界值照常放行（含文档明示 0=关闭/无限等待的字段）
  assert.equal(resolve({ federationEpsilon: 10 }).federationEpsilon, 10, 'ε=10（闭上界）放行');
  const edges = resolve({ noopSimilarityThreshold: 0, ioTimeoutMs: 0, somSparseBudget: 0, autonomyW1ClickRetryMax: 0 });
  assert.equal(edges.noopSimilarityThreshold, 0, '比率下界 0 放行');
  assert.equal(edges.ioTimeoutMs, 0, 'ioTimeoutMs=0（文档：无限等待）放行');
  assert.equal(edges.somSparseBudget, 0, 'somSparseBudget=0（文档：全量标注）放行');
});

test('ΠΑΝ-105: 域表完备性扫描 —— 每个数值字段都带 min/max（零漏网）', () => {
  const dict = (ConfigSchemaValue as unknown as { dict: Record<string, { type?: string; meta?: { min?: number; max?: number } }> }).dict;
  const numeric: string[] = [];
  for (const [key, node] of Object.entries(dict)) {
    if (node?.type === 'number') {
      numeric.push(key);
      assert.ok(
        typeof node.meta?.min === 'number' && typeof node.meta?.max === 'number',
        `数值字段 ${key} 缺 min/max 域（ΠΑΝ-105 域表漏网）`,
      );
      assert.ok(node.meta!.min! <= node.meta!.max!, `${key} 域自洽（min ≤ max）`);
    }
  }
  assert.ok(numeric.length >= 60, `数值字段数 ${numeric.length} 应 ≥ 60（域表覆盖面守恒）`);
});

// ─── ΠΑΝ-106：barrier 对端鉴权 ───
import {
  createBarrierCore, signBarrierRequest, verifyBarrierMac, makeHttpBarrierTransport,
  BARRIER_AUTH_SKEW_MS, type BarrierRequest, type BarrierFetch,
} from '../src/crossMachine.ts';

const KEY = 'unit-test-shared-secret';
const T0 = 1_700_000_000_000;
const armedCore = () => createBarrierCore({ now: () => T0, auth: { token: KEY } });
const signed = (req: BarrierRequest, ts = T0, key = KEY): BarrierRequest =>
  ({ ...req, ts, mac: signBarrierRequest(key, req, ts) });

test('ΠΑΝ-106: 武装态 fail-closed —— MAC 缺席/失配/超时间窗一律 unauthorized，状态不动', () => {
  const core = armedCore();
  // (a) MAC 缺席：伪造 peer 直接 allocate ⇒ 拒绝且名册不动
  const unsigned = core.apply({ op: 'allocate', name: 'n1', peer: 'attacker', n: 2 });
  assert.equal(unsigned.ok, false);
  assert.equal(unsigned.reason, 'unauthorized', '缺席 MAC ⇒ unauthorized');
  assert.equal(core.liveCount(), 0, '名册分毫不动（状态不动律）');

  // (b) 合法签名 ⇒ 放行
  const ok = core.apply(signed({ op: 'allocate', name: 'n1', peer: 'A', n: 2 }));
  assert.equal(ok.ok, true, '持钥签名放行');

  // (c) 错误密钥签名 ⇒ 拒绝
  const badKey = core.apply(signed({ op: 'allocate', name: 'n1', peer: 'B', n: 2 }, T0, 'wrong-key'));
  assert.equal(badKey.ok, false);
  assert.equal(badKey.reason, 'unauthorized', '错钥签名 ⇒ unauthorized');

  // (d) 时间窗外的重放（federation 同律 ±5min）⇒ 拒绝
  const stale = core.apply(signed({ op: 'allocate', name: 'n1', peer: 'B', n: 2 }, T0 - (BARRIER_AUTH_SKEW_MS + 1)));
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'unauthorized', '超时间窗 ⇒ unauthorized（防重放）');

  // (e) MAC 绑定 peer 身份：为 A 签的包改报 B ⇒ 失配
  const aMac = signBarrierRequest(KEY, { op: 'allocate', name: 'n1', peer: 'A', n: 2 }, T0);
  const forged = core.apply({ op: 'allocate', name: 'n1', peer: 'B', n: 2, ts: T0, mac: aMac });
  assert.equal(forged.ok, false);
  assert.equal(forged.reason, 'unauthorized', 'MAC 域含 peer —— 换名即失配（身份与凭证绑定）');

  // (f) status（只读视图）保持开放（/health 同律）
  const st = core.apply({ op: 'status', name: 'n1', peer: 'A' });
  assert.equal(st.ok, true, '只读 status 无需 MAC');
});

test('ΠΑΝ-106: 武装态全流程 —— 双端持钥 barrier 正常放行/退休；未武装零回归', async () => {
  // (a) 武装态：A/B 双端签名 allocate → release → 签名 commit → retired
  const core = armedCore();
  const a1 = core.apply(signed({ op: 'allocate', name: 'dial', peer: 'A', n: 2 }));
  assert.equal(a1.ok, true);
  const b1 = core.apply(signed({ op: 'allocate', name: 'dial', peer: 'B', n: 2 }));
  assert.equal(b1.ok, true);
  assert.equal(b1.phase, 'committed', '满员放行');
  const c1 = core.apply(signed({ op: 'commit', name: 'dial', peer: 'A', seq: 1 }));
  assert.equal(c1.ok, true);
  const c2 = core.apply(signed({ op: 'commit', name: 'dial', peer: 'B', seq: 1 }));
  assert.equal(c2.ok, true && (c2 as { retired?: boolean }).retired === true, '双端确认退休');
  assert.equal(core.liveCount(), 0);

  // (b) 未武装（token=''）：无 MAC 请求逐字节旧行为（零回归律）
  const open = createBarrierCore({ now: () => T0, auth: { token: '' } });
  const r = open.apply({ op: 'allocate', name: 'x', peer: 'A', n: 1 });
  assert.equal(r.ok, true, 'open 态无 MAC 照常工作');

  // (c) 纯函数面：verifyBarrierMac 对垃圾输入绝不抛、open 态恒真
  assert.equal(verifyBarrierMac('', {} as BarrierRequest, undefined, undefined, T0), true, 'open 态恒真');
  assert.equal(verifyBarrierMac(KEY, {} as BarrierRequest, 'x', [], T0), false, '垃圾 ts/mac ⇒ false（不抛）');
});

test('ΠΑΝ-106: HTTP 传输壳 —— 消息带 MAC（body 附 ts+mac）；open 态零字段', async () => {
  const bodies: string[] = [];
  const fake: BarrierFetch = async (_url, init) => {
    bodies.push(init.body);
    return { json: async () => ({ ok: true, name: 'n', seq: 1, phase: 'collecting', expected: 2, arrived: ['A'], acked: [] }) };
  };
  const authed = makeHttpBarrierTransport({ endpoint: 'http://127.0.0.1:1/', fetchImpl: fake, token: KEY, now: () => T0 });
  await authed({ op: 'allocate', name: 'n', peer: 'A', n: 2 });
  const body = JSON.parse(bodies[0]!) as { ts?: number; mac?: string };
  assert.equal(body.ts, T0, 'body 携带签名时间戳');
  assert.match(body.mac ?? '', /^[0-9a-f]{64}$/, 'body 携带 hex HMAC-SHA256');

  const openT = makeHttpBarrierTransport({ endpoint: 'http://127.0.0.1:1/', fetchImpl: fake, token: '', now: () => T0 });
  await openT({ op: 'allocate', name: 'n', peer: 'A', n: 2 });
  const openBody = JSON.parse(bodies[1]!) as { ts?: number; mac?: string };
  assert.equal(openBody.ts, undefined, 'open 态零 ts（与既往请求体逐字节一致）');
  assert.equal(openBody.mac, undefined, 'open 态零 mac');

  // 附签请求过武装核验（端到端闭环：传输壳签名 ↔ 核心验签）
  const core = armedCore();
  const req: BarrierRequest = { op: 'allocate', name: 'e2e', peer: 'A', n: 1 };
  const mac = signBarrierRequest(KEY, req, T0);
  assert.equal(core.apply({ ...req, ts: T0, mac }).ok, true, '传输壳方言 ↔ 核心验签同源');
});

test('ΠΑΝ-106: 客户端诚实失败 —— 领域拒绝 unauthorized 直通（立即失败，不轮询硬磨）', async () => {
  const { arriveAndWaitBarrier } = await import('../src/crossMachine.ts');
  const outcome = await arriveAndWaitBarrier('n', 2, {
    peer: 'A',
    transport: async () => ({ ok: false, reason: 'unauthorized' }),
    now: () => T0, sleep: async () => {}, pollMs: 10, timeoutMs: 1000,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'unauthorized', '鉴权拒绝直通消费方（fail-closed 传播）');
});

// ─── ΠΑΝ-107：planner 重复 id ───
import { planTasks, topoSortSubTasks, type SubTask } from '../src/planner.ts';

test('ΠΑΝ-107: topoSortSubTasks —— 撞号不再静默吞任务；duplicateIds 留痕', () => {
  const tasks: SubTask[] = [
    { id: 1, action: 'first', deps: [] },
    { id: 1, action: 'second (dup)', deps: [] },
    { id: 2, action: 'dep-on-first', deps: [1] },
  ];
  const r = topoSortSubTasks(tasks);
  assert.equal(r.order.length, 3, '三个子任务全部存活（旧实现静默吞掉一个）');
  assert.deepEqual(r.duplicateIds, [1], '撞号清单留痕');
  const ids = r.order.map(t => t.id);
  assert.equal(new Set(ids).size, ids.length, '输出 id 唯一');
  assert.equal(r.order.find(t => t.action === 'first')?.id, 1, '首现者占据原 id');
  // 无撞号 ⇒ duplicateIds 缺席（既有消费面零漂移）
  const clean = topoSortSubTasks([{ id: 1, action: 'a', deps: [] }]);
  assert.equal(clean.duplicateIds, undefined, '无撞号 ⇒ 字段缺席');
});

test('ΠΑΝ-107: planTasks —— LLM 撞号输出自动去重留痕（console.warn 进账）', async () => {
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); };
  try {
    const chat = async () => JSON.stringify([
      { id: 1, action: 'open browser', deps: [] },
      { id: 1, action: 'type search', deps: [] },
      { id: 2, action: 'click result', deps: [1] },
    ]);
    const tasks = await planTasks('dup test', chat);
    assert.equal(tasks.length, 3, '撞号任务全部保留（旧实现经 topoSort 静默消失）');
    const ids = tasks.map(t => t.id);
    assert.equal(new Set(ids).size, ids.length, '重编号后 id 唯一');
    assert.equal(tasks[0]!.id, 1, '首现者保号');
    assert.ok(warns.some(w => w.includes('duplicate subtask ids') && w.includes('[1]')), `撞号留痕 warn（${warns[0]?.slice(0, 60)}…）`);
  } finally {
    console.warn = origWarn;
  }
});

// ─── ΠΑΝ-108：resultContract 行首锚定 ───
import { classifyResult, escapeContractPrefix } from '../src/resultContract.ts';

test('ΠΑΝ-108: 前缀协议行首锚定 —— OCR 正文里的 [Error] 字样不再折叠为失败', () => {
  // 旧 bug 面：正文含 [Error] ⇒ 误判 FAILED（熔断/失败记忆被污染）
  assert.equal(classifyResult('Error dialog text: the app showed [Error] 0x80070005 and crashed').status, 'UNKNOWN',
    '正文中部 [Error] = 内容巧合');
  assert.equal(classifyResult('line1 ok\n[Error] appeared in a log excerpt\nline3').status, 'UNKNOWN',
    '次行行首 [Error] = 正文多行内容');
  // 协议本意：首行（行首锚定）标记 ⇒ 判定不变（零漂移）
  assert.equal(classifyResult('[Error]: Invalid region.').status, 'FAILED', '首行标记照判 FAILED');
  assert.equal(classifyResult('  [Error]: leading whitespace tolerated').status, 'FAILED', '前导空白容忍');
  assert.equal(classifyResult('[System] ok').status, 'SUCCESS', '首行 [System] 照判 SUCCESS');
  // 转义规则：正文必须以标记开头时由发射侧转义
  const escaped = escapeContractPrefix('[Error] 0x80070005 at offset 3');
  assert.ok(escaped.startsWith('\\[Error]'), `转义形态（${escaped.slice(0, 20)}…）`);
  assert.equal(classifyResult(escaped).status, 'UNKNOWN', '已转义首行 = 内容，不折叠为失败');
  assert.equal(classifyResult(escapeContractPrefix('plain content')).status, 'UNKNOWN', '无需转义原样');
});

// ─── ΠΑΝ-109：processScore 副本同源锁 ───
import { SCORE_TOOL_SETS, scoreJournalLines } from '../src/processScore.ts';
import { ACTION_TOOLS } from '../src/journal.ts';

test('ΠΑΝ-109: MARKER 副本对齐权威全集 + 同源锁（journal.ts 源文本对账）', () => {
  // (a) 迟到三成员已入副本
  for (const m of ['AGENT_NOTE', 'GUARD_PROBE', 'SANDBOX_HOST_REPLAY']) {
    assert.ok(SCORE_TOOL_SETS.markers.has(m), `副本含 ${m}（旧副本漂移点）`);
  }
  // (b) 同源锁：journal.ts 的 MARKER_TOOLS 字面集合（未导出 —— 源文本提取）
  const src = readFileSync(fileURLToPath(new URL('../src/journal.ts', import.meta.url)), 'utf8');
  const m = src.match(/const MARKER_TOOLS = new Set\(\[([^\]]*)\]/);
  assert.ok(m, 'journal.ts MARKER_TOOLS 字面量可提取');
  const journalMarkers = new Set((m[1]!.match(/'([A-Z_]+)'/g) ?? []).map(s => s.slice(1, -1)));
  assert.deepEqual([...SCORE_TOOL_SETS.markers].sort(), [...journalMarkers].sort(),
    'processScore 副本 ≡ journal 权威面（漂移即闸红）');
  // (c) SCORED 面对账（ACTION_TOOLS 是 journal 导出面 —— 直接比对）
  assert.deepEqual([...SCORE_TOOL_SETS.scored].sort(), [...ACTION_TOOLS].sort(),
    'SCORED_TOOLS 副本 ≡ journal ACTION_TOOLS');
  // (d) 行为面：非 MARKER 状态入链的 marker 行不再被当 unscored（漂移兜底拆除）
  const rep = scoreJournalLines([
    { tool: 'GUARD_PROBE', status: 'SUCCESS', args: {} },  // 旧兜底吃不到的形态
    { tool: 'click_mouse', status: 'SUCCESS', args: {}, effect_detected: true },
  ]);
  assert.equal(rep.totals.marker_lines, 1, 'GUARD_PROBE 行入 marker 计数（显式集合）');
  assert.equal(rep.totals.lines_unscored_tool, 0, '不再落入 unscored 桶');
  assert.equal(rep.totals.action_steps, 1, '动作步照常评分');
});

// ─── ΠΑΝ-110：uiExtractor 隐私 ───
import { setAccessibilityProvider, extractInteractiveElements } from '../src/uiExtractor.ts';

test('ΠΑΝ-110: 元素命名不回显 node.value（用户已输入内容不进提示词）', async () => {
  setAccessibilityProvider(async () => ({
    rect: { x: 0, y: 0, width: 100, height: 100 },
    role: 'root', name: 'root', children: [
      // 无 name 的 textbox：value 是用户已键入的搜索草稿（敏感输入）
      { rect: { x: 1, y: 1, width: 80, height: 20 }, role: 'textbox', name: '', value: 'my-password-draft-chat' },
      // 有 name 的按钮：照常用 name
      { rect: { x: 1, y: 30, width: 80, height: 20 }, role: 'button', name: 'Submit', value: 'irrelevant' },
    ],
  }));
  const els = await extractInteractiveElements(true);
  const tb = els.find(e => e.role === 'textbox')!;
  assert.ok(tb, 'textbox 在清单');
  assert.equal(tb.name, '[textbox]', '无 name ⇒ [role] 占位（不再回显 value）');
  assert.ok(!JSON.stringify(els).includes('my-password-draft-chat'), '用户输入内容绝不进提取清单');
  const btn = els.find(e => e.role === 'button')!;
  assert.equal(btn.name, 'Submit', 'name 在场照常使用');
});

// ─── ΠΑΝ-111：NaN 卫兵族 + find_text 边界 ───
import { semanticConfirm } from '../src/textReader.ts';
import { createProbeInteractivityTool } from '../src/tools/probeInteractivity.ts';
import { createFindTextTool, createReadTextTool } from '../src/tools/textTools.ts';
import * as backend from '../src/physicalBackend.ts';
import type { Config } from '../src/config.ts';

const toolCfg = { ocrLang: 'eng', enableInteractivityProbe: false, probeMaxTargets: 2 } as unknown as Config;

test('ΠΑΝ-111: probe_interactivity —— NaN/Infinity 坐标到不了执行面；域外值诚实拒绝', async () => {
  const t = createProbeInteractivityTool(toolCfg);
  const exec = (t as unknown as { execute: (a: unknown) => Promise<string> }).execute;
  // 第一道墙（框架层）：dsh-tools 参数校验对 NaN/Infinity 直接拒绝（ToolArgsError）
  await assert.rejects(() => exec({ x: Number.NaN, y: 0.5 }), /finite JSON number/, 'NaN x ⇒ 框架墙拒绝');
  await assert.rejects(() => exec({ x: 0.5, y: Number.POSITIVE_INFINITY }), /finite JSON number/, 'Infinity y ⇒ 框架墙拒绝');
  // 第二道墙（ΠΑΝ-111 工具内卫兵）：有限但域外 ⇒ [Error]（不进物理派发）
  const r = await exec({ x: -0.5, y: 0.5 });
  assert.ok(r.startsWith('[Error]'), `域外 x ⇒ [Error]（${r.slice(0, 40)}）`);
  const r2 = await exec({ x: 1.5, y: 0.5 });
  assert.ok(r2.startsWith('[Error]'), '域外 y ⇒ [Error]');
});

test('ΠΑΝ-111: semanticConfirm —— 数值参数非有限 ⇒ 诚实缺席 null（NaN 区域不进 OCR 面）', async () => {
  assert.equal(await semanticConfirm(null, Number.NaN, 0.5, 0.05, 'x'), null, 'cxPct NaN ⇒ null');
  assert.equal(await semanticConfirm(null, 0.5, 0.5, Number.NaN, 'x'), null, 'radiusPct NaN ⇒ null');
  assert.equal(await semanticConfirm(null, 0.5, 0.5, 0.05, undefined as unknown as string), null, 'expected 非串 ⇒ null');
});

test('ΠΑΝ-111: find_text 空 keyword 拒绝 + 结果上限（截断诚实标注）', async () => {
  const findText = createFindTextTool(toolCfg);
  const exec = (findText as unknown as { execute: (a: unknown) => Promise<string> }).execute;

  // 空/纯空白 keyword：旧实现 ''.includes('') 恒真 ⇒ 全词命中清单爆炸
  const empty = await exec({ keyword: '' });
  assert.ok(empty.startsWith('[Error]') && empty.includes('non-empty'), `空 keyword ⇒ 诚实拒绝（${empty.slice(0, 50)}）`);
  const blank = await exec({ keyword: '   ' });
  assert.ok(blank.startsWith('[Error]'), '纯空白 keyword ⇒ 拒绝');

  // 结果上限：60 命中 ⇒ locations 列 50 条 + 截断标注；matches 保持全量真值
  const elements = Array.from({ length: 60 }, (_, i) => ({
    source: 'L2-ocr', role: 'text', name: `save-${i}`,
    rect: { x: 0.01 * (i % 10), y: 0.1 * Math.floor(i / 10), width: 0.05, height: 0.02 },
    score: 0.9,
  }));
  backend._setAdapterForTests({
    getUiTree: async () => ({
      ok: true as const,
      value: { elements, funnel_depth: 'L2', fault: null, captured_at: 1, l3_invoked: false },
    }),
  } as never);
  try {
    const raw = await exec({ keyword: 'save' });
    const parsed = JSON.parse(raw) as {
      status: string;
      state_anchor: { matches: number; locations: string[]; locations_truncated?: boolean; locations_listed?: number };
    };
    assert.equal(parsed.status, 'SUCCESS');
    assert.equal(parsed.state_anchor.matches, 60, 'matches 计数保持全量真值');
    assert.equal(parsed.state_anchor.locations.length, 50, 'locations 列出上限 50 条');
    assert.equal(parsed.state_anchor.locations_truncated, true, '截断如实标注');
    assert.equal(parsed.state_anchor.locations_listed, 50, '列出条数申报在案');
  } finally {
    backend._setAdapterForTests(null);
  }
});

test('ΠΑΝ-111: read_text 区域卫兵 —— 半指定/域外 half_size 诚实拒绝（finiteNum 域执法）', async () => {
  const readText = createReadTextTool(toolCfg);
  const exec = (readText as unknown as { execute: (a: unknown) => Promise<string> }).execute;
  const half = await exec({ x: 0.5 });
  assert.ok(half.startsWith('[Error]') && half.includes('BOTH'), '只传 x ⇒ 拒绝（BOTH 语义）');
  const badHalf = await exec({ x: 0.5, y: 0.5, half_size: 0.6 });
  assert.ok(badHalf.startsWith('[Error]') && badHalf.includes('half_size'), 'half_size 超上界 ⇒ 拒绝');
});

// ─── ΠΑΝ-112：telemetry 键域上界 ───
import { Telemetry } from '../src/telemetry.ts';

test('ΠΑΝ-112: 键域 LRU + 溢出诚实标注 —— 长会话高基数键不无界', () => {
  const t = new Telemetry();
  for (let i = 0; i < 300; i++) t.observe(`tool-${i}`, 'SUCCESS', 5);
  const snap = t.snapshot() as { key_domain: { tools: number; tools_cap: number; tools_evicted: number } };
  assert.ok(snap.key_domain.tools <= snap.key_domain.tools_cap, `在役键 ≤ 上界（${snap.key_domain.tools}/${snap.key_domain.tools_cap}）`);
  assert.ok(snap.key_domain.tools_evicted >= 300 - snap.key_domain.tools_cap, `溢出账在案（evicted=${snap.key_domain.tools_evicted}）`);

  // LRU（非 FIFO）：最近访问的键在压力下存活，最久未访问者让位
  const t2 = new Telemetry();
  t2.observe('hot', 'SUCCESS', 1);           // 先入
  for (let i = 0; i < 127; i++) t2.observe(`k${i}`, 'SUCCESS', 1); // 填满 128
  t2.observe('hot', 'SUCCESS', 1);           // touch：hot 重插为最近使用
  t2.observe('newcomer', 'SUCCESS', 1);      // 挤掉最久未使用（k0），hot 存活
  const names = (t2.snapshot() as { tools: Array<{ tool: string }> }).tools.map(x => x.tool);
  assert.ok(names.includes('hot'), 'LRU：被 touch 的键存活');
  assert.ok(!names.includes('k0'), 'LRU：最久未访问的键让位（FIFO 语义会挤掉 hot）');

  // counters 同律
  const t3 = new Telemetry();
  for (let i = 0; i < 200; i++) t3.note(`c-${i}`, true);
  const s3 = t3.snapshot() as { key_domain: { counters: number; counters_cap: number; counters_evicted: number } };
  assert.ok(s3.key_domain.counters <= s3.key_domain.counters_cap && s3.key_domain.counters_evicted > 0, '计数器键域同律');

  // reset 清溢出账
  t3.reset();
  assert.equal((t3.snapshot() as { key_domain: { counters_evicted: number } }).key_domain.counters_evicted, 0, 'reset 清溢出账');
});

// ─── ΠΑΝ-113：sleep 教训降格 + 单幕预算上限 ───
import { runSleepCycle, SLEEP_ACT_MAX_SHARE, SLEEP_ACT_CAP_FLOOR_MS, resetSleepCycle } from '../src/sleep/index.ts';
import { runDreamReplay, dreamTrajectories } from '../src/sleep/dreamReplay.ts';
import type { DreamFailureTrajectory } from '../src/sleep/dreamReplay.ts';

/** 标准梦轨迹（w5dream 同形：错路历史 + 冻结简单世界 ⇒ 重放必成功、分歧恒 0） */
const FORCE_SIMPLE: Record<string, number> = {
  'decor:none': 100, 'decor:popup': 0.01, 'decor:payTrap': 0.01, 'decor:cookie': 0.01, 'decor:loading': 0.01,
  'main:form': 100, 'main:tree': 0.01, 'main:list': 0.01, 'main:collapse': 0.01,
};
const traj = (): DreamFailureTrajectory => ({
  id: 'f1', query: '走完向导导出报表', approach: 'scroll 后误点折叠区', symptom: '无进展',
  at: 1_700_000_000_000, surpriseBits: 8, stepsWasted: 10, riskTier: 'sensitive',
  history: [{ kind: 'scroll' }, { kind: 'scroll' }],
  world: { seed: 4242, difficulty: 1, weights: FORCE_SIMPLE },
});

test('ΠΑΝ-113: 梦回放教训降格 —— heuristic=true 结构化标注 + 提示性文案', async () => {
  const handle = await runDreamReplay({
    trajectories: dreamTrajectories([traj()]),
    now: () => 5000,
    overBudget: () => false,
    budget: { maxDreams: 1, maxStepsPerDream: 10 },
  });
  const e = handle.report.entries.find(x => x.lesson);
  assert.ok(e, '反事实教训在场（错路历史 + 必成重放）');
  assert.equal(e!.lessonKind, 'heuristic', '条目级证据强度标注');
  assert.deepEqual(handle.report.lessonMeta, [{ kind: 'heuristic', evidence: 'isomorphic-world-replay', sample: 1 }],
    '报告级 lessonMeta 平行标注（n=1 单次同构重放）');
  const lesson = e!.lesson!;
  assert.ok(lesson.includes('heuristic') && lesson.includes('提示性'), '文案申报提示性');
  assert.ok(!lesson.includes('勿原样重试') && !lesson.includes('优先考虑'), '规定性措辞（硬规则语气）已拆除');
  assert.ok(lesson.includes('反事实教训') && lesson.includes('本可被纠正'), '事实面保留（同构世界纠正事实不缩水）');
});

/** 可手动推进的假时钟（单幕超限的确定性制造面） */
function manualClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test('ΠΑΝ-113: 单幕预算上限 —— 一幕吃不完总预算，超限幕留痕', async () => {
  resetSleepCycle();
  const clock = manualClock();
  // replay 幕耗时 800ms > 上限（budget 2000 ⇒ cap = max(200, floor(2000×0.35)) = 700）
  const slowJournal = {
    list: () => [] as unknown[],
    verify: () => { clock.advance(800); return { ok: true, length: 0, brokenAt: null }; },
    findDecisionPoints: () => [],
  };
  const report = await runSleepCycle(
    { journal: slowJournal as never, log: () => {} },
    { budgetMs: 2000, now: clock.now },
  );
  const replay = report.acts.find(a => a.name === 'replay')!;
  assert.equal(replay.status, 'ok', '超限幕照常完成（同步幕不打断）');
  assert.equal(replay.overActCap, true, '超限标记在案');
  assert.ok((replay.elapsedMs ?? 0) >= 800, `单幕耗时记账（${replay.elapsedMs}ms）`);
  assert.ok((replay.detail ?? '').includes('单幕预算超限'), '超限注记进 detail（病灶可见）');
  // 总预算未被吃光 ⇒ 后续幕未被饿死（旧病灶：一幕吃 1.9s ⇒ 五幕全 timeout）
  const later = report.acts.filter(a => ['distill', 'immune', 'calibrate', 'audit'].includes(a.name));
  assert.ok(later.every(a => a.status !== 'timeout'), '后续维护四幕未因首幕超限而 timeout');
  // 立法常量自检：35% 占比 + 200ms 地板
  assert.equal(SLEEP_ACT_MAX_SHARE, 0.35);
  assert.ok(SLEEP_ACT_CAP_FLOOR_MS >= 100, '地板 ≥ 100ms');
});

test('ΠΑΝ-113: 迟到梦幕单幕硬闸 —— 梦自身耗时超上限 ⇒ 诚实收兵（不越闸）', async () => {
  resetSleepCycle();
  const clock = manualClock();
  const slowJournal = {
    list: () => [] as unknown[],
    verify: () => ({ ok: true, length: 0, brokenAt: null }),
    findDecisionPoints: () => [],
  };
  // 梦的失败轨迹源在读时刻推进时钟 800ms（> 梦幕上限 700ms）—— 模拟梦侧
  // 消耗真实时间（AutonomyGym + sharp 合成帧是六幕最贵消化面）
  const report = await runSleepCycle(
    {
      journal: slowJournal as never,
      log: () => {},
      dream: {
        failures: () => { clock.advance(800); return [traj()]; },
        budget: { maxDreams: 1, maxStepsPerDream: 10 },
      },
    },
    { budgetMs: 2000, now: clock.now },
  );
  // 梦侧已耗 800ms > 单幕上限 700ms ⇒ dreamOver 恒真 ⇒ 首条即饿死
  assert.ok(report.dream, '梦摘要在场');
  assert.equal(report.dream!.replayed, 0, '梦幕单幕闸执法 —— 超限后零回放');
  assert.ok(report.dream!.entries.some(e => !e.replayed), '未回放条目诚实注记在案');
  assert.equal(report.acts.filter(a => a.status === 'timeout').length, 0,
    '总预算未耗尽 ⇒ 六幕无 timeout（单幕闸与总闸分立执法）');
});
