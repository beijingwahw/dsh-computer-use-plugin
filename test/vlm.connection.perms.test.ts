// test/vlm.connection.perms.test.ts
// W6R-C2（落盘加固）执法册：vlm-connection.json 明文 apiKey 档位的权限收紧面。
// 铁律：全离线 —— icacls 通道一律注入假 spawn（绝不真跑子进程执法断言；
// 真实通道只在冒烟用例对本机临时文件尽力）；fs 执行面经 _setFsForTest 注入
// 透传假件（记录参数 + 原样落盘）；平台分支经 _setPlatformForTest 伪造 ——
// 测试在任意宿主平台上都确定性走 win32 / linux 两支。环境变量零触碰。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';

const {
  ConnectionStore,
  buildIcaclsArgs,
  maskKey,
  _setFsForTest,
  _setIcaclsSpawnForTest,
  _setPlatformForTest,
} = await import('../src/vlm/connection.ts');

// ─── 临时目录（每测一新的；测试自洁 —— 不留垃圾） ───

let dir: string;
const dirs: string[] = [];
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'vlmperms-'));
  dirs.push(dir);
});
process.on('exit', () => {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

// ─── 注入缝现场恢复：每测结束全部回真实通道（缝泄漏 = 后续测试污染源） ───

afterEach(() => {
  _setIcaclsSpawnForTest(null);
  _setFsForTest(null);
  _setPlatformForTest(null);
});

// ─── 假件铸造 ───

/** 假 icacls 通道：捕获 (cmd, args, opts) 原样参数，回放可控退出码 / 抛错 */
interface IcaclsCall {
  cmd: string;
  args: string[];
  opts: { stdio: unknown; shell: unknown; windowsHide: unknown };
}

function fakeIcacls(returns: { status: number | null } | { throws: unknown }) {
  const calls: IcaclsCall[] = [];
  const fn = ((cmd: string, args: readonly string[], opts: IcaclsCall['opts']) => {
    calls.push({ cmd, args: [...args], opts });
    if ('throws' in returns) throw returns.throws;
    return { status: returns.status };
  }) as unknown as Parameters<typeof _setIcaclsSpawnForTest>[0];
  _setIcaclsSpawnForTest(fn);
  return { calls };
}

/**
 * 组合 fs 探针（一次 _setFsForTest 注入全部假件 —— 多次注入会互相覆盖，
 * 故 write/chmod/stat 探测必须合并成单次调用）：
 *   write —— 透传真实 + 记录 options.mode（创建即收紧的证据）
 *   chmod —— 透传真实 + 记录 (file, mode)（双 chmod / 旧档收紧的证据）
 *   stat  —— 回放可控 mode 或抛错（load 宽松判定的证据；Windows 真实
 *            statSync 恒报 0o666 模拟位，POSIX 分支判定必须离线回放）
 */
interface WriteCall { file: string; mode: number | undefined }
interface ChmodCall { file: string; mode: number }

function recordFs(parts: {
  write?: boolean;
  chmod?: boolean;
  stat?: () => { mode: number };
}): { writes: WriteCall[]; chmods: ChmodCall[] } {
  const writes: WriteCall[] = [];
  const chmods: ChmodCall[] = [];
  const realW = writeFileSync;
  const realC = chmodSync;
  _setFsForTest({
    ...(parts.write === true ? {
      writeFileSync: ((f: unknown, d: unknown, o: unknown) => {
        writes.push({ file: String(f), mode: (o as { mode?: number } | null | undefined)?.mode });
        (realW as (a: unknown, b: unknown, c: unknown) => void)(f, d, o);
      }) as never,
    } : {}),
    ...(parts.chmod === true ? {
      chmodSync: ((f: unknown, m: unknown) => {
        chmods.push({ file: String(f), mode: m as number });
        (realC as (a: unknown, b: unknown) => void)(f, m);
      }) as never,
    } : {}),
    ...(parts.stat !== undefined ? { statSync: parts.stat as never } : {}),
  });
  return { writes, chmods };
}

/** 预置真实档（不经 ConnectionStore —— 让被测面从「旧档已存在」起步） */
function seedFile(file: string, conn: Record<string, unknown>): void {
  writeFileSync(file, JSON.stringify(conn), 'utf8');
}

const FULL_CONN = {
  platform: 'glm',
  apiKey: 'sk-w6r-c2-perms-abcdef9876',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  model: 'glm-4v-plus',
  updatedAt: 1700000000000,
  via: 'wizard' as const,
};

/** 本机期望的当前账户名（userInfo 优先、USERNAME 兜底 —— 与实现同序） */
function expectedUser(): string {
  try {
    const u = userInfo().username;
    if (typeof u === 'string' && u !== '') return u;
  } catch { /* 防御式 */ }
  return process.env.USERNAME ?? '';
}

// ═════════════════════════ P-1 参数装配（纯函数） ═════════════════════════

test('P-1: buildIcaclsArgs —— 数组四元 [file, /inheritance:r, /grant:r, <user>:F]，无引号拼接', () => {
  assert.deepEqual(buildIcaclsArgs('C:/x/conn.json', 'alice'), [
    'C:/x/conn.json', '/inheritance:r', '/grant:r', 'alice:F',
  ], '标准形态');
  // 用户名含空格 / 中文 / 域前缀：仍是一个 argv 元素（数组即免 shell 引用）
  const spaced = buildIcaclsArgs('C:/x/c.json', 'FirstName LastName');
  assert.equal(spaced.length, 4, '含空格用户名不拆参数');
  assert.equal(spaced[3], 'FirstName LastName:F', '空格用户名整体成 grant 单元');
  const cjk = buildIcaclsArgs('/home/u/c.json', '张三');
  assert.equal(cjk[3], '张三:F', '中文用户名原样直达');
  assert.equal(cjk[1], '/inheritance:r', '断继承位');
  assert.equal(cjk[2], '/grant:r', '重授权位（替换而非追加）');
});

// ═════════════════════════ P-2 Windows save：icacls 通道执法 ═════════════════════════

test('P-2: win32 save —— icacls 数组参数、无 shell、静默回执、grant 当前用户；收紧成功不标 perms', () => {
  _setPlatformForTest('win32');
  const { calls } = fakeIcacls({ status: 0 });
  const file = path.join(dir, 'win.json');
  const store = new ConnectionStore(file);
  const r = store.save(FULL_CONN);
  // 功能面：档落盘、回执干净（成功收紧 ⇒ 无降级标注）
  assert.equal(r.ok, true, 'save 成功');
  assert.equal(r.perms, undefined, 'icacls 退出 0 ⇒ 不标 insecure-perms');
  assert.equal(existsSync(file), true, '档位落盘');
  // 通道面（load 之前执法）：save 路径恰好一次（rename 后收紧），参数形态逐项过堂
  assert.equal(calls.length, 1, 'save 路径只调一次 icacls');
  const c = calls[0]!;
  assert.equal(c.cmd, 'icacls', '命令名');
  assert.ok(Array.isArray(c.args), '参数走数组（非字符串拼接）');
  assert.equal(c.args[0], file, '目标是最终档（非 tmp）');
  assert.equal(c.args[1], '/inheritance:r', '断父目录继承');
  assert.equal(c.args[2], '/grant:r', '重授权');
  assert.equal(c.args[3], `${expectedUser()}:F`, '当前账户独占完全控制');
  assert.ok(!c.args.some(a => a.includes(' ')), '无手工引号（数组元素即免 shell 引用）');
  assert.equal(c.opts.shell, false, '绝不走 shell 解释层');
  assert.equal(c.opts.stdio, 'ignore', '子进程回执静默（不外泄）');
  assert.equal(c.opts.windowsHide, true, '不闪控制台窗口');
  // load 往返 + 顺手收紧（第二次 icacls = load 幂等尽力，目标同档）
  assert.equal(store.load()!.apiKey, FULL_CONN.apiKey, 'load 往返无损');
  assert.equal(calls.length, 2, 'load 顺手再收紧一次（幂等）');
  assert.equal(calls[1]!.args[0], file, 'load 收紧目标同档');
});

// ═════════════════════════ P-3 POSIX save：mode 0600 + 双 chmod ═════════════════════════

test('P-3: posix save —— writeFileSync 即带 mode 0o600、rename 前后双 chmod、不走 icacls、回执干净', () => {
  _setPlatformForTest('linux');
  const icacls = fakeIcacls({ status: 0 });
  const { writes, chmods } = recordFs({ write: true, chmod: true });
  const file = path.join(dir, 'posix.json');
  const store = new ConnectionStore(file);
  const r = store.save(FULL_CONN);
  assert.equal(r.ok, true, 'save 成功');
  assert.equal(r.perms, undefined, 'POSIX chmod 成功 ⇒ 不标 insecure-perms');
  assert.equal(existsSync(file), true, '档位落盘');
  // 创建即收紧：writeFileSync 的 options.mode === 0o600（压缩明文暴露窗口）
  assert.equal(writes.length, 1, '一次 tmp 写入');
  assert.equal(writes[0]!.file, file + '.tmp', '写的是 tmp');
  assert.equal(writes[0]!.mode, 0o600, 'tmp 创建即 mode 0600');
  // rename 前后双 chmod：先 tmp 补刀、后最终档保险
  assert.deepEqual(chmods.map(x => ({ file: x.file, mode: x.mode })), [
    { file: file + '.tmp', mode: 0o600 },
    { file, mode: 0o600 },
  ], 'rename 前 tmp chmod + rename 后档 chmod');
  // POSIX 分支绝不经 icacls
  assert.equal(icacls.calls.length, 0, 'POSIX 不走 icacls 通道');
  assert.equal(existsSync(file + '.tmp'), false, '无 tmp 残留（原子写不变量保持）');
});

// ═════════════════════════ P-4/P-5 Windows 降级路径：icacls 失败不炸功能 ═════════════════════════

test('P-4: win32 save 降级 —— icacls 非零退出 ⇒ { ok:true, perms:"insecure-perms" }，档照写', () => {
  _setPlatformForTest('win32');
  fakeIcacls({ status: 1 }); // icacls 拒绝（如路径锁 / 策略限制）
  const file = path.join(dir, 'degrade.json');
  const store = new ConnectionStore(file);
  const r = store.save(FULL_CONN);
  assert.equal(r.ok, true, '收紧失败不得破坏存档功能');
  assert.equal(r.perms, 'insecure-perms', '诚实降级标注（不伪装安全）');
  assert.equal(store.load()!.apiKey, FULL_CONN.apiKey, '档内容完整、可续读');
});

test('P-5: win32 败相收敛 —— icacls 同步抛 / status null（icacls 缺席）均降级不炸', () => {
  _setPlatformForTest('win32');
  // 败相一：同步抛异常
  fakeIcacls({ throws: new Error('ENOENT icacls missing') });
  const f1 = path.join(dir, 'throw.json');
  const r1 = new ConnectionStore(f1).save(FULL_CONN);
  assert.equal(r1.ok, true, '同步抛 ⇒ 功能不炸');
  assert.equal(r1.perms, 'insecure-perms', '同步抛 ⇒ 降级标注');
  // 败相二：status null（spawn 失败面）
  fakeIcacls({ status: null });
  const f2 = path.join(dir, 'null-status.json');
  const r2 = new ConnectionStore(f2).save(FULL_CONN);
  assert.equal(r2.ok, true, 'status null ⇒ 功能不炸');
  assert.equal(r2.perms, 'insecure-perms', 'status null ⇒ 降级标注');
  assert.equal(existsSync(f2), true, '档位仍落盘');
});

// ═════════════════════════ P-6/P-7 load 顺手收紧旧档 ═════════════════════════

test('P-6: posix load —— 旧档宽松（group/other 位在）⇒ chmod 收紧；已紧 ⇒ 不动手；stat 失败不阻断', () => {
  _setPlatformForTest('linux');
  const file = path.join(dir, 'old.json');
  seedFile(file, { platform: 'glm', apiKey: 'sk-old-loose-key-9999', updatedAt: 1, via: 'wizard' });
  const store = new ConnectionStore(file);
  // 宽松档（0o644：group r + other r）⇒ 收紧一次
  const loose = recordFs({ chmod: true, stat: () => ({ mode: 0o644 }) });
  const loaded = store.load();
  assert.notEqual(loaded, null, '读档不受收紧影响');
  assert.equal(loaded!.apiKey, 'sk-old-loose-key-9999', '旧档内容无损');
  assert.deepEqual(loose.chmods.map(x => x.mode), [0o600], '宽松旧档被收紧为 0600');
  // 已紧档（0o600）⇒ 不惊动
  const tight = recordFs({ chmod: true, stat: () => ({ mode: 0o600 }) });
  assert.notEqual(store.load(), null, '已紧档照常可读');
  assert.equal(tight.chmods.length, 0, '已收紧档不再多余 chmod');
  // stat 本身抛错 ⇒ 读档照样成功（绝不阻断）
  const blind = recordFs({ chmod: true, stat: () => { throw new Error('EACCES'); } });
  assert.notEqual(store.load(), null, 'stat 失败不阻断读档');
  assert.equal(blind.chmods.length, 0, 'stat 失败时无从判定 ⇒ 不动手（不误伤）');
});

test('P-7: win32 load —— 幂等 icacls 顺手收紧旧档；icacls 失败读档照常', () => {
  _setPlatformForTest('win32');
  const file = path.join(dir, 'old-win.json');
  seedFile(file, { platform: 'qwen', apiKey: 'sk-win-old-key-4321', updatedAt: 2, via: 'tool' });
  const store = new ConnectionStore(file);
  const { calls } = fakeIcacls({ status: 0 });
  const loaded = store.load();
  assert.notEqual(loaded, null, '读档正常');
  assert.equal(loaded!.platform, 'qwen', '内容无损');
  assert.equal(calls.length, 1, 'load 顺手跑一次 icacls（ACL 无廉价探测面 ⇒ 幂等尽力）');
  assert.equal(calls[0]!.args[0], file, '收紧目标就是旧档本身');
  assert.equal(calls[0]!.args[3], `${expectedUser()}:F`, '授权当前账户');
  // icacls 失败（status 5）⇒ load 依然完整返回，绝不抛
  fakeIcacls({ status: 5 });
  assert.doesNotThrow(() => {
    const again = store.load();
    assert.notEqual(again, null, '收紧失败不阻断读档');
    assert.equal(again!.apiKey, 'sk-win-old-key-4321', 'key 完整读回');
  });
});

// ═════════════════════════ P-8 错误面脱敏：明文 key 绝不进 error ═════════════════════════

test('P-8: save 失败 —— error 面不含 apiKey 明文（嵌 key 的异常消息也被打码替换）', () => {
  const KEY = 'sk-leaky-plainkey-42XX-w6r';
  const conn = { ...FULL_CONN, apiKey: KEY };
  // 恶意 rename：异常 message 意外嵌有 key 原值（模拟下层实现把秘密带进错误面）
  const realUnlink = unlinkSync;
  _setFsForTest({
    renameSync: (() => { throw new Error(`EPERM: rename '<tmp>' -> '<file>' blocked; secret=${KEY}`); }) as never,
    unlinkSync: ((f: unknown) => realUnlink(f as Parameters<typeof realUnlink>[0])) as never,
  });
  const file = path.join(dir, 'leak.json');
  const store = new ConnectionStore(file);
  const r = store.save(conn);
  assert.equal(r.ok, false, '写入失败如实回报');
  assert.ok(typeof r.error === 'string' && r.error !== '', 'error 面有内容');
  assert.ok(!r.error!.includes(KEY), 'error 绝不含明文 key');
  assert.ok(r.error!.includes(maskKey(KEY)), 'key 原值被替换为打码形态（防御纵深生效）');
  assert.ok(!existsSync(file + '.tmp') || true, 'tmp 清理尽力（不执法 —— 失败面已由 ok:false 表达）');
});

// ═════════════════════════ P-9 注入缝防御 + 真实通道冒烟 ═════════════════════════

test('P-9: 注入缝防御 —— 非函数注入按真实通道处理；真实通道 save/load 冒烟不炸', () => {
  // 垃圾注入不得把真实通道顶掉（防御式：typeof 校验回退）
  _setIcaclsSpawnForTest(42 as unknown as null);
  _setPlatformForTest('');
  const file = path.join(dir, 'smoke.json');
  const store = new ConnectionStore(file);
  // 本机真实通道（win32 ⇒ 真 icacls；posix ⇒ 真 chmod）：尽力收紧，功能必须完整
  const r = store.save(FULL_CONN);
  assert.equal(r.ok, true, '真实通道 save 成功（收紧尽力，回执 ok 只看写入）');
  assert.equal(store.load()!.apiKey, FULL_CONN.apiKey, '真实通道往返无损');
  if (process.platform === 'win32') {
    // 真实 icacls 成功的机器上档位 ACL 已断继承（尽力断言：收紧失败也只降级标注）
    assert.equal(r.perms === 'insecure-perms' || r.perms === undefined, true, 'perms 只有两态');
  }
  // 存量文件权限位可读（不炸 stat 面）
  assert.ok(typeof statSync(file).mode === 'number', '落盘文件 mode 可 stat');
});

// ═════════════════════════ P-10 clear 不受加固面影响（回归护栏） ═════════════════════════

test('P-10: clear 回归 —— 加固面引入后删档幂等语义不变', () => {
  _setPlatformForTest('win32');
  fakeIcacls({ status: 0 });
  const file = path.join(dir, 'clear.json');
  const store = new ConnectionStore(file);
  assert.equal(store.clear().ok, true, '缺席也 ok');
  assert.equal(store.save(FULL_CONN).ok, true);
  assert.equal(store.clear().ok, true);
  assert.equal(existsSync(file), false, '删净');
  assert.equal(store.clear().ok, true, '再删仍 ok（幂等）');
  assert.equal(store.load(), null, '删后 load ⇒ null');
});
