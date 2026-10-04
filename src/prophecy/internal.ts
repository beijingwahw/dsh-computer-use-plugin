// src/prophecy/internal.ts
// W6-2（doctor smell.over-engineering 清偿）：自 index.ts 低风险分区提取 —— 内部
// 纯工具（零异常）整体搬迁。行为零变化；仅 index.ts 消费（不进公开面）。
// ΑΩ-R18：屏型量化方言（quantizedScreenType）新铸于此；D-G2 粗层方言
// （coarseScreenType）自 index.ts 随迁至此 —— 惊异读面的层级匹配需要两者，
// 值定义留在 internal 内可避免 index↔internal 的值环（index 经再分发保持
// 公开导入面逐字节不变）。

/** 概率夹域下界（算法形状字面量 —— 与 index 同源随迁） */
export const PROB_EPSILON = 1e-9;

/**
 * ΝΩ-11：结算惊异的读数夹帽（bits，冻结常量）—— 一切 surpriseBits 的上界。
 * 信息论上界论证：惊异是单一转移的谢农信息量 −log₂P(实际目的地)，其「真实
 * 判别信息」受证据窗口有界性约束——账本是环形 500 条（CAPACITY），任一
 * (屏型,动作) 格在窗口内可分辨的后继至多 500 个 ⇒ 均匀最坏惊异 log₂500 ≈
 * 8.97 bits；12 bits（2¹² = 4096 ≫ 500）是留一档余量的宽松上界，真实
 * hit/miss 读数（Laplace 平滑下常见 0~3.2 bits）零影响。唯一能越界的是退化
 * 定价的数值伪影：回退面 p→1 夹取后 miss 定价 −log₂(1−p) 逼到 PROB_EPSILON
 * =1e-9 地板 ⇒ ~29.9 bits 离群，会把错题本的平均惊异与排序单条拉爆。夹帽后
 * 该伪影钉在 12 bits（仍是账内最响——排序方向不变，只是不再无量纲爆炸）。
 * 下界 0 同律夹取（防御负读数）。纯函数消费（clampSurpriseBits），永不抛。
 */
export const SURPRISE_MAX_BITS = 12;

/** ΝΩ-11：惊异夹 [0, SURPRISE_MAX_BITS]（纯函数；非法输入 ⇒ 0 诚实下界） */
export function clampSurpriseBits(bits: number): number {
  const v = typeof bits === 'number' && Number.isFinite(bits) ? bits : 0;
  return Math.min(SURPRISE_MAX_BITS, Math.max(0, v));
}

import type { ProphecyRecord } from './index';
import type { WorldModel } from '../knowledge/contracts';
// ΑΩ-R18：内核键消费（零新依赖 —— kernel/registry 是纯内存单例，无 IO）。
// 未注册 ⇒ getOrDefault 原样回声常量缺省，行为与常量档逐字节一致；注册后
// （key 'prophecy.quantKeepHex'，区间 [8,16]）即可在运行期调档。
import { kernelRegistry } from '../kernel/registry';

// ─── 屏型量化方言（ΑΩ-R18：预言主键的抖动吸收层） ───

/** 闭环 dhash 方言长度（hex 字符 = 64 位）：量化桥只作用于恰此长度的 hex 指纹 */
const DHASH_HEX_LEN = 16;
/** 量化档位缺省（hex 字符）：上 12 字 = 上 48 位 = dhash 8×8 网格上 6 行（屏上 3/4） */
export const QUANT_KEEP_HEX = 12;
/** 量化档位可行下界：主键不得粗于 D-G2 粗层（上 32 位）—— exact>quant>coarse 层级序的不变式 */
export const QUANT_MIN_KEEP_HEX = 8;
/** 量化档位可行上界：16 = 不量化（主键退回原始 dhash —— 旧行为的逃生门） */
export const QUANT_MAX_KEEP_HEX = 16;
/** 量化档位内核键（ΑΩ-R18）：入册即运行期可调，未注册 ⇒ 常量缺省零行为变化 */
export const PROPHECY_QUANT_KERNEL_KEY = 'prophecy.quantKeepHex';

