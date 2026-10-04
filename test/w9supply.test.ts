// test/w9supply.test.ts
// W9-3 供给执法册（D-D9 + D-F4①）：
//   ① D-D9（knowledgeBase 单例供给）：knowledgeBase.ts 模块级单例在册 ——
//      consolidate 真 callable；免疫幕 actImmune 消费单例 ⇒ status 'ok'
//      （skipped 终结），空库计数诚实为零（绝不伪造）；真实聚类路径
//      （3 条同景 auto-learn ⇒ 簇 ≥1、情景皮层化）；dispose 归零可复；
//      缺席语义零漂移（不传 dep ⇒ 仍 skipped）。
//   ② D-D9 组合根接线（源码取证，w6r/w8.arch 先例）：index.ts 静态引入单例、
//      SleepDeps 实投（enableSleepCycle 块内）、卸载路径 dispose（W-1 隔离律）、
//      config 缺省 enableSleepCycle=false（供给面就位但缺省关 —— 行为零漂移）。
//   ③ D-F4①（生成物豁免登记）：confusables.generated 在中央豁免注册表，
//      epoch/reason 齐全且理由申报再生成命令；注册表整体过防滥用执法
//      （assertExemptionRegistryValid）；登记数与注册表长度一致（22）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { knowledgeBase } from '../src/knowledge/knowledgeBase.ts';
import { actImmune } from '../src/sleep/sleepActs.ts';
import { OVER_ENGINEERING_EXEMPTIONS, EXEMPTABLE_RULE_ID } from '../src/doctorRules.exemptions.ts';
import { assertExemptionRegistryValid } from '../src/qualityDoctor.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 源码取证读取（w6r / w8.arch 先例同法） */
function srcOf(rel: string): string {
  return readFileSync(join(ROOT, 'src', rel), 'utf8');
}

// ─── ① D-D9：免疫幕供给面（skipped 终结） ───

test('W9-供给①: knowledgeBase 单例在册 —— consolidate 真 callable，免疫幕不再 skipped', () => {
  knowledgeBase.dispose(); // 测试隔离：清账起跑
  assert.equal(typeof knowledgeBase.consolidate, 'function', '单例携带免疫幕消费面（SleepKnowledgeBaseLike.consolidate）');
  const r = actImmune({ knowledgeBase });
  assert.notEqual(r.status, 'skipped', '供给后免疫幕 runnable —— skipped 语义终结（D-D9）');
  assert.equal(r.status, 'ok', '空库 consolidate ok（真实调用、真实计数）');
  assert.deepEqual(r.counts, { episodes: 0, clusters: 0, consolidated: 0, decayed: 0 },
    '空库计数诚实为零（供给面不伪造内容）');
});

test('W9-供给①′: 真实聚类路径 —— 3 条同景 auto-learn ⇒ 簇 ≥1、情景皮层化、幂等', () => {
  knowledgeBase.dispose();
  // 同一场景的三次失败经历（海马体情景记忆）—— 语义向量近邻必成簇
  const scenario = 'close the export dialog in spreadsheet app';
  for (const detail of [
    'click save button in export dialog failed (timeout)',
    'click save button in export dialog failed (element not found)',
    'click save button in export dialog failed again (timeout)',
  ]) {
    const r = knowledgeBase.insert({
      category: 'error-pattern', content: detail, scenario,
      confidence: 0.5, source: 'auto-learn',
    });
    assert.ok(r.ok, `auto-learn 条目入册：${detail}`);
  }
  const act = actImmune({ knowledgeBase });
  assert.equal(act.status, 'ok');
  assert.equal(act.counts.episodes, 3, '三条情景全部参与整合');
  assert.ok(act.counts.clusters >= 1, '近邻情景成簇（cosine ≥ CLUSTER_SIMILARITY）');
  assert.ok(act.counts.consolidated >= 1, '簇蒸馏为语义记忆（consolidated ≥1）');
  assert.equal(act.counts.decayed, 3, '原情景皮层化衰减（留痕让位）');
  // 幂等（免疫双守卫：corticalizedIds / semanticMemoryIds 排除已消化面）
  const again = actImmune({ knowledgeBase });
  assert.equal(again.status, 'ok');
  assert.equal(again.counts.episodes, 0, '重复整合零新增情景（幂等安全）');
  // dispose 归零可复（卸载路径同律）
  const d = knowledgeBase.dispose();
  assert.ok(d.ok, 'dispose ok');
  const after = actImmune({ knowledgeBase });
  assert.equal(after.status, 'ok');
  assert.equal(after.counts.episodes, 0, '归零后免疫幕照常 runnable（不因空而 skipped）');
});

