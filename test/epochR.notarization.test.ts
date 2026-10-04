// test/epochR.notarization.test.ts
// 纪元 Ρ（双钥公证锁）执法册 —— 执法编号：
//   Ρ-1 注入锁持律：描述无害（"press the button"）但 OCR 实读「删除」⇒ 判危险需令牌
//           （被提示注入的模型谎报目标不再能绕过 dangerPatterns 词表）。
//   Ρ-2 语义握手执法：描述与 OCR 实读不符 ⇒ 拒绝 notary-mismatch + 引导按屏幕
//           实读文字重述；相符 ⇒ 放行；短标签/纯标点 ⇒ 跳过握手记 degraded 注记。
//   Ρ-3 诚实降级：evidence 缺席/两新通道全 null ⇒ 与旧版逐字段同判 + degraded
//           标志；总开关 enableNotarizationLock=false ⇒ 完全旧路径（键不入场）。
//   Ρ-4 白盒通道：structuralName（UIA 控件登记名）命中危险 ⇒ 拦（含混淆归一）。
//   Ρ-5 click_element 不再绕闸：假 OCR provider 断言闸门被调用（元素名自述通道
//           + 落点邻域 OCR 公证通道，物理派发计数 = 0）。
// 全离线确定性：假 system（物理派发计数器）、假 accessibility provider、
// 假 OCR provider（notaryEvidence 注入缝）—— 零真网络、零真截屏、零服务孵化。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from '../src/config.ts';
import { approval, resetApproval, setConfirmCodeChannel, type ConfirmCodeDelivery } from '../src/approval.ts';
import { journal } from '../src/journal.ts';
import { system } from '../src/system.ts';
import { setAccessibilityProvider } from '../src/uiExtractor.ts';
import { assertActionAllowed, type ActionGateDecision } from '../src/tools/actionGate.ts';
import { createClickMouseTool, notaryEvidence } from '../src/tools/clickMouse.ts';
import { createClickElementTool } from '../src/tools/clickElement.ts';

// ─── 假件工坊：物理派发计数器 + 公证取证注入缝 ───

const originalSystem = {
  clickMouse: system.clickMouse.bind(system),
  getScreenSize: system.getScreenSize.bind(system),
};
const originalNotary = {
  readOcrLabel: notaryEvidence.readOcrLabel.bind(notaryEvidence),
  readStructuralName: notaryEvidence.readStructuralName.bind(notaryEvidence),
};
let clicks = 0;

/** W6R fail-closed：带外码采集 + 携码授予（无码 grant 已废除 —— 授予面一律走此助手） */
const oobSink: ConfirmCodeDelivery[] = [];
function armOob(): void {
  setConfirmCodeChannel(d => { oobSink.push({ ...d }); });
}
function grantOob(token: string): boolean {
  const hit = oobSink.find(d => d.token === token);
  return approval.grantDetailed(token, true, hit ? { confirmCode: hit.confirmCode } : {}).ok;
}

beforeEach(() => {
  resetApproval();
  journal.reset();
  clicks = 0;
  system.clickMouse = async () => { clicks++; };
  system.getScreenSize = async () => ({ width: 1920, height: 1080 });
});

afterEach(() => {
  system.clickMouse = originalSystem.clickMouse;
  system.getScreenSize = originalSystem.getScreenSize;
  notaryEvidence.readOcrLabel = originalNotary.readOcrLabel;
  notaryEvidence.readStructuralName = originalNotary.readStructuralName;
  setAccessibilityProvider(null as any);
});

/** 单元级闸门配置：锁定 = 开、握手 = 开、词表覆盖中英危险词 */
const cfg = {
  enableApprovalGate: true,
  dangerPatterns: 'send,发送,delete,删除,pay,支付,uninstall,卸载',
  enableRiskGate: false,
  riskPatterns: '',
  maxTextLength: 1000,
  focusMaxAgeMs: 60_000,
  enableNotarizationLock: true,
  notarySemanticHandshake: true,
} as unknown as Config;

/** 工具级配置：验证/探针全关（聚焦公证执法，不碰 D-5 后端），OCR 通道开 */
const toolCfg = {
  ...cfg,
  enableOcr: true,
  ocrLang: 'eng',
  dryRun: false,
  verifyActions: false,
  intentVerify: false,
  autoRemember: false,
  adaptiveSettle: false,
  actionSettleMs: 1,
  noopSimilarityThreshold: 0.97,
  regionVerifyRadius: 0.15,
  physicsRules: '',
  enableInteractivityProbe: false,
  enableJournal: true,
} as unknown as Config;

type Executable = { execute: (a: unknown) => Promise<string> };

