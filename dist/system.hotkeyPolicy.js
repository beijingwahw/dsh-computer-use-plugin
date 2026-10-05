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
/** config.hotkeyBlacklist 缺省镜像：schema 不可载时的降级值（单一事实源仍是 config.ts）。
 *  ΠΑΝ-10: 补 ctrl+shift+esc（任务管理器 —— 与 ctrl+alt+delete 同目标）、alt+space
 *  （窗口系统菜单，含"关闭"项）—— 两者同样射向 OS 壳层、逃逸纯视觉闭环且多不可逆。 */
const FALLBACK_HOTKEY_BLACKLIST = 'alt+f4,meta,meta+l,meta+r,meta+d,win,cmd+q,ctrl+alt+delete,ctrl+shift+esc,alt+space';
/** ΠΑΝ-10 缺省补全条目（H-3 覆盖缺口收口）。config.ts 的 schema 缺省串不在本工单
 *  文件所有权内 —— 本模块在装载期对缺省值做**只增不减**的补全，使 schema 缺省与
 *  降级镜像两条初始路径收敛到同一生效缺省（防镜像漂移，L-9 同病不犯）。立法边界：
 *  仅作用于装载期缺省 —— 部署显式配置（system.configure 写入的值）不走此路，
 *  配置即法律逐字节生效（含显式空串 = 明示不设防）。 */
const PAN10_DEFAULT_ADDITIONS = ['ctrl+shift+esc', 'alt+space'];
/** ΠΑΝ-9/ΠΑΝ-10 纪律：装载期缺省补全绝不抛、绝不减条目（只增不减）。字面比对
 *  即可（补全条目是小写规范形；未来 schema 缺省若含大写变体则至多重加一条语义
 *  等价条目 —— 黑名单命中幂等，无害）。 */
function withPan10DefaultAdditions(csv) {
    const base = csv.trim();
    if (!base)
        return csv; // 空缺省 = 部署明示不设防，不越权重写
    const have = new Set(base.split(',').map(e => e.trim().toLowerCase()).filter(Boolean));
    const missing = PAN10_DEFAULT_ADDITIONS.filter(a => !have.has(a));
    return missing.length === 0 ? csv : `${base},${missing.join(',')}`;
}
/** 缺省黑名单：单一事实源是 config schema 声明的 hotkeyBlacklist 缺省
 *  （ΠΑΝ-10：装载期缺省经补全收口 —— schema 侧缺省串的同步更新归 config.ts
 *  所有者，补全在此期间兜底且幂等） */
let hotkeyBlacklistCsv = (() => {
    let v;
    try {
        const r = ConfigSchema({}).hotkeyBlacklist;
        v = typeof r === 'string' ? r : FALLBACK_HOTKEY_BLACKLIST;
    }
    catch {
        v = FALLBACK_HOTKEY_BLACKLIST; // schema 调用失败：降级镜像值，绝不阻断装载
    }
    return withPan10DefaultAdditions(v);
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
/** ΠΑΝ-10: 和弦签名 —— 别名折叠 → 去空白/空键 → **去重** → 字典序。去重立法：
 *  重复键在物理热键语义上等同单次按住（['alt','alt','f4'] 触发的就是 Alt+F4），
 *  畸形重复不得让和弦逃过黑名单全等比较（H-3：旧签名不去重，'alt+alt+f4' ≠
 *  条目 'alt+f4' ⇒ Alt+F4 实际仍会执行 —— 黑名单是纯视觉闭环外不可逆动作的
 *  最后一道闸）。**去重必须在别名折叠之后**：['win','meta'] 先折为 ['meta',
 *  'meta'] 再去重为 ['meta']；顺序反了会留下 meta+win 双键假和弦，反而放过
 *  真正的 OS 壳层单键。 */
function chordSignatureOf(parts) {
    return [...new Set(parts.map(normalizeHotkeyKey).filter(Boolean))].sort().join('+');
}
/**
 * 黑名单命中裁决（纯函数，测试直测）：命中返回触发的黑名单条目原文，未命中返回 null。
 * 两条判定律（与 config.hotkeyBlacklist 描述一致）：
 *   1) 和弦整体归一（小写+别名折叠+去重+排序无关 —— ΠΑΝ-10 补去重：重复修饰键
 *      ≡ 单键按住）后与含 '+' 的条目全等 —— 如 'alt+f4' ≡ ['alt','alt','f4']；
 *   2) 和弦包含任一单键条目 —— 如 'meta'/'win'（任何含 OS 壳层修饰键的组合都拒）。
 * 空黑名单（空串/全空白条目）= 全放行（部署明示不设防）。
 */
export function hotkeyBlacklistHit(keys, blacklistCsv) {
    const csv = String(blacklistCsv ?? '').trim();
    if (!csv)
        return null; // 空黑名单 = 全放行
    const normKeys = (Array.isArray(keys) ? keys : []).map(normalizeHotkeyKey).filter(Boolean);
    const chordSig = chordSignatureOf(normKeys); // ΠΑΝ-10: 折叠后去重再排序
    const keySet = new Set(normKeys);
    for (const raw of csv.split(',')) {
        const entry = raw.trim().toLowerCase();
        if (!entry)
            continue;
        if (entry.includes('+')) {
            // 整体和弦条目：同律归一（折叠+去重）后全等比较 —— 'cmd+q' 与 ['meta','Q']、
            // 'alt+f4' 与 ['alt','alt','f4'] / ['f4','alt','f4'] 命中（ΠΑΝ-10 两侧同去重）
            const sig = chordSignatureOf(entry.split('+'));
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
