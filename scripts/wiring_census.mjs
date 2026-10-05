#!/usr/bin/env node
// scripts/wiring_census.mjs —— 装配完备性执法器（ΠΑΝ-38 wiring census）
//
// ΠΑΝ-38: 立法背景 —— 批判报告 C2-7（主题一）/C2-9（主题 1）证实：全库 942 个导出函数
// 中 233 个（24.8%）零生产调用（armReversalEscrow / promoteFrom / setAccessibilityProvider /
// clearBlockers / mergeSimilarTypes / escalateProbeLatch / armSkillFederationPersistence /
// escrow.sweep ……），而 3044 个测试全部从注入端口进 —— "器官精良、躯体缺位"整类不可见：
// 测试纪律防得住器官内回归，防不住器官失联（组合根缺位发生在"没有那行文本"的地方，
// 源码 regex 取证在原理上找不到"缺席之物的缺席"）。本脚本把「接线完整性」从口头债务
// 铸成机械闸 —— 本项目性价比最高的单点改进，把治理从"写了什么"扩展到"通没通电"：
//
//   · 静态普查 src/ 全部值导出（export function/const/let/var/class/enum，含 re-export
//     桶穿透到最终定义源），构建跨模块引用索引（regex 解析相对导入、剥 .js 后缀、
//     index.ts 回退 —— scripts/cycle_lint.mjs 同族解析器，保长剥注释/字符串盲区安全）；
//   · 判定「生产调用」= 被非测试文件（src/，不含定义文件自身）以值导入且正文存在引用
//     （import type / 仅 re-export 不算 —— 导出 ≠ 通电；w8.arch 的 bindSteerSessionFactory
//     源码断言是本闸范式的孤例，此处推广到全部导出面）；
//   · 方法级重点名单：arm*/wire*/attach*/configure*/register* 等 14 个接线动词前缀的
//     对象/类方法（promoteFrom / clearBlockers / escrow.sweep 这类"导出对象的方法"面，
//     顶层导出扫描覆盖不到的层）；
//   · 豁免册制度（scripts/wiring-census.exemptions.json）：每个零调用导出必须显式登记
//     豁免理由，无理由即红（--check exit 1）；已接线/已消失的册条目 = 幽灵，同样红
//     （r29 豁免册"册不留幽灵条目"同律 —— 修掉一个在册差异 ⇒ 同步删条目）。
//
// 口径与边界（诚实声明）：
//   · 直接引用口径 —— 不做传递可达性闭包（C2-9 主题 1 自身的方法论）；传递死码
//     （只被死器官引用的辅助面）不在本闸射程内。
//   · 值导入但仅类型位置消费 ⇒ 计 wired（保守向绿：宁可漏报孤儿，绝不误红）。
//   · 方法名全域普查：同名方法跨对象合并为一家族，任一生产文件 `.name` 引用即全家族
//     wired；解构消费（const {m} = obj）不计 —— 已知近似，注释在 judgeMethodSurface。
//   · src/index.ts 直定义导出 = 宿主入口面（宿主经 dist/index.js 消费，dsh.plugin.json
//     entry）—— 规则自动豁免，不入册。
//   · 确定性输出：无时间戳、全排序、同树同果（build_manifest 同律）。
//
// 用法：
//   node scripts/wiring_census.mjs --check              # 执法（默认）：未豁免孤儿/幽灵 ⇒ exit 1
//   node scripts/wiring_census.mjs --json               # 结构化机读面（确定性，零时长字段）
//   node scripts/wiring_census.mjs --register-current   # 迁移期：按当前状态整册重写豁免册
//                                                       # （册已存在须加 --force；人工理由仅
//                                                       # KNOWN_ORPHANS 内建条目可在重写中幸存）
//   npm run wiring:census
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// ═══════════════════════ 名词表与常量 ═══════════════════════

// ΠΑΝ-38: 重点接线动词 —— 组合根注册面的命名方言（C2-7 主题一：export arm*/wire*/
// attach*/set* 共 44 个接线函数；C2-9 主题 1 的方法级孤儿 promoteFrom/clearBlockers/
// escalateProbeLatch/mergeSimilarTypes/enforce*/sweep*/calibrate* 全部落在这张动词表上）。
export const FOCUS_VERBS = [
  'arm', 'wire', 'attach', 'configure', 'register', 'set', 'reset', 'clear',
  'promote', 'escalate', 'merge', 'enforce', 'sweep', 'calibrate',
];
export const WIRING_VERB_RE = new RegExp('^(?:' + FOCUS_VERBS.join('|') + ')[A-Z_]');
// ΠΑΝ-38: 动词名单外的批判点名方法 —— reversalEscrow.sweep()（C2-9 主题 1 A 级：
// TTL 补偿巡检零调用 ⇒ inFlightPlans 无界累积）。bare 名 'sweep' 不含大写边界，
// 显式补入（'set'/'clear' 等 Map 常用 bare 名刻意不收 —— 误报淹没信号）。
export const EXTRA_METHOD_NAMES = ['sweep'];

// ΠΑΝ-38: 豁免类别（枚举执法 —— 册内类别非法即红）
export const CATEGORIES = ['unwired-organ', 'test-only', 'internal-surface', 'reserved-api', 'tool-only', 'dead-code'];
export const CATEGORY_LABELS = {
  'unwired-organ': '未通电器官（批判点名，待接线）',
  'test-only': '测试专用面（仅测试宇宙消费）',
  'internal-surface': '文件内部消费（导出面冗余）',
  'reserved-api': '预留 API（代码注释自证）',
  'tool-only': '仅工具链消费（scripts/）',
  'dead-code': '全库零引用（dead-code 待删）',
};

