// test/tools.shapeEnvironment.test.ts
// W6R-B7 补强：src/tools/shapeEnvironment.ts 工具层直测（此前零直接覆盖）。
// 全离线确定性：shaper.setAdapterForTest 注入假 SystemAdapter（先例
// agency.test.ts）—— capabilities/apply/undo 全落网；撤销账本隔离用
// clearUndoLog（每测归零）。WindowsAdapter 的 -EncodedCommand 通道属
// environmentShaper 层，已由 w6r.shellhardening.test.ts 覆盖，本文件只测工具面。
// 覆盖面：action 分发校验、能力诚实申报（含空能力降级话术）、apply 的
// kind/titleHint/系统级闸门/dryRun 拒绝、restore 的 LIFO 与部分失败、undo_log 视图。
//
// ✅ 缺口一已修复（W6R-C3）：shapeEnvironment.ts 的导入已拆为
//   `import { shaper }` + `import type { ShaperActionKind }`，Node strip-types
//   运行时可正常加载本工具模块；下方动态导入成功时全部用例直接执行，
//   仅在加载异常时 skip 并注明原因（哨兵语义保留）。
// ⚠ 已知缺口二（W6R-B7 报告项）：shaper.setAdapterForTest 只换 adapter 不接
//   能力集 —— 注入后 caps 恒为初始空集，apply 成功路径无法经现有缝离线覆盖
//   （agency.test.ts 因此只测过空能力路径）。本文件以注入私有 caps 字段补齐
//   （TS private 仅编译期，运行时可及），离线确定性不受影响。
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { shaper } from '../src/environmentShaper.ts';
import type { SystemAdapter, ShaperActionKind, ShaperAction, UndoRecipe } from '../src/environmentShaper.ts';

type Exec = (a: unknown) => Promise<string>;

let exec: Exec | null = null;
let loadNote: string | null = null;
try {
  const mod = await import('../src/tools/shapeEnvironment.ts');
  exec = (mod.createShapeEnvironmentTool() as unknown as { execute: Exec }).execute;
} catch (e: unknown) {
  loadNote = `工具模块在 Node strip-types 运行时不可加载：${e instanceof Error ? e.message : String(e)}`;
}
const skipReason = loadNote ? { skip: loadNote } : {};

const ALL_KINDS: ShaperActionKind[] = ['raise_window', 'maximize_window', 'move_window', 'set_zoom', 'set_contrast'];

/** 剧本适配器：能力全开；apply/undo 全记录；undo 可注入按 kind 失败 */
function fakeAdapter(opts: { caps?: ShaperActionKind[]; failUndoKinds?: string[] } = {}) {
  const applies: ShaperAction[] = [];
  const undos: string[] = [];
  const adapter: SystemAdapter = {
    platform: 'win32',
    capabilities: async () => new Set(opts.caps ?? ALL_KINDS),
    apply: async (action) => {
      applies.push({ ...action });
      return { kind: action.kind, titleHint: action.titleHint, matchedTitle: `${action.titleHint ?? ''}-wnd` };
    },
    undo: async (recipe: UndoRecipe) => {
      undos.push(recipe.kind);
      if (opts.failUndoKinds?.includes(recipe.kind)) throw new Error('undo engine glitch');
    },
    getWindowGeometry: async () => ({ x: 1, y: 2, width: 3, height: 4, maximized: false }),
  };
  return { adapter, applies, undos };
}

/**
 * 装载假适配器 + 补齐能力集（缺口二的补缝：caps 私有字段直注）。
 * capabilities() 与 apply() 都读 this.caps —— 只换 adapter 不喂 caps 时
 * apply 恒被能力闸门拒绝。
 */
function useAdapter(adapter: SystemAdapter, caps?: ShaperActionKind[]): void {
  shaper.setAdapterForTest(adapter);
  (shaper as unknown as { caps: ReadonlySet<ShaperActionKind> }).caps = new Set(caps ?? ALL_KINDS);
}

beforeEach(() => {
  shaper.clearUndoLog();
  shaper.configure(false, false); // 系统级闸门关、dryRun 关
});

after(() => {
  shaper.clearUndoLog();
  shaper.configure(false, false);
  (shaper as unknown as { caps: ReadonlySet<ShaperActionKind> }).caps = new Set();
});

test('shape_environment: 未知 action —— 结构化 FAILED + capabilities 指引', skipReason, async () => {
  const { adapter } = fakeAdapter();
  useAdapter(adapter);
  const out = JSON.parse(await exec!({ action: 'teleport' }));
  assert.equal(out.status, 'FAILED');
  assert.equal(out.action, 'Unknown action "teleport".');
  assert.equal(out.state_anchor.error, 'action must be capabilities | apply | restore | undo_log');
  assert.match(out.next_step, /action="capabilities"/);
});