test('W9-供给①″: 缺席语义零漂移 —— 不传 knowledgeBase ⇒ 免疫幕仍诚实 skipped', () => {
  const r = actImmune({});
  assert.equal(r.status, 'skipped', 'dep 缺席 ⇒ skipped（既有语义原样保留）');
  assert.ok((r.detail ?? '').includes('knowledgeBase'), '跳过原因指名缺席面');
});

// ─── ② D-D9：组合根接线（源码取证） ───

test('W9-供给②: 组合根实投 —— index.ts 静态引入 + SleepDeps 投喂 + 卸载归零 + 缺省关', () => {
  const idx = srcOf('index.ts');
  assert.match(idx, /import \{ knowledgeBase \} from '\.\/knowledge\/knowledgeBase';/,
    '单例静态引入（W9-3 D-D9）');
  assert.match(idx, /knowledgeBase,\s*\n\s*\/\/ W9-3|\/\/ W9-3（D-D9 供给接线）：免疫幕单例投喂[\s\S]{0,400}?knowledgeBase,/,
    'SleepDeps 实投（enableSleepCycle 块内）');
  assert.match(idx, /knowledgeBase\.dispose\(\);/,
    '卸载路径归零（W-1 单例隔离律）');
  assert.doesNotMatch(idx, /免疫幕诚实缺席/,
    '旧「诚实缺席」注记已被供给注记取代（债项可销）');
  const cfg = srcOf('config.ts');
  assert.match(cfg, /enableSleepCycle:\s*Schema\.boolean\(\)\.default\(false\)/,
    '缺省行为不变：睡眠缺省关（供给面就位、消费零触发）');
});

// ─── ③ D-F4①：生成物豁免登记 ───

test('W9-豁免③: confusables.generated 在中央豁免注册表 —— 三要素齐全、理由申报再生成命令', () => {
  const entry = OVER_ENGINEERING_EXEMPTIONS.find(e => e.file === 'riskGate.confusables.generated.ts');
  assert.ok(entry, '生成物豁免条目在册（D-F4①）');
  assert.equal(entry!.epoch, 'W9-3', '登记纪元可审计');
  assert.match(entry!.reason, /gen_confusables\.mjs/, '理由申报再生成命令（重建路径在案）');
  assert.match(entry!.reason, /生成物/, '理由申报生成物身份（手改即违规）');
});

test('W9-豁免③′: 注册表整体过防滥用执法 —— 无重复、无幽灵文件、登记数一致', () => {
  assert.doesNotThrow(() => assertExemptionRegistryValid(OVER_ENGINEERING_EXEMPTIONS),
    '三要素齐全 + 文件真实存在（fail-fast 执法）');
  const files = OVER_ENGINEERING_EXEMPTIONS.map(e => e.file);
  assert.equal(new Set(files).size, files.length, '无重复登记');
  assert.equal(OVER_ENGINEERING_EXEMPTIONS.length, 24,
    '登记数 24（W6-1 三件 + W6-2 十八件 + W9-3 三件：生成物一件 + 拆分后器官主体残余两件）');
  assert.equal(EXEMPTABLE_RULE_ID, 'smell.over-engineering', '豁免语法域唯一规则（立法面不动）');
});

// ─── ④ D-F4②：拆分后器官主体残余豁免（skillLibrary / subAgent） ───

test('W9-豁免④: 拆分后残余的器官主体豁免在册 —— 卫星件已就位、理由如实申报残余行数', async () => {
  const { existsSync } = await import('node:fs');
  const sl = OVER_ENGINEERING_EXEMPTIONS.find(e => e.file === 'skillLibrary.ts');
  assert.ok(sl, 'skillLibrary.ts 器官主体残余豁免在册（W9-3 拆后）');
  assert.match(sl!.reason, /skillLibrary\.signatures.*skillLibrary\.templates/s,
    '理由申报已提取的卫星件（检索签名 + 模板蒸馏分区）');
  assert.ok(existsSync(join(ROOT, 'src', 'skillLibrary.signatures.ts')), '检索/签名卫星件真实存在');
  assert.ok(existsSync(join(ROOT, 'src', 'skillLibrary.templates.ts')), '模板/蒸馏卫星件真实存在');

  const sa = OVER_ENGINEERING_EXEMPTIONS.find(e => e.file === 'subAgent.ts');
  assert.ok(sa, 'subAgent.ts 器官主体残余豁免在册（W9-3 拆后）');
  assert.match(sa!.reason, /subAgent\.arbitration.*subAgent\.auction/s,
    '理由申报已提取的卫星件（仲裁 + 拍卖分区）');
  assert.ok(existsSync(join(ROOT, 'src', 'subAgent.arbitration.ts')), '仲裁卫星件真实存在');
  assert.ok(existsSync(join(ROOT, 'src', 'subAgent.auction.ts')), '拍卖卫星件真实存在');
});
