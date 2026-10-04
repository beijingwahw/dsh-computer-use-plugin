// src/tools/metricsDashboard.ts
// 纪元 Σ（Σ-7 遥测仪表盘）：metrics_dashboard —— 五分区文本仪表盘。
// 把全系统健康折叠为一张 ≤80 列、中文标签、等宽对齐的多行文本仪表盘：
//   · 工具区（tools）   —— telemetry.snapshot 每工具 调用/成功率/p50/p95
//                          （按调用量降序 top 10）+ 全局延迟尾报告（若在）
//   · 云脑区（vlm）     —— vlmMeter.summary（调用/失败/p50/p95/令牌/类别）
//                          + isGlmConfigured 实时配置态
//   · 自主区（autonomy）—— autonomous_run 的 telemetry 战绩 + 轻量战绩账
//                          + 进化账本可达性如实申报（口径见下）
//   · 守卫区（guards）  —— telemetry.counters 中 'guard:*' 键的 deny 拦截计数
//                          （src/guards/hooks.ts deny 分支打点）
//   · 内核区（kernel）  —— kernelRegistry.list() 的十颗生产内核读点台账
//                          （key/器官/现值 vs 缺省/漂移%/证据/代际 —— 纪元 Θ-4）
// 铁律：纯只读、零配置依赖（恒挂载）、绝不抛异常；锚点一律走 toolResult 工厂。
//
// ─── 自主区数据口径（诚实三源，JSDoc 备案） ───
//   1. telemetry.tools 中 autonomous_run 的战绩 —— 唯一自动接线的生产数据源：
//      telemetryGuard 旁路观测全工具管线，autonomous_run 的成败天然入账；
//   2. 本文件自建的轻量战绩账（autonomyLedger + noteAutonomyOutcome(phase)）——
//      EvolutionEngine 与 PilotStore 均为 autonomy/autonomousRun 别簇的模块级
//      私有件（evolution 单例未导出，本工具只读消费、禁改 autonomousRun.ts），
//      故战绩账在此自建并导出打点函数供未来接线（谁接线谁调用，零迁移成本）；
//      尚无人打点时如实显示「暂无记录」，绝不伪装有数；
//   3. EvolutionEngine 不可达 ⇒ 恒定一行「进化账本未接线」（如实申报，不臆造）。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { toolOk, toolErr } from '../toolResult';
import { telemetry } from '../telemetry';
import { vlmMeter } from '../vlm/metering';
import { isGlmConfigured } from '../vlm/glmClient';
import { kernelRegistry } from '../kernel/registry';

/** 仪表盘行宽纪律（≤80 列的工程甜点：分隔线铺满 78，留边距） */
const COLS = 78;
const WIDTH_LIMIT = 80;

/** 合法 section 名（缺省 'all' = 五分区全渲染） */
const VALID_SECTIONS = ['all', 'tools', 'vlm', 'autonomy', 'guards', 'kernel'] as const;
type Section = (typeof VALID_SECTIONS)[number];

/** 单分区名 → 中文区名（顶栏标签用） */
const SECTION_TITLES: Record<Exclude<Section, 'all'>, string> = {
  tools: '工具区',
  vlm: '云脑区',
  autonomy: '自主区',
  guards: '守卫区',
  kernel: '内核区',
};

// ─── 等宽栅格：CJK 视觉宽度（中英混排对齐的事实源） ───

/** 视觉宽度：全角字符（CJK/全角标点/谚文等）计 2 列，其余计 1 列 */
function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x115f) || // 谚文 Jamo
      (c >= 0x2e80 && c <= 0xa4cf) || // CJK 部首..Yi（含汉字/假名/CJK 标点）
      (c >= 0xac00 && c <= 0xd7a3) || // 谚文音节
      (c >= 0xf900 && c <= 0xfaff) || // CJK 兼容表意
      (c >= 0xfe30 && c <= 0xfe4f) || // CJK 兼容形式
      (c >= 0xff00 && c <= 0xff60) || // 全角形式（！（）：etc.）
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x20000 && c <= 0x3fffd); // CJK 扩展 B..
    w += wide ? 2 : 1;
  }
  return w;
}

