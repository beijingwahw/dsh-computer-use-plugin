// test/no29.bilingual.test.ts
// ΝΩ-29 执法点：跨语系语义盲区修复 —— 零依赖双语词表桥。
// 四组防线：
//   1. 数据完整性（防手误）：无重复键、无自映射、键 CJK 1~3 字、值小写规范、
//      工单点名对逐条在册、反义不互串（移除→remove ≠ 添加）；
//   2. 中英对齐：中文意图 vs 英文 UI 的 cosine 实测钉阈值（各阈值注释实测值，
//      留 8%~12% 余量防表微调导致抖动）；
//   3. 同语系零回归：无映射命中的输入，embed 输出与旧实现（本文件内复刻）逐字节相同；
//   4. 透传与零异常：未命中 token 原样、非数组/非字符串宽收不抛。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BILINGUAL_PAIRS, LOOKUP, toEnglish } from '../src/dialects/bilingual.ts';
import { tokenize } from '../src/uiMemory.ts';
import { embed, cosine } from '../src/semanticHash.ts';

// ─── 1. 数据完整性执法 ─────────────────────────────────────────────────

test('ΝΩ-29 词表规模与键唯一（重复键在构建期即被 Map 吞并，此处必须抓获）', () => {
  assert.ok(BILINGUAL_PAIRS.length >= 250 && BILINGUAL_PAIRS.length <= 400,
    `映射对数应在 250~400（工单目标 300±），实际 ${BILINGUAL_PAIRS.length}`);
  assert.equal(LOOKUP.size, BILINGUAL_PAIRS.length, '存在重复键 —— Map 只留最后值，源表必须唯一');
  assert.equal(new Set(BILINGUAL_PAIRS.map(([k]) => k)).size, BILINGUAL_PAIRS.length);
});

test('ΝΩ-29 键值形态：键为 1~3 个 CJK 表意字符；值全小写、单空格分隔、无自映射', () => {
  const cjk = /^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]{1,3}$/;
  const val = /^[a-z0-9]+( [a-z0-9]+)*$/;
  for (const [k, v] of BILINGUAL_PAIRS) {
    assert.ok(cjk.test(k), `键越界（须 1~3 个 CJK 字符）: ${k}`);
    assert.ok(val.test(v), `值越界（须小写 ASCII、单空格分隔）: ${k} -> ${v}`);
    assert.notEqual(k, v, '禁止自映射');
  }
});

test('ΝΩ-29 工单点名映射逐条在册（含整理→filter 工单指定项）', () => {
  const required: Array<[string, string]> = [
    ['保存', 'save'], ['取消', 'cancel'], ['删除', 'delete'], ['编辑', 'edit'],
    ['发送', 'send'], ['搜索', 'search'], ['筛选', 'filter'], ['整理', 'filter'],
    ['排序', 'sort'], ['复制', 'copy'], ['粘贴', 'paste'], ['剪切', 'cut'],
    ['撤销', 'undo'], ['重做', 'redo'], ['关闭', 'close'], ['打开', 'open'],
    ['设置', 'settings'], ['帮助', 'help'], ['登录', 'login'], ['登出', 'logout'],
    ['注册', 'register'], ['提交', 'submit'], ['确认', 'confirm'], ['下载', 'download'],
    ['上传', 'upload'], ['刷新', 'refresh'], ['重试', 'retry'], ['返回', 'back'],
    ['下一步', 'next'], ['上一步', 'previous'], ['主页', 'home'], ['菜单', 'menu'],
    ['标签', 'tab'], ['窗口', 'window'], ['文件', 'file'], ['文件夹', 'folder'],
    ['视图', 'view'], ['插入', 'insert'], ['格式', 'format'], ['工具', 'tool'],
    ['账户', 'account'], ['密码', 'password'], ['用户名', 'username'], ['邮箱', 'email'],
    ['分享', 'share'], ['打印', 'print'], ['缩放', 'zoom'], ['选择', 'select'],
    ['清空', 'clear'], ['重置', 'reset'], ['应用', 'apply'], ['安装', 'install'],
    ['更新', 'update'], ['移除', 'remove'], ['添加', 'add'], ['播放', 'play'],
    ['暂停', 'pause'], ['停止', 'stop'], ['静音', 'mute'],
    ['按钮', 'button'], ['链接', 'link'], ['复选框', 'checkbox'], ['下拉', 'dropdown'],
    ['列表', 'list'], ['表格', 'table'], ['对话框', 'dialog'], ['弹窗', 'popup'],
    ['侧栏', 'sidebar'], ['工具栏', 'toolbar'], ['地址', 'address'],
    ['栏', 'bar'], ['页', 'page'], ['项', 'item'], ['域', 'field'],
  ];
  for (const [k, v] of required) assert.equal(LOOKUP.get(k), v, `工单点名对缺失/漂移: ${k} -> ${v}`);
});

test('ΝΩ-29 反义执法：移除→remove、添加→add，互不串位', () => {
  assert.equal(LOOKUP.get('移除'), 'remove');
  assert.equal(LOOKUP.get('添加'), 'add');
  assert.notEqual(LOOKUP.get('移除'), 'add', 'remove 语义键不得映射到 add');
  assert.notEqual(LOOKUP.get('添加'), 'remove', 'add 语义键不得映射到 remove');
});

// ─── 2. 中英对齐（阈值 = 实测值下浮 8%~12%）───────────────────────────

