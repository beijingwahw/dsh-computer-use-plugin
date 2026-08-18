// src/swarm.ts
// C-5 群体智能进化网络：从「单机监控」到「万机共享」。
// 三层架构（对基础设施诚实：本地今日可成，联邦协议就绪即燃）：
//   层一 经验晶体 —— 从 journal 链上聚合 (场景指纹, 工具, 成败) 元组，跨会话随 checkpoint 存活。
//        「一机学习，本机万次共享」现在就成立。
//   层二 联邦协议 —— 匿名经验包（只有哈希与统计，零截图零文本，隐私结构不可泄密）。
//        swarmEndpoint 为空 ⇒ 零网络行为（与 localVisionApi 同款优雅降级）。
//   层三 UI 漂移预测 —— 数字孪生务实版：记录「坐标失效→重定位成功」的漂移增量，
//        下次会话 predict() 预补偿。官方更新前的全局预测需群体中心（未来基建）。
// 工程铁律：上报异步非阻塞（fire-and-forget + AbortSignal.timeout），
//        热路径（截图/点击）永不 await 网络 —— 遥测是旁路义务，不是主路债主。
import { journal } from './journal';

/** 层一：经验晶体。key = `${场景指纹前8位}:${工具}` —— 匿名聚合，天然去隐私 */
export interface ExperienceCrystal {
  key: string;
  successes: number;
  attempts: number;
  /** 最近一次坐标漂移（UI 漪变的局部证据） */
  lastDrift?: { dx: number; dy: number; at: number };
}

/** 层二：群体经验包。schema 版本化 —— 群体中心的协议演进不破坏旧客户端 */
export interface SwarmPacket {
  schema: 1;
  /** 匿名实例 ID（启动时随机生成，不含任何用户信息） */
  instanceId: string;
  crystals: Array<{ key: string; successRate: number; attempts: number }>;
  driftEvents: Array<{ sceneHash: string; dx: number; dy: number }>;
}

/** 层三：UI 漂移预测模型（场景指纹 → 漂移向量的最近邻回归） */
export interface DriftModel {
  observe(sceneHash: string, dx: number, dy: number): void;
  predict(sceneHash: string): { dx: number; dy: number; confidence: number } | null;
  dump(): Array<{ sceneHash: string; dx: number; dy: number; n: number }>;
  restore(data: Array<{ sceneHash: string; dx: number; dy: number; n: number }> | undefined): void;
}

const INSTANCE_ID = 'inst-' + Math.random().toString(36).slice(2, 10);

