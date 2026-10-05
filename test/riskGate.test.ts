// test/riskGate.test.ts
// ΝΩ-23：riskGate 词法匹配升级（Aho-Corasick + 词边界感知）的执法测试。
// 覆盖：工单正反例全量 / 边界律立法面（免边界族维持子串语义）/ 中文逐字节
// 不变 / 自动机 vs 旧 includes 引擎在中英文混合长文本上的对照（除拉丁短词
// 边界收窄外全一致，且收窄单侧 —— 绝不新增命中）/ 自定义词表热重建 /
// 铁律（脏输入绝不抛）/ 归一化零回归钉（位置映射改造不动文本面）。
// ΠΑΝ-9（H-1 补全）：不可见字符绕过执法 —— 软连字符 U+00AD/词连接符 U+2060/
//   函数应用族 U+2061-2064（Cf）、组合附加记号（Mn）、变体选择符 VS16/
//   VS17-256 注入必须命中；NFKC 前置（兼容分解形折叠）；同形字路径在 NFKC
//   之后零回归（西里尔/希腊）；边界律与剥除协同（邻接判定回到原文）；
//   混合攻击栈纵深穿透；纯不可见输入绝不抛。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesRiskPatterns,
  matchesDangerPatterns,
  normalizeForRisk,
  riskPatternCacheSize,
  DEFAULT_RISK_PATTERNS,
  DEFAULT_DANGER_PATTERNS,
} from '../src/riskGate.ts';

// ─── 独立参考实现（测试本地，不 import 生产匹配内核）───

/** 旧引擎（ΝΩ-23 前的 includes 语义）：折叠域全子串匹配。
 *  折叠本身复用导出的 normalizeForRisk —— 它不是本次的被测面（等价性另有钉）。 */
function oldEngine(text: string, csv: string, fallback: string): boolean {
  const hay = normalizeForRisk(text);
  return (csv || fallback)
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .map(normalizeForRisk)
    .filter(p => p.length > 0)
    .some(p => hay.includes(p));
}

/** 词表里参与命中的词条（旧引擎视角 —— 用于「收窄可解释性」断言） */
function oldHittingEntries(text: string, csv: string, fallback: string): string[] {
  const hay = normalizeForRisk(text);
  return (csv || fallback)
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .filter(e => normalizeForRisk(e).length > 0 && hay.includes(normalizeForRisk(e)));
}

/** 新引擎的独立期望（限「小写 ASCII + 基本汉字 + 分隔符」语料 —— 前置条件
 *  逐条断言执法）：独立重建「折叠串 + 逐码点来源索引」，非边界词 = 旧子串
 *  语义；硬边界词（纯 [a-z] 单字且 ≤7）的每个出现处按原文邻接判边界 ——
 *  与生产实现同构但独立手写（indexOf 逐出现枚举，非自动机）。 */
function refFoldWithMap(text: string): { hay: string; map: number[] } {
  let hay = '';
  const map: number[] = [];
  let u16 = 0;
  for (const ch of text) { // 语料限小写：逐字符折叠与整串折叠可组合（前置条件断言执法）
    const folded = normalizeForRisk(ch);
    for (const cp of folded) { hay += cp; map.push(u16); }
    u16 += ch.length;
  }
  return { hay, map };
}

/** 独立词内判定：原文该码元折叠后首字符是 [a-z0-9]（字母/数字是词内字符） */
function refWordUnit(text: string, i: number): boolean {
  const folded = normalizeForRisk(text[i]);
  return folded.length > 0 && /[a-z0-9]/.test(folded[0]);
}

function expectedNew(text: string, csv: string, fallback: string): boolean {
  const { hay, map } = refFoldWithMap(text);
  for (const raw of (csv || fallback).split(',')) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    const w = normalizeForRisk(entry);
    if (!w) continue;
    const hard = /^[a-z]+$/.test(entry) && entry.length <= 7;
    let from = 0;
    for (;;) {
      const idx = hay.indexOf(w, from); // 语料 BMP ⇒ 码元索引 = 码点序（与 map 对齐）
      if (idx < 0) break;
      from = idx + 1;
      if (!hard) return true;
      const first = map[idx];
      const last = map[idx + w.length - 1];
      const leadClean = first === 0 || !refWordUnit(text, first - 1);
      const lastLen = (text.codePointAt(last) ?? 0) > 0xffff ? 2 : 1;
      const tailIdx = last + lastLen;
      const tailClean = tailIdx >= text.length || !refWordUnit(text, tailIdx);
      if (leadClean && tailClean) return true;
    }
  }
  return false;
}

