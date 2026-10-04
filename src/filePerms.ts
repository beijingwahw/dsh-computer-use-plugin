// src/filePerms.ts
// W8-A2（密钥落盘加固推广）：分平台文件权限收紧的共享模块。
//
// 为什么存在：W6R-C2 先在 src/vlm/connection.ts（vlm-connection.json 明文
// apiKey 档）落了「写时收紧 + 旧档顺手收紧 + 失败诚实降级」的加固面。凡插件
// 写出的含密文件都该走同一套（配置面 / 存档面 / 未来新写点），故把纯函数与
// 平台路由上提为通用件，connection.ts 改为引用本模块（行为逐字节不变）。
//
// 加固语义（与 W6R-C2 同律）：
//   - POSIX —— chmod 0600（writeFileSync mode + rename 前后双 chmod 由调用方
//     编排；本模块只管「收紧这一个文件」与「旧档是否宽松」两件纯判定）
//   - win32 —— icacls 断继承（/inheritance:r /grant:r "<当前用户>:F"，
//     数组参数、不经 shell —— chmod 在 Windows 只是只读位，管不了 ACL）
//   - 一切「尽力 + 诚实」：收紧失败 ⇒ 回 false，由调用方标注
//     insecure-perms 继续走 —— 权限收紧失败不得破坏功能，但也不许伪装已安全。
//
// 铁律：导出的收紧函数绝不抛异常（内部全兜）；纯函数（buildIcaclsArgs）
// 无副作用、无 I/O；副作用函数的执行面（fs / 子进程 / 平台判定 / 账户名）
// 一律可经 deps 注入 —— 测试注入假件即离线执法。
import { chmodSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { spawnSync } from 'node:child_process';

/** 降级回执标记：档已落盘（功能未损）但平台权限收紧失败 —— 诚实暴露宽松落盘，绝不伪装成已安全 */
export type InsecurePerms = 'insecure-perms';

/** 带降级标注的写回执形状 —— 供各写点（连接存档 / 未来含密配置写点）的回执复用 */
export interface PermsDegradeReceipt {
  /** 收紧尽力失败时的诚实标注（值恒为 'insecure-perms'） */
  perms?: InsecurePerms;
}

/** icacls 子进程通道形状：数组参数、无 shell、静默回执（真实 spawnSync 满足此形状） */
export type IcaclsSpawnSyncLike = (
  cmd: string,
  args: readonly string[],
  opts: { stdio: 'ignore'; shell: false; windowsHide: true },
) => { status: number | null };

/**
 * icacls 参数装配（纯函数）：['<file>', '/inheritance:r', '/grant:r', '<user>:F']
 * 数组形态即免 shell 引用 —— 用户名含空格 / 中文 / 域前缀都作为一个 argv 元素
 * 原样直达 icacls，无拼接、无解释层。/inheritance:r 断父目录继承，
 * /grant:r 只留当前账户完全控制（:F）。
 */
export function buildIcaclsArgs(filePath: string, user: string): string[] {
  return [filePath, '/inheritance:r', '/grant:r', `${user}:F`];
}

/** 当前 Windows 账户名：os.userInfo().username 优先，env USERNAME 兜底；双缺 ⇒ null（无从授权） */
export function currentWindowsUser(): string | null {
  try {
    const u = userInfo().username;
    if (typeof u === 'string' && u.trim() !== '') return u;
  } catch { /* 个别受限环境 userInfo 可能抛 —— 走 env 兜底 */ }
  try {
    const e = process.env.USERNAME;
    if (typeof e === 'string' && e.trim() !== '') return e;
  } catch { /* 防御式：env 访问也不许炸 */ }
  return null;
}

/**
 * 收紧执行面 —— 全部可注入（缺省全真实）：
 *   chmod / stat —— fs 侧证据与动手面（POSIX 分支专用；win32 分支不碰）
 *   platform     —— 平台判定（'win32' ⇒ icacls 路由；其余 ⇒ chmod 路由）
 *   icacls       —— Windows ACL 子进程通道（真实 spawnSync 满足形状）
 *   windowsUser  —— ACL 授权对象（真实 currentWindowsUser）
 */
export interface FilePermsDeps {
  chmod: typeof chmodSync;
  stat: typeof statSync;
  platform: () => string;
  icacls: IcaclsSpawnSyncLike;
  windowsUser: () => string | null;
}

/** 缺省执行面（全真实）：每次现取 —— 注入面覆盖不进真实通道 */
export function defaultFilePermsDeps(): FilePermsDeps {
  return {
    chmod: chmodSync,
    stat: statSync,
    platform: () => process.platform,
    icacls: spawnSync as unknown as IcaclsSpawnSyncLike,
    windowsUser: currentWindowsUser,
  };
}

/**
 * Windows ACL 收紧（绝不抛）：icacls 断继承 + 当前账户独占完全控制。
 * 败相（非零退出 / icacls 缺席 status null / 同步抛 / 取不到账户名）⇒ false
 * —— 由调用方诚实标注 insecure-perms，功能继续。
 */
export function tightenWindowsAcl(filePath: string, deps: FilePermsDeps = defaultFilePermsDeps()): boolean {
  try {
    const user = deps.windowsUser();
    if (user === null) return false;
    const r = deps.icacls('icacls', buildIcaclsArgs(filePath, user), { stdio: 'ignore', shell: false, windowsHide: true });
    return typeof r?.status === 'number' && r.status === 0;
  } catch {
    return false;
  }
}

/**
 * 单文件收紧（分平台路由，绝不抛）：
 *   POSIX —— chmod 0600（rename 后保险刀：个别文件系统 rename 会重置权限位）
 *   win32 —— icacls ACL 收紧（chmod 在 Windows 只是只读位，管不了 ACL）
 * 回执：true = 已收紧；false = 尽力失败（调用方标注 insecure-perms）
 */
export function tightenFilePerms(filePath: string, deps: FilePermsDeps = defaultFilePermsDeps()): boolean {
  try {
    if (deps.platform() === 'win32') return tightenWindowsAcl(filePath, deps);
    deps.chmod(filePath, 0o600);
    return true;
  } catch {
    return false;
  }
}

/**
 * 旧档顺手收紧（读档路径专用 —— 绝不抛、绝不阻断读档）：
 *   POSIX —— stat 检查 group/other 位（mode & 0o077）：宽松才 chmod 0600（不惊动已收紧档）
 *   win32 —— ACL 无廉价探测面：幂等 icacls 每次尽力（/inheritance:r /grant:r
 *            重复执行结果一致；每会话读档一次，成本可控）
 */
export function tightenExistingFilePerms(filePath: string, deps: FilePermsDeps = defaultFilePermsDeps()): void {
  try {
    if (deps.platform() === 'win32') {
      tightenWindowsAcl(filePath, deps);
      return;
    }
    const st = deps.stat(filePath);
    if ((st.mode & 0o077) !== 0) {
      try { deps.chmod(filePath, 0o600); } catch { /* 收紧失败不阻断读档 */ }
    }
  } catch { /* stat 失败等一切异常：读档优先，吞 */ }
}
