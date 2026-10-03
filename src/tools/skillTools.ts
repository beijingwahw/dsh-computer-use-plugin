// src/tools/skillTools.ts
// 第五轮创新的工具面：技能的写 / 查 / 用三件套。
//   save_skill  — 手动把日志片段固化为技能（自动归纳之外的补充入口）
//   match_skill — 新任务先查库：可靠度加权匹配，命中即省去全程探索
//   run_skill   — 一键执行技能；成败回写可靠度（越用越准的闭环）
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Config } from '../config';
// J 纪元修正：类型改 type-only 导入 —— Node strip-only 运行时下
// `import { Skill }`（接口按值导入）会抛 "does not provide an export named 'Skill'"
import { skillLibrary, betaReliability, type SkillStep, type Skill } from '../skillLibrary';
// W4-1（A1）：宏执行面 —— 排练门禁 + 宏链解析（run_skill 的升级原料）
import { resolveMacroChain, type MacroResolveResult } from '../macroExecutor';
import { sharedMacroRehearsalGate, MACRO_REHEARSAL_GATE } from '../sandbox/macroRehearsal';
import { failureMemory } from '../failureMemory';
import { journal } from '../journal';
import { replayOne } from './replayActions';
import * as backend from '../physicalBackend';
import { normalizeHash, similarity } from '../perceptualHash';
// W5-0（A/B 接线）：排练场景的记忆元素面 + 技能联邦本地命中记账
import { uiMemory } from '../uiMemory';
import { skillFederation, skillFingerprintOf, type SkillDigestRecord } from '../skillFederation';

// ─── Y-7 技能后置条件（Epoch Y：可靠度回写从「Actor 说了算」到「场景作证」）───
//
// 数学：技能归纳时记录离场指纹 H_exit（终态世界的 dhash）；run_skill 完毕
// 取当前指纹 H_now，verified ⇔ sim(H_exit, H_now) ≥ τ（UI 含时钟等微变，
// dhash 对此鲁棒故阈值取 0.75 而非 0.95）。回写策略：仅 verified 的成功
// 记 successCount；未验证的成功只记 attemptCount 并在锚点声明「未经场景
// 作证」—— 技能的可靠度从此是世界盖戳的量，不是自我报告的量。

export const POSTCONDITION_THRESHOLD = 0.75;

export interface PostconditionVerdict {
  verified: boolean;
  similarity: number | null;
  reason: 'verified' | 'below-threshold' | 'no-exit-fingerprint' | 'hash-unavailable';
}

export function judgePostcondition(
  exitHash: string | null | undefined,
  currentHash: string | null,
  threshold: number = POSTCONDITION_THRESHOLD,
): PostconditionVerdict {
  if (!exitHash) return { verified: false, similarity: null, reason: 'no-exit-fingerprint' };
  if (!currentHash) return { verified: false, similarity: null, reason: 'hash-unavailable' };
  const sim = similarity(normalizeHash(exitHash), normalizeHash(currentHash));
  return sim >= threshold
    ? { verified: true, similarity: Math.round(sim * 1000) / 1000, reason: 'verified' }
    : { verified: false, similarity: Math.round(sim * 1000) / 1000, reason: 'below-threshold' };
}
import { sleep } from '../actionVerifier';
import { contextManager } from '../contextManager';

// ─── W5-0（A 接线 · W4-1 A1）：run_skill 排练场景源 —— 记忆元素面铸造 ───
//
// 工具层此前无帧元素清单（scene: undefined ⇒ 低可靠宏诚实拒绝）。本原语把
// 场景证据接通：uiMemory 的 landmark 是「验证生效过的真实控件位」（autoRemember
// 只在 effect.detected 时 remember —— 记忆即世界盖过戳的元素面）；contextManager
// 的场景指纹（lastImageRecord().hash）作 recall 的场景加成源（gaze/注视经济同源
// 的语境物料）。landmark 是点 ⇒ 铸控件级小窗（±0.04 夹 [0,1]）。零记忆 ⇒
// undefined（诚实缺席，与接线前逐字节一致）；一切面绝不抛（旁路义务）。
const REHEARSAL_LANDMARK_HALFBOX = 0.04;

