// test/w9deploy.test.ts
// W9-2（落锤代理）执法册：三条「需部署决策」债的保守立法把守 ——
//   ① D-C1 外部策略表装载面（reversalEscrow.loadExternalStrategyTable）：
//      正：好表一次原子落两表（escrow 扩展表 + riskGate 分级注册表同步登记）、
//      铸造/查询/分级三面可用、内置表逐字节不动；反：坏表矩阵（读故障/坏
//      JSON/坏形状/坏条目/内置冲突/重复键）全拒 + 全有或全无（一条坏件 ⇒ 好
//      条目也不入表）；双侧对齐律逐键复验（compensate ⇔ compensable；
//      manual-only ⇔ irreversible）；缺省不变（零调用 = 零变化）；
//   ② D-C2 federation-server 生产化 env 面：缺省行为不变断言（无 env ⇒ 与
//      参考实现逐字节同行为）+ PORT/MAX_BODY/BARRIER_TTL/持久化逐项执法 +
//      优雅关停（POSIX 行为 + 立法在源 —— win32 不投递 SIGTERM 的诚实分层）；
//   ③ D-C5 barrier HMAC 扩面：token 模式下三端点缺省要求签名（无签/坏签/
//      换体 ⇒ 401；带签 ⇒ 领域流全通）；FED_ALLOW_OPEN_BARRIER=1 兼容模式
//      （barrier 开、aggregate 仍签）；带签 barrier 客户端双端往返（现有
//      makeHttpBarrierTransport 注入缝 + federationAuthHeaders —— 无需改源）。
// 全程：D-C1 段离线确定性（tmp 目录）；server 段环回子进程（环境不支持 ⇒
// 诚实 skip，epochMu2/w5cross 同律）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import {
  reversalEscrow, loadExternalStrategyTable, builtinCompensationSemantics, compensationPathOf,
} from '../src/reversalEscrow.ts';
import { reversibilityRegistry } from '../src/riskGate.ts';
import { makeHttpBarrierTransport, createBarrierClient, type BarrierFetch, type BarrierRequest } from '../src/crossMachine.ts';
import { federationAuthHeaders } from '../src/federation/index.ts';

// ═══ ① D-C1：外部策略表装载面（离线确定性）═══

const dirs: string[] = [];
process.on('exit', () => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

/** tmp 目录里写一张表文件，返回绝对路径 */
function writeTable(name: string, content: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'w9deploy-'));
  dirs.push(dir);
  const p = path.join(dir, name);
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return p;
}

/** 好表（3 条：2 compensate + 1 manual-only —— 覆盖两级派生） */
const GOOD_TABLE = {
  version: 1,
  strategies: [
    {
      kind: 'compensate', semantics: 'volume-change',
      steps: [{ method: 'hotkey', label: 'restore volume level', keys: ['ctrl', 'shift', 'arrowdown'] }],
      verify: { mode: 'screen-hash' },
    },
    {
      kind: 'compensate', semantics: 'window-close',
      steps: [
        { method: 'custom', label: 'reopen window by title', target: 'Window - Drafts' },
        { method: 'hotkey', label: 'Ctrl+Shift+T reopen tab', keys: ['ctrl', 'shift', 't'] },
      ],
      verify: { mode: 'none' },
    },
    {
      kind: 'manual-only', semantics: 'account-signout',
      reason: 'signing out kills sessions — re-login is a new auth handshake, not an undo',
    },
  ],
};

/** 装载前的内置表快照（「内置表不变」断言的锚） */
const BUILTIN_BEFORE = builtinCompensationSemantics();

beforeEach(() => {
  reversalEscrow.reset();
  reversibilityRegistry.reset();
});

test('W9-2 D-C1-①a 正：好表一次原子落两表；铸造/查询/分级三面可用；内置表逐字节不动', async () => {
  const r = loadExternalStrategyTable(writeTable('good.json', GOOD_TABLE));
  assert.deepEqual(r, { ok: true, applied: 3, semantics: ['volume-change', 'window-close', 'account-signout'] });
  // escrow 侧：铸造可用（补偿路径快照来自文件）；查询面同律
  const mint = await reversalEscrow.mintPlan({ semantics: 'volume-change', description: 'turn volume down to 20' });
  assert.equal(mint.ok, true, '外部 compensate 键铸造成功（部署以文件扩表 —— 不改源码）');
  if (mint.ok) {
    assert.equal(mint.plan.verifyMode, 'screen-hash');
    assert.deepEqual(mint.plan.compensation.map(s => `${s.method}:${s.label}`), ['hotkey:restore volume level']);
    assert.deepEqual(mint.plan.compensation[0]!.keys, ['ctrl', 'shift', 'arrowdown']);
  }
  const q = compensationPathOf('window-close');
  assert.equal(q.kind, 'compensate');
  assert.deepEqual(q.steps, ['reopen window by title', 'Ctrl+Shift+T reopen tab']);
  // riskGate 侧：同步登记通道生效（classify 派发判定 + levelOf 基级查询）
  assert.deepEqual(reversibilityRegistry.classify({ semantics: 'volume-change' }).level, 'compensable');
  assert.deepEqual(reversibilityRegistry.levelOf('volume-change'), { level: 'compensable', source: 'extension' });
  assert.deepEqual(reversibilityRegistry.classify({ semantics: 'account-signout' }).level, 'irreversible');
  assert.deepEqual(reversibilityRegistry.levelOf('account-signout'), { level: 'irreversible', source: 'extension' });
  // 双侧对齐律逐键复验（装载面执法 —— 与 w4reverse S5-5d 内置遍历同律）
  for (const key of ['volume-change', 'window-close', 'account-signout']) {
    const kind = compensationPathOf(key).kind;
    const base = reversibilityRegistry.levelOf(key);
    assert.equal(
      (kind === 'manual-only' ? 'irreversible' : 'compensable'),
      base?.level,
      `外部键 ${key} 双侧不对齐（compensationPathOf=${kind} / levelOf=${base?.level}）`,
    );
    // classify（派发判定面）与基级一致（证据账为空 ⇒ 无校准偏移）
    assert.equal(reversibilityRegistry.classify({ semantics: key }).level, base?.level);
  }
  // 内置表不变（const 立法不可写 —— 装载前后逐键一致）
  assert.deepEqual(builtinCompensationSemantics(), BUILTIN_BEFORE);
  assert.equal(reversalEscrow.stats().extensionStrategies, 3, '外部表进扩展面（不是内置面）');
  assert.equal(reversalEscrow.stats().builtinStrategies, BUILTIN_BEFORE.length, '内置计数不变');
  // manual-only 外部键：铸造拒绝携带文件理由（fail-closed 立法延伸到外部键）
  const mo = await reversalEscrow.mintPlan({ semantics: 'account-signout' });
  assert.equal(mo.ok, false);
  if (!mo.ok) assert.equal(mo.reason, 'manual-only');
  // 内置 manual-only 立法不受装载影响（不翻案）
  const pay = await reversalEscrow.mintPlan({ semantics: 'payment' });
  assert.equal(pay.ok, false);
  if (!pay.ok) assert.equal(pay.reason, 'manual-only');
});

