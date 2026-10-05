// src/sandbox/actionSchema.ts
// ΑΩ-R19（rehearse_chain 入参执法）：手写防御式校验器 —— 零依赖，卫兵式收敛
// （风格对齐 virtualScreen.asVirtualWidget 先例：畸形输入拒收并归因，绝不夹取、
// 绝不静默、绝不抛）。此前 rehearse_chain 对 actions 只做 JSON.parse + 非空数组
// 检查，kind/args 无 schema 即进引擎 —— 模型输出的未知 kind / 越界坐标 / 超长
// 字符串经 as 断言混入执行域（types.SANDBOX_ACTION_KINDS 的注释早已立法，本文件
// 是它在工具边界的执法落点）。
// 单源纪律：kind 闭集 = types.SANDBOX_ACTION_KINDS、expect.scale 闭集 =
// types.EXPECTED_EFFECT_SCALES —— 本文件绝不复制第二份词表。
// 拒绝语义：任一条目非法 ⇒ 整链拒绝（不逐条丢弃 —— 半截链排练出的证词是毒证），
// 拒绝原因如实返回给调用方进 FAILED 结果（《异常诚实分层契约》第二条：不抛）。
import { EXPECTED_EFFECT_SCALES, SANDBOX_ACTION_KINDS, } from './types.js';
// ΠΑΝ-40b：场景铸造卫兵复用 virtualScreen.asVirtualWidget（同一防御方言 ——
// 畸形 rect 拒收、值即边界；本文件绝不复制第二份几何校验）。
import { asVirtualWidget } from './virtualScreen.js';
/** 防御性上限（结构性常量而非部署调调参 —— 拒绝面的边界，不是行为旋钮） */
export const ACTION_LIMITS = {
    /** 单链动作数上限（无界数组 = 无界排练 = 无界账本） */
    maxActions: 64,
    /** 单字符串字段字符上限（type_text.text / 描述类 / expect 文本字段） */
    maxStringChars: 2000,
    /** 单次热键组合键数上限 */
    maxHotkeyKeys: 8,
    /** 滚动量上限（正数域；无界 amount = 无界物理滚动） */
    maxScrollAmount: 10_000,
};
/** 归一化坐标卫兵：有限且在 [0,1]（JSON.parse 可产出 Infinity/NaN —— 必须 Finite 检查） */
function isFinite01(v) {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}
/** 有界字符串卫兵：string 且 ≤ 上限（返回拒绝归因或 null=合格） */
function stringError(v, field, allowEmpty) {
    if (typeof v !== 'string')
        return `${field}: must be a string`;
    if (!allowEmpty && v.length === 0)
        return `${field}: must not be empty`;
    if (v.length > ACTION_LIMITS.maxStringChars) {
        return `${field}: length ${v.length} exceeds limit ${ACTION_LIMITS.maxStringChars}`;
    }
    return null;
}
const SCROLL_DIRECTIONS = new Set(['up', 'down', 'left', 'right']);
const TAB_DIRECTIONS = new Set(['next', 'previous']);
const MOUSE_BUTTONS = new Set(['left', 'right', 'middle']);
/** 单条动作校验：返回拒绝归因（null = 合格）。永不抛 —— 一切形状疑问都是拒绝 */
function actionError(raw, index) {
    const at = `actions[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return `${at}: must be an object`;
    }
    const rec = raw;
    const kind = rec.kind;
    if (typeof kind !== 'string' || !SANDBOX_ACTION_KINDS.has(kind)) {
        // 闭集从 types 单源展开（不手抄第二份词表进报错文案）
        return `${at}.kind: ${JSON.stringify(kind ?? null)} not in closed vocabulary `
            + `(${[...SANDBOX_ACTION_KINDS].join('|')})`;
    }
    if (rec.args !== undefined
        && (typeof rec.args !== 'object' || rec.args === null || Array.isArray(rec.args))) {
        return `${at}.args: must be an object`;
    }
    const a = (rec.args ?? {});
    // 逐 kind 必填/值域执法（与 engine/virtualScreen 的消费方言逐字对齐）
    switch (kind) {
        case 'click_mouse': {
            if (!isFinite01(a.x))
                return `${at}.args.x: ${JSON.stringify(a.x ?? null)} must be a finite number in [0,1]`;
            if (!isFinite01(a.y))
                return `${at}.args.y: ${JSON.stringify(a.y ?? null)} must be a finite number in [0,1]`;
            if (a.button !== undefined && (typeof a.button !== 'string' || !MOUSE_BUTTONS.has(a.button))) {
                return `${at}.args.button: ${JSON.stringify(a.button)} not in (${[...MOUSE_BUTTONS].join('|')})`;
            }
            if (a.target_description !== undefined) {
                const err = stringError(a.target_description, `${at}.args.target_description`, true);
                if (err)
                    return err;
            }
            break;
        }
        case 'type_text': {
            const err = stringError(a.text, `${at}.args.text`, true);
            if (err)
                return err;
            break;
        }
        case 'scroll_page': {
            if (typeof a.direction !== 'string' || !SCROLL_DIRECTIONS.has(a.direction)) {
                return `${at}.args.direction: ${JSON.stringify(a.direction ?? null)} not in (${[...SCROLL_DIRECTIONS].join('|')})`;
            }
            const amount = a.amount;
            if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
                return `${at}.args.amount: ${JSON.stringify(amount ?? null)} must be a finite positive number`;
            }
            if (amount > ACTION_LIMITS.maxScrollAmount) {
                return `${at}.args.amount: ${amount} exceeds limit ${ACTION_LIMITS.maxScrollAmount}`;
            }
            break;
        }
        case 'press_hotkey': {
            if (!Array.isArray(a.keys) || a.keys.length === 0) {
                return `${at}.args.keys: must be a non-empty array`;
            }
            if (a.keys.length > ACTION_LIMITS.maxHotkeyKeys) {
                return `${at}.args.keys: ${a.keys.length} keys exceed limit ${ACTION_LIMITS.maxHotkeyKeys}`;
            }
            for (let k = 0; k < a.keys.length; k++) {
                const err = stringError(a.keys[k], `${at}.args.keys[${k}]`, false);
                if (err)
                    return err;
            }
            break;
        }
        case 'drag_mouse': {
            for (const field of ['startX', 'startY', 'endX', 'endY']) {
                if (!isFinite01(a[field])) {
                    return `${at}.args.${field}: ${JSON.stringify(a[field] ?? null)} must be a finite number in [0,1]`;
                }
            }
            break;
        }
        case 'switch_tab': {
            if (a.direction !== undefined
                && (typeof a.direction !== 'string' || !TAB_DIRECTIONS.has(a.direction))) {
                return `${at}.args.direction: ${JSON.stringify(a.direction)} not in (${[...TAB_DIRECTIONS].join('|')})`;
            }
            break;
        }
        case 'switch_window': {
            const err = stringError(a.titleKeyword, `${at}.args.titleKeyword`, false);
            if (err)
                return err;
            break;
        }
        case 'dismiss_popup':
        case 'noop':
            break; // 元动作：无必填参数（无状态模型 —— 值即边界）
        default:
            // 闭集已由 SANDBOX_ACTION_KINDS 判定，default 不可达；防御式兜底仍拒
            return `${at}.kind: ${JSON.stringify(kind)} not in closed vocabulary`;
    }
    // expect 可选块：在场 ⇒ scale 闭集 + 文本字段有界（scale 词表单源自 types）
    if (rec.expect !== undefined) {
        if (typeof rec.expect !== 'object' || rec.expect === null || Array.isArray(rec.expect)) {
            return `${at}.expect: must be an object`;
        }
        const scale = rec.expect.scale;
        if (typeof scale !== 'string' || !EXPECTED_EFFECT_SCALES.has(scale)) {
            return `${at}.expect.scale: ${JSON.stringify(scale ?? null)} not in closed vocabulary `
                + `(${[...EXPECTED_EFFECT_SCALES].join('|')})`;
        }
        for (const field of ['expectedText', 'sceneHint']) {
            const v = rec.expect[field];
            if (v === undefined)
                continue;
            const err = stringError(v, `${at}.expect.${field}`, true);
            if (err)
                return err;
        }
    }
    return null;
}
/**
 * rehearse_chain 入参校验（工具边界执法）。纯函数、零依赖、永不抛。
 * 任一条目非法 ⇒ 整链拒绝（reason 如实归因）；全部合格 ⇒ 收窄为 SandboxAction[]。
 */
export function validateActionChainInput(rawActions) {
    if (!Array.isArray(rawActions) || rawActions.length === 0) {
        return { ok: false, reason: 'actions must be a non-empty JSON array' };
    }
    if (rawActions.length > ACTION_LIMITS.maxActions) {
        return { ok: false, reason: `actions: length ${rawActions.length} exceeds limit ${ACTION_LIMITS.maxActions}` };
    }
    for (let i = 0; i < rawActions.length; i++) {
        const err = actionError(rawActions[i], i);
        if (err !== null)
            return { ok: false, reason: err };
    }
    return { ok: true, actions: rawActions };
}
/** 单链场景控件数上限（结构性常量 —— 无界场景 = 无界排练世界） */
const MAX_SCENE_WIDGETS = 256;
/** virtual_scene 入参校验（工具边界执法）。纯函数、永不抛。 */
export function validateVirtualSceneInput(rawScene) {
    if (!Array.isArray(rawScene)) {
        return { ok: false, reason: 'virtual_scene must be a JSON array of widgets' };
    }
    if (rawScene.length === 0) {
        return { ok: false, reason: 'virtual_scene: empty array — omit the parameter for honest degraded rehearsal' };
    }
    if (rawScene.length > MAX_SCENE_WIDGETS) {
        return { ok: false, reason: `virtual_scene: length ${rawScene.length} exceeds limit ${MAX_SCENE_WIDGETS}` };
    }
    const scene = [];
    for (let i = 0; i < rawScene.length; i++) {
        const w = asVirtualWidget(rawScene[i]);
        if (w === null) {
            return {
                ok: false,
                reason: `virtual_scene[${i}]: malformed widget (rect must be finite, normalized `
                    + '[0,1] with positive width/height)',
            };
        }
        scene.push(w);
    }
    return { ok: true, scene };
}
