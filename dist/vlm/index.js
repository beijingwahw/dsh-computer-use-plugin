import { resetGlmClient, getGlmClient, attachFailoverPool, attachCascadeFace, attachVlmRateLimiter } from './glmClient.js';
import { vlmMeter, VlmRateLimiter } from './metering.js';
import { kernelRegistry } from '../kernel/registry.js';
import { createProviderPool } from './providers/failover.js';
// W3-0（W2-8 C2 接线）：成本级联执行体 —— cascade 全族已经 './providers/index'
// （第 44 行 export * from './cascade'）再分发，本文件只额外按值引入铸造所需的
// 执行体与谓词类型（与 createProviderPool 自 './providers/failover' 直引同律）。
import { VlmCascade } from './providers/cascade.js';
import { matchesDangerPatterns, matchesRiskPatterns } from '../riskGate.js';
// ΠΑΝ-24（dhash 场景指纹）：perceptualHash 纯函数直引 —— 与 grounding 同律
//（dhash 经 _legacyDeps 懒加载 sharp，无环；级联分诊自此用真实场景指纹，
// 不再以 prompt-LRU 冒充）。
import { dhash } from '../perceptualHash.js';
// 纪元 Β（反驳法院）：第二意见面的装配物料 + 法院本体再分发
import { createEnsembleCourt, EnsembleCourt } from './providers/ensemble.js';
import { attachRefuteFace, isSameRefuteSource } from './refute.js';
// 纪元 Λ（开箱即亮）：连接存档 / 本地自动接管 / 向导服务 三模块再分发
export * from './connection.js';
export * from './autoAdopt.js';
export * from './onboarding.js';
export * from './glmClient.js';
export * from './codec.js';
export * from './som.js';
export * from './grounding.js';
export * from './vlmOcr.js';
export * from './verdict.js';
export * from './diffExplainer.js';
export * from './diagnosis.js';
export * from './arbitration.js';
export * from './metering.js';
export * from './refute.js';
export * from './providers/index.js';
// ─── 宿主接线入口 ───
/** 安全读配置字符串：非字符串/空白归 ''（schema 缺省与手写配置双方言防御） */
function cfgStr(v) {
    return typeof v === 'string' ? v.trim() : '';
}
/** Ω 纪元 vlmBaseUrl 的 schema 缺省值（GLM 官方基址） */
const GLM_ERA_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
/** Ω 纪元 vlmModel 的 schema 缺省值 */
const GLM_ERA_MODEL = 'glm-5.3-flash';
/**
 * Ω 纪元 schema 缺省值在平台切换时视为缺席 —— 宿主把 vlmBaseUrl/vlmModel 的
 * schema 缺省（GLM 基址/模型名）填进了 config，若原样透传给非 glm 平台，
 * vlmProvider='openai' 会拿到 GLM 基址而指错脑。仅对显式非 glm 平台生效；
 * glm 平台或缺省平台下该值本就等于预设缺省，透传无害（行为不变）。
 */
function eraDefaultStr(v, eraDefault, provider) {
    return provider !== '' && provider !== 'glm' && v === eraDefault ? '' : v;
}
// ─── 池与单例双轨（纪元 Ψ） ───
/** 模块级备选池单例 —— vlmFallbackProviders 非空时铸造；null = 未铸池 */
let poolSingleton = null;
/**
 * 计量缺省接线（纪元 Δ-6）：configureVlm 铸造时把 vlmMeter 单例挂入 meter ——
 * 云脑的每一次心跳（单例 glm/委托路径 + 备选池全脑）落进模块级台账，
 * summary()/exportJsonl() 观测面自此有生产消费者。字段对齐零适配：
 * GlmMeterRecord 与 metering.VlmCallRecord 逐一同名同型（ts/kind/model/latencyMs/
 * ok/promptTokens/completionTokens/error）；ProviderMeterRecord 仅多 providerId
 * 归因字段，VlmMeter.record 的消毒副本自然剥落。直接构造 GlmClient / 池且显式
 * 给了 meter 的消费面不受影响 —— 用户显式 meter 优先，本缺省只在 configureVlm
 * 铸造路径注入（缺省=GLM 路径的既有 meter kind 'glm.chat' 等行为逐字节保持）。
 */
const vlmMeterTap = (rec) => {
    try {
        vlmMeter.record(rec);
    }
    catch { /* 计量故障静默 —— 主路径无关（VlmMeter.record 自身绝不抛，双保险） */ }
};
/**
 * 取模块级 ProviderPool（只读快照）—— 未铸池时 null。
 *
 * 双轨取舍（JSDoc 契约 → P2a-1 升格为「贯通双轨」）：本池与 GlmClient 单例曾
 * 是双轨并存、互不感知 —— 单例（getGlmClient）保 Ω 纪元 glm 路径逐字节不变，
 * 池只服务 vlm_platforms 工具与健康报告等显式消费面，主力路径（ask_screen /
 * grounding / vlmOcr 走的 getGlmClient chat/chatJson）失败后不切备脑 —— 这正是
 * 全库遍历报告点名的缺陷（用户配了 vlmFallbackProviders 以为有容错，实际主力
 * 路径没有）。P2a-1 贯通：configureVlm 铸池时把池注入单例的失败咨询面
 * （attachFailoverPool），单例 chat/chatJson 自身重试全败后按池序取首个健康脑
 * 救回（providerId 标注来源 + note:'failover'）；不配 fallbacks（池 null）⇒
 * 单例行为与 Ω 纪元逐字段一致。池另供 vlm_platforms 工具与健康报告消费
 * （createProviderPool 铸造，熔断跳行见 failover.ts）。
 */
