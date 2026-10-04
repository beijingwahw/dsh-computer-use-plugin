import { doctor, ensureDoctorConfigured } from './qualityDoctor.js';
import { DOCTOR_VERDICT_EVENT, makeScore } from './doctorEvents.js';
import { SANDBOX_EVENTS } from './sandbox/events.js';
import { setConfirmCodeChannel, armApprovalQueue, createApprovalQueueFileStorage } from './approval.js';
/** 判决阈值（D-4 通道主权立法）：approved 的分数下限。
 *  三重前置（缺一即 needs_review）：genesisVerdict='intact' + 零 critical/major
 *  + chainAudited（闸三哲学：未执行的验证层之上无完美分）。 */
const APPROVAL_SCORE_FLOOR = 80;
/** rationale 预算（对齐 DoctorVerdictPayload.rationale 契约 ≤200 —— Token 纪律） */
function clampRationale(s) {
    return s.length > 200 ? s.slice(0, 197) + '...' : s;
}
/** 首个发现的一行式证据（rejected/needs_review 的 rationale 素材） */
function topFindingLine(report) {
    const f = report.findings.find(x => x.severity === 'critical') ?? report.findings[0];
    return f ? `top: ${f.ruleId} ${f.location.file}:${f.location.line} — ${f.evidence}` : '';
}
/**
 * 纯翻译（D-4 内部主权）：DiagnosisReport → doctor/verdict 三态判决。
 * 永不抛错。映射规则：
 *   rejected     ⇐ genesisVerdict='violated' 或任何 critical 发现（创世铁律 = 否决权）
 *   approved     ⇐ intact + 零 critical/major + score ≥ 80 + chainAudited
 *   needs_review ⇐ 其余一切（含分数域外 —— makeScore 失败即降级，绝不 clamp 掩埋）
 */
export function translateReportToVerdict(report, subject, chainTip) {
    const minted = makeScore(report.score);
    if (minted === null) {
        return {
            subject, chainTip, verdict: 'needs_review', score: makeScore(0),
            rationale: clampRationale(`score ${report.score} out of 0-100 domain — reminted to 0, needs human review`),
        };
    }
    const critical = report.findings.filter(f => f.severity === 'critical').length;
    const major = report.findings.filter(f => f.severity === 'major').length;
    if (report.genesisVerdict === 'violated' || critical > 0) {
        return {
            subject, chainTip, verdict: 'rejected', score: minted,
            rationale: clampRationale(`genesis ${report.genesisVerdict}, ${critical} critical / ${major} major finding(s); ${topFindingLine(report)}`),
        };
    }
    if (report.genesisVerdict === 'intact' && major === 0 && minted >= APPROVAL_SCORE_FLOOR && report.chainAudited) {
        return { subject, chainTip, verdict: 'approved', score: minted };
    }
    return {
        subject, chainTip, verdict: 'needs_review', score: minted,
        rationale: clampRationale(`score ${minted} below floor ${APPROVAL_SCORE_FLOOR} or major=${major}/chainAudited=${report.chainAudited}; ${topFindingLine(report)}`),
    };
}
/**
 * 通道接线（组合根调用一次）：rehearsal-end 到达 ⇒ 惰性装配 ⇒ 自主诊断 ⇒ 回执。
 * 回执沉默的一切路径（装配失败 / 诊断故障）都是诚实降级 ——
 * D-5 的固化闸门默认 freeze-for-review，绝不因通道故障而放行。
 * J 纪元修正：busy 期间的到达进小型 FIFO 队列（上限 4，溢出丢最旧并警告）——
 * 旧实现直接丢弃（连重试都没有），长诊断 + 高频 rehearsal 场景下系统性丢回执，
 * 对应 D-5 链条永久冻结直到下一次 rehearsal-end。
 */
const PENDING_RECEIPTS_MAX = 4;
/**
 * L 纪元：SandboxDoctorView 从死导出升级为活契约 —— 沙箱侧消费医生的
 * 最小门面适配（Token 纪律：reportPath 句柄 + 记忆摘要；医生本体绝不进沙箱）。
 */
