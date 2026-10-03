// test/w4audio.test.ts
// W4-8（L4 声学证据通道）单测：音频只作非语义物理证据、权重恒低于视觉 ——
//   ① 端口缺席 ⇒ settleAndVerify 返回体逐字节不变（兼容铁律，golden 对比）；
//   ② 成功提示音 ⇒ 视觉阴性升级 probable_effect（no_effect→probable_effect，
//      detected 主字段不动 —— quantumSense boolean 契约锁死）；
//   ③ 错误提示音 ⇒ 触发复核（recheck），判决不动；
//   ④ 视觉优先律（法条一）：视觉确定性证据在场时音频不改判 —— 连门控判决
//      都不产出，audioEvent 仅作附注；
//   ⑤ 置信封顶（法条二）：高置信压到 0.5 封顶、低置信原样（封顶是顶不是底）；
//   ⑥ 视觉未验证（指纹退化）⇒ 音频不制造确定性（Δ-7 同律）；
//   ⑦ 防御式：端口抛错/事件形状非法 ⇒ 证据缺席，绝不抛、绝不毒化主链；
//   ⑧ 立法在源：法条常量与注释文本源级锁定；python 物理层 --selftest 桥接
//      （合成波形 5 类分类断言，python 缺席环境诚实跳过）。
// 全离线确定性：假 adapter 经 _setAdapterForTests 注入（零 spawn 零网络）、
// unique 哈希避开振荡检测器耦合、注入音频端口零真采集。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as backend from '../src/physicalBackend.ts';
import { normalizeHash } from '../src/perceptualHash.ts';
import {
  settleAndVerify,
  AUDIO_VISUAL_PRIORITY,
  AUDIO_EVIDENCE_CONFIDENCE_CAP,
  type BeforeState, type SettleOptions, type CombinedEffect, type AudioEvent,
} from '../src/actionVerifier.ts';

// ─── 假件工坊：固定 dhash 的假 adapter（零 spawn —— D-5 路径 meta 往返）───

function fakeAdapter(afterDhash: string): never {
  return {
    async takeScreenshot() {
      return {
        ok: true as const,
        value: {
          transport: 'none' as const, name: '', size: 0,
          shape: [1, 1, 3] as [number, number, number], dtype: 'uint8', stride: 3,
          format: 'META', width: 1, height: 1, captured_at: 1,
          image_base64: '', dhash: afterDhash,
          region_dhash: null, unchanged: true, frame_id: null, frame_count: 0,
        },
      };
    },
  } as never;
}

const BASE_OPTS: SettleOptions = {
  adaptive: false, settleMs: 1, threshold: 0.98, regionRadius: 0,
};

function makeBefore(hash: string): BeforeState {
  return { screen: hash, phash: null, region: null, focus: null };
}

async function verify(
  beforeHash: string, afterHash: string, extra?: Partial<SettleOptions>,
): Promise<CombinedEffect> {
  backend._setAdapterForTests(fakeAdapter(afterHash));
  return settleAndVerify(makeBefore(beforeHash), { ...BASE_OPTS, ...extra });
}

/** 音频事件铸造糖 */
function ev(event: AudioEvent['event'], confidence: number): AudioEvent {
  return { event, confidence, ts: 1_759_000_000_000 };
}

// unique 哈希（每测试独立 —— 避开振荡检测器跨测试耦合；含非 0/1 字符强制
// hex 模式，见 epochDelta 对 hexToBits 双模的锁定）
const H_GOLDEN = 'abcd1234abcd1234';
const H_UPGRADE = 'deadbeefdeadbeef';
const H_RECHECK = 'cafebabecafebabe';
const H_CAP = '02357bdfacec1357';
const H_POS_BEFORE = '0123456789abcdef';
const H_POS_AFTER = 'fedcba9876543210'; // 与前者汉明距离 20/64 ⇒ sim 0.6875 < 0.98 ⇒ detected=true
const H_ZERO = '0000000000000000';     // 归一化全零 ⇒ 指纹退化（Δ-7 zero 态）
const H_DEFENSIVE = '13572468ace99bdf';

before(() => { backend._setAdapterForTests(null); });
after(() => { backend._setAdapterForTests(null); });

// ─── ① 端口缺席 ⇒ 逐字节不变（兼容铁律）───

test('W4-8①: audioEvidence 端口缺席 ⇒ 返回体逐字节不变（golden 对比）', async () => {
  const r = await verify(H_GOLDEN, H_GOLDEN);
  // 新键不落：端口缺席时 audioEvent/audioGated 必须整体缺席（不是 undefined 值
  // 在场 —— key 级缺席才配称逐字节不变）
  assert.equal('audioEvent' in r, false, '端口缺席 ⇒ audioEvent 键缺席');
  assert.equal('audioGated' in r, false, '端口缺席 ⇒ audioGated 键缺席');
  // golden：与现状字段面逐项一致（含 undefined 值键 intent/phashCorroborates/
  // unverifiable —— 原 return 字面量的完整键集）
  const golden = {
    detected: false,
    screen: { effect_detected: false, similarity_pct: 100, distance: 0 },
    region: null,
    scale: 'none' as const,
    afterBuffer: Buffer.alloc(0),
    afterHash: normalizeHash(H_GOLDEN), // D-5 路径 afterHash 是归一化位串（hex→bits）
    oscillation: null,
    intent: undefined,
    phashCorroborates: undefined,
    unverifiable: undefined,
    afterFrameId: null,
  };
  assert.deepStrictEqual(r, golden, '返回体与现状 golden 深度等同');
  assert.equal(JSON.stringify(r), JSON.stringify(golden), '序列化字节等同（逐字节铁律）');
});