export function getProviderPool() {
    return poolSingleton;
}
// ─── W3-0（W2-8 C2 成本级联路由）：级联铸造与咨询面接线 ───
/** 模块级级联执行体单例 —— tiers 显式标注了 cheap 档且池在场时铸造；null = 未铸 */
let cascadeSingleton = null;
/** 取模块级 VlmCascade（只读快照 —— 可观测性/测试面）；未铸时 null */
export function getVlmCascade() {
    return cascadeSingleton;
}
/**
 * W3-0：CSV tier 标注表解析（"id=tier" 逗号分隔；tier ∈ cheap|primary，键为池内
 * provider id）。脏段（无 = / 空 id / 非法 tier）安静跳过 —— 配置错误不毒化铸池
 *（与 fallbacks CSV 的宽容解析同律，绝不抛）。
 */
function parseProviderTiers(raw) {
    const out = {};
    for (const part of raw.split(',')) {
        const seg = part.trim();
        const eq = seg.indexOf('=');
        if (eq <= 0)
            continue;
        const id = seg.slice(0, eq).trim().toLowerCase();
        const tier = seg.slice(eq + 1).trim().toLowerCase();
        if (id === '' || (tier !== 'cheap' && tier !== 'primary'))
            continue;
        out[id] = tier;
    }
    return out;
}
/**
 * W3-0：便宜臂法定校验谓词（缺省内建）—— 结构性 JSON 判定（解析值为非 null
 * 对象/数组）。glmClient 咨询桥不携带逐调用谓词物料（bbox/OCR 期望等调用点
 * 语境在桥的另一端不可得），故铸池面只内建这一条确定性谓词：它保证「采信的
 * 便宜答案必须是结构完整的 JSON 值」，而逐调用语义校验（withinBbox/
 * ocrText/schema 族）保留给携带得动语境的直接消费面。校验不过 ⇒ 安全升级
 * 主力重做（失败安全方向恒为多花一次主力调用，而非错答上屏）。
 */
const cascadeStructuralValidator = {
    name: 'json-structural',
    check(value) {
        return value !== null && (Array.isArray(value) || typeof value === 'object');
    },
};
// ─── ΝΩ-18（桥面语义谓词）：按请求类型注册的便宜臂法定校验 ───
//
// 病灶：级联桥原只内建「非空对象/数组」一条结构性谓词 —— grounding 空 elements
// 数组、verdict 缺字段（或枚举外值）、OCR 缺 words 的便宜答案都过检直采，语义
// 空转白省钱且错答上屏风险全靠下游兜底。修法：咨询桥按请求类型（prompt/system
// 的稳定标记词，与 som.ts 三提示词构造器同源）追加语义谓词 —— 谓词不过 ⇒ 走
// cascade 既有升级路径（便宜答案作废、主力档重做）；未命中任何类型的泛化请求
//（ask_screen 等）保持纯结构校验（零行为变化律）。
/** verdict 合法枚举（verdict.ts VlmVerdictLevel 同集 —— 本地声明避免器官耦合） */
const CASCADE_VERDICT_ENUM = new Set(['confirmed', 'refuted', 'uncertain']);
/** bbox 双形态判定（grounding.parseBbox 同律）：[x0,y0,x1,y1] ≥4 有限数 或
 *  {x0,y0,x1,y1} 四有限数 —— 其余形态（缺字段/非有限）不可验证 */
function hasParseableBbox(raw) {
    let ns;
    if (Array.isArray(raw)) {
        if (raw.length < 4)
            return false;
        ns = [raw[0], raw[1], raw[2], raw[3]];
    }
    else if (raw !== null && typeof raw === 'object') {
        const o = raw;
        ns = [o.x0, o.y0, o.x1, o.y1];
    }
    else {
        return false;
    }
    return ns.every(n => typeof n === 'number' && Number.isFinite(n));
}
export function classifyCascadeRequest(req) {
    try {
        const sys = typeof req?.system === 'string' ? req.system : '';
        const p = typeof req?.prompt === 'string' ? req.prompt : '';
        if (sys.includes('屏幕元素定位器') || p.includes('列出图中所有可交互元素'))
            return 'grounding';
        if (p.includes('对比前图与后图'))
            return 'verdict';
        if (p.includes('识别图中所有可见文字'))
            return 'ocr';
        return 'generic';
    }
    catch {
        return 'generic';
    }
}
/**
 * ΝΩ-18：按请求类型注册的语义谓词集（级联桥的 perCall 追加面）：
 *  - grounding ⇒ elements 数组非空且首条有 bbox（双方言：裸数组 / {elements}，
 *    与 grounding.ts 的双形态收窄同律）—— 空 elements = 便宜脑没看见东西，
 *    主力档值得再试一次；
 *  - verdict ⇒ verdict ∈ {confirmed, refuted, uncertain} 枚举（verdict.ts 同集）；
 *  - OCR ⇒ words 在场（{words:[...]} 或裸数组方言，与 vlmOcr.ts 同律 ——
 *    空数组是合法 OCR 结果「屏上无字」，只要求字段在场）。
 * 谓词不过 ⇒ cascade 现有升级路径（validation-failed:<name> 点名）。
 * 导出面：测试/可观测消费。
 */