/** W5-0（A）：排练场景铸造（uiMemory 元素面 + contextManager 场景指纹加成） */
function rehearsalSceneFromMemory(query: string): ReadonlyArray<{
  label: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}> | undefined {
  try {
    const sceneHash = contextManager.lastImageRecord()?.hash;
    const hits = uiMemory.recall(query, 8, sceneHash);
    if (!Array.isArray(hits) || hits.length === 0) return undefined;
    const r = REHEARSAL_LANDMARK_HALFBOX;
    const clamp01 = (v: number): number => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.5));
    return hits
      .filter(lm => lm && typeof lm.description === 'string' && lm.description.trim() !== ''
        && lm.normalized && Number.isFinite(lm.normalized.x) && Number.isFinite(lm.normalized.y))
      .map(lm => {
        const x = clamp01(lm.normalized.x), y = clamp01(lm.normalized.y);
        return {
          label: lm.description.slice(0, 64),
          bbox: { x0: clamp01(x - r), y0: clamp01(y - r), x1: clamp01(x + r), y1: clamp01(y + r) },
        };
      });
  } catch {
    return undefined; // 记忆面故障 = 场景缺席（低可靠宏照旧诚实拒绝）
  }
}

// ─── W5-0（B 接线 · W4-2 G3）：本地技能匹配命中 ⇒ 联邦 dormant 激活记账 ───
//
// 注入三律之三的最小挂点：match_skill 命中本地技能时，按上传侧同一指纹式
// （skillFingerprintOf(sceneFingerprint, stepsDigest)——listSkillDigests 的摘要律
// 与 buildSkillUploads 同键）回调 skillFederation.noteLocalHit。未知指纹的命中
// 诚实忽略（联邦候选缺席 ⇒ no-op）；纯记账零行为面 —— 不改召回、不改排序、
// 绝不炸匹配主流程。命中 2 次激活（SKILL_ACTIVATE_LOCAL_HITS）由联邦自身执法。
function noteFederationLocalHits(hits: Array<{ name?: unknown }>): void {
  try {
    if (!Array.isArray(hits) || hits.length === 0) return;
    const digests: SkillDigestRecord[] = skillLibrary.listSkillDigests();
    if (!Array.isArray(digests) || digests.length === 0) return;
    for (const h of hits) {
      const name = typeof h?.name === 'string' ? h.name : undefined;
      if (name === undefined) continue;
      const d = digests.find(x => x && x.skillId === name);
      if (!d) continue;
      skillFederation.noteLocalHit(skillFingerprintOf(d.sceneFingerprint, d.stepsDigest));
    }
  } catch { /* 联邦记账是旁路义务：失败绝不炸匹配主流程 */ }
}

