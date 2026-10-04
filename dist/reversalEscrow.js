// src/reversalEscrow.ts
// W3-1（旗舰 S1 逆转托管）：把数据库 saga 的补偿语义移植到 GUI 物理操作。
//
// 数据库事务有 WAL 与补偿事务；GUI agent 的物理动作（点击「发送」、删除文件、
// 提交表单）落进真实世界后，业界 agent 的全部事后手段是「再截一张图看看」。
// S1 把 saga 纪律搬到像素世界，四条铁律：
//   1. 预案先行铸造 —— 危险动作派发前（approval.beginAttempt 前置挂点）必须
//      铸造逆转预案入托管：焦点窗口引用 + 动作前屏幕感知哈希（经注入端口）+
//      剪贴板备份句柄（经注入端口，可缺席）+ 补偿路径（按动作语义从补偿策略表
//      选取，内置 + 可注入扩展）。预案本身先行落盘（ΝΩ-22 起为行式 append-only
//      WAL：每事件一行、独立 fsync；首写/迁移/压缩走 tmp+fsync+rename 原子重写，
//      独立文件 —— 不碰 journal.ts 的防篡改链）：宁可世界多一次无害的 Ctrl+Z，
//      不可世界少一份「该怎么撤销」的知识。
//   2. 补偿可验证 —— 派发后 TTL 内验收失败（no_effect/错误）或用户喊停（经注入
//      的中断信号端口）⇒ 按预案自动补偿；补偿后验证（屏幕哈希回到预案态，或
//      补偿谓词确认）并记账。验证失败 ⇒ 升级为醒目的人工介入报告，绝不静默。
//   3. 无可逆路径者强制人类亲办 —— 策略表查不到补偿路径（语义未分类）或策略
//      表明示 manual-only（发送/支付类：已发生的不可逆不是技术问题而是物理
//      事实）的危险动作，beginAttempt 直接拒绝（fail-closed），要求走完整
//      审批 + 人类亲办路径。宁可得罪自动化，不可假装可撤销。
//   4. 防御式绝不抛 —— 本模块一切公开面（铸造/结算/补偿/恢复/报表）绝不抛：
//      端口故障、存储垃圾、时钟垃圾一律收敛为诚实返回值与 degraded 标记。
//
// 降级论证（可用性优先）：物理/感知端口经注入，缺席 ⇒ 逆转托管降级为「仅记账
// 不自动补偿」（记 degraded）。方向选择：补偿能力缺席是**已知的环境事实**而非
// 补偿失败 —— 若端口缺席也 fail-closed，则纯视觉插件在无截图/无热键管线的
// 环境里连可逆动作都不可派发，防御纵深反噬可用性；记账仍完整保留（预案、
// 触发原因、缺席清单全部入册），事后审计与人工补救有全量事实。对照：策略表
// 缺补偿路径是**语义事实**（这个动作本质上撤不回），必须 fail-closed ——
// 两种「缺失」方向相反，正交处理。
//
// 与现有体系的正交性：令牌/批注/队列语义零变化；approve 消费点不改；
// beginAttempt 增加可选 opts（缺省不携带 ⇒ 零行为），consume/attemptFailed
// 的托管结算钩子是 fire-and-forget 旁路（异常全吞、无计划 ⇒ no-op）。
// undo 先例：environmentShaper.UndoRecord/undoLog（改变世界的权力与复原世界
// 的义务对称）；本模块把它推广到一切危险派发，并加上 saga 的验证与升级语义。
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, mkdirSync, unlinkSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
import { similarity } from './perceptualHash.js';
import { setDispatchEscrowHook, setEscrowSettlementHook } from './approval.js';
// W9-2（D-C1 落锤）：外部策略表装载面需要分级注册表的同步登记通道 —— 方向是
// reversalEscrow → riskGate（单向）。riskGate 不得反向 import 本模块（会与
// approval → riskGate 成环，riskGate 注释同律）；本向无环：riskGate 仅依赖
// confusables 生成档。两表对齐从「注释纪律 + 测试执法」升格为「装载面原子
// 执法」，键对齐律（S5-5d）继续在内置表上由 w4reverse/w6fix 遍历把守。
import { reversibilityRegistry } from './riskGate.js';
/**
 * 内置初始集（策略表 = 内置 + 注入扩展，扩展同键覆盖内置）。
 * 键是动作语义类别（派发层对危险动作的分类面，riskGate 词表的对齐产物）：
 *   form-submit  → 草稿箱回收 / Ctrl+Z（多数表单提交会留草稿或支持撤销）
 *   file-delete  → 回收站还原 / Ctrl+Z（GUI 删除默认进回收站 —— 可逆性最强）
 *   file-write   → Ctrl+Z / 编辑菜单撤销（文档类写入普遍支持 undo 栈）
 *   text-input   → Ctrl+Z（W6-3 扩表：输入类普遍支持应用内 undo 栈 —— riskGate
 *                  BUILTIN_LEVELS 早已判 compensable，策略表缺键曾令 escrow 执法
 *                  路径 fail-closed，分级与补偿知识在此对齐）
 *   navigation   → 后退导航 Backspace（W6-3 扩表：浏览器/资源管理器的返回键 —
 *                  回到动作前页面，导航类的天然逆动作）
 *   send-message → manual-only（已发出的消息无法收回 —— 唯一例外：部署注入
 *                  「延迟发送队列撤回」类扩展后方可自动派发）
 *   payment      → manual-only（退款不是撤销 —— 资金流的逆流是新交易）
 *   permanent-delete → manual-only（不进回收站的删除 —— 语义上已放弃可逆性）
 * W8-A4（DEBTS D-C1 第二轮扩表）新增 manual-only 三键 —— 把「无法安全自动
 * 补偿」的判断从 mintPlan 的 no-strategy 缺席面（「须先分类」）升格为显式
 * 立法登记（携带理由的人类可读拒绝），与 DEFAULT_DANGER_PATTERNS 的词族
 * 对齐（reset/清空、uninstall/卸载 在分级注册表尚无语义锚点，导出是经典
 * 不可逆）：
 *   data-export → manual-only（副本离开信任边界 —— 召回不是撤销）
 *   factory-reset → manual-only（重置/清空一步抹掉设置+会话+数据 —— 重置
 *                  没有回收站，permanent-delete 的广谱同族）
 *   app-uninstall → manual-only（卸载移除的不只是文件 —— 用户数据/配置的
 *                  丢失无法由重装补偿）
 * 扩表纪律（W8-A4 执法）：内置表新增 compensate 键受「S5-5d 键对齐律」硬
 * 约束 —— w4reverse/w6fix 遍历 builtinCompensationSemantics() 断言每个内置
 * 键与 riskGate 分级注册表一致（compensate ⇔ compensable；manual-only ⇔
 * irreversible），而 riskGate.BUILTIN_LEVELS 的 compensable 键已全部在表 ⇒
 * 内置 compensate 扩面的前置是分级表同步登记（riskGate 所有权之外的部署
 * 决策）。部署在两表同步登记前的正确姿势 = arm({strategies}) 注入扩展
 * （扩展键不在对齐律遍历域内）+ reversibilityRegistry.setLevel 对齐级别 +
 * createCompositeCompensationExecutor 接线 shaper 撤销栈 —— 见函数注释。
 */
const BUILTIN_STRATEGIES = new Map([
    ['form-submit', {
            kind: 'compensate',
            semantics: 'form-submit',
            steps: [
                { method: 'hotkey', label: 'Ctrl+Z undo the submission', keys: ['ctrl', 'z'] },
                { method: 'navigate', label: 'recover from drafts folder', target: 'drafts' },
            ],
            verify: { mode: 'screen-hash' },
            notes: '表单提交：多数客户端保留草稿或支持撤销',
        }],
    ['file-delete', {
            kind: 'compensate',
            semantics: 'file-delete',
            steps: [
                { method: 'recycle-bin-restore', label: 'restore from recycle bin', target: 'recycle-bin' },
                { method: 'hotkey', label: 'Ctrl+Z undo the delete', keys: ['ctrl', 'z'] },
            ],
            verify: { mode: 'screen-hash' },
            notes: 'GUI 删除默认进回收站 —— 可逆性最强的危险动作',
        }],
    ['file-write', {
            kind: 'compensate',
            semantics: 'file-write',
            steps: [
                { method: 'hotkey', label: 'Ctrl+Z undo the write', keys: ['ctrl', 'z'] },
                { method: 'menu', label: 'Edit > Undo menu', target: 'Edit>Undo' },
            ],
            verify: { mode: 'screen-hash' },
            notes: '文档类写入普遍支持应用内 undo 栈',
        }],
    // W6-3（W5-0 遗留清偿）：text-input / navigation 增补 —— 两键在 riskGate
    // BUILTIN_LEVELS 均判 compensable（escrow 道），但策略表查无此键 ⇒ mintPlan
    // fail-closed，分级说「有托管补偿路径」而托管说「无策略」—— 执法路径自相
    // 矛盾。增补后两表对齐（w4reverse S5-5d 键对齐律自动覆盖新键）。
    ['text-input', {
            kind: 'compensate',
            semantics: 'text-input',
            steps: [
                { method: 'hotkey', label: 'Ctrl+Z undo the typing', keys: ['ctrl', 'z'] },
            ],
            verify: { mode: 'screen-hash' },
            notes: 'W6-3 扩表：输入类普遍支持应用内 undo 栈 —— Ctrl+Z 即补偿',
        }],
    ['navigation', {
            kind: 'compensate',
            semantics: 'navigation',
            steps: [
                { method: 'hotkey', label: 'Backspace navigate back', keys: ['backspace'] },
            ],
            verify: { mode: 'screen-hash' },
            notes: 'W6-3 扩表：后退导航（Backspace，浏览器/资源管理器同律）回到动作前页面',
        }],
    ['send-message', {
            kind: 'manual-only',
            semantics: 'send-message',
            reason: 'send-class actions have NO compensation path: a delivered message cannot be unsent — the human must perform this personally (full approval + manual execution)',
        }],
    ['payment', {
            kind: 'manual-only',
            semantics: 'payment',
            reason: 'payments are irreversible: a refund is a NEW transaction, not an undo — the human must perform this personally',
        }],
    ['permanent-delete', {
            kind: 'manual-only',
            semantics: 'permanent-delete',
            reason: 'permanent delete bypasses the recycle bin by intent — irreversibility was the point — the human must perform this personally',
        }],
    // W8-A4（DEBTS D-C1 第二轮扩表）：manual-only 显式登记三键 —— 见函数头
    // 「扩表纪律」。这些语义此前落在 no-strategy 缺席面（「须先分类」）；显式
    // 登记后拒绝携带立法理由（人类亲办的「为什么」），审计与升级报告可引用。
    // 键对齐律天然满足：三键未在分级注册表登记 ⇒ classify 保守律默认最高级
    // irreversible，与 manual-only 期望一致（w4reverse S5-5d / w6fix F3-② 遍历执法）。
    ['data-export', {
            kind: 'manual-only',
            semantics: 'data-export',
            reason: 'data exports leave the trust boundary: a downloaded or copied-out file is a NEW copy in the wild — recall is not undo — the human must perform this personally',
        }],
    ['factory-reset', {
            kind: 'manual-only',
            semantics: 'factory-reset',
            reason: 'factory reset / wipe-all erases settings, sessions AND data in one stroke — there is no recycle bin for a reset — the human must perform this personally',
        }],
    ['app-uninstall', {
            kind: 'manual-only',
            semantics: 'app-uninstall',
            reason: 'uninstalling removes executables plus user data and configuration that a reinstall does NOT restore — the human must perform this personally',
        }],
]);
// ─── 常量 ───
/** 在途预案 TTL：派发 → 验收结算的窗口（缺省 30s —— 远短于审批 TTL，
 *  因为结算紧随派发；覆盖验证等待与一次自动重试的间隔） */
