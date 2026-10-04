// Golden capture BEFORE refactor — dump current behavior of all six clone sites.
import { embed } from './src/semanticHash.ts';
import { skillFingerprintOf } from './src/skillFederation.ts';
import { policyFingerprintOf, dreamCfKey, dreamBatchWatermark, computeDreamPriority } from './src/sleep/dreamReplayCore.ts';
import { stableColor, somColorKey } from './src/vlm/som.layout.ts';
import { mulberry32 as digestMulberry32, fnv1a32, mintEvidenceDigest } from './src/federation/digest.ts';
import { seededRng, betaSample } from './src/knowledge/memoryOps.random.ts';
import { mulberry32 as dialectMulberry32, fnv1a as dialectFnv1a } from './src/dialects/random.ts';

const out = {};
// 1. dialects fnv1a goldens
out.fnv1a = ['', 'a', 'hello', '整理数据', '§整理', 'w4-4:pcg:derive:123'].map(s => dialectFnv1a(s));
// 2. semanticHash embed golden
const e = embed('整理数据后再筛选数据');
out.embed = { dims: e.dims, norm: e.norm };
const e2 = embed('filter the data');
out.embed2 = { dims: e2.dims, norm: e2.norm };
// 3. skillFingerprint goldens
out.skillFp = [
  skillFingerprintOf('abcdef1234567890', [{ a: 1.23 }, { b: -0.5, c: 2 }]),
  skillFingerprintOf(undefined, 'garbage'),
  skillFingerprintOf('SCENE', [{ x: 0.049 }, { x: 0.051 }]),
];
// 4. dreamReplayCore policyFingerprint / dreamCfKey
out.policyFp = [policyFingerprintOf({ w1: 0.05, w2: -0.1 }), policyFingerprintOf({}), policyFingerprintOf(null)];
out.dreamCfKey = [dreamCfKey('ocr.timeout', 'abc'), dreamCfKey(undefined, 'wfp'), dreamCfKey('  ', '')];
// 5. som stableColor
out.stableColor = ['word', '整理', 'x'].map(k => stableColor(k));
// 6. digest mulberry32 + fnv1a32
out.digestMulFirst = [42, 0, 1.9, -1.5, -2, NaN, Infinity].map(s => digestMulberry32(s)());
out.digestMulStream = (() => { const r = digestMulberry32(4242); return [r(), r(), r(), r()]; })();
out.fnv1a32 = [fnv1a32(0, 'k'), fnv1a32(0x811c9dc5, ''), fnv1a32(NaN, 'x'), fnv1a32(123.7, 'abc'), fnv1a32(5, 5)];
// 7. memoryOps seededRng streams
out.seededRng = {};
for (const s of ['seed-a', '整理', 0, 42, -7.5, 4294967295]) {
  const r = seededRng(s); out.seededRng[String(s)] = [r(), r(), r(), r(), r(), r(), r(), r()];
}
out.beta = [betaSample(3, 2, seededRng('gold')), betaSample(1, 1, seededRng('gold2'))];
// 8. dialect mulberry32 vs raw stream
out.dialectMulFirst = [42, 0, 4294967295, 1].map(s => dialectMulberry32(s)());
console.log(JSON.stringify(out, null, 1));
