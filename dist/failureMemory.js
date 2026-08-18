// src/failureMemory.ts
// 第六轮创新之二：失败记忆（Anti-Skill，反技能）。
// 技能库学习「什么有效」，本模块学习「什么无效」—— 两条记忆对称共存：
//   记录：手动 remember_failure + 熔断触发时自动捕获（场景指纹 + 动作签名 + 症状）
//   检索：match_skill 召回技能时同步附上「同场景已知失败路径」，先验正负对照
// 价值：大多数系统只从成功学习；而一次探索中验证过的死路，本会话内不必再走第二遍。
import { similarity } from './perceptualHash.js';
import { tokenize, overlapCoefficient } from './uiMemory.js';
class FailureMemory {
    records = [];
    nextId = 1;
    capacity = 30;
    record(query, approach, symptom, sceneHash) {
        // 近重复去重：同查询+同路径 5 分钟内不重复记录
        const dup = this.records.find(r => r.query === query && r.approach === approach && Date.now() - r.at < 300_000);
        if (dup) {
            dup.at = Date.now();
            return dup;
        }
        const rec = { id: this.nextId++, query, approach, symptom, sceneHash, at: Date.now() };
        this.records.push(rec);
        if (this.records.length > this.capacity)
            this.records.shift(); // FIFO：旧失败让位新失败
        return rec;
    }
    /** 匹配：文本重合 + 同场景加成。返回「在这个场景/任务下别这么试」的清单 */
    match(query, currentSceneHash, k = 3) {
        const q = tokenize(query);
        return this.records
            .map(r => {
            const text = overlapCoefficient(q, tokenize(r.query + ' ' + r.approach));
            let scene = 0;
            if (currentSceneHash && r.sceneHash && similarity(currentSceneHash, r.sceneHash) >= 0.9)
                scene = 0.4;
            return { ...r, score: Math.round((text + scene) * 1000) / 1000 };
        })
            .filter(r => r.score > 0.2)
            .sort((a, b) => b.score - a.score)
            .slice(0, k);
    }
    get size() {
        return this.records.length;
    }
    /** checkpoint 序列化：失败记忆与技能库对称持久化 */
    dump() {
        return { records: this.records, nextId: this.nextId };
    }
    restore(data) {
        if (!data?.records)
            return;
        this.records = data.records;
        this.nextId = data.nextId ?? (this.records.at(-1)?.id ?? 0) + 1;
    }
    reset() {
        this.records = [];
    }
}
export const failureMemory = new FailureMemory();
