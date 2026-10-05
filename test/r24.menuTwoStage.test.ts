// test/r24.menuTwoStage.test.ts
// R2-4（菜单项级点击精度 · R1-8 冒烟遗留⑤的确定性根因修复册）：
//   证据量化（attempt5-9 hist + 截图像素取证）：
//     · 文件菜单栏条目真值 ≈(0.016,0.056)，模型点击 (0.031-0.04, 0.035-0.045)
//       —— x 偏右 30-47px（落到 编辑/间隙）、y 偏高（落标签条），attempt9 三连
//       menu_expand 全部「below-click zone static」；
//     · 另存为菜单项真值 y≈0.184（下拉 y 0.129-0.208，5 项行距 ~0.0164），模型
//       点 0.125/0.21/0.28/0.381 —— 误差 -0.059~+0.197，双向无定偏 = 小目标
//       grounding 精度问题（1440x810 附件里菜单项字高 <10px），非鼠标漂移；
//     · 菜单未开时菜单项坐标 = 正文区，交互性闸门以 I-beam 拦截（attempt9
//       seq59 ACTION_REQUIRED），但通用 STATIC CONTENT 话术没有给出
//       「回第一阶段开菜单」的路径，模型原地重试。
//   修法（确定性路径，不依赖 VLM 换脑）：
//     ① menu_expand 背叛 ⇒ 专项 MENU DID NOT OPEN 话术（禁点菜单项 + zoom 复核）；
//     ② 菜单项语义 + 闸门拦截 ⇒ MENU NOT OPEN 两段式话术；
//     ③ 提示词层 VISION_GROUNDING 小目标纪律 + ReAct 两段式菜单协议（纯文本，
//        本册以话术纯函数 + 工具面 e2e 钉执法，提示词文本由 r29 方言普查覆盖面）。
// 全离线确定性：mouseVerify 注入缝（epochBeta 同法）+ system 物理面假件。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import type { Config } from '../src/config.ts';
import { system } from '../src/system.ts';
import { focusTracker } from '../src/focusTracker.ts';
import { menuItemSemantics } from '../src/intent.ts';
import {
  createClickMouseTool, mouseVerify,
  menuExpandBetrayedHint, menuNotOpenGateHint,
} from '../src/tools/clickMouse.ts';
import type { BeforeState, CombinedEffect } from '../src/actionVerifier.ts';

// ─── 假件工坊（epochR/epochBeta 同法）───

type Executable = { execute: (a: unknown) => Promise<string> };

const originalSystem = {
  clickMouse: system.clickMouse.bind(system),
  getScreenSize: system.getScreenSize.bind(system),
};
const originalVerify = {
  captureBefore: mouseVerify.captureBefore.bind(mouseVerify),
  settleAndVerify: mouseVerify.settleAndVerify.bind(mouseVerify),
};
let clicks = 0;

beforeEach(() => {
  focusTracker.clear();
  clicks = 0;
  system.clickMouse = async () => { clicks++; };
  system.getScreenSize = async () => ({ width: 1920, height: 1080 });
});

afterEach(() => {
  system.clickMouse = originalSystem.clickMouse;
  system.getScreenSize = originalSystem.getScreenSize;
  mouseVerify.captureBefore = originalVerify.captureBefore;
  mouseVerify.settleAndVerify = originalVerify.settleAndVerify;
  focusTracker.clear();
});

/** 菜单精操测试配置：验证/意图开、探针关（probe 无离线 seam）、公证/分道关 */
const toolCfg = {
  enableApprovalGate: true,
  dangerPatterns: 'send,发送,delete,删除,pay,支付',
  enableRiskGate: false,
  riskPatterns: '',
  maxTextLength: 1000,
  focusMaxAgeMs: 60_000,
  enableNotarizationLock: false,
  enableReversibilityLanes: false,
  enableOcr: false,
  dryRun: false,
  verifyActions: true,
  intentVerify: true,
  autoRemember: false,
  adaptiveSettle: false,
  actionSettleMs: 1,
  noopSimilarityThreshold: 0.97,
  regionVerifyRadius: 0.15,
  physicsRules: '',
  enableInteractivityProbe: false,
} as unknown as Config;

