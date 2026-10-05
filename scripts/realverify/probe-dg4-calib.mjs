// scripts/realverify/probe-dg4-calib.mjs
// ΤΕΛ-9a 逐债探针 · D-G4:Kalman/GPD/Schmitt/NCD 标定生产数据面。
//
// 债（DEBTS D-G4）：Kalman/GPD 标定值待生产数据（睡眠④幕只建议不落值的
// 立法语义——数据面待长跑）；Schmitt/NCD 两原子需先落账数据面（弹窗帧
// 三元组/检索回访标签）。本探针把「长跑数据到手那天」的收割动作一键化：
// 生产数据 → 逐族喂 src/calibration.ts 的标定纯函数（dist 构建件单源复用）
// → 建议值 + 样本量 + 拟合优度结构化产出。
//
//   环境自检（在场判定 = 生产数据面在场）：
//     数据目录发现序：DSH_REALVERIFY_DATA_DIR > <repo>/.dsh > ~/.dsh，
//     目录内 *.jsonl 逐行解析（坏行如实计数不阻断）。缺席/零可解析行 ⇒
//     absent（生产数据缺席——exit 2，不红）。
//   数据方言（每行一个 JSON 对象，三族任选；docs/realverify.md 附导出模板）：
//     {"drift":{"predicted":0.3,"observed":0.41}}              —— Kalman Q/R 族
//     {"popup":{"semantic":true,"geometric":false,"isPopup":true}} —— Schmitt 三元组
//     {"ncd":{"similarity":0.42,"relevant":true}}              —— NCD 回访标签
//     （兼容裸数组形态：[p,o] / [sem,geo,pop] / [s,rel]）
//   在场执行：
//     各族样本 ≥8（Schmitt 另需 pos≥2/neg≥2——calibration.ts 诚实下限单源）
//     ⇒ calibrateKalmanQR / calibrateSchmittEvidence / calibrateNcdThreshold
//     真跑，GPD 侧另产 gpdAdCriticalTable 临界表（确定性 MC——与标定值同册）。
//   判定：
//     pass     = ≥1 族标定返回非空建议值（生产数据面可收割）；
//     degraded = 数据在场但各族均低于诚实下限（数据有了、量不够——如实申报）；
//     fail     = calibration 模块执行异常（数学面真红）。
//
// 用法：
//   DSH_REALVERIFY_DATA_DIR=/path/to/runs node scripts/realverify/probe-dg4-calib.mjs
// 退出码：0=pass / 1=fail / 2=absent（生产数据缺席）/ 3=degraded。

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { finishProbe, forceAbsent, invoked, distModule, REPO_ROOT } from './common.mjs';

const PROBE = 'scripts/realverify/probe-dg4-calib.mjs';

function discoverDataDir(env) {
  // ΤΕΛ-9: 生产数据目录发现序（显式 env > 仓库 .dsh > 用户家 .dsh）
  if (env.DSH_REALVERIFY_DATA_DIR) return { dir: env.DSH_REALVERIFY_DATA_DIR, via: 'DSH_REALVERIFY_DATA_DIR' };
  const candidates = [
    { dir: path.join(REPO_ROOT, '.dsh'), via: '<repo>/.dsh' },
    { dir: path.join(homedir(), '.dsh'), via: '~/.dsh' },
  ];
  for (const c of candidates) if (existsSync(c.dir)) return c;
  return null;
}

function parseRecords(line, sink) {
  // ΤΕΛ-9: 单行方言解析（对象/裸数组双形态）——返回是否可归族（坏行 false）
  let obj;
  try { obj = JSON.parse(line); } catch { return false; }
  const bool = (v) => v === true || v === false;
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    if (obj.drift && typeof obj.drift === 'object'
      && Number.isFinite(obj.drift.predicted) && Number.isFinite(obj.drift.observed)) {
      sink.drift.push({ predicted: obj.drift.predicted, observed: obj.drift.observed });
      return true;
    }
    if (obj.popup && typeof obj.popup === 'object'
      && bool(obj.popup.semantic) && bool(obj.popup.geometric) && bool(obj.popup.isPopup)) {
      sink.popup.push({ semantic: obj.popup.semantic, geometric: obj.popup.geometric, isPopup: obj.popup.isPopup });
      return true;
    }
    if (obj.ncd && typeof obj.ncd === 'object'
      && Number.isFinite(obj.ncd.similarity) && bool(obj.ncd.relevant)) {
      sink.ncd.push({ similarity: obj.ncd.similarity, relevant: obj.ncd.relevant });
      return true;
    }
    return false;
  }
  if (Array.isArray(obj)) {
    if (obj.length >= 2 && obj.slice(0, 2).every(v => Number.isFinite(v))) {
      sink.drift.push({ predicted: obj[0], observed: obj[1] });
      return true;
    }
    if (obj.length >= 3 && bool(obj[0]) && bool(obj[1]) && bool(obj[2])) {
      sink.popup.push({ semantic: obj[0], geometric: obj[1], isPopup: obj[2] });
      return true;
    }
    if (obj.length >= 2 && Number.isFinite(obj[0]) && bool(obj[1])) {
      sink.ncd.push({ similarity: obj[0], relevant: obj[1] });
      return true;
    }
  }
  return false;
}

