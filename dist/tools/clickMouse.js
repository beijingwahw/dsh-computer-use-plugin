// src/tools/clickMouse.ts
// W6-2 结构性保留（doctor smell.over-engineering 登记）：click_mouse 工具面 —— 审批域/公证取证/接地新鲜度/验收消费在同一点击链路上线性串联（W 系列安全层逐环叠加），拆分即拆安全链。
// 世界级升级：三坐标换算锚点 + dHash 效果验证（盲点检测）+ 置信度自报 +
// 验证生效自动写入 UI 记忆。模型第一次能「感知自己是否点中了」。
// ΝΩ-32 帧票据：安全链阶段序一字不动 —— 只把派发前各阶段的独立截屏收敛为
// 一张共享帧（票据复用；after 帧绝不复用），见「帧票据」立法块。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { system } from '../system.js';
import { captureBefore, settleAndVerify } from '../actionVerifier.js';
import { focusTracker } from '../focusTracker.js';
import { semanticConfirm, readTextAny } from '../textReader.js';
import { matchesRiskPatterns, reversibilityRegistry, dispatchLaneFor } from '../riskGate.js';
import { approval } from '../approval.js';
import { uiMemory } from '../uiMemory.js';
import { regionDhash, similarity, normalizeHash } from '../perceptualHash.js';
import { parseExpectation, menuItemSemantics } from '../intent.js';
import { quantum } from '../quantumSense.js';
import { probePoints, gateTextClick } from '../interactivityProbe.js';
import { extractUrls } from '../urlSense.js';
import { toolErr } from '../toolResult.js';
import { journal } from '../journal.js';
import * as physicalBackend from '../physicalBackend.js';
import { encodeForVlm } from '../vlm/codec.js';
import { askRefutation, refuteCourtInSession } from '../vlm/refute.js';
import { probeGroundingFreshness } from '../popupDetector.js';
import { assertActionAllowed, notaryEvidenceStale } from './actionGate.js';
import { reversalEscrow } from '../reversalEscrow.js';
/** W2-2：派发前消费批注 patch（clickMouse/clickElement/dragMouse 共用原语）。 */
export function consumeApprovalAmendment(token, plan) {
    if (!token)
        return {};
    try {
        const patched = approval.applyAmendment(token, plan);
        const corrected = {};
        const ignored = [];
        let px;
        let py;
        let pd;
        if (typeof patched.x === 'number' && Number.isFinite(patched.x)) {
            if (patched.x < 0 || patched.x > 1)
                ignored.push(`x=${patched.x}`);
            else if (patched.x !== plan.x) {
                px = patched.x;
                corrected.x = patched.x;
            }
        }
        if (typeof patched.y === 'number' && Number.isFinite(patched.y)) {
            if (patched.y < 0 || patched.y > 1)
                ignored.push(`y=${patched.y}`);
            else if (patched.y !== plan.y) {
                py = patched.y;
                corrected.y = patched.y;
            }
        }
        if (typeof patched.target_description === 'string' && patched.target_description
            && patched.target_description !== plan.target_description) {
            pd = patched.target_description;
            corrected.target_description = pd;
        }
        if (px === undefined && py === undefined && pd === undefined)
            return {};
        const am = approval.amendmentOf(token);
        return {
            x: px, y: py, target_description: pd,
            stamp: {
                applied: true,
                note: am?.note ?? '',
                corrected,
                ...(ignored.length > 0 ? { ignored_out_of_range: ignored } : {}),
            },
        };
    }
    catch {
        return {}; // 旁路宪法：批注读取失败 = 无批注（不炸派发主流程）
    }
}
// ─── R2-4：菜单两段式协议话术（纯函数 —— 测试的确定性事实源）───
//
// 实战病灶（R1-8 冒烟 9 连败的确定性根因层）：
//   ① menu_expand 背叛（菜单没开）时通用 INTENT MISMATCH 文案被无视，模型径直
//      点菜单项坐标三连（attempt9 seq53/68/153 全部 below-click zone static）；
//   ② 菜单项点击被交互性闸门以 I-beam 拦下时，通用 STATIC CONTENT 文案没有
//      告诉模型「下拉没开，回第一阶段」（attempt9 seq59 ACTION_REQUIRED 后仍
//      原地重试）。
// 两段式协议：先点菜单栏条目（expected_effect menu_expand，satisfied=true 才算
// 开）→ 再按展开后截图读坐标点菜单项。菜单未开 = 第二阶段结构性不可行，话术
// 明令禁止并给出回退路径。纯字符串铸造，零物理调用。
/** R2-4：menu_expand 背叛（含未检出变化）的下一步指引 */
export function menuExpandBetrayedHint(evidence) {
    return `MENU DID NOT OPEN — the zone below your click is unchanged (${evidence}). ` +
        "Your click missed the menu bar entry (these are small targets: full-screen estimates are systematically " +
        "off; also re-check the window state — restore/maximize moves the menu bar). Do NOT click any menu item " +
        "next: menu items only exist while the dropdown is expanded. Call 'zoom_inspect' around the menu bar to " +
        "read precise coordinates, then retry this click still declaring expected_effect '{\"kind\":\"menu_expand\"}' " +
        'and proceed to the item only when intent.satisfied=true.';
}
/** R2-4：菜单项点击被交互性闸门拦下（I-beam/text）时的下一步指引 */
export function menuNotOpenGateHint() {
    return 'MENU NOT OPEN: this point currently reads as document text (I-beam cursor) — the dropdown ' +
        'menu you are targeting is NOT expanded, so the menu item does not exist on screen right now. ' +
        'Do NOT retry these item coordinates. Go back to stage 1 of the two-stage menu protocol: ' +
        "re-open the menu by clicking its bar entry (declare expected_effect '{\"kind\":\"menu_expand\"}' " +
        'and proceed only when the result reports intent.satisfied=true), then take a fresh screenshot ' +
        'of the expanded dropdown and read the item coordinates from THAT screenshot before clicking.';
}
// ─── ΠΑΝ-12（令牌-目标绑定的执行侧预留接线）───
//
// 批判报告 C1-5 H1：审批令牌是不记名能力 —— approval.ledger 的 consume 旧签名
// 只收 token，不比对被授权目标（「发送邮件给 Alice」的令牌在 TTL 内可授权
// 任何命中危险词的点击）。修复分两波：ledger 侧为 validate/beginAttempt/consume
// 增加可选 targetHint（ΠΑΝ-5 macaroon 式目标绑定 —— TargetHint = RawActionShape，
// 坐标千分位量化 = 抖动容忍带）；本波在全部消费点**统一接线** —— 一律经本原语
// 消费，携带 {tool, x, y, target_description} 的完整提示形状。
// 兼容律（ΠΑΝ-5 立法）：未携带绑定的令牌对 hint 免疫（既有行为零变化）；
// 携带绑定的令牌按摘要强制比对（不匹配 ⇒ 拒绝且不焚毁）。
// ΠΑΝ-36（F1-4 移交收尾）：提示形状自描述级升级为**坐标级** —— clickMouse 的
// 两个消费点补齐 x/y（与铸造面 computeTargetDigest 的规范化管道同域）；
// beginAttempt 的派发预留同样携带 escrow planId（ΠΑΝ-34 dispatchGate 命脉的
// 工具侧接线）与坐标级 target。dragMouse/pressHotkey 的消费点维持描述级
//（各自文件领地，形状兼容零破坏 —— hint 可选字段）。
/**
 * ΠΑΝ-12/36：验收式消费的统一落点（clickMouse/dragMouse/pressHotkey 共用）。
 * hint = 本次派发实际作用的目标（token-目标绑定的执行侧证据；clickMouse 携
 * 坐标级完整形状，drag/pressHotkey 携描述级最小形状 —— 兼容面）。
 */
export function consumeApprovalWithHint(token, hint) {
    return approval.consume(token, hint);
}
// ─── 纪元 Ρ（双钥公证锁）：公证取证面 ───
//
// 审计背景：危险判定此前只信模型自述 —— 被提示注入的模型谎报目标即可绕过
// dangerPatterns 词表。本取证面在物理派发前对点击落点独立取证：
//   · OCR 实读（ocrLabel）：点击坐标邻域的一次轻量区域读屏（textReader 现成
//     路径：服务端 L2 优先，enableOcr 开启时 legacy tesseract 兜底）；
//   · 白盒控件名（structuralName）：UIA 点查询（physicalBackend.hitTest，
//     与 Z-1 探针同一判决源）—— 仅当 D-5 服务已在场时取（零孵化零新增调用）。
// 取证纪律（诚实降级律）：
//   · 通道不可用 ⇒ null —— 锁只在「通道在场且见危险/不符」时收紧，绝不因
//     公证取证失败而阻塞正常点击；
//   · 通道可用性的判定纯配置/纯在场（零物理调用）：OCR 通道随 enableOcr
//     （OCR 是部署显式开启的感知能力，公证不反向扩大能力面）；白盒通道随
//     enableInteractivityProbe（UIA 点查询属探针子系统，总闸关即视为白盒
//     通道不可用）且要求服务已存活（healthSnapshot 在场 —— 绝不为取证孵化）。
// 本对象是可注入缝（模块级可变属性）：测试注入假 OCR provider 断言闸门执法，
// 生产路径不经任何替换。
export const notaryEvidence = {
    /** 通道可用性（纯配置/在场判定 —— 零物理调用、零孵化、零网络） */
    channelsAvailable(config) {
        return {
            ocr: notaryOcrAvailable(config),
            structural: notaryStructuralAvailable(config),
        };
    },
    /** OCR 实读：点击点邻域区域读屏（失败/缺席 ⇒ null 诚实降级，绝不抛） */
    async readOcrLabel(config, nx, ny) {
        if (!notaryOcrAvailable(config))
            return null;
        // ΝΩ-32 诚实边界：readTextAny（服务端 L2 OCR 优先）不接受外部帧 —— 服务端
        // 自截 region（getUiTree 无「带 buffer 的 region API」），故公证阶段保持
        // 自截、不接入帧票据；待服务端补该 API 后此处可改吃票据（届时同步更新
        // ΝΩ-32 测试组的捕获计数断言）。
        try {
            // 邻域窗口：与效果验证的区域半径同源（regionVerifyRadius，缺省 0.15），
            // 夹取 [0.05, 0.25] —— 太小漏标签上下文，太大把整屏正文都读进来
            const r = Math.min(0.25, Math.max(0.05, config.regionVerifyRadius > 0 ? config.regionVerifyRadius : 0.15));
            const left = Math.max(0, nx - r);
            const top = Math.max(0, ny - r);
            const width = Math.min(1 - left, r * 2);
            const height = Math.min(1 - top, r * 2);
            if (width < 0.005 || height < 0.005)
                return null;
            const result = await readTextAny({ x: left, y: top, width, height }, config.ocrLang);
            const text = (result.text ?? '').replace(/\s+/g, ' ').trim();
            // 截断到公证预算：区域可能读回整段正文，词表扫描不需要长文
            return text ? text.slice(0, 200) : null;
        }
        catch {
            return null; // 双路径皆败：通道缺席，不阻塞正常点击
        }
    },
    /** 白盒控件名：UIA 点查询（服务在场才取 —— 零孵化；失败 ⇒ null） */
    async readStructuralName(config, nx, ny) {
        if (!notaryStructuralAvailable(config))
            return null;
        try {
            const hit = await physicalBackend.hitTest(nx, ny);
            if (!hit?.available)
                return null;
            const name = (hit.name ?? '').trim();
            return name ? name.slice(0, 120) : null;
        }
        catch {
            return null; // 端点缺席/COM 失败：通道缺席，不阻塞正常点击
        }
    },
};
function notaryOcrAvailable(config) {
    // OCR 是部署显式开启的感知能力（enableOcr 同时装载 read_text/find_text 与
    // 语义核对）；公证锁不反向扩大感知面 —— enableOcr=false 即视为 OCR 公证
    // 通道不可用（诚实 null），不为取证新增任何网络/孵化调用
    return config.enableOcr === true && !config.dryRun;
}
function notaryStructuralAvailable(config) {
    // UIA 点查询属交互性探针子系统（Z-1 通道 1）：探针总闸关闭即白盒通道不可用；
    // 且仅当 D-5 服务已在场（healthSnapshot 非空）才取 —— 取证绝不触发服务孵化
    return config.enableInteractivityProbe === true
        && !config.dryRun
        && physicalBackend.healthSnapshot() !== null;
}
/** Ρ 纪元：公证锚点（输出透明化用 —— verdict + 各通道在场情况/降级注记；
 *  clickElement 共用，导出为工具层公证方言的单一定义点） */
