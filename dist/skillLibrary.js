// src/skillLibrary.ts
// 第五轮创新之一：自进化技能库（Trajectory -> Skill）。
// 日志记录「做了什么」，重放能「再做一次」，但都缺一块：成功经验不会自动沉淀。
// 本模块把成功轨迹归纳为「技能」—— 带触发描述、入口场景指纹、可靠度统计的宏，
// 持久化到磁盘后跨会话存活：Agent 第一次学会你的工作流，第二次直接复用。
// 可靠度闭环：每次 run_skill 的成败回写 successCount/attemptCount，
// 匹配排序时「历史验证过的技能」天然优先 —— 越用越准的肌肉记忆。
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'fs';
import path from 'path';
import { journal } from './journal.js';
import { similarity } from './perceptualHash.js';
import { tokenize, overlapCoefficient } from './uiMemory.js';
import { embed, cosine } from './semanticHash.js';
/** 可重放的工具白名单：click_element 依赖运行时元素缓存，不进技能 */
const REPLAYABLE = new Set([
    'click_mouse', 'type_text', 'scroll_page', 'press_hotkey',
    'drag_mouse', 'switch_tab', 'switch_window', 'dismiss_popup',
]);
const stepSignature = (steps) => steps.map(s => `${s.tool}:${JSON.stringify(s.args)}`).join('|');
class SkillLibrary {
    skills = [];
    nextId = 1;
    enabled = true;
    filePath = '';
    capacity = 50;
    nextSynthId = 1; // C-2：合成技能发号器（syn-N 命名，跨会话不冲突）
    configure(enabled, filePath, capacity = 50) {
        this.enabled = enabled;
        this.filePath = filePath;
        this.capacity = capacity;
    }
    /** 从磁盘载入（跨会话学习的关键）。文件损坏/不存在 ⇒ 从空库开始，不致命 */
    load() {
        if (!this.filePath || !existsSync(this.filePath))
            return;
        try {
            const data = JSON.parse(readFileSync(this.filePath, 'utf8'));
            if (Array.isArray(data.skills)) {
                this.skills = data.skills;
                this.nextId = data.nextId ?? this.skills.length + 1;
                this.nextSynthId = data.nextSynthId ?? this.nextSynthId;
            }
            console.log(`[Skill] Loaded ${this.skills.length} skill(s) from ${this.filePath}`);
        }
        catch (e) {
            console.warn(`[Skill] Load failed (${e.message}); starting with empty library.`);
        }
    }
    /**
     * C-2 原子落盘（工程约束兑现）：tmp + rename —— 合成过程中崩溃 ⇒ 磁盘永远是完整旧库。
     * 与 checkpoint.ts 的 saveCheckpoint 同一原子写律。
     */
    save() {
        if (!this.filePath)
            return;
        const tmp = this.filePath + '.tmp';
        try {
            mkdirSync(path.dirname(this.filePath), { recursive: true });
            writeFileSync(tmp, JSON.stringify({ skills: this.skills, nextId: this.nextId, nextSynthId: this.nextSynthId }, null, 2), 'utf8');
            renameSync(tmp, this.filePath); // 原子换名：要么完整旧档，要么完整新档，绝无半档
        }
        catch (e) {
            try {
                unlinkSync(tmp);
            }
            catch { /* tmp 可能未创建 */ }
            console.warn(`[Skill] Save failed: ${e.message}`);
        }
    }
    /** 插件卸载：仅清内存，磁盘保留 —— 技能的寿命长于会话 */
    reset() {
        this.skills = [];
    }
    /**
     * 归纳技能。签名去重：完全相同的步骤序列不重复建卡，只 bump 可靠度 ——
     * 同一工作流做三遍 = 一个技能验证三次，而非三张卡。
     * C-2：归纳时缓存语义嵌入 + 默认单基因化（steps 整体为一个 DNA 片段）。
     */
    induce(description, steps, entrySceneHash, exitSceneHash) {
        if (!this.enabled || steps.length === 0)
            return null;
        const sig = stepSignature(steps);
        const existing = this.skills.find(s => stepSignature(s.steps) === sig);
        if (existing) {
            existing.attemptCount++;
            existing.successCount++;
            existing.lastUsedAt = Date.now();
            existing.description = description || existing.description;
            this.save();
            return existing;
        }
        const skill = {
            id: this.nextId++,
            name: `skill-${this.nextId - 1}`,
            description,
            entrySceneHash,
            steps,
            successCount: 1,
            attemptCount: 1,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            // C-2：嵌入缓存 + 单基因（整个轨迹一个片段；未来可按场景断点细拆）
            embedding: embed(description || sig),
            genes: [{ steps, entrySceneHash, exitSceneHash }],
        };
        this.skills.push(skill);
        // 容量驱逐：可靠度 × 新近度 综合最低者出局
        if (this.skills.length > this.capacity) {
            const now = Date.now();
            this.skills.sort((a, b) => ((b.successCount / b.attemptCount) * Math.exp(-(now - b.lastUsedAt) / 7200000)) -
                ((a.successCount / a.attemptCount) * Math.exp(-(now - a.lastUsedAt) / 7200000)));
            this.skills = this.skills.slice(0, this.capacity);
        }
        this.save();
        return skill;
    }
    /** 从日志归纳：取最近一次 markTaskStart 之后的可重放动作 */
    induceFromJournal(description, entrySceneHash) {
        const steps = journal.sinceTaskStart()
            .filter(e => REPLAYABLE.has(e.tool))
            .map(e => ({ tool: e.tool, args: e.args ?? {} }));
        return this.induce(description, steps, entrySceneHash);
    }
    /**
     * 匹配：文本重合 + 可靠度 + 入口场景同屏加成 + 新近度。
     * C-2 语义泛化：文本项取 max(overlap, semanticCosine) ——
     *   精确匹配零回归（overlap 主导）；「整理数据」经向量命中「筛选数据」（零样本泛化）。
     */
    match(query, currentSceneHash, k = 3) {
        const q = tokenize(query);
        const qVec = embed(query);
        const now = Date.now();
        return this.skills
            .map(s => {
            const overlap = overlapCoefficient(q, tokenize(s.description));
            // 懒嵌入：旧档技能无 embedding 时现场补算（restore 后首次匹配付一次微秒级成本）
            const vec = s.embedding ?? embed(s.description || stepSignature(s.steps));
            if (!s.embedding)
                s.embedding = vec;
            const semantic = cosine(qVec, vec);
            const text = Math.max(overlap, semantic);
            const reliability = (s.successCount + 1) / (s.attemptCount + 2); // Laplace 平滑
            let scene = 0;
            if (currentSceneHash && s.entrySceneHash && similarity(currentSceneHash, s.entrySceneHash) >= 0.9) {
                scene = 0.3;
            }
            const ageH = (now - s.lastUsedAt) / 3600000;
            const recency = 0.1 * Math.exp(-ageH / 72);
            return {
                ...s, score: Math.round((text + 0.3 * reliability + scene + recency) * 1000) / 1000,
                // C-2 归因：命中通道对模型透明。overlap>=0.5 才算真正词面命中；
                // 零星共享字（CJK 单字/二元组）是子词噪声，此时排序信号实为语义向量。
                matched_via: overlap >= 0.5 && overlap >= semantic ? 'exact-tokens' : 'semantic-vector',
            };
        })
            .filter(s => s.score > 0.15)
            .sort((a, b) => b.score - a.score)
            .slice(0, k);
    }
    /**
     * C-2 DNA 重组引擎：从既有技能的基因链中实时合成新技能。
     * 拼接律：基因 A 的离场指纹 ≈ 基因 B 的入场指纹（dHash 相似度 ≥ 0.85）⇒ 可链式拼接；
     * 或语义相邻（查询向量同时高余弦命中两母体技能）⇒ 按匹配序拼接。
     * 合成技能 synthesized=true：成功 0/尝试 0，Laplace 先验 1/2 —— 谨慎起步，用一次校准一次。
     * 原子性：合成 → 内存登记 → save() 原子落盘，中途崩溃磁盘保持完整旧库。
     */
    recombine(query, currentSceneHash) {
        if (!this.enabled)
            return { skill: null, plan: [] };
        // 候选母体：语义 top-k（k=4 —— 太少没得拼，太多拼出长蛇）
        const candidates = this.match(query, currentSceneHash, 4).filter(c => c.score > 0.25);
        if (candidates.length < 2)
            return { skill: null, plan: [] };
        const plan = [];
        const genes = [];
        const chain = [];
        // 贪心链式拼接：从最强候选出发，尝试把后续基因接到链尾
        for (const cand of candidates) {
            const gene = cand.genes?.[0];
            if (!gene || gene.steps.length === 0)
                continue;
            const tail = chain[chain.length - 1];
            // 拼接判据：首基因无条件入链；后续基因需 指纹衔接 或 语义相邻
            if (!tail) {
                chain.push(cand);
                genes.push({ ...gene, sourceSkillId: cand.id });
                plan.push({ skillId: cand.id, geneIndex: 0, reason: `best match (score ${cand.score})` });
                continue;
            }
            const tailExit = tail.genes?.at(-1)?.exitSceneHash;
            const fingerprintLink = tailExit && gene.entrySceneHash
                && similarity(tailExit, gene.entrySceneHash) >= 0.85;
            const semanticLink = cand.score > 0.3; // 语义相邻阈值：两母体都与查询强相关
            if (fingerprintLink || semanticLink) {
                chain.push(cand);
                genes.push({ ...gene, sourceSkillId: cand.id });
                plan.push({
                    skillId: cand.id, geneIndex: 0,
                    reason: fingerprintLink
                        ? 'exit→entry scene fingerprint linked'
                        : `semantically adjacent (score ${cand.score})`,
                });
            }
        }
        if (genes.length < 2)
            return { skill: null, plan: [] }; // 单基因 = 已有技能，无需合成
        // 合成步骤 = 基因步骤串接（去相邻重复：同工具同参数的接缝冗余剪除）
        const merged = [];
        for (const g of genes) {
            for (const st of g.steps) {
                const prev = merged[merged.length - 1];
                if (prev && prev.tool === st.tool && JSON.stringify(prev.args) === JSON.stringify(st.args))
                    continue;
                merged.push(st);
            }
        }
        const sig = stepSignature(merged);
        const existing = this.skills.find(s => stepSignature(s.steps) === sig);
        if (existing)
            return { skill: existing, plan }; // 重组结果撞已有技能 = 强化而非新建
        const skill = {
            id: this.nextId++,
            name: `syn-${this.nextSynthId++}`,
            description: query,
            entrySceneHash: genes[0].entrySceneHash,
            steps: merged,
            successCount: 0,
            attemptCount: 0,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            embedding: embed(query),
            genes,
            synthesized: true,
        };
        this.skills.push(skill);
        this.save(); // 原子落盘：合成中途崩溃 ⇒ 磁盘保持完整旧库
        return { skill, plan };
    }
    /** 执行结果回写：技能的可靠度随真实使用持续校准 */
    recordOutcome(id, success) {
        const s = this.skills.find(x => x.id === id);
        if (!s)
            return;
        s.attemptCount++;
        if (success)
            s.successCount++;
        s.lastUsedAt = Date.now();
        this.save();
    }
    get(id) {
        return this.skills.find(x => x.id === id);
    }
    /** checkpoint 序列化：与磁盘 JSON 同构（skills + 发号器进度） */
    dump() {
        return { skills: this.skills, nextId: this.nextId };
    }
    restore(data) {
        if (!data?.skills)
            return;
        this.skills = data.skills;
        this.nextId = data.nextId ?? (this.skills.at(-1)?.id ?? 0) + 1;
    }
    list() {
        return [...this.skills].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    }
}
export const skillLibrary = new SkillLibrary();
