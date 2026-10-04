// test/autonomy.autonomyConstitution.test.ts
// 纪元 Φ（Φ-8 自主宪法）：宪法六律全离线验证 —— 黑名单 / 分层取重 / 文本扫描
// （含同形字 · leet · 全角混淆免疫，复用 riskGate 归一化）/ 审批≠禁止语义 /
// destructive 硬法 / 卡死与超步停机；默认条文值、partial 合并与净化、
// 系统还原族扩表（纪元 Δ：恢复出厂/恢复默认/重置系统/restore factory/
// reset to default ⇒ destructive；「恢复」单字不成族反例）、
// 空与垃圾 payload 不抛、条文副本防篡改。零网络、零墙钟、零测试顺序依赖。
// ΑΩ-R43（终版立法）：goalText 危险词**照旧并入扫描面保守顶格**（Σ-3⑦/W7-D3
// 执法定谳：目标级保守是刻意立法，可用性副作用让位）；交付面收窄为 backgroundRisk
// 纯审计标注（判决书字段 + reason 注记，零行为变化）；动作面不可逆证据路径判决
// 逐字节冻结；destructive 硬法锁定。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AutonomyConstitution,
  classifyRisk,
  type ConstitutionContext,
  type ConstitutionRules,
} from '../src/autonomy/autonomyConstitution.ts';
import type { PolicyAction } from '../src/autonomy/policyEngine.ts';

// ─── 工厂 ───

/** 点击目标工厂（bbox/center 与判决无关，取最小合法值） */
function target(label: string): NonNullable<PolicyAction['target']> {
  return { bbox: { x0: 0, y0: 0, x1: 10, y1: 10 }, center: { x: 5, y: 5 }, label };
}

/** 动作工厂 —— 缺省良性 scroll 形态，覆盖项透传 */
function act(o: Partial<PolicyAction> & { kind: PolicyAction['kind'] }): PolicyAction {
  return {
    kind: o.kind,
    ...(o.target !== undefined ? { target: o.target } : {}),
    ...(o.payload !== undefined ? { payload: o.payload } : {}),
    rationale: o.rationale ?? '测试动作',
    expectedEffect: o.expectedEffect ?? '无',
    utility: o.utility ?? 0.5,
    riskTier: o.riskTier ?? 'benign',
  };
}

/** 裁决上下文工厂 —— 缺省安静账目（无卡死 / 无步耗） */
function cctx(o: { goalText?: string; consecutiveNoEffect?: number; stepsTaken?: number } = {}): ConstitutionContext {
  return {
    consecutiveNoEffect: o.consecutiveNoEffect ?? 0,
    stepsTaken: o.stepsTaken ?? 0,
    ...(o.goalText !== undefined ? { goalText: o.goalText } : {}),
  };
}

// ─── 条文：默认值 / partial 合并与净化 / 副本防篡改 ───

test('Φ-8: 默认条文全量对照（白名单 benign / 无黑名单 / 卡死 3 步 / 硬顶 40 步 / 危险词 11 条）', () => {
  const c = new AutonomyConstitution();
  const expected: ConstitutionRules = {
    allowAutonomousTiers: ['benign'],
    forbiddenActions: [],
    maxConsecutiveNoEffect: 3,
    maxTotalSteps: 40,
    forbiddenKeywords: ['删除', '格式化', '清空', '支付', '转账', '注销', '卸载', 'delete', 'format', 'payment', 'transfer'],
  };
  assert.deepEqual(c.rules, expected);
});

test('Φ-8: partial 合并 —— 只传的字段覆写，其余保持缺省；黑名单去重/滤非串/trim', () => {
  const c = new AutonomyConstitution({ maxTotalSteps: 5, forbiddenActions: ['drag', 'drag', 42 as never, '  type  '] });
  assert.equal(c.rules.maxTotalSteps, 5);
  assert.deepEqual(c.rules.forbiddenActions, ['drag', 'type']);
  assert.equal(c.rules.maxConsecutiveNoEffect, 3); // 未传保持缺省
  assert.deepEqual(c.rules.allowAutonomousTiers, ['benign']);
});

