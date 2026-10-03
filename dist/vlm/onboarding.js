// src/vlm/onboarding.ts
// 纪元 Λ（Λ-2 开箱即亮）：连接向导 HTTP 服务器与页面 —— 无视觉模型时弹出的
// 本机连接向导。宿主检测到「一颗脑都没接上」时 startOnboarding() 起一个只绑
// 回环的小 HTTP 服务，自动拉起浏览器（或宿主内嵌 webview）打开向导页；用户在
// 页面上选平台 / 填密钥 / 测试 / 保存，落档走 ConnectionStore（Λ-1），热应用走
// onConnect 回调（宿主注入）。
//
// 实现铁律（与兄弟模块同调）：
//   1. 环回铁律 —— 只绑 127.0.0.1（host 入参仅接受回环名，非回环一律强制
//      127.0.0.1），绝不绑 0.0.0.0 —— 向导只对本机可见，互联网上不存在这扇门
//   2. 密钥卫生 —— 密钥从不回显：一切响应面（/api/state、/api/connect、页面）
//      只出现 maskKey() 打码形态，明文 key 只进存档文件与上游请求头
//   3. 请求体限 32KB（超出 ⇒ 413）；非法 JSON ⇒ 400；未知路由 ⇒ 404；
//      方法不符 ⇒ 405；OPTIONS 预检 ⇒ 204 兜底（同源页面本无 CORS 面，留作
//      宿主内嵌环境的兼容缓冲）
//   4. 不抛铁律（启动口除外）—— startOnboarding 的 Promise 只在端口段
//      （默认 18432..18440）全部被占时 reject Error('port-range-exhausted')
//      （这是唯一允许 reject 的口，调用方 catch）；一旦启动成功，后续一切
//      故障（坏请求/上游失败/回调抛错）都以 HTTP 状态码 + {ok:false} 表达，
//      close() 恒可兑现且幂等
//   5. 零外链 —— renderOnboardingHtml 是纯内嵌单文件页面（无 CDN、无外链资源），
//      离线可用；vanilla JS + fetch，同源直连本服务的 JSON API
import { createServer } from 'node:http';
import { createAnthropicProvider } from './providers/anthropic.js';
import { createGeminiProvider } from './providers/gemini.js';
import { createOpenAiProvider } from './providers/openai.js';
import { discoverModels, probeProvider } from './providers/probe.js';
import { getPreset, listPlatforms } from './providers/registry.js';
import { ConnectionStore, maskKey } from './connection.js';
// ─── 常量与小工具 ───
/** 缺省端口（被占则 +1 逐试至 +8，即 18432..18440） */
const DEFAULT_PORT = 18432;
/** 端口回退上限（含缺省口共 9 个候选） */
const MAX_PORT_OFFSET = 8;
/** 缺省空闲超时：30 分钟无请求自动关停 */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** 请求体上限（超出 ⇒ 413） */
const MAX_BODY_BYTES = 32 * 1024;
/** 环回主机白名单（host 入参仅此三者，其余强制 127.0.0.1 —— 环回铁律） */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
/** 安全 trim 字符串字段：非字符串/脏值 ⇒ '' */
function strField(v) {
    try {
        return typeof v === 'string' ? v.trim() : '';
    }
    catch {
        return '';
    }
}
/** 按声明序取首个非空 env 值（全空 ⇒ ''；读取面故障视为未设置） */
function firstEnv(keys) {
    for (const k of keys) {
        try {
            const v = process.env[k];
            if (typeof v === 'string' && v.trim() !== '')
                return v.trim();
        }
        catch { /* 环境面故障视为未设置 */ }
    }
    return '';
}
/** HTML 文本转义（& < > " ' —— 页面服务端渲染的唯一出口） */
function escHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
/** 发 JSON 响应（一切 API 出入口的统一形态；no-store 防宿主内嵌缓存） */
function sendJson(res, status, payload) {
    let body = '';
    try {
        body = JSON.stringify(payload);
    }
    catch {
        status = 500;
        body = JSON.stringify({ ok: false, error: '内部序列化错误' });
    }
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(body);
}
/**
 * 读请求体并解析 JSON —— 安全律的执行面：
 *  - Content-Length 预告超限（> 32KB）⇒ 413 立即短路
 *  - 流式累计超限 ⇒ 413（继续排干剩余分片但不缓冲 —— 客户端能完整送完并收到响应）
 *  - 空 ⇒ 400；JSON.parse 失败 ⇒ 400；非对象（数组/原始值）⇒ 400
 *  - 永不 reject —— 一切失败以 { ok:false, status, error } 表达
 */
