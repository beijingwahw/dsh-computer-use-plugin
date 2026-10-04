// src/guards/probeAudit.ts
// ─── ΑΩ-R4（审计盲区消除）：守卫物理探针的防篡改存证（fail-open 立法）───
//
// 盲区：canaryGuard（金丝雀试演：click / type-char / backspace / region-hash）
// 与 rootCauseGuard（鉴别试验：悬停 hover-cursor / 采帧 capture-frame）的物理
// 微动作绕过宿主工具管线直调 physicalBackend —— 宿主管线的审计面（W2-2
// auditGuard 的先行审计 WAL + registerJournalGuard 的 post-execute 记录）对
// 它们零覆盖：探针动了真实桌面，链上却无痕。本模块把每一次探针物理派发以
// GUARD_PROBE 标记经 journal.appendMarker 补进哈希链。
//
// API 选择的论证（appendMarker 而非 appendPreDispatch）：探针标记须携带
// 「结果三态」，三态只在派发结算后可知 —— 先行 WAL 的意图行装不下结果；
// 且 appendPreDispatch 的 kind 恒为 AUDIT_PRE、语义是 fail-closed 提交，承载
// 不了专用 GUARD_PROBE 方言。这与 journal 主链自身的 post-execute 观察位
// 同律：探针行是「发生了什么 + 结局如何」的取证行，不是 fail-closed 意图行。
//
// fail-open 立法取舍（ΑΩ-R4，与 W2-2 的 fail-closed 相反，论证如下）：
//   · W2-2 对变更类工具 fail-closed 的理由：「没有审计轨迹的动作不可审计、
//     不可追责、不可回放 ⇒ 拒绝它是正确行为」—— 被拒的是越权动作，拒绝
//     本身无损安全；
//   · 探针恰恰相反：它本身就是安全机制（金丝雀向世界核对反事实预测 /
//     鉴别试验归因失败根因）。若审计失败 fail-closed 拒绝探针，一次审计
//     通道抖动（磁盘满 / 路径权限 / 病态载荷）就会：金丝雀降级放行未核对
//     的高危动作、或在 W6R 令牌路径上 fail-closed 误杀合法动作 —— 安全被
//     审计故障劫持；
//   · 探针的风险敞口有硬顶：幂等可逆微动作（点击回点 / 单字符退格 / 悬停
//     存档复位）+ 每会话预算封顶（CANARY_PROBE_BUDGET_DEFAULT=6）+ 墙钟预算
//     （RC_BUDGET_MS）—— 即便审计缺席，最坏情况是「几次可逆微动作无链上
//     存证」，而不是「不可逆大动作无审计放行」；
//   ⇒ 取舍：fail-open（审计失败探针照跑）+ 遥测打点 <guard>:probe-audit-failed
//     （audit_failed 可观测）—— 缺席可见，安全不瘫。
//
// 脱敏纪律（与 auditGuard 的 REDACT_KEYS 同律从严）：只记守卫名 + 探针步名 +
// 区域坐标 + 结果三态；type 探针只记 charCount（单字符事实），字符与文本
// 内容零明文（坐标是区域定位事实而非秘密 —— auditGuard 同样不脱敏 x/y）。
//
// 防御式铁律：本模块绝不抛（审计是旁路义务）；journal 禁用（enableJournal=
// false）是部署配置态而非故障 —— appendMarker 静默 no-op、不打点（与
// appendPreDispatch 的 skipped:'journal-disabled' 同一诚实边界）。
import { journal } from '../journal.js';
import { telemetry } from '../telemetry.js';
/**
 * ΑΩ-R4：一次守卫物理探针派发的审计提交（fail-open）。在派发结算后调用，
 * 把守卫名 + 探针步名 + 脱敏参数 + 结果三态以 GUARD_PROBE 标记写进 journal
 * 哈希链。绝不抛：任何提交失败收敛为一次 <guard>:probe-audit-failed 遥测
 * 打点，探针与主路径零感知（调用方无需为审计包 try/catch）。
 */
export async function auditGuardProbe(guard, probe, result, ctx = {}) {
    try {
        const marker = {
            kind: 'GUARD_PROBE',
            guard,
            probe: typeof probe === 'string' ? probe : '',
            result,
            ...(ctx.point != null && Number.isFinite(ctx.point.x) && Number.isFinite(ctx.point.y)
                ? { point: { x: ctx.point.x, y: ctx.point.y } }
                : {}),
            ...(typeof ctx.radius === 'number' && Number.isFinite(ctx.radius) ? { radius: ctx.radius } : {}),
            ...(typeof ctx.charCount === 'number' && Number.isFinite(ctx.charCount) ? { charCount: ctx.charCount } : {}),
        };
        await journal.appendMarker(marker);
    }
    catch {
        // fail-open 立法点（ΑΩ-R4，完整论证见文件头）：审计失败绝不拦截探针/主
        // 路径 —— 打点可见即可；遥测自身异常则到此为止（绝不抛）。
        try {
            telemetry.note(`${guard}:probe-audit-failed`, true);
        }
        catch { /* 已尽旁路义务 */ }
    }
}
