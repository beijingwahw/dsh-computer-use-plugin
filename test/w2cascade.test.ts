// test/w2cascade.test.ts
// W2-8（创新提案 C2 · 成本级联路由 tier cascade）契约测试。
// 铁律：全离线 —— 手写假 VisionProvider 桩（可控回复序列 / 调用计数，绝不真实
// 联网）；分诊为纯函数直测；级联执行器经真 ProviderPool + 假脑全程复算；
// 台账数值手算精确断言；glmClient 级联面经注入假 face 验证（缺省零行为变化）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  ProviderTier,
  VisionChatRequest,
  VisionChatResult,
  VisionProvider,
} from '../src/vlm/providers/types.ts';

const { ProviderPool } = await import('../src/vlm/providers/failover.ts');
const {
  VlmCascade,
  triageDanger,
  triageCheapEligible,
  withinBboxValidator,
  schemaValidator,
  ocrTextValidator,
  CASCADE_DANGER_MAX,
} = await import('../src/vlm/providers/cascade.ts');
const { CascadeMeter } = await import('../src/vlm/metering.ts');
const { GlmClient, attachCascadeFace } = await import('../src/vlm/glmClient.ts');

// ─── 假 VisionProvider 桩：可控回复序列 + 调用计数 ───

/** 单步脚本：ok 成败 / 回复文本 / 错误 / 违约上抛 */
interface Step {
  ok?: boolean;
  text?: string;
  error?: string;
  latencyMs?: number;
  throwMsg?: string;
}

/** 假桩观测面：调用计数 */
interface FakeBrain extends VisionProvider {
  readonly calls: number;
}

/** 铸假脑：steps 按次消耗，耗尽重复末步；tier 自报可选；configured 可伪造 */
function fakeBrain(
  id: string,
  steps: Step[],
  o: { tier?: ProviderTier; configured?: boolean } = {},
): FakeBrain {
  let calls = 0;
  const model = `m-${id}`;
  const self: FakeBrain = {
    id,
    protocol: 'openai',
    model,
    configured: o.configured ?? true,
    ...(o.tier !== undefined ? { tier: o.tier } : {}),
    get calls() {
      return calls;
    },
    async chat(r: VisionChatRequest): Promise<VisionChatResult> {
      void r;
      const step = steps[Math.min(calls, steps.length - 1)] ?? {};
      calls++;
      if (step.throwMsg !== undefined) throw new Error(step.throwMsg);
      if (step.ok === true) {
        return {
          ok: true,
          text: step.text ?? `ok@${id}`,
          latencyMs: step.latencyMs ?? 7,
          model,
          providerId: id,
        };
      }
      return {
        ok: false,
        text: '',
        error: step.error ?? `err@${id}`,
        latencyMs: step.latencyMs ?? 7,
        model,
        providerId: id,
      };
    },
    async chatJson<T>(r: VisionChatRequest): Promise<{ ok: boolean; value?: T; error?: string; raw: string }> {
      const res = await self.chat(r);
      return res.ok ? { ok: true, value: res.text as T, raw: res.text } : { ok: false, error: res.error, raw: '' };
    },
  };
  return self;
}

/** 最小合法请求（maxRetries 0 —— 无重试等待；timeoutMs 短防长定时器） */
function req(o: Partial<VisionChatRequest> = {}): VisionChatRequest {
  return { images: [{ base64: 'QUJD' }], prompt: '定位目标并输出 JSON', timeoutMs: 200, maxRetries: 0, ...o };
}

/** 省心三件套：目标 bbox + schema 谓词 + 易场景因子（danger 0.02 ⇒ 便宜可试） */
const TARGET_BBOX = { x0: 100, y0: 50, x1: 200, y1: 150 };
const EASY_FACTORS = { confidence: 0.95, risk: 'low' as const, sceneFamiliar: true };
const RISKY_FACTORS = { confidence: 0.2, risk: 'high' as const, sceneFamiliar: false };

// ─── W2-8a 三因子分诊：各因子边界与单调性 ───

test('W2-8a: 三因子危险度 —— 全绿因子（高置信×低危×旧场景）danger=0，便宜可试', () => {
  const d = triageDanger({ confidence: 1, risk: 'low', sceneFamiliar: true });
  assert.equal(d, 0);
  assert.equal(triageCheapEligible({ confidence: 1, risk: 'low', sceneFamiliar: true }), true);
});

test('W2-8a: 风险因子边界 —— high 档 danger=0.4 越阈 ⇒ 主力；medium 档 0.2 ⇒ 便宜可试', () => {
  assert.equal(triageDanger({ confidence: 1, risk: 'high', sceneFamiliar: true }), 0.4);
  assert.equal(triageCheapEligible({ confidence: 1, risk: 'high', sceneFamiliar: true }), false, '0.4 > 0.35');
  assert.equal(triageDanger({ confidence: 1, risk: 'medium', sceneFamiliar: true }), 0.2);
  assert.equal(triageCheapEligible({ confidence: 1, risk: 'medium', sceneFamiliar: true }), true, '0.2 ≤ 0.35');
});

test('W2-8a: 置信因子边界 —— 零置信 low 危旧场景 danger=0.4 越阈 ⇒ 主力', () => {
  assert.equal(triageDanger({ confidence: 0, risk: 'low', sceneFamiliar: true }), 0.4);
  assert.equal(triageCheapEligible({ confidence: 0, risk: 'low', sceneFamiliar: true }), false);
});

test('W2-8a: 新颖因子边界 —— 高置信低危但新场景 danger=0.2 ⇒ 便宜可试；三缺一仍可试', () => {
  assert.equal(triageDanger({ confidence: 1, risk: 'low', sceneFamiliar: false }), 0.2);
  assert.equal(triageCheapEligible({ confidence: 1, risk: 'low', sceneFamiliar: false }), true);
});

