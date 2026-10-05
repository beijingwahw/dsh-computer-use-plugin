// test/anab2.selectionVerify.test.ts
// ΑΝΒ-2 执法册（W-07 caret 伪锚 + W-08 press_hotkey 选族效果验证 · 决策 D2）。
//
// 根治面（R5-2 §4.2-4.4，T8 直建成因）：① press_hotkey 无选区验证面 —— agent
// 只能烧 take_screenshot+ask（VLM 自相矛盾 seq204/214）；② type_text 像素验证
// 锚在鼠标兜底位（任务栏）⇒ 区域恒 100% 相似 ⇒ WARNING 诱导盲重打 ⇒ 三段拼接。
// 本册执法五面：
//   A. 伪锚记账/优先级/过期/诚实标注（focusTracker 单元）；
//   B. type_text 验证锚区转移（伪锚在场优先于鼠标兜底；区域中心落入目标窗）；
//   C. 选族区域 dHash 效果验证（合成选区蓝条图 —— R5-2 §4.3 离线实验方法复用，
//      真 dhash/regionDhash 函数算出的指纹喂给 mock 端口驱动全工具流）；
//   D. 回执贯通（VERIFIED ⇒ type_text 覆盖语义；UNVERIFIED ⇒ R5-2 防盲打话术
//      维持；一次性消费/点击与裸导航键失效律）；
//   E. 兼容铁律（无 config/无验证面 ⇒ 回执与 R5-2 盲态逐字节一致；非选族零副作用）。
// 全离线确定性：合成 SVG 图（sharp 只做栅格化）、mock 物理端口、假 system ——
// 零 GUI、零 VLM、零真实键盘。
import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { system } from '../src/system.ts';
import type { Config } from '../src/config.ts';
import * as backend from '../src/physicalBackend.ts';
import { dhash, regionDhash, similarity } from '../src/perceptualHash.ts';
import {
  focusTracker,
  resolveCaretAnchor,
  refreshCaretPseudoAnchorAfterNavKey,
  recordSelectionVerification,
  peekSelectionVerification,
  consumeSelectionVerification,
  NO_FOCUS,
  predictedFresh,
} from '../src/focusTracker.ts';
import { recordTargetWindow, _resetWindowFocusGuardForTest } from '../src/windowFocusGuard.ts';
import { createPressHotkeyTool, isSelectionChord, SELECTION_VERIFY_REGION_SIM_MAX_PCT } from '../src/tools/pressHotkey.ts';
import { createTypeTextTool } from '../src/tools/typeText.ts';

type Exec = (a: unknown) => Promise<string>;
const exec = (t: unknown): Exec => (t as unknown as { execute: Exec }).execute;
async function runJson(t: unknown, args: unknown): Promise<any> {
  return JSON.parse(await exec(t)(args));
}

const CFG = {
  maxTextLength: 1000, focusMaxAgeMs: 60_000,
  enableRiskGate: false, riskPatterns: '', enableApprovalGate: false, dangerPatterns: '',
  verifyActions: true, dryRun: false, adaptiveSettle: false, actionSettleMs: 1,
  noopSimilarityThreshold: 0.97, regionVerifyRadius: 0.15, enableOcr: false,
} as unknown as Config;

// ─── 假件工坊（r52 同款：system 补丁 + mock 物理端口）───

const originalSystem = {
  typeText: system.typeText.bind(system),
  pressHotkey: system.pressHotkey.bind(system),
  getMousePosition: system.getMousePosition.bind(system),
  getScreenSize: system.getScreenSize.bind(system),
};
let mouseProbes = 0;
function patchSystem(over: Record<string, unknown>): void {
  const host = system as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) host[k] = v;
}

