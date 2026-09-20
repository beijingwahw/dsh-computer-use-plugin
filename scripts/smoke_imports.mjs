// scripts/smoke_imports.mjs
// 全模块烟测导入器（J 纪元）：Node strip-only 运行时下逐一 import 全部 src 模块，
// 抓出"接口按值导入"类潜伏炸弹（生产宿主的 bundler 约定会掩盖它们）。
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const files = walk('src');
let bad = 0;
for (const f of files) {
  try {
    await import('./' + f.split('\\').join('/'));
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/does not provide an export named|ERR_MODULE_NOT_FOUND|SyntaxError/.test(msg)) {
      console.log('IMPORT-FAIL', f, '—', msg.slice(0, 140));
      bad += 1;
    }
  }
}
console.log(bad === 0 ? `ALL ${files.length} MODULES IMPORT CLEAN` : `${bad} module(s) fail`);
process.exit(bad === 0 ? 0 : 1);