test('W9-2 D-C1-①b 顺序律：arm 不携带 strategies ⇒ 外部表存活（组合根可先 arm 后 load）；arm 显式携带 strategies ⇒ 显式修订后见者胜', async () => {
  const table = writeTable('order.json', GOOD_TABLE);
  reversalEscrow.arm({}); // 组合根姿势：先 arm（端口/存储），再 load（知识）
  assert.equal(loadExternalStrategyTable(table).ok, true);
  const mint = await reversalEscrow.mintPlan({ semantics: 'window-close' });
  assert.equal(mint.ok, true, 'arm 后 load ⇒ 扩展在表');
  reversalEscrow.arm({}); // 再 arm 且不携带 strategies ⇒ 外部表存活（arm 只修订显式给出的面）
  const mint2 = await reversalEscrow.mintPlan({ semantics: 'window-close' });
  assert.equal(mint2.ok, true, 'arm({}) 不清外部表（装载的知识不是 arm 的缺省修订对象）');
  reversalEscrow.arm({ strategies: [] }); // 显式携带（空）扩展 ⇒ 显式修订整体替换 —— 后见者胜
  const mint3 = await reversalEscrow.mintPlan({ semantics: 'window-close' });
  assert.equal(mint3.ok, false, 'arm 显式携带 strategies ⇒ 扩展面被替换（部署显式修订压过文件装载）');
  if (!mint3.ok) assert.equal(mint3.reason, 'no-strategy');
});

test('W9-2 D-C1-② 反：坏表矩阵全拒 + 原子性（一条坏件 ⇒ 好条目也不入表；既有状态保持原样）', () => {
  const cases: Array<{ name: string; content: unknown; reason: string; needle?: RegExp }> = [
    { name: '读故障（不存在路径）', content: null, reason: 'unreadable-path' },
    { name: '坏 JSON', content: '{"broken', reason: 'malformed-json' },
    { name: '根非对象（数组）', content: '[]', reason: 'bad-shape' },
    { name: 'strategies 缺席', content: { nope: 1 }, reason: 'bad-shape' },
    { name: 'strategies 非数组', content: { strategies: 'x' }, reason: 'bad-shape' },
    { name: '空表（零知识 —— 拒绝使错误可见）', content: { strategies: [] }, reason: 'bad-shape' },
    { name: '不支持的版本（前向不猜）', content: { version: 2, strategies: GOOD_TABLE.strategies }, reason: 'bad-shape' },
    {
      name: '步骤方法不在白名单', content: {
        strategies: [{ kind: 'compensate', semantics: 'x', steps: [{ method: 'teleport', label: 'nope' }], verify: { mode: 'none' } }],
      }, reason: 'bad-entry',
    },
    {
      name: 'compensate 零步骤', content: {
        strategies: [{ kind: 'compensate', semantics: 'x', steps: [], verify: { mode: 'none' } }],
      }, reason: 'bad-entry',
    },
    {
      name: 'verify 谓词模式（JSON 无从携带函数 —— 坏表不是降级）', content: {
        strategies: [{ kind: 'compensate', semantics: 'x', steps: [{ method: 'hotkey', label: 'z', keys: ['ctrl', 'z'] }], verify: { mode: 'predicate' } }],
      }, reason: 'bad-entry', needle: /predicate/,
    },
    {
      name: 'manual-only 缺理由', content: { strategies: [{ kind: 'manual-only', semantics: 'x' }] }, reason: 'bad-entry',
    },
    {
      name: '键缺席/空串', content: {
        strategies: [{ kind: 'compensate', semantics: '', steps: [{ method: 'hotkey', label: 'z', keys: ['ctrl', 'z'] }], verify: { mode: 'none' } }],
      }, reason: 'bad-entry',
    },
    {
      name: '表内重复键', content: { strategies: [...GOOD_TABLE.strategies, GOOD_TABLE.strategies[0]] }, reason: 'bad-entry',
    },
    {
      name: '步骤超界（>8 步）', content: {
        strategies: [{
          kind: 'compensate', semantics: 'x',
          steps: Array.from({ length: 9 }, () => ({ method: 'hotkey' as const, label: 'z', keys: ['ctrl', 'z'] })),
          verify: { mode: 'none' },
        }],
      }, reason: 'bad-entry',
    },
    {
      name: 'keys 坏件（非字符串混入）', content: {
        strategies: [{
          kind: 'compensate', semantics: 'x',
          steps: [{ method: 'hotkey', label: 'z', keys: ['ctrl', 42] }], verify: { mode: 'none' },
        }],
      }, reason: 'bad-entry',
    },
    {
      name: '内置立法冲突（把 send-message 降为可补偿 —— 必须死在装载面）', content: {
        strategies: [{
          kind: 'compensate', semantics: 'send-message',
          steps: [{ method: 'custom', label: 'recall the message', target: 'recall-menu' }], verify: { mode: 'none' },
        }],
      }, reason: 'builtin-conflict', needle: /send-message/,
    },
  ];
  for (const c of cases) {
    const p = c.content === null ? path.join(tmpdir(), 'w9deploy-nonexistent', `${Date.now()}.json`) : writeTable('bad.json', c.content);
    const r = loadExternalStrategyTable(p);
    assert.equal(r.ok, false, `${c.name} ⇒ 拒绝`);
    if (!r.ok) {
      assert.equal(r.reason, c.reason, `${c.name} ⇒ reason=${c.reason}（实际 ${r.reason}）`);
      if (c.needle) assert.match(r.detail ?? '', c.needle, `${c.name} ⇒ detail 指认坏件`);
    }
    // 原子性：坏表 ⇒ 扩展面零登记 + 分级注册表零登记（全有或全无）
    assert.equal(reversalEscrow.stats().extensionStrategies, 0, `${c.name} ⇒ 扩展表零条目`);
    assert.equal(reversibilityRegistry.levelOf('volume-change'), null, `${c.name} ⇒ 分级零登记`);
  }
  // 内置表在全部坏表轰击后不动
  assert.deepEqual(builtinCompensationSemantics(), BUILTIN_BEFORE);
});

