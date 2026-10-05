// src/doctorRules.security.ts
// D-4 质量医生的抗体库（W6R-B9 安全不变量守护段；W8-A9 自 doctorRules.ts 拆出）。
// W6R 安全修复浪潮的不变量 → 静态抗体 —— 医生守护修复成果，防后续回改把
// 安全洞重新引入。规则 id 与注册表 API 不变（经 doctorRules.ts 门面聚合）。
import type { DoctorRule, Finding } from './doctorTypes';
import { finding, isCommentLine, lines, pyCodeLines, readRepoArtifact } from './doctorRules.helpers';

// ─── W6R-B9 安全不变量守护（W6R 修复浪潮的防回归抗体） ───
// 设计律：每条规则锚定一个已落地的 W6R 安全修复的**执法点文本形状**（守卫/
// 字面量/调用形态），回改即报警 —— 与 genesis.zero-intrusion-guard 守护手术锁
// 同一手法（金丝雀式静态断言）。检测只对代码行执法（注释里的修复记载豁免）；
// 全部 structural（医生只提案，安全修复永远人类裁决）。

export const DOCTOR_RULES_SECURITY: DoctorRule[] = [
  {
    // W6R 审批 fail-closed 修复的执法点：grantDetailed 中「confirmCodeHash 缺席
    // ⇒ return 拒绝」三要素（守卫在场 + 紧随 return ok:false + 拒绝理由字面量）。
    // 旧实现的「无码降级 grant」是 fail-open：屏幕注入文本可驱动 request→grant
    // →click 全链自批不可逆操作 —— 守卫被删/被放松都必须立刻可见。
    // ΤΕΛ-4（D-G17① 清偿）：同意通道 fail-closed 家族的防回改锚从单面扩为三面 ——
    // ① grantDetailed（approval.ts / approval.ledger.ts，原锚）；② 队列裁决面
    // （approval.queue.ts 的 adjudicate 码校验块——ΠΑΝ-1 人证执法的拒绝结局
    // 字面量族）；③ canaryGuard 裁决面锚（adjudicateCarriesConfirmEvidence +
    // adjudicate_approval_queue pre 块——ΠΑΝ-80）。原规则只锚 ①：裁决面的
    // 人证执法被删 ⇒ 模型自批链在第二入口复活而医生失明（防回改面缺一角）。
    // 各面 only-if-present：scope 过滤掉某文件时不误报（与原锚 if(!f) return 同律）。
    id: 'sec.approval-fail-closed', category: 'security', severity: 'critical', laws: ['honest-degradation'],
    baseWeight: 2, tags: ['security'], description: 'W6R 审批无码降级残留：confirmCodeHash 缺席必须走 return 拒绝（通道缺席 ⇒ 无同意，不得回退为无码 grant）；队列裁决面与金丝雀裁决锚同律（ΤΕΛ-4/D-G17 三面锚）',
    async scan(ctx) {
      // W8-B3 拆分同步：grantDetailed 已自 approval.ts 迁至 approval.ledger.ts
      // （approval.ts 降为桶/门面）。锚定方式从「路径恰为 approval.ts」改为
      // 「approval 门面/主账本二选一中**含 grantDetailed 落点**者」—— 三要素
      // 检测语义（守卫在场 + 紧随 return ok:false + 拒绝理由字面量）逐字保持；
      // 旧形状源（单文件 approval.ts 含裁决方法）依旧匹配（规则单测夹具兼容）。
      const out: Finding[] = [];
      const f = ctx.sources.find(s =>
        (s.path === 'approval.ts' || s.path === 'approval.ledger.ts') && s.content.includes('grantDetailed'));
      if (f) {
        const raw = lines(f.content);
        const isCode = (l: string): boolean => !isCommentLine(l) && !l.includes('doctor-exempt');
        const guardIdx = raw.findIndex(l => isCode(l) && /confirmCodeHash\s*===\s*undefined/.test(l));
        if (guardIdx < 0) {
          const anchor = Math.max(1, raw.findIndex(l => l.includes('grantDetailed')) + 1);
          out.push(finding(this, 'structural', f.path, anchor, 'grantDetailed(…)',
            'the confirmCodeHash===undefined guard is gone from the grant decision path — degraded tokens (out-of-band channel absent) may be grantable again: fail-open regression of the W6R fix',
            `Restore: if (pa.confirmCodeHash === undefined) return { ok: false, reason: 'confirm-channel-absent' } — before any budget spend or granted=true.`));
        } else {
          const rejectOk = raw.slice(guardIdx, guardIdx + 4)
            .some(l => /return\s*\{/.test(l) && /ok:\s*false/.test(l) && /confirm-channel-absent/.test(l));
          const reasonOk = raw.some(l => isCode(l) && /['"]confirm-channel-absent['"]/.test(l));
          if (!(rejectOk && reasonOk)) {
            out.push(finding(this, 'structural', f.path, guardIdx + 1, raw[guardIdx],
              'guard is present but does not immediately return an ok:false rejection carrying confirm-channel-absent — the no-code grant downgrade may have crept back in',
              `The guard must fail closed in place: return { ok: false, reason: 'confirm-channel-absent' } within the guard block — never fall through to granted=true.`));
          }
        }
      }
      // ── ΤΕΛ-4（D-G17①）②：队列裁决面（adjudicate 的码校验块）──
      // ΠΑΝ-1 人证执法的四个拒绝结局字面量必须在**代码行**在场（注释里的
      // 方法头注不算实现）：缺任一 ⇒ 该结局的 fail-closed 分支被删/放松。
      const q = ctx.sources.find(s => s.path === 'approval.queue.ts');
      if (q) {
        const rawQ = lines(q.content);
        const codeQ = rawQ.map((l, i) => ({ l, i })).filter(x => !isCommentLine(x.l) && !x.l.includes('doctor-exempt'));
        const adjudicateIdx = rawQ.findIndex(l => /adjudicate\s*\(/.test(l));
        const anchorQ = adjudicateIdx >= 0 ? adjudicateIdx + 1 : 1;
        const REQUIRED_QUEUE_OUTCOMES = [
          'confirm-channel-absent',   // 无证据锚 ⇒ 无同意（降级铸造/跨进程恢复面 fail-closed）
          'confirm-code-required',    // 未携码 ⇒ 拒（不烧 Y-10 预算）
          'confirm-code-mismatch',    // 错码 ⇒ 计数拒绝
          'code-attempts-exhausted',  // 枚举封顶 ⇒ 条目焚毁（防暴力枚举）
        ] as const;
        const missing = REQUIRED_QUEUE_OUTCOMES.filter(k =>
          !codeQ.some(({ l }) => new RegExp(`['"]${k}['"]`).test(l)));
        if (missing.length > 0) {
          out.push(finding(this, 'structural', q.path, anchorQ, `adjudicate(…) — missing outcome literal(s): ${missing.join(', ')}`,
            `queue adjudication no longer carries the confirm-evidence rejection outcome(s) [${missing.join(', ')}] — the ΠΑΝ-1 human-attestation enforcement on the queue grant arm was deleted or relaxed: model-self-adjudication (request→adjudicate→takeGranted) can mint execution tokens without out-of-band consent again`,
            `Restore the adjudicate confirm-code block: no evidence anchor ⇒ 'confirm-channel-absent'; no code ⇒ 'confirm-code-required'; mismatch ⇒ 'confirm-code-mismatch' (capped at MAX_CODE_MISMATCHES ⇒ 'code-attempts-exhausted') — all before any Y-10 budget spend or verdict='granted'.`));
        }
      }
      // ── ΤΕΛ-4（D-G17①）③：canaryGuard 裁决面锚 ──
      // ΠΑΝ-80 的 pre 面锚：adjudicate_approval_queue 的 grant 主张必须携带
      // 带外确认码证据（在场性检查函数 + 端点名锚）。任一消失 ⇒ 裁决面
      // 金丝雀整体被拆（队列侧 fail-closed 仍在，但更早、带教学文案的一跳
      // 与守卫侧独立防线失明）。
      const cg = ctx.sources.find(s => s.path === 'guards/canaryGuard.ts');
      if (cg) {
        const rawC = lines(cg.content);
        const codeC = rawC.map((l, i) => ({ l, i })).filter(x => !isCommentLine(x.l) && !x.l.includes('doctor-exempt'));
        const regIdx = rawC.findIndex(l => /export function registerCanaryGuard/.test(l));
        const anchorC = regIdx >= 0 ? regIdx + 1 : 1;
        const hasPredicate = codeC.some(({ l }) => /adjudicateCarriesConfirmEvidence/.test(l));
        const hasToolAnchor = codeC.some(({ l }) => /['"]adjudicate_approval_queue['"]/.test(l));
        if (!hasPredicate || !hasToolAnchor) {
          out.push(finding(this, 'structural', cg.path, anchorC, 'registerCanaryGuard(…)',
            `canary adjudication anchor incomplete: ${!hasPredicate ? 'adjudicateCarriesConfirmEvidence predicate missing' : ''}${!hasPredicate && !hasToolAnchor ? ' + ' : ''}${!hasToolAnchor ? 'adjudicate_approval_queue pre-hook anchor missing' : ''} — the ΠΑΝ-80 guard-side fail-closed layer over queue adjudication was removed`,
            `Restore the pre-hook block: calls named 'adjudicate_approval_queue' with grant===true must pass adjudicateCarriesConfirmEvidence (evidence presence: non-empty confirm_code string or per-id map) or be blocked with guidance; deny is always allowed without evidence.`));
        }
      }
      return out;
    },
  },
  {
    // W6R 确认码带外纪律：明文 confirmCode 只许流经宿主事件总线（模型上下文
    // 不可见）；console 输出一律脱敏。任何 console/log 语句输出明文码 = 「码对
    // 模型不可见」的承诺失效（宿主可能把控制台日志回传进模型上下文）。
    // 注意 \bconfirmCode\b 不匹配 confirmCodeHash（哈希可输出，明文不可）。
    id: 'sec.confirm-code-oob-leak', category: 'security', severity: 'critical', laws: ['token-discipline'],
    baseWeight: 2, tags: ['security'], description: 'W6R 确认码纪律：明文 confirmCode 不得进入任何 console 输出语句（码对模型不可见；哈希不受限）',
    async scan(ctx) {
      const out: Finding[] = [];
      for (const f of ctx.sources) {
        for (const [i, l] of lines(f.content).entries()) {
          if (isCommentLine(l) || l.includes('doctor-exempt')) continue;
          if (/console\.(?:log|info|warn|error|debug|trace)\s*\(/.test(l) && /\bconfirmCode\b/.test(l)) {
            out.push(finding(this, 'structural', f.path, i + 1, l,
              'plaintext approval confirm code flows into a console statement — hosts may feed console logs back into model context, breaking the "code invisible to model" promise',
              'Deliver the code only via the out-of-band host event bus (approval/confirm-code); console receipts must stay masked (fact of delivery, never the code itself).'));
          }
        }
      }
      return out;
    },
  },
  {
    // W6R shell 启动纪律（其一）：system.ts 弃 cmd.exe /c start —— cmd 解析层
    // 展开 %VAR%、把 & | > , 当命令语法，URL 身处一个 shell 解释器。回归检测
    // 三形态：'cmd.exe' 字面量 / '/c'+'start' 参数对 / spawn 族调用携带 'cmd'。
    // （macOS 修饰键 'cmd' 不在 spawn 上下文 —— 同行无子进程调用不误报。）
    id: 'sec.shell-launch-cmd', category: 'security', severity: 'critical', laws: [],
    baseWeight: 2, tags: ['security'], description: 'W6R shell 启动纪律：system.ts 禁止 cmd.exe /c start 壳层通道（URL 必须经 rundll32 数组参数直达）',
    async scan(ctx) {
      const f = ctx.sources.find(s => s.path === 'system.ts');
      if (!f) return [];
      const out: Finding[] = [];
      for (const [i, l] of lines(f.content).entries()) {
        if (isCommentLine(l) || l.includes('doctor-exempt')) continue;
        const cmdExe = /['"`]cmd\.exe['"`]/i.test(l);
        const cmdStart = /['"`]\/c['"`]/.test(l) && /['"`]start['"`]/.test(l);
        const spawnCmd = /(?<![\w.])(?:spawn|execFile|exec|spawnSync)\s*\(/.test(l) && /['"`]cmd['"`]/.test(l);
        if (cmdExe || cmdStart || spawnCmd) {
          out.push(finding(this, 'structural', f.path, i + 1, l,
            'cmd.exe shell-launch channel in system.ts — the cmd parser expands %VAR% and treats & | > , as syntax, reopening command injection through URLs',
            'Launch via rundll32.exe url.dll,FileProtocolHandler with argv-array spawn (no shell parse, no verbatim args); explorer.exe fallback keeps the same array form.'));
        }
      }
      return out;
    },
  },
  {
    // W6R shell 启动纪律（其二）：environmentShaper 的 powershell 调用必须
    // -EncodedCommand —— 命令行上只有 base64 载荷，零 PS 语法解析点。'-Command'
    // 字面量重现 = 整段脚本重回命令行解析面（titleHint 等外部输入的转义遗漏
    // 即 RCE）；EncodedCommand 字面量整体消失 = 加固被整体移除。
    id: 'sec.ps-encoded-command', category: 'security', severity: 'critical', laws: [],
    baseWeight: 2, tags: ['security'], description: 'W6R PS 启动纪律：environmentShaper 的 powershell 必走 -EncodedCommand（禁 -Command；无 EncodedCommand 亦违规）',
    async scan(ctx) {
      const f = ctx.sources.find(s => s.path === 'environmentShaper.ts');
      if (!f) return [];
      const raw = lines(f.content);
      const codeLines = raw.map((l, i) => ({ l, i }))
        .filter(x => !isCommentLine(x.l) && !x.l.includes('doctor-exempt'));
      const out: Finding[] = [];
      for (const { l, i } of codeLines) {
        if (/['"`]-Command['"`]/.test(l)) {
          out.push(finding(this, 'structural', f.path, i + 1, l,
            'PowerShell invoked with -Command — the whole script rides the command-line parse surface; any escaping gap in external input (titleHint) is RCE',
            'Route scripts through psEncodeCommand (UTF-16LE base64) with -EncodedCommand: no PS syntax exists on the argv at all.'));
        }
      }
      if (out.length === 0 && !codeLines.some(({ l }) => /EncodedCommand/.test(l))) {
        out.push(finding(this, 'structural', f.path, 1, 'PS_FLAGS / powershell invocation',
          'no -EncodedCommand literal in code — the W6R shell-hardening may have been removed entirely',
          `Restore PS_FLAGS = ['-NoProfile', '-NonInteractive', '-EncodedCommand'] and encode every script via psEncodeCommand.`));
      }
      return out;
    },
  },
  {
    // W6R 依赖归类守护：sharp/tesseract.js 是运行时 import（感知/OCR 面的躯体），
    // 归进 devDependencies = 生产装机（npm install --omit=dev）即缺件 —— 运行时
    // 整面瘫痪。读 package.json JSON 验证（合成件优先，磁盘实读兜底）。
    id: 'sec.runtime-deps', category: 'security', severity: 'major', laws: ['config-driven'],
    baseWeight: 1.5, tags: ['security'], description: 'W6R 依赖归类守护：sharp/tesseract.js 必须在 dependencies（运行时依赖进 devDependencies = 生产即缺件）',
    async scan(ctx) {
      const text = readRepoArtifact('package.json', ctx);
      if (text === null) {
        ctx.warn('sec.runtime-deps: package.json unreadable — dependency-class invariant not scanned');
        return [];
      }
      let pkg: any;
      try { pkg = JSON.parse(text); } catch (e: any) {
        ctx.warn(`sec.runtime-deps: package.json unparseable (${e.message}) — invariant not scanned`);
        return [];
      }
      const deps = (pkg && typeof pkg.dependencies === 'object' && pkg.dependencies !== null) ? pkg.dependencies : {};
      const dev = (pkg && typeof pkg.devDependencies === 'object' && pkg.devDependencies !== null) ? pkg.devDependencies : {};
      const out: Finding[] = [];
      for (const name of ['sharp', 'tesseract.js']) {
        if (deps[name] !== undefined) continue;
        const where = dev[name] !== undefined ? 'devDependencies' : 'absent from the manifest';
        out.push(finding(this, 'structural', 'package.json', 1, `"${name}" → ${where}`,
          `"${name}" is imported at runtime but is ${where} — production installs (omit=dev) ship without it and the perception/OCR surface dead-boots`,
          `Move "${name}" into "dependencies": it is a runtime import, not a build-time tool.`));
      }
      return out;
    },
  },
  {
    // W6R android 转义纪律：adb shell 后的参数在设备端经 /system/bin/sh -c 解释，
    // type_text 的文本必须整串经 shlex.quote 单引号包裹（POSIX 方言标准实现，
    // 零自制转义轮子）。检测锚定方法体内**代码行**的 shlex.quote 调用 ——
    // docstring 里对规则的描述不算实现（实现被删、文档还在时必须报警）。
    id: 'sec.android-shell-escape', category: 'security', severity: 'critical', laws: [],
    baseWeight: 2, tags: ['security'], description: 'W6R android 转义纪律：android.py 的 type_text 必须经 shlex.quote（设备端 shell 注入面消解）',
    async scan(ctx) {
      const rel = 'python_service/dsh_physical/android.py';
      const text = readRepoArtifact(rel, ctx);
      if (text === null) {
        ctx.warn(`sec.android-shell-escape: ${rel} unreadable — type_text escape invariant not scanned`);
        return [];
      }
      const raw = lines(text);
      const code = pyCodeLines(raw);
      const hasImport = code.some(({ l }) => /^\s*import\s+shlex\b/.test(l));
      const defIdx = raw.findIndex(l => /def\s+type_text\s*\(/.test(l));
      if (defIdx < 0) {
        ctx.warn(`sec.android-shell-escape: def type_text not found in ${rel} — surface may have moved; amend the rule anchor`);
        return [];
      }
      let end = raw.findIndex((l, i) => i > defIdx && /^\s{0,8}def\s+\w+/.test(l));
      if (end < 0) end = raw.length;
      const quoted = code.some(({ l, i }) => i > defIdx && i < end && /shlex\.quote\s*\(/.test(l));
      if (hasImport && quoted) return [];
      return [finding(this, 'structural', rel, defIdx + 1, raw[defIdx],
        `type_text escape discipline broken: ${hasImport ? 'shlex.quote call missing from the method body (raw or hand-rolled escaping reaches the device shell)' : 'import shlex missing altogether'} — adb args are interpreted by /system/bin/sh on device; metacharacters (; & $ ( ) \` | < >) are syntax there`,
        `Escape the whole payload with shlex.quote(text.replace(" ", "%s")) before self._shell(serial, "text", …) — stdlib POSIX quoting, never a homemade escaper.`)];
    },
  },
  {
    // W6R 审计 WAL 下限守护：变更类名单是先行审计（W2-2 fail-closed 提交）的
    // 名单面，W6R-A9 补齐后为 18 件（物理动作/绕过宿主管线/文件系统写入三族）。
    // 名单回缩 ⇒ 被删工具静默绕过派发前审计 —— 下限守护防「误删回缩」。
    // ΑΩ-R28 锚点同步：名单已自 guards/auditGuard.ts 迁至工具装配唯一事实源
    // tools/index.ts（MUTATING_TOOL_NAMES 单源导出，auditGuard 只读引入）——
    // 检测语义（宣言消失 ⇒ 报警；条目数 < 下限 ⇒ 报警）逐字保持，只换锚点
    //（W8-B3 拆分同步同法）。
    id: 'sec.audit-wal-floor', category: 'security', severity: 'major', laws: ['honest-degradation'],
    baseWeight: 1.5, tags: ['security'], description: 'W6R 审计 WAL 下限：tools/index.ts 的 MUTATING_TOOL_NAMES 名单长度须达下限（W6R-A9 补齐后的 18 件 —— 防误删回缩绕过先行审计）',
    async scan(ctx) {
      const f = ctx.sources.find(s => s.path.endsWith('tools/index.ts'));
      if (!f) return [];
      const text = f.content;
      const start = text.indexOf('MUTATING_TOOL_NAMES');
      const declLine = Math.max(1, lines(text.slice(0, start)).length);
      if (start < 0) {
        return [finding(this, 'structural', f.path, 1, 'MUTATING_TOOL_NAMES',
          'the MUTATING_TOOL_NAMES declaration is gone from tools/index.ts — pre-dispatch audit WAL may no longer gate any tool',
          'Restore the mutating-tool set (see the W6R-A9 families annotation in src/tools/index.ts).')];
      }
      const end = text.indexOf('])', start);
      const block = text.slice(start, end < 0 ? undefined : end);
      const count = [...block.matchAll(/'([A-Za-z0-9_]+)'/g)].length;
      const FLOOR = 18; // W6R-A9 补齐后的名单下限（具名常量 —— 防规则自身触雷 magic-number）
      if (count >= FLOOR) return [];
      return [finding(this, 'structural', f.path, declLine, `MUTATING_TOOL_NAMES = new Set([ … ${count} entries ])`,
        `pre-dispatch audit WAL covers only ${count} mutating tools — below the W6R-A9 floor of ${FLOOR}; any dropped tool dispatches without an audit trail`,
        `Re-add the dropped mutating tools — physical action family, host-pipeline-bypassing batches, and filesystem-write family (W6R-A9 annotation in src/tools/index.ts).`)];
    },
  },
];