/** 左对齐到视觉宽度（不足补空格；超宽原样不截 —— 调用方自行 slice） */
function padEndV(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - visualWidth(s)));
}

/** 右对齐到视觉宽度（数值列的标准形） */
function padStartV(s: string, width: number): string {
  return ' '.repeat(Math.max(0, width - visualWidth(s))) + s;
}

/** 按视觉宽度硬截（80 列纪律的最后防线 —— 构造期已保证，此处纯保险） */
function trimToWidth(s: string, width: number): string {
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = visualWidth(ch);
    if (w + cw > width) return out;
    out += ch;
    w += cw;
  }
  return out;
}

/** 分区头：`─── <标题> ──────…` 铺满 COLS 列 */
function rule(title: string): string {
  return trimToWidth(`─── ${title} `, COLS) + '─'.repeat(Math.max(0, COLS - visualWidth(`─── ${title} `)));
}

/** 总栏：`━━━ <标题> ━━━━━…` 铺满 COLS 列 */
function heavyRule(title: string): string {
  return trimToWidth(`━━━ ${title} `, COLS) + '━'.repeat(Math.max(0, COLS - visualWidth(`━━━ ${title} `)));
}

/** isGlmConfigured 的绝不抛包装（探测哨兵理论零抛 —— 仪表盘纪律仍层层设防） */
function safeIsGlmConfigured(): boolean {
  try {
    return isGlmConfigured();
  } catch {
    return false;
  }
}

// ─── 轻量战绩账（自主区第 2 数据源 —— 见文件头「自主区数据口径」） ───

/** phase → 次数（模块级，进程生命周期；与 telemetry 完全独立的小账） */
const autonomyLedger = new Map<string, number>();

/**
 * 自主环终局打点（供未来接线：autonomousRun/进化器官若想喂仪表盘战绩账，
 * 在终局处调用本函数即可，无需改本文件）。防御式：非字符串/空 phase 归
 * 'unknown'，超长 phase 截 40 字符；绝不抛。
 */
export function noteAutonomyOutcome(phase: string): void {
  const key =
    typeof phase === 'string' && phase.trim() !== '' ? phase.trim().slice(0, 40) : 'unknown';
  autonomyLedger.set(key, (autonomyLedger.get(key) ?? 0) + 1);
}

/** 清空轻量战绩账（测试隔离 / 会话切换用；生产无人调用亦无害） */
export function resetAutonomyLedger(): void {
  autonomyLedger.clear();
}

// ─── 四分区渲染器（每个返回若干行；数据源只读消费，绝不写） ───

/** 工具区：每工具 调用/成功率/p50/p95（top 10 按调用量降序）+ 全局延迟尾（若在） */
function renderToolsPane(): string[] {
  const lines = [rule('工具区（telemetry · 按调用量 top 10）')];
  const snap = telemetry.snapshot();
  if (snap.tools.length === 0) {
    lines.push('（暂无数据 —— 尚无工具调用被观测）');
    return lines;
  }
  lines.push(
    padEndV('工具名', 24) +
      padStartV('调用', 6) +
      padStartV('成功率', 9) +
      padStartV('p50ms', 8) +
      padStartV('p95ms', 8),
  );
  for (const t of snap.tools.slice(0, 10)) {
    lines.push(
      padEndV(t.tool.slice(0, 24), 24) +
        padStartV(String(t.calls), 6) +
        padStartV(t.success_rate === null ? '-' : `${t.success_rate}%`, 9) +
        padStartV(String(t.p50_ms), 8) +
        padStartV(String(t.p95_ms), 8),
    );
  }
  const tail = telemetry.tailReport();
  if (tail) {
    lines.push(
      `延迟尾: ξ ${tail.xi}${tail.xi >= 0.25 ? '（重尾）' : ''} │ σ ${tail.sigma}ms │ 阈值u ${tail.threshold}ms` +
        ` │ p999≈${tail.p999}ms │ 拟合 ${tail.fit}${tail.consistent ? '' : '（估计器分歧）'}`,
    );
  }
  return lines;
}

