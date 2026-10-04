// test/w3skill.test.ts
// W3-2 执法册：旗舰 M2「参数化通用技能（反统一）」+ sleep 第二批两接线。
//
//   M2-1 DTW 对齐正确性（手算小例：缺口/全同/异工具三态 + 平局裁决确定性）；
//   M2-2 反统一：同值 → 常量、同型异值 → 洞（类型标注 + 来源提示）；
//   M2-3 抗过拟合门：单母体永不产模板 / 双母体过门产模板 / Beta 门数值
//        （s=2,f=1 ⇒ 0.6 < 0.75 拒）/ 对齐代价门 / 零洞拒绝 / 结构分歧弃步；
//   M2-4 运行时绑定：成功（洞读值+类型闸+常量回放）/ 失败两路
//        （reader 缺席值 / 类型不符 / 抛错 / not-found）+ 回退字面量零损失；
//   M2-5 字面量技能零回归：match() 蒸馏前后逐位一致 / induce 去重原律；
//   M2-6 持久化接缝：模板段落盘往返 + dump/restore + 骨架去重幂等；
//   S-1 sleep 接线①：approvalQueue 晨报清单（在场/缺席/noop 不携带/落盘行）；
//   S-2 sleep 接线②：memoryOpsConverger 校准旁挂并入晨报（在场/缺席零行为
//        变化/故障吸收/垃圾报告净化）+ 蒸馏幕 distillTemplates 旁挂计数。
// 全程离线、注入时钟、纯符号确定性（零真钟零网络零 LLM）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  skillLibrary,
  dtwAlignTools, hashSkeleton, holeTypeOf, inferHoleSource, antiUnifyPair, valueMatchesHoleType,
  TEMPLATE_MIN_PARENTS, TEMPLATE_MIN_HOMOLOGS, TEMPLATE_MAX_ALIGN_COST_RATIO, TEMPLATE_HOLE_POSTERIOR_GATE,
  type SkillStep,
} from '../src/skillLibrary.ts';
import {
  runSleepCycle, resetSleepCycle,
  type SleepDeps, type MorningApprovalQueueSummary,
} from '../src/sleep/index.ts';
import type { MemoryOpsConvergenceReport } from '../src/knowledge/memoryOps.ts';
import type { JournalEntry } from '../src/journal.ts';

// ─── 共用铸模 ───

/** 每测前清库：内存库（filePath='' ⇒ save 零落盘 —— 测试离线确定性） */
beforeEach(() => {
  skillLibrary.configure(true, '', 50);
  skillLibrary.reset();
});

const click = (x: number, y: number): SkillStep => ({ tool: 'click_mouse', args: { x, y } });
const typeText = (text: string): SkillStep => ({ tool: 'type_text', args: { text } });

// ─── M2-1：DTW 对齐正确性（手算小例） ───

test('M2-1: DTW 对齐 —— 手算小例：一个缺口代价 1、路径确定、平局裁决 diag 优先', () => {
  // 手算：a=[click,type,click] vs b=[click,type,scroll,click]
  // 最优对齐：c-c(0) t-t(0) [scroll=缺口(1)] c-c(0) ⇒ cost=1
  const r = dtwAlignTools(['click_mouse', 'type_text', 'click_mouse'],
    ['click_mouse', 'type_text', 'scroll_page', 'click_mouse']);
  assert.equal(r.cost, 1, '唯一缺口贡献代价 1');
  assert.deepEqual(r.pairs, [[0, 0], [1, 1], [-1, 2], [2, 3]], '缺口列 j=-1，回溯路径逐位确定');

  // 全同序列：零代价、纯对角
  const same = dtwAlignTools(['a', 'b', 'a'], ['a', 'b', 'a']);
  assert.equal(same.cost, 0);
  assert.deepEqual(same.pairs, [[0, 0], [1, 1], [2, 2]]);

  // 单步异工具：diag 代价 1 < 双缺口代价 2 ⇒ 对角（平局裁决的对照面）
  const mismatch = dtwAlignTools(['click_mouse'], ['type_text']);
  assert.equal(mismatch.cost, 1);
  assert.deepEqual(mismatch.pairs, [[0, 0]], '代价 1 的对角胜过代价 2 的双缺口');

  // 骨架哈希：同工具序列同哈希、异序列异哈希（匹配粗筛键的稳定性）
  assert.equal(hashSkeleton(['click_mouse', 'type_text', 'click_mouse']),
    hashSkeleton(['click_mouse', 'type_text', 'click_mouse']));
  assert.notEqual(hashSkeleton(['click_mouse', 'type_text']),
    hashSkeleton(['type_text', 'click_mouse']));
});

// ─── M2-2：反统一 —— 同值→常量、异值→洞（类型 + 来源标注） ───

