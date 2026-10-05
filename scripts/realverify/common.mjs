// scripts/realverify/common.mjs
// ΤΕΛ-9: 真机验证债公共层（Node 侧）—— 8 条「需真机」债（D-A2/D-A3/D-A4/
// D-A6/D-A7/D-A8/D-B1/D-G4，另含 D-A1 已闭债唯余的采集卡现场标定残余）的
// 一键验证基建。形态模仿 python_service/real_probe.py（真机实证探针先例）：
// 环境自检（硬件在场判定）→ 缺席诚实退出（exit 2 + 「设备缺席」结构化输出）
// → 在场时执行验证并输出结构化判定（pass/fail/degraded + 证据）。
//
// 退出码立法（run-all 与全部探针共用，缺席不红——诚实缺席 ≠ 失败）：
//   0 = pass      在场且验证全过
//   1 = fail      在场但验证失败（真红——债的验证面被抓到问题时才出现）
//   2 = absent    设备/前置缺席（诚实退出，run-all 不计红）
//   3 = degraded  在场但证据未满（部分实证，run-all 不计红但如实呈报）
//
// 输出契约：每个探针 stdout 最后一行 = `REALVERIFY <单行 JSON>`，
// run-all 只按该行汇总（人类可读行随意打，不影响解析）。
//
// 离线确定性测试钩子：环境变量 DSH_REALVERIFY_FORCE_ABSENT=1（或 --force-absent）
// ⇒ 一切探针立刻走缺席路径（test/realverify.test.ts 只测缺席语义与编排纯函数，
// 不依赖任何真机在场的巧合）。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ΤΕΛ-9: 退出码单源（缺席不红的语义根）
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, ABSENT: 2, DEGRADED: 3 });

// ΤΕΛ-9: 判定词 ↔ 退出码双向映射（探针只产出四值枚举，绝不第五态）
export const VERDICT_EXIT = Object.freeze({ pass: 0, fail: 1, absent: 2, degraded: 3 });
export const EXIT_VERDICT = Object.freeze({ 0: 'pass', 1: 'fail', 2: 'absent', 3: 'degraded' });

export const SCHEMA = 'tel9-realverify/1';

const here = path.dirname(fileURLToPath(import.meta.url));

// ΤΕΛ-9: 探针登记册（run-all 调度与测试册「文件在场」执法的单一事实源）。
// kind: 'py' = python 自包含探针；'mjs' = node 探针。D-A1 为已闭债唯余的
// 「真采集卡现场标定」物理边界残余（台账 A 区行内申报），与 8 条需真机债同册收割。
export const PROBE_REGISTRY = Object.freeze([
  { debt: 'D-A1', file: 'probe-da1-uvc.py', kind: 'py', title: 'UVC 采集卡现场标定（已闭债残余）' },
  { debt: 'D-A2', file: 'probe-da2-ch9329.py', kind: 'py', title: 'CH9329 串口 HID 真棒' },
  { debt: 'D-A3', file: 'probe-da3-android.py', kind: 'py', title: 'Android 真机 adb/scrcpy' },
  { debt: 'D-A4', file: 'probe-da4-audio.py', kind: 'py', title: 'WASAPI 声学真环（系统提示音采集）' },
  { debt: 'D-A6', file: 'probe-da6-vlm.mjs', kind: 'mjs', title: '真 VLM 模型长跑稳定性' },
  { debt: 'D-A7', file: 'probe-da7-linux.py', kind: 'py', title: 'Linux 真机首验（uinput/peercred）' },
  { debt: 'D-A8', file: 'probe-da8-comtypes.py', kind: 'py', title: 'comtypes 建链臂真机冒烟（py<3.14）' },
  { debt: 'D-B1', file: 'probe-db1-som.mjs', kind: 'mjs', title: '稀疏 SoM 在线 A/B 开闸证据' },
  { debt: 'D-G4', file: 'probe-dg4-calib.mjs', kind: 'mjs', title: 'Kalman/GPD/Schmitt/NCD 标定生产数据' },
]);

// ΤΕΛ-9: 8 条需真机债的法定集合（D-A1 是残余标定，不算未闭债——测试册按此对账）
export const OPEN_REAL_DEBTS = Object.freeze(['D-A2', 'D-A3', 'D-A4', 'D-A6', 'D-A7', 'D-A8', 'D-B1', 'D-G4']);

export function probeFilePath(entry) {
  return path.join(here, entry.file);
}

// ΤΕΛ-9: 离线确定性缺席开关（测试专用；生产收割不受影响）
export function forceAbsent(argv = process.argv, env = process.env) {
  if (env.DSH_REALVERIFY_FORCE_ABSENT === '1' || env.DSH_REALVERIFY_FORCE_ABSENT === 'true') return true;
  return argv.includes('--force-absent');
}