export function cascadeSemanticValidators(req) {
    const kind = classifyCascadeRequest(req);
    if (kind === 'grounding') {
        return [{
                name: 'semantic-grounding',
                check(value) {
                    try {
                        const els = Array.isArray(value)
                            ? value
                            : value !== null && typeof value === 'object' && Array.isArray(value.elements)
                                ? value.elements
                                : null;
                        if (!Array.isArray(els) || els.length === 0)
                            return false;
                        const first = els[0];
                        return first !== null && typeof first === 'object'
                            && hasParseableBbox(first.bbox);
                    }
                    catch {
                        return false;
                    }
                },
            }];
    }
    if (kind === 'verdict') {
        return [{
                name: 'semantic-verdict',
                check(value) {
                    try {
                        if (value === null || typeof value !== 'object' || Array.isArray(value))
                            return false;
                        const v = value.verdict;
                        return typeof v === 'string' && CASCADE_VERDICT_ENUM.has(v);
                    }
                    catch {
                        return false;
                    }
                },
            }];
    }
    if (kind === 'ocr') {
        return [{
                name: 'semantic-ocr',
                check(value) {
                    try {
                        if (Array.isArray(value))
                            return true; // 裸数组方言 = words 本体
                        return value !== null && typeof value === 'object'
                            && Array.isArray(value.words);
                    }
                    catch {
                        return false;
                    }
                },
            }];
    }
    return [];
}
/**
 * ΝΩ-18/ΠΑΝ-24：级联咨询桥的装配体（从 configureVlm 提取为具名函数 —— 同一
 * 表达式供生产接线与测试直用）：请求级动态因子（ΑΩ-R2）+ 按请求类型的语义
 * 谓词（追加在实例结构谓词之后 —— cascade 的 [...base, ...extra] 合并律）。
 * ΠΑΝ-24 执法序（因子求值去副作用）：① 先取场景指纹（首帧 dhash 经注入端口，
 * 指纹不可得 ⇒ null）；② 因子纯读求值（记忆命中判定，不写账）+ 级联裁决；
 * ③ 裁决**之后**才把指纹记入场景记忆（rememberCascadeScene）—— 本次分诊
 * 不受本次记账影响。绝不抛。
 */
export function wireCascadeConsultFace(cascade) {
    attachCascadeFace({
        consultJson: async (req) => {
            const semantic = cascadeSemanticValidators(req);
            // ΠΑΝ-24：指纹先算一次（端口故障/无图 ⇒ null ⇒ 新场景保守）
            const fingerprint = await cascadeSceneFingerprint(req);
            const out = await cascade.runJson(req, {
                factors: cascadeRequestFactors(req, { sceneFingerprint: fingerprint }),
                ...(semantic.length > 0 ? { validators: semantic } : {}),
            });
            // ΠΑΝ-24：观察记账在裁决之后（同屏复现是便宜信号，不得反过来影响本次分诊）
            rememberCascadeScene(fingerprint);
            return out;
        },
    });
}
// ─── ΑΩ-R2（级联因子源点亮）+ ΠΑΝ-24（dhash 场景指纹）：请求级三因子分诊 ───
//
// 病灶（暗功能）：W3-0 原接线把 factors 供成静态保守值（中危/新场景/中性置信 ⇒
// danger 恒 0.6 > 缺省阈值 0.35）—— 便宜臂在缺省配置下永不触发，配了便宜档的
// 部署买不到一次省钱。修法：咨询桥携带的请求物料在此变现为真实动态因子，经
// perCall.factors 压过实例保守源（W2-8g 优先级律）：
//   · risk —— riskGate 词法风险分级（混淆归一同律）：危险词/凭据词 ⇒ high
//     （danger ≥ 0.4 恒主力）；只读观察语义且无危险词 ⇒ low；不可分类 ⇒
//     medium（保守回落，诚实原则：无证据不便宜）；
//   · sceneFamiliar —— ΠΑΝ-24 修正：**真实 dhash 场景指纹**（perceptualHash.dhash
//     纯函数，经 CascadeSceneHashPort 结构化端口注入 —— 端口面杜绝
//     providers/cascade 对 src 根的静态依赖与环引；sharp 缺席/解码失败 ⇒ 指纹
//     null ⇒ 按新场景保守）。此前实现是「同 prompt 原文 LRU(32)」冒充场景指纹
//     —— 同一句 prompt 在全新屏幕上复现即记 sceneFamiliar=true ⇒ danger 低估 ⇒
//     便宜臂在完全陌生的界面上被点亮，与「新场景保守」的分诊初衷相反（桌面
//     自动化任务语句高度重复、屏幕瞬息万变，错位是常态）。现在：同屏（dhash
//     汉明 0 精确命中，与 grounding 同屏缓存 ΝΩ-48 同尺）复现才算旧场景。
//     因子求值**纯读无副作用**（记忆命中判定不写账）；观察记账
//     （rememberCascadeScene）由咨询桥在裁决**之后**另行执行 —— 「纯函数分诊」
//     的承诺自此成立（此前因子求值顺手写 LRU，把承诺打穿）；
//   · confidence —— 调用方上下文在 GlmVisionRequest 上不可得（无置信字段），
//     诚实保持中性 0.5。
// 校准一致性（缺省权重 0.4/0.4/0.2 与缺省阈值 0.35 均被 w2cascade/w3wire 既有
// 断言钉死，本接线只校准因子不动数学）：低危 + 同屏复现 ⇒ danger =
// 0.4×(1−0.5) = 0.2 < 0.35 ⇒ 便宜臂真正点亮；危险词 ⇒ risk=high ⇒ danger ≥
// 0.4×1 = 0.4 > 0.35 ⇒ 恒主力（场景再熟、置信再高也压不进便宜臂）。
/** 只读观察语义标记（中文动词族 —— 观察语义；不含动作词，命中且无危险词 ⇒ low） */
const CASCADE_READONLY_MARKERS_ZH = [
    '列出', '识别', '读取', '读出', '描述', '对比', '比较', '判断', '找出', '检查', '观察', '转写',
];
/** 只读观察语义标记（英文 —— 词边界匹配，防 'already' ⊃ 'read' 类子串误判） */
const CASCADE_READONLY_MARKERS_EN = /\b(describe|list|read|detect|recogni[sz]e|compare|locate|identify|observe|transcribe|ocr)\b/i;
/**
 * ΠΑΝ-24：近期场景指纹记忆上限（LRU —— Map 保序即 LRU；满后逐出最旧）。
 * 取 64 与 grounding 同屏语义缓存（ΝΩ-48）同尺 —— 场景窗口内有界。
 */