test('W9-2 D-C1-③ 反：混合表（好 + 坏）全拒 —— 绝不留下半套知识；已装载扩展不被翻案', async () => {
  // 先装好表（既有状态）
  assert.equal(loadExternalStrategyTable(writeTable('a.json', GOOD_TABLE)).ok, true);
  // 混合表：一条新好键 + 一条坏键 ⇒ 整拒，且新好键不得入表
  const mixed = writeTable('mixed.json', {
    strategies: [
      ...GOOD_TABLE.strategies.slice(0, 1),
      { kind: 'compensate', semantics: 'good-new-key', steps: [{ method: 'menu', label: 'undo via menu' }], verify: { mode: 'none' } },
      { kind: 'compensate', semantics: 'bad-key', steps: [{ method: 'warp', label: 'nope' }], verify: { mode: 'none' } },
    ],
  });
  const r = loadExternalStrategyTable(mixed);
  assert.equal(r.ok, false, '坏件连坐整表');
  if (!r.ok) assert.equal(r.reason, 'bad-entry');
  assert.equal(reversibilityRegistry.levelOf('good-new-key'), null, '好条目不随坏件入表（全有或全无）');
  const mint = await reversalEscrow.mintPlan({ semantics: 'good-new-key' });
  assert.equal(mint.ok, false);
  // 既有装载保持原样（坏装载是 no-op，不是清空）
  assert.equal(reversalEscrow.stats().extensionStrategies, 3, '既有扩展保持 3 条');
  const again = await reversalEscrow.mintPlan({ semantics: 'volume-change' });
  assert.equal(again.ok, true, '既有外部键照常铸造');
  // 已装载扩展同样不翻案：volume-change 改判 manual-only 的表 ⇒ 拒
  const flip = loadExternalStrategyTable(writeTable('flip.json', {
    strategies: [{ kind: 'manual-only', semantics: 'volume-change', reason: 'attempted overrule' }],
  }));
  assert.equal(flip.ok, false, '外部表不改判已判定的键');
  if (!flip.ok) assert.equal(flip.reason, 'builtin-conflict');
  assert.equal(reversibilityRegistry.levelOf('volume-change')?.level, 'compensable', '改判被拒后原级别在册');
});

test('W9-2 D-C1-④ 缺省不变：零调用 = 零变化（外部键不可铸造、分级走保守律、扩展面空）', async () => {
  assert.equal(reversalEscrow.stats().extensionStrategies, 0);
  assert.deepEqual(builtinCompensationSemantics(), BUILTIN_BEFORE);
  const mint = await reversalEscrow.mintPlan({ semantics: 'volume-change' });
  assert.equal(mint.ok, false, '未装载 ⇒ 外部键 no-strategy（fail-closed 不因通道存在而松动）');
  if (!mint.ok) assert.equal(mint.reason, 'no-strategy');
  assert.deepEqual(
    reversibilityRegistry.classify({ semantics: 'volume-change' }),
    { level: 'irreversible', semantics: 'unknown', source: 'unknown-default' },
    '未装载 ⇒ 分级知识缺口按保守律收费',
  );
});

// ═══ ②③ D-C2/D-C5：federation-server 生产化 + barrier HMAC 扩面（环回子进程）═══

/** 起联邦服务器（epochMu2/w5cross 同律：监听日志解析 + /health 就绪轮询；失败抛错供 skip）。
 *  env 先剥本件管辖的 DSH_FED_* / FED_* 键再应用注入 —— 测试确定性（宿主环境残留不渗入）。 */
async function startFedServer(
  env: Record<string, string> = {},
  args: string[] = ['--port', '0'],
): Promise<{ port: number; child: ChildProcess; stop: () => Promise<void> }> {
  const script = fileURLToPath(new URL('../scripts/federation-server.mjs', import.meta.url));
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('DSH_FED') || k === 'DSH_FEDERATION_TOKEN' || k === 'FED_ALLOW_OPEN_BARRIER') continue;
    if (v !== undefined) clean[k] = v;
  }
  const child = spawn(process.execPath, [script, ...args], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...clean, ...env },
  });
  const port = await new Promise<number>((resolve, reject) => {
    let buf = '';
    let settledFlag = false;
    const done = (v: number | null): void => {
      if (settledFlag) return;
      settledFlag = true;
      clearTimeout(timer);
      if (v === null) reject(new Error('联邦服务器未在 8s 内报出监听口'));
      else resolve(v);
    };
    const timer = setTimeout(() => done(null), 8_000);
    child.stdout!.on('data', (d: Buffer) => {
      buf += String(d);
      if (/"event":"listening"/.test(buf)) {
        const m = buf.match(/"port":(\d+)/);
        if (m) done(Number(m[1]));
      }
    });
    child.on('error', () => done(null));
    child.on('exit', () => done(null));
  });
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
      if (r.ok) break;
    } catch {
      /* 未就绪：继续轮询 */
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('联邦服务器 /health 5s 未就绪');
    }
    await new Promise(r => setTimeout(r, 100));
  }
  child.stdout!.resume();
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) return;
    const exited = new Promise<void>(resolve => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3_000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    child.kill();
    await exited;
  };
  return { port, child, stop };
}

