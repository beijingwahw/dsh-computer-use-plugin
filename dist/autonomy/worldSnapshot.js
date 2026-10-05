// src/autonomy/worldSnapshot.ts
// 纪元 Φ（Φ-2 自主识别中枢）：世界快照器官 —— 把多源感知融合为一张确定性的世界快照。
//
// 存在理由：自主智能环每一步决策都面对同一道题 ——「屏幕上现在有什么」。云端
// 接地（GroundedElement）、本地感知（LocalElement）、OCR 全文、弹窗注记、焦点
// 区是五种方言各异的证据；没有一张统一总账，决策层就要在方言之间反复对表。
// 本器官就是那张对表后的总账（WorldSnapshot）：
//   · 元素层：双源 ⇒ 复用 vlm/arbitration 的数学仲裁（IoU 贪心一对一配对、
//     置信度加权凸组合融合框、双源一致加成），本器官只做形态转写 —— center
//     一律由最终 bbox 中点重算（取整权留给点击层）、role 按仲裁输出次序回填
//     vlm 角色（本地信道无角色语义，缺省 'unknown'）、interactive 按 role 三
//     态化（fusion 元素亦按其 vlm 角色）；单源直映；零源诚实记降级 'elements'。
//   · 文本层：ocrText 截 2000 记 textDigest —— 上下文带宽的记账礼仪。
//   · 变化层：snapshotChanged 以十六进制 dhash 汉明距离 + 元素数量突变双闸判
//     「世界是否动了」—— 感知预算的节流阀（ΝΩ-14 起亦是 grounding 复用门）。
//   · 注记层（ΝΩ-14）：notes 透传 —— 感知门控决策（如 'vlm-reused-unchanged'）
//     的诚实申报面；复用不是降级，不占 degraded 清单。
//   · 检索层：findInSnapshot（双向子串 + 置信降序）/ interactiveElements ——
//     决策层问「东西在哪、哪里能点」的两个直达查询口。
// 纪律：纯函数、零网络、零图像依赖（快照不持有像素 —— image 入参只表存在，
// 不入账）、确定性可回放、对一切脏输入绝不抛异常。
// ΑΩ-R10（方言三重复制单源化）：本地 hammingHex 副本（连同其 nibble popcount 表）
// 已迁出至 ../dialects/hashing 的 hammingDistanceHex 单源模块 —— 本文件改为
// import，行为逐字节等价（不可比仍记 null）。
import { arbitrateElements } from '../vlm/arbitration.js';
import { kernelRegistry } from '../kernel/registry.js';
import { hammingDistanceHex } from '../dialects/hashing.js';
/** textDigest 截断上限：OCR 全文入快照的带宽上限（防上下文爆炸） */
const TEXT_DIGEST_MAX = 2000;
/** snapshotChanged 缺省汉明容差：dhash 距离 ≤ 3 视为像素未动 */
const DEFAULT_HAMMING_TOLERANCE = 3;
/** findInSnapshot 缺省返回上限 */
const DEFAULT_FIND_LIMIT = 5;
/** 已知可交互角色集：命中 ⇒ interactive=true（VLM 角色语义的可点清单） */
const INTERACTIVE_ROLES = new Set([
    'button',
    'link',
    'input',
    'select',
    'menu',
    'tab',
]);
// ─── 内部纯函数工具（零副作用、零异常） ───
/** 数字卫兵：非有限数字一律按 0 记（脏坐标不出 NaN、不炸管线） */
const finiteOr0 = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/**
 * bbox 几何中心：((x0+x1)/2, (y0+y1)/2)。非有限坐标按 0 记 —— 对倒置/压扁
 * 框亦不抛错（与 vlm/arbitration 的零面积约定同源的宽容律）。
 */
function centerOf(bbox) {
    const b = (bbox && typeof bbox === 'object' ? bbox : {});
    return { x: (finiteOr0(b.x0) + finiteOr0(b.x1)) / 2, y: (finiteOr0(b.y0) + finiteOr0(b.y1)) / 2 };
}
/**
 * 可交互三态律：role ∈ {button,link,input,select,menu,tab} ⇒ true；
 * role === 'text' ⇒ false；其余（含 'unknown'）⇒ null（证据不足，不猜）。
 */
