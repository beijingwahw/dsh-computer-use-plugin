#!/usr/bin/env node
// scripts/cycle_lint.mjs —— 依赖环执法器（ΝΩ-41；ΠΑΝ-86 契约修复）
//
// 立法背景：方言单源化（src/dialects/random.ts）要求消费方 import 单源 —— 每
// 新增一条 import 边都在改写模块依赖图。依赖图的无执法演化史已留下 15 个强连
// 通分量（SCC）；本脚本把「环」从口头债务铸成机械闸：零依赖（node:* 内建 +
// 自带 Tarjan）扫描 src 全部 .ts 的相对 import/export-from 边，区分运行时
// （value）与仅类型（type）边：
//   · SCC 内存在全 value 边闭环（运行时真环 —— bundler 循环依赖 / 初始化顺序
//     未定义）⇒ 列环并 exit 1；
//   · 环全含 TYPE 边（import type / export type —— 编译后蒸发，运行时无环）
//     ⇒ warning：建议把环上残余 value 边降级为 import type。
// 边判定（保守向 value）：
//   import type {...} / export type {...} from        → TYPE（ΠΑΝ-86：export type
//     子句级前缀修复——`export type { A } from` 曾被误判 value（裸 specifier 无
//     type 前缀 ⇒ allType 恒 false），纯类型再导出链曾成 [value-cycle] 假阳性）
//   import { type A, type B } from（全部 specifier 带 type 前缀）→ TYPE
//   其余 import/export-from（含 default、*、裸副作用 import、动态 import()）→ VALUE
// ΠΑΝ-86（C2-6/H-3）另两处契约修复：
//   · 动态 import 盲区：`import(\`./foo\${x}\`)`（模板）与 `import('./' + name)`
//     （计算式）曾**不产边**——图本身缺边，Tarjan 再正确也无济于事。现在：
//     模板字面量取 `${` 前的静态前缀，前缀可解析 ⇒ 保守产 value 边并标
//     [dynamic-prefix]；计算式 ⇒ [unknown-dynamic-import] 盲区清单（保守标记，
//     绝不静默缺边）。
//   · 伪边封堵：字符串字面量**内容**抹空后再定位 import 语句（字符串里的
//     `import './x' from` 文本不再入图）；specifier 从原始文本按同偏移读回。
// ΤΕΛ-7a（F4-1 附记登记的盲区清偿）：正则字面量词法域感知——旧 stripForEdges
//   不识别正则字面量，`/[<>&"']/g` 字符类内的引号把状态机踢进字符串态、吞掉
//   后续真实代码（实测：src/vlm/som.ts 两处动态 import '../uiExtractor'/
//   '../textReader' 不产边——图缺边，Tarjan 再正确也无济于事）。移植
//   wiring_census.mjs preprocess 的 regex 词法域（前一显著字符/关键字判
//   regex vs 除法的经典 tokenizer 启发式），正则字面量整体抹空（含 flag）；
//   同时封堵反向伪边类：正则字面量内的 `from './x'` 文本不再入图。
// 结构（ΠΑΝ-86）：纯函数核心（可测，test/pan86.cycleLint.test.ts 消费）+ CLI
// 胶水 invoked 守卫（genesis_audit 同律——被 import 时不执行扫描）。
// 用法：node scripts/cycle_lint.mjs [--root src] [--quiet]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ─── 文件收集 ───

export function collectTs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...collectTs(p));
    else if (name.endsWith('.ts')) out.push(p); // .d.ts 也是图的一等节点
  }
  return out;
}

// ─── 源文本 → 边（comment/string/regex 盲区安全的语句级扫描） ───

// ΤΕΛ-7: regex vs 除法判据（wiring_census.mjs preprocess 同源移植——该实现在
// 本仓 wiring census 执法线实跑成熟）。prevSig = 前一非空白字符（词字符会覆
// 写它，故 `a / b` 的 prevSig 是 'b' ⇒ 除法）；prevWord = 前一完整标识符
// （`return /re/`、`case '/':` 等关键字后必是正则）。
const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '<', '>', '+', '-', '*', '%', '^', '~', "'", '"', '`', '/']);
const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/** 剥注释、字符串内容与正则字面量（保长——注释/正则内伪 import 不入图；
 *  ΠΑΝ-86：字符串**内容**抹空防伪边，引号定界符保留供定位，specifier 从原始
 *  文本同偏移读回；ΤΕΛ-7a：正则字面量整体抹空（含 flag）——字符类内的引号
 *  不再把状态机踢进字符串态吞掉后续真实代码（som.ts 盲区），正则内的
 *  `from './x'` 文本也不再产伪边。模板 ${} 用帧栈+花括号深度（嵌套模板正确）。 */
