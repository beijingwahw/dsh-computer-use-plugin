// src/vlm/providers/registry.ts
// 纪元 Ψ（Ψ-5 万脑归一）：平台注册表 —— 全平台预设 + baseUrl/env 自动识别 + 四路配置解析。
/** 自定义合成预设的固定 id（baseUrl 未命中任何已知平台时使用） */
export const CUSTOM_PRESET_ID = 'custom';
// ─── 全平台预设（声明序即 detectPresetFromEnv 的优先序；GLM 排首位保兼容） ───
/** 平台注册表 —— 13 颗脑按序挂号；GLM 首位（Ω 纪元宿主无感升级） */
export const PLATFORM_PRESETS = [
    {
        id: 'glm',
        label: '智谱 GLM',
        protocol: 'openai',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        envKeys: ['GLM_API_KEY', 'ZHIPUAI_API_KEY', 'ZAI_API_KEY'],
        defaultModel: 'glm-5.3-flash',
    },
    {
        id: 'openai',
        label: 'OpenAI',
        protocol: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        envKeys: ['OPENAI_API_KEY'],
        defaultModel: 'gpt-4o-mini',
    },
    {
        id: 'anthropic',
        label: 'Anthropic Claude',
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        envKeys: ['ANTHROPIC_API_KEY'],
        defaultModel: 'claude-sonnet-4',
    },
    {
        id: 'gemini',
        label: 'Google Gemini',
        protocol: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
        defaultModel: 'gemini-2.0-flash',
    },
    {
        id: 'qwen',
        label: '阿里通义千问 VL',
        protocol: 'openai',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        envKeys: ['DASHSCOPE_API_KEY', 'ALIYUN_API_KEY'],
        defaultModel: 'qwen-vl-max',
        notes: '走 DashScope 的 OpenAI 兼容模式端点（compatible-mode），非原生 JSON 协议。',
    },
    {
        id: 'moonshot',
        label: '月之暗面 Kimi',
        protocol: 'openai',
        baseUrl: 'https://api.moonshot.cn/v1',
        envKeys: ['MOONSHOT_API_KEY'],
        defaultModel: 'kimi-latest',
    },
    {
        id: 'doubao',
        label: '字节豆包（火山方舟）',
        protocol: 'openai',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        envKeys: ['ARK_API_KEY', 'VOLCENGINE_API_KEY'],
        defaultModel: 'doubao-1.5-vision-pro-32k',
        notes: '火山方舟可能要求 model 填接入点 ID（形如 ep-2024xxxxxx-xxxxx）而非模型名。',
    },
    {
        id: 'xai',
        label: 'xAI Grok',
        protocol: 'openai',
        baseUrl: 'https://api.x.ai/v1',
        envKeys: ['XAI_API_KEY', 'GROK_API_KEY'],
        defaultModel: 'grok-2-vision-1212',
    },
    {
        id: 'siliconflow',
        label: '硅基流动',
        protocol: 'openai',
        baseUrl: 'https://api.siliconflow.cn/v1',
        envKeys: ['SILICONFLOW_API_KEY'],
        defaultModel: 'Qwen/Qwen2.5-VL-72B-Instruct',
    },
    {
        id: 'openrouter',
        label: 'OpenRouter',
        protocol: 'openai',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKeys: ['OPENROUTER_API_KEY'],
        defaultModel: 'google/gemini-2.0-flash-001',
    },
    {
        id: 'ollama',
        label: 'Ollama 本地',
        protocol: 'openai',
        baseUrl: 'http://127.0.0.1:11434/v1',
        envKeys: [],
        defaultModel: 'qwen2.5vl:7b',
        localAuthOptional: true,
        notes: '本地服务免 key；环境变量 OLLAMA_HOST 可改 baseUrl（对应改传入 opts.baseUrl）。',
    },
    {
        id: 'lmstudio',
        label: 'LM Studio 本地',
        protocol: 'openai',
        baseUrl: 'http://127.0.0.1:1234/v1',
        envKeys: [],
        defaultModel: '',
        localAuthOptional: true,
        notes: '本地服务免 key；defaultModel 留空 —— 依赖 LM Studio 的模型列表发现。',
    },
    {
        id: 'vllm',
        label: 'vLLM 本地',
        protocol: 'openai',
        baseUrl: 'http://127.0.0.1:8000/v1',
        envKeys: [],
        defaultModel: '',
        localAuthOptional: true,
    },
];
// ─── 内部小工具（永不抛异常） ───
/** 安全读单个环境变量：非字符串/缺失/读访问故障 ⇒ ''；值原样返回（不 trim 语义外泄） */
function readEnv(name) {
    try {
        const v = process.env[name];
        return typeof v === 'string' ? v.trim() : '';
    }
    catch {
        return '';
    }
}
/** 按声明序取首个非空 env 值（空数组/全空 ⇒ ''） */
function firstEnvValue(keys) {
    for (const k of keys) {
        const v = readEnv(k);
        if (v !== '')
            return v;
    }
    return '';
}
/** 安全 trim 字符串入参：非字符串/toString 故障 ⇒ '' */
function safeTrim(v) {
    try {
        return typeof v === 'string' ? v.trim() : '';
    }
    catch {
        return '';
    }
}
/** 解析 URL 为判别投影；解析失败（脏值/相对串/空串）⇒ null，绝不抛 */
function parseUrlParts(raw) {
    try {
        const u = new URL(String(raw ?? '').trim());
        const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
        if (host === '')
            return null;
        const port = u.port !== '' ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
        return { host, port, path: u.pathname.replace(/\/+$/, '') };
    }
    catch {
        return null;
    }
}
/** 回环主机集合（localhost/127.0.0.1/::1 视为同一台本机 —— 整 host 精确比对） */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
/** 主机规范形：回环三兄弟归一（本地预设的 localhost 写法与 127.0.0.1 等价） */
function canonHost(host) {
    return LOOPBACK_HOSTS.has(host) ? '\0loopback' : host;
}
/** 合成自定义预设（baseUrl 未命中任何已知平台时的兜底脑位） */
function makeCustomPreset(baseUrl) {
    return {
        id: CUSTOM_PRESET_ID,
        label: '自定义端点（OpenAI 兼容）',
        protocol: 'openai',
        baseUrl,
        envKeys: [],
        defaultModel: '',
        notes: '未识别的 baseUrl —— 按 OpenAI 兼容方言接入，密钥与模型需显式给定。',
    };
}
// ─── 查表与识别 ───
/**
 * 按平台 id 查预设：命中返回该预设；未命中/空串/脏值 ⇒ null。
 * id 比对大小写不敏感并容忍首尾空白（' GLM ' ≡ 'glm'）；绝不抛异常。
 */
