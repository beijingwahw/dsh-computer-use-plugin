// test/epochZ.test.ts
// 第廿二纪元（Z-2 点击闸门）：「模型将输出的正文当作点击的按钮」的根除执法。
// 世界行动律的最后一环：Z-1 把交互性判决标注在 find_text 结果里（模型可以
// 不看），Z-2 把判决接到 click_mouse 执行前 + 反射弧落点选举 —— 全部纯函数。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  gateTextClick, TEXT_CLICK_REFUSE_FLOOR,
  type ProbeResult, type ProbeEvidence,
} from '../src/interactivityProbe.ts';
import { ocrWordsToClickCandidates } from '../src/knowledge/stations.ts';
import type { OcrWord } from '../src/textReader.ts';

function probe(v: Partial<ProbeResult> & Pick<ProbeResult, 'verdict' | 'confidence' | 'evidence'>): ProbeResult {
  return { point: { x: 0.5, y: 0.5 }, ...v };
}

function hoverEvidence(cursor: string): ProbeEvidence {
  return { via: 'hover', cursor_kind: cursor, hover_repaint: false, repaint_similarity: null, dwell_ms: 350 };
}

function uiaEvidence(controlType: string | null): ProbeEvidence {
  return {
    via: 'uia', cursor_kind: 'n/a', hover_repaint: false, repaint_similarity: null, dwell_ms: 0,
    hit_test: { control_type: controlType, name: '点击登录按钮', classification: 'text', matched_depth: null },
  };
}

// ─── Z-2a 点击闸门判决矩阵 ───

test('Z-2a: UIA 静态正文（Text/Document，决定性判决）⇒ 拦截', () => {
  for (const ct of ['Text', 'Document']) {
    const g = gateTextClick(probe({ verdict: 'text', confidence: 0.93, evidence: uiaEvidence(ct) }));
    assert.equal(g.blocked, true, ct);
    if (g.blocked) assert.match(g.reason, /static content/);
  }
});

test('Z-2a: UIA Edit 输入框 ⇒ 放行（点击聚焦是合法动作，不是本闸门的对症错误）', () => {
  const g = gateTextClick(probe({ verdict: 'text', confidence: 0.93, evidence: uiaEvidence('Edit') }));
  assert.equal(g.blocked, false);
});

test('Z-2a: 悬停 ibeam（正文/聊天消息的 OS 本体感觉）⇒ 拦截', () => {
  const g = gateTextClick(probe({ verdict: 'text', confidence: 0.92, evidence: hoverEvidence('ibeam') }));
  assert.equal(g.blocked, true);
  if (g.blocked) assert.match(g.evidence, /cursor=ibeam/);
});

test('Z-2a: 场景记忆召回的 text 判决同样拦截（每界面一次实验费的复用面）', () => {
  const g = gateTextClick(probe({
    verdict: 'text', confidence: 0.92,
    evidence: { ...hoverEvidence('ibeam'), via: 'memory' },
  }));
  assert.equal(g.blocked, true);
  if (g.blocked) assert.match(g.evidence, /probe memory/);
});

test('Z-2a: 非决定性证据一律放行 —— inconclusive 是诚实弃权，弃权不执法', () => {
  // 光标通道缺席的重绘单证（conf 0.8 < 地板）
  assert.equal(gateTextClick(probe({
    verdict: 'control', confidence: 0.8, evidence: hoverEvidence('unsupported'),
  })).blocked, false);
  // arrow 无重绘（conf 0.3）
  assert.equal(gateTextClick(probe({
    verdict: 'inconclusive', confidence: 0.3, evidence: hoverEvidence('arrow'),
  })).blocked, false);
  // 控件判决（hand / UIA control）
  assert.equal(gateTextClick(probe({
    verdict: 'control', confidence: 0.96, evidence: hoverEvidence('hand'),
  })).blocked, false);
  // 探针缺席（dry-run/服务故障 ⇒ null）零回归
  assert.equal(gateTextClick(null).blocked, false);
  assert.equal(gateTextClick(undefined).blocked, false);
});

test('Z-2a: 拦截地板 = 0.9 —— 只有决定性判决（uia 0.93 / ibeam 0.92）够格执法', () => {
  assert.equal(TEXT_CLICK_REFUSE_FLOOR, 0.9);
  assert.ok(0.93 >= TEXT_CLICK_REFUSE_FLOOR && 0.92 >= TEXT_CLICK_REFUSE_FLOOR);
  assert.equal(gateTextClick(probe({
    verdict: 'text', confidence: 0.89, evidence: hoverEvidence('ibeam'),
  })).blocked, false);
});

test('Z-2a: allowTextClick 自证通道 —— 明知点正文（文档放置光标/选中文本）放行', () => {
  const p = probe({ verdict: 'text', confidence: 0.93, evidence: uiaEvidence('Document') });
  assert.equal(gateTextClick(p).blocked, true);            // 默认拦截
  assert.equal(gateTextClick(p, { allowTextClick: true }).blocked, false); // 显式自证放行
});

// ─── Z-2b 反射弧场景源：正文词不参选落点选举 ───

function ocrWord(text: string, x0: number, x1: number, y0 = 0.4, y1 = 0.42): OcrWord {
  return {
    text, confidence: 90,
    bbox_normalized: { x0, y0, x1, y1 },
    center_normalized: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 },
  };
}

test('Z-2b: 宽行/多行段落（聊天消息、文档正文形态）被剔出点击候选', () => {
  const words = [
    ocrWord('点击登录按钮即可进入系统', 0.05, 0.75),   // 聊天整行（content-like）
    ocrWord('段落块', 0.10, 0.30, 0.30, 0.42),          // 多行段落块（content-like）
    ocrWord('登录', 0.40, 0.48),                        // 紧凑短标签（control-like）
    ocrWord('立即注册账号', 0.50, 0.68),                // 中等宽度（ambiguous）
  ];
  const cands = ocrWordsToClickCandidates(words);
  assert.deepEqual(cands.map(c => c.name), ['登录', '立即注册账号']);
});

test('Z-2b: 候选元素方言保持 —— role=text、name 截断 20 字符、rect 归一化', () => {
  const long = 'X'.repeat(30);
  const [c] = ocrWordsToClickCandidates([ocrWord(long, 0.40, 0.48)]);
  assert.equal(c.role, 'text');
  assert.equal(c.name.length, 20);
  assert.equal(c.rect.x, 0.40);
  assert.equal(c.rect.y, 0.4);
  assert.ok(Math.abs(c.rect.width - 0.08) < 1e-9, `width=${c.rect.width}`);
  assert.ok(Math.abs(c.rect.height - 0.02) < 1e-9, `height=${c.rect.height}`);
  assert.deepEqual(ocrWordsToClickCandidates([]), []);
});

test('Z-2b: 剔除是保守降级 —— 全员正文形态 ⇒ 空候选集（反射弧诚实接地，不错点）', () => {
  const cands = ocrWordsToClickCandidates([
    ocrWord('一整行正文内容', 0.05, 0.80),
    ocrWord('另一行正文', 0.08, 0.70),
  ]);
  assert.equal(cands.length, 0);
});
