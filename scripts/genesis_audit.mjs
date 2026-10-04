#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 创世审计器（W7-2）—— 把 GENESIS 的账实一致从人工抽查升级为机器执法。
//
// 审计对象（全部只读，绝不代改账目——发现不一致只报告，修账属 W6-0 领地）：
//   ① GENESIS.md 的 W 纪元章节表（器官 / 执法 / 审判数字 = 测试数/失败数）；
//   ② DEBTS.md 台账条目（编号 / 状态枚举合法性 / 统计段口径）。
//
// 机器执法：
//   ① 对每个可定位的审判数字，实跑对应测试文件（node --test 单文件，TAP 计数）与账面比对；
//   ② 对「0 fail」类声明，断言对应文件实跑 0 fail；
//   ③ W1-W6 磁盘 w* 文件盘存（含未入账的 w6 在途批次——0 fail 断言 + 滞后申报；
//     w7+ 属并行施工在途批次，不属本审计宇宙——GENESIS/DEBTS 亦未为其立账）；
//   ④ DEBTS 状态字段按台账头部自申报枚举校验；
//   ⑤ 纪元内「合计 N/0」与表行加总的账内自洽核对（纯文本算术执法）。
//
// CLI（自设）：
//   node scripts/genesis_audit.mjs                 默认：抽样审计——每纪元前 3 条可实跑
//                                                   账目 + W1-W6 未入账盘存，分钟级
//     --check        严格模式：虚报 / 实跑异常 / 0-fail 声明破产 ⇒ exit 1
//     --full         全量：全部账目实跑 + 全量套件 + tsc + 基线比对（分钟级）
//     --sample N     抽样覆写：每纪元前 N 条可实跑账目（N=0 ⇒ 全部账目；默认 3）
//     --parse        只解析比对可文本核验项，不实跑（秒级）
//     --json         机读结构化输出（判定字段不含任何时长/时间戳——确定性面）
//     --conc N       实跑并发（默认 4）
//     --selftest     审计器自身单元测试（纯函数 fixtures + 两个真实最小实跑）
//     --help
//
// 判定口径：
//   一致  = 实跑 tests == 账面 tests 且 实跑 fail == 账面 fail
//   虚报  = 实跑 tests <  账面 tests，或 实跑 fail >  账面 fail（含「0 fail」破产）
//   滞后  = 实跑 tests >  账面 tests 且 fail 不劣于账面（账未跟上现实）
//   n/a   = 审判数字无法定位到 node 测试面（如 python --selftest）
//   实跑异常 = 文件跑不完（超时/崩溃）——无法认证，--check 下同 exit 1
//
// 自身确定性：文件列表排序、固定并发池、判定逻辑零时钟零随机——同环境两次运行
// 结论一致（--json 输出可逐字节复现；文本报告仅末行耗时不同）。
//
// 领地：本文件为 W7-2 唯一新建源文件（纯 .mjs，不进 tsc 编译目标、不入
// test/*.test.ts 全量通配——全量计数与基线逐字节无关）。自测走 --selftest。
// ─────────────────────────────────────────────────────────────────────────────

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 审计对象注入缝（仅测试用：篡改副本探针证明执法路径；缺省恒指仓库正本）
const GENESIS_PATH = process.env.DSH_AUDIT_GENESIS || path.join(ROOT, 'GENESIS.md');
const DEBTS_PATH = process.env.DSH_AUDIT_DEBTS || path.join(ROOT, 'DEBTS.md');
const TEST_DIR = path.join(ROOT, 'test');

// ── 常量 ─────────────────────────────────────────────────────────────────────

// 审判册 ID → 测试文件 stem 对照表（W1-W3 纪元表用「Wn-m」式执法册号，W4 起直接
// 写文件 stem）。映射佐证：测试文件内容含该 ID（首行注释）——审计时逐一验读。
export const ID_MAP = {
  'W1-1': 'w1exec', 'W1-2': 'w1approval', 'W1-3': 'w1gate', 'W1-4': 'w1gymnoise',
  'W1-5': 'w1exp4', 'W1-6': 'w1rootcause', 'W1-7': 'w1som', 'W1-8': 'w1zoom',
  'W1-9': 'w1visualecon',
  'W2-1': 'w2queue', 'W2-2': 'w2audit', 'W2-3': 'w2bench', 'W2-4': 'w2swarm',
  'W2-5': 'w2recovery', 'W2-6': 'w2memory', 'W2-7': 'w2canary', 'W2-8': 'w2cascade',
  'W3-0': 'w3wire', 'W3-1': 'w3escrow', 'W3-2': 'w3skill', 'W3-3': 'w3incremental',
  'W3-4': 'w3dag', 'W3-5': 'w3drift', 'W3-6': 'w3branch', 'W3-7': 'w3explore',
  'W3-8': 'w3score',
};

// W7-2 任务基线（2026-10-03 交接）：全量套件 2070/2059/0 fail、tsc exit 0。
// 仅 --full 用于全局声明比对；tests/pass 偏差按「在途批次」口径呈报，fail 才执法。
export const FULL_BASELINE = { tests: 2070, pass: 2059, fail: 0 };

const STEM_RE = /(?:^|[^A-Za-z0-9_\-])(w\d[a-z0-9]*)(?![A-Za-z0-9\-])/g; // 小写文件 stem
const LAW_ID_RE = /^\s*(W\d-\d+)\s*$/;                                    // Wn-m 式执法册号
const W_HEADING_RE = /纪元\s*(W\d)/;                                      // 「纪元 Wn」章节

// ── 1. GENESIS 解析（纯函数，selftest 可注入 fixture）────────────────────────

/** 行尾归一（仓库 .md 为 CRLF——统一为 \n，解析律与平台无关） */
export function normalizeMd(md) {
  return String(md).replace(/\r\n?/g, '\n');
}

/** 把 markdown 切成 ## 级章节 */
export function splitMdSections(md) {
  const out = [];
  const lines = normalizeMd(md).split('\n');
  let cur = null;
  let buf = [];
  const flush = () => {
    if (cur) out.push({ ...cur, text: buf.join('\n') });
  };
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      flush();
      cur = { level: m[1].length, title: m[2].trim(), line: m[2].trim() };
      buf = [];
    } else if (cur) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

