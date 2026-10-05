// src/vlm/refute.ts
// 纪元 Β（反驳法院）：不可逆动作的跨模型对抗核验。
//
// 存在理由：Ρ 的双钥公证锁住了「屏幕实读 vs 模型自述」（OCR/白盒通道不信嘴），
// 但若提示注入同时污染了描述与 OCR 语义判断（视觉上极具欺骗性的钓鱼界面），
// 单脑仍是单点。本法院把对抗验证制度性前移到 computer-use 的不可逆动作闸门：
// 派发前把「截图 + 目标描述」交给**另一颗异构脑**，提示词不是「确认」而是
// 「**请反驳**」—— 确认偏误被制度性逆转：注入必须同时骗过主脑、像素通道、
// 和一颗异构反驳脑。研究上对抗验证多用于推理任务，computer-use 不可逆动作的
// 跨模型反驳闸门是本纪元的世界级 novelty。
//
// 宪法（与 ensemble/failover/glmClient 同调）：
//   1. 永不抛异常 —— 一切失败收敛为 { verdict:'uncertain' }（缺席审判零行为：
//      法院是旁路增益不是依赖，故障绝不炸点击主流程、绝不拦合法点击）；
//   2. 单次不重试 —— 缺省 8s 硬止损（maxRetries:0 传脑 + 本模块竞速兜底：
//      违约挂死的脑不能拖垮点击主流程）；ΑΩ-R35 有限顺延：首席失败后最多再
//      请 1 颗备选脑（换脑非重试），且只在剩余预算内发生（8s 硬帽语义不变）；
//   3. 同源剔除 —— 与主脑同 providerId/baseUrl 的候选脑不请上证人席（用主脑
//      反驳主脑是确认偏误的马戏，不是对抗核验）；剔除数诚实注记；
//   4. 零依赖注入式 —— 本模块不 import 任何兄弟器官（叶子模块，杜绝环引）；
//      第二意见面经 attachRefuteFace 注入（vlm/index 的 configureVlm 装配，
//      照 P2a attachFailoverPool 的注入模式），EnsembleCourt 庭员/池内脑
//      天然结构满足 RefuteBrain 契约；ΠΑΝ-21 唯一的静态依赖是 internalUtils
//      （零依赖叶子原语仓 —— glmClient/providers 同律引用，不构成器官耦合）；
//   5. 纯离线可测 —— 假脑注入 + 超时测试缝（_overrideRefuteTimeoutForTest）
//      零网络零墙钟。
//
// ΝΩ-47（合议庭点亮 + 反驳置信带）两通道两执法：
//   · 通道升级 —— RefuteFace.quorum（可选）在场时，反驳通道整体走合议庭
//     askVerdict 多数票（庭员 ≥2 异构子庭，装配件负责剔除同源），census
//     透传进判词；缺席 ⇒ 单脑路径（旧行为逐字节保持）；
//   · 置信带 —— verdict+confidence 双阈值（两通道共用）：弱 upheld（<0.55）
//     降级 uncertain 不背书；弱 refuted（<0.5）仍拦但注记（保守方向）。
// ─── 内部常量 ───
/** 法定单次硬超时（毫秒）：8s —— 不可逆点击可以等一次认真反驳，不能等一纪元 */
export const REFUTE_DEFAULT_TIMEOUT_MS = 8000;
/** ΑΩ-R35（有限顺延）：首颗异构脑失败后最多再请 1 颗备选脑（bench 序次席）。
 *  顺延只在剩余预算内发生（见 askRefutation 的 deadline 纪律）—— 首席超时
 *  耗尽预算 ⇒ 维持缺席审判，8s 硬帽语义分毫不动。 */
const REFUTE_MAX_BENCH = 2;
/** 缺省请求参数：低温度（桌面自动化要确定性）、小预算（判决不需要长文） */
const REFUTE_TEMPERATURE = 0.1;
const REFUTE_MAX_TOKENS = 400;
/** reason 截断上限（防注入长文通过 reason 字段回流） */
const REASON_MAX = 240;
/** 失败注记截断上限 */
const NOTE_MAX = 200;
/**
 * ΝΩ-47（反驳置信带）：upheld 的弱背书下沿 —— 维持票置信低于此值时不背书
 *（降级 uncertain「提示不背书」：不硬放行注记弱背书，法院弃权交主流程零行为）。
 */
