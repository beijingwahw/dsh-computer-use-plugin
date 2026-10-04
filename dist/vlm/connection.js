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
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { currentWindowsUser, defaultFilePermsDeps, tightenExistingFilePerms as tightenExistingFilePermsShared, tightenFilePerms as tightenFilePermsShared, } from '../filePerms.js';
// 共享模块再出口：既有消费面（测试 / 兄弟模块）从本模块取件不破（纯转发，无副本）
export { buildIcaclsArgs } from '../filePerms.js';
/** 缺省档位 —— ~/.dsh/vlm-connection.json；DSH_VLM_CONNECTION 覆写（physicalBackend 同律） */
export function defaultConnectionPath() {
    return process.env.DSH_VLM_CONNECTION ?? join(homedir(), '.dsh', 'vlm-connection.json');
}
// ─── 消毒（load 的字段级归一 —— 单点定义，绝不抛） ───
/** via 合法值集合（越界值归 'config'） */
const VIA_VALUES = new Set(['wizard', 'auto-adopt', 'tool', 'config']);
/** 可选字符串物料消毒：非字符串 / 纯空白 ⇒ undefined；否则原值保留 */
function sanitizeOptionalString(v) {
    try {
        return typeof v === 'string' && v.trim() !== '' ? v : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * 整档消毒：null / 非对象 ⇒ null；platform 非非空串 ⇒ null（档位根基缺失 =
 * 坏档）；三物料空白归 undefined；via 越界归 'config'；updatedAt 非有限数归
 * Date.now()（时间戳缺位补当下，不虚造古老时间）。
 */
function sanitizeConnection(raw) {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    if (typeof r.platform !== 'string' || r.platform.trim() === '')
        return null;
    const via = typeof r.via === 'string' && VIA_VALUES.has(r.via) ? r.via : 'config';
    const updatedAt = typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : Date.now();
    return {
        platform: r.platform,
        apiKey: sanitizeOptionalString(r.apiKey),
        baseUrl: sanitizeOptionalString(r.baseUrl),
        model: sanitizeOptionalString(r.model),
        updatedAt,
        via: via,
    };
}
/** 错误串化（save/clear 的 error 面）——任何故障归为一句短消息，绝不抛 */
function errText(e) {
    try {
        const msg = e?.message;
        if (typeof msg === 'string' && msg !== '')
            return msg.slice(0, 300);
        return String(e ?? 'unknown error').slice(0, 300);
    }
    catch {
        return 'unknown error';
    }
}
const REAL_FS = {
    mkdirSync, writeFileSync, renameSync, unlinkSync, existsSync, readFileSync, chmodSync, statSync,
};
/** 当前 fs 执行面（默认全真实；测试经 _setFsForTest 覆写。宿主永不触碰注入缝） */
let fsFace = REAL_FS;
/** 测试缝：部分 / 整体替换 fs 执行面（null = 全真实）。任何构造异常回退真实面（防御式） */
export function _setFsForTest(partial) {
    try {
        fsFace = partial === null ? REAL_FS : Object.assign({}, REAL_FS, partial);
    }
    catch {
        fsFace = REAL_FS;
    }
}
/** 平台判定（缺省真实 process.platform；测试经 _setPlatformForTest 伪造走分支） */
let platformOverride = null;
function currentPlatform() {
    return platformOverride ?? process.platform;
}
/** 测试缝：覆写平台判定（空串 / null = 回真实）。icacls 与 chmod 分支的路由开关 */
export function _setPlatformForTest(platform) {
    platformOverride = typeof platform === 'string' && platform !== '' ? platform : null;
}
let icaclsSpawnOverride = null;
/** 测试缝：注入假 icacls 通道捕获 (cmd, args, opts)（null = 真实 spawnSync）。注入非函数按真实处理 */
export function _setIcaclsSpawnForTest(fn) {
    icaclsSpawnOverride = typeof fn === 'function' ? fn : null;
}
/**
 * 共享模块适配器 —— 把本模块三个测试缝（fsFace / currentPlatform /
 * icaclsSpawnOverride）实时转发给 filePerms 共享件：缺省全真实；任一缝被
 * 注入 ⇒ 共享件走的即注入面（W8-A2：收紧逻辑单点在共享模块，本模块只留缝）。
 * 每次收紧现取适配（缝覆盖即时生效，无缓存可污染）。
 */
function permsDeps() {
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
function redactKeyFrom(text, key) {
    try {
        if (typeof key !== 'string' || key === '')
            return text;
        return text.split(key).join(maskKey(key));
    }
    catch {
        return text;
    }
}
// ─── ConnectionStore：档位的读 / 写 / 清 ───
/**
 * 连接档案仓 —— 一个文件一个当前连接。
 * 构造零 I/O（路径缺省值即时取 defaultConnectionPath，env 变化即生效）；
 * load/save/clear 全部绝不抛异常。
 */
export class ConnectionStore {
    filePath;
    /** filePath 缺省 / 空白 ⇒ defaultConnectionPath()（~/.dsh/vlm-connection.json） */
    constructor(filePath) {
        this.filePath = typeof filePath === 'string' && filePath.trim() !== ''
            ? filePath
            : defaultConnectionPath();
    }
    /** 档位绝对路径（注入测试用） */
    get path() {
        return this.filePath;
    }
    /**
     * 读档并消毒 —— 永不抛异常：
     * 文件缺席 / 读失败 / 坏 JSON / 非对象 / platform 非非空串 ⇒ null（坏档视为
     * 无档，调用方走首配向导）；否则返回字段级归一后的连接。读档成功后顺手收紧
     * 宽松旧档（W6R-C2：POSIX stat 查 group/other 位、Windows 幂等 icacls ——
     * 尽力而为，失败绝不阻断读档）。
     */
    load() {
        try {
            if (!fsFace.existsSync(this.filePath))
                return null;
            const parsed = sanitizeConnection(JSON.parse(fsFace.readFileSync(this.filePath, 'utf8')));
            if (parsed !== null)
                tightenExistingFilePermsShared(this.filePath, permsDeps());
            return parsed;
        }
        catch {
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
     */
    save(conn) {
        const tmp = this.filePath + '.tmp';
        try {
            fsFace.mkdirSync(dirname(this.filePath), { recursive: true });
            // 创建即收紧：mode 0o600（POSIX 生效；Windows 忽略 mode —— 靠下方 icacls）
            fsFace.writeFileSync(tmp, JSON.stringify(conn ?? null) ?? 'null', { encoding: 'utf8', mode: 0o600 });
            try {
                fsFace.chmodSync(tmp, 0o600); // 极端 umask 补刀（尽力）
            }
            catch {
                /* chmod 尽力：受限文件系统忽略 */
            }
            fsFace.renameSync(tmp, this.filePath); // 原子换名
            // rename 后保险收紧（分平台，共享模块路由）：失败降级标注 insecure-perms，功能不受损
            const secured = tightenFilePermsShared(this.filePath, permsDeps());
            return secured ? { ok: true } : { ok: true, perms: 'insecure-perms' };
        }
        catch (e) {
            try {
                fsFace.unlinkSync(tmp);
            }
            catch {
                /* tmp 可能尚未创建 */
            }
            return { ok: false, error: redactKeyFrom(errText(e), conn?.apiKey) };
        }
    }
    /**
     * 删档 —— 文件缺席同样 ok（幂等清理）；其余失败 ⇒ { ok:false, error }。
     * 绝不抛异常。
     */
    clear() {
        try {
            fsFace.unlinkSync(this.filePath);
            return { ok: true };
        }
        catch (e) {
            if (e?.code === 'ENOENT')
                return { ok: true };
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
export function maskKey(key) {
    try {
        if (typeof key !== 'string' || key.trim() === '')
            return '(未设置)';
        if (key.length <= MASK_KEY_SHORT_MAX)
            return key.slice(0, 2) + '****';
        return key.slice(0, 4) + '…' + key.slice(-4);
    }
    catch {
        return '(未设置)';
    }
}
