// test/autonomy.closedloop.bench.ts
// 纪元 Φ 闭环基准：确定性离线虚拟世界上的「自主识别→自主判断→自主执行→验证→进化」全链打点。
//
// 世界观：本文件自建小型确定性场景状态机 VirtualWorld（800×600，sharp 渲染「对角升坡底 +
// 控件降序渐变色块」合成 PNG —— 不画字，文字走假 readWords/groundVlm 与状态机挂钩）。
// 注入缝：RuntimeDeps（capture/readWords/groundVlm/now/sleep）+ system 键鼠 monkey-patch
// （屏幕尺寸=世界尺寸 800×600 ⇒ 点击像素与世界像素一比一，命中判定零换算误差）。
// OCR 与 VLM 双源同报一套控件 ⇒ composeSnapshot 走真实双源仲裁融合（IoU=1 恒融合）。
//
// 用例（B1/B2/B4/B5 走 autonomous_run 工具全链；B3/B6 走器官级 runAutonomousLoop 直驱）：
//   B1 三页向导单击达成：点击「下一步」×2 → 完成横幅出现 → declare 判据命中 ⇒ achieved 3 步
//   B2 弹窗改道：进入第 2 页即弹升级弹窗（遮住「下一步」）⇒ 弹窗后第一个动作必是点「确认」⇒ 步数 = B1+1
//   B3 策略切换：死链点两连无效后从感知面消失 ⇒ 僵局探测触发 scroll ⇒ 深页判据在第 2 屏命中
//   B4 安全升级：目标含「支付」⇒ 宪法文本扫描判 destructive ⇒ ACTION_REQUIRED 且零键鼠零世界变化
//   B5 进化生效：同一向导连跑两次 ⇒ 蒸馏技能可靠度 0.5→0.6 + recall_skill 建议（另附引擎级两轮口径）
//   B6 自审执法：同点连击的死亡世界（点击永不翻页）⇒ 步保险丝熔断 + auditTrajectory 以签名重复判震荡
//   W0 预检：关键前后帧 dhash 汉明距离 > 容差 3 + 同态渲染字节恒等（世界确定性根基）
//
// 基准发现（如实记录，两条结构性事实决定了 B3/B6 的执法位置）：
//   ① runtime.createExecute.verifyAfter 的后帧快照不含元素（composeSnapshot 只喂 dhash/OCR）⇒
//     同屏点击经 snapshotChanged 的「元素数突变 >30%」律恒判 progress —— 工具路径上 no_effect
//     不可达，策略引擎僵局切换（scroll）与宪法卡死律（consecutiveNoEffect≥3）随之不可触发。
//     故 B3 的执行器按题面许可「直接驱动状态机+渲染新屏」（结局按世界真相判 progress/no_effect）；
//     B6 用真实 createExecute 证实该口径（六次死点击全记 progress、宪法零否决、步保险丝收场），
//     审计官仍以 OSC-1 动作签名重复执法 —— 自审是最后一道独立的网。
//   ② 工具 FAILED 路径只回 { error }（toolErr 不带审计锚点）⇒ B6 的 verdict 断言直接对轨迹做
//     （auditTrajectory(result.trajectory)，题面明示许可的口径）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from '../src/config.ts';
import { resetGlmClient } from '../src/vlm/index.ts';
import { system } from '../src/system.ts';
import { createAutonomousRunTool } from '../src/tools/autonomousRun.ts';
import {
  buildAutonomyStack, createExecute, runAutonomousLoop, auditTrajectory,
  GoalStateMachine, EvolutionEngine,
  type RuntimeDeps, type GoalSpec, type PolicyAction, type StepOutcome, type RunRecord,
} from '../src/autonomy/index.ts';
import { dhash, hammingDistance } from '../src/perceptualHash.ts';
import { default as sharp } from 'sharp';

// ─── 环境卫兵：GLM 全键清空 + 单例重置（策略咨询臂与 grounding 哨兵零网络） ───

const ENV_KEYS = ['GLM_API_KEY', 'ZHIPUAI_API_KEY', 'ZAI_API_KEY', 'GLM_BASE_URL', 'GLM_VLM_MODEL'] as const;
type EnvSnapshot = Array<readonly [string, string | undefined]>;
function snapshotEnv(): EnvSnapshot {
  return ENV_KEYS.map(k => [k, process.env[k]] as const);
}
function clearEnvKeys(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}
function restoreEnv(snap: EnvSnapshot): void {
  for (const [k, v] of snap) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}