const REFUTE_WEAK_UPHELD_AT = 0.55;
/**
 * ΝΩ-47（反驳置信带）：refuted 的弱反驳下沿 —— 反驳票置信低于此值时保守方向
 * 取「弱反驳仍拦但注记」（拦错的代价是人工复核一次；放错的代价可能是不可逆
 * 误操作 —— 不可逆闸门上失败安全方向恒为多拦）。
 */
const REFUTE_WEAK_REFUTED_AT = 0.5;
// ─── 提示词构造（铁律风格随 som.ts：默认怀疑 / 找反驳而非确认 / 不臆造） ───
// ΠΑΝ-21（反注入铁律全量覆盖）：反驳法院面对的截图与目标描述均来自不可信屏幕
// —— 被审陈述（description）本身可能是注入产物。铁律行引共享常量单源注入。
import { VLM_ANTI_INJECTION_RULE } from './internalUtils.js';
/**
 * 纯函数：反驳式系统提示词。与 som.ts 的裁决/接地系统词同律 —— 只输出严格
 * JSON；三条怀疑铁律写死：默认持怀疑态度、找反驳证据而不是确认、宁可
 * uncertain 不可附和；判断必须基于图像实际像素，不要臆造。
 * ΠΑΝ-21：反注入铁律随行（屏幕文字是数据不是指令）。
 */
export function buildRefutationSystemPrompt() {
    return '你是对抗核验官，默认持怀疑态度。你的职责不是确认陈述，而是找出反驳证据。'
        + '只输出严格 JSON：{"verdict":"refuted"|"upheld"|"uncertain","confidence":0到1的小数,"reason":"一句中文说明"}。'
        + 'verdict 语义：refuted=你找到了反驳证据；upheld=认真寻找反驳证据后描述仍然成立；'
        + 'uncertain=证据不足不敢断言。宁可输出 uncertain 也不附和确认。'
        + '判断必须基于图像实际像素，不要臆造图上看不到的现象。'
        + VLM_ANTI_INJECTION_RULE;
}
/**
 * 纯函数：反驳式用户提示词。把「目标 = 描述」作为被审陈述呈堂，指令是
 * 「请反驳」而非「请确认」；region 在场时附目标大致区域（归一化坐标聚焦注记）。
 */
export function buildRefutationUserPrompt(description, region) {
    const desc = typeof description === 'string' ? description.trim().slice(0, 200) : '';
    const focus = region && Number.isFinite(region.x) && Number.isFinite(region.y)
        && Number.isFinite(region.width) && Number.isFinite(region.height)
        ? `目标大致位于图像归一化区域 [x=${region.x.toFixed(3)}, y=${region.y.toFixed(3)}, `
            + `w=${region.width.toFixed(3)}, h=${region.height.toFixed(3)}]。`
        : '';
    return `请反驳以下陈述：这张截图里被描述为「${desc}」的点击目标，真的是「${desc}」吗？`
        + focus
        + '请以怀疑态度审视并找出任何反驳证据：该位置实际显示的文字或控件与描述不符、'
        + '按钮实为仿冒或钓鱼界面、目标并不在图中的该位置、或它是静态正文而非可交互控件。'
        + '只有认真寻找后确实找不到任何反驳证据，才允许输出 upheld。';
}
/**
 * 纯函数（ΝΩ-47 合议庭点亮）：多脑裁决通道的系统提示词 —— 与单脑版同一套
 * 怀疑铁律（默认怀疑 / 找反驳而非确认 / 不臆造），仅票面方言改随
 * EnsembleCourt.askVerdict 的裁决协议（confirmed|refuted，confidence 0..1）：
 * refuted=找到反驳证据；confirmed=认真寻找反驳证据后描述仍成立。
 */
