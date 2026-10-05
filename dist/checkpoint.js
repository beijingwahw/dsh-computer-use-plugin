// src/checkpoint.ts
// 第七轮创新之三：全认知状态快照（可恢复支柱）。
// 前六轮建造了四个记忆系统（UI 记忆 / 技能库 / 失败记忆 / 行动日志链），
// 但它们各自为政 —— 进程一崩，会话级认知全部蒸发（技能库虽有落盘，其余没有）。
// 本模块把全部认知态收敛为单一版本化 JSON 快照：
//   saveCheckpoint   —— 原子写（tmp + rename）：要么完整旧档，要么完整新档，绝无半档
//   loadCheckpoint   —— 版本校验 + 逐子系统恢复；单字段损坏不拖垮整档（防御性恢复）
// 接线：启动时自动恢复（checkpointPath 配置时）+ 卸载时自动保存 + save_checkpoint 手动档。
// 价值：崩溃/重启后，Agent 的「肌肉记忆」原地满血 —— 会话可中断，认知不回零。
import { existsSync, readFileSync, renameSync, mkdirSync, unlinkSync, openSync, writeSync, fsyncSync, closeSync } from 'fs';
import path from 'path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { uiMemory } from './uiMemory.js';
import { probeMemory } from './probeMemory.js';
import { skillLibrary } from './skillLibrary.js';
import { failureMemory } from './failureMemory.js';
import { telemetry } from './telemetry.js';
import { journal } from './journal.js';
import { contextManager } from './contextManager.js';
import { swarm } from './swarm.js';
import { coordinator } from './subAgent.js';
import { shaper } from './environmentShaper.js';
import { quantum } from './quantumSense.js';
import { sandboxLog } from './sandbox/log.js';
import { selfModel } from './selfmodel/index.js';
import { approvalQueue } from './approval.js';
// ΠΑΝ-80（approvalQueue 段完整性）：信封版本常量与队列档 ΠΑΝ-3 同源（F1 波
// approval.constants 立法件 —— 同一数字，两种载体共享同一信封形状契约）
import { APPROVAL_QUEUE_ENVELOPE_VERSION } from './approval.constants.js';
import { readHexKeyFile, loadOrCreateHexKeyFile } from './hmacKeyFile.js';
// W3-6（H3）：岔路账采集面 —— 每步决策的 Top-K 候选环形账（见 src/branchCards.ts）
import { branchLedger } from './branchCards.js';
// v3：新增 swarmAgents section（D-1 子代理花名册 + 报告 —— 崩溃后团队原地满血复活）。
// v2：新增 contextManager（潜意识池）与 swarm（经验晶体/漂移模型）section。
// 加载兼容 v1/v2 旧档：migrateCheckpoint 幂等归一化（见其注释），缺省 section 防御性跳过。
// 纪元 Ζ 缝隙闭合（自我模型未持久化）：selfModel 段为**第四次原地扩展**（D-1/D-2/D-3
// 同律 —— 加性可选段 + 防御水合免版本跃迁；shaper/quantum 先例在案）。版本字段
// 保持在 4 的另一面是契约现实：epochR/agency 执法册逐字节钉住「v4 落盘」与
// migrate(v3)=v4（本纪元禁改测试），而旧引擎读到多出的 selfModel 键只会静默
// 忽略（sections 表只触已知键）—— 原地扩展双向兼容，版本跃迁反而撕裂契约。
const CHECKPOINT_VERSION = 4;
/**
 * 幂等迁移管线（架构师指令 #3）：v? → v3。
 * 每步先查版本字段再动手；字段已存在 = no-op；重复执行（对迁移结果再迁移）永不报错。
 * 未知版本返回 null —— 由调用方以版本不匹配拒绝（拒绝恢复的既有语义保留）。
 */
