// test/p1-fixes.test.ts
// 地基速修（P1）回归测试 —— 每条 P1 一节，防其借尸还魂。
//
// P1-1  ioMutex 排队/执行超时：挂死的物理调用以 [TIMEOUT] 错误收场（orchestrator
//       同款方言），绝不毒化队列（后续 IO 照常）；timeout=0 = 无限等（旧行为
//       逐字保留）；不传参 = 消费 config.ioTimeoutMs 声明的缺省。
//       守护不变量：D-1 到达序串行 / 失败不毒化队列 / 链尾吞错（无 unhandled
//       rejection）/ 悬空计时器不拖事件循环。
//       ΠΑΝ-33（超时语义修正：上报超时 ≠ 放行队列）：超时只对调用方上报
//       [TIMEOUT]（回执形状不变），队列 tail 恒等待真实终局 —— 挂死调用真正
//       落定前后续 IO 物理排队（D-1 串行公理在超时路径同样成立）；可选 cancel
//       端口超时即触发（缺席 ⇒ 只等待 settle）。旧「超时放行队列」的两条断言
//       已按新公理改写（并发放行 = 破互斥，正是本修正的靶子）。
// P1-2  sandbox 重放令牌换 CSPRNG：与宿主 approval.newToken 同口径（randomBytes(8)
//       hex 大写）—— 令牌唯一性（连续 1000 铸无碰撞）、字符域/长度稳定、
//       engine.ts 源码不再含 Math.random 路径（正则扫源码执法）。
// P1-3  系统级热键黑名单：归一和弦（小写+win/meta/cmd/cmdsuper 等价+排序无关）
//       命中黑名单条目、或和弦含黑名单单键（meta/win）⇒ system.pressHotkey 拒绝；
//       普通组合键（ctrl+c/ctrl+tab/escape/alt+tab）零影响；空黑名单 = 全放行；
//       dryRun 照旧只记录。工具层 toolErr 说明拦截原因 + next_step 常规途径。
// ΠΑΝ-10 P1-3 收口：和弦签名去重（重复修饰键 ≡ 单键按住 —— ['alt','alt','f4']
//       不再逃过 alt+f4）+ 别名折叠→去重顺序执法 + 缺省表补 ctrl+shift+esc /
//       alt+space（装载期只增不减；显式配置即法律不被越权）。
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
import { getHotkeyBlacklistCsv } from '../src/system.hotkeyPolicy.ts';
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