test('W2-8a: 缺省因子全保守 —— 空因子/缺席 ⇒ danger≈0.6 高危直行主力（失败安全）', () => {
  const d = triageDanger({});
  assert.ok(Math.abs(d - 0.6) < 1e-9, `缺省因子 danger≈0.6（实测 ${d}）`);
  assert.equal(triageCheapEligible({}), false);
  assert.equal(triageCheapEligible(undefined), false);
  assert.equal(triageDanger(null) > CASCADE_DANGER_MAX, true, '脏因子按保守缺省打分');
});

test('W2-8a: 因子单调性 —— 置信升 ⇒ danger 降；风险升 ⇒ danger 升；新场景 ⇒ 更危险', () => {
  const confUp = triageDanger({ confidence: 0.9, risk: 'low', sceneFamiliar: true });
  const confDown = triageDanger({ confidence: 0.5, risk: 'low', sceneFamiliar: true });
  assert.ok(confUp < confDown, '置信单调');
  const low = triageDanger({ confidence: 0.9, risk: 'low', sceneFamiliar: true });
  const mid = triageDanger({ confidence: 0.9, risk: 'medium', sceneFamiliar: true });
  const high = triageDanger({ confidence: 0.9, risk: 'high', sceneFamiliar: true });
  assert.ok(low < mid && mid < high, '风险单调');
  const novel = triageDanger({ confidence: 0.9, risk: 'low', sceneFamiliar: false });
  assert.ok(novel > low, '新场景更危险');
});

test('W2-8a: 阈值注入可调 —— dangerMax 收紧翻案；边界含等号（≤ 即可试）', () => {
  const f = { confidence: 1, risk: 'medium' as const, sceneFamiliar: true }; // danger = 0.2
  assert.equal(triageCheapEligible(f), true, '缺省 0.35 放行');
  assert.equal(triageCheapEligible(f, { dangerMax: 0.1 }), false, '收紧到 0.1 ⇒ 翻案主力');
  // 边界含等号：阈值恰等于 danger ⇒ 放行；略低于 danger ⇒ 拒
  const d = triageDanger(f);
  assert.equal(triageCheapEligible(f, { dangerMax: d }), true, '等号边界放行');
  assert.equal(triageCheapEligible(f, { dangerMax: d - 1e-9 }), false, '略低即拒');
});

test('W2-8a: 权重注入可调 —— 单因子权重 1 ⇒ danger=1−置信（纯置信分诊）', () => {
  const d = triageDanger({ confidence: 0.3, risk: 'high', sceneFamiliar: false }, {
    confidence: 1, risk: 0, novelty: 0,
  });
  assert.equal(d, 0.7);
  // 脏权重（全零）回退缺省权重，不除零不抛
  const dirty = triageDanger({ confidence: 1, risk: 'low', sceneFamiliar: true }, {
    confidence: 0, risk: 0, novelty: 0,
  });
  assert.equal(dirty, 0, '全零权重回退缺省后仍正常打分');
});

test('W2-8a: 脏因子消毒 —— NaN 置信按中性 0.5、脏风险档按 medium，绝不抛', () => {
  const d = triageDanger({ confidence: Number.NaN, risk: 'bogus' as never, sceneFamiliar: 'yes' as never });
  assert.ok(Math.abs(d - 0.6) < 1e-9, '脏值全按保守缺省（≈0.6）');
  assert.ok(Number.isFinite(d));
});

// ─── W2-8b 便宜校验通过 ⇒ 省钱（主力零调用 + 台账命中） ───

test('W2-8b: 便宜档过确定性校验 ⇒ 采信便宜答案，主力零调用，台账记省钱', async () => {
  const primary = fakeBrain('glm-pro', [{ ok: true, text: '{"point":{"x":150,"y":100}}' }]);
  const cheap = fakeBrain('glm-flash', [{ ok: true, text: '{"point":{"x":120,"y":80}}' }], { tier: 'cheap' });
  const pool = new ProviderPool([primary, cheap]);
  const cascade = new VlmCascade(pool, {
    validators: [schemaValidator({ point: 'object' }), withinBboxValidator(TARGET_BBOX)],
  });

  const r = await cascade.runJson<{ point: { x: number; y: number } }>(req(), { factors: EASY_FACTORS });
  assert.notEqual(r, null, '承接');
  assert.equal(r!.ok, true);
  assert.equal(r!.value!.point.x, 120, '采信便宜答案的值（非主力的 150）');
  assert.equal(r!.providerId, 'glm-flash', '归因便宜脑');
  assert.deepEqual(r!.meta, { tier: 'cheap', escalated: false, reason: 'cheap-hit' });
  assert.equal(cheap.calls, 1, '便宜脑恰一调');
  assert.equal(primary.calls, 0, '主力零调用 —— 省钱事件');

  const s = cascade.stats;
  assert.equal(s.eligible, 1);
  assert.equal(s.cheapHit, 1);
  assert.equal(s.escalated, 0);
  assert.equal(s.hitRate, 1);
  assert.deepEqual(s.cheapTier, { calls: 1, units: 0.25 }, '缺省价格 cheap=0.25');
  assert.deepEqual(s.primaryTier, { calls: 0, units: 0 });
  assert.equal(s.spentUnits, 0.25);
  assert.equal(s.baselineUnits, 1, '反事实基线 = 1 × 主力价 1');
  assert.equal(s.savedUnits, 0.75);
  assert.equal(s.savingsRate, 0.75, '节省率 = 命中率 1 × 价差比 0.75');
});

// ─── W2-8c 校验失败 ⇒ 升级主力重做（安全升级，不省反贵也诚实记账） ───

