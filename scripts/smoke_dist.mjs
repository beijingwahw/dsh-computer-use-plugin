// scripts/smoke_dist.mjs
// ΑΩ-R33：dist/ 发布面冒烟执法（package.json files/main 均指向 dist，却从无产物级测试）。
// Node 原生 ESM 逐一 import 全部 dist/**/*.js 产物（fix-imports 已补 .js 后缀，
// 无需 test/register.mjs 的 TS 解析 hook），抓三类问题：
//   1) 模块不存在 —— Cannot find module / ERR_MODULE_NOT_FOUND（含依赖丢失、路径漂移）
//   2) 导出面缺失 —— "does not provide an export named"（fix-imports 后处理失误的典型症状）
//   3) 顶层副作用炸 —— SyntaxError 及其余一切 import 期抛错（tsc 配置漂移的症状）
// 跳过名单（对齐 smoke_imports.mjs 的既有处理口径）：CLI 入口 doctorCli.js 的
// 顶层副作用就是本体——import 即 runDoctorCli → process.exit（实测会以退出码 2
// 抢杀冒烟进程），进程内不可测；其唯一依赖 qualityDoctor.js 仍在遍历清单内，
// 模块存在性与导出面覆盖不受损。
// 路径注意：相对说明符按"导入方模块"解析而非 cwd（smoke_imports 的 './'+f 写法
// 实际落在 scripts/src 下），此处一律用绝对 file:// URL 导入，杜绝基准漂移。
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

if (!existsSync(DIST)) {
  console.error('DIST-SMOKE-FAIL dist/ 不存在——先 npm run build 再冒烟发布面');
  process.exit(1);
}

const files = walk(DIST);
const SKIP = new Set([join(DIST, 'doctorCli.js')]); // 理由见文件头"跳过名单"注释
for (const s of SKIP) {
  if (files.includes(s)) console.log('DIST-SMOKE-SKIP (cli-entry)', rel(s));
}
const ordered = files.filter(f => !SKIP.has(f));

function classify(msg) {
  if (/does not provide an export named/.test(msg)) return 'MISSING-EXPORT';
  if (/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/.test(msg)) return 'MODULE-NOT-FOUND';
  return 'SIDE-EFFECT';
}

function rel(p) { return p.slice(ROOT.length + 1).split('\\').join('/'); }

let bad = 0;
for (const f of ordered) {
  try {
    await import(pathToFileURL(f).href);
  } catch (e) {
    const msg = String(e?.message ?? e);
    console.log('DIST-SMOKE-FAIL', classify(msg), rel(f), '—', msg.slice(0, 140));
    bad += 1;
  }
}
console.log(bad === 0
  ? `ALL ${ordered.length} DIST MODULES IMPORT CLEAN (${SKIP.size} skipped)`
  : `${bad} of ${ordered.length} dist module(s) fail`);

// ===== ΝΩ-43：dist 完整性清单校验（追加段，只增不改：清单缺席 ⇒ 旧 dist 兼容不失败）=====
// manifest 在场 ⇒ 逐文件重算 sha256/bytes 比对；任何不匹配（内容漂移/清单有而盘上无/
// 盘上有而清单无）都算「dist 与清单漂移」⇒ exit 1。清单损坏（在场但不可解析）视为
// 凭证失效，同样失败——完整性工具对坏凭证保持沉默即失职。
let drift = 0;
const MANIFEST = join(DIST, '.manifest.json');
if (existsSync(MANIFEST)) {
  let m = null;
  try {
    m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  } catch (e) {
    console.log('DIST-SMOKE-FAIL MANIFEST-CORRUPT dist/.manifest.json 不可解析 —', String(e?.message ?? e).slice(0, 120));
    drift = 1;
  }
  if (m && Array.isArray(m.files)) {
    const onDisk = new Set(walk(DIST).map((p) => p.slice(DIST.length + 1).split('\\').join('/')));
    for (const ent of m.files) {
      const abs = join(DIST, ent.path);
      if (!existsSync(abs)) {
        console.log('DIST-SMOKE-DRIFT', ent.path, '— 清单在录文件缺失');
        drift += 1;
        continue;
      }
      const buf = readFileSync(abs);
      const sha = createHash('sha256').update(buf).digest('hex');
      if (sha !== ent.sha256 || buf.length !== ent.bytes) {
        console.log('DIST-SMOKE-DRIFT', ent.path, '— 内容与清单不符（sha256/bytes）');
        drift += 1;
      }
      onDisk.delete(ent.path);
    }
    for (const p of [...onDisk].sort()) {
      console.log('DIST-SMOKE-DRIFT', p, '— dist 产物无清单记录');
      drift += 1;
    }
    if (drift === 0) {
      console.log(`DIST-SMOKE-MANIFEST-OK ${m.files.length} file(s) sha256 全部一致` +
        ` (HEAD ${m.gitHead ?? 'n/a'}, contentDigest ${String(m.contentDigest ?? '').slice(0, 12) || 'n/a'})`);
    }
  } else if (m) {
    console.log('DIST-SMOKE-FAIL MANIFEST-CORRUPT dist/.manifest.json 缺少 files 数组');
    drift = 1;
  }
} else {
  console.log('DIST-SMOKE-MANIFEST-ABSENT dist/.manifest.json 缺席（旧 dist 兼容，不失败）——生成命令：node scripts/build_manifest.mjs');
}
if (drift > 0) console.log(`dist 与清单漂移（${drift} 处）——重建并重签：npm run build`);
process.exit(bad === 0 && drift === 0 ? 0 : 1);