/** 环回随机可用口（DSH_FED_PORT 测试用 —— 取后即还，测试容忍极小竞态） */
function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const p = typeof addr === 'object' && addr !== null ? addr.port : 0;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

/** ΠΑΝ-88：有界轮询直至谓词命中（组提交落盘到达是异步去抖后的——非同步路径） */
async function waitFor<T>(probe: () => T | Promise<T | null>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== null && v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`waitFor 超时（${timeoutMs}ms）：${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 最小合法摘要（v=1/K=8 坨）—— aggregate 环入件 */
function tinyDigest(key = 'w9.tiny'): string {
  return JSON.stringify({ v: 1, mintedAt: 1, epsilon: 1, keys: [{ key, n: 1, bins: Array.from({ length: 8 }, () => [1, 0]) }] });
}

/** HMAC 签名头（与服务端同协议 —— federationAuthHeaders 权威面） */
function signedHeaders(body: string, secret: string): Record<string, string> {
  return federationAuthHeaders(body, secret, Date.now());
}

test('W9-2 D-C2-① 缺省行为不变：零 env ⇒ 与参考实现同行为（auth 面/上限/barrier 开放/无持久化）', { timeout: 60_000 }, async t => {
  let srv: Awaited<ReturnType<typeof startFedServer>>;
  try {
    srv = await startFedServer();
  } catch (e) {
    return t.skip(`环境不支持子进程/环回监听：诚实跳过（${(e as Error).message}）`);
  }
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    // /health：参考缺省逐字段（生产化是能力不是缺省切换）
    const h = (await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) })).json()) as {
      ok: boolean; authMode: string; barrierAuthMode: string; maxBodyBytes: number;
      persistence: boolean; barrierTtlOverrideMs: number | null; drainMs: number; buffered: number;
    };
    assert.equal(h.ok, true);
    assert.equal(h.authMode, 'open', '无密钥 ⇒ open（零配置环回语义不变）');
    assert.equal(h.barrierAuthMode, 'open', 'open 模式 barrier 照旧开放（D-C5 不改 open 拓扑）');
    assert.equal(h.maxBodyBytes, 1024 * 1024, '体上限缺省 1MB');
    assert.equal(h.persistence, false, '缺省不落盘（关机即忘设计语义不变）');
    assert.equal(h.barrierTtlOverrideMs, null, 'TTL 缺省走 TS 立法（单源纪律 —— 本件不复制缺省值）');
    assert.equal(h.drainMs, 1500, '排空缺省 = 参考超时同值');
    // 行为面：aggregate 照收 + 1MB 界 413；barrier 无签照收（参考拓扑）
    const rAgg = await fetch(`${base}/aggregate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: tinyDigest(), signal: AbortSignal.timeout(5_000),
    });
    assert.equal(rAgg.status, 200);
    assert.equal(((await rAgg.json()) as { sources: number }).sources, 1);
    const rHuge = await fetch(`${base}/aggregate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: '[' + '"pad",'.repeat(600_000) + '"pad"]', signal: AbortSignal.timeout(8_000),
    });
    assert.equal(rHuge.status, 413, '缺省上限 >1MB ⇒ 413（不变）');
    const rBar = await fetch(`${base}/barrier/allocate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'w9def', peer: 'A', n: 2 }), signal: AbortSignal.timeout(2_000),
    });
    assert.equal(rBar.status, 200, 'open 模式 barrier 无签照收（向后兼容）');
    const st = await fetch(`${base}/barrier/status?name=w9def`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(((await st.json()) as { ok: boolean }).ok, true, 'GET status 只读面照旧（TTL 内在役）');
  } finally {
    await srv.stop();
  }
});

