// src/vlm/autoAdopt.ts
// 纪元 Λ（Λ-1 开箱即亮）：本地自动接管 —— 零配置点亮一颗本地视觉脑。
//
// 为什么存在：用户刚装好插件、一个 key 都没配时，向导冷启动是一片黑。但本机
// 可能正跑着 Ollama / LM Studio / vLLM（127.0.0.1 免密直连）。本模块按固定
// 顺序轻叩三家的 /models 门（GET，无鉴权头，1.5s 止损），谁能交出非空模型表，
// 就从中挑一颗视觉倾向的模型（vl / vision / llava / minicpm / moondream /
// gemma-vision / qwen-vl 命名家族），铸成 AdoptedLocal 交给 connection.ts 落档
//（via:'auto-adopt'）—— 开箱即亮，配了云 key 后随时可换。
//
// 设计要点：
//   - 顺序探测不并行 —— 本地串行足够快（三端口全超时也只 ~4.5s）且日志有序
//     （用户能看到「试 Ollama → 试 LM Studio → …」的接管轨迹）
//   - 数据单一来源 —— 本地三家候选投影自 providers/registry 的 PLATFORM_PRESETS
//     （换基址只改 registry 一处，与 probe.ts 同律）
//   - 绝不抛异常 —— 任何故障（fetch 抛错 / 非 2xx / 坏 JSON / 空表）都归约为
//     「下一个候选」，全败 ⇒ null
//   - ΠΑΝ-20（蹲守者进程归属校验）：此前 11434/1234/8000 三端口的自动收养
//     信任任何占用者 —— 恶意进程蹲守 11434 即可成为被收养的「本地脑」，此后
//     全部截图与提示词流向攻击者。修法：候选命中后（fetch 2xx 且模型表非空）
//     尽力解析监听该端口的进程归属（win32：netstat -ano + PowerShell CIM
//     GetOwner；POSIX：lsof -sTCP:LISTEN + ps uid）；**确认归属他用户** ⇒
//     跳过该候选（诚实让位下一家）；同用户 / 机器服务账户 / 无法取证
//     （工具缺席/超时/无监听记录）⇒ 照常收养 —— 「能取到的范围内」执法：跨用户
//     蹲守被消灭，取证不可得不误伤开箱即亮（诚实边界见 resolveListenerOwnership）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetchWithRetry } from './providers/types.js';
import { PLATFORM_PRESETS } from './providers/registry.js';
import { currentWindowsUser } from '../filePerms.js';
/** 本地三家的探测顺序 —— Ollama（最普及）→ LM Studio → vLLM；
 * platform/baseUrl 投影自 registry.PLATFORM_PRESETS（单一数据源，删桩不重复） */
export const LOCAL_CANDIDATES = ['ollama', 'lmstudio', 'vllm']
    .map(id => PLATFORM_PRESETS.find(p => p.id === id))
    .filter((p) => p !== undefined)
    .map(p => ({ platform: p.id, baseUrl: p.baseUrl }));
/** 单候选探测超时缺省 —— 本地回环要么秒应要么没人听，1.5s 足够止损 */
const DEFAULT_ADOPT_TIMEOUT_MS = 1500;
/** 视觉倾向命名家族 —— 命中即优先接管（大小写不敏感） */
const VISION_MODEL_RE = /(vl|vision|llava|minicpm|moondream|gemma.*vision|qwen.*vl)/i;
/** execFile 的 Promise 形（超时/ENOENT 一切故障由调用面收敛，绝不抛出上层） */
const execFileP = promisify(execFile);
/** 单次取证子进程超时 —— 工具挂死不得拖垮开箱即亮 */
const OWNERSHIP_PROBE_TIMEOUT_MS = 3000;
/**
 * 机器服务账户白名单（小写比对）—— SYSTEM 家族监听 11434 是合法的
 * 服务化部署（如以服务跑的 Ollama），且机器账户不是「同机他用户蹲守者」
 * （威胁模型是共享机器上的低权/他用户进程钓鱼收养）。
 */