/** 审判列 → { total, fail, kind } | null（取首个「；(」前段：账面口径段） */
export function parseJudgment(cell) {
  if (!cell) return null;
  const head = String(cell).split(/[；;（(]/)[0].trim();
  let m = head.match(/(\d+)\s*\/\s*(\d+)/);
  if (m) return { total: Number(m[1]), fail: Number(m[2]), kind: 'slash' };
  m = head.match(/(\d+)\s*(?:bench|冒烟)/);
  if (m) return { total: Number(m[1]), fail: 0, kind: 'count' };
  return null;
}

/** 执法列 → 小写文件 stem 列表（w4macro / w5cascade/w5gate/… 六文件） */
export function extractStems(lawCell) {
  const stems = [];
  for (const m of String(lawCell ?? '').matchAll(STEM_RE)) stems.push(m[1]);
  return [...new Set(stems)];
}

/** 执法列 → Wn-m 册号（若整格恰为册号） */
export function extractLawId(lawCell) {
  const m = String(lawCell ?? '').trim().match(LAW_ID_RE);
  return m ? m[1] : null;
}

/** 审判列全部 N/M 段 → [{total,fail,tag}]（去重保持出现序）。
 *  首段 = 账面口径段（；/（ 前）；其余段为格内旁注——同列并记「作者环境 9/0；
 *  本机复核 8/9」两面账时，8/9 为 pass/total 记法（后数>前数必非 tests/fail）
 *  译为 {total:9, fail:1, tag:'本机复核'}。次段上界 500 滤除日期式误配。 */
export function parseJudgmentSegments(cell) {
  if (!cell) return [];
  const s = String(cell);
  const segs = [];
  const push = (total, fail, tag) => {
    if (!segs.some((x) => x.total === total && x.fail === fail)) segs.push({ total, fail, tag });
  };
  const head = s.split(/[；;（(]/)[0].trim();
  let m = head.match(/(\d+)\s*\/\s*(\d+)/);
  if (m) push(Number(m[1]), Number(m[2]), '账面');
  else {
    m = head.match(/(\d+)\s*(?:bench|冒烟)/);
    if (m) push(Number(m[1]), 0, '账面');
  }
  for (const mm of s.matchAll(/(\d+)\s*\/\s*(\d+)/g)) {
    const a = Number(mm[1]);
    const b = Number(mm[2]);
    if (a > 500 || b > 500) continue; // 日期/大数非审判数字
    if (b > a) push(b, b - a, '本机复核'); // pass/total 记法（如 8/9 = 9 测 1 败）
    else push(a, b, '旁注');
  }
  return segs;
}

/** 章节散文中的「w2wire 10/0」式另立账（stem 紧邻 N/M；排除表格竖线跨格误配） */
export function extractProseClaims(text) {
  const claims = new Map();
  const re = /(?:^|[^A-Za-z0-9_\-])(w\d[a-z0-9]*)[^\n|]{0,12}?(\d+)\s*\/\s*(\d+)/g;
  for (const m of String(text).matchAll(re)) {
    const stem = m[1];
    if (!claims.has(stem)) {
      claims.set(stem, { stem, total: Number(m[2]), fail: Number(m[3]), source: 'prose' });
    }
  }
  return [...claims.values()];
}

/** 章节口径段的「合计 N/0」声明（如「九器官合计 169/0」） */
export function parseDeclaredTotal(text) {
  const m = String(text).match(/合计[^0-9\n]{0,12}(\d+)\s*\/\s*(\d+)/);
  return m ? { total: Number(m[1]), fail: Number(m[2]) } : null;
}

/** 解析 GENESIS 的全部 W 纪元章节（表行 + 散文另立账 + 合计声明） */
export function parseGenesisW(md) {
  md = normalizeMd(md);
  const epochs = [];
  for (const sec of splitMdSections(md)) {
    if (sec.level !== 2) continue;
    const em = sec.title.match(W_HEADING_RE);
    if (!em) continue; // 「真机审判（W-2…）」等非「纪元 Wn」章节不入审计面
    const epoch = em[1];
    const rows = [];
    for (const line of sec.text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('|')) continue;
      const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      if (cells.length < 4) continue;
      if (cells[0] === '器官' || /^[-: ]+$/.test(cells[0])) continue;
      const [organ, , law, verdict] = cells;
      const claim = parseJudgment(verdict);
      if (!claim) continue; // 无可定位审判数字（如「—」）
      rows.push({ epoch, organ, law, verdict, claim, segments: parseJudgmentSegments(verdict), source: 'table' });
    }
    epochs.push({
      epoch,
      title: sec.title,
      rows,
      proseClaims: extractProseClaims(sec.text),
      declaredTotal: parseDeclaredTotal(sec.text),
    });
  }
  return epochs;
}

// ── 2. DEBTS 解析（纯函数）───────────────────────────────────────────────────

/** 状态格 → 枚举主词（「需真机（部署后）；…」→ 需真机） */
export function statusTokenOf(status) {
  return String(status ?? '')
    .split(/[（(；;｜|/]/)[0]
    .replace(/[。．\s]+$/, '')
    .trim();
}

/** 头部「状态枚举（每条恰一）：**已闭环**（…）｜…」→ 自申报枚举集
 *  （blockquote 折行——拼接 '>' 续行后再取加粗词） */
export function parseDeclaredEnum(debtsMd) {
  const lines = normalizeMd(debtsMd).split('\n');
  const i = lines.findIndex((l) => l.includes('状态枚举'));
  if (i < 0) return [];
  let joined = lines[i].replace(/^>\s*/, '');
  for (let j = i + 1; j < lines.length && /^\s*>/.test(lines[j]); j++) {
    joined += lines[j].replace(/^\s*>\s?/, '');
  }
  return [...joined.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1].trim());
}

/** 解析 DEBTS：条目（编号/状态主词）、统计段申报数（分节条数 + 合计 + 债主分类） */
export function parseDebts(md) {
  md = normalizeMd(md);
  const rows = [];
  for (const sec of splitMdSections(md)) {
    const sm = sec.title.match(/^([A-G])\./);
    if (!sm) continue;
    for (const line of sec.text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('|')) continue;
      const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      if (cells.length < 5) continue;
      if (!/^D-[A-G]\d+$/.test(cells[0])) continue; // 表头/分隔行
      rows.push({
        id: cells[0],
        section: sm[1],
        sectionTitle: sec.title,
        statusRaw: cells[3],
        statusToken: statusTokenOf(cells[3]),
      });
    }
  }
  // 统计段：markdown 折行——整段拼成一行再取段（「条数…合计 N 条」与「未闭债主分类…」）
  const statsJoined = md
    .slice(Math.max(0, md.indexOf('统计与复核记录')))
    .replace(/\n/g, '');
  const cntSeg = statsJoined.slice(statsJoined.indexOf('条数'), statsJoined.indexOf('合计') + 20);
  const declaredCounts = {};
  for (const m of cntSeg.matchAll(/([A-G])\s+[^\s｜|，,\d][^\s｜|，,]*\s+(\d+)/g)) {
    declaredCounts[m[1]] = Number(m[2]);
  }
  const declaredTotal = Number((statsJoined.match(/合计\s*(\d+)\s*条/) ?? [])[1] ?? 0);
  const mainSeg = statsJoined.slice(statsJoined.indexOf('未闭债主分类'));
  const declaredMain = {};
  for (const m of mainSeg.matchAll(/(需真机|本纪元W6处理|需部署决策|需人工|已知取舍)[^\d（(]{0,6}?(\d+)/g)) {
    declaredMain[m[1]] = Number(m[2]);
  }
  return { rows, declaredEnum: parseDeclaredEnum(md), declaredCounts, declaredTotal, declaredMain };
}

// ── 3. 实跑执法（node --test 单文件，TAP 计数取末次——防测试自身打印干扰）────

/** TAP 输出 → 计数（同一计数器多次出现时取最后一个：TAP 摘要恒在末尾） */
export function parseTap(stdout) {
  const pick = (key) => {
    const ms = [...String(stdout).matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))];
    return ms.length ? Number(ms[ms.length - 1][1]) : null;
  };
  const tests = pick('tests');
  if (tests === null) return null; // 无摘要 = 进程未完成测试面
  return {
    tests,
    pass: pick('pass') ?? 0,
    fail: pick('fail') ?? 0,
    cancelled: pick('cancelled') ?? 0,
    skipped: pick('skipped') ?? 0,
  };
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch { /* 尽力 */ }
  } else {
    try { child.kill('SIGKILL'); } catch { /* 尽力 */ }
  }
}