const CASCADE_FAMILIAR_SCENE_LIMIT = 64;
/** ΠΑΝ-24：模块级场景指纹记忆 —— 键 = dhash 位串（汉明 0 精确命中），值恒 true */
const cascadeSceneMemory = new Map();
/** 缺省场景指纹端口：dhash 纯函数包装（一切故障 ⇒ null，绝不抛） */
const defaultCascadeSceneHashPort = async (imageBase64) => {
    try {
        const fp = await dhash(Buffer.from(imageBase64, 'base64'));
        return typeof fp === 'string' && fp !== '' ? fp : null;
    }
    catch {
        return null;
    }
};
let cascadeSceneHashPort = defaultCascadeSceneHashPort;
/**
 * ΠΑΝ-24：注入/摘除场景指纹端口 —— 传 null 摘除（恒新场景保守）；传 undefined
 * 复位缺省 dhash 端口（测试恢复缝）。垃圾输入安静归 null（不抛铁律）。
 */
export function attachCascadeSceneHashPort(port) {
    try {
        cascadeSceneHashPort = port === undefined ? defaultCascadeSceneHashPort : port;
    }
    catch {
        cascadeSceneHashPort = null;
    }
}
/** 请求首帧 base64 提取（脏值防御 —— 图像缺席/形状不对 ⇒ ''） */
function firstFrameBase64(req) {
    try {
        const arr = req?.images;
        if (!Array.isArray(arr) || arr.length === 0)
            return '';
        const first = arr[0];
        return typeof first?.base64 === 'string' ? first.base64 : '';
    }
    catch {
        return '';
    }
}
/**
 * ΠΑΝ-24：请求的场景指纹（永不抛）—— 首帧经注入端口取 dhash；端口缺席 /
 * 无图像 / 端口故障 / 指纹空 ⇒ null（指纹不可得 = 无场景证据，按新场景保守）。
 * 请求形状宽纳（images/prompt/system 只读，与咨询桥的 GlmVisionRequest 同构）。
 * 导出面：测试/可观测消费。
 */
export async function cascadeSceneFingerprint(req) {
    const port = cascadeSceneHashPort;
    const b64 = firstFrameBase64(req);
    if (port === null || b64 === '')
        return null;
    try {
        const fp = await port(b64);
        return typeof fp === 'string' && fp !== '' ? fp : null;
    }
    catch {
        return null;
    }
}
/**
 * ΠΑΝ-24：场景熟悉度（**纯读，零副作用**）—— 指纹在近期场景记忆中精确命中
 * （dhash 汉明 0）⇒ true；指纹 null / 未命中 ⇒ false（新场景保守）。
 * 导出面：测试/可观测消费。
 */
export function cascadeSceneFamiliar(fingerprint) {
    try {
        if (typeof fingerprint !== 'string' || fingerprint === '')
            return false;
        return cascadeSceneMemory.has(fingerprint);
    }
    catch {
        return false;
    }
}
/**
 * ΠΑΝ-24：观察记账 —— 把场景指纹记入 LRU（咨询桥在**因子求值之后**调用：
 * 本次分诊不受本次记账影响 —— 因子求值去副作用的执法点）。指纹 null 安静
 * 跳过（无指纹无身份）；命中即刷新新近度（LRU 触碰 = 删后重插）。绝不抛。
 * 导出面：测试消费。
 */
export function rememberCascadeScene(fingerprint) {
    try {
        if (typeof fingerprint !== 'string' || fingerprint === '')
            return;
        if (cascadeSceneMemory.has(fingerprint)) {
            cascadeSceneMemory.delete(fingerprint);
            cascadeSceneMemory.set(fingerprint, true);
            return;
        }
        if (cascadeSceneMemory.size >= CASCADE_FAMILIAR_SCENE_LIMIT) {
            const oldest = cascadeSceneMemory.keys().next().value;
            if (oldest !== undefined)
                cascadeSceneMemory.delete(oldest);
        }
        cascadeSceneMemory.set(fingerprint, true);
    }
    catch { /* 记账故障不影响分诊（不抛铁律） */ }
}
/**
 * ΑΩ-R2：请求文本的词法风险分级（纯读，绝不抛）。
 * 危险词（matchesDangerPatterns）/ 凭据词（matchesRiskPatterns）任一命中 ⇒
 * 'high' —— riskGate 归一化同律（leet/同形/全角混淆还原后包含匹配，宁高不低）；
 * 只读观察标记命中 ⇒ 'low'；其余不可分类 ⇒ 'medium'（与旧静态保守源同档）。
 * 导出面：测试/可观测消费。
 */
export function classifyCascadeRiskText(text) {
    try {
        if (typeof text !== 'string' || text === '')
            return 'medium';
        if (matchesDangerPatterns(text, '') || matchesRiskPatterns(text, ''))
            return 'high';
        if (CASCADE_READONLY_MARKERS_EN.test(text))
            return 'low';
        for (const m of CASCADE_READONLY_MARKERS_ZH) {
            if (text.includes(m))
                return 'low';
        }
        return 'medium';
    }
    catch {
        return 'medium'; // 信号不可用 ⇒ 保守回落（诚实原则）
    }
}
/**
 * ΑΩ-R2/ΠΑΝ-24：请求级三因子 —— 咨询桥的 perCall 因子源（真实动态信号）。
 * sceneFingerprint 在场时纯读判定熟悉度（不记账）；缺席时**不**折回
 * prompt-LRU（ΠΑΝ-24 修正：prompt 原文不是场景证据 —— 同句 prompt 换新屏
 * 必须按新场景保守），指纹不可得 ⇒ false。信号不可用时各项回落保守值
 * medium/false/0.5（旧行为的诚实降级面）。导出面：测试/可观测消费。
 */
