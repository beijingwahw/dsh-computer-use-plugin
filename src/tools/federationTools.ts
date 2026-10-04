// src/tools/federationTools.ts
// 纪元 Μ（万脑联邦进化）：federation_sync 工具 —— 内核证据账本的差分隐私联邦面。
// 三个动作：
//   · digest —— 本地摘要预览（mintEvidenceDigest 直接铸给模型看；恒零网络、
//     确定性种子 ⇒ 同账本同摘要，审计可复现）；
//   · sync   —— 全流程（federationSync：铸摘要 → endpoint 非空则 fire-and-forget
//     POST → 响应含合并摘要则按份额上限掺入账本；endpoint 空 = 零网络，仅返回
//     本地摘要 —— **缺省即离线**，网络是显式 opt-in 的增益旁路）；
//   · status —— 信任账（federationTrustReport）+ 上次同步结果（lastFederationSync）
//     + 联邦配置镜像（endpoint/ε/份额上限）。
// D-B6 投产（W6R-A5）：sync 动作缺省走 Μ2 拜占庭鲁棒聚合（robust: true）—— 响应的
// 多源原始摘要经本地逐格中位数聚合 + 离群检疫票折算信任（数学执法代替对聚合端的
// 信任）；显式 robust:false 可回退 Μ 旧行为（预合并摘要直接掺入 —— 审计/兼容缝）。
// 签名认证（W6R-A5）：DSH_FEDERATION_TOKEN 在场 ⇒ federationSync 自动附 HMAC
// 签名头（库内实现，本工具零额外参数 —— 密钥只经环境变量分发，绝不进参数/结果面）。
// 铁律：绝不抛（一切失败走 toolErr / 诚实注记）；输出一律走 toolResult 工厂；
// 远端证据只喂 EvidenceLedger —— 参数值变化仍由本地 calibrator 全链执法
//（见 src/federation/index.ts 的安全设计注记）。
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Config } from '../config';
import { toolOk, toolErr } from '../toolResult';
import { evidenceLedger } from '../kernel/registry';
import {
  mintEvidenceDigest,
  federationSync,
  federationTrustReport,
  lastFederationSync,
} from '../federation/index';

/** 合法动作表（缺席/空白 ⇒ 'digest' —— 最保守的只读预览） */
const VALID_ACTIONS = ['digest', 'sync', 'status'] as const;
type FederationAction = (typeof VALID_ACTIONS)[number];

