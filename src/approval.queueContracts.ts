// src/approval.queueContracts.ts
// approval 队列契约区（W8-B3 自 approval.ts 拆出 —— 代码逐字保持，零漂移）：
// W2-1（H4 暂存式离线批准队列）的类型面、存储端口与文件存储实现。
// ─── W2-1（H4 暂存式离线批准队列）：审批请求超时无人应答 ⇒ 降级暂存模式 ───
//
// 提案 H4 的场景：用户离开（下班/睡觉），agent 的不可逆动作卡在阻塞审批上
// 一无所获。降级暂存（staging）把「人在场的实时同意」换成「人回来后的一次
// 批量裁决」：
//   · 触发 —— request_approval 铸造的请求超过暂存超时（X 分钟）仍无人 grant
//     ⇒ stageAction 把该动作连同证据链（截图引用/动作形状/场景指纹/风险档）
//     入待批队列，agent 继续执行一切**可逆**部分；
//   · 通道资格 —— 暂存是降级而非越权：只在带外通道在场（宿主已接
//     wireDoctorVerdictChannel ⇒ confirmCodeChannel 武装）时可用；通道/宿主
//     缺席 ⇒ stageAction 拒绝（channel-absent），维持现行阻塞审批（诚实降级
//     的方向是更保守，不是更自动）；
//   · 持久化 —— 队列经注入存储端口落盘（tmp + rename 原子写 + fsync，与
//     checkpoint.ts 同律：要么完整旧档要么完整新档，绝无半档）；存储缺席 =
//     仅内存（跨进程不保 —— 诚实降级）。checkpoint 另有 approval-queue 段
//     （会话恢复主源，见 checkpoint.ts W2-1 注记）；
//   · 晨报消费 —— sleep 第⑥幕经注入 dep 读 pendingSummary，待批清单进晨报
//     （见 src/sleep/index.ts W2-1 段）；
//   · 批量裁决 —— adjudicate(ids, grant, note, confirmCode) 复用 W1-2 批注协议：
//     一次批注可携带对多项的裁决，每个条目按自身描述各铸一份 amendment（透传
//     给续跑执行令牌）。ΠΑΝ-1：grant 臂必须携带**带外确认码**（入队时锚定的
//     确认码哈希在裁决时被消费 —— 与 grant_approval 同一人证标准；无锚/无码/
//     错码 ⇒ fail-closed 结构化拒绝，错码封顶焚毁条目）。每项通过人证的 grant
//     再消耗一枚 Y-10 同意预算（批量裁决不是 click-fatigue 的后门：一夜批 100
//     个不可逆操作仍然被桶封顶；限速是补充不是替代人证）；deny 不需要人证、
//     不计费；
//   · TTL 保守律 —— 条目过期**不自动作废**：grant 过期条目被拒绝
//     （ttl-expired，须重走完整审批 —— 带外码人证重新铸造），条目留在队列
//     里持续出现在晨报中直到用户显式 deny（宁可唠叨，不可静默蒸发）；
//     ΠΑΝ-2：已批条目被 takeGranted 消费时以当前时钟重验 TTL —— 陈年同意
//     不可兑换不可逆操作（过期即拒绝并清理）；
//   · 续跑 —— takeGranted() 落盘先行（持久化失败 ⇒ 拒绝交出执行权 —— 宁可
//     保守不可双发），然后铸造一枚**已授予**的执行令牌（amendment 随行，
//     执行侧 applyAmendment 照常消费；不重复扣 Y-10 —— 批量裁决时已扣）。
//     ΠΑΝ-4：被交互式 grant 兑现的条目进入 'absorbed' 终态不可再 take ——
//     一次同意只经一条通道兑付一次（交互令牌本尊就是那次执行的载体）。
//     条目的 stepCursor（入队时 journal 条数）是续跑步账：恢复后只重演此后
//     的步骤，已暂存的可逆部分不重复执行；
//   · 防御式 —— 本段一切公开面绝不抛：存储/时钟/输入垃圾一律收敛为诚实
//     返回值（ok:false + reason / 归零恢复），错误细节记入 queueStats()。
import { existsSync, readFileSync, renameSync, mkdirSync, unlinkSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { APPROVAL_QUEUE_ENVELOPE_VERSION } from './approval.constants';
import { tightenFilePerms, tightenExistingFilePerms } from './filePerms';
import { readHexKeyFile, loadOrCreateHexKeyFile } from './hmacKeyFile';
import type { ActionShape } from './approval.shapes';
import type { ApprovalAmendment } from './approval.security';

/** W2-1（H4）：队列条目的证据链 —— 入队时快照（动作形状即刻脱敏，同 Τ 纪元） */
export interface QueuedActionEvidence {
  /** 截图引用（journal/感知侧的锚点字符串；截 200） */
  screenshotRef?: string;
  /** 铸造时快照并脱敏的动作形状（type_text 只记工具名+长度桶） */
  actionShape?: ActionShape;
  /** 场景指纹（截 100） */
  sceneFingerprint?: string;
  /** 风险档（截 32 —— riskGate 的档位标签） */
  riskTier?: string;
}

/** W2-1（H4）：裁决结果（amended 批注透传） */
export interface QueuedApprovalDecision {
  /**
   * ΠΑΝ-4（双通道双花封堵）：verdict 三值语义 ——
   *   · 'granted'  —— 批量裁决（晨报面）批准：待 takeGranted 续跑消费；
   *   · 'denied'   —— 拒绝：终态（保留期内仅供审计）；
   *   · 'absorbed' —— 交互式 grant 已兑现（recordTokenDecision 传播）：终态，
   *                    **不可再 takeGranted**（一次同意只兑付一次物理执行 ——
   *                    交互令牌本尊就是那次执行的载体；旧实现传播为 granted
   *                    使同一份同意可经两条通道各铸一枚执行令牌 = 双花）。
   */
  verdict: 'granted' | 'denied' | 'absorbed';
  at: number;
  /** 批注式裁决铸出的 amendment patch（W1-2 协议；续跑令牌原样携带） */
  amendment?: ApprovalAmendment;
}

/** W2-1（H4）：待批队列条目 */
export interface QueuedApprovalEntry {
  /** 条目 id（QA- 前缀 CSPRNG —— 批量裁决的寻址面） */
  id: string;
  /** 触发本条目的审批令牌（追溯面；令牌自身可随后续期/焚毁，条目独立存活） */
  token: string;
  /** 待批动作描述（截 200，与批注预算同律） */
  description: string;
  /** 证据链（入队时快照） */
  evidence: QueuedActionEvidence;
  /** 入队时间（注入时钟） */
  enqueuedAt: number;
  /** TTL 宽度（ms） */
  ttlMs: number;
  /** TTL 到期（过期 ⇒ 须重走完整审批，不自动作废 —— 安全保守） */
  expiresAt: number;
  /** 续跑步账：入队时的 journal 条数（恢复后只重演此后的步骤 —— 可逆部分
   *  已在账上，不重复执行）；缺省 = 未提供（调用方无 journal 面时的诚实缺席） */
  stepCursor?: number;
  /** 裁决结果（缺省 = 待批） */
  decision?: QueuedApprovalDecision;
}

/** stageAction 的失败成因（'internal' = 防御式兜底，正常流不可达） */
export type StageFailureReason =
  | 'channel-absent'      // 带外通道缺席 —— 暂存不可用，维持阻塞审批（诚实降级）
  | 'invalid-token'       // 令牌缺席/已消费（须先 request_approval 铸造）
  | 'already-granted'     // 令牌已授予 —— 交互路径已恢复，无需暂存
  | 'not-timed-out-yet'   // 未到暂存超时（retryInMs = 剩余等待）
  | 'queue-full'          // 队列封顶（须先裁决/清理 —— 逼一次人工介入）
  | 'internal';

export type StageOutcome =
  | { ok: true; entry: QueuedApprovalEntry; duplicate?: boolean }
  | { ok: false; reason: StageFailureReason; retryInMs?: number };

/** 批量裁决的单项产出 */
export type AdjudicateItemOutcome =
  | 'granted'                 // 已批（amendment 已铸，等待续跑消费）
  | 'denied'                  // 已拒（amendment 已铸 —— 否决理由随行）
  | 'rate-limited'            // Y-10 同意预算耗尽（条目保持待批，冷静期后重试）
  | 'ttl-expired'             // 条目过期 —— 保守拒绝，须重走完整审批
  | 'unknown-id'              // 无此条目（或已被续跑消费）
  | 'already-decided'         // 已裁决过（双重裁决封堵 —— 决不翻案）
  // ── ΠΑΝ-1（人证补全）：grant 臂的确认码执法词表（与 grant_approval 同律；
  //    码校验先于 Y-10 —— 错码不烧同意预算，限速是补充不是替代人证） ──
  | 'confirm-channel-absent'  // 条目无人证锚（铸造时带外通道缺席/投递失败，或
                              // 跨进程恢复面无哈希证据）—— fail-closed，条目保持待批
  | 'confirm-code-required'   // grant 未携确认码（非错误尝试，不计封顶、不烧预算）
  | 'confirm-code-mismatch'   // 码不匹配（计一次错误尝试；封顶前条目保持待批）
  | 'code-attempts-exhausted'; // 错码封顶：条目已焚毁（重新走 request_approval 带外铸造）

/** W2-1（H4）：存储端口（注入面 —— 离线可测；生产用文件原子写实现）。
 *  ΠΑΝ-3：可选透明化面 lastLoadTrusted —— 上次 load() 内容的完整性可信度。
 *  缺省（实现未提供该方法）= 不可信：恢复面将剥离 granted 裁决（fail-closed ——
 *  不能凭未经完整性验证的盘面恢复「已授予」）。自定义存储实现若能自证完整性
 *  （如自身已有 HMAC/签名面），实现该方法返回 true 即可豁免剥离。 */
export interface ApprovalQueueStorage {
  /** 读持久化队列原文（缺席/不可读 ⇒ null）；绝不抛 */
  load(): string | null;
  /** 原子落盘（tmp + rename 项目惯例）；返回 ok/error，绝不抛 */
  save(text: string): { ok: boolean; error?: string };
  /** ΠΑΝ-3：上次 load() 的内容是否通过完整性验证（可选；缺省 = 不可信） */
  lastLoadTrusted?(): boolean;
}

// ─── ΠΑΝ-3（持久化完整性）：HMAC-SHA256 信封 ───
//
// 威胁模型：队列档是「预授权凭据」——盘面上的 granted 裁决在恢复后可经
// takeGranted 铸成已授予执行令牌并派发不可逆动作。旧实现明文 JSON 落盘，
// 任何能写该文件的进程/用户都能预授权（C1-5 H3：journal 有 SHA-256 链 +
// verify_journal 审计，安全等级更高的审批队列反而无篡改证据面 —— 双标）。
//
// 修复：文件内容改为完整性信封 `{ v:2, alg:'hmac-sha256', mac?, payload }`：
//   · 密钥 —— 首次写档时 CSPRNG 铸 32B 密钥，落 `<档>.key`（tmp+fsync+rename
//     原子写，与队列档同律），并经 filePerms（W8-A2 共享加固面）尽力收紧
//     权限：POSIX chmod 0600 / win32 icacls 断继承只留当前账户 —— 密钥来源
//     参考既有实践（approval.security 的 CSPRNG 强度标准 + filePerms 的
//     「尽力 + 诚实」语义；密钥**不**进代码/配置，杜绝跨部署共用）。
//   · 验证 —— load 时重算 HMAC 恒定时间比对：匹配 ⇒ trusted（granted 裁决
//     照常恢复）；不匹配 ⇒ **篡改档整档归零**（load 返 null —— 绝不冒充
//     恢复，与「垃圾档归零」同律）。
//   · 无密钥降级（诚实三态）—— 密钥档不可读/不可建（只读文件系统、损坏
//     密钥、首次写入前的竞态等）⇒ 写侧省略 mac 落明文信封、读侧无法验证
//     ⇒ lastLoadTrusted=false ⇒ **恢复时全部拒绝 granted 条目**（裁决剥回
//     待批；pending/denied 照常恢复供晨报 —— fail-closed：宁可要求重新
//     人证，不可凭不可信盘面铸已授予令牌）。
//   · 旧版明文档（v1，无信封）—— 同无密钥降级路径：内容结构兼容读回但
//     不可信（升级部署不丢队列，但升级时刻的在途 granted 须重新裁决）。
//   · 已知边界（诚实申报）—— 密钥档与数据档同目录：能**读**密钥的本地
//     攻击者可离线伪造自洽信封。HMAC 防的是「只写不读密钥」的篡改者
//     （其他本地用户/低权进程 —— filePerms 收紧后正是这一边界）；读密钥
//     ⇒ 已等价于该账户本体，属档案权限模型之外的威胁。队列明文另含
//     动作描述/截图引用（行为史隐私面），随信封一并收紧文件权限。
//
// 契约不变量：save/load 语义与 W2-1 完全一致（原子写/绝不抛/缺席=null），
// 信封是存储实现的内脏 —— queueState.persistQueue 的调用面零改动。

function hmacSha256(key: Buffer, payload: string): Buffer {
  return createHmac('sha256', key).update(payload, 'utf8').digest();
}

/** 恒定时间比对（两侧等长摘要 —— timingSafeEqual 不抛；任何异常 ⇒ false） */
function macMatches(key: Buffer, payload: string, mac: string): boolean {
  try {
    const expected = hmacSha256(key, payload);
    const provided = Buffer.from(mac, 'hex');
    return provided.length === expected.length && timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
}

// 密钥档读写已收编为共享件（修复潮 F3-7 / BC-5：此处与 checkpoint.ts 的
// approvalQueue 段曾是逐字克隆 ×2）：读侧 readHexKeyFile（绝不铸造）、写侧
// loadOrCreateHexKeyFile（铸新 + 原子落盘 + 权限收紧）—— 语义头注见共享件。

/** W2-1（H4）：文件存储实现（原子写：tmp + fsync + rename —— checkpoint.ts 同律；
 *  ΠΑΝ-3：内容为 HMAC-SHA256 完整性信封，见上节注记） */
export function createApprovalQueueFileStorage(filePath: string): ApprovalQueueStorage {
  let lastTrusted = false; // 每次 load() 重置 —— 状态只反映「最近一次读档」
  return {
    lastLoadTrusted(): boolean {
      return lastTrusted;
    },
    load(): string | null {
      try {
        lastTrusted = false;
        if (!filePath || !existsSync(filePath)) return null;
        // 顺手收紧旧档权限（幂等尽力 —— L11 行为史隐私面同律处理）
        tightenExistingFilePerms(filePath);
        const text = readFileSync(filePath, 'utf8');
        if (typeof text !== 'string' || text.trim() === '') return null;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return null; // 垃圾档（非 JSON）= 无持久化队列（诚实归零）
        }
        if (!parsed || typeof parsed !== 'object') return null;
        const root = parsed as Record<string, unknown>;
        if (root.v === APPROVAL_QUEUE_ENVELOPE_VERSION && typeof root.payload === 'string') {
          const mac = typeof root.mac === 'string' && root.mac !== '' ? root.mac : undefined;
          if (mac === undefined) {
            // 无密钥环境写入的降级档（无 mac）：内容照读但**不可信** ——
            // 由恢复面剥离 granted（fail-closed，见 queueState ΠΑΝ-3 注记）
            return root.payload;
          }
          const key = readHexKeyFile(filePath + '.key'); // 只读验证 —— 铸造禁用于此（诚实三态）
          if (key === null) return root.payload; // 密钥缺席 ⇒ 无法验证 ⇒ 同上降级
          if (!macMatches(key, root.payload, mac)) return null; // 篡改 ⇒ 整档归零
          lastTrusted = true;
          return root.payload;
        }
        // 旧版明文档（W2-1 原格式，无信封）：结构兼容读回但完整性不可证 ⇒ 不可信
        return text;
      } catch {
        return null; // 读故障（含 ENOENT 竞态）= 无持久化队列（诚实方向）
      }
    },
    save(text: string): { ok: boolean; error?: string } {
      if (!filePath) return { ok: false, error: 'approval-queue path is empty' };
      const tmp = filePath + '.tmp';
      try {
        mkdirSync(path.dirname(filePath), { recursive: true });
        // ΠΑΝ-3：密钥在场 ⇒ 信封携 mac；缺席 ⇒ 明文信封（降级档 —— 读侧不可信）
          const key = loadOrCreateHexKeyFile(filePath + '.key');
        const envelope = JSON.stringify({
          v: APPROVAL_QUEUE_ENVELOPE_VERSION,
          alg: 'hmac-sha256',
          ...(key !== null ? { mac: hmacSha256(key, text).toString('hex') } : {}),
          payload: text,
        });
        // fsync 落盘后再换名：rename 可先于数据块持久化 —— 崩溃后可能读到空/截断档
        const fd = openSync(tmp, 'w');
        try {
          writeSync(fd, Buffer.from(envelope, 'utf8'));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmp, filePath); // 原子换名：要么完整旧档要么完整新档，绝无半档
        tightenExistingFilePerms(filePath); // 行为史含敏感描述 —— 顺手收紧（尽力）
        return { ok: true };
      } catch (e: unknown) {
        try { unlinkSync(tmp); } catch { /* tmp 可能未创建 */ }
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
