// test/filePerms.test.ts
// W8-A2（密钥落盘加固推广）执法册：
//   F-1~F-5 —— 共享模块 src/filePerms.ts 单测：icacls 参数装配（纯函数）、
//              平台路由（win32⇒icacls / posix⇒chmod 0600）、三败相降级
//              （非零退出 / status null / 同步抛 / 无账户名 / chmod 抛）、
//              旧档顺手收紧三态（宽松收紧 / 已紧不动 / stat 失败不动）。
//   F-6/F-7 —— 接线执法：connection.ts 收紧面确实走共享模块（同函数引用 +
//              调用参数逐项一致），零漂移的结构性证据。
//   F-8/F-9 —— config 面边界执法：src/config.ts 零落盘写点（含密配置档由
//              cordis 宿主落盘，插件只读 —— 未来谁往 config.ts 加裸写点即红）；
//              插件侧含密文件唯一写点（vlm-connection.json）写时收紧顺序执法。
// 铁律：全离线 —— 共享模块经 deps 注入假 fs / 假 icacls；connection 缝经
// _setXxxForTest 注入并在 afterEach 全量回真实。环境变量零触碰。
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as realFs from 'node:fs';

const filePerms = await import('../src/filePerms.ts');
const {
  buildIcaclsArgs,
  currentWindowsUser,
  defaultFilePermsDeps,
  tightenWindowsAcl,
  tightenFilePerms,
  tightenExistingFilePerms,
} = filePerms;
const { ConnectionStore, maskKey, _setFsForTest, _setIcaclsSpawnForTest, _setPlatformForTest } =
  await import('../src/vlm/connection.ts');

// ─── 注入缝现场恢复（缝泄漏 = 后续测试污染源） ───

afterEach(() => {
  _setIcaclsSpawnForTest(null);
  _setFsForTest(null);
  _setPlatformForTest(null);
});

// ─── 假件铸造（共享模块 deps 全注入面） ───

interface ChmodCall { file: string; mode: number }
interface IcaclsCall { cmd: string; args: string[]; opts: { stdio: unknown; shell: unknown; windowsHide: unknown } }

/**
 * 全假 deps：chmod / icacls 记录调用（默认成功）、stat 回放可控 mode、
 * platform 恒定注入值、windowsUser 恒定注入名。任一动作可改为抛错。
 */
function fakeDeps(over: {
  platform?: string;
  user?: string | null;
  statMode?: number;
  statThrows?: boolean;
  chmodThrows?: boolean;
  icaclsStatus?: number | null;
  icaclsThrows?: boolean;
} = {}) {
  const chmods: ChmodCall[] = [];
  const icaclsCalls: IcaclsCall[] = [];
  const stats: number[] = [];
  const deps = {
    chmod: ((f: unknown, m: unknown) => {
      chmods.push({ file: String(f), mode: m as number });
      if (over.chmodThrows) throw new Error('EACCES: chmod denied');
    }) as never,
    stat: (() => {
      stats.push(over.statMode ?? 0o600);
      if (over.statThrows) throw new Error('ESTAT: blind');
      return { mode: over.statMode ?? 0o600 };
    }) as never,
    platform: () => over.platform ?? 'linux',
    icacls: ((cmd: string, args: readonly string[], opts: IcaclsCall['opts']) => {
      icaclsCalls.push({ cmd, args: [...args], opts });
      if (over.icaclsThrows) throw new Error('ENOENT: icacls missing');
      // 注意：null 是合法败相（icacls 缺席），不能用 ?? 折叠成 0
      return { status: over.icaclsStatus === undefined ? 0 : over.icaclsStatus };
    }) as never,
    windowsUser: () => over.user === undefined ? 'tester' : over.user,
  };
  return { deps: deps as unknown as import('../src/filePerms.ts').FilePermsDeps, chmods, icaclsCalls, stats };
}