// ─── ② 成功音升级（门控证据）───

test('W4-8②: 视觉阴性 + 成功提示音 ⇒ no_effect 升级 probable_effect（置信封顶）', async () => {
  const r = await verify(H_UPGRADE, H_UPGRADE, {
    audioEvidence: () => ev('success_chime', 0.87),
  });
  assert.equal(r.detected, false, 'detected 主字段恒为纯视觉判决（boolean 契约不动）');
  assert.equal(r.scale, 'none', '视觉双尺度：无变化');
  assert.deepStrictEqual(r.audioEvent, ev('success_chime', 0.87), 'audioEvent 附注在场（failureMemory 签名维度的只读证据源）');
  assert.ok(r.audioGated, '门控判决在场');
  assert.equal(r.audioGated!.verdict, 'probable_effect', '成功音 ⇒ 阴性升级 probable_effect');
  assert.equal(r.audioGated!.event, 'success_chime');
  assert.equal(r.audioGated!.confidence, 0.5, '置信封顶：min(0.87, 0.5) = 0.5（法条二）');
});

// ─── ③ 错误音触发复核 ───

test('W4-8③: 视觉阴性 + 错误提示音 ⇒ 触发复核（recheck），判决不动', async () => {
  const r = await verify(H_RECHECK, H_RECHECK, {
    audioEvidence: () => ev('error_beep', 0.66),
  });
  assert.equal(r.detected, false, '错误音不改变 detected（复核 ≠ 定罪）');
  assert.ok(r.audioGated, '门控判决在场');
  assert.equal(r.audioGated!.verdict, 'recheck', '错误音 ⇒ 复核指令');
  assert.equal(r.audioGated!.confidence, 0.5, '复核置信同受法条二封顶');
  assert.equal(r.audioEvent!.event, 'error_beep', '原始事件附注在场');
});

// ─── ④ 视觉优先律（法条一）───

test('W4-8④: 视觉优先律 —— 视觉确定性证据在场时音频不改判（连门控判决都不产出）', async () => {
  // 视觉阳性（page-level 变化）+ 成功音：音频无权稀释/顶替视觉
  const rPos = await verify(H_POS_BEFORE, H_POS_AFTER, {
    audioEvidence: () => ev('success_chime', 0.99),
  });
  assert.equal(rPos.detected, true, '视觉阳性判决不被音频触碰');
  assert.equal(rPos.scale, 'page-level');
  assert.equal('audioGated' in rPos, false, '视觉阳性 ⇒ 门控判决不产出（法条一：无升级可谈）');
  assert.equal(rPos.audioEvent!.event, 'success_chime', '音频仍作附注记录（证据保留，权力为零）');

  // 视觉阳性 + 错误音：同样不产出 recheck —— 「屏幕变了但伴随错误音」的
  // 解释权归视觉/语义通道，音频通道不得借复核通道翻转叙事
  const rPosErr = await verify(H_POS_BEFORE, H_POS_AFTER, {
    audioEvidence: () => ev('error_beep', 0.9),
  });
  assert.equal(rPosErr.detected, true);
  assert.equal('audioGated' in rPosErr, false, '视觉阳性 + 错误音 ⇒ 同律静默');
  assert.equal(rPosErr.audioEvent!.event, 'error_beep');
});

// ─── ⑤ 置信封顶（法条二）───

test('W4-8⑤: 置信封顶 —— 高置信压顶、低置信原样（封顶是顶不是底）', async () => {
  assert.equal(AUDIO_VISUAL_PRIORITY, true, '法条一常量在场且为真（立法锁定）');
  assert.equal(AUDIO_EVIDENCE_CONFIDENCE_CAP, 0.5, '法条二封顶值 0.5（恒低于视觉确定性 1.0）');

  const rHigh = await verify(H_CAP, H_CAP, {
    audioEvidence: () => ev('success_chime', 0.99),
  });
  assert.equal(rHigh.audioGated!.confidence, AUDIO_EVIDENCE_CONFIDENCE_CAP,
    '0.99 ⇒ 压到 0.5 封顶');

  const rLow = await verify(H_CAP, H_CAP, {
    audioEvidence: () => ev('success_chime', 0.3),
  });
  assert.equal(rLow.audioGated!.confidence, 0.3, '低置信不抬高（封顶非地板）');
  assert.ok(rLow.audioGated!.confidence < 0.5, '音频单通道置信恒低于视觉确定性证据');
});