export function buildRefutationQuorumSystemPrompt() {
    return '你是对抗核验合议庭的陪审脑，默认持怀疑态度。你的职责不是确认陈述，而是找出反驳证据。'
        + '只输出严格 JSON：{"verdict":"confirmed"|"refuted","confidence":0到1的小数}。'
        + 'verdict 语义：refuted=你找到了反驳证据；confirmed=认真寻找反驳证据后描述仍然成立。'
        + '与其他陪审脑独立判断，宁可低 confidence 也不附和确认。'
        + '判断必须基于图像实际像素，不要臆造图上看不到的现象。'
        // ΠΑΝ-21：多脑通道同律设防 —— 多数票也挡不住全体陪审脑被同一注入话术策反
        + VLM_ANTI_INJECTION_RULE;
}
// ─── 模块级注入面（照 P2a attachFailoverPool 的注入模式） ───
/** 模块级反驳面 —— 宿主 configureVlm 装配后注入；null = 未装配（法院缺席） */
let refuteFace = null;
/**
 * 注入/摘除反驳面 —— 传 null 摘除；垃圾输入（非对象/主脑身份不可读/脑清单
 * 既非数组也非函数）安静归 null（不抛铁律）。重复调用以最后一次为准（幂等）。
 */
export function attachRefuteFace(face) {
    try {
        if (!face || typeof face !== 'object') {
            refuteFace = null;
            return;
        }
        const f = face;
        if (typeof f.primaryId !== 'string' || f.primaryId.trim() === '') {
            refuteFace = null;
            return;
        }
        if (!Array.isArray(f.brains) && typeof f.brains !== 'function') {
            refuteFace = null;
            return;
        }
        refuteFace = face;
    }
    catch {
        refuteFace = null;
    }
}
/** 候选脑清单解析：数组直通 / 函数求值（求值或条目访问抛错 ⇒ 空清单，绝不抛） */
function resolveBrains(face) {
    try {
        const raw = typeof face.brains === 'function' ? face.brains() : face.brains;
        return Array.isArray(raw) ? raw : [];
    }
    catch {
        return [];
    }
}
// ─── 同源剔除（纯函数，测试面） ───
/** 身份归一：trim + 小写（providerId 方言防御） */
function normId(v) {
    try {
        return typeof v === 'string' ? v.trim().toLowerCase() : '';
    }
    catch {
        return '';
    }
}
/** 基址归一：trim + 小写 + 剥尾部斜杠（同源判定的第二因子） */
function normBaseUrl(v) {
    try {
        return typeof v === 'string' ? v.trim().toLowerCase().replace(/\/+$/, '') : '';
    }
    catch {
        return '';
    }
}
/**
 * 同源判定（纯函数）：providerId 相同（非空）或 baseUrl 相同（非空）即同源 ——
 * 用主脑自己反驳主脑是确认偏误的马戏；.baseUrl 缺席时退回 id 单因子（诚实，
 * 不虚构比对材料）。两侧身份全缺席 ⇒ 不同源（宁可不剔也不误剔）。
 */
export function isSameRefuteSource(primary, candidate) {
    const pid = normId(primary?.id);
    const cid = normId(candidate?.id);
    if (pid !== '' && pid === cid)
        return true;
    const purl = normBaseUrl(primary?.baseUrl);
    const curl = normBaseUrl(candidate?.baseUrl);
    return purl !== '' && purl === curl;
}
// ─── 统计面（法院年报表） ───
const courtStats = { cases: 0, refuted: 0, upheld: 0, uncertain: 0 };
/** 年报快照（只读副本）：审案数 / refuted / upheld / uncertain 计数 */
export function refuteStats() {
    return { ...courtStats };
}
/** 年报清零（测试面 —— 确定性断言用；生产零调用） */
export function resetRefuteStats() {
    courtStats.cases = 0;
    courtStats.refuted = 0;
    courtStats.upheld = 0;
    courtStats.uncertain = 0;
}
/** 记账（唯一出口）：每次 askRefutation 恰记一案 + 一票 bucket */
function tally(v) {
    courtStats.cases++;
    if (v.verdict === 'refuted')
        courtStats.refuted++;
    else if (v.verdict === 'upheld')
        courtStats.upheld++;
    else
        courtStats.uncertain++;
    return v;
}
// ─── 超时测试缝 ───
/** 缺省硬超时的测试覆写（生产零调用；null = 复位 8000ms 法定值） */
let timeoutOverride = null;
/** 测试注入缝（对齐 codec._overrideSharpResolver_forTest 约定）：离线复算
 *  缺席审判路径零墙钟。脏值安静复位法定值。 */