test('W2-8c: 坐标出界 ⇒ 便宜答案作废，升级主力重做，两脑各记一笔诚实账', async () => {
  const primary = fakeBrain('glm-pro', [{ ok: true, text: '{"point":{"x":110,"y":60}}' }]);
  const cheap = fakeBrain('glm-flash', [{ ok: true, text: '{"point":{"x":500,"y":500}}' }], { tier: 'cheap' });
  const pool = new ProviderPool([primary, cheap]);
  const cascade = new VlmCascade(pool, { validators: [withinBboxValidator(TARGET_BBOX)] });

  const r = await cascade.runJson<{ point: { x: number } }>(req(), { factors: EASY_FACTORS });
  assert.equal(r!.ok, true);
  assert.equal(r!.value!.point.x, 110, '升级后采信主力答案');
  assert.equal(r!.providerId, 'glm-pro');
  assert.deepEqual(r!.meta, { tier: 'primary', escalated: true, reason: 'validation-failed:bbox-within' });
  assert.equal(cheap.calls, 1, '便宜脑白花一次');
  assert.equal(primary.calls, 1, '主力重做一次');

  const s = cascade.stats;
  assert.equal(s.cheapHit, 0);
  assert.equal(s.escalated, 1);
  assert.equal(s.hitRate, 0);
  assert.equal(s.spentUnits, 0.25 + 1, '便宜 0.25 + 主力 1 —— 两笔都记');
  assert.equal(s.baselineUnits, 1);
  assert.equal(s.savedUnits, -0.25, '负节省如实上报（不钳零）');
  assert.equal(s.savingsRate, -0.25);
});

test('W2-8c: 便宜档调用失败/JSON 不可解析 ⇒ 同律升级主力（reason 区分）', async () => {
  // 调用失败（http 500）
  {
    const primary = fakeBrain('glm-pro', [{ ok: true, text: '{"point":{"x":110,"y":60}}' }]);
    const cheap = fakeBrain('glm-flash', [{ ok: false, error: 'flash http 500 after 1 attempt' }], { tier: 'cheap' });
    const cascade = new VlmCascade(new ProviderPool([primary, cheap]), {
      validators: [withinBboxValidator(TARGET_BBOX)],
    });
    const r = await cascade.runJson(req(), { factors: EASY_FACTORS });
    assert.equal(r!.ok, true);
    assert.equal(r!.meta.escalated, true);
    assert.equal(r!.meta.reason, 'cheap-call-failed');
    assert.equal(r!.providerId, 'glm-pro');
  }
  // 文本 ok 但剥不出 JSON
  {
    const primary = fakeBrain('glm-pro', [{ ok: true, text: '{"point":{"x":110,"y":60}}' }]);
    const cheap = fakeBrain('glm-flash', [{ ok: true, text: '我打不开这个 JSON' }], { tier: 'cheap' });
    const cascade = new VlmCascade(new ProviderPool([primary, cheap]), {
      validators: [withinBboxValidator(TARGET_BBOX)],
    });
    const r = await cascade.runJson(req(), { factors: EASY_FACTORS });
    assert.equal(r!.ok, true);
    assert.equal(r!.meta.reason, 'json-unparseable');
    assert.equal(r!.providerId, 'glm-pro');
  }
});

test('W2-8c: 升级主力也失败 ⇒ ok:false 诚实归因（升级已花真金，不静默吞）', async () => {
  const primary = fakeBrain('glm-pro', [{ ok: false, error: 'pro http 503 after 1 attempt' }]);
  const cheap = fakeBrain('glm-flash', [{ ok: true, text: '{"point":{"x":500,"y":500}}' }], { tier: 'cheap' });
  const cascade = new VlmCascade(new ProviderPool([primary, cheap]), {
    validators: [withinBboxValidator(TARGET_BBOX)],
  });
  const r = await cascade.runJson(req(), { factors: EASY_FACTORS });
  assert.equal(r!.ok, false);
  assert.equal(r!.error, 'pro http 503 after 1 attempt', '保留主力失败现场');
  assert.deepEqual(r!.meta, { tier: 'primary', escalated: true, reason: 'validation-failed:bbox-within' });
  assert.equal(cascade.stats.escalated, 1);
});

test('W2-8c: 便宜脑未配置被跳过（未拨号）⇒ 升级只记主力的钱（cheapUnits=0）', async () => {
  const primary = fakeBrain('glm-pro', [{ ok: true, text: '{"point":{"x":110,"y":60}}' }]);
  const cheap = fakeBrain('glm-flash', [{ ok: true }], { tier: 'cheap', configured: false });
  const cascade = new VlmCascade(new ProviderPool([primary, cheap]), {
    validators: [withinBboxValidator(TARGET_BBOX)],
  });
  const r = await cascade.runJson(req(), { factors: EASY_FACTORS });
  assert.equal(r!.ok, true);
  assert.equal(r!.meta.escalated, true);
  assert.deepEqual(cascade.stats.cheapTier, { calls: 0, units: 0 }, '未拨号不计钱');
  assert.equal(cascade.stats.spentUnits, 1, '只花主力 1');
  assert.equal(cascade.stats.savedUnits, 0);
});

// ─── W2-8d 确定性校验谓词集：坐标 / schema / OCR 文字 ───