test('Φ-8: 条文净化 —— 步数上限 <1 / NaN 回退缺省；垃圾构造入参（null / 非对象）不抛且全取缺省', () => {
  const c = new AutonomyConstitution({ maxConsecutiveNoEffect: 0, maxTotalSteps: Number.NaN });
  assert.equal(c.rules.maxConsecutiveNoEffect, 3); // 0 步上限会瘫痪自主环，视为非法
  assert.equal(c.rules.maxTotalSteps, 40);
  assert.doesNotThrow(() => new AutonomyConstitution(null as never));
  assert.doesNotThrow(() => new AutonomyConstitution('垃圾' as never));
  assert.deepEqual(new AutonomyConstitution(null as never).rules, new AutonomyConstitution().rules);
});

test('Φ-8: rules getter 为防御性副本 —— 篡改返回数组（白名单/黑名单/危险词）不透内部判决', () => {
  const c = new AutonomyConstitution();
  const r = c.rules;
  r.allowAutonomousTiers.push('destructive');
  r.forbiddenActions.push('click');
  r.forbiddenKeywords.push('篡改');
  const again = c.rules;
  assert.deepEqual(again.allowAutonomousTiers, ['benign']);
  assert.deepEqual(again.forbiddenActions, []);
  assert.equal(again.forbiddenKeywords.includes('篡改'), false);
});

// ─── classifyRisk 纯律 ───

test('Φ-8: classifyRisk 观察族六种恒 benign（inspect/ask_vlm/recall_skill/wait/declare/scroll）', () => {
  for (const kind of ['inspect', 'ask_vlm', 'recall_skill', 'wait', 'declare', 'scroll'] as const) {
    assert.equal(classifyRisk(act({ kind })), 'benign', kind);
  }
});

test('Φ-8: classifyRisk click —— label 命中不可逆词族 ⇒ destructive（中文/英文/混淆同律），普通 label ⇒ benign', () => {
  assert.equal(classifyRisk(act({ kind: 'click', target: target('删除文件') })), 'destructive');
  assert.equal(classifyRisk(act({ kind: 'click', target: target('Uninstall Now') })), 'destructive'); // parseRiskPatterns 小写化 + 子串匹配
  assert.equal(classifyRisk(act({ kind: 'click', target: target('dеlete all') })), 'destructive'); // 西里尔 е 混淆
  assert.equal(classifyRisk(act({ kind: 'click', target: target('打开文件') })), 'benign');
  assert.equal(classifyRisk(act({ kind: 'click', target: target('发送') })), 'benign'); // 敏感词由 check 文本扫描律接管
  assert.equal(classifyRisk(act({ kind: 'click' })), 'benign'); // 无目标不抛
});

test('Φ-8: 系统还原族（纪元 Δ 扩表）—— 「OK 恢复出厂设置」按钮 click ⇒ destructive 须审批（旧词面全不命中、曾判 benign 被自主点击）', () => {
  const c = new AutonomyConstitution();
  // classifyRisk 词法层：新增不可逆词直判 destructive
  for (const label of ['OK 恢复出厂设置', '恢复默认配置', '重置系统设置', 'Restore factory settings', 'Reset to default now']) {
    assert.equal(classifyRisk(act({ kind: 'click', target: target(label) })), 'destructive', label);
    const v = c.check(act({ kind: 'click', target: target(label), riskTier: 'benign' }), cctx());
    assert.equal(v.riskTier, 'destructive', label);
    assert.equal(v.allowed, true, label); // 审批不是禁止
    assert.equal(v.requiresApproval, true, label);
  }
  // 文本扫描层：goalText 含系统还原词 ⇒ 词族已并入扫描并集，连 benign 的 scroll 也如实顶格
  // （ΑΩ-R43 终版：保守顶格保持，另附 backgroundRisk=high 审计标注）
  const g = c.check(act({ kind: 'scroll', payload: { direction: 'down' } }), cctx({ goalText: '把设备恢复出厂' }));
  assert.equal(g.riskTier, 'destructive');
  assert.equal(g.requiresApproval, true);
  assert.equal(g.backgroundRisk, 'high');
  assert.match(g.reason, /backgroundRisk=high/);
});