function interactiveOf(role) {
    if (INTERACTIVE_ROLES.has(role))
        return true;
    if (role === 'text')
        return false;
    return null;
}
/** 角色卫兵：非字符串/空串 ⇒ 'unknown'（「vlm 优先、缺省 unknown」的执法点） */
function roleOr(role) {
    return typeof role === 'string' && role.length > 0 ? role : 'unknown';
}
/**
 * 检索折叠：小写化 + 连续空白折叠为单空格 + 去首尾空白 —— 大小写不敏感、
 * 空白不敏感比较的统一前置（query 与 label 同律折叠后再比）。
 */
function foldText(s) {
    return typeof s === 'string' ? s.toLowerCase().replace(/\s+/g, ' ').trim() : '';
}
/** 指纹卫兵：非字符串/空串按 null 记（无效指纹 = 无指纹） */
function validDhash(raw) {
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
}
// ΑΩ-R10：十六进制 dhash 汉明距离本体已单源化至 ../dialects/hashing 的
// hammingDistanceHex（null = 不可比）—— 本文件原私有 hammingHex 副本已删除。
/**
 * 元素形态转写：仲裁/单源元素 → 快照元素。role 由调用方裁决（vlm 优先律），
 * center 一律由 bbox 中点重算（不信任直通值），label/confidence 做脏值卫兵。
 */
function toElement(base, source, role) {
    const bbox = base.bbox && typeof base.bbox === 'object' ? base.bbox : { x0: 0, y0: 0, x1: 0, y1: 0 };
    return {
        label: typeof base.label === 'string' ? base.label : '',
        role,
        bbox,
        center: centerOf(bbox),
        confidence: finiteOr0(base.confidence),
        source,
        interactive: interactiveOf(role),
    };
}
// ─── 导出器官 ───
/**
 * ΝΩ-14（role 回填防御断言 · 立法）：仲裁输出次序契约的执法点。
 *
 * 契约内容（与 vlm/arbitration 的跨文件隐式约定，先此只在 composeSnapshot
 * 内联消费）：arbitrateElements 的输出前 vlmElements.length 位恰与 vlm 序
 * 一一对应（source ∈ {'vlm','fusion'}），本地单源殿后（source='local'）。
 * 本函数把该隐式契约升为显式防御：
 *   · 契约位相符（index 落在 vlm 序内且 source ∈ {'vlm','fusion'}）⇒ 照旧
 *     按位置回填 vlmElements[index].role（vlm 优先律不变）；
 *   · 契约位不符（次序错乱的仲裁输出 —— 兄弟器官实现漂移/注入错乱：vlm 序
 *     位置冒出 local 源，或 index 越界/非整数/脏表）⇒ role='unknown'：不按
 *     位置把 A 的角色错配给 B（错配的角色比「不知角色」更危险 —— 交互三态
 *     会被谎言污染），也不抛错 —— 错配经元素 source 字段原样可见，违约有据
 *     可查。纯函数、对一切脏输入绝不抛异常。
 */
export function arbitrationRoleAt(vlmElements, index, source) {
    if (!Array.isArray(vlmElements))
        return 'unknown';
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= vlmElements.length) {
        return 'unknown';
    }
    return source === 'vlm' || source === 'fusion' ? roleOr(vlmElements[index]?.role) : 'unknown';
}
/**
 * 感知合成主入口：多源证据 → 一张世界快照（纯函数、绝不抛异常）。
 *
 * 元素裁决律：
 *   · 双源（vlmElements 与 localElements 皆非空）⇒ arbitrateElements 数学仲裁
 *     （数值细节全由兄弟器官裁决，本器官只做形态转写）。仲裁输出次序为契约
 *     行为 —— vlm 序（融合与 VLM 单源混排）在前、本地单源殿后 —— 故结果前
 *     vlmList.length 个恰与 vlm 序一一对应，据此回填 vlm 角色（ΝΩ-14：回填经
 *     arbitrationRoleAt 防御执法 —— source 与位置不符的错配位记 'unknown'，
 *     不炸、错配可见）；本地单源元素无角色语义，记 'unknown'；interactive 按
 *     role 三态化（fusion 亦同律）。
 *   · 单源 ⇒ 直映（source 记该侧；role 仍 vlm 优先/缺省 'unknown'）。
 *   · 零源 ⇒ elements:[] 且 degraded 记 'elements'（无证据不伪造）。
 *
 * 其余记账：ocrText 缺席 ⇒ degraded 记 'ocr'（在场则截 2000 为 textDigest）；
 * dhash 无效（缺席/空串）⇒ 透传 null 并记 'dhash'；popups 为 popupNotes 去空串；
 * sceneLabel 缺省 ''；notes（ΝΩ-14 门控申报面）为入参去空串、缺省 []；
 * focusedRegion 透传（缺席 null）；takenAt 取 now（缺省
 * Date.now()）；image 缺席不管 —— 快照不持有像素。脏输入（非数组/非字符串/
 * NaN）一律卫兵式收敛，绝不抛错。
 */