test('M2-2: 同值→常量、同型异值→洞；类型标注与来源提示纯符号推断', () => {
  // 类型标注原子（holeTypeOf）
  assert.equal(holeTypeOf(0.5), 'number');
  assert.equal(holeTypeOf('userA'), 'string');
  assert.equal(holeTypeOf(true), 'boolean');
  assert.equal(holeTypeOf({ a: 1 }), 'json');

  // 来源提示原子（inferHoleSource —— 键形+类型的确定性路由）
  assert.equal(inferHoleSource('x', 'number'), 'coordinate');
  assert.equal(inferHoleSource('from_x', 'number'), 'coordinate');
  assert.equal(inferHoleSource('text', 'string'), 'ocr');
  assert.equal(inferHoleSource('url', 'string'), 'clipboard');
  assert.equal(inferHoleSource('target_description', 'string'), 'ocr');
  assert.equal(inferHoleSource('mode', 'boolean'), 'user-input', '无从路由 ⇒ 问用户');

  // 库级蒸馏：双母体（text 异值 → 洞；x/y 同值 → 常量）
  const s1 = skillLibrary.induce('登录门户并导出报表', [click(0.5, 0.5), typeText('userA'), click(0.9, 0.1)]);
  const s2 = skillLibrary.induce('登录门户并导出报表', [click(0.5, 0.5), typeText('userB'), click(0.9, 0.1)]);
  assert.ok(s1 && s2 && s1.id !== s2.id, '异签名 ⇒ 两张卡');
  const { created, rejected } = skillLibrary.distillTemplates();
  assert.equal(created.length, 1, `双母体过门 ⇒ 恰一模板（rejected=${JSON.stringify(rejected)}）`);
  const tpl = created[0];
  assert.equal(tpl.holes, 1);
  assert.equal(tpl.steps.length, 3);
  assert.deepEqual(tpl.parents, [s1.id, s2.id], '支撑母体 = 双母体（库序）');
  assert.equal(tpl.skeletonHash, hashSkeleton(['click_mouse', 'type_text', 'click_mouse']));
  assert.equal(tpl.alignment.cost, 0, '全同骨架零对齐代价');
  assert.equal(tpl.alignment.homologs, 3);
  // 常量槽：逐字面保留
  assert.deepEqual(tpl.steps[0].args.x, { kind: 'const', value: 0.5 });
  assert.deepEqual(tpl.steps[0].args.y, { kind: 'const', value: 0.5 });
  assert.deepEqual(tpl.steps[2].args.x, { kind: 'const', value: 0.9 });
  // 洞槽：类型 + 来源 + 双母体实值 + 跨母体后验
  const hole = tpl.steps[1].args.text;
  assert.equal(hole.kind, 'hole');
  if (hole.kind === 'hole') {
    assert.equal(hole.type, 'string');
    assert.equal(hole.source, 'ocr');
    assert.deepEqual(hole.bindings.map(b => b.value), ['userA', 'userB']);
    assert.deepEqual(hole.bindings.map(b => b.skillId), [s1.id, s2.id]);
    assert.equal(hole.posteriorMean, TEMPLATE_HOLE_POSTERIOR_GATE, '(2+1)/(2+0+2)=0.75 —— 恰过门');
    assert.equal(hole.bindAttempts, 0, '新模板未经历运行时绑定');
  }
});

// ─── M2-3：抗过拟合门 ───

test('M2-3a: 单母体永不产模板（无配对 ⇒ 零产出）', () => {
  skillLibrary.induce('单例工作流', [click(0.1, 0.2), typeText('only'), click(0.3, 0.4)]);
  const { created, rejected } = skillLibrary.distillTemplates();
  assert.equal(created.length, 0, '单母体（无技能对）⇒ 永不产模板');
  assert.equal(rejected.length, 0, '连配对都不存在 —— 结构性拒绝先于一切门');
  assert.equal(TEMPLATE_MIN_PARENTS, 2, '门限常量在册：≥2 母体');
});

test('M2-3b: Beta 门数值 —— 同骨架第三母体缺洞键 ⇒ 后验 0.6 < 0.75 拒', () => {
  skillLibrary.induce('登录A', [click(0.5, 0.5), typeText('userA'), click(0.9, 0.1)]);
  skillLibrary.induce('登录B', [click(0.5, 0.5), typeText('userB'), click(0.9, 0.1)]);
  // 第三母体：同骨架但 text 键缺席 —— 该槽位在同族工作流上不守恒 ⇒ 反证
  skillLibrary.induce('登录C(无输入)', [click(0.5, 0.5), { tool: 'type_text', args: {} }, click(0.9, 0.1)]);
  const { created, rejected } = skillLibrary.distillTemplates();
  assert.equal(created.length, 0, '洞位过不了跨母体门 ⇒ 零模板');
  const gate = rejected.find(r => r.reason === 'hole-gate');
  assert.ok(gate, `hole-gate 拒绝判词在册（rejected=${JSON.stringify(rejected)}）`);
  // 手算：s=2（双母体绑定成功）、f=1（第三母体缺键）⇒ (2+1)/(2+1+2)=0.6
  assert.ok((gate?.detail ?? '').includes('0.6'), `判词携带手算后验 0.6：${gate?.detail}`);
  assert.ok(0.6 < TEMPLATE_HOLE_POSTERIOR_GATE, '0.6 < 0.75 —— 门的方向');
});