const DEFAULT_ESCROW_TTL_MS = 30_000;
/** screen-hash 验证缺省阈值：dHash 64 位下 similarity ≥ 0.9（≤6 位差）——
 *  「回到预案态」的抖动容忍带（光标/菜单残影占少数位） */
const DEFAULT_VERIFY_THRESHOLD = 0.9;
/** 账册封顶（无界账册 = 无界 WAL —— 封顶后丢最旧，恢复报告优先保新） */
const MAX_LEDGER_ENTRIES = 256;
/** WAL 档版本（旧整档格式 v1 —— ΝΩ-22 起写入行式事件流，读取面兼容两代） */
const ESCROW_WAL_VERSION = 1;
// ─── ΝΩ-22（热路径 IO 放大②）：行式 append-only WAL ───
//
// 问题：closePlan / mintPlan 每次触发 persistWal 全量重写（整档
// JSON.stringify + tmp + fsync + rename ×2 fsync）—— 账册越厚，每次结算
// 的写放大越大（O(全量)）。
// 修法：append-only 行式 WAL —— 每行一个事件 {planId, event, ts, payload}，
// 追加单行（open('a') + write + fsync + close），构造期重放重建内存态：
//   · 事件标签：mint（铸造/顶替合并行）/ settle（无补偿结算：verified、
//     aborted-pre-dispatch）/ compensate（补偿结算：compensated-*、
//     compensation-failed、degraded-record-only）/ close（兜底关闭：
//     recovered-human-attention 等）/ ack（人工确认注记）—— settle/close/
//     compensate 三标签的重放语义同律（出在途 + 入账册），标签保留审计语义；
//   · mint 顶替：同令牌旧预案流产 + 新预案注册合并为**单事件行**
//    （payload.superseded 携带流产账 —— 旧实现的双次全量重写并作一次追加）；
//   · 崩溃一致性不降级：每行独立 fsync（行可见即行已持久），崩溃至多留一条
//     尾部半行 ⇒ 重放侧坏行跳过计数（防御式：好行不连坐）；
//   · 压缩：行数远超活跃态（2×(账册+在途)+256）⇒ 下次落盘点做一次原子全量
//     重写（tmp+fsync+rename），把亡账与跳过行挤出 —— 摊还后仍 O(增量)；
//   · 旧档兼容：装载面探测整档 JSON 形状（version/inFlight/ledger）⇒ 旧档
//     只读迁移 —— 旧档内容原样读入重建内存态后，一次性原子改写为行式
//    （不改写则后续追加会污染旧档语义；改写是整档原子换名，数据零丢失）。
/** ΝΩ-22：行式 WAL 魔数头（与旧整档 JSON 分流的探测锚） */
const ESCROW_WAL_MAGIC = 'dsh-escrow-wal';
/** ΝΩ-22：行式 WAL 档版本 */
const ESCROW_WAL_EVENTS_VERSION = 2;
/** ΝΩ-22：压缩阈值 —— 追加行数超过 2×(账册+在途)+256 ⇒ 触发一次全量压缩重写 */
const WAL_COMPACT_OVERHEAD = 256;
// ─── 文件存储实现（tmp + fsync + rename —— checkpoint.ts / approval.ts 同律） ───
/**
 * W3-1：托管 WAL 的文件实现（原子写：tmp + fsync + rename —— 绝无半档）。
 * ΝΩ-22：增产行式追加面 append —— 单事件行 open('a')+write+fsync+close，
 * 每行独立持久（行可见即行已落盘 —— 与整档 fsync+rename 等强；崩溃至多留
 * 一条尾部半行，重放侧跳过计数）。
 */
export function createEscrowFileStorage(filePath) {
    return {
        load() {
            try {
                if (!filePath || !existsSync(filePath))
                    return null;
                const text = readFileSync(filePath, 'utf8');
                return typeof text === 'string' && text.trim() !== '' ? text : null;
            }
            catch {
                return null; // 读故障（含 ENOENT 竞态）= 无在途托管（诚实方向）
            }
        },
        save(text) {
            if (!filePath)
                return { ok: false, error: 'escrow wal path is empty' };
            const tmp = filePath + '.tmp';
            try {
                mkdirSync(path.dirname(filePath), { recursive: true });
                // fsync 落盘后再换名：rename 可先于数据块持久化 —— 崩溃后可能读到空/截断档
                const fd = openSync(tmp, 'w');
                try {
                    writeSync(fd, Buffer.from(text, 'utf8'));
                    fsyncSync(fd);
                }
                finally {
                    closeSync(fd);
                }
                renameSync(tmp, filePath); // 原子换名：要么完整旧档要么完整新档
                return { ok: true };
            }
            catch (e) {
                try {
                    unlinkSync(tmp);
                }
                catch { /* tmp 可能未创建 */ }
                return { ok: false, error: e instanceof Error ? e.message : String(e) };
            }
        },
        append(line) {
            if (!filePath)
                return { ok: false, error: 'escrow wal path is empty' };
            let fd = null;
            try {
                mkdirSync(path.dirname(filePath), { recursive: true });
                fd = openSync(filePath, 'a');
                try {
                    writeSync(fd, Buffer.from(line, 'utf8'));
                    fsyncSync(fd); // ΝΩ-22：每行独立 fsync —— 行写入即持久，不等整档压缩
                }
                finally {
                    closeSync(fd);
                }
                return { ok: true };
            }
            catch (e) {
                if (fd !== null) {
                    try {
                        closeSync(fd);
                    }
                    catch { /* 已关或未开 */ }
                }
                return { ok: false, error: e instanceof Error ? e.message : String(e) };
            }
        },
    };
}
// ─── 模块态（全部经 arm 注入；缺省 = 无端口 + 内置表 + 真钟 + 仅内存） ───
let escrowStorage = null;
let escrowNow = Date.now;
let escrowTtlMs = DEFAULT_ESCROW_TTL_MS;
let hashPort = null;
let clipboardPort = null;
let focusPort = null;
let interruptPort = null;
let executorPort = null;
/** W6-3：热键端口（hotkey 类补偿步骤的专用出口；null = 缺席 ⇒ 回落 executor） */
let hotkeyPort = null;
/** 注入扩展的策略表（同键覆盖内置） */
let extensionStrategies = new Map();
let inFlightPlans = new Map(); // planId → plan
let tokenPlan = new Map(); // approvalToken → planId
let ledger = [];
let walLoaded = false;
let walPersistError;
// ── ΝΩ-22：行式 WAL 簿记 ──
/** 当前档格式：none=无档/仅内存；legacy=旧整档（迁移写失败时滞留）；events=行式 */
let walFormat = 'none';
/** 重放防御观测：坏行/半行跳过计数（透明化面 stats() 暴露） */
let walSkippedLines = 0;
/** 压缩阈值簿记：上次压缩以来的追加行数 */
let walLinesSinceCompact = 0;
/** approval 钩子注册标记（arm 注册 / escrow.reset 后回 false —— 透明化事实源） */
let hooksRegistered = false;
/** 在途异步工作（fire-and-forget 结算的追踪面 —— idle() 供测试/宿主排空） */
const activeWork = new Set();
/** 安全时钟读数（注入钟抛错/回垃圾 ⇒ 真钟兜底 —— TTL 语义不因计时面归零） */
function eNow() {
    try {
        const t = escrowNow();
        if (typeof t === 'number' && Number.isFinite(t) && t >= 0)
            return t;
    }
    catch { /* 注入钟故障 ⇒ 真钟兜底 */ }
    try {
        return Date.now();
    }
    catch {
        return 0;
    }
}
function newPlanId() {
    return 'ESC-' + randomBytes(8).toString('hex').toUpperCase();
}
/** 字符串净化：非字符串/空 ⇒ undefined；否则截断（Token 纪律与隐私截断） */
function strOrUndef(v, max) {
    return typeof v === 'string' && v.trim() !== '' ? v.slice(0, max) : undefined;
}
// ─── WAL 装载 / 净化 / 落盘 ───
/** 补偿步骤净化（垃圾 ⇒ null 弃置） */
function sanitizeStep(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const r = raw;
    const method = r.method;
    const label = strOrUndef(r.label, 200);
    if (typeof method !== 'string' || label === undefined)
        return null;
    const ALLOWED = ['hotkey', 'menu', 'recycle-bin-restore', 'clipboard-restore', 'navigate', 'shaper-undo', 'custom'];
    if (!ALLOWED.includes(method))
        return null;
    const step = { method: method, label };
    if (Array.isArray(r.keys)) {
        const keys = r.keys.filter((k) => typeof k === 'string' && k.trim() !== '').slice(0, 8);
        if (keys.length > 0)
            step.keys = keys;
    }
    const target = strOrUndef(r.target, 200);
    if (target !== undefined)
        step.target = target;
    return step;
}
/** 预案净化（垃圾 ⇒ null 弃置 —— 好预案不连坐） */
function sanitizePlan(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const r = raw;
    const planId = strOrUndef(r.planId, 64);
    const semantics = strOrUndef(r.semantics, 64);
    const mintedAt = r.mintedAt;
    const ttlMs = r.ttlMs;
    const expiresAt = r.expiresAt;
    const compensation = r.compensation;
    if (planId === undefined || semantics === undefined)
        return null;
    if (typeof mintedAt !== 'number' || !Number.isFinite(mintedAt) || mintedAt < 0)
        return null;
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0)
        return null;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt < 0)
        return null;
    if (!Array.isArray(compensation))
        return null;
    const steps = [];
    for (const s of compensation) {
        const step = sanitizeStep(s);
        if (step)
            steps.push(step);
    }
    if (steps.length === 0)
        return null; // 无补偿路径的预案不是预案
    const plan = {
        planId, semantics,
        mintedAt: Math.floor(mintedAt),
        ttlMs: Math.floor(ttlMs),
        expiresAt: Math.floor(expiresAt),
        compensation: steps,
        verifyMode: r.verifyMode === 'screen-hash' || r.verifyMode === 'predicate' || r.verifyMode === 'none'
            ? r.verifyMode : 'none',
    };
    const token = strOrUndef(r.approvalToken, 64);
    if (token !== undefined)
        plan.approvalToken = token;
    const desc = strOrUndef(r.description, 200);
    if (desc !== undefined)
        plan.description = desc;
    const tool = strOrUndef(r.tool, 64);
    if (tool !== undefined)
        plan.tool = tool;
    const focus = strOrUndef(r.focusWindow, 200);
    if (focus !== undefined)
        plan.focusWindow = focus;
    const hash = strOrUndef(r.preActionHash, 256);
    if (hash !== undefined)
        plan.preActionHash = hash;
    const clip = strOrUndef(r.clipboardBackupHandle, 256);
    if (clip !== undefined)
        plan.clipboardBackupHandle = clip;
    if (typeof r.verifyThreshold === 'number' && Number.isFinite(r.verifyThreshold)) {
        plan.verifyThreshold = r.verifyThreshold;
    }
    if (Array.isArray(r.degraded)) {
        const tags = r.degraded.filter((d) => typeof d === 'string').slice(0, 16);
        if (tags.length > 0)
            plan.degraded = tags;
    }
    return plan;
}
/**
 * 惰性装载 + 崩溃恢复：首次触面时从 WAL 读档。**在途预案 ⇒ 不自动补偿** ——
 * 崩溃后的世界状态未知（动作可能已生效、屏幕早已相变数页），按陈旧预案对
 * 现在的屏幕执行热键是新一轮破坏；saga 的 in-doubt 事务在恢复期只做一件事：
 * 醒目地交给人。每条在途预案转为 recovered-human-attention 账册记录 +
 * 升级报告（pendingHumanAttention 持续可见，直到宿主 acknowledge）。
 * ΝΩ-22：装载面格式分流 —— 整档 JSON 形状（version/inFlight/ledger）⇒ 旧档
 * 只读迁移；否则按行式事件流重放（坏行/崩溃半行跳过计数，好行不连坐）。
 */