/** 实跑单个测试文件（相对 repo 根路径），返回 TAP 计数或异常 */
export function runTestFile(relFile, timeoutMs = 300_000) {
  return new Promise((resolve) => {
    const args = [
      '--experimental-strip-types', '--test', '--test-reporter=tap',
      '--import', './test/register.mjs', relFile,
    ];
    const child = spawn(process.execPath, args, { cwd: ROOT, shell: false });
    let out = '';
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      killTree(child);
      resolve({ file: relFile, ok: false, error: `timeout>${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ file: relFile, ok: false, error: `spawn: ${e.message}` });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      const tap = parseTap(out);
      if (!tap) {
        resolve({
          file: relFile, ok: false, error: `no-tap-summary(exit=${code})`,
          stderrTail: err.split('\n').slice(-8).join('\n').slice(0, 600),
        });
        return;
      }
      resolve({ file: relFile, ok: true, code, ...tap });
    });
  });
}

/** 固定并发池（文件排序 + 结果按文件键聚合——与完成顺序无关，确定性面） */
export async function runPool(relFiles, { conc = 4, timeoutMs = 300_000 } = {}) {
  const sorted = [...new Set(relFiles)].sort();
  const results = new Map();
  let idx = 0;
  const worker = async () => {
    while (idx < sorted.length) {
      const f = sorted[idx++];
      results.set(f, await runTestFile(f, timeoutMs));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(conc, sorted.length)) }, worker));
  return results;
}

/** tsc --noEmit（exit 码即结论） */
export function runTsc(timeoutMs = 300_000) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit'],
      { cwd: ROOT, shell: false },
    );
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true; killTree(child);
      resolve({ ok: false, code: null, error: 'timeout' });
    }, timeoutMs);
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, code: null, error: e.message }); } });
    child.on('close', (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ ok: code === 0, code, stderrTail: err.slice(-500) });
    });
  });
}

// ── 4. 判定（纯函数）─────────────────────────────────────────────────────────

/** 账面 vs 实跑 → 一致 / 虚报 / 滞后（实跑异常由调用方先行分流） */
export function classify(claimTotal, claimFail, actTotal, actFail) {
  if (actTotal < claimTotal) return '虚报';
  if (actFail > claimFail) return '虚报';
  if (actTotal > claimTotal) return '滞后';
  return '一致';
}

/** 多段账面 vs 实跑：任一段逐字命中（tests 与 fail 双等）⇒ 一致（账面双面记账
 *  的诚实口径——本机环境命中「本机复核」段即账实相符）；否则按首段判定。 */
export function classifySegments(segments, actTotal, actFail) {
  if (!segments || segments.length === 0) return { verdict: 'n/a', note: '' };
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (actTotal === s.total && actFail === s.fail) {
      return {
        verdict: '一致',
        note: i > 0 ? `命中第${i + 1}段「${s.tag}」（${s.total}/${s.fail}）——双面账本机口径` : '',
      };
    }
  }
  const p = segments[0];
  return {
    verdict: classify(p.total, p.fail, actTotal, actFail),
    note: segments.length > 1
      ? `未命中任何申报段（${segments.map((x) => `${x.total}/${x.fail}`).join('｜')}），按首段判定`
      : '',
  };
}

/** 抽样护栏（纯函数）：每纪元保留前 N 条可实跑账目（不可实跑的 n/a 账全保留）；
 *  sample=null/undefined ⇒ 全部。确定性：顺序取前 N，零随机。 */
export function sampleClaims(claims, sample) {
  if (sample === null || sample === undefined) return claims;
  const out = [];
  const perEpoch = new Map();
  for (const c of claims) {
    if (c.files.length === 0) { out.push(c); continue; }
    const n = perEpoch.get(c.epoch) ?? 0;
    if (n < sample) { out.push(c); perEpoch.set(c.epoch, n + 1); }
  }
  return out;
}

// ── 5. 审计主流程 ────────────────────────────────────────────────────────────

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** stem → 实际测试文件（.test.ts 优先，次 .bench.ts）；带内容佐证读（缓存） */
async function makeResolver() {
  const contentCache = new Map();
  const resolveStem = (stem) => {
    for (const f of [`test/${stem}.test.ts`, `test/${stem}.bench.ts`]) {
      if (existsSync(path.join(ROOT, f))) return f;
    }
    return null;
  };
  const readCached = async (rel) => {
    if (!contentCache.has(rel)) {
      try { contentCache.set(rel, await readFile(path.join(ROOT, rel), 'utf8')); }
      catch { contentCache.set(rel, ''); }
    }
    return contentCache.get(rel);
  };
  return { resolveStem, readCached };
}

/**
 * 汇编审计。
 * opts: { sample?: number|null, run?: boolean, conc?: number, full?: boolean }
 */
export async function audit(opts = {}) {
  const { sample = null, run = true, conc = 4, full = false } = opts;
  const [genesisMd, debtsMd] = await Promise.all([
    readFile(GENESIS_PATH, 'utf8'),
    readFile(DEBTS_PATH, 'utf8'),
  ]);
  const epochs = parseGenesisW(genesisMd);
  const debts = parseDebts(debtsMd);
  const { resolveStem, readCached } = await makeResolver();

  // —— 账目展开：每条 claim = { label, organ, epoch, claim, files, missing, note } ——
  const claims = [];
  for (const ep of epochs) {
    const tableStems = new Set();
    for (const row of ep.rows) {
      let stems = extractStems(row.law);
      let lawId = extractLawId(row.law);
      let note = '';
      if (stems.length === 0 && lawId && ID_MAP[lawId]) stems = [ID_MAP[lawId]];
      for (const s of stems) tableStems.add(s);
      const files = [];
      const missing = [];
      for (const s of stems) {
        const f = resolveStem(s);
        if (f) files.push(f); else missing.push(s);
      }
      // 映射佐证：Wn-m 册号对应文件内容应含该册号（软证据，缺席仅注记）
      if (lawId && files.length === 1) {
        const body = await readCached(files[0]);
        if (!body.includes(lawId)) note = `映射佐证缺席（${files[0]} 未见 ${lawId}）`;
      }
      claims.push({
        epoch: ep.epoch,
        label: lawId ?? (stems.length ? stems.join('+') : truncate(row.law, 24)),
        organ: truncate(row.organ, 44),
        claim: row.claim,
        segments: row.segments,
        files,
        missing,
        note,
        source: 'table',
      });
    }
    for (const p of ep.proseClaims) {
      if (tableStems.has(p.stem)) continue; // 表行已立账，散文重复申报去重
      const f = resolveStem(p.stem);
      claims.push({
        epoch: ep.epoch,
        label: p.stem,
        organ: `（口径段另立账）${p.stem}`,
        claim: { total: p.total, fail: p.fail, kind: 'prose' },
        segments: [{ total: p.total, fail: p.fail, tag: '散文' }],
        files: f ? [f] : [],
        missing: f ? [] : [p.stem],
        note: '',
        source: 'prose',
      });
    }
  }

  // —— 抽样护栏（--sample N：每纪元取前 N 条可实跑账目；n/a 账保留；--parse 恒全量） ——
  const auditedClaims = run ? sampleClaims(claims, sample ?? null) : claims;

  // —— 盘存：磁盘 W1-W6 的 w* 文件（w7+ 为并行施工在途批次，不属本审计宇宙，
  //    且 GENESIS/DEBTS 均未为其立账——跑它们只会把施工噪声当账务信号）。
  //    「未入账」= 不在抽样前全体账面文件集内 ——
  const diskFiles = (await readdir(TEST_DIR))
    .filter((f) => /^w[1-6].*\.(test\.ts|bench\.ts)$/.test(f))
    .sort();
  const allClaimFiles = new Set(claims.flatMap((c) => c.files)); // 抽样前的完整账面文件集
  const auditedFiles = new Set(auditedClaims.flatMap((c) => c.files));
  const unledgeredFiles = diskFiles
    .map((f) => `test/${f}`)
    .filter((f) => !allClaimFiles.has(f));
  const universeFiles = run
    ? [...new Set([...auditedFiles, ...unledgeredFiles])].sort()
    : [];

  // —— 实跑 ——
  const results = run && universeFiles.length
    ? await runPool(universeFiles, { conc, timeoutMs: 300_000 })
    : new Map();

  // —— 逐账判定 ——
  const claimVerdicts = [];
  for (const c of auditedClaims) {
    if (c.files.length === 0) {
      claimVerdicts.push({
        ...c,
        verdict: c.claim.total === 0 && c.missing.length === 0
          ? 'n/a' // 0/0 且非 node 测试面（python --selftest 类）
          : (c.missing.length ? '虚报' : 'n/a'),
        detail: c.missing.length
          ? `账面引用测试文件缺席：${c.missing.join(', ')}`
          : '非 node 测试面（python/冒烟口径），账面 0/0 不实跑',
        actual: null,
      });
      continue;
    }
    if (!run) {
      claimVerdicts.push({ ...c, verdict: '未实跑', detail: '--parse 只解析模式', actual: null });
      continue;
    }
    const runs = c.files.map((f) => results.get(f)).filter(Boolean);
    const bad = runs.find((r) => !r.ok);
    if (runs.length !== c.files.length || bad) {
      claimVerdicts.push({
        ...c,
        verdict: '实跑异常',
        detail: bad ? `${bad.file}: ${bad.error}` : '结果缺席',
        actual: null,
      });
      continue;
    }
    const act = runs.reduce(
      (a, r) => ({
        tests: a.tests + r.tests, pass: a.pass + r.pass, fail: a.fail + r.fail,
        skipped: a.skipped + r.skipped, cancelled: a.cancelled + r.cancelled,
      }),
      { tests: 0, pass: 0, fail: 0, skipped: 0, cancelled: 0 },
    );
    const cls = classifySegments(c.segments, act.tests, act.fail);
    claimVerdicts.push({
      ...c,
      verdict: cls.verdict,
      detail: '',
      note: [c.note, cls.note].filter(Boolean).join('；'),
      actual: act,
    });
  }

  // —— 未入账文件（新纪元盘存）：0 fail 断言（全局基线声明） ——
  const unledgered = [];
  for (const f of unledgeredFiles) {
    const r = results.get(f);
    if (!run || !r) { unledgered.push({ file: f, verdict: '未盘', actual: null }); continue; }
    unledgered.push({
      file: f,
      verdict: r.ok ? (r.fail === 0 ? '未入账·0 fail ✓' : '未入账·fail>0') : '未入账·实跑异常',
      actual: r.ok ? r : null,
      error: r.ok ? null : r.error,
    });
  }

  // —— 纪元内合计自洽（纯文本算术；bench 台账独立口径——GENESIS 明示
  //    「.bench.ts 不入全量通配、独立跑批」，故合计核对剔除纯 bench 行） ——
  const stemsOfRow = (row) => {
    const s = extractStems(row.law);
    if (s.length) return s;
    const id = extractLawId(row.law);
    return id && ID_MAP[id] ? [ID_MAP[id]] : [];
  };
  const epochSums = epochs.map((ep) => {
    let tableSum = 0;
    let benchSum = 0;
    const tableStems = new Set();
    for (const r of ep.rows) {
      const stems = stemsOfRow(r);
      for (const s of stems) tableStems.add(s);
      const files = stems.map((s) => resolveStem(s)).filter(Boolean);
      const allBench = files.length > 0 && files.every((f) => f.endsWith('.bench.ts'));
      if (allBench) benchSum += r.claim.total;
      else tableSum += r.claim.total;
    }
    const extraInTable = ep.proseClaims
      .filter((p) => tableStems.has(p.stem))
      .reduce((a, p) => a + p.total, 0);
    const proseOnlySum = ep.proseClaims
      .filter((p) => !tableStems.has(p.stem))
      .reduce((a, p) => a + p.total, 0);
    // 双口径自洽（GENESIS 各纪元申报习惯不一，两式任一成立即账内可解释）：
    //   式一（W1/W3/W4/W5）：申报 + 表内与散文重复申报的另立账 = 表行加总
    //   式二（W2 实况）：表行加总 + 仅散文另立的接线账 = 申报（合计把「另立」也算进去了）
    const d = ep.declaredTotal?.total ?? null;
    const ok = d === null ? null
      : tableSum === d + extraInTable ? '自洽'
        : tableSum + proseOnlySum === d + extraInTable ? '自洽(含另立)'
          : '不自洽';
    return {
      epoch: ep.epoch, tableSum, benchSum, declared: d,
      prose另立InTable: extraInTable, proseOnlySum, ok,
    };
  });

  // —— DEBTS 审计 ——
  const ids = debts.rows.map((r) => r.id);
  const dupIds = ids.filter((x, i) => ids.indexOf(x) !== i);
  const enumSet = new Set(debts.declaredEnum);
  const enumViolations = debts.rows
    .filter((r) => !enumSet.has(r.statusToken) || !r.statusToken)
    .map((r) => ({ id: r.id, token: r.statusToken || '(空)', raw: truncate(r.statusRaw, 40) }));
  const actualCounts = {};
  for (const r of debts.rows) actualCounts[r.section] = (actualCounts[r.section] ?? 0) + 1;
  const countDiffs = [];
  for (const L of 'ABCDEFG') {
    const d = debts.declaredCounts[L];
    const a = actualCounts[L] ?? 0;
    if (d !== undefined && d !== a) countDiffs.push(`${L}: 账 ${d} vs 实 ${a}`);
  }
  const actualMain = {};
  for (const r of debts.rows) {
    if (r.statusToken !== '已闭环') {
      actualMain[r.statusToken] = (actualMain[r.statusToken] ?? 0) + 1;
    }
  }
  const mainDiffs = [];
  for (const [k, v] of Object.entries(debts.declaredMain)) {
    if ((actualMain[k] ?? 0) !== v) {
      mainDiffs.push(`${k}: 账 ${v} vs 实(状态主词) ${actualMain[k] ?? 0}`);
    }
  }
  const debtsAudit = {
    rowCount: debts.rows.length,
    declaredTotal: debts.declaredTotal,
    declaredEnum: debts.declaredEnum,
    enumViolations,
    dupIds,
    countDiffs,
    mainDiffs,
    rows: debts.rows,
  };

  // —— --full：全量套件 + tsc + 基线比对 ——
  let fullResult = null;
  if (full) {
    const allTests = (await readdir(TEST_DIR))
      .filter((f) => f.endsWith('.test.ts'))
      .sort()
      .map((f) => `test/${f}`);
    const fullRun = await new Promise((resolve) => {
      const args = [
        '--experimental-strip-types', '--test', '--test-reporter=tap',
        '--import', './test/register.mjs', ...allTests,
      ];
      const child = spawn(process.execPath, args, { cwd: ROOT, shell: false });
      let out = '';
      let err = '';
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true; killTree(child);
        resolve({ ok: false, error: 'timeout>1500s' });
      }, 1_500_000);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, error: e.message }); } });
      child.on('close', () => {
        if (done) return;
        done = true; clearTimeout(timer);
        const tap = parseTap(out);
        resolve(tap ? { ok: true, ...tap } : { ok: false, error: 'no-tap-summary' });
      });
    });
    const tsc = await runTsc();
    fullResult = { fullRun, tsc };
  }

  // —— 汇总 ——
  const tally = { 一致: 0, 虚报: 0, 滞后: 0, 'n/a': 0, 实跑异常: 0, 未实跑: 0 };
  for (const v of claimVerdicts) tally[v.verdict] = (tally[v.verdict] ?? 0) + 1;
  const tallyByEpoch = {};
  for (const v of claimVerdicts) {
    tallyByEpoch[v.epoch] ??= { 一致: 0, 虚报: 0, 滞后: 0, 'n/a': 0, 实跑异常: 0, 未实跑: 0, 条目: 0 };
    tallyByEpoch[v.epoch][v.verdict] = (tallyByEpoch[v.epoch][v.verdict] ?? 0) + 1;
    tallyByEpoch[v.epoch].条目 += 1;
  }
  const unledgeredFailBreak = unledgered.filter(
    (u) => u.verdict.includes('fail>0') || u.verdict.includes('异常'),
  );

  return {
    epochsFound: epochs.map((e) => e.epoch),
    epochsMissing: ['W1', 'W2', 'W3', 'W4', 'W5', 'W6'].filter((w) => !epochs.some((e) => e.epoch === w)),
    claimVerdicts,
    epochSums,
    unledgered,
    debtsAudit,
    tally,
    tallyByEpoch,
    unledgeredFailBreak,
    fullResult,
  };
}

// ── 6. 报告 ──────────────────────────────────────────────────────────────────

const W = process.stdout.write.bind(process.stdout);

function printReport(r, opts) {
  W('════════════════════════════════════════════════════════════════\n');
  W('创世审计器 W7-2 · GENESIS 账实一致审计（机器执法，只报告不代改）\n');
  W(`审计对象：GENESIS.md W 纪元账目 × test/w*.test.ts|bench 实跑；DEBTS.md 台账\n`);
  W(`模式：${opts.run ? (opts.sample ? `抽样(每纪元前 ${opts.sample} 条)` : '全部 W 纪元账目实跑') : '仅解析(--parse)'}`
    + `${opts.full ? ' + 全量套件/tsc/基线比对(--full)' : ''}；并发 ${opts.conc}；node ${process.version}\n`);
  W('────────────────────────────────────────────────────────────────\n');

  const byEpoch = new Map();
  for (const v of r.claimVerdicts) {
    if (!byEpoch.has(v.epoch)) byEpoch.set(v.epoch, []);
    byEpoch.get(v.epoch).push(v);
  }
  const epochOrder = [...new Set([...r.epochsFound, 'W1', 'W2', 'W3', 'W4', 'W5', 'W6'])].sort();
  for (const ep of epochOrder) {
    const vs = byEpoch.get(ep) ?? [];
    const sum = r.epochSums.find((s) => s.epoch === ep);
    const inLedger = r.epochsFound.includes(ep);
    if (!inLedger && vs.length === 0) {
      const prefix = `/w${ep.slice(1)}`; // 文件 stem 小写：test/w6deep.test.ts
      const un = r.unledgered.filter((u) => u.file.includes(prefix));
      W(`\n── 纪元 ${ep}：GENESIS 未入账（在途批次）\n`);
      if (un.length) {
        for (const u of un) {
          W(`  ${u.file}  实跑 tests=${u.actual?.tests ?? '?'} pass=${u.actual?.pass ?? '?'} fail=${u.actual?.fail ?? '?'}  ${u.verdict}\n`);
        }
      } else {
        W('  （磁盘无对应文件）\n');
      }
      continue;
    }
    W(`\n── 纪元 ${ep}（${vs.length} 条账目）\n`);
    for (const v of vs) {
      const 账 = `${v.claim.total}/${v.claim.fail}`;
      const 实 = v.actual
        ? `${v.actual.tests}/${v.actual.pass}/${v.actual.fail}` +
          (v.actual.skipped || v.actual.cancelled
            ? `(skip ${v.actual.skipped},cancel ${v.actual.cancelled})` : '')
        : '—';
      W(`  [${v.label}] ${v.organ}\n` +
        `      账面 ${账}  实跑(tests/pass/fail) ${实}  ⇒ ${v.verdict}` +
        (v.detail ? `  · ${v.detail}` : '') + (v.note ? `  · ${v.note}` : '') + '\n');
    }
    if (sum) {
      W(`  合计自洽：表行加总 ${sum.tableSum} vs 口径段申报 ${sum.declared}` +
        (sum.prose另立InTable ? `（+表内另立 ${sum.prose另立InTable}）` : '') +
        (sum.proseOnlySum ? `（+仅散文另立 ${sum.proseOnlySum}）` : '') +
        ` ⇒ ${sum.ok === null ? '无申报(不计)' : sum.ok === '自洽' ? '自洽 ✓' : sum.ok === '自洽(含另立)' ? '自洽(含另立接线账——申报合计把「另立」计入，如实注记) ✓' : '不自洽 ✗'}\n`);
    }
  }

  if (r.unledgered.length) {
    W('\n── 新纪元盘存（磁盘 w* 文件 vs 账面）\n');
    for (const u of r.unledgered) {
      W(`  ${u.file}  ${u.actual ? `实跑 tests=${u.actual.tests} pass=${u.actual.pass} fail=${u.actual.fail}` : '未实跑'}  ⇒ ${u.verdict}\n`);
    }
  }

  const d = r.debtsAudit;
  W('\n── DEBTS.md 台账审计\n');
  W(`  条目 ${d.rowCount} 条（申报合计 ${d.declaredTotal ?? '?'}）${d.dupIds.length ? ` · 编号重复：${d.dupIds.join(',')}` : ' · 编号唯一 ✓'}\n`);
  W(`  分节条数对照：${d.countDiffs.length ? d.countDiffs.join('；') + ' ✗' : '与统计段一致 ✓'}\n`);
  W(`  状态枚举校验（台账自申报枚举 ${d.declaredEnum.length} 值：${d.declaredEnum.join('/')})：\n`);
  if (d.enumViolations.length === 0) {
    W('    全部合法 ✓\n');
  } else {
    W(`    违例 ${d.enumViolations.length} 条（状态主词未入头部申报枚举）：\n`);
    for (const v of d.enumViolations) W(`      ${v.id} → 「${v.token}」（原文：${v.raw}）\n`);
  }
  if (d.mainDiffs.length) {
    W(`  未闭债主分类口径对照（软）：${d.mainDiffs.join('；')}（统计段按语义归组——含跨类注记条目，如实呈报不计虚报）\n`);
  }

  if (r.fullResult) {
    const fr = r.fullResult.fullRun;
    const tsc = r.fullResult.tsc;
    W('\n── 全量套件 + typecheck（--full）\n');
    if (fr.ok) {
      W(`  全量：tests ${fr.tests} / pass ${fr.pass} / fail ${fr.fail} / cancelled ${fr.cancelled} / skipped ${fr.skipped}\n`);
      W(`  基线：tests ${FULL_BASELINE.tests} / pass ${FULL_BASELINE.pass} / fail ${FULL_BASELINE.fail}` +
        ` ⇒ fail ${fr.fail === FULL_BASELINE.fail ? '持平 ✓（「0 fail」声明成立）' : `偏差 ${fr.fail - FULL_BASELINE.fail} ✗`}` +
        `；tests/pass 偏差（在途批次口径，呈报不执法）：${fr.tests - FULL_BASELINE.tests}/${fr.pass - FULL_BASELINE.pass}\n`);
    } else {
      W(`  全量：实跑异常 ${fr.error}\n`);
    }
    W(`  tsc -p tsconfig.json --noEmit ⇒ exit ${tsc.code ?? '?'} ${tsc.ok ? '（0 错声明成立 ✓）' : `✗ ${tsc.error ?? tsc.stderrTail ?? ''}`}\n`);
  }

  W('\n── 汇总\n');
  W(`  账目判定：共 ${r.claimVerdicts.length} 条 = 一致 ${tallyOf(r, '一致')} · 虚报 ${tallyOf(r, '虚报')} · 滞后 ${tallyOf(r, '滞后')} · n/a ${tallyOf(r, 'n/a')} · 实跑异常 ${tallyOf(r, '实跑异常')}` +
    (tallyOf(r, '未实跑') ? ` · 未实跑 ${tallyOf(r, '未实跑')}(--parse)` : '') + '\n');
  {
    const eos = [...new Set([...r.epochsFound, 'W1', 'W2', 'W3', 'W4', 'W5', 'W6'])].sort();
    const parts = [];
    for (const ep of eos) {
      const t = r.tallyByEpoch[ep];
      if (t) {
        parts.push(`${ep} 一致${t.一致}/虚报${t.虚报}/滞后${t.滞后}` +
          (t['n/a'] ? `/n-a${t['n/a']}` : '') + (t.实跑异常 ? `/异常${t.实跑异常}` : '') +
          (t.未实跑 ? `/未跑${t.未实跑}` : ''));
      } else {
        const un = r.unledgered.filter((u) => u.file.includes(`/w${ep.slice(1)}`));
        const bad = un.filter((u) => u.verdict.includes('fail>0') || u.verdict.includes('异常')).length;
        parts.push(`${ep} 未入账盘存${un.length}文件${un.length ? (bad ? `（${bad} 个 fail>0/异常）` : '（0 fail ✓）') : '（磁盘无文件）'}`);
      }
    }
    W(`  分纪元：${parts.join(' · ')}\n`);
  }
  W(`  未入账新纪元文件：${r.unledgered.length} 个（其中 fail>0/异常：${r.unledgeredFailBreak.length} 个${r.unledgeredFailBreak.length ? '——盘存警告：在途批次实跑有红，无账面可违不入 --check 执法面，' + r.unledgeredFailBreak.map((u) => u.file).join('、') : ''}）\n`);
  W(`  DEBTS：枚举违例 ${d.enumViolations.length} 条 · 分节条数偏差 ${d.countDiffs.length} 处 · 编号重复 ${d.dupIds.length} 处\n`);
  const 虚报明细 = r.claimVerdicts.filter((v) => v.verdict === '虚报' || v.verdict === '实跑异常');
  if (虚报明细.length) {
    W('  虚报/异常明细：\n');
    for (const v of 虚报明细) {
      W(`    [${v.epoch}/${v.label}] ${v.organ}：账面 ${v.claim.total}/${v.claim.fail} vs 实跑 ${
        v.actual ? `${v.actual.tests}/…/${v.actual.fail}` : '未跑成'} ⇒ ${v.verdict}${v.detail ? ' · ' + v.detail : ''}\n`);
    }
  }
  const 滞后明细 = r.claimVerdicts.filter((v) => v.verdict === '滞后');
  if (滞后明细.length) {
    W('  滞后明细（账未跟上现实——如实呈报）：\n');
    for (const v of 滞后明细) {
      W(`    [${v.epoch}/${v.label}] ${v.organ}：账面 ${v.claim.total} vs 实跑 ${v.actual.tests}\n`);
    }
  }
}

function tallyOf(r, k) { return r.claimVerdicts.filter((v) => v.verdict === k).length; }

// printReport 里为标题展示重读 GENESIS 章节标题（避免把大文本塞进审计结果）
import { readFileSync } from 'node:fs';
let require_cache_genesis = null;
function genesisTitles() {
  if (!require_cache_genesis) require_cache_genesis = readFileSync(GENESIS_PATH, 'utf8');
  return parseGenesisW(require_cache_genesis).map((e) => `${e.epoch} ${truncate(e.title, 30)}`);
}

// ── 7. JSON 输出（确定性面：不含时长/时间戳） ────────────────────────────────

function toJson(r) {
  return JSON.stringify(
    {
      auditor: 'W7-2 genesis_audit',
      epochsFound: r.epochsFound,
      epochsMissing: r.epochsMissing,
      claims: r.claimVerdicts.map((v) => ({
        epoch: v.epoch, label: v.label, organ: v.organ,
        claim: { total: v.claim.total, fail: v.claim.fail },
        actual: v.actual
          ? { tests: v.actual.tests, pass: v.actual.pass, fail: v.actual.fail,
              skipped: v.actual.skipped, cancelled: v.actual.cancelled }
          : null,
        verdict: v.verdict, detail: v.detail || undefined, note: v.note || undefined,
      })),
      epochSums: r.epochSums,
      unledgered: r.unledgered.map((u) => ({
        file: u.file,
        verdict: u.verdict,
        actual: u.actual
          ? { tests: u.actual.tests, pass: u.actual.pass, fail: u.actual.fail }
          : null,
      })),
      debts: {
        rowCount: r.debtsAudit.rowCount,
        declaredTotal: r.debtsAudit.declaredTotal,
        declaredEnum: r.debtsAudit.declaredEnum,
        enumViolations: r.debtsAudit.enumViolations,
        dupIds: r.debtsAudit.dupIds,
        countDiffs: r.debtsAudit.countDiffs,
        mainDiffs: r.debtsAudit.mainDiffs,
      },
      tally: r.tally,
      tallyByEpoch: r.tallyByEpoch,
      full: r.fullResult
        ? {
            suite: r.fullResult.fullRun.ok
              ? { tests: r.fullResult.fullRun.tests, pass: r.fullResult.fullRun.pass,
                  fail: r.fullResult.fullRun.fail, cancelled: r.fullResult.fullRun.cancelled,
                  skipped: r.fullResult.fullRun.skipped }
              : { error: r.fullResult.fullRun.error },
            tscExit: r.fullResult.tsc.code,
            baseline: FULL_BASELINE,
          }
        : null,
    },
    null, 2,
  );
}

// ── 8. CLI ───────────────────────────────────────────────────────────────────

function usage() {
  W(`用法：node scripts/genesis_audit.mjs [选项]
  （默认）抽样审计：每纪元前 3 条可实跑账目 + W1-W6 未入账盘存逐文件实跑
  --check      严格模式：虚报/实跑异常（--full 另含全量 fail>0、tsc≠0）⇒ exit 1
  --full       全量：全部账目实跑 + 全量套件 + tsc + 基线(2070/2059/0)比对
  --sample N   每纪元抽前 N 条可实跑账目（N=0 ⇒ 全部账目；默认 3；--full 隐含 0）
  --parse      只做可文本核验项（解析/枚举/算术自洽），不实跑
  --json       机读输出（与文本模式同判定；判定面零时长字段）
  --conc N     实跑并发（默认 4）
  --selftest   审计器自身单元测试
  --help       本说明
`);
}

async function main(argv) {
  const flags = {
    check: argv.includes('--check'),
    full: argv.includes('--full'),
    json: argv.includes('--json'),
    parse: argv.includes('--parse'),
    selftest: argv.includes('--selftest'),
    help: argv.includes('--help') || argv.includes('-h'),
  };
  const sampleIdx = argv.indexOf('--sample');
  const sampleArg = sampleIdx >= 0 ? Math.max(0, Number(argv[sampleIdx + 1]) || 0) : null;
  // 规格④默认抽样：显式 --sample N 覆写（N=0 ⇒ 全部账目）；--full 隐含全量；否则每纪元前 3 条
  const sample = sampleArg !== null ? (sampleArg === 0 ? null : sampleArg) : (flags.full ? null : 3);
  const concIdx = argv.indexOf('--conc');
  const conc = concIdx >= 0 ? Math.max(1, Number(argv[concIdx + 1]) || 4) : 4;

  if (flags.help) { usage(); return 0; }
  if (flags.selftest) { return await selftest(); }

  const t0 = Date.now();
  const r = await audit({ sample, run: !flags.parse, conc, full: flags.full });

  if (flags.json) {
    W(toJson(r));
  } else {
    printReport(r, { run: !flags.parse, sample, full: flags.full, conc });
    W(`（纪元章节：${genesisTitles().join(' ｜ ')}）\n`);
  }

  let exit0 = true;
  const fatal = r.claimVerdicts.filter((v) => v.verdict === '虚报' || v.verdict === '实跑异常');
  if (flags.check) {
    // 执法面 = 账面声明被违反（虚报/实跑异常）；--full 另执法全局「0 fail」与 tsc。
    // 未入账在途文件的 fail>0 是盘存警告（无账面可违——DEBTS「并行批次在途文件」
    // 先例），醒目呈报不计 exit。
    if (fatal.length) exit0 = false;
    if (flags.full && r.fullResult) {
      if (r.fullResult.fullRun.ok ? r.fullResult.fullRun.fail > 0 : true) exit0 = false;
      if (!r.fullResult.tsc.ok) exit0 = false;
    }
  }
  // JSON 模式：stdout 只留纯 JSON（逐字节可复现——判定面零时长字段），
  // 退出状态行走 stderr（耗时属运维面，不污染机读面）。
  const statusLine = `\n[退出码 ${exit0 ? 0 : 1}] 虚报/实跑异常 ${fatal.length} 条` +
    (flags.check ? `（--check 严格模式${exit0 ? '：通过' : '：不通过'}）` : '（未启用 --check，仅报告）') +
    ` · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`;
  if (flags.json) process.stderr.write(statusLine);
  else W(statusLine);
  return exit0 ? 0 : 1;
}

// ── 9. 自测（--selftest：纯函数 fixtures + 真实最小实跑）────────────────────

async function selftest() {
  const { equal, deepEqual, ok } = await import('node:assert/strict');
  let n = 0;
  const t = (name, fn) => {
    fn(); n++;
    W(`  ok ${n} - ${name}\n`);
  };

  W('TAP version 14\n');

  // —— parseJudgment ——
  t('parseJudgment 37/0', () => {
    deepEqual(parseJudgment('37/0'), { total: 37, fail: 0, kind: 'slash' });
  });
  t('parseJudgment 0/0（Python 自测 58 断言）', () => {
    deepEqual(parseJudgment('0/0（Python 自测 58 断言）'), { total: 0, fail: 0, kind: 'slash' });
  });
  t('parseJudgment 9 冒烟（作者环境 9/0；本机 8/9）取账面段', () => {
    deepEqual(parseJudgment('9 冒烟（作者环境 9/0；本机复核 8/9）'), { total: 9, fail: 0, kind: 'count' });
  });
  t('parseJudgment 7 bench 全绿；长注…', () => {
    deepEqual(parseJudgment('7 bench 全绿；声明 vs 实测：C1 50.0%｜P2C3 74.6%'), { total: 7, fail: 0, kind: 'count' });
  });
  t('parseJudgment 无数字 → null', () => {
    equal(parseJudgment('—'), null);
    equal(parseJudgment(''), null);
  });

  // —— extractStems / extractLawId ——
  t('extractStems W1-1 册号格 → 空（走 ID_MAP）', () => {
    deepEqual(extractStems('W1-1'), []);
    equal(extractLawId('W1-1'), 'W1-1');
  });
  t('extractStems w5 六文件复合格', () => {
    deepEqual(
      extractStems('w5cascade/w5gate/w5ledger/w5roi/w5macro/w5settle（六文件）'),
      ['w5cascade', 'w5gate', 'w5ledger', 'w5roi', 'w5macro', 'w5settle'],
    );
  });
  t('extractStems python --selftest → 空', () => {
    deepEqual(extractStems('python --selftest'), []);
    equal(extractLawId('python --selftest'), null);
  });
  t('ID_MAP 全部键可由册号定位到 stem', () => {
    for (const [id, stem] of Object.entries(ID_MAP)) {
      ok(/^w\d[a-z0-9]*$/.test(stem), `${id} → ${stem} 格式`);
    }
  });

  // —— 散文另立账 / 合计声明 ——
  t('extractProseClaims 捕获 w2wire 10/0，排除表格竖线跨格', () => {
    const text = '九器官合计 169/0；W2-0 集成接线另立 w2wire 10/0\n（config 缺省落位）\n| w1exec | 37/0 |';
    const claims = extractProseClaims(text);
    equal(claims.length, 1);
    deepEqual(claims[0], { stem: 'w2wire', total: 10, fail: 0, source: 'prose' });
  });
  t('parseDeclaredTotal 九器官合计 169/0', () => {
    deepEqual(parseDeclaredTotal('审判口径：N/0 = …；九器官合计 169/0；另立 w2wire 10/0'), { total: 169, fail: 0 });
  });

  // —— GENESIS 章节切分 ——
  t('parseGenesisW：仅收「纪元 Wn」章节，排除 W-2 真机审判', () => {
    const md = [
      '# 创世总账', '',
      '## 证明与审计', '旧纪元（不入审计面）', '',
      '## 执行与感知韧性（纪元 W1 · 九器官 + W2-0 集成接线）',
      '| 器官 | 根基 | 执法 | 审判 |',
      '| --- | --- | --- | --- |',
      '| 执行层四连改 | 三区判决 | W1-1 | 37/0 |',
      '| 带外确认码 | CSPRNG | W1-2 | 13/0 |',
      '审判口径：九器官合计 50/0；W2-0 集成接线另立 w2wire 10/0', '',
      '## 真机审判（W-2，器官时代后）',
      '| 器官 | 根基 | 执法 | 审判 |',
      '| x | y | z | 4/4 |', '',
      '## 第五批收官潮（纪元 W5 · 七器官）',
      '| 器官 | 根基 | 执法 | 审判 |',
      '| 效能基准 | 七项 | w5cascade/w5gate | 7 bench 全绿；C1 50.0% |',
      '| pyreg | 冒烟 | w5pyreg | 9 冒烟（作者环境 9/0；本机 8/9） |',
    ].join('\n');
    const eps = parseGenesisW(md);
    deepEqual(eps.map((e) => e.epoch), ['W1', 'W5']);
    equal(eps[0].rows.length, 2);
    deepEqual(eps[0].rows[0].claim, { total: 37, fail: 0, kind: 'slash' });
    deepEqual(eps[1].rows[0].claim, { total: 7, fail: 0, kind: 'count' });
    deepEqual(eps[1].rows[1].claim, { total: 9, fail: 0, kind: 'count' });
  });

  // —— classify ——
  t('classify 四象限', () => {
    equal(classify(37, 0, 37, 0), '一致');
    equal(classify(37, 0, 35, 0), '虚报');
    equal(classify(9, 0, 9, 1), '虚报');
    equal(classify(10, 0, 12, 0), '滞后');
  });

  // —— 多段审判数字（双面账）——
  t('parseJudgmentSegments：首段=账面，8/9 译为本机复核 {9,1}', () => {
    deepEqual(
      parseJudgmentSegments('9 冒烟（作者环境 9/0；本机复核 8/9）'),
      [{ total: 9, fail: 0, tag: '账面' }, { total: 9, fail: 1, tag: '本机复核' }],
    );
    deepEqual(parseJudgmentSegments('37/0'), [{ total: 37, fail: 0, tag: '账面' }]);
    deepEqual(parseJudgmentSegments('—'), []);
    deepEqual(parseJudgmentSegments('0/0（Python 自测 58 断言）'), [{ total: 0, fail: 0, tag: '账面' }]);
    // 日期式大数不构成审判段
    deepEqual(parseJudgmentSegments('12/0（复核 2026/10/03）'), [{ total: 12, fail: 0, tag: '账面' }]);
  });
  t('classifySegments：任一段命中 ⇒ 一致；全不中 ⇒ 按首段判定', () => {
    const segs = [{ total: 9, fail: 0, tag: '账面' }, { total: 9, fail: 1, tag: '本机复核' }];
    equal(classifySegments(segs, 9, 0).verdict, '一致');
    equal(classifySegments(segs, 9, 1).verdict, '一致');
    ok(classifySegments(segs, 9, 1).note.includes('本机复核'));
    equal(classifySegments([{ total: 9, fail: 0, tag: '账面' }], 9, 1).verdict, '虚报');
    equal(classifySegments([{ total: 9, fail: 0, tag: '账面' }], 12, 0).verdict, '滞后');
    equal(classifySegments([], 5, 0).verdict, 'n/a');
  });

  // —— DEBTS 解析 ——
  t('statusTokenOf 剥离注记', () => {
    equal(statusTokenOf('需真机（部署后）；部署面见 D-C2'), '需真机');
    equal(statusTokenOf('本纪元W6处理（编码管线接线）/部署协同'), '本纪元W6处理');
    equal(statusTokenOf('已知取舍'), '已知取舍');
    equal(statusTokenOf('已闭环（立法本身；各开闸…）'), '已闭环');
  });
  t('parseDeclaredEnum 从台账头取自申报枚举', () => {
    const md = '> 状态枚举（每条恰一）：**已闭环**（债清）｜**本纪元W6处理**（W6 后续包）｜**需真机**（硬件）｜**需部署决策**（部署方）｜**需人工**（非代码）';
    deepEqual(parseDeclaredEnum(md), ['已闭环', '本纪元W6处理', '需真机', '需部署决策', '需人工']);
  });
  t('parseDebts：行/枚举违例/统计段', () => {
    const md = [
      '# 台账', '',
      '> 状态枚举（每条恰一）：**已闭环**｜**需真机**',
      '',
      '## A. 真机验证清单',
      '| # | 来源 | 描述 | 状态 | 证据 |',
      '| --- | --- | --- | --- | --- |',
      '| D-A1 | W4-6 | UVC | 需真机 | uvc.py |',
      '| D-A2 | W4-6 | HID | 需真机（部署后） | hid.py |',
      '',
      '## B. 激活开关清单',
      '| # | 来源 | 描述 | 状态 | 证据 |',
      '| D-B1 | W1-7 | som | 已知取舍 | som.ts |',
      '',
      '## 统计与复核记录',
      '条数（含已闭环留档）：A 真机 2 ｜ B 激活开关 1',
      ' —— 合计 3 条。', // 折行：合计在续行
      '未闭债主分类：需真机 2｜已知取舍留档',
      ' 1。',
    ].join('\n');
    const d = parseDebts(md);
    equal(d.rows.length, 3);
    deepEqual(d.declaredEnum, ['已闭环', '需真机']);
    deepEqual(d.declaredCounts, { A: 2, B: 1 });
    equal(d.declaredTotal, 3);
    equal(d.declaredMain['需真机'], 2);
    equal(d.declaredMain['已知取舍'], 1);
    const viol = d.rows.filter((r) => !new Set(d.declaredEnum).has(r.statusToken));
    deepEqual(viol.map((v) => v.id), ['D-B1']);
  });
  t('parseDeclaredEnum：blockquote 折行续接（仓库 .md 实况）', () => {
    const md = [
      '# 台账', '',
      '> 状态枚举（每条恰一）：**已闭环**（债清，留档防复发）｜**本纪元W6处理**（W6 后续',
      '> 包职权内可闭）｜**需真机**（硬件/长跑数据在环才能闭）｜**需部署决策**（扩表/',
      '> 生产化/开闸是部署方知识决策，代码不代立法）｜**需人工**（插件面/CI 环境/拆分',
      '> 决策等非代码职权）。',
      '',
      '## A. 表',
    ].join('\n');
    deepEqual(parseDeclaredEnum(md), ['已闭环', '本纪元W6处理', '需真机', '需部署决策', '需人工']);
  });

  // —— TAP 解析（取末次计数，防测试自身打印伪计数） ——
  t('parseTap 取末次计数', () => {
    const tap = ['# tests 3', '# pass 3', '# fail 0', '# tests 8', '# pass 8', '# fail 0', '# cancelled 0', '# skipped 0'];
    deepEqual(parseTap(tap.join('\n')), { tests: 8, pass: 8, fail: 0, cancelled: 0, skipped: 0 });
    equal(parseTap('crash before summary'), null);
  });

  // —— 真实文件确定性解析（两次 deepEqual） ——
  const genesisMd = await readFile(GENESIS_PATH, 'utf8');
  const debtsMd = await readFile(DEBTS_PATH, 'utf8');
  t('真实 GENESIS 两次解析逐字段一致（确定性）', () => {
    deepEqual(parseGenesisW(genesisMd), parseGenesisW(genesisMd));
  });
  t('真实 DEBTS 两次解析逐字段一致（确定性）', () => {
    deepEqual(parseDebts(debtsMd), parseDebts(debtsMd));
  });
  t('真实 GENESIS 命中 W1-W5 五纪元且账目≥40条', () => {
    const eps = parseGenesisW(genesisMd);
    deepEqual(eps.map((e) => e.epoch), ['W1', 'W2', 'W3', 'W4', 'W5']);
    const rows = eps.reduce((a, e) => a + e.rows.length, 0);
    ok(rows >= 40, `rows=${rows}`);
  });
  t('真实 DEBTS 枚举自申报且条目≥30', () => {
    const d = parseDebts(debtsMd);
    ok(d.declaredEnum.length >= 5);
    ok(d.rows.length >= 30, `rows=${d.rows.length}`);
  });

  // —— 审计级确定性 / 盘存面 / 抽样护栏（audit 纯文本面，两次调用零实跑） ——
  {
    const a1 = await audit({ run: false });
    const a2 = await audit({ run: false });
    t('audit(--parse 面) 两次调用逐字段 deepEqual（确定性）', () => {
      deepEqual(a1, a2);
    });
    t('盘存面限定 W1-W6（w7+ 在途批次不入审计宇宙）', () => {
      ok(a1.unledgered.length >= 1, `unledgered=${a1.unledgered.length}`);
      ok(a1.unledgered.every((u) => /^test\/w[1-6]/.test(u.file)),
        `越界文件：${a1.unledgered.filter((u) => !/^test\/w[1-6]/.test(u.file)).map((u) => u.file).join(',')}`);
    });
    t('真实 GENESIS 五纪元合计自洽全过（W2 为含另立口径）', () => {
      const bad = a1.epochSums.filter((s) => s.ok === '不自洽');
      equal(bad.length, 0, JSON.stringify(bad));
      equal(a1.epochSums.find((s) => s.epoch === 'W2').ok, '自洽(含另立)');
    });
    t('分纪元 tally 与账目总数对账', () => {
      const n = Object.values(a1.tallyByEpoch).reduce((x, e) => x + e.条目, 0);
      equal(n, a1.claimVerdicts.length);
      deepEqual(Object.keys(a1.tallyByEpoch).sort(), a1.epochsFound.slice().sort());
    });
    t('抽样护栏（纯函数）：--sample 1 ⇒ 每纪元恰 1 条可实跑账目（n/a 保留）', () => {
      const mk = (epoch, runnable) => ({
        epoch, files: runnable ? ['test/x.test.ts'] : [],
        claim: { total: 1, fail: 0 }, segments: [],
      });
      const claims = [mk('W1', true), mk('W1', true), mk('W1', false), mk('W2', true), mk('W2', true)];
      const out = sampleClaims(claims, 1);
      equal(out.length, 3); // W1 首条 + W1 的 n/a + W2 首条
      equal(out.filter((c) => c.epoch === 'W1' && c.files.length).length, 1);
      ok(out.includes(claims[2]), 'n/a 账保留');
      deepEqual(sampleClaims(claims, null), claims);
      equal(sampleClaims(claims, 0).length, 1); // 0 ⇒ 仅 n/a 账保留（CLI 层已把 0 归一为 null=全部）
    });
  }

  // —— 真实最小实跑（端到端验证执法通道） ——
  if (existsSync(path.join(ROOT, 'test/w1exp4.test.ts'))) {
    const r = await runTestFile('test/w1exp4.test.ts', 120_000);
    t('真实实跑 w1exp4（账面 8/0）：TAP 计数且 0 fail', () => {
      ok(r.ok, `run ok: ${JSON.stringify(r)}`);
      equal(r.fail, 0);
      ok(r.tests >= 1);
    });
  }
  if (existsSync(path.join(ROOT, 'test/w5gate.bench.ts'))) {
    const r = await runTestFile('test/w5gate.bench.ts', 120_000);
    t('真实实跑 bench 文件（.bench.ts 通道）：TAP 计数且 0 fail', () => {
      ok(r.ok, `run ok: ${JSON.stringify(r)}`);
      equal(r.fail, 0);
      ok(r.tests >= 1);
    });
  }

  // —— 端到端执法探针：篡改账面副本（正本只读，绝不代改）⇒ --check 必须 exit 1 ——
  {
    const { writeFile, mkdtemp } = await import('node:fs/promises');
    const os = await import('node:os');
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'genesis-audit-probe-'));
    const doctored = genesisMd.replace('| W1-1 | 37/0 |', '| W1-1 | 99/0 |');
    ok(doctored !== genesisMd, '探针前提：篡改点在正本中存在');
    const doctoredPath = path.join(tmp, 'GENESIS.doctored.md');
    await writeFile(doctoredPath, doctored, 'utf8');
    const runCli = (args) => new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), ...args],
        {
          cwd: ROOT, shell: false,
          env: { ...process.env, DSH_AUDIT_GENESIS: doctoredPath, DSH_AUDIT_DEBTS: DEBTS_PATH },
        },
      );
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out }));
    });
    const bad = await runCli(['--check', '--sample', '1']);
    t('端到端执法：篡改账面 37→99（虚报）⇒ --check exit 1', () => {
      equal(bad.code, 1, `CLI 输出片段：${bad.out.slice(-400)}`);
      ok(bad.out.includes('虚报'));
    });
    const clean = await runCli(['--check', '--parse']);
    t('端到端执法：正本账面（--parse）⇒ --check exit 0', () => {
      equal(clean.code, 0, `CLI 输出片段：${clean.out.slice(-400)}`);
    });
  }

  W(`1..${n}\n# tests ${n}\n# pass ${n}\n# fail 0\n`);
  return 0;
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

// 直跑守卫：仅 `node scripts/genesis_audit.mjs …` 执行 main；被 test/w7audit.test.ts
// 等模块 import 时不触发审计（否则一次 import 就全量实跑）。
import { pathToFileURL } from 'node:url';
const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('genesis_audit 未捕获异常：', e);
      process.exit(2);
    });
}
