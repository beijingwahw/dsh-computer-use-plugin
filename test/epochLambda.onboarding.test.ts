// test/epochLambda.onboarding.test.ts
// 纪元 Λ（Λ-4 开箱即亮）：解析链进 apply() 生命周期的集成验证 —— 全离线。
// lightUpVision（src/index.ts 可测导出）经 deps 注入假件覆盖五级链语义：
//   Λ-4①  存档命中 ⇒ applyConnection 热应用（单例重铸 + 状态日志），不触发 adopt/server
//   Λ-4②  存档空 + 本地命中 ⇒ via:'auto-adopt' 存档 + 应用 + 「已自动接管」日志
//   Λ-4③  全空 + 向导开启 ⇒ server/opener 被调（回环 URL、port 透传、onConnect 注入）
//   Λ-4④  vlmOnboardingEnabled=false ⇒ 不弹不炸；探测/向导供给抛错也全吞
//   Λ-4⑤  onConnect 回调链 —— 向导服务契约（先存档后回调）⇒ 热应用 ⇒ 迟到注册
//          （假 ctx.tools.register 计数 + systemPrompt 段 order 13；宿主面缺席诚实 log）
//   Λ-4⑥  config 三字段 Schema 缺省（true/true/18432）
//   Λ-4⑦  ask_screen 未配置降级 —— next_step 指路 vlm_wizard（行为断言）
//   Λ-4红线 apply() 的 fire-and-forget 接线（源级断言）+ 探测失败/向导启动失败不炸（行为断言）
// 铁律：绝不联网、绝不弹真浏览器、绝不写真存档（store 全注入）；env 保存/恢复法隔离。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Config } from '../src/config.ts';
import type { VisionConnection } from '../src/vlm/connection.ts';
import type { AdoptedLocal } from '../src/vlm/autoAdopt.ts';
import type { OnboardingHandle } from '../src/vlm/onboarding.ts';

const { lightUpVision } = await import('../src/index.ts');
const { Config: ConfigSchema } = await import('../src/config.ts');
const { getGlmClient, isGlmConfigured, resetGlmClient } = await import('../src/vlm/glmClient.ts');
const { PLATFORM_PRESETS } = await import('../src/vlm/providers/registry.ts');
const { createAskScreenTool } = await import('../src/tools/askScreen.ts');

// ─── env 隔离（全部 13 平台 envKeys + GLM 专属覆盖，保存/恢复法） ───

const SCRUB_ENV = [...new Set([
  ...PLATFORM_PRESETS.flatMap(p => [...p.envKeys]),
  'GLM_BASE_URL', 'GLM_VLM_MODEL',
])];
const savedEnv = SCRUB_ENV.map(k => [k, process.env[k]] as const);
function scrubEnv(): void {
  for (const k of SCRUB_ENV) delete process.env[k];
}
scrubEnv();
after(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetGlmClient();
});

// ─── 假件工坊 ───

/** 假存档仓：load 返回预置值；save 记录全部写入（绝不落盘） */
function fakeStore(loaded: VisionConnection | null) {
  const saves: VisionConnection[] = [];
  return {
    saves,
    store: {
      load: () => loaded,
      save: (conn: VisionConnection) => { saves.push(conn); return { ok: true }; },
    },
  };
}

/** 假宿主 ctx：tools.register 计数 + systemPrompt.section 记录（迟到注册取证面） */
function fakeCtx(withSurfaces = true) {
  const registered: Array<{ name?: string }> = [];
  const sections: Array<{ name: string; order: number; text: string }> = [];
  const ctx = withSurfaces
    ? {
        tools: { register: (t: unknown) => { registered.push({ name: (t as { name?: string })?.name }); } },
        get: (name: string) =>
          name === 'systemPrompt' ? { section: (o: { name: string; order: number; text: string }) => { sections.push(o); } } : undefined,
      }
    : {};
  return { ctx, registered, sections };
}

/** 假本地接管产物（AdoptedLocal 全套物料） */
const ADOPTED: AdoptedLocal = {
  platform: 'ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen2.5vl',
  models: ['qwen2.5vl', 'llama3.2'],
  latencyMs: 9,
};