export function migrateCheckpoint(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    let r = raw;
    if (r.version === 4)
        return r; // 已是目标形态：原样透传（幂等性根基）
    if (r.version === 1 || r.version === 2) {
        // 缺省字段补默认而非报错：v1 无 contextManager/swarm、v2 无 swarmAgents —— 全部 no-op 填充。
        // 结构性收窄由调用方的防御性恢复兜底（单 section 损坏不拖垮整档）。
        r = { ...r, swarmAgents: Array.isArray(r.swarmAgents) ? r.swarmAgents : [] };
    }
    if (r.version >= 1 && r.version <= 3) {
        // v1/v2/v3 → v4（R-4）：缺省字段补默认（swarmAgents 等）+ 证据锚补 null
        //（旧档无 MMR 根 —— 诚实缺席不虚造）；幂等 —— 重复迁移结构不变。
        return { ...r, version: 4, journalMmrRoot: r.journalMmrRoot ?? null, sandboxMmrRoot: r.sandboxMmrRoot ?? null };
    }
    return null;
}
const sectionTextCache = new Map();
const sectionSerializeCounts = new Map();
/** 单段序列化：journal 段零序列化命中（count:tip:base 指纹）；其余段直付 */
function sectionTextOf(name, value) {
    try {
        if (name === 'journal') {
            const j = value;
            const key = `j:${j.entries.length}:${j.chainTip}:${j.chainBase}`;
            const hit = sectionTextCache.get(name);
            if (hit !== undefined && hit.key === key)
                return hit.text; // 命中：整段复用（零序列化）
            const text = JSON.stringify(value);
            sectionTextCache.set(name, { key, text });
            sectionSerializeCounts.set(name, (sectionSerializeCounts.get(name) ?? 0) + 1);
            return text;
        }
        // ΠΑΝ-80（C1-1 M3）：非 journal 段无缓存 —— 序列化每保必付、计数如实
        sectionSerializeCounts.set(name, (sectionSerializeCounts.get(name) ?? 0) + 1);
        return JSON.stringify(value);
    }
    catch {
        return JSON.stringify(value); // 防御式：缓存面故障 ⇒ 全量重算（内容永远正确）
    }
}
// ─── ΠΑΝ-80（C1-5 H3 / F1-1 对接点3）：approvalQueue 段的 HMAC-SHA256 完整性信封 ───
//
// 威胁模型：checkpoint 是会话恢复主源 —— 盘面上的 approvalQueue 段含 granted
// 裁决（预授权凭据：恢复后可经 takeGranted 铸已授予执行令牌派发不可逆动作）。
// 旧实现整档明文 JSON（原子写齐备但无完整性保护），任何能写该文件的进程/
// 用户可预授权；队列档已有 ΠΑΝ-3 信封，checkpoint 段此前是同一凭据的第二块
// 裸奔盘面（双标残留）。
//
// 修法：该段落盘为信封 `{ v:2, alg:'hmac-sha256', mac?, payload }`（与队列档
// ΠΑΝ-3 同形状同常量 —— APPROVAL_QUEUE_ENVELOPE_VERSION 同源；密钥为
// `<checkpoint档>.aq.key` 的独立 32B CSPRNG，tmp+fsync+rename 原子写 +
// filePerms 尽力收紧）。**验证/封装算法与队列档逐字节同律**（hmac-sha256 +
// 恒定时间比对 + 「验证路径禁用密钥铸造」的诚实三态）——实现为本文件内镜像
// （queueContracts 的私有面不可 import；两处同律由测试锁定，见报告对接点）。
//
// 读侧三态（与 queueState.ensureQueueLoaded 的 ΠΑΝ-3 语义一致）：
//   · trusted（mac 在场 + 密钥可读 + 比对通过）⇒ 条目照常恢复（granted 在场）；
//   · untrusted（无 mac 降级档 / 密钥缺席 / 旧版明文段）⇒ 条目恢复但 granted
//     裁决**剥离降回待批**（pending/denied 照常恢复供晨报 —— fail-closed：
//     未经完整性验证的「已授予」不可恢复；配合 ΠΑΝ-1 证据仅内存驻留，重启后
//     该条目也无法再被批量批准 —— 重走完整审批是唯一出路）；
//   · tampered（mac 在场但比对失配）⇒ **整段拒绝**（队列归零，绝不冒充恢复，
//     报告置顶）。
// 已知边界（与队列档同律诚实申报）：密钥与数据同目录，能读密钥的攻击者可
// 离线伪造自洽信封 —— HMAC 防的是「只写不读密钥」的篡改者（filePerms 收紧
// 后的边界）；读密钥 ⇒ 已等价于该账户本体。
function aqHmac(key, payload) {
    return createHmac('sha256', key).update(payload, 'utf8').digest();
}
/** 恒定时间比对（两侧等长摘要；任何异常 ⇒ false） */
function aqMacMatches(key, payload, mac) {
    try {
        const expected = aqHmac(key, payload);
        const provided = Buffer.from(mac, 'hex');
        return provided.length === expected.length && timingSafeEqual(expected, provided);
    }
    catch {
        return false;
    }
}
// 密钥档读写已收编为共享件（修复潮 F3-7 / BC-5：此处的 readAqKey/
// loadOrCreateAqKey 与队列档 ΠΑΝ-3 的实现曾是逐字克隆 ×2）：读侧
// readHexKeyFile（绝不铸造）、写侧 loadOrCreateHexKeyFile（铸新 + 原子
// 落盘 + 权限收紧）—— 语义头注见共享件 src/hmacKeyFile.ts。
/** 写侧封装：段文本 → 信封 JSON（密钥缺席 ⇒ 省略 mac 的降级信封；封装故障 ⇒ 原文兜底） */
function sealApprovalQueueSection(sectionText, key) {
    try {
        return JSON.stringify({
            v: APPROVAL_QUEUE_ENVELOPE_VERSION,
            alg: 'hmac-sha256',
            ...(key !== null ? { mac: aqHmac(key, sectionText).toString('hex') } : {}),
            payload: sectionText,
        });
    }
    catch {
        return sectionText; // 防御式：封装故障 ⇒ 原文落盘（读侧按旧版明文 = 不可信处理）
    }
}
/** 读侧开封（绝不抛）：信封形态三态判定；旧版明文段 ⇒ untrusted（升级部署不
 *  丢队列，但在途 granted 须重新人证）。payload 解析失败按结构非法处理。 */
