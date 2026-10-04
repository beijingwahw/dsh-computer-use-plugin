// src/system.hotkeyPolicy.ts
// W6-2（doctor smell.over-engineering 清偿）：自 system.ts（nut-js 防腐层）低风险
// 分区提取 —— P1-3 系统级热键黑名单（纯函数执法面，零 nut-js 依赖；防腐层铁律
// 不动：nut-js 导入仍只在 system.ts）。行为零变化：判定逻辑与缺省值逐字节搬迁，
// system.ts 以再导出保持导入面不变（p1-fixes / pressHotkey 零改动）。
import { Config as ConfigSchema } from './config.js';
// ─── P1-3（地基速修）：系统级热键黑名单 ───
// Alt+F4 关窗、Meta/Win 唤起系统壳层、Ctrl+Alt+Delete —— 这些和弦不是「在应用内
// 操作」，而是把动作射向 OS 壳层/会话管理器：逃逸出纯视觉闭环的验证范围
//（点了之后桌面发生了什么，模型看不见也验证不了），且多数不可逆。执法点放在
// system.pressHotkey（全部热键调用方的唯一漏斗：工具层/shaper/autonomy/replay），
// 拒绝 = 直接 throw（与「白名单外的键名被拒绝」同方言，由各调用方 catch 降级）。
/** config.hotkeyBlacklist 缺省镜像：schema 不可载时的降级值（单一事实源仍是 config.ts） */
const FALLBACK_HOTKEY_BLACKLIST = 'alt+f4,meta,meta+l,meta+r,meta+d,win,cmd+q,ctrl+alt+delete';
/** 缺省黑名单：单一事实源是 config schema 声明的 hotkeyBlacklist 缺省 */
let hotkeyBlacklistCsv = (() => {
    try {
        const v = ConfigSchema({}).hotkeyBlacklist;
        return typeof v === 'string' ? v : FALLBACK_HOTKEY_BLACKLIST;
    }
    catch {
        return FALLBACK_HOTKEY_BLACKLIST; // schema 调用失败：降级镜像值，绝不阻断装载
    }
})();
/** P1-3 拒绝标记（工具层据此区分黑名单拦截与白名单拒绝/底层故障） */
export const HOTKEY_BLACKLIST_MARKER = '[SYSTEM_HOTKEY_BLOCKED]';
/** 键名等价归一表：win/meta/cmd/cmdsuper/super 同指 OS 壳层修饰键；长名折叠为白名单短名 */
const HOTKEY_ALIASES = {
    win: 'meta', meta: 'meta', cmd: 'meta', command: 'meta', super: 'meta', cmdsuper: 'meta',
    escape: 'esc', control: 'ctrl', del: 'delete', return: 'enter',
};
/** 单键归一：小写 + 去空白 + 别名折叠（'Win'/'CMD'/'Escape' → 'meta'/'meta'/'esc'） */
function normalizeHotkeyKey(k) {
    const n = String(k ?? '').trim().toLowerCase();
    return HOTKEY_ALIASES[n] ?? n;
}
/**
 * 黑名单命中裁决（纯函数，测试直测）：命中返回触发的黑名单条目原文，未命中返回 null。
 * 两条判定律（与 config.hotkeyBlacklist 描述一致）：
 *   1) 和弦整体归一（小写+别名折叠+排序无关）后与含 '+' 的条目全等 —— 如 'alt+f4'；
 *   2) 和弦包含任一单键条目 —— 如 'meta'/'win'（任何含 OS 壳层修饰键的组合都拒）。
 * 空黑名单（空串/全空白条目）= 全放行（部署明示不设防）。
 */
export function hotkeyBlacklistHit(keys, blacklistCsv) {
    const csv = String(blacklistCsv ?? '').trim();
    if (!csv)
        return null; // 空黑名单 = 全放行
    const normKeys = (Array.isArray(keys) ? keys : []).map(normalizeHotkeyKey).filter(Boolean);
    const chordSig = [...normKeys].sort().join('+');
    const keySet = new Set(normKeys);
    for (const raw of csv.split(',')) {
        const entry = raw.trim().toLowerCase();
        if (!entry)
            continue;
        if (entry.includes('+')) {
            // 整体和弦条目：同律归一后全等比较（'cmd+q' 与 ['meta','Q'] 命中）
            const sig = entry.split('+').map(normalizeHotkeyKey).filter(Boolean).sort().join('+');
            if (sig && sig === chordSig)
                return raw.trim();
        }
        else {
            // 单键条目：和弦含此键即拒（'meta' ⇒ ['ctrl','shift','meta'] 也拒）
            const single = normalizeHotkeyKey(entry);
            if (single && keySet.has(single))
                return raw.trim();
        }
    }
    return null;
}
/** 程序化判别：这次 pressHotkey 失败是不是黑名单拦截（工具层据此给出针对性 next_step） */
export function isHotkeyBlacklistError(e) {
    return e instanceof Error && e.message.includes(HOTKEY_BLACKLIST_MARKER);
}
// W6-2：模块态访问面（原 system.ts 模块级 let 的等价读写；行为零变化）
/** 当前生效黑名单（configure 接线写 / pressHotkey 执法读 的共享点） */
export function getHotkeyBlacklistCsv() { return hotkeyBlacklistCsv; }
export function setHotkeyBlacklistCsv(v) { hotkeyBlacklistCsv = v; }
