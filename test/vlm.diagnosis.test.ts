// test/vlm.diagnosis.test.ts
// 纪元 Ω（Ω-8 · 失败会诊）：diagnosis 全本地验证 —— 假 client 注入，绝不联网。
// 覆盖：未配置降级（零网络）、正常解析（rootCause/hypotheses 重归一化降序/recovery/confidence 夹取、
// prompt 现场透传）、normalizeHypotheses 纯函数数值（和≠1 重归一化、夹取、降序、空列表、全零均匀）、
// 载荷消毒（recovery 空串过滤/非字符串丢弃/超 5 条截断/60 字硬截断、hypotheses 脏条目丢弃、
// 超 5 条截断后重归一化）、带 screenshot 路径（真实编码管线）、截图编码失败降级、
// chatJson 失败/抛错降级、lastAnchor 循环引用与不可序列化防护、坏载荷诚实报错。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetGlmClient, type GlmClient as GlmClientLike } from '../src/vlm/glmClient.ts';

const { diagnoseFailure, normalizeHypotheses } = await import('../src/vlm/diagnosis.ts');
const { default: sharp } = await import('sharp');

// ─── 假件工坊（与 test/vlm.vlmOcr.test.ts 同款先例） ───

/** 假 chatJson 响应 —— 与 GlmClient.chatJson 契约同构（value = extractGlmJson 之后的解析值） */
interface ChatJsonResp { ok: boolean; value?: unknown; error?: string; raw: string }

/** diagnosis 实际下发的请求形态（只依赖 prompt/images/system） */
interface CapturedCall {
  prompt: string;
  images: Array<{ base64: string; mime?: string }>;
  system?: unknown;
}

/** 注入用假 client —— 只实现 diagnosis 消费的 chatJson，并捕获每次请求 */
function fakeClient(
  respond: (call: CapturedCall) => ChatJsonResp | Promise<ChatJsonResp>,
): { client: GlmClientLike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const stub = {
    chatJson: async (req: { prompt?: unknown; images?: unknown; system?: unknown }): Promise<ChatJsonResp> => {
      const call: CapturedCall = {
        prompt: typeof req.prompt === 'string' ? req.prompt : '',
        images: Array.isArray(req.images) ? (req.images as CapturedCall['images']) : [],
        system: req.system,
      };
      calls.push(call);
      return respond(call);
    },
  };
  return { client: stub as unknown as GlmClientLike, calls };
}

/** sharp 现场生成纯色测试 PNG（内容不重要 —— 假 client 不看像素，只走真实编码管线） */
async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer();
}

/** 浮点近似（归一化保留 6 位小数，容差放宽到 2e-6·条数级别） */
const approx = (a: number, b: number, eps = 5e-6): boolean => Math.abs(a - b) <= eps;
const sumOf = (hs: Array<{ probability: number }>): number =>
  hs.reduce((s, h) => s + h.probability, 0);

// ─── Ω-8a 未配置降级（零网络） ───

test('Ω-8a: 未配置且未注入 client ⇒ 零网络降级（ok:false + degraded:true，空壳诊单 + error）', async () => {
  const keys = ['GLM_API_KEY', 'ZHIPUAI_API_KEY', 'ZAI_API_KEY'] as const;
  const saved = keys.map(k => [k, process.env[k]] as const);
  try {
    for (const k of keys) delete process.env[k];
    resetGlmClient(); // 清掉可能的已配置单例，保证 isGlmConfigured 走环境变量重探测

    const r = await diagnoseFailure({ task: '打开设置面板', lastError: 'click missed' });
    assert.equal(r.ok, false);
    assert.equal(r.degraded, true);
    assert.equal(r.rootCause, '');
    assert.deepEqual(r.hypotheses, []);
    assert.deepEqual(r.recovery, []);
    assert.equal(r.confidence, 0);
    assert.ok(r.error, 'error 必有失败原因');
    assert.match(r.error ?? '', /not configured/);
    assert.ok(Number.isFinite(r.latencyMs) && r.latencyMs >= 0);
  } finally {
    for (const [k, v] of saved) { if (v !== undefined) process.env[k] = v; }
    resetGlmClient();
  }
});

