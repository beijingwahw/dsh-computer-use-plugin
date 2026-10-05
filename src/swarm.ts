// src/swarm.ts
// C-5 群体智能进化网络：从「单机监控」到「万机共享」。
// 三层架构（对基础设施诚实：本地今日可成，联邦协议就绪即燃）：
//   层一 经验晶体 —— 从 journal 链上聚合 (场景指纹, 工具, 成败) 元组，跨会话随 checkpoint 存活。
//        「一机学习，本机万次共享」现在就成立。
//   层二 联邦协议 —— 匿名经验包（只有哈希与统计，零截图零文本，隐私结构不可泄密）。
//        swarmEndpoint 为空 ⇒ 零网络行为（与 localVisionApi 同款优雅降级）。
//        W4-2（G3 策略联邦）：packet 升 v2 —— 可选技能联邦段（指纹+参数统计摘要，
//        经注入的提供者铸造，见 attachSkillFederation / src/skillFederation.ts）。
//   层三 UI 漂移预测 —— 数字孪生务实版：记录「坐标失效→重定位成功」的漂移增量，
//        下次会话 predict() 预补偿。官方更新前的全局预测需群体中心（未来基建）。
// 工程铁律：上报异步非阻塞（fire-and-forget + AbortSignal.timeout），
//        热路径（截图/点击）永不 await 网络 —— 遥测是旁路义务，不是主路债主。
// ΠΑΝ-75（swarm 隐私）：层二上行的 driftEvents 场景指纹经本地盐 HMAC 私有标签
//        出境（privateSceneTag）—— sceneHash 不再裸出境，群体中心无法用已知
//        屏幕 dHash 做匹配识别；本地漂移模型保持真值（盐只划在上行面）。
import { journal, type JournalEntry } from './journal';
import { Telemetry } from './telemetry';
// ΠΑΝ-75（swarm 隐私）：driftEvents 上行的 sceneHash 加本地哈希盐 —— HMAC 私有
// 场景标签（node:crypto，进程内一次性随机密钥；与联邦 DP 种子的 HMAC 方言同族）
import { createHmac, randomBytes } from 'node:crypto';
// W4-2（G3 策略联邦）：仅类型借用（编译期擦除）—— 技能联邦段的载荷与账目形状。
// 运行时零依赖（skillFederation → swarm 是单向的；本行不产生模块环）。
import type { SkillFederationUpload, SkillFederationLedgerStats } from './skillFederation';

/** 层一：经验晶体。key = `${场景指纹前8位}:${工具}` —— 匿名聚合，天然去隐私 */
export interface ExperienceCrystal {
  key: string;
  successes: number;
  attempts: number;
  /** 最近一次坐标漂移（UI 漪变的局部证据） */
  lastDrift?: { dx: number; dy: number; at: number };
}

/** 层二：群体经验包。schema 版本化 —— 群体中心的协议演进不破坏旧客户端。
 *  W4-2（G3 策略联邦）：schema 升级 v2 —— 新增可选技能联邦段（skills）；向后
 *  兼容律：老 peer 按 JSON 宽容语义忽略未知段，v1 字段（instanceId/crystals/
 *  driftEvents/dp_epsilon）形状与语义逐字节不变。 */
export interface SwarmPacket {
  schema: 1 | 2;
  /** 匿名实例 ID（启动时随机生成，不含任何用户信息） */
  instanceId: string;
  crystals: Array<{ key: string; successRate: number; attempts: number }>;
  driftEvents: Array<{ sceneHash: string; dx: number; dy: number }>;
  /** W4-2：技能联邦段（v2 在场；缺省/未接线 ⇒ undefined —— 老 peer 零感知） */
  skills?: SwarmSkillFederationSection;
}

/** W4-2：packet v2 的技能联邦段 —— 上传载荷白名单形状（指纹 + 数值槽统计 +
 *  reliability + 使用计数，全部带 Laplace 噪声；绝无原始文本/坐标序列/截图引用） */
