// test/pan15-19.fixes.test.ts
// ΠΑΝ-15~19 修复潮执法册（重放/技能/截图/输入工具五项高危缺陷）：
//   ΠΑΝ-15 重放崩溃窗口封堵 —— 步循环取证抛错（D-5 后端崩溃/传输抖动）⇒
//          兜底 catch 先按 attemptFailed 结算在途预留（绝不悬账为永久
//          in-flight），再收敛为 PARTIAL_FAILURE 结构化回执（forensic-failure
//          第四路诚实归因），execution_log 不丢、运行层绝不抛。
//   ΠΑΝ-16 open_url 重放契约 —— 重放 = 安全重发（urlSense 同一条安检阶梯 +
//          system.openUrl）；安检拒绝 ⇒ SKIPPED（verified-absent）而非 failed；
//          run_skill 的 SKIPPED 与 failed 分账（不惩罚可靠度、锚点诚实标注）。
//   ΠΑΝ-17 模板指纹铸造 —— 模板首次全部步成功的执行把终帧 dHash 铸为
//          exitFingerprint（世界盖戳基准），打通 recordTemplateOutcome 成功
//          计数账本；后续执行走相似度验收（verified）。
//   ΠΑΝ-18 多屏坐标单位 —— toNorm 像素域直读（(px − origin) / monitorSize），
//          跨屏捕获元素框不再被静默过滤；NaN/非有限/负尺寸卫兵拒收。
//   ΠΑΝ-19 脱敏旁路封堵 —— typed_semantic.region_text_snippet 过与
//          typed_content 相同的脱敏器；脱敏器无法覆盖 ⇒ 截断 + 红action标注。
// 全离线确定性：假 system 键鼠/假 adapter（_setAdapterForTests）注入取证面，
// 零真网络、零真机、零真 D-5 spawn。
import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { journal } from '../src/journal.ts';
import { system } from '../src/system.ts';
import * as backend from '../src/physicalBackend.ts';
import { stopBackend } from '../src/physicalBackend.ts';
import { createReplayActionsTool, replayOneTraced, replayStepExecuted } from '../src/tools/replayActions.ts';
import { createRunSkillTool } from '../src/tools/skillTools.ts';
import { createTypeTextTool } from '../src/tools/typeText.ts';
import { createTakeScreenshotTool } from '../src/tools/takeScreenshot.ts';
import { skillLibrary, type SkillStep } from '../src/skillLibrary.ts';
import { uiMemory } from '../src/uiMemory.ts';
import { setAccessibilityProvider } from '../src/uiExtractor.ts';
import { resetMacroRehearsalGate } from '../src/sandbox/macroRehearsal.ts';
import { approval, resetApproval, setConfirmCodeChannel, type ConfirmCodeDelivery } from '../src/approval.ts';
import type { Config } from '../src/config.ts';

type Executable = { execute: (a: unknown, exec?: unknown) => Promise<string> };
async function runJson(tool: unknown, args: unknown): Promise<any> {
  const out = await (tool as Executable).execute(args);
  return JSON.parse(out);
}

// ─── 共用：system 键鼠 monkey-patch（w3wire/w4macro 注入风格） ───

function patchSystem(over: Record<string, unknown>): () => void {
  const saved: Record<string, unknown> = {};
  const host = system as unknown as Record<string, unknown>;
  for (const key of Object.keys(over)) {
    saved[key] = host[key];
    host[key] = over[key];
  }
  return () => {
    for (const key of Object.keys(over)) host[key] = saved[key];
  };
}

/** 假 adapter 工坊：takeScreenshot 按调用序脚本化（ok 值 / 抛错等效的 Result 失败） */
function installFakeAdapter(script: Array<{ ok: true; value: Record<string, unknown> } | { ok: false }>): { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const adapter = {
    takeScreenshot: async (req: Record<string, unknown>) => {
      calls.push(`takeScreenshot#${i}`);
      const step = script[Math.min(i, script.length - 1)];
      i++;
      if (step.ok) return { ok: true, value: step.value };
      return { ok: false, error: { kind: 'transport-crash', detail: 'injected forensic crash (ΠΑΝ-15)' } };
    },
    getUiTree: async () => ({ ok: true, value: { funnel_depth: 'L2', elements: [] } }),
  };
  backend._setAdapterForTests(adapter as never);
  return { calls };
}