test('shape_environment: capabilities —— 平台 + 能力清单诚实申报', skipReason, async () => {
  const { adapter } = fakeAdapter();
  useAdapter(adapter);
  const out = JSON.parse(await exec!({ action: 'capabilities' }));
  assert.equal(out.status, 'SUCCESS');
  assert.match(out.action, /Platform "win32"\. Available shaping actions: /);
  assert.equal(out.state_anchor.platform, 'win32');
  assert.deepEqual([...out.state_anchor.capabilities].sort(), [...ALL_KINDS].sort());
  assert.match(out.next_step, /undoToken/);
});

test('shape_environment: capabilities 空集 —— 降级话术禁止 apply', skipReason, async () => {
  const { adapter } = fakeAdapter({ caps: [] });
  useAdapter(adapter, []);
  const out = JSON.parse(await exec!({ action: 'capabilities' }));
  assert.equal(out.status, 'SUCCESS');
  assert.match(out.action, /\(none — this machine lacks the required tools/);
  assert.deepEqual(out.state_anchor.capabilities, []);
  assert.match(out.next_step, /Do not attempt apply on this machine/);
});

test('shape_environment: apply 缺 kind / 伪 kind —— 拒绝并列出合法值', skipReason, async () => {
  const { adapter, applies } = fakeAdapter();
  useAdapter(adapter);
  const out1 = JSON.parse(await exec!({ action: 'apply' }));
  assert.equal(out1.status, 'FAILED');
  assert.equal(out1.action, 'shape_environment apply failed.');
  assert.match(out1.state_anchor.error, /kind must be one of: raise_window \| maximize_window \| move_window \| set_zoom \| set_contrast/);
  const out2 = JSON.parse(await exec!({ action: 'apply', kind: 'teleport_window' }));
  assert.equal(out2.status, 'FAILED');
  assert.equal(out2.state_anchor.error, out1.state_anchor.error);
  assert.equal(applies.length, 0, '闸门在 adapter 之前拦截');
});

test('shape_environment: apply 窗口级动作缺 titleHint —— 拒绝（不可盲动整桌面）', skipReason, async () => {
  const { adapter, applies } = fakeAdapter();
  useAdapter(adapter);
  const out = JSON.parse(await exec!({ action: 'apply', kind: 'raise_window' }));
  assert.equal(out.status, 'FAILED');
  assert.equal(out.action, 'shape_environment "raise_window" failed.');
  assert.equal(out.state_anchor.error, 'raise_window requires a titleHint to address the target window');
  assert.equal(applies.length, 0, '闸门在 adapter 之前拦截');
});

test('shape_environment: apply 成功 —— undoToken 发号 + 回执锚点', skipReason, async () => {
  const { adapter, applies } = fakeAdapter();
  useAdapter(adapter);
  const out1 = JSON.parse(await exec!({ action: 'apply', kind: 'raise_window', title_hint: 'Chrome' }));
  assert.equal(out1.status, 'SUCCESS');
  assert.equal(out1.action, 'Applied "raise_window" to "Chrome". Undo token: undo-1.');
  assert.deepEqual(out1.state_anchor, { kind: 'raise_window', undo_token: 'undo-1' });
  assert.match(out1.next_step, /action="restore"/);
  const out2 = JSON.parse(await exec!({ action: 'apply', kind: 'set_zoom', title_hint: 'Chrome', level: 125 }));
  assert.equal(out2.state_anchor.undo_token, 'undo-2', '令牌单调递增');
  assert.deepEqual(applies[1], { kind: 'set_zoom', titleHint: 'Chrome', x: undefined, y: undefined, level: 125 });
});

test('shape_environment: apply 能力缺席 —— 诚实拒绝并指向 capabilities', skipReason, async () => {
  const { adapter, applies } = fakeAdapter({ caps: ['set_zoom'] }); // 本机只有 set_zoom
  useAdapter(adapter, ['set_zoom']);
  const out = JSON.parse(await exec!({ action: 'apply', kind: 'raise_window', title_hint: 'Chrome' }));
  assert.equal(out.status, 'FAILED');
  assert.match(out.state_anchor.error, /capability "raise_window" is unavailable on this platform \(win32\)/);
  assert.match(out.next_step, /action="capabilities"/);
  assert.equal(applies.length, 0);
});

test('shape_environment: 系统级动作受 shaperAllowSystemWide 闸门（默认关）', skipReason, async () => {
  const { adapter, applies } = fakeAdapter();
  useAdapter(adapter); // configure(false, false) 已在 beforeEach
  const out = JSON.parse(await exec!({ action: 'apply', kind: 'set_contrast' }));
  assert.equal(out.status, 'FAILED');
  assert.match(out.state_anchor.error, /"set_contrast" is a system-wide change and is disabled/);
  assert.equal(applies.length, 0);
});

test('shape_environment: dryRun —— 诚实拒绝执行（无真实变更即无复原义务）', skipReason, async () => {
  const { adapter } = fakeAdapter();
  useAdapter(adapter);
  shaper.configure(false, true); // dryRun on
  const out = JSON.parse(await exec!({ action: 'apply', kind: 'raise_window', title_hint: 'Chrome' }));
  assert.equal(out.status, 'FAILED');
  assert.match(out.state_anchor.error, /dry-run: environment shaping is skipped/);
});

test('shape_environment: restore 空账本 —— Nothing to restore', skipReason, async () => {
  const { adapter } = fakeAdapter();
  useAdapter(adapter);
  const out = JSON.parse(await exec!({ action: 'restore' }));
  assert.equal(out.status, 'SUCCESS');
  assert.equal(out.action, 'Nothing to restore — the undo log is empty.');
  assert.deepEqual(out.state_anchor, { restored: 0 });
});

test('shape_environment: restore 两条账目 —— LIFO 复原顺序 + 全成回执', skipReason, async () => {
  const { adapter, undos } = fakeAdapter();
  useAdapter(adapter);
  await exec!({ action: 'apply', kind: 'raise_window', title_hint: 'A' });
  await exec!({ action: 'apply', kind: 'maximize_window', title_hint: 'B' });
  const out = JSON.parse(await exec!({ action: 'restore' }));
  assert.equal(out.status, 'SUCCESS');
  assert.equal(out.action, 'Restored 2/2 change(s) (LIFO order).');
  assert.deepEqual(out.state_anchor, { restored: 2, total: 2, failures: [] });
  assert.deepEqual(undos, ['maximize_window', 'raise_window'], '后做的先还原');
  assert.match(out.next_step, /back to its original state/);
});

test('shape_environment: restore 部分失败 —— 计数诚实 + 失败明细 + 存留义务指引', skipReason, async () => {
  const { adapter, undos } = fakeAdapter({ failUndoKinds: ['raise_window'] });
  useAdapter(adapter);
  await exec!({ action: 'apply', kind: 'raise_window', title_hint: 'A' });
  await exec!({ action: 'apply', kind: 'set_zoom', title_hint: 'B' });
  const out = JSON.parse(await exec!({ action: 'restore' }));
  assert.equal(out.action, 'Restored 1/2 change(s) (LIFO order).');
  assert.deepEqual(out.state_anchor.failures, [{ token: 'undo-1', reason: 'undo engine glitch' }]);
  assert.deepEqual(undos, ['set_zoom', 'raise_window'], '单条失败不中止弹栈');
  assert.match(out.next_step, /undo-1: FAILED/);
  assert.match(out.next_step, /action="undo_log"/);
  // 失败条目存留：undo_log 里以 PENDING + 失败原因呈现
  const log = JSON.parse(await exec!({ action: 'undo_log' }));
  assert.match(log.action, /1 pending \/ 2 total/);
  assert.match(log.next_step, /PENDING \(last attempt failed: undo engine glitch\)/);
});

test('shape_environment: undo_log 视图 —— pending/total 计数 + 条目行', skipReason, async () => {
  const { adapter } = fakeAdapter();
  useAdapter(adapter);
  await exec!({ action: 'apply', kind: 'raise_window', title_hint: 'Chrome' });
  await exec!({ action: 'apply', kind: 'move_window', title_hint: 'Edge', x: 10, y: 20 });
  const out = JSON.parse(await exec!({ action: 'undo_log' }));
  assert.equal(out.status, 'SUCCESS');
  assert.equal(out.action, 'Undo log: 2 pending / 2 total.');
  assert.deepEqual(out.state_anchor, { total: 2, pending: 2 });
  const text = out.next_step as string;
  assert.match(text, /- undo-1 raise_window "Chrome": pending/);
  assert.match(text, /- undo-2 move_window "Edge": pending/);
  assert.match(text, /executed LIFO by action="restore"/);
});

// 加载缺口的自证用例：src 修复后本条自动转绿（可删）
test('shape_environment: 工具模块可在本测试运行时加载（strip-types 兼容性哨兵）', skipReason, () => {
  assert.ok(exec, 'src/tools/shapeEnvironment.ts 可直接加载');
});