function openApprovalQueueSection(sectionValue, keyPath) {
    const parsePayload = (payload) => {
        try {
            return JSON.parse(payload);
        }
        catch {
            return undefined;
        }
    };
    try {
        if (sectionValue !== null && typeof sectionValue === 'object') {
            const root = sectionValue;
            if (root.v === APPROVAL_QUEUE_ENVELOPE_VERSION && typeof root.payload === 'string') {
                const mac = typeof root.mac === 'string' && root.mac !== '' ? root.mac : undefined;
                if (mac === undefined) {
                    return { state: 'untrusted', entries: parsePayload(root.payload) }; // 无密钥环境降级档
                }
                const key = readHexKeyFile(keyPath); // 只读验证 —— 铸造禁用于此（诚实三态）
                if (key === null)
                    return { state: 'untrusted', entries: parsePayload(root.payload) };
                if (!aqMacMatches(key, root.payload, mac))
                    return { state: 'tampered' };
                return { state: 'trusted', entries: parsePayload(root.payload) };
            }
        }
        return { state: 'untrusted', entries: sectionValue }; // 旧版明文段（ΠΑΝ-80 前档）
    }
    catch {
        return { state: 'untrusted', entries: undefined };
    }
}
/**
 * ΝΩ-22：快照档组装 —— 与 JSON.stringify(cp) 同构的紧凑 JSON（键序对齐
 * collect() 的字面序；undefined 段省略 —— JSON.stringify 同律），未变段
 * 直接拼接缓存文本。ΠΑΝ-80：approvalQueue 段经 seal 封信封（密钥由
 * saveCheckpoint 侧铸造后注入 —— 本函数保持纯函数）。
 */