export function composeSnapshot(inputs) {
    const degraded = [];
    const vlmList = Array.isArray(inputs?.vlmElements) ? inputs.vlmElements : [];
    const localList = Array.isArray(inputs?.localElements) ? inputs.localElements : [];
    let elements;
    if (vlmList.length > 0 && localList.length > 0) {
        // 双源 ⇒ 仲裁融合。次序对齐：结果前 vlmList.length 位 ↔ vlm 序（角色回填锚点）
        // 纪元 Θ（Θ-4 生产接线）：仲裁参数显式传内核注册表现值 —— 未注册时
        // getOrDefault 回声 0.5 / 0.15（与 arbitrateElements 自身缺省同律），零行为变化。
        const verdict = arbitrateElements(vlmList, localList, {
            iouThreshold: kernelRegistry.getOrDefault('arbitration.iouThreshold', 0.5),
            agreementBonus: kernelRegistry.getOrDefault('arbitration.agreementBonus', 0.15),
        });
        const out = Array.isArray(verdict?.elements) ? verdict.elements : [];
        elements = out.map((e, i) => {
            const source = e.source === 'local' || e.source === 'fusion' ? e.source : 'vlm';
            // ΝΩ-14：role 回填经 arbitrationRoleAt 防御执法 —— 次序契约位照旧回填
            // vlm 角色；source 与位置不符（次序错乱的仲裁输出）⇒ 'unknown'（不炸、
            // 错配经 source 可见）。契约守序输出下与原内联回填逐字节等价。
            const role = arbitrationRoleAt(vlmList, i, source);
            return toElement(e, source, role);
        });
    }
    else if (vlmList.length > 0) {
        elements = vlmList.map((v) => toElement(v, 'vlm', roleOr(v?.role)));
    }
    else if (localList.length > 0) {
        elements = localList.map((l) => toElement(l, 'local', 'unknown'));
    }
    else {
        elements = [];
        degraded.push('elements');
    }
    // OCR：缺席记降级；在场截 2000（上下文带宽礼仪）
    const ocrRaw = inputs?.ocrText;
    if (typeof ocrRaw !== 'string')
        degraded.push('ocr');
    // ΠΑΝ-61（截断盲区的诚实申报）：语料超限时记 'digest-truncated' —— 截断后
    // 的 textDigest 是**部分证据**（2000 字后的禁词不可见），消费方（否定判据
    // 复核等）据此不得把「语料在场未命中」当「确认不存在」；⑧′ 的当帧重采端口
    //（autoPilot ΠΑΝ-61）供未截断全文，本标记是其降级路径的留痕面。
    const textDigest = typeof ocrRaw === 'string' ? ocrRaw.slice(0, TEXT_DIGEST_MAX) : '';
    if (typeof ocrRaw === 'string' && ocrRaw.length > TEXT_DIGEST_MAX)
        degraded.push('digest-truncated');
    // dhash：透传；无效指纹按 null 记并降级
    const dhash = validDhash(inputs?.dhash);
    if (dhash === null)
        degraded.push('dhash');
    // 弹窗注记：去空串（空注记不是证据，是噪声）
    const popups = (Array.isArray(inputs?.popupNotes) ? inputs.popupNotes : []).filter((p) => typeof p === 'string' && p.length > 0);
    // ΝΩ-14 感知注记：门控决策的诚实申报 —— 与 popups 同律去空串透传；复用不是
    // 降级，绝不混入 degraded（既有「证据源缺席」消费面零污染）
    const notes = (Array.isArray(inputs?.notes) ? inputs.notes : []).filter((n) => typeof n === 'string' && n.length > 0);
    const now = typeof inputs?.now === 'number' && Number.isFinite(inputs.now) ? inputs.now : Date.now();
    return {
        takenAt: now,
        width: finiteOr0(inputs?.width),
        height: finiteOr0(inputs?.height),
        dhash,
        elements,
        textDigest,
        popups,
        focusedRegion: inputs?.focusRegion ?? null,
        sceneLabel: typeof inputs?.sceneLabel === 'string' ? inputs.sceneLabel : '',
        notes,
        degraded,
    };
}
/**
 * 世界是否动了：prev/curr 两张快照的变化判决（纯函数、绝不抛异常）。
 * 判决级联（自上而下短路）：
 *   ① prev=null ⇒ true（首见世界必为「变」—— 没有旧世界可比）；
 *   ② 任一侧 dhash 缺席（null/空）⇒ true —— 指纹缺席时宽松判变：宁可重看，
 *      不可漏看；
 *   ③ 指纹不可比（长度不一/非十六进制字符）⇒ true（与②同源的宽松律）；
 *   ④ 十六进制 dhash 汉明距离 > hammingTolerance（缺省 3，负数/非有限数按
 *      缺省记）⇒ true —— 像素级运动超容差；
 *   ⑤ 指纹判同（距离 ≤ 容差）但 elements 数量突变 >30% ⇒ true —— 结构性
 *      变化。整数安全式 |Δn|×10 > 3×max(n_prev, n_curr)，分母取双侧最大：
 *      对称、且对 0→N 零除免疫（恰落 30% 线为排他边界，不算变）；
 *   ⑥ 否则 false。
 */
