import { AutonomyConstitution } from './autonomyConstitution.js';
import { PolicyEngine } from './policyEngine.js';
import { createPerceive, createExecute, W1_EXEC_TUNING } from './runtime.js';
import { isGlmConfigured } from '../vlm/glmClient.js';
// 纪元 Ι（自我模型）：经验胜任度后验单例 —— 路径显式指到桶文件（目录导入在
// Node strip 装载器是 ERR_UNSUPPORTED_DIR_IMPORT，Λ-4 同律）。
import { selfModel } from '../selfmodel/index.js';
// 纪元 Ε（预言引擎）：动作前铸预言、动作后对账的审计旁路（同律显式指到桶文件）。
import { ProphecyEngine, prophecyWorldModel } from '../prophecy/index.js';
// W2-0（B 接线）：执行层四连改 / 免看门控的生产物料 —— 探针桥、焦点源、
// 本地帧哈希（capture→dhash）、physicalBackend 存活哨兵。
import { createExecWorldProbe } from '../physicalExecution/execProbe.js';
import { createExecFocusSource, focusTracker } from '../focusTracker.js';
import * as backend from '../physicalBackend.js';
import { dhash as dhashOfBuf } from '../perceptualHash.js';
// ΑΩ-R12（drag 执行面接线）：根层 system.dragMouse 的适配物料 —— 接线层允许
// import system（autonomy 器官本体不碰，经 RuntimeDeps.drag 注入破环）。
import { system } from '../system.js';
import { errText } from './runtime.utils.js';
// W4-0（B/C 接线）：第三批器官的栈内注入物料 —— 岔路账单例 + 岔路卡铸造
//（W3-6，纯内存簿记）与探索前沿账本（W3-7，独立持久化）。均为下游纯模块，
// 类型/值导入零回路（branchCards → counterfactual/diagnosis，exploration →
// elementTracker/failureMemory/riskGate 只读）。
import { branchLedger as branchLedgerSingleton, generateBranchCard } from '../branchCards.js';
import { ExplorationLedger } from './exploration.js';
// ΝΩ-46（model-based 反事实接线）：Φ-9 评分内核的世界模型只读面注入面 ——
// counterfactual 的模块默认持有者（结构端口 WorldModelReadPort 见其注释）。
import { wireCounterfactualWorldModel } from './counterfactual.js';
// W8-C1（惊异喂养生接线 · D-G2 清偿）：进化引擎（惊异消费面）—— 栈内 prophecy
// 失手记录的喂养目标。EvolutionEngine 自 './evolutionEngine' 再分发（本桶已
// export *，此处值引入供模块级单例铸造）。
import { EvolutionEngine } from './evolutionEngine.js';
// W5-0（A 接线 · W3-3/W4-1 增量账本）：总闸读取面 —— visualDiff.incremental
// 内核键（index.ts 铸入，缺省 0=关）。只读消费零回路（runtime 已同路 import）。
import { incrementalEncodingEnabled } from '../visualDiff.js';
export * from './goalState.js';
export * from './worldSnapshot.js';
export * from './policyEngine.js';
export * from './autoPilot.js';
export * from './evolutionEngine.js';
export * from './sceneSemantics.js';
export * from './uncertainty.js';
export * from './autonomyConstitution.js';
export * from './counterfactual.js';
export * from './selfAudit.js';
export * from './runtime.js';
// 纪元 Σ（Σ-2）：自主训练营 —— 确定性合成任务 + 虚拟世界闭环 + 进化引擎
export * from './gym.js';
// 纪元 Σ（Σ-3）：断点续跑记账 —— token → PilotRunRecord 档案库（autonomy_resume 的血脉）
export * from './pilotStore.js';
/** 合法风险分层表（CSV 解析白名单） */
const VALID_TIERS = new Set(['benign', 'sensitive', 'destructive']);
/** CSV → 去空白去重的词表（空串 ⇒ []） */
function csvWords(csv) {
    if (typeof csv !== 'string' || csv.trim() === '')
        return [];
    return [...new Set(csv.split(',').map(w => w.trim().toLowerCase()).filter(w => w.length > 0))];
}
// ─── W2-0（B 接线）：W1 执行层/门控的生产铸造物料 ───
/**
 * W2-0（B）：config.autonomyW1* → runtime 的 W1ExecTuning 覆盖（只收非负有限数，
 * 脏值一律不进覆盖表 —— runtime 侧同律拒收，双闸同向保守）。
 * 映射键与 W1_EXEC_TUNING 逐一同名去前缀。
 */