// ─── Ω-8b 正常解析与现场透传 ───

test('Ω-8b: 正常会诊 —— hypotheses 和≠1 重归一化、recovery 透传、confidence 夹 [0,1]、prompt 携带全部现场', async () => {
  const { client, calls } = fakeClient(() => ({
    ok: true, raw: '',
    value: {
      rootCause: ' 保存按钮被确认对话框遮挡 ',
      hypotheses: [
        { cause: '对话框未关闭', probability: 0.7 },
        { cause: '按钮坐标漂移', probability: 0.7 }, // 和 1.4 → 各 0.5
      ],
      recovery: ['关闭对话框后重试', '用键盘 Enter 确认'],
      confidence: 1.4, // 夹到上界 1
    },
  }));
  const r = await diagnoseFailure({
    task: '在编辑器中保存文件',
    recentActions: [
      { action: 'click', detail: '保存按钮 (300,400)', outcome: 'no effect' },
      { action: 'type', detail: 'Ctrl+S', outcome: 'ignored' },
    ],
    lastAnchor: { window: 'Editor', focused: 'untitled.txt' },
    lastError: 'action had no visible effect',
    screenText: '未保存的更改 是否保存?',
  }, { client });

  assert.equal(r.ok, true);
  assert.equal(r.degraded, false);
  assert.equal(r.error, undefined);
  assert.equal(r.rootCause, '保存按钮被确认对话框遮挡'); // 去首尾空白
  assert.equal(r.hypotheses.length, 2);
  assert.ok(approx(r.hypotheses[0].probability, 0.5), '0.7/1.4 → 0.5');
  assert.ok(approx(r.hypotheses[1].probability, 0.5));
  assert.ok(approx(sumOf(r.hypotheses), 1), '重归一化后和≈1');
  assert.deepEqual(r.recovery, ['关闭对话框后重试', '用键盘 Enter 确认']);
  assert.equal(r.confidence, 1); // 1.4 夹到上界
  assert.ok(r.latencyMs >= 0);

  // 请求形态：单次、纯文本会诊（无截图 ⇒ images 空数组，协议合法）、铁律提示词透传
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].images, []);
  const p = calls[0].prompt;
  assert.ok(p.includes('在编辑器中保存文件'), '任务透传');
  assert.ok(p.includes('保存按钮 (300,400)'), '动作明细透传');
  assert.ok(p.includes('Ctrl+S'));
  assert.ok(p.includes('"window":"Editor"'), '锚点序列化透传');
  assert.ok(p.includes('action had no visible effect'), '错误透传');
  assert.ok(p.includes('未保存的更改'), '屏幕文本透传');
  assert.ok(p.includes('hypotheses'), '输出结构指令透传');
  assert.ok(typeof calls[0].system === 'string' && calls[0].system.length > 0, 'system 角色设定随请求下发');
});

// ─── Ω-8c normalizeHypotheses 纯函数数值 ───

test('Ω-8c: normalizeHypotheses —— 夹 [0,1]、和≠1 重归一化、降序稳定、空列表恒等', () => {
  // 空列表 / 空输入恒等
  assert.deepEqual(normalizeHypotheses([]), []);

  // 和 1.4 ≠ 1 → 各 0.5（同概率保持输入原序）
  assert.deepEqual(
    normalizeHypotheses([{ cause: 'a', probability: 0.7 }, { cause: 'b', probability: 0.7 }]),
    [{ cause: 'a', probability: 0.5 }, { cause: 'b', probability: 0.5 }],
  );

  // 夹取先于归一化：-0.5 压 0、1.5 压 1 → 和恰为 1；再按概率降序
  assert.deepEqual(
    normalizeHypotheses([{ cause: 'a', probability: -0.5 }, { cause: 'b', probability: 1.5 }]),
    [{ cause: 'b', probability: 1 }, { cause: 'a', probability: 0 }],
  );

  // 降序：0.8/0.2 原样（和已为 1，重归一化不动值）
  const sorted = normalizeHypotheses([{ cause: 'low', probability: 0.2 }, { cause: 'hi', probability: 0.8 }]);
  assert.deepEqual(sorted.map(h => h.cause), ['hi', 'low']);
  assert.ok(approx(sorted[0].probability, 0.8));
  assert.ok(approx(sorted[1].probability, 0.2));

  // 全零和 ⇒ 最大熵均匀分配（分布不变量「和≈1」优先），仍降序稳定
  const uniform = normalizeHypotheses([
    { cause: 'x', probability: 0 }, { cause: 'y', probability: 0 }, { cause: 'z', probability: 0 },
  ]);
  assert.deepEqual(uniform.map(h => h.cause), ['x', 'y', 'z']);
  for (const h of uniform) assert.ok(approx(h.probability, 1 / 3));
  assert.ok(approx(sumOf(uniform), 1));

  // 运行时脏输入防御（类型之外的垃圾）：非对象/空 cause/非有限概率丢弃，绝不抛
  const junk = normalizeHypotheses([
    { cause: 'ok', probability: 0.5 },
    null, 'junk',
    { cause: '   ', probability: 0.5 },
    { probability: 0.5 },
    { cause: 'nan', probability: Number.NaN },
  ] as unknown as Array<{ cause: string; probability: number }>);
  assert.deepEqual(junk, [{ cause: 'ok', probability: 1 }]); // 幸存者独占全部概率质量
});

