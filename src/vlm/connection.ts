// src/vlm/connection.ts
// 纪元 Λ（Λ-1 开箱即亮）：连接存档 —— 用户视觉脑选择的持久化单点。
//
// 为什么存在：Ψ 纪元立起了十三颗脑的花名册（providers/registry），但用户选定
// 的那颗脑（platform / apiKey / baseUrl / model）此前只活在内存里 —— 进程一
// 重启就回零，每次开箱都要重新配一遍。本模块把「当前连接」收敛为 ~/.dsh 下的
// 一个小 JSON 档（vlm-connection.json），宿主启动时读取即续连：
//   - defaultConnectionPath —— ~/.dsh/vlm-connection.json（DSH_VLM_CONNECTION
//     可覆写；与 physicalBackend 的 ~/.dsh 稳定路径先例同律）
//   - ConnectionStore.load  —— 防御性消毒读：缺席 / 坏 JSON / 非对象 / platform
//     非空串缺位 ⇒ null（坏档视为无档）；字段级脏值就地归一（apiKey/baseUrl/
//     model 空白归 undefined、非法 via 归 'config'、updatedAt 非有限归 Date.now()）
//   - ConnectionStore.save  —— tmp + rename 原子写（checkpoint 同款先例）：要么
//     完整旧档要么完整新档，绝无半档；目录自动建；权限收紧尽力（见 W6R-C2 区）
//   - ConnectionStore.clear —— 删档（文件缺席也 ok —— 幂等清理）
//   - maskKey              —— 密钥展示打码（日志 / UI 面绝不泄漏原值）
// 铁律（与兄弟模块同调）：绝不抛异常 —— 一切失败以 null / { ok:false } 表达。
//
// W6R-C2（落盘加固）：档案内嵌 apiKey 明文，chmod 0600 在 Windows 只是只读位开
// 关、对 ACL 无效 —— 存档默认继承父目录 ACL。故收紧分平台：POSIX 走
// writeFileSync mode 0o600 + rename 前后双 chmod；Windows 走 icacls 断继承
// （/inheritance:r /grant:r "<当前用户>:F"，数组参数、不经 shell）。收紧一切
// 「尽力 + 诚实」：失败 ⇒ 降级标注 insecure-perms 继续走 —— 权限收紧失败不得
// 破坏存档功能，但也不许伪装成已安全。
//
// W8-A2（加固推广·共享化）：上述纯函数与平台路由上提至 src/filePerms.ts 共享
// 模块（config 面等未来含密写点同律复用）；本模块保留自身三个测试缝（fs 面 /
// 平台判定 / icacls 通道），经 permsDeps() 适配器注入共享模块 —— 行为逐字节
// 不变，test/vlm.connection.perms.test.ts 十例原样全绿即零漂移证据。
//
// ΑΩ-R9（密钥静态加密·可选）：环境变量 DSH_VLM_STORE_PASSPHRASE 在场时，落档
// 的 apiKey 字段以 AES-256-GCM 加密（scrypt 派生密钥 + 随机 salt/iv + 版本化
// 魔数 "DSHENC1:" 信封，盐/iv/认证标签随密文同存）；口令缺席 ⇒ 保持明文现状，
// 但档内元数据 encryption 如实申报 'none'（诚实申报，不虚报），加密时申报
// 'aes-256-gcm'。读档先探魔数：密文 ⇒ 解密（口令缺席 / 错口令 / 密文损坏 ⇒
// load 回 null 并经可选 detail 参数归因 —— 与「坏档视为无档」同语义，绝不抛、
// 绝不把密文当明文吐出）；旧明文档无论口令在场与否照常读（向后兼容）。加密
// 失败 ⇒ save 拒绝落盘（{ ok:false } —— 口令在场时绝不静默降级明文）。明文与
// 解密结果仅在内存瞬时存在，绝不回写。原子写与权限收紧纪律（W6R-C2/W8-A2）
// 原样保持。
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import {
  currentWindowsUser,
  defaultFilePermsDeps,
  tightenExistingFilePerms as tightenExistingFilePermsShared,
  tightenFilePerms as tightenFilePermsShared,
  type FilePermsDeps,
  type InsecurePerms,
  type IcaclsSpawnSyncLike,
} from '../filePerms';

