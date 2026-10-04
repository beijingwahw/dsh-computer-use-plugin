// src/notary/index.ts
// 纪元 Π（可公证行为账本）：让 agent 的行为史可对外公证。
//
// 一枚锚（AnchorRecord）= 「某时刻，行为日志（journal）长这个样子」的宣誓快照：
//   seq        —— 锚定时刻 journal 条数（被宣誓覆盖的行动流前缀长度）
//   chainTip   —— journal 哈希链尖（顺序与连续性的指纹）
//   mmrRoot    —— journal 行动流的 MMR 根（单条在册证明的验证锚，proof.ts 原语）
//   timestamp  —— 时间背书：RFC 3161 第三方回执（endpoint 配置时）或本地时钟
//                 （诚实标注 source:'local'，绝不谎称第三方）
//   prevAnchorHash —— 锚自链前链接（锚与锚之间同样成链 —— 抽走一枚锚即断链）
//   hash       —— sha256(canonical(记录去掉自身 hash))：整枚锚的防篡改指纹
//
// 先例致敬：v4 的「MMR 证据锚」（checkpoint.ts，恢复后重算根与锚对照）验证了
// 「快照 + 重算对照」的取证形态；本纪元把它升格为可对外的公证账本：
// verifyNotary() 四绿章 = 链完整 / MMR 在册 / 时间锚 / 重放一致性。
//
// 运行铁律（与 pilotStore/sandboxLog 同源）：公共面永不抛异常 —— 公证是旁路
// 仪式，失败 = 诚实红章或降级注记，绝不炸宿主；now/fetch/crypto 全注入（确定性
// 测试）；notaryTracePath 非空时 JSONL 追加落盘（断尾行容忍读 + 断尾治疗写）。
import { readFileSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import path from 'path';
import { journal } from '../journal.js';
import { mmrVerify } from '../proof.js';
import { requestRfc3161Timestamp, verifyTimestampToken } from './rfc3161.js';
// W6-2（doctor smell.over-engineering 清偿）：锚记录+密码学原语 → primitives、重放一致性 → replay（行为零变化）；导入面不变。
// D-G5（W8 第 2 批）：回放轨迹见证 → replayWitness（数据面在 primitives 同册）。
import { attestReplayConsistency } from './replay.js';
export { attestReplayConsistency } from './replay.js';
export { canonical, sha256Hex, journalChainHash, anchorHash, errText, copyRecord } from './primitives.js';
export { replayStepFingerprint, anchorReplayTrajectoryOn, } from './replayWitness.js';
import { canonical, journalChainHash, anchorHash, errText, copyRecord } from './primitives.js';
import { anchorReplayTrajectoryOn } from './replayWitness.js';
/** 真 journal 单例的适配面（只用 journal 导出的公开 API —— 不复制其实现） */
const journalLedger = {
    entries: () => journal.list(false),
    tip: () => journal.tip,
    base: () => journal.base,
    verify: () => journal.verify(),
    mmrRoot: () => journal.mmrRoot(),
    mmrProof: (index) => journal.mmrProof(index),
};
/** 铸 nonce：CSPRNG 16 字节；首字节 MSB 清零 + 置低位（DER INTEGER 正号位且无前导零剥除歧义） */
function mintNonce(random) {
    const raw = random(16);
    raw[0] = (raw[0] & 0x7f) | 0x01;
    return raw;
}
function toB64(bytes) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}
/**
 * 锚载荷摘要（sha256 原始 32 字节）：时间戳背书所绑定的「账本状态」指纹。
 * D-G5：witness 在场 ⇒ 一并入摘要域（第三方回执连同回放见证一起绑定）；
 * 缺席 ⇒ canonical 过滤 undefined —— 摘要与旧形态逐字节一致（向后兼容）。
 */