/** 假向导服务：记录调用 opts，返回固定回环 handle（绝不真起 HTTP） */
function fakeServer(url = 'http://127.0.0.1:18432/') {
  const calls: Array<{ port?: number; deps?: { onConnect?: (c: VisionConnection) => Promise<void> } }> = [];
  const handle: OnboardingHandle = {
    port: 18432, url, closed: false,
    // ΠΑΝ-20：假 handle 补 nonce 字段（OnboardingHandle 契约新增 —— 假件同形）
    nonce: '0'.repeat(64),
    close: async () => { /* 假件无需真关 */ },
  };
  const server = async (opts: { port?: number; deps?: { onConnect?: (c: VisionConnection) => Promise<void> } }) => {
    calls.push(opts);
    return handle;
  };
  return { server, calls, handle };
}

/** 假 opener：记录全部 URL（绝不唤起真浏览器） */
function fakeOpener() {
  const urls: string[] = [];
  return { urls, opener: async (url: string) => { urls.push(url); return { method: 'fake' }; } };
}

/** lightUpVision 的最小 config（三 Λ 字段齐备，可局部覆盖） */
function luConfig(over: Partial<Config> = {}): Config {
  return {
    vlmApiKey: '',
    vlmProvider: '',
    vlmAutoAdoptLocal: true,
    vlmOnboardingEnabled: true,
    vlmOnboardingPort: 18432,
    ...over,
  } as Config;
}

/** 每用例统一的单例/env 复位 */
function resetVlm(): void {
  scrubEnv();
  resetGlmClient();
}

// ─── Λ-4① 存档命中 ⇒ 热应用，不探测不弹窗 ───

test('Λ-4①: 存档命中 ⇒ applyConnection 重铸单例 + 状态日志；adopt/server 零调用', async () => {
  resetVlm();
  try {
    const conn: VisionConnection = { platform: 'glm', apiKey: 'saved-key-123456', updatedAt: 1, via: 'wizard' };
    const { store } = fakeStore(conn);
    let adoptCalls = 0;
    const { server, calls: serverCalls } = fakeServer();
    const { urls, opener } = fakeOpener();
    const logs: string[] = [];

    await lightUpVision(fakeCtx().ctx, luConfig(), {
      store,
      adopt: async () => { adoptCalls++; return null; },
      server,
      opener,
      log: m => logs.push(m),
    });

    // applyConnection 被调：单例按存档物料重铸（platform/configured 即证）
    const client = getGlmClient();
    assert.equal(client.platform, 'glm', '单例应以存档 platform 重铸');
    assert.equal(isGlmConfigured(), true, 'apiKey 在档 ⇒ 配置哨兵变真');
    // 解析链短路：不探测、不弹窗
    assert.equal(adoptCalls, 0, '存档命中后不得再触发本地探测');
    assert.equal(serverCalls.length, 0, '存档命中后不得再起向导');
    assert.equal(urls.length, 0, '存档命中后不得弹浏览器');
    // 状态日志（经 deps.log 断言 applyConnection 生效面）
    assert.ok(logs.some(l => l.includes('视觉连接已生效') && l.includes('glm')), '应打印连接生效状态行');
  } finally {
    resetVlm();
  }
});

// ─── Λ-4② 存档空 + 本地命中 ⇒ auto-adopt 存档 + 应用 ───

test('Λ-4②: 存档空 + 本地探测命中 ⇒ via:"auto-adopt" 存档 + 单例应用 + 接管日志；不起向导', async () => {
  resetVlm();
  try {
    const { store, saves } = fakeStore(null);
    const { server, calls: serverCalls } = fakeServer();
    const { urls, opener } = fakeOpener();
    const logs: string[] = [];

    await lightUpVision(fakeCtx().ctx, luConfig(), {
      store,
      adopt: async () => ADOPTED,
      server,
      opener,
      log: m => logs.push(m),
    });

    assert.equal(saves.length, 1, '本地接管必须落档（下会话免再探）');
    assert.equal(saves[0].via, 'auto-adopt', '归因字段 via = auto-adopt');
    assert.equal(saves[0].platform, 'ollama');
    assert.equal(saves[0].model, 'qwen2.5vl');
    assert.equal(saves[0].baseUrl, 'http://127.0.0.1:11434/v1');
    assert.equal(getGlmClient().platform, 'ollama', '单例应以接管平台重铸');
    assert.equal(serverCalls.length, 0, '本地接管成功后不得再起向导');
    assert.equal(urls.length, 0);
    assert.ok(logs.some(l => l.includes('已自动接管本地视觉服务 <ollama>')), '应打印「已自动接管」状态行');
  } finally {
    resetVlm();
  }
});

// ─── Λ-4③ 全空 + 向导开启 ⇒ server + opener 被调（回环 URL） ───

