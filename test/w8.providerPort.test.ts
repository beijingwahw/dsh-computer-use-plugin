// test/w8.providerPort.test.ts
// W8-A6（DEBTS D-G3 + VLM 架构债）：多供应商直用面打通的执法册。
// 覆盖：
//   1. D-G3：VisionProvider.baseUrl 只读暴露（假 provider 断言 + openai 族真适配器
//      —— 同平台不同端点可判别）与 registry.effectiveBaseUrl 三级回退；
//   2. 脱敏：maskBaseUrl —— host 保留（含端口），路径/查询/userinfo 凭据段一律
//      打码（打码纪律执法，脏值安静）；
//   3. 依赖倒置：grounding / vlmOcr / verdict 以**非 GlmClient** 的假端口实例
//      （StructuredVisionPort 直铸，不经 GlmClient 强转）完成调用链 —— 注入假
//      chatJson 捕获参数与返回解析；
//   4. 直用面：openai 族 VisionProvider（假 fetch，零联网）直接作为三器官的
//      client —— 多供应商不经 glmClient 委托壳；
//   5. GlmClient 结构兼容端口（类型级 + 运行时冒烟）。
// 铁律：**零联网** —— 一切云端经假端口/假 fetch 注入；图像走 sharp 现场生成
// 的真 PNG 过 codec 真实编码管线（不 mock 几何上游）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { GlmClient } from '../src/vlm/glmClient.ts';
import type {
  ProviderProtocol,
  StructuredVisionPort,
  VisionChatRequest,
  VisionJsonReply,
  VisionProvider,
} from '../src/vlm/providers/types.ts';

const vpt = await import('../src/vlm/providers/types.ts');
const { default: sharp } = await import('sharp');

// ─── 编译期形状锁（错字/缺失在此即编译失败） ───

// D-G3：VisionProvider 携带只读 baseUrl（可选 —— 未回填的适配器合法缺席）
const _providerWithUrl: VisionProvider = {
  id: 'w8fake', protocol: 'openai' as ProviderProtocol, model: 'm', configured: true,
  baseUrl: 'https://api.example.com/v1',
  chat: async (req: VisionChatRequest) => ({
    ok: true, text: req.prompt, latencyMs: 1, model: 'm', providerId: 'w8fake',
  }),
  chatJson: async <T,>(req: VisionChatRequest): Promise<VisionJsonReply<T>> =>
    ({ ok: true, value: req.prompt as unknown as T, raw: req.prompt }),
};
// 端口最小面：configured + chatJson 两件即成 —— 假端口无需 GlmClient 全副武装
const _barePort: StructuredVisionPort = {
  configured: true,
  chatJson: async <T,>(req: VisionChatRequest): Promise<VisionJsonReply<T>> =>
    ({ ok: true, raw: req.prompt }),
};
// GlmClient 结构满足端口（依赖倒置零改动的编译期证明）
const _glmAsPort: (c: GlmClient) => StructuredVisionPort = c => c;
// VisionProvider 结构满足端口（备选池/合议庭直用面的编译期证明）
const _providerAsPort: (p: VisionProvider) => StructuredVisionPort = p => p;
void _providerWithUrl; void _barePort; void _glmAsPort; void _providerAsPort;

// ─── 假件工坊（零网络） ───

/** 假端口工坊：只铸端口最小面，捕获每次请求并回放预设回执 */
function fakePort(
  respond: (req: VisionChatRequest) => VisionJsonReply<unknown> | Promise<VisionJsonReply<unknown>>,
  configured = true,
): { port: StructuredVisionPort; calls: VisionChatRequest[] } {
  const calls: VisionChatRequest[] = [];
  const port: StructuredVisionPort = {
    configured,
    chatJson: async <T,>(req: VisionChatRequest): Promise<VisionJsonReply<T>> => {
      calls.push(req);
      return respond(req) as VisionJsonReply<T>;
    },
  };
  return { port, calls };
}

/** sharp 现场生成纯色 PNG（真图 Buffer —— codec 真实编码管线的最低门票） */
async function makePng(width = 200, height = 150): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 96, g: 96, b: 96 } },
  }).png().toBuffer();
}