function ensureWalLoaded() {
    if (walLoaded)
        return;
    walLoaded = true;
    inFlightPlans = new Map();
    tokenPlan = new Map();
    ledger = [];
    walFormat = 'none';
    walSkippedLines = 0;
    walLinesSinceCompact = 0;
    if (escrowStorage === null)
        return; // 仅内存（跨进程不保 —— 诚实降级）
    try {
        const text = escrowStorage.load();
        if (text === null)
            return;
        const trimmed = text.trim();
        if (trimmed === '')
            return;
        // ΝΩ-22 格式分流：先尝试整档 JSON（旧 v1 整档是单 JSON 文档；行式档首行
        // 是魔数头、多行整体不可单解析 —— 单头行档落进行式分支由魔数识别）。
        let whole;
        try {
            whole = JSON.parse(trimmed);
        }
        catch {
            whole = undefined;
        }
        if (whole !== undefined && whole !== null && typeof whole === 'object' && !Array.isArray(whole)) {
            const root = whole;
            if (Array.isArray(root.inFlight) || Array.isArray(root.ledger) || root.version === ESCROW_WAL_VERSION) {
                loadLegacyWal(root);
                return;
            }
        }
        replayEventWal(trimmed);
    }
    catch {
        /* 解析故障 ⇒ 归零（防御式：坏档不炸托管，也不冒充恢复） */
    }
}
/**
 * ΝΩ-22：行式事件流重放 —— 逐行解析重建内存态（在途表/令牌索引/账册）。
 * 防御式：坏行（垃圾/崩溃尾部半行）跳过计数，好行不连坐；重放后账册封顶
 * 与旧档装载同律；在途残留 ⇒ 崩溃恢复语义（recoverInFlight）。
 */
function replayEventWal(text) {
    walFormat = 'events';
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line === '')
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            walSkippedLines++;
            continue;
        } // 崩溃半行/垃圾行
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            walSkippedLines++;
            continue;
        }
        const r = parsed;
        if (r.wal === ESCROW_WAL_MAGIC)
            continue; // 魔数头行（非事件）
        if (typeof r.planId !== 'string' || typeof r.event !== 'string') {
            walSkippedLines++;
            continue;
        }
        applyWalEvent(r);
    }
    if (ledger.length > MAX_LEDGER_ENTRIES)
        ledger = ledger.slice(-MAX_LEDGER_ENTRIES);
    recoverInFlight();
}
/** ΝΩ-22：单事件行的重放应用面（mint / settle / close / compensate / ack） */
function applyWalEvent(r) {
    const planId = String(r.planId);
    const event = String(r.event);
    const payload = r.payload !== null && typeof r.payload === 'object' && !Array.isArray(r.payload)
        ? r.payload
        : {};
    if (event === 'mint') {
        const plan = sanitizePlan(payload.plan);
        if (plan === null) {
            walSkippedLines++; // 坏预案行弃置（好行不连坐）
            return;
        }
        // mint 顶替：单事件行先应用被顶替预案的流产账（旧预案出在途+入账册），
        // 再注册新预案 —— 与铸造侧的簿记序一致
        const superseded = sanitizeLedgerRecord(payload.superseded);
        if (superseded !== null)
            applyCloseRecord(superseded);
        inFlightPlans.set(plan.planId, plan);
        if (plan.approvalToken !== undefined)
            tokenPlan.set(plan.approvalToken, plan.planId);
        return;
    }
    if (event === 'settle' || event === 'close' || event === 'compensate') {
        // 三标签重放语义同律：出在途 + 入账册（标签是审计语义，不是控制流）
        const rec = sanitizeLedgerRecord(payload.record);
        if (rec === null) {
            walSkippedLines++;
            return;
        }
        applyCloseRecord(rec);
        return;
    }
    if (event === 'ack') {
        const ackAt = typeof r.ts === 'number' && Number.isFinite(r.ts) ? Math.floor(r.ts) : eNow();
        const target = [...ledger].reverse()
            .find(x => x.planId === planId && x.escalation !== undefined);
        if (target !== undefined && target.escalation !== undefined && target.escalation.acknowledgedAt === undefined) {
            target.escalation.acknowledgedAt = ackAt;
        }
        else {
            walSkippedLines++; // 无可确认对象（重复 ack / 账册封顶挤出）⇒ 跳过计数
        }
        return;
    }
    walSkippedLines++; // 未知事件标签（前向兼容：跳过不炸）
}
/** ΝΩ-22：关闭事件的应用面 —— 出在途（含令牌索引清理）+ 入账册 */
function applyCloseRecord(rec) {
    inFlightPlans.delete(rec.planId);
    if (rec.approvalToken !== undefined && tokenPlan.get(rec.approvalToken) === rec.planId) {
        tokenPlan.delete(rec.approvalToken);
    }
    ledger.push(rec);
}
/**
 * ΝΩ-22：在途残留的崩溃恢复记录构造（不自动补偿 —— 世界状态未知，醒目交给
 * 人；与旧整档装载路径逐字同律，供行式重放与旧档迁移共用）。
 */
function buildRecoveryRecord(plan, now) {
    return {
        planId: plan.planId,
        semantics: plan.semantics,
        ...(plan.description !== undefined ? { description: plan.description } : {}),
        ...(plan.approvalToken !== undefined ? { approvalToken: plan.approvalToken } : {}),
        mintedAt: plan.mintedAt,
        settledAt: now,
        outcome: 'recovered-human-attention',
        trigger: 'crash-recovery',
        reason: 'in-flight escrow plan found in WAL after restart — world state unknown, auto-compensation refused',
        executedSteps: [],
        escalation: {
            severity: 'critical',
            headline: 'REVERSAL ESCROW: in-flight plan recovered from WAL — HUMAN ATTENTION REQUIRED',
            planId: plan.planId,
            semantics: plan.semantics,
            whatHappened: `A dangerous "${plan.semantics}" action had a minted reversal escrow plan when the process stopped. ` +
                'Whether the action took effect is UNKNOWN. Automated compensation on the post-crash screen was refused ' +
                '(acting on a stale plan against an unknown world state is a new hazard, not a remedy).',
            compensationAttempted: [],
            suggestedHumanAction: plan.description
                ? `Inspect the world manually for: ${plan.description}. If the action took effect and is unwanted, ` +
                    `apply the compensation path by hand: ${plan.compensation.map(s => s.label).join('; ')}.`
                : `Inspect the world manually for the "${plan.semantics}" action; if unwanted, compensate by hand: ` +
                    plan.compensation.map(s => s.label).join('; ') + '.',
            mintedAt: plan.mintedAt,
            raisedAt: now,
        },
    };
}
/**
 * ΝΩ-22：在途残留 ⇒ 崩溃恢复（recoverInFlight）：逐条转 recovered-human-
 * attention 并立即落盘 —— 恢复动作本身崩溃 ⇒ 下次恢复重读原事件（幂等：
 * 恢复 close 行已入档；宁可重复唠叨，不可静默蒸发）。
 */
function recoverInFlight() {
    if (inFlightPlans.size === 0)
        return;
    const now = eNow();
    const recovered = [];
    for (const plan of [...inFlightPlans.values()]) {
        const rec = buildRecoveryRecord(plan, now);
        inFlightPlans.delete(plan.planId);
        if (plan.approvalToken !== undefined && tokenPlan.get(plan.approvalToken) === plan.planId) {
            tokenPlan.delete(plan.approvalToken);
        }
        ledger.push(rec);
        recovered.push(rec);
    }
    for (const rec of recovered) {
        appendWalEvent({ planId: rec.planId, event: 'close', ts: rec.settledAt, payload: { record: rec } });
    }
}
/**
 * ΝΩ-22：旧整档装载（只读迁移）—— 沿 W3-1 的整档语义重建内存态（账册 +
 * 在途恢复），随后一次性原子改写为行式事件档：旧档内容原样读入（只读），
 * 迁移是整档 tmp+fsync+rename（数据零丢失）；迁移写失败 ⇒ 档滞留 legacy
 * 格式，后续落盘全量重写即是迁移重试（绝不向旧档半途追加污染格式）。
 */
