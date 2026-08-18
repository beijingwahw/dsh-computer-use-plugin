// src/doctorRules.ts
// D-4 质量医生的抗体库：13 条审查规则（数据驱动静态注册表）。
// 从 qualityDoctor.ts 拆出 —— 医生吃自己的处方（smell.over-engineering 的自愈）。
// 规则是纯函数对象：绝不持有状态；进化记忆只在外部计算生效权重，绝不反向修改此处。
import type { DoctorRule, Finding, RiskLevel, ScanContext } from './doctorTypes';

const MARKER_TOOLS = new Set(['AGENT_BEGIN', 'AGENT_END', 'ENV_SHAPED', 'SENSE_SHIFT']);
export const EMPTY_CATCH_FIX = 'FIXME(doctor): document why this error is intentionally swallowed';

/** checkpoint.ts 的 Checkpoint 是模块私有 —— 此为 D-4 的只读结构视图 */
function finding(rule: DoctorRule, riskLevel: RiskLevel, file: string, line: number, snippet: string,
                 evidence: string, recommendation: string): Finding {
  return {
    id: `${rule.id}@${file}:${line}`, ruleId: rule.id, severity: rule.severity, riskLevel,
    location: { file, line, snippet: snippet.trim().slice(0, 160) }, evidence, recommendation,
  };
}

export function lines(s: string): string[] { return s.split('\n'); }

// ─── 规则注册表（数据驱动静态配置 —— 进化记忆绝不反向修改） ───