function isHardEntry(entry: string): boolean {
  const e = entry.trim().toLowerCase();
  return /^[a-z]+$/.test(e) && e.length <= 7;
}

// ─── ΝΩ-23 §1：工单正反例全量执法 ───

test('ΝΩ-23 §1: 误报回归集 —— 粘词全部不再命中', () => {
  // risk 侧（DEFAULT_RISK_PATTERNS：pin/token/secret 等）
  for (const t of ['typing', 'spinner', 'mapping', 'pinning', 'secretary', 'tokenize', 'metatoken']) {
    assert.equal(matchesRiskPatterns(t, ''), false, `risk 误报必须消除: ${t}`);
  }
  // danger 侧（DEFAULT_DANGER_PATTERNS：confirm/reset/remove 等）
  for (const t of ['confirmation', 'resetting', 'preset']) {
    assert.equal(matchesDangerPatterns(t, ''), false, `danger 误报必须消除: ${t}`);
  }
});

test('ΝΩ-23 §1: 真命中不受收窄影响', () => {
  assert.equal(matchesRiskPatterns('pin', ''), true, 'pin 独立词（串首尾天然边界）');
  assert.equal(matchesRiskPatterns('pin-code', ''), true, '连字符是边界（归一化剥掉但原文在）');
  assert.equal(matchesRiskPatterns('pin_code', ''), true, '下划线同律');
  assert.equal(matchesRiskPatterns('enter your pin', ''), true, '空格分写的真实凭据语境');
  assert.equal(matchesRiskPatterns('access token', ''), true);
  assert.equal(matchesRiskPatterns('发送 token', ''), true, '工单正例：中英混排独立 token');
  assert.equal(matchesRiskPatterns('PIN:', ''), true, '大写+标点（折叠后边缘）');
  assert.equal(matchesDangerPatterns('发送 token', ''), true, '中文危险词（无边界概念）');
  assert.equal(matchesDangerPatterns('confirm', ''), true, 'confirm 独立词（长度 7 收编硬边界）');
  assert.equal(matchesDangerPatterns('please confirm the order', ''), true);
  assert.equal(matchesDangerPatterns('factory reset', ''), true);
  assert.equal(matchesDangerPatterns('remove', ''), true);
});

// ─── ΝΩ-23 §2：边界律立法面（免边界族的判定规则成文执法）───

test('ΝΩ-23 §2: 免边界族 —— 长词/含数字/复合词/中文维持子串语义', () => {
  assert.equal(matchesRiskPatterns('passwordless', ''), true, 'password(8) 长词免边界');
  assert.equal(matchesRiskPatterns('x2fa', ''), true, '2fa 含数字免边界');
  assert.equal(matchesRiskPatterns('myapikey', ''), true, 'api key 复合词（词条含空格）免边界');
  assert.equal(matchesRiskPatterns('密码本', ''), true, '中文词无词边界概念');
  assert.equal(matchesRiskPatterns('verificationcode字段', ''), true, '长词 verification code 免边界');
  assert.equal(matchesDangerPatterns('checkoutpage', ''), true, 'checkout(8) 免边界');
  assert.equal(matchesDangerPatterns('卸载向导', ''), true);
});

test('ΝΩ-23 §2: 硬边界族 —— 粘词收窄（收窄单侧，分写形态仍在网内）', () => {
  assert.equal(matchesRiskPatterns('hotpot', ''), false, 'otp(3) 硬边界：hotpot 不再误报');
  assert.equal(matchesRiskPatterns('otp code', ''), true, 'otp 分写命中');
  assert.equal(matchesRiskPatterns('passwdx', ''), false, 'passwd(6) 硬边界');
  assert.equal(matchesRiskPatterns('passwd', ''), true);
  assert.equal(matchesDangerPatterns('applepay', ''), false, 'pay(3) 硬边界：粘合支付名收窄');
  assert.equal(matchesDangerPatterns('apple pay', ''), true, '分写支付名仍在网内');
  assert.equal(matchesDangerPatterns('ｐｒｅｓｅｔ', ''), false, '全角粘词不得借「原文码元非 ASCII」绕过边界');
  assert.equal(matchesDangerPatterns('preset button', ''), false, 'preset 分写也无 reset（reset 在词内）');
});