function readJsonBody(req) {
    return new Promise(resolve => {
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
            resolve({ ok: false, status: 413, error: `请求体超过 ${MAX_BODY_BYTES} 字节上限` });
            req.resume(); // 排干，保住响应通道
            return;
        }
        const chunks = [];
        let size = 0;
        let settled = false;
        const finish = (r) => {
            if (settled)
                return;
            settled = true;
            resolve(r);
        };
        req.on('data', (c) => {
            if (settled)
                return;
            size += c.length;
            if (size > MAX_BODY_BYTES) {
                finish({ ok: false, status: 413, error: `请求体超过 ${MAX_BODY_BYTES} 字节上限` });
                chunks.length = 0; // 停止缓冲；继续排干（不销毁连接 —— 客户端需读走 413）
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            if (settled)
                return;
            const raw = Buffer.concat(chunks).toString('utf8');
            if (raw.trim() === '') {
                finish({ ok: false, status: 400, error: '请求体为空，期望 JSON 对象' });
                return;
            }
            try {
                const v = JSON.parse(raw);
                if (typeof v !== 'object' || v === null || Array.isArray(v)) {
                    finish({ ok: false, status: 400, error: '请求体须为 JSON 对象' });
                    return;
                }
                finish({ ok: true, value: v });
            }
            catch {
                finish({ ok: false, status: 400, error: '请求体不是合法 JSON' });
            }
        });
        req.on('error', () => {
            finish({ ok: false, status: 400, error: '请求体读取失败' });
        });
    });
}
/** 按预设协议铸 provider —— 云脑三家工厂的分发面（与 probe.castPlatformProvider 同律） */
function castProvider(args) {
    const { preset, apiKey, baseUrl, model, fetchImpl } = args;
    const cfg = {
        id: preset.id,
        idPreset: preset.id,
        apiKey,
        baseUrl,
        ...(model !== '' ? { model } : {}),
        defaultBaseUrl: preset.baseUrl,
        defaultModel: preset.defaultModel,
        ...(fetchImpl ? { fetchImpl } : {}),
    };
    if (preset.protocol === 'anthropic')
        return createAnthropicProvider(cfg);
    if (preset.protocol === 'gemini')
        return createGeminiProvider(cfg);
    return createOpenAiProvider(cfg);
}
// ─── 路由表（404/405 的裁决依据） ───
/** 路径 → 允许的方法集（OPTIONS 全局 204 兜底，不入表） */
const ROUTES = {
    '/': new Set(['GET']),
    '/api/state': new Set(['GET']),
    '/api/test': new Set(['POST']),
    '/api/models': new Set(['GET']),
    '/api/connect': new Set(['POST']),
    '/api/disconnect': new Set(['POST']),
};
// ─── startOnboarding ───
/**
 * 启动连接向导服务（无视觉模型时的「开箱即亮」入口）。
 *
 * 安全律（JSDoc 契约）：
 *  - 只绑回环 —— host 仅接受 '127.0.0.1'/'localhost'/'::1'，非回环入参一律
 *    强制 127.0.0.1，绝不绑 0.0.0.0（向导只对本机可见）
 *  - 密钥从不回显 —— 一切响应面只出现 maskKey() 打码形态
 *  - 请求体限 32KB（413）；非法 JSON（400）；未知路由（404）；方法不符（405）
 *
 * @param opts.port       缺省 18432；被占则 +1 逐试至 +8（EADDRINUSE 捕获）；
 *                        传 0 = 内核随机分配（单次尝试）。九口全占 ⇒ Promise
 *                        reject Error('port-range-exhausted') —— 这是本函数
 *                        唯一允许 reject 的口（调用方 catch）
 * @param opts.host       缺省 '127.0.0.1'（环回铁律，见安全律）
 * @param opts.deps       依赖注入口（fetch/store/onConnect/now；全缺省走内置）
 * @param opts.idleTimeoutMs 空闲自动关停：无请求持续该时长即 close（缺省
 *                        30 分钟；0 = 禁用）。任何请求（含 404/405）都重置计时
 * @returns OnboardingHandle —— port/url/created 句柄；close() 幂等
 */
