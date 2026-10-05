// ΠΑΝ-127（D-F5 清偿）：sleep 改自零出边叶导入（原借桶 actionVerifier.ts 构成
// value 二环；桶面同名符号仍经再分发可用）。
import { sleep } from './actionVerifier.shared.js';
import * as backend from './physicalBackend.js';
import { normalizeHash, hammingDistance, dhash } from './perceptualHash.js';
import { kernelRegistry } from './kernel/registry.js';
import { system } from './system.js';
/** 轮询直到屏幕稳定：服务端指纹轮询（meta_only —— 不编码不传图）。
 *  纪元 Ξ（Ξ-D 生产接线）：稳定判距读内核注册表 —— verify.stableGap（缺省 1：
 *  汉明距离 ≤ 此值视为同帧）。未注册 ⇒ getOrDefault 回声字面量，逐字节不变。 */
export async function waitForStableHash(pollMs, maxWaitMs) {
    const stableGap = kernelRegistry.getOrDefault('verify.stableGap', 1);
    const start = Date.now();
    let prev = await backend.captureProcessed({ metaOnly: true, wantHashes: true });
    let prevHash = prev.dhash ? normalizeHash(prev.dhash) : '';
    let prevFrameId = prev.frameId ?? null;
    while (Date.now() - start < maxWaitMs) {
        await sleep(pollMs);
        const cur = await backend.captureProcessed({ metaOnly: true, wantHashes: true });
        const hash = cur.dhash ? normalizeHash(cur.dhash) : '';
        if (hash && hammingDistance(prevHash, hash) <= stableGap) {
            return { hash, frameId: cur.frameId ?? null };
        }
        prevHash = hash;
        prevFrameId = cur.frameId ?? null; // 超时返回 (hash, frameId) 必须同帧 —— 指纹与帧环 id 配对错位会误导下游锚定
    }
    return { hash: prevHash, frameId: prevFrameId };
}
/** legacy 路径：buffer 轮询（sharp 可用且显式保留 buffer 时）。stableGap 同键同缺省。 */
export async function waitForStableFrame(pollMs, maxWaitMs) {
    const stableGap = kernelRegistry.getOrDefault('verify.stableGap', 1);
    const start = Date.now();
    let prevBuf = await system.captureScreen();
    let prevHash = await dhash(prevBuf);
    while (Date.now() - start < maxWaitMs) {
        await sleep(pollMs);
        const buf = await system.captureScreen();
        const hash = await dhash(buf);
        if (hammingDistance(prevHash, hash) <= stableGap)
            return { buffer: buf, hash };
        prevBuf = buf;
        prevHash = hash;
    }
    return { buffer: prevBuf, hash: prevHash };
}