function serializeCheckpoint(cp, sealApprovalQueue) {
    const sections = [
        ['uiMemory', cp.uiMemory],
        ['probeMemory', cp.probeMemory],
        ['skillLibrary', cp.skillLibrary],
        ['failureMemory', cp.failureMemory],
        ['journal', cp.journal],
        ['telemetry', cp.telemetry],
        ['contextManager', cp.contextManager],
        ['swarm', cp.swarm],
        ['swarmAgents', cp.swarmAgents],
        ['shaper', cp.shaper],
        ['quantum', cp.quantum],
        ['journalMmrRoot', cp.journalMmrRoot],
        ['sandboxMmrRoot', cp.sandboxMmrRoot],
        ['selfModel', cp.selfModel],
        ['approvalQueue', cp.approvalQueue],
        ['branchLedger', cp.branchLedger],
    ];
    const parts = [`{"version":${cp.version},"savedAt":${cp.savedAt}`];
    for (const [name, value] of sections) {
        if (value === undefined)
            continue;
        let text = sectionTextOf(name, value);
        if (name === 'approvalQueue' && sealApprovalQueue !== undefined) {
            text = sealApprovalQueue(text); // ΠΑΝ-80：预授权凭据段信封化
        }
        parts.push(`,${JSON.stringify(name)}:${text}`);
    }
    parts.push('}');
    return parts.join('');
}
/** ΝΩ-22（测试/观测面）：各段累计序列化次数（命中不计数 —— 零序列化断言锚点） */
export function checkpointSectionStats() {
    return Object.fromEntries(sectionSerializeCounts);
}
/** ΝΩ-22（测试/恢复面）：分段缓存整体失效（防御 —— 恢复路径调用） */
export function resetCheckpointSectionCache() {
    sectionTextCache.clear();
    sectionSerializeCounts.clear();
}
/**
 * 收集全认知态。日志链尖端与链基随行 —— 恢复后 append 续链、verify 不误报。
 * 纪元 Ζ 旁路律：selfModel 段以独立 try/catch 采集 —— 单例 dump 面（按 Ι 纪元
 * 立法永不抛）万一故障，只记入 warnings 诚实跳过，绝不炸 checkpoint 主流程
 * （持久化是旁路：失败 = 诚实跳过，绝不炸睡眠/卸载路径的保存链）。
 */ function collect() {
    const warnings = [];
    let selfModelSnap;
    try {
        selfModelSnap = selfModel.dump();
    }
    catch (e) {
        selfModelSnap = undefined; // 缺段落盘 = 恢复时诚实冷启动
        warnings.push(`selfModel: SKIPPED (dump 故障旁路吸收: ${e?.message ?? e})`);
    }
    // W2-1（H4）：待批队列随档 —— 采集面自带防御（dumpQueue 绝不抛），
    // try/catch 与 selfModel 同律（旁路故障 = 缺段诚实跳过，绝不炸保存链）
    let approvalQueueSnap;
    try {
        approvalQueueSnap = { entries: approvalQueue.dumpQueue() };
    }
    catch (e) {
        approvalQueueSnap = undefined; // 缺段落盘 = 恢复时队列不动
        warnings.push(`approvalQueue: SKIPPED (dump 故障旁路吸收: ${e?.message ?? e})`);
    }
    // W3-6（H3）：岔路账随档 —— 同律旁路采集（dump 恒出深拷贝，绝不抛；
    // 万一故障 = 缺段诚实跳过，恢复时空账冷启动）
    let branchLedgerSnap;
    try {
        branchLedgerSnap = branchLedger.dump();
    }
    catch (e) {
        branchLedgerSnap = undefined; // 缺段落盘 = 恢复时空账（卡片诚实缺席）
        warnings.push(`branchLedger: SKIPPED (dump 故障旁路吸收: ${e?.message ?? e})`);
    }
    return {
        cp: {
            version: CHECKPOINT_VERSION,
            savedAt: Date.now(),
            uiMemory: uiMemory.dump(),
            probeMemory: probeMemory.dump(),
            skillLibrary: skillLibrary.dump(),
            failureMemory: failureMemory.dump(),
            journal: { entries: journal.list(false), chainTip: journal.tip, chainBase: journal.base },
            telemetry: telemetry.dump(),
            // v2：群体经验先行结晶再入档（结晶是纯内存聚合，同步微秒级）
            contextManager: { subconscious: contextManager.dumpSubconscious() },
            swarm: (() => { swarm.crystalize(); return swarm.dump(); })(),
            // v3：D-1 子代理花名册 + 报告 —— 崩溃后团队原地满血复活
            swarmAgents: coordinator.dump(),
            // D-2：撤销日志随行 —— 崩溃后复原义务不蒸发
            shaper: { undoLog: shaper.dumpUndoLog() },
            // D-3：感知相位随行 —— 叠加态急救跨崩溃续行
            quantum: quantum.dump(),
            // R-4：证据锚 —— 快照与证据链的一致性锚（恢复时可验：重算 MMR 根 == 锚）
            journalMmrRoot: journal.mmrRoot(),
            sandboxMmrRoot: sandboxLog.mmrRoot(),
            // 纪元 Ζ：自我模型账本随行 —— 经验胜任度后验跨崩溃存活（重启不清零）
            selfModel: selfModelSnap,
            // W2-1（H4）：待批/已批未续跑条目随行 —— 崩溃后队列原地满血（晨报照常
            // 列待批清单、已批条目照常续跑）
            approvalQueue: approvalQueueSnap,
            // W3-6（H3）：岔路账随行 —— 崩溃后岔路账原地满血（失败铸卡/换支重放
            // 不因重启而失去支点）
            branchLedger: branchLedgerSnap,
        },
        warnings,
    };
}
/** 原子写：先写临时文件再改名。写一半崩溃 ⇒ 旧档完好，新档不存在，绝无损坏的半档。
 *  ΝΩ-22：序列化走分段缓存组装（serializeCheckpoint）—— 未变段零重序列化。
 *  ΠΑΝ-80：approvalQueue 段（预授权凭据）以 HMAC-SHA256 信封落盘 —— 密钥
 *  在此铸造（写侧允许；`<档>.aq.key`），读侧只读验证。 */