// ΠΑΝ-38: 批判点名条目（C2-7 主题一 / C2-9 主题 1）—— 人工豁免理由的单源。
// --register-current 整册重写时这些理由幸存；其余按扫描证据自动分类。
const KNOWN_ORPHANS = {
  'src/reversalEscrow.ts::armReversalEscrow': ['unwired-organ',
    'C2-7 §1.1 / C2-9 主题1 A 级：S1 逆转托管组合根挂点零生产调用 —— dispatchGate/settlement/sweep/persist 四条命脉悬空，fireEscrowSettlement 每次危险点击发射而钩子恒 null 静默 no-op。接线=index.ts 一行调用。'],
  'src/kernel/registry.ts::promoteFrom': ['unwired-organ',
    'C2-7 §1.2 / C2-9 主题1 A 级：kernel 进化闭环最后一环（方法级）。productionSpecs 立法"换值仅经 gym→显式 promoteFrom"，但全库无工具/CLI/钩子走到 —— gym 校准产物永滞实验室。'],
  'src/uiExtractor.ts::setAccessibilityProvider': ['unwired-organ',
    'C2-7 §1.3：element-ID 模式依赖启动期 provider 注入，组合根无调用 ⇒ enableElementIdMode=true 在任何部署都不可能工作（takeScreenshot 静默降级 elements=[]，四个下游消费端恒空）。'],
  'src/skillFederation.ts::armSkillFederationPersistence': ['unwired-organ',
    'C2-7 §1.4：联邦技能账持久化臂零生产调用（对照同域 armFederationTrustPersistence 已在 index.ts 接线）—— 遗漏而非设计：生产上联邦技能账纯内存，进程退出即蒸发。'],
  'src/autonomy/goalState.ts::clearBlockers': ['unwired-organ',
    'C2-9 主题1 A 级（方法级）：降级 spec 生而 blocked + resume 原样重铸 ⇒ 续跑死循环；清障面零调用。'],
  'src/knowledge/worldModel.ts::mergeSimilarTypes': ['unwired-organ',
    'C2-9 主题1 A 级（方法级）：世界模型类型无界增长的唯一治理面（typeOf 新屏即铸 screen-N 无容量无驱逐）零调用。'],
  // 注：ΠΑΝ-38 施工期间（首跑普查时点）接线潮已落地：armReversalEscrow（index.ts 组合根
  // 挂点）、promoteFrom（kernel/index.ts 晋升通道）、escalateProbeLatch（knowledge/
  // pipeline）、escrow.sweep —— 四者现判 wired，不入册、无幽灵；若未来被拆线重成孤儿，
  // 再登记时适用下列批判理由。
  'src/ltlf.ts::enforceMinedProperties': ['unwired-organ',
    'C2-9 主题1 A 级：LTLf 时序性质只挖不执法 —— ltlf 消费方 rollbackPlanner/observabilityTools 只用挖掘与上报面。'],
  'src/failureMemory.ts::configureFailureMemory': ['unwired-organ',
    'C2-9 主题1 B 级：失败记忆容量配置面 —— config.ts 无对应字段，生产不可配。'],
  'src/diagnosis.ts::calibrateCptFromRules': ['reserved-api',
    'C2-9 主题1 B 级：CPT 标定换血制度从未接生产数据流（数据血缘：oracle 可审计，真实遥测流接入点=替换 oracle —— M 纪元 patcher 自述）。'],
  'src/diagnosis.ts::calibrateCptFromTelemetry': ['reserved-api',
    'C2-9 主题1 B 级：CPT 遥测标定面，真实遥测流未接。'],
  'src/diagnosis.ts::observeSignalsForCalibration': ['reserved-api',
    'C2-9 主题1 B 级：标定观测面，生产数据流未接。'],
  'src/approval.ts::resetApproval': ['unwired-organ',
    'C2-9 主题 2：热重载卸载链漏清审批域全部状态（pending/grantBucket/确认码通道）—— reset 全库零生产调用，仅 w2queue 测试 beforeEach 调用恰好掩盖。'],
  'src/physicalExecution/httpClient.ts::setUndiciBridge': ['reserved-api',
    'C2-7 §1.5（低危）：宿主桥臂（ΑΩ-R3"宿主桥最优先"）在本仓部署不可达 —— undici 动态 import 臂仍活。宿主如注入则活。'],
};

// ═══════════════════════ 文本预处理（保长变换 —— 各扫描面共享坐标） ═══════════════════════

// ΠΑΝ-38: 单遍状态机预处理 —— cycle_lint.mjs 解析器思路的强化移植。cycle_lint 的已知
// 盲区：正则字面量不识别（/['"]/g 内的引号会把状态机踢进字符串态、吞掉后续真实代码
// —— 本仓实跑证实：src/autonomy/runtime.ts 的 judgeRoiOcr 调用点曾因此被抹空成假孤儿）。
// 本实现全感知四类词法域：行/块注释、单双引号字符串、模板字面量（${} 插值帧栈带花括号
// 深度，嵌套模板正确）、正则字面量（前一显著字符/关键字判 regex vs 除法 —— 经典 JS
// tokenizer 启发式）。输出两张同长坐标的文本：
//   code  —— 注释/正则抹空，字符串保留（导入 specifier 要读）；
//   blank —— 注释/正则/字符串全部抹空（正文绑定引用扫描面：字符串内同名文本不算引用）。
// stringSpans —— 字符串/模板字面量段区间（code 面上"字符串内伪 import"的排除依据）。
const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '<', '>', '+', '-', '*', '%', '^', '~', "'", '"', '`', '/']);
const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

export function preprocess(text) {
  const n = text.length;
  const a = text.split(''); // code 变体
  const b = text.split(''); // blank 变体
  const stringSpans = [];
  let mode = 'code'; // code | interp | tmpl | line | block | sq | dq | regex
  const frames = []; // 模板帧栈：{type:'tmpl'} | {type:'interp', depth}
  let prevSig = '';
  let curWord = '';
  let prevWord = '';
  let spanStart = -1;   // 当前字符串/模板文本段起点（blank 抹空 + span 记录）
  let segStart = -1;    // 当前模板文本段起点（span 记录，插值边界闭合）
  let classDepth = 0;   // 正则字符类深度
  let i = 0;
  const blank1 = (pos) => { b[pos] = text[pos] === '\n' ? '\n' : ' '; };
  const commitWord = () => { if (curWord) { prevWord = curWord; curWord = ''; } };
  while (i < n) {
    const c = text[i];
    const nx = i + 1 < n ? text[i + 1] : '';
    if (mode === 'code' || mode === 'interp') {
      if (c === '/' && nx === '/') {
        mode = 'line'; a[i] = a[i + 1] = ' '; blank1(i); blank1(i + 1); i += 2; continue;
      }
      if (c === '/' && nx === '*') {
        mode = 'block'; a[i] = a[i + 1] = ' '; blank1(i); blank1(i + 1); i += 2; continue;
      }
      if (c === "'" || c === '"') {
        mode = c === "'" ? 'sq' : 'dq'; spanStart = i; blank1(i); commitWord(); prevSig = c; i++; continue;
      }
      if (c === '`') {
        frames.push({ type: 'tmpl' }); mode = 'tmpl'; spanStart = segStart = i; blank1(i); commitWord(); prevSig = c; i++; continue;
      }
      if (c === '/') {
        const isRegex = prevSig === '' || REGEX_PRECEDERS.has(prevSig) || KEYWORDS_BEFORE_REGEX.has(prevWord);
        if (isRegex) { mode = 'regex'; classDepth = 0; a[i] = ' '; blank1(i); prevSig = '/'; commitWord(); i++; continue; }
        prevSig = '/'; commitWord(); i++; continue;
      }
      if (c === '{' && mode === 'interp') { frames[frames.length - 1].depth++; prevSig = c; commitWord(); i++; continue; }
      if (c === '}' && mode === 'interp') {
        const f = frames[frames.length - 1];
        if (f.depth > 0) { f.depth--; prevSig = c; commitWord(); i++; continue; }
        // 插值闭合：记录模板文本段 span（含 `${` 前段已闭），回到模板文本态
        frames.pop();
        mode = 'tmpl';
        segStart = i; // 新文本段从 } 之后开始（} 本身抹空）
        blank1(i);
        prevSig = c; commitWord(); i++; continue;
      }
      if (/[A-Za-z0-9_$]/.test(c)) curWord += c;
      else commitWord();
      if (!/\s/.test(c)) prevSig = c;
      i++; continue;
    }
    if (mode === 'line') {
      if (c === '\n') mode = frames.length && frames[frames.length - 1].type === 'interp' ? 'interp' : (frames.length ? 'tmpl' : 'code');
      else { a[i] = ' '; blank1(i); }
      i++; continue;
    }
    if (mode === 'block') {
      if (c === '*' && nx === '/') { a[i] = a[i + 1] = ' '; blank1(i); blank1(i + 1); mode = frames.length && frames[frames.length - 1].type === 'interp' ? 'interp' : (frames.length ? 'tmpl' : 'code'); i += 2; continue; }
      a[i] = c === '\n' ? '\n' : ' '; blank1(i);
      i++; continue;
    }
    if (mode === 'sq' || mode === 'dq') {
      blank1(i);
      if (c === '\\') { blank1(i + 1); i += 2; continue; }
      if (c === '\n') { // 未闭合字符串（病态）—— 就地放弃，防吞后续代码
        stringSpans.push([spanStart, i]); spanStart = -1; mode = frames.length && frames[frames.length - 1].type === 'interp' ? 'interp' : (frames.length ? 'tmpl' : 'code'); i++; continue;
      }
      if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"')) {
        stringSpans.push([spanStart, i + 1]); spanStart = -1;
        mode = frames.length && frames[frames.length - 1].type === 'interp' ? 'interp' : (frames.length ? 'tmpl' : 'code');
      }
      i++; continue;
    }
    if (mode === 'tmpl') {
      blank1(i);
      if (c === '\\') { blank1(i + 1); i += 2; continue; }
      if (c === '`') {
        frames.pop();
        if (segStart >= 0) { stringSpans.push([segStart, i + 1]); segStart = -1; }
        if (spanStart >= 0) spanStart = -1;
        mode = frames.length && frames[frames.length - 1].type === 'interp' ? 'interp' : (frames.length ? 'tmpl' : 'code');
        if (mode === 'code' || mode === 'interp') prevSig = '`';
        i++; continue;
      }
      if (c === '$' && nx === '{') {
        if (segStart >= 0) { stringSpans.push([segStart, i]); segStart = -1; } // 闭掉 ${ 前的文本段
        frames.push({ type: 'interp', depth: 0 });
        mode = 'interp';
        blank1(i + 1);
        prevSig = '{';
        i += 2; continue;
      }
      i++; continue;
    }
    if (mode === 'regex') {
      a[i] = ' '; blank1(i);
      if (c === '\\') { a[i + 1] = ' '; blank1(i + 1); i += 2; continue; }
      if (c === '[') classDepth++;
      else if (c === ']') classDepth = Math.max(0, classDepth - 1);
      else if (c === '/' && classDepth === 0) {
        // 消费 flag 字母（g/i/m/s/u/d/y）
        let j = i + 1;
        while (j < n && /[a-z]/.test(text[j])) { a[j] = ' '; blank1(j); j++; }
        mode = frames.length && frames[frames.length - 1].type === 'interp' ? 'interp' : (frames.length ? 'tmpl' : 'code');
        i = j; continue;
      } else if (c === '\n') {
        // 病态：跨行未闭合 —— 退回代码态（把这次误判限制在单行内）
        mode = frames.length && frames[frames.length - 1].type === 'interp' ? 'interp' : (frames.length ? 'tmpl' : 'code');
      }
      i++; continue;
    }
    i++;
  }
  return { code: a.join(''), blank: b.join(''), stringSpans };
}

