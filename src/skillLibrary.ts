// src/skillLibrary.ts
// 第五轮创新之一：自进化技能库（Trajectory -> Skill）。
// 日志记录「做了什么」，重放能「再做一次」，但都缺一块：成功经验不会自动沉淀。
// 本模块把成功轨迹归纳为「技能」—— 带触发描述、入口场景指纹、可靠度统计的宏，
// 持久化到磁盘后跨会话存活：Agent 第一次学会你的工作流，第二次直接复用。
// 可靠度闭环：每次 run_skill 的成败回写 successCount/attemptCount，
// 匹配排序时「历史验证过的技能」天然优先 —— 越用越准的肌肉记忆。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { journal } from './journal';
import { similarity } from './perceptualHash';
import { tokenize, overlapCoefficient } from './uiMemory';

export interface SkillStep {
  tool: string;
  args: Record<string, any>;
}

export interface Skill {
  id: number;
  name: string;                 // 短名（自动生成或模型指定）
  description: string;          // 触发描述：什么任务该用这个技能
  entrySceneHash?: string;      // 归纳时的入口场景指纹（同屏加成）
  steps: SkillStep[];
  successCount: number;
  attemptCount: number;
  createdAt: number;
  lastUsedAt: number;
}

/** 可重放的工具白名单：click_element 依赖运行时元素缓存，不进技能 */
const REPLAYABLE = new Set([
  'click_mouse', 'type_text', 'scroll_page', 'press_hotkey',
  'drag_mouse', 'switch_tab', 'switch_window', 'dismiss_popup',
]);

const stepSignature = (steps: SkillStep[]): string =>
  steps.map(s => `${s.tool}:${JSON.stringify(s.args)}`).join('|');

class SkillLibrary {
  private skills: Skill[] = [];
  private nextId = 1;
  private enabled = true;
  private filePath = '';
  private capacity = 50;

  configure(enabled: boolean, filePath: string, capacity = 50): void {
    this.enabled = enabled;
    this.filePath = filePath;
    this.capacity = capacity;
  }

  /** 从磁盘载入（跨会话学习的关键）。文件损坏/不存在 ⇒ 从空库开始，不致命 */
  load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(data.skills)) {
        this.skills = data.skills;
        this.nextId = data.nextId ?? this.skills.length + 1;
      }
      console.log(`[Skill] Loaded ${this.skills.length} skill(s) from ${this.filePath}`);
    } catch (e: any) {
      console.warn(`[Skill] Load failed (${e.message}); starting with empty library.`);
    }
  }

  /** 尽力落盘：持久化是旁路义务，失败不阻断主流程 */
  save(): void {
    if (!this.filePath) return;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify({ skills: this.skills, nextId: this.nextId }, null, 2), 'utf8');
    } catch (e: any) {
      console.warn(`[Skill] Save failed: ${e.message}`);
    }
  }

  /** 插件卸载：仅清内存，磁盘保留 —— 技能的寿命长于会话 */
  reset(): void {
    this.skills = [];
  }

  /**
   * 归纳技能。签名去重：完全相同的步骤序列不重复建卡，只 bump 可靠度 ——
   * 同一工作流做三遍 = 一个技能验证三次，而非三张卡。
   */
  induce(description: string, steps: SkillStep[], entrySceneHash?: string): Skill | null {
    if (!this.enabled || steps.length === 0) return null;
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

    const skill: Skill = {
      id: this.nextId++,
      name: `skill-${this.nextId - 1}`,
      description,
      entrySceneHash,
      steps,
      successCount: 1,
      attemptCount: 1,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    this.skills.push(skill);

    // 容量驱逐：可靠度 × 新近度 综合最低者出局
    if (this.skills.length > this.capacity) {
      const now = Date.now();
      this.skills.sort((a, b) =>
        ((b.successCount / b.attemptCount) * Math.exp(-(now - b.lastUsedAt) / 7_200_000)) -
        ((a.successCount / a.attemptCount) * Math.exp(-(now - a.lastUsedAt) / 7_200_000)));
      this.skills = this.skills.slice(0, this.capacity);
    }
    this.save();
    return skill;
  }

  /** 从日志归纳：取最近一次 markTaskStart 之后的可重放动作 */
  induceFromJournal(description: string, entrySceneHash?: string): Skill | null {
    const steps = journal.sinceTaskStart()
      .filter(e => REPLAYABLE.has(e.tool))
      .map(e => ({ tool: e.tool, args: e.args ?? {} }));
    return this.induce(description, steps, entrySceneHash);
  }

  /** 匹配：文本重合 + 可靠度 + 入口场景同屏加成 + 新近度。返回前 k 个候选 */
  match(query: string, currentSceneHash?: string, k = 3): Array<Skill & { score: number }> {
    const q = tokenize(query);
    const now = Date.now();
    return this.skills
      .map(s => {
        const text = overlapCoefficient(q, tokenize(s.description));
        const reliability = (s.successCount + 1) / (s.attemptCount + 2); // Laplace 平滑
        let scene = 0;
        if (currentSceneHash && s.entrySceneHash && similarity(currentSceneHash, s.entrySceneHash) >= 0.9) {
          scene = 0.3;
        }
        const ageH = (now - s.lastUsedAt) / 3_600_000;
        const recency = 0.1 * Math.exp(-ageH / 72);
        return { ...s, score: Math.round((text + 0.3 * reliability + scene + recency) * 1000) / 1000 };
      })
      .filter(s => s.score > 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /** 执行结果回写：技能的可靠度随真实使用持续校准 */
  recordOutcome(id: number, success: boolean): void {
    const s = this.skills.find(x => x.id === id);
    if (!s) return;
    s.attemptCount++;
    if (success) s.successCount++;
    s.lastUsedAt = Date.now();
    this.save();
  }

  get(id: number): Skill | undefined {
    return this.skills.find(x => x.id === id);
  }

  list(): Skill[] {
    return [...this.skills].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }
}

export const skillLibrary = new SkillLibrary();