const DHASH_A = 'a'.repeat(16);
const DHASH_E = 'e'.repeat(16);
const META_OK = (dhash: string) => ({
  dhash, width: 1920, height: 1080, unchanged: false,
  frame_id: null, transport: 'base64' as const,
});

beforeEach(() => {
  journal.reset();
  resetApproval();
  skillLibrary.configure(true, '', 50);
  skillLibrary.reset();
  resetMacroRehearsalGate();
  uiMemory.reset();
});

afterEach(() => {
  backend._setAdapterForTests(null);
  setConfirmCodeChannel(null);
});

after(async () => {
  await stopBackend();
});

// ═══ ΠΑΝ-15：重放崩溃窗口封堵（结算恒可达） ═══

const crashCfg = {
  enableApprovalGate: true, dangerPatterns: 'send,发送', enableRiskGate: false, riskPatterns: '',
  maxTextLength: 1000, focusMaxAgeMs: 60_000,
  verifyActions: true, dryRun: false, // 死步取证链在场 ⇒ 崩溃窗口敞开的前提
  replayMaxSteps: 100, enableJournal: true,
} as unknown as Config;

/** 授予一枚带外码的新令牌（W6R fail-closed 同律） */
function grantFreshToken(desc: string): string {
  const sink: ConfirmCodeDelivery[] = [];
  setConfirmCodeChannel(d => { sink.push({ ...d }); });
  const pa = approval.request(desc);
  assert.equal(approval.grantDetailed(pa.token, true, { confirmCode: sink[0]?.confirmCode }).ok, true, '令牌授予');
  return pa.token;
}

test('ΠΑΝ-15a: 死步取证抛错落在预留与结算之间 ⇒ 兜底结算（attemptFailed）+ 结构化失败回执，令牌不悬账', async () => {
  let clicks = 0;
  const restore = patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async () => { clicks++; },
  });
  // 取证脚本：前帧 ok、后帧注入传输崩溃（unwrapK ⇒ PhysicalBackendError）
  const { calls } = installFakeAdapter([
    { ok: true, value: META_OK(DHASH_A) },
    { ok: false },
  ]);
  try {
    const token = grantFreshToken('重放「发送订单」危险步');
    await journal.append({
      ts: 1, tool: 'click_mouse',
      args: { x: 0.5, y: 0.5, target_description: '发送订单', approval_token: token },
      status: 'SUCCESS', effect_detected: true,
    });
    const out = await runJson(createReplayActionsTool(crashCfg), { confirm: true });
    // 结算恒可达的第一执法：回执是结构化失败（不是裸异常炸穿 execute）
    assert.equal(out.status, 'PARTIAL_FAILURE', '崩溃收敛为结构化失败回执');
    assert.match(String(out.state_anchor.gate), /forensic/, '第四路诚实归因：取证链断裂');
    assert.ok(typeof out.execution_log === 'string' && out.execution_log.length > 0, 'execution_log 不丢');
    assert.match(out.execution_log, /forensic failure/);
    assert.equal(clicks, 1, '步已派发（崩溃在派发后的取证面）');
    assert.equal(calls.length, 2, '前帧 ok + 后帧崩（取证序完整）');
    // 结算恒可达的第二执法：预留已按 attemptFailed 释放 —— 同令牌可再次预留
    //（旧缺陷：inFlight 永久 = 1 ⇒ beginAttempt 恒 false，同令牌重放结构性死锁）
    assert.equal(approval.beginAttempt(token), true, '在途预留已释放（不悬账为永久 in-flight）');
    assert.equal(approval.validate(token), true, 'attemptFailed 续期语义：令牌保留可重试（未被误 consume）');
    // 收尾：把测试自铸的第二次预留释放干净
    approval.attemptFailed(token, 'test-cleanup');
  } finally {
    restore();
  }
});

test('ΠΑΝ-15b: 前帧取证抛错（派发前）⇒ 同样收敛为结构化回执、零派发、绝不裸抛', async () => {
  let clicks = 0;
  const restore = patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async () => { clicks++; },
  });
  installFakeAdapter([{ ok: false }]); // 首帧即崩
  try {
    await journal.append({
      ts: 1, tool: 'click_mouse',
      args: { x: 0.25, y: 0.25, target_description: '菜单按钮' }, status: 'SUCCESS',
    });
    const out = await runJson(createReplayActionsTool(crashCfg), { confirm: true });
    assert.equal(out.status, 'PARTIAL_FAILURE');
    assert.match(String(out.state_anchor.gate), /forensic/);
    assert.equal(clicks, 0, '前帧取证先于派发 ⇒ 零物理派发');
  } finally {
    restore();
  }
});

