// src/failureMemory.ts
// 第六轮创新之二：失败记忆（Anti-Skill，反技能）。
// 技能库学习「什么有效」，本模块学习「什么无效」—— 两条记忆对称共存：
//   记录：手动 remember_failure + 熔断触发时自动捕获（场景指纹 + 动作签名 + 症状）
//   检索：match_skill 召回技能时同步附上「同场景已知失败路径」，先验正负对照
// 价值：大多数系统只从成功学习；而一次探索中验证过的死路，本会话内不必再走第二遍。
import { similarity } from './perceptualHash.js';
import { tokenize, overlapCoefficient } from './uiMemory.js';
import { ncdSimilarity } from './ncd.js';
import { kernelRegistry } from './kernel/registry.js';
import { parseRootCause } from './diagnosis.js'; // W1-6：R1 根因归因链的病因命名空间
/** W1-6：记录的有效病因（无字段/垃圾值 ⇒ unknown —— 与 parseRootCause 同律） */
function effectiveRootCause(r) {
    return r.rootCause === undefined ? 'unknown' : parseRootCause(r.rootCause);
}
class FailureMemory {
    records = [];
    nextId = 1;
    capacity = 30;
    record(query, approach, symptom, sceneHash, rootCause) {
        // 近重复去重：同查询+同路径 5 分钟内不重复记录
        const dup = this.records.find(r => r.query === query && r.approach === approach && Date.now() - r.at < 300_000);
        if (dup) {
            dup.at = Date.now();
            // W1-6：重复失败路径刷新病因 —— 鉴别探针的结论比「未归因」新（如旧记录
            // 无 rootCause 而本次归因出 stall）。垃圾值经 parseRootCause 收口。
            if (rootCause !== undefined)
                dup.rootCause = parseRootCause(rootCause);
            return dup;
        }
        const rec = {
            id: this.nextId++, query, approach, symptom, sceneHash, at: Date.now(),
            // W1-6：病因防御入库（非法值 ⇒ unknown，不冒充知识）
            ...(rootCause !== undefined ? { rootCause: parseRootCause(rootCause) } : {}),
        };
        this.records.push(rec);
        if (this.records.length > this.capacity)
            this.records.shift(); // FIFO：旧失败让位新失败
        return rec;
    }
    /** 匹配：文本重合（query+approach+symptom 全文）+ 同场景加成 + H-2 压缩相似。
     *  H-2 修正注记：symptom 纳入 token hay（症状文本本就可检索 —— 原只搜 query/
     *  approach 是检索面残缺）；NCD 仍只对 symptom 比（可换述的部分，避免 approach
     *  的 ASCII 坐标稀释）。返回「在这个场景/任务下别这么试」的清单
     *  W1-6（R1）：opts.rootCause 在场 ⇒ 先按病因过滤候选池再走三通道 —— 病因
     *  通道与文本通道并存（结构化 narrowing，不替换排序律）；缺省不过滤，零回归。 */
    match(query, currentSceneHash, k = 3, opts) {
        const qTokens = tokenize(query);
        // W1-6：病因过滤（与文本通道并存 —— 池 narrowed，RRF/legacy 排序律不变）
        const pool = opts?.rootCause
            ? this.records.filter(r => effectiveRootCause(r) === opts.rootCause)
            : this.records;
        // R 纪元（R-6 召回层）：RRF 倒数排名融合 —— 三通道（词面重合 / NCD 压缩 /
        // 场景指纹）各排各的名次，融合分 = Σ 1/(60+rankᵢ)（TREC 2003 Cormack 形，
        // k=60 惯例）。为什么不用加权和：三通道分数量纲悬殊（重合系数 [0,1]、
        // NCD 相似 [0,1] 但分布不同、场景是 0/0.4 脉冲）—— 加权需要逐通道定标，
        // 排名是量纲自由的。旧加权和保留为 score2 字段（消费方按需取用，零回归）。
        // 纪元 Ξ（Ξ-D 生产接线）：三常量读内核注册表 —— failure.score2Floor（相关性
        // 闸门，缺省 0.2）/ failure.rrfK（RRF 平滑常数，缺省 60，区间 10..200）/
        // failure.sceneBonus（同场景脉冲，缺省 0.4）。未注册 ⇒ getOrDefault 回声
        // 字面量，召回与排序逐字节不变；每次 match 单次读取。
        const score2Floor = kernelRegistry.getOrDefault('failure.score2Floor', 0.2);
        const RRF_K = Math.round(kernelRegistry.getOrDefault('failure.rrfK', 60));
        const sceneBonus = kernelRegistry.getOrDefault('failure.sceneBonus', 0.4);
        const scored = pool.map(r => {
            const hay = `${r.query} ${r.approach} ${r.symptom}`;
            const text = overlapCoefficient(qTokens, tokenize(hay));
            // H-2 NCD 通道：leet/typo 变体与原文共享长子串（'verificat·on'）而 token
            // 化后零词面命中 —— 词面通道失明处由压缩器兜底。
            const compress = ncdSimilarity(query, r.symptom);
            let scene = 0;
            if (currentSceneHash && r.sceneHash && similarity(currentSceneHash, r.sceneHash) >= 0.9)
                scene = sceneBonus;
            return { r, text, compress, scene };
        });
        // 通道排名（降序；并列取同秩 —— 标准竞争排名：并列者共享首位名次）
        const rank = (key) => {
            const sorted = [...scored].sort((a, b) => b[key] - a[key]);
            const m = new Map();
            let prevVal = null;
            let prevRank = 0;
            sorted.forEach((x, i) => {
                const r = prevVal !== null && x[key] === prevVal ? prevRank : i + 1;
                m.set(x.r, r);
                prevVal = x[key];
                prevRank = r;
            });
            return m;
        };
        const rText = rank('text'), rComp = rank('compress'), rScene = rank('scene');
        return scored
            .map(({ r, text, compress, scene }) => {
            const rrf = 1 / (RRF_K + rText.get(r)) + (compress > 0 ? 1 / (RRF_K + rComp.get(r)) : 0)
                + (scene > 0 ? 1 / (RRF_K + rScene.get(r)) : 0);
            const legacy = Math.round((text + 0.3 * compress + scene) * 1000) / 1000;
            // score = RRF × 量纲还原（×1000 保持旧阈值 0.2 的语义近邻）
            return { ...r, score: Math.round(rrf * 1000 * 1000) / 1000, score2: legacy };
        })
            // Δ-2 过滤修正：RRF 分恒 ≥ 1000/(60+N)（rank ≤ N）—— 旧实现 filter(score>0.2)
            // 对任何非空库恒真（两条记录时下限 16.1），任意查询必召回全部无关失败。
            // 相关性闸门回归 score2（legacy 加权和）域：三通道证据至少其一实质在场
            // （词面重合 / 压缩相似 / 场景指纹）才过闸 —— R-6 之前的既有阈值语义。
            // 排序仍用 score（RRF 排名融合无量纲 —— R-6 的本意只在排序，不在过滤）。
            .filter(r => r.score2 > score2Floor)
            .sort((a, b) => b.score - a.score)
            .slice(0, k);
    }
    get size() {
        return this.records.length;
    }
    /**
     * W1-6（R1 鉴别试验）：按病因检索 —— 「已知 stall 类死路有哪些」「这个场景下
     * 的盲点文本点击败过几次」。与文本通道（match）并存而非替代：match 回答
     * 「这个任务下别这么试」，本方法回答「这类病因下都有哪些前科」。
     * 旧记录（无 rootCause 字段）统一归入 unknown 桶 —— 向后兼容的检索面。
     * 排序按时间降序（无文本查询 ⇒ 无相关性维度，新近性是唯一诚实序）。
     */
    matchByRootCause(rootCause, k = 5) {
        const wanted = parseRootCause(rootCause); // 防御：非法入参 ⇒ unknown 桶
        return this.records
            .filter(r => effectiveRootCause(r) === wanted)
            .sort((a, b) => b.at - a.at)
            .slice(0, Math.max(1, k));
    }
    /** checkpoint 序列化：失败记忆与技能库对称持久化 */
    dump() {
        return { records: this.records, nextId: this.nextId };
    }
    restore(data) {
        if (!data?.records)
            return;
        // W1-6：病因字段防御收口 —— 旧 checkpoint 无此字段（保持 undefined = unknown
        // 语义）；被篡改/损坏的垃圾值归一为 unknown（parseRootCause 律）。
        this.records = data.records.map(r => (r.rootCause === undefined || parseRootCause(r.rootCause) === r.rootCause)
            ? r
            : { ...r, rootCause: 'unknown' });
        this.nextId = data.nextId ?? (this.records.at(-1)?.id ?? 0) + 1;
    }
    reset() {
        this.records = [];
    }
}
export const failureMemory = new FailureMemory();