/** 零网络沙箱内执行 fn（进入清键重置、退出还原再重置 —— 与 integration 测试同律） */
async function withCleanGlmEnv<T>(fn: () => Promise<T>): Promise<T> {
  const snap = snapshotEnv();
  clearEnvKeys();
  resetGlmClient();
  try {
    return await fn();
  } finally {
    restoreEnv(snap);
    resetGlmClient();
  }
}

// ─── 配置与 system 键鼠补丁（五点补丁 + 恢复器） ───

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    autonomyEnabled: true,
    autonomyMaxSteps: 24,
    autonomyTimeBudgetSec: 300,
    autonomyAllowTiers: 'benign',
    autonomyVlmWhenUncertain: true,
    autonomyForbiddenKeywords: '',
    ...over,
  } as Config;
}

type SystemPatch = Partial<Record<'clickMouse' | 'typeText' | 'scroll' | 'pressHotkey' | 'getScreenSize', unknown>>;
function patchSystem(over: SystemPatch): () => void {
  const saved: Record<string, unknown> = {};
  const host = system as unknown as Record<string, unknown>;
  for (const key of Object.keys(over)) {
    saved[key] = host[key];
    host[key] = (over as Record<string, unknown>)[key];
  }
  return () => { for (const key of Object.keys(over)) host[key] = saved[key]; };
}

// ─── 虚拟世界：确定性场景状态机 + sharp 合成屏 ───

const VW = 800;
const VH = 600;

type WMode = 'wizard' | 'wizardPopup' | 'longPage' | 'payGate' | 'deadClick';
type CtrlRole = 'button' | 'text';
interface Ctrl { label: string; role: CtrlRole; x0: number; y0: number; x1: number; y1: number }

/** 控件色块基调：button 高对比降序渐变 / text 低对比降序渐变（在升坡底上刻出可分指纹） */
const BLOCK_TONE: Record<CtrlRole, { hi: number; lo: number }> = {
  button: { hi: 235, lo: 45 },
  text: { hi: 165, lo: 95 },
};

/** 合成一帧：对角升坡底（dhash 全 1 底噪）+ 控件降序渐变色块（刻 0 图样）—— 同态恒同字节 */
async function renderFrame(ctrls: Ctrl[]): Promise<Buffer> {
  const data = Buffer.alloc(VW * VH * 3);
  for (let y = 0; y < VH; y++) {
    for (let x = 0; x < VW; x++) {
      const v = Math.round((255 * (x + y)) / (VW + VH - 2));
      const i = (y * VW + x) * 3;
      data[i] = v; data[i + 1] = v; data[i + 2] = v;
    }
  }
  for (const c of ctrls) {
    const tone = BLOCK_TONE[c.role];
    const span = Math.max(1, c.x1 - c.x0 - 1);
    for (let y = c.y0; y < c.y1; y++) {
      for (let x = c.x0; x < c.x1; x++) {
        const v = Math.round(tone.hi - ((tone.hi - tone.lo) * (x - c.x0)) / span);
        const i = (y * VW + x) * 3;
        data[i] = v; data[i + 1] = v; data[i + 2] = v;
      }
    }
  }
  return sharp(data, { raw: { width: VW, height: VH, channels: 3 } }).png().toBuffer();
}

/**
 * 虚拟世界状态机：屏幕 = 若干控件（label/role/bbox/可见性），动作改变状态。
 * 传感器（readWords/groundVlm）按「当前帧捕获时刻的控件表」上报 —— 帧缓存按 buffer 身份
 * 反查（wizardPopup 的加载帧与落定帧像素不同、传感器口径随帧走；longPage 的死链按钮
 * 像素残留但感知不再上报）。mututions=0 的世界 = 死亡世界（点击永不翻页）。
 */
class VirtualWorld {
  readonly W = VW;
  readonly H = VH;
  page = 0;
  popup = false;        // wizardPopup：升级弹窗开（遮住页内「下一步」）
  settling = false;     // wizardPopup：终页首拍「正在生成结果」（banner 未上屏，只服务一拍）
  viewport: 'top' | 'bottom' = 'top'; // longPage：视口
  deadHits = 0;         // longPage：死链被点次数（≥2 后从感知面消失）
  hidden = false;
  hitLog: Array<{ label: string | null; x: number; y: number }> = [];
  scrollLog: Array<{ dir: string; amount: number }> = [];
  mutations = 0;        // 世界真相变化计数（对照 runtime 判决的自变量）
  captures = 0;
  private readonly mode: WMode;
  private readonly frameCache = new Map<string, { buf: Buffer; ctrls: Ctrl[] }>();
  private readonly bufIndex = new Map<Buffer, Ctrl[]>();

  constructor(mode: WMode) { this.mode = mode; }

