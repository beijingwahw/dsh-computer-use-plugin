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
//     完整旧档要么完整新档，绝无半档；目录自动建；chmod 0600 尽力（Windows
//     文件系统不支持完整权限位 —— 忽略错误）
//   - ConnectionStore.clear —— 删档（文件缺席也 ok —— 幂等清理）
//   - maskKey              —— 密钥展示打码（日志 / UI 面绝不泄漏原值）
// 铁律（与兄弟模块同调）：绝不抛异常 —— 一切失败以 null / { ok:false } 表达。
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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
     * 无档，调用方走首配向导）；否则返回字段级归一后的连接。
     */
    load() {
        try {
            if (!existsSync(this.filePath))
                return null;
            return sanitizeConnection(JSON.parse(readFileSync(this.filePath, 'utf8')));
        }
        catch {
            return null;
        }
    }
    /**
     * 原子写档 —— tmp + rename（checkpoint 同款先例）：写一半崩溃 ⇒ 旧档完好，
     * 新档不存在，绝无半档。目录自动建；tmp 落盘后 chmod 0600 尽力收紧（Windows
     * 文件系统不支持完整 POSIX 位 —— 忽略错误）；任何故障 ⇒ { ok:false, error }
     * 且尽力清掉 tmp 残留。绝不抛异常。
     */
    save(conn) {
        const tmp = this.filePath + '.tmp';
        try {
            mkdirSync(dirname(this.filePath), { recursive: true });
            writeFileSync(tmp, JSON.stringify(conn ?? null) ?? 'null', 'utf8');
            try {
                chmodSync(tmp, 0o600);
            }
            catch {
                /* chmod 尽力：Windows / 受限文件系统忽略 */
            }
            renameSync(tmp, this.filePath); // 原子换名
            return { ok: true };
        }
        catch (e) {
            try {
                unlinkSync(tmp);
            }
            catch {
                /* tmp 可能尚未创建 */
            }
            return { ok: false, error: errText(e) };
        }
    }
    /**
     * 删档 —— 文件缺席同样 ok（幂等清理）；其余失败 ⇒ { ok:false, error }。
     * 绝不抛异常。
     */
    clear() {
        try {
            unlinkSync(this.filePath);
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
/**
 * 密钥展示打码 —— 永不抛异常：
 *   undefined / 空串 / 纯空白 ⇒ '(未设置)'
 *   长度 ≤ 12                ⇒ 前 2 位 + '****'（短 key 前缀可辨即可）
 *   长度 > 12                ⇒ 前 4 位 + '…' + 后 4 位（长 key 首尾对照可辨）
 */
export function maskKey(key) {
    try {
        if (typeof key !== 'string' || key.trim() === '')
            return '(未设置)';
        if (key.length <= 12)
            return key.slice(0, 2) + '****';
        return key.slice(0, 4) + '…' + key.slice(-4);
    }
    catch {
        return '(未设置)';
    }
}