test('M2-3c: 对齐代价门 / 同源步门 / 零洞拒绝 / 异型弃步 —— 纯函数手算', () => {
  // 对齐代价门：全异工具同长 ⇒ ratio 1 > 0.35
  const alien = antiUnifyPair(
    { id: 1, steps: [click(0.1, 0.1), click(0.2, 0.2), click(0.3, 0.3)] },
    { id: 2, steps: [typeText('a'), typeText('b'), typeText('c')] },
  );
  assert.ok(!alien.ok && alien.reason === 'align-cost', '骨架全异 ⇒ align-cost');
  assert.equal(alien.alignment.costRatio, 1, '3 处错配 / max 长度 3 = 1');
  assert.equal(TEMPLATE_MAX_ALIGN_COST_RATIO, 0.35, '代价门限常量在册');

  // 同源步门：单步对（同工具）⇒ homologs 1 < 2
  const tiny = antiUnifyPair({ id: 1, steps: [click(0.1, 0.2)] }, { id: 2, steps: [click(0.3, 0.4)] });
  assert.ok(!tiny.ok && tiny.reason === 'insufficient-homologs', '单步对 ⇒ 同源步不足');
  assert.equal(TEMPLATE_MIN_HOMOLOGS, 2, '同源步门限常量在册');

  // 零洞拒绝：参数全同值 ⇒ 字面量重复，非泛化
  const identical = antiUnifyPair(
    { id: 1, steps: [click(0.5, 0.5), click(0.9, 0.1)] },
    { id: 2, steps: [click(0.5, 0.5), click(0.9, 0.1)] },
  );
  assert.ok(!identical.ok && identical.reason === 'no-holes', '全常量 ⇒ 不产冗余模板');

  // 异型弃步：text 'a' vs 123（string vs number）⇒ 该步结构分歧被弃置
  const divergent = antiUnifyPair(
    { id: 1, steps: [{ tool: 'type_text', args: { text: 'a' } }, click(0.5, 0.5), click(0.9, 0.9)] },
    { id: 2, steps: [{ tool: 'type_text', args: { text: 123 } }, click(0.5, 0.5), click(0.91, 0.9)] },
  );
  assert.ok(divergent.ok, '弃置分歧步后仍有 ≥2 同源步 + ≥1 洞');
  if (divergent.ok) {
    assert.equal(divergent.alignment.droppedSteps, 1, '异型步被弃置');
    assert.equal(divergent.steps.length, 2);
    assert.equal(divergent.steps.map(s => s.tool).join(','), 'click_mouse,click_mouse');
    assert.equal(divergent.holes, 1, '0.9 vs 0.91 ⇒ 数值坐标洞');
    assert.equal(divergent.steps[1].args.x.kind === 'hole' && divergent.steps[1].args.x.type === 'number'
      ? divergent.steps[1].args.x.source : '', 'coordinate', '坐标形数值洞 ⇒ 来源提示 coordinate');
  }
});

// ─── M2-4：运行时绑定 —— 成功 / 失败两路 / 回退零损失 ───

