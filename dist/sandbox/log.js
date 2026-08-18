// src/sandbox/log.ts
// D-5 沙箱会话日志：append-only 哈希链账本（DSH 可观测性铁律）。
// 规范对齐 journal.ts（sha256 链式防篡改），但独立成链 —— 零侵入红线：
// journal 的 JournalMarker 是封闭联合类型，沙箱事件不越权注入宿主账本；
// D-4 审查沙箱链时以 doctor/verdict 的 chainTip 锚点定位本账本。
// canonical/chainHash 是 journal.ts 的模块私有纯函数，此处按同一密码学规范复刻
// （纯密码学原语复刻 ≠ 业务逻辑越权；哈希域构造必须逐字节一致才能保持链语义）。
import { appendFile, mkdir } from 'fs/promises';
import { createHash } from 'crypto';
import path from 'path';
const GENESIS = 'GENESIS';
/** 稳定序列化：键排序 —— 同一对象永远产生同一字符串（哈希链的前提；对齐 journal.canonical） */
function canonical(obj) {
    if (obj === null || typeof obj !== 'object')
        return JSON.stringify(obj);
    if (Array.isArray(obj))
        return '[' + obj.map(canonical).join(',') + ']';
    return '{' + Object.keys(obj).sort()
        .map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}
function sha256(s) {
    return createHash('sha256').update(s).digest('hex');
}
/** 链式哈希：entry 的指纹 = sha256(前条哈希 + 本条内容哈希域)，哈希域不含自身 */
function chainHash(prev, entry) {
    const { hash: _omit, ...domain } = entry;
    return sha256(prev + canonical(domain));
}
/**
 * 沙箱账本：内存窗口 + 可选 JSONL 落盘 + 哈希链防篡改。
 * 抛错契约：一切方法永不抛错 —— 落盘失败 console.warn（旁路义务不阻断主流程）。
 */
export class SandboxLog {
    entries = [];
    filePath = '';
    capacity = 2000;
    chainTip = GENESIS;
    chainBase = GENESIS;
    configure(filePath, capacity) {
        this.filePath = filePath;
        this.capacity = capacity;
    }
    reset() {
        this.entries = [];
        this.chainTip = GENESIS;
        this.chainBase = GENESIS;
    }
    /** 链尖端（快照铸造与 verdict 关联的锚点源） */
    get tip() {
        return this.chainTip;
    }
    async append(kind, data = {}) {
        const entry = { ts: Date.now(), kind, data };
        entry.hash = chainHash(this.chainTip, entry);
        this.chainTip = entry.hash;
        this.entries.push(entry);
        if (this.entries.length > this.capacity) {
            const evicted = this.entries.shift();
            this.chainBase = evicted.hash ?? GENESIS; // 链基前滚（对齐 journal B-1 语义）
        }
        if (this.filePath) {
            try {
                await mkdir(path.dirname(this.filePath), { recursive: true });
                await appendFile(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
            }
            catch (e) {
                console.warn(`[SandboxLog] write failed: ${e.message}`);
            }
        }
    }
    /** 链完整性校验：从链基重放存活窗口，返回第一个断点（verify 语义对齐 journal） */
    verify() {
        let prev = this.chainBase;
        for (let i = 0; i < this.entries.length; i++) {
            const expect = chainHash(prev, this.entries[i]);
            if (this.entries[i].hash !== expect) {
                return { ok: false, length: this.entries.length, brokenAt: i };
            }
            prev = expect;
        }
        return { ok: true, length: this.entries.length, brokenAt: null };
    }
    list() {
        return this.entries;
    }
}
/** 模块级单例（对齐 journal 的导出方言；生命周期随 ctx.effect 清理复位） */
export const sandboxLog = new SandboxLog();