// ═════════════════════════ F-1 参数装配（纯函数·共享件直测） ═════════════════════════

test('F-1: buildIcaclsArgs（共享件）—— 四元数组 [file, /inheritance:r, /grant:r, <user>:F]，特殊用户名不拆参数', () => {
  assert.deepEqual(buildIcaclsArgs('C:/x/conn.json', 'alice'), [
    'C:/x/conn.json', '/inheritance:r', '/grant:r', 'alice:F',
  ], '标准形态');
  const spaced = buildIcaclsArgs('C:/x/c.json', 'FirstName LastName');
  assert.equal(spaced.length, 4, '含空格用户名不拆参数');
  assert.equal(spaced[3], 'FirstName LastName:F', '空格用户名整体成 grant 单元');
  assert.equal(buildIcaclsArgs('/home/u/c.json', '张三')[3], '张三:F', '中文用户名原样直达');
  assert.equal(buildIcaclsArgs('C:/d/c.json', 'CORP\\dom user')[3], 'CORP\\dom user:F', '域前缀用户名原样直达');
});

// ═════════════════════════ F-2 平台路由 ═════════════════════════

test('F-2: tightenFilePerms 平台路由 —— win32⇒icacls（chmod 零触碰）；posix⇒chmod 0600（icacls 零触碰）', () => {
  // win32：icacls 通道被调、参数形态过堂、chmod 不碰
  const win = fakeDeps({ platform: 'win32', user: 'alice' });
  assert.equal(tightenFilePerms('C:/d/k.json', win.deps), true, 'win32 icacls 退出 0 ⇒ 收紧成功');
  assert.equal(win.icaclsCalls.length, 1, '恰好一次 icacls');
  const c = win.icaclsCalls[0]!;
  assert.equal(c.cmd, 'icacls', '命令名');
  assert.deepEqual(c.args, ['C:/d/k.json', '/inheritance:r', '/grant:r', 'alice:F'], '参数 = buildIcaclsArgs 装配形');
  assert.equal(c.opts.shell, false, '绝不走 shell');
  assert.equal(c.opts.stdio, 'ignore', '回执静默');
  assert.equal(win.chmods.length, 0, 'win32 分支零 chmod（chmod 管不了 ACL）');
  // posix：chmod 0600、icacls 不碰
  const px = fakeDeps({ platform: 'linux' });
  assert.equal(tightenFilePerms('/home/u/k.json', px.deps), true, 'posix chmod 成功 ⇒ 收紧成功');
  assert.deepEqual(px.chmods, [{ file: '/home/u/k.json', mode: 0o600 }], 'chmod 0600 一次');
  assert.equal(px.icaclsCalls.length, 0, 'posix 分支零 icacls');
  // 平台判定实时读取（非构造期固化）：同一 deps 序列两平台不同动作
  let plat = 'linux';
  const flip = fakeDeps({ platform: 'linux' });
  (flip.deps as { platform: () => string }).platform = () => plat;
  assert.equal(tightenFilePerms('/p/f', flip.deps), true);
  plat = 'win32';
  assert.equal(tightenFilePerms('/p/f', flip.deps), true);
  assert.equal(flip.chmods.length, 1, '只第一次走了 chmod（平台切换即时生效）');
  assert.equal(flip.icaclsCalls.length, 1, '第二次走了 icacls');
});

// ═════════════════════════ F-3 三败相降级（绝不抛） ═════════════════════════