test('W2-8d: bbox 谓词 —— 界内真/出界假/边界含等号/取不到点假/数组点形也认', () => {
  const v = withinBboxValidator(TARGET_BBOX);
  assert.equal(v.check({ point: { x: 150, y: 100 } }), true);
  assert.equal(v.check({ point: { x: 100, y: 50 } }), true, '左上角边界含等号');
  assert.equal(v.check({ point: { x: 200, y: 150 } }), true, '右下角边界含等号');
  assert.equal(v.check({ point: { x: 201, y: 100 } }), false, '出界');
  assert.equal(v.check({ point: { x: 150, y: 999 } }), false, '出界');
  assert.equal(v.check({}), false, '取不到点 = 不可采信');
  assert.equal(v.check('garbage'), false);
  assert.equal(v.check(null), false);
  assert.equal(v.check({ point: [120, 80] }), true, '[x,y] 数组点形');
  assert.equal(v.check({ center: { x: 120, y: 80 } }), true, 'center 取点兜底');
  assert.equal(v.check({ x: 120, y: 80 }), true, '顶层 {x,y} 取点兜底');
  // 敌意取点函数抛错 ⇒ false 绝不带出
  const hostile = withinBboxValidator(TARGET_BBOX, () => {
    throw new Error('敌意取点');
  });
  assert.equal(hostile.check({ point: { x: 1, y: 1 } }), false);
  // 目标框自身脏值（NaN）⇒ 不可验证
  const dirtyBox = withinBboxValidator({ x0: Number.NaN, y0: 0, x1: 10, y1: 10 } as never);
  assert.equal(dirtyBox.check({ point: { x: 1, y: 1 } }), false);
});

test('W2-8d: schema 谓词 —— 必备键齐且型符 ⇒ 真；缺键/错型/NaN 数 ⇒ 假；额外键宽容', () => {
  const v = schemaValidator({ verdict: 'string', confidence: 'number', items: 'array' });
  assert.equal(v.check({ verdict: 'confirmed', confidence: 0.9, items: [] }), true);
  assert.equal(v.check({ verdict: 'confirmed', confidence: 0.9, items: [], extra: '被宽容' }), true);
  assert.equal(v.check({ verdict: 'confirmed', confidence: 0.9 }), false, '缺 items 键');
  assert.equal(v.check({ verdict: 1, confidence: 0.9, items: [] }), false, 'verdict 错型');
  assert.equal(v.check({ verdict: 'confirmed', confidence: Number.NaN, items: [] }), false, 'NaN 非有限数');
  assert.equal(v.check({ verdict: 'confirmed', confidence: 0.9, items: {} }), false, 'items 非数组');
  assert.equal(v.check([1, 2]), false, '数组本体不认');
  assert.equal(v.check(null), false);
  assert.equal(v.check('{"verdict":"confirmed"}'), false, '字符串载荷不认（要对象）');
  assert.equal(schemaValidator({}).check({ a: 1 }), false, '空 schema = 不可验证 = 不过');
  // object 档类型
  const ov = schemaValidator({ point: 'object' });
  assert.equal(ov.check({ point: { x: 1 } }), true);
  assert.equal(ov.check({ point: [1, 2] }), false, 'array 不冒充 object');
  assert.equal(ov.check({ point: null }), false);
});

test('W2-8d: OCR 文字谓词 —— 归一包含/相似度双路放行，文字不一致 ⇒ 假', () => {
  const v = ocrTextValidator('保存');
  assert.equal(v.check({ text: '保存' }), true, '精确一致');
  assert.equal(v.check({ text: '点击 [保存] 按钮' }), true, '归一包含');
  assert.equal(v.check({ text: '删 除' }), false, '文字不一致（相似度 0）');
  assert.equal(v.check({ label: '保存' }), true, 'label 兜底取字');
  assert.equal(v.check({ something: 'x' }), false, '取不到文本');
  assert.equal(v.check({ text: '' }), false, '空文本不可验证');
  assert.equal(ocrTextValidator('').check({ text: '任意' }), false, '空期望不可验证');
  // 相似度路径：一字母差 0.875 ≥ 0.8 放行；收紧到 1.0 ⇒ 假
  const en = ocrTextValidator('Setings');
  assert.equal(en.check({ text: 'Settings' }), true, '一字母差 0.875 过缺省线');
  assert.equal(ocrTextValidator('Setings', { minSimilarity: 1 }).check({ text: 'Settings' }), false, '收紧线 ⇒ 假');
  // key 注入取字
  assert.equal(ocrTextValidator('确定', { key: 'caption' }).check({ caption: '确 定' }), true);
  assert.equal(ocrTextValidator('确定', { key: 'caption' }).check({ text: '确定' }), false, 'key 指定后不看 text');
  // 大小写与空白噪声归一
  assert.equal(ocrTextValidator('SETTINGS').check({ text: '  settings  page ' }), true);
});

test('W2-8d: 三谓词级联端到端 —— schema 坏 / OCR 不一致各触发升级并点名谓词', async () => {
  // schema 坏
  {
    const primary = fakeBrain('glm-pro', [{ ok: true, text: '{"point":{"x":110,"y":60}}' }]);
    const cheap = fakeBrain('glm-flash', [{ ok: true, text: '{"point":"nope"}' }], { tier: 'cheap' });
    const cascade = new VlmCascade(new ProviderPool([primary, cheap]), {
      validators: [schemaValidator({ point: 'object' }), withinBboxValidator(TARGET_BBOX)],
    });
    const r = await cascade.runJson(req(), { factors: EASY_FACTORS });
    assert.equal(r!.ok, true);
    assert.equal(r!.meta.reason, 'validation-failed:json-schema', 'schema 谓词点名');
  }
  // OCR 文字不一致
  {
    const primary = fakeBrain('glm-pro', [{ ok: true, text: '{"text":"保存"}' }]);
    const cheap = fakeBrain('glm-flash', [{ ok: true, text: '{"text":"删除"}' }], { tier: 'cheap' });
    const cascade = new VlmCascade(new ProviderPool([primary, cheap]), {
      validators: [ocrTextValidator('保存')],
    });
    const r = await cascade.runJson(req(), { factors: EASY_FACTORS });
    assert.equal(r!.ok, true);
    assert.equal(r!.meta.reason, 'validation-failed:ocr-text', 'OCR 谓词点名');
  }
});