// 共享模块再出口：既有消费面（测试 / 兄弟模块）从本模块取件不破（纯转发，无副本）
export { buildIcaclsArgs } from '../filePerms';
export type { IcaclsSpawnSyncLike, InsecurePerms, PermsDegradeReceipt } from '../filePerms';

/** 当前连接档案 —— 一颗「脑」的选中凭证（platform 为 registry 预设 id） */
export interface VisionConnection {
  /** 平台 id（registry 预设之一，如 'glm' / 'ollama'） */
  platform: string;
  /** API Key（本地免密平台 undefined） */
  apiKey?: string;
  /** 服务基址（采用预设缺省时 undefined） */
  baseUrl?: string;
  /** 模型名（依赖运行时发现时 undefined） */
  model?: string;
  /** 档案写入时刻（Date.now() 毫秒） */
  updatedAt: number;
  /** 归因：这颗脑是怎么被选上的（向导 / 本地自动收养 / 工具改写 / 配置解析） */
  via: 'wizard' | 'auto-adopt' | 'tool' | 'config';
}

/** 缺省档位 —— ~/.dsh/vlm-connection.json；DSH_VLM_CONNECTION 覆写（physicalBackend 同律） */
export function defaultConnectionPath(): string {
  return process.env.DSH_VLM_CONNECTION ?? join(homedir(), '.dsh', 'vlm-connection.json');
}

// ─── 消毒（load 的字段级归一 —— 单点定义，绝不抛） ───

/** via 合法值集合（越界值归 'config'） */
const VIA_VALUES: ReadonlySet<string> = new Set(['wizard', 'auto-adopt', 'tool', 'config']);

/** 可选字符串物料消毒：非字符串 / 纯空白 ⇒ undefined；否则原值保留 */
function sanitizeOptionalString(v: unknown): string | undefined {
  try {
    return typeof v === 'string' && v.trim() !== '' ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 整档消毒：null / 非对象 ⇒ null；platform 非非空串 ⇒ null（档位根基缺失 =
 * 坏档）；三物料空白归 undefined；via 越界归 'config'；updatedAt 非有限数归
 * Date.now()（时间戳缺位补当下，不虚造古老时间）。
 */
function sanitizeConnection(raw: unknown): VisionConnection | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.platform !== 'string' || r.platform.trim() === '') return null;
  const via = typeof r.via === 'string' && VIA_VALUES.has(r.via) ? r.via : 'config';
  const updatedAt =
    typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : Date.now();
  return {
    platform: r.platform,
    apiKey: sanitizeOptionalString(r.apiKey),
    baseUrl: sanitizeOptionalString(r.baseUrl),
    model: sanitizeOptionalString(r.model),
    updatedAt,
    via: via as VisionConnection['via'],
  };
}

/** 错误串化（save/clear 的 error 面）——任何故障归为一句短消息，绝不抛 */
function errText(e: unknown): string {
  try {
    const msg = (e as { message?: unknown } | null)?.message;
    if (typeof msg === 'string' && msg !== '') return msg.slice(0, 300);
    return String(e ?? 'unknown error').slice(0, 300);
  } catch {
    return 'unknown error';
  }
}

// ─── W6R-C2：落盘权限加固 —— 明文 apiKey 档位的最后一道门闩 ───

/** save/clear 的写回执 —— perms 仅在「档已落盘但权限收紧失败」时诚实标注（降级不阻断功能） */
export interface ConnectionWriteOutcome {
  ok: boolean;
  error?: string;
  /**
   * 降级标注：档已写上（功能未损），但平台权限收紧（POSIX chmod / Windows
   * icacls）失败 —— 诚实暴露宽松落盘，绝不伪装成已安全。
   */
  perms?: InsecurePerms;
}

/** fs 执行面 —— 真实实现集中一处，测试可注入假件（先例：system._setOpenUrlSpawnForTest） */
export interface FsFace {
  mkdirSync: typeof mkdirSync;
  writeFileSync: typeof writeFileSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
  existsSync: typeof existsSync;
  readFileSync: typeof readFileSync;
  chmodSync: typeof chmodSync;
  statSync: typeof statSync;
}

const REAL_FS: FsFace = {
  mkdirSync, writeFileSync, renameSync, unlinkSync, existsSync, readFileSync, chmodSync, statSync,
};

