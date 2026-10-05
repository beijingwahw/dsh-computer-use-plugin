// test/r43.dialectHardening.test.ts
// R4-3 · b 类回执话术补丁的执法册 —— R3-6 立项（批1 证据：R1-8 九连败 hist 精读）
// 逐条钉死新话术的关键字段，防回归（后续话术演进不得静默丢掉这些防误读锚）：
//   b1 probeMemory.recall note：MEMORY RECALL 显式警示（a9 seq159/179 误信）
//   b2 probe_interactivity control 判读：语义限定（a5/a7「menu rows verified」）
//   b3 TACTICAL_PAUSE：逃逸条款（a2/a4 幻觉关闭键坐标）+ 既有锚兼容
//   b4 type_text：SUCCESS 语义限定内嵌 action + noop WARNING 提级（a9 盲 type 链）
//   b5 click_mouse：page-level-only 防误读注记（a9 seq74/134 假「意图达成」）
//   b6 ask_screen / read_text：降级建议可执行化（7 次 0 执行的文字通道盲区）
// 全离线确定性：假 adapter（physicalBackend._setAdapterForTests）+ 假 system
// monkey-patch + 注入式 VLM client —— 零网络、零真截屏、零服务孵化。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as backend from '../src/physicalBackend.ts';
import { system } from '../src/system.ts';
import type { Config } from '../src/config.ts';
import { probeMemory } from '../src/probeMemory.ts';
import type { ProbeResult } from '../src/interactivityProbe.ts';
import { TACTICAL_PAUSE } from '../src/guards/popupGuard.ts';
import { createProbeInteractivityTool } from '../src/tools/probeInteractivity.ts';
import { createTypeTextTool } from '../src/tools/typeText.ts';
import { createClickMouseTool } from '../src/tools/clickMouse.ts';
import { createAskScreenTool } from '../src/tools/askScreen.ts';
import { createReadTextTool } from '../src/tools/textTools.ts';

type Exec = (a: unknown) => Promise<string>;
const exec = (t: unknown): Exec => (t as unknown as { execute: Exec }).execute;
async function runJson(t: unknown, args: unknown): Promise<any> {
  return JSON.parse(await exec(t)(args));
}

// ─── 假件工坊 ───

const originalSystem = {
  clickMouse: system.clickMouse.bind(system),
  typeText: system.typeText.bind(system),
  getScreenSize: system.getScreenSize.bind(system),
  getMousePosition: system.getMousePosition.bind(system),
};

function patchSystem(over: Record<string, unknown>): void {
  const host = system as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) host[k] = v;
}

after(() => {
  backend._setAdapterForTests(null);
  const host = system as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(originalSystem)) host[k] = v;
  probeMemory.reset();
});

/** UIA hitTest 假面（tools.probeInteractivity.test 同款 —— control 判决回放） */
function uiaAdapter() {
  return {
    hitTest: async () => ({
      ok: true as const,
      value: {
        available: true, classification: 'control', control_type: 'Button',
        name: 'Submit', matched_depth: 2,
      },
    }),
    getCursor: async () => ({ ok: true as const, value: { x: 960, y: 540 } }),
    moveMouse: async () => ({ ok: true as const, value: { pixel: { x: 960, y: 540 } } }),
    health: async () => ({ ok: true as const, value: { status: 'ok' as const } }),
  };
}

/** 可编程指纹适配器：takeScreenshot 按调用序出队 dhash/region_dhash（耗尽重复末值）。
 *  终帧取证非 metaOnly（读图路径）⇒ 携真 JPEG 字节（pan15-19 同款 tiny 帧）。 */
let TINY_JPEG = '';
function fingerprintAdapter(screenSeq: string[], regionSeq: string[]) {
  let n = -1;
  const at = (seq: string[]): string => seq[Math.min(Math.max(n, 0), seq.length - 1)];
  return {
    takeScreenshot: async (args?: { wantRegionHash?: unknown; metaOnly?: boolean }) => {
      n++;
      void args;
      return {
        ok: true as const,
        value: {
          transport: 'base64' as const, name: '', size: 0, shape: [1, 1, 3] as [number, number, number],
          dtype: 'uint8', stride: 0, format: 'png', width: 1, height: 1, captured_at: 1,
          image_base64: TINY_JPEG, dhash: at(screenSeq), phash: null, region_dhash: at(regionSeq),
          unchanged: false, frame_id: null,
        },
      };
    },
  };
}

// 64 位指纹样本（hex；两个陷阱都避开：全零 ⇒ Δ-7 unverifiable；纯 0/1 字符的
// hex 会被 normalizeHash 误读为位串 ⇒ 长度不匹配同样 unverifiable）
const SCREEN_A = '7777777777777777'; // nibble 0111
const SCREEN_B = 'eeeeeeeeeeeeeeee'; // nibble 1110 —— 与 A 汉明距 32/64 ⇒ sim 0.5（页级变化）
const REGION_R = 'aaaaaaaaaaaaaaaa'; // nibble 1010
const REGION_S = 'aaaaaffaaaaaaaaa'; // 与 R 汉明距 4/64 ⇒ sim 0.9375（区域变化）

