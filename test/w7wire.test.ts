// test/w7wire.test.ts
// W7-0（接线收尾包 · 第六批报告遗留六线）执法册：每根线「接通且受控」——
// 生效臂 + 降级臂双验，缺省零回归红律：
//   ① 联邦信任账生产接线（index.ts 启动 load+arm、卸载 flush+解除；路径派生自
//      checkpoint 同目录；checkpointPath 空 ⇒ 纯内存零磁盘）—— 源级 + 行为级；
//   ② 水平滚动列亮度消费（scrollPage 以 frameStats 垂直条带自算列亮度喂
//      estimateColShift → judgeScroll 第三参；列证据缺席 ⇒ 旧行为逐字节不变；
//      纵向路径零 frameStats 调用）—— 假 adapter 行为级；
//   ③ 账本列亮度（visualDiff LedgerAnalysis.colLuminance —— 纯增量：默认分析
//      管线产出列亮度序列，水平位移可经 estimateColShift 复原；注入端口不填
//      该可选字段 ⇒ 账本判决零变化）；
//   ④ 分段评分 CLI（processScore.mjs --segments 调 scoreJournalSegmentsText +
//      renderSegmentedScore；旗标缺席 ⇒ 单任务口径逐字节不变）—— 真子进程；
//   ⑤ 联邦技能账持久化（skillFederation 信任账刚例：端口+原子写+防御恢复+
//      突变计数节流；缺省未武装零磁盘；reset 解除武装）；
//   ⑥ steer 转发面补齐（tools/index.ts 补 4 个可选方法 —— 守卫式转发，缺省
//      跳过语义不变；桶在测试装载器下不可静态导入[shapeEnvironment 按值类型
//      导入地雷] ⇒ 按仓库既律走源级取证 —— w4wire/epochMu 同法）。
// 全离线确定性：假 adapter/桩存储/注入时钟；单例测试后归位。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Config } from '../src/config.ts';
// ① 的被测面
import {
  recordFederationTrust,
  federationTrustOf,
  federationTrustReport,
  federationTrustPersistenceStatus,
  resetFederationRuntime,
  loadFederationTrust,
  armFederationTrustPersistence,
  flushFederationTrust,
  createFederationTrustFileStore,
} from '../src/federation/index.ts';
// ② 的被测面
import { createScrollPageTool, frameColLuminance, COLUMN_STRIP_COUNT } from '../src/tools/scrollPage.ts';
import * as backend from '../src/physicalBackend.ts';
import type { PhysicalExecutionAdapter } from '../src/physicalExecution/contracts.ts';
import { system } from '../src/system.ts';
// ③ 的被测面
import { defaultAnalyze, ScreenStateLedger } from '../src/visualDiff.ts';
import { estimateColShift, judgeScroll } from '../src/motionEstimator.ts';
import { getSharp } from '../src/_legacyDeps.ts';
// ⑤ 的被测面
import {
  skillFederation,
  wireSwarmSkillFederation,
  skillFingerprintOf,
  armSkillFederationPersistence,
  loadSkillFederationLedger,
  flushSkillFederationLedger,
  skillFederationPersistenceStatus,
  createSkillFedFileStore,
  DEFAULT_SKILL_FED_FLUSH_EVERY,
  type SkillFedStore,
} from '../src/skillFederation.ts';
// ⑥ 的缺省臂隔离面（在役会话持有者归零）
import { activeSteerSession, resetW4PilotWire } from '../src/autonomy/autoPilot.ts';

// ─── 测试基建（离线确定性 + 单例归位 + tmp 目录） ───