export function cascadeRequestFactors(req, opts) {
    const prompt = typeof req?.prompt === 'string' ? req.prompt : '';
    const system = typeof req?.system === 'string' ? req.system : '';
    return {
        risk: classifyCascadeRiskText(prompt === '' && system === '' ? '' : `${prompt}\n${system}`),
        // ΠΑΝ-24：指纹可注入（调用方已算过则免二次解码）；缺席 ⇒ null ⇒ 新场景保守
        sceneFamiliar: cascadeSceneFamiliar(opts?.sceneFingerprint),
        confidence: 0.5, // 调用方上下文不可得 ⇒ 中性（不褒不贬，诚实）
    };
}
/** ΑΩ-R2/ΠΑΝ-24：场景记忆归零（测试隔离缝；configureVlm 重铸新纪元时清账） */
export function resetCascadeTriageFamiliarity() {
    cascadeSceneMemory.clear();
}
// ─── ΝΩ-47（合议庭点亮）：反驳法院的多脑裁决面装配 ───
/**
 * ΝΩ-47：把合议庭的**异构子庭**（同源剔除后的庭员）铸为反驳法院的多脑裁决面。
 *
 * 铸造律：整庭名册经 isSameRefuteSource 剔除与主脑同源（providerId/baseUrl
 * 双因子）的庭员 —— 主脑不得入陪审席反驳自己（确认偏误马戏律）；剔除后
 * ≥2 颗才铸（多数票最少需要两票 —— 1 颗异构脑成不了合议，退回单脑通道
 * 诚实降级，不静默凑数）；子庭复用整庭已铸的适配器实例（零重解析零网络）。
 * 返回的 face 结构满足 RefuteQuorumFace（EnsembleCourt.askVerdict 天然契合，
 * census 即 members 普查）。绝不抛：任何读取故障 ⇒ null（多脑缺席 = 单脑
 * 旧行为）。导出面：测试/可观测消费（wireCascadeConsultFace 同律）。
 */
export function buildRefuteQuorumFace(court, primary, benchOptions) {
    try {
        const jury = court.listRoster().filter(p => !isSameRefuteSource({ id: primary.id, baseUrl: primary.baseUrl }, p));
        if (jury.length < 2)
            return null; // 异构庭员 <2 ⇒ 多数票无从谈起 —— 单脑路径保底
        // ΠΑΝ-23：子庭继承整庭的限流闸（rateGate 是庭实例字段 —— 重铸子庭须显式
        // 透传，否则多脑裁决面旁路限流；meter 挂在各成员适配器上，随 roster 引用
        // 天然继承）。无闸时行为与既往逐字节一致。
        const bench = new EnsembleCourt(jury, {
            ...(benchOptions?.rateGate !== undefined ? { rateGate: benchOptions.rateGate } : {}),
        });
        return {
            askVerdict: req => bench.askVerdict(req),
        };
    }
    catch {
        return null; // 装配故障 = 多脑缺席：单脑路径行为不变（绝不抛）
    }
}
/**
 * R3-3（GAP-1）：限流闸铸造/接线的单一权威点（从 configureVlm 的 ΝΩ-18 块原样
 * 提取，逻辑逐字节保持）—— 按注册表现值解析 vlm.maxPerMinute/maxPerHour：
 *   · vlm.maxPerMinute > 0 ⇒ 铸 VlmRateLimiter（小时桶 ≤0 ⇒ 回落 分钟×60）并
 *     attachVlmRateLimiter 注入单例 chat/chatJson 前置位，返回闸实例；
 *   · ≤0 / 未注册 / 任何故障 ⇒ attachVlmRateLimiter(null) 摘除并返回 null
 *    （缺省零行为变化律，绝不抛）。
 * 消费面：configureVlm（铸出的实例另共享给合议庭/反驳法院 —— ΠΑΝ-23 同律）与
 * 宿主存档复载后的重焊（src/index.ts restores 腿 —— kernel-state.json 回放的
 * 供参无需等下一次 apply）。导出面 = 生产接线 + 执法测试（set 后本函数即响应）。
 */