test('W9-2 D-C2-② env 面执法：PORT / MAX_BODY_BYTES / BARRIER_TTL_MS 逐项生效', { timeout: 90_000 }, async t => {
  // (a) DSH_FED_PORT：不带 --port 参数起服 ⇒ 监听 env 指定口
  let srv: Awaited<ReturnType<typeof startFedServer>>;
  const chosen = await ephemeralPort();
  try {
    srv = await startFedServer({ DSH_FED_PORT: String(chosen) }, []);
  } catch (e) {
    return t.skip(`环境不支持子进程/环回监听：诚实跳过（${(e as Error).message}）`);
  }
  try {
    assert.equal(srv.port, chosen, 'env 口生效（--port 缺席 ⇒ env 次之）');
    const h = (await (await fetch(`http://127.0.0.1:${chosen}/health`, { signal: AbortSignal.timeout(2_000) })).json()) as { ok: boolean };
    assert.equal(h.ok, true);
  } finally {
    await srv.stop();
  }
  // (b) DSH_FED_MAX_BODY_BYTES=2048：小体照收、大体 413（上限执法 + health 透明）
  let srv2: Awaited<ReturnType<typeof startFedServer>>;
  try {
    srv2 = await startFedServer({ DSH_FED_MAX_BODY_BYTES: '2048' });
  } catch (e) {
    return t.skip(`环境不支持子进程/环回监听：诚实跳过（${(e as Error).message}）`);
  }
  const base2 = `http://127.0.0.1:${srv2.port}`;
  try {
    const h2 = (await (await fetch(`${base2}/health`, { signal: AbortSignal.timeout(2_000) })).json()) as { maxBodyBytes: number };
    assert.equal(h2.maxBodyBytes, 2048, 'health 报 env 上限');
    const okPost = await fetch(`${base2}/aggregate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: tinyDigest(), signal: AbortSignal.timeout(5_000),
    });
    assert.equal(okPost.status, 200, '限内照收');
    const bigPost = await fetch(`${base2}/aggregate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: '[' + '"pad",'.repeat(2_000) + '"pad"]', signal: AbortSignal.timeout(5_000),
    });
    assert.equal(bigPost.status, 413, '超 env 上限 ⇒ 413');
  } finally {
    await srv2.stop();
  }
  // (c) DSH_FED_BARRIER_TTL_MS=400：驻留超时 ⇒ 惰性清扫退休（status ⇒ unknown-barrier）
  let srv3: Awaited<ReturnType<typeof startFedServer>>;
  try {
    srv3 = await startFedServer({ DSH_FED_BARRIER_TTL_MS: '400' });
  } catch (e) {
    return t.skip(`环境不支持子进程/环回监听：诚实跳过（${(e as Error).message}）`);
  }
  const base3 = `http://127.0.0.1:${srv3.port}`;
  try {
    const h3 = (await (await fetch(`${base3}/health`, { signal: AbortSignal.timeout(2_000) })).json()) as { barrierTtlOverrideMs: number | null };
    assert.equal(h3.barrierTtlOverrideMs, 400, 'health 报 TTL 覆盖');
    const rAlloc = await fetch(`${base3}/barrier/allocate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ttl-e2e', peer: 'A', n: 2 }), signal: AbortSignal.timeout(2_000),
    });
    assert.equal(((await rAlloc.json()) as { ok: boolean }).ok, true, '先入役');
    await new Promise(r => setTimeout(r, 700)); // > TTL 400ms
    const st = await fetch(`${base3}/barrier/status?name=ttl-e2e`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(((await st.json()) as { ok: boolean; reason?: string }).reason, 'unknown-barrier',
      'TTL 覆盖生效：驻留超时 ⇒ tombstone 退休（缺省 120s 的同一状态机，参数面经 env）');
  } finally {
    await srv3.stop();
  }
});

test('W9-2 D-C2-③ 持久化开关：缺席 = 关机即忘不变；设置 = 组提交落盘 + 重启验签回读；坏档/篡改档 ⇒ 空环起步不炸', { timeout: 90_000 }, async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'w9persist-'));
  dirs.push(dir);
  const persistFile = path.join(dir, 'federation-digests.json');
  // (a) 阶段保存的正档副本（后续关停可能覆写盘上文件，篡改用例以副本为基准）
  let goodPayload: { contentSig: string; digests: Array<Record<string, unknown>> } | null = null;
  // (a) 开关开启：入环 ⇒ 组提交落盘（ΠΑΝ-88：150ms 去抖后异步批写——不再每次
  //     POST 同步 fsync 阻塞事件循环；落盘到达按有界轮询断言）；进程消亡后重启 ⇒ 环恢复
  let srv: Awaited<ReturnType<typeof startFedServer>>;
  try {
    srv = await startFedServer({ DSH_FED_PERSIST_DIR: dir });
  } catch (e) {
    return t.skip(`环境不支持子进程/环回监听：诚实跳过（${(e as Error).message}）`);
  }
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const h0 = (await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) })).json()) as { persistence: boolean; buffered: number };
    assert.equal(h0.persistence, true, 'health 报持久化在役');
    for (const k of ['w9.p1', 'w9.p2']) {
      const r = await fetch(`${base}/aggregate`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: tinyDigest(k), signal: AbortSignal.timeout(5_000),
      });
      assert.equal(r.status, 200);
    }
    assert.equal(((await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) })).json()) as { buffered: number }).buffered, 2);
    // ΠΑΝ-88：组提交有界等待（去抖 150ms + 异步 fsync——非 POST 同步路径）
    const persisted = await waitFor(async () => {
      try {
        const p = JSON.parse(readFileSync(persistFile, 'utf8')) as { digests?: unknown[]; contentSig?: string };
        return (p.digests?.length === 2 && typeof p.contentSig === 'string') ? p : null;
      } catch { return null; }
    }, 5_000, '组提交落盘（digests=2 + contentSig）');
    assert.equal(persisted.digests!.length, 2, '突发入环合并落盘（tmp+fsync+rename 原子写）');
    assert.match(persisted.contentSig!, /^[0-9a-f]{64}$/, 'ΠΑΝ-88：载荷带内容签名（HMAC）');
    goodPayload = JSON.parse(JSON.stringify(persisted)) as { contentSig: string; digests: Array<Record<string, unknown>> };
  } finally {
    await srv.stop(); // POSIX 走优雅关停落盘；win32 硬终断 —— 环已在组提交窗口内落盘（两者皆覆盖）
  }
  let srv2: Awaited<ReturnType<typeof startFedServer>>;
  try {
    srv2 = await startFedServer({ DSH_FED_PERSIST_DIR: dir });
  } catch (e) {
    return t.skip(`环境不支持子进程/环回监听：诚实跳过（${(e as Error).message}）`);
  }
  try {
    const base2 = `http://127.0.0.1:${srv2.port}`;
    const h1 = (await (await fetch(`${base2}/health`, { signal: AbortSignal.timeout(2_000) })).json()) as { buffered: number };
    assert.equal(h1.buffered, 2, '重启验签回读：环恢复（生产化能力 —— 缺省仍关机即忘）');
    const r = await fetch(`${base2}/aggregate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: tinyDigest('w9.p3'), signal: AbortSignal.timeout(5_000),
    });
    assert.equal(((await r.json()) as { sources: number }).sources, 3, '恢复环可继续聚合');
  } finally {
    await srv2.stop();
  }
  // (b) 坏档：垃圾 JSON 落盘文件 ⇒ 空环起步、服务存活（读故障不炸起动）
  writeFileSync(persistFile, '{"broken', 'utf8');
  let srv3: Awaited<ReturnType<typeof startFedServer>>;
  try {
    srv3 = await startFedServer({ DSH_FED_PERSIST_DIR: dir });
  } catch (e) {
    return t.skip(`环境不支持子进程/环回监听：诚实跳过（${(e as Error).message}）`);
  }
  try {
    const h2 = (await (await fetch(`http://127.0.0.1:${srv3.port}/health`, { signal: AbortSignal.timeout(2_000) })).json()) as { ok: boolean; buffered: number };
    assert.equal(h2.ok, true, '坏档不炸起动');
    assert.equal(h2.buffered, 0, '坏档 ⇒ 空环起步（诚实归零，不冒充恢复）');
  } finally {
    await srv3.stop();
  }
  // (c) ΠΑΝ-88 篡改档：形状合法 + contentSig 在场但内容被改（签名失配）⇒ 空环起步
  //     —— 持久化把磁盘完整性引入信任面，回读必须验内容签名（不再「形状对即入环」）
  assert.notEqual(goodPayload, null, '篡改基准 = (a) 阶段的正档副本');
  const tampered = {
    ...goodPayload!,
    digests: goodPayload!.digests.map((d) => ({ ...d, keys: (d.keys as Array<Record<string, unknown>>).map((k) => ({ ...k, n: 999 })) })),
  };
  writeFileSync(persistFile, JSON.stringify(tampered), 'utf8');
  let srv4: Awaited<ReturnType<typeof startFedServer>>;
  try {
    srv4 = await startFedServer({ DSH_FED_PERSIST_DIR: dir });
  } catch (e) {
    return t.skip(`环境不支持子进程/环回监听：诚实跳过（${(e as Error).message}）`);
  }
  try {
    const h3 = (await (await fetch(`http://127.0.0.1:${srv4.port}/health`, { signal: AbortSignal.timeout(2_000) })).json()) as { ok: boolean; buffered: number };
    assert.equal(h3.ok, true, '篡改档不炸起动');
    assert.equal(h3.buffered, 0, 'ΠΑΝ-88：内容签名失配 ⇒ 拒入环（形状合法但伪造的摘要进不了聚合源）');
  } finally {
    await srv4.stop();
  }
});

test('W9-2 D-C5-① barrier 签名强制：token 模式缺省三端点验签（无签/坏签/换体 ⇒ 401；带签 ⇒ 领域流全通）', { timeout: 60_000 }, async t => {
  const SECRET = 'w9-dc5-barrier-secret';
  let srv: Awaited<ReturnType<typeof startFedServer>>;
  try {
    srv = await startFedServer({ DSH_FEDERATION_TOKEN: SECRET });
  } catch (e) {
    return t.skip(`环境不支持子进程/环回监听：诚实跳过（${(e as Error).message}）`);
  }
  const base = `http://127.0.0.1:${srv.port}`;
  const allocBody = JSON.stringify({ name: 'w9sig', peer: 'A', n: 2 });
  try {
    // health 明示生产姿态（barrier 面入签名覆盖）
    const h = (await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) })).json()) as
      { authMode: string; barrierAuthMode: string; authNotice: string };
    assert.equal(h.authMode, 'token');
    assert.equal(h.barrierAuthMode, 'token', '缺省姿态：token 模式 ⇒ barrier 面要求签名（D-C5 落锤）');
    assert.ok(h.authNotice.includes('barrier'), `authNotice 覆盖 barrier 面（${h.authNotice}）`);
    // 无签 ⇒ 401（三端点 × 两方法）
    for (const [label, url, init] of [
      ['POST allocate 无签', `${base}/barrier/allocate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: allocBody }],
      ['POST status 无签', `${base}/barrier/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"w9sig"}' }],
      ['GET status 无签', `${base}/barrier/status?name=w9sig`, { method: 'GET' }],
      ['POST commit 无签', `${base}/barrier/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"w9sig","peer":"A","seq":1}' }],
      ['POST aggregate 无签', `${base}/aggregate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: tinyDigest() }],
    ] as const) {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(2_000) });
      assert.equal(r.status, 401, `${label} ⇒ 401`);
      assert.equal(((await r.json()) as { reason: string }).reason, 'missing-signature-headers', `${label} ⇒ reason=缺签名头`);
    }
    // 坏签（异密钥）⇒ 401 signature-mismatch
    const badSig = signedHeaders(allocBody, 'wrong-secret');
    const rBad = await fetch(`${base}/barrier/allocate`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...badSig }, body: allocBody, signal: AbortSignal.timeout(2_000),
    });
    assert.equal(rBad.status, 401);
    assert.equal(((await rBad.json()) as { reason: string }).reason, 'signature-mismatch');
    // 换体（签名对原文、发送体不同）⇒ 401 —— 拒绝在解体之前
    const rTamper = await fetch(`${base}/barrier/allocate`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...signedHeaders(allocBody, SECRET) },
      body: JSON.stringify({ name: 'w9evil', peer: 'A', n: 2 }), signal: AbortSignal.timeout(2_000),
    });
    assert.equal(rTamper.status, 401, '换体签名失配（barrier 面与 /aggregate 同律）');
    // 带签 ⇒ 领域流全通（allocate → status → commit 领域拒绝 not-released —— 核心可达）
    const rOk = await fetch(`${base}/barrier/allocate`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...signedHeaders(allocBody, SECRET) },
      body: allocBody, signal: AbortSignal.timeout(2_000),
    });
    assert.equal(rOk.status, 200);
    const jOk = (await rOk.json()) as { ok: boolean; phase: string; arrived: string[] };
    assert.equal(jOk.ok, true, '带签 allocate 领域 200');
    assert.equal(jOk.phase, 'collecting');
    assert.deepEqual(jOk.arrived, ['A']);
    // GET status 带签（空正文签名 —— 输入 `${ts}.`）
    const st = await fetch(`${base}/barrier/status?name=w9sig`, {
      headers: signedHeaders('', SECRET), signal: AbortSignal.timeout(2_000),
    });
    assert.equal(((await st.json()) as { ok: boolean }).ok, true, 'GET status 带空正文签名照收');
    const cm = await fetch(`${base}/barrier/commit`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...signedHeaders('{"name":"w9sig","peer":"A","seq":1}', SECRET) },
      body: '{"name":"w9sig","peer":"A","seq":1}', signal: AbortSignal.timeout(2_000),
    });
    const cmj = (await cm.json()) as { ok: boolean; reason?: string };
    assert.equal(cm.status, 200);
    assert.equal(cmj.ok, false);
    assert.equal(cmj.reason, 'not-released', '带签 commit 触达单源核心（领域拒绝照旧 —— 签名是旁路，语义零变化）');
    // 环不动（401 全部拒绝在解体之前）
    const h2 = (await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) })).json()) as { buffered: number };
    assert.equal(h2.buffered, 0, '全部 401 ⇒ 摘要环不动');
  } finally {
    await srv.stop();
  }
});

