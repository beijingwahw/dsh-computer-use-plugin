// test/vlm.tools.test.ts
// 纪元 Λ（Λ-3 开箱即亮）：switch_vision_model / vlm_wizard 两工具 —— 全离线验证。
// 假探针（probe）、临时真档（ConnectionStore + mkdtemp）、假热应用（apply 捕获）、
// 假 opener、假向导服务（server 计数）五件套：零真网络、零真浏览器、零真换脑。
//   Λ-3①  switch 成功全链 —— 假 probe ok + 临时档 + 假 apply 收到 {platform,apiKey,...}；
//          落档 via:'tool'；锚点 mask 不含全钥（密钥卫生律）
//   Λ-3②  未知 platform ⇒ toolErr 含合法 id 清单（绝不静默换脑）
//   Λ-3③  probe 失败 ⇒ toolErr 含 detail；next_step 建议 vlm_wizard；零落档
//   Λ-3④  apply 抛错 ⇒ toolErr 诚实（切换失败不谎报成功）—— 但存档已写（save→apply→toolOk 序）
//   Λ-3⑤  vlm_wizard —— 假 opener 收 127.0.0.1 地址；二次调用复用模块级单例（server 计数恰 1）
//   Λ-3⑥  opener dry-run ⇒ note 注记 dryRun（守卫拦截绝不谎报已打开）
//   Λ-3⑦  tools/index.ts 源码取证 —— 两工具恒注册新块在 vlmPlatforms 块之后另起，
//          askScreen 挂载门原行未动（vlm.integration.test.ts:242 正则同源）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config } from '../src/config.ts';
import { ConnectionStore, maskKey } from '../src/vlm/connection.ts';
import type { OnboardingHandle } from '../src/vlm/onboarding.ts';
import { createSwitchVisionModelTool, type VlmConnectDeps } from '../src/tools/vlmConnect.ts';
import {
  createVlmWizardTool,
  _resetVlmWizardForTest,
  type VlmWizardDeps,
} from '../src/tools/vlmWizard.ts';

// ─── 假件工坊 ───

/** 工具执行捷径（execute(args, undefined) → 解析四件套 JSON） */
type ToolLike = { execute: (a: unknown, e: unknown) => Promise<unknown> };
async function runTool(tool: ToolLike, args: unknown): Promise<any> {
  return JSON.parse(String(await tool.execute(args, undefined)));
}

/** 假探针 —— ok 臂（固定延迟；绝不触网：收到 provider 也不 chat） */
function fakeProbeOk(latencyMs = 87): { probe: VlmConnectDeps['probe']; seen: unknown[] } {
  const seen: unknown[] = [];
  const probe = async (provider: unknown) => {
    seen.push((provider as { id?: unknown } | null)?.id ?? null);
    return { id: 'openai', ok: true, latencyMs, detail: `通了：${latencyMs}ms 回复「ok」`, visionGuessed: true };
  };
  return { probe, seen };
}

/** 假探针 —— 失败臂（detail 透传取证） */
function fakeProbeFail(detail: string): VlmConnectDeps['probe'] {
  return async () => ({ id: 'openai', ok: false, latencyMs: 5, detail, visionGuessed: false });
}

/** 临时真档仓（mkdtemp 真文件 IO；用后即焚） */
function tempStore(): { store: ConnectionStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'vlm-tools-'));
  const store = new ConnectionStore(join(dir, 'vlm-connection.json'));
  return { store, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力 */ } } };
}

/** 平台 env 键快照/恢复（resolveProviderConfig 会读 env —— 测试确定性前提） */
const ENV_KEYS = ['OPENAI_API_KEY', 'GLM_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'] as const;
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

/** 测试全程使用的长钥（>12 字符走「前 4 … 后 4」打码路） */
const LONG_KEY = 'sk-live-abcdef1234567890fedcba';

/** 一次性动态口（真 listen(0) 摊派后即关 —— 仅取号不占坑；先例 epochMu2.aggregate.test.ts） */
function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

// ─── Λ-3① switch 成功全链 ───

