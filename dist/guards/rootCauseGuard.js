import { onToolPost } from './hooks.js';
import { runDifferentialProbes, } from '../diagnosis.js';
import { computeDiffRegions } from '../visualDiff.js';
import { probePoints } from '../interactivityProbe.js';
import * as physicalBackend from '../physicalBackend.js';
import { contextManager } from '../contextManager.js';
import { classifyResult, isFailure } from '../resultContract.js';
import { telemetry } from '../telemetry.js';
import { rememberFailure, extractSymptom } from './circuitBreakerGuard.js';
// ΑΩ-R4（审计盲区消除）：悬停/采帧探针的 GUARD_PROBE 存证提交（fail-open ——
// 探针是安全机制本身，审计失败只打点不拦截，立法论证见 probeAudit.ts 文件头）
import { auditGuardProbe } from './probeAudit.js';
// ΝΩ-2（物理探针互斥）：鉴别探针与用户/其他会话动作在同一 D-1 躯体队列排队
//（ioMutex 只读引入 —— 悬停/采帧不再与并发物理派发交错污染取证）
import { serialize } from '../ioMutex.js';
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
    inFlightProbes.clear(); // ΝΩ-2：在途探针一并归零（旧 promise 自行结算，不再可等）
    probeEpoch++; // ΝΩ-2：代际前滚 —— 在途探针的迟来结算不再写观察面（防跨代污染）
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
 * ΝΩ-2：两个物理端口（captureFrame/probePoint）的**整个派发体**（含零孵化
 * 门控）经 io.serialize 入队 —— 门控在临界区内裁决，拒绝派发也占一次队列
 * 轮转（诚实：探针是否触世界由队列序保证）。getBeforeFrame（会话记忆）与
 * diffFrames（纯计算）不是物理派发，不入队。
 */
export function productionRootCausePorts(config, io = { serialize }) {
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
        captureFrame: async () => io.serialize(async () => {
            // 零孵化铁律：服务不在场 ⇒ 采帧缺席（鉴别降级，不孵服务）
            if (!physicalBackend.healthSnapshot())
                return null;
            const cap = await physicalBackend.captureProcessed({
                format: 'jpeg', quality: 60, maxWidth: 480, wantHashes: true,
            });
            return { dhash: cap.dhash ?? null, buffer: cap.buffer ?? null };
        }),
        diffFrames: async (before, after) => {
            if (!before.buffer || !after.buffer)
                return null;
            // ΝΩ-24：computeDiffRegions 对非图像 buffer 现返回 null（维度守卫）——诚实降级
            const r = await computeDiffRegions(before.buffer, after.buffer);
            if (!r)
                return null;
            return { changed_fraction_pct: r.changed_fraction_pct, identical: r.identical };
        },
        ...(config.enableInteractivityProbe ? {
            probePoint: async (point) => io.serialize(async () => {
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
            }),
        } : {}),
    };
}
/**
 * ΑΩ-R4：鉴别探针端口的审计包装 —— 悬停（hover-cursor）与采帧（capture-frame）
 * 两次物理派发各自结算后补 GUARD_PROBE 审计行入防篡改链（此前这些绕过宿主
 * 工具管线的物理微动作链上无痕）。包装律：
 *   · 只包 probePoint / captureFrame 两个物理面；getBeforeFrame（会话记忆）
 *     与 diffFrames（纯计算）不是物理派发，不入审计面；
 *   · 逐字段防御读取：注入件属性读取即抛 ⇒ 整体放弃包装、原端口直通
 *     （审计是增益不是依赖 —— hostile 注入件的既有降级语义零变化）；
 *   · 包装层审计 fail-open（auditGuardProbe 绝不抛），端口的返回值/异常
 *     原样透传 —— diagnosis.safe 的降级语义零变化。
 */
