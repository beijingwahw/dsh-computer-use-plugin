// src/tools/shapeEnvironment.ts
// D-2 工具面：shape_environment —— 模型先看再动（capabilities），动必留痕（undoToken），
// 离开必复原（restore）。Agent 从被动适应 UI 升级为主动整理工作台的造物主。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { shaper } from '../environmentShaper';
import type { ShaperActionKind } from '../environmentShaper';
import { toolOk, toolErr } from '../toolResult';
// R2-3（焦点保卫）：raise/maximize 置前成功 ⇒ 记账目标窗 —— 宿主自抬抢焦后
// type_text 前置校验的复焦依据来源之二（来源之一是 switch_window）。
import { recordTargetWindow } from '../windowFocusGuard';

export function createShapeEnvironmentTool() {
  return defineTool({
    name: 'shape_environment',
    description:
      'Reshapes the physical workspace before/during operation (bring window to front, maximize it, ' +
      'move it, adjust browser zoom, launch a whitelisted GUI app) — with a strict LIFO undo log so ' +
      'every change can be restored. ' +
      'ALWAYS call action="capabilities" first: it reports what this machine can honestly do. ' +
      'After finishing the task, call action="restore" to leave the desktop as you found it.',
    parameters: {
      action: {
        type: 'string', required: true,
        description: "One of: 'capabilities' | 'apply' | 'restore' | 'undo_log'",
      },
      kind: {
        type: 'string',
        description: 'apply only: raise_window | maximize_window | move_window | set_zoom | set_contrast | launch_app',
      },
      title_hint: {
        type: 'string',
        description: 'apply only (window-level): keyword of the target window title, e.g. "Chrome".',
      },
      app: {
        type: 'string',
        // R2-5：沙箱预置应用窗口的唯一可靠通道（pwsh Start-Process 在沙箱秒死——
        // job 连坐 + 受限 token 打断 Shell 激活；直启通道绕开两机制，见
        // environmentShaper.ts 模块头 R2-5 注释）
        description: 'launch_app only: whitelisted GUI app name — notepad | calc | mspaint. ' +
          'Launched via a direct no-shell spawn that survives the tool call and the host process ' +
          '(do NOT use shell tools to open GUI apps in the sandbox — they die instantly).',
      },
      x: { type: 'number', description: 'apply only (move_window): target x in pixels.' },
      y: { type: 'number', description: 'apply only (move_window): target y in pixels.' },
      level: { type: 'number', description: 'apply only (set_zoom): zoom percentage, e.g. 125.' },
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
  kind?: string; title_hint?: string; app?: string; x?: number; y?: number; level?: number;
}): Promise<string> {
  // R2-5：kinds 面收编 launch_app（其余五 kind 语义零回归）
  const kinds: ShaperActionKind[] = ['raise_window', 'maximize_window', 'move_window', 'set_zoom', 'set_contrast', 'launch_app'];
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
    // R2-5：launch_app 的白名单目标（缺席不携带键 —— action 形状最小化）
    ...(args.app !== undefined ? { app: args.app } : {}),
    x: args.x, y: args.y, level: args.level,
  });
  if (!r.ok) {
    return toolErr(
      `shape_environment "${args.kind}" failed.`,
      r.reason ?? 'unknown reason',
      'Call action="capabilities" to see what this machine can do, then retry or proceed with pure-vision interaction.',
    );
  }
  // R2-3：窗口级置前动作成功 ⇒ 记账目标窗（复焦依据；纯旁路，零失败面）
  if (args.kind === 'raise_window' || args.kind === 'maximize_window') {
    if (args.title_hint) recordTargetWindow({ keyword: args.title_hint, matchedTitle: r.matchedTitle });
  }
  // R2-5：直启成功 ⇒ pid 随行（对账事实源）+ 预置指引（驱动/冒烟的下一步话术）
  if (args.kind === 'launch_app') {
    return toolOk(
      `Launched "${args.app}" (pid ${r.pid ?? 'unknown'}). Undo token: ${r.token}.`,
      { kind: args.kind, app: args.app, pid: r.pid, undo_token: r.token },
      'The app was spawned detached (no shell) — it survives this tool call and the host process. '
      + 'Call take_screenshot to see the window; action="restore" will terminate it (taskkill by pid).',
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
