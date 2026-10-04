// src/vlm/providers/ensemble.types.ts
// W6-2（doctor smell.over-engineering 清偿）：自 ensemble.ts 低风险分区提取
// —— 协议类型面（合议庭的查询/成员结果/判词契约，纯类型）整体搬迁。零运行时代码，
// 行为零变化；ensemble.ts 以再导出保持导入面不变。
import type { VisionImage } from './types';

// ─── 协议类型 ───

/** 合议庭问询：一次并席发问的请求（各字段语义同 VisionChatRequest，无 maxRetries） */
export interface EnsembleQuery {
  /** 截图序列（至少一帧才有视觉语义） */
  images: VisionImage[];
  /** 系统提示词（askVerdict / askElements 缺省注入各自裁决/接地系统词） */
  system?: string;
  /** 用户指令（与截图一起进最后一条 user 消息） */
  prompt: string;
  /** 最大生成 token 数（透传各成员适配器缺省） */
  maxTokens?: number;
  /** 采样温度（透传各成员适配器缺省） */
  temperature?: number;
  /** true 时文本问询也请求结构化输出 */
  jsonMode?: boolean;
  /** 单次 fetch 尝试超时毫秒（透传各成员适配器缺省） */
  timeoutMs?: number;
}

/** 庭员普查条目：每颗脑在本次问询中的成败、原文与延迟（census 透明律的最小单元） */
export interface EnsembleMemberResult {
  /** 庭员标识（VisionProvider.id —— 归因主键） */
  id: string;
  /** 该成员本次问询是否成功（未配置 / 失败 / 违约上抛 ⇒ false） */
  ok: boolean;
  /** 成功时的模型回复原文（jsonMode 路径为 raw 原文；失败恒 ''，但 chatJson 失败可带 raw） */
  text: string;
  /** 该成员整次调用的墙钟延迟 */
  latencyMs: number;
  /** 失败原因（ok:false 时必有；已经 sanitizeError 密钥卫生处理） */
  error?: string;
}

/** 文本合议答案：融合后的文本 + 庭内一致性测度 + 法定人数档位 + 全员普查 */
export interface EnsembleTextAnswer {
  /** 融合后的答案（代表簇首家的文本；全败为 ''） */
  text: string;
  /** 成员间 normalizedLevenshtein 两两相似度均值（0..1；单家成功 = 1，全败 = 0） */
  agreement: number;
  /** 法定人数档位：unanimous 全体同簇 / majority 最大簇占比 ≥0.5 / split 分裂 / degraded 无从合议 */
  quorum: 'unanimous' | 'majority' | 'split' | 'degraded';
  /** 全体庭员普查表（长度恒等于庭员数，含未配置成员的失败记账） */
  members: EnsembleMemberResult[];
}

/** 裁决合议判决：多数票判决 + 胜方置信 + 少数派点名 + 全员普查 */
export interface EnsembleVerdict {
  /** 判决：confirmed / refuted 多数票胜出；平票（含全垃圾载荷）⇒ uncertain */
  verdict: 'confirmed' | 'refuted' | 'uncertain';
  /** 胜方置信均值 × 胜方票数占比（uncertain 恒 0） */
  confidence: number;
  /** 少数派点名，格式 `${id}:${verdict}`（uncertain 平票时列出全部已投有效票） */
  dissents: string[];
  /** 全体庭员普查表 */
  members: EnsembleMemberResult[];
}
