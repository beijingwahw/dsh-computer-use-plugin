// src/notary/primitives.ts
// W6-2（doctor smell.over-engineering 清偿）：自 notary/index.ts 低风险分区提取
// （>500 行拆分信号）—— 锚记录数据面（可序列化类型）与密码学原语复刻
// （canonical/sha256/链哈希）整体搬迁。行为零变化；notary/index.ts 以再导出
// 保持导入面不变（epochPi/R 公证测试零改动）。
import { createHash } from 'crypto';
// ─── 密码学原语复刻（journal.ts 模块私有 —— 复刻非复制实现，先例：sandbox/log.ts） ───
// 前缀重走（章③）必须逐字节复算 journal 的链哈希：canonical 键排序 + 过滤
// undefined 值（journal 的哈希域语义：值为 undefined 的自有键与缺键同域）。
// 若两者漂移，重走必然误报断链 —— 此处的逐字节一致是公证有效性的前提。
/** 稳定序列化：键排序 + undefined 值过滤（与 journal.canonical 同律） */
export function canonical(obj) {
    if (obj === null || typeof obj !== 'object')
        return JSON.stringify(obj);
    if (Array.isArray(obj))
        return '[' + obj.map(canonical).join(',') + ']';
    return '{' + Object.keys(obj).sort()
        .filter(k => obj[k] !== undefined)
        .map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}
export function sha256Hex(s) {
    return createHash('sha256').update(s, 'utf8').digest('hex');
}
/** journal 条目的链式哈希（与 journal.chainHash 逐字节一致 —— 前缀重走的原语） */
export function journalChainHash(prev, entry) {
    const domain = { ...entry };
    delete domain.hash; // 哈希域不含自身
    return sha256Hex(prev + canonical(domain));
}
/** 锚记录哈希：sha256(canonical(记录去掉自身 hash)) —— 锚自链的链式指纹 */
export function anchorHash(record) {
    return sha256Hex(canonical(record));
}
/** 异常归因为安全字符串（绝不二次抛出 —— pilotStore 同律） */
export function errText(err) {
    if (err instanceof Error)
        return err.message;
    try {
        const text = String(err);
        return text === '' ? '未知异常' : text;
    }
    catch {
        return '未知异常';
    }
}
/** 记录防御性深拷贝（记录恒为 JSON 安全数据 —— JSON 往返即深拷贝） */
export function copyRecord(rec) {
    try {
        return JSON.parse(JSON.stringify(rec));
    }
    catch {
        return rec;
    }
}