async function runJson(tool: unknown, args: unknown): Promise<any> {
  const out = await (tool as Executable).execute(args);
  return JSON.parse(out);
}

// ─── Ρ-1 注入锁持律 ───

test('Ρ-1: 描述无害但 OCR 实读「删除」⇒ 判危险需令牌（含混淆归一 + 令牌解封）', () => {
  // 注入场景：模型自述无害，屏幕上实打实写着「删除」
  const d = assertActionAllowed('click_mouse', { target_description: 'press the button' }, cfg, { ocrLabel: '删除' });
  assert.equal(d.allowed, false, 'OCR 公证通道见危险 ⇒ 拦');
  assert.equal(d.reason, 'irreversible-action');
  assert.equal(d.requiresApproval, true, '属审批域：一枚已授予令牌可解封');
  assert.equal(d.dangerous, true);
  assert.equal(d.dangerSignalChannel, 'ocr_label', '锚点归因到 OCR 公证通道');
  assert.equal(d.notarization, 'engaged');

  // 混淆免疫：全角/leet 变体经 normalizeForRisk 同律归一后命中（ｄｅｌｅｔｅ→delete）
  const obf = assertActionAllowed('click_mouse', { target_description: 'ok button' }, cfg, { ocrLabel: 'ｄｅｌｅｔｅ ｎｏｗ' });
  assert.equal(obf.allowed, false, '全角变体命中');
  const leet = assertActionAllowed('click_mouse', { target_description: 'ok button' }, cfg, { ocrLabel: 'd3lete it' });
  assert.equal(leet.allowed, false, 'leet 变体命中');

  // 已授予令牌解封（公证判危险 = 审批域语义，不因通道来源而变）
  armOob(); // W6R：授予须带外码
  const pa = approval.request('点击删除按钮以清空回收站');
  assert.equal(grantOob(pa.token), true);
  const ok = assertActionAllowed(
    'click_mouse',
    { target_description: 'press the 删除 button', approval_token: pa.token },
    cfg, { ocrLabel: '删除' },
  );
  assert.equal(ok.allowed, true, '已授予令牌 + 描述与实读一致 ⇒ 放行');
  assert.equal(ok.dangerous, true);

  // 令牌在场但未授予：归因不变（请求≠同意）
  const ungranted = assertActionAllowed(
    'click_mouse', { target_description: 'press the button', approval_token: 'APR-FAKE' },
    cfg, { ocrLabel: '删除' },
  );
  assert.equal(ungranted.reason, 'token-not-granted-or-expired');
  assert.equal(ungranted.dangerSignalChannel, 'ocr_label');
});

test('Ρ-1b: click_mouse 工具面 —— 假 OCR provider 驱动公证拦截，物理派发 = 0', async () => {
  const tool = createClickMouseTool(toolCfg);
  // 注入锁持律在工具面执法：描述无害，屏幕实读「删除」
  notaryEvidence.readOcrLabel = async () => '删除';
  const out = await runJson(tool, { x: 0.5, y: 0.5, target_description: 'press the button' });
  assert.equal(out.status, 'ACTION_REQUIRED');
  assert.equal(out.state_anchor.reason, 'irreversible-action');
  assert.equal(out.state_anchor.danger_signal, 'ocr_label');
  assert.match(out.state_anchor.note, /NOTARIZED FROM/i, '锚点写明危险来自屏幕公证而非描述');
  assert.equal(clicks, 0, '物理点击未派发');
  // 审计留痕：GUARD_BLOCKED（notary-lock）入防篡改链
  assert.ok(
    journal.list(false).some(e => e.tool === 'GUARD_BLOCKED' && e.args?.guard === 'notary-lock'),
    '公证拦截以 GUARD 方言入链',
  );
});

// ─── Ρ-2 语义握手执法 ───

