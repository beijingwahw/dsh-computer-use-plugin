// src/dialects/index.ts
// ΑΩ-R10（方言三重复制单源化）：方言单源模块桶文件 —— 三重复制纯函数方言
// （汉明距离 / PRNG 与散列 / 中英分词）的唯一出处，消费者一律自此 import。
export { hammingDistanceHex } from './hashing';
export { fnv1a, mulberry32 } from './random';
export { CJK_RE, STOPWORDS, tokenizeText } from './tokenizer';
// ΠΑΝ-46：方言选项类型随桶导出（签名系消费方 semanticHash 的 signature 面）
export type { TokenizeOpts } from './tokenizer';
// ΠΑΝ-49（canonical 单源收编）：全库 6 份 canonical JSON 实现收编为单源
//（以 journal ΝΩ-24 版本为准 —— 深度上限 + 环检测守卫，哨兵全库统一），见 ./canonical。
export {
  canonicalJson,
  CANONICAL_SENTINEL,
  CANONICAL_DEFAULT_MAX_DEPTH,
  type CanonicalJsonOptions,
} from './canonical';
