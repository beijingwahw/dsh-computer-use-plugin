#!/usr/bin/env node
// scripts/bench_gate.mjs —— W7-6 性能回归门：把 W5-6 一次性效能基准升级为可持续回归门。
//
// 用法（repo 根目录）：
//   node scripts/bench_gate.mjs --update   采基线：子进程跑 w5*.bench.ts，TAP 解析
//                                         （pass/fail + 注释行结构化指标），写
//                                         bench/baselines/<日期>-<hash>.json（含环境
//                                         戳：node 版本/平台/时间/命令）。仅当基准
//                                         全绿才落盘 —— 基线必须可信。
//   node scripts/bench_gate.mjs --check    回归门：重跑并与最近基线比对，口径分级：
//                                         硬门 = pass/fail 回归/测试失踪/新失败 ⇒ 红
//                                         （exit 1）；软门 = 指标偏离超阈仅告警（不改
//                                         exit 码）—— 计数类阈值 ±15%（W5 基准确定性
//                                         计数，容差只为防口径漂移），时间类
//                                         duration_ms 波动大 ⇒ ±50% 且标注
//                                         「仅告警」。环境不匹配（node/平台不同）⇒
//                                         显著提示「建议 --update」，亦不红。
//   node scripts/bench_gate.mjs --list     列历史基线（含归档区）。
//   node scripts/bench_gate.mjs --reset    显式重置：最近基线移入 archive/ 归档，
//                                         重采新基线。
//
// 指标提取契约（不改 bench 本体，从其 TAP 输出的 console 注释行提取）：
//   · 「key = 数字」对：key 以字母/中文/下划线开头（数字开头=公式残段，剔除）；
//   · 行首到首个键的短前缀（臂名/栏目名）作限定键（如「缺省(上限1).skipRate」），
//     同名键不同臂不互吞；
//   · 公式链「key = 1 − a/b = 74.6%」：以行末百分数回溯最近合法键覆写其值
//     （取 74.6% 而非公式首数 1）；
//   · 百分数归一为 [0,1] 存档（unit: "percent"）。
//
// 比较器核心（parseTap / extractMetrics / compareBenchmarks / envMatches /
// deviation）为纯函数，由 test/w7gate.test.ts 全量回归保护；本文件其余部分是
// CLI 胶水，不含判定逻辑。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 常量 ──
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BASELINE_DIR = path.join(ROOT, 'bench', 'baselines');
const ARCHIVE_DIR = path.join(BASELINE_DIR, 'archive');
const BENCH_ARGS = [
  '--experimental-strip-types',
  '--test',
  '--import',
  './test/register.mjs',
  'test/w5*.bench.ts',
];
const SCHEMA = 'bench-baseline/1';
const DEFAULT_OPTS = { warnThreshold: 0.15, durationThreshold: 0.5 };

// ═══════════════ 纯函数核心（单测覆盖区） ═══════════════

const SUMMARY_COUNT_RE = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/;
const SUMMARY_MS_RE = /^# duration_ms ([\d.]+)$/;
const NOISE_COMMENT_RE = [/^\(node:\d+\)/, /^Use `node/, /^\(Use `node/];

/** 解析 node --test 的 TAP 输出：逐测试名/通过位/时长/注释归属 + 尾部总账。 */
export function parseTap(text) {
  const tests = [];
  const summary = { tests: null, pass: null, fail: null, durationMs: null };
  let commentBuf = []; // 注释先于 Subtest 行出现（console 实时流）⇒ 归属下一测试
  let pending = null;
  let planSeen = false;

  for (const line of String(text).split(/\r?\n/)) {
    if (/^TAP version \d+/.test(line)) continue;
    if (/^1\.\.\d+$/.test(line)) { planSeen = true; continue; }

    if (!planSeen) {
      const sm = /^# Subtest: (.+)$/.exec(line);
      if (sm) {
        pending = { name: sm[1].trim(), comments: commentBuf };
        commentBuf = [];
        continue;
      }
    }

    const cm = /^# (.*)$/.exec(line);
    if (cm) {
      if (planSeen) {
        const c = SUMMARY_COUNT_RE.exec(line);
        if (c) { summary[c[1]] = Number(c[2]); continue; }
        const ms = SUMMARY_MS_RE.exec(line);
        if (ms) { summary.durationMs = Number(ms[1]); continue; }
        continue; // 计划行之后的其余注释不归属任何测试
      }
      if (NOISE_COMMENT_RE.some((re) => re.test(cm[1]))) continue;
      commentBuf.push(cm[1]);
      continue;
    }

    const tm = /^(not )?ok (\d+) - (.*)$/.exec(line);
    if (tm) {
      const directiveM = /\s+#\s*(SKIP|TODO)\s*$/i.exec(tm[3]);
      const directive = directiveM ? directiveM[1].toUpperCase() : null;
      const name = (directiveM ? tm[3].slice(0, directiveM.index) : tm[3]).trim();
      // 跳过/待办 = 未真实通过（门控口径：基线必须真跑真过）
      const ok = tm[1] === undefined && directive === null;
      tests.push({
        name,
        ok,
        directive,
        durationMs: null,
        comments: pending && pending.name === name ? pending.comments : commentBuf,
      });
      pending = null;
      commentBuf = [];
      continue;
    }

    const dm = /^\s+duration_ms:\s*([\d.]+)$/.exec(line);
    if (dm) {
      const last = tests[tests.length - 1];
      if (last && last.durationMs === null) last.durationMs = Number(dm[1]);
    }
  }
  return { tests, summary };
}