function w1TuningFromConfig(config) {
    const c = config;
    if (!c || typeof c !== 'object')
        return {};
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const out = {};
    for (const key of Object.keys(W1_EXEC_TUNING)) {
        const v = c[`autonomyW1${cap(key)}`];
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0)
            out[key] = v;
    }
    return out;
}
/**
 * W2-0（B）：懒点亮执行层世界探针 —— 唯有物理执行服务**已经存活**
 * （physicalBackend.healthSnapshot() 非 null —— 真实感知管线 captureCleanPng 已把
 * 服务拉起）时才把适配器铸成探针；缺席 ⇒ 一切方法诚实降级 null。
 * 安全纪律：**绝不主动拉起服务**（不调 ensureBackend 的 spawn 路径 —— 命中本哨兵
 * 后的 ensureBackend 是已就绪快速通道）；离线测试（假 capture、无后端）零污染。
 * 探针故障绝不阻塞主路径（ExecWorldProbe 的 null 降级方言）。
 */
function createLazyExecProbe() {
    let live = null;
    const resolve = async () => {
        if (live)
            return live;
        try {
            // W2-0：存活哨兵 —— 服务未起（生产首拍感知前/离线测试）即诚实缺席
            if (backend.healthSnapshot() === null)
                return null;
            const adapter = await backend.ensureBackend(); // 哨兵已过 ⇒ state.adapter 就位 ⇒ 零 spawn 快速通道
            live = createExecWorldProbe(adapter);
            return live;
        }
        catch {
            return null; // 探针是增益不是依赖 —— 任何故障收敛为缺席
        }
    };
    return {
        hitTestPoint: async (px, py) => (await resolve())?.hitTestPoint?.(px, py) ?? null,
        cursorKind: async () => (await resolve())?.cursorKind?.() ?? null,
        sampleFrame: async (opts) => (await resolve())?.sampleFrame?.(opts) ?? null,
        frameDiff: async (a, b) => (await resolve())?.frameDiff?.(a, b) ?? null,
        frameRowMeans: async (f, g) => (await resolve())?.frameRowMeans?.(f, g) ?? null,
    };
}
/**
 * W2-0（B）：本地帧哈希端口 —— capture → dhash 的轻实现（重型感知的廉价替身）。
 * 任何失败（截屏异常/指纹失败/空串）返回 null ⇒ 免看门控按「不可判 ⇒ 照旧感知」
 * 降级收敛（autoPilot 的端口契约），绝不抛异常。
 * capture 源与感知同源（deps.capture 缺省 backend.captureCleanPng）—— 假 capture
 * 注入的离线测试里非图像 buffer 的 dhash 自然失败 ⇒ 门控降级，零行为耦合。
 */
function createLocalFrameHash(capture) {
    return async () => {
        try {
            const buf = await capture();
            if (!Buffer.isBuffer(buf) || buf.length === 0)
                return null;
            const h = await dhashOfBuf(buf);
            return typeof h === 'string' && h.trim() !== '' ? h : null;
        }
        catch {
            return null; // 端口故障吞掉 —— 门控降级，绝不炸环
        }
    };
}
/**
 * W2-0（B）：跑环起点的焦点账清零 —— 每轮 autonomous_run 是任务边界，上一轮/
 * 工具层的落点登记不构成「我已点过这里」的证据（W-1 单例隔离律同源：跨任务
 * 状态在任务边界归零）。不清 ⇒ 上一 run 的落点会短路下一 run 对同一目标的首发
 * 点击（闭环语义污染）；清 ⇒ 焦点短路的证据源恒为本轮自己的派发。
 */