  /** 当前状态的物理控件表（渲染与命中判定的真相；感知另有隐藏滤网） */
  controls(): Ctrl[] {
    const t = (label: string, x0: number, y0: number, x1: number, y1: number): Ctrl =>
      ({ label, role: 'text', x0, y0, x1, y1 });
    const b = (label: string, x0: number, y0: number, x1: number, y1: number): Ctrl =>
      ({ label, role: 'button', x0, y0, x1, y1 });
    switch (this.mode) {
      case 'wizard':
        if (this.page === 0) return [t('第一步 欢迎使用', 60, 60, 300, 120), b('下一步', 80, 420, 400, 510)];
        if (this.page === 1) return [t('第二步 网络配置', 500, 60, 740, 120), b('下一步', 400, 420, 720, 510)];
        return [t('第三步 完成', 60, 60, 300, 120), t('下一步安装完成', 220, 230, 580, 340)];
      case 'wizardPopup':
        if (this.page === 0) return [t('第一步 欢迎使用', 60, 60, 300, 120), b('下一步', 80, 420, 400, 510)];
        if (this.page === 1) {
          return this.popup
            ? [t('第二步 网络配置', 500, 60, 740, 120), t('升级提示', 260, 200, 540, 250), b('确认', 340, 360, 470, 450)]
            : [t('第二步 网络配置', 500, 60, 740, 120), b('下一步', 400, 420, 720, 510)];
        }
        return this.settling
          ? [t('第三步 完成', 60, 60, 300, 120), t('正在生成结果', 200, 250, 600, 300)]
          : [t('第三步 完成', 60, 60, 300, 120), t('下一步确认安装完成', 220, 230, 580, 340)];
      case 'longPage':
        return this.viewport === 'top'
          ? [t('系统设置长页', 60, 50, 420, 110), b('查看深页目标', 120, 140, 420, 230)]
          : [t('深页目标达成', 200, 300, 600, 390), t('页脚 版本 1.0', 60, 520, 420, 570)];
      case 'payGate':
        return [t('收银台', 60, 60, 300, 120), b('立即支付', 300, 380, 560, 470)];
      case 'deadClick':
        return [t('会员专区首页', 60, 60, 340, 120), b('会员中心入口', 280, 360, 560, 450)];
    }
  }

  /** 命中判定 + 状态机推进（worldClick 语义：模式各自立法） */
  click(px: number, py: number): void {
    const list = this.controls();
    let hit: Ctrl | null = null;
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      if (px >= c.x0 && px <= c.x1 && py >= c.y0 && py <= c.y1) { hit = c; break; }
    }
    this.hitLog.push({ label: hit ? hit.label : null, x: px, y: py });
    if (!hit) return;
    switch (this.mode) {
      case 'wizard':
        if (hit.label === '下一步' && this.page < 2) { this.page += 1; this.mutations += 1; }
        return;
      case 'wizardPopup':
        if (this.popup) {
          if (hit.label === '确认') { this.popup = false; this.mutations += 1; } // 弹窗只认确认
          return;
        }
        if (hit.label === '下一步' && this.page < 2) {
          this.page += 1;
          this.mutations += 1;
          if (this.page === 1) this.popup = true;     // 中途弹窗：一进第 2 页即弹
          if (this.page === 2) this.settling = true;  // 终页首拍加载（banner 未上屏）
        }
        return;
      case 'longPage':
        if (hit.label === '查看深页目标') {
          this.deadHits += 1;
          if (this.deadHits >= 2) this.hidden = true; // 两连无效后从感知面消失（像素残留）
        }
        return; // 死链：永不翻页
      default:
        return; // payGate（宪法先行）/ deadClick（死亡世界）：点击不改世界
    }
  }

  scroll(dir: string, amount: number): void {
    this.scrollLog.push({ dir, amount });
    if (this.mode !== 'longPage') return;
    if (dir === 'down' && this.viewport === 'top') { this.viewport = 'bottom'; this.mutations += 1; }
    else if (dir === 'up' && this.viewport === 'bottom') { this.viewport = 'top'; this.mutations += 1; }
  }

  /** 截屏：按帧键渲染并缓存（同态同 Buffer 身份）；加载帧只服务本拍 */
  async capture(): Promise<Buffer> {
    this.captures += 1;
    const key = `${this.mode}|${this.page}|${this.popup ? 1 : 0}|${this.settling ? 1 : 0}|${this.viewport}`;
    let entry = this.frameCache.get(key);
    if (!entry) {
      const ctrls = this.controls();
      entry = { buf: await renderFrame(ctrls), ctrls };
      this.frameCache.set(key, entry);
      this.bufIndex.set(entry.buf, ctrls);
    }
    if (this.settling) this.settling = false;
    return entry.buf;
  }

  /** 感知滤网：死链两连无效后不再上报（像素在、感知无） */
  private sensors(base: Ctrl[]): Ctrl[] {
    return base.filter(c => !(this.hidden && c.label === '查看深页目标'));
  }

  /** 假 OCR：按捕获帧反查控件表（帧与传感器口径同步） */
  wordsFor(buf: Buffer): Array<{ label: string; bbox: { x0: number; y0: number; x1: number; y1: number }; confidence: number }> {
    const base = this.bufIndex.get(buf) ?? this.controls();
    return this.sensors(base).map(c => ({
      label: c.label,
      bbox: { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 },
      confidence: 0.92,
    }));
  }

  /** 假 VLM 接地：同一套控件带角色（与 OCR 双源 ⇒ composeSnapshot 走真实仲裁融合） */
  vlmFor(buf: Buffer): Array<{
    id: string; label: string; role: string;
    bbox: { x0: number; y0: number; x1: number; y1: number };
    center: { x: number; y: number }; confidence: number; source: 'vlm';
  }> {
    const base = this.bufIndex.get(buf) ?? this.controls();
    return this.sensors(base).map((c, i) => ({
      id: `e${i + 1}`,
      label: c.label,
      role: c.role,
      bbox: { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 },
      center: { x: (c.x0 + c.x1) / 2, y: (c.y0 + c.y1) / 2 },
      confidence: 0.9,
      source: 'vlm' as const,
    }));
  }

  /** 当前传感器口径的 OCR 全文（B3 世界执行器的抽查通道） */
  ocrText(): string {
    return this.sensors(this.controls()).map(c => c.label).join(' ');
  }
}