// ─── ⑥ 视觉未验证 ⇒ 音频不制造确定性 ───

test('W4-8⑥: 指纹退化（视觉未验证）+ 成功音 ⇒ 不升级（Δ-7 同律：证据不可用 ≠ 无变化）', async () => {
  const r = await verify(H_ZERO, H_ZERO, {
    audioEvidence: () => ev('success_chime', 0.9),
  });
  assert.equal(r.detected, false, '退化 ⇒ 保守 false（现状）');
  assert.equal(r.unverifiable, 'screen:zero', '退化注记在场（现状）');
  assert.equal('audioGated' in r, false, '视觉未验证不是视觉阴性 —— 音频不得在视觉缺席处制造确定性');
  assert.equal(r.audioEvent!.event, 'success_chime', '事件仍附注（证据保留）');
});

// ─── ⑦ 防御式：端口故障/垃圾输入 = 证据缺席 ───

test('W4-8⑦: 防御式 —— 端口抛错/事件形状非法 ⇒ 缺席，绝不抛、绝不毒化主链', async () => {
  // 端口抛错
  const rThrow = await verify(H_DEFENSIVE, H_DEFENSIVE, {
    audioEvidence: () => { throw new Error('audio backend exploded'); },
  });
  assert.equal(rThrow.detected, false, '判决主链无恙');
  assert.equal(rThrow.audioEvent, null, '端口故障 ⇒ 证据缺席（已查询无事件）');
  assert.equal('audioGated' in rThrow, false, '缺席证据不参与判决');

  // 形状非法（未知事件类/缺字段 —— 语义识别冒充物在净化层被拒）
  const rJunk = await verify(H_DEFENSIVE, H_DEFENSIVE, {
    audioEvidence: () => ({ event: 'speech_transcript', confidence: 5, ts: NaN } as unknown as AudioEvent),
  });
  assert.equal(rJunk.audioEvent, null, '未知事件类（语义冒充）⇒ 净化为缺席');
  assert.equal('audioGated' in rJunk, false);

  // 值域越界但形状合法：confidence 夹到 [0,1] 再判（不因垃圾值弃证）
  const rClamp = await verify(H_DEFENSIVE, H_DEFENSIVE, {
    audioEvidence: () => ({ event: 'success_chime', confidence: 7, ts: 1 } as unknown as AudioEvent),
  });
  assert.equal(rClamp.audioEvent!.confidence, 1, '越界置信夹到 1');
  assert.equal(rClamp.audioGated!.confidence, 0.5, '夹正后再受法条二封顶');
});

// ─── ⑧ 立法在源 + python 物理层 selftest 桥 ───

test('W4-8⑧a: 立法在源 —— 法条常量与注释文本源级锁定', () => {
  const src = readFileSync(new URL('../src/actionVerifier.ts', import.meta.url), 'utf8');
  assert.match(src, /AUDIO_VISUAL_PRIORITY = true as const/, '法条一立法常量（视觉优先律）');
  assert.match(src, /AUDIO_EVIDENCE_CONFIDENCE_CAP = 0\.5 as const/, '法条二立法常量（置信封顶 0.5）');
  assert.match(src, /法条一（视觉优先律/, '法条一注释文本在场（立法为代码常量 + 注释法条）');
  assert.match(src, /法条二（置信封顶/, '法条二注释文本在场');
  assert.match(src, /audioEvidence\?: \(\) => AudioEvent \| null/, '注入端口签名锁定');
  // 非语义红线：TS 消费面只认识五类纹理事件，绝无语义识别词汇的合法入口
  assert.doesNotMatch(src, /transcri|asr|speech[-_ ]to[-_ ]text/i, '声学内容不是证据（宪法红线）');
});

test('W4-8⑧b: python 物理层 --selftest 桥 —— 合成波形 5 类分类断言 exit 0', { timeout: 120_000 }, async t => {
  const script = fileURLToPath(new URL('../python_service/dsh_physical/audio.py', import.meta.url));
  const probe = spawnSync('python', ['--version'], { timeout: 15_000 });
  if (probe.error || probe.status !== 0) {
    t.skip(`python 不可用（${probe.error ?? probe.status}）—— 物理层 selftest 已由交付方直接验收`);
    return;
  }
  const r = spawnSync('python', [script, '--selftest'], { timeout: 90_000, encoding: 'utf8' });
  assert.equal(r.status, 0, `audio.py --selftest 必须 exit 0（stdout 尾部: ${String(r.stdout).slice(-400)}）`);
  assert.match(r.stdout, /audio selftest OK/, 'selftest 成功横幅在场');
  // 5 类断言的逐类回执（合成波形 → 分类判决）
  for (const kind of ['notification_ding', 'error_beep', 'success_chime', 'key_click', 'silence']) {
    assert.match(r.stdout, new RegExp(`expected=${kind}\\s+got=${kind}`), `${kind} 分类正确`);
  }
});