/** 注入伪造效果链（menu_expand / menu_collapse 背叛等） */
function fakeEffect(intent: { expected: string; satisfied: boolean; evidence: string }): void {
  mouseVerify.captureBefore = async (): Promise<BeforeState> =>
    ({ screen: 'ab', region: null, focus: { x: 0.03, y: 0.05 } }) as unknown as BeforeState;
  mouseVerify.settleAndVerify = async (): Promise<CombinedEffect> =>
    ({
      detected: true,
      scale: 'page-level',
      screen: { effect_detected: true, similarity_pct: 78.1, distance: 40 },
      region: null,
      intent,
      afterBuffer: Buffer.alloc(0), afterHash: '', oscillation: null,
    }) as unknown as CombinedEffect;
}

async function runJson(args: unknown): Promise<any> {
  const tool = createClickMouseTool(toolCfg) as Executable;
  return JSON.parse(await tool.execute(args));
}

// ═══ ① menuItemSemantics 词形真值表（attempt5-9 实测话术全覆盖）═══

test('R2-4①: menuItemSemantics —— 实战菜单项话术全命中，非菜单项/阶段一话术不误报', () => {
  // 正例：9 次尝试里模型实际写过的菜单项目标描述
  assert.equal(menuItemSemantics('文件菜单下拉中的 保存 菜单项'), true);
  assert.equal(menuItemSemantics('文件菜单下拉中的 另存为 菜单项'), true);
  assert.equal(menuItemSemantics('另存为 菜单项 (File 菜单第4项)'), true);
  assert.equal(menuItemSemantics('Save As menu item'), true);
  assert.equal(menuItemSemantics('the dropdown entry labeled Open'), true);
  assert.equal(menuItemSemantics('右键菜单里的 粘贴'), true);
  assert.equal(menuItemSemantics(undefined, 'submenu entry'), true, '多路信号任一命中即可');
  // 反例：阶段一（菜单栏条目本身）/ 普通控件 —— 不得触发菜单项话术
  assert.equal(menuItemSemantics('Notepad 文件(File) 菜单'), false, '菜单栏条目是阶段一目标');
  assert.equal(menuItemSemantics('GitHub 搜索框'), false);
  assert.equal(menuItemSemantics('提交按钮'), false);
  assert.equal(menuItemSemantics(undefined, null, ''), false);
});

// ═══ ② 话术纯函数：两段式协议关键要素在场 ═══

test('R2-4②: menuExpandBetrayedHint —— 禁点菜单项 + zoom 复核 + 证据嵌入', () => {
  const hint = menuExpandBetrayedHint('below-click zone static (brightness 247→245, detail 14.6→15.0)');
  assert.ok(hint.startsWith('MENU DID NOT OPEN'), '话术必须以可检索的强信号开头');
  assert.ok(hint.includes('below-click zone static'), '物理证据原样嵌入（attempt9 seq54 实测文案）');
  assert.ok(hint.includes('Do NOT click any menu item'), '明令禁止第二阶段');
  assert.ok(hint.includes('zoom_inspect'), '小目标 zoom 复核路径');
  assert.ok(hint.includes('menu_expand'), '重试仍须声明意图验证');
  assert.ok(hint.includes('intent.satisfied=true'), '给出放行判据');
});

test('R2-4③: menuNotOpenGateHint —— I-beam 拦截即「菜单没开」的确定性回读', () => {
  const hint = menuNotOpenGateHint();
  assert.ok(hint.startsWith('MENU NOT OPEN'));
  assert.ok(hint.includes('Do NOT retry these item coordinates'), '禁止原地重试（attempt9 三连病灶）');
  assert.ok(hint.includes('two-stage menu protocol'), '两段式协议指名');
  assert.ok(hint.includes('menu_expand'));
  assert.ok(hint.includes('THAT screenshot'), '菜单项坐标只认展开后截图');
});