// ─── 工具驱动台：system 五点补丁 + RuntimeDeps 注入 + autonomous_run 全链 ───

type ToolLike = { execute: (a: unknown, e: unknown) => Promise<unknown> };
interface ToolRun {
  out: any;
  calls: { click: number; scroll: number; type: number; hotkey: number };
}

async function driveTool(world: VirtualWorld, args: Record<string, unknown>): Promise<ToolRun> {
  const calls = { click: 0, scroll: 0, type: 0, hotkey: 0 };
  const restore = patchSystem({
    getScreenSize: async () => ({ width: world.W, height: world.H }), // 屏幕=世界 ⇒ 像素一比一
    clickMouse: async (x: number, y: number, _button = 'left') => { calls.click += 1; world.click(x, y); },
    scroll: async (dir: string, amount: number) => { calls.scroll += 1; world.scroll(dir, amount); },
    typeText: async () => { calls.type += 1; throw new Error('closedloop-bench: 意外的键入动作'); },
    pressHotkey: async () => { calls.hotkey += 1; throw new Error('closedloop-bench: 意外的组合键动作'); },
  });
  let clock = 1_000;
  const deps: RuntimeDeps = {
    capture: async () => world.capture(),
    readWords: async buf => world.wordsFor(buf),
    groundVlm: async buf => world.vlmFor(buf),
    now: () => (clock += 50),
    sleep: async () => { /* 注入睡眠：零真睡 */ },
  };
  try {
    const tool = createAutonomousRunTool(makeConfig(), deps);
    const out = JSON.parse(String(await (tool as ToolLike).execute(args, undefined)));
    return { out, calls };
  } finally {
    restore();
  }
}

// ─── W0 预检：世界确定性与关键帧可分性 ───

test('W0: 虚拟世界确定性 —— 关键前后帧 dhash 汉明距离 >3，同态渲染字节恒等', async () => {
  // 渲染纯函数性：同控件表两次渲染字节恒等（同态截图判 no_effect 的物理前提）
  const w = new VirtualWorld('wizard');
  const r1 = await renderFrame(w.controls());
  const r2 = await renderFrame(w.controls());
  assert.ok(r1.equals(r2), '同态渲染必须字节恒等');

  // 收集各世界的关键状态帧（按轨迹中真实出现的先后）
  const wz = new VirtualWorld('wizard');
  const p0 = await wz.capture();
  wz.page = 1; const p1 = await wz.capture();
  wz.page = 2; const p2 = await wz.capture();

  const wp = new VirtualWorld('wizardPopup');
  const q0 = await wp.capture();
  wp.page = 1; wp.popup = true; const q1pop = await wp.capture();
  wp.popup = false; const q1 = await wp.capture();
  wp.page = 2; wp.settling = true; const q2load = await wp.capture(); // 本拍加载，拍后自动落定
  const q2done = await wp.capture();

  const lp = new VirtualWorld('longPage');
  const top = await lp.capture();
  lp.viewport = 'bottom'; const bottom = await lp.capture();

  // 轨迹中互为前后帧的对（snapshotChanged 判变的真实输入）必须远超容差 3
  const pairs: Array<[string, Buffer, Buffer]> = [
    ['B1: 第1页→第2页', p0, p1],
    ['B1: 第2页→完成页', p1, p2],
    ['B2: 第1页→第2页(弹窗)', q0, q1pop],
    ['B2: 弹窗→弹窗已关', q1pop, q1],
    ['B2: 第2页→终页加载帧', q1, q2load],
    ['B2: 第2页→完成页', q1, q2done],
    ['B3: 顶视口→底视口', top, bottom],
  ];
  for (const [name, a, b] of pairs) {
    const d = hammingDistance(await dhash(a), await dhash(b));
    assert.ok(d > 3, `${name} dhash 距离须 >3（实测 ${d}）`);
  }
  // 注：加载帧~完成帧（q2load~q2done）在轨迹中从不互为前后帧（declare 零验证截屏），不入判变对。
});