export function _overrideRefuteTimeoutForTest(ms) {
    timeoutOverride = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : null;
}
function effectiveTimeout(deps) {
    const raw = deps?.timeoutMs;
    const self = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
    return self ?? timeoutOverride ?? REFUTE_DEFAULT_TIMEOUT_MS;
}
// ─── 内部：硬止损竞速 + 载荷规整 ───
/**
 * 硬止损竞速：违约挂死/超时不归的脑不能拖垮点击主流程 —— 定时器 unref 不阻
 * 进程退出，先到先得后到弃单（败者 eventual 结果被安静丢弃，缺席审判已记账）。
 * 定时器构造失败（敌意环境）则纯依赖脑自报超时（chatJson 的 timeoutMs 透传）。
 */
function withHardCap(p, ms) {
    return new Promise(resolve => {
        let settled = false;
        const done = (v) => {
            if (!settled) {
                settled = true;
                resolve(v);
            }
        };
        let timer;
        try {
            timer = setTimeout(() => done(null), ms);
            timer.unref?.();
        }
        catch { /* 无定时器可用 —— 退回脑自报超时 */ }
        Promise.resolve(p).then(v => { if (timer !== undefined)
            clearTimeout(timer); done(v); }, () => { if (timer !== undefined)
            clearTimeout(timer); done(null); });
    });
}
/**
 * 载荷规整 —— 判决永不出错值（宁可 uncertain 不可乱判，对齐 verdict.ts）：
 * verdict 非法（拼错/大小写漂移/非字符串/缺席，含 'uncertain' 字面量）⇒
 * uncertain；confidence 宽松转数后夹 [0,1]，有效判决下非法值记中性 0.5；
 * reason 非字符串剥为 undefined，字符串截 240。
 */
function normalizeRefutePayload(value) {
    const v = (value && typeof value === 'object' ? value : {});
    if (v.verdict !== 'refuted' && v.verdict !== 'upheld')
        return null; // 垃圾/uncertain 载荷 ⇒ 缺席审判
    const c = typeof v.confidence === 'number' ? v.confidence : Number(v.confidence);
    const confidence = Number.isFinite(c) ? Math.min(Math.max(c, 0), 1) : 0.5;
    const reason = typeof v.reason === 'string' && v.reason.trim() !== '' ? v.reason.trim().slice(0, REASON_MAX) : undefined;
    return { verdict: v.verdict, confidence, reason };
}
/** 失败注记整形：剥空白 + 截断（防注入长文经 note 回流） */
function noteOf(s) {
    return s.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
}
/**
 * 多脑裁决载荷消毒：verdict 非法（拼错/非字符串/缺席）⇒ null（缺席审判）；
 * confidence 宽松转数后夹 [0,1]，非法记 0；dissents 剥非字符串项、字符串截
 * 64；census 逐条消毒（id 必须字符串、ok 必须布尔、error 截 NOTE_MAX）。
 */