function loadLegacyWal(root) {
    walFormat = 'legacy';
    if (Array.isArray(root.ledger)) {
        for (const raw of root.ledger.slice(-MAX_LEDGER_ENTRIES)) {
            const rec = sanitizeLedgerRecord(raw);
            if (rec)
                ledger.push(rec);
        }
    }
    if (Array.isArray(root.inFlight)) {
        for (const raw of root.inFlight) {
            const plan = sanitizePlan(raw);
            if (plan === null)
                continue; // 垃圾预案弃置（好预案不连坐）
            inFlightPlans.set(plan.planId, plan);
            if (plan.approvalToken !== undefined)
                tokenPlan.set(plan.approvalToken, plan.planId);
        }
    }
    // 在途残留 ⇒ 崩溃恢复（legacy 格式下 appendWalEvent 自动回落全量重写 ——
    // 恢复结算随迁移一并落盘，与旧实现的「恢复即 persistWal」同律）
    recoverInFlight();
    if (!walIsEvents())
        persistWal(); // 无在途也要迁移格式（append 前置条件）
}
/** ΝΩ-22：当前档是否已是行式事件格式（跨函数簿记读 —— 恢复路径可能已翻转） */
function walIsEvents() {
    return walFormat === 'events';
}
/** 账册记录净化（垃圾 ⇒ null 弃置） */
function sanitizeLedgerRecord(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const r = raw;
    const planId = strOrUndef(r.planId, 64);
    const semantics = strOrUndef(r.semantics, 64);
    const mintedAt = r.mintedAt;
    const settledAt = r.settledAt;
    const OUTCOMES = [
        'verified', 'aborted-pre-dispatch', 'compensated-verified', 'compensated-unverified',
        'compensation-failed', 'degraded-record-only', 'recovered-human-attention',
    ];
    if (planId === undefined || semantics === undefined)
        return null;
    if (typeof mintedAt !== 'number' || !Number.isFinite(mintedAt) || mintedAt < 0)
        return null;
    if (typeof settledAt !== 'number' || !Number.isFinite(settledAt) || settledAt < 0)
        return null;
    if (typeof r.outcome !== 'string' || !OUTCOMES.includes(r.outcome))
        return null;
    const rec = {
        planId, semantics,
        mintedAt: Math.floor(mintedAt),
        settledAt: Math.floor(settledAt),
        outcome: r.outcome,
    };
    const desc = strOrUndef(r.description, 200);
    if (desc !== undefined)
        rec.description = desc;
    const token = strOrUndef(r.approvalToken, 64);
    if (token !== undefined)
        rec.approvalToken = token;
    const trigger = strOrUndef(r.trigger, 64);
    if (trigger !== undefined)
        rec.trigger = trigger;
    const reason = strOrUndef(r.reason, 400);
    if (reason !== undefined)
        rec.reason = reason;
    if (Array.isArray(r.executedSteps)) {
        const steps = r.executedSteps.filter((s) => typeof s === 'string').slice(0, 16);
        if (steps.length > 0)
            rec.executedSteps = steps;
    }
    if (Array.isArray(r.degraded)) {
        const tags = r.degraded.filter((d) => typeof d === 'string').slice(0, 16);
        if (tags.length > 0)
            rec.degraded = tags;
    }
    const esc = r.escalation;
    if (esc && typeof esc === 'object') {
        const e = esc;
        const headline = strOrUndef(e.headline, 400);
        const suggested = strOrUndef(e.suggestedHumanAction, 800);
        if (headline !== undefined && suggested !== undefined) {
            const failure = strOrUndef(e.failureDetail, 400);
            rec.escalation = {
                severity: 'critical',
                headline,
                planId,
                semantics,
                whatHappened: strOrUndef(e.whatHappened, 800) ?? '',
                compensationAttempted: Array.isArray(e.compensationAttempted)
                    ? e.compensationAttempted.filter((s) => typeof s === 'string').slice(0, 16) : [],
                ...(failure !== undefined ? { failureDetail: failure } : {}),
                suggestedHumanAction: suggested,
                mintedAt: typeof e.mintedAt === 'number' && Number.isFinite(e.mintedAt) ? e.mintedAt : mintedAt,
                raisedAt: typeof e.raisedAt === 'number' && Number.isFinite(e.raisedAt) ? e.raisedAt : settledAt,
                ...(typeof e.acknowledgedAt === 'number' && Number.isFinite(e.acknowledgedAt) ? { acknowledgedAt: e.acknowledgedAt } : {}),
            };
        }
    }
    return rec;
}
/** 账册结果 → 事件标签（重放语义三标签同律 —— 标签保留审计语义） */
function eventLabelOf(outcome) {
    if (outcome === 'verified' || outcome === 'aborted-pre-dispatch')
        return 'settle';
    if (outcome === 'compensated-verified' || outcome === 'compensated-unverified'
        || outcome === 'compensation-failed' || outcome === 'degraded-record-only')
        return 'compensate';
    return 'close'; // recovered-human-attention 等兜底关闭
}
/** ΝΩ-22：当前内存态 → 行式 WAL 全量文本（首写建档 / 旧档迁移 / 压缩的
 *  原子重写面 —— 头行魔数 + 在途 mint 行 + 账册结算行） */
function serializeEventWal() {
    const lines = [JSON.stringify({ wal: ESCROW_WAL_MAGIC, version: ESCROW_WAL_EVENTS_VERSION }) + '\n'];
    for (const p of inFlightPlans.values()) {
        lines.push(JSON.stringify({ planId: p.planId, event: 'mint', ts: p.mintedAt, payload: { plan: p } }) + '\n');
    }
    for (const rec of ledger) {
        lines.push(JSON.stringify({
            planId: rec.planId, event: eventLabelOf(rec.outcome), ts: rec.settledAt, payload: { record: rec },
        }) + '\n');
    }
    return lines.join('');
}
/**
 * WAL 全量落盘（存储缺席 = 仅内存恒 ok；失败记 walPersistError —— 绝不抛）。
 * ΝΩ-22：整档原子重写面（tmp + fsync + rename）—— 行式事件档格式。调用点：
 * 首写建档、旧档迁移、压缩、以及存储无 append 面时的等效全量写（旧注入面）。
 */
function persistWal() {
    if (escrowStorage === null)
        return { ok: true };
    try {
        const r = escrowStorage.save(serializeEventWal());
        if (!r.ok)
            walPersistError = r.error ?? 'unknown storage error';
        else {
            walPersistError = undefined;
            walFormat = 'events';
            walLinesSinceCompact = 0;
        }
        return r;
    }
    catch (e) {
        walPersistError = e instanceof Error ? e.message : String(e);
        return { ok: false, error: walPersistError };
    }
}
/**
 * ΝΩ-22：追加单事件行（O(1) —— 行式 WAL 的增量面；调用点内存态已提交）。
 * 分流：尚未是行式格式（无档/旧整档滞留）或存储无 append 面 ⇒ 全量原子重写
 * （首写建档 / 迁移重试 / 旧注入面等效语义）；已是行式 ⇒ 单行追加 + 独立
 * fsync，追加行数超压缩阈值 ⇒ 同点位做一次全量压缩重写（亡账与跳过行挤出，
 * 摊还后仍 O(增量)）。绝不抛。
 */
function appendWalEvent(evt) {
    if (escrowStorage === null)
        return { ok: true };
    if (walFormat !== 'events' || typeof escrowStorage.append !== 'function') {
        return persistWal(); // 首写建档 / 旧档迁移重试 / 旧存储注入面 —— 全量重写
    }
    try {
        const r = escrowStorage.append(JSON.stringify(evt) + '\n');
        if (!r.ok) {
            walPersistError = r.error ?? 'unknown storage error';
            return r;
        }
        walPersistError = undefined;
        walLinesSinceCompact++;
        // 压缩阈值：追加行数远超活跃态 ⇒ 原子全量重写封顶文件膨胀
        if (walLinesSinceCompact > 2 * (ledger.length + inFlightPlans.size) + WAL_COMPACT_OVERHEAD) {
            persistWal(); // 压缩失败不回滚追加行（事件已持久 —— 下次落盘点重试压缩）
        }
        return r;
    }
    catch (e) {
        walPersistError = e instanceof Error ? e.message : String(e);
        return { ok: false, error: walPersistError };
    }
}
/** 策略查表：扩展覆盖内置（注入扩展是部署对策略表的显式修订 —— 后见者胜） */
function lookupStrategy(semantics) {
    const ext = extensionStrategies.get(semantics);
    if (ext)
        return ext;
    return BUILTIN_STRATEGIES.get(semantics) ?? null;
}
/** 在途异步工作登记（fire-and-forget 结算的排空面） */
function track(p) {
    activeWork.add(p);
    void p.finally(() => { activeWork.delete(p); }).catch(() => { });
    return p;
}
// ─── 预案铸造 ───
/**
 * 铸造逆转预案（危险动作派发**之前**调用 —— approval.beginAttempt 的前置挂点）。
 * 语义序：策略查表（缺失/manual-only ⇒ fail-closed 拒绝，人类亲办）→ 端口采集
 * （缺席 ⇒ 诚实缺席 + degraded 标记）→ **WAL 先行落盘**（失败 ⇒ 拒绝 —— 预案
 * 不入托管即不派发，H4 takeGranted「宁可保守不可双发」同律）→ 注册返回。
 * 同令牌重复铸造 ⇒ 旧在途预案就地流产（aborted-superseded：beginAttempt 的
 * 单在途约束保证被顶替的预案从未派发 —— 无补偿义务）。绝不抛。
 */