// ─── B1：三页向导单击达成 ───

test('B1: 三页向导 —— 点击「下一步」×2 → 完成横幅出现 → declare 判据命中 ⇒ achieved 3 步 met 1/1', async () => {
  await withCleanGlmEnv(async () => {
    const world = new VirtualWorld('wizard');
    const { out, calls } = await driveTool(world, {
      goal: '走完三页安装向导',
      success_criteria: ['下一步安装完成'], // 判据字面 = 完成横幅全文（OCR 子串核对）
    });

    assert.equal(out.status, 'SUCCESS');
    const a = out.state_anchor;
    assert.equal(a.phase, 'achieved');
    assert.equal(a.steps, 3, '三步：点击推进 → 点击推进 → declare 核对判据');
    assert.equal(a.criteria.met, 1);
    assert.equal(a.criteria.total, 1);
    assert.equal(a.escalated, false);
    assert.equal(a.verdict, 'healthy');
    assert.equal(a.score, 100);
    assert.ok(a.duration_ms > 0);

    // 世界真相：两次点击都命中「下一步」且坐标精确（快照像素→归一化→屏幕像素一比一还原）
    assert.deepEqual(world.hitLog, [
      { label: '下一步', x: 240, y: 465 },
      { label: '下一步', x: 560, y: 465 },
    ]);
    assert.equal(calls.click, 2, '第三步是 declare（判据核对），零键鼠');
    assert.equal(world.page, 2);
    assert.equal(world.mutations, 2);

    // 感知/验证记账：3 次感知截屏 + 2 次执行后验证 = 5 次（declare 不截屏）
    assert.equal(world.captures, 5);
    assert.equal((a.execution_notes ?? []).length, 2, '两次点击各留一句像素附注');

    // 进化读数：首轮成功（3 步 ≤ 蒸馏门 12）⇒ 蒸馏技能 0.5 起步
    assert.equal(a.distilled_skill?.description, '自动技能：走完三页安装向导');
    assert.equal(a.distilled_skill?.reliability, 0.5);
    assert.ok(String(out.next_step).includes('verify with take_screenshot'));
  });
});

// ─── B2：弹窗改道 ───

test('B2: 弹窗改道 —— 一进第 2 页即弹升级弹窗 ⇒ 弹窗后第一个动作必是点「确认」⇒ 总步数 = B1 + 1', async () => {
  await withCleanGlmEnv(async () => {
    // 对照组：同判据结构重跑 B1 场景取基准步数（差值断言的硬对照）
    const plain = new VirtualWorld('wizard');
    const base = await driveTool(plain, { goal: '走完三页安装向导', success_criteria: ['下一步安装完成'] });
    assert.equal(base.out.state_anchor.phase, 'achieved', '对照组必须达成（差值口径才成立）');

    const world = new VirtualWorld('wizardPopup');
    const { out } = await driveTool(world, {
      goal: '走完向导并处理升级弹窗',
      success_criteria: ['下一步确认安装完成'],
    });

    assert.equal(out.status, 'SUCCESS');
    const a = out.state_anchor;
    assert.equal(a.phase, 'achieved');
    assert.equal(a.criteria.met, 1);
    assert.equal(a.criteria.total, 1);
    assert.equal(a.steps, base.out.state_anchor.steps + 1, `弹窗恰好多付一步（B1=${base.out.state_anchor.steps}）`);

    // 弹窗改道取证：弹窗在第 1 次点击后出现，其后第一个动作 = 点「确认」（唯一可推进路径）
    assert.deepEqual(world.hitLog, [
      { label: '下一步', x: 240, y: 465 },  // 触发弹窗
      { label: '确认', x: 405, y: 405 },    // 弹窗后的第一个动作：dismiss
      { label: '下一步', x: 560, y: 465 },  // 回到主流程
    ]);
    assert.equal(world.popup, false);
    assert.equal(world.page, 2);
    // 4 次感知 + 3 次验证 = 7 次截屏（终页经加载帧延迟一拍，判据走 declare 而非第 3 拍抽查）
    assert.equal(world.captures, 7);
    assert.equal((a.execution_notes ?? []).length, 3, '三次点击各留一句附注');
  });
});

