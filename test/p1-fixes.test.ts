// test/p1-fixes.test.ts
// 地基速修（P1）回归测试 —— 每条 P1 一节，防其借尸还魂。
//
// P1-1  ioMutex 排队/执行超时：挂死的物理调用以 [TIMEOUT] 错误收场（orchestrator
//       同款方言），绝不毒化队列（后续 IO 照常）；timeout=0 = 无限等（旧行为
//       逐字保留）；不传参 = 消费 config.ioTimeoutMs 声明的缺省。
//       守护不变量：D-1 到达序串行 / 失败不毒化队列 / 链尾吞错（无 unhandled
//       rejection）/ 悬空计时器不拖事件循环。
// P1-2  sandbox 重放令牌换 CSPRNG：与宿主 approval.newToken 同口径（randomBytes(8)
//       hex 大写）—— 令牌唯一性（连续 1000 铸无碰撞）、字符域/长度稳定、
//       engine.ts 源码不再含 Math.random 路径（正则扫源码执法）。
// P1-3  系统级热键黑名单：归一和弦（小写+win/meta/cmd/cmdsuper 等价+排序无关）
//       命中黑名单条目、或和弦含黑名单单键（meta/win）⇒ system.pressHotkey 拒绝；
//       普通组合键（ctrl+c/ctrl+tab/escape/alt+tab）零影响；空黑名单 = 全放行；
//       dryRun 照旧只记录。工具层 toolErr 说明拦截原因 + next_step 常规途径。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import {
  serialize, configureIoTimeout, getIoTimeoutDefault,
  isIoTimeoutError, IoTimeoutError, IO_TIMEOUT_MARKER,
} from '../src/ioMutex.ts';
import { Config } from '../src/config.ts';
import {
  system, hotkeyBlacklistHit, isHotkeyBlacklistError, HOTKEY_BLACKLIST_MARKER,
} from '../src/system.ts';
import { SandboxEngineImpl } from '../src/sandbox/engine.ts';
import { createPressHotkeyTool } from '../src/tools/pressHotkey.ts';
import type { Config as ConfigType } from '../src/config.ts';

// ─── 共用工具（全离线确定性：假 IO + 短等待，不触碰任何真实物理设备/网络）───

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * config schema 规范化调用面（运行时可调用是宿主装载配置的同款路径；项目内
 * TS 类型未暴露调用签名 —— 窄函数断言，与 ioMutex/system 的 P1-1/P1-3 同口径）
 */
const configDefaults = Config as unknown as (input?: Record<string, unknown>) => ConfigType;

/** 受控延迟体：测试握住释放阀，模拟慢/挂死物理 IO */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** P1-1 会改写 ioMutex 缺省超时：每用例前复位为 config 声明缺省（15000） */
beforeEach(() => {
  configureIoTimeout(configDefaults({}).ioTimeoutMs);
});

// ═══ P1-1：ioMutex 排队超时 ═══

test('P1-1 缺省超时消费 config.ioTimeoutMs：schema 声明值 15000 即模块缺省', () => {
  // 单一事实源执法：缺省来自 config schema（不是 ioMutex 里的第二个魔法数字）
  assert.equal(configDefaults({}).ioTimeoutMs, 15000);
  assert.equal(getIoTimeoutDefault(), 15000);
  // configureIoTimeout 运行时可改写（部署接线面）；域外值诚实归 0（=无限等）
  configureIoTimeout(2500);
  assert.equal(getIoTimeoutDefault(), 2500);
  configureIoTimeout(-5);
  assert.equal(getIoTimeoutDefault(), 0);
  configureIoTimeout(Number.NaN);
  assert.equal(getIoTimeoutDefault(), 0);
});