test('F-3: tightenFilePerms 三败相 —— icacls 非零 / status null / 同步抛 / 无账户名 / chmod 抛 ⇒ false 不炸', () => {
  // win32 败相一：非零退出（策略限制 / 路径锁）
  const nz = fakeDeps({ platform: 'win32', icaclsStatus: 1 });
  assert.equal(tightenFilePerms('C:/d/a.json', nz.deps), false, '非零退出 ⇒ false');
  // win32 败相二：status null（icacls 缺席 / spawn 失败面）
  const nl = fakeDeps({ platform: 'win32', icaclsStatus: null });
  assert.equal(tightenFilePerms('C:/d/b.json', nl.deps), false, 'status null ⇒ false');
  // win32 败相三：通道同步抛
  const th = fakeDeps({ platform: 'win32', icaclsThrows: true });
  assert.equal(tightenFilePerms('C:/d/c.json', th.deps), false, '同步抛 ⇒ false');
  // win32 败相四：取不到账户名（无从授权 —— 连 icacls 都不必发）
  const nu = fakeDeps({ platform: 'win32', user: null });
  assert.equal(tightenFilePerms('C:/d/d.json', nu.deps), false, '账户名缺席 ⇒ false');
  assert.equal(nu.icaclsCalls.length, 0, '无授权对象 ⇒ 不发 icacls');
  // posix 败相：chmod 抛（受限文件系统）
  const cx = fakeDeps({ platform: 'linux', chmodThrows: true });
  assert.equal(tightenFilePerms('/home/u/e.json', cx.deps), false, 'chmod 抛 ⇒ false');
  // tightenWindowsAcl 单面同律（共享件独立执法）
  const wa = fakeDeps({ platform: 'linux', icaclsStatus: 5 });
  assert.equal(tightenWindowsAcl('C:/d/f.json', wa.deps), false, 'tightenWindowsAcl 非零退出 ⇒ false');
  assert.equal(tightenWindowsAcl('C:/d/f.json', fakeDeps({ user: 'x' }).deps), true, '退出 0 ⇒ true');
});

// ═════════════════════════ F-4 旧档顺手收紧三态 ═════════════════════════

test('F-4: tightenExistingFilePerms —— 宽松收紧 / 已紧不动 / stat 失败不动；win32 幂等 icacls', () => {
  // posix 宽松档（0o644：group/other 位在）⇒ 收紧 0600
  const loose = fakeDeps({ platform: 'linux', statMode: 0o644 });
  tightenExistingFilePerms('/old/loose.json', loose.deps);
  assert.deepEqual(loose.chmods, [{ file: '/old/loose.json', mode: 0o600 }], '宽松旧档被收紧');
  // posix 已紧档（0o600）⇒ 不惊动
  const tight = fakeDeps({ platform: 'linux', statMode: 0o600 });
  tightenExistingFilePerms('/old/tight.json', tight.deps);
  assert.equal(tight.chmods.length, 0, '已紧档零多余 chmod');
  // posix stat 抛 ⇒ 不动手、绝不炸（读档优先）
  const blind = fakeDeps({ platform: 'linux', statThrows: true });
  assert.doesNotThrow(() => tightenExistingFilePerms('/old/blind.json', blind.deps));
  assert.equal(blind.chmods.length, 0, 'stat 失败无从判定 ⇒ 不动手（不误伤）');
  // posix stat OK 但 chmod 抛 ⇒ 吞掉不炸
  const choke = fakeDeps({ platform: 'linux', statMode: 0o777, chmodThrows: true });
  assert.doesNotThrow(() => tightenExistingFilePerms('/old/choke.json', choke.deps), '收紧失败不阻断读档');
  // win32：ACL 无廉价探测面 ⇒ 幂等 icacls 每次尽力（不看档位状态）
  const win = fakeDeps({ platform: 'win32', user: 'bob' });
  tightenExistingFilePerms('C:/old/win.json', win.deps);
  tightenExistingFilePerms('C:/old/win.json', win.deps);
  assert.equal(win.icaclsCalls.length, 2, '每次读档路径顺手一次（幂等尽力）');
  assert.equal(win.icaclsCalls[0]!.args[0], 'C:/old/win.json', '收紧目标就是旧档本身');
  assert.equal(win.icaclsCalls[0]!.args[3], 'bob:F', '授权注入账户');
  assert.equal(win.chmods.length, 0, 'win32 零 chmod');
  // win32 icacls 失败 ⇒ 静默吞（绝不阻断）
  const wfail = fakeDeps({ platform: 'win32', icaclsStatus: 5 });
  assert.doesNotThrow(() => tightenExistingFilePerms('C:/old/wf.json', wfail.deps));
});