test('ΝΩ-29 中英对齐：中文意图 vs 英文 UI 跨语系 cosine 显著非零', () => {
  const cos = (a: string, b: string): number => cosine(embed(a), embed(b));
  // 实测 0.2599：'保存'→save 桥通，但 click/button 等同句桥词稀释夹角
  assert.ok(cos('点击保存按钮', 'Save') > 0.25, `实测 ${cos('点击保存按钮', 'Save')}`);
  // 实测 0.5327：动作+对象双词全对齐
  assert.ok(cos('点击保存按钮', 'Save button') > 0.5, `实测 ${cos('点击保存按钮', 'Save button')}`);
  // 实测 0.7845：工单指定桥 '整理'→'filter' 后与英文共享全部 n-gram（残存单字整/理稀释）
  assert.ok(cos('整理', 'filter') > 0.7, `实测 ${cos('整理', 'filter')}`);
  // 实测 0.6757
  assert.ok(cos('筛选数据', 'filter data') > 0.6, `实测 ${cos('筛选数据', 'filter data')}`);
  // 实测 0.5156：三字词经交叠 bigram 对还原（下一+一步→下一步）
  assert.ok(cos('点击下一步按钮', 'Next button') > 0.45, `实测 ${cos('点击下一步按钮', 'Next button')}`);
  // 实测 0.7140
  assert.ok(cos('关闭弹窗', 'Close popup') > 0.65, `实测 ${cos('关闭弹窗', 'Close popup')}`);
  // 实测 0.7518
  assert.ok(cos('登录', 'Login') > 0.7, `实测 ${cos('登录', 'Login')}`);
});

test('ΝΩ-29 语义邻居不越狱：无关跨语系对仍为 0（盲区修复不制造假阳性）', () => {
  assert.equal(cosine(embed('打开浏览器'), embed('Save')), 0);
  assert.equal(cosine(embed('天气预报'), embed('Delete file')), 0);
  // 桥后自身仍是单位向量（norm 与 dims 同源）
  const v = embed('点击保存按钮');
  assert.ok(Math.abs(cosine(v, v) - 1) < 1e-9);
});

// ─── 3. 同语系零回归（旧 embed 逐字节复刻对照）────────────────────────

/** 旧实现复刻：ΝΩ-29 接桥前的 embed（tokenize → n-gram，无桥）—— 执法基准 */
function legacyEmbed(text: string): { dims: Array<[number, number]>; norm: number } {
  function fnv1a(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  function ngrams(token: string): string[] {
    const out: string[] = [];
    if (token.length <= 4) { out.push(token); return out; }
    for (let n = 2; n <= 4; n++) for (let i = 0; i <= token.length - n; i++) out.push(token.slice(i, i + n));
    return out;
  }
  const buckets = new Map<number, number>();
  for (const token of tokenize(text)) {
    const tb = fnv1a(token);
    buckets.set(tb, (buckets.get(tb) ?? 0) + 1.0);
    for (const g of ngrams(token)) {
      const b = fnv1a('§' + g);
      buckets.set(b, (buckets.get(b) ?? 0) + 0.5);
    }
  }
  const dims = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([b, w]): [number, number] => [b, Math.round(w * 1000) / 1000]);
  let sq = 0;
  for (const [, w] of dims) sq += w * w;
  return { dims, norm: Math.sqrt(sq) };
}

test('ΝΩ-29 同语系零回归：无桥命中输入的 embed 输出与旧实现逐字节相同', () => {
  // 语料选取：纯英文（键全 CJK ⇒ 结构性零命中）+ 无桥词中文/混合（先自检零命中再执法）
  const corpus = [
    'sort the data by column header',
    'The quick brown fox jumps over the lazy dog',
    'login failed please retry the request later',
    '天气预报今日晴朗微风',
    '量子计算比特纠缠',
    '股票大盘走势强劲反弹',
    'quantum 纠缠 computing 纬度',
    '',
  ];
  for (const s of corpus) {
    const tk = tokenize(s);
    assert.deepEqual(toEnglish(tk), tk, `语料含桥命中，零回归前提被破坏: ${s}`);
    assert.equal(JSON.stringify(embed(s)), JSON.stringify(legacyEmbed(s)),
      `逐字节漂移: ${JSON.stringify(s)}`);
  }
});

// ─── 4. 透传与零异常 ───────────────────────────────────────────────────

test('ΝΩ-29 toEnglish：命中替换、多词值拆分、未命中原样透传', () => {
  assert.deepEqual(toEnglish(['保存', 'zephyr', '量子']), ['save', 'zephyr', '量子']);
  assert.deepEqual(toEnglish(['保存']), ['save']);
  assert.deepEqual(toEnglish([]), []);
  // 三字词经交叠 bigram 对还原；相邻但不还原的交叠对原样透传
  assert.deepEqual(toEnglish(['下', '一', '步', '下一', '一步']), ['下', '一', '步', 'next']);
  assert.deepEqual(toEnglish(['统', '一', '步', '统一', '一步']), ['统', '一', '步', '统一', '一步']);
  // 多词值按空格拆分（与英文原生分词粒度对齐）；三字键优先于其二字前缀键
  assert.deepEqual(toEnglish(['地址', '址栏']), ['address', 'bar']);
  // embed 全管线：中文句桥后包含英文 token
  const bridged = toEnglish(tokenize('点击保存按钮'));
  for (const w of ['click', 'save', 'button']) assert.ok(bridged.includes(w), `缺 ${w}`);
  assert.ok(!bridged.includes('保存'));
});

test('ΝΩ-29 运行层零异常：宽收非数组/非字符串入参', () => {
  assert.doesNotThrow(() => toEnglish(null as unknown as string[]));
  assert.doesNotThrow(() => toEnglish(undefined as unknown as string[]));
  assert.doesNotThrow(() => toEnglish([1, {}, '保存'] as unknown as string[]));
  assert.deepEqual(toEnglish([1, {}, '保存'] as unknown as string[]), ['save']);
});