test('ΠΑΝ-15c: 取证健康时崩溃兜底零扰动 —— 正常两步回放 SUCCESS（回归）', async () => {
  let clicks = 0;
  const restore = patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async () => { clicks++; },
  });
  // 前后帧 dhash 不同 ⇒ 非死步 ⇒ 照常走完
  installFakeAdapter([
    { ok: true, value: META_OK(DHASH_A) }, { ok: true, value: META_OK(DHASH_E) },
    { ok: true, value: META_OK(DHASH_A) }, { ok: true, value: META_OK(DHASH_E) },
  ]);
  try {
    await journal.append({
      ts: 1, tool: 'click_mouse',
      args: { x: 0.25, y: 0.25, target_description: '菜单按钮' }, status: 'SUCCESS',
    });
    await journal.append({
      ts: 2, tool: 'click_mouse',
      args: { x: 0.3, y: 0.3, target_description: '确认按钮' }, status: 'SUCCESS',
    });
    const out = await runJson(createReplayActionsTool(crashCfg), { confirm: true });
    assert.equal(out.status, 'SUCCESS', '健康取证路径零回归');
    assert.equal(out.state_anchor.replayed_steps, 2);
    assert.equal(clicks, 2);
  } finally {
    restore();
  }
});

// ═══ ΠΑΝ-16：open_url 重放契约（安全重发 + SKIPPED/failed 分账） ═══

