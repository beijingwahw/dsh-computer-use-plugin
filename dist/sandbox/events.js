import { DOCTOR_VERDICT_EVENT } from '../doctorEvents.js';
// P0-3：事件名与载荷联合方言收敛 D-1 单源（cognitionEvents.ts 唯一事实源），
// 本文件只做消费侧再导出 —— 依赖方向对齐 doctorEvents 先例（D-5 import D-4 契约）。
import { COGNITION_PLAN_READY_EVENT } from '../cognitionEvents.js';
/** D-5 发射事件名注册表（as const 防拼写漂移） */
export const SANDBOX_EVENTS = {
    rehearsalBegin: 'sandbox/rehearsal-begin',
    rehearsalEnd: 'sandbox/rehearsal-end',
    memoryConsolidated: 'sandbox/memory-consolidated',
    hostReplayEnd: 'sandbox/host-replay-end',
};
/** D-1 发射、D-5 消费 —— 事件名与载荷契约归 D-1 主权（cognitionEvents.ts 单源再导出） */
export { COGNITION_PLAN_READY_EVENT };
/** D-1 计划就绪载荷 —— 联合方言契约见 cognitionEvents.ts（P0-3 单源收敛）；
 *  D-5 只消费 chain 臂（排练投喂需求），intent 双方言臂是 D-6/D-7 主权 */
// ─── 类型化挂载 / 发射表面 ───
// emit 经集中 as-any：宿主 stub 未声明 emit（与 hooks.ts 对 on 的处理同方言）；
// 一切表面永不抛错 —— 发射失败是旁路义务，不阻断主流程。
export function emitRehearsalBegin(ctx, p) {
    ctx.emit(SANDBOX_EVENTS.rehearsalBegin, p);
}
export function emitRehearsalEnd(ctx, p) {
    ctx.emit(SANDBOX_EVENTS.rehearsalEnd, p);
}
export function emitMemoryConsolidated(ctx, p) {
    ctx.emit(SANDBOX_EVENTS.memoryConsolidated, p);
}
export function emitHostReplayEnd(ctx, p) {
    ctx.emit(SANDBOX_EVENTS.hostReplayEnd, p);
}
export function onCognitionPlanReady(ctx, handler) {
    ctx.on(COGNITION_PLAN_READY_EVENT, handler);
}
// 联合方言消费纪律：handler 收到的是三方言联合 —— 消费方必须自行收窄
// （D-5 只认 'chain' in payload 的链臂；intent 臂属 D-6/D-7 主权，D-5 绝不排练意图）。
export function onDoctorVerdict(ctx, handler) {
    ctx.on(DOCTOR_VERDICT_EVENT, handler);
}
// ─── 宿主观察嗅探（TRUST IS A FINGERPRINT 的镜像源头）───
// D-5 监听宿主管线 post-execute，尽力嗅探结果 JSON 中的屏指纹字段。
// 嗅探缺席 ⇒ 快照诚实降级（screenDhash=''）—— 无证据 = 门禁拒绝，保守方向。
/** 宿主工具结果中可接受的指纹字段名（按宿主锚点方言增补，收口于此） */
const FINGERPRINT_KEYS = ['scene_fingerprint', 'screen_dhash', 'dhash', 'scene_hash'];
/** 从任意宿主工具结果中嗅探 64 位指纹串；缺席返回 null（诚实，不伪造） */
export function sniffFingerprint(result) {
    if (typeof result !== 'string')
        return null;
    // 宿主工具结果可能是 JSON 字符串或前缀协议文本 —— 只对 JSON 路径嗅探
    const trimmed = result.trim();
    if (!trimmed.startsWith('{'))
        return null;
    try {
        const parsed = JSON.parse(trimmed);
        const anchor = typeof parsed.state_anchor === 'object' && parsed.state_anchor !== null
            ? parsed.state_anchor
            : parsed;
        for (const key of FINGERPRINT_KEYS) {
            const v = anchor[key];
            if (typeof v === 'string' && /^[01]{64}$/.test(v))
                return v;
        }
        return null;
    }
    catch {
        return null;
    }
}
export function onHostToolPost(ctx, handler) {
    ctx.on('tools/post-execute', (call, result, next) => {
        handler(call, result);
        return next(result); // 纯观察，原样透传（waterfall 礼仪）
    });
}