test('M2-4: 运行时绑定 —— 成功产出字面步骤；缺席值/类型不符/抛错/not-found 四路失败；回退字面量技能零损失', () => {
  const s1 = skillLibrary.induce('登录门户', [click(0.5, 0.5), typeText('userA'), click(0.9, 0.1)]);
  const s2 = skillLibrary.induce('登录门户', [click(0.5, 0.5), typeText('userB'), click(0.9, 0.1)]);
  const { created } = skillLibrary.distillTemplates();
  assert.equal(created.length, 1);
  const tplId = created[0].id;

  // 成功路：reader 按 (key/type/source) 路由回值 —— 洞绑定、常量逐字面回放
  const seen: unknown[] = [];
  const okBind = skillLibrary.bindTemplate(tplId, req => {
    seen.push({ ...req });
    return 'userC';
  });
  assert.ok(okBind.ok, '全洞绑定成功');
  if (okBind.ok) {
    assert.deepEqual(okBind.steps, [
      { tool: 'click_mouse', args: { x: 0.5, y: 0.5 } },
      { tool: 'type_text', args: { text: 'userC' } },
      { tool: 'click_mouse', args: { x: 0.9, y: 0.1 } },
    ], '常量槽逐字面、洞槽注入读值');
    // reader 请求的路由信息齐全（模板 id/步位/键/工具/类型/来源）
    assert.deepEqual(seen[0], {
      templateId: tplId, stepIndex: 1, key: 'text',
      tool: 'type_text', type: 'string', source: 'ocr',
    });
  }
  const after = skillLibrary.getTemplate(tplId);
  const holeAfter = after?.steps[1].args.text;
  assert.ok(holeAfter && holeAfter.kind === 'hole' && holeAfter.bindAttempts === 1 && holeAfter.bindSuccesses === 1,
    '绑定账本：成功一路 attempt=1/success=1');

  // 失败路①：reader 回 undefined ⇒ hole-read-failed（模板不适用）
  const miss = skillLibrary.bindTemplate(tplId, () => undefined);
  assert.ok(!miss.ok && miss.reason === 'hole-read-failed');
  assert.deepEqual((miss as { failed?: unknown }).failed, { stepIndex: 1, key: 'text', source: 'ocr' });

  // 失败路②：类型不符（string 洞喂 number）⇒ hole-type-mismatch
  const wrongType = skillLibrary.bindTemplate(tplId, () => 42);
  assert.ok(!wrongType.ok && wrongType.reason === 'hole-type-mismatch');

  // 失败路③：reader 抛错 ⇒ 旁路吸收为 hole-read-failed
  const boom = skillLibrary.bindTemplate(tplId, () => { throw new Error('OCR 不可用'); });
  assert.ok(!boom.ok && boom.reason === 'hole-read-failed');

  // 失败路④：未知模板 id ⇒ not-found
  const nf = skillLibrary.bindTemplate(999, () => 'x');
  assert.ok(!nf.ok && nf.reason === 'not-found');

  // 绑定账本审计：3 次失败尝试 + 1 次成功
  const holeFinal = skillLibrary.getTemplate(tplId)?.steps[1].args.text;
  assert.ok(holeFinal && holeFinal.kind === 'hole');
  if (holeFinal.kind === 'hole') {
    assert.equal(holeFinal.bindAttempts, 4);
    assert.equal(holeFinal.bindSuccesses, 1);
  }

  // 类型闸原子：valueMatchesHoleType
  assert.ok(valueMatchesHoleType('x', 'string'));
  assert.ok(!valueMatchesHoleType(42, 'string'));
  assert.ok(valueMatchesHoleType(0.5, 'number'));
  assert.ok(!valueMatchesHoleType(Number.NaN, 'number'));
  assert.ok(valueMatchesHoleType({ a: 1 }, 'json'));
  assert.ok(!valueMatchesHoleType('str', 'json'));

  // 回退零损失：字面量技能原样在场、原步骤逐字节不变（模板不适用 ⇒ 用回它们）
  for (const s of [s1!, s2!]) {
    const kept = skillLibrary.get(s.id);
    assert.ok(kept, `字面量技能 #${s.id} 仍在库`);
    assert.deepEqual(kept?.steps, s.steps, '字面量技能步骤逐字节不变（零行为损失）');
  }
});

// ─── M2-5：字面量技能零回归 + 模板召回 API ───

test('M2-5: 字面量技能零回归 —— induce 去重原律、match() 蒸馏前后逐位一致；matchTemplates 骨架/场景召回', () => {
  // induce 去重原律：同签名二归纳 = 强化（不建新卡）
  const a1 = skillLibrary.induce('整理数据并筛选', [click(0.5, 0.5), typeText('k1')]);
  const a2 = skillLibrary.induce('整理数据并筛选', [click(0.5, 0.5), typeText('k1')]);
  assert.ok(a1 && a2 && a1.id === a2.id, '同签名 ⇒ 同一张卡');
  assert.equal(a2.successCount, 2, '可靠度 bump（原律）');

  // 再放一张可配对的异值卡
  skillLibrary.induce('整理数据并筛选', [click(0.5, 0.5), typeText('k2')]);

  // 蒸馏前后：match() 的输出逐位一致（字面量召回零回归）
  const before = JSON.stringify(skillLibrary.match('整理数据并筛选'));
  const { created } = skillLibrary.distillTemplates();
  assert.equal(created.length, 1);
  const after = JSON.stringify(skillLibrary.match('整理数据并筛选'));
  assert.equal(after, before, 'match() 的分数/排序/透明面蒸馏前后逐位一致');

  // 模板召回：骨架哈希精确过滤
  const bySkeleton = skillLibrary.matchTemplates({ skeleton: ['click_mouse', 'type_text'] });
  assert.equal(bySkeleton.length, 1);
  assert.equal(bySkeleton[0].matched_via, 'skeleton-hash');
  assert.equal(bySkeleton[0].id, created[0].id);
  assert.equal(skillLibrary.matchTemplates({ skeleton: ['type_text', 'click_mouse'] }).length, 0,
    '异骨架 ⇒ 零召回（粗筛键的判别力）');
  // 场景指纹缺席 ⇒ reliability-only 通道（新模板 Beta(1,1) 均值 0.5 起步）
  const byNothing = skillLibrary.matchTemplates({});
  assert.equal(byNothing.length, 1);
  assert.equal(byNothing[0].matched_via, 'reliability-only');
  // 执行回写：recordTemplateOutcome 校准模板可靠度
  skillLibrary.recordTemplateOutcome(created[0].id, true);
  assert.equal(skillLibrary.getTemplate(created[0].id)?.successCount, 1);
  assert.equal(skillLibrary.listTemplates().length, 1, 'listTemplates 观测面');
});