test('ΠΑΝ-16a: replayOneTraced 的 open_url 分支 —— 合法 URL 安全重发；安检拒绝 ⇒ SKIPPED 而非 FAILED', async () => {
  const opened: string[] = [];
  const restore = patchSystem({
    openUrl: async (url: string) => { opened.push(url); return { method: 'fake-shell' }; },
  });
  try {
    // ① 合法 https URL：重放 = 安全重发（system.openUrl 派发）
    const ok = await replayOneTraced({ tool: 'open_url', args: { url: 'https://example.com/docs?q=1' } });
    assert.equal(ok.line, 'reopened https://example.com/docs?q=1', '重放回执 = 重发事实');
    assert.deepEqual(opened, ['https://example.com/docs?q=1'], '经 system.openUrl 派发（与 live 工具同门面）');
    assert.equal(replayStepExecuted(ok.line), true, '已执行（见证三态 = true）');

    // ② 自由文本含单一 URL：无损提取后重发（open_url 工具同一条安检阶梯）
    const free = await replayOneTraced({ tool: 'open_url', args: { url: '详见 https://example.com/a?x=1 即可' } });
    assert.equal(free.line, 'reopened https://example.com/a?x=1');
    assert.equal(opened.length, 2);

    // ③ scheme 白名单拒绝：file:// ⇒ verified-absent（SKIPPED 方言），零派发
    const refused = await replayOneTraced({ tool: 'open_url', args: { url: 'file:///C:/win.ini' } });
    assert.match(refused.line, /^SKIPPED \(open_url replay refused:/, '安检拒绝 ⇒ SKIPPED（非 FAILED）');
    assert.match(refused.line, /scheme/, '拒因申报（scheme 白名单）');
    assert.equal(replayStepExecuted(refused.line), null, '跳过三态 = null（未执行且非失败）');
    assert.equal(opened.length, 2, '拒绝 ⇒ 零派发');

    // ④ 多候选歧义：绝不掷硬币
    const amb = await replayOneTraced({ tool: 'open_url', args: { url: '看 https://a.com/x 与 https://b.com/y' } });
    assert.match(amb.line, /^SKIPPED .*candidates/, '歧义 ⇒ SKIPPED + 拒因');
    assert.equal(opened.length, 2);

    // ⑤ URL 缺席/空：诚实跳过
    const empty = await replayOneTraced({ tool: 'open_url', args: {} });
    assert.match(empty.line, /^SKIPPED/);
    assert.equal(opened.length, 2);
  } finally {
    restore();
  }
});

test('ΠΑΝ-16b: replay_actions 重放 open_url 日志步 —— 照常执行不中止（journal 立法兑现）', async () => {
  const opened: string[] = [];
  const restore = patchSystem({
    openUrl: async (url: string) => { opened.push(url); return { method: 'fake-shell' }; },
  });
  const cfg = { enableApprovalGate: false, verifyActions: false, replayMaxSteps: 100, enableJournal: true } as unknown as Config;
  try {
    await journal.append({ ts: 1, tool: 'open_url', args: { url: 'https://example.com/start' }, status: 'SUCCESS' });
    await journal.append({
      ts: 2, tool: 'click_mouse', args: { x: 0.4, y: 0.4, target_description: '页面按钮' }, status: 'SUCCESS',
    });
    const out = await runJson(createReplayActionsTool(cfg), { confirm: true });
    assert.equal(out.status, 'SUCCESS', 'open_url 步不再结构性 SKIPPED —— 重放走完');
    assert.deepEqual(opened, ['https://example.com/start'], 'URL 安全重发恰一次');
    assert.match(out.state_anchor.detail.join('\n'), /reopened https:\/\/example\.com\/start/);
  } finally {
    restore();
  }
});

test('ΠΑΝ-16c: run_skill 含 open_url 步 —— 拒绝时 SKIPPED 分账（steps_failed=0），成功时照常执行', async () => {
  const opened: string[] = [];
  const restore = patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async () => { /* noop */ },
    openUrl: async (url: string) => { opened.push(url); return { method: 'fake-shell' }; },
  });
  installFakeAdapter([{ ok: true, value: META_OK(DHASH_E) }]); // Y-7 终态指纹取证面（防真 spawn）
  const cfg = {
    enableApprovalGate: false, dangerPatterns: '', enableRiskGate: false, riskPatterns: '',
    maxTextLength: 1000, focusMaxAgeMs: 60_000, verifyActions: false, dryRun: false,
    replayMaxSteps: 100, enableJournal: true, enableSkillLibrary: true,
  } as unknown as Config;
  try {
    // ① 拒绝形态：file:// 步 SKIPPED ⇒ failed=0 / skipped=1（旧实现 failed=1 ⇒
    //    可靠度单调衰减 ⇒ 排练门禁永久封死 —— 结构性失败根除）
    const s1 = skillLibrary.induce('打开机密文档', [
      { tool: 'open_url', args: { url: 'file:///C:/secret.txt' } },
      { tool: 'click_mouse', args: { x: 0.3, y: 0.3, target_description: '按钮' } },
    ])!;
    const out1 = await runJson(createRunSkillTool(cfg), { id: s1.id, confirm: true });
    assert.equal(out1.state_anchor.steps_failed, 0, 'SKIPPED 不计失败（可靠度不受罚）');
    assert.equal(out1.state_anchor.steps_skipped, 1, '跳过步单独申报（诚实标注）');
    assert.ok(!['PARTIAL_FAILURE'].includes(out1.status), '整体不因跳过步判失败');
    assert.match(out1.execution_log, /SKIPPED \(open_url replay refused:/);
    assert.match(out1.next_step, /1 step\(s\) were SKIPPED/, 'next_step 诚实提示未执行步');

    // ② 成功形态：https 步重发
    const s2 = skillLibrary.induce('打开官网文档', [
      { tool: 'open_url', args: { url: 'https://example.com/docs' } },
    ])!;
    const out2 = await runJson(createRunSkillTool(cfg), { id: s2.id, confirm: true });
    assert.equal(out2.state_anchor.steps_failed, 0);
    assert.ok(!('steps_skipped' in out2.state_anchor), '零跳过 ⇒ 不添键（锚点字节形状零回归）');
    assert.match(out2.execution_log, /reopened https:\/\/example\.com\/docs/);
    assert.deepEqual(opened, ['https://example.com/docs']);
  } finally {
    restore();
  }
});

// ═══ ΠΑΝ-17：模板指纹铸造（打通模板成功计数账本） ═══

