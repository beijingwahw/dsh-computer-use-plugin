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
import { dhash, regionDhash, normalizeHash } from './perceptualHash.js';
import { oscillationTracker } from './oscillationTracker.js';
import { kernelRegistry } from './kernel/registry.js';
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
export { reportEffect } from './actionVerifier.effect.js';
import { reportEffect } from './actionVerifier.effect.js';
/** 动作前快照：服务端一次往返取全屏/区域指纹（+ 帧环 id 供物理规则消费） */
export async function captureBefore(focus, regionRadius = 0, keepBuffer = false) {
    const wantBuf = keepBuffer && await sharpAvailable();
    const r = await backend.captureProcessed({
        format: 'jpeg', quality: 60, maxWidth: 1440,
        wantHashes: true,
        wantRegionHash: focus && regionRadius > 0 ? { x: focus.x, y: focus.y, r: regionRadius } : undefined,
        keepFrame: keepBuffer, // 物理规则需要前后帧 —— 前帧入环
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
// W6-2（doctor smell.over-engineering 清偿）：CombinedEffect 与稳定帧轮询已分区提取至
// actionVerifier.stable.ts；EffectReport/reportEffect → actionVerifier.effect.ts（行为零变化）。
export { waitForStableHash, waitForStableFrame } from './actionVerifier.stable.js';
import { waitForStableHash, waitForStableFrame } from './actionVerifier.stable.js';
/** W5-3：互证谓词阈值（立法常量 —— 交叠覆盖率下限；改此值 = 修法，须过 w5cross 断言） */
export const REMOTE_EVIDENCE_OVERLAP_MIN = 0.25;
/** W5-3：单动作取证 peer 数上界（旁路义务不透支主路预算） */
export const REMOTE_PEERS_MAX = 4;
// W6-2（doctor smell.over-engineering 清偿）：W5-3 判决函数与 W4-8 类型/净化面已
// 分区提取至 actionVerifier.channels.ts（行为零变化；立法常量按「立法在源」测试
// 锁定留守本文件）；导入面不变 —— 再分发。
import { judgeRemoteChange, sanitizeAudioEvent, sanitizeRemoteRegion, sanitizeRemoteChange } from './actionVerifier.channels.js';
export { judgeRemoteChange } from './actionVerifier.channels.js';
// ─── W4-8 L4 声学证据通道（有节制的破戒）：非语义物理证据，恒低于视觉 ───
//
// 破戒范围（创新提案 L4）：系统音频只作**非语义**物理证据 —— 五类声学纹理
// 事件（通知叮声/错误提示/成功提示/按键音/静默），由物理层
// python_service/dsh_physical/audio.py（WASAPI 回环 + 阈值级联分类）产出。
// 绝不做语音识别/说话人识别/内容转录：声学**纹理**是证据，声学**内容**不是。
//
// 法条一（视觉优先律，立法为常量 AUDIO_VISUAL_PRIORITY）：
//   音频证据的证明力恒低于视觉。视觉通道给出确定性判决时（detected=true
//   的阳性，或 detected=false 且无指纹退化的阴性），音频**一律不改判** ——
//   最多作为 audioEvent 附注被记录；视觉阳性在场时连门控判决（audioGated）
//   都不产出。音频可以补强视觉的阴性，绝无权推翻视觉的阳性。
// 法条二（置信封顶，立法为常量 AUDIO_EVIDENCE_CONFIDENCE_CAP）：
//   音频单通道升级的效果判决，置信度硬上限 0.5 —— 恒低于任何视觉确定性
//   证据（1.0）。封顶是立法不是调参：改此值 = 修法，须过 w4audio 封顶断言。
//
// 门控语义（仅视觉阴性时计算 audioGated）：
//   · success_chime ⇒ no_effect 升级 probable_effect（置信 ≤ 法条二封顶）；
//   · error_beep   ⇒ 触发复核（recheck）—— 判决不动，要求再看一眼；
//   · notification_ding / key_click / silence ⇒ 只记录，不参与判决。
//   视觉「未验证」（unverifiable，指纹退化）不是视觉阴性 —— 音频不得在
//   视觉缺席处制造确定性（Δ-7 同律：证据不可用 ≠ 无变化）。
/** 法条一（W4-8 视觉优先律）：音频证据恒低权于视觉 —— 立法文本见上方注释块 */
export const AUDIO_VISUAL_PRIORITY = true;
/** 法条二（W4-8 置信封顶）：音频单通道效果判决的置信硬上限（0.5 < 视觉 1.0） */
export const AUDIO_EVIDENCE_CONFIDENCE_CAP = 0.5;
// W6-2：音频事件类型与净化面已随 channels 分区提取（AudioEventKind/AudioEvent/
// AudioGatedVerdict/sanitizeAudioEvent → actionVerifier.channels.ts，经上方再导出回流）。
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
    // 纪元 Ξ（Ξ-D 生产接线）：轮询节奏读内核注册表 —— verify.pollMs（缺省 150）
    // 与 verify.settleFactor（缺省 4，maxWaitMs = settleMs × 此值）。min 护栏
    // Math.max(1,…)：0 轮询间隔会退化成忙等、0 倍率会把等待窗直接清零 ——
    // 区间之外的病值就地夹正，未注册 ⇒ 回声字面量，逐字节不变。
    const pollMs = Math.max(1, kernelRegistry.getOrDefault('verify.pollMs', 150));
    const settleFactor = Math.max(1, kernelRegistry.getOrDefault('verify.settleFactor', 4));
    if (useLegacyBuffers) {
        if (opts.adaptive) {
            const stable = await waitForStableFrame(pollMs, opts.settleMs * settleFactor);
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
            const stable = await waitForStableHash(pollMs, opts.settleMs * settleFactor);
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
    // Δ-7 派生保守律：EffectReport 的 null（指纹退化）**不得**上浮为
    // CombinedEffect.detected —— quantumSense.recordEffect 的调用方契约
    // （src/quantumSense.ts:119-127）由类型系统（纯 boolean）与测试
    // （undefined 直通锁）双重锁死，null 不是合法载体。故 unknown ⇒ 保守 false
    //（绝不当变化采信：不写地标、不焚毁审批令牌、不虚报成功），并携带
    // unverifiable 注记让消费方可区分「未验证」与「判定无变化」。
    const detected = screen.effect_detected === true || region?.effect_detected === true;
    const scale = screen.effect_detected === true
        ? 'page-level'
        : region?.effect_detected === true ? 'element-level' : 'none';
    // 注记只在「保守 false」时在场：detected=true 时退化通道已被另一通道的
    // 硬证据顶替（无歧义）；detected=false 且有通道为 null 时，false 是降级
    // 保守值而非测量结论 —— 不注记就会与真「无变化」混淆
    const unverifiableParts = [];
    if (!detected) {
        if (screen.effect_detected === null)
            unverifiableParts.push(`screen:${screen.unverifiable}`);
        if (region?.effect_detected === null)
            unverifiableParts.push(`region:${region.unverifiable}`);
    }
    const unverifiable = unverifiableParts.length > 0 ? unverifiableParts.join(';') : undefined;
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
    // 纪元 Ξ（Ξ-D 生产接线）：佐证门读内核注册表 —— verify.phashGate（缺省 0.9，
    // 双读点同键同步）。未注册 ⇒ getOrDefault 回声字面量，逐字节不变。
    const phashGate = kernelRegistry.getOrDefault('verify.phashGate', 0.9);
    let phashCorroborates;
    if (afterPhash && before.phash) {
        try {
            const { similarity } = await import('./perceptualHash.js');
            const pb = normalizeHash(before.phash);
            const pa = normalizeHash(afterPhash);
            // Δ-7 同律：任一侧 pHash 全零（平坦帧 —— 63 个 AC 系数无离散度，中位阈值
            // 产出零信息指纹）时比对是边界假信号 —— 佐证诚实缺席，绝不当同判采信
            if (!/^0+$/.test(pb) && !/^0+$/.test(pa)) {
                phashCorroborates = (similarity(pb, pa) < phashGate) === detected;
            }
        }
        catch {
            phashCorroborates = undefined;
        }
    }
    else if (useLegacyBuffers && before.buffer) {
        try {
            const { dualSimilarity } = await import('./perceptualHash.js');
            const dual = await dualSimilarity(before.buffer, afterBuf);
            phashCorroborates = (dual.phash < phashGate) === detected;
        }
        catch {
            phashCorroborates = undefined;
        }
    }
    // ── W4-8 L4 声学证据（门控旁路）：防御式绝不抛 —— 端口故障 = 证据缺席 ──
    // 端口缺席（opts.audioEvidence 未注入）⇒ 本块整体短路，返回体逐字节不变。
    let audio = null;
    if (opts.audioEvidence) {
        try {
            audio = sanitizeAudioEvent(opts.audioEvidence());
        }
        catch {
            audio = null;
        } // 防御式：证据通道的故障绝不毒化判决主链
    }
    let audioGated;
    if (audio && AUDIO_VISUAL_PRIORITY) {
        // 门控前提（法条一）：视觉阴性 = detected=false 且无退化注记。
        //   视觉阳性 ⇒ 音频静默（连门控判决都不产出 —— audioEvent 仍附注）；
        //   视觉未验证（unverifiable）⇒ 不升级（Δ-7 同律：证据不可用 ≠ 无变化）。
        const visualNegative = detected === false && !unverifiable;
        if (visualNegative) {
            if (audio.event === 'success_chime') {
                audioGated = {
                    verdict: 'probable_effect',
                    event: audio.event,
                    // 法条二（置信封顶）：音频单通道升级的置信硬上限 —— 立法不是调参
                    confidence: Math.min(audio.confidence, AUDIO_EVIDENCE_CONFIDENCE_CAP),
                };
            }
            else if (audio.event === 'error_beep') {
                audioGated = {
                    verdict: 'recheck',
                    event: audio.event,
                    confidence: Math.min(audio.confidence, AUDIO_EVIDENCE_CONFIDENCE_CAP),
                };
            }
            // 其余事件（notification_ding / key_click / silence）：只记录不判决
        }
    }
    // ── W5-3（L3 跨机互证）：远程世界变化谓词（旁路义务 —— 失败不毒化判决）──
    // 门控（法条）：视觉阳性（detected=true 且无退化注记）+ 端口在场 + peers
    // 非空，三者齐备才取证 —— 与 W4-8 声学通道的「视觉阴性门控」对称立法。
    // 端口缺席/门控不中 ⇒ 本块整体短路，返回体逐字节不变（兼容铁律）。
    let remote;
    if (typeof opts.remoteEvidence === 'function' && Array.isArray(opts.remotePeers) &&
        opts.remotePeers.length > 0 && detected === true && !unverifiable) {
        const hint = sanitizeRemoteRegion(opts.remoteRegionHint) ?? null; // 非法 hint = 未声明 ⇒ 严格 no-hint
        const perPeer = [];
        for (const rawPeer of opts.remotePeers.slice(0, REMOTE_PEERS_MAX)) {
            if (typeof rawPeer !== 'string' || rawPeer === '') {
                perPeer.push({ peer: '', verdict: 'unverified', overlap: 0, reason: 'bad-peer' });
                continue;
            }
            let change = null;
            let portError = false;
            try {
                change = await opts.remoteEvidence(rawPeer, hint);
            }
            catch {
                portError = true; // 防御式：证据通道的故障绝不毒化判决主链
            }
            if (portError) {
                perPeer.push({ peer: rawPeer, verdict: 'unverified', overlap: 0, reason: 'port-error' });
                continue;
            }
            const j = judgeRemoteChange(hint, sanitizeRemoteChange(change));
            perPeer.push({ peer: rawPeer, ...j });
        }
        remote = {
            hint,
            perPeer,
            corroborated: perPeer.filter(p => p.verdict === 'corroborated').length,
            unverified: perPeer.filter(p => p.verdict !== 'corroborated').length,
        };
    }
    return {
        detected, screen, region, scale,
        afterBuffer: afterBuf, afterHash: afterScreen, oscillation,
        intent, phashCorroborates, unverifiable, afterFrameId,
        // W4-8：端口缺席 ⇒ 两键均不落（逐字节不变）；在场 ⇒ audioEvent 恒附
        //（null = 已查询无事件/事件形状非法），audioGated 仅门控命中时在场。
        ...(opts.audioEvidence ? { audioEvent: audio, ...(audioGated ? { audioGated } : {}) } : {}),
        // W5-3：门控不中 ⇒ remote 键整体缺席（逐字节不变）；门控命中 ⇒ 旁路互证
        // 报告（只读证据 —— 不改写任何视觉判决字段）。
        ...(remote ? { remote } : {}),
    };
}
/** 兼容旧签名：立即取全屏对比（不等待） */
export async function verifyEffect(before, noopThreshold) {
    const cap = await backend.captureProcessed({ metaOnly: true, wantHashes: true });
    return reportEffect(before, cap.dhash ? normalizeHash(cap.dhash) : '', noopThreshold);
}
