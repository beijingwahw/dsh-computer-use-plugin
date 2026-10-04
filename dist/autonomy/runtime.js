// src/autonomy/runtime.ts
// W6-1 结构性保留登记（smell.over-engineering）：createExecute 巨型闭包的原注记。
// ΑΩ-R12（W6-1 保留登记的就地清偿）：createExecute 的按 kind 分支已拆为具名
// 处理器（click/type/scroll/hotkey/drag/inspect/ask_vlm/recall_skill/macro/
// declare/wait 与 default），公共前置（坐标换算/采样稳态门）与公共后置（三区
// 判决/记账/不动作族诚实账）提为共享小函数 —— 处理器为闭包内本地函数，环内
// 状态（verifiedCount/vlmBudget/探针/焦点源）仍就地织成、不经参数传递重构，
// 各 case 体原位搬迁调用序不变：行为与导出面逐字节保持。
// 纪元 Φ（真实运行时适配层）：把十器官的纯决策世界接到真实躯体 —— 截屏、指纹、
// OCR、云脑接地、system 键鼠。Φ-4 闭环只消费 perceive/execute 两个函数面，
// 本模块就是这两个函数面的铸造厂：
//   · createPerceive：截屏 → (dhash, 宽高, OCR 词, VLM 元素可选) → composeSnapshot
//   · createExecute：PolicyAction → system 键鼠/云脑问答 → 再截屏验证 → StepOutcome
// 全部依赖可注入（RuntimeDeps）—— 离线测试注入假截屏序列/假 OCR/假云脑，
// 缺省走真实管线（physicalBackend 截屏、perceptualHash 指纹、textReader 词级
// OCR、vlm/grounding 云脑接地、system 键鼠）。
// 铁律：具名导出、绝不抛异常（一切失败收敛为 error 结局或降级记 degraded）、
// system 调用方式逐字模仿 clickMouse.ts / typeText.ts（像素/归一化换算同律）。
//
// W8-B2（doctor smell.over-engineering 清偿 · D-F2 千行文件群）：低风险分区已
// 拆至兄弟文件（actionVerifier W6-2 先例 —— 纯类型/纯函数/自包含铸造厂整体
// 搬迁，本文件以再导出保持导入面不变，消费方零改动、行为零漂移）：
//   · runtime.types.ts    契约类型区（宏动作方言 / RuntimeWord / ExecOutcome 等）
//   · runtime.deps.ts     RuntimeDeps 依赖注入契约（W8-B2 新增 verifyTaskId 注入位）
//   · runtime.tuning.ts   W1-1 执行层节奏与阈值参数面（W1ExecTuning / W1_EXEC_TUNING）
//   · runtime.verdict.ts  W1-1 纯函数工具区（汉明距离/落点/网格步进/ROI 三区判决）
//   · runtime.perceive.ts 感知铸造厂（createPerceive + 缺省 OCR/云脑接地工厂）
//   · runtime.utils.ts    内部纯工具（异常归因/夹取/折叠/note 截断 —— 家族内部面）
// createExecute 拆分史：W8-B2 时按 W6-1 登记整段留守本文件（闭包状态织成）；
// ΑΩ-R12 就地清偿 —— 分支拆为闭包内具名处理器（见顶部注释），文件仍是铸造厂。
import * as backend from '../physicalBackend.js';
import { system } from '../system.js';
import { getSharp } from '../_legacyDeps.js';
import { dhash } from '../perceptualHash.js';
import { skillLibrary } from '../skillLibrary.js';
import { getGlmClient, isGlmConfigured } from '../vlm/glmClient.js';
import { encodeForVlm, VlmBudget } from '../vlm/codec.js';
import { composeSnapshot, snapshotChanged } from './worldSnapshot.js';
import { estimateRowShift, stillTranslating } from '../motionEstimator.js';
import { kernelRegistry } from '../kernel/registry.js';
import { contextManager } from '../contextManager.js';
// W4-1（A1 技能宏重放执行接线）：宏执行器 —— 解析/排练门禁/重锚定/抽查节奏
import { executeMacro, macroTraceSummary, } from '../macroExecutor.js';
export { W1_EXEC_TUNING } from './runtime.tuning.js';
export { w1HashDistance, pickClickPoint, gridRetryOffsets, combineRoiVerdict } from './runtime.verdict.js';
export { createPerceive } from './runtime.perceive.js';
// 家族内部面（拆分前为模块私有 —— 不进公共导出，公共面零漂移）
import { errText, clamp01, clipNote, CRITERIA_SPOT_PERIOD, DEFAULT_SCROLL_AMOUNT } from './runtime.utils.js';
// W9-1（D-G9 收口）：判据核对单一器官 —— runtime 主路径整体换用 criteriaEval
//（肯定面 fuzzy 容错 + 否定面证伪 + 语料缺席诚实降级，全走同一 DSL 同一器官）
import { evaluateCriteria, buildCriteriaPairs } from './criteriaEval.js';
import { finiteOrNull, w1HashDistance, pickClickPoint, gridRetryOffsets, combineRoiVerdict, judgeRoiOcr } from './runtime.verdict.js';
import { makeDefaultReadWords } from './runtime.perceive.js';
import { W1_EXEC_TUNING } from './runtime.tuning.js';
// ─── 执行铸造厂 ───
/**
 * 铸造 execute(action)：动作映射律 + 执行后验证 + 判据抽查。
 *
 * 动作映射律（system 调用方式逐字模仿 clickMouse.ts / typeText.ts）：
 *  · click → target.center 像素（快照坐标系）÷ 快照宽高 = 归一化 →
 *    `system.getScreenSize()` 后 `Math.round(nx * size.width)` 像素 →
 *    `system.clickMouse(px, py, 'left')`（与 clickMouse 工具同一换算链）；
 *    target 缺席 ⇒ 不动作记 no_effect（无处落点，绝不凭空点击）。
 *  · type → `system.typeText(text, clearFirst)`（payload.text 非串 ⇒ no_effect）。
 *  · scroll → `system.scroll(direction, amount)`（direction 白名单 up/down/left/right，
 *    缺省 down；amount 缺省 5 —— 与 scrollPage 工具同律）。
 *  · hotkey → `system.pressHotkey(keys)`（payload.keys 非字符串数组 ⇒ no_effect）。
 *  · ask_vlm → 截屏 + client.chat 问答，回答仅记 note（观察性动作，不改世界）；
 *    云脑缺席 ⇒ error（诚实归因，不伪答）。
 *  · recall_skill → skillLibrary.match 以 spec.goal 召回最佳；无匹配 ⇒ no_effect；
 *    命中 ⇒ 记 note（技能重放属上游职权，本执行面只报报到）。
 *  · inspect（ΑΩ-R12 落地）→ 聚焦检视：围绕检视点（target.center > payload.region
 *    中心）以 W1 tuning 的 roiRadiusPx（缺省 128px）为半径开 ROI 窗做词级 OCR
 *    读取，读到的词即信息增益（note 携带词摘要，clipNote 截断纪律沿用）——
 *    绝不移动鼠标绝不点击（零像素影响，效果验证预期「无像素影响」照旧）；
 *    OCR 端口（deps.readWords 注入位）缺席/读取失败 ⇒ 诚实降级 no_effect + 注记。
 *  · drag（ΑΩ-R12 落地）→ 起点target.center、终点 payload.end（同一快照像素
 *    坐标域）经 RuntimeDeps.drag 端口派发（接线层注入 system.dragMouse 适配，
 *    像素换算与 click 同律）；端口/坐标缺席 ⇒ 防御式降级 no_effect + 诚实注记。
 *  · declare / wait / 其余 → 不动作（declare 附带判据核对，见下）。
 *
 * W1-1（执行层四连改）—— 全部新能力经 RuntimeDeps.probe / .focus / .w1 注入，
 * 缺席即诚实降级，行为与接线前逐字节一致：
 *  · A2 三区判决验证：click/type 以动作点（或外推焦点）约 roiRadiusPx 半径 ROI
 *    的区域 dhash、frameDiff 变化区与预期区域的交叠、ROI 内 OCR 词三证判进展；
 *    全屏变而 ROI 三证皆无 ⇒ 判噪声（no_effect，防时钟/闪烁假阳性）；探针
 *    缺席 ⇒ 回退全屏 dhash（degraded 记 'roi'）。
 *  · A3 动作前预检：hitTest 判纯文本（非 Edit）且光标无 hand 反证 ⇒ 免截屏短路
 *    no_effect；外推焦点已在目标 ⇒ 跳过点击；探针失败/不支持 ⇒ 放行降级。
 *  · A4 不确定性感知落点：大框点词级 bbox 质心（文字重心）、小框向中心收缩
 *    20%；miss 后 3×3 去中心网格步进重试（最多 8 邻位，ROI 验证命中即停）。
 *  · A5 稳态门控节奏：动作后不固定等待 —— 连续两帧（约 steadyPollMs 间隔）
 *    全屏 dhash 汉明 ≤ steadyHamming 判稳放行；steadyTimeoutMs 强制放行记
 *    degraded；滚动场景用 motionEstimator 判内容是否仍平移。
 *
 * 执行后验证（世界动作与 ask_vlm/recall_skill 命中后）：三区判决（探针在场）
 * 或全屏 snapshotChanged（降级）⇒ progress / no_effect；异常 ⇒ error。
 * before 帧取 lastSnapshotRef（感知快照）；槽缺席时现场补拍（独立使用亦正确）。
 *
 * 判据抽查（成本克制）：OCR 全文（readWords 拼接）对 spec.successCriteria 走
 * criteriaEval.evaluateCriteria 单一器官（W9-1 · D-G9 收口）—— 肯定判据
 * 精确 ∪ fuzzy（⌈m/6⌉ 容错、<3 字符短模式只走精确）命中 ⇒ met；否定判据
 * （mustNotAppear:/不得出现： 前缀）命中禁词 ⇒ violated、在场未命中 ⇒ met；
 * 语料缺席 ⇒ 诚实降级零证据。仅 declare 步（用感知快照的 textDigest，零额外
 * 截屏）与每 3 个已验证步（用验证帧的 OCR）抽查；肯定判据未命中不产生
 * violated（宁缺毋错 ——「没找到」不是「被证伪」）。
 */