// ─── ΝΩ-23 §3：中文词表行为逐字节不变 ───

test('ΝΩ-23 §3: 中文/免边界词上与旧 includes 引擎完全一致', () => {
  const texts = [
    '输入密码后登录', '密 码 输入框', '口令：一二三', '验证码已发送', '私钥文件',
    '点击发送按钮', '支付 付款 转账 提现', '确认订单 结算 下单', '格式化 清空 卸载',
    'uninstall 卸载 格式化 format', 'checkout 结算 提交订单', 'verificationcode 输入',
    'ＡＰＩ ｋｅｙ 全角凭据', '2fa 双因素认证', 'password passwd 长词', 'withdraw transfer 提现 转账',
    '纯中文句子不含任何风险词 标点，符号。', '参考文献综述',
  ];
  const customCsvs = ['', '密码,口令,验证码', '支付,删除,发送', 'pin,密码,token'];
  for (const t of texts) {
    for (const csv of customCsvs) {
      assert.equal(
        matchesRiskPatterns(t, csv), oldEngine(t, csv, DEFAULT_RISK_PATTERNS),
        `risk 中文/免边界零变化: ${JSON.stringify(t)} @ ${csv}`,
      );
      assert.equal(
        matchesDangerPatterns(t, csv), oldEngine(t, csv, DEFAULT_DANGER_PATTERNS),
        `danger 中文/免边界零变化: ${JSON.stringify(t)} @ ${csv}`,
      );
    }
  }
});

// ─── ΝΩ-23 §4：自动机 vs 旧 includes 在中英文混合长文本上的对照 ───

/** 对照语料（限小写 ASCII + 基本汉字 + 分隔符 —— 前置条件逐条执法） */
const MIXED_CORPUS = [
  'click the send button and confirm your order',
  'click the cancel button 然后输入密码 登录',
  'typing spinner mapping pinning secretary tokenize metatoken',
  'preset confirmation resetting removed uninstalling formatted',
  'enter your pin here then press ok 验证码已发送',
  'pin-code 与 pin_code 两种写法的凭据框',
  'two factor auth 2fa otp 备用令牌',
  '访问令牌 token 已过期 请重新获取 secret 之后输入',
  '密码 password passwd 口令 私钥 凭据页',
  '支付 付款 退款 转账 提现 财务中心 checkout',
  'submit order 提交订单 结算 下单 购物车',
  'uninstall 卸载 format 格式化 erase 抹掉 清空',
  '密 码 与 口 令 分 写',
  'myapikey glued and passwordless long words',
  'resend autopay paypal applepay glued compounds',
  'nothing suspicious here 纯中文无风险词的句子 标点，符号。',
  'confirm 前请再确认 reset 与 remove 的区别',
  'hotpot captain posted mapping spinner 英文混排',
  'tokenize the metatoken secretary preset resetting',
  'otp 散落字 o t p 与粘合 hotpot 的对照',
  'send 发送 delete 删除 reset 重置 确认订单 提交订单 中英全表',
];
const MIXED_CSVS = [
  '', 'pin,token,secret,密码,发送', 'otp,2fa,api key,passwd,验证码',
  'send,reset,confirm,删除,支付', 'pin', 'password,remove,format,转账',
];