test('P1-1 超时收场：挂死 IO + 短超时 ⇒ [TIMEOUT] 错误，队列照常放行后续 IO', async () => {
  const hung = deferred<void>(); // 假慢 IO：永不落定（比慢更狠的保守上界）
  const p = serialize(() => hung.promise, 25);
  // 与 orchestrator 逐字同方言：错误 message 以 [TIMEOUT] 开头（工具层 catch 后
  // 透传 error.message 进 toolErr，即自动获得超时语义 —— 无需逐工具改造）
  await assert.rejects(p, (e: unknown) => {
    assert.ok(isIoTimeoutError(e), 'isIoTimeoutError 判别成立');
    assert.ok((e as Error).message.startsWith(IO_TIMEOUT_MARKER), 'message 以 [TIMEOUT] 开头');
    assert.ok((e as Error).message.includes('25ms'), '错误携带预算事实');
    return true;
  });
  // 绝不毒化队列：挂死者已出局，后续 IO 立即照常执行（这是本修复的存在理由）
  assert.equal(await serialize(async () => 42, 25), 42);
  assert.equal(await serialize(async () => 'next', 25), 'next');
});

test('P1-1 超时杀一次调用不杀流水线：慢 IO 超时后，同窗后续 IO 与再入队全部正常', async () => {
  const slow = deferred<number>();
  const timedOut = serialize(() => slow.promise, 20);
  await assert.rejects(timedOut, isIoTimeoutError);
  // 超时后慢 IO 的迟来终局不得变成 unhandled rejection（链尾吞错不变量）
  //（此处显式落定一次：若吞错链断裂，node:test 会以未处理拒绝炸场）
  slow.resolve(99);
  await sleep(5);
  // 再入队：到达序执行照常
  const order: number[] = [];
  await Promise.all([
    serialize(async () => { order.push(1); }, 500),
    serialize(async () => { order.push(2); }, 500),
    serialize(async () => { order.push(3); }, 500),
  ]);
  assert.deepEqual(order, [1, 2, 3]); // D-1 到达序串行（回归守护）
});

test('P1-1 超时 0 = 无限等（旧行为）：慢 IO 不被误伤，落定后照常返回', async () => {
  const slow = deferred<string>();
  const p = serialize(() => slow.promise, 0); // 显式 0 = 立法保留的旧行为
  let settled = false;
  void p.then(() => { settled = true; });
  await sleep(30); // 短等待验证不误伤（30ms >> 0 预算下任何时钟粒度）
  assert.equal(settled, false, '无限等：未落定前绝不超时');
  slow.resolve('legacy-ok');
  assert.equal(await p, 'legacy-ok');
  // 队列健康（tail 无残留堵塞），后续 IO 照常
  assert.equal(await serialize(async () => 7, 0), 7);
});

test('P1-1 缺省 0（config ioTimeoutMs=0 部署）⇒ 不传参调用同享旧行为', async () => {
  configureIoTimeout(0);
  const slow = deferred<number>();
  const p = serialize(() => slow.promise); // 不传参 = 用缺省配置值（此处部署值 0）
  await sleep(20);
  slow.resolve(1);
  assert.equal(await p, 1); // 无限等语义逐字继承，零误伤
});

test('P1-1 缺省超时生效中：挂死 IO 不传参 ⇒ 按缺省预算收场', async () => {
  configureIoTimeout(40);
  const hung = deferred<void>();
  await assert.rejects(serialize(() => hung.promise), isIoTimeoutError); // 缺省 40ms 执法
  assert.equal(await serialize(async () => 'ok', 100), 'ok'); // 队列照常
});

test('P1-1 错误可区分：底层真实失败 ≠ 超时（isIoTimeoutError 不误报）且不毒化队列', async () => {
  await assert.rejects(serialize(async () => { throw new Error('boom'); }, 1000), (e: unknown) => {
    assert.equal(isIoTimeoutError(e), false, '真实底层错误不得冒充超时');
    assert.equal((e as Error).message, 'boom');
    return true;
  });
  assert.equal(await serialize(async () => 'alive', 1000), 'alive'); // D-1 旧不变量：失败不毒化队列
  assert.equal(isIoTimeoutError(new IoTimeoutError(1)), true); // 类判别兜底
  assert.equal(isIoTimeoutError(new Error('[TIMEOUT-ish]')), false, '前缀伪装不入罪');
  assert.equal(isIoTimeoutError(null), false);
});

// ═══ P1-2：sandbox 重放令牌 CSPRNG ═══

test('P1-2 令牌唯一性：连续铸 1000 个无碰撞（randomBytes 8 字节熵）', () => {
  const engine = new SandboxEngineImpl(null);
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const t = engine.requestReplayToken(`entry-${i}`);
    seen.add(t);
  }
  assert.equal(seen.size, 1000, '1000 铸 1000 唯一（Math.random 时代 8 字符 base36 高频可碰撞）');
});

