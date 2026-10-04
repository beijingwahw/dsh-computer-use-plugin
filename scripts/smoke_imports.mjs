// scripts/smoke_imports.mjs
// 全模块烟测导入器（J 纪元）：Node strip-only 运行时下逐一 import 全部 src 模块，
// 抓出"接口按值导入"类潜伏炸弹（生产宿主的 bundler 约定会掩盖它们）。
// ΑΩ-R46（假绿修复）：(1) 旧版 `'./' + f` 相对 scripts/ 解析 ⇒ src 路径全部落空，
//     每个文件都 MODULE_NOT_FOUND；新版 Node 的该错误 message 为
//     "Cannot find module '...' imported from ..."（code 在 e.code 而非 message），
//     旧正则匹配不到 ⇒ 全部被吞，"ALL CLEAN" 是假绿。改为以脚本位置定根 +
//     file:// URL 绝对导入 + code 与 message 双通道匹配。
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

// ΑΩ-R46：doctorCli.ts 顶层即 runDoctorCli→process.exit（dist 冒烟同律跳过）
const SKIP = new Set(['doctorCli.ts']);
const base = (p) => p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);
const files = walk(join(ROOT, 'src')).filter((p) => !SKIP.has(base(p)));
if (SKIP.size) console.log('SKIP (side-effect entry):', [...SKIP].join(', '));
let bad = 0;
for (const f of files) {
  const rel = f.slice(ROOT.length + 1).split('\\').join('/');
  try {
    await import(pathToFileURL(f).href);
  } catch (e) {
    const msg = String(e?.message ?? e);
    const codeHit = e?.code === 'ERR_MODULE_NOT_FOUND';
    if (codeHit
      || /does not provide an export named|Cannot find module|SyntaxError/.test(msg)) {
      console.log('IMPORT-FAIL', rel, '—', msg.slice(0, 140));
      bad += 1;
    }
  }
}
// ΑΩ-R46：process.exit 在管道 stdout 下会截断最后的判决行 —— 同步直写保证落地
import { writeSync } from 'node:fs';
writeSync(1, (bad === 0 ? `ALL ${files.length} MODULES IMPORT CLEAN` : `${bad} module(s) fail`) + '\n');
process.exit(bad === 0 ? 0 : 1);