test('ΝΩ-23 §4: 混合语料对照 —— 除边界收窄外与旧引擎全一致，且收窄单侧', () => {
  let compared = 0;
  let narrowed = 0;
  for (const text of MIXED_CORPUS) {
    // 前置条件：语料不含折叠源（大写/leet/同形字）——独立折叠图与整串折叠可组合
    assert.match(
      text, /^[a-z0-9\u4e00-\u9fff\s\p{P}\p{S}]*$/u,
      `语料越界（必须小写 ASCII + 基本汉字 + 分隔符）: ${JSON.stringify(text)}`,
    );
    assert.equal(
      refFoldWithMap(text).hay, normalizeForRisk(text),
      `独立折叠=整串折叠（组合律前提）: ${JSON.stringify(text)}`,
    );
    for (const csv of MIXED_CSVS) {
      const oldR = oldEngine(text, csv, DEFAULT_RISK_PATTERNS);
      const newR = matchesRiskPatterns(text, csv);
      assert.equal(newR, expectedNew(text, csv, DEFAULT_RISK_PATTERNS), `risk 新引擎=独立期望: ${JSON.stringify(text)} @ ${csv}`);
      assert.equal(newR === oldR || (oldR && !newR), true, `只许收窄不许新增: ${JSON.stringify(text)} @ ${csv}`);
      if (oldR && !newR) {
        narrowed++;
        // 收窄可解释性：旧引擎命中的词条里必须存在硬边界词（否则属非法行为变化）
        assert.ok(
          oldHittingEntries(text, csv, DEFAULT_RISK_PATTERNS).some(isHardEntry),
          `收窄必须由硬边界词解释: ${JSON.stringify(text)} @ ${csv}`,
        );
      }
      const oldD = oldEngine(text, csv, DEFAULT_DANGER_PATTERNS);
      const newD = matchesDangerPatterns(text, csv);
      assert.equal(newD, expectedNew(text, csv, DEFAULT_DANGER_PATTERNS), `danger 新引擎=独立期望: ${JSON.stringify(text)} @ ${csv}`);
      assert.equal(newD === oldD || (oldD && !newD), true, `danger 只许收窄不许新增: ${JSON.stringify(text)} @ ${csv}`);
      if (oldD && !newD) {
        narrowed++;
        assert.ok(
          oldHittingEntries(text, csv, DEFAULT_DANGER_PATTERNS).some(isHardEntry),
          `danger 收窄必须由硬边界词解释: ${JSON.stringify(text)} @ ${csv}`,
        );
      }
      compared++;
    }
  }
  assert.ok(compared > 100, `对照面足量（实际 ${compared} 组）`);
  assert.ok(narrowed > 0, '对照必须实际覆盖到收窄案例（否则语料失效）');
});

test('ΝΩ-23 §4: 混淆语料 —— 折叠命中保留且绝不新增（单侧方向律）', () => {
  const confusable = [
    'ｓｅｎｄ ｏｒｄｅｒ', 'ｐｒｅｓｅｔ', 'ｓｅｃｒｅｔａｒｙ 全角粘词', 'd3lete ｎｏｗ',
    'please confirrn the order', 'p@ssｗ0rd 全角混合', '𝐩𝐚𝐬𝐬𝐰𝐨𝐫𝐝 数学粗体',
    '输入 ＡＰＩ ｋｅｙ', '点击 ｓＵｂｍｉｔ ｏｒｄｅｒ 按钮', '拖到 ｄｅｌｅｔｅ 区',
    'ρin 希腊同形', 't0ken leet', 'cyrillic аttack ѕecret', 'vеrification cоde 同形字',
  ];
  for (const t of confusable) {
    assert.equal(
      matchesRiskPatterns(t, '') === false || oldEngine(t, '', DEFAULT_RISK_PATTERNS) === true, true,
      `risk 绝不新增命中（新命中 ⇒ 旧命中）: ${JSON.stringify(t)}`,
    );
    assert.equal(
      matchesDangerPatterns(t, '') === false || oldEngine(t, '', DEFAULT_DANGER_PATTERNS) === true, true,
      `danger 绝不新增命中（新命中 ⇒ 旧命中）: ${JSON.stringify(t)}`,
    );
  }
  // 折叠命中保留钉（同形/leet/全角变体不得因边界收窄逃逸）
  assert.equal(matchesDangerPatterns('ｓｅｎｄ ｏｒｄｅｒ', ''), true, '全角 send 分写命中');
  assert.equal(matchesRiskPatterns('ρin', ''), true, '希腊 ρ→p 同形 pin');
  assert.equal(matchesRiskPatterns('t0ken', ''), true, 'leet token');
  assert.equal(matchesDangerPatterns('please confirrn the order', ''), true, 'rn 仿 m 折叠 confirm（分写）');
  assert.equal(matchesDangerPatterns('ｐｒｅｓｅｔ', ''), false, '全角粘词同样被边界律收编');
});

