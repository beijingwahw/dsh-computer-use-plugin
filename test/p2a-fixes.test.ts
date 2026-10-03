// test/p2a-fixes.test.ts
// 纪元 P2a（VLM 栈加固）：全库遍历报告点名的三处真实缺陷的修复执法测试。
// 缺陷出处（全库遍历报告）：
//   P2a-1 GlmClient 单例与 ProviderPool 互不感知 —— Ψ 纪元铸了串行故障切换池但
//        只服务显式消费面；ask_screen/grounding/vlmOcr 等主力全走的 getGlmClient
//        单例（chat/chatJson）失败后不会自动切 fallbacks —— 用户配了
//        vlmFallbackProviders 以为有容错，实际主力路径没有；
//   P2a-2 vlmMeter 台账 append-only 无上限 —— p50/p95 只看最近 1000 样本窗，但
//        原始 ledger 数组只增不减，长会话内存无界；
//   P2a-3 服务端 OCR 词级置信度恒填 90 —— 服务端分数未跨线传递，下游按置信度
//        过滤的语义被弱化。
// 铁律：全离线（假 fetch / 假 provider / 假 adapter 经 _setAdapterForTests 注入）、
// 确定性（maxRetries:0 零退避睡眠 / 时间戳全注入）、绝不真实联网。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type {
  GlmVisionRequest, GlmMeterRecord,
} from '../src/vlm/glmClient.ts';
import type { VisionProvider } from '../src/vlm/providers/types.ts';

// 动态导入被测模块（TS 经 register.mjs 的解析 hook 直跑）
const glm = await import('../src/vlm/glmClient.ts');
const metering = await import('../src/vlm/metering.ts');
const textReader = await import('../src/textReader.ts');
const backend = await import('../src/physicalBackend.ts');
const { ProviderPool } = await import('../src/vlm/providers/failover.ts');

// ─── 环境隔离：抹掉可能存在的真实平台 key（与 vlm.glmClient.test.ts 同面），退出恢复 ───
const ENV_KEYS = [
  'GLM_API_KEY', 'ZHIPUAI_API_KEY', 'ZAI_API_KEY', 'GLM_BASE_URL', 'GLM_VLM_MODEL',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'DASHSCOPE_API_KEY', 'ALIYUN_API_KEY', 'MOONSHOT_API_KEY', 'ARK_API_KEY',
  'VOLCENGINE_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY', 'SILICONFLOW_API_KEY',
  'OPENROUTER_API_KEY',
] as const;
const savedEnv = new Map<string, string | undefined>();
for (const k of ENV_KEYS) {
  savedEnv.set(k, process.env[k]);
  delete process.env[k];
}
after(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  glm.resetGlmClient();
  glm.attachFailoverPool(null); // 摘除测试期接线，防跨测试污染
  backend._setAdapterForTests(null);
});

// ─── 假 fetch 工具（与 vlm.glmClient.test.ts 同款） ───

interface FetchCall { url: string; init: RequestInit | undefined }