test('P1-2 令牌字符域/长度稳定：SBX- 前缀 + 16 位大写 hex（与 APR- 同口径）', () => {
  const engine = new SandboxEngineImpl(null);
  for (let i = 0; i < 50; i++) {
    const t = engine.requestReplayToken('e');
    assert.match(t, /^SBX-[0-9A-F]{16}$/, '前缀 + 8 字节 hex 大写，结构恒定');
    assert.equal(t.length, 20, '长度稳定（铸法不得漂移）');
  }
});

test('P1-2 源码执法：engine.ts 不再含 Math.random 路径（CSPRNG 已换防）', () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sandbox', 'engine.ts'),
    'utf8',
  );
  assert.equal(/Math\s*\.\s*random/.test(src), false, '预测性随机数绝迹（正则扫源码执法）');
  assert.ok(src.includes('randomBytes'), '正向对照：CSPRNG 铸法在场（扫描不空转）');
});

// ═══ P1-3：系统级热键黑名单 ═══

const DEFAULT_BLACKLIST = configDefaults({}).hotkeyBlacklist; // 单一事实源：config 声明缺省

test('P1-3 命中拒绝：alt+f4 / meta / win（大小写、顺序、别名等价全归一）', () => {
  const hits: Array<[string[], string | null]> = [
    [['alt', 'f4'], 'alt+f4'],   // 字面命中
    [['ALT', 'F4'], 'alt+f4'],   // 大小写归一
    [['f4', 'alt'], 'alt+f4'],   // 顺序无关（和弦整体比较）
    [['Alt+F4'], 'alt+f4'],      // 单字符串和弦（调用方方言宽容）
    [['meta'], 'meta'],          // OS 壳层单键
    [['win'], 'meta'],           // win ≡ meta（别名折叠后命中 meta 条目）
    [['cmd'], 'meta'],           // cmd ≡ meta
    [['cmdsuper'], 'meta'],      // cmdsuper ≡ meta
    [['meta', 'l'], 'meta'],   // 开始菜单/搜索（CSV 序中单键 meta 先中 —— 拒绝事实不变）
    [['cmd', 'q'], 'meta'],      // cmd+q ≡ meta+q（且和弦已含单键 meta —— 双律皆中）
    [['ctrl', 'alt', 'delete'], 'ctrl+alt+delete'], // 三键全等（排序归一后命中）
    [['ctrl', 'shift', 'meta'], 'meta'], // 和弦含黑名单单键 meta ⇒ 拒
    [['meta', 'shift', 'd'], 'meta'],   // 同上（桌面显示切换逃逸）
  ];
  for (const [keys, expectedEntry] of hits) {
    const hit = hotkeyBlacklistHit(keys, DEFAULT_BLACKLIST);
    assert.ok(hit !== null, `chord [${keys.join('+')}] 必须命中`);
    assert.equal(hit.toLowerCase(), (expectedEntry as string).toLowerCase(),
      `命中条目一致（${keys.join('+')}）`);
  }
});

test('P1-3 放行零误伤：ctrl+c / ctrl+tab / escape / alt+tab 等常规组合全通过', () => {
  const passes: string[][] = [
    ['ctrl', 'c'],        // 复制
    ['ctrl', 'v'],        // 粘贴
    ['ctrl', 'tab'],      // switch_tab 工具的物理实现（误伤即断肢体）
    ['ctrl', 'shift', 'tab'],
    ['escape'],           // dismiss_popup 的物理实现
    ['esc'],
    ['ctrl', 'shift', 't'],
    ['alt', 'tab'],       // switch_window 后备路径（system 明文建议此和弦）
    ['ctrl', 'l'],        // 地址栏聚焦（非黑名单管辖：模型可见可验证）
    ['ctrl', '0'],        // shaper set_zoom 归零（误伤即断 D-2）
    ['ctrl', '+'],
  ];
  for (const keys of passes) {
    assert.equal(hotkeyBlacklistHit(keys, DEFAULT_BLACKLIST), null,
      `常规和弦 [${keys.join('+')}] 必须放行`);
  }
});