function makeSpanGuard(spans) {
  // spans 升序；二分判定位置是否落在字符串区间内
  return function inString(pos) {
    let lo = 0, hi = spans.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [s, e] = spans[mid];
      if (pos < s) hi = mid - 1;
      else if (pos >= e) lo = mid + 1;
      else return true;
    }
    return false;
  };
}

// ═══════════════════════ 模块解析（纯函数：file + text → 结构面） ═══════════════════════

const IDENT = '[A-Za-z_$][\\w$]*';

/** 解析 `{ a, type b, c as d, default as e }` 子句 → [{imported, local, typeOnly}] */
function parseSpecs(inner) {
  const specs = [];
  for (let part of inner.split(',')) {
    part = part.trim();
    if (!part) continue;
    let typeOnly = false;
    if (/^type\s+/.test(part)) { typeOnly = true; part = part.replace(/^type\s+/, '').trim(); }
    const asM = part.match(new RegExp('^(' + IDENT + ')(?:\\s+as\\s+)(' + IDENT + '|default)$'));
    if (asM) specs.push({ imported: asM[1], local: asM[2], typeOnly });
    else if (new RegExp('^' + IDENT + '$').test(part)) specs.push({ imported: part, local: part, typeOnly });
    // 其余形态（解构残渣等）静默丢弃 —— 保守少报
  }
  return specs;
}

/** ΠΑΝ-38: 多声明符 export const/let/var 扫描 —— `export const a = 1, b = f(a);` 里 b 也是值导出。
 *  在抹串文本上做（字符串内逗号不干扰）；<> 深度计入（泛型注解 Map<string, number> 的顶层
 *  逗号不是声明符分隔符）；'=>' 跳过（箭头函数的 > 不闭合角度深度）。
 *  抗幻影护栏：比较运算符 < / > 会腐蚀角度深度 ⇒ 偶发假"顶层逗号"—— 故顶层逗号后
 *  必须紧跟 `IDENT =` 才认定为下一声明符（对象字面量属性 `, key: v` / 方法 `, m(...)` 全被拒）。 */
function scanDeclarators(blankText, start, kind) {
  const names = [];
  let i = start;
  const n = blankText.length;
  const stopAhead = /^\s*(?:export\b|import\b|function\b|class\b|interface\b|enum\b|declare\b|type\b|async\b|const\b|let\b|var\b|@|[})\]])/;
  const nextDecl = new RegExp('^\\s*' + IDENT + '\\s*=');
  let guard = 0;
  while (i < n && guard++ < 64) {
    while (i < n && /\s/.test(blankText[i])) i++;
    const idm = new RegExp('^' + IDENT).exec(blankText.slice(i, i + 64));
    if (!idm) break; // 解构导出等罕见形态 —— 放弃（保守少报）
    names.push({ name: idm[0], kind });
    i += idm[0].length;
    let depth = 0;
    let advanced = false;
    while (i < n) {
      const ch = blankText[i];
      const nx = i + 1 < n ? blankText[i + 1] : '';
      if (ch === '=' && nx === '>') { i += 2; advanced = true; continue; }
      if (ch === '(' || ch === '[' || ch === '{' || ch === '<') { depth++; i++; advanced = true; continue; }
      if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) return names; depth--; i++; advanced = true; continue; }
      if (ch === '>') { if (depth > 0) depth--; i++; advanced = true; continue; }
      if (ch === ',' && depth === 0) {
        if (!nextDecl.test(blankText.slice(i + 1, i + 80))) return names; // 假顶层逗号（深度腐蚀）—— 语句终结
        i++;
        break;
      }
      if (ch === ';' && depth === 0) return names;
      if (ch === '\n' && depth === 0 && !advanced) {
        if (stopAhead.test(blankText.slice(i + 1, i + 26))) return names;
      }
      if (ch !== '\n' && !/\s/.test(ch)) advanced = true;
      i++;
    }
  }
  return names;
}

/** ΠΑΝ-38: 单模块解析 —— 声明面（值导出）/ 导入面（值/类型区分、别名、命名空间、
 *  动态解构）/ 正文（剥注释+抹串+抹 import/export 语句后的引用扫描面）。
 *  纯函数：不做磁盘 IO、不做跨模块解析（那是 buildExportTable 的职责）。 */