export function notaryAnchorOf(verdict, evidence, note) {
    if (verdict === undefined)
        return undefined; // 总开关关：锚点不入场（完全旧路径）
    return {
        verdict,
        ocr_label: evidence?.ocrLabel ? evidence.ocrLabel.slice(0, 80) : '(absent)',
        structural_name: evidence?.structuralName ?? '(absent)',
        note: note || undefined,
    };
}
/** W5-0（C）：分道闸（异步原语 —— escrow 道需 await mintPlan）。绝不抛。 */
export async function gateByReversibility(config, intent) {
    try {
        if (config?.enableReversibilityLanes !== true)
            return { applied: false, reason: 'disabled' };
        const verdict = reversibilityRegistry.classify({
            tool: intent.tool,
            description: intent.description,
        });
        if (verdict.semantics === 'unknown') {
            return { applied: false, reason: 'unknown-semantics' };
        }
        const lane = dispatchLaneFor(verdict.level);
        if (lane.humanExecution) {
            return {
                applied: true, verdict, lane, blocked: JSON.stringify({
                    status: 'ACTION_REQUIRED',
                    state_anchor: {
                        reason: 'reversibility-human-lane',
                        reversibility: {
                            level: verdict.level,
                            semantics: verdict.semantics,
                            source: verdict.source,
                            lane: lane.lane,
                            note: lane.note,
                        },
                    },
                    next_step: 'IRREVERSIBLE by classification: an action whose effect cannot be undone must be performed ' +
                        'by the HUMAN personally. Relay to the user what needs to be done and where; do NOT retry automated ' +
                        'dispatch for this intent while reversibility lanes are enabled.',
                }, null, 2),
            };
        }
        if (lane.requiresEscrowPlan && intent.enforceEscrow) {
            const minted = await reversalEscrow.mintPlan({
                semantics: verdict.semantics,
                ...(intent.description !== undefined ? { description: intent.description } : {}),
                ...(intent.approvalToken !== undefined ? { approvalToken: intent.approvalToken } : {}),
                tool: intent.tool,
            });
            if (!minted.ok) {
                return {
                    applied: true, verdict, lane,
                    blocked: JSON.stringify({
                        status: 'ACTION_REQUIRED',
                        state_anchor: {
                            reason: 'reversibility-escrow-unavailable',
                            reversibility: {
                                level: verdict.level,
                                semantics: verdict.semantics,
                                lane: lane.lane,
                                mint_failure: minted.reason,
                            },
                            note: minted.detail ?? 'no hosted compensation plan could be minted — fail-closed',
                        },
                        next_step: 'COMPENSABLE action without a mintageable reversal plan: dispatch refused (fail-closed). ' +
                            'The HUMAN must perform this action personally, or the deployment must extend the compensation ' +
                            'strategy table for this semantics.',
                    }, null, 2),
                };
            }
            return { applied: true, verdict, lane, escrowPlanId: minted.plan.planId, blocked: null };
        }
        return { applied: true, verdict, lane, blocked: null };
    }
    catch {
        return { applied: false, reason: 'disabled' }; // 防御式：分道故障 = 未分道
    }
}
/** W5-0（C）：分道注记（state_anchor.reversibility_lane 的铸造面；applied:false ⇒ undefined） */
export function laneAnchorOf(gate) {
    if (!gate.applied)
        return undefined;
    return {
        level: gate.verdict.level,
        semantics: gate.verdict.semantics,
        lane: gate.lane.lane,
        ...(gate.escrowPlanId !== undefined ? { escrow_plan: gate.escrowPlanId } : {}),
    };
}
// ─── 纪元 Β（反驳法院）：对抗核验取证面 ───
//
// 截图 + 压缩编码为异构第二脑的呈堂证据：encodeForVlm 优先（长边压缩 + JPEG，
// 与 ask_screen 同一编码纪律）；编码失败（sharp 缺席/残图）回退原图直送。
// 取证失败一律 null（诚实缺席）—— 法院不审无据之案，但绝不因取证失败阻塞
// 点击主流程（askRefutation 收到空证据 ⇒ 缺席审判 uncertain ⇒ 不拦）。
// ΝΩ-32：preCaptured 在场（帧票据）⇒ 零自截 —— 反驳证据与记忆预验/captureBefore
// 共享同一「派发前世界」帧；缺席 ⇒ 原自截路径逐字节保持。
async function captureRefuteEvidence(preCaptured) {
    try {
        const buf = preCaptured ?? await system.captureScreen();
        if (!Buffer.isBuffer(buf) || buf.length === 0)
            return null;
        try {
            const enc = await encodeForVlm(buf);
            if (enc.ok && enc.value && enc.value.base64) {
                return { base64: enc.value.base64, mime: enc.value.mime };
            }
        }
        catch { /* 编码失败回退原图直送 */ }
        return { base64: buf.toString('base64'), mime: 'image/png' };
    }
    catch {
        return null; // 截屏通道缺席 —— 缺席审判，不阻塞
    }
}
// ─── ΝΩ-32（帧票据 frame ticket）：截图帧贯穿管线 ───
//
// 病灶：一次 dangerous+token 的 click_mouse 在派发前独立截屏最多 4 次
//（notary OCR 服务端自截 / 反驳法院证据全屏 / 记忆预验全屏 / captureBefore
// 基线）+ settleAndVerify 的 after 帧 —— 同一个「本链尚未触碰的派发前世界」
// 被重复拍摄，每次都是一整轮服务端往返。立法：
//   · 帧票据 = 派发前世界的唯一共享帧 {buffer, dhash, capturedAt, width, height}
//    （铸票一次服务端往返，携带指纹/区域指纹/帧环 id 供下游阶段消费）；
//   · 懒铸造：最早需要帧的阶段（反驳法院/记忆预验）铸票一次，后续派发前
//     阶段复用；单次点击链至多铸一票（铸败不重试 —— 最坏退化为旧逐阶段自截）；
//   · 新鲜度判据：capturedAt 距使用点 ≤ FRAME_TICKET_FRESH_MS 且未被本链动作
//     污染（交互性探针的悬停实验 = 显式污染源 —— 点击点 hover 高亮/光标移动
//     会污染「无变化」基线，探针之后票据作废）；过期/缺席/污染 ⇒ 该阶段回退
//     原自截路径（票据是增量优化，不是依赖）；
//   · 绝对边界（立法）：**票据只在派发前阶段共享 —— settleAndVerify 的 after
//     帧必须新截**。派发后世界已变，复用旧帧 = 用旧世界冒充新世界 = 效果验证
//     失效（详见 verifyEffectStage 立法注释）；
//   · 诚实边界：notary OCR（readTextAny）不接受外部帧（服务端 L2 OCR 无
//     「带 buffer 的 region API」，getUiTree 只收 region 自截）—— 该阶段保持
//     自截并登记「待服务端 region API」，不虚报覆盖面；
//   · 零孵化：铸票仅在 D-5 服务已在场时发生（healthSnapshot 在场判定，与
//     notaryStructuralAvailable 同律）—— 帧票据绝不成为服务孵化入口；
//     dry-run 无物理世界，不铸票。
// 本对象是可注入缝（notaryEvidence 同律）：测试注入假铸票面断言捕获计数，
// 生产路径不经任何替换。
/** ΝΩ-32：新鲜度阈值（算法形状字面量）—— 票据距使用点超过 2s 即视为过期
 *  （自截回退）。2s ≈ 反驳法院最坏 8s 硬止损与记忆预验/探针的正常耗时上界
 *  之间：基线帧太旧会把与本点击无关的外部世界变化（动画/时钟）误记为点击
 *  效果，宁可贵一截不可误一判。 */
const FRAME_TICKET_FRESH_MS = 2000;
/** ΝΩ-32：铸票面（模块级可注入缝）。mintable 纯在场判定（零物理调用零孵化）；
 *  mint 一次服务端往返，失败/缺席 ⇒ null（绝不抛）。 */