test('ΠΑΝ-17: 模板首次成功执行铸造 exitFingerprint（baseline-minted）⇒ 成功入账；二次执行走相似度验收（verified）', async () => {
  let clicks = 0;
  const restore = patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    clickMouse: async () => { clicks++; },
  });
  installFakeAdapter([{ ok: true, value: META_OK(DHASH_E) }]); // 终帧恒定 dHash（世界盖戳面）
  const cfg = {
    enableApprovalGate: false, dangerPatterns: '', enableRiskGate: false, riskPatterns: '',
    maxTextLength: 1000, focusMaxAgeMs: 60_000, verifyActions: false, dryRun: false,
    replayMaxSteps: 100, enableJournal: true, enableSkillLibrary: true,
  } as unknown as Config;
  try {
    // 铸模板：同骨架两母体、唯 target_description 弈异 ⇒ string 洞（run_skill 的
    // text 参数可绑 —— 模板路径可达；坐标全常量 ⇒ 排练场景可命中）
    const stepA = (desc: string): SkillStep[] => [
      { tool: 'click_mouse', args: { x: 0.25, y: 0.25, target_description: desc } },
      { tool: 'click_mouse', args: { x: 0.5, y: 0.5, target_description: '确认按钮' } },
    ];
    skillLibrary.induce('登录门户甲', stepA('用户名框'));
    skillLibrary.induce('登录门户乙', stepA('账号框'));
    const { created } = skillLibrary.distillTemplates();
    assert.ok(created.length >= 1, '蒸馏产模板');
    const tplId = created[0].id;

    // 排练场景源：uiMemory 地标铸控件窗（rehearsalSceneFromMemory 的世界证据面）
    uiMemory.remember('用户名框', 0.25, 0.25);
    uiMemory.remember('确认按钮', 0.5, 0.5);

    // ① 首次执行：全部步成功 + 无离场基准 ⇒ 终帧铸造 exitFingerprint
    const clicksBefore = clicks;
    const r1 = await runJson(createRunSkillTool(cfg), { template_id: tplId, confirm: true, text: 'carol' });
    assert.equal(r1.macro_trace.source.kind, 'template', '宏解析经模板路径');
    assert.equal(clicks - clicksBefore, 2, '两步真实派发（排练门放行）');
    assert.equal(r1.status, 'SUCCESS', '基准铸造 ⇒ 完全成功形态（不再是恒 SUCCESS_UNVERIFIED）');
    assert.equal(r1.state_anchor.postcondition.reason, 'baseline-minted', '诚实归因：本帧即基准（非相似度对照）');
    assert.equal(r1.state_anchor.postcondition.verified, true);
    const tpl1 = skillLibrary.getTemplate(tplId)!;
    assert.equal(tpl1.successCount, 1, '模板成功计数入账（旧实现恒 0 —— 账本死胡同打通）');
    assert.equal(tpl1.attemptCount, 1);
    assert.equal((tpl1 as unknown as { exitFingerprint?: string }).exitFingerprint, DHASH_E,
      '离场指纹随模板对象在册');

    // ② 二次执行：基准在册 ⇒ 走 judgePostcondition 相似度验收（同帧 ⇒ sim=1）
    const r2 = await runJson(createRunSkillTool(cfg), { template_id: tplId, confirm: true, text: 'dave' });
    assert.equal(r2.status, 'SUCCESS');
    assert.equal(r2.state_anchor.postcondition.reason, 'verified', '后续执行 = 世界盖戳的相似度验收');
    assert.ok((r2.state_anchor.postcondition.final_scene_similarity ?? 0) >= 0.75);
    const tpl2 = skillLibrary.getTemplate(tplId)!;
    assert.equal(tpl2.successCount, 2, '可靠度可持续积累（越用越准的闭环兑现）');
    assert.equal(tpl2.attemptCount, 2);
  } finally {
    restore();
  }
});

// ═══ ΠΑΝ-18：多屏坐标单位（toNorm 像素域 + NaN 卫兵） ═══

