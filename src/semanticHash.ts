// src/semanticHash.ts
// 认知升维公共地基：零依赖 subword 哈希嵌入（Skill Embedding / 任务相关度共用）。
// 原理（fastText 风格的工程极简版）：
//   分词（复用 uiMemory.tokenize 的中英文分词律）→ 每个词再拆字符 n-gram →
//   32 位 FNV-1a 全域哈希做桶键（精确哈希、近零碰撞）→ 累加权重 → 归一化。
// 效果：「整理数据」与「筛选数据」虽无重合词，但 n-gram（数据/筛选→整理的字符簇）
//   使向量夹角足够近 —— 零样本泛化的最小可信实现。
// 工程承诺：零模型下载、零网络、纯 CPU 微秒级、JSON 可序列化（随 checkpoint 存活）。
// J 纪元修正：删除从未被使用的 `DIMS = 256` 死常量 —— embed() 实际用 32 位
// FNV-1a 全域做桶键（无 mod 压缩），头注"哈希到固定桶空间"描述的语义从未实现。
import { tokenize } from './uiMemory';
import { toEnglish } from './dialects/bilingual';
// ΝΩ-41（方言克隆律）：本地 FNV-1a 副本退役 —— 单源 src/dialects/random.ts
// （逐字节同实现，桶键不变；金样 test/no41.dialectClones.test.ts）。
import { fnv1a } from './dialects/random';

const NGRAM_MIN = 2;    // 字符 n-gram 下界（中文 bigram / 英文子词）
const NGRAM_MAX = 4;    // 上界：太长泛化弱，太短碰撞多

export interface SparseVector {
  /** [桶号, 权重] 有序对（桶号升序，JSON 数组天然可序列化） */
  dims: Array<[number, number]>;
  norm: number;
}

/** 提取一个 token 的全部字符 n-gram */
function ngrams(token: string): string[] {
  const out: string[] = [];
  if (token.length <= NGRAM_MAX) {
    out.push(token); // 短词本身就是自己的 n-gram（完整词权重最高）
    return out;
  }
  for (let n = NGRAM_MIN; n <= NGRAM_MAX; n++) {
    for (let i = 0; i <= token.length - n; i++) {
      out.push(token.slice(i, i + n));
    }
  }
  return out;
}

/** 文本 → 稀疏向量。词级 1.0 权重 + n-gram 0.5 权重（词形相近但非同词的贡献减半） */
export function embed(text: string): SparseVector {
  const buckets = new Map<number, number>();
  // ΝΩ-29（跨语系语义盲区修复）：字符级 n-gram 对中英跨语系对零共享子串（'整理' vs
  // 'filter' ⇒ FNV 桶零相交 ⇒ cosine 恒 0）。分词后先经零依赖双语词表桥把中文 UI
  // 高频词归一到英文侧再 n-gram；未命中 token 原样透传，故同语系无命中输入的
  // 输出逐字节不变（test/no29.bilingual.test.ts 执法）。
  for (const token of toEnglish(tokenize(text))) {
    const tb = fnv1a(token);
    buckets.set(tb, (buckets.get(tb) ?? 0) + 1.0);
    for (const g of ngrams(token)) {
      const b = fnv1a('§' + g); // 前缀隔离：n-gram 与整词不共桶
      buckets.set(b, (buckets.get(b) ?? 0) + 0.5);
    }
  }
  const dims = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0]) // 桶号有序：cosine 可走双指针线性合并
    .map(([b, w]): [number, number] => [b, Math.round(w * 1000) / 1000]);
  // norm 从取整后的权重计算（与 dims 同源）：保证 cosine(v, v) === 1 精确成立
  let sq = 0;
  for (const [, w] of dims) sq += w * w;
  return { dims, norm: Math.sqrt(sq) };
}

/** 余弦相似度 0~1（非负权重空间，末端钳制防浮点越界）。任一空向量 ⇒ 0 */
export function cosine(a: SparseVector, b: SparseVector): number {
  if (a.dims.length === 0 || b.dims.length === 0 || a.norm === 0 || b.norm === 0) return 0;
  let dot = 0;
  let i = 0, j = 0;
  while (i < a.dims.length && j < b.dims.length) {
    const [ba, wa] = a.dims[i];
    const [bb, wb] = b.dims[j];
    if (ba === bb) { dot += wa * wb; i++; j++; }
    else if (ba < bb) i++;
    else j++;
  }
  return Math.min(1, dot / (a.norm * b.norm));
}