export function rewireVlmRateGate() {
    let sessionRateGate = null;
    try {
        const mpm = Math.floor(kernelRegistry.getOrDefault('vlm.maxPerMinute', 0));
        if (Number.isFinite(mpm) && mpm > 0) {
            const mph = Math.floor(kernelRegistry.getOrDefault('vlm.maxPerHour', mpm * 60));
            sessionRateGate = new VlmRateLimiter({
                maxPerMinute: mpm,
                maxPerHour: Number.isFinite(mph) && mph > 0 ? mph : mpm * 60,
            });
            attachVlmRateLimiter(sessionRateGate);
        }
        else {
            attachVlmRateLimiter(null);
        }
    }
    catch {
        sessionRateGate = null;
        attachVlmRateLimiter(null); // 供参面故障 ⇒ 摘除（绝不抛）
    }
    return sessionRateGate;
}
/**
 * 宿主血脉接线：以插件配置铸造云脑单例 + 备选池（config 优先于 env）。
 *
 * 单例铸造法（两路，先到先熔）：
 *   - vlmProvider 非空（纪元 Ψ 显式平台）⇒ resetGlmClient() 后以该平台
 *     getGlmClient({platform, ...}) 铸造 —— apiKey/baseUrl/model 取非空 config
 *     值（Ω 纪元 schema 缺省的 GLM 基址/模型名在非 glm 平台下视为缺席），
 *     缺席物料由委托路径回退平台预设与平台 envKeys；
 *   - 否则 vlmApiKey / vlmBaseUrl / vlmModel 任一非空 ⇒ 原生 glm 路径铸造
 *     （Ω 纪元行为不变：缺席字段由 GlmClient 构造器回退 GLM 环境变量）；
 *   - 都空 ⇒ 不动单例 —— 已有单例保持原样，无单例则走 env 探测路径
 *     （getGlmClient 缺省解析：GLM envs > 他平台 envKeys 自动识别）。
 *
 * 池铸造法：vlmFallbackProviders 非空 ⇒ 按 CSV 铸 ProviderPool（主力 =
 *   vlmProvider 或缺省 'glm'，备选各自 env 解析；解析不出 key 且非本机免钥
 *   的备选不进池）；空 ⇒ 池置 null。P2a-1（单例-池贯通）：池的在场性同步注入
 *   单例咨询面 —— 铸池 ⇒ attachFailoverPool(pool)，空 ⇒ attachFailoverPool(null)
 *   （摘除）。
 *
 * 反驳面装配（纪元 Β）：备选链非空（≥2 颗脑）⇒ 另铸一座 EnsembleCourt（主力
 *   + 备选全部入席），庭员名册（listRoster）连同主脑身份注入 vlm/refute 的
 *   attachRefuteFace —— 危险点击派发前 askRefutation 按身份剔除同源庭员后请
 *   首颗异构脑反驳「目标=描述」；空链 ⇒ attachRefuteFace(null)（单脑部署：
 *   法院诚实缺席，零调用零行为）。ΝΩ-47（opt-in）：内核参 vlm.refuteQuorum > 0
 *   且异构子庭 ≥2 ⇒ 另挂多脑裁决面（quorum）—— 反驳通道升级 askVerdict
 *   多数票，census 透传；缺省未供参 ⇒ 单脑路径逐字节不变。
 *
 * 计量接线（纪元 Δ-6）：铸造的单例与池缺省挂 `rec => vlmMeter.record(rec)`
 *（GlmMeterRecord 与 VlmCallRecord 字段同名同型，零适配直落台账）；直接
 *   构造 GlmClient / createProviderPool 且显式给 meter 的消费面不受影响
 *（用户显式 meter 优先）。全空不铸造 ⇒ 无接线可挂（env 路径行为不变）。
 *
 * 幂等性：重复调用以最后一次为准（单例 reset 先行 / 池重铸）；绝不抛异常。
 */