/** 当前 fs 执行面（默认全真实；测试经 _setFsForTest 覆写。宿主永不触碰注入缝） */
let fsFace: FsFace = REAL_FS;

/** 测试缝：部分 / 整体替换 fs 执行面（null = 全真实）。任何构造异常回退真实面（防御式） */
export function _setFsForTest(partial: Partial<FsFace> | null): void {
  try {
    fsFace = partial === null ? REAL_FS : Object.assign({}, REAL_FS, partial);
  } catch {
    fsFace = REAL_FS;
  }
}

/** 平台判定（缺省真实 process.platform；测试经 _setPlatformForTest 伪造走分支） */
let platformOverride: string | null = null;
function currentPlatform(): string {
  return platformOverride ?? process.platform;
}

/** 测试缝：覆写平台判定（空串 / null = 回真实）。icacls 与 chmod 分支的路由开关 */
export function _setPlatformForTest(platform: string | null): void {
  platformOverride = typeof platform === 'string' && platform !== '' ? platform : null;
}

let icaclsSpawnOverride: IcaclsSpawnSyncLike | null = null;

/** 测试缝：注入假 icacls 通道捕获 (cmd, args, opts)（null = 真实 spawnSync）。注入非函数按真实处理 */
export function _setIcaclsSpawnForTest(fn: IcaclsSpawnSyncLike | null): void {
  icaclsSpawnOverride = typeof fn === 'function' ? fn : null;
}

/**
 * 共享模块适配器 —— 把本模块三个测试缝（fsFace / currentPlatform /
 * icaclsSpawnOverride）实时转发给 filePerms 共享件：缺省全真实；任一缝被
 * 注入 ⇒ 共享件走的即注入面（W8-A2：收紧逻辑单点在共享模块，本模块只留缝）。
 * 每次收紧现取适配（缝覆盖即时生效，无缓存可污染）。
 */
function permsDeps(): FilePermsDeps {
  const real = defaultFilePermsDeps();
  return {
    chmod: fsFace.chmodSync,
    stat: fsFace.statSync,
    platform: currentPlatform,
    icacls: icaclsSpawnOverride ?? real.icacls,
    windowsUser: currentWindowsUser,
  };
}

/** 错误面脱敏（防御纵深）：错误文本若意外嵌有 apiKey 原值，整串替换为打码形态 */
function redactKeyFrom(text: string, key?: string): string {
  try {
    if (typeof key !== 'string' || key === '') return text;
    return text.split(key).join(maskKey(key));
  } catch {
    return text;
  }
}

// ─── ΑΩ-R9：apiKey 可选静态加密（AES-256-GCM + scrypt，零依赖 node:crypto） ───

/** 存档元数据申报值：'none' = 明文现状（诚实申报，不虚报）；'aes-256-gcm' = 密钥字段已加密 */
export type ConnectionEncryption = 'none' | 'aes-256-gcm';

/**
 * load 的可选归因出口（ΑΩ-R9）：不传 ⇒ 行为与既往完全一致；传入 ⇒ 读档失败
 * （密文解不开 / 坏 JSON / 读 I/O 故障）时给出归因短句，encryption 原样回报
 * 档案自己的申报值（旧档未申报 ⇒ 不设）。填报尽力而为 —— 填 detail 本身绝不抛。
 */
export interface ConnectionLoadDetail {
  /** 档案申报的加密形态（档案未申报 / 申报越界 ⇒ undefined） */
  encryption?: ConnectionEncryption;
  /** 读档失败归因（文件缺席不设；解密失败 / 坏档时给短句，≤300 字符） */
  error?: string;
}

/** 密文信封魔数（版本化）：格式 DSHENC1:<salt-b64>:<iv-b64>:<tag-b64>:<cipher-b64>，盐/iv/标签随密文同存 */
const ENC_MAGIC = 'DSHENC1:';

/** 信封载荷段数（salt / iv / tag / cipher —— 结构损坏判界） */
const ENC_PAYLOAD_SEGMENTS = 4;

/** scrypt 盐长（随机，随密文同存 —— 每次加密现取，同明文两次落盘信封必不同） */
const ENC_SALT_BYTES = 16;

/** GCM 标准 96-bit nonce 长 */
const ENC_IV_BYTES = 12;