function auditedRootCausePorts(ports) {
    try {
        const probePoint = ports.probePoint;
        const captureFrame = ports.captureFrame;
        return {
            getBeforeFrame: ports.getBeforeFrame,
            diffFrames: ports.diffFrames,
            freezeSamples: ports.freezeSamples,
            freezeSampleGapMs: ports.freezeSampleGapMs,
            portTimeoutMs: ports.portTimeoutMs,
            ...(typeof probePoint === 'function' ? {
                probePoint: async (point) => {
                    try {
                        const r = await probePoint(point);
                        await auditGuardProbe('rootcause', 'hover-cursor', r != null ? 'ok' : 'failed', { point });
                        return r;
                    }
                    catch (e) {
                        await auditGuardProbe('rootcause', 'hover-cursor', 'threw', { point });
                        throw e; // 原样上抛：safe() 的 threw 记注零变化
                    }
                },
            } : {}),
            ...(typeof captureFrame === 'function' ? {
                captureFrame: async () => {
                    try {
                        const r = await captureFrame();
                        await auditGuardProbe('rootcause', 'capture-frame', r != null ? 'ok' : 'failed', {});
                        return r;
                    }
                    catch (e) {
                        await auditGuardProbe('rootcause', 'capture-frame', 'threw', {});
                        throw e; // 原样上抛：同上
                    }
                },
            } : {}),
        };
    }
    catch {
        return ports; // ΑΩ-R4 fail-open：包装失败 ⇒ 原端口直通，探针照跑
    }
}
// ─── ΝΩ-2：fire-and-forget 异步结算 ───
//
// 旧实现在 return next(result) **之前** await runDifferentialProbes —— 鉴别
// 序列的墙钟预算 RC_BUDGET_MS=3000（diagnosis.ts），每次失败的结果回传最多
// 被探针拖住 3 秒（冻结探针的帧间隔 rcSleep 是真实计时器，后端缺席时也照睡）。
// 归因是观察者，世界的回执不该等它：现在先透传 result，探针后台跑完再异步
// 结算三个观察面（recentRootCauseReports / telemetry / failureMemory）。
// 在途集合（inFlightProbes）是结算可等待面 —— 测试与宿主可等「全部归因落账」，
// 绝不影响 post 链本身的即时返回。
/** 在途探针集合（结算完成即自移除；reset 归零 —— 旧 promise 仍会自行结算） */
const inFlightProbes = new Set();
/** ΝΩ-2：探针代际（reset 前滚 —— 迟来结算不写已归零的观察面，防跨代污染） */
let probeEpoch = 0;
/**
 * ΝΩ-2：等待当前在途的全部鉴别探针结算（测试/宿主的确定性同步面）。
 * 立即快照在途集合后等待 —— 等待期间新触发的探针不在本次承诺内。
 */
export async function rootCauseProbesSettled() {
    await Promise.allSettled([...inFlightProbes]);
}
/**
 * ΝΩ-2：鉴别探针的异步结算体（fire-and-forget 的后台半边）。
 * 铁律不变：任何异常吞掉 + 遥测打点（'rootcause:probe-settle-failed'）——
 * 后台结算的故障成本是「这一次观察面没落账」，绝不是 unhandled rejection
 * 或主流程异常。代际闸：reset（插件卸载/测试隔离）后迟来的结算整体让位 ——
 * 已归零的观察面不被上一代的报告复活。
 */
function settleDifferentialProbes(ports, toolCall, result) {
    const epoch = probeEpoch;
    return (async () => {
        const report = await runDifferentialProbes(ports, {
            tool: toolCall.name,
            point: extractPoint(toolCall.args),
        });
        if (epoch !== probeEpoch)
            return; // 跨代结算：观察面已归零，让位
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
    })().catch(() => {
        // 后台结算兜底：runDifferentialProbes 自身绝不抛（防御性双保险），
        // 观察面写入的意外异常在此吞掉 + 打点 —— fire-and-forget 绝不悬挂成
        // unhandled rejection
        try {
            telemetry.note('rootcause:probe-settle-failed', false);
        }
        catch { /* 打点也炸：到此为止 */ }
    });
}
/**
 * W1-6：注册根因归因守卫。ports 参数是注入缝 —— 测试注入假帧/假光标/假 diff
 * （离线确定性）；缺省用生产端口（后端不在场时自动全降级，行为等价于 no-op）。
 * ΝΩ-2：探针 fire-and-forget —— post 链先透传 result 再后台归因（见上）。
 */
export function registerRootCauseGuard(ctx, config, ports) {
    onToolPost(ctx, async (toolCall, result, next) => {
        // 旁路铁律：归因的一切都在 try 内；任何异常的成本是「这一次不归因」，
        // 绝不是工具结果被吞/被改/被延迟到异常路径。
        try {
            if (typeof result === 'string' && isFailure(classifyResult(result))) {
                const tracked = settleDifferentialProbes(
                // ΑΩ-R4：物理探针（悬停/采帧）派发先经审计包装 —— 每次派发入
                // GUARD_PROBE 防篡改链（fail-open：包装/审计故障绝不瘫痪归因）
                auditedRootCausePorts(ports ?? productionRootCausePorts(config)), { name: toolCall.name, args: toolCall.args }, result);
                inFlightProbes.add(tracked);
                void tracked.then(() => { inFlightProbes.delete(tracked); }); // settle 吞一切，then 仅做名册除名
            }
        }
        catch {
            // 归因旁路：吞掉一切 —— 主流程零感知
        }
        return next(result); // 结果先透传（ΝΩ-2：观察者不等归因，更不改写世界）
    });
}