// ─── Ω-8d 载荷消毒：recovery 过滤律与 hypotheses 脏条目丢弃 ───

test('Ω-8d: recovery 消毒 —— 空串/纯空白过滤、非字符串丢弃、超 5 条截断、每条 60 字硬截断', async () => {
  const longStep = '等'.repeat(100); // 100 字步骤 → 码点硬截断到 60
  const { client } = fakeClient(() => ({
    ok: true, raw: '',
    value: {
      rootCause: '加载超时',
      hypotheses: [{ cause: '网络', probability: 1 }],
      recovery: [longStep, '', '   ', '重启应用', 42, null, '检查网络后重试', 's4', 's5', 's6', 's7'],
      confidence: 0.5,
    },
  }));
  const r = await diagnoseFailure({ task: 't' }, { client });
  assert.equal(r.ok, true);
  // 有效步骤 7 条（longStep/重启应用/检查网络/ s4 s5 s6 s7）→ 截前 5；空串与 42/null 早已出局
  assert.deepEqual(r.recovery, ['等'.repeat(60), '重启应用', '检查网络后重试', 's4', 's5']);
  assert.equal(Array.from(r.recovery[0]).length, 60, '每条步骤 ≤60 字（码点截断，中文不切半）');
  // 单条假设独占概率质量（和≈1 不变量）
  assert.deepEqual(r.hypotheses, [{ cause: '网络', probability: 1 }]);
});

test('Ω-8d: hypotheses 脏条目丢弃 —— 空白 cause/非字符串 cause/非有限概率不毒化整批', async () => {
  const { client } = fakeClient(() => ({
    ok: true, raw: '',
    value: {
      rootCause: '复合故障',
      hypotheses: [
        { cause: '  弹窗遮挡  ', probability: '0.6' },   // 数字串概率方言 + cause 去空白
        { cause: '   ', probability: 0.2 },               // 纯空白 cause → 弃
        { cause: 42, probability: 0.1 },                  // 非字符串 cause → 弃
        { probability: 0.1 },                             // cause 缺席 → 弃
        'junk', null,                                     // 非对象元素 → 弃
        { cause: '概率残缺' },                            // probability 缺席 → 弃
      ],
      recovery: [],
      confidence: 'abc',                                  // 非法置信度 → 压 0
    },
  }));
  const r = await diagnoseFailure({ task: 't' }, { client });
  assert.equal(r.ok, true);
  assert.deepEqual(r.hypotheses, [{ cause: '弹窗遮挡', probability: 1 }]);
  assert.deepEqual(r.recovery, []);
  assert.equal(r.confidence, 0, 'NaN 置信度压 0，永不 NaN');
});

// ─── Ω-8e 带 screenshot 路径（真实编码管线） ───