// ─── M2-6：持久化接缝 —— 模板段落盘往返 + dump/restore + 骨架去重幂等 ───

test('M2-6: 模板段持久化 —— 落盘/重载往返、dump/restore 保真、同骨架二次蒸馏幂等', () => {
  const dir = mkdtempSync(join(tmpdir(), 'w3skill-'));
  try {
    skillLibrary.configure(true, join(dir, 'skills.json'), 50);
    skillLibrary.reset();
    skillLibrary.induce('登录A', [click(0.5, 0.5), typeText('userA'), click(0.9, 0.1)]);
    skillLibrary.induce('登录B', [click(0.5, 0.5), typeText('userB'), click(0.9, 0.1)]);
    const { created } = skillLibrary.distillTemplates();
    assert.equal(created.length, 1);

    // 落盘：模板段入档（原子写的完整新档）
    const onDisk = JSON.parse(readFileSync(join(dir, 'skills.json'), 'utf8'));
    assert.equal(onDisk.templates.length, 1, 'templates 段在档');
    assert.equal(onDisk.templates[0].holes, 1);
    assert.equal(onDisk.nextTemplateId, 2, '发号器进度入档');

    // 重载（跨会话存活）：reset 清内存后 load 恢复
    skillLibrary.reset();
    assert.equal(skillLibrary.listTemplates().length, 0, 'reset 清内存（磁盘保留）');
    skillLibrary.load();
    const restored = skillLibrary.listTemplates();
    assert.equal(restored.length, 1, 'load 恢复模板段');
    assert.equal(restored[0].steps[1].args.text.kind, 'hole');
    assert.equal(restored[0].parents.length, 2);
    // 重载后同骨架二次蒸馏 ⇒ 骨架去重（首酿优先，不重复建卡）
    const again = skillLibrary.distillTemplates();
    assert.equal(again.created.length, 0, '同骨架已在职 ⇒ 幂等');
    assert.ok(again.rejected.some(r => r.reason === 'skeleton-exists'), '拒绝判词 skeleton-exists 在册');

    // dump/restore（checkpoint 面）：模板段随快照保真
    const dump = skillLibrary.dump();
    assert.equal(dump.templates.length, 1);
    assert.equal(dump.nextTemplateId, 2);
    skillLibrary.restore({ skills: [], templates: dump.templates, nextTemplateId: dump.nextTemplateId });
    assert.equal(skillLibrary.listTemplates().length, 1, 'restore 恢复模板段（旧快照无段 ⇒ 段保持）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── S-1：sleep 接线① —— approvalQueue 晨报清单 ───

/** 假 journal（水位线可分辨：hash 逐测唯一 —— 结构子集经 as 收窄，同 Υ 册铸律） */
function fakeSleepJournal(hash: string) {
  return {
    list(actionOnly = true): JournalEntry[] {
      const e1 = { ts: 1, tool: 'click_mouse', args: {}, status: 'SUCCESS', hash };
      const marker = { ts: 2, hash: `${hash}#m` };
      return (actionOnly ? [e1] : [e1, marker]) as unknown as JournalEntry[];
    },
    verify() { return { ok: true, length: 2, brokenAt: null }; },
  };
}

test('S-1: sleep 接线① —— approvalQueue 晨报清单在场/落盘；缺席不伪造；noop 不携带', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'w3sleep-s1-'));
  try {
    const trace = join(dir, 'sleep.jsonl');
    const queueSummary: MorningApprovalQueueSummary = {
      pending: 2, expired: 1, grantedAwaitingResume: 1, deniedAwaitingPrune: 0,
      items: [
        { id: 'QA-1', description: '删除临时导出文件', enqueuedAt: 100, expiresAt: 9000, ttlExpired: false, riskTier: 'moderate', actionTool: 'click_mouse' },
        { id: 'QA-2', description: '打开系统设置面板', enqueuedAt: 110, expiresAt: 120, ttlExpired: true },
      ],
    };
    const deps: SleepDeps = {
      journal: fakeSleepJournal('s1h-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      approvalQueue: { pendingSummary: () => queueSummary },
      log: () => {},
    };
    const r = await runSleepCycle(deps, { sleepTracePath: trace, now: () => 1000 });
    // 晨报顶层清单：计数 + 条目 + 过期标注
    assert.equal(r.approvalQueue?.pending, 2);
    assert.equal(r.approvalQueue?.expired, 1);
    assert.equal(r.approvalQueue?.items[0].id, 'QA-1');
    assert.equal(r.approvalQueue?.items[1].ttlExpired, true, '过期条目显式标注（宁可唠叨不可静默蒸发）');
    const morning = r.acts.find(a => a.name === 'report');
    assert.equal(morning?.counts.queuePending, 2, '晨报幕 counts 携带队列计数');
    // 落盘行：清单随晨报 JSONL 行在场
    const line = JSON.parse(readFileSync(trace, 'utf8').trim());
    assert.equal(line.approvalQueue.pending, 2);
    assert.equal(line.approvalQueue.items.length, 2);

    // noop 二睡：同状态水位线 ⇒ 六幕全 noop、清单不携带（水位线律优先）
    const noop = await runSleepCycle(deps, { sleepTracePath: trace, now: () => 1000 });
    assert.ok(noop.acts.every(a => a.status === 'noop'));
    assert.equal(noop.approvalQueue, undefined, 'noop 睡眠不携带清单（随实睡晨报再出）');

    // 缺席 dep：清单缺席（诚实，不伪造空清单）—— 新状态实睡
    resetSleepCycle();
    const absent = await runSleepCycle(
      { journal: fakeSleepJournal('s1h-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), log: () => {} },
      { sleepTracePath: trace, now: () => 1000 },
    );
    assert.equal(absent.approvalQueue, undefined, 'dep 缺席 ⇒ 清单缺席');
    assert.equal(absent.acts.find(a => a.name === 'report')?.counts.queuePending, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── S-2：sleep 接线② —— memoryOpsConverger 校准旁挂 + 蒸馏幕模板旁挂 ───

test('S-2: sleep 接线② —— memoryOpsConverger 并入晨报；缺席零行为变化；故障/垃圾净化', async () => {
  const mkDeps = (hash: string, extra: Partial<SleepDeps> = {}): SleepDeps => ({
    journal: fakeSleepJournal(hash),
    calibrator: { tick: () => [{ key: 'popup.offThreshold', from: 0.35, to: 0.37, reason: 'optimal-threshold', generation: 2 }] },
    log: () => {},
    ...extra,
  });
  const convReport = {
    arms: 28,
    converged: [{
      key: 'memory.op.workflow.insert', category: 'workflow', op: 'insert',
      threshold: 0.42, source: 'thompson-sample', n: 12, successes: 9, failures: 3,
      alpha: 10, beta: 4, sample: 0.42, from: 0.3, to: 0.42, setOk: true,
    }],
    held: [{ key: 'memory.op.ui-pattern.boost', category: 'ui-pattern', op: 'boost', n: 3, reason: 'insufficient-feedback' }],
    seed: '12:s1h-cccccccc',
  } as unknown as MemoryOpsConvergenceReport;

  // 在场：校准幕旁挂调用 + counts + 晨报顶层 memoryOps 段
  const dir = mkdtempSync(join(tmpdir(), 'w3sleep-s2-'));
  try {
    const trace = join(dir, 'sleep.jsonl');
    const r = await runSleepCycle(mkDeps('s2h-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
      memoryOpsConverger: () => convReport,
    }), { sleepTracePath: trace, now: () => 1000 });
    const cal = r.acts.find(a => a.name === 'calibrate');
    assert.equal(cal?.status, 'ok', '旁挂不炸校准幕');
    assert.equal(cal?.counts.memoryOpsArms, 28);
    assert.equal(cal?.counts.memoryOpsConverged, 1);
    assert.equal(cal?.counts.memoryOpsHeld, 1);
    assert.ok((cal?.detail ?? '').includes('记忆操作收敛'), `detail 注记收敛：${cal?.detail}`);
    assert.equal(r.memoryOps?.arms, 28, '晨报顶层 memoryOps 段');
    assert.equal(r.memoryOps?.converged, 1);
    assert.equal(r.memoryOps?.seed, '12:s1h-cccccccc', '收敛种子（重放的钥匙）随晨报');
    assert.equal(r.memoryOps?.entries[0].key, 'memory.op.workflow.insert');
    assert.equal(r.memoryOps?.entries[0].setOk, true);
    const line = JSON.parse(readFileSync(trace, 'utf8').trim());
    assert.equal(line.memoryOps.seed, '12:s1h-cccccccc', '晨报行携带收敛摘要');

    // 缺席：零行为变化 —— counts 无 memoryOps* 键、顶层无段、detail 无注记
    const absent = await runSleepCycle(mkDeps('s2h-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      { now: () => 1000 });
    const calAbsent = absent.acts.find(a => a.name === 'calibrate');
    assert.equal(calAbsent?.status, 'ok');
    assert.deepEqual(Object.keys(calAbsent?.counts ?? {}), ['calibrations', 'recommendations'],
      '缺省缺席 ⇒ counts 与旧形态逐键一致（零行为变化）');
    assert.equal(absent.memoryOps, undefined, '顶层无 memoryOps 段');

    // 故障：converger 抛错 ⇒ 注记吸收，幕仍 ok
    const boom = await runSleepCycle(mkDeps('s2h-ccccccccccccccccccccccccccccccc', {
      memoryOpsConverger: () => { throw new Error('registry degraded'); },
    }), { now: () => 1000 });
    const calBoom = boom.acts.find(a => a.name === 'calibrate');
    assert.equal(calBoom?.status, 'ok');
    assert.ok((calBoom?.detail ?? '').includes('记忆操作收敛故障'), '故障旁路注记');
    assert.equal(boom.memoryOps, undefined);

    // 垃圾报告：sanitize 净化 —— 整体垃圾 ⇒ 缺席注记（不伪造零收敛）
    const garbage = await runSleepCycle(mkDeps('s2h-ddddddddddddddddddddddddddddddd', {
      memoryOpsConverger: (() => null) as unknown as () => MemoryOpsConvergenceReport,
    }), { now: () => 1000 });
    const calGarbage = garbage.acts.find(a => a.name === 'calibrate');
    assert.equal(calGarbage?.status, 'ok');
    assert.ok((calGarbage?.detail ?? '').includes('报告不可解析'), '垃圾报告 ⇒ 缺席注记');
    assert.equal(garbage.memoryOps, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // 蒸馏幕模板旁挂：distillTemplates 在场 ⇒ counts.templates；缺席 ⇒ 无键
  resetSleepCycle();
  const withTpl = await runSleepCycle({
    journal: fakeSleepJournal('s2h-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),
    skillLibrary: {
      induceFromJournal: () => ({ id: 7 }),
      distillTemplates: () => ({ created: [{ id: 1, parents: [7, 8], holes: 2 }], rejected: [] }),
    },
    log: () => {},
  }, { now: () => 1000 });
  const distillWith = withTpl.acts.find(a => a.name === 'distill');
  assert.equal(distillWith?.counts.skills, 1, '主归纳原样');
  assert.equal(distillWith?.counts.templates, 1, '模板蒸馏旁挂计数');

  resetSleepCycle();
  const withoutTpl = await runSleepCycle({
    journal: fakeSleepJournal('s2h-ffffffffffffffffffffffffffffffff'),
    skillLibrary: { induceFromJournal: () => ({ id: 7 }) },
    log: () => {},
  }, { now: () => 1000 });
  const distillWithout = withoutTpl.acts.find(a => a.name === 'distill');
  assert.deepEqual(distillWithout?.counts, { skills: 1 }, '旁挂面缺席 ⇒ counts 与旧形态逐键一致');
});

// ─── ΝΩ-22（热路径 IO 放大①）：skillLibrary 防抖落盘执法册 ───
//
//   a 防抖合并：recordOutcome 三连 ⇒ 恰开一个 50ms 合并窗、窗内零落盘、
//     到点恰一次全库落盘且三笔回写全并入（假 timer 注入 —— 零真等）；
//   b 紧急路径保留：显式 save() 立即冲刷并取消待决合并写；flush() 同步冲刷；
//   c bindTemplate / learnFromDemonstration 失败与蒸馏路径并入合并窗。

/** 假 timer 宿主：捕获回调手动触发（离线确定性 —— 零真等） */
function fakeSaveTimers() {
  let next = 0;
  const queue = new Map<number, { fn: () => void; ms: number }>();
  return {
    host: {
      setTimeout: (fn: () => void, ms: number) => { next += 1; queue.set(next, { fn, ms }); return next; },
      clearTimeout: (h: unknown) => { queue.delete(h as number); },
    },
    queue,
    fireAll: () => { for (const { fn } of [...queue.values()]) fn(); },
  };
}

test('ΝΩ-22-a 防抖合并：recordOutcome 三连 ⇒ 一次落盘（50ms 合并窗，假 timer 零真等）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'w3skill-nw22a-'));
  try {
    skillLibrary.configure(true, join(dir, 'skills.json'), 50);
    skillLibrary.reset();
    const fake = fakeSaveTimers();
    skillLibrary.setSaveTimersForTest(fake.host);
    const s = skillLibrary.induce('防抖工作流', [click(0.5, 0.5)]);
    assert.ok(s);
    const base = skillLibrary.saveStatsForTest();
    assert.equal(base.writes, 1, 'induce 批量路径立即落盘（紧急语义保留）');
    assert.equal(base.pending, false);
    // 热路径三连回写：只开一个合并窗、窗内零落盘
    skillLibrary.recordOutcome(s!.id, true);
    skillLibrary.recordOutcome(s!.id, false);
    skillLibrary.recordOutcome(s!.id, true);
    const mid = skillLibrary.saveStatsForTest();
    assert.equal(mid.writes, base.writes, '合并窗内零落盘');
    assert.equal(mid.scheduled, base.scheduled + 1, '三连回写合并为一次调度');
    assert.equal(mid.pending, true);
    assert.equal(fake.queue.size, 1, '恰一个待触发定时器');
    assert.equal([...fake.queue.values()][0]!.ms, 50, '合并窗宽度 50ms');
    // 到点：恰一次全库落盘，三笔回写全部并入同一档
    fake.fireAll();
    const after = skillLibrary.saveStatsForTest();
    assert.equal(after.writes, base.writes + 1, '窗口到点恰一次落盘');
    assert.equal(after.pending, false);
    const onDisk = JSON.parse(readFileSync(join(dir, 'skills.json'), 'utf8'));
    assert.equal(onDisk.skills[0].attemptCount, 4, '初始 1 + 三笔回写');
    assert.equal(onDisk.skills[0].successCount, 3, '成功 1 + 2');
  } finally {
    skillLibrary.setSaveTimersForTest(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ΝΩ-22-b 紧急路径保留：显式 save() 立即冲刷并取消待决合并写；flush() 同步冲刷', () => {
  const dir = mkdtempSync(join(tmpdir(), 'w3skill-nw22b-'));
  try {
    skillLibrary.configure(true, join(dir, 'skills.json'), 50);
    skillLibrary.reset();
    const fake = fakeSaveTimers();
    skillLibrary.setSaveTimersForTest(fake.host);
    const s = skillLibrary.induce('紧急冲刷工作流', [click(0.1, 0.2)]);
    assert.ok(s);
    const base = skillLibrary.saveStatsForTest();
    // ① 显式 save()：立即冲刷 + 取消待决定时器
    skillLibrary.recordOutcome(s!.id, true);
    assert.equal(skillLibrary.saveStatsForTest().pending, true);
    skillLibrary.save();
    const afterSave = skillLibrary.saveStatsForTest();
    assert.equal(afterSave.writes, base.writes + 1, '显式调用立即落盘');
    assert.equal(afterSave.pending, false, '待决合并写被取消');
    assert.equal(fake.queue.size, 0, '定时器已清理（残余回调不再触发二次落盘）');
    // ② flush()：合并窗内同步冲刷（退出钩子/卸载路径的同步面）
    skillLibrary.recordOutcome(s!.id, true);
    assert.equal(skillLibrary.saveStatsForTest().pending, true);
    skillLibrary.flush();
    const afterFlush = skillLibrary.saveStatsForTest();
    assert.equal(afterFlush.writes, base.writes + 2, 'flush 同步冲刷一次');
    assert.equal(afterFlush.pending, false);
    const onDisk = JSON.parse(readFileSync(join(dir, 'skills.json'), 'utf8'));
    assert.equal(onDisk.skills[0].attemptCount, 3, '两笔回写均已在档');
  } finally {
    skillLibrary.setSaveTimersForTest(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ΝΩ-22-c bindTemplate/learnFromDemonstration 热路径并入合并窗', () => {
  const dir = mkdtempSync(join(tmpdir(), 'w3skill-nw22c-'));
  try {
    skillLibrary.configure(true, join(dir, 'skills.json'), 50);
    skillLibrary.reset();
    const fake = fakeSaveTimers();
    skillLibrary.setSaveTimersForTest(fake.host);
    skillLibrary.induce('登录门户', [click(0.5, 0.5), typeText('userA'), click(0.9, 0.1)]);
    skillLibrary.induce('登录门户', [click(0.5, 0.5), typeText('userB'), click(0.9, 0.1)]);
    const { created } = skillLibrary.distillTemplates();
    assert.equal(created.length, 1);
    const tplId = created[0].id;
    const base = skillLibrary.saveStatsForTest();
    // bindTemplate 失败路径（reader 抛错）：账本回写并入合并窗（不立即落盘）
    const boom = skillLibrary.bindTemplate(tplId, () => { throw new Error('OCR 不可用'); });
    assert.ok(!boom.ok && boom.reason === 'hole-read-failed');
    const afterBind = skillLibrary.saveStatsForTest();
    assert.equal(afterBind.writes, base.writes, '失败路径窗内零落盘');
    assert.equal(afterBind.pending, true);
    fake.fireAll();
    assert.equal(skillLibrary.saveStatsForTest().writes, base.writes + 1, '到点一次落盘');
    const hole = skillLibrary.getTemplate(tplId)?.steps[1].args.text;
    assert.ok(hole && hole.kind === 'hole' && hole.bindAttempts === 1, '绑定账本并入同一档');
    // learnFromDemonstration（负示范命中 ⇒ penalized）：同律并入合并窗
    const mid = skillLibrary.saveStatsForTest();
    const learn = skillLibrary.learnFromDemonstration({
      kind: 'approval-denied',
      tokenId: 'ab12cd34',
      actionShape: { tool: 'click_mouse', x: 0.5, y: 0.5 },
    });
    assert.equal(learn.outcome, 'penalized', '签名通道命中技能');
    assert.equal(skillLibrary.saveStatsForTest().writes, mid.writes, '示范蒸馏窗内零落盘');
    assert.equal(skillLibrary.saveStatsForTest().pending, true);
    fake.fireAll();
    assert.equal(skillLibrary.saveStatsForTest().writes, mid.writes + 1, '到点一次落盘');
    const onDisk = JSON.parse(readFileSync(join(dir, 'skills.json'), 'utf8'));
    const penalized = onDisk.skills.find((x: any) => x.demoDenied > 0);
    assert.ok(penalized, '否决注记已落盘');
    assert.equal(penalized.demoBonus, -0.15);
  } finally {
    skillLibrary.setSaveTimersForTest(null);
    rmSync(dir, { recursive: true, force: true });
  }
});