export function parseModule(file, text) {
  const { code, blank, stringSpans: strSpans } = preprocess(text);
  const inString = makeSpanGuard(strSpans);
  const spans = []; // 需从正文抹除的语句区间（import/export-from/裸 import/动态 import 赋值）
  const namedImports = []; // { rawSpec, imported, local, typeOnly }
  const nsImports = [];    // { rawSpec, local }
  const defaultImports = []; // { rawSpec, local }
  const decls = [];        // [{ name, kind }] —— 值导出声明（普查宇宙的一等公民）
  const exportLists = [];  // [{ specs:[{local, exported}], rawSpec|null, typeOnly }]
  const stars = [];        // [rawSpec] —— export * from
  const nsReexports = [];  // [{ rawSpec, exported }] —— export * as ns from

  // ① import/export … from '…'（跨行子句；命中字符串内伪语句由 inString 排除）
  const fromRe = new RegExp('\\b(import|export)\\s+([^;\'`]*?)\\s*from\\s*([\'"])([^\'"]+)\\3', 'g');
  let m;
  while ((m = fromRe.exec(code)) !== null) {
    if (inString(m.index)) continue;
    const kw = m[1];
    const clause = m[2];
    const rawSpec = m[4];
    const wholeEnd = m.index + m[0].length;
    spans.push([m.index, wholeEnd]);
    const nsAs = clause.match(new RegExp('\\*\\s*as\\s+(' + IDENT + ')'));
    if (kw === 'export' && nsAs) { nsReexports.push({ rawSpec, exported: nsAs[1] }); continue; }
    if (kw === 'export' && clause.replace(/\s+/g, '') === '*') { stars.push(rawSpec); continue; }
    const brace = clause.match(/\{([^}]*)\}/);
    const before = brace ? clause.slice(0, brace.index) : clause;
    const clauseIsType = /^\s*type[\s{]/.test(clause); // import type … / export type …
    if (kw === 'import') {
      const def = before.split(',')[0].trim().replace(/^type\s+/, '');
      if (def && def !== '*' && !clauseIsType && new RegExp('^' + IDENT + '$').test(def)) {
        defaultImports.push({ rawSpec, local: def, typeOnly: false });
      }
      if (nsAs) nsImports.push({ rawSpec, local: nsAs[1] });
      if (brace) {
        for (const s of parseSpecs(brace[1])) {
          if (clauseIsType) s.typeOnly = true;
          namedImports.push({ rawSpec, imported: s.imported, local: s.local, typeOnly: s.typeOnly });
        }
      }
    } else if (brace) {
      // export { a as b } from './x' —— re-export 桶（穿透到定义源在 table 阶段）
      exportLists.push({
        specs: parseSpecs(brace[1]).map((s) => ({ local: s.imported, exported: s.local, typeOnly: s.typeOnly })),
        rawSpec, typeOnly: clauseIsType,
      });
    }
  }

  // ② 裸副作用 import './x'
  const bareRe = /\bimport\s*(['"])([^'"]+)\1/g;
  while ((m = bareRe.exec(code)) !== null) {
    if (inString(m.index)) continue;
    spans.push([m.index, m.index + m[0].length]);
  }

  // ③ 动态 import（运行时值边）：const m = await import('./x')（命名空间绑定）/
  //    const { a, b: c } = await import('./x')（命名绑定）
  const dynNsRe = new RegExp('\\b(?:const|let|var)\\s+(' + IDENT + ')\\s*=\\s*(?:await\\s+)?import\\s*\\(\\s*([\'"])([^\'"]+)\\2\\s*\\)', 'g');
  while ((m = dynNsRe.exec(code)) !== null) {
    if (inString(m.index)) continue;
    nsImports.push({ rawSpec: m[3], local: m[1] });
    spans.push([m.index, m.index + m[0].length]);
  }
  const dynNamedRe = new RegExp('\\b(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*(?:await\\s+)?import\\s*\\(\\s*([\'"])([^\'"]+)\\2\\s*\\)', 'g');
  while ((m = dynNamedRe.exec(code)) !== null) {
    if (inString(m.index)) continue;
    for (const s of parseSpecs(m[1])) namedImports.push({ rawSpec: m[3], imported: s.imported, local: s.local, typeOnly: false });
    spans.push([m.index, m.index + m[0].length]);
  }

  // ④ 值导出声明（普查宇宙）：function / class / enum / const|let|var（多声明符）
  const fnRe = new RegExp('\\bexport\\s+(?:async\\s+)?function\\s*\\*?\\s+(' + IDENT + ')', 'g');
  while ((m = fnRe.exec(code)) !== null) {
    if (!inString(m.index)) decls.push({ name: m[1], kind: 'function' });
  }
  const clsRe = new RegExp('\\bexport\\s+(?:abstract\\s+)?class\\s+(' + IDENT + ')', 'g');
  while ((m = clsRe.exec(code)) !== null) {
    if (!inString(m.index)) decls.push({ name: m[1], kind: 'class' });
  }
  const enumRe = new RegExp('\\bexport\\s+(?:const\\s+)?enum\\s+(' + IDENT + ')', 'g');
  while ((m = enumRe.exec(code)) !== null) {
    if (!inString(m.index)) decls.push({ name: m[1], kind: 'enum' });
  }
  const constRe = /\bexport\s+(const|let|var)\s/g;
  while ((m = constRe.exec(blank)) !== null) {
    if (inString(m.index)) continue;
    decls.push(...scanDeclarators(blank, m.index + m[0].length, m[1]));
  }

  // ⑤ 本地值声明全集（含非导出 —— export { x } 后置列表的解析回退面）与其 kind
  const localNames = new Set(decls.map((d) => d.name));
  const declKinds = new Map(decls.map((d) => [d.name, d.kind]));
  const KW = { function: 'function', class: 'class', const: 'const', let: 'let', var: 'var', enum: 'enum' };
  const anyDeclRe = new RegExp('(?:^|\\n)[ \\t]*(?:export\\s+|declare\\s+)*(?:async\\s+)?(?:(function)\\s*\\*?\\s+|(class)\\s+|(const)\\s+|(let)\\s+|(var)\\s+|(enum)\\s+)(' + IDENT + ')', 'g');
  while ((m = anyDeclRe.exec(blank)) !== null) {
    const kind = KW[[m[1], m[2], m[3], m[4], m[5], m[6]].find(Boolean)];
    localNames.add(m[7]);
    if (!declKinds.has(m[7])) declKinds.set(m[7], kind); // 导出声明的 kind 优先
  }

  // ⑥ 本地导出列表 export { a, b as c }（无 from —— fromRe 已消费带 from 的形态）
  const listRe = /\bexport\s*\{([^}]*)\}/g;
  const taken = (pos) => spans.some(([s, e]) => pos >= s && pos < e);
  while ((m = listRe.exec(code)) !== null) {
    if (inString(m.index) || taken(m.index)) continue;
    exportLists.push({ specs: parseSpecs(m[1]).map((s) => ({ local: s.imported, exported: s.local, typeOnly: s.typeOnly })), rawSpec: null, typeOnly: false });
    spans.push([m.index, m.index + m[0].length]);
  }

  // ⑦ 正文：抹串文本上抹去全部 import/export 语句 → 绑定引用扫描面
  const chars = blank.split('');
  for (const [s, e] of spans) for (let i = s; i < e && i < chars.length; i++) chars[i] = ' ';
  const bodyText = chars.join('');

  // ⑧ 方法级定义（动词名单）：对象字面量速记法 / 类方法（含返回类型注解 `): Foo {`）/
  //    属性式（name: fn|arrow）。从 '(' 平衡扫描到匹配 ')' 再前瞻 '{'/'=>' ——
  //    调用语句（`foo(x);` 的 ';' 先于 '{'）被拒，不误入宇宙。
  const methodDefs = new Set();
  const methodStartRe = new RegExp('(?:^|[{,;\\n])[ \\t]*(?:async\\s+)?(' + IDENT + ')\\s*(?:<[^<>(){}]*>)?\\s*\\(', 'g');
  while ((m = methodStartRe.exec(bodyText)) !== null) {
    const name = m[1];
    if (!(WIRING_VERB_RE.test(name) || EXTRA_METHOD_NAMES.includes(name))) continue;
    let depth = 0;
    let i = m.index + m[0].length - 1; // 位于 '('
    let closed = -1;
    while (i < bodyText.length) {
      const ch = bodyText[i];
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) { closed = i; break; } }
      else if (ch === ';') break; // 跨语句 —— 放弃
      i++;
    }
    if (closed < 0) continue;
    const head = bodyText.slice(closed + 1, Math.min(closed + 1 + 200, bodyText.length));
    if (/^[^;]*\{/.test(head) || /=>/.test(head.split(';')[0])) methodDefs.add(name);
  }
  const propMethodRe = new RegExp('(?:^|[{,;\\n])[ \\t]*(?:async\\s+)?(' + IDENT + ')\\s*:\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*=>|' + IDENT + '\\s*=>)', 'g');
  while ((m = propMethodRe.exec(bodyText)) !== null) {
    const name = m[1];
    if (WIRING_VERB_RE.test(name) || EXTRA_METHOD_NAMES.includes(name)) methodDefs.add(name);
  }

  // ⑨ 属性引用集（方法家族 usage 面）：\.name / ?.name
  const propRefs = new Set();
  const propRe = /\.([A-Za-z_$][\w$]*)/g;
  while ((m = propRe.exec(bodyText)) !== null) propRefs.add(m[1]);

  return {
    file, code, bodyText, decls, declKinds, localNames, exportLists, stars, nsReexports,
    namedImports, nsImports, defaultImports, methodDefs, propRefs,
  };
}

