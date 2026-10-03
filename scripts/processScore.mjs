#!/usr/bin/env node
// scripts/processScore.mjs
// W3-8(E4 免标注过程评分器)CLI 壳 —— 逻辑全部在 src/processScore.ts(纯函数核心),
// 本文件只做:参数解析 / 读入 / 渲染 / JSON 落盘。防御式:错误路径打印友好信息
// 并以非零码退出,绝不吐 stack、绝不抛。
//
// 用法: node scripts/processScore.mjs <journal.jsonl> [--out <report.json>]
//                                            [--threshold <0..1>] [--late-bias <0..1>]
// 输出: stdout 人类可读摘要;默认落盘 <journal.jsonl>.score.json(--out 覆盖)。
//
// 兼容性:核心是 .ts(Node 原生不认)。Node >= 22.18 内置类型剥离直接跑;
// Node 22.6–22.17 需 --experimental-strip-types —— 本壳检测后以该旗标透明重启
// 自身一次(execArgv 检查防二次重启),调用方命令行保持 `node scripts/processScore.mjs`。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

// W3-8:类型剥离缺席 ⇒ 重启自身带上旗标(仅一次)
if (!process.features.typescript && !process.execArgv.includes('--experimental-strip-types')) {
  const [maj, min] = process.versions.node.split('.').map(Number);
  const stripCapable = maj >= 23 || (maj === 22 && min >= 6);
  if (!stripCapable) {
    console.error(`[ProcessScore] Node ${process.versions.node} 不支持类型剥离(需 >= 22.6);` +
      '请升级 Node 或用 --experimental-strip-types 显式运行。');
    process.exit(1);
  }
  const relaunched = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', SELF, ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
  process.exit(relaunched.status ?? 1);
}

// ── W3-8:参数解析(未知旗标当位置参数处理 —— 缺参打印用法退出 1) ──
const argv = process.argv.slice(2);
const positional = [];
let outPath;
let threshold;
let lateBias;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') outPath = argv[++i];
  else if (a === '--threshold') threshold = Number(argv[++i]);
  else if (a === '--late-bias') lateBias = Number(argv[++i]);
  else if (a === '--help' || a === '-h') {
    console.log('用法: node scripts/processScore.mjs <journal.jsonl> [--out <report.json>] ' +
      '[--threshold <0..1>] [--late-bias <0..1>]');
    process.exit(0);
  } else positional.push(a);
}
if (positional.length < 1) {
  // W3-8:缺文件参数 ⇒ 用法提示,退出 1(友好信息,不抛)
  console.error('用法: node scripts/processScore.mjs <journal.jsonl> [--out <report.json>] ' +
    '[--threshold <0..1>] [--late-bias <0..1>]');
  process.exit(1);
}

const journalPath = positional[0];

let text;
try {
  text = readFileSync(journalPath, 'utf8');
} catch (e) {
  console.error(`[ProcessScore] 读入失败: ${journalPath} — ${e?.message ?? e}`);
  process.exit(1);
}

// W3-8:核心加载与评分(核心零依赖 ⇒ strip-types 下直接可载)
const { scoreJournalText, renderProcessScore } = await import(
  new URL('../src/processScore.ts', import.meta.url).href
);
const report = scoreJournalText(text, { lowStepThreshold: threshold, lateBias: lateBias });

console.log(renderProcessScore(report));
console.log(`source: ${journalPath}`);

const target = outPath ?? journalPath + '.score.json';
try {
  writeFileSync(target, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`report: ${target}`);
} catch (e) {
  console.error(`[ProcessScore] 报告落盘失败: ${target} — ${e?.message ?? e}`);
  process.exit(1);
}

// W3-8:ok=false = 评分器内部兜底捕获(防御产物)—— 调用方以非零码感知
process.exit(report.ok ? 0 : 1);