test('Ρ-2: 描述与 OCR 不符 ⇒ notary-mismatch 引导重述；相符放行；短标签跳过', () => {
  // 不符（两侧皆无危险词）：模型描述「菜单」，屏上是订阅入口 —— 谎报/漂移
  const bad = assertActionAllowed('click_mouse', { target_description: '菜单按钮' }, cfg, { ocrLabel: 'Subscribe Now' });
  assert.equal(bad.allowed, false);
  assert.equal(bad.reason, 'notary-mismatch');
  assert.equal(bad.requiresApproval, false, '重述可解，令牌不可解');
  assert.equal(bad.dangerous, false);
  assert.equal(bad.notarization, 'engaged');

  // 相符（中文）：描述含屏幕实读词元 ⇒ 放行
  const goodZh = assertActionAllowed('click_mouse', { target_description: '点击「保存设置」按钮' }, cfg, { ocrLabel: '保存设置' });
  assert.equal(goodZh.allowed, true);
  assert.equal(goodZh.notarization, 'engaged');

  // 相符（英文，反向包含）：实读标签包含描述词元
  const goodEn = assertActionAllowed('click_mouse', { target_description: 'save' }, cfg, { ocrLabel: 'Save Changes' });
  assert.equal(goodEn.allowed, true);

  // 短标签（<2 字符，图标按钮的 ×）：跳过握手，记 degraded 注记（防误杀）
  const icon = assertActionAllowed('click_mouse', { target_description: 'menu' }, cfg, { ocrLabel: '×' });
  assert.equal(icon.allowed, true);
  assert.equal(icon.notarization, 'degraded');
  assert.match(icon.notaryNote ?? '', /ocr-label-too-short/);

  // 纯标点标签：归一化后为空，同律跳过
  const punct = assertActionAllowed('click_mouse', { target_description: 'menu' }, cfg, { ocrLabel: '···' });
  assert.equal(punct.allowed, true);
  assert.equal(punct.notarization, 'degraded');
  assert.match(punct.notaryNote ?? '', /ocr-label-pure-punctuation/);

  // 危险执法前置于握手（Ρ-1 律）：描述无害 + 屏读「删除」⇒ 需令牌，而非 mismatch
  const dangerFirst = assertActionAllowed('click_mouse', { target_description: 'press the button' }, cfg, { ocrLabel: '删除' });
  assert.equal(dangerFirst.reason, 'irreversible-action');

  // 令牌不豁免握手：已授予令牌但描述与实读不符 ⇒ 仍拒（令牌授权的是「这个目标」）
  armOob(); // W6R：授予须带外码
  const pa = approval.request('删除文件');
  grantOob(pa.token);
  const lying = assertActionAllowed(
    'click_mouse',
    { target_description: 'press the button', approval_token: pa.token },
    cfg, { ocrLabel: '删除' },
  );
  assert.equal(lying.allowed, false);
  assert.equal(lying.reason, 'notary-mismatch', '持令牌谎报目标同样被拒');

  // 握手开关关闭（部署逃生口）：不符也放行（危险词执法不受影响，见 Ρ-1）
  const off = assertActionAllowed(
    'click_mouse', { target_description: '菜单按钮' },
    { ...cfg, notarySemanticHandshake: false }, { ocrLabel: 'Subscribe Now' },
  );
  assert.equal(off.allowed, true);
  assert.equal(off.notarization, 'engaged', '危险扫描仍 engaged，仅握手退役');
});

test('Ρ-2b: click_mouse 工具面 —— mismatch 拒绝并引导按屏幕实读重述；相符放行', async () => {
  const tool = createClickMouseTool(toolCfg);
  // 不符：拒绝 + next_step 要求以屏幕实读文字重新描述
  notaryEvidence.readOcrLabel = async () => 'Subscribe Now';
  const bad = await runJson(tool, { x: 0.5, y: 0.5, target_description: '菜单按钮' });
  assert.equal(bad.status, 'ACTION_REQUIRED');
  assert.equal(bad.state_anchor.reason, 'notary-mismatch');
  assert.match(bad.state_anchor.notarization.ocr_label, /Subscribe Now/);
  assert.match(bad.next_step, /actually reads/i, '引导模型按屏幕实读重述');
  assert.match(bad.next_step, /RE-DESCRIBE/i);
  assert.equal(clicks, 0);
  assert.ok(
    journal.list(false).some(e => e.tool === 'GUARD_BLOCKED' && e.args?.reason === 'notary-mismatch'),
    'mismatch 拦截入链留痕',
  );

  // 相符：放行 + 锚点透明化 engaged
  notaryEvidence.readOcrLabel = async () => 'File';
  const ok = await runJson(tool, { x: 0.5, y: 0.5, target_description: 'File menu' });
  assert.equal(ok.status, 'SUCCESS');
  assert.equal(clicks, 1);
  assert.equal(ok.state_anchor.notarization.verdict, 'engaged');
  assert.equal(ok.state_anchor.notarization.ocr_label, 'File');
});

// ─── Ρ-3 诚实降级（零回归）───