// ─── ΝΩ-23 §5：自定义词表热重建 ───

test('ΝΩ-23 §5: 自定义词表热重建 —— 换表即换自动机，逐出后重编译行为不变', () => {
  // 词表变更（新键）⇒ 新自动机即刻生效
  assert.equal(matchesRiskPatterns('pin', 'pin'), true);
  assert.equal(matchesRiskPatterns('token', 'pin'), false, '旧词表已让位');
  assert.equal(matchesRiskPatterns('token', 'token'), true);
  assert.equal(matchesRiskPatterns('pin', 'pin,token'), true, '扩展词表热接入');
  assert.equal(matchesRiskPatterns('typing', 'pin,token'), false, '热接入的拉丁短词同受边界律');
  assert.equal(matchesRiskPatterns('pin-code', 'pin,token'), true);
  // 灌满并逐出缓存（上限 32，同旧律）后，早前词表重入缓存必须重编译而非陈旧复用
  const marker = 'nw23-hot-rebuild-probe,pin';
  assert.equal(matchesRiskPatterns('pin', marker), true);
  for (let i = 0; i < 40; i++) matchesRiskPatterns('x', `nw23-evict-${i},zzz`);
  assert.ok(riskPatternCacheSize() <= 32, '缓存上限受控');
  assert.equal(matchesRiskPatterns('pin', marker), true, '逐出后重建仍命中');
  assert.equal(matchesRiskPatterns('nw23 hot rebuild probe', marker), true, '复合词（含空格）免边界子串命中');
  assert.equal(matchesRiskPatterns('token', 'pin'), false, '重编译不串表');
});

// ─── ΝΩ-23 §6：铁律 —— 运行层绝不抛 ───

test('ΝΩ-23 §6: 脏/极端输入绝不抛（布尔收敛）', () => {
  const hostile = [
    '', '   ', '!!!', '***', '\u0000', '\uD800', 'a'.repeat(10000),
    '𠀀'.repeat(500), 'İᾶϜΙΣΩΣ', '\u200b'.repeat(100), '密'.repeat(2000),
    'pin'.repeat(3000), '{"json":"like","text":"pin"}',
  ];
  for (const t of hostile) {
    for (const csv of ['', 'pin,token,密码', '***,,', 'pin']) {
      assert.equal(typeof matchesRiskPatterns(t, csv), 'boolean', `绝不抛: ${JSON.stringify(t.slice(0, 20))} @ ${csv}`);
      assert.equal(typeof matchesDangerPatterns(t, csv), 'boolean');
    }
  }
  assert.equal(matchesRiskPatterns('anything', '***,,'), false, '全空词表恒不命中');
});

// ─── ΝΩ-23 §7：归一化零回归钉（位置映射改造不动文本面）───

test('ΝΩ-23 §7: normalizeForRisk 输出逐字节不变（含整串小写语境规则）', () => {
  const pins: Array<[string, string]> = [
    ['p@ssw0rd', 'password'],
    ['密 码', '密码'],
    ['A P I k e y', 'aplkey'],        // i→l 折叠（CONFUSABLES 同律）
    ['verificati0n c0de', 'verlflcatloncode'],
    ['ｓｕｂｍｉｔ', 'subrnlt'],        // 全角→ASCII→m→rn 双遍折叠（不动点）
    ['typing', 'typlng'],
    ['pin', 'pln'],
    ['confirm', 'conflrrn'],
    ['confirmation', 'conflrrnatlon'],
    ['preset', 'preset'],
    ['ΑΣ', 'aς'],                     // Final_Sigma：整串小写的语境规则保持
    ['Σ', 'o'],                       // σ→o 混淆折叠（不对称乃表意：σ 形似 o）
    ['d3lete', 'delete'],
    ['ｄｅｌｅｔｅ', 'delete'],
    ['密 码 与 口 令 分 写', '密码与口令分写'],
  ];
  for (const [input, expected] of pins) {
    assert.equal(normalizeForRisk(input), expected, `归一化零回归: ${JSON.stringify(input)}`);
  }
  // ΠΑΝ-9 立法更新：İ 整串小写展开 i+U+0307（组合上点，Mn 类）—— 扩展剥除集
  // 之后 U+0307 剥除、'i' 经 CONFUSABLES 折 'l' ⇒ 输出单码点 'l'（旧钉的
  // 双码点形状是 ΠΑΝ-9 之前的行为；位置映射律本身不变：输出码点来源正确）。
  assert.deepEqual([...normalizeForRisk('İ')].map(c => 'U+' + c.codePointAt(0)!.toString(16)), ['U+6c'], 'İ → i+U+0307，Mn 组合点被 ΠΑΝ-9 剥除');
});

