// test/vlm.providers.registry.test.ts
// 纪元 Ψ（Ψ-5 万脑归一）：平台注册表执法册 —— 预设完整性 / 三种识别 / 四路解析 / configured。
// 铁律：全离线 —— 不发任何网络请求；环境变量一律「保存 → 临时写入 → try/finally 恢复」，
// 且每段先清空全部平台 env 再应用补丁，确保不受宿主环境与测试间顺序影响。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  PLATFORM_PRESETS,
  getPreset,
  detectPresetFromBaseUrl,
  detectPresetFromEnv,
  resolveProviderConfig,
  listPlatforms,
  CUSTOM_PRESET_ID,
} = await import('../src/vlm/providers/registry.ts');

// ─── 环境变量控制：全清 → 补丁 → try/finally 恢复现场 ───

/** 注册表涉及的全部环境变量（去重） */
const ALL_ENV_KEYS = [...new Set(PLATFORM_PRESETS.flatMap(p => p.envKeys))];

/**
 * 受控环境执行：保存全部平台 env → 清空 → 应用补丁（undefined = 确保删除）→
 * 执行 fn → finally 无条件恢复原值（原不存在者删除）。fn 抛错也必恢复。
 */
function withEnv(patch: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const k of ALL_ENV_KEYS) saved.set(k, process.env[k]);
  try {
    for (const k of ALL_ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ─── 期望花名册（13 颗脑，声明序即优先序） ───

interface ExpectedPreset {
  id: string;
  label: string;
  protocol: 'openai' | 'anthropic' | 'gemini';
  baseUrl: string;
  envKeys: string[];
  defaultModel: string;
  localAuth?: boolean;
}

const EXPECTED: ReadonlyArray<ExpectedPreset> = [
  { id: 'glm', label: '智谱 GLM', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', envKeys: ['GLM_API_KEY', 'ZHIPUAI_API_KEY', 'ZAI_API_KEY'], defaultModel: 'glm-5.3-flash' },
  { id: 'openai', label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', envKeys: ['OPENAI_API_KEY'], defaultModel: 'gpt-4o-mini' },
  { id: 'anthropic', label: 'Anthropic Claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', envKeys: ['ANTHROPIC_API_KEY'], defaultModel: 'claude-sonnet-4' },
  { id: 'gemini', label: 'Google Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], defaultModel: 'gemini-2.0-flash' },
  { id: 'qwen', label: '阿里通义千问 VL', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', envKeys: ['DASHSCOPE_API_KEY', 'ALIYUN_API_KEY'], defaultModel: 'qwen-vl-max' },
  { id: 'moonshot', label: '月之暗面 Kimi', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', envKeys: ['MOONSHOT_API_KEY'], defaultModel: 'kimi-latest' },
  { id: 'doubao', label: '字节豆包（火山方舟）', protocol: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', envKeys: ['ARK_API_KEY', 'VOLCENGINE_API_KEY'], defaultModel: 'doubao-1.5-vision-pro-32k' },
  { id: 'xai', label: 'xAI Grok', protocol: 'openai', baseUrl: 'https://api.x.ai/v1', envKeys: ['XAI_API_KEY', 'GROK_API_KEY'], defaultModel: 'grok-2-vision-1212' },
  { id: 'siliconflow', label: '硅基流动', protocol: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', envKeys: ['SILICONFLOW_API_KEY'], defaultModel: 'Qwen/Qwen2.5-VL-72B-Instruct' },
  { id: 'openrouter', label: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', envKeys: ['OPENROUTER_API_KEY'], defaultModel: 'google/gemini-2.0-flash-001' },
  { id: 'ollama', label: 'Ollama 本地', protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', envKeys: [], defaultModel: 'qwen2.5vl:7b', localAuth: true },
  { id: 'lmstudio', label: 'LM Studio 本地', protocol: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', envKeys: [], defaultModel: '', localAuth: true },
  { id: 'vllm', label: 'vLLM 本地', protocol: 'openai', baseUrl: 'http://127.0.0.1:8000/v1', envKeys: [], defaultModel: '', localAuth: true },
];

/** 必须携带中文备注的平台（接入陷阱说明） */
const NOTES_REQUIRED = new Set(['qwen', 'doubao', 'ollama', 'lmstudio']);

// ─── Ψ-5a 预设完整性：13 个、唯一 id、GLM 首位、逐项字段全等 ───

test('Ψ-5a: PLATFORM_PRESETS —— 13 项完整 / id 唯一 / GLM 首位 / 逐字段全等', () => {
  assert.equal(PLATFORM_PRESETS.length, EXPECTED.length, `预设数量 = ${EXPECTED.length}`);
  assert.equal(PLATFORM_PRESETS[0]!.id, 'glm', 'GLM 排首位（Ω 宿主兼容）');
  assert.equal(new Set(PLATFORM_PRESETS.map(p => p.id)).size, EXPECTED.length, 'id 全表唯一');
  assert.equal(CUSTOM_PRESET_ID, 'custom', 'custom 常量');
  assert.equal(PLATFORM_PRESETS.some(p => p.id === CUSTOM_PRESET_ID), false, '注册表本体不含 custom 合成位');
  for (let i = 0; i < EXPECTED.length; i++) {
    const p = PLATFORM_PRESETS[i]!;
    const e = EXPECTED[i]!;
    assert.equal(p.id, e.id, `#${i + 1} id`);
    assert.equal(p.label, e.label, `#${i + 1} label`);
    assert.equal(p.protocol, e.protocol, `#${i + 1} protocol`);
    assert.equal(p.baseUrl, e.baseUrl, `#${i + 1} baseUrl`);
    assert.deepEqual(p.envKeys, e.envKeys, `#${i + 1} envKeys`);
    assert.equal(p.defaultModel, e.defaultModel, `#${i + 1} defaultModel`);
    assert.equal(p.localAuthOptional === true, e.localAuth === true, `#${i + 1} localAuthOptional`);
    if (NOTES_REQUIRED.has(e.id)) {
      assert.equal(typeof p.notes, 'string', `${e.id} 有中文备注`);
      assert.ok(p.notes !== '' && /[\u4e00-\u9fff]/.test(p.notes!), `${e.id} 备注非空且含中文`);
    } else {
      assert.equal(p.notes, undefined, `${e.id} 无备注`);
    }
  }
});

// ─── Ψ-5b getPreset：命中 / 大小写与空白宽容 / 未命中 ───

test('Ψ-5b: getPreset —— 命中、大小写与空白宽容、未命中与脏值安静返 null', () => {
  assert.equal(getPreset('glm')!.label, '智谱 GLM');
  assert.equal(getPreset('qwen')!.protocol, 'openai');
  assert.equal(getPreset('vllm')!.baseUrl, 'http://127.0.0.1:8000/v1');
  assert.equal(getPreset('GLM')!.id, 'glm', '大小写不敏感');
  assert.equal(getPreset('  anthropic  ')!.id, 'anthropic', '首尾空白容忍');
  assert.equal(getPreset('nonexistent'), null);
  assert.equal(getPreset(''), null);
  assert.equal(getPreset('   '), null);
  assert.equal(getPreset(null as unknown as string), null, '脏值不抛');
});

// ─── Ψ-5c detectPresetFromBaseUrl：精确 host / 带路径 / 未知 null / localhost 不误配 ───

test('Ψ-5c: detectPresetFromBaseUrl —— 精确 host、带路径、未知/仿冒/异端口 null、回环各归各位', () => {
  // 精确命中（预设 baseUrl 原文）
  assert.equal(detectPresetFromBaseUrl('https://open.bigmodel.cn/api/paas/v4')!.id, 'glm');
  assert.equal(detectPresetFromBaseUrl('https://api.openai.com/v1')!.id, 'openai');
  assert.equal(detectPresetFromBaseUrl('https://api.anthropic.com')!.id, 'anthropic', '无路径预设任意路径可配');
  // 带路径（端点级 URL）+ 尾斜杠 + host 大小写 + 显式缺省端口
  assert.equal(detectPresetFromBaseUrl('https://api.openai.com/v1/chat/completions')!.id, 'openai');
  assert.equal(detectPresetFromBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions')!.id, 'qwen');
  assert.equal(detectPresetFromBaseUrl('https://open.bigmodel.cn/api/paas/v4/')!.id, 'glm', '尾斜杠归一');
  assert.equal(detectPresetFromBaseUrl('https://API.MOONSHOT.CN/v1')!.id, 'moonshot', 'host 大小写');
  assert.equal(detectPresetFromBaseUrl('https://api.openai.com:443/v1')!.id, 'openai', '显式缺省端口');
  assert.equal(detectPresetFromBaseUrl('https://api.anthropic.com/v1/messages')!.id, 'anthropic');
  // 未知 host / 后缀仿冒 / 端口不符 / 路径不匹配 ⇒ null
  assert.equal(detectPresetFromBaseUrl('https://api.example.com/v1'), null, '未知 host');
  assert.equal(detectPresetFromBaseUrl('https://api.openai.com.evil.tld/v1'), null, '后缀仿冒不配');
  assert.equal(detectPresetFromBaseUrl('https://evil-openai.example.com/v1'), null);
  assert.equal(detectPresetFromBaseUrl('https://open.bigmodel.cn:8443/api/paas/v4'), null, '异端口不配');
  assert.equal(detectPresetFromBaseUrl('https://api.openai.com/v2'), null, '路径前缀不符');
  assert.equal(detectPresetFromBaseUrl('https://api.openai.com'), null, '路径缺席（预设含 /v1）不配');
  // 本地三兄弟各归各位（host+端口+路径全判）
  assert.equal(detectPresetFromBaseUrl('http://127.0.0.1:11434/v1')!.id, 'ollama');
  assert.equal(detectPresetFromBaseUrl('http://127.0.0.1:1234/v1')!.id, 'lmstudio');
  assert.equal(detectPresetFromBaseUrl('http://127.0.0.1:8000/v1/chat/completions')!.id, 'vllm');
  assert.equal(detectPresetFromBaseUrl('http://localhost:11434/v1')!.id, 'ollama', '回环等价：localhost ≡ 127.0.0.1');
  assert.equal(detectPresetFromBaseUrl('http://[::1]:1234/v1')!.id, 'lmstudio', '回环等价：IPv6 ::1');
  // localhost 不误配：未知端口的回环地址绝不误认为任何已知平台（云脑/本地脑都不沾）
  assert.equal(detectPresetFromBaseUrl('http://localhost:9/v1'), null, '未知端口不误配');
  assert.equal(detectPresetFromBaseUrl('http://127.0.0.1:9999/v1'), null);
  assert.equal(detectPresetFromBaseUrl('http://localhost/v1'), null);
  assert.equal(detectPresetFromBaseUrl('http://localhost:11434'), null, '端口对但缺 /v1 路径不配 ollama');
  // 脏值安静返 null
  assert.equal(detectPresetFromBaseUrl(''), null);
  assert.equal(detectPresetFromBaseUrl('not a url'), null);
  assert.equal(detectPresetFromBaseUrl(undefined as unknown as string), null);
});

// ─── Ψ-5d detectPresetFromEnv：GLM 优先 / 声明序 / 空 fallback / 全空 null ───

test('Ψ-5d: detectPresetFromEnv —— GLM 优先序、声明序多平台取首、次序 envKeys、空串缺席、全空 null', () => {
  withEnv({}, () => {
    assert.equal(detectPresetFromEnv(), null, '无任何平台 env ⇒ null');
  });
  // GLM 排首位保兼容：GLM 与 OpenAI 同设 ⇒ glm
  withEnv({ GLM_API_KEY: 'g1', OPENAI_API_KEY: 'o1' }, () => {
    assert.equal(detectPresetFromEnv()!.id, 'glm', 'GLM 优先于 OpenAI');
  });
  withEnv({ ZHIPUAI_API_KEY: 'z1', OPENAI_API_KEY: 'o1' }, () => {
    assert.equal(detectPresetFromEnv()!.id, 'glm', 'GLM 的旧变量名同样夺冠');
  });
  // 多平台只取声明序首个：moonshot(6) < xai(8) < openrouter(10)
  withEnv({ MOONSHOT_API_KEY: 'm1', XAI_API_KEY: 'x1', OPENROUTER_API_KEY: 'r1' }, () => {
    assert.equal(detectPresetFromEnv()!.id, 'moonshot');
  });
  withEnv({ XAI_API_KEY: 'x1', OPENROUTER_API_KEY: 'r1' }, () => {
    assert.equal(detectPresetFromEnv()!.id, 'xai');
  });
  // envKeys 内部按序回退：第 2/3 个变量单设同样命中
  withEnv({ ZAI_API_KEY: 'z2' }, () => assert.equal(detectPresetFromEnv()!.id, 'glm'));
  withEnv({ GOOGLE_API_KEY: 'gg' }, () => assert.equal(detectPresetFromEnv()!.id, 'gemini'));
  withEnv({ VOLCENGINE_API_KEY: 'v1' }, () => assert.equal(detectPresetFromEnv()!.id, 'doubao'));
  withEnv({ GROK_API_KEY: 'gk' }, () => assert.equal(detectPresetFromEnv()!.id, 'xai'));
  withEnv({ ALIYUN_API_KEY: 'a1' }, () => assert.equal(detectPresetFromEnv()!.id, 'qwen'));
  // 空串视为缺席
  withEnv({ OPENAI_API_KEY: '' }, () => assert.equal(detectPresetFromEnv(), null));
  withEnv({ GLM_API_KEY: '', OPENAI_API_KEY: '  ' }, () => assert.equal(detectPresetFromEnv(), null, '空白串同样缺席'));
  // env 即时读取（无缓存）：设 → glm；删 → null
  withEnv({ GLM_API_KEY: 'g' }, () => {
    assert.equal(detectPresetFromEnv()!.id, 'glm');
    delete process.env.GLM_API_KEY;
    assert.equal(detectPresetFromEnv(), null, '同进程内删 env 即失效');
    process.env.GLM_API_KEY = 'g-again';
    assert.equal(detectPresetFromEnv()!.id, 'glm', '同进程内再设即生效');
  });
});

// ─── Ψ-5e resolveProviderConfig 路 1：显式 provider ───

test('Ψ-5e: resolveProviderConfig(explicit) —— 命中预设、opts>env>preset 三物料优先级、未知 id null', () => {
  withEnv({}, () => {
    const r = resolveProviderConfig({ provider: 'glm' });
    assert.equal(r!.preset.id, 'glm');
    assert.equal(r!.via, 'explicit');
    assert.equal(r!.apiKey, '', '无 env 无 opts ⇒ 空 key');
    assert.equal(r!.baseUrl, 'https://open.bigmodel.cn/api/paas/v4');
    assert.equal(r!.model, 'glm-5.3-flash');
    // 本地脑显式点名：免 key、preset 缺省全接管
    const ro = resolveProviderConfig({ provider: 'ollama' });
    assert.equal(ro!.preset.id, 'ollama');
    assert.equal(ro!.apiKey, '');
    assert.equal(ro!.baseUrl, 'http://127.0.0.1:11434/v1');
    assert.equal(ro!.model, 'qwen2.5vl:7b');
    assert.equal(ro!.via, 'explicit');
    // 未知 id（含 custom 字面量）诚实 null —— 不静默换脑
    assert.equal(resolveProviderConfig({ provider: 'nonexistent', apiKey: 'k' }), null);
    assert.equal(resolveProviderConfig({ provider: 'custom' }), null);
    // 空白 provider 视为缺席（转入后续路径）
    assert.equal(resolveProviderConfig({ provider: '   ' }), null, '空白 provider + 干净 env ⇒ null');
  });
  // opts 三物料全覆写 env 与 preset（opts > env > preset）
  withEnv({ DASHSCOPE_API_KEY: 'env-key' }, () => {
    const r = resolveProviderConfig({
      provider: 'qwen',
      apiKey: 'opt-key',
      baseUrl: 'https://q-mirror.example.com/compatible-mode/v1',
      model: 'qwen-vl-custom',
    });
    assert.equal(r!.preset.id, 'qwen');
    assert.equal(r!.via, 'explicit');
    assert.equal(r!.apiKey, 'opt-key', 'opts.apiKey > env');
    assert.equal(r!.baseUrl, 'https://q-mirror.example.com/compatible-mode/v1', 'opts.baseUrl > preset');
    assert.equal(r!.model, 'qwen-vl-custom', 'opts.model > preset');
  });
  // env 回退：首个非空 envKeys 命中（DASHSCOPE 空则取 ALIYUN）
  withEnv({ DASHSCOPE_API_KEY: '', ALIYUN_API_KEY: 'ali-key' }, () => {
    const r = resolveProviderConfig({ provider: 'qwen' });
    assert.equal(r!.apiKey, 'ali-key');
    assert.equal(r!.model, 'qwen-vl-max', 'model 无 opts/则用 preset 缺省');
  });
});

// ─── Ψ-5f resolveProviderConfig 路 2：baseUrl 线索（识别 / custom 合成） ───

test('Ψ-5f: resolveProviderConfig(baseurl) —— 命中预设保用户原值、custom 合成、env 回填', () => {
  // 命中已知平台：via baseurl、baseUrl 用用户原文（尾斜杠原样，归一归适配器管）
  withEnv({}, () => {
    const r = resolveProviderConfig({ baseUrl: 'https://api.moonshot.cn/v1/' });
    assert.equal(r!.preset.id, 'moonshot');
    assert.equal(r!.via, 'baseurl');
    assert.equal(r!.baseUrl, 'https://api.moonshot.cn/v1/', '用户 baseUrl 原值保留');
    assert.equal(r!.model, 'kimi-latest', 'model 落 preset 缺省');
    assert.equal(r!.apiKey, '', '无 key 来源 ⇒ 空');
  });
  // 未识别 baseUrl ⇒ custom 合成预设（openai 方言、envKeys 空、defaultModel 空）
  withEnv({}, () => {
    const r = resolveProviderConfig({
      baseUrl: 'https://vision.internal.example.com/v1',
      apiKey: 'sk-local',
      model: 'internal-vl',
    });
    assert.equal(r!.preset.id, CUSTOM_PRESET_ID);
    assert.equal(r!.preset.protocol, 'openai', 'custom 缺省 openai 方言');
    assert.deepEqual(r!.preset.envKeys, []);
    assert.equal(r!.preset.defaultModel, '');
    assert.equal(r!.preset.baseUrl, 'https://vision.internal.example.com/v1', '合成预设携带用户 baseUrl');
    assert.equal(r!.apiKey, 'sk-local');
    assert.equal(r!.model, 'internal-vl');
    assert.equal(r!.via, 'baseurl');
    // custom 无 model ⇒ 空（依赖发现）
    const r2 = resolveProviderConfig({ baseUrl: 'http://10.0.0.5:9000/v1' });
    assert.equal(r2!.preset.id, 'custom');
    assert.equal(r2!.model, '');
    assert.equal(r2!.apiKey, '');
  });
  // 预设命中时 env 密钥照样回填（本地 env 已有 ark key）
  withEnv({ ARK_API_KEY: 'ark-key' }, () => {
    const r = resolveProviderConfig({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' });
    assert.equal(r!.preset.id, 'doubao');
    assert.equal(r!.apiKey, 'ark-key', 'baseUrl 线索 + env key 回填');
    assert.equal(r!.model, 'doubao-1.5-vision-pro-32k');
    assert.equal(r!.via, 'baseurl');
  });
});

// ─── Ψ-5g resolveProviderConfig 路 3/4：env 自动识别 与 全无 null ───

test('Ψ-5g: resolveProviderConfig(env/null) —— env 路识别、opts 覆写、四路全无 null', () => {
  withEnv({ ANTHROPIC_API_KEY: 'ak-1' }, () => {
    const r = resolveProviderConfig();
    assert.equal(r!.preset.id, 'anthropic');
    assert.equal(r!.preset.protocol, 'anthropic');
    assert.equal(r!.apiKey, 'ak-1');
    assert.equal(r!.baseUrl, 'https://api.anthropic.com');
    assert.equal(r!.model, 'claude-sonnet-4');
    assert.equal(r!.via, 'env');
    // env 路上 opts 仍优先（opts > env）
    const r2 = resolveProviderConfig({ apiKey: 'opt-ak', model: 'claude-opus-4' });
    assert.equal(r2!.via, 'env');
    assert.equal(r2!.apiKey, 'opt-ak', 'opts.apiKey > env');
    assert.equal(r2!.model, 'claude-opus-4', 'opts.model > env 路缺省');
  });
  withEnv({ GEMINI_API_KEY: 'gk' }, () => {
    const r = resolveProviderConfig({ apiKey: 'opt' });
    assert.equal(r!.preset.id, 'gemini');
    assert.equal(r!.apiKey, 'opt');
    assert.equal(r!.baseUrl, 'https://generativelanguage.googleapis.com/v1beta');
  });
  // 路 4：无 provider、无 baseUrl、env 全空 ⇒ null（空 opts / 仅零散物料均不构成线索）
  withEnv({}, () => {
    assert.equal(resolveProviderConfig(), null);
    assert.equal(resolveProviderConfig({}), null);
    assert.equal(resolveProviderConfig({ model: 'some-model' }), null, '仅 model 不构成线索');
    assert.equal(resolveProviderConfig({ apiKey: 'sk-lonely' }), null, '仅 apiKey 不构成线索');
  });
});

// ─── Ψ-5h listPlatforms：configured 判定（env 任一非空 || localAuthOptional） ───

test('Ψ-5h: listPlatforms —— 13 行带 configured、干净 env 下唯本地三兄弟就绪、env 点亮、不动注册表本体', () => {
  withEnv({}, () => {
    const list = listPlatforms();
    assert.equal(list.length, EXPECTED.length);
    const byId = new Map(list.map(p => [p.id, p]));
    for (const p of list) {
      assert.equal(p.configured, p.localAuthOptional === true, `干净 env：${p.id} configured = localAuthOptional`);
    }
    assert.equal(byId.get('ollama')!.configured, true);
    assert.equal(byId.get('lmstudio')!.configured, true);
    assert.equal(byId.get('vllm')!.configured, true);
    assert.equal(byId.get('glm')!.configured, false);
    assert.equal(byId.get('openai')!.configured, false);
    assert.equal(byId.get('doubao')!.configured, false);
    // 行携带完整预设字段（非仅 id/configured 的薄片）
    assert.equal(byId.get('qwen')!.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
    assert.deepEqual(byId.get('gemini')!.envKeys, ['GEMINI_API_KEY', 'GOOGLE_API_KEY']);
  });
  withEnv({ OPENAI_API_KEY: 'sk-o' }, () => {
    const byId = new Map(listPlatforms().map(p => [p.id, p]));
    assert.equal(byId.get('openai')!.configured, true, 'env 点亮 openai');
    assert.equal(byId.get('glm')!.configured, false, '其余云脑仍暗');
    assert.equal(byId.get('ollama')!.configured, true, '本地脑恒亮');
  });
  withEnv({ VOLCENGINE_API_KEY: 'vk' }, () => {
    const byId = new Map(listPlatforms().map(p => [p.id, p]));
    assert.equal(byId.get('doubao')!.configured, true, '第二 envKey 同样点亮');
    assert.equal(byId.get('xai')!.configured, false);
  });
  // listPlatforms 是浅拷贝 —— 注册表本体不得被追加 configured 字段
  assert.equal('configured' in PLATFORM_PRESETS.find(p => p.id === 'glm')!, false);
  // env 即时读取：两次调用间 env 变化即时反映
  withEnv({}, () => {
    assert.equal(listPlatforms().find(p => p.id === 'siliconflow')!.configured, false);
    process.env.SILICONFLOW_API_KEY = 'sf';
    try {
      assert.equal(listPlatforms().find(p => p.id === 'siliconflow')!.configured, true, '设 env 即亮');
    } finally {
      delete process.env.SILICONFLOW_API_KEY;
    }
    assert.equal(listPlatforms().find(p => p.id === 'siliconflow')!.configured, false, '删 env 即暗');
  });
});
