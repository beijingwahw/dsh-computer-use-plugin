#!/usr/bin/env node
// scripts/cycle_lint.mjs —— 依赖环执法器（ΝΩ-41）
//
// 立法背景：方言单源化（src/dialects/random.ts）要求消费方 import 单源 —— 每
// 新增一条 import 边都在改写模块依赖图。依赖图的无执法演化史已留下 15 个强连
// 通分量（SCC）；本脚本把「环」从口头债务铸成机械闸：零依赖（node:* 内建 +
// 自带 Tarjan）扫描 src 全部 .ts 的相对 import/export-from 边，区分运行时
// （value）与仅类型（type）边：
//   · SCC 内存在全 value 边闭环（运行时真环 —— bundler 循环依赖 / 初始化顺序
//     未定义）⇒ 列环并 exit 1；
//   · 环全部含 TYPE 边（import type / export type —— 编译后蒸发，运行时无环）
//     ⇒ warning：建议把环上残余 value 边降级为 import type。
// 边判定（保守向 value）：
//   import type {...} / export type {...} from          → TYPE
//   import { type A, type B } from（全部 specifier 带 type 前缀）→ TYPE
//   其余 import/export-from（含 default、*、裸副作用 import、动态 import()）→ VALUE
// 用法：node scripts/cycle_lint.mjs [--root src] [--quiet]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(REPO, process.argv.includes('--root') ? process.argv[process.argv.indexOf('--root') + 1] : 'src');
const QUIET = process.argv.includes('--quiet');

// ─── 文件收集 ───

function collectTs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...collectTs(p));
    else if (name.endsWith('.ts')) out.push(p); // .d.ts 也是图的一等节点
  }
  return out;
}

// ─── 源文本 → 边（comment/string 盲区安全的语句级扫描） ───

/** 剥注释（保留长度 —— 逐字符换空格，注释内伪 import 不入图），字符串字面量整体保留 */
function stripComments(text) {
  const out = text.split('');
  let i = 0;
  const n = text.length;
  let mode = 'code'; // code | line | block | sq | dq | tmpl
  const tmplStack = []; // 模板字面量内 ${ … } 的嵌套
  while (i < n) {
    const c = text[i];
    const next = i + 1 < n ? text[i + 1] : '';
    if (mode === 'code') {
      if (c === '/' && next === '/') { mode = 'line'; out[i] = out[i + 1] = ' '; i += 2; continue; }
      if (c === '/' && next === '*') { mode = 'block'; out[i] = out[i + 1] = ' '; i += 2; continue; }
      if (c === "'") { mode = 'sq'; i++; continue; }
      if (c === '"') { mode = 'dq'; i++; continue; }
      if (c === '`') { mode = 'tmpl'; i++; continue; }
      if (c === '}' && tmplStack.length > 0) { mode = tmplStack.pop(); i++; continue; }
      i++; continue;
    }
    if (mode === 'line') {
      if (c === '\n') mode = 'code';
      else out[i] = ' ';
      i++; continue;
    }
    if (mode === 'block') {
      if (c === '*' && next === '/') { out[i] = out[i + 1] = ' '; mode = 'code'; i += 2; continue; }
      out[i] = c === '\n' ? '\n' : ' '; // 保行号，抹内容
      i++; continue;
    }
    // 字符串态：保留原文（specifier 要读），只处理转义与闭界
    if (c === '\\') { i += 2; continue; }
    if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"')) { mode = 'code'; i++; continue; }
    if (mode === 'tmpl') {
      if (c === '`') { mode = tmplStack.length ? 'tmpl' : 'code'; i++; continue; }
      if (c === '$' && next === '{') { tmplStack.push('tmpl'); mode = 'code'; i += 2; continue; }
    }
    i++;
  }
  return out.join('');
}

/** 从一条 import/export 子句判定边种类：'type' | 'value' */
function clauseKind(keyword, clause) {
  const c = clause.replace(/\s+/g, ' ').trim();
  if (keyword === 'import' && /^type[\s{]/.test(c)) return 'type'; // import type …
  const brace = c.match(/\{([^}]*)\}/);
  if (!brace) return 'value'; // default 导入 / export * / 裸子句 —— 运行时边
  const specs = brace[1].split(',').map(s => s.trim().replace(/^type\s+/, '').trim()).filter(s => s.length > 0);
  if (specs.length === 0) return 'value';
  // 全部 specifier 带 type 前缀 ⇒ 仅类型边；任一裸名/default ⇒ value（保守）
  const allType = brace[1].split(',').map(s => s.trim()).filter(s => s.length > 0)
    .every(s => /^type\s+[\w$]+(\s+as\s+[\w$]+)?$/.test(s));
  return allType ? 'type' : 'value';
}

/** 解析相对 specifier → 仓库内绝对路径；解析失败返回 null（包导入/外域） */
function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null;
  let base = resolve(dirname(fromFile), spec);
  const cands = [];
  if (extname(base) === '.js' || extname(base) === '.mjs') base = base.slice(0, base.lastIndexOf('.'));
  cands.push(base + '.ts', base + '.tsx', join(base, 'index.ts'));
  for (const c of cands) {
    try { statSync(c); return c; } catch { /* 试下一个 */ }
  }
  return null;
}