export const frameTicketing = {
    /** 铸票口在场判定：D-5 服务已存活（healthSnapshot 在场 —— 零孵化） */
    mintable() {
        return physicalBackend.healthSnapshot() !== null;
    },
    /** 铸票：与 captureCleanPng 同形（png / maxWidth 1600）+ 指纹/区域指纹/帧环 */
    async mint(focus, regionRadius, keepFrame) {
        try {
            const cap = await physicalBackend.captureProcessed({
                format: 'png',
                maxWidth: 1600,
                wantHashes: true,
                ...(regionRadius > 0
                    ? { wantRegionHash: { x: focus.x, y: focus.y, r: regionRadius } }
                    : {}),
                ...(keepFrame ? { keepFrame: true } : {}),
            });
            if (!cap.buffer || cap.buffer.length === 0)
                return null;
            return {
                buffer: cap.buffer,
                dhash: cap.dhash,
                phash: cap.phash,
                regionDhash: cap.regionDhash,
                frameId: cap.frameId,
                capturedAt: Date.now(),
                width: cap.width,
                height: cap.height,
                keptFrame: keepFrame,
            };
        }
        catch {
            return null; // 旁路宪法：铸票失败 = 票据缺席，各阶段回退自截
        }
    },
};
/** ΝΩ-32：sharp 在场探测 —— 与 actionVerifier.captureBefore 的 wantBuf 判据同源
 * （ticket 复用铸 BeforeState 时保持 buffer 字段的同判据：expectation 且 sharp
 *  可用才保留字节引用）。 */
async function sharpProbeAvailable() {
    try {
        const { getSharp } = await import('../_legacyDeps.js');
        await getSharp();
        return true;
    }
    catch {
        return false;
    }
}
/** ΝΩ-32：验收取证面的可注入包装（clickElement.elementVerify 同律 —— 直接
 *  具名导入的模块绑定不可替换，包装对象给测试一个计数缝；生产经同一函数
 *  引用转发，行为零变化）。 */
