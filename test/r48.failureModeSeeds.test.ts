// test/r48.failureModeSeeds.test.ts
// R4-8 执法册 —— 实战失败模式固化进记忆系统（预置注入）的验收：
//   ① 知识档（knowledge/failure-modes-r4-8.json，D-7 exportSnapshot v1 形状）可被
//     InMemoryKnowledgeBase.restoreSnapshot 水合，且 5 类情境检索各自命中对应条目
//     （BM25 词法 + 语义向量 hybrid —— 离线单测要求：检索「菜单」情境命中菜单条目）。
//   ② 反技能种子（knowledge/failure-memory-seeds-r4-8.json canonical）可被
//     failureMemory.restore 水合，match 同样命中（score2 > 相关性闸门 0.2）。
//   ③ 真实生产装载路径：canonical 种子嵌入 checkpoint v4 档 → loadCheckpoint
//     防御性恢复（缺段 SKIPPED 不连坐、failureMemory: OK）→ 装载后 match_skill
//     同型检索命中菜单种子 —— 这正是 checkpointPath 配置后下次宿主启动的路径。
//   ④ 部署档漂移守卫：~/.dsh/plugin-memory/computer-use-checkpoint.json 在场时，
//     其 failureMemory.records 与仓内 canonical 逐字节一致（部署拷贝由 canonical
//     生成；缺席机器跳过 —— 本守卫只在本部署机上执法）。
// 全程离线、确定性（零网络零真 IO 副作用 —— loadCheckpoint 只读临时档）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';

import { InMemoryKnowledgeBase } from '../src/knowledge/knowledgeBase.ts';
import { failureMemory, type FailureRecord } from '../src/failureMemory.ts';
import { loadCheckpoint } from '../src/checkpoint.ts';
import { uiMemory } from '../src/uiMemory.ts';
import { skillLibrary } from '../src/skillLibrary.ts';
import { telemetry } from '../src/telemetry.ts';
import { journal } from '../src/journal.ts';

const REPO = join(import.meta.dirname, '..');
const KB_ARCHIVE = join(REPO, 'knowledge', 'failure-modes-r4-8.json');
const FM_SEEDS = join(REPO, 'knowledge', 'failure-memory-seeds-r4-8.json');
const DEPLOYED_CP = join(homedir(), '.dsh', 'plugin-memory', 'computer-use-checkpoint.json');
/** 种子铸造时刻（2026-10-05T12:00:00+08:00 —— 与数据档内 at/updatedAt 一致的单源） */
const SEED_AT = 1_791_172_800_000;

const dirs: string[] = [];
beforeEach(() => {
  uiMemory.reset();
  failureMemory.reset();
  skillLibrary.reset();
  telemetry.reset();
  journal.reset();
});

// ═══ ① 知识档：水合 + 五情境检索各自命中 ═══

test('K-1: D-7 知识档水合成功，5 条 error-pattern 入库（manual 主权 + 亲证 + 90 天半衰期）', () => {
  const snap = JSON.parse(readFileSync(KB_ARCHIVE, 'utf8'));
  const kb = new InMemoryKnowledgeBase();
  const r = kb.restoreSnapshot(snap);
  assert.ok(r.ok, `restoreSnapshot 拒绝: ${r.ok ? '' : r.error.field + ':' + r.error.reason}`);
  const entries = kb.snapshot();
  assert.equal(entries.length, 5);
  for (const e of entries) {
    assert.equal(e.category, 'error-pattern');
    assert.equal(e.source, 'manual', '造物主主权（容量驱逐豁免）');
    assert.ok(e.content.length <= 500, `content ≤500 结构律（实测 ${e.content.length}）`);
    assert.ok(e.verifiedAt !== undefined, 'R1-8 取证亲证在场');
    assert.equal(e.halfLifeMs, 90 * 24 * 3_600_000, '模型行为型模式 90 天半衰期');
    assert.equal(e.usageCount, 0);
  }
  // 证据来源在册：每条 content 必须引用报告路径（可追溯性）
  for (const e of entries) assert.match(e.content, /R1-8\.md|R3-6\.md|R3-4\.md|R2-4\.md/);
});