export function getPreset(id) {
    const key = safeTrim(id).toLowerCase();
    if (key === '')
        return null;
    for (const p of PLATFORM_PRESETS) {
        if (p.id === key)
            return p;
    }
    return null;
}
/**
 * 按 baseUrl 识别平台（host + 端口 + 路径前缀匹配）：
 *  - 主机精确比对（小写；'api.openai.com.evil.tld' 等后缀仿冒不匹配）
 *  - 端口须一致（显式缺省端口归一到 80/443；本地三兄弟 11434/1234/8000 各归各位）
 *  - 回环主机等价：localhost ≡ 127.0.0.1 ≡ ::1（Ollama 写 localhost:11434 同样命中）
 *  - 路径前缀匹配：预设路径为 '' 时任意路径均可；否则候选路径须等于预设路径
 *    或以 `预设路径/` 开头（尾斜杠已归一）
 *  - 未命中/URL 解析失败/脏值 ⇒ null；绝不抛异常。
 */
export function detectPresetFromBaseUrl(url) {
    const cand = parseUrlParts(url);
    if (!cand)
        return null;
    const candHost = canonHost(cand.host);
    for (const p of PLATFORM_PRESETS) {
        const base = parseUrlParts(p.baseUrl);
        if (!base)
            continue;
        if (candHost !== canonHost(base.host) || cand.port !== base.port)
            continue;
        if (base.path === '' || cand.path === base.path || cand.path.startsWith(`${base.path}/`)) {
            return p;
        }
    }
    return null;
}
/**
 * 按环境变量自动识别平台：按 PLATFORM_PRESETS 声明序，返回首个 envKeys 中
 * 任一变量非空的预设（GLM 排首位 —— Ω 纪元宿主双设时保 GLM 兼容）。
 * 空串值视为缺席；本地预设 envKeys 为空数组故永不中；全空 ⇒ null。
 * env 每次调用即时读取（无缓存）。绝不抛异常。
 */
