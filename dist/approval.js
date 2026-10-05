// src/approval.ts
// 第六轮创新之一：一次性审批令牌（One-shot Approval Token）。
// 不可逆操作（发送/删除/支付/提交订单…）需要显式授权：模型先 request_approval
// 生成令牌并告知用户，用户在对话中同意后，模型携令牌重试动作。
// 令牌四性质：一次性（用后即焚）、短时效（默认 10min，覆盖整个任务的重试窗口）、
// 带用途（描述随行）、**须授予**（J 纪元：grant_approval(token, true) 是执行的
// 必要条件 —— 旧协议"从未 grant"与"grant=true"对执行层无区别，审批闸门的
// 同意环节形同虚设）。
//
// Y 纪元（Y-10）：审批令牌桶 —— 同意本身也是有限资源。
//
// V 纪元（验收式消费）：用户的同意锚定在**任务意图**上，而非单次点击派发。
// 旧语义在「点击已派发但世界未变」（落错窗口/坐标漂移）时也焚毁令牌 ——
// 一次用户确认只换来一次物理尝试，重试即二次打扰（实测：发一封邮件被问了
// 三次 yes）。新语义：**令牌只在验收通过（世界出现预期变化）时焚毁**；
// 未生效的尝试不消耗同意（no-op 不是不可逆操作），登记后自动续期供重试，
// 直到验收通过、尝试次数超限或生命周期硬顶到期。安全性不降反升：
// 每次「验收通过」的世界变化仍恰好消耗一枚令牌 + 一枚 Y-10 桶令牌。
//
// ─── W8-B3 拆分注记（本文件 = 桶/门面，导入面零改动） ───
//
// approval.ts 原为 1584 行单文件；W8-B3 按内聚分区拆为兄弟文件簇
// （与 actionVerifier.* 同形式），本桶文件再导出全部既有公共符号 ——
// 大量测试与 src 消费方直接 import approval，符号面与语义零变化：
//   · approval.constants.ts     立法常量区（TTL/封顶/桶宽/队列预算 —— 数值即契约）
//   · approval.shapes.ts        脱敏契约（长度桶/形状脱敏/字符串净化）
//   · approval.registry.ts      共享簿记注册表（pending Map + 令牌类型；
//                               主账本与队列共用的下层 —— 依赖图无环的缝合点）
//   · approval.security.ts      安全原语（令牌铸造/带外确认码 S2/批注 H1/Y-10 桶）
//   · approval.bypass.ts        旁路面（Τ 示范观察者 + W3-1 托管钩子/闸门）
//   · approval.ledger.ts        主账本（approval 对象：授予/验收式消费/批注读取；
//                               W6R fail-closed 守卫的执法点在此文件）
//   · approval.queueContracts.ts / approval.queueState.ts / approval.queue.ts
//                               队列面（W2-1 暂存式离线批准队列：契约/状态核/API）
// 行为零漂移：所有代码逐字搬移；仅有的新增缝 = 跨文件只读探针
// （confirmChannelArmed）、逐字提取的闸门函数（escrowBlockedByGate）与
// 隔离缝组合（本文件的 resetApproval 调各分区归零函数，顺序与原实现一致）。
// 注意：sec.approval-fail-closed 规则以「含 grant 裁决方法落点」为内容锚 ——
// 该裁决方法现居 approval.ledger.ts；本桶文件**不得**出现该方法的字面名
// （否则规则会锚定到无守卫的桶文件上，产生误报）。
import { pending } from './approval.registry.js';
import { grantBucket, setConfirmCodeChannel, resetApprovalSecurityState } from './approval.security.js';
import { resetDemonstrationState, resetEscrowState } from './approval.bypass.js';
import { resetQueueState } from './approval.queueState.js';
import { reversibilityRegistry } from './riskGate.js';
// ─── 公共符号面（与拆分前逐一对齐 —— 导入面零改动） ───
// 脱敏契约
export { lengthBucket, sanitizeActionShape, normalizeToken } from './approval.shapes.js';
export { TokenBucket, setConfirmCodeChannel, approvalBudget } from './approval.security.js';
// ΠΑΝ-5（能力限缩令牌）：目标摘要规范化/比对原语与绑定拒绝透明化面
export { computeTargetDigest, digestsEqual, targetRejectionOf } from './approval.security.js';
export { setDemonstrationObserver, configureDemonstrations } from './approval.bypass.js';
export { setDispatchEscrowHook, setEscrowSettlementHook, escrowBlockOf, escrowGateArmed } from './approval.bypass.js';
// 主账本
export { approval } from './approval.ledger.js';
export { createApprovalQueueFileStorage } from './approval.queueContracts.js';
export { approvalQueue, armApprovalQueue } from './approval.queue.js';
// ─── W 纪元（W-1 隔离缝）：resetApproval —— 各分区归零的组合面 ───
/** 审批簿记归零 —— 测试隔离与插件卸载共用。
 *  Τ 纪元：观察者面随簿记一并归零（observer=null、开关回默认 true ——
 *  config 的铸入由下一次装配重做），隔离缝不漏教育旁路的全局态。
 *  W1-2（S2）：带外确认码通道一并卸载（恢复通道缺席的 fail-closed 默认 ——
 *  测试的确定性基线；生产由组合根的下一次 wireDoctorVerdictChannel 重新武装）。
 *  W2-1（H4）：暂存队列一并归零（内存条目清空、存储/时钟注入卸载回缺省 ——
 *  测试不得读到上一用例的持久化队列；生产由下一次组合根武装重接）。
 *  W3-1（S1）：托管钩子/拦截簿记一并卸载（gate=null、settlement=null、
 *  block=null —— 托管面回「未武装」默认；生产由 reversalEscrow.arm 重接）。
 *  W4-3（S5）：可逆性分级注册表的证据账一并归零（approval 现在直接喂
 *  注册表 —— 隔离缝不漏旁路的全局态，与 Τ 观察者面同律）。
 *  ΠΑΝ-5/6（能力限缩令牌修复潮）：安全原语区的伴随账（目标绑定映射 /
 *  兑换权标记 / 最近目标绑定拒绝）一并归零 —— 测试不得读到上一用例的绑定
 *  或兑换残迹（fail-closed 基线的确定性）。
 *  （W8-B3 拆分：各分区经自身的归零函数复位，调用顺序与原单文件实现一致。） */
export function resetApproval() {
    pending.clear();
    grantBucket.reset();
    resetDemonstrationState();
    setConfirmCodeChannel(null);
    resetEscrowState();
    resetApprovalSecurityState();
    resetQueueState();
    try {
        reversibilityRegistry.reset();
    }
    catch { /* 隔离缝防御：注册表故障不炸审批归零 */ }
}