test('W2-8d: 多谓词 AND 语义 —— 任一不过即升级；谓词自身抛错按不过计', async () => {
  const primary = fakeBrain('glm-pro', [{ ok: true, text: '{"point":{"x":110,"y":60}}' }]);
  const cheap = fakeBrain('glm-flash', [{ ok: true, text: '{"point":{"x":120,"y":80}}' }], { tier: 'cheap' });
  const hostile: { name: string; check(v: unknown): boolean } = {
    name: 'hostile',
    check(): boolean {
      throw new Error('谓词内爆');
    },
  };
  const cascade = new VlmCascade(new ProviderPool([primary, cheap]), {
    validators: [withinBboxValidator(TARGET_BBOX), hostile],
  });
  const r = await cascade.runJson(req(), { factors: EASY_FACTORS });
  assert.equal(r!.ok, true);
  assert.equal(r!.providerId, 'glm-pro', '坐标过检但敌意谓词抛错 ⇒ 升级主力（失败安全）');
  assert.equal(r!.meta.reason, 'validation-failed:hostile');
});

// ─── W2-8e 未标注 tier ⇒ 零行为变化 ───

test('W2-8e: 未标注 tier —— 花名册全主力档，级联恒弃权且零调用', async () => {
  const a = fakeBrain('glm', [{ ok: true, text: '{"point":{"x":1,"y":1}}' }]);
  const b = fakeBrain('qwen', [{ ok: true }]);
  const pool = new ProviderPool([a, b]);
  assert.deepEqual(pool.tierRoster(), [
    { id: 'glm', tier: 'primary' },
    { id: 'qwen', tier: 'primary' },
  ], '未标注全主力');
  const cascade = new VlmCascade(pool, { validators: [withinBboxValidator(TARGET_BBOX)] });
  const r = await cascade.runJson(req(), { factors: EASY_FACTORS });
  assert.equal(r, null, '池内无 cheap 档 ⇒ 弃权（零行为变化律）');
  assert.equal(a.calls + b.calls, 0, '零调用');
  assert.equal(cascade.stats.eligible, 0, '零记账');
});

test('W2-8e: 未标注 tier 的池上 chatTier(primary) ≡ chat()（同链同结果）', async () => {
  const a = fakeBrain('glm', [{ ok: true, text: '主力回复' }]);
  const b = fakeBrain('qwen', [{ ok: true }]);
  const pool = new ProviderPool([a, b]);
  const viaChat = await pool.chat(req());
  const viaTier = await pool.chatTier(req(), 'primary');
  assert.equal(viaChat.ok, true);
  assert.equal(viaChat.providerId, 'glm');
  assert.deepEqual(
    { ok: viaTier.ok, text: viaTier.text, providerId: viaTier.providerId, model: viaTier.model },
    { ok: viaChat.ok, text: viaChat.text, providerId: viaChat.providerId, model: viaChat.model },
  );
  assert.equal(b.calls, 0);
});

test('W2-8e: tier 标注不改变 chat() 全池切换语义（failover 正交律）', async () => {
  // 主力挂了，cheap 档备脑顶上 —— chat() 的池序不看 tier
  const primary = fakeBrain('glm-pro', [{ ok: false, error: '挂了' }]);
  const cheap = fakeBrain('glm-flash', [{ ok: true, text: '便宜脑救场' }], { tier: 'cheap' });
  const pool = new ProviderPool([primary, cheap]);
  const r = await pool.chat(req());
  assert.equal(r.ok, true);
  assert.equal(r.providerId, 'glm-flash', 'chat() 跨 tier 切换照旧');
});

// ─── W2-8f 节省率记账数值（手算精确断言） ───

test('W2-8f: CascadeMeter 数值 —— 2 命中 + 1 升级 ⇒ 节省率 = 1.25/3', () => {
  const m = new CascadeMeter(); // primaryPrice 缺省 1
  m.recordCheapHit(0.25, true);
  m.recordCheapHit(0.25, true);
  m.recordEscalation(0.25, true);
  const s = m.stats();
  assert.equal(s.eligible, 3);
  assert.equal(s.cheapHit, 2);
  assert.equal(s.escalated, 1);
  assert.ok(Math.abs(s.hitRate - 2 / 3) < 1e-12, '命中率 2/3');
  assert.deepEqual(s.cheapTier, { calls: 3, units: 0.75 });
  assert.deepEqual(s.primaryTier, { calls: 1, units: 1 });
  assert.equal(s.spentUnits, 1.75);
  assert.equal(s.baselineUnits, 3);
  assert.equal(s.savedUnits, 1.25);
  assert.ok(Math.abs(s.savingsRate - 1.25 / 3) < 1e-12, '节省率 = 命中率×价差比 = 1.25/3');
});

test('W2-8f: CascadeMeter —— 未拨号升级只记主力的钱；脏价格单位记 0', () => {
  const m = new CascadeMeter();
  m.recordEscalation(0.25, false); // 便宜被熔断跳过，未拨号
  let s = m.stats();
  assert.deepEqual(s.cheapTier, { calls: 0, units: 0 });
  assert.equal(s.spentUnits, 1);
  assert.equal(s.savedUnits, 0);
  m.recordCheapHit(Number.NaN, true); // 脏单位消毒
  s = m.stats();
  assert.deepEqual(s.cheapTier, { calls: 1, units: 0 });
});