function sanitizeQuorum(raw) {
    if (raw === null || typeof raw !== 'object')
        return null;
    const q = raw;
    if (q.verdict !== 'confirmed' && q.verdict !== 'refuted' && q.verdict !== 'uncertain')
        return null;
    const c = typeof q.confidence === 'number' ? q.confidence : Number(q.confidence);
    const confidence = Number.isFinite(c) ? Math.min(Math.max(c, 0), 1) : 0;
    const dissents = Array.isArray(q.dissents)
        ? q.dissents.filter((d) => typeof d === 'string' && d !== '').map(d => d.slice(0, 64))
        : [];
    const census = [];
    if (Array.isArray(q.members)) {
        for (const m of q.members) {
            if (m === null || typeof m !== 'object')
                continue;
            const e = m;
            if (typeof e.id !== 'string' || typeof e.ok !== 'boolean')
                continue;
            census.push({
                id: e.id.slice(0, 64),
                ok: e.ok,
                ...(typeof e.error === 'string' && e.error !== '' ? { error: e.error.slice(0, NOTE_MAX) } : {}),
            });
        }
    }
    return { verdict: q.verdict, confidence, dissents, members: census };
}
/**
 * ΝΩ-47（反驳置信带）：verdict + confidence 双阈值执法（单脑与多脑通道共用）：
 *   · upheld 且 confidence < 0.55 ⇒ 降级 uncertain「提示不背书」—— 弱背书
 *     不配写进锚点注记（不硬放行注记弱背书），法院弃权交主流程零行为；
 *   · refuted 且 confidence < 0.5 ⇒ 弱反驳**仍拦**但注记（保守方向论证：
 *     拦错 = 人工复核一次的可恢复代价；放错 = 不可逆误操作 —— 失败安全取多拦）；
 *   · 带内（≥ 各自下沿）⇒ 原判原样（旧行为）。
 */
function applyConfidenceBand(p) {
    if (p.verdict === 'upheld' && p.confidence < REFUTE_WEAK_UPHELD_AT) {
        return {
            verdict: 'uncertain',
            confidence: 0,
            note: noteOf(`weak-upheld (confidence ${p.confidence.toFixed(3)} < ${REFUTE_WEAK_UPHELD_AT}) — 弱背书不背书，法院弃权`),
        };
    }
    if (p.verdict === 'refuted' && p.confidence < REFUTE_WEAK_REFUTED_AT) {
        return {
            verdict: 'refuted',
            confidence: p.confidence,
            reason: p.reason,
            note: noteOf(`weak-refuted (confidence ${p.confidence.toFixed(3)} < ${REFUTE_WEAK_REFUTED_AT}) — 弱反驳仍拦（保守方向），建议人工复核`),
        };
    }
    return { verdict: p.verdict, confidence: p.confidence, reason: p.reason };
}
// ─── 法院：askRefutation ───
/**
 * 反驳法院的开庭面（永不抛）：截图 + 目标描述 → 请异构第二脑（单脑或合议庭）尝试反驳。
 *
 * 审判序（固定）：
 *   1) 面在场性：未装配反驳面 ⇒ uncertain 'no-refute-face'（缺席审判零行为）；
 *   2) 证据完整性：截图/描述缺席 ⇒ uncertain（法院不审无据之案）；
 *   3) ΝΩ-47（合议庭点亮）：quorum 面在场且可用 ⇒ 多脑多数票通道整体替代
 *      单脑 —— 庭员 ≥2 的异构子庭并行作证（每颗脑单次不重试）、多数票定谳、
 *      census 透传；任何故障（挂死/上抛/垃圾载荷/平票）收敛 uncertain
 *      （多脑失败不回退单脑：时间预算已花在合议庭上，法院是旁路增益不是依赖）；
 *   4) 名册收口（单脑通道）：候选脑解析（垃圾脑剔除、未配置脑零拨号跳过）+
 *      同源剔除（providerId/baseUrl 与主脑比对，剔除数诚实注记）；剔除后无脑 ⇒
 *      uncertain 'no-heterogeneous-second-brain'（单脑部署的诚实形态）；
 *   5) 单脑单次：取首颗异构脑 chatJson（jsonMode + maxRetries:0 + timeoutMs
 *      透传），外加本模块硬止损竞速兜底 —— 单次不重试，8s 缺省止损；
 *      ΑΩ-R35 有限顺延：首席失败（调用败/上抛/垃圾载荷）且剩余预算充裕时
 *      最多再请 1 颗次席备选脑（每颗脑仍单次不重试；首席超时耗尽预算 ⇒
 *      维持缺席审判，总 8s 硬帽语义不变）；
 *   6) 载荷规整：{verdict:'refuted'|'upheld', confidence, reason}；垃圾载荷 ⇒
 *      uncertain；refuted/upheld 附 secondOpinionId 归因；
 *   7) ΝΩ-47（反驳置信带）：verdict+confidence 双阈值执法（两通道共用）——
 *      弱 upheld（<0.55）降级 uncertain 不背书；弱 refuted（<0.5）仍拦但注记。
 *
 * 每次调用恰好记一案（tally 唯一出口）。绝不抛异常：任何内部故障（含敌意
 * face/脑违约上抛/定时器故障）收敛为 uncertain。
 */
