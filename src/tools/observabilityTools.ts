// src/observabilityTools.ts
// 第七轮创新的工具面：把「系统的自我认知」暴露给模型与用户。
//   get_metrics     —— 运行指标 + 模型自省洞见（noop 率高的工具直接点名）
//   verify_journal  —— 哈希链审计：证明行动日志未被篡改（或定位第一个断点）
//   self_diagnose   —— 子系统活体检查（preflight）：截图管线/感知管线/记忆体/审计链
//   save_checkpoint —— 手动快照全部认知态（里程碑保护；卸载时另有自动档）
// 设计原则：观测是旁路义务 —— 任何检查失败都返回结构化报告，绝不抛异常中断任务。
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Config } from '../config';
import { telemetry } from '../telemetry';
import { journal } from '../journal';
import { uiMemory } from '../uiMemory';
import { skillLibrary } from '../skillLibrary';
import { failureMemory } from '../failureMemory';
import { saveCheckpoint } from '../checkpoint';
import { system } from '../system';
import { dhash } from '../perceptualHash';

export function createGetMetricsTool() {
  return defineTool({
    name: 'get_metrics',
    description:
      'Returns runtime telemetry: per-tool success/no-op rates, latency percentiles (P50/P95/P99), ' +
      'and memory hit rates, plus actionable insights about your own recent performance. ' +
      'Call this when you suspect you are repeating ineffective actions.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      const insights = telemetry.insights();
      return JSON.stringify({
        status: 'SUCCESS',
        metrics: telemetry.snapshot(),
        insights: insights.length > 0
          ? insights
          : ['No anomalies detected. Keep using verify-effective strategies.'],
      }, null, 2);
    },
  });
}

export function createVerifyJournalTool() {
  return defineTool({
    name: 'verify_journal',
    description:
      'Audits the action journal hash chain (SHA-256, tamper-evident). ' +
      'OK = the recorded history is provably intact. A broken index means the log was modified ' +
      'after the fact — treat everything after that point as untrusted.',
    parameters: {
      tail: { type: 'number', required: false, description: 'Also show the last N entries (default 5).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const v = journal.verify();
      const n = Math.min(Math.max(args.tail ?? 5, 0), 20);
      const tail = journal.list().slice(-n).map((e, i) =>
        `${i + 1}. ${e.tool} ${e.status}${e.effect_detected === false ? ' (no effect)' : ''} ${e.hash?.slice(0, 12) ?? ''}`);
      return JSON.stringify({
        status: v.ok ? 'SUCCESS' : 'FAILED',
        state_anchor: {
          chain_integrity: v.ok ? 'INTACT' : 'BROKEN',
          entries: v.length,
          first_broken_at_index: v.brokenAt,
        },
        recent_entries: tail,
        next_step: v.ok
          ? undefined
          : `The journal chain breaks at entry #${v.brokenAt}. Entries after it are not trustworthy; ` +
            'investigate what modified the log before replaying anything from it.',
      }, null, 2);
    },
  });
}

export function createSelfDiagnoseTool(config: Config) {
  return defineTool({
    name: 'self_diagnose',
    description:
      'Runs live health checks on all subsystems: screen capture pipeline, perceptual hashing, ' +
      'memory stores (UI/skills/failures), journal audit chain, and telemetry. ' +
      'Call this at session start, or whenever tool results seem inconsistent with reality.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      const checks: Array<{ subsystem: string; status: 'GREEN' | 'AMBER' | 'RED'; detail: string }> = [];

      // 1. 截图管线（一切视觉能力的地基）
      try {
        const buf = await system.captureScreen();
        checks.push({ subsystem: 'screen-capture', status: buf.length > 0 ? 'GREEN' : 'RED', detail: `${buf.length} bytes` });
        // 2. 感知管线：对真实截图像指纹（端到端活体检测，非单测）
        const hash = await dhash(buf);
        checks.push({
          subsystem: 'perceptual-hash',
          status: /^[01]{64}$/.test(hash) ? 'GREEN' : 'RED',
          detail: `fingerprint ${hash.slice(0, 12)}…`,
        });
      } catch (e: any) {
        checks.push({ subsystem: 'screen-capture', status: 'RED', detail: e.message });
        checks.push({ subsystem: 'perceptual-hash', status: 'RED', detail: 'skipped (capture failed)' });
      }

      // 3. 记忆体
      checks.push({ subsystem: 'ui-memory', status: uiMemory.size > 0 ? 'GREEN' : 'AMBER', detail: `${uiMemory.size} landmark(s)` });
      checks.push({ subsystem: 'skill-library', status: skillLibrary.list().length > 0 ? 'GREEN' : 'AMBER', detail: `${skillLibrary.list().length} skill(s)` });
      checks.push({ subsystem: 'failure-memory', status: failureMemory.size > 0 ? 'GREEN' : 'AMBER', detail: `${failureMemory.size} record(s)` });

      // 4. 审计链
      const v = journal.verify();
      checks.push({
        subsystem: 'journal-chain',
        status: v.ok ? 'GREEN' : 'RED',
        detail: v.ok ? `${v.length} entries intact` : `BROKEN at #${v.brokenAt}`,
      });

      // 5. 全局运行指标
      const snap = telemetry.snapshot();
      checks.push({
        subsystem: 'telemetry',
        status: 'GREEN',
        detail: `${snap.global.calls} calls, success ${snap.global.success_rate ?? '-'}%, noop ${snap.global.noop_rate ?? '-'}%`,
      });

      // 6. 干跑模式警示（动作全部只记录不执行 —— 非常容易忘记）
      if (config.dryRun) {
        checks.push({ subsystem: 'dry-run-mode', status: 'AMBER', detail: 'ACTIONS ARE NOT EXECUTED (dryRun=true)' });
      }

      const red = checks.filter(c => c.status === 'RED').length;
      const amber = checks.filter(c => c.status === 'AMBER').length;
      return JSON.stringify({
        status: red > 0 ? 'FAILED' : 'SUCCESS',
        state_anchor: {
          overall: red > 0 ? 'RED' : amber > 0 ? 'AMBER' : 'GREEN',
          red, amber, green: checks.length - red - amber,
        },
        checks,
        next_step: red > 0
          ? 'Critical subsystem(s) down. Do NOT attempt UI automation until the RED items are fixed ' +
            '(check display/access permissions first — headless environments cannot capture screens).'
          : amber > 0 && config.dryRun
            ? 'Healthy but in dry-run mode: actions will be logged, not executed.'
            : 'All critical subsystems healthy. Proceed with the task.',
      }, null, 2);
    },
  });
}

export function createSaveCheckpointTool(config: Config) {
  return defineTool({
    name: 'save_checkpoint',
    description:
      'Snapshots the entire cognitive state (UI memory, skills, failure memory, journal chain, metrics) ' +
      'to the configured checkpoint file (atomic write). Call it after completing valuable milestones ' +
      'so a crash can never erase them. Requires checkpointPath in config.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      const r = saveCheckpoint(config.checkpointPath);
      return r.ok
        ? `[System]: Checkpoint saved atomically (${r.steps} journal entries chained). ` +
          'Crash-safe from this point on.'
        : `[Error]: Checkpoint not saved — ${r.error}`;
    },
  });
}