test('Λ-4③: 存档空 + 探测空 + 向导开启 ⇒ 假 server/opener 被调；port 透传、onConnect 注入、URL 回环', async () => {
  resetVlm();
  try {
    const { store } = fakeStore(null);
    const { server, calls } = fakeServer();
    const { urls, opener } = fakeOpener();
    const logs: string[] = [];

    await lightUpVision(fakeCtx().ctx, luConfig(), {
      store,
      adopt: async () => null,
      server,
      opener,
      log: m => logs.push(m),
    });

    assert.equal(calls.length, 1, '向导服务恰好启动一次');
    assert.equal(calls[0].port, 18432, 'config.vlmOnboardingPort 必须透传给向导服务');
    assert.equal(typeof calls[0].deps?.onConnect, 'function', 'onConnect 热应用回调必须注入');
    assert.equal(urls.length, 1, '浏览器 opener 恰好调用一次');
    assert.match(urls[0], /127\.0\.0\.1:18432\//, '向导地址必须是本机回环');
    assert.ok(logs.some(l => l.includes('连接向导已启动') && l.includes('127.0.0.1')), '应打印向导地址（用户可手动访问）');
  } finally {
    resetVlm();
  }
});

// ─── Λ-4④ 向导关闭 ⇒ 不弹；供给面抛错 ⇒ 全吞不炸 ───

test('Λ-4④: vlmOnboardingEnabled=false ⇒ server/opener 零调用；探测抛错也不炸', async () => {
  resetVlm();
  try {
    // a) 向导关闭：全链安静走完
    const { store } = fakeStore(null);
    const { server, calls } = fakeServer();
    const { urls, opener } = fakeOpener();
    await lightUpVision(fakeCtx().ctx, luConfig({ vlmOnboardingEnabled: false }), {
      store,
      adopt: async () => null,
      server,
      opener,
      log: () => {},
    });
    assert.equal(calls.length, 0, '向导关闭 ⇒ 不得起服务');
    assert.equal(urls.length, 0, '向导关闭 ⇒ 不得弹浏览器');

    // b) 探测供给直接抛错 + 向导开启但服务供给 reject：lightUpVision 仍安静兑现
    const { server: badServer, calls: badCalls } = fakeServer();
    const { urls: badUrls, opener: badOpener } = fakeOpener();
    await lightUpVision(fakeCtx().ctx, luConfig(), {
      store: fakeStore(null).store,
      adopt: async () => { throw new Error('probe exploded'); },
      server: async () => { throw new Error('port-range-exhausted'); },
      opener: badOpener,
      log: () => {},
    });
    assert.equal(badCalls.length, 0);
    assert.equal(badUrls.length, 0, '服务启动失败 ⇒ opener 不可达');
  } finally {
    resetVlm();
  }
});

// ─── Λ-4⑤ onConnect 回调链：存档（向导服务契约）⇒ 热应用 ⇒ 迟到注册 ───

test('Λ-4⑤: onConnect 链 —— 假 store 保存 + applyConnection 重铸 + 迟到注册（register 计数 + 提示词段）；宿主面缺席诚实 log', async () => {
  resetVlm();
  try {
    // 起「向导」：捕获 lightUpVision 注入的 opts（含 onConnect）
    const { store, saves } = fakeStore(null);
    const { server, calls } = fakeServer();
    const logs: string[] = [];
    const host = fakeCtx(true);
    await lightUpVision(host.ctx, luConfig(), {
      store,
      adopt: async () => null,
      server,
      opener: async () => ({ method: 'fake' }),
      log: m => logs.push(m),
    });
    const onConnect = calls[0]?.deps?.onConnect;
    assert.equal(typeof onConnect, 'function');

    // 模拟向导 /api/connect 契约：先存档（via:'wizard'）后回调热应用
    const wizardConn: VisionConnection = { platform: 'anthropic', apiKey: 'ak-ant-key-123456', updatedAt: 2, via: 'wizard' };
    store.save(wizardConn);
    await onConnect!(wizardConn);

    assert.equal(saves.length, 1, '向导服务契约：连接先落档');
    assert.equal(saves[0].via, 'wizard');
    assert.equal(getGlmClient().platform, 'anthropic', 'onConnect 必须热应用（单例重铸）');
    // 迟到注册：ask_screen 工具 + vlm 提示词段（order 13）
    assert.equal(host.registered.length, 1, '迟到注册恰好挂一个工具');
    assert.equal(host.registered[0].name, 'ask_screen');
    assert.equal(host.sections.length, 1, '迟到注册恰好注入一个提示词段');
    assert.equal(host.sections[0].name, 'vlm-ask-screen-rules');
    assert.equal(host.sections[0].order, 13);
    assert.ok(host.sections[0].text.includes('vlm_wizard'), '提示词段应含向导用法声明');
    assert.ok(!logs.some(l => l.includes('重载插件后生效')), '宿主面在场 ⇒ 不得报「重载后生效」');

    // 宿主面缺席臂：ctx 无 tools/systemPrompt ⇒ onConnect 仍安静兑现 + 诚实 log
    const bare = fakeCtx(false);
    const logs2: string[] = [];
    const captured = fakeServer();
    await lightUpVision(bare.ctx, luConfig(), {
      store: fakeStore(null).store,
      adopt: async () => null,
      server: captured.server,
      opener: async () => ({ method: 'fake' }),
      log: m => logs2.push(m),
    });
    await captured.calls[0].deps!.onConnect!(wizardConn);
    assert.equal(bare.registered.length, 0, '宿主面缺席 ⇒ 无工具可挂');
    assert.ok(logs2.some(l => l.includes('连接已保存，重载插件后生效')), '宿主面缺席 ⇒ 诚实 log 一句');
  } finally {
    resetVlm();
  }
});

// ─── Λ-4⑥ config 三字段缺省值（Schema 缺省） ───

test('Λ-4⑥: Schema 缺省 —— vlmAutoAdoptLocal=true / vlmOnboardingEnabled=true / vlmOnboardingPort=18432', () => {
  // schemastery 对象运行时可调用但类型面无 call signature —— 宿主侧同法（cordis 配置解析）
  const resolve = ConfigSchema as unknown as (v: unknown) => Config;
  const cfg = resolve({});
  assert.equal(cfg.vlmAutoAdoptLocal, true, '本地自动接管缺省开（开箱即亮主路径）');
  assert.equal(cfg.vlmOnboardingEnabled, true, '向导弹出缺省开');
  assert.equal(cfg.vlmOnboardingPort, 18432, '向导缺省端口 18432');
});

// ─── Λ-4⑦ ask_screen 降级指路 vlm_wizard（行为断言） ───

test('Λ-4⑦: ask_screen 未配置降级 —— next_step 含 vlm_wizard 指引（无模型时模型知道往哪指路）', async () => {
  resetVlm();
  try {
    assert.equal(isGlmConfigured(), false, '前提：无 env 无单例 ⇒ 未配置');
    const tool = createAskScreenTool({} as Config);
    // execute 的 (args, exec) 双参面：exec 在测试里传 undefined（vlm.integration 同律）
    const run = tool as unknown as { execute: (a: unknown, e: unknown) => Promise<unknown> };
    const out = JSON.parse(String(await run.execute({ question: '这是什么页面？' }, undefined)));
    assert.equal(out.status, 'FAILED');
    assert.match(out.state_anchor.error, /not configured/i);
    assert.match(out.next_step, /vlm_wizard/, '降级 next_step 必须指路 vlm_wizard');
  } finally {
    resetVlm();
  }
});

// ─── Λ-4 红线：fire-and-forget 接线 + 缺省路径行为零变化 ───

test('Λ-4红线: apply() 以 void…catch fire-and-forget 调 lightUpVision；五级门 = 无 key 无 provider 无已配置', async () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(
    src,
    /if\s*\(!config\.vlmApiKey\s*&&\s*!config\.vlmProvider\s*&&\s*!isGlmConfigured\(\)\)\s*\{\s*void lightUpVision\(ctx, config\)\.catch\(\(\)\s*=>\s*\{\}\);/s,
    'apply 必须以 fire-and-forget（void + .catch）调 lightUpVision —— 装载绝不等待解析链',
  );
  // 行为面：链内各级故障已被 ④ 覆盖；此处补「缺省三档全在场却全失败」的合流臂
  resetVlm();
  try {
    const logs: string[] = [];
    await lightUpVision(fakeCtx().ctx, luConfig(), {
      store: { load: () => { throw new Error('archive corrupted'); }, save: () => ({ ok: true }) },
      adopt: async () => { throw new Error('network gone'); },
      server: async () => { throw new Error('port-range-exhausted'); },
      opener: async () => { throw new Error('no shell'); },
      log: m => logs.push(m),
    });
    assert.ok(true, '三级全炸 ⇒ lightUpVision 仍安静兑现（apply 侧 .catch 双保险）');
  } finally {
    resetVlm();
  }
});
