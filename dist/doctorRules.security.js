import { finding, isCommentLine, lines, pyCodeLines, readRepoArtifact } from './doctorRules.helpers.js';
// ─── W6R-B9 安全不变量守护（W6R 修复浪潮的防回归抗体） ───
// 设计律：每条规则锚定一个已落地的 W6R 安全修复的**执法点文本形状**（守卫/
// 字面量/调用形态），回改即报警 —— 与 genesis.zero-intrusion-guard 守护手术锁
// 同一手法（金丝雀式静态断言）。检测只对代码行执法（注释里的修复记载豁免）；
// 全部 structural（医生只提案，安全修复永远人类裁决）。
export const DOCTOR_RULES_SECURITY = [
    {
        // W6R 审批 fail-closed 修复的执法点：grantDetailed 中「confirmCodeHash 缺席
        // ⇒ return 拒绝」三要素（守卫在场 + 紧随 return ok:false + 拒绝理由字面量）。
        // 旧实现的「无码降级 grant」是 fail-open：屏幕注入文本可驱动 request→grant
        // →click 全链自批不可逆操作 —— 守卫被删/被放松都必须立刻可见。
        id: 'sec.approval-fail-closed', category: 'security', severity: 'critical', laws: ['honest-degradation'],
        baseWeight: 2, tags: ['security'], description: 'W6R 审批无码降级残留：confirmCodeHash 缺席必须走 return 拒绝（通道缺席 ⇒ 无同意，不得回退为无码 grant）',
        async scan(ctx) {
            // W8-B3 拆分同步：grantDetailed 已自 approval.ts 迁至 approval.ledger.ts
            // （approval.ts 降为桶/门面）。锚定方式从「路径恰为 approval.ts」改为
            // 「approval 门面/主账本二选一中**含 grantDetailed 落点**者」—— 三要素
            // 检测语义（守卫在场 + 紧随 return ok:false + 拒绝理由字面量）逐字保持；
            // 旧形状源（单文件 approval.ts 含裁决方法）依旧匹配（规则单测夹具兼容）。
            const f = ctx.sources.find(s => (s.path === 'approval.ts' || s.path === 'approval.ledger.ts') && s.content.includes('grantDetailed'));
            if (!f)
                return [];
            const raw = lines(f.content);
            const isCode = (l) => !isCommentLine(l) && !l.includes('doctor-exempt');
            const guardIdx = raw.findIndex(l => isCode(l) && /confirmCodeHash\s*===\s*undefined/.test(l));
            if (guardIdx < 0) {
                const anchor = Math.max(1, raw.findIndex(l => l.includes('grantDetailed')) + 1);
                return [finding(this, 'structural', f.path, anchor, 'grantDetailed(…)', 'the confirmCodeHash===undefined guard is gone from the grant decision path — degraded tokens (out-of-band channel absent) may be grantable again: fail-open regression of the W6R fix', `Restore: if (pa.confirmCodeHash === undefined) return { ok: false, reason: 'confirm-channel-absent' } — before any budget spend or granted=true.`)];
            }
            const rejectOk = raw.slice(guardIdx, guardIdx + 4)
                .some(l => /return\s*\{/.test(l) && /ok:\s*false/.test(l) && /confirm-channel-absent/.test(l));
            const reasonOk = raw.some(l => isCode(l) && /['"]confirm-channel-absent['"]/.test(l));
            if (rejectOk && reasonOk)
                return [];
            return [finding(this, 'structural', f.path, guardIdx + 1, raw[guardIdx], 'guard is present but does not immediately return an ok:false rejection carrying confirm-channel-absent — the no-code grant downgrade may have crept back in', `The guard must fail closed in place: return { ok: false, reason: 'confirm-channel-absent' } within the guard block — never fall through to granted=true.`)];
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
            const out = [];
            for (const f of ctx.sources) {
                for (const [i, l] of lines(f.content).entries()) {
                    if (isCommentLine(l) || l.includes('doctor-exempt'))
                        continue;
                    if (/console\.(?:log|info|warn|error|debug|trace)\s*\(/.test(l) && /\bconfirmCode\b/.test(l)) {
                        out.push(finding(this, 'structural', f.path, i + 1, l, 'plaintext approval confirm code flows into a console statement — hosts may feed console logs back into model context, breaking the "code invisible to model" promise', 'Deliver the code only via the out-of-band host event bus (approval/confirm-code); console receipts must stay masked (fact of delivery, never the code itself).'));
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
            if (!f)
                return [];
            const out = [];
            for (const [i, l] of lines(f.content).entries()) {
                if (isCommentLine(l) || l.includes('doctor-exempt'))
                    continue;
                const cmdExe = /['"`]cmd\.exe['"`]/i.test(l);
                const cmdStart = /['"`]\/c['"`]/.test(l) && /['"`]start['"`]/.test(l);
                const spawnCmd = /(?<![\w.])(?:spawn|execFile|exec|spawnSync)\s*\(/.test(l) && /['"`]cmd['"`]/.test(l);
                if (cmdExe || cmdStart || spawnCmd) {
                    out.push(finding(this, 'structural', f.path, i + 1, l, 'cmd.exe shell-launch channel in system.ts — the cmd parser expands %VAR% and treats & | > , as syntax, reopening command injection through URLs', 'Launch via rundll32.exe url.dll,FileProtocolHandler with argv-array spawn (no shell parse, no verbatim args); explorer.exe fallback keeps the same array form.'));
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
            if (!f)
                return [];
            const raw = lines(f.content);
            const codeLines = raw.map((l, i) => ({ l, i }))
                .filter(x => !isCommentLine(x.l) && !x.l.includes('doctor-exempt'));
            const out = [];
            for (const { l, i } of codeLines) {
                if (/['"`]-Command['"`]/.test(l)) {
                    out.push(finding(this, 'structural', f.path, i + 1, l, 'PowerShell invoked with -Command — the whole script rides the command-line parse surface; any escaping gap in external input (titleHint) is RCE', 'Route scripts through psEncodeCommand (UTF-16LE base64) with -EncodedCommand: no PS syntax exists on the argv at all.'));
                }
            }
            if (out.length === 0 && !codeLines.some(({ l }) => /EncodedCommand/.test(l))) {
                out.push(finding(this, 'structural', f.path, 1, 'PS_FLAGS / powershell invocation', 'no -EncodedCommand literal in code — the W6R shell-hardening may have been removed entirely', `Restore PS_FLAGS = ['-NoProfile', '-NonInteractive', '-EncodedCommand'] and encode every script via psEncodeCommand.`));
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
            let pkg;
            try {
                pkg = JSON.parse(text);
            }
            catch (e) {
                ctx.warn(`sec.runtime-deps: package.json unparseable (${e.message}) — invariant not scanned`);
                return [];
            }
            const deps = (pkg && typeof pkg.dependencies === 'object' && pkg.dependencies !== null) ? pkg.dependencies : {};
            const dev = (pkg && typeof pkg.devDependencies === 'object' && pkg.devDependencies !== null) ? pkg.devDependencies : {};
            const out = [];
            for (const name of ['sharp', 'tesseract.js']) {
                if (deps[name] !== undefined)
                    continue;
                const where = dev[name] !== undefined ? 'devDependencies' : 'absent from the manifest';
                out.push(finding(this, 'structural', 'package.json', 1, `"${name}" → ${where}`, `"${name}" is imported at runtime but is ${where} — production installs (omit=dev) ship without it and the perception/OCR surface dead-boots`, `Move "${name}" into "dependencies": it is a runtime import, not a build-time tool.`));
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
            if (end < 0)
                end = raw.length;
            const quoted = code.some(({ l, i }) => i > defIdx && i < end && /shlex\.quote\s*\(/.test(l));
            if (hasImport && quoted)
                return [];
            return [finding(this, 'structural', rel, defIdx + 1, raw[defIdx], `type_text escape discipline broken: ${hasImport ? 'shlex.quote call missing from the method body (raw or hand-rolled escaping reaches the device shell)' : 'import shlex missing altogether'} — adb args are interpreted by /system/bin/sh on device; metacharacters (; & $ ( ) \` | < >) are syntax there`, `Escape the whole payload with shlex.quote(text.replace(" ", "%s")) before self._shell(serial, "text", …) — stdlib POSIX quoting, never a homemade escaper.`)];
        },
    },
    {
        // W6R 审计 WAL 下限守护：MUTATING_TOOLS 是先行审计（W2-2 fail-closed 提交）
        // 的名单面，W6R-A9 补齐后为 18 件（物理动作/绕过宿主管线/文件系统写入三族）。
        // 名单回缩 ⇒ 被删工具静默绕过派发前审计 —— 下限守护防「误删回缩」。
        id: 'sec.audit-wal-floor', category: 'security', severity: 'major', laws: ['honest-degradation'],
        baseWeight: 1.5, tags: ['security'], description: 'W6R 审计 WAL 下限：auditGuard 的 MUTATING_TOOLS 名单长度须达下限（W6R-A9 补齐后的 18 件 —— 防误删回缩绕过先行审计）',
        async scan(ctx) {
            const f = ctx.sources.find(s => s.path.endsWith('guards/auditGuard.ts'));
            if (!f)
                return [];
            const text = f.content;
            const start = text.indexOf('MUTATING_TOOLS');
            const declLine = Math.max(1, lines(text.slice(0, start)).length);
            if (start < 0) {
                return [finding(this, 'structural', f.path, 1, 'MUTATING_TOOLS', 'the MUTATING_TOOLS declaration is gone from auditGuard.ts — pre-dispatch audit WAL may no longer gate any tool', 'Restore the mutating-tool set (see the W6R-A9 families annotation in auditGuard.ts).')];
            }
            const end = text.indexOf('])', start);
            const block = text.slice(start, end < 0 ? undefined : end);
            const count = [...block.matchAll(/'([A-Za-z0-9_]+)'/g)].length;
            const FLOOR = 18; // W6R-A9 补齐后的名单下限（具名常量 —— 防规则自身触雷 magic-number）
            if (count >= FLOOR)
                return [];
            return [finding(this, 'structural', f.path, declLine, `MUTATING_TOOLS = new Set([ … ${count} entries ])`, `pre-dispatch audit WAL covers only ${count} mutating tools — below the W6R-A9 floor of ${FLOOR}; any dropped tool dispatches without an audit trail`, `Re-add the dropped mutating tools — physical action family, host-pipeline-bypassing batches, and filesystem-write family (W6R-A9 annotation in auditGuard.ts).`)];
        },
    },
];
