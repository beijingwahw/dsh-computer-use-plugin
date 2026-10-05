// src/sandbox/types.ts
// D-5 沙箱执行引擎 —— 契约层终版（六轮评审收敛，唯一事实源）。
// 产权铁律：跨器官类型一律 import，绝不定义 ——
//   D-4 事件契约来自 ../doctorEvents；现世接口契约自 ../doctorTypes 透传；
//   本文件只拥有 D-5 主权类型（ActionChain / MuscleMemoryEntry / RehearsalOutcome / …）。
// 异常诚实分层契约（D-6 轮正式立法，本文件遵守全部条文）：
//   第一条（加载层）configure/apply/Schema 校验 —— throw 合法且是唯一诚实形态：
//     拒绝带病上线；与宿主 cordis Schema 校验同生命周期哲学。
//   第二条（运行层）诊断/执行/重放/验收 —— 禁止 throw，一律 Result/verdict 降级；
//     运行时数据流神圣不可击穿。
//   第三条（判据）方法被调用时是否存在需要保护的数据流 —— 加载期无数据流，
//     throw 不伤害任何东西；运行期有数据流，throw 会击穿流水线。
//   第四条（对称性）模拟成功是债，模拟降级同罪（simulated rescue 同罪）：
//     坏配置 + configure 静默降级 = 用降级伪装成功。
import { randomUUID } from 'crypto';
/** 动作词汇表运行时集合（类型的唯一运行时镜像 —— 解析边界执法用，
 *  防 LLM 输出的未知 kind 经 as 断言混入执行域） */
export const SANDBOX_ACTION_KINDS = new Set([
    'click_mouse', 'type_text', 'scroll_page', 'press_hotkey',
    'drag_mouse', 'switch_tab', 'switch_window', 'dismiss_popup', 'noop',
]);
/** 预期效果 scale 词表运行时集合（ΑΩ-R19：与 SANDBOX_ACTION_KINDS 同方言 ——
 *  解析边界执法的唯一事实源，防入参校验器复制第二份词表） */
export const EXPECTED_EFFECT_SCALES = new Set([
    'page-level', 'element-level', 'text-level',
]);
/**
 * 肌肉记忆可靠度 —— 唯一公式落点（锚定 skillLibrary.ts:182 既有事实）：
 *   reliability = (hostSuccessCount + 1) / (hostReplayCount + 2)   // 加一 Laplace，二值结局
 * 零重放条目 = 1/2 谨慎起步（对齐合成技能先验哲学："谨慎起步，用一次校准一次"）。
 * 计数是唯一事实源，可靠度永远是导出值 —— 消费方禁止自行重算。
 */
export function muscleReliability(e) {
    return (e.hostSuccessCount + 1) / (e.hostReplayCount + 2);
}
/** 集合语义查询面（铸造点保证去重与典范序，此处只做成员判定） */
export function hasVerificationLayer(o, layer) {
    return o.verificationLayers.includes(layer);
}
/**
 * 指纹相似度（perceptualHash.similarity/hammingDistance 同构式本地复刻：
 * D-5 只需纯字符串距离，不拖入 sharp 图像二进制运行时依赖）。
 * ΑΩ-R19/ΠΑΝ-41 位宽鲁棒：等宽 ⇒ 按实际位宽逐位比对（除数为长度而非硬编码
 * 64 —— 对现行 64 位串数值逐字节不变；128 位串不再产出负数）；不等宽 ⇒ 按
 * 较短侧前缀比对并注记 truncatedTo（诚实降级优于静默 0 —— 格式演进静默全拒
 * = 把升级伪装成全局失配）；空串（0 位证据）仍 0。纯函数、永不抛。
 */
export function fpSimilarity(a, b) {
    if (a.length === 0 || b.length === 0)
        return { similarity: 0 };
    const n = Math.min(a.length, b.length);
    let dist = 0;
    for (let i = 0; i < n; i++)
        if (a[i] !== b[i])
            dist++;
    return {
        similarity: 1 - dist / n,
        ...(a.length !== b.length ? { truncatedTo: n } : {}),
    };
}
/**
 * 纯函数，永不抛错。passed × rejected 是合法且高价值的报警态：
 * 预演「达成了效果」但链触犯创世铁律（如点击成功但目标命中敏感字段）。
 * 闸一：医生否决权 universal；闸二：自知之明；
 * 闸三：证据不足（degraded）时医生的 approved 亦无效 —— 未执行的验证层之上无完美分；
 * 闸四：医生终审。
 */
export function resolveConsolidation(rehearsal, doctor) {
    if (doctor === 'rejected')
        return 'discard';
    if (rehearsal === 'failed' || rehearsal === 'aborted')
        return 'discard';
    if (rehearsal === 'degraded')
        return 'freeze-for-review';
    return doctor === 'approved' ? 'consolidate' : 'freeze-for-review';
}
/** 生命周期铁律：counter 与 BOOT_NONCE 是模块寿命级状态，engine.reset() 无权触碰 */
const BOOT_NONCE = randomUUID().slice(0, 8);
let counter = 0;
/** 默认实现（契约文件内的唯一例外：纯基础设施零业务逻辑，对齐 makeScore 先例） */
export function createDefaultIdGenerator() {
    return {
        next: kind => `${kind}-${Date.now().toString(36)}-${(counter++).toString(36)}-${BOOT_NONCE}`,
    };
}