export async function startOnboarding(opts) {
    const deps = opts?.deps ?? {};
    const store = deps.store ?? new ConnectionStore();
    const onConnect = deps.onConnect;
    const now = deps.now ?? Date.now;
    const idleTimeoutMs = opts?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const rawHost = strFieldOr(opts?.host, '127.0.0.1');
    const host = LOOPBACK_HOSTS.has(rawHost) ? rawHost : '127.0.0.1'; // 环回铁律
    const basePort = Number.isFinite(Number(opts?.port)) ? Number(opts?.port) : DEFAULT_PORT;
    // ─── 状态面（闭包持有；handle 的数据源） ───
    let closedFlag = false;
    let idleTimer = null;
    let closePromise = null;
    /** 组装向导状态（每次请求即时组装 —— connect/disconnect 后刷新即见） */
    const buildState = () => {
        let conn = null;
        try {
            conn = store.load();
        }
        catch {
            conn = null; // 存档面故障按未连接展示（不抛铁律）
        }
        return {
            current: conn?.platform ?? '',
            connectedVia: conn?.via ?? null,
            maskedKey: conn?.apiKey ? maskKey(conn.apiKey) : null,
            platforms: listPlatforms().map(p => ({
                id: p.id,
                label: p.label,
                protocol: p.protocol,
                local: p.localAuthOptional === true,
                configured: p.configured,
            })),
        };
    };
    // ─── 关停面（手动 close 与 idle 超时共用；幂等） ───
    const clearIdle = () => {
        if (idleTimer !== null) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }
    };
    const shutdown = () => {
        if (closedFlag)
            return closePromise ?? Promise.resolve();
        closedFlag = true;
        clearIdle();
        closePromise = new Promise(resolve => {
            let settled = false;
            const done = () => {
                if (settled)
                    return;
                settled = true;
                resolve();
            };
            try {
                server.closeAllConnections?.(); // 排掉 keep-alive 悬挂连接，close 即归
            }
            catch { /* 旧运行时无此 API —— 交由 close 回调与兜底钟 */ }
            try {
                server.close(() => done());
            }
            catch {
                done();
            }
            const guard = setTimeout(done, 2000); // 兜底钟：悬挂连接异常时也放行
            guard.unref?.();
        });
        return closePromise;
    };
    const refreshIdle = () => {
        clearIdle();
        if (idleTimeoutMs > 0) {
            idleTimer = setTimeout(() => {
                void shutdown(); // 空闲到期：无人值守的向导自动熄灯
            }, idleTimeoutMs);
            idleTimer.unref?.(); // 不阻进程退出
        }
    };
    // ─── 请求处理面 ───
    const handle = async (req, res) => {
        const u = new URL(req.url ?? '/', 'http://127.0.0.1');
        const path = u.pathname;
        const method = (req.method ?? 'GET').toUpperCase();
        // OPTIONS 预检 204 兜底（同源页面本无需 CORS —— 留作宿主内嵌环境缓冲）
        if (method === 'OPTIONS') {
            res.writeHead(204, { allow: 'GET, POST, OPTIONS' });
            res.end();
            return;
        }
        const allowed = ROUTES[path];
        if (!allowed) {
            sendJson(res, 404, { ok: false, error: `未知路由：${path}` });
            return;
        }
        if (!allowed.has(method)) {
            res.writeHead(405, {
                allow: [...allowed, 'OPTIONS'].join(', '),
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
            });
            res.end(JSON.stringify({ ok: false, error: `方法不允许：${method}` }));
            return;
        }
        // ── GET / —— 向导页（状态即时组装，服务端渲染进页面） ──
        if (path === '/') {
            res.writeHead(200, {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
            });
            res.end(renderOnboardingHtml(buildState()));
            return;
        }
        // ── GET /api/state —— 向导状态（密钥只含打码形态） ──
        if (path === '/api/state') {
            sendJson(res, 200, buildState());
            return;
        }
        // ── POST /api/test —— 用 probeProvider 对所选平台做一次真探 ──
        if (path === '/api/test') {
            const body = await readJsonBody(req);
            if (!body.ok) {
                sendJson(res, body.status, { ok: false, error: body.error });
                return;
            }
            const preset = getPreset(strField(body.value.platform));
            if (!preset) {
                sendJson(res, 400, { ok: false, error: `未知平台：${strField(body.value.platform) || '(空)'}` });
                return;
            }
            const apiKey = strField(body.value.api_key) || firstEnv(preset.envKeys);
            const baseUrl = strField(body.value.base_url) || preset.baseUrl;
            const model = strField(body.value.model) || preset.defaultModel;
            const provider = castProvider({ preset, apiKey, baseUrl, model, fetchImpl: deps.fetchImpl });
            const probe = await probeProvider(provider); // 永不抛
            sendJson(res, 200, { ok: probe.ok, probe });
            return;
        }
        // ── GET /api/models —— 对所选平台做模型发现 ──
        if (path === '/api/models') {
            const preset = getPreset((u.searchParams.get('platform') ?? '').trim());
            if (!preset) {
                sendJson(res, 400, { ok: false, models: [], error: `未知平台：${(u.searchParams.get('platform') ?? '') || '(空)'}` });
                return;
            }
            const apiKey = (u.searchParams.get('api_key') ?? '').trim() || firstEnv(preset.envKeys);
            const baseUrl = (u.searchParams.get('base_url') ?? '').trim() || preset.baseUrl;
            const r = await discoverModels({
                baseUrl,
                ...(apiKey !== '' ? { apiKey } : {}),
                protocol: preset.protocol,
                ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
            }); // 永不抛
            const models = r.models;
            sendJson(res, 200, r.ok ? { ok: true, models } : { ok: false, models: [], error: r.error });
            return;
        }
        // ── POST /api/connect —— 校验 ⇒ 存档 ⇒ 热应用回调 ⇒ 打码回执 ──
        if (path === '/api/connect') {
            const body = await readJsonBody(req);
            if (!body.ok) {
                sendJson(res, body.status, { ok: false, error: body.error });
                return;
            }
            const preset = getPreset(strField(body.value.platform));
            if (!preset) {
                sendJson(res, 400, { ok: false, error: `未知平台：${strField(body.value.platform) || '(空)'}` });
                return;
            }
            const apiKey = strField(body.value.api_key);
            const baseUrl = strField(body.value.base_url);
            const model = strField(body.value.model);
            const conn = {
                platform: preset.id,
                ...(apiKey !== '' ? { apiKey } : {}),
                ...(baseUrl !== '' ? { baseUrl } : {}),
                ...(model !== '' ? { model } : {}),
                updatedAt: now(),
                via: 'wizard',
            };
            const saved = store.save(conn);
            if (!saved.ok) {
                // 存档失败：如实相告（未热应用）
                sendJson(res, 200, { ok: false, error: saved.error ?? '存档失败（原因未知）' });
                return;
            }
            try {
                if (onConnect)
                    await onConnect(conn);
            }
            catch {
                // 存档已写、热应用失败 —— 重载插件即生效（JSDoc 契约文案）
                sendJson(res, 200, { ok: false, error: '连接已保存但热应用失败，重载插件后生效' });
                return;
            }
            sendJson(res, 200, {
                ok: true,
                current: preset.id,
                masked_key: conn.apiKey ? maskKey(conn.apiKey) : null, // 密钥只回打码形态
            });
            return;
        }
        // ── POST /api/disconnect —— 清档即断开 ──
        if (path === '/api/disconnect') {
            const r = store.clear();
            sendJson(res, 200, r.ok ? { ok: true } : { ok: false, error: r.error ?? '清档失败（原因未知）' });
            return;
        }
        // 理论不可达（路由表已穷举）—— 兜底 404
        sendJson(res, 404, { ok: false, error: `未知路由：${path}` });
    };
    const server = createServer((req, res) => {
        refreshIdle(); // 任何请求（含 404/405/413）都重置空闲钟
        void handle(req, res).catch(() => {
            // 不抛铁律兜底：处理器内部一切未预期异常收敛为 500 JSON
            try {
                if (!res.headersSent)
                    sendJson(res, 500, { ok: false, error: '内部错误' });
                else
                    res.end();
            }
            catch { /* 响应通道已死 —— 无事可做 */ }
        });
    });
    // ─── 端口段回退监听（EADDRINUSE 捕获；port 0 = 随机单次尝试） ───
    // 注意：监听尝试期只有 attemptListen 的 once 处理器在岗（EADDRINUSE 属预期
    // 噪音）；持久 error 处理器须在绑定成功后挂 —— 否则回退期的占用错误会误触
    // 「熄灯」路径。
    const attemptListen = (port) => new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        server.once('error', onError);
        server.listen(port, host, () => {
            server.off('error', onError);
            resolve();
        });
    });
    const candidates = basePort === 0 ? [0] : Array.from({ length: MAX_PORT_OFFSET + 1 }, (_, i) => basePort + i);
    let bound = false;
    for (const cand of candidates) {
        try {
            await attemptListen(cand);
            bound = true;
            break;
        }
        catch {
            continue; // EADDRINUSE（及其余监听故障）⇒ 试下一口
        }
    }
    if (!bound) {
        // 唯一允许 reject 的口：端口段全占（调用方 catch 后走降级路径）
        throw new Error('port-range-exhausted');
    }
    server.on('error', () => {
        // 监听后意外错误（理论上不可达）：熄灯防僵尸
        closedFlag = true;
        clearIdle();
        try {
            server.close();
        }
        catch { /* 已关 */ }
    });
    const port = server.address().port;
    const urlHost = host.includes(':') ? `[${host}]` : host; // IPv6 字面量加方括号
    refreshIdle(); // 启动即起表（无请求 30 分钟后自动熄灯）
    return {
        port,
        url: `http://${urlHost}:${port}/`,
        get closed() {
            return closedFlag;
        },
        close: () => shutdown(),
    };
}
/** strField 的带缺省变体（host 解析用） */
function strFieldOr(v, fallback) {
    const s = strField(v);
    return s !== '' ? s : fallback;
}
// ─── renderOnboardingHtml：向导页（纯内嵌单文件，无外链 CDN，中文 UI） ───
/**
 * 渲染向导页 HTML —— 纯函数（同状态同输出，无副作用零 I/O）。
 * 纯内嵌单文件：样式、脚本、状态全部内联，无任何外链资源（离线可用）。
 * 密钥卫生：state.maskedKey 进页面前已由调用方 maskKey() 打码 —— 本函数
 * 不接收也不渲染任何明文密钥。
 */