test('P1-1 超时收场：挂死 IO + 短超时 ⇒ [TIMEOUT] 错误（回执形状执法）', async () => {
  const hung = deferred<void>(); // 假慢 IO：测试握住释放阀（ΠΑΝ-33 后队列尾等真实终局）
  const p = serialize(() => hung.promise, 25);
  // 与 orchestrator 逐字同方言：错误 message 以 [TIMEOUT] 开头（工具层 catch 后
  // 透传 error.message 进 toolErr，即自动获得超时语义 —— 无需逐工具改造）
  await assert.rejects(p, (e: unknown) => {
    assert.ok(isIoTimeoutError(e), 'isIoTimeoutError 判别成立');
    assert.ok((e as Error).message.startsWith(IO_TIMEOUT_MARKER), 'message 以 [TIMEOUT] 开头');
    assert.ok((e as Error).message.includes('25ms'), '错误携带预算事实');
    assert.equal((e as IoTimeoutError).name, 'IoTimeoutError', '错误类名稳定（形状不变）');
    return true;
  });
  // ΠΑΝ-33（超时后队列仍物理串行）：挂死者未真正落定 ⇒ 后续 IO 不得入场；
  // 真实终局到达 ⇒ 后续 IO 照常执行（这是本修正的存在理由 —— 上报超时 ≠ 放行队列）
  //（followUp 预算给足 500ms：排队等待计入调用方总预算 —— 队尾等待也会超时，
  //  但物理派发仍严格排在挂死调用之后；此处只验串行不验排队超时）
  const followUp = serialize(async () => 42, 500);
  let followUpSettled = false;
  void followUp.then(() => { followUpSettled = true; }, () => { followUpSettled = true; });
  await sleep(40); // >> 25ms 超时预算：旧实现此处已放行（并发 = 破互斥）
  assert.equal(followUpSettled, false, '挂死调用未落定 ⇒ 后续 IO 仍在队尾物理排队');
  hung.resolve(undefined); // 底层终局（迟到）到达
  assert.equal(await followUp, 42, '真实终局后队列即刻恢复（失败/超时不毒化队列）');
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

test('P1-1 缺省超时生效中：挂死 IO 不传参 ⇒ 按缺省预算收场（真实终局后队列恢复）', async () => {
  configureIoTimeout(40);
  const hung = deferred<void>();
  await assert.rejects(serialize(() => hung.promise), isIoTimeoutError); // 缺省 40ms 执法
  hung.resolve(undefined); // ΠΑΝ-33：队列尾等待真实终局 —— 落定后放行（不留在全局尾巴上）
  await sleep(5);
  assert.equal(await serialize(async () => 'ok', 100), 'ok'); // 队列照常
});

// ═══ ΠΑΝ-33：超时语义修正（上报超时 ≠ 放行队列）═══

test('ΠΑΝ-33 超时后队列仍物理串行：下一个 IO 与挂死的 fn 不得并发（D-1 公理执法）', async () => {
  // 复现批判 C1-2 H4 的靶场景：旧实现 tail = Promise.race([settle, clock]) 使
  // 超时即放行 —— 下一个 serialize 的 fn 与仍挂死的前一个 fn 并发执行，
  // 两次物理动作可交错落到同一躯体。新不变量：fn2 的启动必须严格晚于 fn1 的终局。
  const hung = deferred<void>();
  let fn2Started = false;
  const p1 = serialize(() => hung.promise, 20);
  await assert.rejects(p1, isIoTimeoutError); // 调用方拿到超时回执
  const p2 = serialize(async () => { fn2Started = true; return 'second'; }, 500);
  await sleep(60); // >> 20ms：若 race 放行仍在，fn2 早已启动
  assert.equal(fn2Started, false, '挂死调用未落定 ⇒ 下一个 IO 绝不启动（互斥未破）');
  hung.resolve(undefined);
  assert.equal(await p2, 'second', '真实终局后按到达序执行');
  assert.equal(fn2Started, true);
});

test('ΠΑΝ-33 取消传播：cancel 端口在场 ⇒ 超时即触发一次（中止挂死调用的接线面）', async () => {
  const hung = deferred<void>();
  let cancels = 0;
  const abort = (): void => { cancels++; hung.resolve(undefined); }; // 模拟 AbortController：中止后底层终局到达
  await assert.rejects(serialize(() => hung.promise, 20, abort), isIoTimeoutError);
  await sleep(5);
  assert.equal(cancels, 1, '超时恰触发一次取消（不重触发、不早触发）');
  // 取消使底层落定 ⇒ 队列即刻恢复，后续 IO 照常（取消是恢复串行的通路，不是绕过）
  assert.equal(await serialize(async () => 'recovered', 100), 'recovered');
});

test('ΠΑΝ-33 取消端口缺席/炸裂 ⇒ 防御式只等待 settle（绝不抛、不毒化队列）', async () => {
  // 缺席：只等待真实终局（cancel 为 undefined —— 现有一元/二元调用方的零回归面）
  const hung1 = deferred<void>();
  await assert.rejects(serialize(() => hung1.promise, 15), isIoTimeoutError);
  const follow1 = serialize(async () => 1, 100);
  await sleep(30);
  hung1.resolve(undefined);
  assert.equal(await follow1, 1, '端口缺席：真实终局后照常');
  // 炸裂：cancel 抛错被吞，队列不受影响
  const hung2 = deferred<void>();
  const badCancel = (): void => { throw new Error('cancel-port-exploded'); };
  await assert.rejects(serialize(() => hung2.promise, 15, badCancel), isIoTimeoutError);
  hung2.resolve(undefined);
  await sleep(5);
  assert.equal(await serialize(async () => 2, 100), 2, '端口炸裂：只等待 settle，队列不毒化');
});

test('ΠΑΝ-33 迟来终局不产生 unhandled rejection 且不计入后续调用结果', async () => {
  const late = deferred<number>();
  const timedOut = serialize(() => late.promise, 20);
  await assert.rejects(timedOut, isIoTimeoutError);
  late.resolve(99); // 迟到成功：调用方已收 [TIMEOUT]，此终局被吞错镜像吸收
  await sleep(10); // 若吞错链断裂，node:test 会以未处理拒绝炸场
  assert.equal(await serialize(async () => 'clean', 100), 'clean', '队列状态干净');
  // 迟到失败面：reject 同样被吞（不毒化后续调用）
  const lateFail = deferred<number>();
  await assert.rejects(serialize(() => lateFail.promise, 20), isIoTimeoutError);
  lateFail.reject(new Error('late-failure'));
  await sleep(10);
  assert.equal(await serialize(async () => 'clean2', 100), 'clean2');
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

// ═══ ΠΑΝ-10：热键黑名单和弦去重 + 缺省表补全（H-3 收口）═══
// 漏洞一（去重缺失）：旧 chordSig 不去重 —— ['alt','alt','f4'] 签名 'alt+alt+f4'
// ≠ 条目 'alt+f4'，单键条目只有 meta 系 ⇒ Alt+F4 实际仍会执行（重复修饰键
// 语义等同单次按住）。漏洞二（覆盖缺口）：缺省表不含 ctrl+shift+esc（任务
// 管理器 —— 与 ctrl+alt+delete 同目标）、alt+space（窗口系统菜单，含"关闭"）。

test('ΠΑΝ-10 重复键和弦去重：[alt,alt,f4] / [f4,alt,f4] 逃逸被堵（重复修饰键 ≡ 单键按住）', () => {
  assert.equal(hotkeyBlacklistHit(['alt', 'alt', 'f4'], 'alt+f4'), 'alt+f4', 'H-3 正例：重复 alt');
  assert.equal(hotkeyBlacklistHit(['f4', 'alt', 'f4'], 'alt+f4'), 'alt+f4', '重复非修饰键同律');
  assert.equal(hotkeyBlacklistHit(['ALT', 'Alt', 'F4'], 'alt+f4'), 'alt+f4', '大小写归一后去重');
  assert.equal(hotkeyBlacklistHit(['alt', 'alt', 'f4'], DEFAULT_BLACKLIST), 'alt+f4', '缺省表上同样拦截');
  assert.equal(
    hotkeyBlacklistHit(['ctrl', 'ctrl', 'alt', 'delete'], 'ctrl+alt+delete'), 'ctrl+alt+delete',
    '三键和弦重复 ctrl 同律',
  );
  // 条目侧对称：畸形条目（CSV 里写重复键）与正常和弦全等
  assert.equal(hotkeyBlacklistHit(['alt', 'f4'], 'alt+alt+f4'), 'alt+alt+f4', '条目侧同去重');
});

test('ΠΑΝ-10 别名折叠与去重的顺序：先折叠后去重（win+meta ≡ meta 单键）', () => {
  // ['win','meta'] 先别名折叠为 ['meta','meta'] 再去重为 ['meta'] —— 顺序反了会
  // 留下 meta+win 双键假和弦，既逃过单键条目也逃过全等比较
  assert.equal(hotkeyBlacklistHit(['win', 'meta'], 'meta'), 'meta', '双别名同键去重后命中单键条目');
  assert.equal(hotkeyBlacklistHit(['win', 'cmd'], 'meta'), 'meta');
  assert.equal(hotkeyBlacklistHit(['win', 'cmd', 'q'], 'cmd+q'), 'cmd+q', 'win+cmd+q → meta+q 与条目 cmd+q 全等');
  assert.equal(hotkeyBlacklistHit(['meta', 'win', 'l'], 'meta+l'), 'meta+l', '折叠去重后与 meta+l 全等');
  assert.equal(hotkeyBlacklistHit(['cmdsuper', 'super'], 'meta'), 'meta', 'cmdsuper/super 双别名');
});

test('ΠΑΝ-10 缺省表补全：ctrl+shift+esc / alt+space 纳入装载期生效缺省（只增不减）', () => {
  const effective = getHotkeyBlacklistCsv(); // 模块装载缺省 = schema 缺省 + ΠΑΝ-10 补全
  assert.ok(effective.includes('ctrl+shift+esc'), '任务管理器和弦入缺省');
  assert.ok(effective.includes('alt+space'), '窗口系统菜单和弦入缺省');
  // schema 缺省原有条目全部保留（只增不减）
  for (const entry of DEFAULT_BLACKLIST.split(',')) {
    assert.ok(effective.includes(entry.trim()), `缺省原有条目不丢: ${entry}`);
  }
  assert.equal(hotkeyBlacklistHit(['ctrl', 'shift', 'esc'], effective), 'ctrl+shift+esc');
  assert.equal(hotkeyBlacklistHit(['alt', 'space'], effective), 'alt+space');
  assert.equal(hotkeyBlacklistHit(['ctrl', 'shift', 'ctrl', 'esc'], effective), 'ctrl+shift+esc', '重复键同拦');
  assert.equal(hotkeyBlacklistHit(['alt', 'alt', 'space'], effective), 'alt+space', '重复键同拦');
  // 常规和弦在补全后的缺省上仍零误伤
  for (const keys of [['ctrl', 'c'], ['ctrl', 'shift', 'tab'], ['esc'], ['alt', 'tab'], ['ctrl', 'shift', 't']] as string[][]) {
    assert.equal(hotkeyBlacklistHit(keys, effective), null, `补全不得误伤常规和弦 [${keys.join('+')}]`);
  }
  // 显式配置不被补全越权（配置即法律）
  assert.equal(hotkeyBlacklistHit(['ctrl', 'shift', 'esc'], 'alt+f4'), null);
});

test('ΠΑΝ-10 system.pressHotkey 端到端：重复键 Alt+F4 在触达任何后端之前即拒绝', async () => {
  await system.configure({ dryRun: false, hotkeyBlacklist: 'alt+f4,ctrl+shift+esc,alt+space' } as ConfigType);
  await assert.rejects(system.pressHotkey(['alt', 'alt', 'f4']), (e: unknown) => {
    assert.ok(isHotkeyBlacklistError(e), '重复键和弦的黑名单拦截判别成立');
    assert.ok((e as Error).message.includes(HOTKEY_BLACKLIST_MARKER));
    return true;
  });
  await assert.rejects(system.pressHotkey(['ctrl', 'shift', 'esc']), isHotkeyBlacklistError, '任务管理器和弦拒绝');
  await assert.rejects(system.pressHotkey(['alt', 'alt', 'space']), isHotkeyBlacklistError, '系统菜单和弦重复键拒绝');
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
