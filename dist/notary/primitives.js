// src/notary/primitives.ts
// W6-2（doctor smell.over-engineering 清偿）：自 notary/index.ts 低风险分区提取
// （>500 行拆分信号）—— 锚记录数据面（可序列化类型）与密码学原语复刻
// （canonical/sha256/链哈希）整体搬迁。行为零变化；notary/index.ts 以再导出
// 保持导入面不变（epochPi/R 公证测试零改动）。
import { createHash } from 'crypto';
// ΠΑΝ-49：canonical 单源消费（dialects/canonical.ts —— ΝΩ-24 守卫形态唯一出处）
import { canonicalJson } from '../dialects/index.js';
// ─── 密码学原语（canonical 已收编单源，ΠΑΝ-49）───
// 前缀重走（章③）必须逐字节复算 journal 的链哈希：canonical 键排序 + 过滤
// undefined 值（journal 的哈希域语义：值为 undefined 的自有键与缺键同域）。
// 若两者漂移，重走必然误报断链 —— 逐字节一致是公证有效性的前提。
// ΠΑΝ-49：本件曾是 journal.canonical 的无守卫复刻（C1-9 H1 实证漂移：journal
// 的 ΝΩ-24 病态载荷守卫未随迁 ⇒ 深/环 args 在此重算出不同字节 ⇒ 章③永久误红）。
// 现收编为 dialects/canonical.ts 单源的薄再导出 —— 守卫（深度上限+环检测）随
// 单源自动到位，且未来加固只落一处。
// ΠΑΝ-49：canonical 单源消费（见文件头 import —— dialects/canonical.ts）
/** 稳定序列化：键排序 + undefined 值过滤 + 病态载荷守卫（dialects 单源薄代理） */
export function canonical(obj) {
    return canonicalJson(obj);
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
