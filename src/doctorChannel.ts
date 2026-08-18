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
import type { RehearsalEndPayload } from './sandbox/events';

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
 * 回执沉默的一切路径（装配失败 / 诊断故障 / 并发占用）都是诚实降级 ——
 * D-5 的固化闸门默认 freeze-for-review，绝不因通道故障而放行。
 */
export function wireDoctorVerdictChannel(ctx: Context, config: Config): void {
  let busy = false;
  (ctx as any).on(SANDBOX_EVENTS.rehearsalEnd, async (p: RehearsalEndPayload) => {
    if (!p || typeof p.chainId !== 'string' || typeof p.chainTip !== 'string') {
      return; // 非法载荷：拒绝回执（沉默 ⇒ 冻结，保守方向）
    }
    if (busy) {
      console.warn(`[DoctorChannel] diagnose in flight — verdict receipt skipped for ${p.chainId} (D-5 freezes for review, honest).`);
      return;
    }
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
  });
  console.log('[DoctorChannel] D-4 verdict receipt channel armed (sandbox/rehearsal-end → doctor/verdict).');
}
