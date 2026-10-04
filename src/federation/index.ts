// src/federation/index.ts
// 纪元 Μ（万脑联邦进化）：认知器官参数证据的差分隐私联邦。万脑各自把
// EvidenceLedger 的滑窗证据铸成「裁剪直方图 + Laplace 噪声」摘要，聚合侧逐格
// 求和（secure-aggregation 风格），本地按「远端份额上限 × 信任权重」把合并摘要
// 掺回自己的证据账本 —— 一机学习，万机受益，且隐私与主权双边界都划得清清楚楚。
//
// 制度先例（本器官一字不违）：
//   · 差分隐私照 src/swarm.ts 的 H-5（buildPacket 的 Laplace 逆 CDF 采样、
//     ε 缺省 1 与群体经验结晶同律）—— 隐私边界只划在上传面：本地账本恒保持
//     真值，联邦是增益不是依赖；单条证据的增删恰动一格 ⇒ 计数敏感度 1 ⇒
//     每格加 Laplace(0, 1/ε) 噪声即 Dwork 机制的逐格实现；
//   · 网络纪律照 swarm.fireUpload：endpoint 空 = 零网络行为（缺省即离线全功能，
//     摘要/合并/掺入手递手可用）、单次不重试、AbortSignal.timeout(5s)、
//     fire-and-forget、错误消毒（绝不泄摘要外的信息 —— endpoint 原文可能带
//     凭据，错误注记一律替换脱敏）；
//   · 「绝不直接写 kernelRegistry 值」是本器官的安全设计核心：远端证据只喂
//     EvidenceLedger（经既有 record API，成败由坨坐标反演、margin 取坨中心），
//     参数值的一切变化仍由本地 KernelCalibrator 的证据门（n ≥ 30）+ 回归守卫 +
//     optimalThreshold 全链执法 —— 联邦没有任何直达参数值的写径；远端洪泛或
//     投毒最多污染证据水位，过不了本地数学执法（掺入还有份额上限与信任折减
//     两道闸，见 applyFederatedEvidence）。
// 运行层永不抛异常（联邦是纯增益旁路：失败 = 诚实跳过/降级，绝不炸宿主）。
// W6-4（持久化缝包）：信任账可落盘 —— 原子写（tmp + fsync + rename，checkpoint
// 同律）+ 防御恢复（垃圾值归先验）+ 突变计数节流；缺省不武装（纯内存，与旧行为
// 逐字节一致），dump 面 = federationTrustReport，restore 面 = restoreFederationTrust。
// ΑΩ-R6（试用期缓升）：初见源 trust 封顶 PROBATION_TRUST_CAP（0.35），累计
// PROBATION_CLEAN_MERGES（3）次干净合并解除；试用期内检疫票 ⇒ 回退重启；
// 'local' 源豁免。试用期原始计数（merges/cleanMerges/dirty）随档落盘（trust 仍
// 派生）；配额链路经闸③ quota=floor(cap×trust) 自然折减，三道闸语义零变化。
// W6R-A5（聚合端共享密钥认证）：上行 HMAC-SHA256 请求签名 + 时间戳防重放（Cap
// Token 同风格）—— DSH_FEDERATION_TOKEN 在场时 federationSync 自动附签名头，
// 服务端（scripts/federation-server.mjs）同 env 强制验签（缺省 open 零配置）。
// ΝΩ-19（联邦逐源签名）：DSH_FED_SIGNING_KEY（Ed25519 pkcs8/base64 或 seed）在场
// ⇒ 上行摘要附 {pubkey,sig}、下行逐源验签（假源剔除 + unverifiableSources 计数，
// 绝不混入中位数）+ 止血限额/同毫秒批量护栏 + 信任账键扩为 endpoint#指纹（ΑΩ-R6
// 试用期平移到正确主体粒度；未配置密钥 ⇒ 未签名旧路径逐字节 —— 零回归律）。
// 全模块随机源/时钟/网络/账本皆可注入，resetFederationRuntime 供测试隔离。

