// src/approval.bypass.ts
// approval 旁路面（W8-B3 自 approval.ts 拆出 —— 代码逐字保持，零漂移）：
// Τ 纪元示范事件观察者 + W3-1（S1）逆转托管钩子。共同律：全部是审批主流程
// 的旁路 —— 观察者/钩子缺席或抛错 ⇒ 异常全吞、零行为（旁路义务：教育与
// 托管故障绝不炸审批主流程）。主账本（approval.ledger.ts）是唯一消费方。
//
// ─── Τ 纪元（干预即教育）：示范事件的动作形状（隐私铁律的铸造点） ───
//
// 人机交互研究的经典事实：用户干预（拒绝/手动接管）是最贵的监督信号，业界 agent
// 全部把它扔掉。Τ 把审批事件变成教育事件：
//   验收式消费成功（consume）= 特权正示范 —— 用户亲自背书且世界验证成功的动作模式
//     （这正是「用户同意的动作真的成了」的铁证，双重证据等级高于任何自动归纳）；
//   用户拒绝（grant=false）= 负示范 —— 这条路用户不让走。
// agent 越被纠正越懂这个用户。教育是旁路：观察者异常全吞，绝不炸审批主流程。
//
// 既有审批语义零变化：观察者缺席 / enableDemonstrations 关 ⇒ 零行为；
// 回调异常全吞（旁路义务 —— 教育失败绝不炸审批主流程）。事件的两个且仅两个
// 发射点：consume 成功（验收通过 = 特权正示范）与 grant(false)（用户否决 =
// 负示范）。revoke 是机械作废而非用户裁决，不发射（拒绝的语义主体在用户）。
import { createHash } from 'node:crypto';
import { reversibilityRegistry } from './riskGate.js';
/** 示范观察者（null = 缺席 ⇒ 零行为） */
let demoObserver = null;
/** 示范总开关：默认 true；由 config.enableDemonstrations 经
 *  configureDemonstrations 铸入（approvalTools 装配时） */
let demonstrationsEnabled = true;
/** 挂载/卸载示范观察者（fn=null 卸载）。回调异常在发射点全吞。 */
export function setDemonstrationObserver(fn) {
    demoObserver = fn;
}
/** 示范总开关（config.enableDemonstrations 的模块级铸入面） */
export function configureDemonstrations(enabled) {
    demonstrationsEnabled = enabled;
}
/** 教育事件发射（旁路）：tokenId 只出 sha256 前 8 位；观察者异常全吞。
 *  W1-2（H1）：批注在场 ⇒ amended 标注 + 批注内容随行（最强负示范对蒸馏
 *  下游可见）。
 *  W4-3（S5）：示范事件同步喂可逆性分级注册表（旁路的旁路 —— 注册表异常
 *  全吞，且只受 demonstrationsEnabled 总闸约束、不依赖观察者在场：注册表是
 *  内部分级知识，不是外部观察通道）。denial = 用户视此为不可逆的最强证据
 *  （adverse++，Beta 证据门防单事件翻级）；consumed = 特权正示范
 *  （supportive++，后验分母）。 */
export function emitDemonstration(pa, kind) {
    if (demonstrationsEnabled) {
        try {
            reversibilityRegistry.observeDemonstration({
                kind,
                ...(pa.reversibility?.semantics !== undefined ? { semantics: pa.reversibility.semantics } : {}),
                ...(pa.actionShape?.tool !== undefined ? { tool: pa.actionShape.tool } : {}),
                ...(pa.description !== undefined ? { description: pa.description } : {}),
            });
        }
        catch {
            /* 旁路义务：分级注册表故障绝不炸审批主流程 */
        }
    }
    if (!demonstrationsEnabled || !demoObserver)
        return;
    try {
        demoObserver({
            kind,
            actionShape: pa.actionShape,
            sceneFingerprint: pa.sceneFingerprint,
            tokenId: createHash('sha256').update(pa.token).digest('hex').slice(0, 8),
            amended: pa.amendment ? true : undefined,
            amendment: pa.amendment,
        });
    }
    catch {
        /* 旁路义务：教育失败=跳过（此处无下游注记消费方，静默即诚实） */
    }
}
/** W-1 隔离缝的旁路面归零（resetApproval 组合面调用 —— 观察者卸载、开关回
 *  默认 true；config 的铸入由下一次装配重做）。 */