const TINY = 'x'; // metaOnly 路径不读图像字节 —— 占位即可
interface CapFrame { screen: string; region: string }
interface MockPort {
  reqs: Array<{ wantRegionHash?: { x: number; y: number; r: number } }>;
  count(): number;
}
function mockAdapter(frames: CapFrame[], throwOnCall = -1): MockPort {
  const reqs: MockPort['reqs'] = [];
  let n = 0;
  backend._setAdapterForTests({
    takeScreenshot: async (req: MockPort['reqs'][number]) => {
      reqs.push(req);
      if (n === throwOnCall) { n++; throw new Error('mock capture failure'); }
      const f = frames[Math.min(n, frames.length - 1)];
      n++;
      return {
        ok: true as const,
        value: {
          transport: 'base64' as const, name: '', size: 0, shape: [1, 1, 3] as [number, number, number],
          dtype: 'uint8', stride: 0, format: 'png', width: 1, height: 1, captured_at: 1,
          image_base64: TINY, dhash: f.screen, phash: null, region_dhash: f.region,
          unchanged: false, frame_id: null,
        },
      };
    },
  } as never);
  return { reqs, count: () => n };
}

beforeEach(() => {
  focusTracker.clear(); // 伪锚/点击/选区账本三态全清
  _resetWindowFocusGuardForTest();
  mouseProbes = 0;
});
afterEach(() => {
  backend._setAdapterForTests(null);
});
after(() => {
  const host = system as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(originalSystem)) host[k] = v;
});

// ─── 合成选区蓝条图（R5-2 §4.3 离线实验方法复用：白底文字行 ± 蓝条白字高亮）───
// 结构要点：dHash 是**水平梯度**算子 —— 纯水平色条产出全零指纹（Δ-7 退化），
// 故文字行必须由 x 向间断的词块构成（真实文本的梯度结构）；选区高亮 = 蓝条
// 覆盖行 + 词块反白（真实选区渲染），梯度反转 ⇒ 区域相似度陡降（合成实测
// ≈0.72，与 R5-2 真截图实测 ≈0.80 同量级，双低于 0.95 立法阈）。

const WORD_BLOCKS: ReadonlyArray<readonly [number, number]> = [[24, 34], [66, 44], [120, 56], [186, 30]];