export function createExecute(deps) {
    const capture = deps.capture ?? (() => backend.captureCleanPng());
    const imageSize = deps.imageSize ??
        (async (buf) => {
            const sharp = await getSharp();
            const meta = await sharp(buf).metadata();
            return { width: meta.width ?? 0, height: meta.height ?? 0 };
        });
    const dhashOf = deps.dhashOf ??
        (async (buf) => {
            try {
                return await dhash(buf);
            }
            catch {
                return null;
            }
        });
    const readWords = deps.readWords ?? makeDefaultReadWords(deps.ocrLang);
    const now = deps.now ?? (() => Date.now());
    const sleep = deps.sleep ?? ((ms) => new Promise(resolve => { setTimeout(resolve, ms); }));
    const spec = deps.spec;
    // W1-1：节奏/阈值 —— 缺省常量 + 注入覆盖（只收非负有限数，脏值一律拒收）
    const T = { ...W1_EXEC_TUNING };
    if (deps.w1 && typeof deps.w1 === 'object') {
        for (const key of Object.keys(W1_EXEC_TUNING)) {
            const v = deps.w1[key];
            if (typeof v === 'number' && Number.isFinite(v) && v >= 0)
                T[key] = v;
        }
    }
    // W1-1（A2/A3/A5）：世界探针 —— 缺席 ⇒ 四项新能力全部降级，主路径绝不被探针阻塞
    const probe = deps.probe ?? null;
    const probeCanSample = !!(probe && typeof probe.sampleFrame === 'function');
    // W1-1（A3）：焦点源 —— 缺省禁用（哨兵远点、零全局副作用；生产接线 createExecFocusSource）
    const focusSrc = deps.focus ?? {
        predicted: () => ({ x: -9, y: -9, extrapolated: false }),
        set: () => { },
    };
    // ΝΩ-13（三修 · type 前焦点回填）：最近一次 click 派发落点（归一化）—— 焦点源
    // 禁用态（deps.focus 缺席 ⇒ 哨兵远点）下 type 的 ROI 回填证据源（「键入几乎
    // 总是落在最近一次点击处」—— focusTracker 的现实语义在执行层闭包内的本地
    // 镜像，仅记录真实派发过的点击，预检否决/焦点短路不落账）。
    let lastClickLanding = null;
    // 判据对（原文 + 原始下标）：下标锚定 spec.successCriteria 原位（recordCriterion
    // 按原数组回填）—— 过滤掉非法判据不得平移后续判据的证据下标。
    // W9-1（D-G9 收口）：判据对铸造也走单一器官（buildCriteriaPairs —— 原内联
    // 铸造的逐字节同律搬迁：非数组 ⇒ 空账；非法条目剔除但下标不平移）
    const criteria = buildCriteriaPairs(spec.successCriteria);
    /** 已验证步计数（每 3 步抽查判据的节拍器） */
    let verifiedCount = 0;
    // W2-0（D 接线）：任务级视觉预算（W1-9 C4）—— createExecute 每次铸造（runPilotLoop
    // 每 run 一 execute = 任务级生命周期）。只消费 requote 的**建议性**分档（original
    // 档不显式传参 ⇒ 缺省路径编码参数逐字节不变），绝不接 check/commit 的强制闸语义。
    const vlmBudget = new VlmBudget();
    /**
     * W9-1（D-G9 收口 · 判据证伪·极性分工红线）：判据核对整体换用
     * criteriaEval.evaluateCriteria —— 折叠子串匹配方言就此退役，判据解析
     * （mustNotAppear:/不得出现： 否定前缀）、肯定面 fuzzy 容错（fuzzy.ts
     * ⌈m/6⌉ 六字符容一错；<3 字符短模式只走精确匹配的 actionGate 同律护栏）、
     * 否定面证伪（命中禁词 ⇒ violated）、OCR 语料缺席诚实降级（零证据、
     * 否定判据绝不因「看不见」自动为真），四语义全走单一器官 —— 绝不两套
     * 方言并存（runtime 是判据核对的唯一权威器官）。
     * 行为变更面（D-G9 立法意图，显式论证）：肯定判据在 OCR 距 ≤ ⌈m/6⌉ 时也判
     * met（精确子串命中是 fuzzy 命中的真子集 —— 既有精确命中用例零回归；短模式
     * 护栏保持精确，既有严格例不弱化）；否定判据经 execute 通道也能产出 violated
     * （与 autoPilot ⑧′ 否定面复核同器官同律 —— 环内消费不改，口径差见其注释）。
     */
    const checkCriteria = (ocrText) => {
        const out = evaluateCriteria(criteria, ocrText);
        // degraded ⇒ 器官已返零证据；ExecOutcome 契约只载 index+status（polarity
        // 随行字段是器官审计面，此处投影剥离 —— 消费方 autoPilot ⑧ 按状态回填）
        return out.evidence.map(({ index, status }) => ({ index, status }));
    };
    // ─── W1-1 内部工具（全部零异常；探针失败 ⇒ null 降级，绝不阻塞主路径） ───
    /** 探针帧采样（meta-only + 可选区域指纹/keepFrame）；失败 ⇒ null */
    const safeSample = async (opts) => {
        if (!probe || typeof probe.sampleFrame !== 'function')
            return null;
        try {
            return await probe.sampleFrame(opts);
        }
        catch {
            return null;
        }
    };
    /** 探针行亮度序列；失败 ⇒ null */
    const safeRows = async (frameId) => {
        if (!probe || typeof probe.frameRowMeans !== 'function')
            return null;
        try {
            const rows = await probe.frameRowMeans(frameId, T.rowMeansGrid);
            return Array.isArray(rows) ? rows : null;
        }
        catch {
            return null;
        }
    };
    /** 探针帧差分（消毒后的区域清单）；失败 ⇒ null */
    const safeFrameDiff = async (frameA, frameB) => {
        if (!probe || typeof probe.frameDiff !== 'function')
            return null;
        try {
            const regions = await probe.frameDiff(frameA, frameB);
            if (!Array.isArray(regions))
                return null;
            const clean = [];
            for (const r of regions) {
                const x = finiteOrNull(r?.x), y = finiteOrNull(r?.y);
                const w = finiteOrNull(r?.width), h = finiteOrNull(r?.height);
                if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0)
                    continue;
                clean.push({ x, y, width: w, height: h });
            }
            return clean;
        }
        catch {
            return null;
        }
    };
    /** 全屏判变容差：与 snapshotChanged 同源读内核注册表（world.hammingTolerance） */
    const fullscreenTolerance = () => kernelRegistry.getOrDefault('world.hammingTolerance', 3);
    /** ROI 半径归一（按捕获图短边；维度未知 ⇒ 0.15 兜底，钳半屏防溢出） */
    const roiRadiusNorm = (w, h) => {
        const m = Math.min(w, h);
        return m > 0 ? Math.min(0.5, T.roiRadiusPx / m) : 0.15;
    };
    /** 当前世界维度（显式入参 > 感知快照 > 未知 0） */
    const worldDims = () => {
        const rs = deps.lastSnapshotRef?.current;
        const w = typeof deps.width === 'number' && deps.width > 0 ? deps.width :
            typeof rs?.width === 'number' && rs.width > 0 ? rs.width : 0;
        const h = typeof deps.height === 'number' && deps.height > 0 ? deps.height :
            typeof rs?.height === 'number' && rs.height > 0 ? rs.height : 0;
        return { w, h };
    };
    /**
     * W1-1（A5）：稳态门控 —— 动作后不固定等待，连续两帧（间隔 steadyPollMs）
     * 全屏 dhash 汉明 ≤ steadyHamming 即稳态放行；steadyTimeoutMs 强制放行记
     * degraded('steady-timeout')。滚动场景另用 motionEstimator 判内容是否仍
     * 平移（哈希稳但内容仍动 ⇒ 继续等）。采样失败 ⇒ 立即放行记 'steady-sample'
     * （探针故障绝不阻塞主路径）。轮询硬上限防注入时钟静止时的死循环。
     */
    const settleGate = async (opts) => {
        if (!probeCanSample)
            return { steady: true, lastSample: null, degraded: [], polls: 0 };
        const sampleOnce = () => safeSample({ keepFrame: true, ...(opts.roi ? { wantRegionHash: opts.roi } : {}) });
        const maxPolls = Math.max(1, Math.ceil(T.steadyTimeoutMs / Math.max(1, T.steadyPollMs)) + 1);
        const t0 = now();
        let prev = await sampleOnce();
        if (!prev)
            return { steady: true, lastSample: null, degraded: ['steady-sample'], polls: 0 };
        for (let polls = 1; polls <= maxPolls; polls++) {
            if (now() - t0 >= T.steadyTimeoutMs) {
                return { steady: false, lastSample: prev, degraded: ['steady-timeout'], polls: polls - 1 };
            }
            await sleep(T.steadyPollMs);
            const curr = await sampleOnce();
            if (!curr)
                return { steady: true, lastSample: prev, degraded: ['steady-sample'], polls };
            const d = w1HashDistance(prev.dhash, curr.dhash);
            const hashSteady = d === null ? true : d <= T.steadyHamming; // 指纹缺席不阻塞（宽松放行）
            let translating = false;
            if (opts.scroll && probe && typeof probe.frameRowMeans === 'function' &&
                prev.frameId != null && curr.frameId != null && prev.frameId !== curr.frameId) {
                const [ra, rb] = await Promise.all([safeRows(prev.frameId), safeRows(curr.frameId)]);
                if (ra !== null && rb !== null) {
                    translating = stillTranslating(estimateRowShift(ra, rb, T.rowShiftSearchRange));
                }
            }
            if (hashSteady && !translating)
                return { steady: true, lastSample: curr, degraded: [], polls };
            prev = curr;
        }
        return { steady: false, lastSample: prev, degraded: ['steady-timeout'], polls: maxPolls };
    };
    /**
     * W1-1（A3）：动作前预检 —— hitTest 判纯文本（非 Edit）且光标无 hand 反证 ⇒
     * 免截屏短路 no_effect；探针缺席/失败/unavailable/unknown ⇒ 放行（证据不足
     * 绝不否决）。Edit 控件虽分类 text 但可点击聚焦，不放行会断 type 流。
     */
    const precheckClick = async (px, py) => {
        if (!probe || typeof probe.hitTestPoint !== 'function')
            return { blocked: false, note: '' };
        let ht = null;
        try {
            ht = await probe.hitTestPoint(px, py);
        }
        catch {
            ht = null;
        }
        if (!ht || ht.available !== true)
            return { blocked: false, note: '' };
        if (ht.classification === 'text') {
            const ct = typeof ht.controlType === 'string' ? ht.controlType : '';
            if (/edit/i.test(ct))
                return { blocked: false, note: '' };
            // A3③ 光标形态交叉印证：hand 反证 ⇒ 物理证据优先，放行（世界说可点）
            let ck = null;
            if (typeof probe.cursorKind === 'function') {
                try {
                    ck = await probe.cursorKind();
                }
                catch {
                    ck = null;
                }
            }
            if (ck === 'hand')
                return { blocked: false, note: '' };
            return {
                blocked: true,
                note: `预检否决：hitTest 判纯文本（${ct || 'Text'}${ck ? `、光标 ${ck}` : ''}）—— 目标不可交互，免截屏短路 no_effect`,
            };
        }
        return { blocked: false, note: '' };
    };
    /**
     * W1-1（A2）：三区判决验证 —— ROI 区域指纹 / frameDiff 预期区域交叠 / ROI 内
     * OCR 词，三证任一命中 ⇒ progress；全屏变而 ROI 不动 ⇒ 噪声（不算进展）。
     * 探针证据链缺席 ⇒ 诚实降级回全屏 dhash（截屏 + snapshotChanged，行为与
     * 接线前逐字节一致，degraded 记 'roi'）。判据抽查（每 3 步）搭便车复用
     * 验证帧 OCR；区域指纹缺席时 OCR 词判据补位（A2③）。
     * ΝΩ-13（二修 · 重试期抽查去重）：spotOverride 显式覆盖抽查到期判决 ——
     * verifiedCount 不随重试递增，同一步逻辑的重试若各自按节拍器重算 spotDue，
     * 首发到期时最多 8 次重试每次都重新截屏+OCR 抽查；click 网格重试传 false
     * （抽查在首发消费一次即止），缺省（undefined）保持按节拍器推导。
     */
    const verifyOnce = async (input, spotOverride) => {
        const spotDue = typeof spotOverride === 'boolean'
            ? spotOverride
            : verifiedCount % CRITERIA_SPOT_PERIOD === 0;
        const refSnap = deps.lastSnapshotRef?.current ?? null;
        // 全屏判决：探针样本指纹优先（meta-only，零截屏）；缺席/残缺 ⇒ 旧管线回退
        let fullscreenChanged = null;
        const sampleDist = input.beforeSample && input.afterSample
            ? w1HashDistance(input.beforeSample.dhash, input.afterSample.dhash)
            : null;
        if (sampleDist !== null)
            fullscreenChanged = sampleDist > fullscreenTolerance();
        const probeCtx = !!(input.beforeSample || input.afterSample);
        // A2①：ROI 区域指纹（动作点邻域 dhash）
        let roiChanged = null;
        if (input.beforeSample && input.afterSample) {
            const d = w1HashDistance(input.beforeSample.regionDhash, input.afterSample.regionDhash);
            if (d !== null)
                roiChanged = d > T.roiHammingTolerance;
        }
        // 是否需要全帧截屏：判据抽查到期 / 探针缺席（旧管线）/ 全屏指纹残缺 /
        // 区域指纹缺席时的 OCR 补位（A2③）
        const ocrFallback = probeCtx && input.roi !== null && roiChanged === null;
        const needCapture = !probeCtx || sampleDist === null || spotDue || ocrFallback;
        let afterBuf = null;
        let afterDims = { width: 0, height: 0 };
        let afterWords = null;
        let ocrText = '';
        if (needCapture) {
            afterBuf = await capture();
            afterDims = await imageSize(afterBuf);
            if (spotDue || ocrFallback) {
                const words = await readWords(afterBuf).catch(() => []);
                afterWords = words;
                ocrText = words.map(w => (typeof w.label === 'string' ? w.label : '')).filter(Boolean).join(' ');
            }
        }
        // 旧管线回退：截屏 + composeSnapshot + snapshotChanged（与接线前同律）
        if (fullscreenChanged === null) {
            if (afterBuf === null) {
                afterBuf = await capture();
                afterDims = await imageSize(afterBuf);
            }
            const afterDhash = await dhashOf(afterBuf).catch(() => null);
            const after = composeSnapshot({
                image: afterBuf, width: afterDims.width, height: afterDims.height,
                dhash: afterDhash, ocrText, now: now(),
            });
            fullscreenChanged = snapshotChanged(refSnap, after);
        }
        // A2②：frameDiff 变化区与预期区域（归一化目标框）交叠
        let expectedHit = null;
        if (probe && typeof probe.frameDiff === 'function' && input.expectedBox &&
            input.beforeSample && input.afterSample &&
            input.beforeSample.frameId != null && input.afterSample.frameId != null &&
            input.beforeSample.frameId !== input.afterSample.frameId) {
            const regions = await safeFrameDiff(input.beforeSample.frameId, input.afterSample.frameId);
            if (regions !== null) {
                const dims = input.afterSample.width > 0 && input.afterSample.height > 0
                    ? input.afterSample
                    : input.beforeSample.width > 0 && input.beforeSample.height > 0
                        ? input.beforeSample
                        : null;
                if (dims && dims.width > 0 && dims.height > 0) {
                    const box = input.expectedBox;
                    expectedHit = regions.some(r => r.x / dims.width < box.x1 && box.x0 < (r.x + r.width) / dims.width &&
                        r.y / dims.height < box.y1 && box.y0 < (r.y + r.height) / dims.height);
                }
            }
        }
        // A2③：ROI 内 OCR 词级标签集（判据抽查便车 / 区域指纹缺席补位）
        let roiOcrChanged = null;
        if (ocrFallback && afterWords !== null && input.roi) {
            roiOcrChanged = judgeRoiOcr(refSnap, afterWords, input.roi, afterDims);
        }
        const roiCapability = roiChanged !== null || expectedHit !== null || roiOcrChanged !== null;
        const verdict = combineRoiVerdict({
            roiChanged, expectedHit, roiOcrChanged, fullscreenChanged, roiCapability,
        });
        const degradedAll = [...verdict.degraded, ...input.steadyDegraded];
        const suffixes = [];
        if (verdict.noise)
            suffixes.push('ROI 未动而全屏变化 ⇒ 判噪声（时钟/闪烁类假阳性，不算进展）');
        if (degradedAll.length > 0)
            suffixes.push(`W1降级:${degradedAll.join('/')}`);
        const result = { outcome: verdict.outcome };
        const noteBody = typeof input.note === 'string' && input.note !== '' ? input.note : '';
        if (noteBody !== '' || suffixes.length > 0) {
            result.note = clipNote([noteBody, ...suffixes].filter(s => s !== '').join('；'));
        }
        const evidence = spotDue ? checkCriteria(ocrText) : [];
        if (evidence.length > 0)
            result.criteriaEvidence = evidence;
        result.verification = {
            roiChanged, expectedHit, roiOcrChanged, fullscreenChanged,
            noise: verdict.noise, steady: input.steady, steadyPolls: input.steadyPolls,
            retries: input.retries, degraded: degradedAll,
        };
        return result;
    };
    /** 计数 + 验证（带 W1 证据上下文） */
    const verifyAfterCtx = (ctx) => {
        verifiedCount++;
        return verifyOnce(ctx);
    };
    /** 计数 + 验证（旧签名 —— ask_vlm/recall_skill 等无 ROI 语境的观察性验证） */
    const verifyAfter = (note) => {
        verifiedCount++;
        return verifyOnce({
            note, roi: null, expectedBox: null, beforeSample: null, afterSample: null,
            steady: null, steadyDegraded: [], steadyPolls: 0, retries: 0,
        });
    };
    // ─── ΑΩ-R12：动作处理器的公共前置/后置（各调用序与拆分前逐字节一致） ───
    /** 公共后置（不动作族）：零世界动作的诚实账 —— 全证据缺席（null = 不猜） */
    const bareVerification = () => ({
        roiChanged: null, expectedHit: null, roiOcrChanged: null, fullscreenChanged: null,
        noise: false, steady: null, steadyPolls: 0, retries: 0, degraded: [],
    });
    /** 公共后置（不动作族）：no_effect + 一句注记 + 全缺席验证明细 */
    const noWorldAction = (note) => ({
        outcome: 'no_effect',
        note,
        verification: bareVerification(),
    });
    /**
     * 公共管线（世界动作 type/scroll/hotkey/drag 共用）：before 采样（探针在场
     * 携 ROI 区域指纹）→ 派发 → 稳态门（A5）→ 三区判决 + 记账（A2，verifiedCount
     * 只在派发成功后递增 —— dispatch 抛错 ⇒ 原样上抛交外层 error 收口，计数
     * 不虚增，与拆分前各 case 的调用序逐字节一致）。
     */
    const dispatchVerified = (note, roi, opts) => {
        return (async () => {
            const beforeSample = await safeSample({ keepFrame: true, ...(roi ? { wantRegionHash: roi } : {}) });
            await opts.dispatch();
            const gate = probeCanSample ? await settleGate({ roi, scroll: opts.scroll }) : null;
            return verifyAfterCtx({
                note, roi, expectedBox: null,
                beforeSample, afterSample: gate ? gate.lastSample : null,
                steady: gate ? gate.steady : null, steadyDegraded: gate ? gate.degraded : [],
                steadyPolls: gate ? gate.polls : 0, retries: 0,
            });
        })();
    };
    /**
     * 公共前置（坐标换算链前端）：快照像素 → 归一化（÷ 快照宽高，clamp01 卫兵）
     * → 屏幕像素（Math.round(nx * size.width) —— 与 clickMouse 工具同一换算律）。
     */
    const toScreenPoint = (sx, sy, w, h, size) => {
        const nx = clamp01(sx / w);
        const ny = clamp01(sy / h);
        return { nx, ny, px: Math.round(nx * size.width), py: Math.round(ny * size.height) };
    };
    /**
     * 公共前置（坐标系维度优先链）：显式入参 > 感知快照宽高（元素坐标的原生
     * 坐标系）> 调用方兜底（click/drag 为屏幕尺寸 —— 视捕获图与屏幕同幅；
     * inspect 为捕获图自身维度）。
     */
    const coordDims = (refSnap, fallback) => ({
        w: typeof deps.width === 'number' && deps.width > 0
            ? deps.width
            : typeof refSnap?.width === 'number' && refSnap.width > 0 ? refSnap.width : fallback.width,
        h: typeof deps.height === 'number' && deps.height > 0
            ? deps.height
            : typeof refSnap?.height === 'number' && refSnap.height > 0 ? refSnap.height : fallback.height,
    });
    // ── W4-1（A1 技能宏重放执行接线）：宏执行的运行时宿主面 ──
    /** W4-1：感知快照元素 → 归一化锚点（重锚定 + 排练场景的共同证据源） */
    const macroAnchors = () => {
        const snap = deps.lastSnapshotRef?.current ?? null;
        if (!snap || !Array.isArray(snap.elements) || snap.width <= 0 || snap.height <= 0)
            return [];
        return snap.elements
            .filter(el => el && typeof el.label === 'string' && el.label.trim() !== '')
            .map(el => {
            const b = el.bbox;
            return {
                label: el.label,
                bbox: {
                    x0: Math.min(b.x0, b.x1) / snap.width,
                    y0: Math.min(b.y0, b.y1) / snap.height,
                    x1: Math.max(b.x0, b.x1) / snap.width,
                    y1: Math.max(b.y0, b.y1) / snap.height,
                },
            };
        });
    };
    /**
     * W4-1：宏单步派发（system 键鼠 —— click/type case 的映射律宏方言）。
     * 坐标已由宏执行器重锚定为归一化值，此处只做 归一化 → 屏幕像素 的换算
     *（Math.round(nx * size.width)，与 clickMouse 工具同一换算链）。
     * 沙箱词汇表外的宿主工具（switch_tab 等）⇒ 诚实 unresolved（不派发）。
     */
    const macroDispatch = async (step) => {
        const a = step.args ?? {};
        switch (step.tool) {
            case 'click_mouse': {
                if (typeof a.x !== 'number' || !Number.isFinite(a.x) || typeof a.y !== 'number' || !Number.isFinite(a.y)) {
                    return { ok: false, note: 'click 步坐标缺席 —— 不派发' };
                }
                const size = await system.getScreenSize();
                const px = Math.round(Math.min(1, Math.max(0, a.x)) * size.width);
                const py = Math.round(Math.min(1, Math.max(0, a.y)) * size.height);
                await system.clickMouse(px, py, 'left');
                focusSrc.set(Math.min(1, Math.max(0, a.x)), Math.min(1, Math.max(0, a.y)));
                return { ok: true, note: `点击像素 (${px}, ${py})` };
            }
            case 'type_text': {
                if (typeof a.text !== 'string' || a.text.length === 0) {
                    return { ok: false, note: 'type 步 text 缺席 —— 不派发' };
                }
                await system.typeText(a.text, a.clearFirst === true);
                return { ok: true, note: `键入 ${a.text.length} 字符` };
            }
            case 'scroll_page': {
                const dirMap = {
                    up: 'up', down: 'down', left: 'left', right: 'right',
                };
                const dir = dirMap[typeof a.direction === 'string' ? a.direction : 'down'];
                if (!dir)
                    return { ok: false, note: 'scroll 步方向非法 —— 不派发' };
                const amount = typeof a.amount === 'number' && Number.isFinite(a.amount) && a.amount >= 1
                    ? a.amount : DEFAULT_SCROLL_AMOUNT;
                await system.scroll(dir, amount);
                return { ok: true, note: `滚动 ${dir} ${amount} 行` };
            }
            case 'press_hotkey': {
                const keys = Array.isArray(a.keys) ? a.keys.filter((k) => typeof k === 'string' && k.trim() !== '') : [];
                if (keys.length === 0)
                    return { ok: false, note: 'hotkey 步 keys 缺席 —— 不派发' };
                await system.pressHotkey(keys);
                return { ok: true, note: `按键 ${keys.join('+')}` };
            }
            default:
                return { ok: false, note: `工具「${step.tool}」在宏派发面无系统映射（unresolved）` };
        }
    };
    /**
     * W4-1：dhash 抽查（链内节奏 —— 每 2 步一次，跳过逐步 VLM 决策）。
     * 证据优先级：探针 meta-only 采样（零截屏）> 验证截屏 + dhashOf（降级）；
     * 两种证据都缺席 ⇒ null（诚实缺席，不反证）。判「变」容差与全屏判决同源
     *（world.hammingTolerance）—— 复用 W1-1 verifyAfter 的判决口径。
     */
    const macroSpotCheck = (baselineDhash) => {
        return async () => {
            if (baselineDhash === null)
                return null;
            try {
                const sample = await safeSample();
                if (sample && typeof sample.dhash === 'string' && sample.dhash !== '') {
                    const d = w1HashDistance(baselineDhash, sample.dhash);
                    return d === null ? null : d > fullscreenTolerance();
                }
                const buf = await capture();
                const h = await dhashOf(buf).catch(() => null);
                if (h === null)
                    return null;
                const d = w1HashDistance(baselineDhash, h);
                return d === null ? null : d > fullscreenTolerance();
            }
            catch {
                return null; // 抽查端口炸裂 ⇒ 证据缺席
            }
        };
    };
    /**
     * W4-1：宏执行入口（macro case 与 recall_skill 升级的共同脊梁）。
     * 排练门禁同律（可靠度 <0.5 / 模板产物必排练）；执行后 recordOutcome 回写
     * 技能账本（越用越准的闭环兑现）。防御式：宏执行器绝不抛，此处再兜一层。
     */
    const runMacro = async (input) => {
        try {
            const anchors = macroAnchors();
            const baselineDhash = deps.lastSnapshotRef?.current?.dhash ?? null;
            const trace = await executeMacro(input, {
                dispatch: macroDispatch,
                spotCheck: macroSpotCheck(baselineDhash),
                anchors: () => anchors,
                now,
                ...(deps.macro?.budget
                    ? {
                        budget: {
                            ...(typeof deps.macro.budget.maxSteps === 'number' ? { maxSteps: deps.macro.budget.maxSteps } : {}),
                            ...(typeof deps.macro.budget.timeoutMs === 'number' ? { timeoutMs: deps.macro.budget.timeoutMs } : {}),
                        },
                    }
                    : {}),
            });
            // 可靠度回写闭环：字面量技能 ⇒ recordOutcome；模板绑定产物 ⇒
            // recordTemplateOutcome（各自账本 —— 越用越准的宏方言兑现）
            if (trace.source.kind === 'skill' || trace.source.kind === 'fallback-skill') {
                if (trace.source.id >= 0) {
                    try {
                        skillLibrary.recordOutcome(trace.source.id, trace.ok);
                    }
                    catch { /* 账本旁路 */ }
                }
            }
            else if (trace.source.kind === 'template' && trace.source.id >= 0) {
                try {
                    skillLibrary.recordTemplateOutcome(trace.source.id, trace.ok);
                }
                catch { /* 账本旁路 */ }
            }
            const outcome = {
                outcome: trace.ok ? 'progress' : 'no_effect',
                note: clipNote(`宏执行：${macroTraceSummary(trace)}`),
                verification: {
                    roiChanged: null, expectedHit: null, roiOcrChanged: null, fullscreenChanged: null,
                    noise: false, steady: null, steadyPolls: 0, retries: 0,
                    degraded: trace.degraded.length > 0 ? [`macro:${trace.degraded.join('/')}`] : [],
                },
            };
            return { outcome, trace };
        }
        catch (err) {
            return {
                outcome: { outcome: 'error', note: clipNote(`macro: ${errText(err)}`) },
                trace: null,
            };
        }
    };
    // ─── ΑΩ-R12：按 kind 具名处理器（原 switch case 体原位搬迁 + inspect/drag 落地） ───
    /**
     * click 处理器：世界动作 —— system 键鼠（换算链逐字模仿 clickMouse.ts）。
     * W1-1 四连（A2 三区判决 / A3 预检+焦点短路 / A4 落点+网格重试 / A5 稳态门）
     * 的主路径。ΑΩ-R12：原 case 体原位搬迁；坐标换算与维度优先链改用公共前置
     *（toScreenPoint / coordDims）、短路/预检否决改用公共后置（bareVerification /
     * noWorldAction）—— 数值与调用序逐字节一致。
     */
    const handleClick = async (a) => {
        const target = a.target;
        const cx = target?.center?.x;
        const cy = target?.center?.y;
        if (typeof cx !== 'number' || !Number.isFinite(cx) || typeof cy !== 'number' || !Number.isFinite(cy)) {
            return { outcome: 'no_effect', note: '点击目标缺席中心坐标，不动作（绝不凭空点击）' };
        }
        const size = await system.getScreenSize();
        // 快照像素 → 归一化：坐标系优先级 = 显式入参 > 感知快照宽高（元素坐标
        // 的原生坐标系）> 屏幕尺寸（快照缺席时的兜底 —— 视捕获图与屏幕同幅）
        const refSnap = deps.lastSnapshotRef?.current ?? null;
        const { w, h } = coordDims(refSnap, size);
        // W1-1（A4）：不确定性感知落点 —— 大框取词级质心（文字重心），
        // 小框向几何中心收缩 20%；缺省几何中心（无框/无内嵌词时零行为差）
        const snapElements = refSnap && Array.isArray(refSnap.elements) ? refSnap.elements : [];
        const pick = pickClickPoint(target, snapElements, T);
        const toScreen = (sx, sy) => toScreenPoint(sx, sy, w, h, size);
        const firstPt = toScreen(pick.x, pick.y);
        // W1-1（A3②）：焦点短路 —— 外推焦点已在目标 ⇒ 跳过点击（免重复派发）
        const focusPt = focusSrc.predicted();
        const focusDist = Math.hypot(focusPt.x - firstPt.nx, focusPt.y - firstPt.ny);
        if (focusPt.x >= 0 && focusPt.y >= 0 && Number.isFinite(focusDist) && focusDist <= T.focusShortcutRadius) {
            // W2-0（D 补线）：短路免截屏，但判据核对零成本不豁免 —— 与 declare 同律
            //（W9-1：用感知快照 textDigest 走 evaluateCriteria 单一器官，零额外截屏
            // 零 OCR）。旧路径的
            // 判据证据搭验证帧 OCR 便车（每 3 步抽查）；短路步无验证帧，若不补此
            // 免费通道，「目标字面早已在屏」的达成会被短路推迟到保险丝之后。
            const shortcutEvidence = checkCriteria(deps.lastSnapshotRef?.current?.textDigest ?? '');
            return {
                outcome: 'no_effect',
                note: `焦点短路：外推焦点（${focusPt.x.toFixed(3)}, ${focusPt.y.toFixed(3)}${focusPt.extrapolated ? '，外推' : ''}）已在目标 ${T.focusShortcutRadius} 内 —— 跳过点击`,
                ...(shortcutEvidence.length > 0 ? { criteriaEvidence: shortcutEvidence } : {}),
                verification: bareVerification(),
            };
        }
        // W1-1（A3①③）：hitTest 预检 + 光标交叉印证 —— 判死 ⇒ 免截屏短路
        const pre = await precheckClick(firstPt.px, firstPt.py);
        if (pre.blocked) {
            return noWorldAction(pre.note);
        }
        const roiR = roiRadiusNorm(w, h);
        // 预期区域（归一化目标框）—— frameDiff 交叠判决（A2②）与网格重试（A4）的对照面
        const expectedBox = (() => {
            const bx0 = finiteOrNull(target?.bbox?.x0);
            const by0 = finiteOrNull(target?.bbox?.y0);
            const bx1 = finiteOrNull(target?.bbox?.x1);
            const by1 = finiteOrNull(target?.bbox?.y1);
            if (bx0 === null || by0 === null || bx1 === null || by1 === null || w <= 0 || h <= 0)
                return null;
            return {
                x0: Math.min(bx0, bx1) / w, y0: Math.min(by0, by1) / h,
                x1: Math.max(bx0, bx1) / w, y1: Math.max(by0, by1) / h,
            };
        })();
        const clickNote = (pt) => {
            const via = pick.via === 'word-centroid' ? `（词级质心 ${pick.words} 词）` :
                pick.via === 'shrunk' ? '（小框收缩落点）' : '';
            return `点击像素 (${pt.px}, ${pt.py})（归一化 ${pt.nx.toFixed(3)}, ${pt.ny.toFixed(3)}）${via}`;
        };
        // W2-0（D 接线）：点击命中 ⇒ 任务锚点登记（W1-9 P1）—— 目标 bbox + 视口
        //（快照宽高）交 contextManager 缓存，下次编码经 suggestFoveaCenter 组装
        // 三路候选交 gazeRouter，产出的注视中心直供 encodeForVlm.foveaCenter。
        // 旁路铁律：recordTaskAnchor 防御规整、绝不抛；登记失败绝不影响执行面。
        const recordAnchorOnHit = () => {
            try {
                const b = target?.bbox;
                if (!b || typeof b !== 'object')
                    return; // 无框目标无处锚定 —— 诚实跳过
                contextManager.recordTaskAnchor({
                    bbox: {
                        x0: Number(b.x0), y0: Number(b.y0), x1: Number(b.x1), y1: Number(b.y1),
                    },
                    ...(w > 0 && h > 0 ? { viewport: { width: w, height: h } } : {}),
                    route: 'grounding',
                });
            }
            catch { /* 锚点是增益不是依赖 */ }
        };
        /** 一次完整点击：before 采样 → 派发 → 落点登记 → 稳态门（A5） */
        const dispatchClick = async (pt, roi) => {
            const beforeSample = await safeSample({ keepFrame: true, wantRegionHash: roi });
            await system.clickMouse(pt.px, pt.py, 'left');
            focusSrc.set(pt.nx, pt.ny); // W1-1（A3）：落点登记 —— 下次焦点短路的证据源
            lastClickLanding = { x: pt.nx, y: pt.ny }; // ΝΩ-13（三修）：焦点源禁用态的 type 回填证据
            const gate = await settleGate({ roi, scroll: false });
            return {
                note: clickNote(pt), roi, expectedBox,
                beforeSample, afterSample: gate.lastSample,
                // steady=null 表示「未走门」（探针缺席）；走过门才是 boolean
                steady: probeCanSample ? gate.steady : null,
                steadyDegraded: gate.degraded, steadyPolls: gate.polls,
                retries: 0,
            };
        };
        // 首发落点（计数律与旧律一致：派发抛错 ⇒ 外层 error，计数不虚增）
        const firstInput = await dispatchClick(firstPt, { x: firstPt.nx, y: firstPt.ny, r: roiR });
        verifiedCount++;
        let result = await verifyOnce(firstInput);
        if (result.outcome === 'progress')
            recordAnchorOnHit(); // W2-0（D）：命中即锚定
        // W1-1（A4）：miss（no_effect/噪声且 ROI 未命中）⇒ 3×3 去中心网格步进
        // 重试，每次用 A2 的 ROI 验证，命中即停。仅探针在场且首发 miss 是
        // ROI 可判决的（未降级）才启用 —— 判决缺席时盲扫网格只是浪费截屏；
        // 重试途中采样故障 ⇒ 立即收兵（未派发的点击绝不派发）。
        const miss = result.outcome !== 'progress' && result.outcome !== 'error';
        const missJudged = miss && (!result.verification || !result.verification.degraded.includes('roi'));
        if (missJudged && probeCanSample && T.clickRetryMax > 0 && expectedBox) {
            const bx0 = expectedBox.x0 * w, bx1 = expectedBox.x1 * w;
            const by0 = expectedBox.y0 * h, by1 = expectedBox.y1 * h;
            const step = Math.min(T.gridStepMaxPx, Math.max(T.gridStepMinPx, Math.min(bx1 - bx0, by1 - by0) * T.gridStepRatio));
            const tried = new Set([`${firstPt.px},${firstPt.py}`]);
            let attempted = 0;
            for (const off of gridRetryOffsets()) {
                if (attempted >= T.clickRetryMax)
                    break;
                const sx = Math.min(bx1, Math.max(bx0, pick.x + off.dx * step));
                const sy = Math.min(by1, Math.max(by0, pick.y + off.dy * step));
                const pt = toScreen(sx, sy);
                const key = `${pt.px},${pt.py}`;
                if (tried.has(key))
                    continue; // 步长过小坍缩到已试点 —— 跳过
                tried.add(key);
                const pre2 = await precheckClick(pt.px, pt.py);
                if (pre2.blocked)
                    continue; // 邻位判死 ⇒ 换下一邻位（不终止序列）
                // 采样先行：判决证据缺席 ⇒ 不派发（盲扫无据）
                const beforeSample = await safeSample({ keepFrame: true, wantRegionHash: { x: pt.nx, y: pt.ny, r: roiR } });
                if (beforeSample === null)
                    break;
                attempted++;
                await system.clickMouse(pt.px, pt.py, 'left');
                focusSrc.set(pt.nx, pt.ny);
                lastClickLanding = { x: pt.nx, y: pt.ny }; // ΝΩ-13（三修）：网格邻位也是真实点击落点
                const gate = await settleGate({ roi: { x: pt.nx, y: pt.ny, r: roiR }, scroll: false });
                const input = {
                    note: clickNote(pt), roi: { x: pt.nx, y: pt.ny, r: roiR }, expectedBox,
                    beforeSample, afterSample: gate.lastSample,
                    steady: gate.steady, steadyDegraded: gate.degraded, steadyPolls: gate.polls,
                    retries: attempted,
                };
                // ΝΩ-13（二修）：重试不再重复判据抽查 —— spotDue 已在首发消费（若到期）
                const r2 = await verifyOnce(input, false);
                if (r2.outcome === 'progress') {
                    recordAnchorOnHit(); // W2-0（D）：网格重试命中同样锚定
                    const base = typeof r2.note === 'string' && r2.note !== '' ? r2.note : '';
                    r2.note = clipNote(`${base}；第 ${attempted} 次网格重试命中（像素 ${pt.px}, ${pt.py}）`);
                    return r2;
                }
                result = r2;
            }
            const base = typeof result.note === 'string' && result.note !== '' ? result.note : '';
            result.note = clipNote(`${base}；网格重试 ${attempted}/${T.clickRetryMax} 邻位未命中`);
        }
        return result;
    };
    /**
     * ΑΩ-R12：type 处理器 —— 公共管线（before 采样 → 键入 → 稳态门 → 三区判决）
     * ΝΩ-13（三修 · type 前焦点回填）：外推焦点是哨兵远点（焦点源禁用/无新鲜
     * 焦点）且 hitTest 端口在场 ⇒ 用已知落点（最近 click 派发落点 > 动作自带
     * target.center 坐标，均归一化）经 hitTest 结构层证实后回填键入作用点再判
     * ROI —— 弹 Toast 类局部反馈不再因 roi=null 漏进全屏判决；hitTest 端口
     * 缺席/证实失败 ⇒ 诚实降级保持全屏判决（旧行为）。回填点只供本次判决消费，
     * 不写回焦点源（「我点过这里」的登记语义不被观察性回填伪造）。
     */
    const handleType = async (a, payload) => {
        const text = payload.text;
        if (typeof text !== 'string' || text.length === 0) {
            return { outcome: 'no_effect', note: 'type 动作 payload.text 缺席，不动作' };
        }
        // W1-1（A2）：键入作用点 = 外推焦点（焦点源禁用/无新鲜焦点 ⇒ 尝试回填）
        let fp = focusSrc.predicted();
        let focusNote = '';
        if (fp.x < 0 || fp.y < 0) {
            // ΝΩ-13：候选落点 —— 最近 click 派发落点优先，缺席时退动作自带坐标
            //（target.center 快照像素域 → 归一化；坐标域未知 ⇒ 无候选，诚实跳过）
            let cand = null;
            if (lastClickLanding) {
                cand = { x: clamp01(lastClickLanding.x), y: clamp01(lastClickLanding.y) };
            }
            else {
                const tcx = finiteOrNull(a.target?.center?.x);
                const tcy = finiteOrNull(a.target?.center?.y);
                const rs = deps.lastSnapshotRef?.current ?? null;
                const { w, h } = coordDims(rs, { width: 0, height: 0 });
                if (tcx !== null && tcy !== null && w > 0 && h > 0)
                    cand = { x: clamp01(tcx / w), y: clamp01(tcy / h) };
            }
            if (cand && probe && typeof probe.hitTestPoint === 'function') {
                const size = await system.getScreenSize();
                const px = Math.round(cand.x * size.width);
                const py = Math.round(cand.y * size.height);
                let ht = null;
                try {
                    ht = await probe.hitTestPoint(px, py);
                }
                catch {
                    ht = null;
                }
                // 证实闸：结构层查询真实可用且落点可归到 UI 元素（'unavailable' = 查询
                // 落空 ⇒ 键入作用点存疑，诚实降级全屏）
                if (ht && ht.available === true && ht.classification !== 'unavailable') {
                    fp = { x: cand.x, y: cand.y, extrapolated: false };
                    focusNote = `；ROI 焦点经 hitTest 回填 (${cand.x.toFixed(3)}, ${cand.y.toFixed(3)})`;
                }
            }
        }
        const dims = worldDims();
        const roi = fp.x >= 0 && fp.y >= 0
            ? { x: clamp01(fp.x), y: clamp01(fp.y), r: roiRadiusNorm(dims.w, dims.h) }
            : null;
        return dispatchVerified(`键入 ${text.length} 字符${focusNote}`, roi, {
            scroll: false,
            dispatch: async () => { await system.typeText(text, payload.clearFirst === true); },
        });
    };
    /** ΑΩ-R12：scroll 处理器 —— 公共管线（方向白名单 + 缺省行数与 scrollPage 工具同律） */
    const handleScroll = async (payload) => {
        const raw = typeof payload.direction === 'string' ? payload.direction : 'down';
        const dirMap = {
            up: 'up', down: 'down', left: 'left', right: 'right',
        };
        const dir = dirMap[raw];
        if (!dir)
            return { outcome: 'no_effect', note: `scroll 方向非法（${raw}），不动作` };
        const amount = typeof payload.amount === 'number' && Number.isFinite(payload.amount) && payload.amount >= 1
            ? payload.amount
            : DEFAULT_SCROLL_AMOUNT;
        // W1-1（A5）：滚动稳态 = 哈希稳 且 内容不再平移（motionEstimator 行位移判决）
        return dispatchVerified(`滚动 ${dir} ${amount} 行`, null, {
            scroll: true,
            dispatch: async () => { await system.scroll(dir, amount); },
        });
    };
    /** ΑΩ-R12：hotkey 处理器 —— 公共管线（keys 过滤后非空才派发） */
    const handleHotkey = async (payload) => {
        const keys = Array.isArray(payload.keys)
            ? payload.keys.filter((k) => typeof k === 'string' && k.trim() !== '')
            : [];
        if (keys.length === 0) {
            return { outcome: 'no_effect', note: 'hotkey 动作 payload.keys 缺席，不动作' };
        }
        return dispatchVerified(`按键 ${keys.join('+')}`, null, {
            scroll: false,
            dispatch: async () => { await system.pressHotkey(keys); },
        });
    };
    /**
     * ΑΩ-R12：drag 处理器 —— 拖拽动作落地（词汇表在册、执行面此前 default 空转）。
     * 起点 = target.center、终点 = payload.end {x,y}（与 target.center 同一快照像素
     * 坐标域），换算链与 click 同律（归一化 → 屏幕像素）；派发经 RuntimeDeps.drag
     * 注入端口（autonomy 器官本体不碰 system.dragMouse —— 经 deps 注入破环，接线
     * 层 buildAutonomyStack 注入适配）。端口缺席/坐标缺席 ⇒ 防御式降级 no_effect +
     * 诚实注记（绝不凭空移动鼠标）；端口报失败 ⇒ error（诚实归因，与 click 派发
     * 异常同律）。派发成功 ⇒ 公共验证管线（稳态门 + 三区判决），ROI 锚定终点
     *（被抓取物运动的目的地），落点登记于终点（下次焦点短路的证据源）。
     */
    const handleDrag = async (a, payload) => {
        const dragPort = deps.drag;
        if (typeof dragPort !== 'function') {
            return noWorldAction('drag：拖拽端口未注入（deps.drag 缺席），不动作');
        }
        const target = a.target;
        const scx = finiteOrNull(target?.center?.x);
        const scy = finiteOrNull(target?.center?.y);
        if (scx === null || scy === null) {
            return noWorldAction('drag：拖拽起点缺席（target.center），不动作');
        }
        const end = payload.end;
        const ecx = finiteOrNull(end?.x);
        const ecy = finiteOrNull(end?.y);
        if (ecx === null || ecy === null) {
            return noWorldAction('drag：拖拽终点缺席（payload.end），不动作');
        }
        const size = await system.getScreenSize();
        const refSnap = deps.lastSnapshotRef?.current ?? null;
        const { w, h } = coordDims(refSnap, size);
        const start = toScreenPoint(scx, scy, w, h, size);
        const finish = toScreenPoint(ecx, ecy, w, h, size);
        return dispatchVerified(`拖拽像素 (${start.px}, ${start.py}) → (${finish.px}, ${finish.py})`, {
            x: finish.nx, y: finish.ny, r: roiRadiusNorm(w, h),
        }, {
            scroll: false,
            dispatch: async () => {
                const res = await dragPort(start.px, start.py, finish.px, finish.py);
                if (!res || res.ok !== true) {
                    throw new Error(`drag 端口失败：${res && typeof res.error === 'string' && res.error !== '' ? res.error : '未知'}`);
                }
                focusSrc.set(finish.nx, finish.ny); // 落点登记 —— 拖拽收梢于终点
            },
        });
    };
    /**
     * ΝΩ-13（一修 · inspect 产物回流感知）：检视词合成 LocalElement 增量，经
     * composeSnapshot 单源重铸进 lastSnapshotRef —— ROI 窗内读到的新词对下一步
     * policy.decide 可见（检视的 0.7 信息增益先验兑现，不再只躺在 note 里）。
     * 重铸律：宽高/弹窗/焦点区/场景标签/指纹原样透传（检视零像素影响 ⇒ dhash
     * 不变），takenAt 刷新为当刻，degraded 诚实追加 'inspect-merged'；旧元素按
     * source 分流回流（vlm/fusion 走 vlm 通道保角色语义、local 走本地通道），
     * 新词并入本地通道 —— 双源在场时增量与既有元素经同一仲裁融合（composeSnapshot
     * 单源，不另立方言）。幂等闸：同折叠标签且归一化中心邻近（ROI 半径内）的词
     * 已在账上 ⇒ 不重复入增量（重复检视同一区域零虚增）。防御式：快照槽缺席/
     * 维度未知/重铸任何意外 ⇒ 保持旧快照原样（返回 0，检视结局不受影响）。
     */
    const mergeInspectGain = (roiWords, captureDims) => {
        const slot = deps.lastSnapshotRef;
        const snap = slot?.current ?? null;
        if (!slot || !snap || roiWords.length === 0)
            return 0;
        if (!(snap.width > 0) || !(snap.height > 0))
            return 0;
        if (!(captureDims.width > 0) || !(captureDims.height > 0))
            return 0;
        try {
            // 标签折叠比较律（大小写 + 连续空白折叠单空格 + 去首尾空白）—— 与家族
            // 工具模块同律的本地实现：W9-1④a 源级契约钉死本文件不得引入折叠工具
            // 标识符（判据核对单一器官红线不因回流增量破例），故此处就地同律折叠。
            const foldLabel = (s) => typeof s === 'string' ? s.toLowerCase().replace(/\s+/g, ' ').trim() : '';
            const oldElems = Array.isArray(snap.elements) ? snap.elements : [];
            // 邻近判容差：ROI 半径按快照短边归一（与检视窗同一几何参数面）
            const rNorm = Math.min(0.5, T.roiRadiusPx / Math.min(snap.width, snap.height));
            // 检视词（捕获图像素域）→ 快照像素域（perceive 的 makeDefaultReadWords 同律换算）
            const toSnapX = (v) => Math.round(clamp01(v / captureDims.width) * snap.width);
            const toSnapY = (v) => Math.round(clamp01(v / captureDims.height) * snap.height);
            const increments = [];
            for (const wd of roiWords) {
                const folded = foldLabel(wd.label);
                if (folded === '')
                    continue;
                const cxN = clamp01(((wd.bbox.x0 + wd.bbox.x1) / 2) / captureDims.width);
                const cyN = clamp01(((wd.bbox.y0 + wd.bbox.y1) / 2) / captureDims.height);
                const already = oldElems.some(el => {
                    if (!el || foldLabel(el.label) !== folded)
                        return false;
                    const ex = finiteOrNull(el.center?.x), ey = finiteOrNull(el.center?.y);
                    if (ex === null || ey === null)
                        return false;
                    return Math.hypot(ex / snap.width - cxN, ey / snap.height - cyN) <= rNorm;
                });
                if (already)
                    continue;
                increments.push({
                    label: wd.label,
                    bbox: {
                        x0: toSnapX(wd.bbox.x0), y0: toSnapY(wd.bbox.y0),
                        x1: toSnapX(wd.bbox.x1), y1: toSnapY(wd.bbox.y1),
                    },
                    confidence: clamp01(wd.confidence),
                });
            }
            if (increments.length === 0)
                return 0;
            // 旧元素按 source 分流：vlm/fusion → vlm 通道（角色/框/置信/中心逐字段
            // 回流，composeSnapshot 双源路径按 vlm 序回填角色）；local → 本地通道
            const vlmRound = oldElems
                .filter(el => el && el.source !== 'local')
                .map(el => ({
                id: '', label: el.label, role: el.role, bbox: el.bbox,
                center: el.center, confidence: el.confidence, source: 'vlm',
            }));
            const localRound = [
                ...oldElems
                    .filter(el => el && el.source === 'local')
                    .map(el => ({ label: el.label, bbox: el.bbox, confidence: el.confidence })),
                ...increments,
            ];
            const digestBase = typeof snap.textDigest === 'string' ? snap.textDigest : '';
            const merged = composeSnapshot({
                width: snap.width,
                height: snap.height,
                dhash: snap.dhash, // 零像素影响 ⇒ 指纹原样透传
                ...(vlmRound.length > 0 ? { vlmElements: vlmRound } : {}),
                localElements: localRound,
                ocrText: [digestBase, ...increments.map(i => i.label)].filter(s => s !== '').join(' '),
                popupNotes: Array.isArray(snap.popups) ? snap.popups : [],
                focusRegion: snap.focusedRegion ?? null,
                sceneLabel: typeof snap.sceneLabel === 'string' ? snap.sceneLabel : '',
                now: now(),
            });
            if (!merged.degraded.includes('inspect-merged'))
                merged.degraded.push('inspect-merged');
            slot.current = merged;
            return increments.length;
        }
        catch {
            return 0; // 防御式：重铸任何意外 ⇒ 保持旧快照
        }
    };
    /**
     * ΑΩ-R12：inspect 处理器 —— 聚焦检视（策略引擎僵局切换 ④ 会发出；此前落入
     * default 分支空转 no_effect，反事实的 0.7 信息增益先验在生产路径虚高）。
     * 真「检视」而非伪放大：围绕检视点（target.center > payload.region 中心）以
     * W1 tuning 的 roiRadiusPx（缺省 128px）为半径开 ROI 窗做词级 OCR 读取，读到
     * 的词即信息增益（note 携带词摘要，clipNote 截断纪律沿用）。绝不移动鼠标
     * 绝不点击（零像素影响 —— 效果验证预期「无像素影响」照旧：观察性动作，结局
     * no_effect 如实记账）。OCR 端口（deps.readWords 注入位）缺席或读取失败 ⇒
     * 诚实降级 no_effect + 注记（绝不伪读）；检视点/坐标域缺席 ⇒ 同律不动作。
     * ΝΩ-13（一修）：读到的 ROI 新词另合成 LocalElement 增量重铸进感知快照槽
     *（mergeInspectGain —— 下一步 policy.decide 可见，0.7 信息增益先验兑现）。
     */
    const handleInspect = async (a, payload) => {
        const readWordsPort = deps.readWords;
        if (typeof readWordsPort !== 'function') {
            return noWorldAction('inspect：词级 OCR 端口未注入（deps.readWords 缺席），聚焦检视诚实降级，不伪读');
        }
        // 检视点解析：target.center 优先；缺席 ⇒ payload.region（策略引擎僵局切换
        // 的方言：快照 focusedRegion 或全屏兜底）的几何中心
        const target = a.target;
        const tcx = finiteOrNull(target?.center?.x);
        const tcy = finiteOrNull(target?.center?.y);
        const region = payload.region;
        let px = null;
        let py = null;
        if (tcx !== null && tcy !== null) {
            px = tcx;
            py = tcy;
        }
        else {
            const rx0 = finiteOrNull(region?.x0), ry0 = finiteOrNull(region?.y0);
            const rx1 = finiteOrNull(region?.x1), ry1 = finiteOrNull(region?.y1);
            if (rx0 !== null && ry0 !== null && rx1 !== null && ry1 !== null) {
                px = (rx0 + rx1) / 2;
                py = (ry0 + ry1) / 2;
            }
        }
        if (px === null || py === null) {
            return noWorldAction('inspect：检视点缺席（target.center 与 payload.region 均未给出），不动作');
        }
        const buf = await capture();
        const dims = await imageSize(buf);
        if (dims.width <= 0 || dims.height <= 0) {
            return noWorldAction('inspect：捕获图维度未知，聚焦检视降级，不动作');
        }
        // 检视点（快照坐标域）→ 捕获图像素域：与 click 同律的维度优先链（显式
        // 入参 > 感知快照 > 捕获图自身），再按捕获宽高换算开 ROI 窗
        const refSnap = deps.lastSnapshotRef?.current ?? null;
        const { w, h } = coordDims(refSnap, dims);
        if (w <= 0 || h <= 0) {
            return noWorldAction('inspect：快照坐标域未知，聚焦检视降级，不动作');
        }
        const r = T.roiRadiusPx; // W1 tuning 的 ROI 半径常量（与 A2 验证同一参数面）
        const cwx = clamp01(px / w) * dims.width;
        const cwy = clamp01(py / h) * dims.height;
        const win = {
            x0: Math.max(0, cwx - r), y0: Math.max(0, cwy - r),
            x1: Math.min(dims.width, cwx + r), y1: Math.min(dims.height, cwy + r),
        };
        const words = await readWordsPort(buf).catch(() => null);
        if (words === null) {
            return noWorldAction('inspect：词级 OCR 读取失败，聚焦检视诚实降级，不伪读');
        }
        const inRoi = [];
        // ΝΩ-13（一修）：完整词记录（增量回流的原料 —— label/bbox/confidence）
        const roiWords = [];
        for (const wd of Array.isArray(words) ? words : []) {
            if (!wd || typeof wd.label !== 'string' || wd.label.trim() === '')
                continue;
            const wx0 = finiteOrNull(wd.bbox?.x0), wy0 = finiteOrNull(wd.bbox?.y0);
            const wx1 = finiteOrNull(wd.bbox?.x1), wy1 = finiteOrNull(wd.bbox?.y1);
            if (wx0 === null || wy0 === null || wx1 === null || wy1 === null)
                continue;
            const mx = (wx0 + wx1) / 2, my = (wy0 + wy1) / 2;
            if (mx >= win.x0 && mx <= win.x1 && my >= win.y0 && my <= win.y1) {
                inRoi.push(wd.label);
                roiWords.push({
                    label: wd.label,
                    bbox: { x0: wx0, y0: wy0, x1: wx1, y1: wy1 },
                    confidence: clamp01(finiteOrNull(wd.confidence) ?? 0),
                });
            }
        }
        // ΝΩ-13（一修）：检视产物回流 —— ROI 新词重铸进感知快照槽（decide 可见；
        // 合成失败 ⇒ mergeInspectGain 内部防御式保持旧快照，检视结局不受影响）
        const mergedCount = mergeInspectGain(roiWords, dims);
        const summary = inRoi.join(' ');
        return {
            outcome: 'no_effect', // 零像素影响照旧 —— 信息增益在 note 与快照增量，不在世界
            note: clipNote(`聚焦检视：ROI(${Math.round(win.x0)},${Math.round(win.y0)})-(${Math.round(win.x1)},${Math.round(win.y1)}) 读到 ${inRoi.length} 词${summary !== '' ? `：${summary}` : ''}${mergedCount > 0 ? `；增量回流 ${mergedCount} 词入快照（inspect-merged）` : ''}`),
            verification: bareVerification(),
        };
    };
    /** ΑΩ-R12：ask_vlm 处理器 —— 观察性动作（截屏 + 云脑问答，回答仅记 note） */
    const handleAskVlm = async (payload) => {
        const client = deps.client ?? (isGlmConfigured() ? getGlmClient() : null);
        if (!client) {
            return { outcome: 'error', note: 'ask_vlm：云脑未配置（缺 API Key 且未注入 client）' };
        }
        const question = typeof payload.question === 'string' && payload.question.trim() !== ''
            ? payload.question
            : `目标「${spec.goal}」的下一步建议是什么？`;
        const buf = await capture();
        // W2-0（D 接线）：任务驱动注视 + 预算弹性（W1-9 P1/C4）——
        //  · foveaCenter 消费 suggestFoveaCenter 的路由判决（锚点+diff+光标三路
        //    加权 Top-1；仅 foveated 编码开启时生效，缺省路径逐字节不变）；
        //  · requote 按剩余步数（spec.maxSteps − 已验证步）产出建议编码档 ——
        //    original 档不显式传参（codec 注册表缺省不被覆盖）；economy/deep 档
        //    才消费建议 quality/maxDimension（只降不升）；编码成功即 commit 记账
        //    （后续 requote 的单帧字节估计走真实历史而非经验值）。
        const gaze = contextManager.suggestFoveaCenter();
        const maxStepsOf = typeof spec.maxSteps === 'number' && Number.isFinite(spec.maxSteps) && spec.maxSteps >= 1
            ? spec.maxSteps
            : 24;
        const requote = vlmBudget.requote(Math.max(1, maxStepsOf - verifiedCount));
        const enc = await encodeForVlm(buf, {
            foveaCenter: gaze.center,
            ...(requote.tier !== 'original'
                ? { quality: requote.quality, maxDimension: requote.maxDimension }
                : {}),
        });
        if (enc.ok && enc.value)
            vlmBudget.commit(enc.value); // 建议性记账（不接强制闸）
        if (!enc.ok || !enc.value) {
            return { outcome: 'error', note: `ask_vlm 截屏编码失败：${enc.error ?? '未知'}` };
        }
        const res = await client.chat({
            images: [{ base64: enc.value.base64, mime: enc.value.mime }],
            prompt: question,
            temperature: 0.2,
            maxTokens: 512,
        });
        if (!res.ok) {
            return { outcome: 'error', note: `ask_vlm 云脑失败：${res.error ?? '未知'}` };
        }
        return verifyAfter(`云脑答：${res.text.trim()}`);
    };
    /** ΑΩ-R12：recall_skill 处理器 —— 召回即经宏执行器落地（W4-1 A1） */
    const handleRecallSkill = async (payload) => {
        const matches = (() => {
            try {
                return skillLibrary.match(typeof spec.goal === 'string' ? spec.goal : '', undefined, 1)
                    .map(m => ({ id: m.id, name: m.name }));
            }
            catch {
                return [];
            }
        })();
        if (matches.length === 0) {
            return { outcome: 'no_effect', note: 'recall_skill：技能库无匹配（无匹配 ⇒ 不动作）' };
        }
        // W4-1（A1）：从「只报到达」升级为「可执行」—— 召回即经宏执行器落地
        //（重锚定非盲重放 + 排练门禁同律 + dhash 抽查节奏）；执行后
        // recordOutcome 回写（runMacro 内），note 携宏执行轨迹摘要。
        const skillId = typeof payload.skillId === 'number' && Number.isFinite(payload.skillId)
            ? payload.skillId : matches[0].id;
        verifiedCount++;
        const { outcome } = await runMacro({ skillId });
        return outcome;
    };
    /** ΑΩ-R12：macro 处理器 —— 参数化宏动作（W4-1 A1 技能宏重放执行） */
    const handleMacro = async (payload) => {
        // payload：{skillId?|templateId?, args:{target?, text?}}（参数化宏动作）
        const skillId = typeof payload.skillId === 'number' && Number.isFinite(payload.skillId)
            ? payload.skillId : undefined;
        const templateId = typeof payload.templateId === 'number' && Number.isFinite(payload.templateId)
            ? payload.templateId : undefined;
        const argsRaw = payload.args && typeof payload.args === 'object'
            ? payload.args : {};
        const target = typeof argsRaw.target === 'string' && argsRaw.target !== '' ? argsRaw.target : undefined;
        const text = typeof argsRaw.text === 'string' && argsRaw.text !== '' ? argsRaw.text : undefined;
        if (skillId === undefined && templateId === undefined) {
            return {
                outcome: 'no_effect',
                note: 'macro：payload 缺席宏定位（skillId/templateId 均未给出），不动作',
            };
        }
        verifiedCount++;
        const { outcome } = await runMacro({
            ...(skillId !== undefined ? { skillId } : {}),
            ...(templateId !== undefined ? { templateId } : {}),
            args: { ...(target !== undefined ? { target } : {}), ...(text !== undefined ? { text } : {}) },
        });
        return outcome;
    };
    /** ΑΩ-R12：declare 处理器 —— 不动作族，附带判据核对（感知快照 textDigest，零额外截屏） */
    const handleDeclare = async () => {
        const digest = deps.lastSnapshotRef?.current?.textDigest ?? '';
        const evidence = checkCriteria(digest);
        const result = { outcome: 'no_effect' };
        if (evidence.length > 0)
            result.criteriaEvidence = evidence;
        else
            result.note = 'declare：感知文本未命中判据字面（宁缺毋错，不置位）';
        return result;
    };
    /** ΑΩ-R12：wait 处理器 —— 静止一拍（与拆分前逐字节一致的裸结局） */
    const handleWait = async () => {
        return { outcome: 'no_effect' };
    };
    /** ΑΩ-R12：default 处理器 —— escalate（闭环已拦截）/ 未知种类：不动世界 */
    const handleUnknownKind = async (a) => {
        return { outcome: 'no_effect', note: `动作种类「${String(a.kind)}」在本执行面无世界动作` };
    };
    // ─── ΑΩ-R12：派发面 —— switch 收敛为具名处理器路由（调用序与拆分前一致） ───
    return async (action) => {
        const a = (action ?? {});
        const payload = a.payload && typeof a.payload === 'object' ? a.payload : {};
        try {
            // W4-1：宏扩展字入 switch 域（macro 不在 policyEngine 闭集 —— 类型层经
            // 联合扩展合法消费）；ΑΩ-R12 后各 case 只路由到具名处理器。铁律：一律
            // return await —— try 块内裸 return promise 的拒绝不进 catch（return vs
            // return await 语义差），处理器异常必须收敛为 error 结局（运行层绝不抛）。
            switch (a.kind) {
                // ── 世界动作：system 键鼠（换算链逐字模仿 clickMouse.ts） ──
                case 'click': return await handleClick(a);
                case 'type': return await handleType(a, payload);
                case 'scroll': return await handleScroll(payload);
                case 'hotkey': return await handleHotkey(payload);
                case 'drag': return await handleDrag(a, payload);
                // ── 观察性动作：不改世界，结果仅记 note ──
                case 'inspect': return await handleInspect(a, payload);
                case 'ask_vlm': return await handleAskVlm(payload);
                case 'recall_skill': return await handleRecallSkill(payload);
                // ── W4-1（A1）：技能宏重放执行 —— 参数化宏动作 ──
                case 'macro': return await handleMacro(payload);
                // ── 不动作族：declare 附带判据核对（用感知快照 textDigest，零额外截屏） ──
                case 'declare': return await handleDeclare();
                case 'wait': return await handleWait();
                default: return await handleUnknownKind(a);
            }
        }
        catch (err) {
            return { outcome: 'error', note: clipNote(`execute: ${errText(err)}`) };
        }
    };
}