export interface SwarmSkillFederationSection {
  v: 1;
  /** 本段使用的差分隐私 ε（与 packet 级 dp_epsilon 同源 —— 分段申报，审计面） */
  dpEpsilon: number;
  uploads: SkillFederationUpload[];
}

/** W4-2：swarm 与技能联邦模块的接线面（依赖注入 —— swarm 不 import 其运行时）。
 *  uploads 的 ε/随机流由 buildPacket 透传（与晶体噪声同一 DP 纪律与确定性缝）。 */
export interface SwarmSkillFederationProvider {
  uploads(dpEpsilon: number, uniform: () => number): SkillFederationUpload[];
  ledgerStats(): SkillFederationLedgerStats;
}

/** 层三：UI 漂移预测模型（场景指纹 → 漂移向量的最近邻回归）。
 *  F-5 Kalman 化（第六维·压缩认知）：等权滑动均值 → 各向同性标量 Kalman 滤波。
 *  状态空间模型：真实漂移做随机游走（过程噪声 Q —— UI 是非平稳世界，旧观测
 *  应被遗忘）；观测噪声 R。Q=R=1 ⇒ 稳态增益 K=2/3：新观测权重 2/3 ——
 *  「最近一次改版」比「三个月前的平均」更代表当下（非平稳跟踪的本质收益）。
 *  置信度升级：n 饱和 × 后验方差收缩（不再只是计数 —— 估计质量本身入账）。 */
export interface DriftModel {
  observe(sceneHash: string, dx: number, dy: number): void;
  predict(sceneHash: string): { dx: number; dy: number; confidence: number } | null;
  dump(): Array<{ sceneHash: string; dx: number; dy: number; n: number }>;
  restore(data: Array<{ sceneHash: string; dx: number; dy: number; n: number }> | undefined): void;
}

/** Kalman 常数（算法形状字面量：Q/R 比值决定遗忘速率 —— K=2/3 是「三观测收敛、
 *  新观测主导」的甜点，非旋钮；预测门控 6 位与潜意识既视感同律） */
const KF_Q = 1; // 过程噪声方差（世界会变）
const KF_R = 1; // 观测噪声方差
/** 单场景漂移估计（双轴各向同性：同一 P，x/y 独立滤波） */
interface KalmanDrift {
  sceneHash: string;
  x: number;
  y: number;
  /** 后验方差（预测不确定度 —— 置信度的方差面） */
  p: number;
  n: number;
}

const INSTANCE_ID = 'inst-' + Math.random().toString(36).slice(2, 10);

// ─── ΠΑΝ-75（swarm 隐私）：上行 sceneHash 的 HMAC 私有标签 ───
//
// 缝隙（C1-3 M-8）：buildPacket 的 driftEvents 携带**全量 dHash 场景指纹明文**
// 上行 —— 群体中心拿已知屏幕的 dHash 即可匹配识别「某实例访问过哪些屏幕」，跨
// 周期（INSTANCE_ID 稳定）还能重建指纹序列；H-5 差分隐私只盖晶体 successRate，
// driftEvents 的 dx/dy 是 Kalman 均值、sceneHash 裸奔。
// 修复律：sceneHash 出境前经本地盐 HMAC（keyed pseudonym）——
//   · 密钥 = 进程启动时一次性 randomBytes(32)（模块私有，绝不外发；公开面
//     （INSTANCE_ID/标签值/dx/dy）推不出）；
//   · 标签 = HMAC-SHA256(key, sceneHash) 前 16 hex —— 同场景同标签（进程内
//     稳定可聚合），异场景异标签（雪崩），**不可与已知屏幕的 dHash 匹配**（无钥
//     的攻击者对标签做字典匹配的路径被 HMAC 摘断 —— 与联邦 DP 种子的
//     HMAC(K_fed, digest_id) 同方言）；
//   · 本地 drifts 数组保持真值（predict/dump/restore 语义零变化 —— 盐只划在
//     上行面，与 H-5「隐私边界只划在上传面」同律）；
//   · 诚实边界：跨实例的场景聚合随私有盐失效（各实例标签不可互对）—— 这是
//     「不再裸出境」的直接代价，群体中心的跨机漂移聚合留待共享盐的部署选项。