test('Ρ-3: evidence 缺席 ⇒ 与旧版逐字段同判 + degraded 标志；总开关关 ⇒ 完全旧路径', () => {
  const legacy = (args: Record<string, any>) =>
    assertActionAllowed('click_mouse', args, { ...cfg, enableNotarizationLock: false });
  // 覆盖旧闸门的全部判决形态：危险无令牌 / 伪造令牌 / 第二通道危险 / 未描述 / 安全
  const cases: Array<Record<string, any>> = [
    { target_description: '发送按钮' },
    { target_description: '发送按钮', approval_token: 'APR-FAKE' },
    { target_description: 'btn', expected_text: '支付成功' },
    { x: 0.5, y: 0.5 },
    { target_description: '菜单按钮' },
  ];
  for (const args of cases) {
    const oldD = legacy(args);
    const absent = assertActionAllowed('click_mouse', args, cfg);                       // evidence 缺席
    const emptyObj = assertActionAllowed('click_mouse', args, cfg, {});                 // 空对象
    const nullChannels = assertActionAllowed('click_mouse', args, cfg, { ocrLabel: null, structuralName: null });
    for (const d of [absent, emptyObj, nullChannels]) {
      assert.equal(d.allowed, oldD.allowed, `同判 allowed（${JSON.stringify(args)}）`);
      assert.equal(d.reason, oldD.reason, '同判 reason');
      assert.equal(d.requiresApproval, oldD.requiresApproval, '同判 requiresApproval');
      assert.equal(d.dangerous, oldD.dangerous, '同判 dangerous');
      assert.equal(d.dangerSignalChannel, oldD.dangerSignalChannel, '同判归因通道');
      assert.equal(d.notarization, 'degraded', '诚实标注 degraded');
    }
  }
  // 键形锁定：degraded 路径只加 notarization 一个键（不夹带私货）
  assert.deepEqual(
    assertActionAllowed('click_mouse', { target_description: '菜单按钮' }, cfg),
    { allowed: true, requiresApproval: false, dangerous: false, notarization: 'degraded' },
  );

  // 总开关关 + 危险 OCR 证据在场 ⇒ 完全旧路径：OCR 不执法、notarization 键不入场
  const off = assertActionAllowed(
    'click_mouse', { target_description: 'press the button' },
    { ...cfg, enableNotarizationLock: false }, { ocrLabel: '删除', structuralName: 'Uninstall' },
  );
  assert.deepEqual(off, { allowed: true, requiresApproval: false, dangerous: false });
  assert.equal('notarization' in off, false, '完全旧路径：键不入场');

  // type_text 分支不受 evidence 影响（签名兼容扩展的另一侧）
  const typed = assertActionAllowed('type_text', { text: 'hello world' }, cfg, { ocrLabel: '删除' });
  assert.deepEqual(typed, { allowed: true, requiresApproval: false, dangerous: false });
});

test('Ρ-3b: click_mouse 工具面 —— 公证通道不可用 ⇒ 诚实 degraded（真取证面零调用降级）', async () => {
  // enableOcr=false 且探针关：OCR/白盒通道皆不可用 ⇒ 不采集（零物理/网络调用），
  // 走真 notaryEvidence（未注入假件）—— 降级路径本身确定性可复
  const tool = createClickMouseTool({ ...toolCfg, enableOcr: false });
  const out = await runJson(tool, { x: 0.5, y: 0.5, target_description: 'File menu' });
  assert.equal(out.status, 'SUCCESS', '取证缺席不阻塞正常点击');
  assert.equal(clicks, 1);
  assert.equal(out.state_anchor.notarization.verdict, 'degraded');
  assert.equal(out.state_anchor.notarization.note, 'notary-channels-unavailable');

  // 总开关关 ⇒ 锚点键不入场（完全旧路径）
  const offTool = createClickMouseTool({ ...toolCfg, enableOcr: false, enableNotarizationLock: false });
  const offOut = await runJson(offTool, { x: 0.5, y: 0.5, target_description: 'File menu' });
  assert.equal(offOut.status, 'SUCCESS');
  assert.equal(offOut.state_anchor.notarization, undefined, '总开关关：锚点不入场');
});

// ─── Ρ-4 白盒通道 ───