export function toSandboxDoctorView(doc) {
    return {
        reportPath: () => doc.reportPath(),
        memory: () => doc.memory(),
    };
}
// ─── W1-2（S2 带外人证通道）：审批确认码的带外投递挂点 ───
//
// 威胁模型：审批协议的旧软肋是「同意」与「人」之间只隔着模型的转述 —— 被注入
// 的模型可以谎称"用户同意了"。S2 给同意加一道带外人证：request_approval 铸造
// 6 位确认码，码只经**模型上下文不可见**的通道投给人类（宿主事件总线的弹窗、
// toast、推送），grant_approval 必须携带人类读码后交回的码。
// 挂点选择（实读裁定）：本文件是插件唯一既有的「宿主侧通知通道」事实源
// （D-4 判决回执即走宿主 console + ctx.emit），S2 的带外面复用同一主权。
// W6R 安全修复（两律）：
//   1. 明文码只走事件总线（宿主进程内总线，不在模型上下文里）—— 控制台输出
//      一律脱敏（"确认码已投递(6位)"）：宿主可能把控制台日志回传进模型上下文，
//      明文码进 console/log 即等于对模型可见，「码对模型不可见」的承诺失效；
//   2. 事件总线缺席/投递失败 ⇒ 通道投递失败 ⇒ approval 侧记 degraded 且
//      grantDetailed 拒绝（fail-closed，见 approval.ts W6R 段）—— 不再降级为
//      无码 grant（旧 fail-open 让屏幕注入文本可驱动自批不可逆操作）。
// 本段一切路径永不 throw。
/** W1-2（S2）：确认码带外事件（宿主 UI 的挂点 —— 弹窗/toast/推送）。
 *  载荷含明文码：事件总线是宿主进程内总线，不在模型上下文里。
 *  W6R：这是**唯一**携带明文码的通道 —— console/log/遥测一律脱敏。 */
export const APPROVAL_CONFIRM_CODE_EVENT = 'approval/confirm-code';
/**
 * W1-2（S2）：武装带外人证通道（幂等；组合根调用一次）。
 * W6R 安全修复后的投递语义：
 *   · **唯一携码通道**是 cordis 事件总线 approval/confirm-code（ctx.emit）——
 *     宿主 UI 在此挂弹窗/toast/推送；emit 成功 ⇒ 已投递（审批进入带码模式）。
 *   · 控制台只打**脱敏**回执（"确认码已投递(6位)"，不含码本身）：宿主可能把
 *     控制台日志回传进模型上下文，任何路径都不得把明文码写进 console/log/遥测。
 *   · ctx 缺席 / 无 emit / emit 抛出 ⇒ 投递失败 ⇒ approval 侧记 degraded 且
 *     grant 拒绝（fail-closed：无带外人证即无同意，用户须经宿主 UI 操作）。
 * 防御式：本函数绝不抛。
 */