/** openai 族假脑回执体（choices[0].message.content = 指定 JSON 串） */
function openAiBody(content: string): string {
  return JSON.stringify({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}

/** 铸一颗 openai 族备选脑（VisionProvider + 假 fetch 记账，零联网） */
async function altBrain(content: string): Promise<{
  brain: VisionProvider; urls: string[];
}> {
  const { createOpenAiProvider } = await import('../src/vlm/providers/openai.ts');
  const urls: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    urls.push(String(url));
    return new Response(openAiBody(content), { status: 200 });
  }) as typeof fetch;
  const brain = createOpenAiProvider({
    id: 'w8alt',
    apiKey: 'sk-w8alt-000111222',
    baseUrl: 'https://alt-brain.example.com/v1',
    model: 'alt-vl-1',
    fetchImpl,
  });
  return { brain, urls };
}

// ─── D-G3：baseUrl 只读暴露 ───

test('W8-A6a: 假 provider 的 baseUrl 只读暴露 —— 值原样可读（端点判别面）', () => {
  const p = _providerWithUrl;
  assert.equal(p.baseUrl, 'https://api.example.com/v1', '自报端点原样可读');
  // 缺席合法（可选字段 —— 未回填的适配器不臆造端点）
  const bare: VisionProvider = {
    id: 'bare', protocol: 'gemini' as ProviderProtocol, model: 'm', configured: false,
    chat: async () => ({ ok: false, text: '', latencyMs: 0, model: 'm', providerId: 'bare' }),
    chatJson: async () => ({ ok: false, error: 'x', raw: '' }),
  };
  assert.equal(bare.baseUrl, undefined);
});

test('W8-A6b: openai 族适配器自报 baseUrl —— 同平台不同端点可判别（剔同源脑的依据）', async () => {
  const { createOpenAiProvider } = await import('../src/vlm/providers/openai.ts');
  const a = createOpenAiProvider({
    id: 'qwen', apiKey: 'sk-test-000001', baseUrl: 'https://dashscope-a.example.com/compatible-mode/v1',
  });
  const b = createOpenAiProvider({
    id: 'qwen', apiKey: 'sk-test-000002', baseUrl: 'https://dashscope-b.example.com/compatible-mode/v1',
  });
  assert.equal(a.baseUrl, 'https://dashscope-a.example.com/compatible-mode/v1');
  assert.equal(b.baseUrl, 'https://dashscope-b.example.com/compatible-mode/v1');
  assert.notEqual(a.baseUrl, b.baseUrl, '同平台不同端点 —— 反驳法院剔同源脑时就靠它');
  // 尾斜杠归一（适配器工厂纪律）：'…/v1/' 与 '…/v1' 同一归宿
  const c = createOpenAiProvider({ apiKey: 'sk-test-000003', baseUrl: 'https://x.example.com/v1/' });
  assert.equal(c.baseUrl, 'https://x.example.com/v1');
  // 缺省端点也在场（openai 官方云）
  const d = createOpenAiProvider({ apiKey: 'sk-test-000004' });
  assert.equal(d.baseUrl, 'https://api.openai.com/v1');
});

