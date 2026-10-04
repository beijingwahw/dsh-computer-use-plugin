// src/approval.constants.ts
// approval 立法常量区（W8-B3 自 approval.ts 拆出 —— 值逐字保持，零漂移）。
// 全部数值是审批安全契约的一部分：TTL/封顶/桶宽/队列预算共同决定「一次同意
// 能兑换多少次不可逆操作、隔多久、留多久」。改动任何一条 = 改安全语义，
// 须连同 W6-R 修复语义与既有测试锁定一并审计（测试经行为面锁定这些值，
// 不经符号导入 —— 故除本簇兄弟文件外不对外再导出）。
// 分区归属见 src/approval.ts 桶文件的拆分注记。

/** 长度桶阈值（2 的幂阶梯）：short/medium/long 的上界。数值是脱敏契约的
 *  一部分 —— 示范事件的 text_length_bucket 取值域由这三条边界划分（蒸馏
 *  下游可见的等价类），改动即改契约面，须连同示范事件消费者一并审计。 */
export const LENGTH_BUCKET_SHORT_MAX = 16;
export const LENGTH_BUCKET_MEDIUM_MAX = 64;
export const LENGTH_BUCKET_LONG_MAX = 256;

/** 初始有效期：一次确认覆盖整个任务（重定位目标/切窗重试）的窗口 */
export const TTL_MS = 600_000;
/** 单令牌尝试次数上限（物理点击数）—— 超限焚毁，重新审批 */
export const MAX_ATTEMPTS = 5;
/** 生命周期硬顶 = 铸造时 TTL 的 3 倍：重试续期的总天花板 */
export const LIFETIME_MULTIPLIER = 3;

/** 码空间：6 位十进制（10^6）。zerosafe：前导零合法且必须保留（padStart）。 */
export const CONFIRM_CODE_SPACE = 1_000_000;
/** 错码尝试封顶：达到即焚毁令牌。10^6 空间下 5 次命中的概率 5×10⁻⁶ ——
 *  给人类手误留足余量，给暴力枚举判死刑。 */
export const MAX_CODE_MISMATCHES = 5;
/** 批注原文预算（与 target_description 同律 —— Token 纪律与隐私截断） */
export const AMENDMENT_NOTE_MAX = 200;

/** 暂存超时缺省：5 分钟（X 分钟无人应答 ⇒ 降级暂存；可用 armApprovalQueue 覆盖） */
export const DEFAULT_STAGING_TIMEOUT_MS = 300_000;
/** 队列 TTL 缺省：24h（覆盖一夜 —— 晨报裁决的窗口；过期须重走完整审批） */
export const DEFAULT_QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
/** 队列封顶：64（无界队列 = 无界晨报 —— 封顶逼人工介入） */
export const MAX_QUEUE_ENTRIES = 64;
/** 持久化档版本 */
export const APPROVAL_QUEUE_VERSION = 1;
/** W6-3（W2-1 遗留清偿）：已拒条目保留期缺省 —— 7 天（deny 后的审计窗口；
 *  到期在下次队列落盘时清除，清理经计数器留痕，绝不静默消失。可经
 *  arm({deniedRetentionMs}) 注入覆盖；负值 = 部署显式关闭清理）。 */
export const DEFAULT_DENIED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