// 指标提取：键值对 + 百分数公式链覆写 + 臂名限定键（契约见文件头）。
const NUM_PAT = String.raw`-?\d+(?:\.\d+)?`;
const PAIR_RE = new RegExp(
  String.raw`([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff（）()·%/.-]*)` +
    String.raw`\s*=\s*(` + NUM_PAT + String.raw`)\s*(%?)` +
    String.raw`(?=[\s（）)；;,、。：/]|$)`,
  'g',
);
const PERCENT_RE = new RegExp(String.raw`=\s*(` + NUM_PAT + String.raw`)\s*%`, 'g');
const ANY_KEY_EQ_RE = new RegExp(String.raw`([\w\u4e00-\u9fff（）()·%/.-]+)\s*=`, 'g');
const VALID_KEY_START = /^[A-Za-z_\u4e00-\u9fff]/;
const FORMULA_KEY = /^[\d./]+$/;

/** 从 TAP 注释行（console 表）提取结构化指标：{ 限定键: { value, unit } }。 */
export function extractMetrics(lines) {
  const metrics = {};
  const put = (k, value, unit) => { metrics[k] = { value, unit }; };

  for (const line of lines) {
    PAIR_RE.lastIndex = 0;
    PERCENT_RE.lastIndex = 0;
    const pairs = [...String(line).matchAll(PAIR_RE)];
    const pcts = [...String(line).matchAll(PERCENT_RE)];
    if (pairs.length === 0 && pcts.length === 0) continue;

    // 行首到首个匹配起点的短前缀（臂名/栏目名）作限定键
    const firstIdx = Math.min(
      pairs.length ? pairs[0].index : Infinity,
      pcts.length ? pcts[0].index : Infinity,
    );
    let prefix = '';
    if (Number.isFinite(firstIdx) && firstIdx > 0) {
      const p = line.slice(0, firstIdx).trim().replace(/[:：]$/, '').trim();
      if (p.length > 0 && p.length <= 16 && !/[⇒#─]/.test(p)) prefix = `${p}.`;
    }

    for (const m of pairs) {
      if (!VALID_KEY_START.test(m[1])) continue; // 数字开头 = 公式残段
      // 表头负载常量键规整：「级联路由节省率（N=20」⇒「级联路由节省率.N」
      const key = m[1].replace(/（([A-Za-z])$/, '.$1');
      const isPct = m[3] === '%';
      put(prefix + key, isPct ? Number(m[2]) / 100 : Number(m[2]), isPct ? 'percent' : 'plain');
    }

    // 公式链改判：行末百分数回溯越过公式残段，找最近合法键覆写。
    // 「<=」而非「<」：百分数自己的键值对（skipRate=50.0%）正是首选治理键，
    // 否则会错落到前一个键（probe）上。
    for (const pc of pcts) {
      ANY_KEY_EQ_RE.lastIndex = 0;
      const keyEqs = [...line.matchAll(ANY_KEY_EQ_RE)]
        .filter((k) => k.index + k[0].length - 1 <= pc.index);
      for (let i = keyEqs.length - 1; i >= 0; i--) {
        const key = keyEqs[i][1];
        if (VALID_KEY_START.test(key) && !FORMULA_KEY.test(key)) {
          put(prefix + key.replace(/（([A-Za-z])$/, '.$1'), Number(pc[1]) / 100, 'percent');
          break;
        }
      }
    }
  }
  return metrics;
}

/** 相对偏离 (cur-base)/base；基线为 0/非有限 ⇒ null（交由绝对偏离路径）。 */
export function deviation(base, cur) {
  if (!Number.isFinite(base) || base === 0) return null;
  return (cur - base) / base;
}

/**
 * 基线 vs 现跑比对（纯函数，口径分级）。
 * 硬门（exit 1 仅由此触发）：基线通过→现失败；基线测试失踪；现跑出现基线没有的失败。
 * 软门（仅告警）：计数类指标 |偏离|>warnThreshold(±15%)；时间类 duration_ms
 * |偏离|>durationThreshold(±50%) 且标注 volatile（「仅告警」）；指标消失/基线为 0
 * 的绝对偏离。返回 { hardRed, hardFindings, warnFindings, infoFindings }。
 */
export function compareBenchmarks(baseline, current, opts = {}) {
  const warnThreshold = opts.warnThreshold ?? DEFAULT_OPTS.warnThreshold;
  const durationThreshold = opts.durationThreshold ?? DEFAULT_OPTS.durationThreshold;
  const hardFindings = [];
  const warnFindings = [];
  const infoFindings = [];
  const baseTests = new Map(baseline.tests.map((t) => [t.name, t]));
  const curTests = new Map(current.tests.map((t) => [t.name, t]));

  for (const b of baseline.tests) {
    const c = curTests.get(b.name);
    if (!c) {
      hardFindings.push({ kind: 'missing-test', test: b.name, detail: '基线测试失踪（改名/删除即覆盖丢失）' });
    } else if (b.ok && !c.ok) {
      hardFindings.push({ kind: 'regression', test: b.name, detail: '基线通过 → 现跑失败' });
    } else if (!b.ok && c.ok) {
      infoFindings.push({ kind: 'recovered', test: b.name, detail: '基线失败 → 现跑通过' });
    }
  }
  for (const c of current.tests) {
    if (!baseTests.has(c.name)) {
      if (c.ok) infoFindings.push({ kind: 'new-test', test: c.name, detail: '新测试（未参与比对，建议 --update 收入基线）' });
      else hardFindings.push({ kind: 'new-fail', test: c.name, detail: '现跑出现基线没有的失败' });
    }
  }

  for (const c of current.tests) {
    const b = baseTests.get(c.name);
    if (!b) continue;
    const baseMetrics = b.metrics ?? {};
    const curMetrics = c.metrics ?? {};
    for (const [k, bv] of Object.entries(baseMetrics)) {
      const cv = curMetrics[k];
      if (cv === undefined) {
        warnFindings.push({ kind: 'metric-vanished', test: c.name, key: k, base: bv.value, detail: '基线指标在现跑消失（口径/输出格式变化）' });
        continue;
      }
      const dev = deviation(bv.value, cv.value);
      if (dev === null) {
        if (Math.abs(cv.value - bv.value) > 1e-9) {
          warnFindings.push({ kind: 'metric-drift-abs', test: c.name, key: k, base: bv.value, cur: cv.value, unit: bv.unit, detail: '基线为 0 的绝对偏离' });
        }
      } else if (Math.abs(dev) > warnThreshold) {
        warnFindings.push({
          kind: 'metric-drift', test: c.name, key: k, base: bv.value, cur: cv.value,
          dev, unit: bv.unit, volatile: false,
          detail: `偏离 ${(dev * 100).toFixed(1)}% 超阈值 ±${(warnThreshold * 100).toFixed(0)}%（方向未定，人工复核）`,
        });
      }
    }
    if (typeof b.durationMs === 'number' && typeof c.durationMs === 'number' && b.durationMs > 0) {
      const dev = deviation(b.durationMs, c.durationMs);
      if (dev !== null && Math.abs(dev) > durationThreshold) {
        warnFindings.push({
          kind: 'duration-drift', test: c.name, base: b.durationMs, cur: c.durationMs,
          dev, volatile: true,
          detail: `时长偏离 ${(dev * 100).toFixed(1)}% 超阈值 ±${(durationThreshold * 100).toFixed(0)}%（时间类波动大，仅告警）`,
        });
      }
    }
  }
  return { hardRed: hardFindings.length > 0, hardFindings, warnFindings, infoFindings };
}

/** 环境戳比对：node 版本 / 平台不一致 ⇒ { ok:false, diffs }（提示 --update，不红）。 */
export function envMatches(baseEnv, curEnv) {
  const diffs = [];
  if (baseEnv?.node !== curEnv?.node) diffs.push(`node ${baseEnv?.node} → ${curEnv?.node}`);
  if (baseEnv?.platform !== curEnv?.platform) diffs.push(`platform ${baseEnv?.platform} → ${curEnv?.platform}`);
  return { ok: diffs.length === 0, diffs };
}

// ═══════════════ CLI 胶水 ═══════════════

function currentEnv() {
  return {
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    command: `node ${BENCH_ARGS.join(' ')}`,
    cwd: ROOT,
  };
}

function runBenches() {
  const res = spawnSync(process.execPath, BENCH_ARGS, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
  if (res.error) throw new Error(`无法启动基准子进程: ${res.message}`);
  const parsed = parseTap(res.stdout);
  for (const t of parsed.tests) t.metrics = extractMetrics(t.comments);
  if (parsed.tests.length === 0) {
    throw new Error(`TAP 解析得到 0 个测试（子进程 exit=${res.status}）——运行器或解析器坏了，拒绝继续`);
  }
  return parsed;
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function hash8(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 8);
}

function toBaselineRecord(parsed, env) {
  const pass = parsed.tests.filter((t) => t.ok).length;
  const fail = parsed.tests.length - pass;
  const payload = {
    schema: SCHEMA,
    createdAt: new Date().toISOString(),
    environment: env,
    summary: { tests: parsed.tests.length, pass, fail, durationMs: parsed.summary.durationMs },
    tests: parsed.tests.map((t) => ({
      name: t.name,
      ok: t.ok,
      directive: t.directive ?? null,
      durationMs: t.durationMs,
      metrics: t.metrics,
    })),
  };
  return { payload, id: `${stamp()}-${hash8(payload)}` };
}

function listBaselineFiles(dir = BASELINE_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^[\d-]+-[0-9a-f]{8}\.json$/.test(f))
    .sort();
}

function latestBaseline() {
  const files = listBaselineFiles();
  if (files.length === 0) return null;
  const name = files[files.length - 1];
  return { name, path: path.join(BASELINE_DIR, name) };
}

function printRunSummary(label, parsed) {
  const pass = parsed.tests.filter((t) => t.ok).length;
  const metricCount = parsed.tests.reduce((n, t) => n + Object.keys(t.metrics ?? {}).length, 0);
  console.log(`${label}: 测试 ${parsed.tests.length}（通过 ${pass}/失败 ${parsed.tests.length - pass}），提取指标 ${metricCount} 项，总时长 ${parsed.summary.durationMs ?? '?'}ms`);
}

function cmdUpdate() {
  const parsed = runBenches();
  printRunSummary('基准现跑', parsed);
  const fails = parsed.tests.filter((t) => !t.ok);
  if (fails.length > 0) {
    for (const f of fails) console.error(`  ✗ ${f.name}`);
    console.error('基准未全绿 —— 拒绝建立基线（基线必须可信）。先修红再 --update。');
    return 2;
  }
  const { payload, id } = toBaselineRecord(parsed, currentEnv());
  mkdirSync(BASELINE_DIR, { recursive: true });
  const file = path.join(BASELINE_DIR, `${id}.json`);
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`基线已落盘: bench/baselines/${id}.json`);
  console.log(`环境戳: node ${payload.environment.node} / ${payload.environment.platform} / ${payload.createdAt}`);
  return 0;
}

function fmtVal(v, unit) {
  if (unit === 'percent') return `${(v * 100).toFixed(2)}%`;
  return String(Number(v.toFixed(6)));
}

function cmdCheck() {
  const latest = latestBaseline();
  if (!latest) {
    console.error('无基线可比对。先运行: node scripts/bench_gate.mjs --update');
    return 1;
  }
  const baseline = JSON.parse(readFileSync(latest.path, 'utf8'));
  console.log(`比对基线: bench/baselines/${latest.name}（${baseline.createdAt}）`);

  const env = envMatches(baseline.environment, currentEnv());
  if (!env.ok) {
    console.log('⚠ 基线环境不匹配: ' + env.diffs.join('；'));
    console.log('  ⇒ 指标口径可能失真，建议: node scripts/bench_gate.mjs --update（本提示为告警，不判红）');
  }

  const current = runBenches();
  printRunSummary('基准现跑', current);

  const r = compareBenchmarks(baseline, current);
  for (const t of current.tests) {
    const b = baseline.tests.find((x) => x.name === t.name);
    const mk = Object.keys(t.metrics ?? {}).length;
    const bk = b ? Object.keys(b.metrics ?? {}).length : 0;
    const dur = typeof t.durationMs === 'number' && b?.durationMs
      ? `时长 ${t.durationMs.toFixed(1)}ms（基线 ${b.durationMs.toFixed(1)}ms）`
      : `时长 ${t.durationMs ?? '?'}ms`;
    console.log(`  ${t.ok ? '✓' : '✗'} ${t.name}  指标 ${mk} 项（基线 ${bk}）  ${dur}`);
  }

  for (const f of r.infoFindings) console.log(`  [信息] ${f.kind}: ${f.test ?? ''} ${f.detail}`);
  for (const f of r.warnFindings) {
    const where = f.test ? `${f.test} / ` : '';
    const val = f.key
      ? `${f.base !== undefined ? fmtVal(f.base, f.unit) : '?'} → ${f.cur !== undefined ? fmtVal(f.cur, f.unit) : '?'}`
      : `${f.base}ms → ${f.cur}ms`;
    console.log(`  [告警] ${where}${f.key ?? '时长'}: ${val}  ${f.detail}${f.volatile ? '【仅告警】' : ''}`);
  }
  for (const f of r.hardFindings) console.error(`  [硬门·红] ${f.kind}: ${f.test}  ${f.detail}`);

  console.log(`门判决: 硬门 ${r.hardFindings.length} 红 / 告警 ${r.warnFindings.length} 条 / 信息 ${r.infoFindings.length} 条`);
  if (r.hardRed) {
    console.error('性能回归门: 红（存在 pass/fail 级回归）');
    return 1;
  }
  console.log('性能回归门: 绿（硬门无红；告警不判红）');
  return 0;
}

function cmdList() {
  const files = listBaselineFiles();
  if (files.length === 0) {
    console.log(`（${BASELINE_DIR} 无基线 —— 先 --update）`);
    return 0;
  }
  console.log('历史基线（bench/baselines/，新→旧由文件名时间戳排序，末行为最近）:');
  files.forEach((f, i) => {
    let row = `  ${f}`;
    try {
      const b = JSON.parse(readFileSync(path.join(BASELINE_DIR, f), 'utf8'));
      const metricCount = b.tests.reduce((n, t) => n + Object.keys(t.metrics ?? {}).length, 0);
      row += `\n      ${b.createdAt}  node ${b.environment.node}  ${b.environment.platform}  测试 ${b.summary.tests}（pass ${b.summary.pass}/fail ${b.summary.fail}）  指标 ${metricCount} 项`;
    } catch {
      row += '\n      （解析失败）';
    }
    if (i === files.length - 1) row += '  ← 最近基线';
    console.log(row);
  });
  const archived = listBaselineFiles(ARCHIVE_DIR);
  if (archived.length > 0) {
    console.log(`归档区（bench/baselines/archive/，--reset 移入，不参与比对）: ${archived.join('、')}`);
  }
  return 0;
}

function cmdReset() {
  const latest = latestBaseline();
  if (latest) {
    mkdirSync(ARCHIVE_DIR, { recursive: true });
    renameSync(latest.path, path.join(ARCHIVE_DIR, latest.name));
    console.log(`已归档旧基线: bench/baselines/archive/${latest.name}`);
  } else {
    console.log('无既有基线，--reset 等价于 --update。');
  }
  return cmdUpdate();
}

function usage() {
  console.log('用法: node scripts/bench_gate.mjs --update | --check | --list | --reset');
  return 2;
}

function main() {
  const mode = process.argv[2];
  switch (mode) {
    case '--update': return cmdUpdate();
    case '--check': return cmdCheck();
    case '--list': return cmdList();
    case '--reset': return cmdReset();
    default: return usage();
  }
}

// 直跑才执行 CLI；被 test/w7gate.test.ts 动态 import 时不触发（纯函数区可测）。
const invokedDirectly = (() => {
  try {
    return path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) process.exit(main());