async function main() {
  const env = process.env;
  if (forceAbsent()) {
    return ['absent', '设备缺席——force-absent（离线测试强制缺席路径）', { forced: true }];
  }
  const found = discoverDataDir(env);
  const evidence = {};
  if (!found) {
    return ['absent', '生产数据面缺席（无 DSH_REALVERIFY_DATA_DIR，<repo>/.dsh 与 ~/.dsh 均不在场）——长跑数据积累后重跑', {
      candidates: ['DSH_REALVERIFY_DATA_DIR', path.join(REPO_ROOT, '.dsh'), path.join(homedir(), '.dsh')],
    }];
  }
  evidence.data = { dir: found.dir, via: found.via };

  // ── JSONL 收割（坏行如实计数——绝不因脏数据抛出）──
  let files = [];
  try { files = readdirSync(found.dir).filter(f => f.endsWith('.jsonl')).sort(); } catch { files = []; }
  const sink = { drift: [], popup: [], ncd: [] };
  let lines = 0, bad = 0;
  const perFile = [];
  for (const f of files) {
    let flines = 0, fbad = 0;
    try {
      for (const line of readFileSync(path.join(found.dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        flines++;
        if (!parseRecords(line, sink)) fbad++;
      }
    } catch { /* 不可读文件如实跳过 */ }
    lines += flines; bad += fbad;
    perFile.push({ file: f, lines: flines, unparsed: fbad });
  }
  evidence.files = perFile;
  evidence.parsed = { drift: sink.drift.length, popup: sink.popup.length, ncd: sink.ncd.length, lines, unparsed: bad };
  if (!files.length || sink.drift.length + sink.popup.length + sink.ncd.length === 0) {
    return ['absent', `数据目录在场但无可解析标定记录（${files.length} 个 jsonl / ${lines} 行 / ${bad} 坏行）——方言与长度见 docs/realverify.md`, evidence];
  }

  // ── dist/calibration.js 权威源在场判定 ──
  const calibPath = distModule('calibration.js');
  if (!calibPath) {
    return ['degraded', 'dist/calibration.js 缺席——先 npm run build（标定纯函数的 TS 权威源构建件）', evidence];
  }
  const calib = await import(pathToFileURL(calibPath).href);

  // ── 逐族标定（诚实下限由 calibration.ts 单源执法——探针不另立阈值）──
  const results = {};
  try {
    results.kalmanQR = sink.drift.length ? calib.calibrateKalmanQR(sink.drift) : null;
    results.schmitt = sink.popup.length ? calib.calibrateSchmittEvidence(sink.popup) : null;
    results.ncd = sink.ncd.length ? calib.calibrateNcdThreshold(sink.ncd) : null;
    results.gpdCriticalTable = calib.gpdAdCriticalTable({ nSims: 200 }); // ΤΕΛ-9: GPD A² 临界表（确定性 MC，小规模复算在案）
  } catch (e) {
    return ['fail', `标定数学面异常（${e?.message ?? e}）——真红`, evidence];
  }
  evidence.calibration = results;

  const calibrated = [
    results.kalmanQR && { family: 'kalmanQR', n: results.kalmanQR.n },
    results.schmitt && { family: 'schmitt', n: results.schmitt.n },
    results.ncd && { family: 'ncd', n: results.ncd.n },
  ].filter(Boolean);
  if (calibrated.length) {
    return ['pass',
      `生产数据面可收割：${calibrated.map(c => `${c.family}(n=${c.n})`).join(' + ')} 标定建议值产出（Q/R=${results.kalmanQR ? results.kalmanQR.q + '/' + results.kalmanQR.r : '—'}；Schmitt=${results.schmitt ? results.schmitt.evidenceSem + '/' + results.schmitt.evidenceGeo : '—'}；NCD阈=${results.ncd ? results.ncd.threshold : '—'}）—— D-G4 落账数据面成`,
      evidence];
  }
  return ['degraded',
    `数据在场（drift=${sink.drift.length}/popup=${sink.popup.length}/ncd=${sink.ncd.length}）但各族均低于诚实下限（≥8 且 Schmitt 双侧各≥2）——量不够，长跑继续`,
    evidence];
}

if (invoked(import.meta.url)) {
  const t0 = Date.now();
  try {
    const [verdict, summary, evidence] = await main();
    finishProbe({ debt: 'D-G4', probe: PROBE, verdict, summary, evidence, elapsedMs: Date.now() - t0 });
  } catch (e) {
    // ΤΕΛ-9: 探针绝不裸抛——意外异常折叠为结构化 fail
    finishProbe({ debt: 'D-G4', probe: PROBE, verdict: 'fail', summary: '探针异常（诚实失败码）', evidence: {}, elapsedMs: Date.now() - t0, error: `${e?.stack ?? e}` });
  }
}
