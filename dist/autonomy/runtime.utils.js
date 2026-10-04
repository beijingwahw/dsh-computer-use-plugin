// src/autonomy/runtime.utils.ts
// W8-B2（doctor smell.over-engineering 清偿 · D-F2 千行文件群）：自 runtime.ts
// 低风险分区提取 —— 内部纯工具（异常归因 / 坐标夹取 / 文本折叠 / note 截断 /
// 判据抽查节拍 / 滚动缺省行数）。逐字节搬迁、零外部依赖；runtime.ts 以再导出
// 保持导入面不变（本面原为模块私有 —— 仅供 runtime 家族兄弟文件跨文件复用，
// 不进桶的公共导出面，公共面零漂移）。
//
/** 异常归因为安全字符串（绝不二次抛出） */
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
/** 数字夹 [0,1]；非有限数按 0 记（归一化坐标卫兵） */
export function clamp01(v) {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
    return Math.min(1, Math.max(0, n));
}
/** 大小写 + 空白折叠（判据子串匹配的统一前置） */
export function foldText(s) {
    return typeof s === 'string' ? s.toLowerCase().replace(/\s+/g, ' ').trim() : '';
}
/** note 预算：附注截 500 字（Token 纪律 —— 记事本不是转录本） */
const NOTE_MAX = 500;
export function clipNote(s) {
    return s.length > NOTE_MAX ? `${s.slice(0, NOTE_MAX)}…[截断]` : s;
}
/** 判据抽查周期：每 3 个已验证步抽查一次（成本克制） */
export const CRITERIA_SPOT_PERIOD = 3;
/** 缺省滚动行数（与 scrollPage 工具缺省同律） */
export const DEFAULT_SCROLL_AMOUNT = 5;