function textPageSvg(highlight: boolean): string {
  let rects = '';
  for (let i = 0; i < 6; i++) {
    for (const [x, w] of WORD_BLOCKS) {
      rects += `<rect x="${x}" y="${16 + i * 24}" width="${w}" height="8" fill="#222222"/>`;
    }
  }
  let sel = '';
  if (highlight) {
    const y2 = 16 + 2 * 24;
    sel = `<rect x="14" y="${y2 - 8}" width="212" height="24" fill="#2f6fed"/>`;
    for (const [x, w] of WORD_BLOCKS) sel += `<rect x="${x}" y="${y2}" width="${w}" height="8" fill="#ffffff"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160">` +
    `<rect width="240" height="160" fill="#ffffff"/>${rects}${sel}</svg>`;
}

async function syntheticSelectionHashes(): Promise<{
  screenA: string; screenB: string; regionA: string; regionB: string; sim: number;
}> {
  const { default: sharp } = await import('sharp');
  const bufA = await sharp(Buffer.from(textPageSvg(false))).png().toBuffer();
  const bufB = await sharp(Buffer.from(textPageSvg(true))).png().toBuffer();
  const [screenA, screenB, regionA, regionB] = await Promise.all([
    dhash(bufA), dhash(bufB),
    regionDhash(bufA, 0.5, 0.5, 0.15), regionDhash(bufB, 0.5, 0.5, 0.15),
  ]);
  return { screenA, screenB, regionA, regionB, sim: similarity(regionA, regionB) };
}

// ═══ A：伪锚记账 / 优先级 / 过期 / 诚实标注（focusTracker 单元）═══

test('ANB2-A1: 无目标窗记账、无点击 ⇒ 无锚（消费方回退旧路径）', () => {
  assert.equal(resolveCaretAnchor(), null);
});

test('ANB2-A2: switch_window 记账在场 ⇒ 物化窗口中心伪锚 + anchorKind 诚实标注', () => {
  recordTargetWindow({ keyword: '记事本', matchedTitle: '无标题 - 记事本' });
  const anchor = resolveCaretAnchor();
  assert.deepEqual(anchor, { kind: 'window-center-pseudo', x: 0.5, y: 0.5 });
  // get() 透出 anchorKind —— 消费方可区分伪锚与点击实测位
  const got = focusTracker.get(60_000);
  assert.equal(got?.x, 0.5);
  assert.equal((got as { anchorKind?: string })?.anchorKind, 'window-center-pseudo');
});

test('ANB2-A3: 点击记账优先于伪锚（实测位 > 代理位），且不带 anchorKind', () => {
  recordTargetWindow({ keyword: '记事本' });
  focusTracker.set(0.3, 0.4);
  const anchor = resolveCaretAnchor();
  assert.deepEqual(anchor, { kind: 'click-tracked', x: 0.3, y: 0.4 });
  assert.equal((focusTracker.get(60_000) as { anchorKind?: string })?.anchorKind, undefined);
});

test('ANB2-A4: 伪锚绝不冒充点击证据 —— predictedFresh 执行层短路对伪锚回哨兵', () => {
  recordTargetWindow({ keyword: '记事本' });
  resolveCaretAnchor(); // 物化伪锚
  assert.deepEqual(predictedFresh('w1-exec'), { ...NO_FOCUS });
});

test('ANB2-A5: 伪锚/目标窗记账双双过期 ⇒ 无锚（确定性时钟，无 sleep）', () => {
  recordTargetWindow({ keyword: '记事本' });
  const t0 = Date.now();
  assert.notEqual(resolveCaretAnchor(30_000, t0), null); // 新鲜
  assert.equal(resolveCaretAnchor(30_000, t0 + 30_001), null); // 双过期
});

test('ANB2-A6: 导航键保鲜 —— refresh 后伪锚寿命以刷新点起算', () => {
  recordTargetWindow({ keyword: '记事本' });
  const t0 = Date.now();
  resolveCaretAnchor(50, t0); // 物化（at=t0）
  assert.equal(refreshCaretPseudoAnchorAfterNavKey(50, t0 + 40), true); // 保鲜到 t0+40
  const anchor = resolveCaretAnchor(50, t0 + 80);
  assert.equal(anchor?.kind, 'window-center-pseudo'); // 无保鲜则 80>50 已过期
});

test('ANB2-A7: 导航键保鲜绝不覆盖新鲜点击记账（实测位不可被代理顶替）', () => {
  focusTracker.set(0.3, 0.4);
  assert.equal(refreshCaretPseudoAnchorAfterNavKey(), false);
  const got = focusTracker.get(60_000);
  assert.equal(got?.x, 0.3);
  assert.equal((got as { anchorKind?: string })?.anchorKind, undefined);
});

test('ANB2-A8: 选区账本失效律 —— 点击清账 / 显式失效 / 一次性消费 / 过期', () => {
  recordSelectionVerification({ verdict: 'verified', region_similarity_pct: 62.5, keys: ['shift', 'end'], anchor: 'window-center-pseudo' });
  assert.equal(peekSelectionVerification()?.verdict, 'verified');
  focusTracker.set(0.1, 0.2); // 点击 ⇒ 光标移动/选区折叠 ⇒ 清账
  assert.equal(peekSelectionVerification(), null);

  recordSelectionVerification({ verdict: 'unverified', region_similarity_pct: 100, keys: ['shift', 'home'], anchor: 'window-center-pseudo' });
  const consumed = consumeSelectionVerification(); // type_text 一次性消费
  assert.equal(consumed?.verdict, 'unverified');
  assert.equal(peekSelectionVerification(), null); // VERIFIED 语义不跨打字存活

  recordSelectionVerification({ verdict: 'blind', region_similarity_pct: null, keys: ['shift', 'end'], anchor: null });
  const t0 = Date.now();
  assert.equal(peekSelectionVerification(30_000, t0)?.verdict, 'blind');
  assert.equal(peekSelectionVerification(30_000, t0 + 30_001), null); // 过期
});

// ═══ B：type_text 验证锚区转移（伪锚在场优先于鼠标兜底）═══

test('ANB2-B1: 伪锚在场 ⇒ 验证区域锚定目标窗中心（不再锚任务栏鼠标位）+ 诚实披露', async () => {
  recordTargetWindow({ keyword: '记事本', matchedTitle: '无标题 - 记事本' });
  const port = mockAdapter([{ screen: '7777777777777777', region: 'aaaaaaaaaaaaaaaa' }]);
  patchSystem({
    typeText: async () => { /* noop */ },
    // 鼠标通道在场但伪锚路径**不得**触达（锚区已转移 —— 触达即回归任务栏锚）
    getMousePosition: async () => { mouseProbes++; return { x: 100, y: 1040 }; },
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
  });
  const out = await runJson(createTypeTextTool(CFG), { text: 'ROW-2-EDITED-FULL' });
  assert.equal(out.status, 'SUCCESS');
  // 验证区域中心 = 窗口中心伪锚（0.5,0.5），而非鼠标位（100/1920≈0.052, 1040/1080≈0.963 任务栏）
  assert.equal(port.reqs[0]?.wantRegionHash?.x, 0.5);
  assert.equal(port.reqs[0]?.wantRegionHash?.y, 0.5);
  assert.equal(mouseProbes, 0, '伪锚在场时不得回退鼠标兜底');
  // 诚实标注：focus_source + verification-anchor 双披露；noop ⇒ 伪锚同族防盲打话术
  assert.equal(out.state_anchor.effect.focus_source, 'window-center-pseudo');
  assert.equal(out.state_anchor.effect.verification_anchor, 'pseudo-window-center');
  assert.match(out.action, /WINDOW-CENTER PSEUDO anchor/);
  assert.match(out.action, /verify visually BEFORE retyping/);
  assert.match(out.next_step, /blind retyping duplicates the inserted text/);
});

test('ANB2-B2: 无伪锚（无切窗记账/无点击）⇒ 鼠标兜底旧路径逐字节保持（r52 T8-C3 回归钉）', async () => {
  mockAdapter([{ screen: '7777777777777777', region: 'aaaaaaaaaaaaaaaa' }]);
  patchSystem({
    typeText: async () => { /* noop */ },
    getMousePosition: async () => { mouseProbes++; return { x: 100, y: 100 }; },
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
  });
  const out = await runJson(createTypeTextTool(CFG), { text: 'ROW-2-EDITED-FULL' });
  assert.equal(out.state_anchor.effect.focus_source, 'mouse-position');
  assert.equal(out.state_anchor.effect.verification_anchor, undefined);
  assert.match(out.action, /CAVEAT: the verified region was centered on the CURRENT MOUSE POSITION/);
  assert.equal(mouseProbes, 1);
});

// ═══ C：选族区域 dHash 效果验证（合成选区蓝条，R5-2 方法复用）═══

test('ANB2-C0: 合成选区蓝条区域可见性（R5-2 §4.3 复现）—— 区域 sim 显著低于验证阈', async () => {
  const { sim } = await syntheticSelectionHashes();
  assert.ok(
    sim < SELECTION_VERIFY_REGION_SIM_MAX_PCT / 100,
    `合成蓝条区域相似度 ${sim} 必须低于验证阈 ${SELECTION_VERIFY_REGION_SIM_MAX_PCT}%（R5-2 实测真截图 ≈0.80）`,
  );
});

test('ANB2-C1: 选族和弦派发 ⇒ 区域差分超阈 ⇒ SELECTION VERIFIED + 实测值 + 伪锚披露 + 账本记账', async () => {
  const { screenA, screenB, regionA, regionB, sim } = await syntheticSelectionHashes();
  recordTargetWindow({ keyword: '记事本', matchedTitle: '无标题 - 记事本' });
  const port = mockAdapter([
    { screen: screenA, region: regionA }, // 派发前快照
    { screen: screenB, region: regionB }, // 派发后快照（蓝条在场）
  ]);
  patchSystem({ pressHotkey: async () => { /* noop */ } });
  const out = await runJson(createPressHotkeyTool(CFG), { keys: ['shift', 'end'] });
  assert.equal(out.status, 'SUCCESS');
  const expectedPct = Math.round(sim * 1000) / 10;
  assert.ok(out.next_step.startsWith('SELECTION VERIFIED'), `next_step 头部: ${out.next_step.slice(0, 60)}`);
  assert.match(out.next_step, new RegExp(`${expectedPct}% similarity`));
  assert.match(out.next_step, /REPLACE the verified selected range/);
  assert.match(out.next_step, /window-center PSEUDO anchor/); // 伪锚诚实披露
  assert.match(out.next_step, /NOT the real caret/);
  // 派发前后两次区域快照都锚定目标窗中心
  assert.equal(port.reqs[0]?.wantRegionHash?.x, 0.5);
  assert.equal(port.reqs[1]?.wantRegionHash?.x, 0.5);
  assert.equal(port.count(), 2, '恰两次快照（派发前/后），零 VLM 调用');
  // 回执锚点 + 选区账本
  assert.equal(out.state_anchor.selection_check.verified, true);
  assert.equal(out.state_anchor.selection_check.region_similarity_pct, expectedPct);
  assert.equal(out.state_anchor.selection_check.verification_anchor, 'window-center-pseudo');
  const ledger = peekSelectionVerification(60_000);
  assert.equal(ledger?.verdict, 'verified');
  assert.equal(ledger?.region_similarity_pct, expectedPct);
});

test('ANB2-C2: 区域未变（sim 100%）⇒ SELECTION UNVERIFIED 维持 + 附区域差分实测值', async () => {
  recordTargetWindow({ keyword: '记事本' });
  mockAdapter([{ screen: '7777777777777777', region: 'aaaaaaaaaaaaaaaa' }]); // 前后同帧
  patchSystem({ pressHotkey: async () => { /* noop */ } });
  const out = await runJson(createPressHotkeyTool(CFG), { keys: ['shift', 'end'] });
  assert.equal(out.status, 'SUCCESS');
  assert.match(out.next_step, /^SELECTION UNVERIFIED/);
  assert.match(out.next_step, /100% similarity/); // 实测值在场（比盲态多一个证据维度）
  assert.match(out.next_step, /duplicate-text hazard/); // 防盲打核心话术保留
  assert.match(out.next_step, /take_screenshot/);
  assert.equal(out.state_anchor.selection_check.verified, false);
  assert.equal(out.state_anchor.selection_check.region_similarity_pct, 100);
  assert.equal(peekSelectionVerification(60_000)?.verdict, 'unverified');
});

test('ANB2-C3: 点击记账为验证锚（实测位优先）—— selection_check.verification_anchor=click-tracked', async () => {
  const { screenA, screenB, regionA, regionB } = await syntheticSelectionHashes();
  focusTracker.set(0.42, 0.31); // agent 点击进文本框后 shift+end —— 光标在点击邻域
  const port = mockAdapter([
    { screen: screenA, region: regionA },
    { screen: screenB, region: regionB },
  ]);
  patchSystem({ pressHotkey: async () => { /* noop */ } });
  const out = await runJson(createPressHotkeyTool(CFG), { keys: ['shift', 'end'] });
  assert.match(out.next_step, /^SELECTION VERIFIED/);
  assert.equal(out.state_anchor.selection_check.verification_anchor, 'click-tracked');
  assert.equal(port.reqs[0]?.wantRegionHash?.x, 0.42); // 区域锚在点击位
});

test('ANB2-C4: 非选族和弦零副作用 —— ctrl+s 零截图、回执字节不变、账本清空', async () => {
  recordTargetWindow({ keyword: '记事本' });
  recordSelectionVerification({ verdict: 'verified', region_similarity_pct: 60, keys: ['shift', 'end'], anchor: 'click-tracked' });
  const port = mockAdapter([{ screen: '7777777777777777', region: 'aaaaaaaaaaaaaaaa' }]);
  patchSystem({ pressHotkey: async () => { /* noop */ } });
  const out = await runJson(createPressHotkeyTool(CFG), { keys: ['ctrl', 's'] });
  assert.equal(out.next_step, "Call 'take_screenshot' to verify the shortcut took effect.");
  assert.equal(out.state_anchor.selection_check, undefined); // 加法式键缺席
  assert.equal(port.count(), 0, '非选族零快照（验证面只对选族开）');
  assert.equal(peekSelectionVerification(), null, '非选族派发 ⇒ 选区账本保守失效');
});

test('ANB2-C5: 裸导航键（home）零截图 + 伪锚记账 + 选区账本失效 + 回执字节不变', async () => {
  recordTargetWindow({ keyword: '记事本' });
  recordSelectionVerification({ verdict: 'verified', region_similarity_pct: 60, keys: ['shift', 'end'], anchor: 'click-tracked' });
  const port = mockAdapter([{ screen: '7777777777777777', region: 'aaaaaaaaaaaaaaaa' }]);
  patchSystem({ pressHotkey: async () => { /* noop */ } });
  const out = await runJson(createPressHotkeyTool(), { keys: ['home'] }); // 无 config 也记账
  assert.equal(out.next_step, "Call 'take_screenshot' to verify the shortcut took effect.");
  assert.equal(port.count(), 0);
  // W-07 核心：导航键派发后伪锚在场（无点击场景下的光标代理）
  const got = focusTracker.get(60_000);
  assert.equal((got as { anchorKind?: string })?.anchorKind, 'window-center-pseudo');
  assert.equal(peekSelectionVerification(), null, '裸导航折叠选区 ⇒ 账本失效');
});

test('ANB2-C6: 验证面缺席（无锚）⇒ R5-2 盲态回执逐字节一致 + 账本 blind', async () => {
  const port = mockAdapter([{ screen: '7777777777777777', region: 'aaaaaaaaaaaaaaaa' }]);
  patchSystem({ pressHotkey: async () => { /* noop */ } });
  // 无 recordTargetWindow、无点击 ⇒ resolveCaretAnchor null ⇒ 无验证面
  const out = await runJson(createPressHotkeyTool(CFG), { keys: ['shift', 'end'] });
  assert.equal(port.count(), 0, '无锚 ⇒ 不取快照');
  assert.match(out.next_step, /^SELECTION UNVERIFIED: this receipt CANNOT see/);
  assert.match(out.next_step, /duplicate-text hazard/);
  assert.equal(out.state_anchor.selection_check, undefined);
  assert.equal(peekSelectionVerification(60_000)?.verdict, 'blind');
});

test('ANB2-C7: 快照车道故障（端口抛错）⇒ 派发照常 + 盲态回执（绝不抛、不阻断）', async () => {
  recordTargetWindow({ keyword: '记事本' });
  mockAdapter([{ screen: '7777777777777777', region: 'aaaaaaaaaaaaaaaa' }], 0 /* 首呼即抛 */);
  patchSystem({ pressHotkey: async () => { /* noop */ } });
  const out = await runJson(createPressHotkeyTool(CFG), { keys: ['shift', 'end'] });
  assert.equal(out.status, 'SUCCESS');
  assert.match(out.next_step, /^SELECTION UNVERIFIED: this receipt CANNOT see/);
  assert.equal(peekSelectionVerification(60_000)?.verdict, 'blind');
});

test('ANB2-C8: 无 config 装配（既有测试路径）⇒ 选族回执与 R5-2 盲态逐字节一致', async () => {
  recordTargetWindow({ keyword: '记事本' });
  const port = mockAdapter([{ screen: '7777777777777777', region: 'aaaaaaaaaaaaaaaa' }]);
  patchSystem({ pressHotkey: async () => { /* noop */ } });
  const out = await runJson(createPressHotkeyTool(), { keys: ['shift', 'end'] });
  assert.equal(port.count(), 0, '无 config ⇒ 零验证面开销（r52 兼容）');
  assert.match(out.next_step, /^SELECTION UNVERIFIED: this receipt CANNOT see/);
  assert.equal(peekSelectionVerification(60_000)?.verdict, 'blind');
  // isSelectionChord 判定纯函数（R5-2 立法）不回归
  assert.equal(isSelectionChord(['shift', 'end']), true);
  assert.equal(isSelectionChord(['ctrl', 'end']), false);
});

// ═══ D：回执贯通（press_hotkey 验证状态 → type_text 语义）═══

async function dispatchVerifiedSelection(): Promise<void> {
  const { screenA, screenB, regionA, regionB } = await syntheticSelectionHashes();
  mockAdapter([
    { screen: screenA, region: regionA },
    { screen: screenB, region: regionB },
    { screen: screenB, region: regionB }, // 后续 type_text 的前后帧（同帧 ⇒ noop）
  ]);
  patchSystem({ pressHotkey: async () => { /* noop */ } });
  const out = await runJson(createPressHotkeyTool(CFG), { keys: ['shift', 'end'] });
  assert.match(out.next_step, /^SELECTION VERIFIED/, '前置：选区验证命中');
}

test('ANB2-D1: VERIFIED 选区在场 ⇒ type_text 覆盖语义 + 一次性消费（第二次回 Append）', async () => {
  recordTargetWindow({ keyword: '记事本', matchedTitle: '无标题 - 记事本' });
  await dispatchVerifiedSelection();
  patchSystem({ typeText: async () => { /* noop */ } });
  const first = await runJson(createTypeTextTool(CFG), { text: 'REPLACEMENT' });
  assert.equal(first.status, 'SUCCESS');
  assert.match(first.state_anchor.input_state, /Replacing the last VERIFIED selection/);
  assert.match(first.state_anchor.input_state, /overwrites the selected range/);
  assert.equal(first.state_anchor.selection_replacement.selection, 'verified');
  assert.equal(first.state_anchor.selection_replacement.verification_anchor, 'pseudo-window-center');
  // 一次性消费：打字即覆盖选区，VERIFIED 语义不跨打字存活
  const second = await runJson(createTypeTextTool(CFG), { text: 'MORE' });
  assert.equal(second.state_anchor.selection_replacement, undefined);
  assert.equal(second.state_anchor.input_state, 'Appended to existing content');
});

test('ANB2-D2: UNVERIFIED 选区 ⇒ type_text 维持 R5-2 防盲打话术 + 附实测差分值', async () => {
  recordTargetWindow({ keyword: '记事本' });
  mockAdapter([
    { screen: '7777777777777777', region: 'aaaaaaaaaaaaaaaa' }, // 和弦前后同帧 ⇒ 100%
    { screen: '7777777777777777', region: 'aaaaaaaaaaaaaaaa' },
    { screen: '7777777777777777', region: 'aaaaaaaaaaaaaaaa' }, // type_text 前后同帧
  ]);
  patchSystem({ pressHotkey: async () => { /* noop */ }, typeText: async () => { /* noop */ } });
  const chord = await runJson(createPressHotkeyTool(CFG), { keys: ['shift', 'end'] });
  assert.match(chord.next_step, /^SELECTION UNVERIFIED/);
  const out = await runJson(createTypeTextTool(CFG), { text: 'ROW-2-EDITED-FULL' });
  // 防盲打：不宣称替换 + noop 警告 + 伪锚披露 + 禁盲重打
  assert.equal(out.state_anchor.input_state, 'Appended to existing content');
  assert.equal(out.state_anchor.selection_replacement.selection, 'unverified');
  assert.equal(out.state_anchor.selection_replacement.region_similarity_pct, 100);
  assert.match(out.action, /WINDOW-CENTER PSEUDO anchor/);
  assert.match(out.next_step, /blind retyping duplicates the inserted text/);
});

test('ANB2-D3: blind 选族（无验证面）⇒ type_text 同样不宣称替换（保守一致）', async () => {
  recordTargetWindow({ keyword: '记事本' });
  // 无 config 工具派发选族 ⇒ blind 账本；type_text 消费到 blind 状态
  patchSystem({ pressHotkey: async () => { /* noop */ }, typeText: async () => { /* noop */ } });
  mockAdapter([{ screen: '7777777777777777', region: 'aaaaaaaaaaaaaaaa' }]);
  await runJson(createPressHotkeyTool(), { keys: ['shift', 'end'] });
  assert.equal(peekSelectionVerification(60_000)?.verdict, 'blind');
  const out = await runJson(createTypeTextTool(CFG), { text: 'X' });
  assert.equal(out.state_anchor.input_state, 'Appended to existing content');
  assert.equal(out.state_anchor.selection_replacement.selection, 'blind');
});

test('ANB2-D4: clearFirst 优先于选区覆盖语义（工具自带全选清空）', async () => {
  recordTargetWindow({ keyword: '记事本' });
  await dispatchVerifiedSelection();
  patchSystem({ typeText: async () => { /* noop */ } });
  const out = await runJson(createTypeTextTool(CFG), { text: 'ALL', clearFirst: true });
  assert.equal(out.state_anchor.input_state, 'Replaced all previous content');
});