export const mouseVerify = { captureBefore, settleAndVerify };
export function createClickMouseTool(config) {
    return defineTool({
        name: 'click_mouse',
        description: 'Clicks the mouse at normalized coordinates (0.0 to 1.0). ' +
            'Effect verification is built-in: the result tells you whether the screen actually changed. ' +
            'target_description is REQUIRED (protocol level): every click must name its target — ' +
            'it feeds UI memory and the risk/approval gate; a click that cannot describe its ' +
            'target is a click that cannot be verified. ' +
            'The click point is independently notarized (OCR screen-read + whitebox control name): ' +
            'describe the target USING THE TEXT ACTUALLY SHOWN ON IT — a description that contradicts ' +
            'the screen is rejected (notary-mismatch).',
        parameters: {
            x: { type: 'number', required: true, description: 'X coordinate (0.0-1.0)' },
            y: { type: 'number', required: true, description: 'Y coordinate (0.0-1.0)' },
            button: { type: 'string', description: 'left, right, or middle' },
            confidence: {
                type: 'number',
                description: 'Your confidence in these coordinates (0.0-1.0). If below 0.6, consider zoom_inspect first.',
            },
            target_description: {
                type: 'string',
                // O 纪元（#18）：协议强制 —— 审批盲区的模型侧根除。schema 必填 ⇒
                // harness 在调用前就拒绝无描述点击（N 纪元的运行时硬前置是第二道闸）。
                required: true,
                description: 'Short description of what you are clicking (e.g., "GitHub 搜索框"). REQUIRED — ' +
                    'used for UI memory and the credential/danger gate.',
            },
            expected_change: {
                type: 'string',
                description: 'What visual change do you EXPECT if the click succeeds? e.g., "a dropdown expands", "input gains focus". Used to verify the effect semantically.',
            },
            expected_text: {
                type: 'string',
                description: 'Text you EXPECT to appear near the click point if it succeeds (requires enableOcr). The system OCR-verifies it automatically.',
            },
            from_memory_id: {
                type: 'number',
                description: 'Landmark ID from recall_ui. When provided, the system PRE-VERIFIES locally that the target still looks like it did when remembered — clicks on moved/changed targets are aborted before execution.',
            },
            approval_token: {
                type: 'string',
                description: 'One-shot token from request_approval. Required for irreversible targets (send/delete/pay/submit order...).',
            },
            // ── C-1 意图感知验证：声明预期，物理规则引擎带着预期找证据 ──
            expected_effect: {
                type: 'string',
                description: 'EXPECTED visual effect if this click succeeds — a kind string or JSON. Kinds: ' +
                    'toggle_on (checkmark appears), toggle_off, menu_expand (dropdown opens), menu_collapse, ' +
                    'input_focus (caret appears), page_navigate. Example: {"kind":"menu_expand"}',
            },
            reasoning: {
                type: 'string',
                description: 'Why you chose this action (one sentence). Recorded into the causal journal for later counterfactual analysis.',
            },
            allow_text_click: {
                type: 'boolean',
                description: 'Set true ONLY when you DELIBERATELY intend to click static text — place a caret in a document, ' +
                    'select a text span. The OS interactivity gate refuses left-clicks on static content by default: ' +
                    'conversation/document text that merely MENTIONS a label ("点击登录按钮" rendered in a chat) is NOT a clickable entry.',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
            const { x: rawX, y: rawY, button = 'left', confidence, expected_change, expected_text, from_memory_id, approval_token, expected_effect, reasoning, allow_text_click } = args;
            const rawTarget = typeof args.target_description === 'string' ? args.target_description : undefined;
            // ΑΩ-R11 结构重构：巨型 execute 拆为具名阶段函数（本文件内的局部工厂，
            // 闭包共享管线数据），主 execute 收敛为安全链编排序列。阶段序 = 原执行序
            // （W6-2 顺序敏感铁律，拆分即拆安全链 —— 本重构把每一环显式命名为阶段）：
            // 坐标校验 → 批注消费 → 危险词闸门 → 双钥公证锁 → 可逆性分道 → 反驳法院 →
            // 像素解析 → 记忆预验 → 交互性闸门 → 双尺度基线 → 接地新鲜度 →
            // 验证旁路收口 → 派发预留 → 物理派发 → 焦点登记 → 效果验证 → UI 记忆 →
            // OCR 核对 → 下一步指引 → 验收式令牌消费 → 成功回执。
            // 纯结构重构：执行顺序 / 条件分支 / 错误文案 / 输出 JSON 形状逐字节保持。
            // ΑΩ-R11 toolResult 工厂收编决策：本工具的非 toolErr 方言**不**迁移工厂 ——
            // ACTION_REQUIRED 各方言无顶层 action 键且 reason 落位 state_anchor.reason
            // （toolActionRequired 会注入 action 并把 reason 顶层合并，形状变化）；
            // SUCCESS 回执含 toolOk 四件套之外的 memory / pre_verified 顶层键；
            // stale-click FAILED 方言无 action / state_anchor.error。既有测试钉死这些
            // 形状（零回归优先），故维持 JSON.stringify 现状。
            // ΑΩ-R11 阶段函数·坐标校验：归一化域自查兜底，越界即拒。
            // 双保险校验（Guard 已在前线，工具自查兜底）
            const validateCoordinatesStage = () => {
                if (rawX < 0 || rawX > 1 || rawY < 0 || rawY > 1) {
                    return toolErr('Click validation failed.', `Invalid normalized coordinates (${rawX}, ${rawY}). X and Y must be between 0.0 and 1.0.`, 'Re-estimate the target center from the latest screenshot; zoom_inspect can refine the estimate.');
                }
                return undefined;
            };
            const invalidCoordinates = validateCoordinatesStage();
            if (invalidCoordinates !== undefined)
                return invalidCoordinates;
            // ΑΩ-R11 阶段函数·批注消费：把用户批注 patch 合并进点击计划，产出钳定后坐标/描述。
            // ── W1-2 批注消费接线：派发前读 amendment patch 修正计划 ──
            // 位置刻意在 assertActionAllowed **之前**（「beginAttempt 前」的最强形式）：
            // 用户批注修正后的 target_description 参与危险判定 —— 修正出危险语义的
            // 计划同样要过审批闸门，批注不得成为绕闸通道。无令牌/无批注 ⇒ 零行为。
            const consumeAmendmentStage = () => {
                const amendment = consumeApprovalAmendment(approval_token, { tool: 'click_mouse', x: rawX, y: rawY, target_description: rawTarget });
                return {
                    amendment,
                    x: amendment.x ?? rawX,
                    y: amendment.y ?? rawY,
                    target_description: amendment.target_description ?? rawTarget,
                };
            };
            const { amendment, x, y, target_description } = consumeAmendmentStage();
            // ΑΩ-R11 阶段函数·危险词闸门：第一遍 assertActionAllowed —— 危险/未授予/未描述
            // 点击在此拒绝（取证之前，阻断路径零新增物理/网络副作用，逐字节旧方言）。
            // ── 不可逆操作闸门（第六轮 + B-3 两阶段 + J 纪元授予门 + N 纪元硬前置）──
            // 危险目标必须持**已授予**的有效令牌（grant_approval 落点 approval.grant ——
            // "从未 grant" 与 "grant=true" 不再等价）。
            // J 纪元升级（盲区收窄）：expected_text 作为**第二危险信号** —— 模型即使
            // 不填 target_description，声明"预期出现『发送/支付』字样"（expected_text
            // 本就是模型对该按钮的自述）同样触发闸门。旧的 `!!target_description`
            // 前置条件使"沉默不填描述"成为绕过通道；现在绕过需要同时沉默两条
            // 独立信号通道。
            // Δ 纪元（审计#1）：判定抽取至 actionGate.assertActionAllowed —— 工具层与
            // 重放层（replayOne）共用同一事实源；此处语义与原工具内实现逐条等价
            // （危险信号计算 / 拒绝归因 / sweep 副作用 / undescribed-click 硬前置）。
            // 阶段一 validate：只查不烧 —— 点击若抛异常，令牌仍可用于重试；
            // 阶段二 consume 在动作成功返回前调用（见下方 finally 前的成功路径）。
            const dangerGateStage = () => {
                const gate = assertActionAllowed('click_mouse', { target_description, expected_text, approval_token }, config);
                if (gate.allowed)
                    return { gate, blocked: undefined };
                if (gate.reason === 'undescribed-click') {
                    return {
                        gate,
                        blocked: JSON.stringify({
                            status: 'ACTION_REQUIRED',
                            state_anchor: { reason: 'undescribed-click', note: 'approval gate cannot judge an undescribed target' },
                            next_step: 'Re-invoke click_mouse with target_description (what you are clicking) or expected_text ' +
                                '(text you expect to appear) — the approval gate requires one description channel to judge irreversibility.',
                        }, null, 2),
                    };
                }
                return {
                    gate,
                    blocked: JSON.stringify({
                        status: 'ACTION_REQUIRED',
                        state_anchor: {
                            target: target_description ?? expected_text ?? '(undescribed target)',
                            danger_signal: gate.dangerSignalChannel,
                            reason: gate.reason,
                            note: approval_token
                                ? 'The token exists but the user has not granted it yet (or it expired).'
                                : 'This target looks irreversible (send/delete/pay/submit...).',
                        },
                        next_step: 'PAUSE: this action needs explicit user approval. Call request_approval with a clear ' +
                            'description, tell the user what you are about to do, wait for their consent, call ' +
                            'grant_approval(token, true), then re-invoke click_mouse with the returned approval_token. ' +
                            'Never proceed without consent.',
                    }, null, 2),
                };
            };
            const gateDecision = dangerGateStage();
            if (gateDecision.blocked !== undefined)
                return gateDecision.blocked;
            const gate = gateDecision.gate;
            // ΑΩ-R11 阶段函数·双钥公证锁：放行路径上的多通道取证重审（落点邻域 OCR 实读 +
            // 白盒控件名），任一通道见危险 ⇒ 审批域执法；OCR 实读与自述不符 ⇒ notary-mismatch。
            // ── 纪元 Ρ（双钥公证锁·第二遍）：放行路径上的多通道公证 ──
            // 第一遍（上方）保持 Ρ 之前的全部阻断语义 —— 危险/未授予/未描述的点击
            // 在取证之前就被拒（阻断路径零新增物理/网络副作用，逐字节旧方言）。
            // 只有本来就会派发的点击才付出取证成本：落点邻域 OCR 实读 + 白盒控件名，
            // 携证据重审 —— 任一通道见危险 ⇒ 审批域执法；OCR 实读与模型自述不符 ⇒
            // notary-mismatch（注入谎报目标的根除点）。取证失败一律 null（诚实降级），
            // 绝不因公证取证失败而阻塞正常点击：锁只在「通道在场且见危险/不符」时收紧。
            // ΤΕΛ-6（D-G32·M3）：notaryEvidenceAt 记录取证成功时刻（至少一条通道
            // 读了东西才算在场证据）；派发前的 freshnessStage 据此判「证据过期作废」
            //（C1-5 M3：取证到派发可隔 10s+ —— 反驳法院最坏 8s + 预验 + 探针 + 截屏，
            // 帧票据 2s 新鲜度只管截屏复用，不管公证证据）。
            let notaryEvidenceAt = null;
            const notaryStage = async () => {
                let gate2 = gate;
                let notarization;
                if (config.enableNotarizationLock && !config.dryRun) {
                    const avail = notaryEvidence.channelsAvailable(config);
                    if (avail.ocr || avail.structural) {
                        let evidence;
                        try {
                            evidence = {
                                ocrLabel: avail.ocr ? await notaryEvidence.readOcrLabel(config, x, y) : null,
                                structuralName: avail.structural ? await notaryEvidence.readStructuralName(config, x, y) : null,
                            };
                            // ΤΕΛ-6（D-G32·M3）：证据在场（任一通道读到非空）⇒ 记取证时刻
                            if (evidence.ocrLabel !== null || evidence.structuralName !== null) {
                                notaryEvidenceAt = Date.now();
                            }
                            gate2 = assertActionAllowed('click_mouse', { target_description, expected_text, approval_token }, config, evidence);
                        }
                        catch {
                            // 宪法：运行层永不抛 —— 取证自身失败 = 通道缺席，维持第一遍判决
                            evidence = undefined;
                            gate2 = gate;
                        }
                        // ΑΩ-R11：字段名对齐 actionGate 现行 ActionGateDecision.notaryNote
                        //（原 notarizationNote 为更名前的陈旧引用 —— dist 既有构建与 clickElement 同用 notaryNote）
                        notarization = notaryAnchorOf(gate2.notarization, evidence, gate2.notaryNote);
                        if (!gate2.allowed) {
                            // 审计留痕：公证拦截入防篡改链（GUARD_BLOCKED 方言，circuitBreaker 同律）
                            void journal.appendMarker({
                                kind: 'GUARD_BLOCKED',
                                guard: 'notary-lock',
                                reason: gate2.reason === 'notary-mismatch'
                                    ? 'notary-mismatch'
                                    : `danger:${gate2.dangerSignalChannel ?? 'unknown'}`,
                            }).catch(() => { });
                            if (gate2.reason === 'notary-mismatch') {
                                const ocrSnippet = (evidence?.ocrLabel ?? '').slice(0, 60);
                                return {
                                    gate2, notarization,
                                    blocked: JSON.stringify({
                                        status: 'ACTION_REQUIRED',
                                        state_anchor: {
                                            target: target_description ?? expected_text ?? '(undescribed target)',
                                            reason: 'notary-mismatch',
                                            notarization,
                                            note: 'The text actually READ FROM THE SCREEN at this point does not match your description ' +
                                                '(semantic handshake failed) — the target may have moved, or the description is wrong.',
                                        },
                                        next_step: `NOTARY MISMATCH: this point actually reads "${ocrSnippet}". RE-DESCRIBE the target ` +
                                            'using the text ACTUALLY SHOWN ON SCREEN (put it in target_description) and retry the click. ' +
                                            "If the screen has changed, call 'take_screenshot' first and re-locate the target. " +
                                            'Do not reuse the mismatched description.',
                                    }, null, 2),
                                };
                            }
                            return {
                                gate2, notarization,
                                blocked: JSON.stringify({
                                    status: 'ACTION_REQUIRED',
                                    state_anchor: {
                                        target: target_description ?? expected_text ?? '(undescribed target)',
                                        danger_signal: gate2.dangerSignalChannel,
                                        reason: gate2.reason,
                                        notarization,
                                        note: approval_token
                                            ? 'The token exists but the user has not granted it yet (or it expired).'
                                            : 'This target looks irreversible (send/delete/pay/submit...) — the danger was NOTARIZED FROM ' +
                                                'THE SCREEN (OCR-read label / whitebox control name), not taken from your description.',
                                    },
                                    next_step: 'PAUSE: this action needs explicit user approval. Call request_approval with a clear ' +
                                        'description (quote the text actually shown on the target), tell the user what you are about to ' +
                                        'do, wait for their consent, call grant_approval(token, true), then re-invoke click_mouse with ' +
                                        'the returned approval_token. Never proceed without consent.',
                                }, null, 2),
                            };
                        }
                    }
                    else {
                        notarization = notaryAnchorOf('degraded', undefined, 'notary-channels-unavailable');
                    }
                }
                return { gate2, notarization, blocked: undefined };
            };
            const notaryOutcome = await notaryStage();
            if (notaryOutcome.blocked !== undefined)
                return notaryOutcome.blocked;
            const dangerous = notaryOutcome.gate2.dangerous;
            const notarization = notaryOutcome.notarization;
            const gateCoverage = config.enableApprovalGate ? 'described' : 'gate-disabled';
            // ΑΩ-R11 阶段函数·可逆性分道：物理派发前的三路执法（快道/托管道/人道），
            // 阻断即原样返回其结构化回执。
            // ── W5-0（C 接线 · W4-3 S5）：可逆性分道 —— 物理派发前的三路执法 ──
            // 位置在全部既有闸门（危险词/公证/批注）之后、beginAttempt 之前：
            // compensable 的逆转预案必须先于派发预留铸造（dispatchLaneFor 的字面序）。
            // 开关关（缺省）⇒ applied:false 零行为；未知语义交回危险词闸门（保守律 ②）。
            const reversibilityStage = () => gateByReversibility(config, {
                tool: 'click_mouse',
                description: target_description ?? expected_text,
                ...(approval_token !== undefined ? { approvalToken: approval_token } : {}),
                enforceEscrow: !!(dangerous && approval_token),
            });
            const laneGate = await reversibilityStage();
            if (laneGate.applied && laneGate.blocked !== null) {
                return laneGate.blocked;
            }
            // ΑΩ-R11 阶段函数·帧票据（ΝΩ-32）：本回合派发前的共享帧持有者。
            // 铸票口 = 最早需要帧的阶段（下方反驳法院/记忆预验，懒铸造）；票据只在
            // 派发前阶段共享 —— settleAndVerify 的 after 帧绝不复用（见 verifyEffectStage
            // 立法注释）。过期/缺席/污染 ⇒ 各阶段回退原自截路径（零回归兜底）。
            let frameTicket = null;
            let ticketMintTried = false; // 单链至多铸一票（铸败不重试）
            let ticketPolluted = false; // 污染标记：交互性探针悬停触碰过世界
            const freshTicket = () => frameTicket !== null
                && !ticketPolluted
                && (Date.now() - frameTicket.capturedAt) <= FRAME_TICKET_FRESH_MS
                ? frameTicket
                : null;
            const ensureFrameTicket = async () => {
                const held = freshTicket();
                if (held)
                    return held;
                if (ticketMintTried)
                    return null; // 已铸过（败/过期）—— 不再重试
                ticketMintTried = true;
                if (config.dryRun)
                    return null; // dry-run 无物理世界
                if (!frameTicketing.mintable())
                    return null; // 服务不在场：零孵化，各阶段自截
                // keepFrame 与 beforeCaptureStage 的 expectation 判据同源（物理规则需要
                // before 帧入环；parseExpectation 纯函数，铸票时即可判定）
                const keepFrame = config.intentVerify && parseExpectation(expected_effect) !== null;
                frameTicket = await frameTicketing.mint({ x, y }, config.regionVerifyRadius, !!keepFrame);
                return freshTicket(); // 铸后重判新鲜度（防御式：注入面/极端慢铸不越过阈值）
            };
            // ΑΩ-R11 阶段函数·反驳法院：不可逆动作派发前的跨模型对抗核验
            // （refuted 拦 / upheld 注记 / uncertain 缺席审判零行为）。
            // ── 纪元 Β（反驳法院）：不可逆动作派发前的跨模型对抗核验 ──
            // 窄门执法三前置（缺一不开庭，非危险动作零法院调用 —— 性能铁律：法院只审
            // 不可逆）：危险词命中（能走到这里的危险点击必已持有效令牌，即将物理派发）
            // + enableRefuteCourt 开 + 会话内有异构第二脑（refuteCourtInSession 纯配置
            // /在场判定，零网络零拨号）。判决执法（沿 notary-lock 方言）：
            //   refuted   ⇒ 拦截（toolErr + guard:'refute-court' + next_step 人工复核
            //               指引 + journal GUARD_BLOCKED 留痕）；拦截发生在 beginAttempt
            //               之前 —— 令牌不烧、尝试不占，人工复核后可原令牌重试；
            //   upheld    ⇒ 放行 + 锚点注记 refute:'upheld'（认真反驳后维持的可信度
            //               加成，透明化）；
            //   uncertain ⇒ 缺席审判零行为 —— 不拦、不注记，输出与法院关闭时逐字节
            //               同路。法院是旁路增益不是依赖：故障（无第二脑/调用失败/
            //               超时 8s 单次不重试）绝不下沉为点击主流程的阻塞。askRefutation
            //               自身永不抛，本块对主流程的唯一可见副作用是上述两分支。
            const refuteStage = async () => {
                let refuteStamp;
                if (dangerous && config.enableRefuteCourt === true && !config.dryRun && refuteCourtInSession()) {
                    // ΝΩ-32：呈堂证据优先消费帧票据（本阶段通常即铸票口 —— 证据帧定义上
                    // 新鲜）；票据缺席 ⇒ 原自截路径逐字节保持
                    const evidence = await captureRefuteEvidence((await ensureFrameTicket())?.buffer);
                    // 目标区域聚焦注记：与 notary 邻域窗口同源（regionVerifyRadius 夹取）
                    const rr = Math.min(0.25, Math.max(0.05, config.regionVerifyRadius > 0 ? config.regionVerifyRadius : 0.15));
                    const rLeft = Math.max(0, x - rr);
                    const rTop = Math.max(0, y - rr);
                    const verdict = await askRefutation({
                        imageBase64: evidence ? evidence.base64 : '',
                        mime: evidence?.mime,
                        description: target_description ?? expected_text ?? 'the point being clicked',
                        region: {
                            x: rLeft,
                            y: rTop,
                            width: Math.min(1 - rLeft, rr * 2),
                            height: Math.min(1 - rTop, rr * 2),
                        },
                    });
                    if (verdict.verdict === 'refuted') {
                        // 审计留痕：反驳拦截入防篡改链（GUARD_BLOCKED 方言，notary-lock 同律）
                        void journal.appendMarker({
                            kind: 'GUARD_BLOCKED',
                            guard: 'refute-court',
                            reason: `second-brain-refuted:${verdict.secondOpinionId ?? 'unknown'}`,
                        }).catch(() => { });
                        return {
                            refuteStamp,
                            blocked: toolErr(`Irreversible click on "${target_description ?? 'undescribed target'}" blocked by the refutation court.`, `An independent second brain (${verdict.secondOpinionId ?? 'heterogeneous second opinion'}) examined the ` +
                                'screen and found CONTRADICTING evidence (guard: refute-court): ' +
                                `${verdict.reason ?? 'no reason given'} (confidence ${verdict.confidence.toFixed(2)}).`, 'PAUSE: do NOT retry this click as-is. The target description did not survive adversarial review — ' +
                                'ask the USER to manually verify this target on screen (take_screenshot / zoom_inspect around the point) ' +
                                'and confirm what it actually is before any retry; if the user confirms the target, re-invoke with a ' +
                                'corrected target_description (the approval token is still valid — the court blocked before dispatch).'),
                        };
                    }
                    if (verdict.verdict === 'upheld')
                        refuteStamp = 'upheld';
                    // uncertain ⇒ 缺席审判零行为（不拦、不注记 —— 见上方法条）
                }
                return { refuteStamp, blocked: undefined };
            };
            const refuteOutcome = await refuteStage();
            if (refuteOutcome.blocked !== undefined)
                return refuteOutcome.blocked;
            const refuteStamp = refuteOutcome.refuteStamp;
            // Δ 纪元（审计#2）：本回合是否已持有 beginAttempt 的派发预留（catch 路径
            // 需据此结算 —— 见下方异常分支）
            let attemptReserved = false;
            try {
                // ΑΩ-R11 阶段函数·像素解析：屏幕尺寸换算点击落点（try 域首步 —— 取屏失败走 catch 结算）。
                const resolvePixelsStage = async () => {
                    const size = await system.getScreenSize();
                    return { size, px: Math.round(x * size.width), py: Math.round(y * size.height) };
                };
                const { size, px, py } = await resolvePixelsStage();
                // ΑΩ-R11 阶段函数·记忆预验：点击前本地核实 from_memory_id 目标还在原位（防 stale-click）。
                // ── 记忆预验（第六轮）：点击前本地核实目标还在原位 ──
                // recall_ui 给的是历史坐标；屏幕可能已变。取当前屏同位置区域指纹与
                // 记忆时的目标外观对比：不像 ⇒ 目标已移动/消失，点击中止（防 stale-click）
                const memoryPrecheckStage = async () => {
                    let preVerified;
                    if (typeof from_memory_id === 'number' && !config.dryRun) {
                        const lm = uiMemory.get(from_memory_id);
                        if (!lm) {
                            return {
                                preVerified,
                                blocked: toolErr(`Landmark #${from_memory_id} click aborted.`, 'Landmark not found in memory.', "Call 'recall_ui' to refresh landmark IDs, then retry with the correct from_memory_id."),
                            };
                        }
                        if (lm.regionHash) {
                            // ΝΩ-32：优先复用帧票据（与反驳证据/captureBefore 同一派发前帧 ——
                            // 票据缺席/过期/污染 ⇒ 原自截路径逐字节保持，预验语义零变化：
                            // 票据帧与 captureScreen 同为干净全屏 png/1600，regionDhash 同尺）
                            const ticket = await ensureFrameTicket();
                            const curBuf = ticket?.buffer ?? await system.captureScreen();
                            const curRegion = await regionDhash(curBuf, lm.normalized.x, lm.normalized.y, config.regionVerifyRadius);
                            const matchScore = similarity(curRegion, lm.regionHash);
                            if (matchScore < 0.85) {
                                return {
                                    preVerified,
                                    blocked: JSON.stringify({
                                        status: 'FAILED',
                                        state_anchor: {
                                            pre_verification: {
                                                landmark: from_memory_id,
                                                appearance_similarity_pct: Math.round(matchScore * 1000) / 10,
                                                verdict: 'target-changed',
                                            },
                                        },
                                        next_step: 'ABORTED BEFORE CLICK: the target region no longer looks like it did when remembered ' +
                                            '(the UI probably changed). Do NOT click stale coordinates — take a fresh screenshot and re-locate.',
                                    }, null, 2),
                                };
                            }
                            preVerified = true;
                        }
                    }
                    return { preVerified, blocked: undefined };
                };
                const memoryOutcome = await memoryPrecheckStage();
                if (memoryOutcome.blocked !== undefined)
                    return memoryOutcome.blocked;
                const preVerified = memoryOutcome.preVerified;
                // ΑΩ-R11 阶段函数·交互性闸门：指针落下前问世界「这是控件还是正文」，
                // 静态正文上的左键点击结构化否决（AA-1 拒绝即改道指引）。
                // ── Z-2 交互性闸门：指针落下之前，先问世界「这是控件还是正文」──
                // 对症失败模式：「模型将输出的正文当作点击的按钮」。Z-1 的判决只标注
                // 在 find_text 结果里（模型可以不看）；此处把同一三通道探针（UIA 结构层
                // > 悬停光标 > 场景记忆）前移到点击执行前 —— 静态正文（Text/Document，
                // 非 Edit 输入框）上的左键点击被结构化否决。右键（正文上的上下文菜单
                // 是合法动作）与 dry-run（无物理世界可问）不适用；模型明知点正文时可
                // 以 allow_text_click 自证（文档放置光标/选中文本）。
                // 顺序：闸门必须在 captureBefore 之前 —— 悬停实验可能触发 hover 高亮，
                // before 帧只能在探针之后取，否则高亮会污染「无变化」基线。
                const interactivityStage = async () => {
                    if (config.enableInteractivityProbe && !config.dryRun && button === 'left') {
                        const [probe] = await probePoints(config, [{ x, y }]);
                        // ΝΩ-32 票据污染标记：悬停实验可能触发 hover 高亮/光标移动 —— 本链
                        // 已触碰世界，票据不得再充当「无变化」基线（下方 captureBefore 回退
                        // 自截，与本阶段头注「before 帧只能在探针之后取」同一立法）
                        ticketPolluted = true;
                        const gate = gateTextClick(probe, { allowTextClick: allow_text_click === true });
                        if (gate.blocked) {
                            console.warn(`[Interactivity Gate] Blocked click on static text: ${gate.evidence}`);
                            // AA-1 跳转出口：被否决的正文里若含 URL，拒绝即改道指引 ——
                            // 「别点，跳」。UIA 的控件名是该点文字内容的官方回执（≤40 字符），
                            // 零成本复用；悬停通道无文本回执，保持原语义。
                            const textContent = probe?.evidence.hit_test?.name;
                            const urls = textContent ? extractUrls(textContent) : [];
                            const jumpHint = urls.length > 0
                                ? ` The static text contains a URL: ${urls[0]} — if your goal is to open it, call 'open_url' with it instead of clicking.`
                                : '';
                            return JSON.stringify({
                                status: 'ACTION_REQUIRED',
                                state_anchor: {
                                    target: target_description ?? '(undescribed target)',
                                    interactivity_gate: {
                                        verdict: 'text',
                                        reason: gate.reason,
                                        evidence: gate.evidence,
                                        note: probe?.note,
                                    },
                                },
                                next_step: 
                                // R2-4：菜单项语义 ⇒ 两段式话术。实战病灶：下拉未开时点菜单项
                                // 坐标落在正文（I-beam），模型把拦截当噪声原地重试同一坐标
                                // （R1-8 attempt9 三连）。菜单项只在菜单展开期间存在 —— 拦截
                                // 本身就是「菜单没开」的确定性证据，直接给出回到第一阶段的路径。
                                menuItemSemantics(target_description, expected_text)
                                    ? menuNotOpenGateHint()
                                    : 'This point is STATIC CONTENT (chat message / document text), not a clickable control — the text merely ' +
                                        'MENTIONS the label you are looking for. Do NOT retry the same coordinates. ' +
                                        "Re-locate the real control: call 'find_text' with the label keyword and click ONLY a match with " +
                                        'interactivity=control; or take_screenshot and search visually; the entry may need scroll_page or a ' +
                                        'menu to be opened first. ' +
                                        'If you DELIBERATELY want to click static text (place a caret in a document, select a span), ' +
                                        're-invoke click_mouse with allow_text_click: true.' + jumpHint,
                            }, null, 2);
                        }
                    }
                    return undefined;
                };
                const interactivityBlocked = await interactivityStage();
                if (interactivityBlocked !== undefined)
                    return interactivityBlocked;
                // ΑΩ-R11 阶段函数·双尺度基线：动作前同时取全屏 + 点击点区域指纹
                //（C-1 声明 expected_effect 时保留动作前帧供物理规则前后对比）。
                // ── 效果验证（双尺度 + C-1 意图感知）：动作前同时取全屏 + 点击点区域指纹 ──
                // 区域指纹放大局部反馈（光标/高亮/展开），弥补全屏 dHash 的局部盲区
                // C-1：声明了 expected_effect 时保留动作前帧 —— 物理规则需要前后两帧对比
                const beforeCaptureStage = async () => {
                    const expectation = config.intentVerify ? parseExpectation(expected_effect) : null;
                    const verify = config.verifyActions && !config.dryRun;
                    if (!verify)
                        return { expectation, before: null };
                    // ΝΩ-32 captureBefore 帧复用：票据在场且新鲜未污染 ⇒ 直接由票据铸
                    // BeforeState（铸票时服务端已算好 dhash/regionDhash —— 复用 = 零额外
                    // 服务端往返）。复用判据（缺一回退 captureBefore 自截，逐字节旧路径）：
                    //   · dhash 在场（指纹缺席的极端服务端降级不满足基线语义）；
                    //   · expectation 在场（物理规则消费 before 帧）⇒ 票据必须 keptFrame
                    //     且 frameId 非空（帧环引用锚不得缺席）。
                    const ticket = freshTicket();
                    if (ticket && ticket.dhash && (!expectation || (ticket.keptFrame && ticket.frameId != null))) {
                        // buffer 判据与 captureBefore 的 wantBuf 同源：expectation 且 sharp
                        // 可用才保留字节引用（legacy 物理规则前后帧对比路径）
                        const wantBuf = !!expectation && await sharpProbeAvailable();
                        const before = {
                            screen: normalizeHash(ticket.dhash),
                            phash: ticket.phash ?? null,
                            region: ticket.regionDhash ? normalizeHash(ticket.regionDhash) : null,
                            focus: { x, y },
                            buffer: wantBuf ? ticket.buffer : undefined,
                            frameId: ticket.frameId ?? null,
                        };
                        return { expectation, before };
                    }
                    return { expectation, before: await mouseVerify.captureBefore({ x, y }, config.regionVerifyRadius, !!expectation) };
                };
                const { expectation, before } = await beforeCaptureStage();
                // ΑΩ-R11 阶段函数·接地新鲜度：dangerous 令牌动作派发前与接地指纹比对，
                // 漂移/降级即阻断（W6R fail-closed；判决随成功路径透明化）。
                // W2-2（S3）：派发前接地新鲜度探针的判决（成功路径透明化用）
                // ── W2-2（S3）：派发前接地新鲜度探针（approval.beginAttempt 之前）──
                // 危险类点击（dangerous 经闸门判定 —— riskGate 词表的只读调用产物）的
                // 坐标来自接地时刻的截图；审批人机往返分钟级，屏幕可能已相变。派发前
                // 抓一帧低清快图（经注入端口）与接地指纹比对：漂移 ⇒ 阻断本次派发
                // （结构化「需重新截图定位」，供上层重感知；令牌未烧 —— 阻断在预留/派发
                // 之前）。
                // W6R（fail-open ⇒ fail-closed 收口）：本探针保护的恰是「需要审批令牌的
                // 动作」（dangerous 分级、走 beginAttempt/consume 的路径）—— 探针缺席或
                // 失败时降级放行等于把叠加防御的故障变成不可逆动作面的默认态。新法：
                // degraded（端口缺席 / 取帧失败 / 指纹缺席）⇒ 拒绝派发，错误信息指明
                // 原因与三条出路（重试 / 开探针 / 显式逃生门 allowUnverifiedDangerous）。
                // drifted（主动漂移证据）不受逃生门豁免 —— 那是阳性危险发现，不是证据
                // 缺席。非令牌动作不进入本块（叠加防御只挂危险令牌面，旧行为不变）。
                const freshnessStage = async () => {
                    if (dangerous && approval_token && !config.dryRun) {
                        // ΤΕΛ-6（D-G32·M3）：公证证据时效 —— 取证到「现在」超过立法阈
                        //（NOTARY_EVIDENCE_MAX_AGE_MS=10s）⇒ 证据过期作废，拒绝派发（fail-closed，
                        // 与 freshness 探针同执法点族：叠加防御只挂危险令牌面，非令牌动作零行为）。
                        // 过期证据是「新鲜度阳性的失效发现」（同 drifted 律）：不受
                        // allowUnverifiedDangerous 逃生门豁免 —— 重试即重新取证，成本一次点击。
                        // 令牌未烧（阻断在预留/派发之前 —— 与 freshness 拦截同位）。
                        if (notaryEvidenceStale(notaryEvidenceAt, Date.now())) {
                            void journal.appendMarker({
                                kind: 'GUARD_BLOCKED',
                                guard: 'notary-lock',
                                reason: `notary-evidence-stale: evidence age ${Date.now() - (notaryEvidenceAt ?? 0)}ms > ${10_000}ms`,
                            }).catch(() => { });
                            return {
                                stamp: undefined,
                                blocked: JSON.stringify({
                                    status: 'ACTION_REQUIRED',
                                    state_anchor: {
                                        target: target_description ?? expected_text ?? '(undescribed target)',
                                        reason: 'notary-evidence-stale',
                                        note: 'The OCR/whitebox evidence proving this irreversible target was captured too long before '
                                            + 'dispatch (refutation court, probes and screenshots may have intervened) — the screen may no '
                                            + 'longer read the same. The notarized guarantee has EXPIRED, not merely degraded.',
                                    },
                                    next_step: 'STALE NOTARY EVIDENCE — do NOT force this click. Simply RETRY the same click_mouse call: '
                                        + 'the retry re-collects fresh evidence at the point (the approval token is still valid — no '
                                        + 'attempt was spent). If retries keep expiring, reduce intervening steps between approval and click.',
                                }, null, 2),
                            };
                        }
                        const fresh = await probeGroundingFreshness();
                        if (fresh.verdict === 'drifted') {
                            // 审计留痕：新鲜度拦截入防篡改链（GUARD_BLOCKED 方言，notary-lock 同律）
                            void journal.appendMarker({
                                kind: 'GUARD_BLOCKED',
                                guard: 'freshness-probe',
                                reason: `grounding-drift: similarity ${fresh.similarity_pct}% < threshold ${fresh.threshold_pct}%`,
                            }).catch(() => { });
                            return {
                                stamp: fresh,
                                blocked: JSON.stringify({
                                    status: 'ACTION_REQUIRED',
                                    state_anchor: {
                                        target: target_description ?? expected_text ?? '(undescribed target)',
                                        freshness_probe: fresh,
                                        reason: 'grounding-stale',
                                        note: 'The screen has changed materially since the screenshot these coordinates were ' +
                                            'grounded against — the click would land in a DIFFERENT world state.',
                                    },
                                    next_step: 'STALE GROUNDING — do NOT retry these coordinates. Call take_screenshot to ' +
                                        're-capture the screen, RE-LOCATE the target from the fresh screenshot, then retry with ' +
                                        'the new coordinates. The approval token is still valid (blocked before dispatch — no ' +
                                        'attempt was spent).',
                                }, null, 2),
                            };
                        }
                        if (fresh.verdict === 'degraded' && config.allowUnverifiedDangerous !== true) {
                            // W6R fail-closed：探针缺席/失败 ⇒ 拒绝派发（令牌未烧 —— 阻断在预留之前）
                            void journal.appendMarker({
                                kind: 'GUARD_BLOCKED',
                                guard: 'freshness-probe',
                                reason: `probe-unavailable: ${fresh.note ?? 'unknown'}`,
                            }).catch(() => { });
                            return {
                                stamp: fresh,
                                blocked: JSON.stringify({
                                    status: 'ACTION_REQUIRED',
                                    state_anchor: {
                                        target: target_description ?? expected_text ?? '(undescribed target)',
                                        freshness_probe: fresh,
                                        reason: 'freshness-probe-unavailable',
                                        note: 'This irreversible (approval-token) action MUST be freshness-checked before ' +
                                            'dispatch, but the grounding-freshness probe is absent or failed ' +
                                            `(${fresh.note ?? 'unknown cause'}) — dispatch is refused (fail-closed), NOT silently degraded.`,
                                    },
                                    next_step: 'FRESHNESS PROBE UNAVAILABLE — the pre-dispatch grounding check could not run. ' +
                                        'Ways out: (1) RETRY after taking a fresh screenshot (take_screenshot establishes the ' +
                                        'grounding fingerprint the probe compares against); (2) ensure the physical service is ' +
                                        'alive and the probe port is wired (production wires it by default; offline/dry-run ' +
                                        'environments do not); (3) deployment-level explicit escape hatch: set ' +
                                        'allowUnverifiedDangerous=true (accepts unverified dangerous dispatch). ' +
                                        'The approval token is still valid (blocked before dispatch — no attempt was spent).',
                                }, null, 2),
                            };
                        }
                        return { stamp: fresh, blocked: undefined };
                    }
                    return { stamp: undefined, blocked: undefined };
                };
                const freshnessOutcome = await freshnessStage();
                if (freshnessOutcome.blocked !== undefined)
                    return freshnessOutcome.blocked;
                const freshnessStamp = freshnessOutcome.stamp;
                // ΑΩ-R11 阶段函数·验证旁路收口：W6R —— dangerous 令牌动作的效果验证
                // 不可被 verifyActions 整体关闭（双重显式逃生门）。
                // ── W6R（验证总开关旁路收口）：dangerous 令牌动作的效果验证不可被
                //    verifyActions 整体关闭（双重显式逃生门） ──
                // 旧缺陷：verifyActions=false ⇒ dangerous+token 走 unverified-dispatch-
                // consumed（令牌派发即焚）—— 整个效果验证体系（V 纪元验收式消费的依据）
                // 被一个 Token 经济开关静默旁路。新法：
                //   · verifyActions=false 且 allowUnverifiedDangerous !== true ⇒ 派发前
                //     拒绝并指明出路（本块）。dry-run 豁免：无物理世界可验，令牌消费仅
                //     是模拟账面；
                //   · verifyActions=false 且 allowUnverifiedDangerous === true ⇒ 旧方言
                //     保持（部署两把钥匙同时显式插入：既关验证又显式接受未验证危险派发）；
                //   · verifyActions=true（缺省）⇒ 零变化。
                // 非 dangerous 分级维持 verifyActions 原语义（benign 动作的验证仍是可关
                // 的 Token 经济开关 —— 本块只挂在 dangerous && approval_token 面上）。
                const verifyBypassStage = () => {
                    if (dangerous && approval_token && !config.dryRun
                        && config.verifyActions !== true && config.allowUnverifiedDangerous !== true) {
                        return JSON.stringify({
                            status: 'ACTION_REQUIRED',
                            state_anchor: {
                                target: target_description ?? expected_text ?? '(undescribed target)',
                                approval_gate: gateCoverage,
                                reason: 'effect-verification-required',
                                note: 'Effect verification is the acceptance basis for approval-token (irreversible) ' +
                                    'actions: the token is only consumed on a VERIFIED world effect. verifyActions=false ' +
                                    'alone can no longer bypass that (the legacy bypass silently consumed the token on ' +
                                    'dispatch, defeating the whole acceptance system).',
                            },
                            next_step: 'EFFECT VERIFICATION REQUIRED for this approval-token action, but verifyActions=false. ' +
                                'Ways out: (1) re-enable verifyActions=true (recommended — dangerous actions then verify ' +
                                'before/after and the token is consumed only on a verified effect); (2) deployment-level ' +
                                'explicit escape hatch: ALSO set allowUnverifiedDangerous=true (two explicit keys — accepts ' +
                                'legacy unverified-dispatch-consumed dialect for dangerous actions). ' +
                                'No physical dispatch happened and the approval token is still valid.',
                        }, null, 2);
                    }
                    return undefined;
                };
                const bypassBlocked = verifyBypassStage();
                if (bypassBlocked !== undefined)
                    return bypassBlocked;
                // ΑΩ-R11 阶段函数·派发预留：beginAttempt 在物理派发前原子预留一次尝试
                //（Δ 纪元双花窗口封堵 —— 预留到物理派发之间保持零 await）。
                // ── Δ 纪元（审计#2·双花窗口封堵）：派发预留 ──
                // validate（只查不烧）与验收式消费（consume/attemptFailed，见下方）之间
                // 隔着多个 await —— 并发两次同令牌调用都能过 validate、都派发物理点击。
                // beginAttempt 在物理派发前原子预留一次尝试（attempts +1 且同令牌同时
                // 只允许一个在途回合），与本行到 system.clickMouse 之间零 await ——
                // 并发的第二回合在落到物理世界之前即被拒（恰一次派发）。
                // 计数时序：预留 +1 → 验收通过 consume（焚毁，计数随行）/ 验收失败
                // attemptFailed（释放预留，不再重复 ++）—— 单次点击全链路 attempts 恰 +1；
                // 预算耗尽在派发前焚毁（旧实现第 maxAttempts+1 次点击仍会落到物理世界）。
                const attemptReservationStage = () => {
                    if (dangerous && approval_token) {
                        // ΠΑΝ-34（C1-2 H1）：escrow 预案 id 随预留携带 —— laneGate 已在托管道
                        // 铸得 planId（mintPlan），此前却从未传入 beginAttempt，dispatchGate
                        // 武装后（index.ts 的 armReversalEscrow）「没有预案就绝无派发预留」
                        // 的执法链在此闭合。ΠΑΝ-36：target = 坐标级完整形状（绑定令牌的
                        // 兑换面比对；未绑定令牌零行为 —— 兼容律）。
                        if (!approval.beginAttempt(approval_token, {
                            ...(laneGate.applied && laneGate.escrowPlanId !== undefined
                                ? { escrow: { planId: laneGate.escrowPlanId, semantics: laneGate.verdict.semantics } }
                                : {}),
                            target: {
                                tool: 'click_mouse', x, y,
                                ...(target_description !== undefined || expected_text !== undefined
                                    ? { target_description: target_description ?? expected_text }
                                    : {}),
                            },
                        })) {
                            approval.sweep();
                            return {
                                reserved: false,
                                blocked: JSON.stringify({
                                    status: 'ACTION_REQUIRED',
                                    state_anchor: {
                                        target: target_description ?? expected_text ?? '(undescribed target)',
                                        approval_gate: 'attempt-reservation-denied',
                                        reason: 'attempt-in-flight-or-budget-exhausted',
                                        note: 'The token is valid, but another attempt under it is still in flight, or its retry budget is exhausted.',
                                    },
                                    next_step: 'Do NOT re-invoke click_mouse concurrently with the same token — wait for the in-flight ' +
                                        'attempt to settle. If the retry budget is exhausted, call request_approval again and explain to ' +
                                        'the user why the action keeps failing.',
                                }, null, 2),
                            };
                        }
                        return { reserved: true, blocked: undefined };
                    }
                    return { reserved: false, blocked: undefined };
                };
                const reservation = attemptReservationStage();
                if (reservation.blocked !== undefined)
                    return reservation.blocked;
                attemptReserved = reservation.reserved;
                // ΑΩ-R11 阶段函数·物理派发：把点击落到物理世界（click_mouse 的世界写点）。
                const dispatchStage = () => system.clickMouse(px, py, button);
                await dispatchStage();
                // ΑΩ-R11 阶段函数·焦点登记：登记点击点为后续 type_text 的隐式上下文，
                // 凭据语义命中 ⇒ 标记敏感（后续输入将被闸门拦截）。
                // 焦点登记：后续 type_text 的区域验证将以此为中心（隐式工具间上下文）。
                // 风险感知：目标描述命中凭据语义 ⇒ 焦点标记为敏感，后续输入将被闸门拦截
                const focusRegisterStage = () => {
                    const sensitive = config.enableRiskGate
                        && !!target_description
                        && matchesRiskPatterns(target_description, config.riskPatterns);
                    focusTracker.set(x, y, sensitive);
                    return sensitive;
                };
                const sensitive = focusRegisterStage();
                // ΑΩ-R11 阶段函数·效果验证：双尺度 dHash + C-1 意图裁决（settleAndVerify），
                // 证据喂量子感知状态机。
                // ΝΩ-32 立法：settleAndVerify 的 after 帧必须新截 —— 派发后世界已变，
                // 帧票据绝不跨越派发点复用（before 帧共享是「同一派发前世界」的增量，
                // after 帧是「新世界」的测量；复用 = 用旧世界冒充新世界 = 效果验证失效，
                // 进而误焚审批令牌）。故本阶段不接票据，settleAndVerify 内部照旧自截。
                const verifyEffectStage = async () => {
                    let effect = null;
                    if (before) {
                        effect = await mouseVerify.settleAndVerify(before, {
                            adaptive: config.adaptiveSettle,
                            settleMs: config.actionSettleMs,
                            threshold: config.noopSimilarityThreshold,
                            regionRadius: config.regionVerifyRadius,
                            physicsRules: config.physicsRules,
                        }, expectation);
                    }
                    // D-3 量子感知：验证证据喂给状态机（effect=null ⇒ undefined ⇒ 不计数）
                    quantum.recordEffect(effect?.detected);
                    return effect;
                };
                const effect = await verifyEffectStage();
                // ΑΩ-R11 阶段函数·UI 记忆：验证生效 + 模型给了描述 ⇒ 写入场景记忆
                //（含当时整屏指纹；regionHash 随行入库供 from_memory_id 预验比对）。
                // ── 自动记忆：验证生效 + 模型给了描述 ⇒ 写入场景记忆（含当时整屏指纹）──
                // regionHash（点击点邻域指纹）随行入库 —— from_memory_id 的 stale-click
                // 预验依赖它：无 regionHash 的 landmark 只能查存在性，无法比对外观
                const uiMemoryStage = () => {
                    let memoryNote = '';
                    if (effect?.detected && config.autoRemember && target_description) {
                        const lm = uiMemory.remember(target_description, x, y, undefined, before?.screen, before?.region ?? undefined);
                        memoryNote = ` Landmark #${lm.id} saved.`;
                    }
                    return memoryNote;
                };
                const memoryNote = uiMemoryStage();
                // ΑΩ-R11 阶段函数·OCR 核对：语义核对预期文字是否出现在点击点邻域
                //（像素验证答「有没有变化」，语义核对答「变化是不是预期的内容」）。
                // ── 语义核对（第四轮）：OCR 检查预期文字是否出现在点击点邻域 ──
                // 像素验证回答「有没有变化」，语义核对回答「变化是不是预期的内容」
                const semanticConfirmStage = async () => {
                    if (expected_text && config.enableOcr && effect?.detected) {
                        return await semanticConfirm(effect.afterBuffer, x, y, Math.max(config.regionVerifyRadius * 1.5, 0.2), expected_text, config.ocrLang) ?? 'ocr-unavailable';
                    }
                    return null;
                };
                const semantic = await semanticConfirmStage();
                // ΑΩ-R11 阶段函数·下一步指引：双尺度判定 + C-1 意图裁决 + 预期核对
                // 合成 next_step（intentBetrayed 随出口带给验收阶段复用）。
                // ── 自适应下一步指引：双尺度判定 + C-1 意图裁决 + 预期核对 ──
                const guidanceStage = () => {
                    const noopSuspected = effect && !effect.detected;
                    const intentBetrayed = effect?.intent && !effect.intent.satisfied && effect.detected;
                    const lowConfidence = typeof confidence === 'number' && confidence < 0.6;
                    let nextStep = "MANDATORY: Call 'take_screenshot' to verify the UI state change.";
                    if (expectation?.kind === 'menu_expand' && effect?.intent && !effect.intent.satisfied) {
                        // R2-4：menu_expand 背叛的专项话术。实战病灶（R1-8 attempt9 三连）：
                        // 通用 INTENT MISMATCH 文案被无视，模型径直点菜单项坐标（菜单没开，
                        // 全部落空）。菜单未开 = 第二阶段（点菜单项）结构性不可行 —— 明令
                        // 禁止后续菜单项点击，并给出小目标 zoom 复核路径（菜单栏词形小、
                        // 全屏估坐标系统性偏移）。
                        nextStep = menuExpandBetrayedHint(effect.intent.evidence);
                    }
                    else if (intentBetrayed) {
                        nextStep = `INTENT MISMATCH: the screen changed but NOT in the expected way (${effect.intent.evidence}). ` +
                            'The click probably landed on the wrong element — treat as partial failure and re-examine.';
                    }
                    else if (noopSuspected) {
                        nextStep = 'WARNING: Neither the screen nor the clicked region changed — you may have MISSED the target. ' +
                            "Call 'zoom_inspect' around this point to refine coordinates, then retry.";
                    }
                    else if (lowConfidence) {
                        nextStep = "Low confidence reported. Consider 'zoom_inspect' for finer grounding before the next action.";
                    }
                    if (!noopSuspected && expected_change) {
                        nextStep += ` Then CONFIRM your expectation: "${expected_change}" — if it did NOT happen, treat this as a partial failure.`;
                    }
                    // R4-3（b5，证据：R1-8 a9 seq74/134）：回执 SUCCESS + effect scale=
                    // page-level 实况菜单根本未展开 —— 全屏指纹变了（环境噪声/别处动画）
                    // 而点击点邻域纹丝不动（region 未检出变化），模型一律读成「意图达成」
                    // 径直链下一步。page-level-only（region 未证实）时追加防误读注记
                    // （加法式）：页级变化可能是环境性的，链式动作前必须截图确认。
                    if (effect && effect.detected && effect.scale === 'page-level'
                        && effect.region?.effect_detected !== true) {
                        nextStep += ' CAUTION: the change was detected only at PAGE level — the clicked region itself did NOT change, ' +
                            'so this may be ambient change (animation/clock/focus ring) rather than your click taking effect. ' +
                            "Confirm the expected UI is actually present (take_screenshot) BEFORE chaining the next action.";
                    }
                    if (semantic && semantic !== 'ocr-unavailable' && !semantic.confirmed) {
                        nextStep = `SEMANTIC MISMATCH: expected text "${expected_text}" was NOT found near the click point. ` +
                            `Treat this click as FAILED even though pixels changed — re-examine with diff_view / take_screenshot.`;
                    }
                    if (sensitive) {
                        nextStep = 'SENSITIVE FIELD: this looks like a credentials/input-secret area. ' +
                            'Do NOT type secrets via type_text here — ask the USER to enter them personally, then continue with take_screenshot.';
                    }
                    return { intentBetrayed, nextStep };
                };
                const guidance = guidanceStage();
                let nextStep = guidance.nextStep;
                // ΑΩ-R11 阶段函数·验收式令牌消费：世界说「成了」才焚毁令牌
                //（B-3 两阶段 + V 纪元验收式消费；验收失败保留令牌供同授权重试）。
                // ── 阶段二（B-3 + V 纪元·验收式消费）：令牌只在验收通过时焚毁 ──
                // 验收判定 —— 世界说「成了」才算成了：
                //   验证关闭/dry-run（effect=null）⇒ 无法验收，退回派发即消费（保守：
                //     不能把「无法验收」当成「没生效」而放行无限制重试）。W6R 收口后该
                //     分支仅剩两条合法入口：dry-run（无物理世界可验）或双重显式逃生门
                //     （verifyActions=false 且 allowUnverifiedDangerous=true）—— 仅
                //     verifyActions=false 已在派发前被拒（effect-verification-required）；
                //   effect.detected=false ⇒ 点击未生效（点空/落错窗口）—— 世界没有发生
                //     不可逆变化，用户的同意未被消耗，令牌保留供同一授权内自动重试；
                //   intentBetrayed / semantic mismatch ⇒ 世界变了但不是预期的 —— 同样
                //     保留令牌让模型纠正后重试。
                // 一次用户确认覆盖整个任务：验收失败 ⇒ attemptFailed 登记（TTL 续期，
                // 次数递减），重试不再打扰用户；预算耗尽/超期 ⇒ 焚毁，重新审批。
                const acceptanceStage = () => {
                    let acceptance;
                    if (dangerous && approval_token) {
                        const semanticMismatched = !!(semantic && semantic !== 'ocr-unavailable' && !semantic.confirmed);
                        if (!effect) {
                            // 验证通道关闭（dry-run 或双重逃生门）：无从验收，维持旧方言（派发即消费，用后即焚）
                            // ΠΑΝ-36：坐标级 targetHint（绑定令牌的兑换面比对 —— 与 beginAttempt 同一形状）
                            consumeApprovalWithHint(approval_token, { tool: 'click_mouse', x, y, target_description: target_description ?? expected_text });
                            acceptance = {
                                verdict: 'unverified-dispatch-consumed',
                                detail: 'Effect verification unavailable (dry-run, or verifyActions=false + ' +
                                    'allowUnverifiedDangerous=true escape hatch); token consumed on dispatch.',
                            };
                        }
                        else if (!effect.detected) {
                            const r = approval.attemptFailed(approval_token, 'no-effect');
                            acceptance = r.valid
                                ? {
                                    verdict: 'retry-allowed', reason: 'no-effect', remaining_attempts: r.remainingAttempts,
                                    detail: 'No verified world change — the click did NOT take effect (missed target / wrong window). ' +
                                        `Token STILL VALID (${r.remainingAttempts} attempts left): fix coordinates or focus and RETRY within the SAME approval. ` +
                                        'Do NOT ask the user again — their consent covers this task until a verified effect.',
                                }
                                : {
                                    verdict: 'budget-exhausted', reason: 'no-effect',
                                    detail: 'Retry budget exhausted with no verified effect. The token is void. ' +
                                        'Call request_approval again and explain to the user why the action keeps failing.',
                                };
                        }
                        else if (guidance.intentBetrayed || semanticMismatched) {
                            const reason = semanticMismatched ? 'semantic-mismatch' : 'intent-betrayed';
                            const r = approval.attemptFailed(approval_token, reason);
                            acceptance = r.valid
                                ? {
                                    verdict: 'retry-allowed', reason, remaining_attempts: r.remainingAttempts,
                                    detail: 'The screen changed but NOT in the expected way — the click probably landed on the wrong element. ' +
                                        `Token STILL VALID (${r.remainingAttempts} attempts left): re-examine and RETRY within the SAME approval. ` +
                                        'Do NOT ask the user again.',
                                }
                                : {
                                    verdict: 'budget-exhausted', reason,
                                    detail: 'Retry budget exhausted with repeated wrong-element clicks. The token is void. ' +
                                        'Call request_approval again and explain to the user what keeps going wrong.',
                                };
                        }
                        else {
                            // 验收通过：世界出现了变化且与预期一致（或无更严苛的期望可核对）
                            // ΠΑΝ-36：坐标级 targetHint（绑定令牌的兑换面比对 —— 与 beginAttempt 同一形状）
                            consumeApprovalWithHint(approval_token, { tool: 'click_mouse', x, y, target_description: target_description ?? expected_text });
                            acceptance = {
                                verdict: 'verified',
                                detail: 'Verified world change consistent with the expectation — user consent consumed by this irreversible effect. ' +
                                    'Report the acceptance result to the user.',
                            };
                        }
                    }
                    return acceptance;
                };
                const acceptance = acceptanceStage();
                // ΑΩ-R11 阶段函数·成功回执装配：重试指引前置 + SUCCESS 回执
                //（状态锚点携带全部安全链注记；输出形状逐字节保持，不迁 toolOk —— 见 execute 头注）。
                const successReceiptStage = () => {
                    // 重试指引前置：验收失败且令牌仍有效时，下一步就是纠偏重试（免二次确认）
                    if (acceptance && acceptance.verdict === 'retry-allowed') {
                        nextStep = acceptance.detail + ' ' + nextStep;
                    }
                    return JSON.stringify({
                        status: 'SUCCESS',
                        action: `Mouse ${button} clicked.`,
                        state_anchor: {
                            normalized: { x, y },
                            absolute_pixels: { x: px, y: py },
                            screen_resolution: `${size.width}x${size.height}`,
                            effect: effect ? {
                                detected: effect.detected,
                                scale: effect.scale, // page-level / element-level / none
                                screen_similarity_pct: effect.screen.similarity_pct,
                                region_similarity_pct: effect.region ? effect.region.similarity_pct : undefined,
                                // C-1 意图裁决：期望 kind + 物理证据（与 detected 分歧 = 高级幻觉警报）
                                intent: effect.intent ?? undefined,
                            } : 'verification-off',
                            expected_change: expected_change || undefined, // 预期锚定：模型行动前声明的预期
                            sensitive_focus: sensitive || undefined, // 风险闸门：焦点已标记为凭据区
                            // J 纪元：审批网覆盖情况透明化（described / blind-spot / gate-disabled）
                            approval_gate: gateCoverage,
                            // Ρ 纪元：双钥公证参与情况透明化（engaged/degraded + 各通道在场情况；
                            // 总开关关 ⇒ 键不入场 —— 完全旧路径）
                            notarization: notarization || undefined,
                            // Β 纪元：反驳法院参与情况透明化 —— 'upheld' = 异构第二脑认真反驳后
                            // 维持「目标=描述」；uncertain/缺席 ⇒ 键不入场（缺席审判零行为，
                            // 输出与法院关闭时同路）
                            refute: refuteStamp || undefined,
                            // W2-2（S3）：接地新鲜度探针判决（dangerous 令牌路径在场）。W6R 后
                            // degraded 只在逃生门（allowUnverifiedDangerous=true）下才能到达成功
                            // 路径 —— 缺席即拒绝（fail-closed），这里的 degraded 是逃生门下的
                            // 诚实观测面（模型/遥测仍看得见防御缺席）
                            freshness: freshnessStamp || undefined,
                            // W5-0（C 接线）：可逆性分道注记（快道/托管道 + 预案 id；未分道缺席）
                            reversibility_lane: laneAnchorOf(laneGate),
                            // W2-2（W1-2）：批注修正透明化 —— 用户批注把计划修正成了什么
                            amendment: amendment.stamp || undefined,
                            // V 纪元：验收裁决 —— verified（通过，令牌已焚毁）/ retry-allowed
                            // （未生效，令牌保留，重试免确认）/ budget-exhausted（预算耗尽，需重新审批）
                            acceptance: acceptance || undefined,
                            semantic: semantic
                                ? (semantic === 'ocr-unavailable'
                                    ? 'ocr-unavailable'
                                    : { expected_text: expected_text, confirmed: semantic.confirmed, region_text_snippet: semantic.snippet })
                                : undefined,
                        },
                        memory: memoryNote || undefined,
                        next_step: nextStep,
                        // 预验结果透明化：本次点击是否经过 from_memory_id 外观比对
                        pre_verified: preVerified === undefined ? undefined : { landmark: from_memory_id, appearance_match: true },
                    }, null, 2);
                };
                return successReceiptStage();
            }
            catch (error) {
                // B-3 注：异常路径不烧审批令牌（validate 只查不烧；consume 仅在成功 return 前调用）
                // Δ 纪元（审计#2）：已预留的尝试在此结算（attemptFailed 只释放预留、不重复
                // 计数）—— 令牌保留、TTL 续期，B-3 的「异常后同令牌重试」语义原样保持。
                if (attemptReserved && approval_token)
                    approval.attemptFailed(approval_token, 'dispatch-exception');
                return toolErr(`Mouse ${button} click at (${x}, ${y}) failed.`, error.message, 'Analyze the error and try a different approach; if an approval_token was used it is still valid for one retry.');
            }
        },
    });
}