export function renderOnboardingHtml(state) {
    const json = JSON.stringify(state ?? { current: '', connectedVia: null, maskedKey: null, platforms: [] })
        .replace(/</g, '\\u003c'); // 防 </script> 逃逸（嵌入脚本的唯一消毒口）
    const cards = (state?.platforms ?? [])
        .map(p => '<label class="card">' +
        `<input type="radio" name="platform" value="${escHtml(p.id)}" data-local="${p.local ? 'true' : 'false'}">` +
        '<span class="card-head">' +
        `<span class="dot ${p.configured ? 'dot-on' : ''}" title="${p.configured ? '环境已就绪' : '环境未配置'}"></span>` +
        `<span class="name">${escHtml(p.label)}</span>` +
        `<span class="badge">${escHtml(p.protocol)}</span>` +
        (p.local ? '<span class="badge local">本地</span>' : '') +
        '</span></label>')
        .join('\n');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>连接视觉模型</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #14161a; color: #d7dce3;
         font: 15px/1.6 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
  .wrap { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #7d8694; margin: 0 0 20px; font-size: 13px; }
  section { margin-bottom: 22px; }
  h2 { font-size: 15px; color: #aeb7c2; margin: 0 0 10px; }
  .current { padding: 12px 14px; border: 1px solid #2a2f38; border-radius: 10px;
             background: #1a1d23; font-size: 14px; }
  .current.none { color: #8a93a1; }
  .current.live { border-color: #2f6f4f; color: #9fd8b4; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }
  .card { display: block; border: 1px solid #2a2f38; border-radius: 10px; padding: 10px 12px;
          cursor: pointer; background: #1a1d23; transition: border-color .12s; }
  .card:hover { border-color: #3d4553; }
  .card:has(input:checked) { border-color: #4f8cf0; background: #1c2531; }
  .card input { display: none; }
  .card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .name { font-size: 14px; }
  .badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: #262b34;
           color: #9aa5b3; border: 1px solid #333a46; }
  .badge.local { color: #9fd8b4; border-color: #2f6f4f; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #4a5261; flex: none; }
  .dot-on { background: #46c47f; box-shadow: 0 0 6px #46c47f88; }
  label.field { display: block; margin-bottom: 12px; }
  label.field span { display: block; font-size: 13px; color: #aeb7c2; margin-bottom: 4px; }
  input[type=password], input[type=text] { width: 100%; padding: 8px 10px; border-radius: 8px;
        border: 1px solid #2a2f38; background: #10131a; color: #d7dce3; font-size: 14px; }
  input:focus { outline: none; border-color: #4f8cf0; }
  .hint { font-size: 12px; color: #7d8694; margin-top: 4px; }
  details { border: 1px solid #2a2f38; border-radius: 10px; padding: 10px 12px; background: #1a1d23; }
  details summary { cursor: pointer; color: #aeb7c2; font-size: 14px; }
  details .inner { margin-top: 10px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 6px; }
  button { padding: 9px 18px; border-radius: 9px; border: 1px solid #333a46; background: #232833;
           color: #d7dce3; font-size: 14px; cursor: pointer; }
  button:hover { border-color: #4a5468; }
  button.primary { background: #23467e; border-color: #3563b0; }
  button.danger { background: #40232a; border-color: #6e3543; margin-top: 26px; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .result { margin-top: 10px; font-size: 14px; white-space: pre-wrap; }
  .result.ok { color: #9fd8b4; }
  .result.bad { color: #e08b8b; }
  select { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid #2a2f38;
           background: #10131a; color: #d7dce3; font-size: 14px; }
  footer { color: #5b6472; font-size: 12px; margin-top: 30px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>连接视觉模型</h1>
  <p class="sub">本页只在本机回环可见 —— 密钥仅写入本地存档，绝不回显明文。</p>

  <section>
    <h2>当前生效</h2>
    <div id="currentBox" class="current none">尚未连接——选择一个平台开始</div>
  </section>

  <section>
    <h2>选择平台</h2>
    <div class="grid" id="platformGrid">
${cards}
    </div>
  </section>

  <section>
    <h2>密钥</h2>
    <label class="field">
      <span>API Key</span>
      <input type="password" id="apiKey" placeholder="留空则使用环境变量中的密钥" autocomplete="off">
    </label>
    <div class="hint" id="keyHint">填入所选平台的 API Key（留空则用环境变量）</div>
  </section>

  <section>
    <details>
      <summary>高级选项</summary>
      <div class="inner">
        <label class="field">
          <span>Base URL 覆盖</span>
          <input type="text" id="baseUrl" placeholder="留空使用平台缺省基址">
        </label>
        <label class="field">
          <span>模型（可手动填，或获取列表后选择）</span>
          <input type="text" id="modelInput" placeholder="留空使用平台缺省模型">
        </label>
        <label class="field">
          <span>发现的模型列表</span>
          <select id="modelSelect" size="1">
            <option value="">— 获取模型列表后在此选择 —</option>
          </select>
        </label>
      </div>
    </details>
  </section>

  <section>
    <div class="row">
      <button id="btnTest" type="button">测试连接</button>
      <button id="btnModels" type="button">获取模型列表</button>
      <button id="btnConnect" type="button" class="primary">保存并启用</button>
    </div>
    <div id="testResult" class="result"></div>
    <div id="modelsResult" class="result"></div>
    <div id="connectResult" class="result"></div>
  </section>

  <section>
    <button id="btnDisconnect" type="button" class="danger">断开连接</button>
  </section>

  <footer>向导空闲 30 分钟自动关闭 · 断开即清除已存连接</footer>
</div>

<script>
var INITIAL_STATE = ${json};
var STATE = INITIAL_STATE;
function $(id) { return document.getElementById(id); }
function selectedId() {
  var el = document.querySelector('input[name=platform]:checked');
  return el ? el.value : '';
}
function platformInfo(id) {
  for (var i = 0; i < STATE.platforms.length; i++) {
    if (STATE.platforms[i].id === id) return STATE.platforms[i];
  }
  return null;
}
function show(id, text, cls) {
  var el = $(id);
  el.textContent = text;
  el.className = 'result' + (cls ? ' ' + cls : '');
}
function renderCurrent() {
  var box = $('currentBox');
  if (!STATE.current) {
    box.textContent = '尚未连接——选择一个平台开始';
    box.className = 'current none';
    return;
  }
  var info = platformInfo(STATE.current);
  var text = '当前生效：' + (info ? info.label : STATE.current);
  if (STATE.connectedVia) text += '（来源 ' + STATE.connectedVia + '）';
  if (STATE.maskedKey) text += ' · 密钥 ' + STATE.maskedKey;
  box.textContent = text;
  box.className = 'current live';
}
function onPick() {
  var info = platformInfo(selectedId());
  $('keyHint').textContent = info && info.local
    ? '本地服务无需密钥'
    : '填入所选平台的 API Key（留空则用环境变量）';
}
function payload() {
  return {
    platform: selectedId(),
    api_key: $('apiKey').value.trim(),
    base_url: $('baseUrl').value.trim(),
    model: $('modelInput').value.trim() || $('modelSelect').value
  };
}
async function postJson(url, data) {
  var r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data || {})
  });
  var body = {};
  try { body = await r.json(); } catch (e) { body = {}; }
  return { status: r.status, body: body };
}
async function refreshState() {
  try {
    var r = await fetch('/api/state');
    STATE = await r.json();
    renderCurrent();
  } catch (e) { /* 状态面故障保持旧视图 */ }
}
async function testConn() {
  if (!selectedId()) { show('testResult', '请先选择一个平台', 'bad'); return; }
  show('testResult', '测试中…', '');
  var res = await postJson('/api/test', payload());
  if (res.body && res.body.probe) {
    show('testResult', res.body.probe.ok ? '✓ ' + res.body.probe.detail : '✗ ' + res.body.probe.detail,
         res.body.probe.ok ? 'ok' : 'bad');
  } else {
    show('testResult', '✗ ' + ((res.body && res.body.error) || ('HTTP ' + res.status)), 'bad');
  }
}
async function loadModels() {
  if (!selectedId()) { show('modelsResult', '请先选择一个平台', 'bad'); return; }
  show('modelsResult', '获取中…', '');
  var qs = new URLSearchParams({ platform: selectedId() });
  var key = $('apiKey').value.trim();
  var base = $('baseUrl').value.trim();
  if (key) qs.set('api_key', key);
  if (base) qs.set('base_url', base);
  try {
    var r = await fetch('/api/models?' + qs.toString());
    var j = await r.json();
    if (j.ok) {
      var sel = $('modelSelect');
      sel.innerHTML = '';
      if (!j.models || j.models.length === 0) {
        sel.add(new Option('— 服务端返回空列表 —', ''));
        show('modelsResult', '模型列表为空（服务端正常但无模型）', 'bad');
        return;
      }
      for (var i = 0; i < j.models.length; i++) {
        sel.add(new Option(j.models[i].id, j.models[i].id));
      }
      show('modelsResult', '✓ 发现 ' + j.models.length + ' 个模型（在上方下拉选择）', 'ok');
    } else {
      show('modelsResult', '✗ ' + (j.error || '获取失败'), 'bad');
    }
  } catch (e) {
    show('modelsResult', '✗ 请求失败：' + e, 'bad');
  }
}
async function connect() {
  if (!selectedId()) { show('connectResult', '请先选择一个平台', 'bad'); return; }
  show('connectResult', '保存中…', '');
  var res = await postJson('/api/connect', payload());
  if (res.body && res.body.ok) {
    show('connectResult', '已生效 ✓ 可关闭此页', 'ok');
    refreshState();
  } else {
    show('connectResult', '✗ ' + ((res.body && res.body.error) || ('HTTP ' + res.status)), 'bad');
  }
}
async function disconnect() {
  await postJson('/api/disconnect', {});
  show('connectResult', '已断开', '');
  refreshState();
}
document.querySelectorAll('input[name=platform]').forEach(function (r) {
  r.addEventListener('change', onPick);
});
$('modelSelect').addEventListener('change', function () {
  if (this.value) $('modelInput').value = this.value;
});
$('btnTest').addEventListener('click', testConn);
$('btnModels').addEventListener('click', loadModels);
$('btnConnect').addEventListener('click', connect);
$('btnDisconnect').addEventListener('click', disconnect);
renderCurrent();
onPick();
</script>
</body>
</html>`;
}
