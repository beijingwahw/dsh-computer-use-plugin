// src/dialects/index.ts
// ΑΩ-R10（方言三重复制单源化）：方言单源模块桶文件 —— 三重复制纯函数方言
// （汉明距离 / PRNG 与散列 / 中英分词）的唯一出处，消费者一律自此 import。
export { hammingDistanceHex } from './hashing.js';
export { fnv1a, mulberry32 } from './random.js';
export { CJK_RE, STOPWORDS, tokenizeText } from './tokenizer.js';