export function configureVlm(config) {
    try {
        const apiKey = cfgStr(config?.vlmApiKey);
        const baseUrl = cfgStr(config?.vlmBaseUrl);
        const model = cfgStr(config?.vlmModel);
        const provider = cfgStr(config?.vlmProvider).toLowerCase();
        const fallbacks = cfgStr(config?.vlmFallbackProviders);
        // W3-0（W2-8 C2 接线）：tier 标注表（缺省空 = 池内全 primary ⇒ 级联恒弃权）
        const tiers = parseProviderTiers(cfgStr(config?.vlmProviderTiers));
        // 单例：显式平台（纪元 Ψ）⇒ 平台铸造；否则 Ω 纪元 glm 三字段法原样。
        // 两条铸造路都挂 vlmMeter 缺省接线（Δ-6）—— 心跳落进模块级计量台账。
        if (provider !== '') {
            const url = eraDefaultStr(baseUrl, GLM_ERA_BASE_URL, provider);
            const mdl = eraDefaultStr(model, GLM_ERA_MODEL, provider);
            resetGlmClient();
            getGlmClient({
                platform: provider,
                ...(apiKey ? { apiKey } : {}),
                ...(url ? { baseUrl: url } : {}),
                ...(mdl ? { model: mdl } : {}),
                meter: vlmMeterTap,
            });
        }
        else if (apiKey || baseUrl || model) {
            resetGlmClient();
            getGlmClient({
                ...(apiKey ? { apiKey } : {}),
                ...(baseUrl ? { baseUrl } : {}),
                ...(model ? { model } : {}),
                meter: vlmMeterTap,
            });
        } // 全空 ⇒ 不动单例，走 env 路径（不铸造 ⇒ 无接线可挂，env 探测路径行为不变）
        // 池（纪元 Ψ 双轨）：备选链非空 ⇒ 铸池；空 ⇒ 置 null（幂等）。
        // 铸池同样挂 vlmMeter 缺省接线（Δ-6）—— 池内全脑心跳同账本。
        // R3-2：链段原样透传（'glm=glm-4v-flash' 形态由 createProviderPool 的
        // parseFallbackSpec 解析 —— per-brain 模型覆写 + 模型硬顶包装都在铸造厂
        // 单点执法；裸 id 段行为与既往逐字节一致）。
        if (fallbacks !== '') {
            const chain = fallbacks.split(',').map(s => s.trim()).filter(s => s !== '');
            const primary = provider !== '' ? provider : 'glm'; // 缺省主力 = GLM（Ω 纪元缺省脑）
            const url = eraDefaultStr(baseUrl, GLM_ERA_BASE_URL, primary);
            const mdl = eraDefaultStr(model, GLM_ERA_MODEL, primary);
            poolSingleton = createProviderPool({
                provider: primary,
                ...(apiKey ? { apiKey } : {}),
                ...(url ? { baseUrl: url } : {}),
                ...(mdl ? { model: mdl } : {}),
                fallbacks: chain,
                // W3-0（W2-8 C2 接线）：tier 标注入池 —— options.tiers[id] 显式覆盖 >
                // provider 自报 > 'primary'（failover.ts 三级解析）。空表缺席注入 ⇒
                // 铸池路径与既往逐字节一致。
                ...(Object.keys(tiers).length > 0 ? { tiers } : {}),
                meter: vlmMeterTap,
            });
        }
        else {
            poolSingleton = null;
        }
        // P2a-1（单例-池贯通）：池的在场性同步注入单例失败咨询面 —— 铸池 ⇒ 接线，
        // 空池 ⇒ 摘除。此后 getGlmClient 的 chat/chatJson 自身重试全败后按池序取
        // 首个健康脑救回；不配 fallbacks ⇒ null 注入 ⇒ 单例行为与既往逐字段一致。
        attachFailoverPool(poolSingleton);
        // ── R3-3（GAP-1 限流键入册）：vlm.maxPerMinute / vlm.maxPerHour 补注册 ──
        // 病灶（R2-8 §2.1/§6 GAP-1）：消费点（下方 ΝΩ-18 读键）一直在，但两键从未
        // 入册 ⇒ kernelRegistry.set 对其返回 'unregistered' 静默拒收 —— 本地限流闸
        // 在配置层（kernel-state.json 存档通道）根本开不了。修法：configureVlm 的
        // register 面按 productionSpecs 入册方言（key/organ/defaultValue/min/max/note）
        // 补两条幂等入册；缺省 0 = 关（零行为变化律 —— 入册前后 getOrDefault 读数同
        // 为 0，未供参部署逐字节不变）。区间执法由 registry.set 的夹取不变式承担
        //（越界 set ⇒ 'clamped' 夹回 [min,max]，见 kernel/registry.ts）。
        try {
            kernelRegistry.register({
                key: 'vlm.maxPerMinute',
                organ: 'metering',
                defaultValue: 0,
                min: 0,
                max: 600,
                note: 'R3-3（GAP-1）：VlmRateLimiter 分钟桶容量（缺省 0=关；>0 ⇒ configureVlm 铸双桶限流闸挂单例 chat/chatJson 前置；上限 600=10/s —— 远超桌面 agent 常态 5-10/min，只拦失控不塑形）',
            });
            kernelRegistry.register({
                key: 'vlm.maxPerHour',
                organ: 'metering',
                defaultValue: 0,
                min: 0,
                max: 36000,
                note: 'R3-3（GAP-1）：VlmRateLimiter 小时桶容量（缺省 0 ⇒ 铸闸时回落 分钟×60 的保守缺省；显式 >0 才收紧日预算）',
            });
        }
        catch { /* 入册失败 = 键不在册，消费面回声 0（关）—— 绝不抛 */ }
        // ── ΝΩ-18（限流器接线）：VlmRateLimiter 的 configureVlm 注入面 ──
        // 内核注册表供参（与 metering.VlmApiBreaker 的 Ξ-D 读法同律，不动 config
        // schema）：vlm.maxPerMinute > 0 ⇒ 铸双桶限流闸挂入单例 chat/chatJson 前置
        //（vlm.maxPerHour 可选，缺省 = 分钟 × 60）；未注册/ ≤0 ⇒ 摘除（缺省零行为
        // 变化律 —— 限流器全库原本零消费，未显式供参的部署行为逐字节不变）。
        // ΠΑΝ-23：铸出的闸实例另存 sessionRateGate —— 同一实例随后注入合议庭/
        // 反驳法院（旁路拨号与主路径共享同一配额池与回填面，「同标准」的执法点）。
        // R3-3：铸闸/接线整体提取为 rewireVlmRateGate（单一铸造点）—— configureVlm
        // 调用之外，宿主存档复载（kernelStore.applyTo 回放 kernel-state.json）之后
        // 经同一函数重焊，限流供参才能在当次启动生效（apply 序：configureVlm 先于
        // restores 腿 ⇒ 不重焊则复载值要等下一次 apply 才被铸闸读到）。
        const sessionRateGate = rewireVlmRateGate();
        // ── 纪元 Β（反驳法院）：第二意见面装配（照 P2a attachFailoverPool 的注入模式）──
        // 备选链在场（≥2 颗脑配置）才有异构可言：铸一座合议庭（主力 + 备选全部入席，
        // 铸造面零网络 —— 只是适配器落座），把庭员名册连同主脑身份注入反驳面 ——
        // askRefutation 按身份（providerId/baseUrl）剔除与主脑同源的庭员后请首颗
        // 异构脑作证。单脑部署（无 fallbacks）⇒ attachRefuteFace(null) —— 法院
        // 诚实缺席（零调用零行为，绝不静默把主脑自己请上证人席反驳自己）。
        // ΝΩ-47（合议庭点亮，opt-in）：内核参 vlm.refuteQuorum > 0 时另铸多脑
        // 裁决面 —— 同源剔除后的异构子庭 ≥2 颗 ⇒ askRefutation 的反驳通道整体
        // 升级为 askVerdict 多数票（不可逆动作核验从单脑单票变多脑多数票，
        // census 透传）；未供参 / 子庭不足 ⇒ quorum 缺席 = 单脑路径逐字节保持
        //（缺省零行为变化律）。
        try {
            if (fallbacks !== '') {
                // R3-2：同一链段原样灌庭（'id=model' 由 createEnsembleCourt 的
                // parseFallbackSpec 同方言解析 —— 池与庭见到同一颗备脑，绝不漂移）
                const chain = fallbacks.split(',').map(s => s.trim()).filter(s => s !== '');
                const primary = provider !== '' ? provider : 'glm';
                const url = eraDefaultStr(baseUrl, GLM_ERA_BASE_URL, primary);
                // ΠΑΝ-23（旁路计量收编）：铸庭挂 vlmMeterTap（庭内每次成员拨号经适配器
                // 恰好一条记录落台账 —— 与单例/池同标准）+ 共享限流闸 sessionRateGate
                //（与主路径同一配额池/回填面；闸缺席 = 全量并问，既往行为不变）。
                // 此前法院/合议庭的每一次真实云拨号在 vlmMeter 与 vlm.maxPerMinute 上
                // 完全不可见 —— 恰是最贵的旁路（不可逆动作前的多脑核验）。
                const court = createEnsembleCourt({
                    provider: primary,
                    ...(apiKey ? { apiKey } : {}),
                    ...(url ? { baseUrl: url } : {}),
                    extraProviders: chain,
                    meter: vlmMeterTap,
                    ...(sessionRateGate !== null ? { rateGate: sessionRateGate } : {}),
                });
                // ΝΩ-47：多脑裁决面（opt-in —— 内核参未注册时 getOrDefault 回声 0 ⇒ 恒缺席）
                let quorumFace = null;
                try {
                    if (kernelRegistry.getOrDefault('vlm.refuteQuorum', 0) > 0) {
                        // ΠΑΝ-23：子庭继承共享限流闸（meter 随成员适配器天然继承）
                        quorumFace = buildRefuteQuorumFace(court, { id: primary, ...(url ? { baseUrl: url } : {}) }, sessionRateGate !== null ? { rateGate: sessionRateGate } : undefined);
                    }
                }
                catch {
                    quorumFace = null; // 供参面故障 ⇒ 多脑缺席（绝不抛）
                }
                attachRefuteFace({
                    primaryId: primary,
                    ...(url ? { primaryBaseUrl: url } : {}),
                    // 庭员名册 → 第二意见脑（VisionProvider 天然结构满足 RefuteBrain 契约）。
                    // ΠΑΝ-22（同源剔除 baseUrl 因子激活）：三厂适配器均回填只读 baseUrl
                    //（W8-A6），此前装配面注释称「适配器不外露 ⇒ 缺席」是过时死代码 ——
                    // isSameRefuteSource 的双因子判定（providerId/baseUrl）在生产路径退化为
                    // 单因子，「不同 id、同 baseUrl」的镜像脑会留下用同源脑反驳同源脑。
                    // 现透传 baseUrl，双因子剔除自此在生产路径成立。
                    brains: court.listRoster().map(p => ({
                        id: p.id,
                        ...(p.baseUrl !== undefined ? { baseUrl: p.baseUrl } : {}),
                        configured: p.configured === true,
                        chatJson: (req) => p.chatJson(req),
                    })),
                    ...(quorumFace !== null ? { quorum: quorumFace } : {}),
                });
            }
            else {
                attachRefuteFace(null);
            }
        }
        catch {
            attachRefuteFace(null); // 装配失败 = 法院缺席：零调用零行为（绝不抛）
        }
        // ── W3-0（W2-8 C2 成本级联路由）：级联执行体铸造 + 咨询面接线 ──
        // 激活双钥：① vlmProviderTiers 显式标注了 cheap 档（无 cheap 档 ⇒ 级联律
        // 恒弃权，接线无意义）；② 池在场（fallbacks 非空时铸造）。双钥齐 ⇒ 铸
        // VlmCascade 并 attachCascadeFace —— glmClient.chatJson 的最前置咨询闸自此
        // 有真实消费面；任一缺席 ⇒ attachCascadeFace(null)（摘除，幂等），单例
        // chatJson 行为与未接线逐字节一致（缺省零行为变化律）。
        // ΑΩ-R2（级联因子源点亮）：咨询桥以请求文本供真实动态因子（词法风险分级 +
        // 同 prompt 熟悉度，见 cascadeRequestFactors）—— 只读低危 + 同 prompt 复现
        // ⇒ danger 0.2 < 缺省阈值 0.35，配置了便宜档的部署真正能路由到便宜臂；
        // 危险词 ⇒ 恒 high 恒主力。信号不可用 ⇒ 各项回落保守值（与旧静态源同值 ⇒
        // 弃权，无证据不便宜）。vlmCascadeDangerMax 仍可配置覆盖阈值（收紧/放宽皆可）。
        try {
            if (poolSingleton !== null && Object.values(tiers).includes('cheap')) {
                const dm = Number(config?.vlmCascadeDangerMax);
                resetCascadeTriageFamiliarity(); // 重铸新纪元 —— 旧纪元的同 prompt 记忆不作数
                cascadeSingleton = new VlmCascade(poolSingleton, {
                    ...(Number.isFinite(dm) ? { dangerMax: Math.min(1, Math.max(0, dm)) } : {}),
                    // 实例级因子源保持 W3-0 静态保守值：直接 runJson（无 perCall）的调用面
                    // 旧行为逐字节保持（danger 0.6 ⇒ 弃权）；咨询桥恒供 perCall 动态因子
                    // （W2-8g 优先级律压过本源），本源退居「无请求语境」的诚实缺省。
                    factors: () => ({ risk: 'medium', sceneFamiliar: false, confidence: 0.5 }),
                    validators: [cascadeStructuralValidator],
                });
                // ΝΩ-18：咨询桥经 wireCascadeConsultFace 装配（请求级动态因子 + 按
                // 请求类型的语义谓词 —— grounding/verdict/OCR 三型，见上方谓词面）。
                wireCascadeConsultFace(cascadeSingleton);
            }
            else {
                cascadeSingleton = null;
                attachCascadeFace(null);
            }
        }
        catch {
            cascadeSingleton = null;
            attachCascadeFace(null); // 铸造失败 = 级联缺席：零调用零行为（绝不抛）
        }
    }
    catch { /* 铸造失败 = 云脑缺席：env/降级路径不变（绝不抛） */ }
}