export function detectPresetFromEnv() {
    for (const p of PLATFORM_PRESETS) {
        if (firstEnvValue(p.envKeys) !== '')
            return p;
    }
    return null;
}
// ─── 配置解析（四路仲裁） ───
/**
 * 解析供应商配置 —— 万脑装配的入口仲裁，按优先级四路：
 *   1. provider 显式给出 ⇒ 该 id 的预设（未知 id ⇒ null，不静默换脑）；
 *   2. 无 provider 但 baseUrl 给出 ⇒ detectPresetFromBaseUrl 识别（命中用该
 *      预设；未命中合成 protocol='openai' 的 'custom' 预设）；
 *   3. 都无 ⇒ detectPresetFromEnv 环境变量自动识别；
 *   4. 全无 ⇒ null。
 * 三物料的取值律（各路同法）：opts 显式值 > env 首命中（预设 envKeys） > 预设
 * 缺省值；baseUrl/model 无 env 来源；apiKey 兜底 ''（本地服务允许）。
 * 空串/纯空白 opts 值视为缺席。绝不抛异常。
 */
export function resolveProviderConfig(opts) {
    const o = opts ?? {};
    const optKey = safeTrim(o.apiKey);
    const optUrl = safeTrim(o.baseUrl);
    const optModel = safeTrim(o.model);
    // 路 1：显式 provider id —— 未知 id 诚实返回 null（换错脑比没有脑更糟）
    const providerId = safeTrim(o.provider).toLowerCase();
    if (providerId !== '') {
        const preset = getPreset(providerId);
        if (!preset)
            return null;
        return {
            preset,
            apiKey: optKey !== '' ? optKey : firstEnvValue(preset.envKeys),
            baseUrl: optUrl !== '' ? optUrl : preset.baseUrl,
            model: optModel !== '' ? optModel : preset.defaultModel,
            via: 'explicit',
        };
    }
    // 路 2：baseUrl 线索 —— 识别则用已知预设，未识别合成 custom（openai 方言）
    if (optUrl !== '') {
        const preset = detectPresetFromBaseUrl(optUrl) ?? makeCustomPreset(optUrl);
        return {
            preset,
            apiKey: optKey !== '' ? optKey : firstEnvValue(preset.envKeys),
            baseUrl: optUrl, // 用户给的 baseUrl 永远优先于预设缺省（尾斜杠等原样保留）
            model: optModel !== '' ? optModel : preset.defaultModel,
            via: 'baseurl',
        };
    }
    // 路 3：环境变量自动识别（声明序首个命中）
    const preset = detectPresetFromEnv();
    if (!preset)
        return null;
    return {
        preset,
        apiKey: optKey !== '' ? optKey : firstEnvValue(preset.envKeys),
        baseUrl: preset.baseUrl,
        model: optModel !== '' ? optModel : preset.defaultModel,
        via: 'env',
    };
}
// ─── 观测面 ───
/**
 * 列出全平台（含 configured 判定）：configured = envKeys 任一非空
 * || localAuthOptional === true（本地免密服务恒视为就绪）。env 即时读取；
 * 返回预设浅拷贝（不污染注册表本体）。绝不抛异常。
 */
export function listPlatforms() {
    return PLATFORM_PRESETS.map(p => ({
        ...p,
        configured: p.localAuthOptional === true || firstEnvValue(p.envKeys) !== '',
    }));
}