// ═══ b1：probeMemory 记忆召回 note 升格警示 ═══

test('R4-3 b1: 记忆召回 note = MEMORY RECALL 显式警示（非现场证据申报 + 复核指令）', () => {
  probeMemory.reset();
  const cfg = {
    probeMemoryTtlMs: 300_000, probeMemoryCapacity: 128,
    probeMemorySceneSimilarity: 0.9, probeRecallRadius: 0.015,
  };
  const FP = '0123456789abcdef';
  const stored: ProbeResult = {
    point: { x: 0.5, y: 0.5 },
    verdict: 'control', confidence: 0.85,
    evidence: { via: 'hover', cursor_kind: 'arrow', hover_repaint: true, repaint_similarity: 0.9, dwell_ms: 300 },
  };
  probeMemory.store(FP, stored, cfg as never);
  const hit = probeMemory.recall(FP, { x: 0.5, y: 0.5 }, cfg as never);
  assert.ok(hit, '同场景邻近点应命中');
  // 新警示锚（a9 seq159/179 误信面）：一句话内完成「这是缓存 / 不是本屏 / 怎么办」
  assert.match(hit.note!, /^MEMORY RECALL \(cached from an earlier scene, NOT the current screen/);
  assert.match(hit.note!, /do NOT treat as fresh evidence/);
  assert.match(hit.note!, /re-probe or take_screenshot before acting/);
  // 原遥测加法保留（诊断面不回归）
  assert.match(hit.note!, /scene_similarity=1\.000/);
  assert.match(hit.note!, /hits=\d+/);
});

// ═══ b2：probe_interactivity control 判读语义限定 ═══

test('R4-3 b2: control 回执附语义限定 —— 「某控件」≠「哪个控件」，菜单项仅在展开期在场', async () => {
  backend._setAdapterForTests(uiaAdapter() as never);
  const cfg = {
    dryRun: false, enableProbeMemory: false, enableProbeEconomy: false,
    probeDwellMs: 300, probeRegionRadius: 0.02, probeRepaintThreshold: 0.97,
  } as unknown as Config;
  const out = await runJson(createProbeInteractivityTool(cfg), { x: 0.5, y: 0.3 });
  assert.equal(out.state_anchor.verdict, 'control');
  assert.equal(out.state_anchor.confidence, 0.97, '判决与置信零回归（话术-only 补丁）');
  assert.match(out.next_step, /The OS confirms this is an interactive element/, '原句保留（加法式）');
  assert.match(out.next_step, /does NOT identify WHICH control/, '语义限定在场');
  assert.match(out.next_step, /ONLY while its dropdown is expanded/, '菜单项存在性限定在场');
  assert.match(out.next_step, /take_screenshot \/ zoom_inspect/, '限定后给出可执行复核路径');
});

// ═══ b3：TACTICAL_PAUSE 逃逸条款（+ 既有测试锚兼容面） ═══

test('R4-3 b3: TACTICAL_PAUSE 逃逸条款 —— 无弹窗在场时禁猜关闭键', () => {
  const out = JSON.parse(TACTICAL_PAUSE);
  assert.equal(out.status, 'ACTION_REQUIRED');
  assert.equal(out.state_anchor.current_state, 'Screen is blocked by an unexpected popup or modal.');
  // 新逃逸锚（a2/a4 幻觉坐标面）
  assert.match(out.next_step, /ESCAPE CLAUSE/);
  assert.match(out.next_step, /NO popup\/modal on screen/);
  assert.match(out.next_step, /do NOT guess a close button position/);
  assert.match(out.next_step, /detector may be stale/);
  assert.match(out.next_step, /take_screenshot/);
  assert.match(out.next_step, /report this mismatch to the user/);
  // 既有执法锚兼容（tools.dismissPopup.test.ts 钉的形状不破）
  assert.match(out.next_step, /MANDATORY/);
  assert.match(out.next_step, /'click_mouse'/);
  assert.match(out.next_step, /'X'|Close|Cancel/);
});

// ═══ b4：type_text SUCCESS 语义限定 + noop WARNING 提级 action ═══

test('R4-3 b4①: SUCCESS 回执 action 内嵌语义限定 —— SUCCESS = 按键已发出 ≠ 落对字段', async () => {
  // 验证关闭路径（effect='verification-off'）：SUCCESS 头不再裸奔
  patchSystem({
    typeText: async () => { /* noop */ },
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
  });
  const cfg = {
    maxTextLength: 1000, focusMaxAgeMs: 60_000,
    enableRiskGate: false, riskPatterns: '', enableApprovalGate: false, dangerPatterns: '',
    verifyActions: false, dryRun: false, enableOcr: false,
  } as unknown as Config;
  const out = await runJson(createTypeTextTool(cfg), { text: 'hello world' });
  assert.equal(out.status, 'SUCCESS');
  assert.match(out.action, /Text typed successfully/);
  assert.match(out.action, /SUCCESS = keystrokes dispatched, not that the intended field received them/);
  // ΑΩ-R29 键序铁律不破（r29.dialectCensus 同款断言）
  assert.deepEqual(Object.keys(out), ['status', 'action', 'state_anchor', 'next_step']);
});

test('R4-3 b4②: noop 输入 —— WARNING 提级到 action 字段，链式动作在头部被判停', async () => {
  const { default: sharp } = await import('sharp');
  TINY_JPEG = (await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 90, g: 90, b: 90 } },
  }).jpeg().toBuffer()).toString('base64');
  // 前后帧指纹全同 ⇒ effect.detected=false（a9 seq88-99 形态：对话框从未打开）
  patchSystem({
    typeText: async () => { /* noop */ },
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    getMousePosition: async () => ({ x: 100, y: 100 }), // 焦点兜底 → 区域验证开启
  });
  backend._setAdapterForTests(fingerprintAdapter([SCREEN_A, SCREEN_A], [REGION_R, REGION_R]) as never);
  const cfg = {
    maxTextLength: 1000, focusMaxAgeMs: 60_000,
    enableRiskGate: false, riskPatterns: '', enableApprovalGate: false, dangerPatterns: '',
    verifyActions: true, dryRun: false, adaptiveSettle: false, actionSettleMs: 1,
    noopSimilarityThreshold: 0.97, regionVerifyRadius: 0.15, enableOcr: false,
  } as unknown as Config;
  const out = await runJson(createTypeTextTool(cfg), { text: 'C:\\save\\me.txt' });
  assert.equal(out.status, 'SUCCESS', '状态语义不变（诚实分层：状态/动作/指引各司其职）');
  assert.equal(out.state_anchor.effect.detected, false);
  // 提级后的头部判停（旧话术只活在不被读的 next_step 尾部）
  assert.match(out.action, /^WARNING: keystrokes dispatched but NO screen\/focus-region change was verified/);
  assert.match(out.action, /may have gone NOWHERE/);
  assert.match(out.action, /Do NOT chain the next action on this input/);
  // 尾部既有 WARNING 指引保留（加法式）
  assert.match(out.next_step, /Click the input field first, then retype/);
});