/** 云脑区：vlmMeter.summary（调用/失败/延迟分位/令牌/类别）+ isGlmConfigured 实时态 */
function renderVlmPane(): string[] {
  const lines = [rule('云脑区（VLM 计量 · vlmMeter）')];
  const s = vlmMeter.summary();
  lines.push(`配置态: ${safeIsGlmConfigured() ? '已配置' : '未配置'}（isGlmConfigured 实时读数）`);
  if (s.calls === 0) {
    lines.push('（暂无数据 —— 云脑零调用记录）');
    return lines;
  }
  const failPct = Math.round((s.failures / s.calls) * 1000) / 10;
  lines.push(`调用 ${s.calls} │ 失败 ${s.failures}（${failPct}%）`);
  lines.push(
    `延迟: p50 ${s.p50LatencyMs}ms │ p95 ${s.p95LatencyMs}ms │ 均摊 ${Math.round(s.totalLatencyMs / s.calls)}ms`,
  );
  lines.push(`令牌: 入 ${s.promptTokens} │ 出 ${s.completionTokens}`);
  const kinds = Object.entries(s.byKind).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  if (kinds.length > 0) {
    const shown = kinds.slice(0, 6).map(([k, n]) => `${k} ${n}`).join(' · ');
    const rest = kinds.length > 6 ? ` +${kinds.length - 6}` : '';
    lines.push(`类别: ${shown}${rest}`);
  }
  return lines;
}

