// src/notary/replay.ts
// W6-2（doctor smell.over-engineering 清偿）：自 notary/index.ts 低风险分区提取
// —— Χ 纪元（沙箱重放证词）第四章 replay-consistency 的执法体整体搬迁。
// 行为零变化；notary/index.ts 以再导出保持导入面不变。
import { deterministicReplay } from '../sandbox/engine';
import { sandboxLog, type SandboxLog } from '../sandbox/log';
import type { SandboxAction } from '../sandbox/types';
import type { JournalEntry } from '../journal';
import { errText } from './primitives';
import type { BadgeStatus } from './primitives';

// ─── Χ 纪元（沙箱重放证词）：第四章 replay-consistency 的执法体 ───
// Π 在此章诚实 n/a 并留言「沙箱段重放证词留给后续」—— 本纪元兑现该承诺：
// 沙箱排练链是确定性世界（virtualScreen：命中测试/输入缓冲/滚动/esc 关弹窗），
// 同动作链重入必同屏 —— 重放因此**可执法**：链上在册的屏指纹序列 vs 重演重算
// 序列逐位一致 ⇒ green「重放一致」（agent 行为的复现性证明）。
// 威胁模型补位：无密钥哈希链只证「未被无痕篡改」，不证「内容为真」—— 攻击者
// 持整链重写权（改内容后重算全部哈希）可保章①绿。重放章补的就是这个缺口：
// 内容必须仍与确定性世界重演的产物逐位一致，否则 red —— 链完整而史不可复现。

/** 重放章注入面：沙箱账本可注入（缺省自动发现沙箱单例 —— 注入优先） */
export interface ReplayConsistencyOptions {
  sandboxLedger?: SandboxLog;
}

/**
 * 重放一致性章（独立可调；永不抛 —— 内部异常吞为红章，绝不炸调用方）：
 *   沙箱段在场且带屏指纹 ⇒ 逐段 deterministicReplay 重演比对（逐位）；
 *   无沙箱段 ⇒ n/a（真机 journal 段不可复现 —— 理由在场，诚实）；
 *   旧格式无指纹 ⇒ n/a(legacy)；
 *   分歧 ⇒ red（注记首个分歧步）。
 */
export function attestReplayConsistency(opts: ReplayConsistencyOptions = {}): BadgeStatus {
  try {
    const ledger = opts.sandboxLedger ?? sandboxLog; // 注入优先，缺省沙箱单例
    const entries = ledger.list();
    const isRehearsal = (kind: string) => kind === 'rehearsal-begin' || kind === 'rehearsal-step';
    if (!entries.some(e => isRehearsal(e.kind))) {
      return {
        status: 'n/a',
        detail: 'no sandbox rehearsal segment on the sandbox ledger — real-machine journal '
          + 'segments stay honestly unattested (world non-determinism: screens/timings); '
          + 'nothing replayable in scope',
      };
    }
    const newFormat = entries.some(e => isRehearsal(e.kind) && e.data?.fpFormat !== undefined);
    const segments = ledger.exportRehearsalSegments();
    if (segments.length === 0) {
      if (!newFormat) {
        return {
          status: 'n/a(legacy)',
          detail: `sandbox ledger holds ${entries.length} pre-Χ entr${entries.length === 1 ? 'y' : 'ies'} `
            + 'with rehearsal records but no screen fingerprints (legacy format) — bit-level '
            + 'replay attestation requires Χ-format records; honest n/a(legacy), not a false green',
        };
      }
      return {
        status: 'n/a',
        detail: 'rehearsal records present but no reconstructable replay segment '
          + '(virtual scene absent from the records, or segment head evicted by capacity) — honest n/a',
      };
    }

    let totalSteps = 0;
    let firstDivergence: string | null = null;
    for (const seg of segments) {
      const actions = seg.steps.map(s => s.action as SandboxAction);
      const r = deterministicReplay(actions, { scene: seg.scene });
      if (r.fingerprints.length !== seg.steps.length) {
        firstDivergence ??= `segment ${seg.chainId}: replay produced ${r.fingerprints.length} `
          + `fingerprint(s) for ${seg.steps.length} recorded step(s)`;
        continue;
      }
      for (let i = 0; i < seg.steps.length; i++) {
        if (r.fingerprints[i] !== seg.steps[i].fingerprint) {
          firstDivergence ??= `segment ${seg.chainId}: FIRST DIVERGENCE at step ${i} `
            + `(chain index ${seg.steps[i].index}) — recorded ${seg.steps[i].fingerprint.slice(0, 12)}… `
            + `vs replayed ${r.fingerprints[i].slice(0, 12)}…`;
          break;
        }
      }
      totalSteps += seg.steps.length;
    }
    if (firstDivergence) {
      return {
        status: 'red',
        detail: `${firstDivergence}; attested ${segments.length} segment(s) / ${totalSteps} step(s) — `
          + 'history NOT reproducible: the chain may verify intact yet its content diverges '
          + 'from what the deterministic world produces',
      };
    }
    return {
      status: 'green',
      detail: `replayed ${segments.length} sandbox segment(s) / ${totalSteps} step(s) — every post-step `
        + 'screen fingerprint recomputed by re-entering the virtual screen matches the ledger '
        + 'bit-for-bit (deterministic world reproduces the history); real-machine journal segments '
        + 'remain honestly outside replay scope',
    };
  } catch (e) {
    return { status: 'red', detail: `replay attestation crashed: ${errText(e)}` };
  }
}
