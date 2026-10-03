// test/vlm.connection.test.ts
// 纪元 Λ（Λ-1 开箱即亮）：连接存档 + 本地自动接管 执法册（两模块并入一文件）。
// 铁律：全离线 —— ConnectionStore 一律注入临时目录路径（不碰真实 ~/.dsh）；
// adoptLocalVision 一律注入 fetchImpl 假 /models 响应（绝不真实联网）；
// 环境变量（DSH_VLM_CONNECTION）一律「保存 → 临时写入 → try/finally 恢复」。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

const {
  defaultConnectionPath,
  ConnectionStore,
  maskKey,
} = await import('../src/vlm/connection.ts');
const {
  LOCAL_CANDIDATES,
  pickVisionModel,
  adoptLocalVision,
} = await import('../src/vlm/autoAdopt.ts');

// ─── 临时目录（每测一新的；测试自洁 —— 世界级标准：测试不留垃圾） ───

let dir: string;
const dirs: string[] = [];
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'vlmconn-'));
  dirs.push(dir);
});
process.on('exit', () => {
  // 逐个清理：exit 钩子只能看到最后一次赋值的 dir，早前每测新建的目录会漏删
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

// ─── 环境变量控制：保存 → 补丁 → try/finally 恢复现场 ───

/** 受控执行 DSH_VLM_CONNECTION：undefined = 确保删除；fn 抛错也必恢复 */
function withConnEnv(value: string | undefined, fn: () => void): void {
  const saved = process.env.DSH_VLM_CONNECTION;
  try {
    if (value === undefined) delete process.env.DSH_VLM_CONNECTION;
    else process.env.DSH_VLM_CONNECTION = value;
    fn();
  } finally {
    if (saved === undefined) delete process.env.DSH_VLM_CONNECTION;
    else process.env.DSH_VLM_CONNECTION = saved;
  }
}

// ─── 假 fetch：按 URL 路由回放可控 Response / 抛错 / 挂起（超时路径用） ───

/** 单条路由：2xx JSON / 指定状态 / 原文正文（坏 JSON）/ 抛错 / 挂起（abort 时拒） */
interface Route {
  status?: number;
  body?: unknown;
  raw?: string;
  throws?: unknown;
  hang?: boolean;
}

interface FetchCall { url: string; init: RequestInit | undefined }

const OLLAMA_URL = 'http://127.0.0.1:11434/v1/models';
const LMSTUDIO_URL = 'http://127.0.0.1:1234/v1/models';
const VLLM_URL = 'http://127.0.0.1:8000/v1/models';

function fakeFetch(routes: Record<string, Route>): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    const route = routes[call.url];
    if (!route) {
      return new Response(JSON.stringify({ error: { message: `no route for ${call.url}` } }), { status: 404 });
    }
    if ('throws' in route) throw route.throws;
    if (route.hang === true) {
      // 挂起直到外层超时信号 abort（模拟无人监听的本地端口 —— 快速超时止损路径）
      return new Promise<Response>((_resolve, reject) => {
        const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
        const fire = () => {
          const e = new Error('test hang aborted');
          e.name = 'TimeoutError';
          reject(e);
        };
        if (signal && typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', () => { clearTimeout(guard); fire(); });
        }
        // AbortSignal.timeout 的内部定时器是 unref 的：它是唯一挂起物时事件循环会
        // 先一步排干（node --test 的进程隔离下即"unsettled await"翻车）。挂一个
        // ref 兜底钟保活到 abort 自然触发（正常路径 abort 先到并清钟，兜底钟不拖尾）
        const guard = setTimeout(fire, 10_000);
        guard.ref?.();
      });
    }
    const body = route.raw !== undefined ? route.raw : JSON.stringify(route.body ?? {});
    return new Response(body, { status: route.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

// ═════════════════════════ connection.ts ═════════════════════════

// ─── Λ-1a defaultConnectionPath 与构造缺省：env 覆盖 / 缺省回退 / 显式注入 ───

test('Λ-1a: defaultConnectionPath —— env 覆盖原文生效、缺省落 ~/.dsh；ConnectionStore 构造三路取径', () => {
  withConnEnv(undefined, () => {
    assert.equal(defaultConnectionPath(), path.join(homedir(), '.dsh', 'vlm-connection.json'), '缺省落 ~/.dsh/vlm-connection.json');
    assert.equal(new ConnectionStore().path, defaultConnectionPath(), '无参构造 = defaultConnectionPath()');
  });
  withConnEnv('C:/tmp/my-conn.json', () => {
    assert.equal(defaultConnectionPath(), 'C:/tmp/my-conn.json', 'env 覆盖原文生效');
    assert.equal(new ConnectionStore().path, 'C:/tmp/my-conn.json', '无参构造跟随 env');
  });
  const explicit = path.join(dir, 'explicit.json');
  assert.equal(new ConnectionStore(explicit).path, explicit, '显式注入路径优先');
});

// ─── Λ-1b load 消毒五态（一）：缺席 / 坏 JSON / 非对象 ⇒ null ───

test('Λ-1b: load —— 文件缺席 / 坏 JSON / 非对象（字符串/数字/数组）⇒ null，绝不抛', () => {
  const file = path.join(dir, 'conn.json');
  const store = new ConnectionStore(file);
  assert.equal(store.load(), null, '文件缺席 ⇒ null');
  writeFileSync(file, '{oops not json', 'utf8');
  assert.equal(store.load(), null, '坏 JSON ⇒ null');
  writeFileSync(file, '"just a string"', 'utf8');
  assert.equal(store.load(), null, 'JSON 字符串非对象 ⇒ null');
  writeFileSync(file, '123', 'utf8');
  assert.equal(store.load(), null, 'JSON 数字非对象 ⇒ null');
  writeFileSync(file, '[]', 'utf8');
  assert.equal(store.load(), null, 'JSON 数组无 platform ⇒ null');
});

// ─── Λ-1c load 消毒五态（二）：platform 非空串缺位 ⇒ null ───

test('Λ-1c: load —— platform 缺席 / 空串 / 纯空白 / 非字符串 ⇒ null；非空串 ⇒ 档位成立', () => {
  const file = path.join(dir, 'conn.json');
  const store = new ConnectionStore(file);
  writeFileSync(file, JSON.stringify({ updatedAt: 1 }), 'utf8');
  assert.equal(store.load(), null, 'platform 缺席 ⇒ null');
  writeFileSync(file, JSON.stringify({ platform: '' }), 'utf8');
  assert.equal(store.load(), null, 'platform 空串 ⇒ null');
  writeFileSync(file, JSON.stringify({ platform: '   ' }), 'utf8');
  assert.equal(store.load(), null, 'platform 纯空白 ⇒ null');
  writeFileSync(file, JSON.stringify({ platform: 42 }), 'utf8');
  assert.equal(store.load(), null, 'platform 非字符串 ⇒ null');
  writeFileSync(file, JSON.stringify({ platform: 'ollama', updatedAt: 7, via: 'wizard' }), 'utf8');
  const ok = store.load();
  assert.notEqual(ok, null, 'platform 非空串 ⇒ 档位成立');
  assert.equal(ok!.platform, 'ollama');
});

// ─── Λ-1d load 消毒五态（三）：字段级归一（空白三物料 / via 越界 / updatedAt 非有限） ───

test('Λ-1d: load —— apiKey/baseUrl/model 空白归 undefined、via 越界归 config、updatedAt 非有限归 Date.now()', () => {
  const file = path.join(dir, 'conn.json');
  const store = new ConnectionStore(file);
  const before = Date.now();
  writeFileSync(file, JSON.stringify({
    platform: 'glm',
    apiKey: '',
    baseUrl: '   ',
    model: null,
    updatedAt: 'not-a-number',
    via: 'hijack',
  }), 'utf8');
  const c = store.load();
  assert.notEqual(c, null);
  assert.equal(c!.apiKey, undefined, '空串 apiKey 归 undefined');
  assert.equal(c!.baseUrl, undefined, '纯空白 baseUrl 归 undefined');
  assert.equal(c!.model, undefined, '非字符串 model 归 undefined');
  assert.equal(c!.via, 'config', '越界 via 归 config');
  assert.ok(typeof c!.updatedAt === 'number' && Number.isFinite(c!.updatedAt), 'updatedAt 归有限数');
  assert.ok(c!.updatedAt >= before, 'updatedAt 归 Date.now()（当下而非古老时间）');
  // updatedAt 整体缺席同样归 now；合法 via / 有限 updatedAt 原样保留
  writeFileSync(file, JSON.stringify({ platform: 'qwen', via: 'auto-adopt' }), 'utf8');
  const c2 = store.load();
  assert.equal(c2!.via, 'auto-adopt', '合法 via 原样保留');
  assert.ok(c2!.updatedAt >= before, 'updatedAt 缺席归 now');
  writeFileSync(file, JSON.stringify({ platform: 'qwen', updatedAt: 42, via: 'tool' }), 'utf8');
  assert.equal(store.load()!.updatedAt, 42, '有限 updatedAt 原样保留');
});

// ─── Λ-1e save：往返 + 原子（无 .tmp 残留）+ 目录自动建 + 覆写 ───

test('Λ-1e: save —— 深目录自动建、往返无损、无 .tmp 残留、二次写覆写旧档', () => {
  const file = path.join(dir, 'nested', 'deep', 'conn.json');
  const store = new ConnectionStore(file);
  const full = {
    platform: 'qwen',
    apiKey: 'sk-dashscope-1234567890abcdef',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-vl-max',
    updatedAt: 1700000000000,
    via: 'wizard' as const,
  };
  assert.equal(store.save(full).ok, true, '父目录不存在也成功（自动建）');
  assert.equal(existsSync(file), true, '档位落盘');
  assert.equal(existsSync(file + '.tmp'), false, '原子写：无 .tmp 残留');
  assert.deepEqual(store.load(), full, 'save → load 全字段无损往返');
  // 最小档（三物料 undefined）往返：JSON 丢键、load 补 undefined —— 结构等价
  const minimal = { platform: 'ollama', updatedAt: 99, via: 'auto-adopt' as const };
  assert.equal(store.save(minimal).ok, true);
  assert.deepEqual(store.load(), {
    platform: 'ollama',
    apiKey: undefined,
    baseUrl: undefined,
    model: undefined,
    updatedAt: 99,
    via: 'auto-adopt',
  }, '最小档往返：缺省物料归 undefined');
  assert.equal(store.save(full).ok, true, '二次写覆写');
  assert.equal(store.load()!.updatedAt, 1700000000000, '旧档被新档整体替换');
});

// ─── Λ-1f save 失败面：父路径是普通文件 ⇒ ok:false + error，绝不抛 ───

test('Λ-1f: save —— 父路径被普通文件占位 ⇒ { ok:false, error } 不抛异常', () => {
  const blocker = path.join(dir, 'blocker');
  writeFileSync(blocker, 'i am a file', 'utf8');
  const store = new ConnectionStore(path.join(blocker, 'sub', 'conn.json'));
  let r: { ok: boolean; error?: string } | undefined;
  assert.doesNotThrow(() => { r = store.save({ platform: 'glm', updatedAt: 1, via: 'config' }); });
  assert.equal(r!.ok, false);
  assert.ok(typeof r!.error === 'string' && r!.error !== '', 'error 面给出失败原因');
});

// ─── Λ-1g clear：删档幂等（在场删成功 / 缺席也 ok） ───

test('Λ-1g: clear —— 缺席 ok、在场删净、再删仍 ok；删后 load 回 null', () => {
  const file = path.join(dir, 'conn.json');
  const store = new ConnectionStore(file);
  assert.equal(store.clear().ok, true, '文件缺席也 ok（幂等清理）');
  assert.equal(store.save({ platform: 'vllm', updatedAt: 5, via: 'tool' }).ok, true);
  assert.equal(existsSync(file), true);
  assert.equal(store.clear().ok, true);
  assert.equal(existsSync(file), false, '档位删净');
  assert.equal(store.load(), null, '删后 load ⇒ null');
  assert.equal(store.clear().ok, true, '再删仍 ok');
});

// ─── Λ-1h maskKey 四态：未设置 / 空串 / 短 key / 长 key（含 12/13 边界） ───

test('Λ-1h: maskKey —— 未设置、空串、≤12 前2+****、>12 前4…后4', () => {
  assert.equal(maskKey(undefined), '(未设置)');
  assert.equal(maskKey(''), '(未设置)');
  assert.equal(maskKey('shortkey9'), 'sh****', '9 字符 ⇒ 前2+****');
  assert.equal(maskKey('abcdefghijkl'), 'ab****', '恰 12 字符（边界含）⇒ 前2+****');
  assert.equal(maskKey('abcdefghijklm'), 'abcd…jklm', '恰 13 字符（边界破）⇒ 前4…后4');
  assert.equal(maskKey('sk-1234567890abcdef9876'), 'sk-1…9876', '24 字符长 key ⇒ 前4…后4');
});

// ═════════════════════════ autoAdopt.ts ═════════════════════════

// ─── Λ-1i LOCAL_CANDIDATES：本地三家按序，物料投影自 registry ───

test('Λ-1i: LOCAL_CANDIDATES —— ollama → lmstudio → vllm 三家按序、回环基址各归各位', () => {
  assert.deepEqual(LOCAL_CANDIDATES, [
    { platform: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
    { platform: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1' },
    { platform: 'vllm', baseUrl: 'http://127.0.0.1:8000/v1' },
  ]);
});

// ─── Λ-1j pickVisionModel：视觉词优先 / 排序兜底 / 空与全垃圾 null（纯函数） ───

test('Λ-1j: pickVisionModel —— 视觉词命名优先取首、无命中排序兜底、空表/全垃圾 null', () => {
  assert.equal(pickVisionModel([]), null, '空表 ⇒ null');
  assert.equal(pickVisionModel(['   ', '\t', '']), null, '全空白条目（全垃圾）⇒ null');
  assert.equal(pickVisionModel([42, null, undefined, true] as unknown as string[]), null, '全非字符串 ⇒ null');
  // 视觉词优先：表序首个命中（即便排序更靠前的纯文本模型在场）
  assert.equal(pickVisionModel(['llama3.1:8b', 'llava:13b', 'qwen2.5:7b']), 'llava:13b');
  assert.equal(pickVisionModel(['zzz-model', 'Qwen2.5-VL-7B', 'aaa']), 'Qwen2.5-VL-7B', '大小写不敏感');
  assert.equal(pickVisionModel(['minicpm-v', 'moondream']), 'minicpm-v', '多命中取表序首个');
  assert.equal(pickVisionModel(['gemma-3-27b-it', 'gemma-3-vision-12b']), 'gemma-3-vision-12b', 'gemma.*vision 家族命中');
  assert.equal(pickVisionModel(['  llava:7b  ', 42] as unknown as string[]), 'llava:7b', '垃圾条目跳过、空白容忍');
  // 无命中 ⇒ 排序后首个（确定性）：乱序输入两次结果一致
  assert.equal(pickVisionModel(['zeta', 'alpha', 'delta']), 'alpha');
  assert.equal(pickVisionModel(['delta', 'zeta', 'alpha']), 'alpha', '输入顺序不影响兜底结果（确定性）');
});

// ─── Λ-1k adoptLocalVision：首个候选命中即返（串行单发、URL 形状、无鉴权头） ───

test('Λ-1k: adoptLocalVision —— ollama 首候选命中即返：视觉词挑模、单发不越位、GET /models 无鉴权头', async () => {
  const { fetchImpl, calls } = fakeFetch({
    [OLLAMA_URL]: { body: { data: [{ id: 'llama3.1:8b' }, { id: 'llava:13b' }, { id: 'nomic-embed-text' }] } },
  });
  const r = await adoptLocalVision({ fetchImpl });
  assert.notEqual(r, null);
  assert.equal(r!.platform, 'ollama');
  assert.equal(r!.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(r!.model, 'llava:13b', '从模型表挑中视觉倾向名');
  assert.deepEqual(r!.models, ['llama3.1:8b', 'llava:13b', 'nomic-embed-text'], '完整模型表随行（原始顺序）');
  assert.ok(r!.latencyMs >= 0, 'latencyMs 为非负墙钟');
  assert.equal(calls.length, 1, '首候选命中 ⇒ 只发一次（串行不越位）');
  assert.equal(calls[0]!.url, OLLAMA_URL, 'URL = {base}/models 拼接');
  assert.equal((calls[0]!.init as { method?: string } | undefined)?.method, 'GET', 'GET 方法');
  const headers = (calls[0]!.init as { headers?: Record<string, unknown> } | undefined)?.headers ?? {};
  for (const k of Object.keys(headers)) {
    assert.ok(!/^(authorization|x-api-key|x-goog-api-key)$/i.test(k), `无鉴权头（发现 ${k}）`);
  }
});

// ─── Λ-1l 首败次中：非 2xx 静默让位，第二候选接管，未探第三 ───

test('Λ-1l: adoptLocalVision —— 首候选 404 让位、lmstudio 次中接管、vllm 不再被叩门', async () => {
  const { fetchImpl, calls } = fakeFetch({
    [OLLAMA_URL]: { status: 404, body: { error: 'not found' } },
    [LMSTUDIO_URL]: { body: { data: [{ id: 'qwen2-vl-7b-instruct' }, { id: 'phi-3-mini' }] } },
  });
  const r = await adoptLocalVision({ fetchImpl });
  assert.notEqual(r, null);
  assert.equal(r!.platform, 'lmstudio');
  assert.equal(r!.model, 'qwen2-vl-7b-instruct');
  assert.deepEqual(calls.map(c => c.url), [OLLAMA_URL, LMSTUDIO_URL], '顺序探测且止于命中');
});

// ─── Λ-1m 全败 null：三路败相（抛错 / 非 2xx / 坏 JSON）各自收敛、顺序保持 ───

test('Λ-1m: adoptLocalVision —— 全败 ⇒ null：抛错、5xx、坏 JSON 三种败相均收敛不抛', async () => {
  const EXPECTED_ORDER = [OLLAMA_URL, LMSTUDIO_URL, VLLM_URL];
  // 败相一：fetch 全抛
  const t1 = fakeFetch(Object.fromEntries(EXPECTED_ORDER.map(u => [u, { throws: new Error('ECONNREFUSED') }])));
  assert.equal(await adoptLocalVision({ fetchImpl: t1.fetchImpl }), null, '全候选抛错 ⇒ null');
  assert.deepEqual(t1.calls.map(c => c.url), EXPECTED_ORDER, '三候选按序全探');
  // 败相二：全 503
  const t2 = fakeFetch(Object.fromEntries(EXPECTED_ORDER.map(u => [u, { status: 503 }])));
  assert.equal(await adoptLocalVision({ fetchImpl: t2.fetchImpl }), null, '全候选非 2xx ⇒ null');
  // 败相三：全坏 JSON
  const t3 = fakeFetch(Object.fromEntries(EXPECTED_ORDER.map(u => [u, { raw: '<html>网关抽风</html>' }])));
  assert.equal(await adoptLocalVision({ fetchImpl: t3.fetchImpl }), null, '全候选坏 JSON ⇒ null');
});

// ─── Λ-1n 超时跳过：挂起端口（无人监听）快速止损，让位下一候选 ───

test('Λ-1n: adoptLocalVision —— 挂起候选超时止损让位、次候选接管（timeoutMs 注入生效）', async () => {
  const { fetchImpl, calls } = fakeFetch({
    [OLLAMA_URL]: { hang: true }, // 模拟无人监听 / 防火墙黑洞
    [LMSTUDIO_URL]: { body: { data: [{ id: 'moondream2' }] } },
  });
  const startedAt = Date.now();
  const r = await adoptLocalVision({ fetchImpl, timeoutMs: 120 });
  assert.notEqual(r, null, '首候选超时后次候选接管');
  assert.equal(r!.platform, 'lmstudio');
  assert.equal(r!.model, 'moondream2');
  assert.equal(calls[0]!.url, OLLAMA_URL, '挂起候选仍被按序首探');
  assert.ok(Date.now() - startedAt >= 100, '确实经历了超时等待（~120ms）而非秒判失败');
});

// ─── Λ-1o 空表 null + 候选注入：data 空数组让位全探、custom candidates 只探给定 ───

test('Λ-1o: adoptLocalVision —— 空模型表 ⇒ 全探后 null；candidates 注入只探给定集', async () => {
  const empty = fakeFetch({
    [OLLAMA_URL]: { body: { data: [] } },
    [LMSTUDIO_URL]: { body: { data: [] } },
    [VLLM_URL]: { body: { data: [] } },
  });
  assert.equal(await adoptLocalVision({ fetchImpl: empty.fetchImpl }), null, '三候选全空表 ⇒ null');
  assert.equal(empty.calls.length, 3, '空表也算探过（诚实尝试全序）');
  // 候选注入：只探给定的自定义候选（容器字段缺失的败相也让位）
  const CUSTOM_URL = 'http://127.0.0.1:9999/v1/models';
  const custom = fakeFetch({
    [CUSTOM_URL]: { body: { object: 'list', data: [{ id: 'minicpm-v' }] } },
  });
  const r = await adoptLocalVision({
    fetchImpl: custom.fetchImpl,
    candidates: [{ platform: 'custom-local', baseUrl: 'http://127.0.0.1:9999/v1/' }],
  });
  assert.notEqual(r, null);
  assert.equal(r!.platform, 'custom-local');
  assert.equal(r!.model, 'minicpm-v');
  assert.deepEqual(custom.calls.map(c => c.url), [CUSTOM_URL], '尾斜杠基址归一拼 /models、只探注入候选');
});

// ─── Λ-1p 绝不抛：恶意 fetch（同步抛 / 异步拒 / 返回垃圾）全部收敛 null ───

test('Λ-1p: adoptLocalVision —— 恶意 fetch 同步抛 / 异步拒 / 返回垃圾对象 ⇒ 收敛 null 绝不抛', async () => {
  // 直接 await：若实现抛错，测试即失败（绝不抛的执法就是让抛错无处可逃）
  const syncThrow = (() => { throw new Error('malicious sync'); }) as unknown as typeof fetch;
  assert.equal(await adoptLocalVision({ fetchImpl: syncThrow }), null, '同步抛 ⇒ null');
  const asyncReject = (async () => { throw new Error('malicious async'); }) as unknown as typeof fetch;
  assert.equal(await adoptLocalVision({ fetchImpl: asyncReject }), null, '异步拒 ⇒ null');
  const garbage = (async () => 'not-a-response') as unknown as typeof fetch;
  assert.equal(await adoptLocalVision({ fetchImpl: garbage }), null, '非 Response 垃圾返回 ⇒ null');
});