export function stripForEdges(text) {
  const out = text.split('');
  const n = text.length;
  const blank1 = (pos) => { if (pos >= 0 && pos < n) out[pos] = text[pos] === '\n' ? '\n' : ' '; };
  let mode = 'code'; // code | interp | tmpl | line | block | sq | dq | regex
  const frames = []; // 模板帧栈：{type:'tmpl'} | {type:'interp', depth}
  let prevSig = '';
  let curWord = '';
  let prevWord = '';
  let classDepth = 0; // 正则字符类深度（[…] 内的 '/' 不闭界）
  const commitWord = () => { if (curWord) { prevWord = curWord; curWord = ''; } };
  // 字面量（注释/字符串/模板/正则）闭合后回到哪一态：外层还有模板帧 ⇒ 回模板文本/插值，否则代码
  const afterLiteral = () => (frames.length && frames[frames.length - 1].type === 'interp' ? 'interp' : (frames.length ? 'tmpl' : 'code'));
  let i = 0;
  while (i < n) {
    const c = text[i];
    const nx = i + 1 < n ? text[i + 1] : '';
    if (mode === 'code' || mode === 'interp') {
      if (c === '/' && nx === '/') { mode = 'line'; blank1(i); blank1(i + 1); i += 2; continue; }
      if (c === '/' && nx === '*') { mode = 'block'; blank1(i); blank1(i + 1); i += 2; continue; }
      if (c === "'" || c === '"') { mode = c === "'" ? 'sq' : 'dq'; commitWord(); prevSig = c; i++; continue; } // 开界定界符保留
      if (c === '`') { frames.push({ type: 'tmpl' }); mode = 'tmpl'; commitWord(); prevSig = c; i++; continue; } // 开界 ` 保留
      if (c === '/') {
        const isRegex = prevSig === '' || REGEX_PRECEDERS.has(prevSig) || KEYWORDS_BEFORE_REGEX.has(prevWord);
        if (isRegex) { mode = 'regex'; classDepth = 0; blank1(i); prevSig = '/'; commitWord(); i++; continue; }
        prevSig = '/'; commitWord(); i++; continue; // 除法：原字符保留
      }
      if (c === '{' && mode === 'interp') { frames[frames.length - 1].depth++; prevSig = c; i++; continue; }
      if (c === '}' && mode === 'interp') {
        const f = frames[frames.length - 1];
        if (f.depth > 0) { f.depth--; prevSig = c; i++; continue; }
        frames.pop(); mode = 'tmpl'; prevSig = c; i++; continue; // 插值闭合 `}` 保留（${ 同律）
      }
      if (/[A-Za-z0-9_$]/.test(c)) curWord += c; else commitWord();
      if (!/\s/.test(c)) prevSig = c;
      i++; continue;
    }
    if (mode === 'line') {
      if (c === '\n') mode = afterLiteral();
      else blank1(i);
      i++; continue;
    }
    if (mode === 'block') {
      if (c === '*' && nx === '/') { blank1(i); blank1(i + 1); mode = afterLiteral(); i += 2; continue; }
      blank1(i); // 保行号（换行经 blank1 原样保留），抹内容
      i++; continue;
    }
    // 字符串态：抹内容（ΠΑΝ-86 伪边封堵），保留换行与**闭界定界符**（供正则
    // 匹配完整字面量、按同偏移从原始文本读回 specifier）；只处理转义与闭界
    if (mode === 'sq' || mode === 'dq') {
      if (c === '\\') { blank1(i); blank1(i + 1); i += 2; continue; }
      if (c === '\n') { mode = afterLiteral(); i++; continue; } // 病态未闭合：就地放弃，防吞后续代码
      if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"')) { mode = afterLiteral(); i++; continue; } // 闭界定界符保留
      blank1(i);
      i++; continue;
    }
    if (mode === 'tmpl') {
      if (c === '\\') { blank1(i); blank1(i + 1); i += 2; continue; }
      if (c === '`') { frames.pop(); mode = afterLiteral(); if (mode === 'code' || mode === 'interp') prevSig = '`'; i++; continue; } // 闭界 ` 保留
      if (c === '$' && nx === '{') { frames.push({ type: 'interp', depth: 0 }); mode = 'interp'; prevSig = '{'; i += 2; continue; } // ${ 保留
      blank1(i);
      i++; continue;
    }
    // ΤΕΛ-7a：正则字面量态——整体抹空（定界符/内容/flag），转义双抹，字符类
    // 深度内 '/' 不闭界；病态跨行未闭合退回代码态（把误判限制在单行内）
    if (mode === 'regex') {
      blank1(i);
      if (c === '\\') { blank1(i + 1); i += 2; continue; }
      if (c === '[') classDepth++;
      else if (c === ']') classDepth = Math.max(0, classDepth - 1);
      else if (c === '/' && classDepth === 0) {
        let j = i + 1;
        while (j < n && /[a-z]/.test(text[j])) { blank1(j); j++; } // flag 字母一并抹空
        mode = afterLiteral();
        i = j; continue;
      } else if (c === '\n') {
        mode = afterLiteral();
      }
      i++; continue;
    }
    i++;
  }
  return out.join('');
}