test('K-2: 知识检索 —— 5 类实战情境各自命中对应条目（菜单/同坐标/盲打/脚本旁路/zoom）', () => {
  const kb = new InMemoryKnowledgeBase();
  assert.ok(kb.restoreSnapshot(JSON.parse(readFileSync(KB_ARCHIVE, 'utf8'))).ok);
  const cases: Array<{ tag: string; scene: string; intent: string; want: string }> = [
    {
      tag: '菜单未开即点菜单项（R1-8 主败因）',
      scene: '记事本窗口，文件菜单栏可见但下拉未展开',
      intent: '点击文件菜单的另存为菜单项，把文件保存到指定路径',
      want: 'kb-r48-001-menu-not-open',
    },
    {
      tag: '同坐标重复点击',
      scene: '点击某个按钮后屏幕没有任何变化',
      intent: '同一个坐标已经点过两次都没效果，还要再点吗',
      want: 'kb-r48-002-coordinate-inertia',
    },
    {
      tag: '对话框未确认即盲打',
      scene: '刚点了另存为，不确定对话框是否弹出',
      intent: '直接输入文件路径并回车保存',
      want: 'kb-r48-003-blind-type-enter',
    },
    {
      tag: '受挫后脚本旁路螺旋',
      scene: '视觉点击一直失败，模型开始写 pwsh 脚本',
      intent: '用 SendKeys/UIA 脚本模拟键盘鼠标完成保存',
      want: 'kb-r48-004-script-bypass-spiral',
    },
    {
      tag: 'zoom 后不消费新坐标',
      scene: '用 zoom_inspect 放大看了小目标的位置',
      intent: '接下来用什么坐标点击它',
      want: 'kb-r48-005-zoom-not-consumed',
    },
  ];
  for (const c of cases) {
    const q = kb.query({ sceneDescription: c.scene, intentDescription: c.intent, maxResults: 5 });
    assert.ok(q.ok, `query 失败: ${c.tag}`);
    const rank = q.value.entries.findIndex(e => e.id === c.want) + 1;
    assert.equal(rank, 1, `[${c.tag}] 期望 ${c.want} 居首，实际序: ${q.value.entries.map(e => e.id).join(',')}`);
    assert.ok(q.value.entries[0].confidence > 0.5, '有效置信度（遗忘曲线出口）仍高于可用线');
  }
});

// ═══ ② 反技能种子：failureMemory 水合 + match 命中 ═══

test('K-3: failureMemory 种子水合 5 条；match 五情境命中且过相关性闸门（score2>0.2）', () => {
  const seeds = JSON.parse(readFileSync(FM_SEEDS, 'utf8'));
  failureMemory.restore(seeds);
  assert.equal(failureMemory.size, 5);
  assert.equal(seeds.records.filter((r: { rootCause?: string }) => r.rootCause === 'blind-spot-text').length, 2,
    '仅鉴别探针可归因处标病因（1/3），其余诚实 unknown');
  const cases: Array<{ q: string; wantId: number }> = [
    { q: '记事本 文件菜单 另存为 菜单项 点击', wantId: 1 },
    { q: '同一坐标 重复点击 没有 效果', wantId: 2 },
    { q: '对话框 输入 路径 回车', wantId: 3 },
    { q: 'pwsh SendKeys 脚本 模拟 键鼠', wantId: 4 },
    { q: 'zoom 放大 坐标 点击', wantId: 5 },
  ];
  for (const c of cases) {
    const hits = failureMemory.match(c.q, undefined, 5);
    assert.ok(hits.length > 0, `[${c.q}] 零召回`);
    assert.equal(hits[0].id, c.wantId, `[${c.q}] 期望种子 #${c.wantId} 居首，实际 ${hits.map(h => h.id).join(',')}`);
    // match 的签名只声明 score；score2（legacy 加权和 = R-6 相关性闸门的执法域）
    // 在运行时随对象返回 —— 经加宽读取（与实现逐字对应，不重复推导）。
    const score2 = (hits[0] as FailureRecord & { score: number; score2?: number }).score2 ?? 0;
    assert.ok(score2 > 0.2, `[${c.q}] score2=${score2} 须过 R-6 相关性闸门`);
  }
});

// ═══ ③ 生产装载路径：checkpoint v4 → loadCheckpoint → match_skill 同型检索 ═══