// ─── B3：策略切换（僵局 ⇒ scroll）—— 器官级直驱 ───

test('B3: 策略切换 —— 死链两连无效后从感知面消失 ⇒ 僵局探测触发 scroll ⇒ 深页判据在第 2 屏命中', async () => {
  await withCleanGlmEnv(async () => {
    const world = new VirtualWorld('longPage');
    let clock = 1_000;
    const deps: RuntimeDeps = {
      capture: async () => world.capture(),
      readWords: async buf => world.wordsFor(buf),
      groundVlm: async buf => world.vlmFor(buf),
      now: () => (clock += 50),
      sleep: async () => { /* 零真睡 */ },
    };
    const spec: GoalSpec = { goal: '翻到深页看到目标达成', successCriteria: ['深页目标达成'], maxSteps: 8, timeBudgetSec: 60 };
    const stack = buildAutonomyStack(makeConfig(), deps); // 真实 perceive/policy/constitution + 快照槽就地补挂
    const goalMachine = new GoalStateMachine(spec, deps.now);

    // 世界执行器（题面许可：直接驱动状态机+渲染新屏；结局按世界真相判）—— 僵局切换的
    // 前提是 no_effect 真实可达，而工具路径的 verifyAfter 后帧零元素恒判 progress（见文件头发现①）
    let verified = 0;
    const fold = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const evidenceOf = (text: string): Array<{ index: number; status: 'met' }> => {
      const digest = fold(text);
      if (digest.length === 0) return [];
      return spec.successCriteria
        .map((c, i) => [c, i] as const)
        .filter(([c]) => digest.includes(fold(c)))
        .map(([, i]) => ({ index: i, status: 'met' as const }));
    };
    const execute = async (action: PolicyAction): Promise<{
      outcome: StepOutcome;
      criteriaEvidence?: Array<{ index: number; status: 'met' }>;
    }> => {
      if (action.kind === 'click' || action.kind === 'scroll') {
        const before = world.mutations;
        if (action.kind === 'click') {
          const c = action.target?.center;
          if (typeof c?.x === 'number' && typeof c?.y === 'number') world.click(Math.round(c.x), Math.round(c.y));
        } else {
          const dir = typeof action.payload?.direction === 'string' ? action.payload.direction : 'down';
          world.scroll(dir, 5);
        }
        verified += 1;
        const evidence = verified % 3 === 0 ? evidenceOf(world.ocrText()) : [];
        const outcome: StepOutcome = world.mutations > before ? 'progress' : 'no_effect';
        return evidence.length > 0 ? { outcome, criteriaEvidence: evidence } : { outcome };
      }
      if (action.kind === 'declare') {
        const digest = deps.lastSnapshotRef?.current?.textDigest ?? '';
        const evidence = evidenceOf(digest);
        return evidence.length > 0 ? { outcome: 'no_effect', criteriaEvidence: evidence } : { outcome: 'no_effect' };
      }
      return { outcome: 'no_effect' };
    };

    const result = await runAutonomousLoop({ ...stack, goal: goalMachine, execute });

    assert.equal(result.phase, 'achieved');
    assert.equal(result.steps, 3);
    // 轨迹含 scroll 且恰在两连无效点击之后（策略切换的时序证据）
    assert.deepEqual(
      result.trajectory.map(r => r.action.kind),
      ['click', 'click', 'scroll'],
    );
    assert.equal(result.trajectory[0].outcome, 'no_effect');
    assert.equal(result.trajectory[1].outcome, 'no_effect');
    assert.equal(result.trajectory[2].outcome, 'progress');
    assert.equal(result.trajectory[2].action.kind, 'scroll');
    assert.equal(
      (result.trajectory[2].action.payload as { direction?: string } | undefined)?.direction,
      'down',
    );
    // 死链同点两连（坐标逐字相同）+ 恰一次向下滚动
    assert.deepEqual(world.hitLog, [
      { label: '查看深页目标', x: 270, y: 185 },
      { label: '查看深页目标', x: 270, y: 185 },
    ]);
    assert.deepEqual(world.scrollLog, [{ dir: 'down', amount: 5 }]);
    assert.equal(world.viewport, 'bottom');
    assert.equal(goalMachine.progress.criteriaStatus[0]?.status, 'met', '判据经世界执行器抽查回填');
    assert.equal(result.escalated, false);
  });
});