// ═══════════════════════ 路径解析（相对导入 → 仓库内规范键） ═══════════════════════

function toPosix(p) { return p.replace(/\\/g, '/'); }

/** ΠΑΝ-38: 相对 specifier → 模块规范键（posix 相对仓库根）。剥 .js/.mjs 后缀、
 *  .ts 显式后缀直通、index 回退 —— cycle_lint resolveSpec 同律（knownFiles 注入，
 *  纯函数可测）。包导入/外域 → null。 */
export function resolveSpecPath(fromFile, spec, knownFiles) {
  if (typeof spec !== 'string' || (!spec.startsWith('.') && !spec.startsWith('/'))) return null;
  const base0 = toPosix(join(toPosix(dirname(fromFile)), spec));
  const cands = [];
  if (/\.ts$/.test(base0)) cands.push(base0);
  else if (/\.(js|mjs|cjs)$/.test(base0)) {
    const b2 = base0.replace(/\.(js|mjs|cjs)$/, '');
    cands.push(b2 + '.ts', b2 + '.mjs', b2 + '/index.ts');
  } else cands.push(base0 + '.ts', base0 + '/index.ts', base0 + '.mjs');
  for (const c of cands) if (knownFiles.has(c)) return c;
  return null;
}

// ═══════════════════════ 导出表（re-export 桶穿透 → 最终定义源） ═══════════════════════

/** 构建 Map<file, Map<exportName, origin>>；origin = { file, name, kind }（穿透到定义源）
 *  | { external: true }（命名空间 re-export / 不可穿透）| undefined（类型或未解析 —— 不入普查）。
 *  惰性 DFS + 记忆化 + 环守卫（export * 环上返回 undefined，保守少报）。 */
export function buildExportTable(modules, knownFiles) {
  const targets = new Map(); // module → Map<rawSpec, resolvedKey|null>
  const targetOf = (mod, rawSpec) => {
    if (!targets.has(mod)) targets.set(mod, new Map());
    const cache = targets.get(mod);
    if (!cache.has(rawSpec)) cache.set(rawSpec, resolveSpecPath(mod, rawSpec, knownFiles));
    return cache.get(rawSpec);
  };
  const memo = new Map(); // file::name → origin
  const resolveEntry = (file, name, stack) => {
    const key = file + '::' + name;
    if (memo.has(key)) return memo.get(key);
    if (stack.includes(file)) return undefined; // re-export 环
    const mod = modules.get(file);
    if (!mod) return undefined;
    const nextStack = [...stack, file];
    let result;
    const decl = mod.decls.find((d) => d.name === name);
    if (decl) result = { file, name, kind: decl.kind };
    for (const list of mod.exportLists) {
      if (result) break;
      const spec = list.specs.find((s) => s.exported === name);
      if (!spec || spec.typeOnly || list.typeOnly) continue;
      if (list.rawSpec !== null) {
        const t = targetOf(file, list.rawSpec);
        result = t ? resolveEntry(t, spec.local, nextStack) : { external: true };
      } else {
        // 本地列表：同名声明 → 导入绑定 → 非导出本地声明 → 放弃（类型面）
        if (mod.localNames.has(spec.local)) result = { file, name: spec.local, kind: mod.declKinds.get(spec.local) ?? 'unknown' };
        const ni = mod.namedImports.find((n) => n.local === spec.local && !n.typeOnly);
        if (!result && ni) {
          const t = targetOf(file, ni.rawSpec);
          result = t ? resolveEntry(t, ni.imported, nextStack) : { external: true };
        }
        const di = mod.defaultImports.find((d) => d.local === spec.local);
        if (!result && di) {
          const t = targetOf(file, di.rawSpec);
          result = t ? resolveEntry(t, 'default', nextStack) : { external: true };
        }
      }
    }
    if (!result) {
      for (const rawSpec of mod.stars) {
        const t = targetOf(file, rawSpec);
        if (!t || name === 'default') continue;
        const r = resolveEntry(t, name, nextStack);
        if (r) { result = r; break; }
      }
    }
    if (!result) {
      const nre = mod.nsReexports.find((n) => n.exported === name);
      if (nre) result = { external: true };
    }
    memo.set(key, result);
    return result;
  };
  const table = new Map();
  for (const file of [...modules.keys()].sort()) {
    const mod = modules.get(file);
    const names = new Set([
      ...mod.decls.map((d) => d.name),
      ...mod.exportLists.flatMap((l) => l.specs.map((s) => s.exported)),
      ...mod.nsReexports.map((n) => n.exported),
    ]); // star 面名集不可枚举 —— 依赖 lookup 的惰性穿透兜底
    const t = new Map();
    for (const name of [...names].sort()) t.set(name, resolveEntry(file, name, []));
    table.set(file, t);
  }
  // star 面兜底：导入方查 table(target) 命不中时，对 star 桶做一次穿透尝试（惰性）
  return {
    table,
    lookup(file, name) {
      const t = table.get(file);
      if (!t) return undefined;
      if (t.has(name)) return t.get(name);
      const mod = modules.get(file);
      if (!mod) return undefined;
      for (const rawSpec of mod.stars) {
        const tgt = targetOf(file, rawSpec);
        if (!tgt || name === 'default') continue;
        const r = resolveEntry(tgt, name, [file]);
        if (r) { t.set(name, r); return r; }
      }
      t.set(name, undefined);
      return undefined;
    },
  };
}

function declKindOf(mod, name) {
  return mod.decls.find((d) => d.name === name)?.kind ?? mod.declKinds.get(name);
}

// ═══════════════════════ 角色与普查判定 ═══════════════════════