function resetFocusForRun() {
    try {
        focusTracker.clear();
    }
    catch { /* 隔离律是旁路义务：清账失败绝不炸铸栈 */ }
}
// ─── W4-0（C 接线）：探索前沿账本（W3-7 R2）的栈内铸造 ───
/**
 * W4-0（C）：进程级共享探索账本（一进程一账 —— 每次铸栈都归零 run 级状态：
 * 建议预算/交替律）。goal 绑定 ''（铸栈时 goal 尚未出生 —— advise 的 ctx.goal
 * 优先于账本 goal，恢复态问路的目标语境由闭环逐次供给；持久化档的 goal 亦恒
 * ''，跨会话恢复自洽）。
 * ΑΩ-R23（去重复全档读盘）：恢复改为「每持久化路径每进程恰一次」—— 缓存键
 * 含 persistPath；首铸（或换路重铸）显式 beginSession('restore') 读盘一次
 * （该 API 的本义即会话起点的恢复），后续同路径铸栈 attach 共享实例，只走
 * beginSession('reset') 归零 run 级状态（纯内存零 IO —— beginSession('restore'）
 * 不再被逐栈滥用为读档器）。路径变化 ⇒ 键失效重铸重读；进程退出即弃（本桶与
 * 宿主均无探索账本卸载钩子 —— 账本生命周期与进程同尽，persist 节流落盘语义
 * 不变）。首铸恢复失败只缓存负面结果（空账实例照常共享），防御恢复语义不变：
 * 绝不抛、垃圾格弃置、后续铸栈不重读坏档。
 */
let w4SharedExploration = null;
let w4SharedExplorationKey = '';
/**
 * W4-0（C）/ ΑΩ-R23：取（或铸）共享探索账本并归零 run 级状态；绝不抛（内部
 * 自带契约）。同路径缓存命中 ⇒ attach 共享实例零读盘；缺席/换路 ⇒ 首铸恰一次
 * 显式恢复（全档同步读盘至多一次）。
 */
function w4ExplorationFor(persistPath) {
    const p = typeof persistPath === 'string' && persistPath !== '' ? persistPath : '';
    if (w4SharedExploration === null || w4SharedExplorationKey !== p) {
        w4SharedExploration = new ExplorationLedger('', {
            enabled: true,
            ...(p !== '' ? { persistPath: p } : {}),
        });
        // ΑΩ-R23：首铸/换路重铸恰一次显式恢复 —— 后续同路径铸栈不再触盘
        w4SharedExploration.beginSession(p !== '' ? 'restore' : 'reset');
        w4SharedExplorationKey = p;
    }
    else {
        // ΑΩ-R23：同路径复铸 ⇒ attach 共享实例，仅归零 run 级态（纯内存零 IO）
        w4SharedExploration.beginSession('reset');
    }
    return w4SharedExploration;
}
// ─── W8-C1（惊异喂养生接线 · D-G2 清偿）：栈内 prophecy → EvolutionEngine ───
/**
 * W8-C1：惊异消费单例 —— 进程级共享的进化引擎（模块级单例，与
 * tools/autonomousRun.ts 的 evolution 单例同律：跨栈跨 run 存活，喂养的失手
 * 教训持续累积）。buildAutonomyStack 铸 ProphecyEngine 时以 surpriseFeed 构造
 * 选项接通（prophecy/index.ts 备好的构造期通道）：栈内预言结算失手即自动喂
 *（surpriseRunRecord 只喂失手 —— hit/no-model 不掺水；水位线零重喂）。
 * 纯旁路：EvolutionEngine.ingest 内部绝不抛（w8.prophecy G2-3 已证真引擎直收），
 * 喂养故障由 prophecy 侧吞掉（该条计丢不计喂），绝不炸环。
 * 导出面：宿主/测试的观察位（history/heuristics 读数差分 —— 生接线冒烟的执法缝）。
 */