test('W9-2 D-C5-② 兼容模式：FED_ALLOW_OPEN_BARRIER=1 ⇒ barrier 开（参考拓扑）；aggregate 仍签', { timeout: 60_000 }, async t => {
  const SECRET = 'w9-dc5-compat-secret';
  let srv: Awaited<ReturnType<typeof startFedServer>>;
  try {
    srv = await startFedServer({ DSH_FEDERATION_TOKEN: SECRET, FED_ALLOW_OPEN_BARRIER: '1' });
  } catch (e) {
    return t.skip(`环境不支持子进程/环回监听：诚实跳过（${(e as Error).message}）`);
  }
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    const h = (await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) })).json()) as
      { authMode: string; barrierAuthMode: string; authNotice: string };
    assert.equal(h.authMode, 'token', 'aggregate 面仍在 token 模式');
    assert.equal(h.barrierAuthMode, 'open', '兼容声明：barrier 面开放');
    assert.ok(h.authNotice.includes('OPEN'), `明示兼容模式（${h.authNotice}）`);
    const rOpen = await fetch(`${base}/barrier/allocate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'w9compat', peer: 'A', n: 2 }), signal: AbortSignal.timeout(2_000),
    });
    assert.equal(rOpen.status, 200, '无签 barrier 照收（参考拓扑保持 —— 过渡姿势）');
    assert.equal(((await rOpen.json()) as { ok: boolean }).ok, true);
    const rAgg = await fetch(`${base}/aggregate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: tinyDigest(), signal: AbortSignal.timeout(2_000),
    });
    assert.equal(rAgg.status, 401, '兼容只开 barrier：aggregate 签名执法不随兼容松动');
  } finally {
    await srv.stop();
  }
});