test('W2-8f: CascadeMeter —— 价差倒挂（便宜比主力贵）负节省如实上报', () => {
  const m = new CascadeMeter({ primaryPrice: 0.2 });
  m.recordEscalation(0.25, true);
  const s = m.stats();
  assert.equal(s.spentUnits, 0.45);
  assert.equal(s.baselineUnits, 0.2);
  assert.equal(s.savedUnits, -0.25);
  assert.equal(s.savingsRate, -1.25);
});

test('W2-8f: CascadeMeter —— 空台账零除防线与 reset', () => {
  const m = new CascadeMeter();
  let s = m.stats();
  assert.equal(s.eligible, 0);
  assert.equal(s.hitRate, 0, '零除防线：无 NaN');
  assert.equal(s.savingsRate, 0);
  m.recordCheapHit(0.25, true);
  m.recordPrimaryDirect();
  m.recordPrimaryDirect();
  s = m.stats();
  assert.equal(s.primaryDirect, 2, '高危直行仅观测计数，不入队列');
  assert.equal(s.baselineUnits, 1, '基线不含 primaryDirect');
  m.reset();
  s = m.stats();
  assert.equal(s.eligible, 0);
  assert.equal(s.primaryDirect, 0);
});

test('W2-8f: VlmCascade 注入价格与共享台账 —— 2 命中 1 升级的全链记账', async () => {
  const shared = new CascadeMeter({ primaryPrice: 2 });
  const primary = fakeBrain('glm-pro', [
    { ok: true, text: '{"point":{"x":110,"y":60}}' },
    { ok: true, text: '{"point":{"x":110,"y":60}}' },
    { ok: true, text: '{"point":{"x":110,"y":60}}' },
  ]);
  const cheap = fakeBrain('glm-flash', [
    { ok: true, text: '{"point":{"x":120,"y":80}}' }, // 命中 1
    { ok: true, text: '{"point":{"x":500,"y":500}}' }, // 校验不过 ⇒ 升级
    { ok: true, text: '{"point":{"x":130,"y":90}}' }, // 命中 2
  ], { tier: 'cheap' });
  const cascade = new VlmCascade(new ProviderPool([primary, cheap]), {
    validators: [withinBboxValidator(TARGET_BBOX)],
    prices: { primary: 2, cheap: 0.5 },
    meter: shared,
  });
  const r1 = await cascade.runJson(req(), { factors: EASY_FACTORS });
  const r2 = await cascade.runJson(req(), { factors: EASY_FACTORS });
  const r3 = await cascade.runJson(req(), { factors: EASY_FACTORS });
  assert.equal(r1!.meta.tier, 'cheap');
  assert.equal(r2!.meta.escalated, true);
  assert.equal(r3!.meta.tier, 'cheap');
  const s = shared.stats(); // = cascade.stats（共享实例）
  assert.deepEqual(cascade.stats, s);
  assert.equal(s.cheapTier.units, 1.5, '三次便宜实拨 × 0.5');
  assert.equal(s.primaryTier.units, 2, '一次升级 × 主力价 2');
  assert.equal(s.spentUnits, 3.5);
  assert.equal(s.baselineUnits, 6);
  assert.equal(s.savedUnits, 2.5);
  assert.equal(s.savingsRate, 2.5 / 6);
});

test('W2-8f: 高危直行只记 primaryDirect 观测账（不入节省率队列）', async () => {
  const primary = fakeBrain('glm-pro', [{ ok: true }]);
  const cheap = fakeBrain('glm-flash', [{ ok: true }], { tier: 'cheap' });
  const cascade = new VlmCascade(new ProviderPool([primary, cheap]), {
    validators: [withinBboxValidator(TARGET_BBOX)],
  });
  const r = await cascade.runJson(req(), { factors: RISKY_FACTORS });
  assert.equal(r, null, '高危 ⇒ 弃权（主路径走主力）');
  assert.equal(cheap.calls, 0, '便宜脑零调用');
  assert.equal(cascade.stats.primaryDirect, 1);
  assert.equal(cascade.stats.eligible, 0, '不入队列');
});

// ─── W2-8g 级联弃权闸：无谓词/无因子 ⇒ 恒 null ───

test('W2-8g: 无校验谓词 ⇒ 弃权（无确定性校验则便宜答案永不可采信）', async () => {
  const primary = fakeBrain('glm-pro', [{ ok: true }]);
  const cheap = fakeBrain('glm-flash', [{ ok: true }], { tier: 'cheap' });
  const cascade = new VlmCascade(new ProviderPool([primary, cheap]));
  const r = await cascade.runJson(req(), { factors: EASY_FACTORS });
  assert.equal(r, null);
  assert.equal(cheap.calls, 0);
});

test('W2-8g: 无分诊因子 ⇒ 弃权（无证据不便宜）；敌意池抛错 ⇒ 弃权不外抛', async () => {
  const primary = fakeBrain('glm-pro', [{ ok: true }]);
  const cheap = fakeBrain('glm-flash', [{ ok: true }], { tier: 'cheap' });
  const cascade = new VlmCascade(new ProviderPool([primary, cheap]), {
    validators: [withinBboxValidator(TARGET_BBOX)],
  });
  assert.equal(await cascade.runJson(req()), null, '因子缺席 ⇒ 弃权');
  assert.equal(await cascade.runJson(req(), {}), null);
  assert.equal(cheap.calls, 0);
  // 敌意池：chatTier 恒上抛 ⇒ 内部收敛，绝不外抛
  const hostilePool = {
    size: 2,
    tierRoster: () => [{ id: 'a', tier: 'primary' as const }, { id: 'b', tier: 'cheap' as const }],
    async chatTier(): Promise<VisionChatResult> {
      throw new Error('敌意池');
    },
  };
  const hostileCascade = new VlmCascade(hostilePool, { validators: [withinBboxValidator(TARGET_BBOX)] });
  const hr = await hostileCascade.runJson(req(), { factors: EASY_FACTORS });
  assert.notEqual(hr, null, '承接了升级臂（两臂都抛 ⇒ 诚实失败）');
  assert.equal(hr!.ok, false);
  assert.equal(hr!.meta.escalated, true);
  assert.equal(hr!.meta.reason, 'cheap-call-failed');
  assert.equal(hostileCascade.stats.escalated, 1, '升级记账照记');
});