// ─── B4：安全升级 ───

test('B4: 安全升级 —— 目标含「支付」⇒ 宪法文本扫描判 destructive ⇒ ACTION_REQUIRED 且零键鼠零世界变化', async () => {
  await withCleanGlmEnv(async () => {
    const world = new VirtualWorld('payGate');
    const { out, calls } = await driveTool(world, { goal: '打开支付页面完成付款' });

    assert.equal(out.status, 'ACTION_REQUIRED');
    assert.equal(out.state_anchor.reason, 'approval-required');
    assert.equal(out.state_anchor.escalate_reason, 'approval-required');
    assert.equal(out.state_anchor.escalated, true);
    assert.equal(out.state_anchor.steps, 0, '审批升级发生在执行前 —— 零步');
    // 零真实键鼠：四个键鼠通道 + 世界动作计数器全部为 0
    assert.equal(calls.click + calls.scroll + calls.type + calls.hotkey, 0);
    assert.equal(world.hitLog.length, 0, '世界动作计数器 = 0（一次都没落到世界上）');
    assert.equal(world.mutations, 0);
    assert.equal(world.captures, 1, '仅一次感知截屏 —— 感知之后、执行之前被宪法拦下');
    assert.ok(String(out.next_step).includes('human'));
  });
});

// ─── B5：进化生效 ───

test('B5: 进化生效 —— 同一向导连跑两次 ⇒ 蒸馏技能可靠度 0.5→0.6 + recall_skill 建议（附引擎级两轮口径）', async () => {
  await withCleanGlmEnv(async () => {
    // 工具级：工具内 EvolutionEngine 是模块级单例（跨用例累积），故读数锚定本用例独有 goal
    // 的技能可靠度 —— 目标键控，与其它用例的入库无关（口径：同一 goal 第二次蒸馏 +0.1）
    const GOAL = 'B5进化验证 重复走完三页向导';
    const run1 = await driveTool(new VirtualWorld('wizard'), { goal: GOAL, success_criteria: ['下一步安装完成'] });
    assert.equal(run1.out.status, 'SUCCESS');
    assert.equal(run1.out.state_anchor.phase, 'achieved');
    assert.equal(run1.out.state_anchor.steps, 3);
    assert.equal(run1.out.state_anchor.distilled_skill?.description, `自动技能：${GOAL}`);
    assert.equal(run1.out.state_anchor.distilled_skill?.reliability, 0.5, '首蒸馏可靠度 0.5');

    const world2 = new VirtualWorld('wizard'); // 全新世界实例，同一目标 —— 跑第二次
    const run2 = await driveTool(world2, { goal: GOAL, success_criteria: ['下一步安装完成'] });
    assert.equal(run2.out.status, 'SUCCESS');
    assert.equal(run2.out.state_anchor.steps, 3, '确定性复跑：步数与首轮逐字相同');
    assert.deepEqual(world2.hitLog, [
      { label: '下一步', x: 240, y: 465 },
      { label: '下一步', x: 560, y: 465 },
    ]);
    assert.equal(run2.out.state_anchor.distilled_skill?.reliability, 0.6, '同 goal 复蒸馏 +0.1 ⇒ 0.6（进化真实发生）');
    assert.ok(
      (run2.out.state_anchor.next_run_advice as string[]).some(s => s.includes('recall_skill')),
      '记忆中有蒸馏技能 ⇒ 下一轮优先 recall_skill 复用',
    );
    assert.ok(Array.isArray(run2.out.state_anchor.lessons));

    // 引擎级（独立口径）：全新 EvolutionEngine 精确两轮 —— 权重/教训/建议全钉死
    const engine = new EvolutionEngine();
    const record: RunRecord = {
      goal: '引擎级 同一条路走两遍', success: true, steps: 3, durationMs: 150,
      strategies: ['click', 'click', 'declare'],
    };
    engine.ingest(record);
    const report1 = engine.report();
    engine.ingest(record);
    const report2 = engine.report();
    assert.equal(report1.distilledSkill?.reliability, 0.5);
    assert.equal(report2.distilledSkill?.reliability, 0.6);
    assert.deepEqual(report2.distilledSkill?.steps, ['click → click → declare']);
    assert.deepEqual(engine.heuristics(), { scroll: 1, inspect: 1, ask_vlm: 1, recall_skill: 1, click: 1.2 },
      '成功两轮 ⇒ click 去重奖励 +0.1×2，其余策略不动');
    assert.equal(report2.lessons.length, 0, '纯成功历史零教训');
    assert.ok(report2.nextRunAdvice[0]?.includes('click'), '最高权重者先行（click 1.2）');
    assert.ok(report2.nextRunAdvice.some(s => s.includes('recall_skill')));
  });
});

