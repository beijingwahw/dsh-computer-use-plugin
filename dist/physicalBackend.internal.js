// src/physicalBackend.internal.ts
// W6-2（doctor smell.over-engineering 清偿）：自 physicalBackend.ts 低风险分区提取 ——
// 模块私有生命周期小件（Result 解包 / 端口探活 / 语义化版本比较）。纯函数，行为零变化；
// 仅 physicalBackend.ts 消费（不进公开再分发面）。
export function unwrap(result, what) {
    if (result.ok)
        return result.value;
    throw new Error(`[physicalBackend] ${what} failed: ${result.error.kind}: ${result.error.detail}`);
}
/** 端口占用探测：健康端点有响应即视为「已有服务存活」 */
export async function probeAlive(port) {
    try {
        const resp = await fetch(`http://127.0.0.1:${port}/v1/health`, {
            signal: AbortSignal.timeout(800),
        });
        const alive = resp.ok;
        // 取消响应体：未消费的 body 会占住连接池里挂起的 socket
        resp.body?.cancel().catch(() => { });
        return alive;
    }
    catch {
        return false;
    }
}
/** 语义化版本比较（数字段逐段）：字符串序会把 '0.10.0' 判小于 '0.4.0'，必须按段数值比 */
export function versionLt(a, b) {
    const pa = a.split('.').map(s => parseInt(s, 10) || 0);
    const pb = b.split('.').map(s => parseInt(s, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0)
            return d < 0;
    }
    return false;
}