/** ΠΑΝ-75：sceneHash 私有标签的 HMAC 密钥（进程一次性随机 —— 模块私有绝不外发） */
const scenePrivacyKey = randomBytes(32);

/**
 * ΠΑΝ-75：上行场景标签（纯函数、绝不抛）：HMAC-SHA256(进程私有盐, sceneHash)
 * 前 16 hex。同输入恒同输出（进程内稳定）；密钥缺席/故障 ⇒ 确定性降级标签
 *（'salted-err'，绝不裸回原 dHash —— 出境方向宁可废标签不泄指纹）。导出为
 * 公开面：执法测试与聚合端文档共用同一实现。
 */
export function privateSceneTag(sceneHash: string): string {
  try {
    if (typeof sceneHash !== 'string' || sceneHash === '') return 'salted-void';
    return createHmac('sha256', scenePrivacyKey).update(sceneHash).digest('hex').slice(0, 16);
  } catch {
    return 'salted-err'; // 防御带：绝不裸回原指纹
  }
}

/**
 * G-4 经验贝叶斯收缩（第七维·过程感知）：稀疏成功率的防过信回撤。
 *
 * 数学（Stein 悖论/James-Stein 家族）：多维场景下逐组估计被全局基率收缩后
 * 总误差更小 —— 直觉违反但定理成立。工程形式（收缩系数 k=3，算法形状字面量）：
 *   rate* = [n/(n+k)]·rate + [k/(n+k)]·globalRate
 * n=2 时权重仅 40% —— 「2 次尝试 100% 成功」的诚实读数不是 100% 而是向
 * 基率回撤后的值；n=20 时权重 87% —— 证据充分，收缩几近无感。
 * 消费方：counterfactual 的 shrunkRate（what_if 前瞻显示双率 —— 原始与收缩，
 * 让模型自己看见证据的稀疏程度）。纯函数导出：统计原子的测试面。
 */
export function shrinkRate(successes: number, attempts: number, globalRate: number, k = 3): number {
  if (attempts <= 0) return globalRate;
  const w = attempts / (attempts + k);
  return Math.round((w * (successes / attempts) + (1 - w) * globalRate) * 1000) / 1000;
}

