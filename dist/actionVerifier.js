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
/** 纯对比：给定前后指纹生成报告。
 *  Δ-7 指纹退化三态（诚实降级，防边界假信号）：
 *    ① absent —— 任一侧指纹为空（服务端未返回 dhash 时 captureBefore 以 '' 占位）
 *    ② zero   —— 归一化后全零（hexToBits 对损坏 hex 的回退值；与真·无梯度平面帧
 *      的 dHash 不可区分 —— 全零指纹信息量为零，任意两张平面帧都判 sim=1）
 *    ③ length —— 归一化后长度不等（异构指纹不可比；hammingDistance 取 max(len)
 *      把 sim 压到 0，旧实现据此虚报 effect_detected=true 假阳性）
 *  任一态 ⇒ effect_detected=null（无法判定）+ unverifiable 原因；distance/
 *  similarity_pct 照报原始测量值（证据保留），但其判决资格已被 null 否决。 */
export function reportEffect(before, after, noopThreshold) {
    const nb = normalizeHash(before);
    const na = normalizeHash(after);
    // 归一化域判退化：'' 经 hexToBits 回退为全零（BigInt('0x') 抛错 → '0'.repeat(64)），
    // 故 absent 检查必须在归一化**前**的原始串上做；zero/length 检查在归一化后做
    const unverifiable = before === '' || after === '' ? 'absent'
        : (/^0+$/.test(nb) || /^0+$/.test(na)) ? 'zero'
            : nb.length !== na.length ? 'length'
                : undefined;
    const distance = hammingDistance(nb, na);
    const sim = similarity(nb, na);
    if (unverifiable) {
        return {
            effect_detected: null,
            similarity_pct: Math.round(sim * 1000) / 10,
            distance,
            unverifiable,
        };
    }
    return {
        effect_detected: sim < noopThreshold,
        similarity_pct: Math.round(sim * 1000) / 10,
        distance,
    };
}
/** W5-3：互证谓词阈值（立法常量 —— 交叠覆盖率下限；改此值 = 修法，须过 w5cross 断言） */
export const REMOTE_EVIDENCE_OVERLAP_MIN = 0.25;
/** W5-3：单动作取证 peer 数上界（旁路义务不透支主路预算） */
export const REMOTE_PEERS_MAX = 4;
/** W5-3 防御式净化：归一化矩形形状/值域不合法或退化（x1≤x0 等）⇒ null */
function sanitizeRemoteRegion(r) {
    try {
        if (!r || typeof r !== 'object')
            return null;
        const o = r;
        if (![o.x0, o.y0, o.x1, o.y1].every(v => typeof v === 'number' && Number.isFinite(v)))
            return null;
        const c = (v) => Math.max(0, Math.min(1, v));
        const x0 = c(o.x0), y0 = c(o.y0), x1 = c(o.x1), y1 = c(o.y1);
        if (!(x1 > x0 && y1 > y0))
            return null; // 退化框：零面积 ⇒ 无判决资格
        return { x0, y0, x1, y1 };
    }
    catch {
        return null;
    }
}
/** W5-3 防御式净化：RemoteChange 载荷形状不合法 ⇒ null（证据缺席）；regions 内坏框静默剔除 */
function sanitizeRemoteChange(c) {
    try {
        if (!c || typeof c !== 'object' || Array.isArray(c))
            return null;
        const o = c;
        const regions = Array.isArray(o.regions)
            ? o.regions.map(sanitizeRemoteRegion).filter((r) => r !== null)
            : [];
        return {
            screen: typeof o.screen === 'string' ? o.screen : '',
            region: typeof o.region === 'string' ? o.region : null,
            regions,
        };
    }
    catch {
        return null;
    }
}
/**
 * W5-3：跨机互证谓词（纯函数、确定性、绝不抛）——「A 的动作效果必须出现在
 * B 屏」的判决核心：
 *   · 证据缺席（change=null）⇒ unverified 'absent'（peer 离线/超时/载荷坏）；
 *   · 无期望区域（hint=null/非法）⇒ unverified 'no-hint'（严格：说不出该出现
 *     在哪，就无权互证）；
 *   · 无有效变化区域 ⇒ unverified 'no-change-regions'（B 屏没变 —— 诚实
 *     缺席而非反驳：region 证据链断在哪环都不臆造）；
 *   · 判据：max over regions of（区域∩期望）/（期望面积）≥ REMOTE_EVIDENCE_
 *     OVERLAP_MIN ⇒ corroborated；否则 unverified 'overlap-below-min'
 *     （overlap 照报最优值 —— 证据保留）。
 */
export function judgeRemoteChange(hint, change) {
    const un = (reason) => ({ verdict: 'unverified', overlap: 0, reason });
    try {
        if (change === null)
            return un('absent');
        const h = sanitizeRemoteRegion(hint);
        if (h === null)
            return un('no-hint');
        if (change.regions.length === 0)
            return un('no-change-regions');
        const hArea = (h.x1 - h.x0) * (h.y1 - h.y0);
        if (!(hArea > 0))
            return un('no-hint');
        let best = 0;
        for (const r of change.regions) {
            const iw = Math.min(h.x1, r.x1) - Math.max(h.x0, r.x0);
            const ih = Math.min(h.y1, r.y1) - Math.max(h.y0, r.y0);
            if (iw > 0 && ih > 0)
                best = Math.max(best, (iw * ih) / hArea);
        }
        const overlap = Math.round(best * 10000) / 10000;
        return overlap >= REMOTE_EVIDENCE_OVERLAP_MIN
            ? { verdict: 'corroborated', overlap }
            : { verdict: 'unverified', overlap, reason: 'overlap-below-min' };
    }
    catch {
        return un('absent');
    }
}
/** 法条一（W4-8 视觉优先律）：音频证据恒低权于视觉 —— 立法文本见上方注释块 */
export const AUDIO_VISUAL_PRIORITY = true;
/** 法条二（W4-8 置信封顶）：音频单通道效果判决的置信硬上限（0.5 < 视觉 1.0） */
export const AUDIO_EVIDENCE_CONFIDENCE_CAP = 0.5;
/** W4-8 防御式净化：注入方给的 AudioEvent 形状/值域不合法 ⇒ 视为缺席（null）。
 *  证据通道的垃圾输入绝不进入判决链（防御式绝不抛的外延）。 */
function sanitizeAudioEvent(ev) {
    if (!ev || typeof ev !== 'object')
        return null;
    const e = ev;
    const kinds = ['notification_ding', 'error_beep', 'success_chime', 'key_click', 'silence'];
    if (typeof e.event !== 'string' || !kinds.includes(e.event))
        return null;
    const confidence = typeof e.confidence === 'number' && Number.isFinite(e.confidence)
        ? Math.max(0, Math.min(1, e.confidence))
        : 0;
    const ts = typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : Date.now();
    return { event: e.event, confidence, ts };
}
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
