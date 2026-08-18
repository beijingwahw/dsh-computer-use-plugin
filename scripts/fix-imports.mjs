#!/usr/bin/env node
// scripts/fix-imports.mjs
// 构建后处理（npm run build 第二步）：
// 源码内部相对导入遵循宿主 bundler 约定（'./journal' 无扩展名），tsc 原样保留；
// Node ESM 运行时不认无扩展名相对导入 —— 本脚本为 dist 内可解析的相对导入补 .js 后缀。
// 安全网：只重写「能解析到 dist 真实文件」的说明符；消息文本中的疑似路径不动。
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

function walk(dir) {
  const out = [];
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

/** 无扩展名说明符 → 实际 dist 文件（./x → ./x.js；./tools → ./tools/index.js） */
function resolveSpec(fromFile, spec) {
  const base = join(dirname(fromFile), spec);
  if (existsSync(base + '.js')) return spec + '.js';
  const trimmed = spec.replace(/\/+$/, '');
  if (existsSync(join(base, 'index.js'))) return trimmed + '/index.js';
  return null;
}

let files = 0;
for (const file of walk(DIST)) {
  const before = readFileSync(file, 'utf8');
  let code = before;
  // 静态 import / re-export：from '...'
  code = code.replace(/(\bfrom\s*)(['"])(\.\.?\/[^'"]+)\2/g, (m, p1, q, spec) => {
    const r = resolveSpec(file, spec);
    return r ? `${p1}${q}${r}${q}` : m;
  });
  // 动态 import('...')
  code = code.replace(/(\bimport\s*\(\s*)(['"])(\.\.?\/[^'"]+)\2/g, (m, p1, q, spec) => {
    const r = resolveSpec(file, spec);
    return r ? `${p1}${q}${r}${q}` : m;
  });
  // 裸副作用导入：import '...'
  code = code.replace(/(\bimport\s*)(['"])(\.\.?\/[^'"]+)\2/g, (m, p1, q, spec) => {
    const r = resolveSpec(file, spec);
    return r ? `${p1}${q}${r}${q}` : m;
  });
  if (code !== before) {
    writeFileSync(file, code);
    files++;
  }
}
console.log(`[fix-imports] rewrote ${files} file(s) in dist/`);