import { existsSync, readFileSync, renameSync, mkdirSync, unlinkSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { evidenceLedger } from '../kernel/registry';
import { robustMergeDigests, applyQuarantineToTrust } from './aggregate';

// ─── 纪元 Μ2 纯增量：拜占庭鲁棒聚合面再分发 ───
// aggregate.ts 是零运行时依赖本模块的纯函数核心（类型面经 import type 借用，编译期
// 擦除）—— 逐格中位数/均值/直通聚合 + 离群检疫（票折算 regressed 喂信任账）+ 贡献
// 份额帽。此处只做面分发与 federationSync 的 robust 臂接线；缺省（robust 缺席）走
// Μ 旧行为逐字节不变（纯增量纪律）。
export {
  robustMergeDigests,
  applyQuarantineToTrust,
  contributionCap,
  OUTLIER_FLOOR,
  OUTLIER_IQR_SCALE,
  QUARANTINE_VOTES_PER_REGRESSED,
  DEFAULT_CONTRIBUTION_CAP_SHARE,
} from './aggregate';
export type {
  RobustMergeResult,
  RobustMergeOptions,
  ContributionCapResult,
  QuarantineTrustReportEntry,
} from './aggregate';

// W9-3（D-F4 拆分）：摘要/信任/掺入/传输四分区已提取至卫星件 —— 本文件是联邦的
// 聚合根（面分发 + 运行时复位门），导入面不变（消费方零改动）。
import { resetTrustRuntime } from './trust';
import { resetLastSync } from './sync';

export {
  DIGEST_VERSION, DIGEST_BINS, DIGEST_MARGIN_CLIP, FEDERATION_TIMEOUT_MS,
  DEFAULT_FEDERATION_EPSILON, DEFAULT_MAX_REMOTE_SHARE,
  mulberry32, laplaceNoise,
  type EvidenceDigestKeyEntry, type EvidenceDigest, type FederationLedgerView,
  type MintDigestOptions, mintEvidenceDigest,
  type MergedEvidenceDigest, mergeDigests,
} from './digest';
export {
  FEDERATION_AUTH_ENV, FEDERATION_AUTH_TIMESTAMP_HEADER, FEDERATION_AUTH_SIGNATURE_HEADER,
  FEDERATION_AUTH_SKEW_MS, federationAuthHeaders,
  FEDERATION_SIGNING_KEY_ENV, federationSigningIdentity, signEvidenceDigest,
  verifyEvidenceDigestSignature, canonicalFederationJson, federationSigningKeyHint,
  logFederationSigningKeyHint,
  type FederationFetch, type FederationSyncOptions, type FederationSyncResult,
  type FederationSyncStatus, lastFederationSync, federationSync,
  type SignedEvidenceDigest, type FederationSigningIdentity, type FederationSignatureVerdict,
} from './sync';
export {
  type FederationLedgerTarget, type ApplyFederatedEvidenceOptions,
  type FederatedApplyReport, applyFederatedEvidence,
} from './apply';
export {
  type FederationTrustRecord, TRUST_STORE_VERSION, DEFAULT_TRUST_FLUSH_EVERY,
  PROBATION_TRUST_CAP, PROBATION_CLEAN_MERGES, TRUST_PROBATION_EXEMPT_SOURCE,
  FEDERATION_FINGERPRINT_KEY_SEP, federationFingerprintSourceId,
  recordFederationTrust, federationTrustOf, federationTrustReport,
  type FederationTrustStore, createFederationTrustFileStore,
  type FederationTrustStoreDoc, serializeFederationTrust,
  type FederationTrustRestoreReport, restoreFederationTrust, loadFederationTrust,
  type ArmTrustPersistenceOptions, armFederationTrustPersistence,
  type FederationTrustFlushReport, flushFederationTrust, federationTrustPersistenceStatus,
} from './trust';

// ─── 测试缝：联邦运行时复位（信任账 + 上次同步记忆 + W6-4 持久化武装；生产代码无理由调用） ───

export function resetFederationRuntime(): void {
  resetTrustRuntime(); // W9-3：信任账/持久化武装复位（trust.ts 私有账本之门）
  resetLastSync();     // W9-3：上次同步记忆复位（sync.ts 私有记忆之门）
}