export const DOCTOR_RULES: DoctorRule[] = [
  {
    id: 'genesis.io-mutex', category: 'genesis', severity: 'critical', laws: ['io-serialization'],
    baseWeight: 2, tags: ['genesis'], description: '防腐层纪律：nut-js 只允许 system.ts 导入（IO 串行化铁律）',
    async scan(ctx) {
      const out: Finding[] = [];
      for (const f of ctx.sources) {
        if (f.path === 'system.ts') continue;
        for (const [i, l] of lines(f.content).entries()) {
          if (/from\s+['"]@nut-tree\/nut-js['"]/.test(l) || /require\(['"]@nut-tree\/nut-js['"]\)/.test(l)) {
            out.push(finding(this, 'structural', f.path, i + 1, l,
              'nut-js imported outside the anti-corruption layer (system.ts) — bypasses serialize() IO mutex',
              'Route the call through system.ts (the single serialized IO boundary).'));
          }
        }
      }
      return out;
    },
  },
  {
    id: 'genesis.token-leak', category: 'genesis', severity: 'major', laws: ['token-discipline'],
    baseWeight: 1.5, tags: ['genesis'], description: '白盒/潜意识原始数据不得进入工具文本输出（Token 零损耗铁律）',
    async scan(ctx) {
      const out: Finding[] = [];
      for (const f of ctx.sources.filter(s => s.path.startsWith('tools/'))) {
        for (const [i, l] of lines(f.content).entries()) {
          if (/(quantumOverlays|WhiteboxOverlay|dumpSubconscious|subconscious)/.test(l) &&
              /(JSON\.stringify|toolOk\(|toolErr\()/.test(l)) {
            out.push(finding(this, 'structural', f.path, i + 1, l,
              'structured-sense raw data flows into a textual tool output on the same statement line',
              'Keep whitebox/subconscious data out of conversation-facing strings; bounded counts only.'));
          }
        }
      }
      return out;
    },
  },
  {
    id: 'genesis.premature-impl', category: 'genesis', severity: 'major', laws: ['architecture-void'],
    baseWeight: 1.5, tags: ['genesis'], description: '预留接口槽不得偷填实现（架构留白铁律 —— WindowsAdapter 保持签名就位）',
    async scan(ctx) {
      const f = ctx.sources.find(s => s.path.endsWith('environmentShaper.ts'));
      if (!f) return [];
      const text = f.content;
      const start = text.indexOf('class WindowsAdapter');
      if (start < 0) return [];
      const end = text.indexOf('export class', start + 10);
      const block = text.slice(start, end < 0 ? undefined : end);
      const out: Finding[] = [];
      if (/execFile|spawnSync|spawn\(|child_process|powershell|ffi|DllImport/.test(block)) {
        const line = lines(text.slice(0, start)).length;
        out.push(finding(this, 'structural', f.path, line, 'class WindowsAdapter { … }',
          'the reserved WindowsAdapter slot contains real implementation calls — the architecture void was filled',
          'Move the implementation behind a capability probe and keep the slot reserved until a real Windows environment exists.'));
      }
      return out;
    },
  },
  {
    id: 'genesis.zero-intrusion-guard', category: 'genesis', severity: 'critical', laws: ['zero-intrusion'],
    baseWeight: 2, tags: ['genesis', 'self'],
    description: '手术锁金丝雀：heal 写盘路径必须保有 structural 拒绝守卫（零侵入铁律的结构断言）',
    async scan(ctx) {
      const f = ctx.sources.find(s => s.path.endsWith('qualityDoctor.ts'));
      if (!f) return [];
      if (!/riskLevel\s*!==\s*'mechanical'/.test(f.content)) {
        const line = Math.max(1, lines(f.content).findIndex(l => l.includes('async heal')) + 1);
        return [finding(this, 'structural', f.path, line, 'heal() write path',
          'the structural-write guard literal is missing from heal() — the surgery lock may have been removed',
          'Restore the guard: patches with riskLevel !== mechanical must never reach writeFileSync.')];
      }
      return [];
    },
  },
  {
    id: 'smell.magic-number', category: 'smell', severity: 'minor', laws: ['config-driven'],
    baseWeight: 0.5, tags: ['smell'], description: '比较表达式中的两位数裸字面量应提取为具名常量/枚举（配置化铁律）',
    async scan(ctx) {
      const out: Finding[] = [];
      for (const f of ctx.sources) {
        if (f.path === 'config.ts' || f.path.endsWith('.d.ts')) continue;
        for (const [i, l] of lines(f.content).entries()) {
          if (l.includes('doctor-exempt')) continue;
          const trimmed = l.trim();
          // 注释行豁免（如「Node >= 18」是文档不是代码）
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
          const m = l.match(/(?:===|!==|==|!=|>=|<=)\s*(\d{2,})\b/);
          if (m) {
            out.push(finding(this, 'structural', f.path, i + 1, l,
              `bare numeric literal ${m[1]} in a comparison — intent is unreadable and unconfigurable`,
              `Extract to a named constant (or move the threshold into config.ts); add "doctor-exempt" comment if intentional.`));
          }
        }
      }
      return out;
    },
  },
  {
    id: 'smell.empty-catch', category: 'smell', severity: 'minor', laws: ['honest-degradation'],
    baseWeight: 1, tags: ['smell'], description: '空 catch 且无注释豁免 = 静默吞错（异常诚实铁律；有意吞错必须写明原因）',
    async scan(ctx) {
      const out: Finding[] = [];
      for (const f of ctx.sources) {
        const ls = lines(f.content);
        for (let i = 0; i < ls.length; i++) {
          const l = ls[i];
          // 单行空 catch（catch 可在行中 —— 尾部锚定；块内含注释则不匹配 = 豁免）
          if (/catch\s*(\([^)]*\))?\s*\{\s*\}\s*$/.test(l)) {
            out.push(finding(this, 'mechanical', f.path, i + 1, l,
              'empty catch block with no comment — swallowed errors are silent lies',
              `Insert a comment stating the intent, e.g. /* ${EMPTY_CATCH_FIX} */`));
            continue;
          }
          // 多行空 catch：open 行以「catch (...) {」结尾，其后到关闭括号之间全为空白
          if (/catch\s*(\([^)]*\))?\s*\{\s*$/.test(l)) {
            let j = i + 1;
            while (j < ls.length && ls[j].trim() === '') j++;
            if (j < ls.length && /^\s*\}\s*$/.test(ls[j])) {
              out.push(finding(this, 'mechanical', f.path, i + 1, l,
                'multi-line empty catch block with no comment — swallowed errors are silent lies',
                `Add an intent comment inside the block, e.g. // ${EMPTY_CATCH_FIX}`));
            }
          }
        }
      }
      return out;
    },
  },
  {
    id: 'smell.over-engineering', category: 'smell', severity: 'info', laws: [],
    baseWeight: 0.5, tags: ['smell'], description: '单文件 >500 行是拆分信号（最小复杂度铁律）',
    async scan(ctx) {
      const out: Finding[] = [];
      for (const f of ctx.sources) {
        const n = lines(f.content).length;
        if (n > 500) {
          out.push(finding(this, 'structural', f.path, 1, `// ${n} lines`,
            `file has ${n} lines (>500) — cohesion is drifting`,
            'Split along responsibility boundaries (rule registry / engine / persistence).'));
        }
      }
      return out;
    },
  },
  {
    id: 'sec.exec-concat', category: 'security', severity: 'major', laws: [],
    baseWeight: 1.5, tags: ['security'], description: '子进程参数中的未消毒字符串插值（命令注入面）',
    async scan(ctx) {
      const out: Finding[] = [];
      const SANITIZED = /Math\.(round|floor|min|max)|Number\(|String\(|parseInt|encodeURIComponent/;
      for (const f of ctx.sources) {
        const ls = lines(f.content);
        for (let i = 0; i < ls.length; i++) {
          // 负向后顾排除方法调用：regex.exec() / coordinator.spawn() 不是子进程
          if (!/(?<![\w.])\b(?:execFile|exec|spawnSync|spawn)\s*\(/.test(ls[i])) continue;
          const stmt = ls.slice(i, Math.min(i + 4, ls.length)).join(' ');
          for (const m of stmt.matchAll(/\$\{([^}]*)\}/g)) {
            if (!SANITIZED.test(m[1])) {
              out.push(finding(this, 'structural', f.path, i + 1, ls[i],
                `unsanitized interpolation "${m[1].trim().slice(0, 60)}" inside a child-process call`,
                'Coerce through Math.round/Number/String before interpolating into exec args.'));
              break;
            }
          }
        }
      }
      return out;
    },
  },
  {
    id: 'sec.hardcoded-secret', category: 'security', severity: 'critical', laws: [],
    baseWeight: 2, tags: ['security'], description: '疑似硬编码凭据（password/secret/api key/token 赋字面量）',
    async scan(ctx) {
      const out: Finding[] = [];
      for (const f of ctx.sources) {
        for (const [i, l] of lines(f.content).entries()) {
          if (l.includes('process.env') || l.includes('doctor-exempt')) continue;
          const m = l.match(/(password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"][^'"]{8,}['"]/i);
          if (m) {
            out.push(finding(this, 'structural', f.path, i + 1, l,
              'credential-like literal assigned in source',
              'Load from environment/config; never commit secrets.'));
          }
        }
      }
      return out;
    },
  },
  {
    id: 'chain.agent-pairing', category: 'chain', severity: 'major', laws: [],
    baseWeight: 1.5, tags: ['chain'], description: 'AGENT_BEGIN 必有配对 AGENT_END（生命周期不得撒谎）',
    async scan(ctx) {
      const out: Finding[] = [];
      const ended = new Set<string>();
      for (const e of ctx.chain.entries) if (e.tool === 'AGENT_END') ended.add(String(e.args.taskId));
      for (const e of ctx.chain.entries) {
        if (e.tool === 'AGENT_BEGIN' && !ended.has(String(e.args.taskId))) {
          out.push(finding(this, 'structural', 'journal', 0, `AGENT_BEGIN ${e.args.taskId}`,
            `sub-agent "${e.args.taskId}" born but never ended (crash or lifecycle lie)`,
            'Ensure abort()/report() always appends the AGENT_END marker.'));
        }
      }
      return out;
    },
  },
  {
    id: 'chain.shaper-parity', category: 'chain', severity: 'major', laws: [],
    baseWeight: 1, tags: ['chain'], description: '撤销义务与 ENV_SHAPED 链证对账（做了没记 = 复原义务来源不明）',
    async scan(ctx) {
      if (!ctx.snapshot?.shaper?.undoLog) return [];
      const envCount = ctx.chain.entries.filter(e => e.tool === 'ENV_SHAPED').length;
      const undoLen = ctx.snapshot.shaper.undoLog.length;
      if (undoLen > envCount) {
        return [finding(this, 'structural', 'journal', 0, `undoLog=${undoLen} ENV_SHAPED=${envCount}`,
          `undo log holds ${undoLen} duties but the chain evidences only ${envCount} shaping actions — origin unknown`,
          'Restore parity: every apply() must append its ENV_SHAPED marker.')];
      }
      return [];
    },
  },
  {
    id: 'chain.sense-legality', category: 'chain', severity: 'critical', laws: ['honest-degradation'],
    baseWeight: 2, tags: ['chain'], description: '降级叠加态前必须有硬失败证据（simulated rescue 与 simulated success 同罪）',
    async scan(ctx) {
      const out: Finding[] = [];
      let fails = 0;
      for (const e of ctx.chain.entries) {
        if (e.tool === 'SENSE_SHIFT') {
          if (String(e.args.to) === 'superposition' && fails === 0) {
            out.push(finding(this, 'structural', 'journal', 0,
              `SENSE_SHIFT → ${e.args.to} with 0 prior failures`,
              'degraded to superposition without any verified failure — rescue without evidence',
              'Only recordEffect(false) evidence may trigger the shift (quantum state machine contract).'));
          }
          fails = 0;
        } else if (e.effect_detected === false) {
          fails++;
        }
      }
      return out;
    },
  },
  {
    id: 'chain.marker-purity', category: 'chain', severity: 'critical', laws: [],
    baseWeight: 1.5, tags: ['chain'], description: '标记事件必须保持 MARKER 语义（不得混入动作流）',
    async scan(ctx) {
      const out: Finding[] = [];
      for (const [i, e] of ctx.chain.entries.entries()) {
        if (MARKER_TOOLS.has(e.tool) && e.status !== 'MARKER') {
          out.push(finding(this, 'structural', 'journal', i, `${e.tool} status=${e.status}`,
            'lifecycle marker with non-MARKER status — the D-1 gating bypass may be broken',
            'Markers must go through appendMarker (status恒为MARKER), never append.'));
        }
      }
      return out;
    },
  },
];