test('Λ-3①: switch_vision_model 成功 —— 假 probe ok + 临时档 + 假 apply；via:tool + 锚点不含全钥', async () => {
  const saved = snapshotEnv();
  const tmp = tempStore();
  try {
    clearEnvKeys();
    const { probe, seen } = fakeProbeOk(123);
    const applied: unknown[] = [];
    const tool = createSwitchVisionModelTool({} as Config, {
      probe,
      store: tmp.store,
      apply: async (opts) => { applied.push(opts); },
    });

    const out = await runTool(tool, { platform: 'openai', api_key: LONG_KEY, model: 'gpt-4o' });
    assert.equal(out.status, 'SUCCESS', JSON.stringify(out));
    assert.match(out.action, /switch_vision_model/);
    assert.equal(out.state_anchor.platform, 'openai');
    assert.equal(out.state_anchor.model, 'gpt-4o');
    assert.equal(out.state_anchor.latency_ms, 123);
    assert.equal(out.state_anchor.persisted, true);
    // 密钥卫生律：锚点只有打码形（与真 maskKey 同形），整份回执绝不含全钥
    assert.equal(out.state_anchor.masked_key, maskKey(LONG_KEY));
    assert.notEqual(out.state_anchor.masked_key, LONG_KEY);
    assert.ok(!JSON.stringify(out).includes(LONG_KEY), '回执任何位置不得泄漏全钥');

    // 假 apply 收到热应用物料（platform/apiKey/model 直传；baseUrl 缺席走 getGlmClient 内部回退）
    assert.equal(applied.length, 1);
    assert.deepEqual(applied[0], { platform: 'openai', apiKey: LONG_KEY, model: 'gpt-4o' });

    // 探针收到的 provider 已按 preset.protocol 铸好（id = 平台 id）
    assert.deepEqual(seen, ['openai']);

    // 临时真档：via:'tool' 落册（与 wizard/auto-adopt 同册）
    const conn = tmp.store.load();
    assert.ok(conn, '连接档案必须已写入');
    assert.equal(conn!.platform, 'openai');
    assert.equal(conn!.via, 'tool');
    assert.equal(conn!.apiKey, LONG_KEY);
    assert.equal(conn!.model, 'gpt-4o');
    assert.equal(conn!.baseUrl, 'https://api.openai.com/v1');
  } finally {
    tmp.cleanup();
    restoreEnv(saved);
  }
});

// ─── Λ-3② 未知 platform ───

test('Λ-3②: switch_vision_model 未知 platform ⇒ toolErr 含合法 id 清单（不静默换脑）', async () => {
  const tmp = tempStore();
  try {
    const tool = createSwitchVisionModelTool({} as Config, {
      probe: fakeProbeOk().probe,
      store: tmp.store,
      apply: async () => { throw new Error('不得触达'); },
    });
    const out = await runTool(tool, { platform: 'nopenai-not-a-brain' });
    assert.equal(out.status, 'FAILED');
    assert.match(out.action, /switch_vision_model/);
    // 合法清单必须在场（抽三个代表：首位 glm / 云端 openrouter / 本地 ollama）
    assert.match(out.state_anchor.error, /unknown platform/i);
    for (const id of ['glm', 'openai', 'openrouter', 'ollama']) {
      assert.ok(String(out.state_anchor.error).includes(id), `合法清单须含 ${id}`);
    }
    // 拒绝即零副作用：不探活、不落档
    assert.equal(tmp.store.load(), null);
  } finally {
    tmp.cleanup();
  }
});

// ─── Λ-3③ probe 失败 ───

test('Λ-3③: switch_vision_model probe 失败 ⇒ toolErr 含 detail + next_step 建议 vlm_wizard；零落档', async () => {
  const saved = snapshotEnv();
  const tmp = tempStore();
  try {
    clearEnvKeys();
    const tool = createSwitchVisionModelTool({} as Config, {
      probe: fakeProbeFail('失败（HTTP 401）：invalid api key'),
      store: tmp.store,
      apply: async () => { throw new Error('不得触达'); },
    });
    const out = await runTool(tool, { platform: 'openai', api_key: LONG_KEY });
    assert.equal(out.status, 'FAILED');
    assert.match(out.action, /switch_vision_model/);
    assert.match(out.state_anchor.error, /HTTP 401/, 'error 必须含 probe.detail');
    assert.match(out.state_anchor.error, /invalid api key/);
    assert.match(out.next_step, /vlm_wizard/, '恢复路径必须建议向导');
    // 探活不通 ⇒ 零落档零热应用
    assert.equal(tmp.store.load(), null, 'probe 失败不得写档');
  } finally {
    tmp.cleanup();
    restoreEnv(saved);
  }
});

// ─── Λ-3④ apply 抛错（诚实律：save→apply→toolOk 序） ───

test('Λ-3④: switch_vision_model apply 抛错 ⇒ toolErr 如实报错并注明存档已写（不谎报成功）', async () => {
  const saved = snapshotEnv();
  const tmp = tempStore();
  try {
    clearEnvKeys();
    const tool = createSwitchVisionModelTool({} as Config, {
      probe: fakeProbeOk().probe,
      store: tmp.store,
      apply: async () => { throw new Error('mint exploded'); },
    });
    const out = await runTool(tool, { platform: 'openai', api_key: LONG_KEY });
    assert.equal(out.status, 'FAILED', '热应用失败不得报 SUCCESS');
    assert.match(out.state_anchor.error, /mint exploded/);
    // 诚实交代：档案已持久化（save 先于 apply —— 重启后仍会被收养）
    assert.match(out.state_anchor.error, /persisted|已写入|存档/, '错误面必须注明存档已写');
    const conn = tmp.store.load();
    assert.ok(conn, 'save→apply 序：apply 抛错时档案已落盘');
    assert.equal(conn!.via, 'tool');
  } finally {
    tmp.cleanup();
    restoreEnv(saved);
  }
});

// ─── Λ-3⑤ vlm_wizard：单例复用 + opener 收回环地址 ───

