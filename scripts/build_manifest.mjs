#!/usr/bin/env node
// scripts/build_manifest.mjs — ΝΩ-43（发布面完整性：dist SBOM + 完整性清单）
// 动机：dist 入库却无任何产物完整性凭证——构建产物漂移（fix-imports 后处理失误/
//   tsc 配置漂移/手工误改）不可检测。本脚本在构建链落定后遍历 dist/ 全部 .js 产物
//   生成 dist/.manifest.json；smoke_dist.mjs 校验时逐文件重算 sha256 比对，
//   不匹配即「dist 与清单漂移」⇒ exit 1。
// 确定性论证（刻意省略时间戳，generatedAt 方案弃用）：墙钟时间戳使「同产物同
//   manifest」不可能成立——每次重建 manifest 字节必变，基线比对只能回答"变没变"
//   而无法回答"产物变没变"。故生成时刻改用可复现的溯源标识替代：
//     gitHead       构建 HEAD 短哈希（产物出自哪个提交；工作区未提交改动由
//                   contentDigest 兜底覆盖——内容变则摘要变）；
//     contentDigest 全部 "path:sha256" 行的 sha256——产物自身的 merkle 式摘要。
//   同工具链（node 版本）+ 同产物 ⇒ manifest 逐字节相同。node 字段保留为环境指纹
//   （形状要求）：换 node 本身即环境漂移，记录之是合理的；它不参与 smoke 比对。
//   （业界 SBOM/取证惯例同理：in-toto/SLSA 以内容摘要链为准，时间戳不作完整性证据。）
// 原子写：先写 .tmp 同卷 rename 顶替，保证读者（smoke/CI）永不见半写清单。
// 用法：npm run build 后随 fix-imports.mjs 末尾 await import 自动执行；也可单独跑：
//   node scripts/build_manifest.mjs
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const OUT = join(DIST, '.manifest.json');
const TMP = OUT + '.tmp';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p); // .manifest.json / .tmp 均非 .js，天然不入清单
  }
  return out;
}

function gitHeadShort() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return null; // 非 git 环境/git 缺失 ⇒ 置 null，不阻断构建
  }
}

if (!existsSync(DIST)) {
  console.error('[build-manifest] dist/ 不存在——先 npm run build 再生成清单');
  process.exit(1);
}

const files = walk(DIST)
  .map((p) => {
    const buf = readFileSync(p);
    return {
      path: relative(DIST, p).split('\\').join('/'), // Windows 反斜杠统一为 posix 分隔
      sha256: createHash('sha256').update(buf).digest('hex'),
      bytes: buf.length,
    };
  })
  .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)); // 相对路径排序 ⇒ 字节序确定

const contentDigest = createHash('sha256')
  .update(files.map((f) => `${f.path}:${f.sha256}\n`).join(''))
  .digest('hex');

// 对象字面量固定键序 + JSON.stringify 稳定序列化 ⇒ 同产物输出逐字节一致
const manifest = {
  schema: 1,
  gitHead: gitHeadShort(),
  node: process.versions.node,
  moduleCount: files.length,
  files,
  summary: { totalBytes: files.reduce((s, f) => s + f.bytes, 0), count: files.length },
  contentDigest,
};

const json = JSON.stringify(manifest, null, 2) + '\n';
try {
  writeFileSync(TMP, json);
} catch (e) {
  try { unlinkSync(TMP); } catch { /* tmp 不存在则无需清理 */ }
  console.error('[build-manifest] 清单写入失败：', e?.message ?? e);
  process.exit(1);
}
renameSync(TMP, OUT); // 同卷 rename 原子顶替（Windows 上 libuv 走 MOVEFILE_REPLACE_EXISTING）
console.log(
  `[build-manifest] ${manifest.moduleCount} file(s), ${Math.round(manifest.summary.totalBytes / 1024)} KiB` +
  ` -> dist/.manifest.json (HEAD ${manifest.gitHead ?? 'n/a'}, digest ${contentDigest.slice(0, 12)})`
);