test('W9-2 D-C5-③ 带签客户端双端 barrier 往返：注入 fetchImpl 加签（现有缝 —— 无需改 crossMachine 源）', { timeout: 60_000 }, async t => {
  const SECRET = 'w9-dc5-client-secret';
  let srv: Awaited<ReturnType<typeof startFedServer>>;
  try {
    srv = await startFedServer({ DSH_FEDERATION_TOKEN: SECRET });
  } catch (e) {
    return t.skip(`环境不支持子进程/环回监听：诚实跳过（${(e as Error).message}）`);
  }
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    // 加签 fetch（README 同款 —— federationAuthHeaders 与服务端同协议）
    const signedFetch: BarrierFetch = async (url, init) => {
      const headers = { ...init.headers, ...federationAuthHeaders(init.body, SECRET, Date.now()) };
      return fetch(url, { method: 'POST', headers, body: init.body, signal: init.signal }) as unknown as { json?: () => Promise<unknown> };
    };
    const transport = makeHttpBarrierTransport({ endpoint: base, fetchImpl: signedFetch });
    // 冒烟：transport 直达（带签 allocate 被收）
    const probe = await transport({ op: 'allocate', name: 'w9t', peer: 'A', n: 2 } as BarrierRequest);
    assert.equal(probe.ok, true, '带签 transport 领域 200');
    // 双客户端两阶段往返（强制签名拓扑下的完整 barrier 机制）
    const cA = createBarrierClient({ peer: 'A', transport, pollMs: 25, timeoutMs: 8_000 });
    const cB = createBarrierClient({ peer: 'B', transport, pollMs: 25, timeoutMs: 8_000 });
    const pa = cA.arriveAndWait('w9-e2e-dial', 2);
    const rb = await cB.arriveAndWait('w9-e2e-dial', 2);
    const ra = await pa;
    assert.equal(rb.ok, true, 'B 抵达即放行（签名不改变 barrier 语义）');
    assert.equal(ra.ok, true, 'A 轮询见放行');
    if (ra.ok && rb.ok) {
      assert.equal(ra.seq, rb.seq, '同 generation');
      assert.deepEqual([...ra.peers].sort(), ['A', 'B']);
      assert.equal(ra.ack?.ok, true, '两阶段确认闭环');
    }
    const after = await fetch(`${base}/barrier/status?name=w9-e2e-dial`, {
      headers: signedHeaders('', SECRET), signal: AbortSignal.timeout(2_000),
    });
    assert.equal(((await after.json()) as { reason?: string }).reason, 'unknown-barrier', '全确认 ⇒ generation 退休（零驻留）');
  } finally {
    await srv.stop();
  }
});

// ═══ ΠΑΝ-88：HMAC nonce + ±30s 窗 + 重放拒绝（C2-6/M-4 落锤）═══

/** v2 签名头（推荐协议）：`${ts}.${nonce}.${body}`；v1（legacy 无 nonce）：`${ts}.${body}` */
function hmacHeaders(body: string, secret: string, ts: number, nonce: string | null): Record<string, string> {
  const input = nonce === null ? `${ts}.${body}` : `${ts}.${nonce}.${body}`;
  const h: Record<string, string> = {
    'content-type': 'application/json',
    'x-dsh-fed-timestamp': String(ts),
    'x-dsh-fed-signature': createHmac('sha256', secret).update(input).digest('hex'),
  };
  if (nonce !== null) h['x-dsh-fed-nonce'] = nonce;
  return h;
}