test('W2-8g: 因子优先级 —— perCall.factors 压过接线态因子源', async () => {
  const primary = fakeBrain('glm-pro', [{ ok: true, text: '{"point":{"x":110,"y":60}}' }]);
  const cheap = fakeBrain('glm-flash', [{ ok: true, text: '{"point":{"x":120,"y":80}}' }], { tier: 'cheap' });
  const cascade = new VlmCascade(new ProviderPool([primary, cheap]), {
    validators: [withinBboxValidator(TARGET_BBOX)],
    factors: () => EASY_FACTORS, // 接线源：可试
  });
  // perCall 显式高危 ⇒ 压过接线源 ⇒ 弃权
  const r = await cascade.runJson(req(), { factors: RISKY_FACTORS });
  assert.equal(r, null);
  assert.equal(cascade.stats.primaryDirect, 1);
  // perCall 缺席 ⇒ 用接线源 ⇒ 承接便宜臂
  const r2 = await cascade.runJson(req());
  assert.equal(r2!.meta.tier, 'cheap');
});

// ─── W2-8h chatTier 档位隔离与 tier 标注源 ───

test('W2-8h: chatTier 档位隔离 —— cheap 链不碰主力，主力链不碰便宜；档内 failover 照切', async () => {
  const primary = fakeBrain('glm-pro', [{ ok: true }]);
  const cheapA = fakeBrain('flash-a', [{ ok: false, error: 'a 挂' }], { tier: 'cheap' });
  const cheapB = fakeBrain('flash-b', [{ ok: true, text: 'b 便宜脑' }], { tier: 'cheap' });
  const pool = new ProviderPool([primary, cheapA, cheapB]);
  assert.deepEqual(pool.tierRoster(), [
    { id: 'glm-pro', tier: 'primary' },
    { id: 'flash-a', tier: 'cheap' },
    { id: 'flash-b', tier: 'cheap' },
  ]);
  const viaCheap = await pool.chatTier(req(), 'cheap');
  assert.equal(viaCheap.ok, true);
  assert.equal(viaCheap.providerId, 'flash-b', '档内 failover：a 败 b 补位');
  assert.equal(primary.calls, 0, 'cheap 链不碰主力');
  const viaPrimary = await pool.chatTier(req(), 'primary');
  assert.equal(viaPrimary.providerId, 'glm-pro');
  assert.equal(cheapA.calls + cheapB.calls, 2, '主力链只碰主力');
});

test('W2-8h: tier 标注源 —— options.tiers 覆盖 > provider.tier 自报 > 缺省主力', () => {
  const selfCheap = fakeBrain('a', [{ ok: true }], { tier: 'cheap' });
  const plain = fakeBrain('b', [{ ok: true }]);
  // 自报生效
  assert.deepEqual(new ProviderPool([selfCheap, plain]).tierRoster(), [
    { id: 'a', tier: 'cheap' },
    { id: 'b', tier: 'primary' },
  ]);
  // options.tiers 把无自报者提为 cheap
  assert.deepEqual(
    new ProviderPool([plain], { tiers: { b: 'cheap' } }).tierRoster(),
    [{ id: 'b', tier: 'cheap' }],
  );
  // options.tiers 显式压回主力（覆盖自报）
  assert.deepEqual(
    new ProviderPool([selfCheap], { tiers: { a: 'primary' } }).tierRoster(),
    [{ id: 'a', tier: 'primary' }],
  );
  // 未知 id 的标注被忽略；脏 tier 自报值归主力
  const dirty = fakeBrain('c', [{ ok: true }]);
  (dirty as unknown as { tier: string }).tier = 'expensive';
  assert.deepEqual(
    new ProviderPool([dirty], { tiers: { nobody: 'cheap' } }).tierRoster(),
    [{ id: 'c', tier: 'primary' }],
  );
});

test('W2-8h: chatTier 对空档回合成 degraded（不抛）；脏 tier 入参归 primary 档', async () => {
  const a = fakeBrain('a', [{ ok: true, text: '主力' }]);
  const pool = new ProviderPool([a]);
  const r = await pool.chatTier(req(), 'cheap');
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
  assert.equal(r.error, 'no provider available');
  assert.equal(r.providerId, 'pool');
  assert.equal(a.calls, 0);
  const dirty = await pool.chatTier(req(), 'bogus' as never);
  assert.equal(dirty.ok, true, '脏 tier 归 primary 档 ⇒ 走到 a');
});

// ─── W2-8i glmClient 级联咨询面（缺省零行为变化） ───