test('W8-A6b2: anthropic / gemini 适配器自报 baseUrl —— 同平台不同端点可判别（W8-A6 遗留回填闭账）', async () => {
  // 环境隔离：anthropic 的解析链含 env ANTHROPIC_BASE_URL（自报 > env > 预设 > 官方云）
  // —— 清空后断言确定性（跑机器可能带本地网关配置）
  const savedEnvBase = process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_BASE_URL;
  try {
    const { createAnthropicProvider } = await import('../src/vlm/providers/anthropic.ts');
    const a = createAnthropicProvider({ apiKey: 'sk-ant-000111', baseUrl: 'https://gw-a.example.com' });
    const b = createAnthropicProvider({ apiKey: 'sk-ant-000112', baseUrl: 'https://gw-b.example.com/' });
    assert.equal(a.baseUrl, 'https://gw-a.example.com', '自报端点原样可读');
    assert.equal(b.baseUrl, 'https://gw-b.example.com', '尾斜杠归一（工厂纪律）');
    assert.notEqual(a.baseUrl, b.baseUrl, '同平台不同端点 —— 反驳法院剔同源脑时就靠它');
    // 平台预设缺省臂（glmClient.castDelegate 传 defaultBaseUrl 的形态）
    assert.equal(
      createAnthropicProvider({ defaultBaseUrl: 'https://proxy.example.com/anthropic' }).baseUrl,
      'https://proxy.example.com/anthropic',
      '配置自报缺席 ⇒ 平台预设缺省在场',
    );
    // 内置官方云兜底
    assert.equal(createAnthropicProvider({}).baseUrl, 'https://api.anthropic.com');
  } finally {
    if (savedEnvBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = savedEnvBase;
  }

  const { createGeminiProvider } = await import('../src/vlm/providers/gemini.ts');
  const g1 = createGeminiProvider({ apiKey: 'g-key-000111', baseUrl: 'https://gw-c.example.com/v1beta' });
  const g2 = createGeminiProvider({ apiKey: 'g-key-000112', baseUrl: 'https://gw-d.example.com/v1beta/' });
  assert.equal(g1.baseUrl, 'https://gw-c.example.com/v1beta', '自报端点原样可读');
  assert.equal(g2.baseUrl, 'https://gw-d.example.com/v1beta', '尾斜杠归一');
  assert.notEqual(g1.baseUrl, g2.baseUrl, '同平台不同端点可判别');
  assert.equal(
    createGeminiProvider({ defaultBaseUrl: 'https://proxy.example.com/gemini/v1beta' }).baseUrl,
    'https://proxy.example.com/gemini/v1beta',
    '配置自报缺席 ⇒ 平台预设缺省在场',
  );
  assert.equal(
    createGeminiProvider({}).baseUrl,
    'https://generativelanguage.googleapis.com/v1beta',
    '内置官方云兜底',
  );
  // 与实际拨号端点一致（接口位承诺）：假 fetch 收网 —— URL 前缀 = 自报 baseUrl
  const urls: string[] = [];
  const dialing = createGeminiProvider({
    apiKey: 'g-key-000113', baseUrl: 'https://dial.example.com/v1beta',
    fetchImpl: (async (url: unknown) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), { status: 200 });
    }) as typeof fetch,
  });
  const r = await dialing.chat({ prompt: 'hi', images: [] });
  assert.equal(r.ok, true);
  assert.ok(urls[0]!.startsWith('https://dial.example.com/v1beta/'), '拨号打在自报端点上');
  assert.equal(dialing.baseUrl, 'https://dial.example.com/v1beta');
});

test('W8-A6c: registry.effectiveBaseUrl —— 自报优先，缺席回退平台预设，再缺安静空串', async () => {
  const { effectiveBaseUrl, getPreset } = await import('../src/vlm/providers/registry.ts');
  assert.equal(
    effectiveBaseUrl({ id: 'qwen', baseUrl: 'https://self.example.com/v1' }),
    'https://self.example.com/v1',
    '自报端点优先（同平台不同端点的判别以自报为准）',
  );
  assert.equal(effectiveBaseUrl({ id: 'qwen' }), getPreset('qwen')!.baseUrl, '缺席回退预设缺省端点');
  assert.equal(effectiveBaseUrl({ id: 'no-such-platform' }), '', '未知 id 不臆造');
  assert.equal(effectiveBaseUrl(null as unknown as { id?: string }), '', '脏入参安静空串');
});

// ─── 脱敏：maskBaseUrl（D-G3 暴露面的打码纪律） ───