/** 自主区：autonomous_run 遥测战绩 + 轻量战绩账 + 进化账本可达性如实申报 */
function renderAutonomyPane(): string[] {
  const lines = [rule('自主区（autonomy 战绩）')];
  const row = telemetry.snapshot().tools.find(t => t.tool === 'autonomous_run');
  if (row) {
    lines.push(`autonomous_run 战绩: 调用 ${row.calls} │ 成功率 ${row.success_rate === null ? '-' : `${row.success_rate}%`}`);
  } else {
    lines.push('autonomous_run 战绩: 暂无数据（自主环未被调用或遥测未观测）');
  }
  if (autonomyLedger.size > 0) {
    const entries = [...autonomyLedger.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const shown = entries.slice(0, 6).map(([p, n]) => `${p} ${n}`).join(' · ');
    const rest = entries.length > 6 ? ` +${entries.length - 6}` : '';
    lines.push(`轻量战绩账: ${shown}${rest}（noteAutonomyOutcome 打点）`);
  } else {
    lines.push('轻量战绩账: 暂无记录（noteAutonomyOutcome 尚未接线）');
  }
  lines.push('进化账本未接线（EvolutionEngine 为 autonomousRun 模块级私有单例，如实申报）');
  return lines;
}

/** 守卫区：'guard:*' 计数器的 deny 拦截账（hooks deny 分支打点，misses = 拦截） */
function renderGuardsPane(): string[] {
  const lines = [rule('守卫区（deny 拦截计数 · hooks 打点）')];
  const rows = telemetry
    .snapshot()
    .counters.filter(c => c.counter.startsWith('guard:'))
    .sort((a, b) => b.hits + b.misses - (a.hits + a.misses) || (a.counter < b.counter ? -1 : 1));
  if (rows.length === 0) {
    lines.push('（暂无守卫拦截记录 —— pre-execute deny 路径零触发）');
    return lines;
  }
  for (const c of rows.slice(0, 10)) {
    lines.push(
      padEndV(c.counter.slice(0, 30), 32) + `拦截 ${c.misses}` + (c.hits > 0 ? ` │ 放行 ${c.hits}` : ''),
    );
  }
  return lines;
}

/** 内核数值展示：保留至多 3 位小数去尾噪（0.15 → '0.15'、3 → '3'） */
function fmtKernelNum(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

/**
 * 内核区（纪元 Θ-4）：kernelRegistry.list() 的生产内核台账 —— 每键一行：
 * 参数键 / 器官 / 现值 vs 缺省 / 漂移%（= |现值−缺省| / 区间宽 × 100，与
 * registry.drift 同式）/ 证据 / 代际。零入册（未 registerProductionKernels /
 * 测试已 resetKernelRuntime）⇒ 诚实一行「暂无内核登记」。纯只读、绝不抛。
 */
function renderKernelPane(): string[] {
  const lines = [rule('内核区（kernel 参数台账 · kernelRegistry）')];
  const params = kernelRegistry.list();
  if (params.length === 0) {
    lines.push('（暂无内核登记 —— registerProductionKernels 未调用或注册表已被重置）');
    return lines;
  }
  lines.push(
    padEndV('参数键', 28) +
      padEndV('器官', 12) +
      padStartV('现值', 7) +
      padStartV('缺省', 7) +
      padStartV('漂移%', 8) +
      padStartV('证据', 6) +
      padStartV('代际', 6),
  );
  for (const p of params) {
    const driftPct =
      p.value === p.defaultValue
        ? 0
        : (Math.abs(p.value - p.defaultValue) / (p.max - p.min)) * 100;
    lines.push(
      padEndV(p.key.slice(0, 28), 28) +
        padEndV(p.organ.slice(0, 12), 12) +
        padStartV(fmtKernelNum(p.value), 7) +
        padStartV(fmtKernelNum(p.defaultValue), 7) +
        padStartV(`${Math.round(driftPct * 10) / 10}%`, 8) +
        padStartV(String(p.evidence), 6) +
        padStartV(String(p.generation), 6),
    );
  }
  return lines;
}

/** 全分区渲染器表（section 筛选的分派面） */
const PANE_RENDERERS: Record<Exclude<Section, 'all'>, () => string[]> = {
  tools: renderToolsPane,
  vlm: renderVlmPane,
  autonomy: renderAutonomyPane,
  guards: renderGuardsPane,
  kernel: renderKernelPane,
};

export function createMetricsDashboardTool() {
  return defineTool({
    name: 'metrics_dashboard',
    description:
      'Renders a five-pane TEXT dashboard of whole-system health (monospace-aligned, <=80 columns): ' + // doctor-exempt: 文案字符串（终端排版说明），非阈值比较（W6-2）
      'tools pane (per-tool calls / success rate / P50 / P95, top 10 by volume, plus the global GPD ' +
      'latency-tail report when available), vlm pane (VlmMeter calls / failures / P50 / P95 / tokens / ' +
      'by-kind, plus live isGlmConfigured state), autonomy pane (autonomous_run telemetry record, a ' +
      'lightweight outcome ledger, and an honest "evolution ledger not wired" notice), guards pane ' +
      "(per-tool 'guard:*' deny-interception counters), and kernel pane (the production kernel registry: " +
      'per-key organ / value vs default / drift% / evidence / generation). Read-only, never throws. ' +
      "Pass section: 'tools' | 'vlm' | 'autonomy' | 'guards' | 'kernel' to zoom into one pane (default all).",
    parameters: {
      section: {
        type: 'string',
        description:
          "Which pane to render: 'tools' | 'vlm' | 'autonomy' | 'guards' | 'kernel', or 'all' (default) " +
          'for the full five-pane dashboard.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        // section 解析：缺席/空白 ⇒ 'all'；大小写不敏感；非法值 ⇒ 结构化 toolErr（绝不抛）
        const raw = (args as { section?: unknown } | undefined)?.section;
        let section: Section | null;
        if (raw === undefined || raw === null) {
          section = 'all';
        } else if (typeof raw === 'string') {
          const t = raw.trim().toLowerCase();
          section = t === '' ? 'all' : (VALID_SECTIONS as readonly string[]).includes(t) ? (t as Section) : null;
        } else {
          section = null;
        }
        if (section === null) {
          return toolErr(
            'metrics_dashboard validation failed.',
            `Invalid section value: ${JSON.stringify(raw)}. Valid sections: all | tools | vlm | autonomy | guards | kernel.`,
            "Omit section (or pass 'all') for the full five-pane dashboard, or pass one of " +
              "'tools' | 'vlm' | 'autonomy' | 'guards' | 'kernel' to zoom into a single pane.",
          );
        }

        const chosen: Array<Exclude<Section, 'all'>> =
          section === 'all' ? ['tools', 'vlm', 'autonomy', 'guards', 'kernel'] : [section];

        // 铸盘：总栏（all 模式附全局一行）+ 各分区 + 底栏；每行 80 列硬纪律
        const lines: string[] = [
          heavyRule(`遥测仪表盘 · ${section === 'all' ? '全系统健康（五分区）' : SECTION_TITLES[section]}`),
        ];
        if (section === 'all') {
          const snap = telemetry.snapshot();
          lines.push(
            `运行时长 ${snap.uptime_sec}s │ 总调用 ${snap.global.calls} │ 全局成功率 ${snap.global.success_rate ?? '-'}%` +
              ` │ noop率 ${snap.global.noop_rate ?? '-'}%`,
          );
        }
        for (const name of chosen) lines.push(...PANE_RENDERERS[name]());
        lines.push(heavyRule('Σ-7 · 只读透视 · 绝不抛'));
        const dashboard = lines.map(l => trimToWidth(l, WIDTH_LIMIT)).join('\n');

        // 机读速览（文本之外的程序化消费面 —— 与 dashboard 同源同刻）
        const snap = telemetry.snapshot();
        const auto = snap.tools.find(t => t.tool === 'autonomous_run');
        const guardBlocks = snap.counters
          .filter(c => c.counter.startsWith('guard:'))
          .reduce((n, c) => n + c.misses, 0);
        const vlmSummary = vlmMeter.summary();
        const health = {
          uptime_sec: snap.uptime_sec,
          global_calls: snap.global.calls,
          global_success_rate: snap.global.success_rate,
          vlm_configured: safeIsGlmConfigured(),
          vlm_calls: vlmSummary.calls,
          autonomous_run_calls: auto?.calls ?? 0,
          autonomous_run_success_rate: auto?.success_rate ?? null,
          guard_blocks: guardBlocks,
        };

        return toolOk(
          `metrics_dashboard: rendered ${section === 'all' ? 'five panes' : `the ${SECTION_TITLES[section as Exclude<Section, 'all'>]} pane`} ` +
            `(${lines.length} lines, <=${WIDTH_LIMIT} cols).`,
          {
            section,
            sections: chosen,
            dashboard,
            health,
          },
          'Read the panes for a whole-system snapshot. For machine-readable detail call get_metrics; ' +
          'pass section (tools|vlm|autonomy|guards|kernel) to zoom into one pane. High failure rate on a tool? ' +
          'Re-ground with take_screenshot before retrying; guard interceptions point to rejected calls ' +
          'worth reading the deny reasons for.',
        );
      } catch (error: any) {
        // 绝不抛纪律的兜底臂（理论不可达 —— 渲染全程只读且防御式）
        return toolErr(
          'metrics_dashboard failed.',
          error?.message ?? 'unknown error',
          'The dashboard crashed unexpectedly — it is read-only, so underlying metrics are unaffected. ' +
            'Retry once; if it persists, fall back to get_metrics for the raw snapshot.',
        );
      }
    },
  });
}
