// src/tools/skillTools.ts
// 第五轮创新的工具面：技能的写 / 查 / 用三件套。
//   save_skill  — 手动把日志片段固化为技能（自动归纳之外的补充入口）
//   match_skill — 新任务先查库：可靠度加权匹配，命中即省去全程探索
//   run_skill   — 一键执行技能；成败回写可靠度（越用越准的闭环）
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Config } from '../config';
// J 纪元修正：类型改 type-only 导入 —— Node strip-only 运行时下
// `import { Skill }`（接口按值导入）会抛 "does not provide an export named 'Skill'"
import { skillLibrary, type SkillStep, type Skill } from '../skillLibrary';
import { failureMemory } from '../failureMemory';
import { journal } from '../journal';
import { replayOne } from './replayActions';
import * as backend from '../physicalBackend';
import { normalizeHash, similarity } from '../perceptualHash';

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
        const ci = Array.isArray((s as any).ci95) ? ` ci95=[${(s as any).ci95[0]},${(s as any).ci95[1]}]` : '';
        // G-5 多目标透明：非支配候选标注（没有别的候选在相关×可靠×新近全轴更优）
        const pareto = (s as any).pareto_optimal ? ' [Pareto-optimal]' : '';
        const preview = s.steps.slice(0, 5).map((st, i) =>
          `    ${i + 1}. ${st.tool} ${JSON.stringify(st.args).slice(0, 80)}`).join('\n');
        const more = s.steps.length > 5 ? `\n    ... (+${s.steps.length - 5} more)` : '';
        return `- #${s.id} "${s.name}" reliability=${reliability}%${ci} score=${s.score ?? '-'}${via}${pareto}${synthTag}\n` +
          `  does: ${s.description}\n${preview}${more}`;
      });

      // 负向对照：技能命中但同场景存在失败记忆时，显式标注技能步骤中的已知死路段
      let antiSection = '';
      if (antiHits.length > 0) {
        const anti = antiHits.map(a => `- "${a.approach}" failed with: ${a.symptom}`).join('\n');
        antiSection = `\n[Known failures in this context] (do NOT repeat):\n${anti}`;
      }

      return `[System]: ${hits.length} matching skill(s):\n${lines.join('\n')}${antiSection}\n` +
        `[Next Step]: If a skill fits, call run_skill with confirm=true (verify with take_screenshot afterwards). ` +
        `Otherwise execute manually — skills are priors, not guarantees (UIs change).`;
    },
  });
}

export function createRunSkillTool(config: Config) {
  return defineTool({
    name: 'run_skill',
    description:
      'Executes a saved skill step-by-step. Skills encode previously verified action sequences. ' +
      'The outcome updates the skill reliability automatically. Requires confirm=true.',
    parameters: {
      id: { type: 'number', required: true, description: 'Skill ID from match_skill.' },
      confirm: { type: 'boolean', required: true, description: 'Must be explicitly true to execute.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const skill = skillLibrary.get(args.id);
      if (!skill) return `[Error]: Skill #${args.id} not found. Call match_skill to list available skills.`;

      if (args.confirm !== true) {
        return JSON.stringify({
          status: 'ACTION_REQUIRED',
          state_anchor: {
            skill: `#${skill.id} "${skill.name}"`,
            steps: skill.steps.length,
            does: skill.description,
          },
          next_step: 'Review the skill steps via match_skill, then call run_skill with confirm=true to execute.',
        }, null, 2);
      }
      if (skill.steps.length > config.replayMaxSteps) {
        return `[Error]: Skill has ${skill.steps.length} steps, exceeding replayMaxSteps (${config.replayMaxSteps}).`;
      }

      const log: string[] = [];
      let failed = 0;
      for (const step of skill.steps) {
        const line = await replayOne(step);
        if (line.startsWith('FAILED') || line.startsWith('SKIPPED')) failed++;
        log.push(`  ${step.tool}: ${line}`);
        await sleep(150);
      }

      const success = failed === 0;

      // ── Y-7 后置条件验收：终态指纹 vs 离场指纹 ──
      let post: PostconditionVerdict = { verified: false, similarity: null, reason: 'hash-unavailable' };
      try {
        const cap = await backend.captureProcessed({ metaOnly: true, wantHashes: true });
        post = judgePostcondition((skill as any).exitFingerprint, cap.dhash ?? null);
      } catch { /* 指纹不可得：reason 已是 hash-unavailable */ }

      // 回写策略：verified 成功才入 successCount（世界盖戳）；未验证只记尝试
      if (success && post.verified) {
        skillLibrary.recordOutcome(skill.id, true);
      } else if (success) {
        skillLibrary.recordOutcome(skill.id, false);
      } else {
        skillLibrary.recordOutcome(skill.id, false);
      }

      return JSON.stringify({
        status: success ? (post.verified ? 'SUCCESS' : 'SUCCESS_UNVERIFIED') : 'PARTIAL_FAILURE',
        state_anchor: {
          skill: `#${skill.id} "${skill.name}"`,
          steps_total: skill.steps.length,
          steps_failed: failed,
          reliability_now: `${skill.successCount}/${skill.attemptCount}`,
          postcondition: {
            verified: post.verified,
            final_scene_similarity: post.similarity,
            reason: post.reason,
            note: post.verified
              ? 'final scene matches the exit fingerprint recorded at skill-creation time'
              : 'reliability NOT credited — the final scene diverges from the recorded exit state (UI may have changed, or the macro ran in a different context)',
          },
        },
        execution_log: log.join('\n'),
        next_step: success
          ? "MANDATORY: Call 'take_screenshot' to verify the final state matches the skill's intent."
          : `${failed} step(s) failed — the UI may have changed since this skill was learned. ` +
            'Verify with take_screenshot, fix manually, and save_skill to update the library.',
      }, null, 2);
    },
  });
}