function anchorPayloadDigest(a) {
    return createHash('sha256')
        .update(canonical({
        seq: a.seq, chainTip: a.chainTip, mmrRoot: a.mmrRoot,
        prevAnchorHash: a.prevAnchorHash, witness: a.witness,
    }), 'utf8')
        .digest();
}
class Notary {
    endpoint = '';
    tracePath = '';
    anchors = [];
    /** 追加写前是否需要「治疗换行」（断尾半行的封口 —— 见 appendAnchor） */
    traceEndsClean = true;
    /** 是否已被 configure 过（ensureConfigured 的兜底语义锚点） */
    configuredOnce = false;
    dirEnsured = false;
    /** 磁盘镜像可用性（写失败 ⇒ 永久降级纯内存 —— pilotStore 降级律） */
    traceWritable = true;
    _lastError = null;
    /** 最近一次内部故障（降级取证；null = 无故障） */
    get lastError() { return this._lastError; }
    /** 内存锚链长度 */
    get anchorCount() { return this.anchors.length; }
    /**
     * 宿主装配状态（D-G5 公证缺席判据）：configure 是否发生过（显式接线或
     * ensureConfigured 兜底均计）。未装配 ⇒ 重放铸证等便捷面诚实降级 ——
     * 公证纪律由宿主开闸，缺省零行为。
     */
    isConfigured() { return this.configuredOnce; }
    /**
     * 装配：endpoint/tracePath。tracePath 变更（或首配）⇒ 重放 JSONL 铸回内存锚链
     * （断尾行容忍 —— 被杀进程的半行跳过，之前的完好行照常铸态）。永不抛。
     */
    configure(cfg) {
        try {
            if (typeof cfg.endpoint === 'string')
                this.endpoint = cfg.endpoint.trim();
            const tp = typeof cfg.tracePath === 'string' ? cfg.tracePath.trim() : this.tracePath;
            if (tp !== this.tracePath) {
                this.tracePath = tp;
                this.reloadTrace();
            }
            this.configuredOnce = true;
        }
        catch (e) {
            this._lastError = `configure: ${errText(e)}`;
        }
    }
    /** 惰性兜底装配（仅在从未 configure 过时生效 —— index.ts 的显式接线优先） */
    ensureConfigured(cfg) {
        if (this.configuredOnce)
            return;
        this.configure(cfg);
    }
    /** 测试缝：清内存锚链与配置归零（磁盘文件不删 —— 文件清理属宿主运维职权） */
    reset() {
        this.endpoint = '';
        this.tracePath = '';
        this.anchors = [];
        this.traceEndsClean = true;
        this.configuredOnce = false;
        this.dirEnsured = false;
        this.traceWritable = true;
        this._lastError = null;
    }
    /** 末锚（防御性深拷贝；无锚 ⇒ null） */
    lastAnchor() {
        const last = this.anchors.at(-1);
        return last ? copyRecord(last) : null;
    }
    /**
     * 铸一枚锚（永不抛：任何内部异常吞为 lastError 并返回 null —— 公证是旁路仪式）。
     * 流程：账本快照（seq/链尖/MMR 根，journal 公开面）→ nonce → RFC 3161（endpoint
     * 非空；失败诚实回退 local + 注记）或本地时间锚（endpoint 空，零网络）→ 记录
     * 哈希封存 → 内存锚链 + JSONL 追加（若配置且可写）。
     */
    async anchorOnce(opts = {}) {
        try {
            const ledger = opts.ledger ?? journalLedger;
            const now = opts.now ?? Date.now;
            const random = opts.random ?? ((n) => new Uint8Array(randomBytes(n)));
            const t = now();
            // 账本快照：同刻取三件套（seq = 条数；链尖与 MMR 根各自来自 journal 公开面）
            const seq = ledger.entries().length;
            const chainTip = ledger.tip();
            const mmrRoot = ledger.mmrRoot();
            const prevAnchorHash = this.anchors.at(-1)?.hash ?? null; // 首锚 null 哨兵
            const nonce = mintNonce(random);
            // D-G5：TSA 请求摘要与锚载荷同域 —— witness 在场 ⇒ 第三方回执连回放
            // 见证一起绑定（canonical 过滤 undefined ⇒ 无见证锚的摘要逐字节旧形态）
            const digest = anchorPayloadDigest({ seq, chainTip, mmrRoot, prevAnchorHash, witness: opts.witness });
            const endpoint = (opts.endpoint !== undefined ? opts.endpoint : this.endpoint).trim();
            let timestamp;
            if (endpoint === '') {
                // 本地时间锚：诚实标注 source:'local' —— 绝不谎称第三方背书（零网络）
                timestamp = { source: 'local', anchoredAt: t, nonce: toB64(nonce) };
            }
            else {
                const r = await requestRfc3161Timestamp({
                    endpoint, digest, nonce,
                    fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs,
                });
                if (r.ok) {
                    timestamp = {
                        source: 'rfc3161', anchoredAt: t,
                        token: toB64(r.token), imprintVerified: true, nonce: toB64(nonce),
                    };
                }
                else {
                    // 诚实回退 + 注记：回执未取得，本地钟顶上，失败事实留在锚上（不掩盖）
                    timestamp = {
                        source: 'local', anchoredAt: t, nonce: toB64(nonce),
                        note: `rfc3161 fallback (${r.error}) — local clock only, NOT third-party attestation`,
                    };
                }
            }
            const seed = {
                seq, chainTip, mmrRoot, timestamp, prevAnchorHash,
                // D-G5：见证在场 ⇒ 入哈希域（anchorHash 覆盖全部字段 —— 防篡改同律）；
                // 缺席 ⇒ 键不落（canonical 语义下 undefined 与缺键同域 —— 旧锚逐字节不变）
                ...(opts.witness !== undefined ? { witness: opts.witness } : {}),
            };
            const record = { ...seed, hash: anchorHash(seed) };
            this.anchors.push(record);
            this.appendAnchor(record);
            return copyRecord(record);
        }
        catch (e) {
            this._lastError = `anchorOnce: ${errText(e)}`;
            return null;
        }
    }
    /**
     * 四绿章核验（纯本地零网络；任何一章崩溃吞为红章 —— 绝不抛）：
     *   ① chain-integrity   journal.verify() 全链校验（篡改任何历史字节 ⇒ 红）
     *   ② mmr-membership    末锚条目的 MMR 包含证明有效（proof.ts 公开原语铸证）
     *   ③ timestamp-anchor  锚自链完整 + journal 前缀重走至 seq 复算链尖 + token 复核
     *   ④ replay-consistency Χ 纪元三态升级：沙箱段在场 ⇒ deterministicReplay 重演
     *      逐位比对（绿=可复现 / 红=链完整但内容与确定性世界不符）；无沙箱段 ⇒
     *      诚实 n/a（真机 journal 段不可复现）；旧格式无指纹 ⇒ n/a(legacy)。
     *      沙箱账本可经 opts.sandboxLedger 注入（缺省自动发现沙箱单例）。
     */
    verifyNotary(opts = {}) {
        const ledger = opts.ledger ?? journalLedger;
        const badges = {};
        // 章级隔离：单章崩溃降级为红章 detail，其余章照常出结论（绝不整体炸）
        const guard = (name, fn) => {
            try {
                badges[name] = fn();
            }
            catch (e) {
                badges[name] = { status: 'red', detail: `verifier crashed: ${errText(e)}` };
            }
        };
        // ① 链完整：journal 全链校验（哈希链 —— 顺序与连续性；篡改即断，断点即证物）
        guard('chain-integrity', () => {
            const v = ledger.verify();
            if (v.ok) {
                return { status: 'green', detail: `journal hash-chain intact over ${v.length} live entr${v.length === 1 ? 'y' : 'ies'} (chainBase → tip)` };
            }
            return { status: 'red', detail: `journal chain broken at entry ${v.brokenAt} — history tampered (add/delete/modify)` };
        });
        // ② MMR 在册：末锚覆盖的最后一条 journal 条目铸造包含证明并验证（免整链重放 —— O(log n)）
        guard('mmr-membership', () => {
            const last = this.anchors.at(-1);
            if (!last)
                return { status: 'n/a', detail: 'no anchors minted yet — nothing to prove membership of' };
            if (last.seq === 0)
                return { status: 'n/a', detail: 'anchor covers an empty journal (seq=0) — no entry to include' };
            const entries = ledger.entries();
            if (entries.length < last.seq) {
                return { status: 'n/a', detail: `anchored entry #${last.seq - 1} evicted from the live window (${entries.length} entries left) — membership forensics live on the disk JSONL` };
            }
            const proof = ledger.mmrProof(last.seq - 1);
            if (!proof) {
                return { status: 'red', detail: `cannot mint an MMR inclusion proof for anchored entry #${last.seq - 1}` };
            }
            if (entries.length === last.seq && last.mmrRoot !== null) {
                // 静止世界（锚后无增长）：证明对「锚根」验证 —— 锚根覆盖被锚条目的最强形态
                return mmrVerify(proof, last.mmrRoot)
                    ? { status: 'green', detail: `entry #${last.seq - 1} inclusion proof verifies against the ANCHOR's MMR root (journal ungrown since anchoring)` }
                    : { status: 'red', detail: `inclusion proof for entry #${last.seq - 1} fails against the anchor MMR root — journal prefix rewritten` };
            }
            // 增长世界：证明对「当前根」验证 —— MMR 追加型，旧叶不可能从袋中消失；
            // 旧叶还在 + 章①（顺序完整）共同构成增长世界下的在册证词
            const rootNow = ledger.mmrRoot();
            return rootNow !== null && mmrVerify(proof, rootNow)
                ? { status: 'green', detail: `entry #${last.seq - 1} inclusion proof verifies against the CURRENT MMR root (journal grew ${last.seq} → ${entries.length} after anchoring)` }
                : { status: 'red', detail: `inclusion proof for entry #${last.seq - 1} fails against the current MMR root` };
        });
        // ③ 时间锚：锚自链 + journal 前缀重走 + rfc3161 token 离线复核
        guard('timestamp-anchor', () => this.verifyTimestampAnchor(ledger));
        // ④ 重放一致性（Χ 纪元升级：Π 的 n/a 承诺兑现为可执法的三态）。沙箱段在
        //    场 ⇒ 确定性重放逐位执法；真机段保持诚实 n/a（世界不可复现）；旧格式
        //    无指纹 ⇒ n/a(legacy)。attestReplayConsistency 自身永不抛 —— guard 双保险
        //    同律（章级隔离：此章崩溃不炸其余三章与总报告）。
        guard('replay-consistency', () => attestReplayConsistency({ sandboxLedger: opts.sandboxLedger }));
        const ok = Object.values(badges).every(b => b.status !== 'red');
        const last = this.anchors.at(-1) ?? null;
        return {
            ok,
            badges,
            anchors: this.anchors.length,
            lastAnchor: last ? {
                seq: last.seq,
                chainTip: last.chainTip,
                mmrRoot: last.mmrRoot,
                source: last.timestamp.source,
                anchoredAt: last.timestamp.anchoredAt,
                imprintVerified: last.timestamp.imprintVerified ?? null,
                hash: last.hash,
                prevAnchorHash: last.prevAnchorHash,
            } : null,
        };
    }
    /** 章③实现：三段核验 —— 任一段硬失败 ⇒ 红；前缀重走不可得（驱逐）⇒ 整章诚实 n/a */
    verifyTimestampAnchor(ledger) {
        if (this.anchors.length === 0) {
            return { status: 'n/a', detail: 'no anchors on the notarial chain' };
        }
        const details = [];
        let red = null;
        // ③-a 锚自链：逐锚重算 hash + prev 链接（篡改锚记录/抽锚/插锚 ⇒ 红）
        for (let i = 0; i < this.anchors.length; i++) {
            const a = this.anchors[i];
            const domain = { ...a };
            delete domain.hash;
            if (anchorHash(domain) !== a.hash) {
                red ??= `anchor #${i} hash mismatch (record tampered)`;
            }
            const expectPrev = i === 0 ? null : this.anchors[i - 1].hash;
            if (a.prevAnchorHash !== expectPrev) {
                red ??= `anchor #${i} prevAnchorHash broken (anchor chain forked/spliced)`;
            }
        }
        if (!red)
            details.push(`anchor self-chain intact (${this.anchors.length} link${this.anchors.length === 1 ? '' : 's'})`);
        // ③-b journal 前缀重走：从链基复算前 seq 条至锚定时刻的链尖，与锚上的 chainTip 对照。
        // 驱逐警戒：chainBase ≠ GENESIS 说明容量驱逐发生过 —— 存活窗口起点与历史序号
        // 失去映射（诚实不可判），整段降级 n/a（磁盘 JSONL 承载取证，不虚绿也不误红）。
        const entries = ledger.entries();
        const base = ledger.base();
        if (base !== 'GENESIS') {
            details.push('journal capacity eviction advanced the chain base — historical seq→live-index mapping unavailable, prefix re-walk honestly skipped (disk JSONL holds forensics)');
            if (!red)
                return { status: 'n/a', detail: details.join('; ') };
        }
        else {
            for (let i = 0; i < this.anchors.length && !red; i++) {
                const a = this.anchors[i];
                if (a.seq === 0) {
                    if (a.chainTip !== 'GENESIS')
                        red = `anchor #${i} claims tip ${a.chainTip.slice(0, 16)}… over an empty journal (expected GENESIS)`;
                    else
                        details.push(`anchor #${i}: empty-journal anchor consistent (tip=GENESIS)`);
                    continue;
                }
                if (entries.length < a.seq) {
                    // 窗口未驱逐（base=GENESIS）却条数少于 seq ⇒ 账本被清空/回滚 —— 硬失败
                    red = `journal holds ${entries.length} entries but anchor #${i} swears over ${a.seq} — ledger rolled back or reset`;
                    break;
                }
                let prev = base;
                for (let k = 0; k < a.seq; k++) {
                    const e = entries[k];
                    const expect = journalChainHash(prev, e);
                    if (e.hash !== expect) {
                        red = `re-walk diverges at entry ${k} before anchor #${i}'s seq ${a.seq} — entry tampered after anchoring`;
                        break;
                    }
                    prev = expect;
                }
                if (!red) {
                    if (prev !== a.chainTip) {
                        red = `anchor #${i} chainTip mismatch — re-walk recomputes a different tip than the anchor swears`;
                    }
                    else {
                        details.push(`anchor #${i}: re-walk over ${a.seq} entries reproduces its chainTip`);
                    }
                }
            }
        }
        // ③-c rfc3161 token 离线复核：重算锚载荷摘要 + nonce，重走 token 内的
        // imprint/nonce（零网络 —— 回执是留存物证，复核不依赖 TSA 在线；token 是
        // ContentInfo 不含 PKIStatusInfo —— 信封级结论在领取时已下，此处只核物证）
        let sawRfc = false;
        for (let i = 0; i < this.anchors.length && !red; i++) {
            const a = this.anchors[i];
            if (a.timestamp.source !== 'rfc3161')
                continue;
            sawRfc = true;
            if (!a.timestamp.token) {
                red = `anchor #${i} claims rfc3161 but stores no token`;
                break;
            }
            const token = Buffer.from(a.timestamp.token, 'base64');
            const digest = anchorPayloadDigest(a);
            const nonce = Buffer.from(a.timestamp.nonce, 'base64');
            let verified;
            try {
                const v = verifyTimestampToken(new Uint8Array(token), { digest: new Uint8Array(digest), nonce: new Uint8Array(nonce) });
                verified = v.ok ? { ok: true } : { ok: false, error: v.error };
            }
            catch (e) {
                verified = { ok: false, error: errText(e) }; // 双保险：复核崩溃不炸核验面
            }
            if (verified.ok) {
                details.push(`anchor #${i}: token imprint+nonce re-verified offline (receipt on record)`);
            }
            else {
                red = `anchor #${i} token re-verification failed: ${verified.error ?? 'unparsed'}`;
            }
        }
        if (!sawRfc) {
            details.push('no rfc3161 anchors — token recheck vacuous (local-time anchors honestly carry no third-party receipt)');
        }
        if (red)
            return { status: 'red', detail: `${red}; ${details.join('; ')}` };
        return { status: 'green', detail: details.join('; ') };
    }
    // ─── JSONL 落盘（断尾容忍读 + 断尾治疗写 —— pilotStore 先例的公证版） ───
    /** 重放 trace 文件铸回内存锚链（文件不存在 = 空账本首用，合法态） */
    reloadTrace() {
        this.anchors = [];
        this.traceWritable = true;
        this.dirEnsured = false;
        this.traceEndsClean = true;
        if (!this.tracePath)
            return;
        let text;
        try {
            text = readFileSync(this.tracePath, 'utf8');
        }
        catch (e) {
            const code = e?.code;
            if (code !== 'ENOENT') {
                // 读失败（权限/占用等）⇒ 落盘面降级，内存账本照常（绝不炸）
                this.traceWritable = false;
                this._lastError = `reloadTrace: ${errText(e)}`;
            }
            return;
        }
        // 断尾容忍：逐行解析，半行（进程被杀）跳过 —— 之前的完好行照常铸态
        for (const raw of text.split('\n')) {
            const line = raw.trim();
            if (line === '')
                continue;
            try {
                const rec = JSON.parse(line);
                // 最小形状门（垃圾行剔除；被篡改但形状完好的行保留 —— 核验章的证物）
                if (rec && typeof rec.seq === 'number' && typeof rec.chainTip === 'string'
                    && typeof rec.hash === 'string' && rec.timestamp
                    && (rec.timestamp.source === 'rfc3161' || rec.timestamp.source === 'local')) {
                    this.anchors.push(rec);
                }
            }
            catch {
                continue; // 断尾/损坏行容忍
            }
        }
        // 断尾治疗记账：文件不以换行收尾 ⇒ 下次追加先补 '\n' 封口（半行不再增长成「粘行」）
        this.traceEndsClean = text === '' || text.endsWith('\n');
    }
    /** 追加一枚锚行（目录一次保证 + fsync 崩溃一致性 + 断尾治疗；写失败 ⇒ 降级纯内存） */
    appendAnchor(record) {
        if (!this.tracePath || !this.traceWritable)
            return;
        try {
            if (!this.dirEnsured) {
                mkdirSync(path.dirname(this.tracePath), { recursive: true });
                this.dirEnsured = true;
            }
            const heal = this.traceEndsClean ? '' : '\n'; // 断尾治疗写：先封口半行
            const fh = openSync(this.tracePath, 'a');
            try {
                writeSync(fh, heal + JSON.stringify(record) + '\n', null, 'utf8');
                fsyncSync(fh); // 页缓存不算落盘（journal/checkpoint 同律的崩溃一致性）
            }
            finally {
                closeSync(fh);
            }
            this.traceEndsClean = true;
        }
        catch (e) {
            // 降级律：磁盘故障 ⇒ 此后纯内存（内存锚链仍完整），错误留痕供运维取证
            this.traceWritable = false;
            this._lastError = `appendAnchor: ${errText(e)}`;
        }
    }
}
/** 模块级单例（对齐 journal/sandboxLog 的导出方言；生命周期由 index.ts 接线管理） */
export const notary = new Notary();
/**
 * 自动锚开关面（index.ts 卸载钩子接线；本函数零侵入可重入）：
 * config.notaryAutoAnchor 为真时铸一次锚 —— fire-and-forget、吞错（公证是旁路
 * 仪式，卸载路径上任何故障都不许炸宿主）；假/缺省 ⇒ 零行为。
 * 参数取结构最小面（Config 天然满足 —— 不把 schemastery 拉进运行时依赖图）。
 */
export function notaryAutoAnchorIfConfigured(config) {
    try {
        if (!config || config.notaryAutoAnchor !== true)
            return;
        notary.ensureConfigured({
            endpoint: config.notaryEndpoint ?? '',
            tracePath: config.notaryTracePath ?? '',
        });
        // fire-and-forget + 双保险吞错（anchorOnce 自身已永不抛 —— 此处 belt & braces）
        void notary.anchorOnce().catch(() => { });
    }
    catch {
        /* 绝不炸宿主 */
    }
}
/**
 * 把回放轨迹见证铸进 notary 单例锚（D-G5 便捷面，绑定单例 —— 永不抛）：
 * 未装配 ⇒ 诚实降级（reason 申报公证缺席）；endpoint 空 = 本地时间锚零网络
 * （既有纪律保持）。结构性注入测试走 anchorReplayTrajectoryOn（假件执法缝）。
 */
export async function anchorReplayTrajectory(witness, opts = {}) {
    return anchorReplayTrajectoryOn(notary, witness, opts);
}