async function mintPlan(info) {
    try {
        ensureWalLoaded();
        const semantics = strOrUndef(info?.semantics, 64);
        if (semantics === undefined)
            return { ok: false, reason: 'no-strategy', detail: 'semantics is required to look up a compensation path' };
        // 铁律 3：无可逆路径者强制人类亲办（fail-closed —— 两类成因分开报告）
        const strategy = lookupStrategy(semantics);
        if (strategy === null) {
            return {
                ok: false, reason: 'no-strategy',
                detail: `no compensation strategy for semantics "${semantics}" — classify the action (extend the strategy table) ` +
                    'or the HUMAN must perform it personally via full approval + manual execution',
            };
        }
        if (strategy.kind === 'manual-only') {
            return { ok: false, reason: 'manual-only', detail: strategy.reason };
        }
        // 端口采集（逐个防御：故障 = 缺席 + degraded 标记 —— 可用性优先）
        const degraded = [];
        const focusWindow = await captureFromPort('focus', () => focusPort?.current() ?? Promise.resolve(null), degraded, 'no-focus-port');
        const preActionHash = await captureFromPort('hash', () => hashPort?.capture() ?? Promise.resolve(null), degraded, 'no-hash-port');
        const clipboardBackupHandle = await captureFromPort('clipboard', () => clipboardPort?.backup() ?? Promise.resolve(null), degraded, 'no-clipboard-port');
        if (executorPort === null
            && (hotkeyPort === null || strategy.steps.some(s => s.method !== 'hotkey'))) {
            // W6-3：执行通道判定 —— 全 hotkey 策略 + 热键端口在场 = 可执行
            // （executor 缺席不再必然降级：仅有热键管线的部署也能自动补偿 hotkey 类
            // 预案）；含非 hotkey 步骤且 executor 缺席，或热键端口亦缺席 ⇒ 标记照旧。
            degraded.push('no-executor-port');
        }
        if (escrowStorage === null)
            degraded.push('no-storage');
        const now = eNow();
        const ttl = Math.max(1_000, typeof info?.ttlMs === 'number' && Number.isFinite(info.ttlMs) ? info.ttlMs : escrowTtlMs);
        const description = strOrUndef(info?.description, 200);
        const approvalToken = strOrUndef(info?.approvalToken, 64);
        const tool = strOrUndef(info?.tool, 64);
        const plan = {
            planId: newPlanId(),
            semantics,
            ...(description !== undefined ? { description } : {}),
            ...(approvalToken !== undefined ? { approvalToken } : {}),
            ...(tool !== undefined ? { tool } : {}),
            mintedAt: now,
            ttlMs: ttl,
            expiresAt: now + ttl,
            compensation: strategy.steps.map(s => ({ ...s })), // 自包含快照
            verifyMode: strategy.verify.mode,
            ...(focusWindow !== undefined ? { focusWindow } : {}),
            ...(preActionHash !== undefined ? { preActionHash } : {}),
            ...(clipboardBackupHandle !== undefined ? { clipboardBackupHandle } : {}),
            ...(strategy.verify.mode === 'screen-hash'
                ? { verifyThreshold: strategy.verify.threshold ?? DEFAULT_VERIFY_THRESHOLD } : {}),
            ...(degraded.length > 0 ? { degraded } : {}),
        };
        // 同令牌旧在途预案流产（见函数头注释的论证）。
        // ΝΩ-22：顶替双写合并为单事件行 —— 旧实现先 closePlan（全量重写①）再
        // persistWal（全量重写②）；现在流产账随 mint 行携带（payload.superseded），
        // 一次追加同时翻转两笔簿记。
        let supersededStale;
        let supersededRecord;
        if (plan.approvalToken !== undefined) {
            const staleId = tokenPlan.get(plan.approvalToken);
            if (staleId !== undefined && inFlightPlans.has(staleId)) {
                supersededStale = inFlightPlans.get(staleId);
                supersededRecord = buildCloseRecord(supersededStale, {
                    outcome: 'aborted-pre-dispatch', trigger: 'superseded',
                    reason: 'superseded by a newer mint for the same approval token (single in-flight dispatch per token)',
                });
            }
        }
        // 铁律 4（WAL 语义）：预案先行落盘 —— 失败 ⇒ 不入托管即拒绝派发。
        // 内存先提交、追加失败 ⇒ 逐项回滚（与旧实现的回滚语义同形；账册封顶
        // 延后到成功路径 —— 回滚 pop 干净）。
        if (supersededStale !== undefined) {
            inFlightPlans.delete(supersededStale.planId); // 顶替：旧预案流产出在途
        }
        inFlightPlans.set(plan.planId, plan);
        if (plan.approvalToken !== undefined)
            tokenPlan.set(plan.approvalToken, plan.planId);
        if (supersededRecord !== undefined)
            ledger.push(supersededRecord); // 暂不封顶（成功后统一封顶）
        const persisted = appendWalEvent({
            planId: plan.planId, event: 'mint', ts: now,
            payload: { plan, ...(supersededRecord !== undefined ? { superseded: supersededRecord } : {}) },
        });
        if (!persisted.ok) {
            // 回滚：盘未翻转 ⇒ 内存逐项还原（新预案摘除 + 顶替流产撤销）
            inFlightPlans.delete(plan.planId);
            if (plan.approvalToken !== undefined && tokenPlan.get(plan.approvalToken) === plan.planId) {
                tokenPlan.delete(plan.approvalToken);
            }
            if (supersededStale !== undefined) {
                inFlightPlans.set(supersededStale.planId, supersededStale);
                if (plan.approvalToken !== undefined)
                    tokenPlan.set(plan.approvalToken, supersededStale.planId);
            }
            if (supersededRecord !== undefined && ledger[ledger.length - 1] === supersededRecord)
                ledger.pop();
            // 防御式再同步：追加路径若中途触发过压缩（全量重写）而追加失败 ⇒ 盘上
            // 可能残留已提交假象 —— best-effort 全量重写回滚态（失败仅记 error）；
            // 重写成功不清除原失败证据（stats 的 persistError 面向调用方如实汇报）
            const originalError = persisted.error;
            persistWal();
            if (originalError !== undefined)
                walPersistError = originalError;
            return { ok: false, reason: 'persist-failed', detail: persisted.error };
        }
        if (ledger.length > MAX_LEDGER_ENTRIES)
            ledger = ledger.slice(-MAX_LEDGER_ENTRIES);
        return { ok: true, plan: clonePlan(plan) };
    }
    catch {
        return { ok: false, reason: 'internal' }; // 防御式兜底（正常流不可达）
    }
}
/** 端口采集的防御包装：端口缺席/抛错/非字符串 ⇒ undefined + degraded 标记 */
async function captureFromPort(_name, fn, degraded, absentTag) {
    try {
        const v = await fn();
        if (typeof v === 'string' && v.trim() !== '')
            return v.slice(0, 256);
        degraded.push(absentTag);
        return undefined;
    }
    catch {
        degraded.push(absentTag); // 端口故障 = 端口缺席（诚实降级，绝不炸铸造）
        return undefined;
    }
}
// ─── 派发闸门（approval.beginAttempt 的同步前置钩子） ───
/**
 * beginAttempt 前置闸门（同步面 —— 物理派发前的最后一道托管执法）：
 * 无 planId ⇒ plan-required（必须先铸造 —— 「预案先行」的执法点）；
 * planId 无效/令牌错配/TTL 已过 ⇒ 拒绝。策略表缺失的拒绝发生在铸造面
 * （mintPlan fail-closed），此处保证**没有预案就绝无派发预留**。
 */
function dispatchGate(check) {
    try {
        ensureWalLoaded();
        if (!check?.planId) {
            return {
                ok: false, reason: 'plan-required',
                detail: 'dangerous dispatch requires a minted reversal plan — call reversalEscrow.mintPlan BEFORE beginAttempt ' +
                    '(actions without a compensation path are rejected fail-closed and must be performed by the human)',
            };
        }
        const plan = inFlightPlans.get(check.planId);
        if (!plan)
            return { ok: false, reason: 'plan-invalid', detail: `no in-flight escrow plan "${check.planId}"` };
        if (plan.approvalToken !== undefined && check.token !== plan.approvalToken) {
            return { ok: false, reason: 'plan-token-mismatch', detail: `plan ${plan.planId} was minted for a different approval token` };
        }
        if (eNow() > plan.expiresAt) {
            return { ok: false, reason: 'plan-expired', detail: `plan ${plan.planId} TTL elapsed before dispatch` };
        }
        return { ok: true };
    }
    catch {
        return { ok: false, reason: 'plan-invalid', detail: 'internal gate failure — failing closed' };
    }
}
// ─── 结算与补偿 ───
/** 占位：把预案原子摘出在途表 —— 并发的第二结算/中断/巡检找不到 ⇒ 不补
 *  （补偿恰一次的执法点；摘要出后 closePlan 入账册，WAL 随行更新） */
function claimPlan(plan) {
    if (!inFlightPlans.has(plan.planId))
        return false;
    inFlightPlans.delete(plan.planId);
    if (plan.approvalToken !== undefined && tokenPlan.get(plan.approvalToken) === plan.planId) {
        tokenPlan.delete(plan.approvalToken);
    }
    return true;
}
/** 按令牌结算（consume/attemptFailed 的钩子落点；fire-and-forget 调用） */
function settleByToken(token, kind, reason) {
    return track((async () => {
        ensureWalLoaded();
        const cleanToken = String(token ?? '').trim();
        const planId = tokenPlan.get(cleanToken);
        if (planId === undefined)
            return; // 无在途预案 ⇒ no-op（正交性：普通审批流零参与）
        const plan = inFlightPlans.get(planId);
        if (!plan) {
            tokenPlan.delete(cleanToken);
            return;
        }
        if (!claimPlan(plan))
            return; // 已被并发结算/中断占位 ⇒ 不补（恰一次）
        if (kind === 'verified') {
            closePlan(plan, { outcome: 'verified', trigger: 'acceptance-verified' });
            return;
        }
        await runCompensation(plan, reason === 'no-effect' ? 'no-effect' : 'acceptance-failed', reason);
    })());
}
/** ΝΩ-22：结算记录构造（closePlan 与 mint 顶替共用 —— 纯构造，不落盘） */
function buildCloseRecord(plan, fields) {
    // 降级标记合并面：铸造时缺席清单 ∪ 结算时新增（如 no-verify-channel）
    const mergedDegraded = [...new Set([...(plan.degraded ?? []), ...(fields.degraded ?? [])])];
    return {
        planId: plan.planId,
        semantics: plan.semantics,
        ...(plan.description !== undefined ? { description: plan.description } : {}),
        ...(plan.approvalToken !== undefined ? { approvalToken: plan.approvalToken } : {}),
        mintedAt: plan.mintedAt,
        settledAt: eNow(),
        outcome: fields.outcome,
        ...(fields.trigger !== undefined ? { trigger: fields.trigger } : {}),
        ...(fields.reason !== undefined ? { reason: fields.reason } : {}),
        ...(fields.executedSteps !== undefined && fields.executedSteps.length > 0 ? { executedSteps: fields.executedSteps } : {}),
        ...(mergedDegraded.length > 0 ? { degraded: mergedDegraded } : {}),
        ...(fields.escalation !== undefined ? { escalation: fields.escalation } : {}),
    };
}
/** 关闭预案入账册（WAL 随行；结算落盘失败 ⇒ 内存账册仍准确 —— 见 persistWal 注释）。
 *  ΝΩ-22：全量重写降单事件行追加（O(增量)；每行独立 fsync —— 崩溃一致性不降级）。 */
function closePlan(plan, fields) {
    inFlightPlans.delete(plan.planId);
    if (plan.approvalToken !== undefined && tokenPlan.get(plan.approvalToken) === plan.planId) {
        tokenPlan.delete(plan.approvalToken);
    }
    const rec = buildCloseRecord(plan, fields);
    ledger.push(rec);
    if (ledger.length > MAX_LEDGER_ENTRIES)
        ledger = ledger.slice(-MAX_LEDGER_ENTRIES);
    appendWalEvent({ planId: rec.planId, event: eventLabelOf(rec.outcome), ts: rec.settledAt, payload: { record: rec } });
}
/** 构造补偿失败的升级报告（醒目 —— 绝不静默的落点） */
function buildEscalation(plan, whatHappened, attempted, failureDetail, suggestedHumanAction) {
    const now = eNow();
    return {
        severity: 'critical',
        headline: 'REVERSAL ESCROW: compensation FAILED — HUMAN INTERVENTION REQUIRED',
        planId: plan.planId,
        semantics: plan.semantics,
        whatHappened,
        compensationAttempted: attempted,
        failureDetail,
        suggestedHumanAction,
        mintedAt: plan.mintedAt,
        raisedAt: now,
    };
}
/**
 * 执行补偿（铁律 2 的核心）：无执行端口 ⇒ degraded-record-only（仅记账 —— 可用性
 * 优先，见模块头降级论证）；逐步执行（clipboard-restore 走一等端口，其余走执行
 * 端口），一步失败即止 ⇒ compensation-failed + 升级报告；全部执行 ⇒ 验证
 * （screen-hash 回预案态 / 谓词确认 / 无通道 ⇒ compensated-unverified 诚实降级）。
 */