/** 从一条 import/export 子句判定边种类：'type' | 'value'（纯函数） */
export function clauseKind(keyword, clause) {
  const c = clause.replace(/\s+/g, ' ').trim();
  // ΠΑΝ-86：子句级 type 前缀对 import 与 export 同律——`export type { A } from`
  // 是 type-only re-export（此前只认 import type，export 面裸 specifier 恒 value）
  if (/^type[\s{]/.test(c)) return 'type';
  const brace = c.match(/\{([^}]*)\}/);
  if (!brace) return 'value'; // default 导入 / export * / 裸子句 —— 运行时边
  const specs = brace[1].split(',').map(s => s.trim()).filter(s => s.length > 0);
  if (specs.length === 0) return 'value';
  // 全部 specifier 带 type 前缀 ⇒ 仅类型边；任一裸名/default ⇒ value（保守）
  const allType = specs.every(s => /^type\s+[\w$]+(\s+as\s+[\w$]+)?$/.test(s));
  return allType ? 'type' : 'value';
}

/** 解析相对 specifier → 根内绝对路径；解析失败返回 null（包导入/外域）。
 *  ΠΑΝ-86：候选补 .d.ts/.mts（头注「.d.ts 一等节点」与 resolveSpec 此前不认它
 *  的矛盾消除——静默缺边同类）。 */
export function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null;
  let base = resolve(dirname(fromFile), spec);
  const cands = [];
  if (extname(base) === '.js' || extname(base) === '.mjs' || extname(base) === '.cjs') {
    base = base.slice(0, base.lastIndexOf('.'));
  }
  cands.push(base + '.ts', base + '.tsx', base + '.d.ts', base + '.mts', join(base, 'index.ts'));
  for (const c of cands) {
    try { statSync(c); return c; } catch { /* 试下一个 */ }
  }
  return null;
}

/** 动态 import 实参分类（ΠΑΝ-86：模板/计算式不静默缺边）。
 *  返回 {kind:'literal', spec} | {kind:'template', prefix, holed} | {kind:'computed'} */
export function classifyDynamicArg(rawText, argStart) {
  let i = argStart;
  const n = rawText.length;
  // 跳过空白与注释（块/行）
  for (;;) {
    while (i < n && /\s/.test(rawText[i])) i++;
    if (rawText[i] === '/' && rawText[i + 1] === '*') {
      const j = rawText.indexOf('*/', i + 2);
      i = j < 0 ? n : j + 2;
      continue;
    }
    break;
  }
  const c = rawText[i];
  // 字面量后必须是 `)`（忽略空白/注释）——`'./' + name` 这类拼接起始含引号，
  // 但闭引号后还有表达式 ⇒ 计算式（ΠΑΝ-86：不得误判为可解析字面量）
  const closedByParen = (j) => {
    while (j < n) {
      while (j < n && /\s/.test(rawText[j])) j++;
      if (rawText[j] === '/' && rawText[j + 1] === '*') {
        const k = rawText.indexOf('*/', j + 2);
        j = k < 0 ? n : k + 2;
        continue;
      }
      break;
    }
    return rawText[j] === ')';
  };
  if (c === "'" || c === '"') {
    let j = i + 1;
    let spec = '';
    while (j < n && rawText[j] !== c) {
      if (rawText[j] === '\\') { spec += rawText[j] + (rawText[j + 1] ?? ''); j += 2; continue; }
      spec += rawText[j];
      j++;
    }
    if (!closedByParen(j + 1)) return { kind: 'computed' };
    return { kind: 'literal', spec };
  }
  if (c === '`') {
    let j = i + 1;
    let prefix = '';
    while (j < n) {
      if (rawText[j] === '\\') { prefix += rawText[j] + (rawText[j + 1] ?? ''); j += 2; continue; }
      if (rawText[j] === '`') {
        // 无插值模板 = 事实字面量（前提同样：闭界定界符后即 `)`）
        return closedByParen(j + 1) ? { kind: 'template', prefix, holed: false } : { kind: 'computed' };
      }
      if (rawText[j] === '$' && rawText[j + 1] === '{') return { kind: 'template', prefix, holed: true };
      prefix += rawText[j];
      j++;
    }
    return { kind: 'template', prefix, holed: true }; // 未闭合：保守按有洞
  }
  return { kind: 'computed' }; // 标识符/拼接/函数调用 —— 目标不可静态知
}