const dirs: string[] = [];
function freshDir(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

/** 手写最小配置（缺字段按 falsy 缺省走零行为臂 —— w4wire/w5wire 同法） */
function makeConfig(over: Partial<Config> = {}): Config {
  return {
    verifyActions: true,
    dryRun: false,
    actionSettleMs: 1,
    ...(over as object),
  } as Config;
}

/** Result 方言 ok 包装（w1exec 同法） */
const ok = <T,>(value: T) => ({ ok: true as const, value });

beforeEach(() => {
  resetFederationRuntime();   // ①：联邦信任账/持久化武装归零
  skillFederation.reset();    // ⑤：候选/端口/持久化武装归零
  resetW4PilotWire();         // ⑥：在役 steer 会话持有者归零
});

afterEach(() => {
  resetFederationRuntime();
  skillFederation.reset();
  resetW4PilotWire();
  backend._setAdapterForTests(null); // ②：假 adapter 摘除
});

// ─── ① 联邦信任账生产接线（index.ts 源级 + 行为级） ───

test('W7-①a: index.ts 组合根接线源级 —— checkpoint 同目录派生 + 启动 load/arm + 卸载 flush/解除', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  // 启动面：checkpointPath 在场才建端口（空路径 ⇒ 纯内存零磁盘，现状逐字节不变）
  assert.match(src, /if \(config\.checkpointPath\) \{\s*\r?\n\s*const trustStore = createFederationTrustFileStore\(/,
    '启动处以 checkpointPath 为门建信任账存储端口');
  assert.match(src, /join\(dirname\(config\.checkpointPath\), 'federation-trust\.json'\)/,
    '信任账档路径派生自 checkpoint 同目录（federation-trust.json —— 认知快照的联邦伴档）');
  assert.match(src, /loadFederationTrust\(trustStore\)/, '启动先恢复（防御 restore —— 档缺席/坏 JSON ⇒ 冷启动空账）');
  assert.match(src, /armFederationTrustPersistence\(trustStore\)/, '恢复后武装（突变计数节流原子落盘）');
  // 卸载面：flush 最后一程 + 解除武装（resetFederationRuntime 是唯一解除缝）
  assert.match(src, /const trustFlushed = flushFederationTrust\(\);/, '卸载路径冲刷节流未及落盘的突变');
  assert.match(src, /try \{ resetFederationRuntime\(\); \} catch/, '卸载解除武装 + 清账（W-1 单例隔离律）');
});

test('W7-①b: 接线行为级往返 —— 冷启动空账 → 武装 → 节流落盘 → 卸载面（flush+reset）→ 再启动恢复', () => {
  const dir = freshDir('w7trust-');
  // 与 index.ts 同一派生式：dirname(checkpoint) + federation-trust.json
  const checkpointPath = path.join(dir, 'checkpoint.json');
  const trustFile = path.join(path.dirname(checkpointPath), 'federation-trust.json');
  assert.equal(trustFile, path.join(dir, 'federation-trust.json'), '同目录派生（排版自检）');
  const store = createFederationTrustFileStore(trustFile);

  // 首次启动：无档 = 冷启动空账
  const cold = loadFederationTrust(store);
  assert.equal(cold.restored, 0);
  assert.match(cold.note ?? '', /冷启动/, '无持久化档的诚实注记');
  assert.equal(armFederationTrustPersistence(store, { flushEvery: 2 }), true, '武装成功');

  // 在线记账：2 次突变（flushEvery=2）⇒ 恰一次原子落盘
  recordFederationTrust('src-a', { applied: 1 });
  assert.ok(!existsSync(trustFile), '1 次突变未达阈值 —— 尚未落盘');
  recordFederationTrust('src-a', { regressed: 1 });
  assert.ok(existsSync(trustFile), '2 次突变 ⇒ 节流落盘');
  assert.ok(!existsSync(trustFile + '.tmp'), '原子换名：无 .tmp 残留');

  // 卸载面：flush（尾账冲刷）+ resetFederationRuntime（解除武装 + 清账）
  assert.deepEqual(flushFederationTrust(), { ok: true, written: 1 }, '尾账冲刷幂等成功');
  resetFederationRuntime();
  assert.equal(federationTrustPersistenceStatus().armed, false, '卸载后武装解除（下次 apply 重武装）');
  assert.deepEqual(federationTrustReport(), [], '内存账随会话归零（W-1 单例隔离律）');

  // 下次启动：从档恢复（信任度由 regressed + 试用期计数重算）
  const rep = loadFederationTrust(store);
  assert.equal(rep.restored, 1);
  assert.ok(Math.abs(federationTrustOf('src-a') - 0.35) < 1e-12, '恢复后信任在岗（raw 0.5 与试用期封顶 0.35 取小 —— ΑΩ-R6）');
});

test('W7-①c: 缺省臂 —— checkpointPath 空 ⇒ 不武装纯内存；未武装 flush 幂等零磁盘', () => {
  // index.ts 的门是 config.checkpointPath（源级已证）；行为级：未武装态下
  // 记账/冲刷零磁盘、status 如实申报
  assert.equal(federationTrustPersistenceStatus().armed, false, '缺省未武装');
  recordFederationTrust('mem-only', { applied: 3 });
  assert.deepEqual(
    federationTrustReport(),
    [{ sourceId: 'mem-only', applied: 3, regressed: 0, merges: 1, cleanMerges: 1, probation: true, trust: 0.35 }],
    '纯内存记账照常执法（ΑΩ-R6 初见试用期封顶在岗）',
  );
  assert.deepEqual(flushFederationTrust(), { ok: true, written: 0 }, '未武装 flush = 幂等 no-op（纯内存是合法配置态）');
});

// ─── ② 水平滚动列亮度消费（scrollPage 假 adapter 行为级） ───

/** 列亮度图案：32 条带平滑正弦（相位相关唯一峰，无周期混叠） */
const COLS_BEFORE = Array.from({ length: COLUMN_STRIP_COUNT }, (_, i) => 128 + 60 * Math.sin(i / 3.7));
const COL_SHIFT = 3;
/** 内容左移 COL_SHIFT 条带（scroll right 的物理后果）：after[i] = before[i+K] */
const COLS_AFTER = Array.from({ length: COLUMN_STRIP_COUNT }, (_, i) => COLS_BEFORE[(i + COL_SHIFT) % COLUMN_STRIP_COUNT]);
/** 行亮度：64 行同构图案（纵向臂用；after = before 上移 2 行 = scroll down 的物理后果） */
const ROWS_BEFORE = Array.from({ length: 64 }, (_, i) => 128 + 60 * Math.sin(i / 3.7));
const ROWS_AFTER = Array.from({ length: 64 }, (_, i) => ROWS_BEFORE[(i + 2) % 64]);

interface FakeScrollWorld {
  adapter: PhysicalExecutionAdapter;
  calls: { frameStats: number; rowmeans: number; screenshots: number };
  scrolled: Array<{ dir: string; amount: number }>;
  failFrameStats: boolean;
}

/** 假物理世界：metaOnly 截图（帧 id 递增）+ 行亮度/区域统计按帧查表；scroll 落账 */
function makeScrollWorld(): FakeScrollWorld {
  const w: FakeScrollWorld = {
    calls: { frameStats: 0, rowmeans: 0, screenshots: 0 },
    scrolled: [],
    failFrameStats: false,
    adapter: null as unknown as PhysicalExecutionAdapter,
  };
  let nextFrame = 0;
  w.adapter = {
    takeScreenshot: async () => {
      w.calls.screenshots++;
      nextFrame += 1;
      return ok({
        dhash: '', region_dhash: '', frame_id: nextFrame, width: 1920, height: 1080,
        transport: 'base64', name: '', size: 0, shape: [0, 0, 0], dtype: '', stride: 0,
        format: '', captured_at: 0, image_base64: '',
      });
    },
    frameRowmeans: async (frameId: number) => {
      w.calls.rowmeans++;
      return ok({ frame_id: frameId, rows: frameId === 1 ? [...ROWS_BEFORE] : [...ROWS_AFTER] });
    },
    frameStats: async (frameId: number, regions: Array<{ x: number }>) => {
      w.calls.frameStats++;
      if (w.failFrameStats) throw new Error('frame_stats endpoint down');
      // 垂直条带按序返回均值（strip i ⇔ regions[i].x = i/n —— scrollPage 的采样方言）
      const table = frameId === 1 ? COLS_BEFORE : COLS_AFTER;
      return ok({ frame_id: frameId, stats: regions.map((_, i) => ({ mean: table[i] ?? 0, stdev: 0 })) });
    },
  } as unknown as PhysicalExecutionAdapter;
  return w;
}

/** system.scroll monkey-patch（w1exec patchWorld 同法 —— 可变对象字面量） */
function patchScroll(): () => void {
  const host = system as unknown as { scroll: unknown };
  const saved = host.scroll;
  host.scroll = async () => { /* 假世界：滚动即生效（帧表已编码前后差） */ };
  return () => { host.scroll = saved; };
}

/** 工具执行薄壳（defineTool 的 execute 绑定 —— w5wire 同法） */
async function runScrollTool(config: Config, args: { direction: string; amount?: number }): Promise<Record<string, any>> {
  const tool = createScrollPageTool(config);
  const exec = (tool as unknown as { execute: (a: unknown) => Promise<string> }).execute.bind(tool);
  return JSON.parse(await exec(args)) as Record<string, any>;
}

test('W7-②a: 生效臂 —— scroll right 列证据在场 ⇒ direction_consistent 可判 + 列移读数随行', async () => {
  const w = makeScrollWorld();
  backend._setAdapterForTests(w.adapter);
  const restore = patchScroll();
  try {
    const out = await runScrollTool(makeConfig(), { direction: 'right', amount: 5 });
    const cl = out.state_anchor.closed_loop;
    assert.equal(out.status, 'SUCCESS');
    assert.equal(cl.direction_consistent, true, '内容左移 + 请求右滚 ⇒ 方向一致（judgeScroll 水平臂首次在生产面判向）');
    assert.equal(cl.effective, true, '列移 ≥1 条带且残差低 ⇒ 内容真的动了');
    assert.equal(cl.at_boundary, false);
    assert.ok(cl.content_shift_cols <= -COL_SHIFT + 0.5 && cl.content_shift_cols >= -COL_SHIFT - 0.5,
      `列移读数 ≈ -${COL_SHIFT}（实测 ${cl.content_shift_cols}）—— >0=右移的纵向对偶约定`);
    assert.ok(cl.col_residual < 0.1, '干净平移的列残差近零');
    assert.ok(w.calls.frameStats >= 2, '前后两帧各取一次列亮度（frameStats 垂直条带）');
  } finally {
    restore();
  }
});

test('W7-②b: 降级臂 —— frameStats 故障 ⇒ 列证据缺席，判决回落旧行为（direction_consistent=null、无列读数键）', async () => {
  const w = makeScrollWorld();
  w.failFrameStats = true; // 端点故障 ⇒ frameColLuminance ⇒ null
  backend._setAdapterForTests(w.adapter);
  const restore = patchScroll();
  try {
    const out = await runScrollTool(makeConfig(), { direction: 'right', amount: 5 });
    const cl = out.state_anchor.closed_loop;
    assert.equal(cl.direction_consistent, null, '列证据缺席 ⇒ 方向一致性诚实缺席（W6-5 前旧行为）');
    assert.equal('content_shift_cols' in cl, false, '列读数键缺席（消费方可按缺席判降级）');
    assert.equal('col_residual' in cl, false);
    assert.ok(w.calls.frameStats >= 2, '端点被叩但故障 ⇒ 降级而非炸裂');
  } finally {
    restore();
  }
});

test('W7-②c: 纵向臂零开销 —— scroll down 不叩 frameStats（行证据照旧判向）', async () => {
  const w = makeScrollWorld();
  backend._setAdapterForTests(w.adapter);
  const restore = patchScroll();
  try {
    const out = await runScrollTool(makeConfig(), { direction: 'down', amount: 5 });
    const cl = out.state_anchor.closed_loop;
    assert.equal(w.calls.frameStats, 0, '纵向判决只认行证据（judgeScroll 立法）—— 列采样零调用');
    assert.equal(cl.direction_consistent, true, '内容上移 + 请求下滚 ⇒ 行证据判向照旧');
    assert.equal('content_shift_cols' in cl, false, '纵向锚点不带列读数（纯增量纪律）');
  } finally {
    restore();
  }
});

test('W7-②d: frameColLuminance 纯函数防御 —— 脏条带数/端口抛错/坏形状 ⇒ null（不产弱证据）', async () => {
  const w = makeScrollWorld();
  backend._setAdapterForTests(w.adapter);
  assert.equal(await frameColLuminance(1, 2), null, '条带数 <4 无相位分辨力');
  assert.equal(await frameColLuminance(Number.NaN), null, '脏帧 id');
  // 坏形状：stats 长度不符 / 均值缺席
  backend._setAdapterForTests({
    frameStats: async () => ok({ stats: [{ mean: 1 }] }),
  } as unknown as PhysicalExecutionAdapter);
  assert.equal(await frameColLuminance(7), null, 'stats 长度与条带数不符 ⇒ 整序列缺席');
  backend._setAdapterForTests({
    frameStats: async () => ok({ stats: Array.from({ length: COLUMN_STRIP_COUNT }, () => ({ mean: null, stdev: 0 })) }),
  } as unknown as PhysicalExecutionAdapter);
  assert.equal(await frameColLuminance(7), null, '单条带均值缺席 ⇒ 不零填充伪造平线');
});

// ─── ③ 账本列亮度（visualDiff LedgerAnalysis.colLuminance —— 纯增量） ───

/** 列结构测试图：240×160 灰度 PNG，列亮度 f(x)（水平平移的纯相位移动） */
async function columnPatternPng(shift: number): Promise<Buffer> {
  const sharp = await getSharp();
  const W0 = 240, H0 = 160;
  const f = (x: number): number => Math.max(0, Math.min(255, Math.round(100 + 90 * Math.sin(x / 9))));
  const raw = Buffer.alloc(W0 * H0 * 3);
  for (let y = 0; y < H0; y++) {
    for (let x = 0; x < W0; x++) {
      const v = f(x + shift);
      const i = (y * W0 + x) * 3;
      raw[i] = v; raw[i + 1] = v; raw[i + 2] = v;
    }
  }
  return sharp(raw, { raw: { width: W0, height: H0, channels: 3 } }).png().toBuffer();
}

test('W7-③a: 生效臂 —— 默认分析管线产出列亮度，水平位移经 estimateColShift 复原', async () => {
  const before = await columnPatternPng(0);
  const after = await columnPatternPng(8); // 内容左移 8 源像素
  const a = await defaultAnalyze(before, after);
  assert.ok(a.colLuminance, 'LedgerAnalysis.colLuminance 在场（分析面新证据通道）');
  assert.equal(a.colLuminance!.cols, 480, '差分分辨率 480 列（行亮度 diffRows 同尺的横向对偶）');
  assert.equal(a.colLuminance!.before.length, 480);
  assert.equal(a.colLuminance!.after.length, 480);
  const est = estimateColShift(a.colLuminance!.before, a.colLuminance!.after);
  // 8 源像素 @240 ⇒ 16 差分列 @480；内容左移 ⇒ shift < 0
  assert.ok(Math.abs(est.shift + 16) <= 1.5, `列移复原 ≈ -16（实测 ${est.shift}）`);
  assert.ok(est.residual < 0.2, '干净水平平移的残差低');
  // 既有面零变化：行移估计照旧产出（本图案行亮度近常量 ⇒ 行移 ≈ 0）
  assert.ok(a.rowShift && Number.isFinite(a.rowShift.shift));
});

test('W7-③b: 纯增量纪律 —— identical 判定/维度/区域清单不受列亮度影响；同图 ⇒ 前后列亮度同序列', async () => {
  const before = await columnPatternPng(0);
  const a = await defaultAnalyze(before, before);
  assert.equal(a.identical, true, 'before===after 恒 identical（既有冷启动探测语义不动）');
  assert.deepEqual(a.colLuminance!.before, a.colLuminance!.after, '同图 ⇒ 前后列亮度逐值一致');
});

test('W7-③c: 降级臂 —— 注入端口不填可选字段 colLuminance ⇒ 账本判决零变化', async () => {
  // 最小分析端口（W3-3 契约形状 —— 无 colLuminance 字段）：账本两帧判决与接前一致
  const minimal = async (b: Buffer, f: Buffer) => ({
    width: 100, height: 80,
    regions: b.equals(f) ? [] : [{ index: 1, bbox_normalized: { x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.4 }, center: { x: 0.25, y: 0.25 }, tiles_changed: 4 }],
    changedPct: b.equals(f) ? 0 : 2, // < patchDirtyPct(5) ⇒ 补丁分诊（9 会触发大变关键帧）
    identical: b.equals(f),
    rowShift: null,
    diffRows: 0,
  });
  const ledger = new ScreenStateLedger({ analyze: minimal, now: () => 1000 });
  const k = await ledger.ingest(Buffer.from('frame-a'));
  assert.equal(k.kind, 'keyframe', '冷启动关键帧（colLuminance 缺席不碰分诊序）');
  const s = await ledger.ingest(Buffer.from('frame-a'));
  assert.equal(s.kind, 'silent', '同帧静默（colLuminance 缺席 ⇒ 无新消费面）');
  const p = await ledger.ingest(Buffer.from('frame-b'));
  assert.equal(p.kind, 'patch', '小变补丁 —— 与接前逐字节同判');
});

// ─── ④ 分段评分 CLI（processScore.mjs --segments —— 真子进程） ───

/** 双任务 journal 夹具：两段 AGENT_BEGIN/END（各带可评分动作步） */
const SEGMENT_JOURNAL = [
  JSON.stringify({ ts: 1, tool: 'AGENT_BEGIN', args: { objective: '清理收件箱' }, status: 'MARKER' }),
  JSON.stringify({ ts: 2, tool: 'click_mouse', args: { x: 0.5 }, status: 'SUCCESS', effect_detected: true }),
  JSON.stringify({ ts: 3, tool: 'AGENT_END', args: { status: 'SUCCESS' }, status: 'MARKER' }),
  JSON.stringify({ ts: 4, tool: 'AGENT_BEGIN', args: { objective: '归档报告' }, status: 'MARKER' }),
  JSON.stringify({ ts: 5, tool: 'type_text', args: { text: 'hi' }, status: 'SUCCESS', effect_detected: true }),
  JSON.stringify({ ts: 6, tool: 'scroll_page', args: { direction: 'down' }, status: 'SUCCESS', effect_detected: false }),
  JSON.stringify({ ts: 7, tool: 'AGENT_END', args: { status: 'FAILED' }, status: 'MARKER' }),
].join('\n') + '\n';

const SCORE_CLI = fileURLToPath(new URL('../scripts/processScore.mjs', import.meta.url));

test('W7-④a: 生效臂 —— --segments ⇒ 分段评分 + 分段渲染 + 分段 JSON 落盘', () => {
  const dir = freshDir('w7seg-');
  const journalPath = path.join(dir, 'journal.jsonl');
  const outPath = path.join(dir, 'segments-report.json');
  writeFileSync(journalPath, SEGMENT_JOURNAL, 'utf8');
  const res = spawnSync(process.execPath, [SCORE_CLI, journalPath, '--segments', '--out', outPath],
    { encoding: 'utf8', timeout: 60_000 });
  assert.equal(res.status, 0, `CLI 退出码 0（stderr: ${res.stderr?.slice(0, 300) ?? ''}）`);
  assert.match(res.stdout, /\[ProcessScore\.segments\]/, '分段渲染头（renderSegmentedScore）');
  assert.match(res.stdout, /seg#0/, '逐段行在场');
  assert.match(res.stdout, /summary: method=step-weighted/, '步数加权汇总行在场');
  const rep = JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, any>;
  assert.equal(rep.segment_count, 2, '两任务两段');
  assert.equal(rep.generated_by, 'W6-5 processScore.segments', '分段核心生成');
  assert.equal(rep.summary.total_steps, 3, '段内动作步合计（1 + 2）');
  assert.equal(rep.segments[1].objective, '归档报告', '段目标随行');
});

test('W7-④b: 缺省臂 —— 无旗标 ⇒ 单任务口径逐字节不变（渲染头/caliber/落盘路径）', () => {
  const dir = freshDir('w7score-');
  const journalPath = path.join(dir, 'journal.jsonl');
  writeFileSync(journalPath, SEGMENT_JOURNAL, 'utf8');
  const res = spawnSync(process.execPath, [SCORE_CLI, journalPath],
    { encoding: 'utf8', timeout: 60_000 });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /\[ProcessScore\] caliber=/, '单任务渲染头（renderProcessScore）');
  assert.doesNotMatch(res.stdout, /\[ProcessScore\.segments\]/, '分段面缺席');
  const defaultOut = journalPath + '.score.json';
  assert.ok(existsSync(defaultOut), '缺省落盘路径不变（<journal>.score.json）');
  const rep = JSON.parse(readFileSync(defaultOut, 'utf8')) as Record<string, any>;
  assert.equal(rep.generated_by, 'W3-8 processScore', '单任务核心生成');
  assert.equal('segments' in rep, false, '单任务报告不带段结构（返回类型契约不动）');
});

// ─── ⑤ 联邦技能账持久化（skillFederation —— 信任账刚例移植） ───

/** 桩存储：捕获落盘文本（离线确定性；可注入失败/预置读档） */
function spySkillStore(onSave?: (text: string) => { ok: boolean; error?: string }): SkillFedStore & { saves: string[] } {
  const s = {
    saves: [] as string[],
    load(): string | null { return s.saves.length > 0 ? s.saves[s.saves.length - 1]! : null; },
    save(text: string): { ok: boolean; error?: string } {
      s.saves.push(text);
      return onSave ? onSave(text) : { ok: true };
    },
  };
  return s;
}

/** 本地双技能端口（闸①本地证据面在场 ⇒ cap = floor(0.5×2) = 1 —— w5wire 同形） */
function localPort() {
  return {
    listSkillDigests: () => [
      { skillId: 'skill-1', sceneFingerprint: 'aabbccdd', stepsDigest: [{ dx: 1 }], reliability: 0.8 },
      { skillId: 'skill-2', sceneFingerprint: 'eeaabbcc', stepsDigest: [{ dy: 3 }], reliability: 0.6 },
    ],
    addDormantSkill: () => true,
  };
}

/** 高可靠聚合候选（k=3 —— 接收端资格面） */
function aggCandidate(fp: string) {
  return {
    fingerprint: fp, aggregatedFrom: 3,
    slotStats: { dx: { median: 1, iqr: 0 }, dy: { median: 2, iqr: 0 } },
    reliability: 0.9, useCount: 5,
  };
}

test('W7-⑤a: 缺省未武装零磁盘 —— receive/noteLocalHit 照常执法，flush 幂等 no-op', () => {
  assert.equal(skillFederationPersistenceStatus().armed, false, '缺省未武装');
  assert.equal(wireSwarmSkillFederation(localPort()), true);
  const fp = skillFingerprintOf('aabbccdd', [{ dx: 1 }, { dy: 2 }]);
  const rep = skillFederation.receive([aggCandidate(fp)], { rng: () => 0.99 });
  assert.equal(rep.injected, 1, '接收/登记照常（持久化是旁路义务）');
  skillFederation.noteLocalHit(fp);
  assert.deepEqual(flushSkillFederationLedger(), { ok: true, written: 0 }, '未武装 flush = 合法配置态');
  assert.equal(skillFederationPersistenceStatus().armed, false);
});

test('W7-⑤b: 武装 + 突变计数节流 —— 每 N 次账本突变恰一次落盘；内容即账本态', () => {
  assert.equal(wireSwarmSkillFederation(localPort()), true);
  const spy = spySkillStore();
  assert.equal(armSkillFederationPersistence(spy, { flushEvery: 2 }), true, '武装成功');
  const fp = skillFingerprintOf('aabbccdd', [{ dx: 1 }, { dy: 2 }]);
  const rep = skillFederation.receive([aggCandidate(fp)], { rng: () => 0.99, now: () => 4242 });
  assert.equal(rep.injected, 1);
  assert.equal(spy.saves.length, 0, '1 次突变（候选登记）未达阈值');
  skillFederation.noteLocalHit(fp); // 突变 2 ⇒ 落盘
  assert.equal(spy.saves.length, 1, '2 次突变 ⇒ 恰一次落盘');
  const doc = JSON.parse(spy.saves[0]!) as { v: number; savedAt: number; candidates: Array<Record<string, unknown>> };
  assert.equal(doc.v, 1, '档 schema 版本');
  assert.equal(doc.candidates.length, 1);
  assert.equal(doc.candidates[0]!.state, 'dormant', '落盘点名 dormant');
  assert.equal((doc.candidates[0]!.localHits as number), 1, '命中计数随账落盘');
  assert.equal(skillFederationPersistenceStatus().pendingMutations, 0, '成功落盘后节流钟归零');
});

test('W7-⑤c: 往返 —— flush 落盘 → reset（解除武装+清账）→ load 恢复 → 账目逐字段一致', () => {
  assert.equal(wireSwarmSkillFederation(localPort()), true);
  const dir = freshDir('w7skillfed-');
  const file = path.join(dir, 'skill-fed.json');
  const store = createSkillFedFileStore(file);
  assert.equal(armSkillFederationPersistence(store), true);

  const fp = skillFingerprintOf('aabbccdd', [{ dx: 1 }, { dy: 2 }]);
  skillFederation.receive([aggCandidate(fp)], { rng: () => 0.99, now: () => 4242 });
  skillFederation.noteLocalHit(fp);
  skillFederation.noteLocalHit(fp); // 两次命中 ⇒ 激活
  const beforeStats = skillFederation.ledgerStats();
  assert.equal(beforeStats.active, 1, '两段激活在岗');
  const fl = flushSkillFederationLedger();
  assert.equal(fl.ok, true);
  assert.equal(fl.written, 1);
  assert.ok(existsSync(file), '档已存在');
  assert.ok(!existsSync(file + '.tmp'), '原子换名：无 .tmp 残留');

  // 崩溃/卸载模拟：reset 解除武装 + 清账
  skillFederation.reset();
  assert.equal(skillFederationPersistenceStatus().armed, false, 'reset 解除武装');
  assert.equal(skillFederation.ledgerStats().candidates, 0, '内存账归零');

  // 再启动：load 恢复
  const rep = loadSkillFederationLedger(store);
  assert.equal(rep.restored, 1);
  assert.equal(rep.skipped, 0);
  const afterStats = skillFederation.ledgerStats();
  assert.equal(afterStats.candidates, 1);
  assert.equal(afterStats.active, 1, '激活态随档恢复');
  assert.equal(afterStats.localHits, beforeStats.localHits, '命中计数恢复');
  assert.equal(afterStats.activations, beforeStats.activations, '激活计数恢复');
  assert.equal(afterStats.lastReceivedAt, 4242, '最近接收时刻恢复');
  const cand = skillFederation.candidatesSnapshot()[0]!;
  assert.equal(cand.fingerprint, fp);
  assert.deepEqual(cand.slotStats, { dx: { median: 1, iqr: 0 }, dy: { median: 2, iqr: 0 } }, '槽统计逐字段一致');
});

test('W7-⑤d: 防御恢复 —— 档级垃圾整档拒绝；条目级跳过；字段级归先验（state 垃圾 ⇒ dormant）', () => {
  // 预置内存账（恢复是整体替换 —— 垃圾档不得动它）
  const live = skillFingerprintOf('aabbccdd', [{ dx: 1 }]);
  skillFederation.receive([aggCandidate(live)], { rng: () => 0.99, localSkillCount: 4, now: () => 1 });
  const snapshot = skillFederation.candidatesSnapshot();

  for (const garbage of [null, 42, 'text', [], true, {}, { v: 2, candidates: [] }, { v: 1, candidates: 'no' }]) {
    const rep = skillFederation.restoreLedger(garbage);
    assert.equal(rep.restored, 0, `档级垃圾不恢复：${JSON.stringify(garbage)}`);
    assert.ok(rep.note, '拒绝原因注记在案');
  }
  assert.deepEqual(skillFederation.candidatesSnapshot(), snapshot, '内存账不受档级垃圾牵连');

  // 条目级垃圾（无指纹）跳过；字段级垃圾归先验
  const rep = skillFederation.restoreLedger({
    v: 1, savedAt: 0, totals: { localHits: 'x', activations: -1, thompsonAttempts: 2.9 }, lastReceivedAt: 'bad',
    candidates: [
      null, 42, { fingerprint: '' }, { slotStats: 1 },                       // 条目级 → skipped
      { fingerprint: 'fp-keep', state: 'weird', reliability: 9, useCount: -5, aggregatedFrom: 'x', localHits: -1,
        slotStats: { dx: { median: 'bad', iqr: -3 }, dy: { median: 2 } }, receivedAt: Number.NaN },
    ],
  });
  assert.equal(rep.restored, 1);
  assert.equal(rep.skipped, 4);
  const c = skillFederation.candidatesSnapshot()[0]!;
  assert.equal(c.fingerprint, 'fp-keep');
  assert.equal(c.state, 'dormant', 'state 垃圾 ⇒ dormant（dormant 安全律的恢复向）');
  assert.equal(c.reliability, 0.5, 'reliability 垃圾 ⇒ 0.5 先验');
  assert.equal(c.useCount, 1, 'useCount 垃圾 ⇒ 最小证据 1');
  assert.equal(c.aggregatedFrom, 0, 'aggregatedFrom 垃圾 ⇒ 0（消费方 k≥3 门复审）');
  assert.equal(c.localHits, 0, 'localHits 垃圾 ⇒ 0');
  assert.deepEqual(c.slotStats, { dx: { median: 0, iqr: 0 }, dy: { median: 2, iqr: 0 } }, '槽字段垃圾归 0、坏槽不臆造');
  const st = skillFederation.ledgerStats();
  assert.equal(st.localHits, 0, 'totals 字段垃圾归 0');
  assert.equal(st.activations, 0);
  assert.equal(st.thompsonAttempts, 2, '非整数取整封顶');
});

test('W7-⑤e: 端口契约 —— 结构坏端口拒绝武装；arm(null) false；load 各诚实方向收敛', () => {
  assert.equal(armSkillFederationPersistence(null), false, 'null 拒绝');
  assert.equal(armSkillFederationPersistence({ load: () => null } as unknown as SkillFedStore), false, '缺 save 拒绝');
  assert.ok(loadSkillFederationLedger(null).note?.includes('缺席'), '端口缺席');
  assert.ok(loadSkillFederationLedger({ load: () => null, save: () => ({ ok: true }) }).note?.includes('冷启动'), '无档 = 冷启动空账');
  assert.ok(loadSkillFederationLedger({ load: () => 'garbage{', save: () => ({ ok: true }) }).note?.includes('坏 JSON'), '坏 JSON 整档拒绝');
  const boom = loadSkillFederationLedger({ load: () => { throw new Error('boom'); }, save: () => ({ ok: true }) });
  assert.equal(boom.restored, 0, '端口抛错 ⇒ 防御兜底（绝不炸）');
  // 写失败保留突变计数 ⇒ 下次突变即重试（信任账 T-3 同律）
  const failing = spySkillStore(() => ({ ok: false, error: 'disk full' }));
  assert.equal(armSkillFederationPersistence(failing, { flushEvery: 1 }), true);
  assert.equal(wireSwarmSkillFederation(localPort()), true);
  const fp = skillFingerprintOf('aabbccdd', [{ dx: 1 }, { dy: 2 }]);
  skillFederation.receive([aggCandidate(fp)], { rng: () => 0.99 });
  assert.equal(skillFederationPersistenceStatus().pendingMutations, 1, '写失败不清计数（下次突变重试）');
  assert.equal(flushSkillFederationLedger().ok, false, '冲刷失败如实申报');
  assert.equal(DEFAULT_SKILL_FED_FLUSH_EVERY, 8, '缺省节流阈值与信任账同值');
});

// ─── ⑥ steer 转发面补齐（tools/index.ts 源级 —— 桶不可静态导入，w4wire 同法） ───

test('W7-⑥a: 转发面 4 个可选方法在册 —— 守卫臂 + 缺省臂 + 注入缝', () => {
  const src = readFileSync(new URL('../src/tools/index.ts', import.meta.url), 'utf8');
  // 注入缝：缺省 activeSteerSession（生产血脉不变 —— buildAllTools 的调用式零改动；
  // W8-B4 破环：缺省参数带装配收窄还原 as —— 持有面收窄为结构端口，真身恒完整会话）
  assert.match(src, /export function w4ForwardingSteerSession\(\s*\r?\n\s*sessionSource: \(\) => SteerSession \| null = activeSteerSession( as \(\) => SteerSession \| null)?,\s*\r?\n\): SteerSession \{/,
    '工厂带 sessionSource 注入缝（缺省 activeSteerSession —— 生产调用 w4ForwardingSteerSession() 语义不变）');
  // 缝1：drainAmendments —— 无会话/未实现/故障 ⇒ 空数组
  assert.match(src, /drainAmendments\(\): SteerAmendmentHandoff\[\] \{\s*\r?\n\s*const s = sessionSource\(\);\s*\r?\n\s*if \(s === null \|\| typeof s\.drainAmendments !== 'function'\) return \[\];/,
    'drainAmendments 守卫式转发（缺席 ⇒ 空数组 = 回灌零执行）');
  assert.match(src, /return Array\.isArray\(out\) \? out : \[\];/, '脏返回收敛为空数组');
  // 缝3：holdBranchCard —— no-op 缺省
  assert.match(src, /holdBranchCard\(card: unknown\): void \{\s*\r?\n\s*const s = sessionSource\(\);\s*\r?\n\s*if \(s === null \|\| typeof s\.holdBranchCard !== 'function'\) return;/,
    'holdBranchCard 守卫式转发（缺席 ⇒ no-op）');
  // 缝3：branchCard / takeBranchBias —— null 缺省
  assert.match(src, /branchCard\(\): BranchCard \| null \{\s*\r?\n\s*const s = sessionSource\(\);\s*\r?\n\s*if \(s === null \|\| typeof s\.branchCard !== 'function'\) return null;/,
    'branchCard 守卫式转发（缺席 ⇒ null）');
  assert.match(src, /takeBranchBias\(\): SteerBiasStepper \| null \{\s*\r?\n\s*const s = sessionSource\(\);\s*\r?\n\s*if \(s === null \|\| typeof s\.takeBranchBias !== 'function'\) return null;/,
    'takeBranchBias 守卫式转发（缺席 ⇒ null = 无偏置原路）');
  // 每个方法的故障臂 try/catch（基础 4 面调用臂 + 新 4 面 = 8 个吞错臂；
  // goal getter 是纯属性读无调用臂）
  const tail = src.slice(src.indexOf('w4ForwardingSteerSession'));
  const guards = tail.slice(0, tail.indexOf('export function buildAllTools'));
  assert.equal((guards.match(/\} catch \{/g) ?? []).length, 8, '基础 4 面 + 新 4 面全部带故障吞掉臂');
});

test('W7-⑥b: 既有面零回归 —— 转发面 5 个基础方法与挂载门源级不动', () => {
  const src = readFileSync(new URL('../src/tools/index.ts', import.meta.url), 'utf8');
  assert.match(src, /maybeCheckAndAsk\(stepIndex, entropy\) \{\s*\r?\n\s*const s = sessionSource\(\);/, '基础面改经 sessionSource（缺省同源 —— 行为等价改写）');
  assert.match(src, /if \(s === null\) \{\s*\r?\n\s*return \{ status: 'no-pending', hint: '当前无在役 steer 会话（漂移检查未点亮或尚未跑环）' \};/,
    '无会话 answer 的 no-pending 缺省语义原样');
  assert.match(src, /const w4SteerSession = w4ForwardingSteerSession\(\);/, 'buildAllTools 挂载点调用式不变（缺省参数 = 生产血脉）');
});

test('W7-⑥c: 消费契约 —— 会话不实现可选面 ⇒ 消费方守卫式跳过（SteerSession 可选面兼容律）', () => {
  // 缺省态（无在役会话）：接前转发面未实现这 4 个方法 —— 消费方（runPilotLoop）
  // 按接口契约守卫跳过（undefined 面零执行）；补齐后缺席语义显式化为 []/no-op/null，
  // 消费方观察行为等价。此处钉住两端契约：持有者缺省无会话 + 接口可选面在册。
  resetW4PilotWire();
  assert.equal(activeSteerSession(), null, '缺省无在役会话（转发面空转的既态）');
  // steerTools 的可选面契约（接口注释）与转发面的缺席语义一一对应
  const steerSrc = readFileSync(new URL('../src/tools/steerTools.ts', import.meta.url), 'utf8');
  assert.match(steerSrc, /drainAmendments\?\(\): SteerAmendmentHandoff\[\];/, '契约面：drainAmendments 可选');
  assert.match(steerSrc, /holdBranchCard\?\(card: unknown\): void;/, '契约面：holdBranchCard 可选');
  assert.match(steerSrc, /branchCard\?\(\): BranchCard \| null;/, '契约面：branchCard 可选');
  assert.match(steerSrc, /takeBranchBias\?\(\): SteerBiasStepper \| null;/, '契约面：takeBranchBias 可选');
});