// ═════════════════════════ F-5 缺省执行面（真实通道冒烟） ═════════════════════════

test('F-5: defaultFilePermsDeps / currentWindowsUser 真实面冒烟 —— 形状完整、不炸、账户名两态', () => {
  const d = defaultFilePermsDeps();
  assert.equal(typeof d.chmod, 'function', 'chmod 面');
  assert.equal(typeof d.stat, 'function', 'stat 面');
  assert.equal(typeof d.platform, 'function', 'platform 面');
  assert.equal(typeof d.icacls, 'function', 'icacls 面');
  assert.equal(typeof d.windowsUser, 'function', 'windowsUser 面');
  assert.ok(['win32', 'linux', 'darwin', 'freebsd', 'openbsd', 'sunos', 'aix'].includes(d.platform()), '平台判定真实值');
  assert.doesNotThrow(() => {
    const u = currentWindowsUser();
    assert.ok(u === null || (typeof u === 'string' && u !== ''), '账户名两态：非空串或 null');
  }, 'currentWindowsUser 真实面绝不炸');
});

// ═════════════════════════ F-6 接线执法：connection 收紧面 = 共享模块（零漂移结构证据） ═════════════════════════

test('F-6: connection 再出口与共享件同函数引用；save 收紧调用参数 = 共享 buildIcaclsArgs 装配形', async () => {
  // 单点定义的直接证据：再出口不是副本（=== 同引用），posix/win32 行为永远同源
  const connMod = await import('../src/vlm/connection.ts');
  assert.ok((connMod.buildIcaclsArgs as unknown) === (filePerms.buildIcaclsArgs as unknown),
    'connection.buildIcaclsArgs 与 filePerms.buildIcaclsArgs 是同一函数（无本地副本漂移面）');
  // 假 icacls + win32 平台：ConnectionStore.save 的收紧调用逐项过堂
  _setPlatformForTest('win32');
  const calls: IcaclsCall[] = [];
  _setIcaclsSpawnForTest(((cmd: string, args: readonly string[], opts: IcaclsCall['opts']) => {
    calls.push({ cmd, args: [...args], opts });
    return { status: 0 };
  }) as unknown as Parameters<typeof _setIcaclsSpawnForTest>[0]);
  const dir = mkdtempSync(path.join(tmpdir(), 'w8a2-wire-'));
  const file = path.join(dir, 'conn.json');
  const conn = { platform: 'glm', apiKey: 'sk-w8a2-wiring-key-7777', updatedAt: 1, via: 'wizard' as const };
  const r = new ConnectionStore(file).save(conn);
  assert.equal(r.ok, true, 'save 成功');
  assert.equal(r.perms, undefined, '收紧成功不降级');
  assert.equal(calls.length, 1, 'save 路径恰一次收紧');
  const user = calls[0]!.args[3]!.slice(0, calls[0]!.args[3]!.lastIndexOf(':'));
  assert.deepEqual(calls[0]!.args, buildIcaclsArgs(file, user), '调用参数 = 共享件装配形（接线走共享模块）');
  // 清理（save 是真实 fs 面 —— 绝不留含密残档）
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力 */ }
});

// ═════════════════════════ F-7 config 面边界执法：零落盘写点 ═════════════════════════