test('ΠΑΝ-18: display 模式元素框像素域归一化 —— 跨屏框在图、主屏框诚实出局；非有限坐标卫兵拒收', async () => {
  const FAKE_DISPLAYS = [
    { name: 'Primary', x: 0, y: 0, width: 1920, height: 1080 },
    { name: 'Monitor@1920,0', x: 1920, y: 0, width: 2560, height: 1440 },
  ];
  const { default: sharp } = await import('sharp');
  const tinyJpeg = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 128, g: 128, b: 128 } },
  }).jpeg().toBuffer();

  const capCalls: Array<{ boxes?: Array<{ x: number; y: number; width: number; height: number }>; [k: string]: unknown }> = [];
  const restore = patchSystem({
    getActiveDisplay: async () => FAKE_DISPLAYS[0],
    getMousePosition: async () => ({ x: 960, y: 540 }),
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    getAllDisplays: async () => FAKE_DISPLAYS,
    captureScreenWithOverlay: async (opts: any) => {
      capCalls.push(opts);
      const w = opts.display === 1 ? 2560 : 1920;
      const h = opts.display === 1 ? 1440 : 1080;
      return {
        buffer: tinyJpeg, width: w, height: h,
        dhash: `00${capCalls.length}112233445566`, phash: null, regionDhash: null,
        unchanged: false, frameId: null, transport: 'base64', salience: null,
        display: typeof opts.display === 'number' ? opts.display : null,
      };
    },
  });
  // 像素域元素（uiExtractor 契约：原始像素边界框 —— 虚拟坐标空间）：
  //   A = 副屏左上角；B = 主屏中部；C = y=Infinity（过 extractor 的 width>0 闸，
  //   必须由 toNorm 的非有限卫兵拒收）
  setAccessibilityProvider(async () => ({
    children: [
      { role: 'button', name: 'Mon2 Btn', rect: { x: 1920, y: 0, width: 520, height: 400 } },
      { role: 'button', name: 'Pri Btn', rect: { x: 100, y: 100, width: 200, height: 100 } },
      { role: 'button', name: 'InfY Btn', rect: { x: 100, y: Infinity, width: 200, height: 100 } },
    ],
  }));
  const cfg = {
    compressWidth: 1440, jpegQuality: 75, gridDivisions: 10,
    maxImageCount: 9, maxContextImageKb: 4096,
    enableElementIdMode: true, enableQuantumSense: false,
    enableOcr: false, popupKeywords: '', ocrLang: 'eng', stableScreenDistance: 3,
  } as unknown as Config;
  const tool = createTakeScreenshotTool(cfg);
  try {
    // ① 跨屏捕获（display=1）：A 框换算到副屏域 (1920−1920)/2560=0 起 —— 旧实现
    //    x=(1920*1920−1920)/2560≈1436 ⇒ onTarget 全滤 ⇒ 元素框无声消失
    const v1 = await runJson(tool, { display: 1 });
    assert.equal(v1.status, 'SUCCESS');
    const boxes1 = capCalls[capCalls.length - 1].boxes ?? [];
    assert.equal(boxes1.length, 1, '副屏元素框在图（主屏框诚实出局、脏坐标框拒收）');
    const b = boxes1[0];
    assert.ok(Math.abs(b.x - 0) < 1e-9 && Math.abs(b.y - 0) < 1e-9, `副屏局部原点（实际 ${JSON.stringify(b)}）`);
    assert.ok(Math.abs(b.width - 520 / 2560) < 1e-9 && Math.abs(b.height - 400 / 1440) < 1e-9, '宽高同域缩放');
    assert.ok([b.x, b.y, b.width, b.height].every(v => Number.isFinite(v) && v >= 0 && v <= 1),
      '归一化值域合法（旧实现 >1 全滤的根因消除）');
    assert.equal(v1.interactive_elements.length, 3, '锚点元素清单不受 toNorm 影响（含坐标卫兵对象）');

    // ② 无 display（主屏现状）：B 框按主屏域归一化（100/1920 等）。注：无
    //    target 时 onTarget 恒真（旧语义：不做跨屏过滤）⇒ 副屏框 A 也随行
    //    （x=1.0 起的越界归一化 —— 服务端裁剪域自律）；脏框 C 仍被卫兵拒收。
    const v0 = await runJson(tool, { force: true });
    assert.equal(v0.status, 'SUCCESS');
    const boxes0 = capCalls[capCalls.length - 1].boxes ?? [];
    assert.equal(boxes0.length, 2, '主屏模式：A+B 在图（无 target 不做跨屏过滤）、脏框出局');
    assert.ok(Math.abs(boxes0[0].x - 1920 / 1920) < 1e-9, 'A 框像素域直除（旧实现 1920*1920/1920 的单位错误根除）');
    const b0 = boxes0[1];
    assert.ok(Math.abs(b0.x - 100 / 1920) < 1e-9 && Math.abs(b0.y - 100 / 1080) < 1e-9, '像素域直除（无 target 平移）');
    assert.ok(Math.abs(b0.width - 200 / 1920) < 1e-9 && Math.abs(b0.height - 100 / 1080) < 1e-9);
  } finally {
    restore();
    setAccessibilityProvider(async () => ({ children: [] })); // 复位为空树（签名不收 null）
  }
});