/**
 * 屏型量化（ΑΩ-R18，纯函数，永不抛）：恰 16 hex 字的闭环 dhash ⇒ 保留上
 * keep（缺省 12）字、低位**掩没为 '0'**（长度保持 —— 掩没不是截断：Q(x) 与
 * x 恒同长，低位本已归零的指纹量化后逐字节不变）。其余一切（非 hex / 非 16
 * 字 —— 世界模型聚类 id 'screen-12'、测试方言 'AAA'、64 位二进制串）⇒ 原样
 * 返回（旧方言零漂移）。
 *
 * 为什么掩没低 16 位（末 4 hex 字 = dhash 网格下 2 行 = 屏幕下 1/4 条带）：
 *   · dhash 8×8 row-major（首字符 = 最高位 = 第 0 行），末 4 字 = 第 6/7 行 =
 *     屏幕底部条带 —— 桌面像素抖动的正源（任务栏时钟、托盘动画、通知角标、
 *     底部光标停留）恰住此带；掩没 ⇒ 「同场景不同抖动」映射同键，转移证据
 *     在量化键上累积、预言非平凡可达（R18 主诉：原 64 位全量键几乎每屏唯一
 *     ⇒ 精确通道结构性查无 ⇒ 命中率趋零）；
 *   · 上 48 位（6 行 = 3/4 屏）保留布局判别力 —— 不同屏不因量化撞键；
 *   · 不掩更多（低 32 位）：那一档的粗化已由 D-G2 coarseScreenType 作回退层
 *     承担；主键若与之同粗，层级塌缩、错题本格被过度汇聚（失手不可归因）；
 *   · 不掩更少（仅末 8 位 = 1 行）：盖不住底部条带的 8×8 下采样插值渗漏
 *     （相邻行有重采样溢出，任务栏内容常抹到第 6 行）。
 * 档位经内核键 PROPHECY_QUANT_KERNEL_KEY 可调（8..16；16 = 关量化回到旧行
 * 为），读侧就地夹取 —— 未注册时与常量缺省逐字节一致。
 */
export function quantizedScreenType(screenType: string): string {
  try {
    const s = typeof screenType === 'string' ? screenType : '';
    if (s.length !== DHASH_HEX_LEN || !/^[0-9a-f]+$/i.test(s)) return s;
    const raw = kernelRegistry.getOrDefault(PROPHECY_QUANT_KERNEL_KEY, QUANT_KEEP_HEX);
    const keep = Math.min(QUANT_MAX_KEEP_HEX, Math.max(QUANT_MIN_KEEP_HEX, Math.round(raw)));
    if (keep >= DHASH_HEX_LEN) return s;
    return s.slice(0, keep) + '0'.repeat(DHASH_HEX_LEN - keep);
  } catch {
    return typeof screenType === 'string' ? screenType : ''; // 量化绝不抛（运行层铁律）
  }
}

/** 粗层屏型前缀长度（hex 字符）：闭环 dhash 16 hex 字 ⇒ 前 8 字符 = 上 32 位梯度 */
export const COARSE_PREFIX_HEX = 8;

/**
 * 屏型粗化（纯函数，永不抛 —— D-G2 身份桥，ΑΩ-R18 自 index.ts 随迁）：hex
 * 方言指纹截前 COARSE_PREFIX_HEX 字符；非 hex / 不长于前缀 ⇒ 原样返回（旧
 * 方言零漂移 —— 世界模型聚类 id 不经 dhash 面，双写与回退对它们天然跳过）。
 */
export function coarseScreenType(screenType: string): string {
  const s = typeof screenType === 'string' ? screenType : '';
  if (s.length <= COARSE_PREFIX_HEX) return s;
  return /^[0-9a-f]+$/i.test(s) ? s.slice(0, COARSE_PREFIX_HEX) : s;
}

// ─── 内部纯工具（零异常） ───

/** 非空字符串守卫 */
export function nonEmptyStr(v: unknown): boolean {
  return typeof v === 'string' && v.length > 0;
}