test('Ρ-4: structuralName 命中危险 ⇒ 拦（含混淆归一 + 多通道并置 + 归因优先级）', () => {
  // UIA 登记名自带危险语义：白盒通道单独拦
  const d = assertActionAllowed('click_mouse', { target_description: 'settings gear' }, cfg, { structuralName: 'Uninstall Program' });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'irreversible-action');
  assert.equal(d.dangerSignalChannel, 'structural_name');
  assert.equal(d.notarization, 'engaged');

  // 混淆归一：全角 ｕｎｉｎｓｔａｌｌ → uninstall
  const obf = assertActionAllowed('click_mouse', { target_description: 'settings' }, cfg, { structuralName: 'ｕｎｉｎｓｔａｌｌ' });
  assert.equal(obf.allowed, false, '白盒通道同律归一命中');

  // 三通道并置（自述双通道沉默 + OCR 见危险）：任一命中即拦，归因到命中通道
  const multi = assertActionAllowed(
    'click_mouse',
    { target_description: 'ok', expected_text: 'done' },
    cfg, { ocrLabel: '支付', structuralName: 'Btn' },
  );
  assert.equal(multi.allowed, false);
  assert.equal(multi.dangerSignalChannel, 'ocr_label');

  // 归因优先级：老通道在前（既有锚点归因零回归），公证通道殿后
  const prio = assertActionAllowed('click_mouse', { target_description: '发送' }, cfg, { structuralName: 'Delete All' });
  assert.equal(prio.dangerSignalChannel, 'target_description');
});

// ─── Ρ-5 click_element 收编入闸 ───

test('Ρ-5: click_element 不再绕闸 —— 元素名自述 + 落点 OCR 公证，物理派发计数执法', async () => {
  // 一次缓存的元素树承载全部场景（uiExtractor 1.5s 缓存窗口内 ID 稳定 ——
  // 取证场景全部毫秒级完成，无 TTL 漂移）
  setAccessibilityProvider(async () => ({
    children: [
      { role: 'button', name: 'OK', rect: { x: 100, y: 500, width: 100, height: 40 } },       // id 1
      { role: 'button', name: '删除全部', rect: { x: 400, y: 500, width: 100, height: 40 } }, // id 2
      { role: 'button', name: '保存设置', rect: { x: 700, y: 500, width: 100, height: 40 } }, // id 3
    ],
  }));
  notaryEvidence.readStructuralName = async () => null; // 白盒通道防御性静默（配置已关）
  const tool = createClickElementTool(toolCfg);

  // ① 注入锁持律在 click_element 执法：元素名无害（OK），落点屏读「删除」⇒ 拦
  notaryEvidence.readOcrLabel = async () => '删除';
  const blocked = await runJson(tool, { id: 1 });
  assert.equal(blocked.status, 'ACTION_REQUIRED');
  assert.equal(blocked.state_anchor.reason, 'irreversible-action');
  assert.equal(blocked.state_anchor.danger_signal, 'ocr_label');
  assert.equal(clicks, 0, '闸门被调用且执法：物理点击未派发');
  assert.ok(
    journal.list(false).some(e => e.tool === 'GUARD_BLOCKED' && e.args?.guard === 'notary-lock'),
    '拦截入链留痕',
  );

  // ② 描述与实读相符 ⇒ 放行（锚点透明化 engaged）
  notaryEvidence.readOcrLabel = async () => '保存设置';
  const ok = await runJson(tool, { id: 3 });
  assert.equal(ok.status, 'SUCCESS');
  assert.equal(clicks, 1);
  assert.equal(ok.state_anchor.notarization.verdict, 'engaged');
  assert.equal(ok.state_anchor.approval_gate, 'described');

  // ③ 握手执法：元素名（OK）与屏读（Subscribe Now）不符 ⇒ notary-mismatch
  notaryEvidence.readOcrLabel = async () => 'Subscribe Now';
  const mismatch = await runJson(tool, { id: 1 });
  assert.equal(mismatch.status, 'ACTION_REQUIRED');
  assert.equal(mismatch.state_anchor.reason, 'notary-mismatch');
  assert.match(mismatch.next_step, /actually reads/i, '引导按屏幕实读重定位');
  assert.equal(clicks, 1, '不派发');

  // ④ 模型自述通道独立执法（取证缺席也能拦）：元素名自带「删除」⇒ 需令牌
  notaryEvidence.readOcrLabel = async () => null;
  const selfDanger = await runJson(tool, { id: 2 });
  assert.equal(selfDanger.status, 'ACTION_REQUIRED');
  assert.equal(selfDanger.state_anchor.reason, 'irreversible-action');
  assert.equal(selfDanger.state_anchor.danger_signal, 'target_description');
  assert.equal(clicks, 1, '元素名危险同样不派发');

  // ⑤ 已授予令牌 + 描述与实读一致 ⇒ 放行（审批域闭环）
  armOob(); // W6R：授予须带外码
  const pa = approval.request('点击「删除全部」清空列表');
  grantOob(pa.token);
  notaryEvidence.readOcrLabel = async () => '删除全部';
  const approved = await runJson(tool, { id: 2, approval_token: pa.token });
  assert.equal(approved.status, 'SUCCESS');
  assert.equal(clicks, 2);
  assert.equal(approved.state_anchor.approval_gate, 'notarized-approved');
});
