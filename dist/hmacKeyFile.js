// src/hmacKeyFile.ts
// HMAC 密钥档读写的共享模块（修复潮 F3-7 / BC-5 收编）。
//
// 为什么存在：ΠΑΝ-3（队列档信封）与 ΠΑΝ-80（checkpoint approvalQueue 段信封）
// 两处各自落了一份逐字相同的密钥档读写函数（readHmacKey/readAqKey、
// loadOrCreateHmacKey/loadOrCreateAqKey）—— bug_class_lint --strict 检出
// BC-5 函数体克隆 ×2（src/approval.queueContracts.ts 与 src/checkpoint.ts）。
// 密钥档的「读侧绝不铸造 / 写侧铸造后原子落盘 + 权限收紧 / 一切故障 ⇒ null
// 降级」是同一套安全语义，克隆漂移（一处改了 fsync 次序另一处忘改）正是
// BC-5 要防的虫型 —— 故上提为共享件，两调用方改为引用（行为逐字不变，
// filePerms.ts 同款卫星件方言）。
//
// 语义铁律（与两处原实现逐字一致）：
//   - 读侧（readHexKeyFile）**绝不铸造**：密钥缺席 ⇒ 「无法验证」降级，
//     而非「新钥验旧 mac 失配」的篡改归零 —— 两种 fail 刻意可区分（诚实三态）；
//   - 写侧（loadOrCreateHexKeyFile）：读侧失败 ⇒ 铸新 + tmp/fsync/rename
//     原子落盘 + tightenFilePerms 尽力收紧（失败 ⇒ 功能继续，风险在盘）；
//     在场但不可读/损坏 ⇒ 不覆盖（降级 null）；
//   - 两函数都绝不抛：一切异常 ⇒ null（= 无密钥降级，由调用方申报）。
import { existsSync, readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tightenFilePerms } from './filePerms.js';
/** HMAC 密钥长度（字节）缺省 —— 对齐 approval.security 的 CSPRNG 强度标准（32B = sha256 对称宽） */
export const HMAC_KEY_FILE_BYTES = 32;
/** 密钥档合法形状：64 位 hex（32B）—— trim 后整体匹配，任何残缺 = 损坏 */
const HEX_KEY_RE = /^[0-9a-fA-F]{64}$/;
/**
 * 密钥只读（绝不抛、绝不铸造）：在场且合法（64 位 hex = 32B）⇒ Buffer；
 * 缺席/损坏/读故障 ⇒ null。**仅验证路径之外的读侧（load）调用** ——
 * 验证路径禁用铸造：密钥缺席 ⇒ 「无法验证」降级，而非「新钥验旧 mac
 * 失配」的篡改归零 —— 两种 fail 的语义刻意区分（诚实三态）。
 */
export function readHexKeyFile(keyPath) {
    try {
        if (!existsSync(keyPath))
            return null;
        const hex = readFileSync(keyPath, 'utf8').trim();
        if (HEX_KEY_RE.test(hex))
            return Buffer.from(hex, 'hex');
        return null; // 损坏密钥 = 无密钥（降级 —— 绝不抛、绝不静默换钥重签旧档）
    }
    catch {
        return null;
    }
}
/**
 * 密钥读取/铸造（绝不抛）：缺席 ⇒ 铸新 + 原子落盘（tmp + fsync + rename）
 * + 权限收紧；一切故障 ⇒ null（= 无密钥降级）。**仅写侧（save）调用** ——
 * 见 readHexKeyFile 头注（验证路径禁用铸造）。
 */
export function loadOrCreateHexKeyFile(keyPath, keyBytes = HMAC_KEY_FILE_BYTES) {
    try {
        const existing = readHexKeyFile(keyPath);
        if (existing !== null)
            return existing;
        if (existsSync(keyPath))
            return null; // 在场但不可读/损坏 ⇒ 不覆盖（降级）
        const key = randomBytes(keyBytes);
        const tmp = keyPath + '.tmp';
        const fd = openSync(tmp, 'w');
        try {
            writeSync(fd, Buffer.from(key.toString('hex'), 'utf8'));
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        renameSync(tmp, keyPath);
        // 密钥档是信封的根：W8-A2 加固面尽力收紧（失败 ⇒ 功能继续，风险在盘）
        tightenFilePerms(keyPath);
        return key;
    }
    catch {
        return null;
    }
}