export function createSaveSkillTool() {
  return defineTool({
    name: 'save_skill',
    description:
      'Saves a recent successful action sequence (from the journal) as a reusable named skill. ' +
      'Call this after completing a workflow that may be needed again later.',
    parameters: {
      description: {
        type: 'string', required: true,
        description: 'What task does this skill accomplish? Used for matching future requests (e.g., "打开 GitHub 并搜索仓库").',
      },
      from_step: { type: 'number', description: '0-based start index in the journal. Default: start of the current task.' },
      to_step: { type: 'number', description: '0-based end index (inclusive). Default: latest.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      // from_step 钳制下界（与 replayActions 同律）：负数经 slice 语义变成「从尾部倒数」，
      // 会把非预期区段铸成技能；to_step 同律补下界（J 纪元 —— 见 replayActions 注）
      const from = Math.max(0, args.from_step ?? 0);
      const all = journal.list();
      const to = Math.max(from, Math.min(all.length - 1, args.to_step ?? all.length - 1));
      // 过滤不可重放工具：click_element 依赖运行时缓存；dismiss_popup 是模型侧
      // 恢复指令（无机械动作）—— 留在宏里只会让 run_skill 误记失败
      const steps: SkillStep[] = all.slice(from, to + 1)
        .filter(e => e.tool !== 'click_element' && e.tool !== 'dismiss_popup')
        .map(e => ({ tool: e.tool, args: e.args ?? {} }));

      if (steps.length === 0) {
        return `[Error]: No replayable actions in range [${from}, ${to}].`;
      }

      const skill = skillLibrary.induce(args.description, steps, contextManager.lastImageRecord()?.hash);
      if (!skill) {
        return `[Error]: Skill library is disabled (enableSkillLibrary=false).`;
      }
      // Y-7 后置条件：离场指纹随卡入库（run_skill 的世界级验收基准）
      let exitNote = '';
      try {
        const cap = await backend.captureProcessed({ metaOnly: true, wantHashes: true });
        if (cap.dhash) {
          (skill as any).exitFingerprint = cap.dhash;
          exitNote = ' [exit fingerprint recorded]';
        }
      } catch { exitNote = ''; }
      const dup = skill.successCount > 1 ? ' (existing skill reinforced)' : '';
      return `[System]: Skill #${skill.id} "${skill.name}" saved with ${skill.steps.length} step(s)${dup}. ` +
        `Reliability ${skill.successCount}/${skill.attemptCount}.${exitNote} Reuse via match_skill + run_skill.`;
    },
  });
}

export function createMatchSkillTool(config: Config) {
  return defineTool({
    name: 'match_skill',
    description:
      'Searches the skill library for previously learned workflows matching a task description ' +
      '(exact-token OR semantic-vector match), and surfaces known FAILED approaches from failure memory. ' +
      'When nothing matches, skill DNA recombination may synthesize a new skill from gene segments of related ones. ' +
      'Call this BEFORE planning a complex task.',
    parameters: {
      query: {
        type: 'string', required: true,
        description: 'The task you are about to perform, in natural language.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const currentScene = contextManager.lastImageRecord()?.hash;
      // 双记忆对照检索：正向技能（什么有效） + 负向失败（什么无效）同时召回
      const query = args.query || journal.currentTask();
      const hits = skillLibrary.match(query, currentScene, 3);
      const antiHits = failureMemory.match(query, currentScene, 3);

      // C-2 DNA 重组：无命中技能时尝试基因拼接合成（想象力的工具面）
      let synthNote = '';
      if (hits.length === 0 && config.enableRecombination && config.enableSkillLibrary) {
        const { skill, plan } = skillLibrary.recombine(query, currentScene);
        if (skill) {
          const lineage = plan.map(p => `#${p.skillId} (${p.reason})`).join(' + ');
          synthNote = `\n[Synthesized]: No exact skill matched, so gene segments were recombined into new skill ` +
            `#${skill.id} "${skill.name}" (${skill.steps.length} steps, lineage: ${lineage}). ` +
            `It starts unverified (0/0) — run it with confirm=true and the outcome will calibrate its reliability.`;
          hits.push(skill as Skill & { score: number });
        }
      }

      if (hits.length === 0) {
        // F-1 文法归纳前馈：无技能命中时，从行动日志挖「重复着自己却未被固化」的序列
        // （SEQUITUR：能被短文法压缩的行为就是结构 —— 结构就是技能的胚胎）
        let motifNote = '';
        if (config.enableSkillLibrary) {
          const motifs = skillLibrary.mineMotifs();
          if (motifs.length > 0) {
            const top = motifs.map(m =>
              `- [${m.steps.length} steps × ${m.usage} times] ${m.steps.slice(0, 4).map(s => s.tool).join(' → ')}` +
              `${m.steps.length > 4 ? ' → …' : ''}`).join('\n');
            motifNote = `\n[Recurring motifs in your own journal (grammar-induced)]:\n${top}\n` +
              `These sequences repeat but are not yet skills — call save_skill to crystallize one.`;
          }
        }
        if (antiHits.length > 0) {
          const anti = antiHits.map(a => `- tried "${a.approach}" -> ${a.symptom} (score=${a.score})`).join('\n');
          return `[System]: No matching skills, but ${antiHits.length} known FAILED approach(es) for this context:\n` +
            `${anti}\n[Next Step]: Avoid repeating the above. The normal explore-act-verify loop still applies — ` +
            `try a different modality or route from the start.${motifNote}`;
        }
        return `[System]: No matching skills. Proceed with the normal explore-act-verify loop; ` +
          `consider save_skill afterwards if this workflow is worth remembering.${motifNote}`;
      }
      const lines = hits.map(s => {
        const reliability = s.attemptCount > 0 ? Math.round((s.successCount / s.attemptCount) * 100) : 0;
        const via = (s as any).matched_via ? ` via=${(s as any).matched_via}` : '';
        const synthTag = (s as any).synthesized ? ' [synthesized, unverified]' : '';
        // E-5 透明面：可靠度附 95% 可信区间 —— 「67%±46%」与「67%±9%」是两种决策依据
        const ci = Array.isArray((s as any).ci95) ? ` ci95=[${(s as any).ci95[0]}, ${(s as any).ci95[1]}]` : '';
        // G-5 多目标透明：非支配候选标注（没有别的候选在相关×可靠×新近全轴更优）
        const pareto = (s as any).pareto_optimal ? ' [Pareto-optimal]' : '';
        const preview = s.steps.slice(0, 5).map((st, i) =>
          `    ${i + 1}. ${st.tool} ${JSON.stringify(st.args).slice(0, 80)}`).join('\n');
        const more = s.steps.length > 5 ? `\n    ... (+${s.steps.length - 5} more)` : '';
        return `- #${s.id} "${s.name}" reliability=${reliability}%${ci} score=${s.score ?? '-'}${via}${pareto}${synthTag}\n` +
          `  does: ${s.description}\n${preview}${more}`;
      });

      // W5-0（B 接线 · W4-2 G3）：本地匹配命中 ⇒ 联邦 dormant 激活记账
      //（上传/激活同键指纹；未知指纹 no-op；纯旁路绝不炸匹配）
      noteFederationLocalHits(hits);

      // W4-1（A1）：matchTemplates 召回附段 —— 参数化模板与字面量技能并列呈现，
      // 两套召回并行模型自选（模板是泛化形态；执行经 run_skill 的 template_id 路径，
      // 洞由当前世界读取绑定，绑定失败自动回退母体技能 —— W3-2 语义）
      let templateSection = '';
      if (config.enableSkillLibrary) {
        try {
          const tplHits = skillLibrary.matchTemplates({ sceneHash: currentScene ?? undefined, k: 3 });
          if (tplHits.length > 0) {
            const tplLines = tplHits.map(t => {
              const rel = t.attemptCount > 0
                ? Math.round((t.successCount / t.attemptCount) * 100) : 0;
              const parents = Array.isArray(t.parents) ? ` parents=${t.parents.join(',')}` : '';
              const holes = t.steps
                .flatMap(st => Object.entries(st.args))
                .filter(([, slot]) => (slot as any)?.kind === 'hole')
                .map(([key, slot]) => `${key}<${(slot as any).type}:${(slot as any).source}>`)
                .slice(0, 6);
              return `- ${t.name} (template_id=${t.id}) holes=${t.holes}${parents} reliability=${rel}% via=${t.matched_via} score=${t.score}\n` +
                `  does: ${t.description}\n` +
                `  parameter slots: ${holes.length > 0 ? holes.join(', ') : '(none listed)'}`;
            });
            templateSection = `\n[Parameterized templates (generalized skills — holes bound at runtime)]:\n${tplLines.join('\n')}\n` +
              `Execute with run_skill template_id=<id> (bind failure falls back to parent literal skill).`;
          }
        } catch { /* 模板召回是增益不是依赖 —— 失败静默（既有输出零变化） */ }
      }

      // 负向对照：技能命中但同场景存在失败记忆时，显式标注技能步骤中的已知死路段
      let antiSection = '';
      if (antiHits.length > 0) {
        const anti = antiHits.map(a => `- "${a.approach}" failed with: ${a.symptom}`).join('\n');
        antiSection = `\n[Known failures in this context] (do NOT repeat):\n${anti}`;
      }

      return `[System]: ${hits.length} matching skill(s):\n${lines.join('\n')}${templateSection}${antiSection}\n` +
        `[Next Step]: If a skill fits, call run_skill with confirm=true (verify with take_screenshot afterwards). ` +
        `Otherwise execute manually — skills are priors, not guarantees (UIs change).`;
    },
  });
}

/**
 * W4-1（A1）：run_skill 的宏轨迹摘要 —— 宏解析 + 排练门禁判词的工具结果形态
 * （Token 纪律：紧凑判词，全量证据在 execution_log）。
 */
function macroGateTrace(
  resolved: MacroResolveResult,
  gate: { required: boolean; verdict: string; allowed: boolean; note: string; muscleEntryId?: string },
): Record<string, unknown> {
  const source = resolved.ok
    ? { kind: resolved.source.kind, id: resolved.source.id, name: resolved.source.name }
    : null;
  return {
    resolved: resolved.ok,
    ...(source ? { source } : {
      resolve_error: `${(resolved as { reason: string }).reason}: ${(resolved as { detail: string }).detail}`,
    }),
    rehearsal_gate: {
      required: gate.required,
      verdict: gate.verdict,
      allowed: gate.allowed,
      ...(gate.muscleEntryId ? { muscle_entry: gate.muscleEntryId } : {}),
      note: gate.note,
    },
    ...(resolved.ok && resolved.fallbackReason ? { fallback_reason: resolved.fallbackReason } : {}),
  };
}

export function createRunSkillTool(config: Config) {
  return defineTool({
    name: 'run_skill',
    description:
      'Executes a saved skill step-by-step. Skills encode previously verified action sequences. ' +
      'The outcome updates the skill reliability automatically. Requires confirm=true. ' +
      'W4-1: template_id executes a parameterized template (holes bound at runtime; bind failure falls back ' +
      'to the parent literal skill); low-reliability skills and template products must first pass a sandbox ' +
      'virtual rehearsal gate before host dispatch.',
    parameters: {
      id: { type: 'number', description: 'Skill ID from match_skill (omit when using template_id).' },
      template_id: { type: 'number', description: 'W4-1: Parameterized template ID from match_skill (hole binding; falls back to parent skill on failure).' },
      confirm: { type: 'boolean', required: true, description: 'Must be explicitly true to execute.' },
      text: { type: 'string', description: 'W4-1: Parameterized text argument — overrides type_text steps and binds string holes.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      // W4-1（A1）：宏解析先行 —— skillId 直取 / templateId 绑洞（text 参数作
      // string 洞的绑定源与 type_text 槽覆盖；绑定失败回退母体字面量技能）
      const textParam = typeof args.text === 'string' && args.text !== '' ? args.text : undefined;
      const resolved = resolveMacroChain({
        ...(typeof args.id === 'number' ? { skillId: args.id } : {}),
        ...(typeof args.template_id === 'number' ? { templateId: args.template_id } : {}),
        ...(textParam !== undefined
          ? { args: { text: textParam }, holeReader: (req): unknown => (req.type === 'string' ? textParam : undefined) }
          : {}),
      });
      if (!resolved.ok) {
        return `[Error]: Macro resolution failed (${resolved.reason}): ${resolved.detail}`;
      }
      const skill = resolved.source.kind === 'template'
        ? null
        : skillLibrary.get(resolved.source.id);
      if (resolved.source.kind !== 'template' && !skill) {
        return `[Error]: Skill #${args.id} not found. Call match_skill to list available skills.`;
      }

      if (args.confirm !== true) {
        const anchorSkill = skill ?? {
          id: resolved.source.id, name: resolved.source.name,
          steps: resolved.steps.length,
          description: skillLibrary.getTemplate(resolved.source.id)?.description ?? '(template)',
        };
        return JSON.stringify({
          status: 'ACTION_REQUIRED',
          state_anchor: {
            skill: `#${anchorSkill.id} "${anchorSkill.name}"`,
            steps: anchorSkill.steps,
            does: anchorSkill.description,
          },
          macro_trace: macroGateTrace(resolved, {
            required: false, verdict: 'not-required', allowed: true,
            note: '待确认（confirm=false）—— 门禁尚未评估',
          }),
          next_step: 'Review the skill steps via match_skill, then call run_skill with confirm=true to execute.',
        }, null, 2);
      }
      if (resolved.steps.length > config.replayMaxSteps) {
        return `[Error]: Skill has ${resolved.steps.length} steps, exceeding replayMaxSteps (${config.replayMaxSteps}).`;
      }

      // ── W4-1（A1）：排练门禁 —— 可靠度 < 0.5 的技能 / 模板绑定产物必须先在
      //    sandbox MuscleMemoryStore 虚拟排练通过才许宿主派发（同律于 runtime
      //    的 macro case）。工具层无当前帧元素清单 ⇒ 场景缺席 ⇒ 低可靠宏诚实
      //    拒绝（防御式：低可靠 + 零世界证据不放行）。
      const reliability = resolved.source.kind === 'template'
        ? betaReliability(
          skillLibrary.getTemplate(resolved.source.id)?.successCount ?? 0,
          skillLibrary.getTemplate(resolved.source.id)?.attemptCount ?? 0).mean
        : betaReliability(skill!.successCount, skill!.attemptCount).mean;
      const gateVerdict = sharedMacroRehearsalGate.gate({
        reliability,
        steps: resolved.steps,
        // W5-0（A 接线 · W4-1 A1）：排练场景源接通 —— uiMemory 元素面
        //（验证生效过的真实控件位）+ contextManager 场景指纹加成。低可靠度
        // 技能从此可在本机记忆证据上虚拟排练（verdict 'passed' 入肌肉记忆），
        // 而非场景缺席的诚实拒绝；零记忆 ⇒ undefined（旧路径逐字节不变）。
        scene: rehearsalSceneFromMemory(
          `${resolved.source.name} ${skill?.description ?? ''}`.trim()),
        forceRehearsal: resolved.source.kind === 'template',
        trigger: `run_skill ${resolved.source.kind}#${resolved.source.id}`,
      });
      if (!gateVerdict.allowed) {
        return JSON.stringify({
          status: 'REHEARSAL_GATE_REJECTED',
          state_anchor: {
            skill: `#${resolved.source.id} "${resolved.source.name}"`,
            reliability: Math.round(reliability * 1000) / 1000,
            gate_threshold: MACRO_REHEARSAL_GATE,
          },
          macro_trace: macroGateTrace(resolved, gateVerdict),
          execution_log: '',
          next_step: `Skill blocked by the sandbox rehearsal gate (${gateVerdict.note}). ` +
            'Run the workflow manually once to raise its reliability, or rehearse it in the sandbox first.',
        }, null, 2);
      }

      const log: string[] = [];
      let failed = 0;
      for (const step of resolved.steps) {
        // Δ 纪元（审计#1）：重放步与 live 工具同闸门 —— 危险步无有效令牌即失败
        const line = await replayOne(step, config);
        if (line.startsWith('FAILED') || line.startsWith('SKIPPED')) failed++;
        log.push(`  ${step.tool}: ${line}`);
        await sleep(150);
      }

      const success = failed === 0;

      // ── Y-7 后置条件验收：终态指纹 vs 离场指纹 ──
      let post: PostconditionVerdict = { verified: false, similarity: null, reason: 'hash-unavailable' };
      try {
        const cap = await backend.captureProcessed({ metaOnly: true, wantHashes: true });
        post = judgePostcondition((skill as any)?.exitFingerprint, cap.dhash ?? null);
      } catch { /* 指纹不可得：reason 已是 hash-unavailable */ }

      // 回写策略：verified 成功才入 successCount（世界盖戳）；未验证只记尝试。
      // 模板产物 ⇒ recordTemplateOutcome（模板自己的账本 —— W3-2 同律）
      if (resolved.source.kind === 'template') {
        skillLibrary.recordTemplateOutcome(resolved.source.id, success && post.verified);
      } else if (success && post.verified) {
        skillLibrary.recordOutcome(skill!.id, true);
      } else {
        skillLibrary.recordOutcome(skill!.id, false);
      }

      return JSON.stringify({
        status: success ? (post.verified ? 'SUCCESS' : 'SUCCESS_UNVERIFIED') : 'PARTIAL_FAILURE',
        state_anchor: {
          skill: `#${resolved.source.id} "${resolved.source.name}"`,
          steps_total: resolved.steps.length,
          steps_failed: failed,
          reliability_now: skill
            ? `${skill.successCount}/${skill.attemptCount}`
            : `${skillLibrary.getTemplate(resolved.source.id)?.successCount ?? 0}/${skillLibrary.getTemplate(resolved.source.id)?.attemptCount ?? 0} (template)`,
          postcondition: {
            verified: post.verified,
            final_scene_similarity: post.similarity,
            reason: post.reason,
            note: post.verified
              ? 'final scene matches the exit fingerprint recorded at skill-creation time'
              : 'reliability NOT credited — the final scene diverges from the recorded exit state (UI may have changed, or the macro ran in a different context)',
          },
        },
        macro_trace: macroGateTrace(resolved, gateVerdict),
        execution_log: log.join('\n'),
        next_step: success
          ? "MANDATORY: Call 'take_screenshot' to verify the final state matches the skill's intent."
          : `${failed} step(s) failed — the UI may have changed since this skill was learned. ` +
            'Verify with take_screenshot, fix manually, and save_skill to update the library.',
      }, null, 2);
    },
  });
}
