// src/doctorChannel.ts
// D-4 判决回执通道（P0-4 发射端补全）：订阅 sandbox/rehearsal-end → 自主触发诊断
// （sandbox/types.ts §8 契约：includeChainAudit: true）→ 翻译 DiagnosisReport →
// 发射 doctor/verdict 回执。D-5（固化双闸门）/ D-6（attempt 判决索引）/
// D-7（验收结算门）三方消费者至此闭环 —— 此前消费侧全部接线而发射端缺席。
// 依赖方向：本文件 import D-5 的发射契约（sandbox/events）—— 消费方向合法
// （对齐 D-5 import doctorEvents 先例）；qualityDoctor.ts 核心绝不 import D-5
// 模块（doctorEvents.ts 头注的反向环红线），故通道独立成文件而非并入医生本体。
// 异常诚实：回执失败 = 沉默（D-5 消费侧默认 freeze-for-review —— 无证据即冻结，
// 保守方向）；本通道一切路径永不 throw。
import type { Context } from '@deepseek-ai/cordis';
import { doctor, ensureDoctorConfigured } from './qualityDoctor';
import type { Config } from './config';
import type { DiagnosisReport } from './doctorTypes';
import { DOCTOR_VERDICT_EVENT, makeScore } from './doctorEvents';
import type { DoctorVerdictPayload } from './doctorEvents';
import { SANDBOX_EVENTS } from './sandbox/events';
import type { SandboxDoctorView } from './sandbox/types';
import type { RehearsalEndPayload } from './sandbox/events';
import { setConfirmCodeChannel, armApprovalQueue, createApprovalQueueFileStorage, type ConfirmCodeDelivery } from './approval';

/** 判决阈值（D-4 通道主权立法）：approved 的分数下限。
 *  三重前置（缺一即 needs_review）：genesisVerdict='intact' + 零 critical/major
 *  + chainAudited（闸三哲学：未执行的验证层之上无完美分）。 */
const APPROVAL_SCORE_FLOOR = 80;

/** rationale 预算（对齐 DoctorVerdictPayload.rationale 契约 ≤200 —— Token 纪律） */
function clampRationale(s: string): string {
  return s.length > 200 ? s.slice(0, 197) + '...' : s;
}