/** ΠΑΝ-38: 文件角色 —— src/=生产（组合根宇宙）、test/+bench/=测试宇宙、scripts/=工具链。
 *  测试宇宙的引用不构成"通电"，但计入分类证据（测试专用面）。 */
export function roleOf(path) {
  if (path.startsWith('src/')) return 'prod';
  if (path.startsWith('test/') || path.startsWith('bench/')) return 'test';
  if (path.startsWith('scripts/')) return 'tool';
  return 'other';
}

const refReCache = new Map();
function countRefs(bodyText, name) {
  // 绑定引用：词边界 + 排除属性位（.name / obj.name 是成员访问，不是绑定引用；
  // { name: … } 是属性键）—— 保守向"不算引用"
  let re = refReCache.get(name);
  if (!re) { re = new RegExp('(?<![\\w$.])' + name + '(?![\\w$])(?!\\s*:)', 'g'); refReCache.set(name, re); }
  const matches = bodyText.match(re);
  return matches ? matches.length : 0;
}

function hasRef(bodyText, name) {
  return countRefs(bodyText, name) > 0;
}

/** ΠΑΝ-38: 普查主判定 —— 全部值导出的接线状态 + 方法级动词面。
 *  wired = 存在生产文件（≠定义文件）值导入且正文有引用；import type 不算、
 *  re-export 桶穿透（导出 ≠ 通电）；src/index.ts 直定义 = host-entry 自动豁免。 */
export function judgeCensus(modules, graph) {
  // ── 引用索引：originKey → Map<userFile, role> ──
  const knownFiles = new Set(modules.keys());
  const usages = new Map();
  const addUsage = (origin, userFile) => {
    if (!origin || origin.external) return;
    const key = origin.file + '::' + origin.name;
    if (!usages.has(key)) usages.set(key, new Map());
    usages.get(key).set(userFile, roleOf(userFile));
  };
  for (const file of [...modules.keys()].sort()) {
    const mod = modules.get(file);
    for (const ni of mod.namedImports) {
      if (ni.typeOnly) continue;
      const t = resolveSpecPath(file, ni.rawSpec, knownFiles);
      if (!t) continue;
      const origin = graph.lookup(t, ni.imported);
      if (origin && !origin.external && hasRef(mod.bodyText, ni.local)) addUsage(origin, file);
    }
    for (const di of mod.defaultImports) {
      const t = resolveSpecPath(file, di.rawSpec, knownFiles);
      if (!t) continue;
      const origin = graph.lookup(t, 'default');
      if (origin && !origin.external && hasRef(mod.bodyText, di.local)) addUsage(origin, file);
    }
    for (const ns of mod.nsImports) {
      const t = resolveSpecPath(file, ns.rawSpec, knownFiles);
      if (!t) continue;
      // 命名空间成员按绑定精确提取：\bns\.member —— 不用全文件属性集（obj.x 会误连）
      const memberRe = new RegExp('\\b' + ns.local + '\\s*\\.\\s*(' + IDENT + ')', 'g');
      let mm;
      while ((mm = memberRe.exec(mod.bodyText)) !== null) {
        const origin = graph.lookup(t, mm[1]);
        if (origin && !origin.external) addUsage(origin, file);
      }
    }
  }
  // ── 普查宇宙：穿透后的定义源去重 —— ΠΑΝ-38 只普查 src/ 生产面（插件本体）；
  //    test/bench/scripts 的导出是消费宇宙的一部分，不是被执法对象 ──
  const seen = new Map(); // originKey → { file, name, kind }
  const inScope = (f) => f.startsWith('src/');
  for (const file of [...graph.table.keys()].sort()) {
    for (const [name, origin] of graph.table.get(file)) {
      if (!origin || origin.external || !inScope(origin.file)) continue;
      const key = origin.file + '::' + origin.name;
      if (!seen.has(key)) seen.set(key, { file: origin.file, name: origin.name, kind: origin.kind });
    }
  }
  // lookup 兜底命中的 star 穿透项同样入宇宙
  for (const key of usages.keys()) {
    if (!seen.has(key)) {
      const [f, n] = key.split('::');
      if (!inScope(f)) continue;
      const mod = modules.get(f);
      const kind = mod ? declKindOf(mod, n) : undefined;
      if (kind) seen.set(key, { file: f, name: n, kind });
    }
  }

  const entries = [];
  for (const key of [...seen.keys()].sort()) {
    const e = seen.get(key);
    if (!e.kind || e.kind === 'unknown') continue; // 解析不出值声明形态 —— 保守不入普查
    const users = usages.get(key) ?? new Map();
    const prodUsers = [...users.entries()].filter(([f, r]) => r === 'prod' && f !== e.file).map(([f]) => f);
    const testUsers = [...users.entries()].filter(([, r]) => r === 'test').map(([f]) => f);
    const toolUsers = [...users.entries()].filter(([, r]) => r === 'tool').map(([f]) => f);
    const internalRefs = countRefs(modules.get(e.file)?.bodyText ?? '', e.name);
    const focus = WIRING_VERB_RE.test(e.name);
    let status;
    let subcategory = null;
    if (prodUsers.length > 0) status = 'wired';
    else if (e.file === 'src/index.ts') status = 'host-entry'; // 宿主经 dist/index.js 消费（dsh.plugin.json entry）
    else {
      status = 'orphan';
      subcategory = testUsers.length ? 'test-only' : internalRefs >= 2 ? 'internal-surface' : toolUsers.length ? 'tool-only' : 'dead-code';
    }
    entries.push({
      id: key, file: e.file, name: e.name, kind: e.kind, focus, status, subcategory,
      internalRefs, prodUsers, testUsers, toolUsers,
    });
  }

  // ── 方法级动词面（名字域家族普查 —— 诚实近似，见文件头"口径与边界"；仅 src/ 定义面） ──
  const methodNames = new Set();
  for (const mod of modules.values()) {
    if (!inScope(mod.file)) continue;
    for (const n of mod.methodDefs) methodNames.add(n);
  }
  const methods = [];
  for (const name of [...methodNames].sort()) {
    const definers = [...modules.values()].filter((mod) => inScope(mod.file) && mod.methodDefs.has(name)).map((mod) => mod.file).sort();
    const prodUsers = [];
    const testUsers = [];
    for (const mod of modules.values()) {
      if (!mod.propRefs.has(name)) continue;
      const role = roleOf(mod.file);
      if (role === 'prod' && !definers.includes(mod.file)) prodUsers.push(mod.file);
      if (role === 'test') testUsers.push(mod.file);
    }
    const internal = definers.some((f) => modules.get(f)?.propRefs.has(name));
    const status = prodUsers.length > 0 ? 'wired' : 'orphan';
    methods.push({
      id: definers[0] + '::' + name, file: definers[0], name, kind: 'method',
      definers, status,
      subcategory: status === 'orphan' ? (testUsers.length ? 'test-only' : internal ? 'internal-surface' : 'dead-code') : null,
      internalRefs: internal ? 1 : 0, prodUsers, testUsers, toolUsers: [],
    });
  }
  return { entries, methods, usages };
}

// ═══════════════════════ 豁免册 ═══════════════════════

/** ΠΑΝ-38: 豁免册对账 —— 册内每条必须命中当前真孤儿（幽灵即红，r29"册不留幽灵"同律）；
 *  当前每个孤儿必须在册（无理由即红）。返回 { exempted, unregistered, ghosts, invalid }。 */
