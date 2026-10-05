// src/dialects/canonical.ts
// ΠΑΝ-49（canonical 单源收编）：稳定序列化（键排序 canonical JSON）的唯一出处。
//
// 收编前全库 6 份同族实现已实证漂移（C1-9 H1）：journal.ts 的 ΝΩ-24 加固
//（深度上限 + WeakSet 环检测）只进了 journal 真身，notary/primitives.ts 与
// sandbox/log.ts 的「复刻」掉队 ⇒ journal 合法入链的深嵌套/环形 args 在 notary
// 章③前缀重走重算出不同字节 ⇒ 永久误红「re-walk diverges」；federation/sync、
// skillLibrary.signatures、sandbox/memory 三份方言又在 undefined 键处理与
// 环哨兵上各持微差。本文件以 journal.ts:172 的 ΝΩ-24 版本为准收编为单源
//（dialects 是零出边基座 —— 无 src 内 import，正适合承载全库共享原语），
// 全部 6 个消费点改为 import 此处；病态载荷（深嵌套/环形）行为全库一致。
//
// 语义（以 ΝΩ-24 为准，哨兵全库统一 '"#unserializable"'）：
//   · 原始值：JSON.stringify(v)（undefined 顶位 ⇒ 'null' —— 全函数恒返回 string）；
//   · 对象：自有键字典序 + **undefined 值键与缺键同域**（JSON.stringify 落盘时
//     丢弃前者 —— 若哈希域区分两者，落盘-恢复往返后重算即误报断链）；
//   · 深度上限（缺省 64）：超过 ⇒ 降级哨兵（序列化稳定、绝不抛；哨兵在哈希域
//     确定性一致 —— 同一病态载荷每次铸出同一指纹，verify 重算同哨兵，链不断）；
//   · 环检测：WeakSet 只记当前递归路径（出口即删）—— 同一子对象被两键引用是
//     合法 DAG 载荷（JSON.stringify 同律逐处展开），只有真环降级哨兵；
//   · BigInt / 抛错 getter 等 JSON.stringify 硬拒值仍照实抛出（journal 的
//     append 防御 catch 与 appendPreDispatch 的 fail-closed 立法依赖此行为）。
// 纯函数、零依赖（dialects 零出边律）、绝不吞病态载荷的既有抛出语义。

/** ΠΑΝ-49：深度上限缺省（与 journal ΝΩ-24 的 CANONICAL_MAX_DEPTH 同值） */
export const CANONICAL_DEFAULT_MAX_DEPTH = 64;
/** ΠΑΝ-49：病态载荷降级哨兵（全库统一 —— 此前 sandbox/memory 用 '"<cycle>"' 已对齐废弃） */
export const CANONICAL_SENTINEL = '"#unserializable"';

/** ΠΑΝ-49：canonical 序列化选项（全部可选 —— 缺省即 ΝΩ-24 形态） */
export interface CanonicalJsonOptions {
  /** 递归深度上限（缺省 64；须为正有限整数，否则回落缺省） */
  maxDepth?: number;
  /** 病态载荷（超深/环形）降级哨兵（缺省 '"#unserializable"'） */
  sentinel?: string;
}

/**
 * 稳定序列化单源（纯函数）：同一对象永远产生同一字符串（哈希链的前提）。
 * 深嵌套超限与真环 ⇒ 哨兵串（绝不无限递归）；BigInt/硬拒值 ⇒ 照实抛
 *（调用方防御 catch —— 与 journal ΝΩ-24 契约逐字节同律）。
 */
export function canonicalJson(value: unknown, opts?: CanonicalJsonOptions): string {
  const maxDepth =
    typeof opts?.maxDepth === 'number' && Number.isFinite(opts.maxDepth) && opts.maxDepth >= 1
      ? Math.floor(opts.maxDepth)
      : CANONICAL_DEFAULT_MAX_DEPTH;
  const sentinel =
    typeof opts?.sentinel === 'string' && opts.sentinel !== '' ? opts.sentinel : CANONICAL_SENTINEL;
  return walk(value, 0, new WeakSet<object>(), maxDepth, sentinel);
}

function walk(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  maxDepth: number,
  sentinel: string,
): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (depth > maxDepth || seen.has(value as object)) return sentinel;
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      return '[' + value.map(v => walk(v, depth + 1, seen, maxDepth, sentinel)).join(',') + ']';
    }
    const rec = value as Record<string, unknown>;
    return '{' + Object.keys(rec).sort()
      .filter(k => rec[k] !== undefined)
      .map(k => JSON.stringify(k) + ':' + walk(rec[k], depth + 1, seen, maxDepth, sentinel)).join(',') + '}';
  } finally {
    seen.delete(value as object); // 出口即删：只记当前递归路径（DAG 合法，真环才哨兵）
  }
}