test('Φ-8: 反例 —— 「恢复」单字不成族：恢复窗口布局 / Restore session 仍 benign 免审批', () => {
  const c = new AutonomyConstitution();
  assert.equal(classifyRisk(act({ kind: 'click', target: target('恢复窗口布局') })), 'benign');
  assert.equal(classifyRisk(act({ kind: 'click', target: target('Restore session') })), 'benign');
  for (const label of ['恢复窗口布局', 'Restore session']) {
    const v = c.check(act({ kind: 'click', target: target(label) }), cctx());
    assert.equal(v.riskTier, 'benign', label);
    assert.equal(v.allowed, true, label);
    assert.equal(v.requiresApproval, false, label);
  }
});

test('Φ-8: classifyRisk type/hotkey/drag —— 敏感动词输入 ⇒ sensitive；delete/backspace 大段删除 ⇒ sensitive；其余 benign', () => {
  assert.equal(classifyRisk(act({ kind: 'type', payload: { text: '请查收，此邮件即将发送' } })), 'sensitive');
  assert.equal(classifyRisk(act({ kind: 'type', payload: { text: 'submit the report' } })), 'sensitive');
  assert.equal(classifyRisk(act({ kind: 'type', payload: { text: 'hello world' } })), 'benign');
  assert.equal(classifyRisk(act({ kind: 'hotkey', payload: { keys: ['ctrl', 'backspace'] } })), 'sensitive');
  assert.equal(classifyRisk(act({ kind: 'hotkey', payload: { keys: ['delete'] } })), 'sensitive');
  assert.equal(classifyRisk(act({ kind: 'hotkey', payload: { keys: ['esc'] } })), 'benign');
  assert.equal(classifyRisk(act({ kind: 'drag' })), 'benign');
});

test('Φ-8: classifyRisk 垃圾动作收敛 benign 不抛（null / 缺 kind / 目标 label 非串）', () => {
  assert.equal(classifyRisk(null as never), 'benign');
  assert.equal(classifyRisk({} as never), 'benign');
  assert.equal(
    classifyRisk(act({ kind: 'click', target: { bbox: { x0: 0, y0: 0, x1: 1, y1: 1 }, center: { x: 0, y: 0 }, label: 7 as never } })),
    'benign',
  );
});

// ─── 律① 黑名单 ───

test('Φ-8: 律①黑名单 —— 命中 kind 直接禁止（审批不可解锁），reason 点名黑名单', () => {
  const c = new AutonomyConstitution({ forbiddenActions: ['type'] });
  const v = c.check(act({ kind: 'type', payload: { text: 'hello' } }), cctx());
  assert.equal(v.allowed, false);
  assert.equal(v.requiresApproval, false);
  assert.match(v.reason, /黑名单/);
  assert.ok(v.reason.endsWith('。')); // 一句中文
});

test('Φ-8: 律①压过其余一切 —— 黑名单动作即使文本命中不可逆词仍禁止，但判决书如实携带 destructive 供审计', () => {
  const c = new AutonomyConstitution({ forbiddenActions: ['type'] });
  const v = c.check(act({ kind: 'type', payload: { text: '删除全部文件' } }), cctx({ goalText: '清理磁盘' }));
  assert.equal(v.allowed, false);
  assert.equal(v.riskTier, 'destructive'); // 全量证据之最重，恒随裁决返回
});

// ─── 律② 分层取重 ───

test('Φ-8: 律②取重 —— 词法 destructive 压过申报 benign；申报 sensitive 压过词法 benign', () => {
  const c = new AutonomyConstitution();
  const v1 = c.check(act({ kind: 'click', target: target('清空回收站'), riskTier: 'benign' }), cctx());
  assert.equal(v1.riskTier, 'destructive');
  const v2 = c.check(act({ kind: 'click', target: target('打开文件'), riskTier: 'sensitive' }), cctx());
  assert.equal(v2.riskTier, 'sensitive');
  assert.equal(v2.allowed, true); // 须审批不是禁止
  assert.equal(v2.requiresApproval, true);
});

// ─── 律③ 文本扫描（goalText / label / payload 三源 + 混淆免疫）───

test('Φ-8/ΑΩ-R43: 律③ goalText 保守顶格（旧律字节忠实）+ backgroundRisk 审计标注 —— 目标含「清空」⇒ scroll 升 destructive 须审批', () => {
  const c = new AutonomyConstitution();
  const v = c.check(act({ kind: 'scroll', payload: { direction: 'down' } }), cctx({ goalText: '清空回收站' }));
  assert.equal(v.riskTier, 'destructive');
  assert.equal(v.allowed, true);
  assert.equal(v.requiresApproval, true);
  assert.equal(v.backgroundRisk, 'high');
  assert.match(v.reason, /backgroundRisk=high/);
  assert.ok(v.reason.endsWith('。'), '注记以分号缀叙，理由仍一句中文句号收尾');
});

test('Φ-8: 律③ label 命中一般危险词（发送）⇒ sensitive 须审批；命中不可逆词（支付）⇒ destructive', () => {
  const c = new AutonomyConstitution();
  const v1 = c.check(act({ kind: 'click', target: target('发送邮件') }), cctx());
  assert.equal(v1.riskTier, 'sensitive');
  const v2 = c.check(act({ kind: 'click', target: target('立即支付') }), cctx());
  assert.equal(v2.riskTier, 'destructive');
  for (const v of [v1, v2]) {
    assert.equal(v.allowed, true); // 审批是人的裁决权，动作本身仍合法
    assert.equal(v.requiresApproval, true);
  }
});

test('Φ-8: 律③ payload 参与扫描 —— type 输入含 transfer ⇒ destructive（词法层未察、文本扫描补位）', () => {
  const c = new AutonomyConstitution();
  const v = c.check(act({ kind: 'type', payload: { text: 'transfer $100 to account' } }), cctx());
  assert.equal(v.riskTier, 'destructive');
  assert.equal(v.requiresApproval, true);
  // 对照：classifyRisk 的 type 分支只察敏感动词，本句词法层确为 benign —— 升级来自③
  assert.equal(classifyRisk(act({ kind: 'type', payload: { text: 'transfer $100 to account' } })), 'benign');
});

test('Φ-8: 律③混淆免疫（复用 riskGate 归一化）—— 西里尔 dеlete / 插空 支 付 / 全角 ｔｒａｎｓｆｅｒ / leet d3lete 全数命中 destructive', () => {
  const c = new AutonomyConstitution();
  // 注：全角样本避开 ｍ/ｒｎ 双边折叠不对称的字母（riskGate 生成表 m→rn，全角 ｍ 折到 m 即止）——
  // 那是 riskGate 自身的已知边界，宪法按契约原样继承其归一化能力，不在此绕行。
  const samples = ['dеlete everything', '支 付 宝 转 账', 'ｔｒａｎｓｆｅｒ 100 dollars', 'd3lete all files'];
  for (const text of samples) {
    const v = c.check(act({ kind: 'type', payload: { text } }), cctx());
    assert.equal(v.riskTier, 'destructive', text);
    assert.equal(v.allowed, true, text);
    assert.equal(v.requiresApproval, true, text);
  }
  // 对照：明文同句同样命中 —— 混淆不降险
  const plain = c.check(act({ kind: 'type', payload: { text: 'delete everything' } }), cctx());
  assert.equal(plain.riskTier, 'destructive');
});

test('Φ-8/ΑΩ-R43: 律③自定义危险词 —— forbiddenKeywords 注入「引爆」⇒ goalText 命中 sensitive 须审批（不在不可逆族）+ backgroundRisk=elevated 标注', () => {
  const c = new AutonomyConstitution({ forbiddenKeywords: ['引爆'] });
  const v = c.check(act({ kind: 'scroll', payload: { direction: 'down' } }), cctx({ goalText: '引爆测试装置' }));
  assert.equal(v.riskTier, 'sensitive');
  assert.equal(v.allowed, true);
  assert.equal(v.requiresApproval, true);
  assert.equal(v.backgroundRisk, 'elevated');
  assert.match(v.reason, /backgroundRisk=elevated/);
  // 自定义词表替换后，riskGate 默认危险词表仍恒在（并集立法）：删除照旧 destructive
  const v2 = c.check(act({ kind: 'click', target: target('删除') }), cctx());
  assert.equal(v2.riskTier, 'destructive');
});

// ─── ΑΩ-R43 扫描面分层：goalText 背景风险 ───

test('ΑΩ-R43: goalText 危险词照旧保守顶格（终版立法）—— 判决含 backgroundRisk 审计标注，goalText 干净则无标注', () => {
  const c = new AutonomyConstitution();
  // 高危目标（不可逆词族）⇒ 连 benign 的 scroll 也升 destructive（旧律），并留 high 标注：
  const v = c.check(act({ kind: 'scroll', payload: { direction: 'down' } }), cctx({ goalText: '删除临时文件并转账付款' }));
  assert.equal(v.riskTier, 'destructive', '旧律保守顶格（Σ-3⑦/W7-D3 定谳）');
  assert.equal(v.allowed, true);
  assert.equal(v.requiresApproval, true);
  assert.equal(v.backgroundRisk, 'high');
  assert.match(v.reason, /backgroundRisk=high/);
  assert.ok(v.reason.endsWith('。'));
  // 申报 sensitive 的动作 + 高危目标 ⇒ 不可逆顶格压过申报档（旧律 maxTier 语义）
  const s = c.check(act({ kind: 'click', target: target('打开设置'), riskTier: 'sensitive' }), cctx({ goalText: '删除临时文件' }));
  assert.equal(s.riskTier, 'destructive');
  assert.equal(s.requiresApproval, true);
  assert.equal(s.backgroundRisk, 'high');
  // 目标只含一般危险词（非不可逆族）⇒ sensitive 须审批（旧律）+ elevated 标注
  const e = c.check(act({ kind: 'scroll', payload: { direction: 'up' } }), cctx({ goalText: '发送周报给主管' }));
  assert.equal(e.riskTier, 'sensitive');
  assert.equal(e.requiresApproval, true);
  assert.equal(e.backgroundRisk, 'elevated');
  // goalText 干净 ⇒ 无字段无注记（判决形态与旧律一致）
  const clean = c.check(act({ kind: 'scroll', payload: { direction: 'down' } }), cctx({ goalText: '打开系统设置' }));
  assert.equal(clean.backgroundRisk, undefined);
  assert.equal(clean.riskTier, 'benign');
  assert.equal(clean.reason.includes('backgroundRisk'), false);
});

test('ΑΩ-R43: 动作自身含危险词 ⇒ 旧行为逐字节 —— 判决对象全量对照（无 backgroundRisk 字段、reason 无注记），goalText 危险词不改变结果', () => {
  const c = new AutonomyConstitution();
  const withGoal = c.check(act({ kind: 'click', target: target('立即支付') }), cctx({ goalText: '删除全部订单' }));
  const noGoal = c.check(act({ kind: 'click', target: target('立即支付') }), cctx());
  // 逐字节冻结：动作自带不可逆证据的路径，有无 goalText 判决全等，且与旧律判决对象一致
  assert.deepEqual(withGoal, {
    allowed: true,
    riskTier: 'destructive',
    requiresApproval: true,
    reason: '风险分层 destructive 不在自主白名单（benign）内，本动作须人工审批后方可执行。',
  });
  assert.deepEqual(noGoal, withGoal);
  // 动作面一般危险词（label 发送）+ 高危目标：目标不可逆词照旧把整体顶格 destructive
  // （旧律 maxTier 语义），backgroundRisk 留 high 审计标注
  const s = c.check(act({ kind: 'click', target: target('发送邮件') }), cctx({ goalText: '删除全部订单' }));
  assert.equal(s.riskTier, 'destructive');
  assert.equal(s.requiresApproval, true);
  assert.equal(s.backgroundRisk, 'high');
});

test('ΑΩ-R43: destructive 硬法恒审批不变 —— 白名单显式含 destructive，动作面不可逆证据仍恒审批且判决逐字节无注记', () => {
  const c = new AutonomyConstitution({ allowAutonomousTiers: ['benign', 'sensitive', 'destructive'] });
  const v = c.check(act({ kind: 'click', target: target('格式化磁盘') }), cctx({ goalText: '删除一切' }));
  assert.equal(v.allowed, true); // 不是禁止 —— 批了就能做
  assert.equal(v.requiresApproval, true); // 但审批是绕不开的（硬法不可让渡）
  assert.equal(v.riskTier, 'destructive');
  assert.match(v.reason, /硬法/);
  assert.equal(v.reason.includes('backgroundRisk'), false, '动作自带不可逆证据 ⇒ 判决逐字节不变');
  assert.equal(v.backgroundRisk, undefined);
});

test('ΑΩ-R43: 审计标注在场性 —— 目标背景危险无论动作面证据在场与否均保守顶格（旧律）并留痕；干净目标零标注', () => {
  const c = new AutonomyConstitution();
  // 无 label 无 payload + 高危目标 ⇒ destructive（旧律同果）+ high 标注
  const v = c.check(act({ kind: 'scroll' }), cctx({ goalText: '清空回收站' }));
  assert.equal(v.riskTier, 'destructive');
  assert.equal(v.allowed, true);
  assert.equal(v.requiresApproval, true);
  assert.equal(v.backgroundRisk, 'high', '背景风险如实留痕供审计');
  assert.match(v.reason, /backgroundRisk=high/);
  // 对照：动作面证据在场（payload 非空）且干净 ⇒ 终版立法下仍顶格（goalText 恒在
  // 扫描面 —— 与旧律逐字节同果），标注同样在场
  const present = c.check(act({ kind: 'scroll', payload: { direction: 'down' } }), cctx({ goalText: '清空回收站' }));
  assert.equal(present.riskTier, 'destructive');
  assert.equal(present.requiresApproval, true);
  assert.equal(present.backgroundRisk, 'high');
  // elevated 背景 ⇒ sensitive 须审批（旧律同果）
  assert.equal(c.check(act({ kind: 'wait' }), cctx({ goalText: '发送周报' })).riskTier, 'sensitive');
  // goalText 干净时证据缺席不顶格（与旧律一致）、零标注
  const clean = c.check(act({ kind: 'wait' }), cctx({ goalText: '打开设置' }));
  assert.equal(clean.riskTier, 'benign');
  assert.equal(clean.requiresApproval, false);
  assert.equal(clean.backgroundRisk, undefined);
});

// ─── 律④ 审批律与硬法 ───

test('Φ-8: 律④ —— benign 在白名单内 ⇒ allowed 且免审批（reason 一句中文说明放行）', () => {
  const c = new AutonomyConstitution();
  const v = c.check(act({ kind: 'inspect', payload: { region: { x0: 0, y0: 0, x1: 100, y1: 100 } } }), cctx());
  assert.equal(v.allowed, true);
  assert.equal(v.requiresApproval, false);
  assert.equal(v.riskTier, 'benign');
  assert.ok(v.reason.length > 0 && v.reason.endsWith('。'));
});

test('Φ-8: 律④硬法 —— 白名单显式含 destructive，destructive 动作仍恒须审批（reason 点名硬法）', () => {
  const c = new AutonomyConstitution({ allowAutonomousTiers: ['benign', 'sensitive', 'destructive'] });
  const v = c.check(act({ kind: 'click', target: target('格式化磁盘') }), cctx());
  assert.equal(v.allowed, true); // 不是禁止 —— 批了就能做
  assert.equal(v.requiresApproval, true); // 但审批是绕不开的
  assert.equal(v.riskTier, 'destructive');
  assert.match(v.reason, /硬法/);
  // 同一白名单下 sensitive 真正放行 —— 证明硬法只针对 destructive，白名单对其余分层仍有效
  const v2 = c.check(act({ kind: 'click', target: target('发送') }), cctx());
  assert.equal(v2.riskTier, 'sensitive');
  assert.equal(v2.requiresApproval, false);
  assert.equal(v2.allowed, true);
});

test('Φ-8: 律④最保守立法 —— allowAutonomousTiers 置空 ⇒ benign 也须审批，但仍是审批不是禁止', () => {
  const c = new AutonomyConstitution({ allowAutonomousTiers: [] });
  const v = c.check(act({ kind: 'wait' }), cctx());
  assert.equal(v.allowed, true);
  assert.equal(v.requiresApproval, true);
  assert.equal(v.riskTier, 'benign');
});

// ─── 律⑤ 卡死 / 律⑥ 超步 ───

test('Φ-8: 律⑤卡死 —— 连续 3 步无效果（默认上限 3）⇒ 禁止升级人工；2 步仍放行', () => {
  const c = new AutonomyConstitution();
  const v = c.check(act({ kind: 'inspect' }), cctx({ consecutiveNoEffect: 3 }));
  assert.equal(v.allowed, false);
  assert.equal(v.requiresApproval, false); // 审批救不了死循环（停机问题非授权问题）
  assert.match(v.reason, /卡死/);
  const ok = c.check(act({ kind: 'inspect' }), cctx({ consecutiveNoEffect: 2 }));
  assert.equal(ok.allowed, true);
  assert.equal(ok.requiresApproval, false);
});

test('Φ-8: 律⑤压过律④ —— sensitive 动作叠加卡死 ⇒ 禁止（而非转审批）', () => {
  const c = new AutonomyConstitution();
  const v = c.check(act({ kind: 'click', target: target('发送') }), cctx({ consecutiveNoEffect: 3 }));
  assert.equal(v.riskTier, 'sensitive');
  assert.equal(v.allowed, false);
  assert.equal(v.requiresApproval, false);
  assert.match(v.reason, /卡死/);
});

test('Φ-8: 律⑥超步 —— stepsTaken 达 40（默认硬顶）禁止且 reason 携带上限；39 仍放行；自定义上限 5 边界对照', () => {
  const c = new AutonomyConstitution();
  const v = c.check(act({ kind: 'wait' }), cctx({ stepsTaken: 40 }));
  assert.equal(v.allowed, false);
  assert.equal(v.requiresApproval, false);
  assert.match(v.reason, /40/);
  const ok = c.check(act({ kind: 'wait' }), cctx({ stepsTaken: 39 }));
  assert.equal(ok.allowed, true);
  const c5 = new AutonomyConstitution({ maxTotalSteps: 5 });
  assert.equal(c5.check(act({ kind: 'wait' }), cctx({ stepsTaken: 5 })).allowed, false);
  assert.equal(c5.check(act({ kind: 'wait' }), cctx({ stepsTaken: 4 })).allowed, true);
});

// ─── 防御性：空 / 垃圾输入绝不抛 ───

test('Φ-8: 空 payload / 无 payload 不抛 —— undefined、null、{} 均正常出具判决', () => {
  const c = new AutonomyConstitution();
  type Verdict = ReturnType<AutonomyConstitution['check']>;
  const run = (a: PolicyAction): { threw: boolean; v?: Verdict } => {
    try {
      return { threw: false, v: c.check(a, cctx()) };
    } catch {
      return { threw: true };
    }
  };
  for (const payload of [undefined, null, {}] as Array<Record<string, unknown> | undefined | null>) {
    const a: PolicyAction = { ...act({ kind: 'type' }), ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) };
    const r = run(a);
    assert.equal(r.threw, false);
    assert.equal(r.v!.allowed, true);
    assert.equal(r.v!.riskTier, 'benign');
  }
});

test('Φ-8: 炸裂 payload（循环引用 / BigInt）与垃圾 ctx 不抛 —— safeStringify 收敛，账目非法按 0 记', () => {
  const c = new AutonomyConstitution();
  type Verdict = ReturnType<AutonomyConstitution['check']>;
  const circular: Record<string, unknown> = { text: '普通输入' };
  circular.self = circular; // JSON.stringify 会抛 TypeError
  let threw = false;
  let v: Verdict | undefined;
  let v2: Verdict | undefined;
  let v3: Verdict | undefined;
  try {
    v = c.check(act({ kind: 'type', payload: circular }), cctx());
    v2 = c.check(act({ kind: 'type', payload: { n: BigInt(1) } }), cctx()); // JSON.stringify 对 BigInt 抛 TypeError
    v3 = c.check(act({ kind: 'scroll' }), { consecutiveNoEffect: Number.NaN, stepsTaken: -5, goalText: 7 as never });
    c.check(act({ kind: 'scroll' }), undefined as never); // 整个 ctx 缺失
  } catch {
    threw = true;
  }
  assert.equal(threw, false);
  assert.equal(v!.riskTier, 'benign'); // 序列化失败 = 无文本证据，不凭空猜险
  assert.equal(v!.allowed, true);
  assert.equal(v2!.allowed, true);
  assert.equal(v3!.allowed, true); // NaN 按 0、负步数不达上限
});