/** 假 fetch：计数并回 OpenAI 形状成功响应 */
function fakeFetchFactory(): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (async (_url: unknown, _init?: unknown): Promise<Response> => {
    calls++;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"answer":42}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

test('W2-8i: 未接线级联面 ⇒ chatJson 行为与原路径逐字节一致（零行为变化律）', async () => {
  try {
    const { fetchImpl, calls } = fakeFetchFactory();
    const client = new GlmClient({ apiKey: 'k', model: 'm', fetchImpl });
    attachCascadeFace(null);
    const r = await client.chatJson<{ answer: number }>(req());
    assert.equal(r.ok, true);
    assert.equal(r.value!.answer, 42);
    assert.equal(calls(), 1, '自身路径恰一调');
  } finally {
    attachCascadeFace(null);
  }
});

test('W2-8i: 级联面弃权（null）⇒ 主路径照走；承接 ⇒ 直传级联值且自身零 fetch', async () => {
  try {
    const { fetchImpl, calls } = fakeFetchFactory();
    const client = new GlmClient({ apiKey: 'k', model: 'm', fetchImpl });
    let seenPrompt = '';
    // 弃权面：返回 null ⇒ 主路径照走
    attachCascadeFace({
      consultJson: async r => {
        seenPrompt = r.prompt;
        return null;
      },
    });
    const r1 = await client.chatJson<{ answer: number }>(req({ prompt: '第一问' }));
    assert.equal(seenPrompt, '第一问', '咨询面收到原请求');
    assert.equal(r1.ok, true);
    assert.equal(r1.value!.answer, 42, '弃权 ⇒ 自身路径结果');
    assert.equal(calls(), 1);
    // 承接面：返回级联值 ⇒ 直传，自身零 fetch
    attachCascadeFace({
      consultJson: async () => ({ ok: true, value: { answer: 7 }, raw: '{"answer":7}' }),
    });
    const r2 = await client.chatJson<{ answer: number }>(req());
    assert.equal(r2.ok, true);
    assert.equal(r2.value!.answer, 7, '级联承接值');
    assert.equal(r2.raw, '{"answer":7}');
    assert.equal(calls(), 1, '承接 ⇒ 自身零新增 fetch');
    // 承接失败：ok:false ⇒ 诚实失败透传（不再走自身路径）
    attachCascadeFace({
      consultJson: async () => ({ ok: false, error: 'cascade escalation failed', raw: '' }),
    });
    const r3 = await client.chatJson(req());
    assert.equal(r3.ok, false);
    assert.equal(r3.error, 'cascade escalation failed');
    assert.equal(calls(), 1, '失败承接也零自身 fetch');
  } finally {
    attachCascadeFace(null);
  }
});

test('W2-8i: 敌意级联面（抛错/垃圾/ok 无值）⇒ 全部安全弃权走主路径', async () => {
  try {
    const { fetchImpl, calls } = fakeFetchFactory();
    const client = new GlmClient({ apiKey: 'k', model: 'm', fetchImpl });
    // 抛错面
    attachCascadeFace({
      consultJson: async () => {
        throw new Error('面内爆');
      },
    });
    const r1 = await client.chatJson<{ answer: number }>(req());
    assert.equal(r1.ok, true);
    assert.equal(r1.value!.answer, 42);
    // 垃圾面（无 consultJson 函数 ⇒ 注入即静默归 null）
    attachCascadeFace({} as never);
    const r2 = await client.chatJson<{ answer: number }>(req());
    assert.equal(r2.ok, true);
    // ok:true 却无值且 raw 剥不出 JSON ⇒ 弃权
    attachCascadeFace({
      consultJson: async () => ({ ok: true, raw: 'not json at all' } as never),
    });
    const r3 = await client.chatJson<{ answer: number }>(req());
    assert.equal(r3.ok, true);
    assert.equal(r3.value!.answer, 42, '兜底走主路径');
    // ok:true 无值但 raw 可剥壳 ⇒ 剥壳补值
    attachCascadeFace({
      consultJson: async () => ({ ok: true, raw: '{"answer":9}' } as never),
    });
    const r4 = await client.chatJson<{ answer: number }>(req());
    assert.equal(r4.ok, true);
    assert.equal(r4.value!.answer, 9);
    assert.equal(calls(), 3, '主路径恰三次（其余全被级联/弃权分流）');
  } finally {
    attachCascadeFace(null);
  }
});

test('W2-8i: VlmCascade 经 glmClient 面全链贯通 —— 便宜过检直采/接线态因子源', async () => {
  try {
    const { fetchImpl: singletonFetch, calls: singletonCalls } = fakeFetchFactory();
    const client = new GlmClient({ apiKey: 'k', model: 'm', fetchImpl: singletonFetch });
    // 真池真级联（假脑）：主力在池内、便宜档过检；因子经接线态因子源供给
    // （glmClient 面桥接无法携带 perCall 因子 —— 桥接场景的法定因子通道）
    const primary = fakeBrain('glm-pro', [{ ok: true, text: '{"answer":1}' }]);
    const cheap = fakeBrain('glm-flash', [{ ok: true, text: '{"answer":7}' }], { tier: 'cheap' });
    const cascade = new VlmCascade(new ProviderPool([primary, cheap]), {
      validators: [schemaValidator({ answer: 'number' })],
      factors: () => EASY_FACTORS,
    });
    attachCascadeFace({ consultJson: r => cascade.runJson(r) });
    const r = await client.chatJson<{ answer: number }>(req());
    assert.equal(r.ok, true);
    assert.equal(r.value!.answer, 7, '便宜档过 schema 校验 ⇒ 直采');
    assert.equal(singletonCalls(), 0, '单例自身零 fetch（级联承接）');
    assert.equal(cascade.stats.cheapHit, 1);
    assert.equal(cascade.stats.savingsRate, 0.75, '缺省价格下的节省率');

    // 接线态因子源回脏值（undefined）⇒ 弃权走主路径
    const cascadeNoFactors = new VlmCascade(new ProviderPool([primary, cheap]), {
      validators: [schemaValidator({ answer: 'number' })],
      factors: () => undefined,
    });
    attachCascadeFace({ consultJson: r2 => cascadeNoFactors.runJson(r2) });
    const r2 = await client.chatJson<{ answer: number }>(req());
    assert.equal(r2.value!.answer, 42, '因子源无产出 ⇒ 弃权 ⇒ 主路径结果');
  } finally {
    attachCascadeFace(null);
  }
});