// ═══ b5：click_mouse page-level-only 防误读注记 ═══

test('R4-3 b5①: page-level-only（区域未证实）⇒ next_step 附环境噪声防误读注记', async () => {
  const { default: sharp } = await import('sharp');
  TINY_JPEG = (await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 90, g: 90, b: 90 } },
  }).jpeg().toBuffer()).toString('base64');
  patchSystem({
    clickMouse: async () => { /* noop */ },
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
  });
  // 前= SCREEN_A / 后= SCREEN_B（全屏变）；区域恒 R（点击点邻域纹丝不动）
  backend._setAdapterForTests(fingerprintAdapter([SCREEN_A, SCREEN_B], [REGION_R, REGION_R]) as never);
  const cfg = {
    enableApprovalGate: true, dangerPatterns: '', enableRiskGate: false, riskPatterns: '',
    maxTextLength: 1000, focusMaxAgeMs: 60_000,
    enableNotarizationLock: false, enableRefuteCourt: false,
    enableOcr: false, ocrLang: 'eng', dryRun: false,
    verifyActions: true, intentVerify: false, autoRemember: false,
    adaptiveSettle: false, actionSettleMs: 1, noopSimilarityThreshold: 0.97,
    regionVerifyRadius: 0.15, physicsRules: '', enableInteractivityProbe: false,
    enableJournal: false,
  } as unknown as Config;
  const out = await runJson(createClickMouseTool(cfg), { x: 0.5, y: 0.5, target_description: 'File menu' });
  assert.equal(out.status, 'SUCCESS');
  assert.equal(out.state_anchor.effect.detected, true);
  assert.equal(out.state_anchor.effect.scale, 'page-level', '前置：全屏变 + 区域不变 = page-level-only');
  assert.ok(out.state_anchor.effect.region_similarity_pct >= 97, '区域高相似（点击点邻域未变）');
  // 新防误读锚（a9 seq74/134 面）
  assert.match(out.next_step, /CAUTION: the change was detected only at PAGE level/);
  assert.match(out.next_step, /clicked region itself did NOT change/);
  assert.match(out.next_step, /ambient change/);
  assert.match(out.next_step, /BEFORE chaining the next action/);
});