export function resetDemonstrationState() {
    demoObserver = null;
    demonstrationsEnabled = true;
}
/** 派发前置闸门（null = 未注册 ⇒ beginAttempt 的托管面缺席，零行为） */
let dispatchEscrowHook = null;
/** 结算钩子（null = 未注册） */
let escrowSettlementHook = null;
/** 最近一次托管拦截（透明化面 —— 派发层组装拒绝指引的事实源） */
let lastEscrowBlock = null;
/** 挂载/卸载派发前置闸门（fn=null 卸载）。钩子由 reversalEscrow.arm 单点注册。 */
export function setDispatchEscrowHook(fn) {
    dispatchEscrowHook = fn;
}
/** 挂载/卸载结算钩子（fn=null 卸载）。钩子内的一切异常由发射点全吞。 */
export function setEscrowSettlementHook(fn) {
    escrowSettlementHook = fn;
}
/** 最近一次托管拦截（无拦截 ⇒ null；仅最近一条 —— 透明化面，非审计面） */
export function escrowBlockOf() {
    return lastEscrowBlock;
}
/** W3-1（S1）：结算钩子发射（旁路义务 —— 异常全吞，绝不炸审批主流程）。
 *  verified：consume 成功（世界出现预期变化 —— 预案关闭，无需补偿）；
 *  attempt-failed：attemptFailed（验收失败 —— 触发托管补偿）。钩子内部
 *  fire-and-forget，无在途预案时 no-op（普通审批流零参与 —— 正交性）。 */
export function fireEscrowSettlement(token, verdict, reason) {
    if (escrowSettlementHook === null)
        return;
    try {
        escrowSettlementHook(token, verdict, reason);
    }
    catch {
        /* 旁路义务：托管结算故障绝不炸审批主流程 */
    }
}
/** W3-1（S1）：派发前置闸门（W8-B3 拆分缝 —— 原为 beginAttempt 体内的守卫块，
 *  逐字提取；返回 true = 拦截（fail-closed 拒绝），false = 放行/零行为）。
 *  「没有逆转预案就绝无派发预留」的执法点。策略表查不到补偿路径的拒绝发生在
 *  铸造面（reversalEscrow.mintPlan fail-closed），此处兜底的是「跳过铸造直接
 *  派发」的路径：钩子未注册或不携预案 ⇒ 零行为；携预案但预案无效/错配 ⇒
 *  记 lastEscrowBlock 并拦截（拒绝置于一切簿记变异之前 —— 不烧预算与令牌）。 */
export function escrowBlockedByGate(token, escrow) {
    if (dispatchEscrowHook === null || escrow === undefined)
        return false;
    let verdict;
    try {
        verdict = dispatchEscrowHook({
            token: String(token ?? ''),
            planId: escrow.planId,
            semantics: escrow.semantics,
        });
    }
    catch {
        verdict = { ok: false, reason: 'plan-invalid', detail: 'escrow gate threw — failing closed' };
    }
    if (!verdict.ok) {
        lastEscrowBlock = {
            token: String(token ?? ''),
            planId: escrow.planId,
            semantics: escrow.semantics,
            reason: verdict.reason,
            ...(verdict.detail !== undefined ? { detail: verdict.detail } : {}),
            at: Date.now(),
        };
        return true;
    }
    return false;
}
/** W-1 隔离缝的托管面归零（resetApproval 组合面调用 —— 托管面回「未武装」
 *  默认；生产由 reversalEscrow.arm 重接）。 */
export function resetEscrowState() {
    dispatchEscrowHook = null;
    escrowSettlementHook = null;
    lastEscrowBlock = null;
}