test('K-4: canonical 种子嵌入 checkpoint v4 档后经真实 loadCheckpoint 恢复，match_skill 同型检索命中菜单种子', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r48-seeds-'));
  dirs.push(dir);
  const cpPath = join(dir, 'computer-use-checkpoint.json');
  const seeds = JSON.parse(readFileSync(FM_SEEDS, 'utf8'));
  // 最小档：仅 version/savedAt/failureMemory —— 其余段缺席 = 防御性 SKIPPED 空脑开局
  writeFileSync(cpPath, JSON.stringify({
    version: 4,
    savedAt: SEED_AT,
    failureMemory: { records: seeds.records, nextId: seeds.nextId },
  }));
  const cp = loadCheckpoint(cpPath);
  assert.ok(cp.restored, '最小档整体可恢复');
  assert.ok(cp.report.includes('failureMemory: OK'), `failureMemory 段恢复: ${cp.report.join('; ')}`);
  assert.ok(cp.report.some(l => l.startsWith('journal: SKIPPED')), '缺段 SKIPPED 不连坐（防御性恢复语义）');
  assert.equal(failureMemory.size, 5);
  // match_skill 生产同型调用：antiHits = failureMemory.match(query, sceneHash, 3)
  const antiHits = failureMemory.match('记事本 文件菜单 另存为 保存', undefined, 3);
  assert.ok(antiHits.length > 0 && antiHits[0].id === 1,
    `菜单情境须命中种子 #1（match_skill [Known failures] 面），实际 ${antiHits.map(h => h.id).join(',')}`);
  assert.ok(String(antiHits[0].approach).includes('菜单'), '命中条目 approach 描述菜单败因');
});

// ═══ ④ 部署档漂移守卫（本部署机执法；他机缺席跳过） ═══

test('K-5: 部署档在场时 canonical 种子段逐字节前缀一致、追加段仅限宿主学习连续分配（漂移守卫）', () => {
  if (!existsSync(DEPLOYED_CP)) return; // 未部署机器：守卫不执法（缺席 ≠ 失败）
  const deployed = JSON.parse(readFileSync(DEPLOYED_CP, 'utf8'));
  const canonical = JSON.parse(readFileSync(FM_SEEDS, 'utf8'));
  assert.equal(deployed.version, 4, 'checkpoint v4 钉死');
  const dRecs: FailureRecord[] = deployed.failureMemory.records;
  const cRecs: FailureRecord[] = canonical.records;
  // 注入律执法①（仓内单源）：canonical 种子在部署档中逐字节原序前缀 —— 种子零手改/零删除/零重排
  assert.deepEqual(dRecs.slice(0, cRecs.length), cRecs,
    '部署拷贝的种子段必须由 canonical 生成（R4-8 注入律：仓内单源，部署零手改）');
  // 注入律执法②（宿主学习豁免）：种子段之后只允许宿主 record() 运行时追加。
  // ΑΝΒ-11 血统不变量修正：宿主多段/多重启分配会产生合法 id 空洞（实锤：批3 活宿主
  // 学习段 15,16,17,21,25,32..51 —— 6-14 为运行期未持久化分配），"连续无洞"假设过窄。
  // 保留的执法面：追加段 id 严格递增（零重排/零重复）且全部 ≥ canonical.nextId
  // （零种子域冲突——异源低位 id 即手改漂移）。
  const learned = dRecs.slice(cRecs.length);
  learned.forEach((r, i) => {
    assert.ok(r.id >= canonical.nextId,
      `追加段第 ${i + 1} 条 id=${r.id} 低于 canonical.nextId=${canonical.nextId} —— 种子域冲突即手改漂移`);
    if (i > 0) {
      assert.ok(r.id > learned[i - 1]!.id,
        `追加段第 ${i + 1} 条 id=${r.id} 未严格递增（前条 ${learned[i - 1]!.id}）—— 重排/重复即漂移`);
    }
  });
  // nextId 尾后一格律：无追加 = canonical.nextId；有追加 = 末条 id + 1
  const expectNextId = learned.length ? learned[learned.length - 1]!.id + 1 : canonical.nextId;
  assert.equal(deployed.failureMemory.nextId, expectNextId, 'nextId 须与记录序列连续（尾后一格）');
});

// 清理全部临时目录（测试自洁 —— w8 同律：测试不留垃圾）
process.on('exit', () => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });
