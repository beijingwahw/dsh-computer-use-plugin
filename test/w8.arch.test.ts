// test/w8.arch.test.ts
// W8-B4（任务二：包级循环依赖破除）架构执法测试 —— 源码级文本断言（w6r 源码
// 取证先例：readFileSync + assert.match/doesNotMatch）+ 装配运行时验证：
//   ① canaryLogic.ts（纯逻辑区）对 autonomy 包零 import —— 三张认识论面
//      （adviseAction / costPriorOfCall / scoreOptions 包装）全部改经
//      CanaryEpistemicPorts 端口注入，由 canaryGuard 装配时喂参；
//   ② autoPilot.ts 对 tools 侧会话实现零 import —— steer 会话工厂经
//      bindSteerSessionFactory 晚绑定注册器注入（steerTools 装载即注册）；
//   ③ autonomy 包全域对 '../tools' 零 import（tools↔autonomy 环彻底断开 ——
//      依赖方向恒 tools/guards → autonomy 单向）；
//   ④ 装配运行时验证：装载 steerTools/canaryGuard 的进程里注册位非空；
//   ⑤ 判据证伪面接线在册：autoPilot 源内 evaluateCriteria 消费点（⑧′）存在。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
// 装载即注册的两侧装配面（运行时验证用）
import '../src/tools/steerTools.ts';
import '../src/guards/canaryGuard.ts';
import { boundSteerSessionFactory } from '../src/autonomy/autoPilot.ts';
import { boundCanaryEpistemicPorts } from '../src/guards/canaryLogic.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 源码取证读取（w6r 先例同法） */
function srcOf(rel: string): string {
  return readFileSync(join(ROOT, 'src', rel), 'utf8');
}

// ─── ① canaryLogic：纯逻辑区对 autonomy 零 import（含 type import —— 文本级禁绝） ───

test('W8-架构①: canaryLogic.ts 无任何 autonomy 包 import —— 认识论面全经端口注入', () => {
  const src = srcOf('guards/canaryLogic.ts');
  assert.doesNotMatch(src, /autonomy\//, 'canaryLogic 源内不得出现指向 autonomy 包的路径（import/type 均禁）');
  assert.match(src, /export interface CanaryEpistemicPorts/, '端口契约在册');
  assert.match(src, /export function bindCanaryEpistemicPorts/, '注册器在册');
});

test('W8-架构①′: canaryGuard.ts 是生产装配点 —— 模块装载即喂入三张真身', () => {
  const src = srcOf('guards/canaryGuard.ts');
  assert.match(src, /from '\.\.\/autonomy\/uncertainty'/, '装配点合法持有 autonomy 依赖边（单向）');
  assert.match(src, /bindCanaryEpistemicPorts\(\{/, '装载即注册（生产面喂参）');
  assert.match(src, /adviseAction,\s*\n?\s*costPriorOfCall,\s*\n?\s*predictEffects:/, '三张面齐喂');
  // 运行时验证：本测试进程装载了 canaryGuard ⇒ 注册位非空
  assert.notEqual(boundCanaryEpistemicPorts(), null, '注册位已绑定生产面');
  assert.equal(typeof boundCanaryEpistemicPorts()!.adviseAction, 'function');
});

// ─── ② autoPilot：对 tools 侧会话实现零 import（晚绑定注册器破环） ───

test('W8-架构②: autoPilot.ts 无 tools 侧会话实现 import —— 工厂经注册器注入', () => {
  const src = srcOf('autonomy/autoPilot.ts');
  assert.doesNotMatch(src, /steerTools/, 'autoPilot 源内不得出现会话实现模块名（静态/动态 import 均禁）');
  assert.match(src, /export function bindSteerSessionFactory/, '晚绑定注册器在册');
  assert.match(src, /export interface PilotSteerSession/, '结构端口契约在册');
});

test('W8-架构②′: steerTools.ts 装载即注册生产工厂 —— 注册位运行时验证', () => {
  const src = srcOf('tools/steerTools.ts');
  assert.match(src, /bindSteerSessionFactory\(createSteerSession\)/, '装载即注册（生产真身）');
  assert.notEqual(boundSteerSessionFactory(), null, '本测试进程（已装载 steerTools）注册位非空');
});

// ─── ③ autonomy 包全域对 '../tools' 零 import（环彻底断开） ───

test('W8-架构③: autonomy 包全域无 ../tools import —— tools↔autonomy 双向依赖已破', () => {
  const dir = join(ROOT, 'src', 'autonomy');
  const files = readdirSync(dir).filter(f => f.endsWith('.ts'));
  assert.ok(files.length > 0, 'autonomy 包在册');
  const offenders: string[] = [];
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    if (/from '\.\.\/tools\//.test(text) || /from "\.\.\/tools\//.test(text)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `以下文件仍反向 import tools：${offenders.join(', ')}`);
});

// ─── ④ 判据证伪面接线在册（任务一与 autoPilot 的缝合点） ───

test('W8-架构④: autoPilot ⑧′ 消费 criteriaEval —— 证伪面接进闭环', () => {
  const src = srcOf('autonomy/autoPilot.ts');
  assert.match(src, /from '\.\/criteriaEval'/, '闭环依赖 criteriaEval 器官');
  assert.match(src, /evaluateCriteria\(w8CriteriaPairs, w8Corpus\)/, '⑧′ 评估消费点在册');
  assert.match(srcOf('autonomy/criteriaEval.ts'), /from '\.\.\/fuzzy'/, 'fuzzy 容错已接入判据匹配路径');
});
