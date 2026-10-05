// src/subAgent.auction.ts
// W9-3（D-F4 拆分·拍卖分区）：自 subAgent.ts 低风险提取 —— W4-7（G5）步数拍卖
// 市场（纯整数最大余数分配/边际进展评分/出价与轮账契约）。逐字节搬运（零逻辑
// 变更）；subAgent.ts 原位再导出 —— 导入面不变（消费方零改动）。
// W4-7（G5）：经验晶体收缩率只读消费 —— swarm.ts 是 W4-2 领地，本模块不写它，
// 仅 import 其导出的纯函数 shrinkRate（结构化端口/只读消费律）。场景收敛先验的
// 数学因此与晶体 counterfactual 单源同构，无本地漂移副本。
import { shrinkRate } from './swarm.js';
// ─── W4-7（G5）：步数拍卖市场 —— 全局步数池 + 每 K 步重拍卖 ───
//
// 哲学：maxSteps 出生即定是「计划经济」；拍卖市场让步数预算随边际进展流动 ——
// 收敛快的场景多买步，收敛慢的场景省步数。三条铁律：
//   * 确定性：分配走纯整数最大余数法（bids×1000 成整数），无 RNG、无时钟、
//     无 Map 迭代序依赖 —— 同输入恒同输出（可重放、可审计、离线可测）。
//   * 饿死防护：每代理每轮至少 1 步保底（除非已退场）；连续 M 轮低进展者
//     降级为「提交部分发现优雅退场」（现有 report 通道 + retire 释放容量）。
//   * 防御式绝不抛：端口炸了按零证据处理，拍卖炸了保留既有配额下轮重试。
// 兼容律：拍卖默认关闭 —— 关闭时 chargeStep/spawn/report 走原路径逐字节一致
// （现有 subAgent 测试零回归）；开启时 maxSteps 语义变为「共享池上限」并在
// 拍卖账本（报告环）genesis 条目中显式说明。
/** W4-7（G5）：重拍卖周期（每 K 个扣费动作步触发一次拍卖） */
export const AUCTION_EPOCH_K = 10;
/** W4-7（G5）：连续低进展降级阈值（连续 M 轮收缩先验 < 舰队基率 ⇒ 优雅退场） */
export const AUCTION_DEMOTE_ROUNDS = 3;
/** W4-7（G5）：拍卖账本（报告环）容量 —— 有界防漂移 */
export const AUCTION_LEDGER_MAX = 32;
/** W4-7（G5）：零证据时的舰队基率缺省（与晶体 counterfactual 的 0.5 同律） */
export const AUCTION_DEFAULT_GLOBAL_RATE = 0.5;
/** W4-7（G5）：三位小数舍入（先验/出价的账面精度 —— 与 shrinkRate 同律） */
export const r3 = (x) => Math.round(x * 1000) / 1000; // W9-3：协调器同律消费，升导出
/**
 * W4-7（G5）：边际进展分（纯函数，确定性）。
 * bid = 场景收敛先验 × 自报未完成度：
 *   * 先验 = shrinkRate(successes, attempts, globalRate) —— 晶体数学只读消费
 *     （经验贝叶斯收缩：稀疏证据向舰队基率回撤，「2 次尝试 100% 成功」不是 1.0）；
 *   * 零证据（attempts ≤ 0 / 缺席）⇒ 先验 = 舰队基率（无辜推定，均匀入场）；
 *   * 未完成度钳制 [0,1]，非法值按 1（全然未完成）处理；基率非法回退 0.5。
 * 语义：先验高（场景在收敛）× 未完成度高（多做一步的边际价值大）⇒ 值得多买步。
 */