const MACHINE_SERVICE_ACCOUNTS = new Set([
    'system', 'local system', 'network service', 'local service',
]);
/**
 * 纯函数（测试面导出）：从 `netstat -ano -p tcp` 输出解析** LISTENING 态**且
 * 本地地址端口命中的 PID 集。本地地址须为回环或通配（127.0.0.1/[::1]/
 * 0.0.0.0/[::] —— 通配监听同样接受回环连接）；ESTABLISHED 等连接态行不取。
 * 例：`TCP  127.0.0.1:11434  0.0.0.0:0  LISTENING  1234` ⇒ [1234]。
 */
export function parseNetstatListeningPids(output, port) {
    const pids = [];
    try {
        if (typeof output !== 'string' || !Number.isInteger(port) || port <= 0 || port > 65535)
            return [];
        for (const rawLine of output.split(/\r?\n/)) {
            const cols = rawLine.trim().split(/\s+/);
            if (cols.length < 5 || cols[0].toUpperCase() !== 'TCP')
                continue;
            if (cols[3].toUpperCase() !== 'LISTENING')
                continue;
            const local = cols[1];
            const eq = local.lastIndexOf(':');
            if (eq < 0)
                continue;
            const host = local.slice(0, eq).toLowerCase();
            const portPart = local.slice(eq + 1);
            if (portPart !== String(port))
                continue; // 精确端口匹配（防 111434 ⊃ 11434）
            if (host !== '127.0.0.1' && host !== '[::1]' && host !== '0.0.0.0' && host !== '[::]' && host !== '::')
                continue;
            const pid = Number(cols[cols.length - 1]);
            if (Number.isInteger(pid) && pid > 0)
                pids.push(pid);
        }
    }
    catch { /* 脏输出 ⇒ 空集（unknown 路径） */ }
    return [...new Set(pids)];
}
/** baseUrl → { host, port }（URL 面；端口缺席按协议缺省 80/443） */
function hostPortOf(baseUrl) {
    try {
        const u = new URL(String(baseUrl));
        const port = u.port !== '' ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
        if (!Number.isInteger(port) || port <= 0)
            return null;
        return { host: u.hostname.toLowerCase(), port };
    }
    catch {
        return null;
    }
}
/** win32：单 PID 的进程属主（PowerShell CIM GetOwner；失败 ⇒ null） */
async function windowsProcessOwner(pid) {
    try {
        const { stdout } = await execFileP('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Invoke-CimMethod -Name GetOwner).User`], { timeout: OWNERSHIP_PROBE_TIMEOUT_MS, windowsHide: true });
        const owner = String(stdout ?? '').trim();
        return owner !== '' ? owner.toLowerCase() : null;
    }
    catch {
        return null;
    }
}
/** POSIX：单 PID 的属主 uid（ps；失败 ⇒ null） */
async function posixProcessUid(pid) {
    try {
        const { stdout } = await execFileP('ps', ['-o', 'uid=', '-p', String(pid)], {
            timeout: OWNERSHIP_PROBE_TIMEOUT_MS,
        });
        const uid = Number(String(stdout ?? '').trim());
        return Number.isInteger(uid) && uid >= 0 ? uid : null;
    }
    catch {
        return null;
    }
}
/**
 * ΠΑΝ-20：尽力解析「谁在监听这个回环端口」（永不抛）：
 *  - win32：netstat -ano 找 LISTENING PID → PowerShell CIM GetOwner 取属主名，
 *    与 currentWindowsUser 比对（filePerms 同源账户面）；
 *  - POSIX：lsof -tPniTCP:<port> -sTCP:LISTEN 找 PID → ps -o uid= 取属主，
 *    与 process.getuid() 比对；
 *  - 判定：任一 PID 确认属**他用户**（且非机器服务账户）⇒ 'other-user'；
 *    全部可解析且皆本用户 ⇒ 'same-user'；无 PID / 工具缺席 / 全不可解析 ⇒
 *    'unknown'（诚实降级 —— 不因取证不可得误伤收养；执法只砍确认异主者）。
 */
export async function resolveListenerOwnership(baseUrl) {
    try {
        const hp = hostPortOf(baseUrl);
        if (hp === null)
            return 'unknown';
        let pids = [];
        if (process.platform === 'win32') {
            try {
                const { stdout } = await execFileP('netstat', ['-ano', '-p', 'tcp'], {
                    timeout: OWNERSHIP_PROBE_TIMEOUT_MS,
                    windowsHide: true,
                });
                pids = parseNetstatListeningPids(String(stdout ?? ''), hp.port);
            }
            catch {
                return 'unknown';
            }
            if (pids.length === 0)
                return 'unknown';
            const self = (currentWindowsUser() ?? '').toLowerCase();
            if (self === '')
                return 'unknown';
            let resolved = 0;
            for (const pid of pids) {
                const owner = await windowsProcessOwner(pid);
                if (owner === null)
                    continue;
                resolved++;
                if (owner !== self && !MACHINE_SERVICE_ACCOUNTS.has(owner))
                    return 'other-user';
            }
            return resolved > 0 ? 'same-user' : 'unknown';
        }
        // POSIX 主路径
        try {
            const { stdout } = await execFileP('lsof', ['-tPniTCP:' + hp.port, '-sTCP:LISTEN'], {
                timeout: OWNERSHIP_PROBE_TIMEOUT_MS,
            });
            pids = String(stdout ?? '').split(/\s+/).map(Number).filter(n => Number.isInteger(n) && n > 0);
        }
        catch {
            return 'unknown';
        }
        if (pids.length === 0)
            return 'unknown';
        const selfUid = typeof process.getuid === 'function' ? process.getuid() : null;
        if (selfUid === null)
            return 'unknown';
        let resolved = 0;
        for (const pid of pids) {
            const uid = await posixProcessUid(pid);
            if (uid === null)
                continue;
            resolved++;
            if (uid !== selfUid)
                return 'other-user';
        }
        return resolved > 0 ? 'same-user' : 'unknown';
    }
    catch {
        return 'unknown'; // 不抛铁律 —— 取证面一切故障按无法取证处理
    }
}
// ─── pickVisionModel：纯函数挑模 ───
/**
 * 从模型表挑一颗视觉脑 —— 纯函数（零 I/O / 零副作用），永不抛：
 *   - 空表 / 全垃圾（非字符串、纯空白条目）⇒ null
 *   - 命中视觉倾向命名（VISION_MODEL_RE）⇒ 按表序取首个命中
 *   - 无命中 ⇒ 排序后取首个（确定性 —— 服务端顺序不稳时结果仍可复现）
 */
export function pickVisionModel(models) {
    try {
        if (!Array.isArray(models))
            return null;
        const clean = [];
        for (const m of models) {
            if (typeof m !== 'string')
                continue; // 垃圾条目跳过
            const id = m.trim();
            if (id === '')
                continue;
            clean.push(id);
        }
        if (clean.length === 0)
            return null;
        for (const id of clean) {
            if (VISION_MODEL_RE.test(id))
                return id; // 视觉倾向：表序首个命中
        }
        return [...clean].sort()[0] ?? null; // 兜底：排序后首个（确定性）
    }
    catch {
        return null;
    }
}
// ─── 响应解析 ───
/** 列表 URL：尾斜杠归一后拼 /models（'http://127.0.0.1:11434/v1' → '…/v1/models'） */
function modelsUrl(baseUrl) {
    const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
    return `${base}/models`;
}
/**
 * 解析 openai 方言模型表：`data[].id` 收敛为字符串数组（非字符串 / 空白 id 的
 * 脏条目静默跳过 —— probe.extractModels 同律）。容器字段非数组 ⇒ null（诚实
 * 失败，视为该候选不可用）；空数组如实返回（由调用方判空表）。
 */
function extractModelIds(body) {
    const data = body?.data;
    if (!Array.isArray(data))
        return null;
    const ids = [];
    for (const m of data) {
        const id = m?.id;
        if (typeof id !== 'string' || id.trim() === '')
            continue;
        ids.push(id.trim());
    }
    return ids;
}
/** 单候选一次探测 —— 任何故障归约 null（下一候选的信号），绝不抛 */
async function tryAdoptOne(cand, doFetch, timeoutMs, ownershipProbe) {
    const startedAt = Date.now();
    try {
        // 无鉴权头：本地三家免密直连（空头徒扰 Ollama 们）；GET 一次、不重试
        const fr = await fetchWithRetry({
            doFetch,
            url: modelsUrl(cand.baseUrl),
            init: { method: 'GET', headers: { Accept: 'application/json' } },
            maxRetries: 0,
            timeoutMs,
        });
        if (!fr.ok)
            return null; // 非 2xx / 超时 / 传输失败 ⇒ 下一候选
        let body;
        try {
            body = JSON.parse(fr.body ?? '');
        }
        catch {
            return null; // 坏 JSON ⇒ 下一候选
        }
        const models = extractModelIds(body);
        if (models === null || models.length === 0)
            return null; // 缺容器 / 空表 ⇒ 下一候选
        const model = pickVisionModel(models);
        if (model === null)
            return null; // 全垃圾表（理论不可达 —— 已滤空）
        // ΠΑΝ-20（蹲守者归属校验）：候选命中后才取证（无人监听的常态路径零开销）。
        // 确认他用户监听 ⇒ 拒绝收养（静默让位下一候选）；同用户/机器账户/无法
        // 取证 ⇒ 照常（「能取到的范围内」—— 不因工具缺席误伤开箱即亮）。探测面
        // 一切故障按 unknown 处理，绝不抛。
        if (ownershipProbe !== undefined) {
            let ownership = 'unknown';
            try {
                ownership = await ownershipProbe(cand.baseUrl);
            }
            catch {
                ownership = 'unknown';
            }
            if (ownership === 'other-user')
                return null; // 异主蹲守 —— 不接管
        }
        return {
            platform: cand.platform,
            baseUrl: cand.baseUrl,
            model,
            models,
            latencyMs: Date.now() - startedAt,
        };
    }
    catch {
        return null; // 不抛铁律兜底（fetchWithRetry 自身不抛 —— 理论不可达）
    }
}
/**
 * 本地视觉脑自动接管 —— 按候选顺序探测（串行，不并行），永不抛异常：
 *   - 每候选 GET `{base}/models`（无鉴权头；超时缺省 1500ms）
 *   - 2xx 且解析出 `data[].id` 非空列表 ⇒ pickVisionModel 挑模 ⇒ 返回首个
 *     命中候选的 AdoptedLocal（platform/baseUrl/models/latencyMs 全套）
 *   - ΠΑΝ-20：命中候选过端口监听者归属闸 —— 确认他用户蹲守 ⇒ 让位下一候选
 *     （注入 ownershipProbe 可替换取证面；缺省 resolveListenerOwnership 尽力
 *     取证，无法取证的环境照常收养 —— 诚实降级不误伤）
 *   - 任何异常 / 非 2xx / 坏 JSON / 空表 ⇒ 静默转下一候选
 *   - 全败 / fetch 不可用 ⇒ null（向导冷启动照旧 —— 自动接管只加分不添堵）
 *
 * @param opts.fetchImpl       fetch 注入 —— 测试全离线；缺省用全局 fetch
 * @param opts.timeoutMs       单候选探测超时（缺省 1500）
 * @param opts.candidates      候选覆盖（缺省 LOCAL_CANDIDATES：ollama → lmstudio → vllm）
 * @param opts.ownershipProbe  ΠΑΝ-20 归属取证面注入（缺省尽力取证；测试注入假件）
 */
export async function adoptLocalVision(opts) {
    try {
        const injected = typeof opts?.fetchImpl === 'function' ? opts.fetchImpl : undefined;
        const doFetch = injected ?? (typeof fetch === 'function' ? fetch : undefined);
        if (typeof doFetch !== 'function')
            return null; // 运行时无 fetch（Node < 18）⇒ 诚实弃权
        const rawTimeout = Number(opts?.timeoutMs);
        const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
            ? rawTimeout
            : DEFAULT_ADOPT_TIMEOUT_MS;
        const candidates = opts?.candidates ?? LOCAL_CANDIDATES;
        if (!Array.isArray(candidates))
            return null;
        // ΠΑΝ-20：取证面 —— 注入优先（测试假件）；缺省尽力取证
        const ownershipProbe = typeof opts?.ownershipProbe === 'function'
            ? opts.ownershipProbe
            : resolveListenerOwnership;
        for (const cand of candidates) {
            const adopted = await tryAdoptOne(cand, doFetch, timeoutMs, ownershipProbe);
            if (adopted !== null)
                return adopted; // 首个命中即接管
        }
        return null;
    }
    catch {
        return null; // 不抛铁律的最终兜底
    }
}