test('Ω-8e: 带 screenshot —— 现场截图经真实编码管线随请求下发，prompt 注明附图', async () => {
  const { client, calls } = fakeClient(() => ({
    ok: true, raw: '',
    value: {
      rootCause: '确认弹窗遮挡目标',
      hypotheses: [
        { cause: '弹窗未关闭', probability: 0.6 },
        { cause: '按钮坐标漂移', probability: 0.4 },
      ],
      recovery: ['关闭弹窗后重试'],
      confidence: 0.8,
    },
  }));
  const r = await diagnoseFailure(
    { task: '点击保存', lastError: 'timeout' },
    { screenshot: await makePng(96, 64), client },
  );
  assert.equal(r.ok, true);
  assert.equal(r.degraded, false);
  assert.ok(approx(sumOf(r.hypotheses), 1), '0.6+0.4 和已为 1 → 原样');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].images.length, 1, '请求恰好携带一张现场截图');
  assert.ok(calls[0].images[0].base64.length > 100, '真实编码后的 base64 应非空');
  assert.equal(calls[0].images[0].mime, 'image/jpeg');
  const meta = await sharp(Buffer.from(calls[0].images[0].base64, 'base64')).metadata();
  assert.equal(meta.width, 96);  // 小图不缩放（长边 < 1568），仅转码 JPEG
  assert.equal(meta.height, 64);
  assert.ok(calls[0].prompt.includes('已附带当前屏幕截图'), '现场记录注明附图（规则 4 锚点）');
});

test('Ω-8e: 截图编码失败 ⇒ 诚实降级（不静默降级为纯文本会诊，不发请求）', async () => {
  const { client, calls } = fakeClient(() => ({
    ok: true, raw: '',
    value: { rootCause: 'x', hypotheses: [], recovery: [], confidence: 0.5 },
  }));
  const r = await diagnoseFailure({ task: 't' }, { screenshot: Buffer.alloc(0), client });
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
  assert.equal(r.rootCause, '');
  assert.match(r.error ?? '', /encode/);
  assert.equal(calls.length, 0, '编码失败应在下发前被拒，不触云脑');
});

// ─── Ω-8f chatJson 失败降级 ───

test('Ω-8f: chatJson 失败 ⇒ 降级（error 透传）；注入 client 抛错同样降级，绝不越狱上抛', async () => {
  const fail = fakeClient(() => ({ ok: false, error: 'mock glm outage', raw: 'no-json' }));
  const r = await diagnoseFailure({ task: 't' }, { client: fail.client });
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
  assert.equal(r.rootCause, '');
  assert.deepEqual(r.hypotheses, []);
  assert.deepEqual(r.recovery, []);
  assert.equal(r.confidence, 0);
  assert.match(r.error ?? '', /mock glm outage/);
  assert.ok(r.latencyMs >= 0);

  const throwing = {
    chatJson: async (): Promise<never> => { throw new Error('injected boom'); },
  };
  const r2 = await diagnoseFailure({ task: 't' }, { client: throwing as unknown as GlmClientLike });
  assert.equal(r2.ok, false);
  assert.equal(r2.degraded, true);
  assert.match(r2.error ?? '', /injected boom/);
});

// ─── Ω-8g lastAnchor 循环引用防护（safeStringify） ───

test('Ω-8g: lastAnchor 循环引用不炸 —— [Circular] 防护，会诊照常成功；不可序列化兜底 [unserializable]', async () => {
  const { client, calls } = fakeClient(() => ({
    ok: true, raw: '',
    value: {
      rootCause: '状态锚点过期',
      hypotheses: [{ cause: '锚点与实际窗口脱节', probability: 1 }],
      recovery: ['重建状态锚点'],
      confidence: 0.7,
    },
  }));
  const anchor: { window: string; props: { scale: number; parent?: unknown }; self?: unknown } = {
    window: 'Editor', props: { scale: 1.25 },
  };
  anchor.self = anchor;        // 自引用循环
  anchor.props.parent = anchor; // 二重循环

  const r = await diagnoseFailure({ task: 't', lastAnchor: anchor }, { client });
  assert.equal(r.ok, true);
  assert.equal(r.degraded, false);
  assert.ok(calls[0].prompt.includes('[Circular]'), '回边以 [Circular] 截断，JSON.stringify 不炸');
  assert.ok(calls[0].prompt.includes('Editor'), '非循环字段照常序列化');

  // BigInt 令 JSON.stringify 抛 TypeError ⇒ 兜底 '[unserializable]'
  const r2 = await diagnoseFailure({ task: 't', lastAnchor: { big: 10n } }, { client });
  assert.equal(r2.ok, true);
  assert.ok(calls[1].prompt.includes('[unserializable]'));
});

