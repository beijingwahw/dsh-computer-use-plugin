// src/failureMemory.ts
// 第六轮创新之二：失败记忆（Anti-Skill，反技能）。
// 技能库学习「什么有效」，本模块学习「什么无效」—— 两条记忆对称共存：
//   记录：手动 remember_failure + 熔断触发时自动捕获（场景指纹 + 动作签名 + 症状）
//   检索：match_skill 召回技能时同步附上「同场景已知失败路径」，先验正负对照
// 价值：大多数系统只从成功学习；而一次探索中验证过的死路，本会话内不必再走第二遍。
import { similarity } from './perceptualHash';
import { tokenize, overlapCoefficient } from './uiMemory';
import { ncdSimilarity } from './ncd';

export interface FailureRecord {
  id: number;
  query: string;              // 什么任务/目标下尝试的
  approach: string;           // 尝试了什么路径（工具+参数摘要）
  symptom: string;            // 失败症状（无变化/找不到/被拦截…）
  sceneHash?: string;         // 失败时的整屏指纹
  at: number;
}

class FailureMemory {
  private records: FailureRecord[] = [];
  private nextId = 1;
  private capacity = 30;

  record(query: string, approach: string, symptom: string, sceneHash?: string): FailureRecord {
    // 近重复去重：同查询+同路径 5 分钟内不重复记录
    const dup = this.records.find(r =>
      r.query === query && r.approach === approach && Date.now() - r.at < 300_000);
    if (dup) { dup.at = Date.now(); return dup; }

    const rec: FailureRecord = { id: this.nextId++, query, approach, symptom, sceneHash, at: Date.now() };
    this.records.push(rec);
    if (this.records.length > this.capacity) this.records.shift(); // FIFO：旧失败让位新失败
    return rec;
  }

  /** 匹配：文本重合（query+approach+symptom 全文）+ 同场景加成 + H-2 压缩相似。
   *  H-2 修正注记：symptom 纳入 token hay（症状文本本就可检索 —— 原只搜 query/
   *  approach 是检索面残缺）；NCD 仍只对 symptom 比（可换述的部分，避免 approach
   *  的 ASCII 坐标稀释）。返回「在这个场景/任务下别这么试」的清单 */
  match(query: string, currentSceneHash?: string, k = 3): Array<FailureRecord & { score: number }> {
    const qTokens = tokenize(query);
    // R 纪元（R-6 召回层）：RRF 倒数排名融合 —— 三通道（词面重合 / NCD 压缩 /
    // 场景指纹）各排各的名次，融合分 = Σ 1/(60+rankᵢ)（TREC 2003 Cormack 形，
    // k=60 惯例）。为什么不用加权和：三通道分数量纲悬殊（重合系数 [0,1]、
    // NCD 相似 [0,1] 但分布不同、场景是 0/0.4 脉冲）—— 加权需要逐通道定标，
    // 排名是量纲自由的。旧加权和保留为 score2 字段（消费方按需取用，零回归）。
    const scored = this.records.map(r => {
      const hay = `${r.query} ${r.approach} ${r.symptom}`;
      const text = overlapCoefficient(qTokens, tokenize(hay));
      // H-2 NCD 通道：leet/typo 变体与原文共享长子串（'verificat·on'）而 token
      // 化后零词面命中 —— 词面通道失明处由压缩器兜底。
      const compress = ncdSimilarity(query, r.symptom);
      let scene = 0;
      if (currentSceneHash && r.sceneHash && similarity(currentSceneHash, r.sceneHash) >= 0.9) scene = 0.4;
      return { r, text, compress, scene };
    });
    // 通道排名（降序；并列取同秩 —— 标准竞争排名）
    const rank = (key: 'text' | 'compress' | 'scene'): Map<FailureRecord, number> => {
      const sorted = [...scored].sort((a, b) => b[key] - a[key]);
      const m = new Map<FailureRecord, number>();
      sorted.forEach((x, i) => m.set(x.r, i + 1));
      return m;
    };
    const rText = rank('text'), rComp = rank('compress'), rScene = rank('scene');
    const RRF_K = 60;
    return scored
      .map(({ r, text, compress, scene }) => {
        const rrf = 1 / (RRF_K + rText.get(r)!) + (compress > 0 ? 1 / (RRF_K + rComp.get(r)!) : 0)
          + (scene > 0 ? 1 / (RRF_K + rScene.get(r)!) : 0);
        const legacy = Math.round((text + 0.3 * compress + scene) * 1000) / 1000;
        // score = RRF × 量纲还原（×1000 保持旧阈值 0.2 的语义近邻）
        return { ...r, score: Math.round(rrf * 1000 * 1000) / 1000, score2: legacy };
      })
      .filter(r => r.score > 0.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  get size(): number {
    return this.records.length;
  }

  /** checkpoint 序列化：失败记忆与技能库对称持久化 */
  dump(): { records: FailureRecord[]; nextId: number } {
    return { records: this.records, nextId: this.nextId };
  }

  restore(data: { records?: FailureRecord[]; nextId?: number } | undefined): void {
    if (!data?.records) return;
    this.records = data.records;
    this.nextId = data.nextId ?? (this.records.at(-1)?.id ?? 0) + 1;
  }

  reset(): void {
    this.records = [];
  }
}

export const failureMemory = new FailureMemory();