/** 单文件源文本 → 边与盲区（纯函数；edgesOf 读盘后转调）。
 *  返回 { edges: [{to, kind}], unknownDynamic: [{kind, snippet}] }（to 为解析后
 *  绝对路径或 null——null 边在调用方按 root 节点集过滤）。 */
export function edgesOfText(file, rawText) {
  const blanked = stripForEdges(rawText);
  const edges = [];
  const unknownDynamic = [];
  // import/export … from '…'（跨行子句；在字符串内容抹空文本上定位 ⇒ 字符串里的
  // 伪 import 文本不入图，specifier 从原始文本同偏移读回。匹配覆盖完整字面量
  // （含闭引号）——空白化内容由 [^'"]* 吸收，原始切片才含闭引号可供尾部提取）
  const fromRe = /\b(import|export)\s+([^;'`]*?)\s*from\s*(['"])[^'"]*\3/g;
  let m;
  while ((m = fromRe.exec(blanked)) !== null) {
    // 语句原始切片（长度同构）：specifier = 尾部带引号字面量
    const stmtRaw = rawText.slice(m.index, m.index + m[0].length);
    const specM = stmtRaw.match(/(['"])([^'"]+)\1\s*$/);
    if (!specM) continue;
    const to = resolveSpec(file, specM[2]);
    if (to) edges.push({ to, kind: clauseKind(m[1], m[2]) });
  }
  // 裸副作用 import './x'
  const bareRe = /\bimport\s*(['"])[^'"]*\1/g;
  while ((m = bareRe.exec(blanked)) !== null) {
    const stmtRaw = rawText.slice(m.index, m.index + m[0].length);
    const specM = stmtRaw.match(/(['"])([^'"]+)\1\s*$/);
    if (!specM) continue;
    const to = resolveSpec(file, specM[2]);
    if (to) edges.push({ to, kind: 'value' });
  }
  // 动态 import(…) —— 运行时边（ΠΑΝ-86：模板/计算式不再静默缺边）
  const dynRe = /\bimport\s*\(/g;
  while ((m = dynRe.exec(blanked)) !== null) {
    const arg = classifyDynamicArg(rawText, m.index + m[0].length);
    if (arg.kind === 'literal' || (arg.kind === 'template' && !arg.holed)) {
      // 无插值模板 = 事实字面量（\`./x\` 与 './x' 同义）
      const spec = arg.kind === 'literal' ? arg.spec : arg.prefix;
      const to = resolveSpec(file, spec);
      if (to) edges.push({ to, kind: 'value' });
    } else if (arg.kind === 'template') {
      const to = arg.prefix ? resolveSpec(file, arg.prefix) : null;
      if (to) edges.push({ to, kind: 'value' }); // 静态前缀可解析 ⇒ 保守 value 边
      unknownDynamic.push({
        kind: to ? 'dynamic-prefix' : 'dynamic-unresolved',
        snippet: `import(\`${arg.prefix}\${…}\`)${to ? ` → 前缀已保守入图：${to}` : ' → 前缀不可解析（盲区）'}`,
      });
    } else {
      unknownDynamic.push({
        kind: 'dynamic-unresolved',
        snippet: `import(计算式) —— 目标不可静态解析（依赖图盲区，环可能对执法器不可见）`,
      });
    }
  }
  return { edges, unknownDynamic };
}

/** 单文件 → 边列表（读盘壳） */
export function edgesOf(file) {
  return edgesOfText(file, readFileSync(file, 'utf8'));
}

// ─── Tarjan SCC（迭代式 —— 零依赖、零递归深度风险） ───

export function tarjan(nodes, adj) {
  const index = new Map(), low = new Map(), on = new Set(), sccOf = new Map();
  let counter = 0;
  const stack = [];
  const sccs = [];
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work = [[root, 0]]; // [节点, 邻居游标]
    // ΠΑΝ-86：拆开原 `low.set(...) && counter` 恒真值投机写法——功能同、可读性归位
    index.set(root, counter); low.set(root, counter); counter++;
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
export function findCycle(nodes, adj) {
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

// ─── 图分析（纯函数：文件集 + 逐文件边 → 环判定与盲区清单） ───

/** ΠΑΝ-86：主流程核心纯函数化——测试经 fixture 文件集消费，CLI 只做 IO/渲染。
 *  files: 绝对路径[]；edgesByFile: Map(file → {edges, unknownDynamic})。
 *  返回 { valueCycles: [{scc, cycle}], typeOnlySccs: [scc], unknownDynamic:
 *  [{file, kind, snippet}], edgeCount, nonTrivialCount } */
export function analyzeGraph(files, edgesByFile) {
  const nodeSet = new Set(files);
  const filtered = new Map();
  for (const f of files) {
    const { edges, unknownDynamic } = edgesByFile.get(f) ?? { edges: [], unknownDynamic: [] };
    filtered.set(f, { edges: edges.filter(e => nodeSet.has(e.to)), unknownDynamic });
  }
  // 合并邻接表：同目标 value+type 双边 ⇒ value 胜（运行时边存在即算）
  const adjAll = new Map(), adjValue = new Map();
  for (const f of files) { adjAll.set(f, []); adjValue.set(f, []); }
  for (const f of files) {
    const seen = new Map(); // to → best kind
    for (const e of filtered.get(f).edges) {
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
  const valueCycles = [];
  const typeOnlySccs = [];
  for (const comp of nonTrivial) {
    const set = new Set(comp);
    const valueAdj = new Map(comp.map(v => [v, (adjValue.get(v) ?? []).filter(w => set.has(w))]));
    const cycle = findCycle(comp, valueAdj);
    if (cycle) valueCycles.push({ scc: comp, cycle });
    else typeOnlySccs.push(comp);
  }
  const unknownDynamic = [];
  for (const f of files) {
    for (const u of filtered.get(f).unknownDynamic) unknownDynamic.push({ file: f, ...u });
  }
  const edgeCount = [...filtered.values()].reduce((a, e) => a + e.edges.length, 0);
  return { valueCycles, typeOnlySccs, unknownDynamic, edgeCount, nonTrivialCount: nonTrivial.length };
}

// ─── CLI ───

const ROOT_ARG = process.argv.includes('--root')
  ? process.argv[process.argv.indexOf('--root') + 1]
  : 'src';
const QUIET = process.argv.includes('--quiet');

function main() {
  const root = resolve(REPO, ROOT_ARG);
  const files = collectTs(root).map(p => resolve(p)).sort();
  const edgesByFile = new Map();
  for (const f of files) edgesByFile.set(f, edgesOf(f));
  const r = analyzeGraph(files, edgesByFile);

  const rel = p => relative(REPO, p).replace(/\\/g, '/');
  let errors = 0, warnings = 0;
  for (const { scc, cycle } of r.valueCycles) {
    errors++;
    console.error(`✖ [value-cycle] SCC(${scc.length}): ${scc.map(rel).join(' <-> ')}`);
    console.error(`    环路径: ${cycle.map(rel).join(' -> ')} -> ${rel(cycle[0])}`);
  }
  for (const comp of r.typeOnlySccs) {
    warnings++;
    if (!QUIET) console.warn(`⚠ [type-only-cycle] SCC(${comp.length}): ${comp.map(rel).join(' <-> ')} —— 环全含 TYPE 边（运行时无害·豁免），建议环上 value 边降级 import type`);
  }
  // ΠΑΝ-86：动态 import 盲区清单（保守标记，绝不静默缺边）
  for (const u of r.unknownDynamic) {
    if (!QUIET) console.warn(`⚠ [${u.kind}] ${rel(u.file)}: ${u.snippet}`);
  }
  console.log(
    `依赖环执法：${files.length} 文件 / ${r.edgeCount} 条相对边 / ${r.nonTrivialCount} 个非平凡 SCC` +
    `（value 环 ${errors} ⇒ 红，type-only 环 ${warnings} ⇒ 豁免）` +
    (r.unknownDynamic.length ? ` · 动态 import 盲区标记 ${r.unknownDynamic.length} 处（已保守入图或列示）` : ''),
  );
  if (errors > 0) {
    console.error('✖ 存在全 value 边闭环（运行时循环依赖）—— exit 1');
    process.exit(1);
  }
  console.log('✔ 零 value-only 依赖环');
  process.exit(0);
}

// ΠΑΝ-86：直跑守卫（genesis_audit 同律）——被 test/pan86.cycleLint.test.ts import
// 时只取纯函数，不触发扫描。
const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) main();