// ─── Ω-8h hypotheses 超 5 条截断 ───

test('Ω-8h: hypotheses 超 5 条截断 —— 取归一化后概率最高的前 5，幸存者重归一化保和≈1', async () => {
  const { client } = fakeClient(() => ({
    ok: true, raw: '',
    value: {
      rootCause: '复合故障',
      hypotheses: [
        { cause: 'c1', probability: 0.3 },
        { cause: 'c2', probability: 0.25 },
        { cause: 'c3', probability: 0.2 },
        { cause: 'c4', probability: 0.15 },
        { cause: 'c5', probability: 0.05 },
        { cause: 'c6', probability: 0.03 },
        { cause: 'c7', probability: 0.02 },
      ],
      recovery: ['逐步排除'],
      confidence: 0.4,
    },
  }));
  const r = await diagnoseFailure({ task: 't' }, { client });
  assert.equal(r.ok, true);
  assert.equal(r.hypotheses.length, 5);
  assert.deepEqual(r.hypotheses.map(h => h.cause), ['c1', 'c2', 'c3', 'c4', 'c5']);
  // 截断丢掉 0.05 的质量 → 幸存者（和 0.95）重归一化，和≈1 不变量保住
  assert.ok(approx(sumOf(r.hypotheses), 1));
  for (let i = 1; i < r.hypotheses.length; i++) {
    assert.ok(r.hypotheses[i - 1].probability >= r.hypotheses[i].probability, '降序不变量');
  }
  assert.deepEqual(r.recovery, ['逐步排除']);
});

// ─── Ω-8i 坏载荷诚实报错 ───

test('Ω-8i: 载荷残缺 —— rootCause 缺失/非字符串/空白 ⇒ ok:false 且 degraded:false（云路走通但无诊单）', async () => {
  const missing = fakeClient(() => ({ ok: true, raw: '', value: { hypotheses: [], recovery: [] } }));
  const r1 = await diagnoseFailure({ task: 't' }, { client: missing.client });
  assert.equal(r1.ok, false);
  assert.equal(r1.degraded, false);
  assert.equal(r1.rootCause, '');
  assert.match(r1.error ?? '', /rootCause/);

  const nonString = fakeClient(() => ({ ok: true, raw: '', value: { rootCause: 42 } }));
  const r2 = await diagnoseFailure({ task: 't' }, { client: nonString.client });
  assert.equal(r2.ok, false);
  assert.equal(r2.degraded, false);
  assert.match(r2.error ?? '', /rootCause/);

  const blank = fakeClient(() => ({ ok: true, raw: '', value: { rootCause: '   ', recovery: ['x'] } }));
  const r3 = await diagnoseFailure({ task: 't' }, { client: blank.client });
  assert.equal(r3.ok, false);
  assert.equal(r3.rootCause, '');

  const nonObject = fakeClient(() => ({ ok: true, raw: '', value: 'junk' }));
  const r4 = await diagnoseFailure({ task: 't' }, { client: nonObject.client });
  assert.equal(r4.ok, false);
  assert.equal(r4.degraded, false);
});

test('Ω-8i: 字段缺席容忍 —— hypotheses/recovery 缺席为空数组（ok:true 宁可空不可错），置信度压 0', async () => {
  const { client } = fakeClient(() => ({ ok: true, raw: '', value: { rootCause: '仅根因可判定' } }));
  const r = await diagnoseFailure({}, { client });
  assert.equal(r.ok, true);
  assert.equal(r.degraded, false);
  assert.equal(r.rootCause, '仅根因可判定');
  assert.deepEqual(r.hypotheses, []);
  assert.deepEqual(r.recovery, []);
  assert.equal(r.confidence, 0);
  assert.ok(Number.isFinite(r.latencyMs) && r.latencyMs >= 0);
});