/** 场景指纹的汉明距离（swarm 内实现，避免与 perceptualHash 产生模块环） */
function hashDistance(a: string, b: string): number {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

class Swarm {
  private crystals = new Map<string, ExperienceCrystal>();
  private drifts: Array<{ sceneHash: string; dx: number; dy: number; n: number }> = [];
  private endpoint = '';
  private syncIntervalMs = 300_000;
  private crystalCapacity = 500;
  private driftCapacity = 200;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSyncAt = 0;

  configure(endpoint: string, syncIntervalMs: number, crystalCapacity: number): void {
    this.endpoint = endpoint;
    this.syncIntervalMs = syncIntervalMs;
    this.crystalCapacity = Math.max(10, crystalCapacity);
  }

  /**
   * 层一：从 journal 链上结晶经验。增量式 —— 只消费上次结晶之后的新条目。
   * 在 checkpoint 保存与定时器时调用，热路径零成本。
   */
  crystalize(): number {
    const entries = journal.list(true);
    let added = 0;
    for (const e of entries) {
      // 观察串格式 `#N dHash=<hex> popup=...` —— 提取指纹而非截断原文（键匿名且稳定）
      const hash = e.observe ? /dHash=([0-9a-fA-F]+)/.exec(e.observe)?.[1] : undefined;
      if (!hash) continue; // 无指纹锚点的条目无法结晶
      const key = `${hash.slice(0, 8).toLowerCase()}:${e.tool}`;
      let c = this.crystals.get(key);
      if (!c) {
        c = { key, successes: 0, attempts: 0 };
        this.crystals.set(key, c);
      }
      c.attempts++;
      if (e.status === 'SUCCESS' && e.effect_detected !== false) c.successes++;
      added++;
    }
    // 容量收敛：按尝试数降序保留（高频经验优先存活）
    if (this.crystals.size > this.crystalCapacity) {
      const kept = [...this.crystals.values()]
        .sort((a, b) => b.attempts - a.attempts)
        .slice(0, this.crystalCapacity);
      this.crystals = new Map(kept.map(c => [c.key, c]));
    }
    return added;
  }

  /** 层三：坐标漂移观测（uiMemory 重定位成功时调用） */
  observeDrift(sceneHash: string, dx: number, dy: number): void {
    // 同场景漂移向量滑动平均（n 为观测数，置信度的分母）
    const existing = this.drifts.find(d => d.sceneHash === sceneHash);
    if (existing) {
      existing.dx = (existing.dx * existing.n + dx) / (existing.n + 1);
      existing.dy = (existing.dy * existing.n + dy) / (existing.n + 1);
      existing.n++;
    } else {
      this.drifts.push({ sceneHash, dx, dy, n: 1 });
      if (this.drifts.length > this.driftCapacity) this.drifts.shift();
    }
  }

  /** 层三：漂移预测 —— 最近邻场景指纹的漂移向量（汉明距离 ≤ 6 视为同场景变体） */
  predictDrift(sceneHash: string): { dx: number; dy: number; confidence: number } | null {
    let best: { dx: number; dy: number; n: number } | null = null;
    let bestDist = Infinity;
    for (const d of this.drifts) {
      const dist = hashDistance(d.sceneHash, sceneHash);
      if (dist < bestDist) { bestDist = dist; best = d; }
    }
    if (!best || bestDist > 6) return null;
    // 置信度 = 观测次数的饱和函数 × 指纹距离衰减
    const confidence = Math.min(1, best.n / 5) * Math.max(0, 1 - bestDist / 10);
    return { dx: best.dx, dy: best.dy, confidence: Math.round(confidence * 100) / 100 };
  }

  /** 层二：构造匿名经验包（零截图零文本 —— 只有哈希前缀与统计量） */
  buildPacket(): SwarmPacket {
    const crystals = [...this.crystals.values()]
      .filter(c => c.attempts >= 2) // 单次经验不上报：噪声大于信号
      .slice(0, 100)
      .map(c => ({
        key: c.key,
        successRate: Math.round((c.successes / c.attempts) * 1000) / 1000,
        attempts: c.attempts,
      }));
    const driftEvents = this.drifts.slice(-20).map(d => ({ sceneHash: d.sceneHash, dx: Math.round(d.dx * 1000) / 1000, dy: Math.round(d.dy * 1000) / 1000 }));
    return { schema: 1, instanceId: INSTANCE_ID, crystals, driftEvents };
  }

  /**
   * 层二：异步上报 —— 工程铁律的落点。
   * fire-and-forget：不返回 Promise 给调用方 await；超时即弃，失败静默（下次再试）。
   * 热路径（截图/点击）永不因网络阻塞：setInterval 与卸载钩子是仅有的触发点。
   */
  private fireUpload(): void {
    if (!this.endpoint) return;
    const packet = this.buildPacket();
    const body = JSON.stringify(packet);
    fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5_000),
    })
      .then(() => { this.lastSyncAt = Date.now(); })
      .catch(() => { /* 网络失败静默：联邦是增益不是依赖 */ });
  }

  /** 启动群体同步定时器（endpoint 未配置时零行为） */
  start(): void {
    if (!this.endpoint || this.timer) return;
    this.timer = setInterval(() => {
      this.crystalize();
      this.fireUpload();
    }, this.syncIntervalMs);
    // Node 定时器不阻止进程退出（DSH 卸载语义友好）
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref?.();
  }

  /** 手动触发一次同步（swarm_sync 工具 / 卸载钩子调用；同样非阻塞） */
  syncNow(): void {
    if (!this.endpoint) return;
    this.crystalize();
    this.fireUpload();
  }

  /** 本地结晶报告（get_metrics / 自省消费 —— 群体智慧对模型可见） */
  report(): { crystals: number; topRoutes: Array<{ key: string; successRate: number; attempts: number }>; driftModels: number; lastSyncAt: number; endpoint: string } {
    const topRoutes = [...this.crystals.values()]
      .sort((a, b) => b.attempts - a.attempts)
      .slice(0, 5)
      .map(c => ({ key: c.key, successRate: Math.round((c.successes / c.attempts) * 1000) / 1000, attempts: c.attempts }));
    return {
      crystals: this.crystals.size,
      topRoutes,
      driftModels: this.drifts.length,
      lastSyncAt: this.lastSyncAt,
      endpoint: this.endpoint || '(disabled)',
    };
  }

  dump(): { crystals: Array<ExperienceCrystal>; drifts: Array<{ sceneHash: string; dx: number; dy: number; n: number }> } {
    return {
      crystals: [...this.crystals.values()].slice(0, this.crystalCapacity),
      drifts: [...this.drifts],
    };
  }

  restore(data: { crystals?: ExperienceCrystal[]; drifts?: Array<{ sceneHash: string; dx: number; dy: number; n: number }> } | undefined): void {
    if (!data) return;
    for (const c of data.crystals ?? []) {
      if (c && typeof c.key === 'string') this.crystals.set(c.key, c);
    }
    if (Array.isArray(data.drifts)) this.drifts = data.drifts.slice(-this.driftCapacity);
  }

  reset(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.crystals.clear();
    this.drifts = [];
  }
}

export const swarm = new Swarm();