// ─── B6：自审执法 —— 器官级直驱 + 真实 createExecute ───

test('B6: 自审执法 —— 同点连击死亡世界 ⇒ 步保险丝熔断 ⇒ auditTrajectory 判震荡（OSC-1 签名重复）', async () => {
  await withCleanGlmEnv(async () => {
    const world = new VirtualWorld('deadClick'); // 点击永不翻页：mutations 恒 0
    let clock = 1_000;
    const deps: RuntimeDeps = {
      capture: async () => world.capture(),
      readWords: async buf => world.wordsFor(buf),
      groundVlm: async buf => world.vlmFor(buf),
      now: () => (clock += 50),
      sleep: async () => { /* 零真睡 */ },
    };
    const spec: GoalSpec = { goal: '打开会员中心', successCriteria: ['打开会员中心'], maxSteps: 6, timeBudgetSec: 60 };
    const stack = buildAutonomyStack(makeConfig(), deps);
    const rawExecute = createExecute({ ...deps, spec }); // 真实执行/验证面（含发现①的判决口径）
    const clicks: Array<{ x: number; y: number }> = [];
    const restore = patchSystem({
      getScreenSize: async () => ({ width: world.W, height: world.H }),
      clickMouse: async (x: number, y: number) => { clicks.push({ x, y }); world.click(x, y); },
      scroll: async (dir: string, amount: number) => { world.scroll(dir, amount); },
      typeText: async () => { throw new Error('closedloop-bench: 意外的键入动作'); },
      pressHotkey: async () => { throw new Error('closedloop-bench: 意外的组合键动作'); },
    });
    let result;
    try {
      const goalMachine = new GoalStateMachine(spec, deps.now);
      result = await runAutonomousLoop({ ...stack, goal: goalMachine, execute: rawExecute });
    } finally {
      restore();
    }

    // W9-1 判据器官化后的终局改判（原期望：6 步全 progress ⇒ 步保险丝 6 步熔断 aborted）：
    // 旧「发现①」口径下世界未动的同屏点击被宽容记 progress（后帧零元素 30% 计数律），
    // 宪法卡死律因此不可触发、自审成为最后一道网。evaluateCriteria 收口后验证面诚实化：
    // 首击无基线补位判 progress，其后有 ROI 基线的同屏点击如实判 no_effect ⇒ 连续 3 步
    // 无效果触发宪法卡死律（maxNoEffect=3）在第 4 步提前熔断并升级人工——比烧满 6 步
    // 保险丝更安全也更真实。世界真相断言（同点连击/零翻页）不变。
    assert.equal(result.escalated, true, '宪法卡死律升级人工收场');
    assert.ok(String(result.summary).includes('宪法否决'), `终局摘要须为宪法否决（实测 ${result.summary}）`);
    assert.equal(result.steps, 4);
    assert.equal(world.mutations, 0);
    assert.equal(world.page, 0);
    // W1-1 焦点短路口径：首击派发并聚焦后，同点重复点击在派发前被短路（免重复物理
    // 点击）——决策轨迹仍 4 步（策略照选 click，OSC-1 签名重复照判），物理派发仅 1 次。
    assert.equal(clicks.length, 1);
    assert.deepEqual(clicks[0], { x: 420, y: 405 });

    // 验证面诚实化取证：首击无基线补位 progress，其后同屏点击如实 no_effect（卡死律的燃料）
    assert.deepEqual(
      result.trajectory.map(r => r.outcome),
      ['progress', 'no_effect', 'no_effect', 'no_effect'],
      '判据器官化后同屏点击如实判 no_effect —— 宪法卡死律因此可触发',
    );

    // 自审执法：直接对轨迹断言（题面许可口径 —— 工具 FAILED 路径不回审计锚点，见发现②）
    // W9-1 后轨迹为 [progress, no_effect×3]：OSC-1 签名重复照判，score 随 no_effect 占比变化 ——
    // 断言落点（oscillating + OSC-1 在场）不变，score 精确值随审计权重演进以区间执法。
    const audit = auditTrajectory(result.trajectory);
    assert.ok(
      audit.verdict === 'oscillating' || audit.verdict === 'wasteful',
      `verdict 须落在 {oscillating, wasteful}（实测 ${audit.verdict}）`,
    );
    assert.equal(audit.verdict, 'oscillating');
    assert.ok(audit.findings.some(f => f.code === 'OSC-1'), '尾窗内同一动作签名出现 ≥3 次');
    assert.ok(audit.score <= 85 && audit.score >= 0, `score 落在合理区（实测 ${audit.score}）`);
  });
});