test('ΠΑΝ-88 nonce+时间戳+重放拒绝：v2 首发 200 / 同 nonce 重放 401（新 ts 新签也拒）/ v1 兼容 200 / 31s 前 stale', { timeout: 60_000 }, async t => {
  const SECRET = 'pan88-replay-secret';
  let srv: Awaited<ReturnType<typeof startFedServer>>;
  try {
    srv = await startFedServer({ DSH_FEDERATION_TOKEN: SECRET });
  } catch (e) {
    return t.skip(`环境不支持子进程/环回监听：诚实跳过（${(e as Error).message}）`);
  }
  const base = `http://127.0.0.1:${srv.port}`;
  const body = tinyDigest('pan88.replay');
  const post = async (h: Record<string, string>) => {
    const r = await fetch(`${base}/aggregate`, { method: 'POST', headers: h, body, signal: AbortSignal.timeout(2_000) });
    return { status: r.status, json: (await r.json()) as { reason?: string } };
  };
  try {
    // health 透明面：nonce 推荐与 ±30s 窗在指引中可见
    const h = (await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) })).json()) as { authMode: string; authNotice: string };
    assert.equal(h.authMode, 'token');
    assert.ok(h.authNotice.includes('nonce'), `authNotice 指引提及 nonce（${h.authNotice}）`);
    assert.ok(h.authNotice.includes('±30s'), '±30s 窗口透明');
    // v2 首发：200
    const nonce = randomBytes(12).toString('hex');
    const ok = await post(hmacHeaders(body, SECRET, Date.now(), nonce));
    assert.equal(ok.status, 200, 'v2 带签首发通过');
    // 同 nonce 重放：401 replayed-request（时间戳与签名全部重造也不行——nonce 是重放身份证）
    const rp = await post(hmacHeaders(body, SECRET, Date.now(), nonce));
    assert.equal(rp.status, 401);
    assert.equal(rp.json.reason, 'replayed-request', '同 nonce 重放被拒');
    // 新 nonce：200（重放拒绝不误伤合法新请求）
    const ok2 = await post(hmacHeaders(body, SECRET, Date.now(), randomBytes(12).toString('hex')));
    assert.equal(ok2.status, 200, '新 nonce 合法通过');
    // v1（legacy 无 nonce，federationAuthHeaders 既有面）：首发 200、原样重放 401
    const v1 = await post(hmacHeaders(body, SECRET, Date.now(), null));
    assert.equal(v1.status, 200, 'v1 legacy 兼容（既有客户端零变化）');
    const v1Headers = hmacHeaders(body, SECRET, Date.now() - 1_000, null);
    const v1replay1 = await post(v1Headers);
    const v1replay2 = await post(v1Headers); // 同一签名第二次
    assert.equal(v1replay1.status, 200, 'v1 首发（1s 前时间戳仍在 ±30s 窗内）');
    assert.equal(v1replay2.status, 401, 'v1 原样重放（同签名材料）被拒');
    assert.equal((v1replay2.json as { reason?: string }).reason, 'replayed-request');
    // 31s 前时间戳 ⇒ stale（±30s 窗收窄执法）
    const stale = await post(hmacHeaders(body, SECRET, Date.now() - 31_000, randomBytes(12).toString('hex')));
    assert.equal(stale.status, 401);
    assert.equal(stale.json.reason, 'stale-timestamp', '±30s 窗外的重放面就位');
    // 全程重放被拒 ⇒ 环内恰 4 份合法摘要（v2 首发 + v2 新 nonce + v1 首发 + v1 1s前首发）
    const h2 = (await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) })).json()) as { buffered: number };
    assert.equal(h2.buffered, 4, '拒绝在解体之前——重放零入环（stale 与 replayed 均未入环）');
  } finally {
    await srv.stop();
  }
});

test('W9-2 D-C2-④ 优雅关停：SIGTERM ⇒ 排空后 exit 0（POSIX）；win32 硬终断亦不挂（诚实分层）+ 立法在源', { timeout: 60_000 }, async t => {
  // (a) 立法在源（w5cross ⑩ 同律 —— 结构断言把守关停纪律，平台无关）
  const srv = readFileSync(new URL('../scripts/federation-server.mjs', import.meta.url), 'utf8');
  assert.match(srv, /DSH_FED_DRAIN_MS/, '排空上限 env 立法在场');
  assert.match(srv, /closeIdleConnections/, 'keep-alive 空闲连接收口（server.close 不被空闲连接拖住）');
  assert.match(srv, /persistRing\('shutdown'\)/, '关停随行落盘（持久化开启时）');
  assert.match(srv, /for \(const sig of \['SIGINT', 'SIGTERM'\]\)/, '双信号接线');
  assert.match(srv, /BARRIER_AUTH_REQUIRED = AUTH_REQUIRED && !ALLOW_OPEN_BARRIER/, 'D-C5 立法：缺省签名 + 兼容开关');
  // ΠΑΝ-88 立法在源：nonce 重放拒绝 + ±30s 窗 + 组提交 + 回读验签
  assert.match(srv, /x-dsh-fed-nonce/, 'ΠΑΝ-88：nonce 头协议在场');
  assert.match(srv, /AUTH_SKEW_MS = 30_000/, 'ΠΑΝ-88：±30s 窗立法');
  assert.match(srv, /replayed-request/, 'ΠΑΝ-88：重放拒绝理由面在场');
  assert.match(srv, /schedulePersist\('aggregate'\)/, 'ΠΑΝ-88：运行期组提交（不再每次 POST 同步 fsync）');
  assert.match(srv, /persist-tamper/, 'ΠΑΝ-88：回读内容签名验证事件在场');
  for (const envName of ['DSH_FED_PORT', 'DSH_FED_MAX_BODY_BYTES', 'DSH_FED_BARRIER_TTL_MS', 'DSH_FED_PERSIST_DIR', 'FED_ALLOW_OPEN_BARRIER']) {
    assert.ok(srv.includes(envName), `env 面 ${envName} 在源`);
  }
  // (b) 行为面：SIGTERM ⇒ 进程在排空上限内退场（不挂死）
  let s: Awaited<ReturnType<typeof startFedServer>>;
  try {
    s = await startFedServer({ DSH_FED_DRAIN_MS: '300' });
  } catch (e) {
    return t.skip(`环境不支持子进程/环回监听：诚实跳过（${(e as Error).message}）`);
  }
  const exited = new Promise<{ code: number | null; sig: NodeJS.Signals | null }>(resolve => {
    s.child.once('exit', (code, sig) => resolve({ code, sig }));
  });
  s.child.kill('SIGTERM');
  const r = await Promise.race([
    exited,
    new Promise<null>(resolve => setTimeout(() => resolve(null), 5_000)),
  ]);
  assert.notEqual(r, null, 'SIGTERM ⇒ 5s 内退场（排空上限 + 兜底 exit —— 绝不挂死）');
  if (r !== null && process.platform !== 'win32') {
    // POSIX：优雅路径 ⇒ exit 0（drain 完成后显式退出码）
    assert.equal(r.code, 0, `POSIX 优雅关停 exit 0（实际 code=${r.code} sig=${r.sig}）`);
  }
  // win32 诚实注记：子进程 SIGTERM 不投递（硬终断，处理器不运行 —— Node/Win32
  // 平台事实）；优雅语义在 POSIX 拓扑执法，win32 由 (a) 立法在源把守。
  s.child.stdout?.resume();
});