// ─── ΠΑΝ-9：不可见字符绕过执法（H-1 补全：Cf/Mn/变体选择符剥除 + NFKC 前置）───

test('ΠΑΝ-9 §8: 软连字符 U+00AD / 词连接符 U+2060 / 函数应用族 U+2061-2064（Cf）注入全部命中', () => {
  assert.equal(matchesRiskPatterns('pass\u00ADword', ''), true, '软连字符拼 password（H-1 正例）');
  assert.equal(matchesRiskPatterns('密\u00AD码', ''), true, '中文风险词中插软连字符');
  assert.equal(matchesRiskPatterns('p\u2060in', ''), true, '词连接符拼 pin');
  assert.equal(matchesRiskPatterns('口\u2060令', ''), true, '词连接符拼口令');
  assert.equal(matchesDangerPatterns('发\u2060送', ''), true, '词连接符拼发送（不可逆词）');
  assert.equal(matchesDangerPatterns('de\u2061lete', ''), true, 'U+2061 函数应用（Cf）拼 delete');
  assert.equal(matchesRiskPatterns('t\u2062oken', ''), true, 'U+2062 不可见乘（Cf）拼 token');
  assert.equal(matchesRiskPatterns('se\u2063cret', ''), true, 'U+2063 不可见分隔（Cf）拼 secret');
  assert.equal(matchesRiskPatterns('2\u2064fa', ''), true, 'U+2064 不可见加（Cf）拼 2fa');
});

test('ΠΑΝ-9 §8: 组合附加记号（Mn，如 U+0301/U+0307）注入命中', () => {
  assert.equal(matchesRiskPatterns('pa\u0301ssword', ''), true, '分解形 á（a+U+0301）拼 password');
  assert.equal(matchesRiskPatterns('tok\u0301en', ''), true, 'token 中插组合尖音符');
  assert.equal(matchesRiskPatterns('验证\u0301码', ''), true, '中文验证码中插组合记号');
  assert.equal(matchesRiskPatterns('pin\u0307', ''), true, '组合上点（İ 展开的同族记号）尾随 pin');
});

test('ΠΑΝ-9 §8: 变体选择符 VS16（U+FE0F）与 VS17-256（U+E0100-E01EF，星面 Mn）注入命中', () => {
  assert.equal(matchesDangerPatterns('se\uFE0Fnd', ''), true, 'VS16 拼 send');
  assert.equal(matchesRiskPatterns('pass\uFE0Fword', ''), true, 'VS16 拼 password');
  assert.equal(matchesDangerPatterns('de\u{E0100}lete', ''), true, 'VS17 拼 delete');
  assert.equal(matchesRiskPatterns('2\u{E01EF}fa', ''), true, 'VS256（区间末码点）拼 2fa');
});

test('ΠΑΝ-9 §8: NFKC 前置 —— 兼容分解形（全角/带圈/罗马数字/连字/上标）折叠后命中', () => {
  assert.equal(matchesRiskPatterns('２ｆａ', ''), true, '全角数字 NFKC→2fa');
  assert.equal(matchesRiskPatterns('Ⓟⓐⓢⓢⓦⓞⓡⓓ', ''), true, '带圈字母 NFKC→password');
  assert.equal(matchesDangerPatterns('ⓢⓔⓝⓓ 订单', ''), true, '带圈字母 NFKC→send 分写命中');
  // 粘词形态（ⅴⅠ 折 v+l 前缀）同受硬边界律 —— 与 §2 applepay 同律，NFKC 不豁免粘词
  assert.equal(matchesDangerPatterns('ⅴⅠⓢⓔⓝⓓ', ''), false, '罗马数字+带圈粘词 = 粘合前缀，边界律照常执法');
  assert.equal(normalizeForRisk('ﬁle'), 'flle', '连字 ﬁ NFKC→f+i，i 经 CONFUSABLES 折 l（同律链）');
  assert.equal(normalizeForRisk('№'), 'no', '兼容字 № NFKC→no');
});

