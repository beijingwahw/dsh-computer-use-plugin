// src/actionVerifier.ts
// 行为效果验证引擎。三轮演进：
//   R1 盲点检测（全屏 dHash 前后对比）
//   R2 自适应稳定等待（轮询至屏幕稳定，动画期不误判）
//   R3 双尺度验证（全屏 + 区域指纹）+ 焦点区域放大局部变化
// 判定矩阵：全屏变化 = 页面级效果；仅区域变化 = 元素级效果（光标出现/文字输入）；
// 两者皆未变 = 疑似无效操作（盲点）。
import { system } from './system.js';
import { dhash, regionDhash, hammingDistance, similarity } from './perceptualHash.js';
import { oscillationTracker } from './oscillationTracker.js';
import { getEnabledPhysicsRules } from './intent.js';
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
/** 动作前快照：一次性取全屏 buffer，分别算全屏/区域指纹 */
export async function captureBefore(focus, regionRadius = 0, keepBuffer = false) {
    const buf = await system.captureScreen();
    const screen = await dhash(buf);
    const region = focus && regionRadius > 0
        ? await regionDhash(buf, focus.x, focus.y, regionRadius)
        : null;
    return { screen, region, focus: focus ?? null, buffer: keepBuffer ? buf : undefined };
}
/** 纯对比：给定前后指纹生成报告 */
export function reportEffect(before, after, noopThreshold) {
    const distance = hammingDistance(before, after);
    const sim = similarity(before, after);
    return {
        effect_detected: sim < noopThreshold,
        similarity_pct: Math.round(sim * 1000) / 10,
        distance,
    };
}
/** 轮询直到屏幕稳定：返回稳定帧的 buffer + 全屏指纹（同一帧供区域指纹复用） */
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
    let afterBuf;
    let afterScreen;
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
    const screen = reportEffect(before.screen, afterScreen, opts.threshold);
    let region = null;
    if (before.region && before.focus && opts.regionRadius > 0) {
        const afterRegion = await regionDhash(afterBuf, before.focus.x, before.focus.y, opts.regionRadius);
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
    if (expectation && before.buffer) {
        const rules = getEnabledPhysicsRules(opts.physicsRules ?? '');
        const rule = rules.get(expectation.kind);
        if (rule) {
            let verdict;
            try {
                verdict = await rule.check({
                    beforeBuf: before.buffer,
                    afterBuf,
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
    return { detected, screen, region, scale, afterBuffer: afterBuf, afterHash: afterScreen, oscillation, intent };
}
/** 兼容旧签名：立即取全屏对比（不等待） */
export async function verifyEffect(before, noopThreshold) {
    const buf = await system.captureScreen();
    return reportEffect(before, await dhash(buf), noopThreshold);
}
