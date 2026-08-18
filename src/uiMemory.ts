// src/uiMemory.ts
// 突破二：场景式 UI 记忆（Episodic Landmark Memory）。
// 滑动窗口只记得「最近几张图」；本模块让 Agent 拥有跨任务的位置记忆：
// 「上次在 VS Code 里，设置按钮在 (0.93, 0.04)」—— 成功点击过的目标被记为
// landmark，之后用自然语言召回，直接获得高置信坐标先验（仍需截图验证）。
// 检索打分 = 文本重合度 + 成功次数加成 + 时间衰减 + 场景指纹匹配加成，全部本地零成本。
import { similarity } from './perceptualHash';

export interface Landmark {
  id: number;
  description: string;            // 模型对目标的自然语言描述
  appHint?: string;               // 可选的应用/上下文线索
  sceneHash?: string;             // 记忆形成时的整屏指纹：场景匹配加成的事实源
  normalized: { x: number; y: number };
  successCount: number;           // 该位置被验证成功的次数
  lastUsedAt: number;
}

/** 分词：拉丁词 + CJK 单字 + CJK 二元组 —— 中英混合描述都能命中 */
export function tokenize(text: string): string[] {
  const latin = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const cjk = text.match(/[\u4e00-\u9fff]/g) ?? [];
  const bigrams: string[] = [];
  for (let i = 0; i < cjk.length - 1; i++) bigrams.push(cjk[i] + cjk[i + 1]);
  return [...latin, ...cjk, ...bigrams];
}

/** 重合系数：|A∩B| / min(|A|,|B|)，短查询也能命中长描述 */
export function overlapCoefficient(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const inter = a.filter(t => setB.has(t)).length;
  return inter / Math.min(a.length, b.length);
}

class UIMemory {
  private landmarks: Landmark[] = [];
  private capacity = 200;
  private nextId = 1;

  configure(capacity: number) {
    this.capacity = capacity;
  }

  reset() {
    this.landmarks = [];
  }

  /** 记录（或强化）一个 landmark：同描述就近复用，成功次数 +1；sceneHash 记录当时场景 */
  remember(description: string, x: number, y: number, appHint?: string, sceneHash?: string): Landmark {
    const existing = this.landmarks.find(l =>
      l.description.toLowerCase() === description.toLowerCase() &&
      Math.abs(l.normalized.x - x) < 0.02 && Math.abs(l.normalized.y - y) < 0.02,
    );
    if (existing) {
      existing.successCount++;
      existing.lastUsedAt = Date.now();
      existing.sceneHash = sceneHash ?? existing.sceneHash; // 场景指纹滚动更新
      return existing;
    }

    const landmark: Landmark = {
      id: this.nextId++,
      description,
      appHint,
      sceneHash,
      normalized: { x, y },
      successCount: 1,
      lastUsedAt: Date.now(),
    };
    this.landmarks.push(landmark);

    // 容量驱逐：优先淘汰「低成功 + 陈旧」的条目
    if (this.landmarks.length > this.capacity) {
      this.landmarks.sort((a, b) =>
        (b.successCount * b.lastUsedAt) - (a.successCount * a.lastUsedAt));
      this.landmarks = this.landmarks.slice(0, this.capacity);
    }
    return landmark;
  }

  /**
   * 召回 top-k：score = overlap + 0.05*min(successCount,6) + 时间衰减 + 场景匹配加成。
   * currentSceneHash 与 landmark 形成时同场景（相似度>=0.9）⇒ +0.3 强加成 ——
   * 「还是那个界面」时，历史坐标的置信度显著更高。
   */
  recall(query: string, k = 5, currentSceneHash?: string): Array<Landmark & { score: number }> {
    const qTokens = tokenize(query);
    const now = Date.now();
    return this.landmarks
      .map(l => {
        const lTokens = tokenize(l.description + ' ' + (l.appHint ?? ''));
        const text = overlapCoefficient(qTokens, lTokens);
        const trust = 0.05 * Math.min(l.successCount, 6);
        const ageH = (now - l.lastUsedAt) / 3_600_000;
        const recency = 0.1 * Math.exp(-ageH / 24);
        let sceneBonus = 0;
        if (currentSceneHash && l.sceneHash && similarity(currentSceneHash, l.sceneHash) >= 0.9) {
          sceneBonus = 0.3;
        }
        return { ...l, score: Math.round((text + trust + recency + sceneBonus) * 1000) / 1000 };
      })
      .filter(l => l.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

// 单例：跨会话的肌肉记忆
export const uiMemory = new UIMemory();
