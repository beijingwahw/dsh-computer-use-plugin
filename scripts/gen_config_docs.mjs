// scripts/gen_config_docs.mjs
// 配置文档生成器（ΝΩ-42 配置治理）：运行时 import src/config.ts 的 Config Schema，
// 遍历 schemastery 节点树（type / meta.description / meta.default），铸 docs/config-schema.md 总表。
// 用法：node --import ./test/register.mjs scripts/gen_config_docs.mjs [输出路径]
// 特性：零依赖（node 内建 + 项目既有 schemastery）；确定性输出（无时间戳）⇒ 幂等
//（内容与现存文件一致时不落盘，保 mtime）；生成 < 150 行视为配置表意外萎缩，非零退出报警。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_OUT = fileURLToPath(new URL('../docs/config-schema.md', import.meta.url));
const MIN_LINES = 150;

// ── schemastery 节点元信息读取（meta 优先，根属性兜底） ──
function metaOf(node) {
  return {
    type: node?.type ?? 'any',
    description: node?.meta?.description ?? node?.description ?? '',
    default: node?.meta?.default ?? node?.default,
  };
}

// ── 类型标注：object 之外的复合节点（array/dict/union/intersect/lazy）给可读标签 ──
function typeLabel(node, depth = 0) {
  const t = node?.type;
  if (depth > 4) return String(t ?? 'any');
  switch (t) {
    case 'array': return `array<${typeLabel(node.inner, depth + 1)}>`;
    case 'dict': return `dict<${typeLabel(node.inner, depth + 1)}>`;
    case 'union': return (node.list ?? []).map((s) => typeLabel(s, depth + 1)).join(' | ') || 'union';
    case 'intersect': return 'intersect';
    case 'lazy': return 'lazy';
    default: return String(t ?? 'any');
  }
}

// ── 对象树遍历：object 节点按声明序下沉（嵌套键以 a.b 点号命名），其余节点为叶子行 ──
export function buildRows(schema) {
  const rows = [];
  (function walk(node, prefix) {
    if (!node || (typeof node !== 'object' && typeof node !== 'function')) return;
    if (node.type === 'object' && node.dict && typeof node.dict === 'object') {
      for (const [key, child] of Object.entries(node.dict)) {
        walk(child, prefix ? `${prefix}.${key}` : key);
      }
      return;
    }
    const meta = metaOf(node);
    rows.push({ key: prefix, type: typeLabel(node), default: meta.default, description: meta.description });
  })(schema, '');
  return rows;
}

// ── 单元格格式化：管道转义 + 折行压平，防长描述击穿表格 ──
function cell(text) {
  return String(text ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function fmtDefault(value) {
  if (value === undefined) return '—';
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// ── 纯渲染：行序 = Schema 声明序（Object.entries 保插入序）⇒ 确定性 ──
export function renderMarkdown(rows) {
  const lines = [
    '# 配置字段总表（config-schema）',
    '',
    '> 本文件由 `scripts/gen_config_docs.mjs` 从 `src/config.ts` 的 Config Schema 自动生成，请勿手改（重跑即重铸）。',
    '> 生成命令：`node --import ./test/register.mjs scripts/gen_config_docs.mjs`',
    '',
    `共 ${rows.length} 个配置字段。`,
    '',
    '| 键 | 类型 | 缺省 | 描述 |',
    '| --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    lines.push(`| ${cell(row.key)} | ${cell(row.type)} | ${cell(fmtDefault(row.default))} | ${cell(row.description)} |`);
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const outPath = resolve(process.argv[2] ?? DEFAULT_OUT);
  const { Config } = await import('../src/config');
  // schemastery 节点是可调用函数（typeof 'function'），携带 type/dict/meta 属性
  if (!Config || (typeof Config !== 'function' && typeof Config !== 'object')) {
    console.error('gen_config_docs: Config schema 未导出或不可遍历');
    process.exit(1);
  }
  const rows = buildRows(Config);
  if (!rows.length) {
    console.error('gen_config_docs: 遍历得到 0 行 —— Schema 树结构异常（object/dict 丢失？）');
    process.exit(1);
  }
  const content = renderMarkdown(rows);
  const lineCount = content.split('\n').length;
  if (lineCount < MIN_LINES) {
    console.error(`gen_config_docs: 生成 ${lineCount} 行 < ${MIN_LINES} 行下限 —— 配置表意外萎缩，拒绝落盘`);
    process.exit(1);
  }
  // 幂等：内容一致则不写（保 mtime，构建缓存友好）
  let prev = null;
  try {
    prev = await readFile(outPath, 'utf8');
  } catch {
    /* 首次生成 */
  }
  if (prev !== content) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, content, 'utf8');
    console.log(`gen_config_docs: ${outPath} 写入 ${rows.length} 字段 / ${lineCount} 行`);
  } else {
    console.log(`gen_config_docs: ${outPath} 内容未变（${rows.length} 字段 / ${lineCount} 行），跳过写入`);
  }
}

// 经 loader 直跑时执行；被测试 import 时不执行（node:test 下 process.argv[1] 非 本脚本）
const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  await main();
}