async function runCompensation(plan, trigger, reason) {
    // 降级：无任何可执行通道 ⇒ 仅记账（预案与触发原因全量入册 —— 审计面完整）。
    // W6-3：可执行性按步骤判定 —— 全 hotkey 预案 + 热键端口在场 ⇒ 可执行
    // （executor 缺席不再必然降级）；含非 hotkey 步骤且 executor 缺席，或热键
    // 端口亦缺席 ⇒ degraded-record-only 照旧（降级记账方向不变）。
    const needsExecutorPort = plan.compensation.some(s => s.method !== 'hotkey');
    if (executorPort === null && (needsExecutorPort || hotkeyPort === null)) {
        closePlan(plan, {
            outcome: 'degraded-record-only',
            trigger,
            ...(reason !== undefined ? { reason: `${reason ?? ''}${reason ? '; ' : ''}no compensation executor port — record only (degraded)` } : { reason: 'no compensation executor port — record only (degraded)' }),
        });
        return;
    }
    const attempted = [];
    const degraded = [...(plan.degraded ?? [])];
    try {
        for (const step of plan.compensation) {
            attempted.push(step.label);
            if (step.method === 'clipboard-restore') {
                // 剪贴板恢复是一等端口义务（有备份句柄 + 端口在场才可恢复）
                if (plan.clipboardBackupHandle === undefined || clipboardPort === null) {
                    degraded.push('clipboard-restore-unavailable');
                    continue; // 非致命：跳过该步继续主补偿路径
                }
                const ok = await clipboardPort.restore(plan.clipboardBackupHandle);
                if (!ok) {
                    degraded.push('clipboard-restore-failed');
                    continue; // 剪贴板是伴生恢复，失败不阻断主补偿
                }
                continue;
            }
            if (step.method === 'hotkey' && hotkeyPort !== null) {
                // W6-3（W3-1 遗留清偿）：hotkey 步骤路由到热键端口 —— 补偿中的热键类
                // （Ctrl+Z / Backspace 返回导航）经注入的专用端口派发，不再依赖通用
                // executor 恰好认识热键。失败语义与 executor 同律：ok:false ⇒ 补偿失败
                // 升级人工（绝不静默）；端口抛错由外层 catch 兜底（防御式）。
                const r = await hotkeyPort.send(Array.isArray(step.keys) ? step.keys : []);
                if (!r.ok) {
                    closePlan(plan, {
                        outcome: 'compensation-failed',
                        trigger,
                        ...(reason !== undefined ? { reason } : {}),
                        executedSteps: [...attempted],
                        ...(degraded.length > 0 ? { degraded: [...new Set(degraded)] } : {}),
                        escalation: buildEscalation(plan, `Dangerous "${plan.semantics}" action failed acceptance (trigger: ${trigger}) and automated compensation FAILED at hotkey step "${step.label}". ` +
                            'The world may be left in an unintended state.', [...attempted], r.detail ?? 'hotkey port reported failure', plan.description
                            ? `Manually inspect: ${plan.description}. Then compensate by hand — remaining path: ${plan.compensation.slice(attempted.length).map(s => s.label).join('; ') || step.label}.`
                            : `Manually inspect the "${plan.semantics}" action and compensate by hand: ${plan.compensation.map(s => s.label).join('; ')}.`),
                    });
                    return;
                }
                continue; // 热键步已派发成功 ⇒ 下一步（热键端口缺席则穿透到 executor）
            }
            if (executorPort === null) {
                // W6-3 防御式：函数头的可执行性判定保证正常流不可达（全 hotkey 预案
                // 不会走到此处）。若仍抵达（预案数据被恢复面注入污染）⇒ 走外层 catch
                // 的 compensation-failed 升级 —— 绝不静默跳过一个无通道的补偿步骤。
                throw new Error(`no compensation channel for non-hotkey step "${step.label}"`);
            }
            const r = await executorPort.execute(step, plan);
            if (!r.ok) {
                closePlan(plan, {
                    outcome: 'compensation-failed',
                    trigger,
                    ...(reason !== undefined ? { reason } : {}),
                    executedSteps: [...attempted],
                    ...(degraded.length > 0 ? { degraded: [...new Set(degraded)] } : {}),
                    escalation: buildEscalation(plan, `Dangerous "${plan.semantics}" action failed acceptance (trigger: ${trigger}) and automated compensation FAILED at step "${step.label}". ` +
                        'The world may be left in an unintended state.', [...attempted], r.detail ?? 'executor reported failure', plan.description
                        ? `Manually inspect: ${plan.description}. Then compensate by hand — remaining path: ${plan.compensation.slice(attempted.length).map(s => s.label).join('; ') || step.label}.`
                        : `Manually inspect the "${plan.semantics}" action and compensate by hand: ${plan.compensation.map(s => s.label).join('; ')}.`),
                });
                return;
            }
        }
        // 验证（补偿可验证 —— 铁律 2 的第二半）
        const verified = await verifyCompensation(plan);
        const degradedField = degraded.length > 0 ? { degraded: [...new Set(degraded)] } : {};
        if (verified === 'verified') {
            closePlan(plan, { outcome: 'compensated-verified', trigger, ...(reason !== undefined ? { reason } : {}), executedSteps: [...attempted], ...degradedField });
        }
        else if (verified === 'failed') {
            closePlan(plan, {
                outcome: 'compensation-failed',
                trigger,
                ...(reason !== undefined ? { reason } : {}),
                executedSteps: [...attempted],
                ...degradedField,
                escalation: buildEscalation(plan, `Compensation steps for the "${plan.semantics}" action all executed, but VERIFICATION says the world did NOT return to the pre-action state (trigger: ${trigger}).`, [...attempted], 'screen hash did not return to the pre-action plan state', plan.focusWindow
                    ? `Bring window "${plan.focusWindow}" to front and manually verify/complete the undo: ${plan.compensation.map(s => s.label).join('; ')}.`
                    : `Manually verify/complete the undo: ${plan.compensation.map(s => s.label).join('; ')}.`),
            });
        }
        else {
            // 'no-channel'：补偿已执行但无验证通道 —— 诚实降级记账（区别于验证失败）
            degraded.push('no-verify-channel');
            closePlan(plan, {
                outcome: 'compensated-unverified',
                trigger,
                ...(reason !== undefined ? { reason } : {}),
                executedSteps: [...attempted],
                ...(degraded.length > 0 ? { degraded: [...new Set(degraded)] } : {}),
            });
        }
    }
    catch (e) {
        // 防御式：补偿路径自身异常 ⇒ 视同补偿失败升级（绝不静默吞掉一个可能受损的世界）
        const detail = e instanceof Error ? e.message : String(e);
        closePlan(plan, {
            outcome: 'compensation-failed',
            trigger,
            ...(reason !== undefined ? { reason } : {}),
            executedSteps: [...attempted],
            ...(degraded.length > 0 ? { degraded: [...new Set(degraded)] } : {}),
            escalation: buildEscalation(plan, `Compensation for the "${plan.semantics}" action crashed (trigger: ${trigger}). The world may be left in an unintended state.`, [...attempted], detail, `Manually inspect the world and compensate by hand: ${plan.compensation.map(s => s.label).join('; ')}.`),
        });
    }
}
/** 补偿验证：'verified' | 'failed' | 'no-channel'（无通道 ≠ 失败 —— 诚实降级） */
async function verifyCompensation(plan) {
    try {
        if (plan.verifyMode === 'screen-hash') {
            if (hashPort === null || plan.preActionHash === undefined)
                return 'no-channel';
            const now = await hashPort.capture();
            if (typeof now !== 'string' || now.trim() === '')
                return 'no-channel'; // 采集失败 = 无通道（非验证失败）
            const sim = similarity(now, plan.preActionHash);
            const threshold = plan.verifyThreshold ?? DEFAULT_VERIFY_THRESHOLD;
            return sim >= threshold ? 'verified' : 'failed';
        }
        if (plan.verifyMode === 'predicate') {
            const strategy = lookupStrategy(plan.semantics);
            if (strategy && strategy.kind === 'compensate' && typeof strategy.verifyPredicate === 'function') {
                return (await strategy.verifyPredicate(plan)) ? 'verified' : 'failed';
            }
            return 'no-channel'; // 谓词随扩展注入，铸造后扩展被卸载 ⇒ 通道消失
        }
        return 'no-channel'; // mode 'none'
    }
    catch {
        return 'no-channel'; // 验证通道故障 = 无通道（诚实降级，绝不误报失败）
    }
}
// ─── 中断 / TTL 巡检 ───
/** 用户喊停 ⇒ 全部在途预案补偿（直接调用面；生产经 InterruptSignalPort 由 sweep 轮询） */
function interrupt(reason) {
    return track((async () => {
        ensureWalLoaded();
        let compensated = 0;
        for (const plan of [...inFlightPlans.values()]) {
            if (!claimPlan(plan))
                continue; // 并发中断/结算已占位 ⇒ 不补
            await runCompensation(plan, 'interrupt', reason ?? 'user interrupt');
            compensated++;
        }
        return compensated;
    })());
}
/**
 * 巡检（宿主周期调用 / 测试直调）：轮询中断端口（pending ⇒ 在途预案全部补偿）+
 * TTL 到期的未结算预案补偿（settlement 永不到达 = 世界状态未知 —— saga 的
 * in-doubt 事务按已生效处理：补偿一次无害的 Ctrl+Z 好过留下一次真实破坏）。
 * 绝不抛。
 */