// ΤΕΛ-9: 结构化收口——绝不抛、绝不 process.exit（D-E3 教训：硬 exit 与未决异步
// 句柄竞态 ⇒ 0xC0000409；此处统一 process.exitCode 自然排空退出）
export function finishProbe({ debt, probe, verdict, summary, evidence = {}, elapsedMs = 0, error = undefined }) {
  const report = {
    schema: SCHEMA,
    debt,
    probe,
    verdict,
    summary: String(summary).replace(/\s+/g, ' ').slice(0, 500),
    evidence,
    elapsed_ms: Math.round(elapsedMs),
    ...(error !== undefined ? { error: String(error).slice(0, 500) } : {}),
  };
  process.stdout.write(reportLine(report) + '\n');
  process.exitCode = VERDICT_EXIT[verdict] ?? EXIT.FAIL;
}

// ΤΕΛ-9: 单行 JSON 序列化（键序固定 ⇒ 确定性输出；换行全净化防破行）
export function reportLine(report) {
  const clean = JSON.parse(JSON.stringify(report, (k, v) => (typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ') : v)));
  return 'REALVERIFY ' + JSON.stringify(clean);
}

// ΤΕΛ-9: 从探针 stdout 提取最后一行 REALVERIFY JSON（编排纯函数——测试册执法对象）
export function parseProbeLine(stdout) {
  if (typeof stdout !== 'string') return null;
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('REALVERIFY ')) {
      try {
        const obj = JSON.parse(line.slice('REALVERIFY '.length));
        if (obj && typeof obj === 'object' && typeof obj.debt === 'string' && typeof obj.verdict === 'string') return obj;
        return null; // ΤΕΛ-9: 形状不对按不可解析处理（诚实红，不猜）
      } catch {
        return null;
      }
    }
  }
  return null;
}

// ΤΕΛ-9: 汇总纯函数——缺席/降级不计红，唯 fail 与探针自身故障（probe-error）计红
export function buildSummary(results) {
  const by = (v) => results.filter((r) => r.verdict === v).length;
  const summary = {
    total: results.length,
    pass: by('pass'),
    fail: by('fail'),
    absent: by('absent'),
    degraded: by('degraded'),
    probe_error: by('probe-error'),
    devices_present: results.filter((r) => r.verdict === 'pass' || r.verdict === 'fail' || r.verdict === 'degraded').length,
  };
  return summary;
}

export function aggregateExit(results) {
  return results.some((r) => r.verdict === 'fail' || r.verdict === 'probe-error') ? EXIT.FAIL : EXIT.PASS;
}

// ΤΕΛ-9: python 解释器发现（PATH 优先，缺席回报 null——调用方诚实缺席）
export function findPython(env = process.env) {
  if (env.DSH_REALVERIFY_PYTHON) return env.DSH_REALVERIFY_PYTHON;
  return 'python'; // ΤΕΛ-9: 与 test/w5pyreg.test.ts 同方言（spawn 由 PATH 解析）
}

// ΤΕΛ-9: 子进程捕获（绝不抛——超时/ENOENT 都折叠为 {ok:false,...} 诚实信封）
export function runCapture(cmd, args, { timeoutMs = 300_000, env = process.env, cwd = undefined } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let child;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let timer;
    try {
      child = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return done({ ok: false, rc: null, stdout: '', stderr: `spawn failed: ${e?.message ?? e}`, timedOut: false });
    }
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 尽力 */ }
      done({ ok: false, rc: null, stdout, stderr: stderr + '\n[realverify] probe timeout', timedOut: true });
    }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('error', (e) => done({ ok: false, rc: null, stdout, stderr: stderr + `\nspawn error: ${e.message}`, timedOut: false }));
    child.on('close', (rc) => done({ ok: true, rc: rc ?? null, stdout, stderr, timedOut: false }));
  });
}

// ΤΕΛ-9: 直跑守卫——被 import（测试册/未来编排）时不触发 CLI main（仓库先例：
// genesis_audit.mjs 同律）。各 CLI 入口文件以 `if (invoked(import.meta.url)) main();` 收口。
export function invoked(url, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return fileURLToPath(url) === path.resolve(argv1);
  } catch {
    return false;
  }
}

// ΤΕΛ-9: 仓库根（scripts/realverify 的上两级）——探针定位 dist/ 与 python_service 用
export const REPO_ROOT = path.resolve(here, '..', '..');

export function distModule(rel) {
  const p = path.join(REPO_ROOT, 'dist', rel);
  return existsSync(p) ? p : null;
}