export function saveCheckpoint(filePath) {
    if (!filePath)
        return { ok: false, error: 'checkpointPath is not configured' };
    const { cp, warnings } = collect();
    const tmp = filePath + '.tmp';
    try {
        mkdirSync(path.dirname(filePath), { recursive: true });
        // ΠΑΝ-80：密钥铸造（只读 fs ⇒ null ⇒ 明文信封降级，读侧同律剥离 granted）
        const aqKey = loadOrCreateHexKeyFile(filePath + '.aq.key');
        // fsync 落盘后再换名：rename 可先于数据块持久化 —— 崩溃后可能读到空/截断档
        //（与 journal.ts 磁盘写的崩溃一致性同律：页缓存不算落盘）
        const fd = openSync(tmp, 'w');
        try {
            writeSync(fd, Buffer.from(serializeCheckpoint(cp, t => sealApprovalQueueSection(t, aqKey)), 'utf8'));
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        renameSync(tmp, filePath); // 原子换名
        // 纪元 Ζ：旁路 warnings（如 selfModel dump 故障）随行上报 —— 保存照常 ok
        return { ok: true, steps: cp.journal.entries.length, ...(warnings.length > 0 ? { warnings } : {}) };
    }
    catch (e) {
        try {
            unlinkSync(tmp);
        }
        catch { /* tmp 可能未创建 */ }
        return { ok: false, error: e.message };
    }
}
/** 防御性恢复：逐子系统独立 try-catch，单点损坏不拖垮整档；返回逐项恢复报告 */
export function loadCheckpoint(filePath) {
    // ΝΩ-22：恢复路径整体失效分段缓存（恢复会替换各子系统内容 —— 缓存键全部
    // 视为可疑，下次保存全量重算；防御式的缓存失效即全量重算）
    resetCheckpointSectionCache();
    if (!filePath || !existsSync(filePath))
        return { restored: false, report: ['no checkpoint file'] };
    const report = [];
    let cp;
    try {
        cp = JSON.parse(readFileSync(filePath, 'utf8'));
    }
    catch (e) {
        return { restored: false, report: [`checkpoint unreadable: ${e.message}`] };
    }
    if (cp.version !== CHECKPOINT_VERSION) {
        // 版本策略：v1/v2 旧档经幂等迁移归一为 v3；未知版本拒绝（拒绝恢复的既有语义）
        const migrated = migrateCheckpoint(cp);
        if (!migrated) {
            return { restored: false, report: [`version mismatch: file=${cp.version} engine=${CHECKPOINT_VERSION}`] };
        }
        cp = migrated;
    }
    const sections = [
        ['uiMemory', () => uiMemory.restore(cp.uiMemory)],
        ['probeMemory', () => probeMemory.restore(cp.probeMemory)],
        ['skillLibrary', () => skillLibrary.restore(cp.skillLibrary)],
        ['failureMemory', () => failureMemory.restore(cp.failureMemory)],
        ['journal', () => {
                // S 纪元（S-1）：证据锚验证（R-4 的另一半）—— 恢复后重算 MMR 根与锚对照；
                // 不等 ⇒ 条目被改/锚错配（篡改或档案损坏），响亮报告（防御性恢复策略：
                // 照常恢复但报告置顶 —— 单 section 报告不阻断其余恢复）。
                journal.restoreChain(cp.journal.entries, cp.journal.chainTip, cp.journal.chainBase);
                if (typeof cp.journalMmrRoot === 'string' && journal.mmrRoot() !== cp.journalMmrRoot) {
                    report.unshift(`EVIDENCE ANCHOR MISMATCH: journal MMR root after restore != snapshot anchor (entries tampered or stale anchor) — evidence chain integrity untrusted`);
                }
            }],
        ['telemetry', () => telemetry.restore(cp.telemetry)],
        // v2 sections：v1 旧档缺省时静默跳过（防御性恢复的红利）
        ['contextManager', () => contextManager.restoreSubconscious(cp.contextManager?.subconscious)],
        ['swarm', () => swarm.restore(cp.swarm)],
        // v3 section：子代理团队复活
        ['subAgents', () => coordinator.restore(cp.swarmAgents)],
        // D-2 section：撤销义务复活（未复原条目重新领责）
        ['shaper', () => shaper.restoreUndoLog(cp.shaper?.undoLog)],
        // D-3 section：感知相位复活
        ['quantum', () => quantum.restore(cp.quantum)],
        // 纪元 Ζ section：自我模型账本复活（坏段隔离不连坐 —— 沿本表防御水合风格）：
        //   缺段（Ζ 前旧档）⇒ 不触账本（新进程即空模型 = 诚实冷启动，非错误）；
        //   结构坏段（非对象/cells 非数组）⇒ 清账 + 上抛 ⇒ 本表 catch 记 SKIPPED（空模型）；
        //   段内坏行 ⇒ Ι 单例 restore 的半水合语义（好行入账、坏行弃置）。
        ['selfModel', () => {
                if (cp.selfModel === undefined)
                    return;
                const snap = cp.selfModel;
                if (!snap || typeof snap !== 'object' || !Array.isArray(snap.cells)) {
                    selfModel.reset(); // 坏段 ⇒ 空模型（不残留进程内旧账冒充恢复产物）
                    throw new Error('selfModel 段结构非法（弃置 ⇒ 空模型冷启动）');
                }
                selfModel.restore(cp.selfModel);
            }],
        // W2-1（H4）section：待批队列复活（防御性恢复 —— 垃圾值归零）：
        //   缺段（W2-1 前旧档）⇒ 不触队列（新进程即空队列，非错误）；
        //   结构坏段（非对象 / entries 非数组）⇒ 队列归零 + 上抛 ⇒ SKIPPED 注记；
        //   段内坏条目 ⇒ 弃置保好（dropped 计数进报告 —— 好条目照常恢复）。
        //   ΠΑΝ-80：段先过 HMAC 信封三态开封（trusted / untrusted / tampered，
        //   见 openApprovalQueueSection 头注）—— granted 裁决只在 trusted 下恢复；
        //   untrusted 剥离降回待批（与 queueState.ensureQueueLoaded 的队列档
        //   ΠΑΝ-3 语义逐字同律）；tampered 整段拒绝（队列归零 + 报告置顶）。
        ['approvalQueue', () => {
                if (cp.approvalQueue === undefined)
                    return;
                const opened = openApprovalQueueSection(cp.approvalQueue, filePath + '.aq.key');
                if (opened.state === 'tampered') {
                    approvalQueue.restoreQueue([]); // 篡改档整段归零（绝不冒充恢复）
                    report.unshift('APPROVAL QUEUE TAMPERED: approvalQueue section HMAC mismatch — section rejected, queue zeroed ' +
                        '(fail-closed; staged items are lost by design, never honored from a tampered file)');
                    throw new Error('approvalQueue 段完整性失配（HMAC mismatch ⇒ 弃置归零，绝不冒充恢复）');
                }
                const snap = opened.entries;
                if (!snap || typeof snap !== 'object' || !Array.isArray(snap.entries)) {
                    approvalQueue.restoreQueue([]); // 垃圾段 ⇒ 归零（不残留进程内旧账冒充恢复产物）
                    throw new Error('approvalQueue 段结构非法（弃置 ⇒ 空队列冷启动）');
                }
                let entries = snap.entries;
                if (opened.state === 'untrusted') {
                    // ΠΑΝ-80：不可信盘面 ⇒ granted 决不恢复（裁决剥回待批 —— 与队列档
                    // ΠΑΝ-3 同一执法点；'absorbed'/'denied' 终态无兑付风险，照常接回）。
                    // 注记只在确有剥离时发声（空队列的不可信态无可保护对象 —— 不制造噪声行）
                    let stripped = 0;
                    for (const e of entries) {
                        if (e && typeof e === 'object' && e.decision?.verdict === 'granted') {
                            delete e.decision;
                            stripped++;
                        }
                    }
                    if (stripped > 0) {
                        report.push(`approvalQueue: INTEGRITY UNPROVEN (${stripped} granted verdict(s) stripped to pending — ` +
                            `fail-closed; re-adjudication requires fresh out-of-band human evidence per ΠΑΝ-1)`);
                    }
                }
                const r = approvalQueue.restoreQueue(entries);
                if (r.dropped > 0) {
                    report.push(`approvalQueue: DROPPED ${r.dropped} malformed entr${r.dropped === 1 ? 'y' : 'ies'} (defensive restore, garbage zeroed)`);
                }
            }],
        // W3-6（H3）section：岔路账复活（防御性恢复 —— 垃圾归零、坏步弃置保好）：
        //   缺段（W3-6 前旧档）⇒ 不触账（新进程即空账 = 诚实冷启动，非错误）；
        //   结构坏段（非对象 / entries 非数组）⇒ 归零 + 上抛 ⇒ SKIPPED 注记；
        //   段内坏步 ⇒ 弃置保好（dropped 计数进报告 —— 好步照常恢复）。
        //   注：restore 收**段对象**（BranchLedgerSnapshot 形状）—— 与
        //   approvalQueue.restoreQueue 收条目数组的约定不同，错配会静默 no-op。
        ['branchLedger', () => {
                if (cp.branchLedger === undefined)
                    return;
                const snap = cp.branchLedger;
                if (!snap || typeof snap !== 'object' || !Array.isArray(snap.entries)) {
                    branchLedger.restore(null); // 垃圾段 ⇒ 归零（不残留进程内旧账冒充恢复产物）
                    throw new Error('branchLedger 段结构非法（弃置 ⇒ 空账冷启动）');
                }
                const r = branchLedger.restore(snap);
                if (r.dropped > 0) {
                    report.push(`branchLedger: DROPPED ${r.dropped} malformed step${r.dropped === 1 ? '' : 's'} (defensive restore, garbage zeroed)`);
                }
            }],
    ];
    for (const [name, fn] of sections) {
        try {
            fn();
            report.push(`${name}: OK`);
        }
        catch (e) {
            report.push(`${name}: SKIPPED (${e.message})`);
        }
    }
    return { restored: true, report };
}