// ═══ ΠΑΝ-19：type_text 语义自证 snippet 的脱敏旁路封堵 ═══

test('ΠΑΝ-19: region_text_snippet 过同一脱敏器 —— 敏感回声 [REDACTED]；脱敏器覆盖外 ⇒ 截断 + 红action标注', async () => {
  const { default: sharp } = await import('sharp');
  // settleAndVerify 的终帧取证非 metaOnly（读图路径）⇒ 假 adapter 需带 base64 图
  const tinyJpeg = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 90, g: 90, b: 90 } },
  }).jpeg().toBuffer();
  const restore = patchSystem({
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    getMousePosition: async () => ({ x: 100, y: 100 }), // 焦点兜底：最近交互先验
    typeText: async () => { /* noop */ },
  });
  // 假 adapter 双面：takeScreenshot（前后帧取证）+ getUiTree（焦点邻域 OCR ——
  // 回读的正是刚输入的敏感文本，即被堵的泄漏向量）
  const ocrEcho = { text: '密码 hunter2 已输入' };
  const adapter = {
    takeScreenshot: async () => ({
      ok: true,
      value: {
        dhash: DHASH_A, width: 1920, height: 1080, unchanged: false,
        frame_id: null, transport: 'base64', image_base64: tinyJpeg.toString('base64'),
      },
    }),
    getUiTree: async () => ({
      ok: true,
      value: {
        funnel_depth: 'L2',
        elements: [{
          name: ocrEcho.text, source: 'L2-ocr',
          rect: { x: 0.04, y: 0.08, width: 0.12, height: 0.03 },
        }],
      },
    }),
  };
  backend._setAdapterForTests(adapter as never);
  // 攻击面组合：闸门关闭（enableRiskGate=false —— 模型可配置面）+ 敏感文本
  const cfg = {
    maxTextLength: 1000, focusMaxAgeMs: 60_000,
    enableRiskGate: false, riskPatterns: '密码,password',
    enableApprovalGate: false, dangerPatterns: '',
    verifyActions: true, dryRun: false, adaptiveSettle: false, actionSettleMs: 1,
    noopSimilarityThreshold: 0.97, regionVerifyRadius: 0.15,
    enableOcr: true, ocrLang: 'eng',
  } as unknown as Config;
  try {
    const raw = await (createTypeTextTool(cfg) as Executable).execute({ text: '密码 hunter2' });
    const out = JSON.parse(raw);
    assert.equal(out.status, 'SUCCESS');
    // 既有防线（回归锚）：typed_content 脱敏
    assert.equal(out.state_anchor.typed_content, '[REDACTED — sensitive content]');
    // 新执法：snippet（OCR 回读 = 敏感明文的第二条回显路径）同过脱敏器
    const sem = out.state_anchor.typed_semantic;
    assert.equal(sem.confirmed, true, '语义自证照常工作（脱敏不破坏对账判决）');
    assert.equal(sem.region_text_snippet, '[REDACTED — sensitive content]', 'snippet 与 typed_content 同一脱敏器');
    assert.equal(sem.snippet_redacted, true, '脱敏发生如实申报');
    assert.ok(!raw.includes('hunter2'), '全回执零敏感明文（锚点/日志/遥测面封死）');

    // 脱敏器无法覆盖（双侧不命中风险词）⇒ 截断 + 红action标注
    ocrEcho.text = `${'x'.repeat(80)}benign-echo`;
    const raw2 = await (createTypeTextTool(cfg) as Executable).execute({ text: 'search query words' });
    const out2 = JSON.parse(raw2);
    const sem2 = out2.state_anchor.typed_semantic;
    assert.ok(!('snippet_redacted' in sem2), '良性回声不误标脱敏');
    assert.ok(sem2.region_text_snippet.length <= 50 + 60, '超长回声截断');
    assert.match(sem2.region_text_snippet, /truncated — unredacted OCR echo/, '覆盖缺口以红action标注申报');
  } finally {
    restore();
  }
});