test('R4-3 b5②: 区域同步变化（element 证据在场）⇒ 不附 page-level-only 注记（防误伤）', async () => {
  TINY_JPEG = TINY_JPEG || ''; // b5① 已铸帧；若单跑本条则惰性补铸
  if (!TINY_JPEG) {
    const { default: sharp } = await import('sharp');
    TINY_JPEG = (await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 90, g: 90, b: 90 } },
    }).jpeg().toBuffer()).toString('base64');
  }
  patchSystem({
    clickMouse: async () => { /* noop */ },
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
  });
  // 全屏变 + 区域也变（R→S）⇒ 双尺度证据一致，注记不入场
  backend._setAdapterForTests(fingerprintAdapter([SCREEN_A, SCREEN_B], [REGION_R, REGION_S]) as never);
  const cfg = {
    enableApprovalGate: true, dangerPatterns: '', enableRiskGate: false, riskPatterns: '',
    maxTextLength: 1000, focusMaxAgeMs: 60_000,
    enableNotarizationLock: false, enableRefuteCourt: false,
    enableOcr: false, ocrLang: 'eng', dryRun: false,
    verifyActions: true, intentVerify: false, autoRemember: false,
    adaptiveSettle: false, actionSettleMs: 1, noopSimilarityThreshold: 0.97,
    regionVerifyRadius: 0.15, physicsRules: '', enableInteractivityProbe: false,
    enableJournal: false,
  } as unknown as Config;
  const out = await runJson(createClickMouseTool(cfg), { x: 0.5, y: 0.5, target_description: 'File menu' });
  assert.equal(out.status, 'SUCCESS');
  assert.equal(out.state_anchor.effect.detected, true);
  assert.equal(out.state_anchor.effect.region_similarity_pct < 97, true, '区域已检出变化');
  assert.doesNotMatch(out.next_step, /CAUTION: the change was detected only at PAGE level/,
    '区域证据在场 ⇒ 不误伤合法页级跳转');
});

// ═══ b6：ask_screen / read_text 降级建议可执行化 ═══

test('R4-3 b6①: ask_screen 云脑失联 —— 降级建议为逐步命令 + 重试熔断', async () => {
  const { default: sharp } = await import('sharp');
  const tinyJpeg = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 90, g: 90, b: 90 } },
  }).jpeg().toBuffer();
  const failing = {
    chat: async () => ({ ok: false as const, error: '429 rate limited' }),
  };
  const tool = createAskScreenTool({} as Config, {
    capture: async () => tinyJpeg,
    client: failing as never,
  });
  const out = await runJson(tool, { question: 'Is a dialog open?' });
  assert.equal(out.status, 'FAILED');
  assert.match(out.state_anchor.error, /429/);
  assert.match(out.next_step, /Do this NOW/, '指令式开场（非工具清单）');
  assert.match(out.next_step, /take_screenshot/);
  assert.match(out.next_step, /read_text/);
  assert.match(out.next_step, /find_text with your exact keyword/, '点名参数形状');
  assert.match(out.next_step, /at most once/, '重试熔断');
});

test('R4-3 b6②: ask_screen 空答案 —— 重构问句一次 + 自答路径', async () => {
  const { default: sharp } = await import('sharp');
  const tinyJpeg = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 90, g: 90, b: 90 } },
  }).jpeg().toBuffer();
  const blank = {
    chat: async () => ({ ok: true as const, text: '   ', model: 'glm-flash', latencyMs: 5 }),
  };
  const tool = createAskScreenTool({} as Config, {
    capture: async () => tinyJpeg,
    client: blank as never,
  });
  const out = await runJson(tool, { question: 'What is on screen?' });
  assert.equal(out.status, 'FAILED');
  assert.match(out.next_step, /Rephrase the question more concretely and retry ONCE/);
  assert.match(out.next_step, /take_screenshot and answer it yourself/);
  assert.match(out.next_step, /read_text/);
});

test('R4-3 b6③: read_text OCR 全路径失败 —— 降级指引含 zoom_inspect 替代 + 熔断', async () => {
  backend._setAdapterForTests({
    getUiTree: async () => ({ ok: false as const, error: { kind: 'ocr_unavailable', detail: 'engine missing' } }),
    takeScreenshot: async () => ({ ok: false as const, error: { kind: 'screen_capture_failed', detail: 'no frame' } }),
  } as never);
  const out = await exec(createReadTextTool({ ocrLang: 'eng' } as unknown as Config))({});
  assert.match(out, /^\[Error\]: OCR failed \(/);
  // 旧锚保留（tools.textTools.test.ts:166 钉形状）+ 新可执行化锚
  assert.match(out, /fall back to take_screenshot/);
  assert.match(out, /read the screen yourself/);
  assert.match(out, /zoom_inspect on its region instead of retrying read_text/);
});