test('W8-A6d: maskBaseUrl —— host（含端口）保留，路径打码为 /*** ', () => {
  assert.equal(vpt.maskBaseUrl('https://api.openai.com/v1'), 'https://api.openai.com/***');
  assert.equal(vpt.maskBaseUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/***');
  assert.equal(vpt.maskBaseUrl('https://api.anthropic.com'), 'https://api.anthropic.com/***');
  assert.equal(vpt.maskBaseUrl('  https://x.example.com/v1  '), 'https://x.example.com/***', '首尾空白容忍');
});

test('W8-A6e: maskBaseUrl —— 查询串密钥 / userinfo 凭据 / 路径端点 ID 绝不外泄', () => {
  const q = vpt.maskBaseUrl('https://gemini.example.com/v1beta?key=AIzaSyABCDEF1234567890');
  assert.ok(!q.includes('AIzaSy'), '查询串密钥不外泄');
  assert.ok(!q.includes('v1beta'), '路径不外泄');
  assert.equal(q, 'https://gemini.example.com/***');
  const u = vpt.maskBaseUrl('https://ak:sk-secret-12345678@registry.example.com/team-a/ep-2024xyz');
  assert.ok(!u.includes('sk-secret') && !u.includes('ak:'), 'userinfo 凭据不外泄');
  assert.ok(!u.includes('team-a') && !u.includes('ep-2024xyz'), '路径段（租户/端点 ID）不外泄');
  assert.equal(u, 'https://registry.example.com/***');
  // 幂等：打码结果再打码稳定（展示链多级打码不翻新）
  assert.equal(vpt.maskBaseUrl(vpt.maskBaseUrl('https://a.example.com/v1')), 'https://a.example.com/***');
});

test('W8-A6f: maskBaseUrl —— 脏值安静（不抛、不回显原文）', () => {
  assert.equal(vpt.maskBaseUrl(''), '(unknown endpoint)');
  assert.equal(vpt.maskBaseUrl('not a url at all'), '(unknown endpoint)');
  assert.equal(vpt.maskBaseUrl(undefined as unknown as string), '(unknown endpoint)');
  assert.equal(vpt.maskBaseUrl(12345 as unknown as string), '(unknown endpoint)');
  assert.equal(vpt.maskBaseUrl('localhost:11434/v1'), '(unknown endpoint)', '无 scheme 的裸 host:port 不臆测');
});

// ─── 依赖倒置：三器官直用非 GlmClient 假端口 ───

test('W8-A6g: grounding 直用假端口 —— 参数捕获与返回解析（非 GlmClient 实例）', async () => {
  const { groundElements, resetVerifyGateBudget } = await import('../src/vlm/grounding.ts');
  resetVerifyGateBudget('w8-port-grounding');
  const { port, calls } = fakePort(() => ({
    ok: true,
    raw: '{"elements":[...]}',
    value: {
      elements: [
        { id: 'A', label: '设置', role: 'button', bbox: [8, 10, 40, 30], confidence: 0.92 },
      ],
    },
  }));
  const r = await groundElements(await makePng(120, 90), {
    client: port,
    verifyGate: false,
    width: 120,
    height: 90, // 双维显式声明 ⇒ 声明系直通，bbox 断言不吃反算
    question: '找到设置入口',
  });
  assert.equal(r.ok, true, '假端口调用链走通');
  assert.equal(r.elements.length, 1);
  assert.equal(r.elements[0]!.label, '设置');
  assert.deepEqual(r.elements[0]!.bbox, { x0: 8, y0: 10, x1: 40, y1: 30 });
  assert.equal(r.elements[0]!.center.x, 24);
  // 端口捕获：单图 + 接地铁律 system + jsonMode + 聚焦问题进 prompt
  assert.equal(calls.length, 1, '恰好一次结构化对话');
  const req = calls[0]!;
  assert.equal(req.images.length, 1);
  assert.ok(req.images[0]!.base64.length > 0, '截图经真实编码管线进端口');
  assert.equal(req.jsonMode, true);
  assert.equal(req.temperature, 0.1, '接地要确定性');
  assert.equal(req.maxTokens, 2048);
  assert.ok(typeof req.system === 'string' && req.system.length > 0, '接地 system 提示词在场');
  assert.ok(req.prompt.includes('找到设置入口'), '聚焦问题进 prompt');
});

test('W8-A6h: grounding 复核闸直用假端口 —— verifyClient 收到复核流量（诚实 reground-failed）', async () => {
  const { groundElements, resetVerifyGateBudget } = await import('../src/vlm/grounding.ts');
  resetVerifyGateBudget('w8-port-verify');
  const main = fakePort(() => ({
    ok: true,
    raw: '',
    // confidence 0.4 < 0.6 ⇒ 触发复核闸
    value: { elements: [{ id: 'x', label: '目标', role: 'button', bbox: [20, 20, 80, 70], confidence: 0.4 }] },
  }));
  const verify = fakePort(() => ({ ok: false, error: 'verify port down', raw: '' }));
  const r = await groundElements(await makePng(200, 150), {
    client: main.port,
    verifyClient: verify.port,
    verifyTaskId: 'w8-port-verify',
  });
  assert.equal(r.ok, true, '复核失败放行原值 —— 主结果不受扰');
  assert.ok(r.verifyGate, '低置信触发 ⇒ 闸报告在场');
  assert.equal(r.verifyGate!.events.length, 1);
  assert.equal(r.verifyGate!.events[0]!.outcome, 'reground-failed');
  assert.equal(r.verifyGate!.budgetUsed, 1, '真实下发复核才耗预算');
  assert.equal(verify.calls.length, 1, '复核端口（非 GlmClient）真实收到一次复核 grounding');
  assert.equal(main.calls.length, 1, '主端口不受复核流量打扰');
});

test('W8-A6i: vlmOcr 直用假端口 —— readTextViaVlm 参数捕获与词表解析', async () => {
  const { readTextViaVlm } = await import('../src/vlm/vlmOcr.ts');
  const { port, calls } = fakePort(() => ({
    ok: true,
    raw: '',
    value: {
      words: [
        { text: '保存', confidence: 0.9, bbox: [10, 10, 60, 30] },
        { text: '取消', confidence: 1.4, bbox: [10, 40, 60, 60] },      // confidence 越界 ⇒ 夹 1
        { text: '   ', confidence: 0.5, bbox: [10, 70, 60, 90] },       // 纯空白词 ⇒ 弃
      ],
    },
  }));
  const r = await readTextViaVlm(await makePng(400, 300), { client: port });
  assert.equal(r.ok, true, '假端口调用链走通');
  assert.equal(r.words.length, 2, '空白词丢弃');
  assert.equal(r.words[0]!.text, '保存');
  assert.equal(r.words[0]!.center.x, 35, 'bbox 4 元数组 → 对象 → 中心');
  assert.equal(r.words[1]!.confidence, 1, 'confidence 夹 [0,1]');
  assert.ok(r.text.includes('保存') && r.text.includes('取消'), '阅读序空格连接');
  // 端口捕获
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.images.length, 1);
  assert.ok(calls[0]!.images[0]!.base64.length > 0);
  assert.ok(typeof calls[0]!.prompt === 'string' && calls[0]!.prompt.length > 0, 'OCR 铁律提示词在场');
});

test('W8-A6j: vlmOcr 直用假端口 —— findTextViaVlm 大小写/空白不敏感命中', async () => {
  const { findTextViaVlm } = await import('../src/vlm/vlmOcr.ts');
  const { port } = fakePort(() => ({
    ok: true,
    raw: '',
    value: { words: [{ text: 'Discard Changes', confidence: 0.8, bbox: [5, 5, 120, 25] }] },
  }));
  const r = await findTextViaVlm(await makePng(200, 100), '  discard  ', { client: port });
  assert.equal(r.ok, true);
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0]!.text, 'Discard Changes');
  assert.ok(r.matches[0]!.center.x > 0 && r.matches[0]!.center.y > 0, '命中中心可供点击定位');
});

test('W8-A6k: verdict 直用假端口 —— 双图按序下发与载荷规整（判决永不出错值）', async () => {
  const { judgeEffect } = await import('../src/vlm/verdict.ts');
  const { port, calls } = fakePort(() => ({
    ok: true,
    raw: '',
    value: { verdict: 'CONFIRMED', scale: 'weird', explanation: '菜单已展开', confidence: '0.75' },
  }));
  const r = await judgeEffect(await makePng(50, 40), await makePng(50, 40), '菜单展开', { client: port });
  assert.equal(r.ok, true, '假端口调用链走通');
  assert.equal(r.verdict, 'uncertain', '大小写漂移的非法枚举 ⇒ uncertain');
  assert.equal(r.scale, 'none', '非法 scale ⇒ none');
  assert.equal(r.confidence, 0.75, '数字串方言宽松转数后夹取');
  assert.equal(r.explanation, '菜单已展开');
  // 端口捕获：双图同请求 + 顺序说明钉死
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.images.length, 2, '前后双图同请求下发');
  assert.ok(calls[0]!.prompt.includes('before') && calls[0]!.prompt.includes('after'), '顺序说明钉死');
});

// ─── 直用面：openai 族 VisionProvider 直入三器官（不经 glmClient 委托壳） ───

test('W8-A6l: 备选脑（openai 族 VisionProvider + 假 fetch）直用 vlmOcr —— 零强转零壳', async () => {
  const { brain, urls } = await altBrain(JSON.stringify({
    words: [{ text: '直用端口', confidence: 0.9, bbox: [4, 4, 80, 24] }],
  }));
  const { readTextViaVlm } = await import('../src/vlm/vlmOcr.ts');
  const r = await readTextViaVlm(await makePng(160, 120), { client: brain });
  assert.equal(r.ok, true, '备选脑直用成功（VisionProvider 结构满足端口）');
  assert.equal(r.words[0]!.text, '直用端口');
  assert.equal(urls.length, 1, '恰好一次拨号');
  assert.ok(urls[0]!.startsWith('https://alt-brain.example.com/v1/'), '真打在备选脑自报端点上');
});

test('W8-A6m: 备选脑直用 grounding 与 verdict —— 多供应商直用面全线打通', async () => {
  const { groundElements, resetVerifyGateBudget } = await import('../src/vlm/grounding.ts');
  resetVerifyGateBudget('w8-direct-ground');
  const g = await altBrain(JSON.stringify({
    elements: [{ id: 'A', label: '按钮', role: 'button', bbox: [10, 10, 70, 50], confidence: 0.88 }],
  }));
  const rg = await groundElements(await makePng(120, 90), {
    client: g.brain, verifyGate: false, width: 120, height: 90,
  });
  assert.equal(rg.ok, true, 'grounding 直用备选脑成功');
  assert.equal(rg.elements[0]!.label, '按钮');
  assert.ok(g.urls[0]!.startsWith('https://alt-brain.example.com/v1/'));

  const v = await altBrain(JSON.stringify({
    verdict: 'confirmed', scale: 'element', explanation: '已展开', confidence: 0.9,
  }));
  const { judgeEffect } = await import('../src/vlm/verdict.ts');
  const rv = await judgeEffect(await makePng(50, 40), await makePng(50, 40), '菜单展开', { client: v.brain });
  assert.equal(rv.ok, true, 'verdict 直用备选脑成功');
  assert.equal(rv.verdict, 'confirmed');
  assert.equal(rv.scale, 'element');
  assert.equal(rv.confidence, 0.9);
});

// ─── GlmClient 结构兼容端口（运行时冒烟，零联网） ───

test('W8-A6n: GlmClient 结构兼容端口 —— 真实例直入三器官（未配置 ⇒ 零网络降级，行为不变）', async () => {
  const { GlmClient } = await import('../src/vlm/glmClient.ts');
  const glm = new GlmClient({}); // 无 options ⇒ 未配置（不读 env、不拨号）
  assert.equal(typeof glm.chatJson, 'function');
  assert.equal(glm.configured, false);

  const { groundElements } = await import('../src/vlm/grounding.ts');
  const rg = await groundElements(await makePng(60, 40), { client: glm });
  assert.equal(rg.ok, false);
  assert.equal(rg.degraded, true, '配置哨兵经端口照常生效');
  assert.equal(rg.strategy, 'unconfigured');

  const { readTextViaVlm } = await import('../src/vlm/vlmOcr.ts');
  const ro = await readTextViaVlm(await makePng(60, 40), { client: glm });
  assert.equal(ro.ok, false);
  assert.equal(ro.degraded, true, 'chatJson 降级臂经端口透传（vlmOcr）');

  const { judgeEffect } = await import('../src/vlm/verdict.ts');
  const rv = await judgeEffect(await makePng(60, 40), await makePng(60, 40), '任意预期', { client: glm });
  assert.equal(rv.ok, false);
  assert.equal(rv.degraded, true, 'chatJson 降级臂经端口透传（verdict）');
});
