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
//   · 批量裁决 —— adjudicate(ids, grant, note) 复用 W1-2 批注协议：一次批注
//     可携带对多项的裁决，每个条目按自身描述各铸一份 amendment（透传给续跑
//     执行令牌）。每项 grant 消耗一枚 Y-10 同意预算令牌（批量裁决不是 click-
//     fatigue 的后门：一夜批 100 个不可逆操作仍然被桶封顶）；deny 不计费；
//   · TTL 保守律 —— 条目过期**不自动作废**：grant 过期条目被拒绝
//     （ttl-expired，须重走完整审批 —— 带外码人证重新铸造），条目留在队列
//     里持续出现在晨报中直到用户显式 deny（宁可唠叨，不可静默蒸发）；
//   · 续跑 —— takeGranted() 落盘先行（持久化失败 ⇒ 拒绝交出执行权 —— 宁可
//     保守不可双发），然后铸造一枚**已授予**的执行令牌（amendment 随行，
//     执行侧 applyAmendment 照常消费；不重复扣 Y-10 —— 批量裁决时已扣）。
//     条目的 stepCursor（入队时 journal 条数）是续跑步账：恢复后只重演此后
//     的步骤，已暂存的可逆部分不重复执行；
//   · 防御式 —— 本段一切公开面绝不抛：存储/时钟/输入垃圾一律收敛为诚实
//     返回值（ok:false + reason / 归零恢复），错误细节记入 queueStats()。
import { existsSync, readFileSync, renameSync, mkdirSync, unlinkSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
/** W2-1（H4）：文件存储实现（原子写：tmp + fsync + rename —— checkpoint.ts 同律） */
export function createApprovalQueueFileStorage(filePath) {
    return {
        load() {
            try {
                if (!filePath || !existsSync(filePath))
                    return null;
                const text = readFileSync(filePath, 'utf8');
                return typeof text === 'string' && text.trim() !== '' ? text : null;
            }
            catch {
                return null; // 读故障（含 ENOENT 竞态）= 无持久化队列（诚实方向）
            }
        },
        save(text) {
            if (!filePath)
                return { ok: false, error: 'approval-queue path is empty' };
            const tmp = filePath + '.tmp';
            try {
                mkdirSync(path.dirname(filePath), { recursive: true });
                // fsync 落盘后再换名：rename 可先于数据块持久化 —— 崩溃后可能读到空/截断档
                const fd = openSync(tmp, 'w');
                try {
                    writeSync(fd, Buffer.from(text, 'utf8'));
                    fsyncSync(fd);
                }
                finally {
                    closeSync(fd);
                }
                renameSync(tmp, filePath); // 原子换名：要么完整旧档要么完整新档，绝无半档
                return { ok: true };
            }
            catch (e) {
                try {
                    unlinkSync(tmp);
                }
                catch { /* tmp 可能未创建 */ }
                return { ok: false, error: e instanceof Error ? e.message : String(e) };
            }
        },
    };
}
