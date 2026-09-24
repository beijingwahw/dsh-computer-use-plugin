// src/urlSense.ts
// ─── AA 纪元（AA-1 世界跳转引擎）：URL 感知 —— 纯函数，零依赖 ───
//
// 对症需求：「自动跳转网页链接」。屏幕上的 URL（聊天消息里、文档里、OCR
// 噪声里）不是控件 —— 点击它们要么被 Z-2 闸门拒绝（正文），要么点了没反应；
// 正确动作是把它交给操作系统壳层打开。本模块是 URL 的感知与安检：
//
//   1. 引号级精确提取：从自由文本（OCR 全文/控件名）中提取完整 URL 子串，
//      尾随标点剥离（中文句号/逗号/括号是 OCR 文本的常见粘连）；
//   2. 归一：www. 前缀补 https://（裸域名不猜 —— 精确性优先，与运动弧
//      引号锚定同律：打错一个字的 URL 与没打开一样）；
//   3. 安检：scheme 白名单 http/https —— file://（本地文件系统）、
//      javascript:（脚本执行）、data:（数据载荷）一律拒绝。跳转引擎
//      只允许把模型带向公开网页，不允许变成任意协议启动器。
//
// 拒绝语义与 intentGrammar 同方言：{ kind:'refused', reason } —— 运行层
// 永不抛错，「看不懂」以结构化拒绝返回。

/** URL 长度上限（RFC 7230 建议线的宽容值 —— 超长是解析噪声不是链接） */
const URL_MAX_LENGTH = 2048;

/** 提取结果上限（防爆量：一段文本里超过 16 个"URL"是正则误报潮） */
const EXTRACT_MAX = 16;

/** 允许的 scheme（白名单 —— 未列出的一律拒绝，包括大小写变体归一后） */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/** URL 字符集（RFC 3986 保留+非保留字符 + 括号；不含空白与引号 —— 含引号的
 *  "URL"是文本噪声。括号归属由尾随剥离的平衡律裁决） */
const URL_BODY = "[A-Za-z0-9\\-._~:/?#\\[\\]@!$&*+,;=%'()]";

/** 尾随标点剥离集：中文标点 + 西文标点（OCR 文本粘连的常见尾巴；不含 / 与 %）。
 *  半角括号不入此集 —— 由平衡律单独裁决。 */
const TRAILING_PUNCT = '.,;:!?。，；：！？）】］]》〉」』"\'`';

/** 前导包裹剥离集：OCR/排版把 URL 包在括号或书名号里 —— 开头的包裹符是
 *  文本噪声（URL 自身不可能以这些字符开头：scheme 是字母，www. 是 w） */
const LEADING_WRAPPER = '（([<«「《【『“"\'`';

/** 候选正则：显式 scheme（http(s)://…）或 www. 前缀域名 —— 裸域名不猜 */
const CANDIDATE_RE = new RegExp(
  `(?:https?://${URL_BODY}+|www\\.[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+(?::\\d{1,5})?(?:/${URL_BODY}*)?)`,
  'g',
);

/** 尾随标点剥离（多趟收敛 —— `))。` 与 `)，` 这类复合尾巴要剥干净）。
 *  括号平衡律：仅当 ')' 多于 '(' 时，尾随 ')' 才是文本粘连 —— 维基百科式
 *  URL（…wiki/Python_(lang)）的成对括号是 URL 的一部分，不许误剥。
 *  多趟的必要性：`)` 不必是串尾字符（`a)，` 要先剥 `，` 才轮到 `)`）。 */
function stripTrailingPunct(s: string): string {
  let out = s;
  let changed = true;
  while (changed) {
    changed = false;
    while (out.length > 0 && TRAILING_PUNCT.includes(out[out.length - 1])) {
      out = out.slice(0, -1);
      changed = true;
    }
    const open = (out.match(/\(/g) ?? []).length;
    const close = (out.match(/\)/g) ?? []).length;
    if (close > open) {
      out = out.slice(0, out.length - (close - open));
      changed = true;
    }
  }
  return out;
}

export interface UrlVerdict {
  kind: 'ok';
  /** 归一后的绝对 URL（scheme 在场，www. 补全 https://） */
  url: string;
}

export type UrlRefusal = { kind: 'refused'; reason: string };

/**
 * URL 候选归一与安检（纯函数）。
 * 输入：单个候选子串（可带尾随标点/包裹空白）。
 * 拒绝通道（全部结构化）：scheme 白名单外、无点主机、含空白/引号、超长、
 * URL 构造失败。精确性优先：宁可拒绝让模型看清楚，不要错 URL 落壳层。
 */
export function normalizeUrlCandidate(raw: string): UrlVerdict | UrlRefusal {
  let s = raw.trim();
  if (!s) return { kind: 'refused', reason: 'empty candidate' };
  if (s.length > URL_MAX_LENGTH) {
    return { kind: 'refused', reason: `length ${s.length} exceeds ${URL_MAX_LENGTH} (parse noise, not a link)` };
  }
  // 前导包裹剥离（（url）/「url」—— URL 自身不可能以包裹符开头）
  while (s.length > 0 && LEADING_WRAPPER.includes(s[0])) s = s.slice(1);
  s = stripTrailingPunct(s);
  if (!s) return { kind: 'refused', reason: 'candidate is pure punctuation' };
  if (/[\s"'<>]/.test(s)) {
    return { kind: 'refused', reason: 'URL contains whitespace/quotes (text noise, not a link)' };
  }
  // www. 前缀补全：唯一被授权的猜测（www. 是显式的网页自声明）
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    if (s.toLowerCase().startsWith('www.')) {
      s = `https://${s}`;
    } else {
      return { kind: 'refused', reason: 'no scheme and no www. prefix — bare domains are not guessed (precision-first)' };
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    return { kind: 'refused', reason: 'not a parseable URL' };
  }
  // scheme 白名单：大小写归一后核对（HTTP:// 的 host 解析会小写化，scheme 不会）
  if (!ALLOWED_SCHEMES.has(parsed.protocol.toLowerCase())) {
    return { kind: 'refused', reason: `scheme '${parsed.protocol}' outside allowlist [http, https] — this engine jumps to web pages only` };
  }
  // 主机健全性：有点（域名）或是 localhost（开发场景）；无点主机（http://foo）拒绝
  if (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost') {
    return { kind: 'refused', reason: `host '${parsed.hostname}' has no dot and is not localhost` };
  }
  return { kind: 'ok', url: parsed.toString() };
}

/**
 * 从自由文本提取全部合法 URL（去重保序，上限 16）。
 * 感知面：read_text 的 OCR 全文、交互性闸门的控件名 —— 「自动跳转」的燃料。
 */
export function extractUrls(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(CANDIDATE_RE)) {
    const v = normalizeUrlCandidate(m[0]);
    if (v.kind !== 'ok') continue;
    if (seen.has(v.url)) continue;
    seen.add(v.url);
    out.push(v.url);
    if (out.length >= EXTRACT_MAX) break;
  }
  return out;
}