const surpriseEvolution = new EvolutionEngine();
export { surpriseEvolution };
// ─── ΝΩ-46（model-based 反事实）：Φ-9 评分内核的世界模型只读面接线 ───
/**
 * ΝΩ-46：prophecyWorldModel.predict 的 Result 方言 → WorldModelReadPort 的
 * {top} 方言适配（纯读适配，绝不抛）：无证据 / 坏形状 / 模型抛错 ⇒ {top:null}
 * （诚实无知，绝不把「没见过」伪装成任何置信）。世界模型用 prophecy 同源单例
 * prophecyWorldModel（prophecy/index.ts 铸造、进程内跨 run 存活——读的正是
 * prophecy 结算回灌 observe 学到的 (量化屏型 × 动作键) 真实转移分布，同表同格）。
 * 概率读数缺席按中性 0.5（与 prophecy 惊异定价的回退同律——不自夸也不自贬）。
 */
function counterfactualPredictFace(fromType, actionKey) {
    try {
        const r = prophecyWorldModel.predict(fromType, actionKey);
        if (!r || r.ok !== true)
            return { top: null };
        const pred = r.value;
        const first = pred && Array.isArray(pred.nextTypes) ? pred.nextTypes[0] : undefined;
        if (!first || typeof first.typeId !== 'string' || first.typeId === '')
            return { top: null };
        const prob = typeof first.prob === 'number' && Number.isFinite(first.prob)
            ? Math.min(1, Math.max(0, first.prob))
            : 0.5;
        return { top: { typeId: first.typeId, prob } };
    }
    catch {
        return { top: null }; // 读模型故障 = 无知识（诚实吞掉，绝不炸评分）
    }
}
/**
 * ΝΩ-46：世界模型只读面（单例适配——与 prophecyWorldModel 同源）。
 */
const counterfactualWorldModelPort = { predict: counterfactualPredictFace };
/**
 * 宿主血脉接线：以插件 Config 铸造自主闭环栈（perceive / policy / constitution）。
 *
 * 规则映射律：
 *  · autonomyAllowTiers CSV → RiskTier[]（取值 benign/sensitive/destructive，
 *    非法词剔除；全非法 ⇒ 回落 ['benign'] 最保守立法；destructive 即使列入
 *    也被宪法硬法恒审批 —— 不可逆没有自主授权通道）；
 *  · autonomyForbiddenKeywords CSV → 宪法扫描词表（与 riskGate 默认不可逆
 *    词表取并集后扫描 —— 宪法 check 内建该并集，此处只喂追加词）；
 *  · autonomyMaxSteps → 宪法步数硬顶 maxTotalSteps（环的步保险丝与宪法
 *    停机线同源同值 —— 预算只有一处真相）；
 *  · autonomyVlmWhenUncertain → PolicyEngine 的不确定即咨询开关；
 *  · enableEpistemicGate（纪元 Η）→ 认识论闸门（Φ-7 adviseAction × riskTier 代价映射）
 *    开关：缺省 true 且执法面红律收窄（仅 destructive × 自报置信 <0.3 可熔断），
 *    false ⇒ epistemicGate 字段缺席，闭环逐字节旧路径；
 *  · enableSelfModel（纪元 Ι）→ 自我模型（经验胜任度后验单例）铸进栈：认识论
 *    闸门的置信源换为（动作类×场景桶）衰减 Beta 均值（冷启动格子返回 null ⇒
 *    自动回落纪元 Η 自报链）；selfModelMinEvidence/selfModelHalfLifeH 同步灌入
 *    单例；false ⇒ selfModel 字段缺席，闸门走自报置信路径；
 *  · enableProphecy（纪元 Ε）→ 预言引擎（纯审计旁路）铸进栈：动作前铸预言、
 *    动作后对账三态入账（错题本自动生成）；false ⇒ prophecy 字段缺席，闭环
 *    逐字节旧路径。
 *  · W2-0（W1 集成接线）→ autonomyW1Exec 缺省 true ⇒ 就地补挂 probe（懒点亮
 *    执行层世界探针 —— 物理服务已存活才生效）+ focus（origin 标签焦点源）+
 *    w1（autonomyW1* 组字段 → W1ExecTuning 覆盖）；autonomyW1FrameGate 缺省
 *    true ⇒ 就地补挂 frameHash（capture→dhash 本地轻实现）+ perceptionGate
 *    配置随栈入环（免看门控 C1）。任一开关 false 或调用方已显式注入 ⇒ 对应
 *    注入位缺席，行为与接线前逐字节一致。
 *
 * 快照槽与补挂回传（ΑΩ-R44 定谳）：deps 的缺席注入位（lastSnapshotRef/
 * incrementalObserver/drag/probe/focus/w1）先补挂进入口的浅拷贝副本（栈内
 * 消费面只读副本，函数体对原对象零散写），出口恰把「本次补挂的缺席位」回写
 * 进原 deps —— 生产血脉（tools/autonomousRun.ts 铸栈后紧接
 * createExecute({...deps, spec}) 消费回传：感知/执行共享 before 帧 + 执行层
 * 四端口随行）与接线测试（w2wire 直调 deps.drag、w5wire/w7fullon 读
 * deps.incrementalObserver 的感知写回）依赖该回传，删除即生产回归。调用方
 * 已注入字段零覆盖（只填缺席位）。now/sleep 透传（注入时钟贯穿全环）。
 * GoalStateMachine 由调用方铸造（每轮目标各异，栈不越权代铸）。
 */