export function applyLedger(censusEntries, ledgerEntries) {
  const orphans = censusEntries.filter((e) => e.status === 'orphan');
  const orphanIds = new Set(orphans.map((e) => e.id));
  const ledgerMap = new Map();
  const invalid = [];
  for (const raw of ledgerEntries ?? []) {
    const entry = typeof raw === 'object' && raw !== null ? raw : null;
    const id = entry ? entry.file + '::' + entry.name : '(malformed)';
    const problems = [];
    if (!entry || typeof entry.file !== 'string' || typeof entry.name !== 'string') problems.push('结构非法（file/name 缺失）');
    if (entry && !CATEGORIES.includes(entry.category)) problems.push(`类别非法: ${String(entry.category)}`);
    if (entry && (typeof entry.reason !== 'string' || entry.reason.trim().length === 0)) problems.push('理由缺失（无理由即红）');
    if (ledgerMap.has(id)) problems.push('重复条目');
    if (problems.length > 0) invalid.push({ id, problems });
    else ledgerMap.set(id, entry);
  }
  const exempted = [];
  const unregistered = [];
  for (const o of orphans) {
    const led = ledgerMap.get(o.id);
    if (led) exempted.push({ ...o, category: led.category, reason: led.reason });
    else unregistered.push(o);
  }
  const ghosts = [];
  for (const [id, led] of ledgerMap) {
    if (!orphanIds.has(id)) {
      const current = censusEntries.find((e) => e.id === id);
      ghosts.push({
        id, file: led.file, name: led.name, category: led.category,
        now: current ? current.status : 'vanished', // wired / host-entry / vanished（改名或删除）
      });
    }
  }
  ghosts.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { exempted, unregistered, ghosts, invalid };
}

/** ΠΑΝ-38: 迁移期分类推断 —— 人工点名表(KNOWN_ORPHANS) > 代码注释预留标记 > 引用证据。
 *  理由必须是有据陈述（扫描证据或批判引文），不编造。 */
const RESERVED_MARKER_RE = /预留|保留|未来|后续|待接线|wiring next|TODO|FIXME|reserved|planned|下一步|暂不|尚未|占位/;

export function inferExemption(entry, vfs) {
  const known = KNOWN_ORPHANS[entry.id];
  if (known) return { category: known[0], reason: known[1] };
  // 代码注释推断：定义点上方 3 行原文中的预留标记
  if (vfs && vfs.has(entry.file)) {
    const raw = vfs.get(entry.file);
    const lines = raw.split('\n');
    const re = entry.kind === 'method'
      ? new RegExp('[{;\\n]\\s*(?:async\\s+)?' + entry.name + '\\s*\\(')
      : new RegExp('\\b(?:export\\s+)?(?:async\\s+)?(?:function|const|let|var|class|enum)\\s+' + entry.name + '\\b');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        const ctx = lines.slice(Math.max(0, i - 3), i).join(' ');
        const mk = ctx.match(RESERVED_MARKER_RE);
        if (mk) {
          return { category: 'reserved-api', reason: `定义点注释自证预留（标记"${mk[0]}"）—— 尚未接线的外来面；接线落地后删本条。` };
        }
        break;
      }
    }
  }
  const evid = (arr, k = 3) => arr.slice(0, k).join('、') + (arr.length > k ? ` 等 ${arr.length} 处` : '');
  if (entry.subcategory === 'test-only') {
    return { category: 'test-only', reason: `仅测试宇宙消费（${evid(entry.testUsers)}）—— 器官自带电源测试的注入面；组合根零调用（C2-9 主题 1：测试纪律防得住器官内回归，防不住器官失联）。` };
  }
  if (entry.subcategory === 'internal-surface') {
    return { category: 'internal-surface', reason: `仅本文件内部引用（${entry.internalRefs - 1} 处正文引用）—— 导出面冗余但实现活（同文件消费方在用）；收编为私有导出或接线后删本条。` };
  }
  if (entry.subcategory === 'tool-only') {
    return { category: 'tool-only', reason: `仅工具链消费（${evid(entry.toolUsers)}）—— 生产组合根未接线。` };
  }
  return { category: 'dead-code', reason: '全库零引用（含测试宇宙与工具链）—— dead-code 待删，或接线后删本条。' };
}

// ═══════════════════════ 普查编排（纯函数：vfs + 豁免册 → 完整结果） ═══════════════════════

/** ΠΑΝ-38: runCensus —— 全流程纯函数（磁盘无关，测试可注入合成树）。
 *  vfs: Map<规范键, 源文本>；ledger: { entries: [...] } | null。确定性：全排序、零时间戳。 */
export function runCensus(vfs, ledger) {
  const modules = new Map();
  const keys = [...vfs.keys()].sort();
  for (const k of keys) modules.set(k, parseModule(k, vfs.get(k)));
  const knownFiles = new Set(modules.keys());
  const graph = buildExportTable(modules, knownFiles);
  const { entries, methods } = judgeCensus(modules, graph);
  const all = [...entries, ...methods].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ledgerResult = applyLedger(all, ledger ? ledger.entries : []);
  const orphans = all.filter((e) => e.status === 'orphan');
  const wired = all.filter((e) => e.status === 'wired');
  const hostEntry = all.filter((e) => e.status === 'host-entry');
  const focusAll = all.filter((e) => e.focus || e.kind === 'method');
  const categoryCount = {};
  for (const e of ledgerResult.exempted) categoryCount[e.category] = (categoryCount[e.category] ?? 0) + 1;
  const kindCount = {};
  for (const e of all) kindCount[e.kind] = (kindCount[e.kind] ?? 0) + 1;
  return {
    summary: {
      scannedFiles: modules.size,
      prodFiles: keys.filter((k) => roleOf(k) === 'prod').length,
      testFiles: keys.filter((k) => roleOf(k) === 'test').length,
      toolFiles: keys.filter((k) => roleOf(k) === 'tool').length,
      symbolsTotal: all.length,
      kindCount,
      wiredCount: wired.length,
      orphanCount: orphans.length,
      hostEntryCount: hostEntry.length,
      focusTotal: focusAll.length,
      focusWired: focusAll.filter((e) => e.status === 'wired').length,
      focusOrphan: focusAll.filter((e) => e.status === 'orphan').length,
      exemptedCount: ledgerResult.exempted.length,
      exemptionRate: orphans.length === 0 ? 1 : ledgerResult.exempted.length / orphans.length,
      categoryCount,
      unregisteredCount: ledgerResult.unregistered.length,
      ghostCount: ledgerResult.ghosts.length,
      invalidCount: ledgerResult.invalid.length,
    },
    entries: all,
    ...ledgerResult,
  };
}

// ═══════════════════════ 渲染（确定性） ═══════════════════════

function pct(x) { return (x * 100).toFixed(1) + '%'; }