test('Λ-3⑤: vlm_wizard —— opener 收 127.0.0.1 地址；二次调用复用模块级单例（server 计数恰 1）', async () => {
  _resetVlmWizardForTest();
  const wizPort = await ephemeralPort(); // 动态口（旧 8931 固定字面量已退役 —— 防环境撞口）
  const wizUrl = `http://127.0.0.1:${wizPort}/wizard`;
  try {
    let serverCalls = 0;
    const fakeHandle: OnboardingHandle = {
      port: wizPort,
      url: wizUrl,
      closed: false,
      close: async () => { fakeHandle.closed = true; },
    };
    const server = async (): Promise<OnboardingHandle> => { serverCalls++; return fakeHandle; };
    const openedUrls: string[] = [];
    const opener = async (url: string) => { openedUrls.push(url); return { method: 'shell:start' }; };

    const tool = createVlmWizardTool({} as Config, { server, opener });
    const out1 = await runTool(tool, {});
    const out2 = await runTool(tool, {});

    for (const out of [out1, out2]) {
      assert.equal(out.status, 'SUCCESS', JSON.stringify(out));
      assert.equal(out.state_anchor.url, wizUrl);
      assert.equal(out.state_anchor.port, wizPort);
      assert.match(out.state_anchor.note, /手动访问/);
    }
    // 单例复用：两次调用只起一次服务；浏览器各开一次（同地址）
    assert.equal(serverCalls, 1, '向导服务必须复用模块级单例，绝不双起');
    assert.deepEqual(openedUrls, [wizUrl, wizUrl]);
    assert.match(openedUrls[0], /127\.0\.0\.1/, '向导地址必须是本机回环');
  } finally {
    _resetVlmWizardForTest();
  }
});

// ─── Λ-3⑥ opener dry-run 注记 ───

test('Λ-3⑥: vlm_wizard opener 返回 dry-run ⇒ note 注明 dryRun（守卫拦截绝不谎报已打开）', async () => {
  _resetVlmWizardForTest();
  const dryPort = await ephemeralPort(); // 动态口（旧 8932 固定字面量已退役）
  try {
    const server = async (): Promise<OnboardingHandle> => ({
      port: dryPort,
      url: `http://127.0.0.1:${dryPort}/wizard`,
      closed: false,
      close: async () => { /* 假 handle：无事可关 */ },
    });
    const opener = async (_url: string) => ({ method: 'dry-run' });
    const tool = createVlmWizardTool({} as Config, { server, opener });

    const out = await runTool(tool, {});
    assert.equal(out.status, 'SUCCESS');
    assert.match(out.state_anchor.note, /dry-?run/i, 'note 必须注明 dry-run');
    assert.match(out.state_anchor.note, /dryRun/, '注记须点名 dryRun 守卫');
  } finally {
    _resetVlmWizardForTest();
  }
});

// ─── Λ-3⑦ tools/index.ts 注册取证（源码正则 —— 同桶运行时导入不可行，epochR/Σ-7⑤ 先例） ───

test('Λ-3⑦: tools/index.ts —— 两工具恒注册新块在 vlmPlatforms 块之后另起；askScreen 挂载门原行未动', async () => {
  const src = readFileSync(new URL('../src/tools/index.ts', import.meta.url), 'utf8');

  // askScreen 挂载门原行未动（vlm.integration.test.ts:242 同源正则锁定立法文本 —— 不许动）
  assert.match(
    src,
    /if\s*\(config\.vlmApiKey\s*\|\|\s*isGlmConfigured\(\)\)\s*\{\s*[^}]*createAskScreenTool/s,
    'ask_screen 挂载门原样',
  );

  // 两工具导入行在场
  assert.match(src, /import \{ createSwitchVisionModelTool \} from '\.\/vlmConnect';/, 'vlmConnect 导入在场');
  assert.match(src, /import \{ createVlmWizardTool \} from '\.\/vlmWizard';/, 'vlmWizard 导入在场');

  // 恒注册：语句级无条件 push（行首恰好两空格缩进 + 行尾即分号 —— 不在任何 if 体内）
  const sw = src.match(/^  tools\.push\(createSwitchVisionModelTool\(config\)\);$/m);
  const wz = src.match(/^  tools\.push\(createVlmWizardTool\(config\)\);$/m);
  assert.ok(sw, 'switch_vision_model 无条件注册（恒挂载，无配置门）');
  assert.ok(wz, 'vlm_wizard 无条件注册（恒挂载，无配置门）');

  // 顺序：vlmPlatforms 注册块之后另起新块（且 askScreen 门在其前未被移动进新块）
  const vpIdx = src.indexOf('tools.push(createVlmPlatformsTool(config));');
  assert.ok(vpIdx >= 0 && vpIdx < sw!.index!, '新块必须在 vlmPlatforms 注册块之后另起');
  assert.ok(sw!.index! < wz!.index!, 'switch_vision_model 先于 vlm_wizard 注册');
  assert.ok(src.indexOf('createAskScreenTool(config)') < vpIdx, 'askScreen 门仍在 vlmPlatforms 块之前（原结构未动）');
});