test('F-7: src/config.ts 零落盘写点 —— 不 import node:fs / 子进程，无任何写原语（含密配置档归宿主落盘，插件只读）', () => {
  const src = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
  // 边界执法：config 面永不自写 —— 未来任何裸写点（含密或不含密）加入即红
  assert.ok(!/\bfrom\s+'node:fs'/.test(src), '不 import node:fs');
  assert.ok(!/\bfrom\s+'node:child_process'/.test(src), '不 import node:child_process');
  assert.ok(!/\brequire\s*\(\s*'node:fs'/.test(src), '不 require node:fs');
  // 调用形匹配（描述文本里出现 "spawn 工具" 之类的散文不算 —— 只抓真调用）
  for (const prim of ['writeFileSync', 'appendFileSync', 'openSync', 'createWriteStream', 'rmSync', 'unlinkSync', 'renameSync', 'mkdirSync', 'chmodSync', 'spawn', 'spawnSync', 'exec', 'execFile', 'execSync']) {
    assert.ok(!new RegExp(`\\b${prim}\\s*\\(`).test(src), `无 ${prim}( 调用`);
  }
  // 配置面完整：密钥字段仍在（边界界定是文档，不是削减）
  assert.ok(/\bvlmApiKey\b/.test(src), 'vlmApiKey 字段仍在（配置面无损）');
});

// ═════════════════════════ F-8 插件侧含密唯一写点：写时收紧顺序执法 ═════════════════════════

test('F-8: vlm-connection.json（插件侧含密唯一写点）—— 含密落盘后必随收紧动作（假 fs/假 icacls 缝）', () => {
  _setPlatformForTest('win32');
  const order: string[] = [];
  let wroteKey = false;
  // 假 fs 面：writeFileSync / renameSync 透传真实 + 记录顺序与内容；icacls 只记录顺序
  _setFsForTest({
    writeFileSync: ((f: unknown, data: unknown, o: unknown) => {
      order.push(`write:${String(f).slice(-9)}`);
      wroteKey = wroteKey || String(data).includes('sk-w8a2-order-key-1234');
      (realFs.writeFileSync as (a: unknown, b: unknown, c: unknown) => void)(f, data, o);
    }) as never,
    renameSync: ((a: unknown, b: unknown) => {
      order.push('rename');
      (realFs.renameSync as (a: unknown, b: unknown) => void)(a, b);
    }) as never,
  });
  _setIcaclsSpawnForTest(((() => {
    order.push('icacls');
    return { status: 0 };
  }) as unknown) as Parameters<typeof _setIcaclsSpawnForTest>[0]);
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'w8a2-ord-')), 'conn.json');
  const conn = { platform: 'glm', apiKey: 'sk-w8a2-order-key-1234', updatedAt: 2, via: 'tool' as const };
  const r = new ConnectionStore(file).save(conn);
  assert.equal(r.ok, true, 'save 成功');
  assert.ok(wroteKey, '含密内容确实经插件写点落盘（被测面真实触达）');
  // 顺序执法：写 tmp → rename 原子换名 → icacls 收紧跟在换名之后（明文暴露窗口最小化）
  assert.deepEqual(order, [`write:${'.json.tmp'}`, 'rename', 'icacls'], '写时收紧顺序：write(tmp) → rename → tighten');
  // 打码统一律：展示面 maskKey 是共享唯一打码器（config.ts 无自造打码 —— F-7 已证零写点，这里证打码不旁路）
  assert.equal(maskKey('sk-w8a2-order-key-1234'), 'sk-w…1234', '展示面统一走 maskKey');
  try { rmSync(path.dirname(file), { recursive: true, force: true }); } catch { /* 尽力 */ }
});

// ═════════════════════════ F-9 宿主面如实界定（文档性断言·防边界漂移） ═════════════════════════

test('F-9: 边界界定在册 —— config.ts 注释面记录「宿主落盘 + 插件侧写点指路 filePerms」', () => {
  const src = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('W8-A2'), 'W8-A2 边界界定注释在册');
  assert.ok(src.includes('filePerms'), '插件侧加固写点指路 filePerms 在册');
  assert.ok(src.includes('宿主'), '宿主管辖面如实标注在册');
});