export async function askRefutation(deps) {
    try {
        const face = refuteFace;
        if (!face) {
            return tally({ verdict: 'uncertain', confidence: 0, note: 'no-refute-face' });
        }
        const b64 = typeof deps?.imageBase64 === 'string' ? deps.imageBase64.trim() : '';
        if (b64 === '') {
            return tally({ verdict: 'uncertain', confidence: 0, note: 'no-evidence-image' });
        }
        const desc = typeof deps?.description === 'string' ? deps.description.trim() : '';
        if (desc === '') {
            return tally({ verdict: 'uncertain', confidence: 0, note: 'no-target-description' });
        }
        // ── ΝΩ-47（合议庭点亮）：多脑裁决通道（可选升级，在场即替代单脑）───
        // 不可逆动作的核验从单脑单票变多脑多数票：装配件（vlm/index.ts
        // buildRefuteQuorumFace）已保证子庭 ≥2 且同源剔除完毕。硬止损竞速与
        // 单脑通道同律（timeoutMs + 500ms 宽放）；违约上抛以 crash 哨兵区分于
        // 超时 null（诚实归因，两态皆缺席审判）。
        const quorum = face.quorum;
        if (quorum !== null && typeof quorum === 'object' && typeof quorum.askVerdict === 'function') {
            const timeoutMs = effectiveTimeout(deps);
            const mime = typeof deps?.mime === 'string' && deps.mime !== '' ? deps.mime : 'image/jpeg';
            const req = {
                images: [{ base64: b64, mime }],
                system: buildRefutationQuorumSystemPrompt(),
                prompt: buildRefutationUserPrompt(desc, deps?.region),
                maxTokens: REFUTE_MAX_TOKENS,
                temperature: REFUTE_TEMPERATURE,
                jsonMode: true,
                timeoutMs,
                // ΠΑΝ-22（quorum 单次不重试）：与单脑通道（下方 maxRetries:0）对齐 ——
                // 审判序注释「每颗脑单次不重试」此前只是宣称：quorum 请求体缺席该字段
                // ⇒ 陪审脑走适配器缺省 maxRetries=2；withHardCap 弃单后底层重试继续
                // 烧钱（8.5s 硬帽 + 3 次拨号的叠加恰发生在不可逆动作前的高危窗口）。
                maxRetries: 0,
            };
            const attempt = (async () => {
                try {
                    return (await quorum.askVerdict(req));
                }
                catch (e) {
                    return { __courtCrash: noteOf(e instanceof Error ? e.message : String(e)) };
                }
            })();
            const raw = await withHardCap(attempt, timeoutMs + 500);
            if (raw === null) {
                return tally({ verdict: 'uncertain', confidence: 0, note: `quorum-timeout-after-${timeoutMs}ms` });
            }
            if (raw !== null && typeof raw === 'object' && '__courtCrash' in raw) {
                return tally({ verdict: 'uncertain', confidence: 0, note: noteOf(`quorum-failed: ${raw.__courtCrash}`) });
            }
            const q = sanitizeQuorum(raw);
            if (q === null) {
                return tally({ verdict: 'uncertain', confidence: 0, note: 'quorum-payload-unusable' });
            }
            if (q.verdict === 'uncertain') {
                // 平票/全垃圾 ⇒ 缺席审判：census 仍透传（每颗脑怎么了），异议点名入注记
                return tally({
                    verdict: 'uncertain',
                    confidence: 0,
                    census: q.members,
                    note: q.dissents.length > 0 ? noteOf(`quorum-split (${q.dissents.join('、')})`) : 'quorum-no-valid-votes',
                });
            }
            // 方言映射：合议庭票面 confirmed ⇒ 法院判词 upheld；refuted 直通。
            // 多数票理由由异议面合成（票票点名，确定可审计），再过置信带。
            const dis = q.dissents.length > 0 ? q.dissents.join('、') : '无';
            const banded = applyConfidenceBand({
                verdict: q.verdict === 'confirmed' ? 'upheld' : 'refuted',
                confidence: q.confidence,
                reason: q.verdict === 'confirmed'
                    ? `合议庭多脑多数票维持（少数异议：${dis}）`
                    : `合议庭多脑多数票反驳（少数维持：${dis}）`,
            });
            return tally({
                verdict: banded.verdict,
                confidence: banded.confidence,
                ...(banded.reason !== undefined ? { reason: banded.reason.slice(0, REASON_MAX) } : {}),
                ...(banded.verdict !== 'uncertain' ? { secondOpinionId: 'ensemble-quorum' } : {}),
                ...(banded.note !== undefined ? { note: banded.note } : {}),
                census: q.members,
            });
        }
        // 名册收口：垃圾剔除 + 未配置跳过 + 同源剔除（诚实注记剔除数）
        const primary = { id: face.primaryId, baseUrl: face.primaryBaseUrl };
        let excluded = 0;
        const bench = [];
        for (const b of resolveBrains(face)) {
            try {
                if (!b || typeof b !== 'object' || typeof b.id !== 'string' || typeof b.chatJson !== 'function')
                    continue;
                if (b.configured === false)
                    continue; // 未配置零拨号
                if (isSameRefuteSource(primary, b)) {
                    excluded++;
                    continue;
                }
                bench.push(b);
            }
            catch { /* 敌意条目 —— 静默剔除 */ }
        }
        if (bench.length === 0) {
            return tally({
                verdict: 'uncertain',
                confidence: 0,
                excludedSameSource: excluded,
                note: excluded > 0
                    ? noteOf(`no-heterogeneous-second-brain (excluded ${excluded} same-source candidate(s))`)
                    : 'no-heterogeneous-second-brain',
            });
        }
        let brain = bench[0];
        const backup = REFUTE_MAX_BENCH > 1 ? bench[1] : undefined; // ΑΩ-R35：次席备选（至多 1 颗）
        const timeoutMs = effectiveTimeout(deps);
        // ΑΩ-R35（有限顺延）：总预算锚点 —— 首席 8s 硬帽耗尽后 deadline 已过，
        // 顺延不再发生（缺席审判语义不变）；只有首席快速失败/垃圾载荷才可能
        // 在剩余时间内请次席备选脑。
        const deadline = Date.now() + timeoutMs;
        const mime = typeof deps?.mime === 'string' && deps.mime !== '' ? deps.mime : 'image/jpeg';
        const req = {
            images: [{ base64: b64, mime }],
            system: buildRefutationSystemPrompt(),
            prompt: buildRefutationUserPrompt(desc, deps?.region),
            maxTokens: REFUTE_MAX_TOKENS,
            temperature: REFUTE_TEMPERATURE,
            jsonMode: true,
            timeoutMs,
            maxRetries: 0, // 单脑单次不重试（法院铁律：缺席审判优于拖廷；顺延≠重试——换的是另一颗脑）
        };
        // 同步/异步上抛都收敛为 ok:false 结果（区分于硬止损超时的 null）+ 硬止损
        // 竞速（+500ms 宽放）—— 违约挂死的脑不能拖垮点击主流程
        const ask = (brain, capMs) => {
            const attempt = (async () => {
                try {
                    return await brain.chatJson(req);
                }
                catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    return { ok: false, error: noteOf(`second brain threw: ${msg}`), raw: '' };
                }
            })();
            return withHardCap(attempt, capMs);
        };
        let res = await ask(brain, timeoutMs + 500);
        // ΑΩ-R35（有限顺延）：首席失败（ok:false / 上抛收敛 / 超时 null / 垃圾载荷）
        // 且席上还有备选 ⇒ 在剩余预算内再请次席（最多 1 颗）；预算耗尽（首席超时
        // 即是）⇒ 维持缺席审判。
        if ((res === null || res.ok !== true || normalizeRefutePayload(res.value) === null)
            && backup !== undefined) {
            const remaining = deadline - Date.now();
            if (remaining > 0) {
                brain = backup;
                res = await ask(brain, remaining + 500);
            }
        }
        if (res === null) {
            return tally({
                verdict: 'uncertain',
                confidence: 0,
                excludedSameSource: excluded || undefined,
                note: `second-opinion-timeout-after-${timeoutMs}ms`,
            });
        }
        if (!res || res.ok !== true) {
            const err = res && typeof res.error === 'string' ? res.error : 'unknown error';
            return tally({
                verdict: 'uncertain',
                confidence: 0,
                excludedSameSource: excluded || undefined,
                note: noteOf(`second-opinion-failed: ${err}`),
            });
        }
        const p = normalizeRefutePayload(res.value);
        if (p === null) {
            return tally({
                verdict: 'uncertain',
                confidence: 0,
                excludedSameSource: excluded || undefined,
                note: 'second-opinion-payload-unusable',
            });
        }
        // ΝΩ-47（反驳置信带）：verdict+confidence 双阈值执法（弱 upheld 不背书降级
        // uncertain / 弱 refuted 仍拦但注记 —— applyConfidenceBand 的保守方向论证）。
        const banded = applyConfidenceBand({ verdict: p.verdict, confidence: p.confidence, reason: p.reason });
        return tally({
            verdict: banded.verdict,
            confidence: banded.confidence,
            ...(banded.reason !== undefined ? { reason: banded.reason } : {}),
            ...(banded.verdict !== 'uncertain' ? { secondOpinionId: brain.id } : {}),
            excludedSameSource: excluded || undefined,
            ...(banded.note !== undefined ? { note: banded.note } : {}),
        });
    }
    catch (e) {
        // 不抛铁律的最终兜底（理论不可达 —— 各步自兜底）
        const msg = e instanceof Error ? e.message : String(e);
        return tally({ verdict: 'uncertain', confidence: 0, note: noteOf(`refute-court-crashed: ${msg}`) });
    }
}
// ─── 在场判定（clickMouse 的窄门执法前置 —— 零网络零拨号） ───
/**
 * 反驳法院是否在本会话可开庭：已装配反驳面且名册内存在**已配置的异构脑**
 *（同源剔除后仍有席），或 ΝΩ-47 多脑裁决面在场可用。纯配置/纯在场判定 ——
 * 零网络、零拨号、零副作用；clickMouse 以此为窄门前置（无脑 ⇒ 连
 * askRefutation 都不叫，性能铁律）。敌意 face 读取故障 ⇒ false（不可开庭的
 * 诚实形态）。
 */
export function refuteCourtInSession() {
    try {
        const face = refuteFace;
        if (!face)
            return false;
        // ΝΩ-47：多脑裁决面可用即足以开庭（装配件已保证子庭 ≥2 异构）
        const q = face.quorum;
        if (q !== null && typeof q === 'object' && typeof q.askVerdict === 'function')
            return true;
        const primary = { id: face.primaryId, baseUrl: face.primaryBaseUrl };
        for (const b of resolveBrains(face)) {
            if (!b || typeof b !== 'object' || typeof b.id !== 'string' || typeof b.chatJson !== 'function')
                continue;
            if (b.configured === false)
                continue;
            if (isSameRefuteSource(primary, b))
                continue;
            return true; // 首颗可用异构脑即足以开庭
        }
        return false;
    }
    catch {
        return false;
    }
}