function recorder(handler: (call: FetchCall, n: number) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return handler(call, calls.length);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function httpStatus(status: number, body = '{"error":{"message":"boom"}}'): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

function chatOk(content: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** 最小合法请求体（maxRetries 缺省 0：终败立即返回，零退避睡眠 —— 确定性） */
function req(overrides: Partial<GlmVisionRequest> = {}): GlmVisionRequest {
  return {
    images: [{ base64: 'QUJD', mime: 'image/png' }],
    prompt: '描述这张截图',
    timeoutMs: 500,
    maxRetries: 0,
    ...overrides,
  };
}

/** 假脑（VisionProvider 最小实现）：ok/text 可控，onChat 观测池内调用序与池侧 meter */
function fakeBrain(o: {
  id: string;
  ok: boolean;
  text?: string;
  onChat?: () => void;
}): VisionProvider {
  return {
    id: o.id,
    protocol: 'openai',
    model: `${o.id}-model`,
    configured: true,
    chat: async () => {
      o.onChat?.();
      return {
        ok: o.ok,
        text: o.ok ? (o.text ?? 'ok') : '',
        latencyMs: 7,
        model: `${o.id}-model`,
        providerId: o.id,
        ...(o.ok ? {} : { error: `${o.id} down` }),
      };
    },
    chatJson: async () => ({ ok: false, raw: '' }),
  };
}

// ═══ P2a-1：单例-池贯通 ═══

test('P2a-1: 主脑假 fetch 恒败 + 池有健康备脑 ⇒ 单例 chat 被救回（providerId/note 标注 + 池侧计量落账）', async () => {
  const poolSideMeter: GlmMeterRecord[] = [];
  const chatLog: string[] = [];
  const pool = new ProviderPool([
    fakeBrain({ id: 'pool-primary', ok: false, onChat: () => chatLog.push('pool-primary') }),
    fakeBrain({
      id: 'backup',
      ok: true,
      text: '备脑顶上',
      onChat: () => {
        chatLog.push('backup');
        // 池侧 meter tap（镜像 configureVlm 铸造路径的 vlmMeterTap 接线语义）
        poolSideMeter.push({ ts: 1, kind: 'backup.chat', model: 'backup-model', latencyMs: 7, ok: true });
      },
    }),
  ]);
  glm.attachFailoverPool(pool);
  try {
    const { fetchImpl, calls } = recorder(() => httpStatus(500, 'primary down'));
    const client = new glm.GlmClient({ apiKey: 'k', fetchImpl });
    const r = await client.chat(req()); // 5xx + maxRetries 0 ⇒ 立即终败（零退避睡眠）
    assert.equal(r.ok, true, '备脑救回');
    assert.equal(r.text, '备脑顶上');
    assert.equal(r.providerId, 'backup', 'providerId 标注 fallback 来源');
    assert.equal(r.note, 'failover', 'note 注明 failover');
    assert.equal(r.model, 'backup-model', 'model 取备脑自报值');
    assert.equal(r.latencyMs, 7, 'latencyMs 取备脑自报值');
    assert.equal(calls.length, 1, '主脑首发 1 次（maxRetries=0 不重试）');
    assert.deepEqual(chatLog, ['pool-primary', 'backup'], '池按序：首脑败后备脑顶上');
    assert.deepEqual(
      poolSideMeter.map(m => ({ kind: m.kind, ok: m.ok })),
      [{ kind: 'backup.chat', ok: true }],
      'failover 成功也记 meter（沿用铸造路径 tap —— 池内适配器自报）',
    );
  } finally {
    glm.attachFailoverPool(null);
  }
});

test('P2a-1: 主脑失败经单例 meter 照报（不因备脑救回而抹账）+ 单例侧恰好一条', async () => {
  const singletonMeter: GlmMeterRecord[] = [];
  const pool = new ProviderPool([fakeBrain({ id: 'solo', ok: true, text: 'ok' })]);
  glm.attachFailoverPool(pool);
  try {
    const { fetchImpl } = recorder(() => httpStatus(500, 'down'));
    const client = new glm.GlmClient({ apiKey: 'k', fetchImpl, meter: rec => singletonMeter.push(rec) });
    const r = await client.chat(req());
    assert.equal(r.ok, true, '备脑救回');
    assert.equal(singletonMeter.length, 1, '单例 meter 恰好一条（主脑失败是真实事件）');
    assert.equal(singletonMeter[0]!.ok, false);
    assert.match(singletonMeter[0]!.error!, /HTTP 500/);
  } finally {
    glm.attachFailoverPool(null);
  }
});

test('P2a-1: chatJson 主脑全败 ⇒ 池救回且 JSON 剥壳成立（主力路径 ask_screen/grounding 同形）', async () => {
  const reply = '```json\n{"target": "保存", "x": 0.5}\n```';
  const pool = new ProviderPool([fakeBrain({ id: 'b1', ok: true, text: reply })]);
  glm.attachFailoverPool(pool);
  try {
    const { fetchImpl } = recorder(() => httpStatus(500, 'down'));
    const client = new glm.GlmClient({ apiKey: 'k', fetchImpl });
    const r = await client.chatJson<{ target: string; x: number }>(req());
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { target: '保存', x: 0.5 });
    assert.equal(r.raw, reply, 'raw 恒为备脑回复原文');
  } finally {
    glm.attachFailoverPool(null);
  }
});

test('P2a-1: 主脑未配置（degraded 臂）也咨询池 —— 只配 fallbacks 的用户获得容错', async () => {
  const pool = new ProviderPool([fakeBrain({ id: 'solo', ok: true, text: '直接备脑' })]);
  glm.attachFailoverPool(pool);
  try {
    const { fetchImpl, calls } = recorder(() => chatOk('never'));
    const client = new glm.GlmClient({ fetchImpl }); // env 已清空 ⇒ 无 key ⇒ degraded
    const r = await client.chat(req());
    assert.equal(calls.length, 0, 'degraded 臂自身仍零网络');
    assert.equal(r.ok, true, '池救回');
    assert.equal(r.text, '直接备脑');
    assert.equal(r.providerId, 'solo');
    assert.equal(r.note, 'failover');
  } finally {
    glm.attachFailoverPool(null);
  }
});

test('P2a-1: 未接线池 ⇒ 旧失败返回逐字段一致（零回归红律 —— 大多数既有测试的形态）', async () => {
  glm.attachFailoverPool(null);
  const { fetchImpl, calls } = recorder(() => httpStatus(400, 'boom'));
  const client = new glm.GlmClient({ apiKey: 'k', fetchImpl });
  const r = await client.chat(req());
  assert.ok(r.latencyMs >= 0);
  const { latencyMs, ...rest } = r;
  void latencyMs;
  // Ω 纪元失败形状逐字段锁定：无 providerId/note/degraded/json/usage 等新增键
  assert.deepStrictEqual(rest, {
    ok: false,
    text: '',
    model: 'glm-5.3-flash',
    error: 'glm chat/completions HTTP 400: boom',
  });
  assert.equal(calls.length, 1, '400 不可重试 —— 立即失败');
});

test('P2a-1: 池在场但全败 ⇒ 主脑原失败返回（池的失败不覆盖归因）', async () => {
  const pool = new ProviderPool([
    fakeBrain({ id: 'f1', ok: false }),
    fakeBrain({ id: 'f2', ok: false }),
  ]);
  glm.attachFailoverPool(pool);
  try {
    const { fetchImpl } = recorder(() => httpStatus(429, 'rate'));
    const client = new glm.GlmClient({ apiKey: 'k', fetchImpl });
    const r = await client.chat(req()); // 429 + maxRetries 0 ⇒ 立即终败
    assert.equal(r.ok, false);
    assert.equal(r.error, 'glm chat/completions HTTP 429: rate');
    assert.equal(r.providerId, undefined, '原生 glm 失败本就不带 providerId —— 保持');
    assert.equal(r.note, undefined, '池全败 ⇒ 无 failover 标注');
  } finally {
    glm.attachFailoverPool(null);
  }
});

test('P2a-1: 空池（size 0）与无池同形 —— 咨询直接跳过', async () => {
  glm.attachFailoverPool(new ProviderPool([]));
  try {
    const { fetchImpl } = recorder(() => httpStatus(400, 'boom'));
    const client = new glm.GlmClient({ apiKey: 'k', fetchImpl });
    const r = await client.chat(req());
    assert.equal(r.ok, false);
    assert.match(r.error!, /HTTP 400: boom/);
    assert.equal(r.note, undefined);
  } finally {
    glm.attachFailoverPool(null);
  }
});

test('P2a-1: 委托平台单例（非 glm）全败 ⇒ 同律咨询池救回', async () => {
  // 委托路径行为级执法：platform 'openai' 的单例 chat 假 fetch 恒败 ⇒ 池救回。
  // （env 已清空 + 显式 apiKey ⇒ 委托适配器 configured，走假 fetch 全败臂）
  const pool = new ProviderPool([fakeBrain({ id: 'rescue', ok: true, text: 'delegate rescued' })]);
  glm.attachFailoverPool(pool);
  try {
    const { fetchImpl } = recorder(() => httpStatus(500, 'down'));
    const client = new glm.GlmClient({ platform: 'openai', apiKey: 'sk-x', fetchImpl });
    const r = await client.chat(req());
    assert.equal(r.ok, true, '委托路径全败后池救回');
    assert.equal(r.text, 'delegate rescued');
    assert.equal(r.providerId, 'rescue');
    assert.equal(r.note, 'failover');
  } finally {
    glm.attachFailoverPool(null);
  }
});

test('P2a-1: configureVlm 接线执法 —— 铸池注入 / 空摘除（源级 + 行为级双证）', async () => {
  // 源级：configureVlm 铸池/置空后必须把池在场性同步注入 glmClient 咨询面。
  // （行为级「铸池注入」无法离线复演 —— configureVlm 无 fetch 注入面，铸出的池
  //  用全局 fetch，真触发咨询会触真网；故铸池臂以源级执法，摘除臂以行为级执法。）
  const src = readFileSync(new URL('../src/vlm/index.ts', import.meta.url), 'utf8');
  assert.ok(
    src.includes('attachFailoverPool(poolSingleton)'),
    'configureVlm 铸池/置空后接线 attachFailoverPool',
  );

  // 行为级：空 fallbacks ⇒ 摘除已接线池（幂等归零）—— 之后再失败与无池同形
  glm.attachFailoverPool(new ProviderPool([fakeBrain({ id: 'ghost', ok: true, text: '不应出现' })]));
  const vlmIndex = await import('../src/vlm/index.ts');
  vlmIndex.configureVlm({
    vlmApiKey: '', vlmBaseUrl: '', vlmModel: '', vlmProvider: '', vlmFallbackProviders: '',
  });
  const { fetchImpl } = recorder(() => httpStatus(400, 'boom'));
  const client = new glm.GlmClient({ apiKey: 'k', fetchImpl });
  const r = await client.chat(req());
  assert.equal(r.ok, false, '池已被 configureVlm 摘除 —— ghost 不得救场');
  assert.match(r.error!, /HTTP 400: boom/);
  assert.equal(r.note, undefined);
});

// ═══ P2a-2：vlmMeter 台账环形有界 ═══

test('P2a-2: 灌 6000 条 ⇒ 台账 5000 封顶 + dropped=1000 + p50/p95 仍按最近 1000 窗计算', () => {
  const m = new metering.VlmMeter();
  for (let i = 0; i < 6000; i++) {
    m.record({ ts: i, kind: 'screen', model: 'm', latencyMs: i, ok: true });
  }
  const s = m.summary();
  assert.equal(s.calls, 5000, '环形封顶：台账长度 5000');
  assert.equal(m.dropped, 1000, '被覆盖样本诚实计数');
  // 保留 = 最新的 5000 条（latency 1000..5999）；分位窗 = 最近 1000（5000..5999）
  // sorted 窗：p50 idx=⌊0.5·1000⌋=500 → 5500；p95 idx=⌊0.95·1000⌋=950 → 5950
  assert.equal(s.p50LatencyMs, 5500);
  assert.equal(s.p95LatencyMs, 5950);
  assert.equal(s.totalLatencyMs, (1000 + 5999) * 5000 / 2, 'totalLatency 只累计保留环');
  // exportJsonl 审计面 = 保留环 —— 首行即覆盖后最老的存活样本（ts=1000）
  const firstLine = JSON.parse(m.exportJsonl().split('\n')[0]!);
  assert.equal(firstLine.ts, 1000, '最老被覆盖，最老存活者 ts=1000');
});

test('P2a-2: 未触顶（1005 条）dropped=0 —— 既有窗口语义与 summary 形状零变化', () => {
  const m = new metering.VlmMeter();
  for (let i = 0; i < 1005; i++) {
    const latencyMs = i < 5 ? 999_999 : 1000 + i; // 与既有「窗口 1000」测试同向量
    m.record({ ts: i, kind: 'bulk', model: 'm', latencyMs, ok: true });
  }
  assert.equal(m.dropped, 0, '未触顶 ⇒ 零覆盖');
  const s = m.summary();
  assert.equal(s.calls, 1005, 'calls 不受分位窗口影响（既有语义）');
  assert.equal(s.p50LatencyMs, 1505, '窗口 = 最近 1000（1005..2004）—— 既有语义不变');
  assert.equal(s.p95LatencyMs, 1955);
  // summary 返回形状被既有测试 deepStrictEqual 锁死 —— P2a-2 不得加字段
  assert.deepEqual(
    Object.keys(s).sort(),
    ['byKind', 'calls', 'completionTokens', 'failures', 'p50LatencyMs', 'p95LatencyMs', 'promptTokens', 'totalLatencyMs'],
  );
});

test('P2a-2: reset 后 dropped 归零（覆盖过再清零的往返）', () => {
  const m = new metering.VlmMeter();
  for (let i = 0; i < 5001; i++) {
    m.record({ ts: i, kind: 'k', model: 'm', latencyMs: 1, ok: true });
  }
  assert.equal(m.dropped, 1, '恰超 1 条 ⇒ 覆盖 1 条');
  m.reset();
  assert.equal(m.dropped, 0);
  assert.equal(m.summary().calls, 0);
});

// ═══ P2a-3：服务端 OCR 词级置信诚实 ═══

test('P2a-3: 服务端 L2 词置信保持 90 但携带 confidenceAssumed:true（真值未跨线的诚实标记）', async () => {
  // 证据（全库遍历查明）：python_service/dsh_physical/ui_tree.py 的 rapidocr 路径
  // 算出词级 score_f 后**仅用于 <0.5 剔除**（`if not text or score_f < 0.5: continue`），
  // 序列化的 UIElement 只有 source/role/name/state/rect —— 分数被丢弃，未跨线；
  // TS 侧 wire 契约（physicalExecution/contracts.ts 的 UIElement）同无分数字段。
  // 任务律：不动 python_service ⇒ 真值确实缺席，按律保持 90 + confidenceAssumed 标记。
  textReader._setServerOcrFailedAt_forTest(0); // 清服务端负缓存（离线测试前置）
  const treeCalls: Array<Record<string, unknown>> = [];
  backend._setAdapterForTests({
    getUiTree: async (args?: unknown) => {
      treeCalls.push(args as Record<string, unknown>);
      return {
        ok: true as const,
        value: {
          elements: [
            { source: 'L2-ocr', role: 'text', name: 'Settings', rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.25 } },
            { source: 'L1-tree', role: 'button', name: 'OK', rect: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } },
          ],
          funnel_depth: 'L2', fault: null, captured_at: 1, l3_invoked: false,
        },
      };
    },
  } as never);
  try {
    const r = await textReader.readTextAny(undefined);
    assert.equal(r.words.length, 1, '只有 L2-ocr 元素映射为词（L1-tree 不入 OCR 词表）');
    const w = r.words[0]!;
    assert.equal(w.text, 'Settings');
    assert.equal(w.confidence, 90, '真值未跨线 ⇒ 保持 90（任务律：不动 python）');
    assert.equal(w.confidenceAssumed, true, 'P2a-3：假设值标记在场 —— 这是假设值不是测量值');
    assert.deepEqual(w.bbox_normalized, { x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.5 });
    assert.deepEqual(w.center_normalized, { x: 0.5, y: 0.375 });
    // 请求形态：服务端 L2 探测参数不因标记而变（source=ocr / funnelCeiling=L2）
    assert.equal(treeCalls[0]!.source, 'ocr');
    assert.equal(treeCalls[0]!.funnelCeiling, 'L2');
  } finally {
    backend._setAdapterForTests(null);
  }
});