export function createFederationSyncTool(config: Config) {
  return defineTool({
    name: 'federation_sync',
    description:
      'Differentially-private federation of kernel evidence (epoch Mu): mints a clipped-histogram digest ' +
      '(K=8 margin bins x success/fail counts, per-cell Laplace noise with epsilon=federationEpsilon) from the ' +
      'local evidence ledger, optionally POSTs it to a federation aggregation endpoint, and blends a returned ' +
      'merged digest back into the LOCAL LEDGER ONLY (capped by federationMaxRemoteShare and a per-source trust ' +
      'weight; kernel parameter VALUES still change only through the local calibrator evidence gate + regression ' +
      'guard). ZERO NETWORK BY DEFAULT: with federationEndpoint empty (the default) nothing is ever sent — ' +
      "digest/merge/apply all work fully offline for multi-process hand-off. Byzantine-robust aggregation " +
      '(epoch Mu2) is the DEFAULT for sync: the response digests are merged locally per-cell by median with ' +
      'outlier quarantine feeding the trust ledger (pass robust:false to fall back to the legacy pre-merged ' +
      "path). Actions: 'digest' (default; local deterministic preview, never touches the network), 'sync' " +
      "(full flow; POST is single-shot, 5s timeout, fire-and-forget, errors sanitized; HMAC-signed when " +
      "DSH_FEDERATION_TOKEN is set), 'status' (trust ledger + last sync result + config mirror).",
    parameters: {
      action: {
        type: 'string',
        description:
          "Which action to run: 'digest' (local digest preview, zero network), 'sync' (mint + optional POST + " +
          "blend returned merged digest), or 'status' (trust ledger + last sync). Default 'digest'.",
      },
      robust: {
        type: 'boolean',
        description:
          'Sync only: aggregate the response digests locally with Byzantine-robust per-cell median + outlier ' +
          'quarantine (epoch Mu2; the DEFAULT). Pass false to fall back to the legacy epoch-Mu path that blends ' +
          "the endpoint's pre-merged digest as-is. Ignored by 'digest' and 'status'.",
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        // 动作解析：缺席/空白 ⇒ 'digest'；大小写不敏感；非法值 ⇒ 结构化 toolErr（绝不抛）
        const raw = (args as { action?: unknown } | undefined)?.action;
        let action: FederationAction | null;
        if (raw === undefined || raw === null) {
          action = 'digest';
        } else if (typeof raw === 'string') {
          const t = raw.trim().toLowerCase();
          action = t === '' ? 'digest' : (VALID_ACTIONS as readonly string[]).includes(t) ? (t as FederationAction) : null;
        } else {
          action = null;
        }
        if (action === null) {
          return toolErr(
            'federation_sync validation failed.',
            `Invalid action value: ${JSON.stringify(raw)}. Valid actions: digest | sync | status.`,
            "Omit action (or pass 'digest') for the local zero-network preview, 'sync' for the full flow, " +
              'or status for the trust ledger and last sync result.',
          );
        }

        // 配置镜像（status / 锚点共用 —— 手算可复现的三键回显）
        const configMirror = {
          endpoint: config.federationEndpoint,
          epsilon: config.federationEpsilon,
          max_remote_share: config.federationMaxRemoteShare,
        };

        if (action === 'digest') {
          // 本地摘要预览：确定性种子（缺省 0）⇒ 同账本同摘要 —— 审计可复现；恒零网络
          const digest = mintEvidenceDigest(evidenceLedger, { epsilon: config.federationEpsilon });
          if (digest === null) {
            return toolErr(
              'federation_sync digest failed.',
              '本地摘要铸造失败（账本视图非法 —— 理论不可达）。',
              'The evidence ledger view was rejected; nothing was uploaded or blended. Retry once; ' +
                "if it persists, inspect the ledger via metrics_dashboard section 'kernel'.",
            );
          }
          return toolOk(
            `federation_sync digest: minted a v${digest.v} digest over ${digest.keys.length} key(s) ` +
              `(epsilon=${digest.epsilon}, per-cell Laplace noise, post-processed to non-negative integers).`,
            {
              action,
              network: 'off',
              config: configMirror,
              digest,
            },
            'This is a LOCAL preview with a deterministic seed — nothing left this machine (zero network by ' +
              "default). To actually federate, call action 'sync' (requires federationEndpoint to be configured; " +
              "otherwise it honestly stays offline). Use action 'status' to inspect trust and past syncs.",
          );
        }

        if (action === 'status') {
          const trust = federationTrustReport();
          const last = lastFederationSync();
          return toolOk(
            `federation_sync status: ${trust.length} trust account(s), last sync ` +
              `${last === null ? '(never)' : `${last.network} @${last.at} applied=${last.applied}`}.`,
            {
              action,
              config: configMirror,
              trust,
              last_sync: last,
            },
            'Trust decays as 1/(1+regressed) per source; blending quotas are multiplied by it. ' +
              "Call action 'digest' for a local preview or 'sync' to run the full flow " +
              '(zero network while federationEndpoint is empty).',
          );
        }

        // action === 'sync'：全流程。缺省走 Μ2 拜占庭鲁棒臂（D-B6 投产落点：本地逐格
        // 中位数聚合 + 离群检疫票折算信任 —— 数学执法代替对聚合端的信任）；只有显式
        // robust:false 才回退 Μ 旧行为（预合并摘要直接掺入 —— 审计/兼容缝）。参数已经
        // defineTool 校验为 boolean，此处再消毒到「非 false 即 true」（防御式双保险）。
        const robustRaw = (args as { robust?: unknown } | undefined)?.robust;
        const robust = robustRaw === false ? false : true;
        // await settled（≤5s 超时上界）把掺入结果带回给模型 ——
        // 工具调用不是热路径，5 秒有界等待换全流程可观测是值得的；热路径纪律由
        // federationSync 内部的 fire-and-forget 结构保证（settled 永不 reject）。
        const res = federationSync({
          endpoint: config.federationEndpoint,
          epsilon: config.federationEpsilon,
          maxRemoteShare: config.federationMaxRemoteShare,
          robust,
        });
        await res.settled;
        if (!res.ok || res.digest === null) {
          return toolErr(
            'federation_sync sync failed.',
            '本地摘要铸造失败（账本视图非法 —— 理论不可达），零网络零应用。',
            'Nothing was uploaded or blended. Retry once; the local ledger and kernel registry are unaffected.',
          );
        }
        return toolOk(
          `federation_sync sync: minted digest over ${res.digest.keys.length} key(s); network=${res.network}` +
            (res.network === 'off'
              ? ' (endpoint empty — zero network, digest returned for hand-off).'
              : res.robust !== undefined
                ? `; byzantine-robust ${res.robust.method} merge over ${res.robust.mergedFrom} source(s)` +
                  `${Object.keys(res.robust.quarantined).length > 0 ? ` (quarantine votes: ${JSON.stringify(res.robust.quarantined)})` : ''}` +
                  (res.applied !== null
                    ? `; blended ${res.applied.applied} remote evidence row(s) into the local ledger (cap x trust enforced).`
                    : '; no usable multi-source digests in the response (upload-only).')
                : res.applied !== null
                  ? `; blended ${res.applied.applied} remote evidence row(s) into the local ledger (cap x trust enforced).`
                  : '; no usable merged digest in the response (upload-only).'),
          {
            action,
            network: res.network,
            endpoint: res.endpoint,
            config: configMirror,
            digest: res.digest,
            applied: res.applied,
            // Μ2 鲁棒臂的合并报告（method/mergedFrom/检疫票/缺席源）—— legacy 路径该字段
            // 缺席（Μ 旧结果形状不变）；robust: true 是 sync 缺省 ⇒ 生产面恒可见
            robust: res.robust,
            error: res.error,
          },
          res.network === 'off'
            ? 'Endpoint is empty: zero network by default. Hand the digest to mergeDigests/applyFederatedEvidence ' +
              'in another process, or configure federationEndpoint and re-run to federate for real.'
            : res.robust !== undefined
              ? 'Response digests were merged LOCALLY per-cell by median (quarantine votes feed the trust ledger as ' +
                "1/(1+regressed)); kernel values still move solely through the local calibrator. Check action " +
                "'status' for trust effects."
              : res.applied !== null
                ? 'Remote evidence now sits in the LOCAL LEDGER only; kernel values still move solely through the ' +
                  "local calibrator (evidence gate + regression guard). Check action 'status' for trust effects."
                : 'Upload succeeded but the response carried no usable digest; nothing was blended. ' +
                  "Retry 'sync' later or inspect the aggregation endpoint.",
        );
      } catch (error: any) {
        // 绝不抛纪律的兜底臂（理论不可达 —— 全程只读/防御式/工厂输出）
        return toolErr(
          'federation_sync failed.',
          error?.message ?? 'unknown error',
          'The federation bypass crashed unexpectedly — the local ledger and kernel registry are unaffected ' +
            "(federation never writes kernel values). Retry once; if it persists, use action 'status' to inspect state.",
        );
      }
    },
  });
}
