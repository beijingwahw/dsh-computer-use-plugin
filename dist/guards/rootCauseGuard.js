import { onToolPost } from './hooks.js';
import { runDifferentialProbes, } from '../diagnosis.js';
import { computeDiffRegions } from '../visualDiff.js';
import { probePoints } from '../interactivityProbe.js';
import * as physicalBackend from '../physicalBackend.js';
import { contextManager } from '../contextManager.js';
import { classifyResult, isFailure } from '../resultContract.js';
import { telemetry } from '../telemetry.js';
import { rememberFailure, extractSymptom } from './circuitBreakerGuard.js';
/** 最近报告环（W1-6：诊断观察面 —— 有界 8 条，环形淘汰） */
const RECENT_LIMIT = 8;
const recentReports = [];
/** W1-6：最近的鉴别报告（时间降序；诊断面板/测试观察面） */
export function recentRootCauseReports() {
    return [...recentReports];
}
/** W1-6：生命周期归零（插件卸载 / 测试隔离） */
export function resetRootCauseGuard() {
    recentReports.length = 0;
}
/** 从工具参数提取动作目标点（归一化坐标；缺席/非数值 ⇒ null —— 悬停探针跳过） */
function extractPoint(args) {
    const x = Number(args?.x);
    const y = Number(args?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y))
        return null;
    return { x, y };
}
/** data-URL/裸 base64 → Buffer（防御：解析失败 ⇒ null，参考帧降级为无像素） */
function decodeBase64Image(dataUrl) {
    try {
        const b64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
        const buf = Buffer.from(b64, 'base64');
        return buf.length > 0 ? buf : null;
    }
    catch {
        return null;
    }
}
/**
 * W1-6：生产探针端口 —— 鉴别试验与物理世界的唯一接缝（全部可注入替换）。
 *   getBeforeFrame：contextManager 最近截图（动作前参考帧；降级记录无像素）
 *   captureFrame：  低分辨率截屏（480px —— visualDiff 内部本就降采样到 480）
 *   diffFrames：    visualDiff.computeDiffRegions（① 像素差分引擎）
 *   probePoint：    interactivityProbe.probePoints（② 悬停光标/结构层探针 ——
 *                   复用 Z-1 引擎的存档/复位/守卫纪律，dry-run/弹窗自动弃权）
 * 物理端口统一以 healthSnapshot 在场为前提（绝不为归因孵化服务）。
 */
export function productionRootCausePorts(config) {
    return {
        getBeforeFrame: async () => {
            const rec = contextManager.lastImageRecord();
            if (!rec)
                return null;
            return {
                dhash: rec.hash ?? null,
                buffer: rec.base64 ? decodeBase64Image(rec.base64) : null,
            };
        },
        captureFrame: async () => {
            // 零孵化铁律：服务不在场 ⇒ 采帧缺席（鉴别降级，不孵服务）
            if (!physicalBackend.healthSnapshot())
                return null;
            const cap = await physicalBackend.captureProcessed({
                format: 'jpeg', quality: 60, maxWidth: 480, wantHashes: true,
            });
            return { dhash: cap.dhash ?? null, buffer: cap.buffer ?? null };
        },
        diffFrames: async (before, after) => {
            if (!before.buffer || !after.buffer)
                return null;
            const r = await computeDiffRegions(before.buffer, after.buffer);
            return { changed_fraction_pct: r.changed_fraction_pct, identical: r.identical };
        },
        ...(config.enableInteractivityProbe ? {
            probePoint: async (point) => {
                if (!physicalBackend.healthSnapshot())
                    return null; // 零孵化同律
                const [r] = await probePoints(config, [{ x: point.x, y: point.y }]);
                if (!r)
                    return null;
                const kind = r.evidence?.cursor_kind;
                return {
                    cursorKind: kind && kind !== 'n/a' ? kind : null,
                    verdict: r.verdict,
                };
            },
        } : {}),
    };
}
/**
 * W1-6：注册根因归因守卫。ports 参数是注入缝 —— 测试注入假帧/假光标/假 diff
 * （离线确定性）；缺省用生产端口（后端不在场时自动全降级，行为等价于 no-op）。
 */
export function registerRootCauseGuard(ctx, config, ports) {
    onToolPost(ctx, async (toolCall, result, next) => {
        // 旁路铁律：归因的一切都在 try 内；任何异常的成本是「这一次不归因」，
        // 绝不是工具结果被吞/被改/被延迟到异常路径。
        try {
            if (typeof result === 'string' && isFailure(classifyResult(result))) {
                const report = await runDifferentialProbes(ports ?? productionRootCausePorts(config), { tool: toolCall.name, point: extractPoint(toolCall.args) });
                // 观察面 1：最近报告环（时间降序插入）
                recentReports.unshift(report);
                if (recentReports.length > RECENT_LIMIT)
                    recentReports.length = RECENT_LIMIT;
                // 观察面 2：遥测计数（metrics_dashboard 的 counters 区消费；note 绝不抛）
                telemetry.note(`rootcause:${report.rootCause}`, true);
                if (report.degraded)
                    telemetry.note('rootcause:probe-degraded', false);
                // 出境 3：失败记忆病因随行（unknown 不写库 —— 兜底不冒充知识）
                if (report.rootCause !== 'unknown') {
                    rememberFailure(toolCall.name, toolCall.args, extractSymptom(result), report.rootCause);
                }
            }
        }
        catch {
            // 归因旁路：吞掉一切 —— 主流程零感知
        }
        return next(result); // 结果原样透传（观察者不改写世界）
    });
}
