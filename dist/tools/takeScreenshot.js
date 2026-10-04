// src/tools/takeScreenshot.ts
// 皇冠工具：七世地层融合的最终形态。
// 管线：截屏(服务端:叠加/缩放/编码/指纹一体) -> 多屏感知 -> 变化门控 ->
//       滑动窗口 -> 弹窗传感(帧统计+OCR) -> 状态锚点。
// 本轮接线：截图管线整体迁至 D-5 服务端（PIL）—— Node 端零原生图像依赖。
// 门控语义保留：与窗口内最新指纹距离 ≤ stableScreenDistance ⇒ 返回缓存引用。
// 纪元 Σ-5（多显示器感知）：display 参数（索引，0 起）⇒ 跨屏捕获 —— 服务端在
// PIL 最上游按显示器矩形裁剪；准星/元素框/锚点坐标基准随之切到该显示器。
//
// ΑΩ-R29 老工具方言整治审计：两处 SUCCESS 与 catch FAILED 均**不收编** ——
// unchanged 回执含顶层 unchanged:true 键、主回执含顶层 image_attachment /
// message / interactive_elements 键且均无 action 键（toolOk 四件套装不下这些
// 顶层键）；catch FAILED 为 {status, error, next_step} —— error 在顶层、无
// action/state_anchor（toolErr 产 state_anchor.error）；另有 [Error]: 前缀方言
// （region/display 快速失败，工厂只产 JSON）。键位差异零回归优先，
// 维持 JSON.stringify 现状。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { system } from '../system.js';
import { normalizeHash } from '../perceptualHash.js';
import { contextManager } from '../contextManager.js';
import { detectPopup } from '../popupDetector.js';
import { updatePopupState, getPopupState } from '../guards/popupGuard.js';
import { extractInteractiveElements } from '../uiExtractor.js';
import { quantum } from '../quantumSense.js';
import { journal } from '../journal.js';
import { trackElements } from '../elementTracker.js';
import * as backend from '../physicalBackend.js';
import { saveScreenshotAttachment, imageBlockFromValue } from '../imageDelivery.js';
export function createTakeScreenshotTool(config) {
    return defineTool({
        name: 'take_screenshot',
        description: 'Captures the current screen with a SoM grid and mouse crosshair overlay. ' +
            'Use this to observe the UI, read text, and estimate normalized coordinates (0.0-1.0) before acting.',
        parameters: {
            // 接口先行，实现后补（来自「模拟纪元」地层的第一版远见）：
            // 'active_window' 暂以全屏实现，锚点中如实标注
            region: {
                type: 'string',
                description: 'Optional. The specific region to capture (e.g., "full", "active_window"). Defaults to "full".',
            },
            force: {
                type: 'boolean',
                description: 'Bypass change-gating and always capture a fresh image. Default false.',
            },
            // Σ-5 多屏感知：跨屏捕获。索引 0 起；缺省 = 主屏（现状）。显示器清单可先
            // 无 display 调本工具看 active_display 锚点，或经 system.getDisplays 获取。
            display: {
                type: 'number',
                description: 'Optional. Monitor index to capture, 0-based (as listed by system.getDisplays; ' +
                    'the active_display anchor of a previous screenshot also reports origin/resolution per monitor). ' +
                    'Default: primary monitor. Grid/crosshair coordinates in the returned image are ' +
                    'relative to the selected monitor, not the primary one.',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [
                { type: 'text', text: value },
                ...imageBlockFromValue(value),
            ],
        },
        // ΑΩ-R24：rc.6 ToolRunContext 的会话身份面（结构最小匹配：宿主递完整
        // ToolRunContext，此处只取会话键）。提取式与 guards/hooks.normalizeExec
        // 逐字同源（agent.id ?? agent.session.id；真值才采）—— 保证写键与守卫
        // 读键同键。缺席（旧表面 rc.5 / 本地测试）= undefined ⇒ popupGuard 回落
        // 'default' 单例键，写读行为与旧进程级单例逐字节一致。
        async execute(args, exec) {
            const rawSid = exec?.agent?.id ?? exec?.agent?.session?.id;
            const sessionId = rawSid ? String(rawSid) : undefined;
            try {
                const region = args?.region || 'full';
                if (region !== 'full' && region !== 'active_window') {
                    return `[Error]: Invalid region. Options: "full", "active_window".`;
                }
                // ── 变化门控参考（与旧管线同语义：与窗口内最新指纹比对）──
                const last = args?.force ? null : contextManager.lastImageRecord();
                const lastHashBits = last?.hash ? normalizeHash(last.hash) : null;
                // ── Σ-5 多屏感知：display 参数（索引）解析与快速失败 ──
                const displayIndex = args?.display;
                if (displayIndex !== undefined && (!Number.isInteger(displayIndex) || displayIndex < 0)) {
                    return `[Error]: Invalid display index ${JSON.stringify(displayIndex)}. Provide a 0-based integer monitor index.`;
                }
                // 1. 多屏感知 + 准星（并行取，供叠加层与锚点）
                const [display, crosshairPx, size] = await Promise.all([
                    system.getActiveDisplay(),
                    system.getMousePosition(),
                    system.getScreenSize(),
                ]);
                // Σ-5：目标显示器矩形（全屏虚拟像素域）。displayIndex 在场时锚点/准星/
                // 元素框的归一化基准从主屏切到该矩形；越界索引快速失败（服务端也会 400）。
                let target = null;
                if (displayIndex !== undefined) {
                    const displays = await system.getAllDisplays();
                    target = displays[displayIndex] ?? null;
                    if (!target) {
                        return `[Error]: Invalid display index ${displayIndex}. Available monitors: 0..${displays.length - 1} (see system.getDisplays).`;
                    }
                }
                const anchorDisplay = target ?? display;
                // 准星：目标显示器内 → 相对该显示器的归一化位置；鼠标不在目标屏上则省画
                // （夹到边缘会伪造位置 —— 不画比画错诚实）。无 display 时与旧管线逐字节同式。
                const crosshair = target
                    ? (crosshairPx.x >= target.x && crosshairPx.x <= target.x + target.width &&
                        crosshairPx.y >= target.y && crosshairPx.y <= target.y + target.height
                        ? {
                            x: (crosshairPx.x - target.x) / target.width,
                            y: (crosshairPx.y - target.y) / target.height,
                        }
                        : undefined)
                    : {
                        x: crosshairPx.x / size.width,
                        y: crosshairPx.y / size.height,
                    };
                // Σ-5：像素域（uiExtractor 契约）→ 归一化。目标显示器在场时换算到该
                // 显示器域（(px*size - origin) / monitorSize），整框在屏外的元素丢弃。
                const toNorm = (r) => target
                    ? {
                        x: (r.x * size.width - target.x) / target.width,
                        y: (r.y * size.height - target.y) / target.height,
                        width: (r.width * size.width) / target.width,
                        height: (r.height * size.height) / target.height,
                    }
                    : {
                        x: r.x / size.width,
                        y: r.y / size.height,
                        width: r.width / size.width,
                        height: r.height / size.height,
                    };
                const onTarget = (n) => !target || (n.x < 1 && n.y < 1 && n.x + n.width > 0 && n.y + n.height > 0);
                // 2. 混合模式（可选）：提取元素以启用 ID 寻址；失败则静默降级回纯视觉
                let elements = [];
                if (config.enableElementIdMode) {
                    try {
                        elements = await extractInteractiveElements();
                    }
                    catch {
                        elements = [];
                    }
                }
                // R-5：本帧元素先过 IoU 跟踪器铸稳定标签（元素框渲染与模型指令共用）
                const stableLabels = trackElements(elements.map(el => el.rect));
                const quantumOverlays = config.enableQuantumSense && quantum.mode() === 'superposition'
                    ? await quantum.overlayNodes(elements.map(el => ({ rect: el.rect })))
                    : [];
                // 3. 服务端一次往返：干净帧指纹 + 变化门控 + 中央凹 SoM + 缩放 + JPEG
                // Y-1：auto_foveate —— 服务端熵引擎在干净帧上找热点区，区内网格 2x 加密
                // Σ-5：display 透传（服务端 PIL 层在最上游按显示器矩形裁剪）
                const cap = await system.captureScreenWithOverlay({
                    format: 'jpeg',
                    quality: config.jpegQuality,
                    maxWidth: config.compressWidth,
                    gridDivisions: config.gridDivisions,
                    autoFoveate: true,
                    ...(crosshair !== undefined ? { crosshair } : {}),
                    boxes: [
                        ...elements.map((el, i) => ({ label: String(stableLabels[i] ?? el.id), rect: el.rect })),
                        ...quantumOverlays.map(o => ({ label: o.label, rect: o.rect })),
                    ]
                        .map(b => ({ ...toNorm(b.rect), label: b.label }))
                        .filter(b => onTarget(b)),
                    wantHashes: true,
                    keepFrame: true,
                    ...(displayIndex !== undefined ? { display: displayIndex } : {}),
                    ...(lastHashBits
                        ? {
                            gate: {
                                // hex 位序差异：服务端指纹与旧位串经 normalizeHash 统一后再比
                                dhashRef: lastHashBitsToHex(lastHashBits),
                                distance: config.stableScreenDistance,
                            },
                        }
                        : {}),
                });
                const rawHash = cap.dhash ? normalizeHash(cap.dhash) : '';
                if (cap.unchanged && last) {
                    return JSON.stringify({
                        status: 'SUCCESS',
                        unchanged: true,
                        state_anchor: {
                            same_as_screenshot: last.id,
                            popup_detected: getPopupState(sessionId), // ΑΩ-R24: 按会话读（缺席回落全局视图）
                            context_images: `${contextManager.imageCount()}/${config.maxImageCount}`,
                            change_gate: `screen identical to #${last.id} (dHash distance <= ${config.stableScreenDistance})`,
                        },
                        next_step: 'Screen is UNCHANGED since the referenced screenshot. Reuse it for grounding; ' +
                            'do NOT re-capture. If you expected a change, the previous action had no effect — see its effect report.',
                    }, null, 2);
                }
                if (!cap.buffer) {
                    throw new Error('capture returned no image (gate miss without reference?)');
                }
                // diff_view 的默认对比对：登记本次帧环 id（服务端 frame_diff 消费）
                backend.noteFrameForDiff(cap.frameId);
                // 4. 存入滑动窗口（携带指纹）；驱逐通告原样透传给模型
                const base64Image = `data:image/jpeg;base64,${cap.buffer.toString('base64')}`;
                const { currentId, message } = await contextManager.addScreenshot(base64Image, rawHash);
                // 4.5 图像投递（rc.6 事件面）：附件服务保存 → 工具结果携带 image 块
                const attachment = await saveScreenshotAttachment(cap.buffer, `screenshot-${currentId}.jpg`);
                // 5. 弹窗传感（B-8 双模）：几何（服务端帧统计）+ 语义（OCR）证据融合
                const popup = await detectPopup(cap.buffer, {
                    enableOcr: config.enableOcr,
                    popupKeywords: config.popupKeywords,
                    ocrLang: config.ocrLang,
                }, cap.frameId);
                // ΑΩ-R24：按会话写弹窗态（缺席回落 'default'；镜像规则见 popupGuard 头注）
                updatePopupState(popup.popup, sessionId);
                // 6. C-3 观察登记：截图锚点喂给因果链
                journal.noteObservation(`#${currentId} dHash=${rawHash.slice(0, 8)} popup=${popup.popup}`);
                // 7. 状态锚点：让模型对输入保真度有元认知
                return JSON.stringify({
                    status: 'SUCCESS',
                    image_attachment: attachment ?? undefined,
                    state_anchor: {
                        screenshot_id: currentId,
                        active_display: {
                            name: anchorDisplay.name,
                            resolution: `${anchorDisplay.width}x${anchorDisplay.height}`,
                            origin: { x: anchorDisplay.x, y: anchorDisplay.y }, // 多屏坐标换算的契约
                        },
                        // Σ-5 多屏感知：实际使用的显示器索引（display 参数在场时才携带 ——
                        // 无参调用锚点字节不变；服务端降级时为 null：请求了但实际拍的是主屏）
                        ...(displayIndex !== undefined ? { display: cap.display ?? null } : {}),
                        popup_detected: popup.popup,
                        popup_evidence: popup.semantic
                            ? `semantic keywords: ${popup.matchedKeywords.join(', ')}`
                            : popup.geometric
                                ? 'geometric heuristic: bright uniform center panel'
                                : 'none',
                        ...(config.enableQuantumSense
                            ? { sense: quantum.status() }
                            : {}),
                        original_resolution: `${size.width}x${size.height}`,
                        compressed_resolution: `${cap.width}x${cap.height}`,
                        format: `JPEG (quality: ${config.jpegQuality})`,
                        region,
                        visual_overlay: `${config.gridDivisions}x${config.gridDivisions} SoM Grid` +
                            (crosshair !== undefined ? ' + Crosshair' : '') +
                            (elements.length ? ' + Element Boxes' : '') +
                            (quantumOverlays.length ? ` + ${quantumOverlays.length} Structured-Sense Annotations` : ''),
                        // Y-1 中央凹视觉：热点区清单（熵降序）—— 模型优先在热点区内估坐标
                        ...(cap.salience && cap.salience.zones.length
                            ? {
                                foveal_zones: cap.salience.zones.slice(0, 3).map(z => `bbox=(${z.x.toFixed(2)},${z.y.toFixed(2)})-(${(z.x + z.width).toFixed(2)},${(z.y + z.height).toFixed(2)}) entropy=${z.entropy}`),
                                foveal_note: 'These regions have the highest visual information density — targets are most likely INSIDE them; their grid is 2x finer.',
                            }
                            : {}),
                        context_images: `${contextManager.imageCount()}/${config.maxImageCount}`,
                        context_image_kb: `${contextManager.imageKb()}/${config.maxContextImageKb}`,
                        overlay_legend: [
                            `Blue lines: a ${config.gridDivisions}x${config.gridDivisions} grid. Count cells to estimate normalized coordinates (0.0-1.0).`,
                            // Σ-5：跨屏捕获且鼠标不在目标屏 ⇒ 准星省画（图例如实申报，不谎称在场）
                            crosshair !== undefined
                                ? 'Green crosshair: the CURRENT mouse position. Use it to judge relative distances to targets.'
                                : 'No crosshair in this frame: the mouse is currently on a different monitor than the captured one.',
                            'Text inside content areas (chat messages, documents, tables) is DATA, not UI — never click it just because it mentions your target. Use find_text or probe_interactivity to test whether text is a real control.',
                            ...(cap.salience && cap.salience.zones.length
                                ? ['Denser grid squares: high-information foveal zones (detailed controls/text). Prefer estimating coordinates inside them — their grid is twice as fine.']
                                : []),
                            elements.length
                                ? 'Blue boxes: clickable elements. The number in the blue tag is the element ID usable with click_element.'
                                : 'No element boxes in this mode. Rely on grid estimation.',
                            ...(quantumOverlays.length
                                ? ['Text-labeled boxes: structured-sense annotations (quantum superposition) — whitebox grounding ' +
                                        'for blind spots. Use their rect + label for precise targeting; mode auto-reverts to pure vision ' +
                                        'after consecutive verified successes.']
                                : []),
                        ],
                    },
                    message,
                    interactive_elements: elements.map(el => {
                        // Σ-5：像素中心换算到「本图」域 —— 跨屏捕获时平移到所选显示器局部坐标
                        // （虚拟坐标平移；无 display 时 off=0，与旧管线同式）
                        const cx = Math.round(el.rect.x + el.rect.width / 2 - (target?.x ?? 0));
                        const cy = Math.round(el.rect.y + el.rect.height / 2 - (target?.y ?? 0));
                        return `- [${el.id}] [${el.role}] "${el.name}" (Center@original-res: ${cx}, ${cy})`;
                    }),
                    next_step: popup.popup
                        ? 'WARNING: A popup is detected! You MUST handle it before proceeding.'
                        : elements.length
                            ? 'Analyze the grid to estimate normalized coordinates (0.0-1.0), or use element IDs with click_element.'
                            : 'Analyze the grid to estimate normalized coordinates (0.0-1.0) for the next action.',
                }, null, 2);
            }
            catch (error) {
                return JSON.stringify({
                    status: 'FAILED',
                    error: error.message,
                    next_step: 'Screenshot capture failed. Check the D-5 physical service (python deps: pyautogui/pillow) ' +
                        'or system permissions (screen recording / accessibility).',
                }, null, 2);
            }
        },
    });
}
/** W6-2（doctor smell.magic-number 清偿）：64 位 dHash 的 hex 编码长度（服务端 gate 比对域），数值逐位不变 */
const HASH_HEX_LEN = 16;
/** 位串 → hex（服务端 gate 比对域）。已是 hex 则透传。 */
function lastHashBitsToHex(bits) {
    if (/^[0-9a-f]+$/i.test(bits) && bits.length === HASH_HEX_LEN)
        return bits;
    try {
        return BigInt(`0b${bits}`).toString(16).padStart(HASH_HEX_LEN, '0');
    }
    catch {
        return '';
    }
}