export function armOutOfBandConfirmChannel(ctx) {
    try {
        setConfirmCodeChannel((d) => {
            const ttl = Math.max(0, Math.round((d.expiresAt - Date.now()) / 1000));
            // 脱敏控制台回执（旁路）：只透出「已投递」事实与对号信息（token/时效），
            // 绝不含明文码 —— 码属于人类，console 可能被宿主回传进模型上下文。
            try {
                console.log(`[Approval OOB] "${d.description}" — 确认码已投递(6位)，经宿主事件总线 ` +
                    `${APPROVAL_CONFIRM_CODE_EVENT}（token ${d.token}，${ttl}s 内有效）。` +
                    '码仅供人类：不得转述进模型对话，不得写入任何日志/遥测。');
            }
            catch { /* 脱敏回执是旁路 —— 控制台故障不影响投递裁决 */ }
            // 主通道（唯一携码面）：宿主事件总线。缺席/故障 ⇒ false ⇒ fail-closed。
            try {
                const emit = ctx
                    ?.emit;
                if (typeof emit !== 'function')
                    return false; // 无总线 = 通道缺席（fail-closed）
                emit(APPROVAL_CONFIRM_CODE_EVENT, {
                    token: d.token,
                    description: d.description,
                    confirmCode: d.confirmCode,
                    expiresAt: d.expiresAt,
                });
                return true;
            }
            catch {
                return false; // 总线故障 = 投递失败（fail-closed；铸造主流程绝不炸）
            }
        });
    }
    catch {
        /* 装配失败 ⇒ 通道缺席 ⇒ approval 侧 fail-closed（武装永不抛） */
    }
}
export function wireDoctorVerdictChannel(ctx, config) {
    let busy = false;
    const pendingReceipts = [];
    const drain = async () => {
        while (pendingReceipts.length > 0) {
            const p = pendingReceipts.shift();
            await runReceipt(p);
        }
    };
    const runReceipt = async (p) => {
        busy = true;
        try {
            const cfgErr = await ensureDoctorConfigured(config);
            if (cfgErr !== null) {
                console.warn(`[DoctorChannel] doctor unconfigured — no receipt for ${p.chainId}: ${cfgErr}`);
                return;
            }
            const report = await doctor.diagnose({ includeChainAudit: true }); // §8 契约：自主触发
            const payload = translateReportToVerdict(report, p.chainId, p.chainTip);
            ctx.emit(DOCTOR_VERDICT_EVENT, payload);
            console.log(`[DoctorChannel] verdict receipt for ${p.chainId}: ${payload.verdict} score=${payload.score}`);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`[DoctorChannel] receipt fault for ${p.chainId} — silence keeps D-5 frozen (honest): ${msg}`);
        }
        finally {
            busy = false;
        }
    };
    ctx.on(SANDBOX_EVENTS.rehearsalEnd, async (p) => {
        if (!p || typeof p.chainId !== 'string' || typeof p.chainTip !== 'string') {
            return; // 非法载荷：拒绝回执（沉默 ⇒ 冻结，保守方向）
        }
        if (busy) {
            // Δ 纪元（审计#2）：原实现用「元素与自身比较」的 filter 且未赋值回——
            // 到达回执照旧静默丢。改为同链替换、异链追加（FIFO 上限语义保留）。
            const idx = pendingReceipts.findIndex(r => r.chainId === p.chainId);
            if (idx >= 0)
                pendingReceipts.splice(idx, 1, p);
            else
                pendingReceipts.push(p);
            while (pendingReceipts.length > PENDING_RECEIPTS_MAX) {
                const dropped = pendingReceipts.shift();
                console.warn(`[DoctorChannel] receipt queue overflow — dropped verdict for ${dropped?.chainId} (D-5 freezes for review, honest).`);
            }
            return;
        }
        await runReceipt(p);
        void drain(); // 队列排空（fire-and-forget：drain 内部自持 busy 标志）
    });
    armOutOfBandConfirmChannel(ctx); // W1-2（S2）：组合根既有的接线点顺带武装带外人证通道（幂等）
    // W2-1（H4）：暂存式离线批准队列武装 —— 与带外通道同一组合根挂点（宿主在
    // 场 ⇒ 通道在 ⇒ 暂存资格在；stageAction 自行执法通道缺席 = 维持阻塞审批）。
    // 持久化锚点派生自 checkpointPath（同目录同寿命 —— 快照在则队列在）：
    // checkpointPath 缺省 ⇒ 仅内存队列（跨进程不保，但 checkpoint 段照常随档 ——
    // 诚实降级而非静默丢失）。武装绝不抛。
    try {
        const ckpt = config.checkpointPath;
        const queuePath = typeof ckpt === 'string' && ckpt ? ckpt + '.approval-queue.json' : '';
        armApprovalQueue(queuePath ? { storage: createApprovalQueueFileStorage(queuePath) } : {});
    }
    catch {
        /* 队列武装失败 ⇒ 暂存不可用 ⇒ 阻塞审批原样（诚实降级） */
    }
    console.log('[DoctorChannel] D-4 verdict receipt channel armed (sandbox/rehearsal-end → doctor/verdict).');
}