function sweep() {
    return track((async () => {
        try {
            ensureWalLoaded();
            if (inFlightPlans.size === 0)
                return 0;
            let interrupted = false;
            try {
                interrupted = interruptPort !== null && interruptPort.pending() === true;
            }
            catch { /* 中断端口故障 = 无中断（旁路义务） */ }
            if (interrupted) {
                let compensated = 0;
                for (const plan of [...inFlightPlans.values()]) {
                    if (!claimPlan(plan))
                        continue;
                    await runCompensation(plan, 'interrupt', 'user interrupt (signal port)');
                    compensated++;
                }
                return compensated;
            }
            const now = eNow();
            let swept = 0;
            for (const plan of [...inFlightPlans.values()]) {
                if (now > plan.expiresAt) {
                    if (!claimPlan(plan))
                        continue;
                    await runCompensation(plan, 'ttl-expired', 'settlement never arrived within TTL — world state unknown, compensating (saga in-doubt)');
                    swept++;
                }
            }
            return swept;
        }
        catch {
            return 0; // 防御式兜底
        }
    })());
}
// ─── 深拷贝 / 报表面 ───
function clonePlan(p) {
    return JSON.parse(JSON.stringify(p));
}
function cloneRecord(r) {
    return JSON.parse(JSON.stringify(r));
}
// ─── 托管单例（模块单例 —— 插件卸载随闭包消亡） ───
export const reversalEscrow = {
    /**
     * 武装（幂等）：注入端口/存储/时钟/TTL/策略扩展，并注册 approval 的托管钩子
     * （beginAttempt 前置闸门 + consume/attemptFailed 结算钩子 —— 组合根单点接线）。
     * 缺省 = 无端口 + 内置表 + 真钟 + 仅内存（一切降级路径的诚实起点）。绝不抛。
     */
    arm(opts = {}) {
        try {
            if ('storage' in opts)
                escrowStorage = opts.storage ?? null;
            if (typeof opts.now === 'function')
                escrowNow = opts.now;
            if (typeof opts.ttlMs === 'number' && Number.isFinite(opts.ttlMs)) {
                escrowTtlMs = Math.max(1_000, opts.ttlMs);
            }
            if ('hashPort' in opts)
                hashPort = opts.hashPort ?? null;
            if ('clipboardPort' in opts)
                clipboardPort = opts.clipboardPort ?? null;
            if ('focusPort' in opts)
                focusPort = opts.focusPort ?? null;
            if ('interruptPort' in opts)
                interruptPort = opts.interruptPort ?? null;
            if ('executorPort' in opts)
                executorPort = opts.executorPort ?? null;
            if ('hotkeyPort' in opts)
                hotkeyPort = opts.hotkeyPort ?? null; // W6-3
            if (Array.isArray(opts.strategies)) {
                const m = new Map();
                for (const s of opts.strategies) {
                    if (s && typeof s === 'object' && typeof s.semantics === 'string' && s.semantics.trim() !== '') {
                        m.set(s.semantics.slice(0, 64), s);
                    }
                }
                extensionStrategies = m;
            }
            inFlightPlans = new Map();
            tokenPlan = new Map();
            ledger = [];
            walLoaded = false;
            walPersistError = undefined;
            // ΝΩ-22：行式 WAL 簿记随武装归零（重装后 ensureWalLoaded 重新分流探测）
            walFormat = 'none';
            walSkippedLines = 0;
            walLinesSinceCompact = 0;
            // 单点接线：approval 的托管钩子（缺省武装后即接管 fail-closed 派发闸门）
            setDispatchEscrowHook(dispatchGate);
            setEscrowSettlementHook((token, verdict, reason) => {
                // fire-and-forget 旁路：结算异步面绝不阻塞/炸审批主流程
                void settleByToken(token, verdict === 'verified' ? 'verified' : 'failed', reason);
            });
            hooksRegistered = true;
        }
        catch {
            /* 武装失败 = 保持现状（托管缺席 —— 诚实降级） */
        }
    },
    /** 铸造逆转预案（派发层在 approval.beginAttempt 之前 await；见 mintPlan 全注释） */
    mintPlan(info) {
        return mintPlan(info);
    },
    /** 验收通过结算（consume 钩子的直接面 —— 测试/宿主可显式调用）：预案关闭为 verified */
    settleVerified(approvalToken) {
        return settleByToken(approvalToken, 'verified');
    },
    /** 验收失败结算（attemptFailed 钩子的直接面）⇒ 触发补偿 */
    settleFailed(approvalToken, reason) {
        return settleByToken(approvalToken, 'failed', reason);
    },
    /** 用户喊停：全部在途预案按预案补偿（返回补偿数） */
    interrupt(reason) {
        return interrupt(reason);
    },
    /** 巡检：中断端口轮询 + TTL 到期补偿（返回本轮补偿数） */
    sweep() {
        return sweep();
    },
    /**
     * 崩溃恢复面（宿主重启后显式调用 / 任意触面惰性执行）：读 WAL，在途预案转为
     * recovered-human-attention + 升级报告（不自动补偿 —— 见 ensureWalLoaded 论证）。
     */
    recover() {
        ensureWalLoaded();
        return {
            recovered: ledger.filter(r => r.outcome === 'recovered-human-attention').length,
            pendingHumanAttention: this.pendingHumanAttention().length,
        };
    },
    /** 待人工处置的升级报告（补偿失败/崩溃恢复 —— 未 acknowledge 持续可见，绝不静默） */
    pendingHumanAttention() {
        ensureWalLoaded();
        const out = [];
        for (let i = ledger.length - 1; i >= 0 && out.length < 32; i--) {
            const esc = ledger[i].escalation;
            if (esc && esc.acknowledgedAt === undefined)
                out.push(cloneRecord(ledger[i]).escalation);
        }
        return out;
    },
    /** 人工处置确认（宿主在报告处理后调用 —— 留痕但不删史） */
    acknowledge(planId) {
        ensureWalLoaded();
        const rec = [...ledger].reverse().find(r => r.planId === planId && r.escalation !== undefined);
        if (!rec || rec.escalation === undefined)
            return false;
        if (rec.escalation.acknowledgedAt === undefined) {
            rec.escalation.acknowledgedAt = eNow();
            // ΝΩ-22：确认注记追加单 ack 事件行（重放侧应用到匹配记录 —— 免全量重写）
            appendWalEvent({ planId, event: 'ack', ts: rec.escalation.acknowledgedAt });
        }
        return true;
    },
    /** 在途预案快照（深拷贝） */
    dumpInFlight() {
        ensureWalLoaded();
        return [...inFlightPlans.values()].map(clonePlan);
    },
    /** 账册快照（深拷贝 —— 新的在后） */
    dumpLedger() {
        ensureWalLoaded();
        return ledger.map(cloneRecord);
    },
    /** 排空在途异步结算（测试/宿主的确定性同步面） */
    async idle() {
        while (activeWork.size > 0) {
            await Promise.all([...activeWork]).catch(() => { });
        }
    },
    /** 透明化（测试/遥测面） */
    stats() {
        ensureWalLoaded();
        const lastDegraded = ledger.length > 0 && (ledger[ledger.length - 1].degraded?.length ?? 0) > 0;
        return {
            armed: hooksRegistered,
            inFlight: inFlightPlans.size,
            ledgerEntries: ledger.length,
            degraded: lastDegraded || [...inFlightPlans.values()].some(p => (p.degraded?.length ?? 0) > 0),
            storageArmed: escrowStorage !== null,
            hotkeyPortArmed: hotkeyPort !== null,
            ttlMs: escrowTtlMs,
            ...(walPersistError !== undefined ? { persistError: walPersistError } : {}),
            builtinStrategies: BUILTIN_STRATEGIES.size,
            extensionStrategies: extensionStrategies.size,
            walSkippedLines,
        };
    },
    /** 隔离缝（测试 beforeEach / 插件卸载）：一切模块态归零回缺省。
     *  approval 侧钩子由 resetApproval 卸载（两侧隔离缝各自负责 —— 不跨界）。 */
    reset() {
        escrowStorage = null;
        escrowNow = Date.now;
        escrowTtlMs = DEFAULT_ESCROW_TTL_MS;
        hashPort = null;
        clipboardPort = null;
        focusPort = null;
        interruptPort = null;
        executorPort = null;
        hotkeyPort = null; // W6-3：热键端口随隔离缝归零
        extensionStrategies = new Map();
        inFlightPlans = new Map();
        tokenPlan = new Map();
        ledger = [];
        walLoaded = false;
        walPersistError = undefined;
        // ΝΩ-22：行式 WAL 簿记随隔离缝归零
        walFormat = 'none';
        walSkippedLines = 0;
        walLinesSinceCompact = 0;
        hooksRegistered = false;
        activeWork.clear();
    },
};
/** W3-1：托管武装的独立函数面（组合根挂点 —— 与 armApprovalQueue 同风格） */
export function armReversalEscrow(opts = {}) {
    reversalEscrow.arm(opts);
}
// ─── W8-A4（DEBTS D-C1）：组合补偿执行器 —— shaper 撤销栈接入统一账本 ───
//
// 环境整形类补偿（缩放/对比度/窗口几何）有现成机制：environmentShaper 的
// UndoRecipe/undoLog（D-2：改变世界的权力与复原世界的义务对称）已经由
// createShaperCompensationExecutor 包装成补偿执行端口（method 'shaper-undo'
// → restoreAll LIFO 复原）。但 escrow 的 arm 只收**一个** executorPort ——
// 部署既有 GUI 执行器（热键/菜单/回收站）又有 shaper 桥时，含 shaper-undo
// 步骤的预案无从落地。本组合器是组合根的接线件：
//   arm({ executorPort: createCompositeCompensationExecutor(guiExec, createShaperCompensationExecutor()) })
// 路由律（一步恰一执行器 —— 绝不双发）：
//   · method 'shaper-undo' → 优先 shaper 桥（最知情的执行者）；桥缺席回落
//     primary（部署可能以全知 GUI 执行器统一承接 shaper-undo）；
//   · 其余 method → 优先 primary；primary 缺席回落 shaper 桥（由桥自己醒目
//     拒绝 —— 「只处理 shaper-undo」的说明比组合器吞掉步骤更诚实）；
//   · 两者皆缺席 ⇒ ok:false 醒目拒绝（绝不假装执行）。
// 防御式：执行器缺席/抛错/垃圾步骤一律收敛为诚实返回值，绝不抛（runCompensation
// 的外层 catch 之外的第二层兜底 —— 组合器是可独立复用的件）。零 import：两侧
// 执行器均经参数注入（reversalEscrow ↔ environmentShaper 保持零运行时耦合）。
/** W8-A4：组合补偿执行器（GUI 执行器 + shaper 撤销栈执行器的分method路由） */
export function createCompositeCompensationExecutor(primary, shaperUndo) {
    const p = primary ?? null;
    const s = shaperUndo ?? null;
    return {
        async execute(step, plan) {
            try {
                if (!step || typeof step !== 'object' || typeof step.method !== 'string') {
                    return { ok: false, detail: 'composite executor received a malformed compensation step — refusing to execute garbage' };
                }
                const first = step.method === 'shaper-undo' ? (s ?? p) : (p ?? s);
                if (first === null) {
                    return {
                        ok: false,
                        detail: `composite executor has no port for step "${String(step.label ?? '')}" (method "${step.method}") — ` +
                            'neither the GUI executor nor the shaper-undo executor is armed, refusing to pretend execution',
                    };
                }
                try {
                    return await first.execute(step, plan);
                }
                catch (e) {
                    // 执行器抛错 = 该步失败（与 ok:false 同律）—— 升级决策交 runCompensation
                    return { ok: false, detail: `composite executor port threw for step "${String(step.label ?? '')}": ${e instanceof Error ? e.message : String(e)}` };
                }
            }
            catch {
                return { ok: false, detail: 'internal composite routing failure — treating as step failure (fail-closed)' };
            }
        },
    };
}
/** 内置策略表视图（透明化 —— 派发层告知模型哪些语义有自动补偿路径） */
export function builtinCompensationSemantics() {
    return [...BUILTIN_STRATEGIES.keys()];
}
/**
 * W4-3（S5）：补偿策略只读查询（内置 + 注入扩展的合并视图）。分级注册表
 * 的「可补偿」级与策略表的对齐锚点：派发层/集成侧判断一个语义是否真有托管
 * 补偿路径（compensate：有；manual-only：不可补偿 —— 人类亲办；none：未分类
 * —— fail-closed）。与 riskGate.reversibilityRegistry 的对齐是纪律不是依赖
 * （riskGate 不得 import 本模块 —— 会与 approval → riskGate 成环），键对齐
 * 靠注释与测试执法。绝不抛。
 */