/** 场景指纹的汉明距离（swarm 内实现，避免与 perceptualHash 产生模块环） */
function hashDistance(a: string, b: string): number {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

class Swarm {
  private crystals = new Map<string, ExperienceCrystal>();
  private drifts: KalmanDrift[] = [];
  private endpoint = '';
  private syncIntervalMs = 300_000;
  private crystalCapacity = 500;
  private driftCapacity = 200;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSyncAt = 0;
  /** J 纪元修正：已结晶条目的身份游标（WeakSet）—— 消灭重复计数。
   *  注释宣称"增量式——只消费上次结晶之后的新条目"，旧实现每次全量遍历且无游标：
   *  crystalize 的调用点极多（5 分钟定时器 / 每次 what_if / counterfactual /
   *  checkpoint），同一批日志被反复累加进 attempts/successes —— 成功率先验
   *  系统性膨胀，与 G-4 收缩的"诚实读数"哲学相悖。
   *  用对象身份（WeakSet）而非数值序号：journal 条目无 seq 字段，且给条目
   *  补 seq 会改变 canonical 哈希域、破坏旧链 verify —— 身份游标零迁移成本。
   *  已知残差（诚实边界）：checkpoint 恢复的条目是新对象，跨会话会再结晶一次。 */
  private crystallized = new WeakSet<JournalEntry>();
  /** N/P 纪元：跨会话消费水位 —— checkpoint 保存时随行（= 保存时的窗口长度，
   *  即已全量消费的前缀）。P 纪元修正（第十二只 bug）：位置在 journal 滑窗
   *  驱逐下**不稳定**（容量 1000 饱和后 entries.length 恒 plateau，水位恒
   *  等于 plateau ⇒ 会话内每轮前缀跳过吞掉全部新条目 —— swarm 中途永久失聪）。
   *  修正律：会话内**只信身份游标**（WeakSet，驱逐免疫）；水位只在 restore
   *  后首轮（armed）作前缀跳过，跳过的条目同时标记进 WeakSet（身份接管），
   *  首轮后缴械。跨会话语义不变：恢复的前缀不再重复入账。 */
  private consumedWatermark = 0;
  /** restore 武装位：true = 下一轮 crystalize 执行前缀跳过（跨会话水位执法） */
  private watermarkArmed = false;
  /** W4-2（G3 策略联邦）：技能联邦接线面（null = 未接线 —— packet 无技能段、
   *  report 联邦技能账诚实归零；reset 不摘线 —— 接线是宿主配置不是数据） */
  private skillFedProvider: SwarmSkillFederationProvider | null = null;

  /** W4-2：接/摘技能联邦提供者（wireSwarmSkillFederation 的宿主接线缝；测试注入桩） */
  attachSkillFederation(provider: SwarmSkillFederationProvider | null): void {
    this.skillFedProvider =
      provider && typeof provider.uploads === 'function' && typeof provider.ledgerStats === 'function'
        ? provider
        : null; // 形状不合法按未接线处理（防御式，绝不抛）
  }

  configure(endpoint: string, syncIntervalMs: number, crystalCapacity: number): void {
    this.endpoint = endpoint;
    this.syncIntervalMs = syncIntervalMs;
    this.crystalCapacity = Math.max(10, crystalCapacity);
  }

  /**
   * 层一：从 journal 链上结晶经验。增量式 —— 只消费上次结晶之后的新条目
   * （WeakSet 身份游标执法，见字段注）。在 checkpoint 保存与定时器时调用，热路径零成本。
   */
  crystalize(): number {
    const entries = journal.list(true);
    let added = 0;
    let index = 0;
    // P 纪元律：仅 restore 后首轮做前缀跳过（水位 = 保存时已消费的前缀长度）；
    // 跳过的条目同时入 WeakSet（身份游标接管 —— 后续轮次驱逐免疫）。
    const skipUntil = this.watermarkArmed ? this.consumedWatermark : 0;
    this.watermarkArmed = false;
    for (const e of entries) {
      index += 1;
      if (index <= skipUntil) {
        this.crystallized.add(e); // P 纪元：跳过即标记 —— 身份游标从此接管该前缀
        continue;
      }
      if (this.crystallized.has(e)) continue; // 身份游标：已消费的条目不再入账
      // 观察串格式 `#N dHash=<hex> popup=...` —— 提取指纹而非截断原文（键匿名且稳定）
      const hash = e.observe ? /dHash=([0-9a-fA-F]+)/.exec(e.observe)?.[1] : undefined;
      if (!hash) continue; // 无指纹锚点的条目无法结晶（不计入游标 —— 观察补充后仍可结晶）
      this.crystallized.add(e);
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
    this.consumedWatermark = entries.length; // N 纪元：全量消费后水位推进
    // 容量收敛：按尝试数降序保留（高频经验优先存活）
    if (this.crystals.size > this.crystalCapacity) {
      const kept = [...this.crystals.values()]
        .sort((a, b) => b.attempts - a.attempts)
        .slice(0, this.crystalCapacity);
      this.crystals = new Map(kept.map(c => [c.key, c]));
    }
    return added;
  }

  /** 层三：坐标漂移观测（uiMemory 重定位成功时调用）—— F-5 Kalman 更新 */
  observeDrift(sceneHash: string, dx: number, dy: number): void {
    const existing = this.drifts.find(d => d.sceneHash === sceneHash);
    if (!existing) {
      // 首观测：扩散先验（K=1 全信首观测），P ← R
      this.drifts.push({ sceneHash, x: dx, y: dy, p: KF_R, n: 1 });
      if (this.drifts.length > this.driftCapacity) this.drifts.shift();
      return;
    }
    // 预测步（随机游走：x 不变，P ← P + Q）+ 更新步（K = P⁻/(P⁻+R)）
    const pPred = existing.p + KF_Q;
    const k = pPred / (pPred + KF_R);
    existing.x += k * (dx - existing.x);
    existing.y += k * (dy - existing.y);
    existing.p = (1 - k) * pPred;
    existing.n++;
  }

  /** 层三：漂移预测 —— 最近邻场景指纹的 Kalman 估计（汉明距离 ≤ 6 视为同场景变体） */
  predictDrift(sceneHash: string): { dx: number; dy: number; confidence: number } | null {
    let best: KalmanDrift | null = null;
    let bestDist = Infinity;
    for (const d of this.drifts) {
      const dist = hashDistance(d.sceneHash, sceneHash);
      if (dist < bestDist) { bestDist = dist; best = d; }
    }
    if (!best || bestDist > 6) return null;
    // 置信度 = 观测数饱和 × 后验方差收缩（估计质量本身入账 —— F-5 的透明面）
    const confidence = Math.min(1, best.n / 5) * Math.max(0, 1 - Math.min(1, best.p / 2));
    return { dx: best.x, dy: best.y, confidence: Math.round(confidence * 100) / 100 };
  }

  /**
   * F-6 经验晶体反事实（第六维·压缩认知）：给定当前场景指纹，返回同场景的
   * 历史工具成功率统计 —— 「在这块屏幕上，群体经验说哪条路走得通」。
   * 消费方：what_if 的经验前瞻通道（反事实推理从历史重放升级为经验先验）。
   * 先验≠保证：attempts≥2 才入场（单次经验是噪声不是信号 —— 与 buildPacket 同律）。
   * G-4：successRate 附 shrunkRate（经验贝叶斯收缩 —— 见 shrinkRate 注记）。
   */
  counterfactual(sceneHash?: string, k = 3): Array<{ scene: string; tool: string; successRate: number; shrunkRate: number; attempts: number }> {
    this.crystalize();
    const prefix = sceneHash?.slice(0, 8).toLowerCase();
    const out: Array<{ scene: string; tool: string; successRate: number; shrunkRate: number; attempts: number }> = [];
    // G-4 全局基率：所有晶体的合并成功率（收缩的锚 —— 稀疏证据向它回撤）
    let gS = 0, gA = 0;
    for (const c of this.crystals.values()) { gS += c.successes; gA += c.attempts; }
    const globalRate = gA > 0 ? gS / gA : 0.5;
    for (const c of this.crystals.values()) {
      const [scene, tool] = c.key.split(':');
      if (prefix && scene !== prefix) continue;
      if (c.attempts < 2) continue;
      out.push({
        scene,
        tool,
        successRate: Math.round((c.successes / c.attempts) * 1000) / 1000,
        shrunkRate: shrinkRate(c.successes, c.attempts, globalRate),
        attempts: c.attempts,
      });
    }
    return out.sort((a, b) => b.attempts - a.attempts).slice(0, k);
  }

  /** 层二：构造匿名经验包（零截图零文本 —— 只有哈希前缀与统计量）。
   *  H-5 差分隐私（创世纪）：dpEpsilon 在场时对 successRate 施加 Laplace 噪声
   *  （尺度 1/(ε·attempts) —— rate 的敏感度补偿）并声明 dp_epsilon 字段。
   *  隐私语义：单次尝试的增删对上传统计的影响被 ε 定量约束（Dwork 机制）；
   *  本地晶体保持真值 —— 联邦是增益不是依赖，隐私边界只划在上传面。 */
  buildPacket(dpEpsilon = 1, uniform: () => number = Math.random): SwarmPacket {
    const crystals = [...this.crystals.values()]
      .filter(c => c.attempts >= 2) // 单次经验不上报：噪声大于信号
      .slice(0, 100)
      .map(c => {
        const rawRate = Math.round((c.successes / c.attempts) * 1000) / 1000;
        // H-5：rate 敏感度 = 1/attempts（单次成败翻转幅度）⇒ Laplace 噪声尺度
        const scale = 1 / (dpEpsilon * c.attempts);
        const u = uniform();
        const noise = -scale * Math.sign(u - 0.5) * Math.log(1 - 2 * Math.abs(u - 0.5) + 1e-12);
        return {
          key: c.key,
          successRate: Math.round(Math.min(1, Math.max(0, rawRate + noise)) * 1000) / 1000,
          attempts: c.attempts,
        };
      });
    // ΠΑΝ-75：sceneHash 经本地盐 HMAC 私有标签出境（不再裸 dHash —— 群体中心
    // 无法与已知屏幕字典匹配识别；本地 drifts 保持真值，盐只划在上行面）
    const driftEvents = this.drifts.slice(-20).map(d => ({ sceneHash: privateSceneTag(d.sceneHash), dx: Math.round(d.x * 1000) / 1000, dy: Math.round(d.y * 1000) / 1000 }));
    // W4-2：技能联邦段（提供者在场才铸；防御式 —— 提供者任何故障都吞掉成
    // 「无技能段」，绝不炸 packet：联邦是增益不是依赖）。ε 与随机流与晶体噪声
    // 同源透传（同一次 buildPacket 的 DP 纪律与确定性测试缝统一）。
    let skills: SwarmSkillFederationSection | undefined;
    try {
      if (this.skillFedProvider) {
        skills = { v: 1, dpEpsilon: dpEpsilon, uploads: this.skillFedProvider.uploads(dpEpsilon, uniform) ?? [] };
      }
    } catch {
      skills = undefined; // 提供者故障：诚实降级为无技能段
    }
    const packet: SwarmPacket & { dp_epsilon: number } = {
      schema: 2, instanceId: INSTANCE_ID, crystals, driftEvents,
      dp_epsilon: dpEpsilon,
      skills,
    };
    return packet;
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

  /** 手动触发一次同步（卸载钩子调用；同样非阻塞）。
   *  ΑΩ-R34：旧注释称「swarm_sync 工具」—— 本插件无此工具面（工具注册表里
   *  技能联邦同步由 federation_sync 承担、且走 federation/ 证据账流程），
   *  syncNow 的现实调用方只有卸载钩子（index.ts 卸载时序）。 */
  syncNow(): void {
    if (!this.endpoint) return;
    this.crystalize();
    this.fireUpload();
  }

  /** 本地结晶报告（get_metrics / 自省消费 —— 群体智慧对模型可见）。
   *  W4-2：新增 federatedSkills 段 —— 晶体层的联邦技能账（本地命中/激活计数、
   *  dormant/active 候选规模、Thompson 尝试数；未接线 ⇒ wired:false 诚实归零）。 */
  report(): { crystals: number; topRoutes: Array<{ key: string; successRate: number; attempts: number }>; driftModels: number; lastSyncAt: number; endpoint: string; federatedSkills: SkillFederationLedgerStats } {
    const topRoutes = [...this.crystals.values()]
      .sort((a, b) => b.attempts - a.attempts)
      .slice(0, 5)
      .map(c => ({ key: c.key, successRate: Math.round((c.successes / c.attempts) * 1000) / 1000, attempts: c.attempts }));
    // W4-2：联邦技能账（防御式拉取 —— 提供者故障 ⇒ 未接线形状，绝不炸 report）
    let federatedSkills: SkillFederationLedgerStats = {
      wired: false, candidates: 0, dormant: 0, active: 0, localHits: 0, activations: 0, thompsonAttempts: 0, lastReceivedAt: 0,
    };
    try {
      if (this.skillFedProvider) {
        const stats = this.skillFedProvider.ledgerStats();
        if (stats && typeof stats === 'object') federatedSkills = stats;
      }
    } catch {
      /* 保持未接线形状 */
    }
    return {
      crystals: this.crystals.size,
      topRoutes,
      driftModels: this.drifts.length,
      lastSyncAt: this.lastSyncAt,
      endpoint: this.endpoint || '(disabled)',
      federatedSkills,
    };
  }

  dump(): { crystals: Array<ExperienceCrystal>; drifts: Array<{ sceneHash: string; dx: number; dy: number; n: number }>; consumedWatermark: number } {
    return {
      consumedWatermark: this.consumedWatermark,
      crystals: [...this.crystals.values()].slice(0, this.crystalCapacity),
      // F-5：外部契约形状不变（dx/dy/n）—— Kalman 内部 x/y/p 不外泄（封装）
      drifts: this.drifts.map(d => ({ sceneHash: d.sceneHash, dx: d.x, dy: d.y, n: d.n })),
    };
  }

  restore(data: { crystals?: ExperienceCrystal[]; drifts?: Array<{ sceneHash: string; dx: number; dy: number; n: number }>; consumedWatermark?: number } | undefined): void {
    if (!data) return;
    for (const c of data.crystals ?? []) {
      if (c && typeof c.key === 'string') this.crystals.set(c.key, c);
    }
    if (Array.isArray(data.drifts)) {
      // 旧档水合：均值估计 → P=R（诚实初值 —— 估计质量从「一次观测」起算）
      this.drifts = data.drifts.slice(-this.driftCapacity).map(d => ({
        sceneHash: d.sceneHash, x: d.dx, y: d.dy, p: KF_R, n: Math.max(1, d.n ?? 1),
      }));
    }
    // P 纪元修正（第十一只 bug）：dump 持久化了 consumedWatermark、restore 却
    // 静默丢弃（类型里声明了、函数体从未赋值）—— 崩溃恢复语境下 N-1 的根除
    // 名存实亡（前缀全量重结晶）。水位置入 + 武装下一轮前缀跳过。
    const wm = data.consumedWatermark;
    this.consumedWatermark = typeof wm === 'number' && Number.isFinite(wm) && wm > 0
      ? Math.floor(wm)
      : 0;
    this.watermarkArmed = this.consumedWatermark > 0;
  }

  /**
   * Q 纪元（Q-7）：晶体 Thompson 采样排序 —— Beta(s+1, f+1) 一次抽样代替
   * 点估计排序（H-3 模态仲裁同律的迁移）。价值：低证据晶体（3/3 全胜）的
   * 抽样分布宽，有机会被抽高而获探索机会 —— 反事实推理不再被早期幸运儿
   * 垄断；高证据晶体分布窄，长期排序由真值主导。探索按证据不足程度
   * **成比例**发生（Thompson 采样最优性），不是 ε 贪心的均匀扰动。
   */
  thompsonTopRoutes(k = 5, uniform: () => number = Math.random): Array<{ key: string; successRate: number; attempts: number }> {
    const sampler = new Telemetry(); // H-3 的 Beta 采样器（实例面）—— 复用不复制
    return [...this.crystals.values()]
      .map(c => ({ c, sampled: sampler.sampleBeta(c.successes + 1, c.attempts - c.successes + 1, uniform) }))
      .sort((a, b) => b.sampled - a.sampled)
      .slice(0, k)
      .map(({ c }) => ({ key: c.key, successRate: Math.round((c.successes / c.attempts) * 1000) / 1000, attempts: c.attempts }));
  }

  reset(): void {
    // W4-2：技能联邦提供者不随 reset 摘除 —— 接线是宿主配置不是数据（晶体/漂移
    // 是学习数据故清，提供者是结构故留；测试用 attachSkillFederation(null) 摘线）
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.crystals.clear();
    this.drifts = [];
  }
}

export const swarm = new Swarm();
