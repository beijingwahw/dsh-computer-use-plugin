// src/actionVerifier.ts
// 行为效果验证引擎。三轮演进：
//   R1 盲点检测（全屏 dHash 前后对比）
//   R2 自适应稳定等待（轮询至屏幕稳定，动画期不误判）
//   R3 双尺度验证（全屏 + 区域指纹）+ 焦点区域放大局部变化
// 判定矩阵：全屏变化 = 页面级效果；仅区域变化 = 元素级效果（光标出现/文字输入）；
// 两者皆未变 = 疑似无效操作（盲点）。
//
// 本轮接线（真机修复）：指纹计算迁至 D-5 服务端（Python PIL）—— Node 端零
// 原生图像依赖。captureBefore/settleAndVerify 的「截屏→本地 dhash」链改为
// 「服务端一次往返：干净帧 dhash + 区域 dhash + 帧环 id」。sharp 可用时保留
// 旧 buffer 路径供物理规则直接消费（DSH_FORCE_LEGACY_SYSTEM=1 或开发仓）。
import { system } from './system.js';
import * as backend from './physicalBackend.js';
import { dhash, regionDhash, hammingDistance, similarity, normalizeHash } from './perceptualHash.js';
import { oscillationTracker } from './oscillationTracker.js';
import { getEnabledPhysicsRules } from './intent.js';
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function sharpAvailable() {
    try {
        const { getSharp } = await import('./_legacyDeps.js');
        await getSharp();
        return true;
    }
    catch {
        return false;
    }
}
/** 动作前快照：服务端一次往返取全屏/区域指纹（+ 帧环 id 供物理规则消费） */
export async function captureBefore(focus, regionRadius = 0, keepBuffer = false) {
    const wantBuf = keepBuffer && await sharpAvailable();
    const r = await backend.captureProcessed({
        format: 'jpeg', quality: 60, maxWidth: 1440,
        wantHashes: true,
        wantRegionHash: focus && regionRadius > 0 ? { x: focus.x, y: focus.y, r: regionRadius } : undefined,
        keepFrame: keepBuffer,
        ...(wantBuf ? {} : { metaOnly: true }),
    });
    const screen = r.dhash ? normalizeHash(r.dhash) : '';
    const region = r.regionDhash ? normalizeHash(r.regionDhash) : null;
    return {
        screen, phash: r.phash ?? null, region,
        focus: focus ?? null,
        buffer: wantBuf && r.buffer ? r.buffer : undefined,
        frameId: r.frameId ?? null,
    };
}
/** 纯对比：给定前后指纹生成报告 */
export function reportEffect(before, after, noopThreshold) {
    const distance = hammingDistance(normalizeHash(before), normalizeHash(after));
    const sim = similarity(normalizeHash(before), normalizeHash(after));
    return {
        effect_detected: sim < noopThreshold,
        similarity_pct: Math.round(sim * 1000) / 10,
        distance,
    };
}
/** 轮询直到屏幕稳定：服务端指纹轮询（meta_only —— 不编码不传图） */
export async function waitForStableHash(pollMs, maxWaitMs) {
    const start = Date.now();
    let prev = await backend.captureProcessed({ metaOnly: true, wantHashes: true });
    let prevHash = prev.dhash ? normalizeHash(prev.dhash) : '';
    while (Date.now() - start < maxWaitMs) {
        await sleep(pollMs);
        const cur = await backend.captureProcessed({ metaOnly: true, wantHashes: true });
        const hash = cur.dhash ? normalizeHash(cur.dhash) : '';
        if (hash && hammingDistance(prevHash, hash) <= 1) {
            return { hash, frameId: cur.frameId ?? null };
        }
        prevHash = hash;
    }
    return { hash: prevHash, frameId: prev.frameId ?? null };
}
/** legacy 路径：buffer 轮询（sharp 可用且显式保留 buffer 时） */
export async function waitForStableFrame(pollMs, maxWaitMs) {
    const start = Date.now();
    let prevBuf = await system.captureScreen();
    let prevHash = await dhash(prevBuf);
    while (Date.now() - start < maxWaitMs) {
        await sleep(pollMs);
        const buf = await system.captureScreen();
        const hash = await dhash(buf);
        if (hammingDistance(prevHash, hash) <= 1)
            return { buffer: buf, hash };
        prevBuf = buf;
        prevHash = hash;
    }
    return { buffer: prevBuf, hash: prevHash };
}
/**
 * 动作后统一入口：自适应等待稳定帧，然后双尺度对比。
 * 决策矩阵：全屏变 = page-level；仅区域变 = element-level；都没变 = none（盲点）。
 * C-1：传入 expectation 时，物理规则引擎在双尺度之后追加意图裁决（L2 证据阶梯）。
 *   物理规则命中 ⇒ intent.satisfied 为裁决结论（可与 detected 分歧 —— 变了但不是预期的变化）；
 *   规则不适用/未启用 ⇒ intent 标注 not-applicable，行为回退纯双尺度（零回归）。
 */