test('ΠΑΝ-9 §8: 同形字折叠在 NFKC 之后仍工作（西里尔/希腊路径零回归）', () => {
  assert.equal(normalizeForRisk('а'), 'a', '西里尔 а → a（NFKC 不分解西里尔 —— 策展/生成表路径原样工作）');
  assert.equal(normalizeForRisk('ѕ'), 's', '西里尔 ѕ → s');
  assert.equal(matchesRiskPatterns('pаssword', ''), true, 'p+西里尔а+ssword → password');
  assert.equal(matchesRiskPatterns('ѕecret', ''), true, '西里尔 ѕecret → secret');
  assert.equal(matchesRiskPatterns('ρin', ''), true, '希腊 ρin → pin（既有钉复确认）');
  assert.equal(normalizeForRisk('Σ'), 'o', 'σ→o 混淆折叠（不对称乃表意）');
  assert.equal(normalizeForRisk('ΑΣ'), 'aς', 'Final_Sigma 语境规则不被 NFKC 破坏');
});

test('ΠΑΝ-9 §8: 边界律协同 —— 不可见剥除后拼接不产生新逃逸，邻接判定回到原文', () => {
  // 不可见字符是透明分隔：词表词内部插入（pass­word）剥除后必须命中 —— 这正是目的
  assert.equal(matchesRiskPatterns('pass\u00ADword', ''), true);
  // 硬边界词的邻接判定读原文真实邻接字符（位置映射穿透剥除）：
  assert.equal(matchesRiskPatterns('pin\u00ADcode', ''), true, 'pin+软连字符+code：软连字符折叠为空 = 非词内字符 ⇒ 边界干净');
  assert.equal(matchesRiskPatterns('xp\u00ADin', ''), false, 'x 前缀粘词不得因软连字符洗白');
  assert.equal(matchesRiskPatterns('typ\u00ADing', ''), false, 'typing 中插软连字符不得命中 pin');
  assert.equal(matchesDangerPatterns('co\u00ADnfirm order', ''), true, 'confirm 内插软连字符 + 空格分写');
  assert.equal(matchesDangerPatterns('preset', ''), false, '对照：无不可见字符的既有收窄不回摆');
});

test('ΠΑΝ-9 §8: 混合攻击栈（同形字+软连字符+leet+全角）纵深穿透', () => {
  assert.equal(matchesRiskPatterns('pаss\u00ADw0rd', ''), true, '西里尔 а + 软连字符 + leet 0');
  assert.equal(matchesRiskPatterns('ｓｅｃ\uFE0Fｒｅｔ', ''), true, '全角 + VS16 拼 secret');
  assert.equal(matchesDangerPatterns('ｓｅ\u2060ｎｄ 订单', ''), true, '全角 + 词连接符拼 send');
});

test('ΠΑΝ-9 §8: 纯不可见/极端不可见输入绝不抛（布尔收敛）', () => {
  const hostile = [
    '\u00AD'.repeat(300), '\u2060\u2061\u2062\u2063\u2064'.repeat(60),
    '\u{E0100}'.repeat(80), '\uFE0F'.repeat(500), 'pa\u0301ss'.repeat(200),
    'pass\u00ADword'.repeat(150), '\uFEFF\u200B\u200C\u200D'.repeat(100),
  ];
  for (const t of hostile) {
    for (const csv of ['', 'pin,token,密码', 'send,删除']) {
      assert.equal(typeof matchesRiskPatterns(t, csv), 'boolean', `绝不抛: ${JSON.stringify(t.slice(0, 12))} @ ${csv}`);
      assert.equal(typeof matchesDangerPatterns(t, csv), 'boolean');
    }
  }
  assert.equal(matchesRiskPatterns('\u00AD'.repeat(50), ''), false, '纯不可见归一为空 ⇒ 不命中');
});