export function snapshotChanged(prev, curr, hammingTolerance) {
    if (prev === null || prev === undefined)
        return true;
    // 纪元 Θ（Θ-4 生产接线）：缺省容差读内核注册表（world.hammingTolerance，
    // 区间 [1,8]）—— 未注册 ⇒ getOrDefault 回声 DEFAULT_HAMMING_TOLERANCE(3)，
    // 行为逐字节不变；显式入参仍最高优先。runtime 调用处不传参 ⇒ 经此缺省缝
    // 读注册表（接线二选一：本缺省接法 + runtime 不动）。
    const tolerance = typeof hammingTolerance === 'number' && Number.isFinite(hammingTolerance) && hammingTolerance >= 0
        ? hammingTolerance
        : kernelRegistry.getOrDefault('world.hammingTolerance', DEFAULT_HAMMING_TOLERANCE);
    const prevHash = validDhash(prev.dhash);
    const currHash = validDhash(curr?.dhash);
    if (prevHash === null || currHash === null)
        return true;
    const distance = hammingDistanceHex(prevHash, currHash);
    if (distance === null)
        return true;
    if (distance > tolerance)
        return true;
    const prevCount = Array.isArray(prev.elements) ? prev.elements.length : 0;
    const currCount = Array.isArray(curr?.elements) ? curr.elements.length : 0;
    if (Math.abs(currCount - prevCount) * 10 > 3 * Math.max(prevCount, currCount))
        return true;
    return false;
}
/**
 * 在快照中找东西：大小写不敏感 + 空白折叠后的**双向子串**匹配 —— query 含于
 * label（全名指物）或 label 含于 query（物名不全，如「打开设置面板」命中
 * 「设置」）。命中按 confidence 降序（同分保持快照原序 —— 稳定排序），截
 * opts.limit（缺省 5；负数/非有限数按缺省记）。不按 role 筛选 —— 角色过滤
 * 交给调用方与 interactiveElements 组合使用。空 query / 空标签不入检索：
 * 检索要具体的证据，不做全集匹配。纯函数（sort 作用于过滤副本）、绝不抛异常。
 */
export function findInSnapshot(snap, query, opts) {
    const pool = snap && Array.isArray(snap.elements) ? snap.elements : [];
    const q = foldText(query);
    if (q.length === 0)
        return [];
    const limit = typeof opts?.limit === 'number' && Number.isFinite(opts.limit) && opts.limit >= 0
        ? Math.floor(opts.limit)
        : DEFAULT_FIND_LIMIT;
    return pool
        .filter((el) => {
        const label = foldText(el?.label);
        if (label.length === 0)
            return false; // 无标签元素不可名状，不入检索
        return label.includes(q) || q.includes(label);
    })
        .sort((a, b) => finiteOr0(b?.confidence) - finiteOr0(a?.confidence))
        .slice(0, limit);
}
/**
 * 快照中已知可交互的元素（interactive === true 的三态过滤）：已知纯文本
 * （false）与证据不足（null）皆不入选 —— 点击层只消费「确定能点」的清单。
 * 次序保持快照原序；纯函数、绝不抛异常。
 */
export function interactiveElements(snap) {
    const pool = snap && Array.isArray(snap.elements) ? snap.elements : [];
    return pool.filter((el) => el?.interactive === true);
}