/** 单文件 → 边列表 [{ to, kind }]（相对路径 only；同目标双语句时 value 优先在聚合处处理） */
function edgesOf(file) {
  const text = stripComments(readFileSync(file, 'utf8'));
  const edges = [];
  // import/export … from '…'（跨行子句，子句不含 ';'）
  const fromRe = /\b(import|export)\s+([^;'`]*?)\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = fromRe.exec(text)) !== null) {
    const spec = resolveSpec(file, m[3]);
    if (spec) edges.push({ to: spec, kind: clauseKind(m[1], m[2]) });
  }
  // 裸副作用 import './x'
  const bareRe = /\bimport\s*['"]([^'"]+)['"]/g;
  while ((m = bareRe.exec(text)) !== null) {
    const spec = resolveSpec(file, m[1]);
    if (spec) edges.push({ to: spec, kind: 'value' });
  }
  // 动态 import('./x') —— 运行时边
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynRe.exec(text)) !== null) {
    const spec = resolveSpec(file, m[1]);
    if (spec) edges.push({ to: spec, kind: 'value' });
  }
  return edges;
}

// ─── Tarjan SCC（迭代式 —— 零依赖、零递归深度风险） ───

function tarjan(nodes, adj) {
  const index = new Map(), low = new Map(), on = new Set(), sccOf = new Map();
  let counter = 0;
  const stack = [];
  const sccs = [];
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work = [[root, 0]]; // [节点, 邻居游标]
    const adjList = new Map(); // 本次 DFS 栈内的邻接快照（含 value/type 合并集）
    index.set(root, low.set(root, counter) && counter); counter++;
    stack.push(root); on.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const v = frame[0];
      const neighbors = adj.get(v) ?? [];
      if (frame[1] < neighbors.length) {
        const w = neighbors[frame[1]++];
        if (!index.has(w)) {
          index.set(w, counter); low.set(w, counter); counter++;
          stack.push(w); on.add(w);
          work.push([w, 0]);
        } else if (on.has(w)) {
          low.set(v, Math.min(low.get(v), index.get(w)));
        }
      } else {
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1][0];
          low.set(parent, Math.min(low.get(parent), low.get(v)));
        }
        if (low.get(v) === index.get(v)) {
          const comp = [];
          for (;;) {
            const w = stack.pop(); on.delete(w);
            comp.push(w); sccOf.set(w, sccs.length);
            if (w === v) break;
          }
          sccs.push(comp);
        }
      }
    }
  }
  return sccs;
}

/** 有向图找任一环（DFS 回边法），返回节点序列（环）或 null */
function findCycle(nodes, adj) {
  const color = new Map(); // 0=白 1=灰 2=黑
  const parent = new Map();
  for (const s of nodes) color.set(s, 0);
  for (const s of nodes) {
    if (color.get(s) !== 0) continue;
    const stack = [[s, 0]];
    color.set(s, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const v = frame[0];
      const neighbors = adj.get(v) ?? [];
      if (frame[1] < neighbors.length) {
        const w = neighbors[frame[1]++];
        if (color.get(w) === 1) { // 回边：parent 链回溯成环
          const cycle = [w, v];
          let cur = v;
          while (cur !== w) { cur = parent.get(cur); cycle.push(cur); }
          cycle.reverse();
          cycle.pop(); // 首尾同点
          return cycle;
        }
        if (color.get(w) === 0) { color.set(w, 1); parent.set(w, v); stack.push([w, 0]); }
      } else {
        color.set(v, 2);
        stack.pop();
      }
    }
  }
  return null;
}

// ─── 主流程 ───

const files = collectTs(ROOT).map(p => resolve(p)).sort();
const nodeSet = new Set(files);
const edgesByFile = new Map();
for (const f of files) {
  edgesByFile.set(f, edgesOf(f).filter(e => nodeSet.has(e.to)));
}

// 合并邻接表：同目标 value+type 双边 ⇒ value 胜（运行时边存在即算）
const adjAll = new Map(), adjValue = new Map();
for (const f of files) { adjAll.set(f, []); adjValue.set(f, []); }
for (const f of files) {
  const seen = new Map(); // to → best kind
  for (const e of edgesByFile.get(f)) {
    const prev = seen.get(e.to);
    if (prev !== 'value') seen.set(e.to, e.kind);
  }
  for (const [to, kind] of seen) {
    adjAll.get(f).push(to);
    if (kind === 'value') adjValue.get(f).push(to);
  }
}

const sccs = tarjan(files, adjAll);
const nonTrivial = sccs
  .filter(comp => comp.length > 1 || adjAll.get(comp[0])?.includes(comp[0]))
  .sort((a, b) => b.length - a.length);

const rel = p => relative(REPO, p).replace(/\\/g, '/');
let errors = 0, warnings = 0;
for (const comp of nonTrivial) {
  const set = new Set(comp);
  const valueAdj = new Map(comp.map(v => [v, (adjValue.get(v) ?? []).filter(w => set.has(w))]));
  const cycle = findCycle(comp, valueAdj);
  const label = `SCC(${comp.length}): ${comp.map(rel).join(' <-> ')}`;
  if (cycle) {
    errors++;
    console.error(`✖ [value-cycle] ${label}`);
    console.error(`    环路径: ${cycle.map(rel).join(' -> ')} -> ${rel(cycle[0])}`);
  } else {
    warnings++;
    if (!QUIET) console.warn(`⚠ [type-only-cycle] ${label} —— 环全含 TYPE 边（运行时无害），建议环上 value 边降级 import type`);
  }
}

const edgeCount = [...edgesByFile.values()].reduce((a, es) => a + es.length, 0);
console.log(`依赖环执法：${files.length} 文件 / ${edgeCount} 条相对边 / ${nonTrivial.length} 个非平凡 SCC（value 环 ${errors}，type-only 环 ${warnings}）`);
if (errors > 0) { console.error('✖ 存在全 value 边闭环（运行时循环依赖）—— exit 1'); process.exit(1); }
console.log('✔ 零 value-only 依赖环');