/** GCM 认证标签长（getAuthTag 缺省 16 字节） */
const ENC_TAG_BYTES = 16;

/** AES-256 密钥长 */
const ENC_KEY_BYTES = 32;

/** scrypt 代价参数（N=16384/r=8/p=1，约 16MiB 内存 —— 口令穷举的成本闸） */
const ENC_SCRYPT_COST = { N: 16384, r: 8, p: 1 };

/**
 * 加密口令（env DSH_VLM_STORE_PASSPHRASE，每次现取 —— env 变化即生效，与
 * defaultConnectionPath 同律）：纯空白串视为缺席 —— 不可用的口令 = 没有口令，
 * 绝不拿空白口令虚造一层「已加密」的假安全。绝不抛。
 */
function storePassphrase(): string | undefined {
  try {
    const v = process.env.DSH_VLM_STORE_PASSPHRASE;
    return typeof v === 'string' && v.trim() !== '' ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 明文 ⇒ 密文信封（绝不抛）：scrypt(passphrase, salt) 派生 AES-256 密钥，
 * GCM 加密（随机 iv），盐/iv/标签/密文四段 base64 同存于信封。任何失败 ⇒
 * null —— 由调用方拒绝落盘（口令在场时绝不静默降级明文）。
 */
function encryptApiKey(plain: string, passphrase: string): string | null {
  try {
    const salt = randomBytes(ENC_SALT_BYTES);
    const iv = randomBytes(ENC_IV_BYTES);
    const key = scryptSync(passphrase, salt, ENC_KEY_BYTES, ENC_SCRYPT_COST);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      ENC_MAGIC + salt.toString('base64'),
      iv.toString('base64'),
      tag.toString('base64'),
      body.toString('base64'),
    ].join(':');
  } catch {
    return null;
  }
}

/**
 * 密文信封 ⇒ 明文（绝不抛）：魔数 / 段数 / 各段长度先验，scrypt 派生密钥后
 * GCM 解密并验签。结构损坏 ⇒ ok:false（结构归因）；GCM 校验失败（错口令或
 * 密文被篡改，final() 抛）⇒ ok:false（统一归因到口令/损坏 —— 两者在 GCM 下
 * 不可区分，归因措辞如实并列）。
 */
function decryptApiKey(
  envelope: string,
  passphrase: string,
): { ok: true; plain: string } | { ok: false; reason: string } {
  try {
    if (!envelope.startsWith(ENC_MAGIC)) {
      return { ok: false, reason: '密文信封无 DSHENC1: 版本魔数' };
    }
    const segs = envelope.slice(ENC_MAGIC.length).split(':');
    if (segs.length !== ENC_PAYLOAD_SEGMENTS) {
      return { ok: false, reason: `密文信封结构损坏（期望 ${ENC_PAYLOAD_SEGMENTS} 段载荷，实得 ${segs.length}）` };
    }
    const salt = Buffer.from(segs[0] as string, 'base64');
    const iv = Buffer.from(segs[1] as string, 'base64');
    const tag = Buffer.from(segs[2] as string, 'base64');
    const body = Buffer.from(segs[3] as string, 'base64');
    if (salt.length !== ENC_SALT_BYTES || iv.length !== ENC_IV_BYTES || tag.length !== ENC_TAG_BYTES) {
      return { ok: false, reason: '密文信封长度异常（salt/iv/tag 与 DSHENC1 规格不符）' };
    }
    const key = scryptSync(passphrase, salt, ENC_KEY_BYTES, ENC_SCRYPT_COST);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    return { ok: true, plain };
  } catch {
    return { ok: false, reason: '解密失败：口令错误或密文已损坏（AES-256-GCM 认证不过）' };
  }
}

/** detail 填报尽力而为（绝不抛）：档案申报的加密形态原样回报（越界值不设 —— 不替档案圆谎） */
function noteEncryption(detail: ConnectionLoadDetail | undefined, declared: unknown): void {
  try {
    if (detail === undefined) return;
    if (declared === 'none' || declared === 'aes-256-gcm') detail.encryption = declared;
  } catch { /* 填报绝不炸 */ }
}

/** detail 填报失败归因（绝不抛；已有归因不覆盖 —— 首因保留） */
function noteError(detail: ConnectionLoadDetail | undefined, message: string): void {
  try {
    if (detail !== undefined && detail.error === undefined) detail.error = message.slice(0, 300);
  } catch { /* 填报绝不炸 */ }
}

/**
 * 落盘序列化（ΑΩ-R9）：口令在场且有非空 apiKey ⇒ apiKey 换密文信封、元数据
 * 申报 'aes-256-gcm'；否则明文现状 + 申报 'none'（无密可加密时不虚报加密）。
 * 加密失败 ⇒ 抛（由 save 的 catch 收敛为 { ok:false } —— 口令在场时绝不静默
 * 降级明文落盘，也不写 'null' 毁掉旧档）。
 */
function serializeForDisk(conn: VisionConnection): string {
  // 防御面（旧行为同款：JSON.stringify(conn ?? null) ?? 'null'）
  const c: VisionConnection | null = conn ?? null;
  if (c === null || typeof c !== 'object') return 'null';
  const passphrase = storePassphrase();
  if (passphrase !== undefined && typeof c.apiKey === 'string' && c.apiKey !== '') {
    const envelope = encryptApiKey(c.apiKey, passphrase);
    if (envelope === null) {
      throw new Error('apiKey 加密失败：DSH_VLM_STORE_PASSPHRASE 在场，拒绝明文降级落盘');
    }
    return JSON.stringify({ ...c, apiKey: envelope, encryption: 'aes-256-gcm' });
  }
  return JSON.stringify({ ...c, encryption: 'none' });
}

// ─── ConnectionStore：档位的读 / 写 / 清 ───

/**
 * 连接档案仓 —— 一个文件一个当前连接。
 * 构造零 I/O（路径缺省值即时取 defaultConnectionPath，env 变化即生效）；
 * load/save/clear 全部绝不抛异常。
 */
export class ConnectionStore {
  private readonly filePath: string;

  /** filePath 缺省 / 空白 ⇒ defaultConnectionPath()（~/.dsh/vlm-connection.json） */
  constructor(filePath?: string) {
    this.filePath = typeof filePath === 'string' && filePath.trim() !== ''
      ? filePath
      : defaultConnectionPath();
  }

  /** 档位绝对路径（注入测试用） */
  get path(): string {
    return this.filePath;
  }

  /**
   * 读档并消毒 —— 永不抛异常：
   * 文件缺席 / 读失败 / 坏 JSON / 非对象 / platform 非非空串 ⇒ null（坏档视为
   * 无档，调用方走首配向导）；否则返回字段级归一后的连接。读档成功后顺手收紧
   * 宽松旧档（W6R-C2：POSIX stat 查 group/other 位、Windows 幂等 icacls ——
   * 尽力而为，失败绝不阻断读档）。
   * ΑΩ-R9：读档先探魔数 —— apiKey 为 "DSHENC1:" 密文信封 ⇒ 先解密再消毒
   * （口令缺席 / 错口令 / 密文损坏 ⇒ null，与「坏档视为无档」同语义，绝不把
   * 密文当明文吐出；归因经可选 detail 参数给出）。旧明文档无论口令在场与否
   * 照常读（向后兼容）。解密结果仅在内存瞬时存在，绝不回写。
   */
  load(detail?: ConnectionLoadDetail): VisionConnection | null {
    try {
      if (!fsFace.existsSync(this.filePath)) return null;
      const raw: unknown = JSON.parse(fsFace.readFileSync(this.filePath, 'utf8'));
      if (raw === null || typeof raw !== 'object') return null;
      const r = raw as Record<string, unknown>;
      noteEncryption(detail, r.encryption); // 档案自己的申报原样回报（ΑΩ-R9）
      const storedKey = typeof r.apiKey === 'string' ? r.apiKey : undefined;
      if (storedKey !== undefined && storedKey.startsWith(ENC_MAGIC)) {
        const passphrase = storePassphrase();
        if (passphrase === undefined) {
          noteError(detail, '档案 apiKey 为 AES-256-GCM 密文，但 DSH_VLM_STORE_PASSPHRASE 缺席 —— 无法解密');
          return null;
        }
        const d = decryptApiKey(storedKey, passphrase);
        if (!d.ok) {
          noteError(detail, d.reason);
          return null;
        }
        r.apiKey = d.plain; // 明文仅在内存瞬时存在（用完即弃，绝不回写）
      }
      const parsed = sanitizeConnection(r);
      if (parsed !== null) tightenExistingFilePermsShared(this.filePath, permsDeps());
      return parsed;
    } catch (e) {
      noteError(detail, `读档失败：${errText(e)}`);
      return null;
    }
  }

  /**
   * 原子写档 —— tmp + rename（checkpoint 同款先例）：写一半崩溃 ⇒ 旧档完好，
   * 新档不存在，绝无半档。目录自动建。权限收紧（W6R-C2 分平台尽力）：
   *   POSIX —— tmp 创建即带 mode 0o600（压缩明文暴露窗口）+ rename 前后双 chmod
   *   win32 —— rename 后 icacls 断继承、当前账户独占（chmod 在 Windows 无 ACL 效力）
   * 收紧失败 ⇒ { ok:true, perms:'insecure-perms' } 诚实降级（档照写、功能不损）；
   * 写入故障 ⇒ { ok:false, error }（error 面经 redactKeyFrom 脱敏，明文 key 绝不
   * 进错误文本）且尽力清掉 tmp 残留。绝不抛异常。
   * ΑΩ-R9：落盘内容经 serializeForDisk —— 口令在场 ⇒ apiKey 密文信封 + 元数据
   * 'aes-256-gcm'；缺席 ⇒ 明文现状 + 'none'（诚实申报）；加密失败 ⇒ { ok:false }
   * 拒绝落盘（绝不静默降级明文）。
   */
  save(conn: VisionConnection): ConnectionWriteOutcome {
    const tmp = this.filePath + '.tmp';
    try {
      fsFace.mkdirSync(dirname(this.filePath), { recursive: true });
      // 创建即收紧：mode 0o600（POSIX 生效；Windows 忽略 mode —— 靠下方 icacls）
      fsFace.writeFileSync(tmp, serializeForDisk(conn), { encoding: 'utf8', mode: 0o600 });
      try {
        fsFace.chmodSync(tmp, 0o600); // 极端 umask 补刀（尽力）
      } catch {
        /* chmod 尽力：受限文件系统忽略 */
      }
      fsFace.renameSync(tmp, this.filePath); // 原子换名
      // rename 后保险收紧（分平台，共享模块路由）：失败降级标注 insecure-perms，功能不受损
      const secured = tightenFilePermsShared(this.filePath, permsDeps());
      return secured ? { ok: true } : { ok: true, perms: 'insecure-perms' };
    } catch (e) {
      try {
        fsFace.unlinkSync(tmp);
      } catch {
        /* tmp 可能尚未创建 */
      }
      return { ok: false, error: redactKeyFrom(errText(e), conn?.apiKey) };
    }
  }

  /**
   * 删档 —— 文件缺席同样 ok（幂等清理）；其余失败 ⇒ { ok:false, error }。
   * 绝不抛异常。
   */
  clear(): ConnectionWriteOutcome {
    try {
      fsFace.unlinkSync(this.filePath);
      return { ok: true };
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === 'ENOENT') return { ok: true };
      return { ok: false, error: errText(e) };
    }
  }
}

// ─── 密钥打码（展示面专用 —— 日志 / UI 绝不泄原值） ───

/** W6-2（doctor smell.magic-number 清偿）：短 key 判界（≤12 位用「前 2 位 + ****」打码），数值逐位不变 */
const MASK_KEY_SHORT_MAX = 12;

/**
 * 密钥展示打码 —— 永不抛异常：
 *   undefined / 空串 / 纯空白 ⇒ '(未设置)'
 *   长度 ≤ MASK_KEY_SHORT_MAX ⇒ 前 2 位 + '****'（短 key 前缀可辨即可）
 *   长度 > MASK_KEY_SHORT_MAX ⇒ 前 4 位 + '…' + 后 4 位（长 key 首尾对照可辨）
 */
export function maskKey(key?: string): string {
  try {
    if (typeof key !== 'string' || key.trim() === '') return '(未设置)';
    if (key.length <= MASK_KEY_SHORT_MAX) return key.slice(0, 2) + '****';
    return key.slice(0, 4) + '…' + key.slice(-4);
  } catch {
    return '(未设置)';
  }
}
