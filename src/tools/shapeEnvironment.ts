// src/tools/shapeEnvironment.ts
// D-2 工具面：shape_environment —— 模型先看再动（capabilities），动必留痕（undoToken），
// 离开必复原（restore）。Agent 从被动适应 UI 升级为主动整理工作台的造物主。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { shaper, ShaperActionKind } from '../environmentShaper';
import { toolOk, toolErr } from '../toolResult';

export function createShapeEnvironmentTool() {
  return defineTool({
    name: 'shape_environment',
    description:
      'Reshapes the physical workspace before/during operation (bring window to front, maximize it, ' +
      'move it, adjust browser zoom) — with a strict LIFO undo log so every change can be restored. ' +
      'ALWAYS call action="capabilities" first: it reports what this machine can honestly do. ' +
      'After finishing the task, call action="restore" to leave the desktop as you found it.',
    parameters: {
      action: {
        type: 'string', required: true,
        description: "One of: 'capabilities' | 'apply' | 'restore' | 'undo_log'",
      },
      kind: {
        type: 'string', required: false,
        description: 'apply only: raise_window | maximize_window | move_window | set_zoom | set_contrast',
      },
      title_hint: {
        type: 'string', required: false,
        description: 'apply only (window-level): keyword of the target window title, e.g. "Chrome".',
      },
      x: { type: 'number', required: false, description: 'apply only (move_window): target x in pixels.' },
      y: { type: 'number', required: false, description: 'apply only (move_window): target y in pixels.' },
      level: { type: 'number', required: false, description: 'apply only (set_zoom): zoom percentage, e.g. 125.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      switch (args.action) {
        case 'capabilities': return handleCapabilities();
        case 'apply': return await handleApply(args);
        case 'restore': return await handleRestore();
        case 'undo_log': return handleUndoLog();
        default:
          return toolErr(
            `Unknown action "${args.action}".`,
            'action must be capabilities | apply | restore | undo_log',
            'Call shape_environment(action="capabilities") to see available actions.',
          );
      }
    },
  });
}

function handleCapabilities(): string {
  const caps = shaper.capabilities();
  const list = caps.size
    ? [...caps].join(', ')
    : '(none — this machine lacks the required tools, e.g. wmctrl/xdotool, or no graphical session)';
  return toolOk(
    `Platform "${shaper.platform()}". Available shaping actions: ${list}.`,
    { platform: shaper.platform(), capabilities: [...caps] },
    caps.size
      ? 'Apply with action="apply"; every change gets an undoToken and is restored via action="restore".'
      : 'Do not attempt apply on this machine — it will be honestly rejected. Proceed with pure-vision interaction.',
  );
}

async function handleApply(args: {
  kind?: string; title_hint?: string; x?: number; y?: number; level?: number;
}): Promise<string> {
  const kinds: ShaperActionKind[] = ['raise_window', 'maximize_window', 'move_window', 'set_zoom', 'set_contrast'];
  if (!args.kind || !kinds.includes(args.kind as ShaperActionKind)) {
    return toolErr(
      'shape_environment apply failed.',
      `kind must be one of: ${kinds.join(' | ')}`,
      'Pick a kind from the capabilities report.',
    );
  }
  const r = await shaper.apply({
    kind: args.kind as ShaperActionKind,
    titleHint: args.title_hint,
    x: args.x, y: args.y, level: args.level,
  });
  if (!r.ok) {
    return toolErr(
      `shape_environment "${args.kind}" failed.`,
      r.reason ?? 'unknown reason',
      'Call action="capabilities" to see what this machine can do, then retry or proceed with pure-vision interaction.',
    );
  }
  return toolOk(
    `Applied "${args.kind}"${args.title_hint ? ` to "${args.title_hint}"` : ''}. Undo token: ${r.token}.`,
    { kind: args.kind, undo_token: r.token },
    'Call take_screenshot to see the reshaped workspace; action="restore" (or unload) will undo it in LIFO order.',
  );
}

async function handleRestore(): Promise<string> {
  const results = await shaper.restoreAll();
  if (results.length === 0) {
    return toolOk('Nothing to restore — the undo log is empty.', { restored: 0 },
      'The workspace was never changed (or has already been restored).');
  }
  const okCount = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  const detail = results.map(r => `  - ${r.token}: ${r.ok ? 'restored' : `FAILED (${r.reason})`}`).join('\n');
  return toolOk(
    `Restored ${okCount}/${results.length} change(s) (LIFO order).`,
    { restored: okCount, total: results.length, failures: failed.map(f => ({ token: f.token, reason: f.reason })) },
    failed.length
      ? `Some changes could not be restored:\n${detail}\nCheck action="undo_log" for the surviving duties.`
      : 'The desktop is back to its original state.',
  );
}

function handleUndoLog(): string {
  const log = shaper.dumpUndoLog();
  if (log.length === 0) {
    return toolOk('Undo log is empty.', { entries: 0 },
      'No outstanding restoration duties.');
  }
  const lines = log.map(r =>
    `  - ${r.token} ${r.recipe.kind}${r.action.titleHint ? ` "${r.action.titleHint}"` : ''}: ` +
    (r.undone ? 'restored' : r.undoFailureReason ? `PENDING (last attempt failed: ${r.undoFailureReason})` : 'pending'));
  return toolOk(
    `Undo log: ${log.filter(r => !r.undone).length} pending / ${log.length} total.`,
    { total: log.length, pending: log.filter(r => !r.undone).length },
    lines.join('\n') + '\nPending duties are executed LIFO by action="restore".',
  );
}