export async function settleAndVerify(before, opts, expectation) {
    const useLegacyBuffers = !!(before.buffer && await sharpAvailable());
    let afterScreen = '';
    let afterRegion = null;
    let afterBuf = Buffer.alloc(0);
    let afterFrameId = null;
    let afterPhash = null;
    if (useLegacyBuffers) {
        if (opts.adaptive) {
            const stable = await waitForStableFrame(150, opts.settleMs * 4);
            afterBuf = stable.buffer;
            afterScreen = stable.hash;
        }
        else {
            await sleep(opts.settleMs);
            afterBuf = await system.captureScreen();
            afterScreen = await dhash(afterBuf);
        }
        if (before.region && before.focus && opts.regionRadius > 0) {
            afterRegion = await regionDhash(afterBuf, before.focus.x, before.focus.y, opts.regionRadius);
        }
    }
    else {
        // D-5 路径：服务端一次往返 = 稳定轮询(meta_only) + 终帧(指纹+区域+帧环)
        if (opts.adaptive) {
            const stable = await waitForStableHash(150, opts.settleMs * 4);
            afterScreen = stable.hash;
            afterFrameId = stable.frameId;
        }
        else {
            await sleep(opts.settleMs);
        }
        const finalCap = await backend.captureProcessed({
            format: 'jpeg', quality: 60, maxWidth: 1440,
            wantHashes: true,
            wantRegionHash: before.region && before.focus && opts.regionRadius > 0
                ? { x: before.focus.x, y: before.focus.y, r: opts.regionRadius } : undefined,
            keepFrame: !!expectation,
        });
        if (finalCap.dhash)
            afterScreen = normalizeHash(finalCap.dhash);
        afterPhash = finalCap.phash;
        afterRegion = finalCap.regionDhash ? normalizeHash(finalCap.regionDhash) : afterRegion;
        afterFrameId = finalCap.frameId ?? afterFrameId;
        afterBuf = finalCap.buffer ?? Buffer.alloc(0);
    }
    const screen = reportEffect(before.screen, afterScreen, opts.threshold);
    let region = null;
    if (before.region && afterRegion) {
        region = reportEffect(before.region, afterRegion, opts.threshold);
    }
    const detected = screen.effect_detected || (region?.effect_detected ?? false);
    const scale = screen.effect_detected
        ? 'page-level'
        : region?.effect_detected ? 'element-level' : 'none';
    // 振荡检测（第六轮）：稳定帧指纹顺手入环，零额外截图
    const oscillation = oscillationTracker.observe(afterScreen);
    // ── C-1 意图裁决（L2 物理证据）：带着预期找证据，而非盲目找不同 ──
    let intent;
    if (expectation && (before.buffer || before.frameId)) {
        const rules = getEnabledPhysicsRules(opts.physicsRules ?? '');
        const rule = rules.get(expectation.kind);
        if (rule) {
            let verdict;
            try {
                verdict = await rule.check({
                    beforeBuf: before.buffer ?? Buffer.alloc(0),
                    afterBuf,
                    beforeFrameId: before.frameId ?? null,
                    afterFrameId,
                    focus: before.focus,
                    regionRadius: opts.regionRadius,
                });
            }
            catch (e) {
                verdict = { satisfied: false, evidence: `physics rule error: ${e.message}`, notApplicable: true };
            }
            intent = {
                expected: expectation.kind,
                satisfied: verdict.satisfied,
                evidence: verdict.notApplicable
                    ? `rule not applicable (${verdict.evidence}); fell back to dual-scale verdict`
                    : verdict.evidence,
            };
        }
        else {
            // 语义/委托类期望或规则被 config 裁剪：不裁决，交给 L0/L1/L3 既有通道
            intent = {
                expected: expectation.kind,
                satisfied: detected,
                evidence: 'no physics rule for this kind; verdict delegated to dual-scale detection',
            };
        }
    }
    // ── Q 纪元（Q-2）：pHash 频谱佐证（旁路义务 —— 失败不毒化判决，诚实缺席）──
    // 语义：前后 pHash 相似度 < 0.9 = 频谱域看到变化；与 dHash 的 detected 同判 ⇒ true
    let phashCorroborates;
    if (afterPhash) {
        try {
            const { similarity } = await import('./perceptualHash.js');
            const pSim = similarity(normalizeHash(before.phash ?? ''), normalizeHash(afterPhash));
            phashCorroborates = (pSim < 0.9) === detected;
        }
        catch {
            phashCorroborates = undefined;
        }
    }
    else if (useLegacyBuffers && before.buffer) {
        try {
            const { dualSimilarity } = await import('./perceptualHash.js');
            const dual = await dualSimilarity(before.buffer, afterBuf);
            phashCorroborates = (dual.phash < 0.9) === detected;
        }
        catch {
            phashCorroborates = undefined;
        }
    }
    return {
        detected, screen, region, scale,
        afterBuffer: afterBuf, afterHash: afterScreen, oscillation,
        intent, phashCorroborates, afterFrameId,
    };
}
/** 兼容旧签名：立即取全屏对比（不等待） */
export async function verifyEffect(before, noopThreshold) {
    const cap = await backend.captureProcessed({ metaOnly: true, wantHashes: true });
    return reportEffect(before, cap.dhash ? normalizeHash(cap.dhash) : '', noopThreshold);
}