/** 安全时钟读数：注入钟缺席/抛错 ⇒ Date.now；永不抛 */
export function safeNow(injected: (() => number) | undefined): number {
  try {
    if (typeof injected === 'function') {
      const t = injected();
      if (typeof t === 'number' && Number.isFinite(t)) return t;
    }
  } catch { /* 坏钟 ⇒ 系统钟兜底 */ }
  return Date.now();
}

/** 展示位截断（journal 一行的 Token 纪律：指纹全量留在账本，注记只留锚点） */
export function shortId(s: string): string {
  return s.length > 16 ? `${s.slice(0, 16)}…` : s;
}

/** 结果解析：Result 形状的成功值（坏形状/坏值 ⇒ null —— 防御式读模型） */
export function resultValue<T>(r: unknown): T | null {
  if (!r || typeof r !== 'object' || (r as { ok?: unknown }).ok !== true) return null;
  const v = (r as { value?: unknown }).value;
  return (v ?? null) as T | null;
}

/**
 * 结算惊异差值（bits）—— 铸预言的自误定价（纯函数，永不抛）。
 * 优先走世界模型现成的 surprise() 读面（Laplace 平滑惊讶，与 D-7 计费器同一
 * 口径 —— 绝不复制实现，只复用读面）；模型缺席/抛错/坏值 ⇒ 按预言自身定价
 * 回退：miss 为 −log₂(1−p)（预言落空的惊异 —— 越自信错得越响，恒正），
 * hit 为 −log₂(p)（言中残差，≥0）。ΝΩ-11：两条通道的读数一律夹
 * [0, SURPRISE_MAX_BITS=12]（信息论上界论证见常量注——回退面 p→1 的 miss
 * 原生 ~29.9 bits 是 ε 地板伪影，不是真实判别信息）。
 */
export function settleSurpriseBits(
  record: ProphecyRecord,
  actualType: string,
  outcome: 'hit' | 'miss',
  worldModel: WorldModel | null | undefined,
): number | undefined {
  try {
    if (worldModel && typeof worldModel.surprise === 'function') {
      // ΑΩ-R18：惊异读面按预言来源层对键（exact=原始指纹 / quant=量化格 /
      // coarse=粗格），目的地一律经量化折算 —— 与引擎回灌写面同一方言（表内
      // 目的地恒为量化身份），读写的键粒度两侧一致（不得 fine↔coarse 串味）。
      const fromKey =
        record.predictedVia === 'coarse' ? coarseScreenType(record.screenType)
          : record.predictedVia === 'quant' ? quantizedScreenType(record.screenType)
            : record.screenType;
      const r = worldModel.surprise(fromKey, record.actionKey, quantizedScreenType(actualType));
      const v = resultValue<{ bits?: unknown }>(r);
      if (v && typeof v.bits === 'number' && Number.isFinite(v.bits) && v.bits >= 0) {
        // ΝΩ-11：读面惊异同律夹帽（模型读数也受窗口有界性约束 —— 上界论证见
        // SURPRISE_MAX_BITS；真实读数 ≪ 12，夹帽只拦数值伪影）
        return Math.round(clampSurpriseBits(v.bits) * 1e6) / 1e6;
      }
    }
  } catch { /* 模型故障 ⇒ 回退自误定价（绝不炸结算） */ }
  try {
    const p = typeof record.predictedProb === 'number' && Number.isFinite(record.predictedProb)
      ? Math.min(1, Math.max(0, record.predictedProb))
      : 0.5; // 无概率读数 ⇒ 中性 0.5（不自夸也不自贬）
    if (outcome === 'hit') {
      const q = Math.min(1, Math.max(PROB_EPSILON, p));
      return Math.round(clampSurpriseBits(-Math.log2(q)) * 1e6) / 1e6;
    }
    const q = Math.min(1 - PROB_EPSILON, Math.max(PROB_EPSILON, 1 - p));
    // 夹 (0,1) ⇒ 恒正；ΝΩ-11 夹帽 —— p→1 时 −log₂(1e-9)≈29.9 bits 的离群钉在 12
    return Math.round(clampSurpriseBits(-Math.log2(q)) * 1e6) / 1e6;
  } catch {
    return undefined; // 数学库故障（理论上不可达）⇒ 惊异缺席，绝不抛
  }
}