export function renderReport(r) {
  const s = r.summary;
  const L = [];
  L.push('接线普查（ΠΑΝ-38 装配完备性执法器 wiring census）');
  L.push(`  扫描: ${s.prodFiles} 生产文件(src/) · ${s.testFiles} 测试宇宙(test/+bench/) · ${s.toolFiles} 工具链(scripts/)`);
  L.push(`  普查宇宙: ${s.symbolsTotal} 值导出符号（function ${s.kindCount.function ?? 0} / const ${s.kindCount.const ?? 0} / let-var ${((s.kindCount.let ?? 0) + (s.kindCount.var ?? 0))} / class ${s.kindCount.class ?? 0} / enum ${s.kindCount.enum ?? 0} / method(动词面) ${s.kindCount.method ?? 0}）`);
  L.push(`  接线: ${s.wiredCount} wired（${pct(s.wiredCount / s.symbolsTotal)}）· ${s.orphanCount} orphan · ${s.hostEntryCount} host-entry(宿主入口自动豁免)`);
  L.push(`  重点接线面（${FOCUS_VERBS.join('*/')}* 动词 + 方法级）: ${s.focusWired} wired / ${s.focusOrphan} orphan`);
  const cats = CATEGORIES.filter((c) => s.categoryCount[c]).map((c) => `${c} ${s.categoryCount[c]}`).join(' · ');
  L.push(`  豁免册: ${s.exemptedCount}/${s.orphanCount} 在册（豁免率 ${pct(s.exemptionRate)}）${cats ? '；分类: ' + cats : ''}`);
  L.push(`  迁移（相对豁免册基线）: 新增未登记孤儿 ${s.unregisteredCount} · 幽灵条目 ${s.ghostCount} · 非法条目 ${s.invalidCount}`);
  if (r.invalid.length > 0) {
    L.push('');
    L.push(`✖ 豁免册非法条目 ${r.invalid.length}（结构/类别/理由）：`);
    for (const e of r.invalid) L.push(`  ${e.id} —— ${e.problems.join('；')}`);
  }
  if (r.unregistered.length > 0) {
    L.push('');
    L.push(`✖ 未豁免孤儿 ${r.unregistered.length}（新孤儿必须接线，或在豁免册登记理由）：`);
    for (const o of r.unregistered) {
      const usage = o.subcategory === 'test-only' ? `（仅测试: ${(o.testUsers.slice(0, 2).join('、'))}${o.testUsers.length > 2 ? '…' : ''}）` : o.subcategory === 'internal-surface' ? '（仅本文件内部引用）' : o.subcategory === 'tool-only' ? '（仅工具链）' : '（全库零引用）';
      L.push(`  ${o.file} → ${o.name} [${o.kind}] 生产零调用 ${usage}`);
    }
  }
  if (r.ghosts.length > 0) {
    L.push('');
    L.push(`✖ 豁免册幽灵条目 ${r.ghosts.length}（已接线/已消失 —— 修掉在册差异须同步删条目，r29 同律）：`);
    for (const g of r.ghosts) L.push(`  ${g.id} [${g.category}] 当前状态: ${g.now}`);
  }
  L.push('');
  const bad = s.unregisteredCount + s.ghostCount + s.invalidCount;
  if (bad === 0) L.push(`✔ 装配完备性执法通过：孤儿 ${s.orphanCount} 个全部在册，豁免册无幽灵、无非法条目`);
  else L.push(`✖ 装配完备性执法失败：${bad} 项红灯（未登记 ${s.unregisteredCount} / 幽灵 ${s.ghostCount} / 非法 ${s.invalidCount}）—— exit 1`);
  return L.join('\n');
}

export function renderJson(r) {
  const out = {
    summary: r.summary,
    unregistered: r.unregistered.map((e) => ({ id: e.id, file: e.file, name: e.name, kind: e.kind, subcategory: e.subcategory })),
    ghosts: r.ghosts,
    invalid: r.invalid,
    exempted: r.exempted.map((e) => ({ id: e.id, file: e.file, name: e.name, kind: e.kind, category: e.category })),
  };
  return JSON.stringify(out, null, 2);
}

/** ΠΑΝ-38: 迁移期整册生成 —— 当前全部孤儿按 inferExemption 登记（含人工点名理由）。
 *  只生成对象不落盘（落盘是 CLI 胶水职责）。 */
export function bootstrapLedger(r, vfs) {
  const entries = r.entries
    .filter((e) => e.status === 'orphan')
    .map((e) => {
      const { category, reason } = inferExemption(e, vfs);
      const base = { file: e.file, name: e.name, kind: e.kind, category, reason };
      if (e.kind === 'method') base.definers = e.definers;
      return base;
    })
    .sort((a, b) => (a.file + '::' + a.name < b.file + '::' + b.name ? -1 : 1));
  return {
    meta: {
      wave: 'ΠΑΝ-38',
      note: '装配完备性执法器豁免册 —— 每条 = 一个当前零生产调用的导出/方法与其豁免理由。' +
        '执法纪律：新孤儿必须接线或登记（无理由即红）；条目对应的孤儿被接线/删除后必须同步删除本条（幽灵即红，r29 册不留幽灵同律）。' +
        '类别枚举: ' + CATEGORIES.join(' | ') + '。生成: node scripts/wiring_census.mjs --register-current（确定性，无时间戳）。',
    },
    entries,
  };
}

// ═══════════════════════ CLI 胶水（invoked 守卫 —— 被 import 时不触发执法） ═══════════════════════

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const EXEMPTIONS_PATH = join(REPO, 'scripts', 'wiring-census.exemptions.json');

/** 磁盘 vfs 收集（只读）：src 全部 .ts（跳过 .d.ts）+ test/bench 的 .ts/.mjs + scripts 的 .mjs */
export function collectVfs(root) {
  const vfs = new Map();
  const walk = (dir, exts) => {
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names.sort()) {
      if (name === 'node_modules' || name === '__pycache__' || name === 'fixtures') continue;
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, exts);
      else if (exts.some((ext) => name.endsWith(ext)) && !name.endsWith('.d.ts')) {
        vfs.set(toPosix(relative(root, p)), readFileSync(p, 'utf8'));
      }
    }
  };
  walk(join(root, 'src'), ['.ts']);
  walk(join(root, 'test'), ['.ts', '.mjs']);
  walk(join(root, 'bench'), ['.ts', '.mjs']);
  walk(join(root, 'scripts'), ['.mjs']);
  return vfs;
}

function main() {
  const argv = process.argv.slice(2);
  const wantsJson = argv.includes('--json');
  const register = argv.includes('--register-current');
  const force = argv.includes('--force');
  const vfs = collectVfs(REPO);
  let ledger = null;
  if (existsSync(EXEMPTIONS_PATH)) {
    try {
      ledger = JSON.parse(readFileSync(EXEMPTIONS_PATH, 'utf8'));
    } catch (err) {
      console.error(`✖ 豁免册 JSON 解析失败: ${err.message}`);
      process.exit(1);
    }
  }
  if (register) {
    if (ledger && !force) {
      console.error('✖ 豁免册已存在 —— --register-current 会整册重写（人工新增理由会丢失，仅 KNOWN_ORPHANS 内建理由幸存）。确认请加 --force。');
      process.exit(1);
    }
    const boot = bootstrapLedger(runCensus(vfs, null), vfs);
    const text = JSON.stringify(boot, null, 2) + '\n';
    writeFileSync(EXEMPTIONS_PATH, text, 'utf8');
    console.log(`已按当前状态整册登记豁免: ${boot.entries.length} 条 → scripts/wiring-census.exemptions.json（此后新孤儿即红）`);
    return;
  }
  const result = runCensus(vfs, ledger);
  if (wantsJson) {
    console.log(renderJson(result));
  } else {
    console.log(renderReport(result));
  }
  const bad = result.summary.unregisteredCount + result.summary.ghostCount + result.summary.invalidCount;
  process.exit(bad > 0 ? 1 : 0);
}

// ΠΑΝ-38: invoked 守卫 —— 纯函数核心被 test/w0wiring.census.test.ts import 时不触发 CLI
const invoked = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked) main();