test('P1-3 空黑名单 = 全放行（部署明示不设防，执法层诚实让路）', () => {
  assert.equal(hotkeyBlacklistHit(['alt', 'f4'], ''), null);
  assert.equal(hotkeyBlacklistHit(['meta'], ''), null);
  assert.equal(hotkeyBlacklistHit(['ctrl', 'alt', 'delete'], ''), null);
  assert.equal(hotkeyBlacklistHit(['win'], '  '), null); // 全空白同空
  // 自定义黑名单：只有列出的才拦（配置即法律，不多不少）
  assert.equal(hotkeyBlacklistHit(['alt', 'f4'], 'alt+f4'), 'alt+f4');
  assert.equal(hotkeyBlacklistHit(['meta'], 'alt+f4'), null); // 未列单键不拦
});

test('P1-3 system.pressHotkey 执法：黑名单和弦在触达任何后端之前即拒绝', async () => {
  await system.configure({ dryRun: false, hotkeyBlacklist: 'alt+f4,meta,win' } as ConfigType);
  // 拒绝发生在 system 层 —— 离线环境下若漏到 D-5 后端，错误将是连接失败而非拦截标记
  await assert.rejects(system.pressHotkey(['alt', 'f4']), (e: unknown) => {
    assert.ok(isHotkeyBlacklistError(e), 'isHotkeyBlacklistError 判别成立');
    assert.ok((e as Error).message.includes(HOTKEY_BLACKLIST_MARKER));
    assert.ok((e as Error).message.includes('系统级热键被黑名单拦截'), '拒绝理由明说');
    return true;
  });
  await assert.rejects(system.pressHotkey(['win']), isHotkeyBlacklistError); // 别名单键同拒
  await assert.rejects(system.pressHotkey(['ctrl', 'shift', 'meta']), isHotkeyBlacklistError); // 含 meta 即拒
});

test('P1-3 dryRun 照旧只记录：黑名单和弦不抛错（不执行 = 无拦截必要）', async () => {
  await system.configure({ dryRun: true, hotkeyBlacklist: 'alt+f4,meta' } as ConfigType);
  // dry-run 模式只记录不执行 —— 提示词调试要能看到完整热键轨迹（含被拦和弦）
  await assert.doesNotReject(system.pressHotkey(['alt', 'f4']));
  await assert.doesNotReject(system.pressHotkey(['meta']));
});

test('P1-3 工具层锚点：toolErr 说明拦截原因 + next_step 指向常规途径', async () => {
  await system.configure({ dryRun: false, hotkeyBlacklist: 'alt+f4,meta' } as ConfigType);
  const tool = createPressHotkeyTool();
  const raw = await tool.execute({ keys: ['alt', 'f4'] });
  const parsed = JSON.parse(String(raw));
  assert.equal(parsed.status, 'FAILED');
  assert.ok(String(parsed.state_anchor.error).includes('系统级热键被黑名单拦截'), '错误事实');
  assert.ok(String(parsed.next_step).includes('常规途径'), '恢复指引：改走常规途径');
  assert.ok(String(parsed.next_step).includes('switch_window'), '给出具体常规工具出口');
});

test('P1-3 工具层超时方言：[TIMEOUT] 错误翻译为 toolErr 专属恢复指引（P1-1 × 工具层接线）', async () => {
  const tool = createPressHotkeyTool();
  // 离线确定性接缝：临时把 system.pressHotkey 替换为抛真实 IoTimeoutError 的假躯体
  //（工具层只依赖错误形状做判别 —— 与 legacy 路径 serialize 超时的真实形状逐字一致）
  const original = system.pressHotkey.bind(system);
  (system as { pressHotkey: unknown }).pressHotkey = async () => {
    throw new IoTimeoutError(20);
  };
  try {
    const raw = await tool.execute({ keys: ['ctrl', 'c'] });
    const parsed = JSON.parse(String(raw));
    assert.equal(parsed.status, 'FAILED');
    assert.ok(String(parsed.state_anchor.error).startsWith('[TIMEOUT]'), '超时方言透传');
    assert.ok(String(parsed.next_step).includes('物理 IO 队列超时'), '超时专属恢复指引');
  } finally {
    (system as { pressHotkey: unknown }).pressHotkey = original; // 单例复原，不毒化后续用例
  }
});