// ═══ ③ 工具面 e2e：menu_expand 背叛切换专项话术 ═══

test('R2-4④: click_mouse menu_expand 背叛 ⇒ next_step 为 MENU DID NOT OPEN（attempt9 seq54 复现）', async () => {
  fakeEffect({
    expected: 'menu_expand', satisfied: false,
    evidence: 'below-click zone static (brightness 247→245, detail 14.6→15.0)',
  });
  const r = await runJson({
    x: 0.031, y: 0.037,
    target_description: '文件 菜单',
    expected_effect: '{"kind":"menu_expand"}',
  });
  assert.equal(r.status, 'SUCCESS');
  assert.equal(clicks, 1, '物理点击照常派发（话术强化不是拦截）');
  assert.equal(r.state_anchor.effect.intent.satisfied, false, '意图裁决如实透出');
  assert.ok(r.next_step.startsWith('MENU DID NOT OPEN'),
    `专项话术必须顶替通用 INTENT MISMATCH（实测：${r.next_step.slice(0, 80)}）`);
  assert.ok(!r.next_step.startsWith('INTENT MISMATCH'));
});

// ═══ ④ 回归：非 menu_expand 期望的背叛维持旧通用话术（零回归铁律）═══

test('R2-4⑤: menu_collapse 背叛（attempt7 seq49 同构）维持 INTENT MISMATCH 旧方言', async () => {
  fakeEffect({
    expected: 'menu_collapse', satisfied: false,
    evidence: 'menu area still changing (not collapsed)',
  });
  const r = await runJson({
    x: 0.04, y: 0.21,
    target_description: '文件菜单中的 另存为(Save As) 菜单项',
    expected_effect: '{"kind":"menu_collapse"}',
  });
  assert.equal(r.status, 'SUCCESS');
  assert.ok(r.next_step.startsWith('INTENT MISMATCH'),
    `非 menu_expand 期望不得吃到新话术（实测：${r.next_step.slice(0, 60)}）`);
});

// ═══ ⑤ 回归：menu_expand 满足时零变化（成功路径不吃强化话术）═══

test('R2-4⑥: menu_expand 满足（attempt7 seq34 同构）⇒ 通用验证指引，无 MENU 话术', async () => {
  fakeEffect({
    expected: 'menu_expand', satisfied: true,
    evidence: 'below-click zone changed (brightness 128→172, detail 84.2→88.3)',
  });
  const r = await runJson({
    x: 0.04, y: 0.045,
    target_description: 'Notepad 文件(File) 菜单',
    expected_effect: '{"kind":"menu_expand"}',
  });
  assert.equal(r.status, 'SUCCESS');
  assert.equal(r.state_anchor.effect.intent.satisfied, true);
  assert.ok(!r.next_step.includes('MENU DID NOT OPEN'), '菜单开成功不得误报');
  assert.ok(r.next_step.includes('take_screenshot'), '维持验证指引');
});

// ═══ ⑥ 提示词层：两段式纪律与小目标纪律在册（方言普查面）═══

test('R2-4⑦: 系统提示词两段式菜单协议 + 小目标 zoom 纪律入册', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf-8');
  assert.ok(src.includes('菜单操作两段式纪律'), 'ReAct 工作流提示必须含两段式纪律段');
  assert.ok(src.includes('expected_effect'), '协议必须显式声明意图验证');
  assert.ok(src.includes('小目标定位纪律'), 'VISION_GROUNDING 必须含小目标纪律段');
  assert.ok(src.includes('绝不跨窗口状态复用菜单栏坐标'), '窗口状态平移菜单栏的实测教训入册');
});
