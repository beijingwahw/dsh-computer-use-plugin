#!/usr/bin/env node
// scripts/gen_confusables.mjs
// #10（O 纪元）：Unicode confusables.txt 全表蒸馏生成器。
// 数据血缘：scripts/confusables-source.txt（Unicode Consortium, UTS #39 confusables.txt）
//   → 蒸馏规则：原型（映射目标序列）小写后纯 [a-z0-9] 的条目全收（其余与拉丁
//     风险词匹配无关）→ 键 = 源码点小写字形，值 = 原型小写串。
//   → 再生命令：node scripts/gen_confusables.mjs（更新 source 后重跑即可）。
// 与策展/算术族的关系：生成表打底，riskGate 的策展跨脚本核心与码点算术族
//   覆写在后 —— 既有行为零回归，生成表只填空白。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'confusables-source.txt'), 'utf8');

const version = src.match(/^# Version:\s*(.+)$/m)?.[1] ?? 'unknown';
const date = src.match(/^# Date:\s*(.+)$/m)?.[1]?.trim() ?? 'unknown';

const map = new Map();
let total = 0;
for (const line of src.split('\n')) {
  const m = line.match(/^([0-9A-Fa-f]+)\s+;\s+((?:[0-9A-Fa-f]+\s*)+);\s*MA/);
  if (!m) continue;
  total++;
  const proto = m[2].trim().split(/\s+/).map(cp => String.fromCodePoint(parseInt(cp, 16))).join('').toLowerCase();
  if (!/^[a-z0-9]+$/.test(proto)) continue;
  const key = String.fromCodePoint(parseInt(m[1], 16)).toLowerCase();
  // 同键多值取先出现者（consortium 表按视觉相似度聚类，首条 = 规范原型）
  if (!map.has(key)) map.set(key, proto);
}

const entries = [...map.entries()]
  .sort((a, b) => a[0].codePointAt(0) - b[0].codePointAt(0))
  .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
  .join('\n');

const out = `// src/riskGate.confusables.generated.ts —— 本文件由 scripts/gen_confusables.mjs 生成，勿手改。
// 数据血缘：Unicode confusables.txt（UTS #39）Version ${version}，${date}。
// 蒸馏：原型小写纯 [a-z0-9] 的全量条目（${map.size} 条，源表 ${total} 条数据行）。
// 再生：node scripts/gen_confusables.mjs
export const CONFUSABLES_ASCII: Readonly<Record<string, string>> = {
${entries}
};
`;

writeFileSync(join(here, '..', 'src', 'riskGate.confusables.generated.ts'), out);
console.log(`generated ${map.size} entries from ${total} data lines (Unicode ${version}).`);