/** 首个发现的一行式证据（rejected/needs_review 的 rationale 素材） */
function topFindingLine(report: DiagnosisReport): string {
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
export function translateReportToVerdict(
  report: DiagnosisReport,
  subject: string,
  chainTip: string,
): DoctorVerdictPayload {
  const minted = makeScore(report.score);
  if (minted === null) {
    return {
      subject, chainTip, verdict: 'needs_review', score: makeScore(0)!,
      rationale: clampRationale(`score ${report.score} out of 0-100 domain — reminted to 0, needs human review`),
    };
  }
  const critical = report.findings.filter(f => f.severity === 'critical').length;
  const major = report.findings.filter(f => f.severity === 'major').length;
  if (report.genesisVerdict === 'violated' || critical > 0) {
    return {
      subject, chainTip, verdict: 'rejected', score: minted,
      rationale: clampRationale(
        `genesis ${report.genesisVerdict}, ${critical} critical / ${major} major finding(s); ${topFindingLine(report)}`),
    };
  }
  if (report.genesisVerdict === 'intact' && major === 0 && minted >= APPROVAL_SCORE_FLOOR && report.chainAudited) {
    return { subject, chainTip, verdict: 'approved', score: minted };
  }
  return {
    subject, chainTip, verdict: 'needs_review', score: minted,
    rationale: clampRationale(
      `score ${minted} below floor ${APPROVAL_SCORE_FLOOR} or major=${major}/chainAudited=${report.chainAudited}; ${topFindingLine(report)}`),
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
export function toSandboxDoctorView(doc: { reportPath(): string | null; memory(): { totalDiagnoses: number; lastReport: { score: number } | null } }): SandboxDoctorView {
  return {
    reportPath: () => doc.reportPath(),
    memory: () => doc.memory(),
  };
}

// ─── W1-2（S2 带外人证通道）：审批确认码的带外投递挂点 ───
//
// 威胁模型：审批协议的旧软肋是「同意」与「人」之间只隔着模型的转述 —— 被注入
// 的模型可以谎称"用户同意了"。S2 给同意加一道带外人证：request_approval 铸造
// 6 位确认码，码只经**模型上下文不可见**的通道投给人类（控制台 / 宿主事件总
// 线的弹窗、toast、推送），grant_approval 必须携带人类读码后交回的码。
// 挂点选择（实读裁定）：本文件是插件唯一既有的「宿主侧通知通道」事实源
// （D-4 判决回执即走宿主 console + ctx.emit），S2 的带外面复用同一主权 ——
// 通道缺席（未武装 / 投递故障）时 approval 侧自动降级旧式无码 grant 并记
// degraded，现有宿主流零破坏。本段一切路径永不 throw。

/** W1-2（S2）：确认码带外事件（宿主 UI 的挂点 —— 弹窗/toast/推送）。
 *  载荷含明文码：事件总线是宿主进程内总线，不在模型上下文里。 */
export const APPROVAL_CONFIRM_CODE_EVENT = 'approval/confirm-code';

/** W1-2（S2）：带外投递载荷（与 approval.ConfirmCodeDelivery 同形） */
export interface ApprovalConfirmCodePayload {
  token: string;
  description: string;
  confirmCode: string;
  expiresAt: number;
}

/**
 * W1-2（S2）：武装带外人证通道（幂等；组合根调用一次）。投递面双通道，
 * 均对模型上下文不可见（out-of-band 的安全本质）：
 *   1. 宿主进程控制台 —— 永远在场的人证面；
 *   2. cordis 事件总线 approval/confirm-code（ctx 可选）—— 宿主 UI 挂点。
 * 任一通道成功即视为已投递（返回 true ⇒ 审批进入带码模式）；
 * 武装失败 ⇒ 通道缺席 ⇒ approval 侧降级（防御式：本函数绝不抛）。
 */
export function armOutOfBandConfirmChannel(ctx?: Context): void {
  try {
    setConfirmCodeChannel((d: ConfirmCodeDelivery) => {
      const ttl = Math.max(0, Math.round((d.expiresAt - Date.now()) / 1000));
      let consoleOk = false;
      try {
        // 主通道：控制台。刻意声明「绝无必要转述给模型」—— 码属于人类。
        console.log(
          `[Approval OOB] "${d.description}" — user confirm code: ${d.confirmCode} ` +
          `(token ${d.token}, expires in ${ttl}s). This code is for the HUMAN ONLY — ` +
          'it must never be relayed into the model conversation.',
        );
        consoleOk = true;
      } catch { /* 控制台故障 ⇒ 副通道仍可投递 */ }
      try {
        (ctx as unknown as { emit?: (event: string, payload: unknown) => void } | undefined)
          ?.emit?.(APPROVAL_CONFIRM_CODE_EVENT, {
            token: d.token,
            description: d.description,
            confirmCode: d.confirmCode,
            expiresAt: d.expiresAt,
          } satisfies ApprovalConfirmCodePayload);
      } catch { /* 事件总线故障：主通道已投 ⇒ 不算投递失败 */ }
      return consoleOk;
    });
  } catch {
    /* 装配失败 ⇒ 通道缺席 ⇒ approval 侧自动降级（武装永不抛） */
  }
}

export function wireDoctorVerdictChannel(ctx: Context, config: Config): void {
  let busy = false;
  const pendingReceipts: RehearsalEndPayload[] = [];
  const drain = async (): Promise<void> => {
    while (pendingReceipts.length > 0) {
      const p = pendingReceipts.shift()!;
      await runReceipt(p);
    }
  };
  const runReceipt = async (p: RehearsalEndPayload): Promise<void> => {
    busy = true;
    try {
      const cfgErr = await ensureDoctorConfigured(config);
      if (cfgErr !== null) {
        console.warn(`[DoctorChannel] doctor unconfigured — no receipt for ${p.chainId}: ${cfgErr}`);
        return;
      }
      const report = await doctor.diagnose({ includeChainAudit: true }); // §8 契约：自主触发
      const payload = translateReportToVerdict(report, p.chainId, p.chainTip);
      (ctx as any).emit(DOCTOR_VERDICT_EVENT, payload);
      console.log(`[DoctorChannel] verdict receipt for ${p.chainId}: ${payload.verdict} score=${payload.score}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[DoctorChannel] receipt fault for ${p.chainId} — silence keeps D-5 frozen (honest): ${msg}`);
    } finally {
      busy = false;
    }
  };
  (ctx as any).on(SANDBOX_EVENTS.rehearsalEnd, async (p: RehearsalEndPayload) => {
    if (!p || typeof p.chainId !== 'string' || typeof p.chainTip !== 'string') {
      return; // 非法载荷：拒绝回执（沉默 ⇒ 冻结，保守方向）
    }
    if (busy) {
      // Δ 纪元（审计#2）：原实现用「元素与自身比较」的 filter 且未赋值回——
      // 到达回执照旧静默丢。改为同链替换、异链追加（FIFO 上限语义保留）。
      const idx = pendingReceipts.findIndex(r => r.chainId === p.chainId);
      if (idx >= 0) pendingReceipts.splice(idx, 1, p);
      else pendingReceipts.push(p);
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
    const ckpt = (config as { checkpointPath?: unknown }).checkpointPath;
    const queuePath = typeof ckpt === 'string' && ckpt ? ckpt + '.approval-queue.json' : '';
    armApprovalQueue(queuePath ? { storage: createApprovalQueueFileStorage(queuePath) } : {});
  } catch {
    /* 队列武装失败 ⇒ 暂存不可用 ⇒ 阻塞审批原样（诚实降级） */
  }
  console.log('[DoctorChannel] D-4 verdict receipt channel armed (sandbox/rehearsal-end → doctor/verdict).');
}