export function buildAutonomyStack(config, deps = {}) {
    // ΑΩ-R44（入参纯化 · 定谳保留最小变异面）：入口对 deps 做恰一层的防御式浅拷贝
    //（resolved）—— 后续全部补挂只落在副本，栈内一切消费面（createPerceive 与
    // client/now/sleep/capture/branchLedger 读取）一律走副本，函数体内对调用方
    // 原对象零散写。浅拷贝边界的理由：本函数补挂的字段全部是顶层键，一层即足以
    // 隔离全部变异；深拷贝则会破坏单例/槽位共享语义 —— lastSnapshotRef 与
    // incrementalObserver 是感知/执行（及调用方读数面）共享的同一只槽，
    // probe/focus 是跨栈存活的端口引用，capture/now 等嵌套依赖同理必须保持
    // 引用相等（零拷贝语义）。
    const resolved = { ...deps };
    // ΑΩ-R44：补挂记账 —— 只登记「本次确实补上场的缺席位」，出口一次回写（见
    // 下方回写块）；调用方已注入的字段从不进清单 ⇒ 回写零覆盖。
    const attachedKeys = new Set();
    const fill = (key, value) => {
        if (resolved[key])
            return; // 只填缺席位 —— 调用方显式注入优先（零覆盖铁律）
        resolved[key] = value;
        attachedKeys.add(key);
    };
    // 快照槽补挂（同一只槽感知/执行共享 —— 见 JSDoc）
    fill('lastSnapshotRef', { current: null });
    // W5-0（A 接线 · W3-3/W4-1 增量账本消费链）：总闸 incrementalEncodingEnabled()
    // （kernelRegistry 键 visualDiff.incremental，index.ts 铸入、缺省 0=关）为真 ⇒
    // 补挂增量观察槽进副本（ΑΩ-R44 后出口回写原 deps）—— createPerceive 每帧把
    // ScreenStateLedger 判决与 deliverIncremental 投递产物写入此槽（runtime.ts 的
    // 注入缝；该文件禁改，缝在此接）。调用方（宿主编码层/工具面）经
    // deps.incrementalObserver.current 读「这一帧该作为关键帧/补丁/滚动条带投递
    // 给模型」的事实源。总闸关 ⇒ 槽缺席，perceive 零写入（感知行为与接线前逐字节
    // 一致——零回归红律）；只填缺席位，测试显式注入的观察槽优先。
    if (incrementalEncodingEnabled()) {
        fill('incrementalObserver', { current: null });
    }
    // ΑΩ-R12（drag 执行面接线）：拖拽端口 —— 根层 system.dragMouse 的四拍时序
    //（移→按→移→放）适配为 RuntimeDeps.drag 的像素四元组方言；任何失败收敛
    // {ok:false, error}（绝不抛 —— 运行层铁律由端口收口，execute 侧收敛 error
    // 结局）。只填缺席位 —— 测试显式注入的假件优先；不注入且无端口的离线调用
    // 保持 execute 的防御式降级路径（no_effect + 诚实注记）。
    fill('drag', async (startX, startY, endX, endY) => {
        try {
            await system.dragMouse({ x: startX, y: startY }, { x: endX, y: endY });
            return { ok: true };
        }
        catch (err) {
            return { ok: false, error: errText(err) };
        }
    });
    // W2-0（B）：W1 执行层四连改接线 —— 补挂进副本（ΑΩ-R44 后出口随 attachedKeys
    // 回写原 deps；调用方随后以同一 deps 铸 createExecute({...deps, spec})，
    // probe/focus/w1 三注入位即随行生效；与 lastSnapshotRef 同一补挂回传模式）。
    // 只填缺席位 —— 测试显式注入的假件优先。
    // activation：config.autonomyW1Exec 缺省 true（Schema 默认语义）；探针懒点亮
    //（物理服务已存活才生效，绝不主动 spawn），焦点源带 origin 标签（工具层无标签
    // 记录绝不触发执行层短路 —— focusTracker 三重资格闸同律）。
    if (config?.autonomyW1Exec !== false) {
        resetFocusForRun(); // W2-0（B）：任务边界焦点清账（跨 run 短路污染的隔离律）
        fill('probe', createLazyExecProbe());
        fill('focus', createExecFocusSource());
        const tuning = w1TuningFromConfig(config);
        if (Object.keys(tuning).length > 0)
            fill('w1', tuning);
    }
    // ΑΩ-R44（最小变异面 · 出口一次回写）：恰把本次补挂的缺席位写回调用方原对象。
    // 定谳依据（调用方审计 —— 回写不可删除，删除即生产回归）：
    //  · 生产血脉 tools/autonomousRun.ts 的 runPilotLoop 以「本函数返回后紧接
    //    createExecute({ ...deps, spec })」消费补挂回传（感知/执行共享 before 帧
    //    + probe/focus/w1/drag 随行入执行面）；
    //  · 接线测试直读补挂后的原 deps（w2wire 直调 deps.drag、w5wire/w7fullon 读
    //    deps.incrementalObserver 的感知写回、autonomy.integration 读
    //    deps.lastSnapshotRef 的感知写回）。
    // 变异面由 attachedKeys 记账钉死：至多 lastSnapshotRef/incrementalObserver/
    // drag/probe/focus/w1 六键，且均为零覆盖的缺席位补挂 —— 除此清单外原对象
    // 分毫不动。
    for (const key of attachedKeys) {
        // 同形 Record 断言：key 与值同源于 resolved（联合索引直赋会被 TS 拒收）
        deps[key] = resolved[key];
    }
    // W2-0（B）：免看门控（C1）接线 —— 本地帧哈希端口（capture→dhash 轻实现）。
    // 只入返回栈（runAutonomousLoop 的消费面），不进 deps（createExecute 不消费）。
    // 五重与门（总闸/端口/基线/弹窗/语境）保证只有最窄的「无影响 + 双层 benign」
    // 类（外加 benign wait 值守）可跳过确认型感知；端口失败 ⇒ 照旧感知（零回归）。
    // activation：config.autonomyW1FrameGate 缺省 true；false ⇒ 端口缺席，
    // autoPilot 门控整体降级（与接线前逐字节同路径）。
    const w1FrameHash = config?.autonomyW1FrameGate !== false
        ? createLocalFrameHash(resolved.capture ?? (() => backend.captureCleanPng()))
        : undefined;
    const tierCsv = typeof config?.autonomyAllowTiers === 'string' ? config.autonomyAllowTiers : '';
    const allowTiers = tierCsv
        .split(',')
        .map(w => w.trim().toLowerCase())
        .filter((w) => VALID_TIERS.has(w));
    const forbiddenKeywords = csvWords(config?.autonomyForbiddenKeywords);
    const maxSteps = typeof config?.autonomyMaxSteps === 'number' && Number.isFinite(config.autonomyMaxSteps) && config.autonomyMaxSteps >= 1
        ? Math.floor(config.autonomyMaxSteps)
        : undefined;
    // ΝΩ-46（model-based 反事实接线）：世界模型只读面注入 Φ-9 评分内核（模块默认
    // 持有者——决策面调用点 breakTieBand/岔路账不携带 worldModel 字段，经此兜底
    // 吃到模型）。立法边界：prophecy 铁律「绝不影响动作选择」禁的是**回写与动作
    // 选择耦合的审计回路**（mint→settle→observe 回灌的学习闭环不得反向牵动当步
    // 裁决）；此处是**决策面独立读模型**——评分按（量化屏型 × 4×4 动作格）向
    // prophecyWorldModel 单例 predict 一次（只读，绝不 mint/observe/settle），
    // prophecy 的账本与挂起预言分毫不因本接线而动。开关同门 enableProphecy：
    // false ⇒ 不注入且清除旧接线（最新铸栈胜出——闭环逐字节旧路径，零回归红律）；
    // 实验室 gym 不经本函数铸栈 ⇒ 永不注入（确定性不变）。
    wireCounterfactualWorldModel(config?.enableProphecy !== false ? counterfactualWorldModelPort : null);
    return {
        // ΑΩ-R44：栈内消费面一律走入口浅拷贝副本 resolved（补挂/透传同源）
        perceive: createPerceive(resolved),
        policy: new PolicyEngine({
            ...(resolved.client ? { client: resolved.client } : {}),
            useVlmWhenUncertain: config?.autonomyVlmWhenUncertain !== false,
        }),
        constitution: new AutonomyConstitution({
            allowAutonomousTiers: allowTiers.length > 0 ? allowTiers : ['benign'],
            ...(forbiddenKeywords.length > 0 ? { forbiddenKeywords } : {}),
            ...(maxSteps !== undefined ? { maxTotalSteps: maxSteps } : {}),
        }),
        // 纪元 Η（Η-1 认识论闸门生产接线）：config.enableEpistemicGate 缺省 true（Schema
        // 默认语义），但执法面按红律收窄 —— 仅 destructive 动作且自报置信 < 0.3 才允许
        // ask_human/abort 熔断（「高危 × 低校准置信」窄条件）；sensitive 常规置信路径
        // （如宪法审批流）与良性路径绝不拦截，至多收一条 proceed/ask_vlm 步注记。
        // enableEpistemicGate === false ⇒ 整字段缺席，闭环走纪元 Η 前逐字节旧路径。
        ...(config?.enableEpistemicGate !== false
            ? {
                epistemicGate: {
                    vlmAvailable: () => {
                        try {
                            if (resolved.client)
                                return resolved.client.configured !== false;
                            return isGlmConfigured();
                        }
                        catch {
                            return false;
                        }
                    },
                    blockOnlyTiers: ['destructive'],
                    blockOnlyBelowConfidence: 0.3,
                },
            }
            : {}),
        // 纪元 Ι（自我模型生产接线）：config.enableSelfModel 缺省 true（Schema 默认
        // 语义）⇒ 把经验胜任度后验单例铸进栈（认识论闸门的置信源换为实测校准置信；
        // 单例对冷启动格子返回 null ⇒ 闸门自动回落纪元 Η 自报链，零行为差）。
        // 同时把 minEvidence/halfLifeH 两键灌进单例（configure 部分覆盖语义，非法值
        // 由 SelfModel 内部逐键回退缺省）；enableSelfModel === false ⇒ 字段缺席，
        // 闸门走自报置信路径。configure/reset 的完整接线（含 enableSelfModel
        // 总开关）由主控 src/index.ts 负责 —— 本处只保证栈内消费面就绪。
        ...(config?.enableSelfModel !== false
            ? {
                selfModel: (() => {
                    selfModel.configure({
                        minEvidence: config?.selfModelMinEvidence,
                        halfLifeH: config?.selfModelHalfLifeH,
                    });
                    return selfModel;
                })(),
            }
            : {}),
        // 纪元 Ε（预言引擎生产接线）：config.enableProphecy 缺省 true（Schema 默认
        // 语义）⇒ 铸审计引擎进栈：动作前按（屏型指纹 × 动作键）向世界模型铸预言、
        // 动作后第一次感知到达时结算（hit/miss/no-model 三态入账，错题本自动生成）。
        // 纯旁路三铁律：绝不阻断动作、绝不改写 PilotResult 既有字段（至多一步
        // journal 注记）、任何故障只丢预言绝不炸环。世界模型用 prophecy 单例
        //（进程内跨 run 存活 —— 结算回灌 observe 让模型逐步走出无知，Dyna 式）；
        // 时钟透传注入钟（挂起作废律与账本 ts 同源）。enableProphecy === false ⇒
        // 字段缺席，闭环逐字节旧路径。
        // W8-C1（惊异喂养生接线 · D-G2 清偿）：surpriseFeed 构造期通道接通 —— 结算
        // 失手即自动喂惊异消费单例 surpriseEvolution（surpriseRunRecord 只喂失手、
        // 水位线零重喂；w8.prophecy G2-3 已证真引擎结构直收）。纯旁路：喂养面由
        // prophecy 侧防御吞错，绝不影响铸栈与闭环。
        ...(config?.enableProphecy !== false
            ? {
                prophecy: new ProphecyEngine({
                    worldModel: prophecyWorldModel,
                    ...(resolved.now ? { now: resolved.now } : {}),
                    surpriseFeed: surpriseEvolution,
                }),
            }
            : {}),
        ...(resolved.now ? { now: resolved.now } : {}),
        ...(resolved.sleep ? { sleep: resolved.sleep } : {}),
        // W2-0（B）：免看门控的闭环消费面 —— frameHash 端口与门控配置随栈入环
        //（runAutonomousLoop 消费 AutonomyDeps.frameHash/perceptionGate）；配置脏值
        // 由 autoPilot 的 gateNumIn 就地收敛（此处只透传，不重复收口）。
        ...(w1FrameHash ? { frameHash: w1FrameHash } : {}),
        ...(config?.autonomyW1FrameGate !== false
            ? {
                perceptionGate: {
                    hammingTolerance: config?.autonomyW1GateHammingTolerance,
                    pollIntervalMs: config?.autonomyW1GatePollIntervalMs,
                    pollMaxMs: config?.autonomyW1GatePollMaxMs,
                    maxConsecutiveSkips: config?.autonomyW1GateMaxConsecutiveSkips,
                },
            }
            : {}),
        // W4-0（C 接线）：探索前沿（W3-7 R2）—— enableExploration（缺省 false）为真
        // ⇒ 铸共享 ExplorationLedger 注入 deps.exploration（③″ 恢复态升级分支的 UCB
        // 择路 + 步落账回报）；false ⇒ 端口缺席，升级路径逐字节旧路（零回归红律）。
        // run 级状态（建议预算/交替律）随每次铸栈归零；persistPath 在场 ⇒ 跨会话恢复。
        ...(config?.enableExploration === true
            ? { exploration: w4ExplorationFor(config?.explorationPersistPath) }
            : {}),
        // W4-0（B 接线）：活意图漂移（W3-5 H2）—— autonomySteerEnabled（缺省 false）
        // 为真 ⇒ steer 端口点亮（driveLoop 环内铸会话逐步出题，出题 ⇒ steer-drift
        // 升级提问）；false ⇒ 端口缺席，环内零执行（逐字节旧路径）。
        ...(config?.autonomySteerEnabled === true ? { steer: { enabled: true } } : {}),
        // W4-0（B 接线）：岔路账（W3-6 H3）—— 单例适配注入（调用方显式注入优先，
        // 只填缺席位）。纯旁路簿记：每步决策后 record（rankTopK 与 scoreOptions 同源
        // 内核）、goal failed/aborted 时 generateCard；PilotResult 既有字段分毫不动，
        // 缺省注入即安全（无 config 门 —— 簿记面零行为差）。deps 是 RuntimeDeps ——
        // branchLedger 是 AutonomyDeps 的字段（闭环消费面），此处按其部分面收窄读取
        //（ΑΩ-R44：读副本 resolved —— 与栈内其余消费面同源）。
        ...(resolved.branchLedger
            ? {}
            : {
                branchLedger: {
                    record: (options, ctx, meta) => branchLedgerSingleton.record(options, ctx, meta),
                    generateCard: (failure) => generateBranchCard(branchLedgerSingleton, failure),
                },
            }),
    };
}
export { createExecute, createPerceive };