export function compensationPathOf(semantics) {
    try {
        const key = typeof semantics === 'string' && semantics.trim() !== '' ? semantics.slice(0, 64) : '';
        if (key === '')
            return { kind: 'none', steps: [], reason: 'semantics is required' };
        const strategy = lookupStrategy(key);
        if (strategy === null) {
            return { kind: 'none', steps: [], reason: `no compensation strategy for "${key}" — classify first (fail-closed)` };
        }
        if (strategy.kind === 'manual-only') {
            return { kind: 'manual-only', steps: [], reason: strategy.reason };
        }
        return { kind: 'compensate', steps: strategy.steps.map(s => s.label) };
    }
    catch {
        return { kind: 'none', steps: [], reason: 'internal query failure — treating as unclassified (fail-closed)' };
    }
}
/** 外部表条目数上界（无界表 = 无界策略面 —— 与账册/步骤封顶同律） */
const EXTERNAL_TABLE_MAX_ENTRIES = 64;
/** 单策略步骤数上界（补偿路径是「按序尝试」的短清单，不是宏） */
const EXTERNAL_TABLE_MAX_STEPS = 8;
/**
 * W9-2（D-C1 落锤）：装载外部补偿策略表（JSON）—— 补偿路径 + 语义级别一次
 * 原子落两表（escrow 扩展表 + riskGate 分级注册表同步登记通道）。
 *
 * 文件形状（唯一合法形状 —— 保守立法）：
 *   { "version": 1, "strategies": [
 *     { "kind": "compensate", "semantics": "volume-change",
 *       "steps": [{ "method": "hotkey", "label": "restore volume", "keys": ["ctrl","shift","arrowdown"] }],
 *       "verify": { "mode": "screen-hash" } },
 *     { "kind": "manual-only", "semantics": "account-signout", "reason": "..." } ] }
 * · version 缺席视为 1；非 1 ⇒ bad-shape（前向不猜）；
 * · verify.mode 仅收 screen-hash / none —— predicate 模式拒绝（JSON 无从携带
 *   谓词函数，装载一个永远无验证通道的策略是坏表，不是降级）；
 * · steps.method 仅收 CompensationStep 的白名单七值（与 sanitizeStep 同律）；
 * · 级别派生律：compensate ⇒ compensable；manual-only ⇒ irreversible ——
 *   文件**不携带** level 字段（级别是策略 kind 的必然投影，双写才有失配面）。
 *
 * 顺序律：arm 不携带 strategies 参数 ⇒ 外部表存活（arm 只修订显式给出的面，
 * 组合根「先 arm({executorPort,...}) 后 load(path)」与反序皆可）；arm 显式
 * 携带 strategies（含空数组）⇒ 扩展面被整体替换 —— 部署显式修订压过文件
 * 装载，后见者胜（w9deploy D-C1-①b 执法）。绝不抛；成功后
 * builtinCompensationSemantics() 视图与 mintPlan 的内置键行为逐字节不变
 * （外部键走扩展覆盖语义）。
 */
export function loadExternalStrategyTable(filePath) {
    try {
        // ① 原子读（单次全文读 —— 半写档在 parse 面死）
        if (typeof filePath !== 'string' || filePath.trim() === '') {
            return { ok: false, reason: 'unreadable-path', detail: 'file path is required' };
        }
        let text;
        try {
            text = readFileSync(filePath, 'utf8');
        }
        catch (e) {
            return { ok: false, reason: 'unreadable-path', detail: e instanceof Error ? e.message : String(e) };
        }
        // ② 解析 + 根形状
        let root;
        try {
            root = JSON.parse(text);
        }
        catch (e) {
            return { ok: false, reason: 'malformed-json', detail: e instanceof Error ? e.message : String(e) };
        }
        if (!root || typeof root !== 'object' || Array.isArray(root)) {
            return { ok: false, reason: 'bad-shape', detail: 'root must be an object with a "strategies" array' };
        }
        const r = root;
        if (r.version !== undefined && r.version !== 1) {
            return { ok: false, reason: 'bad-shape', detail: `unsupported table version ${String(r.version)} (expected 1)` };
        }
        if (!Array.isArray(r.strategies)) {
            return { ok: false, reason: 'bad-shape', detail: '"strategies" array is required' };
        }
        if (r.strategies.length === 0) {
            return { ok: false, reason: 'bad-shape', detail: 'empty strategy table carries no knowledge — refusing (a mistake should surface, not load as a no-op)' };
        }
        if (r.strategies.length > EXTERNAL_TABLE_MAX_ENTRIES) {
            return { ok: false, reason: 'bad-shape', detail: `table exceeds ${EXTERNAL_TABLE_MAX_ENTRIES} entries` };
        }
        // ③ 逐条防御校验（一条坏 ⇒ 整表拒 —— 绝不静默过滤后收下残表）
        const ALLOWED_METHODS = ['hotkey', 'menu', 'recycle-bin-restore', 'clipboard-restore', 'navigate', 'shaper-undo', 'custom'];
        const parsed = [];
        const seen = new Set();
        for (let i = 0; i < r.strategies.length; i++) {
            const entry = r.strategies[i];
            const where = `strategies[${i}]`;
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                return { ok: false, reason: 'bad-entry', detail: `${where}: not an object` };
            }
            const s = entry;
            const semantics = strOrUndef(s.semantics, 64);
            if (semantics === undefined)
                return { ok: false, reason: 'bad-entry', detail: `${where}: semantics is required (non-empty string)` };
            if (seen.has(semantics)) {
                return { ok: false, reason: 'bad-entry', detail: `${where}: duplicate semantics "${semantics}"` };
            }
            if (s.kind === 'manual-only') {
                const reason = strOrUndef(s.reason, 800);
                if (reason === undefined)
                    return { ok: false, reason: 'bad-entry', detail: `${where} (${semantics}): manual-only requires a human-readable "reason"` };
                seen.add(semantics);
                parsed.push({ strategy: { kind: 'manual-only', semantics, reason }, level: 'irreversible' });
                continue;
            }
            if (s.kind !== 'compensate') {
                return { ok: false, reason: 'bad-entry', detail: `${where} (${semantics}): kind must be "compensate" or "manual-only"` };
            }
            if (!Array.isArray(s.steps) || s.steps.length === 0 || s.steps.length > EXTERNAL_TABLE_MAX_STEPS) {
                return { ok: false, reason: 'bad-entry', detail: `${where} (${semantics}): compensate requires 1..${EXTERNAL_TABLE_MAX_STEPS} steps` };
            }
            const steps = [];
            for (let j = 0; j < s.steps.length; j++) {
                const raw = s.steps[j];
                const w = `${where}.steps[${j}]`;
                if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                    return { ok: false, reason: 'bad-entry', detail: `${w}: not an object` };
                }
                const st = raw;
                if (typeof st.method !== 'string' || !ALLOWED_METHODS.includes(st.method)) {
                    return { ok: false, reason: 'bad-entry', detail: `${w}: method must be one of ${ALLOWED_METHODS.join('/')}` };
                }
                const label = strOrUndef(st.label, 200);
                if (label === undefined)
                    return { ok: false, reason: 'bad-entry', detail: `${w}: label is required (non-empty string)` };
                const step = { method: st.method, label };
                if (st.keys !== undefined) {
                    if (!Array.isArray(st.keys) || st.keys.length === 0 || st.keys.length > 8
                        || st.keys.some((k) => typeof k !== 'string' || k.trim() === '')) {
                        return { ok: false, reason: 'bad-entry', detail: `${w}: keys must be 1..8 non-empty strings` };
                    }
                    step.keys = st.keys.map(k => k.slice(0, 32));
                }
                const target = strOrUndef(st.target, 200);
                if (target !== undefined)
                    step.target = target;
                steps.push(step);
            }
            if (!s.verify || typeof s.verify !== 'object' || Array.isArray(s.verify)) {
                return { ok: false, reason: 'bad-entry', detail: `${where} (${semantics}): verify is required ({mode:"screen-hash"|"none"})` };
            }
            const v = s.verify;
            if (v.mode !== 'screen-hash' && v.mode !== 'none') {
                return { ok: false, reason: 'bad-entry', detail: `${where} (${semantics}): verify.mode must be "screen-hash" or "none" — "predicate" is refused (a JSON table cannot carry the predicate function; a strategy that can never verify is a bad table, not a degradation)` };
            }
            const verify = v.mode === 'screen-hash'
                ? { mode: 'screen-hash', ...(typeof v.threshold === 'number' && Number.isFinite(v.threshold) && v.threshold > 0 && v.threshold <= 1 ? { threshold: v.threshold } : {}) }
                : { mode: 'none' };
            const notes = strOrUndef(s.notes, 400);
            seen.add(semantics);
            parsed.push({
                strategy: { kind: 'compensate', semantics, steps, verify, ...(notes !== undefined ? { notes } : {}) },
                level: 'compensable',
            });
        }
        // ④ 对齐律前置校验：不改判已判定的键（内置立法优先；已装载扩展同样不翻案）
        for (const { strategy, level } of parsed) {
            const existing = reversibilityRegistry.levelOf(strategy.semantics);
            if (existing !== null && existing.level !== level) {
                return {
                    ok: false, reason: 'builtin-conflict',
                    detail: `semantics "${strategy.semantics}" is already registered as ${existing.level} (${existing.source}) but the table declares ${strategy.kind} (${level}) — external tables ADD knowledge, they do not overrule existing legislation (fail-closed)`,
                };
            }
        }
        // ⑤ riskGate 侧同步登记（全有或全无的批量通道 —— W9-2 增量登记面）
        const reg = reversibilityRegistry.registerLevels(parsed.map(({ strategy, level }) => ({ semantics: strategy.semantics, level })));
        if (!reg.ok) {
            return { ok: false, reason: 'registration-failed', detail: reg.error ?? 'level registration rejected' };
        }
        // ⑥ 装载后复验（防御臂）：登记读回必须与派生级别一致。此臂正常流不可达
        //（registerLevels 恰好写入了 ⑤ 传入的值）；若仍失配 ⇒ 拒表。方向论证：
        // 此时级别已登记而策略未入表 —— 残留态是 fail-closed 安全向（compensable
        // 已登记但无补偿策略 ⇒ mintPlan 照样 no-strategy 拒绝；irreversible 更严），
        // 不存在「策略在表而分级不知道」的放行向残留。
        for (const { strategy, level } of parsed) {
            const after = reversibilityRegistry.levelOf(strategy.semantics);
            if (after === null || after.level !== level) {
                return {
                    ok: false, reason: 'alignment-violation',
                    detail: `post-registration verification failed for "${strategy.semantics}" (expected ${level}, read ${after?.level ?? 'null'}) — strategies NOT applied; the residual registered level is fail-closed safe (no strategy ⇒ mintPlan refuses)`,
                };
            }
        }
        // ⑦ 全部通过 ⇒ 策略入扩展表（arm({strategies}) 同一落点 —— 扩展覆盖内置，
        // 与既有扩展语义一致；reset() 随隔离缝一并归零）
        for (const { strategy } of parsed)
            extensionStrategies.set(strategy.semantics, strategy);
        return { ok: true, applied: parsed.length, semantics: parsed.map(p => p.strategy.semantics) };
    }
    catch (e) {
        return { ok: false, reason: 'registration-failed', detail: `internal loader failure — table refused (${e instanceof Error ? e.message : String(e)})` };
    }
}