export function marginalProgressScore(evidence, incompleteness, globalRate) {
    const inc = typeof incompleteness === 'number' && Number.isFinite(incompleteness)
        ? Math.max(0, Math.min(1, incompleteness)) : 1;
    const g = typeof globalRate === 'number' && Number.isFinite(globalRate)
        ? Math.max(0, Math.min(1, globalRate)) : AUCTION_DEFAULT_GLOBAL_RATE;
    const attempts = evidence && Number.isFinite(evidence.attempts) ? Math.floor(evidence.attempts) : 0;
    if (attempts <= 0)
        return r3(g * inc); // 零证据 ⇒ 先验回退基率（诚实降级）
    const successes = Math.max(0, Math.min(attempts, evidence && Number.isFinite(evidence.successes) ? Math.floor(evidence.successes) : 0));
    return r3(shrinkRate(successes, attempts, g) * inc);
}
/**
 * W4-7（G5）：配额分配（纯函数，确定性整数算法 —— 拍卖的心脏）。
 * 输入出价数组（下标即代理序）与总额 T，输出各代理配额：
 *   ① 饿死防护：T ≥ n 时每代理保底 1 步；T < n 时按代理序保底前 T 个（诚实降级）；
 *   ② 剩余按出价比例分配：份额 = bid_i·rem/Σbid。整数律：bids×1000 成整数后
 *     分子/分母全整数 —— floor 与小数部分（同分母的余数）可精确比较，零 FP 噪声；
 *   ③ 最大余数法派发零头：小数部分大者先得，平手按代理序（下标升序）；
 *   ④ 全零出价 ⇒ 均分（floor + 零头按代理序）—— 零证据市场的缺省公平。
 *
 * ΠΑΝ-124（平票与先占规则显式立法 · C1-3 L-14 清偿）：本函数的**全部**
 * 平票/先占裁决点逐条成文，消除「先 spawn 者确定性占优」这类隐式规则：
 *   P1【池不足先占律】T < n 时按下标升序保底前 T 个 —— 先入名册（先 spawn）
 *       者先占。这是**有意立法**：池不足以全员保底时，任何分配都是偏爱，
 *       出生序是唯一无 RNG、无时钟、可重放的偏爱源；后 spawn 者在下一轮
 *       池宽裕时自动补齐（每轮重拍卖，非终身劣势）。
 *   P2【余数平票律】最大余数法的小数部分平手 ⇒ 下标升序先得（③ 已立法）。
 *   P3【全零均分平票律】零证据市场的均分零头 ⇒ 下标升序先得（④ 已立法）。
 *   P4【零出价保底律】自报完成（bid=0）者仍得保底 1 步 —— 有意立法：保底
 *       是「确认退场/收尾」的机会成本（完成者用它提交最终报告），不是浪费；
 *       且轮内配额执法对 0 配额者会跳过（不产生额外物理动作）。
 *   P5【确定性总律】以上裁决点全序确定（无 sort 稳定性依赖、无 Map 迭代序
 *       依赖）—— 同输入恒同输出；执法测试以重放全等 + 平票手算例锁定。
 */
export function allocateQuotas(bids, total) {
    const n = bids.length;
    if (n === 0)
        return [];
    const T = typeof total === 'number' && Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
    const out = new Array(n).fill(0);
    if (T === 0)
        return out;
    if (T < n) {
        // ΠΑΝ-124 P1（池不足先占律）：下标升序保底前 T 个 —— 出生序偏爱成文立法
        for (let i = 0; i < T; i++)
            out[i] = 1;
        return out;
    }
    // ΠΑΝ-124 P4（零出价保底律）：bid=0 的完成者同样得保底（见函数头注立法）
    for (let i = 0; i < n; i++)
        out[i] = 1; // 饿死防护：每代理每轮至少 1 步
    const rem = T - n;
    if (rem === 0)
        return out;
    const mBids = bids.map(b => Math.max(0, Math.round((typeof b === 'number' && Number.isFinite(b) ? b : 0) * 1000)));
    const B = mBids.reduce((s, m) => s + m, 0);
    if (B <= 0) {
        // 全零出价 ⇒ 均分（floor + 零头按代理序）—— ΠΑΝ-124 P3：平票裁决点成文
        const base = Math.floor(rem / n), extra = rem % n;
        for (let i = 0; i < n; i++)
            out[i] += base + (i < extra ? 1 : 0);
        return out;
    }
    const floors = [];
    const fracNums = []; // 小数部分 × B（整数表示 —— 同分母可精确比较）
    let allocated = 0;
    for (let i = 0; i < n; i++) {
        const num = mBids[i] * rem; // 份额分子（整数）：份额 = num / B
        floors.push(Math.floor(num / B));
        fracNums.push(num % B);
        allocated += floors[i];
    }
    for (let i = 0; i < n; i++)
        out[i] += floors[i];
    let leftover = rem - allocated;
    const order = fracNums
        .map((f, i) => ({ f, i }))
        .sort((a, b) => b.f - a.f || a.i - b.i); // 小数大者先得；平手按代理序（ΠΑΝ-124 P2 立法点）
    for (let k = 0; k < order.length && leftover > 0; k++, leftover--)
        out[order[k].i] += 1;
    return out;
}
