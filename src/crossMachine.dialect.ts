// src/crossMachine.dialect.ts
// W6-2（doctor smell.over-engineering 清偿）：自 crossMachine.ts 低风险分区提取
// （>500 行拆分信号）—— 传输方言（纯类型面，零运行时代码）整体搬迁，行为零变化。
// crossMachine.ts 以 export * 再分发，导入面不变（orchestrator / w5cross 测试零改动）；
// 立法常量按「立法在源」测试（w5cross ⑩）锁定留守 crossMachine.ts。

// ─── 传输方言（纯逻辑核心与 HTTP 壳共用；测试注内存桩 = 零网络确定性）───

/** W5-3：barrier 操作种类（allocate=阶段一抵达；commit=阶段二确认；status=只读） */
export type BarrierOp = 'allocate' | 'commit' | 'status';

/** W5-3：领域拒绝原因（诚实失败词表 —— 客户端按 reason 决策，绝不猜） */
export type BarrierViewReason =
  | 'bad-request'      // 形状/值域非法（状态不动）
  | 'unknown-barrier'  // name 无在役 generation（且序号不落后 ⇒ 非重放）
  | 'stale-seq'        // 旧 generation 重放（序号防重放的执法面）
  | 'unknown-seq'      // 超前序号（臆造/错位包）
  | 'count-conflict'   // 与在役 generation 的 expected 不符（两个半 barrier 永不合并）
  | 'not-a-participant'// commit 者不在名册（无票可确认）
  | 'not-released'     // 放行前的 commit（两阶段纪律：确认只能跟在放行后）
  | 'missed-release';  // 放行后的迟到加入（脑裂守卫：不能悄悄混入已放行的轮次）

/** W5-3：barrier 视图（中继端对 generation 的完整诚实面；ok:false ⇒ reason 在场） */
export interface BarrierView {
  ok: boolean;
  reason?: BarrierViewReason;
  name?: string;
  /** generation 序号（防重放锚） */
  seq?: number;
  phase?: 'collecting' | 'committed';
  /** 名册规模 N（创建时钉死） */
  expected?: number;
  /** 已抵达名册（字典序 —— 确定性输出） */
  arrived?: string[];
  /** 已确认名册（阶段二进度） */
  acked?: string[];
  /** 放行时刻（epoch ms；collecting ⇒ null） */
  releasedAt?: number | null;
  /** 仅 commit 响应：本次确认是否使 generation 退休（全 N 已确认） */
  retired?: boolean;
}

/** W5-3：barrier 传输面（真 HTTP / 内存桩皆可注入 —— 测试零网络） */
export type BarrierTransport = (req: BarrierRequest) => Promise<BarrierView>;

/** W5-3：barrier 请求（op 决定必填字段：allocate 需要 n；commit 需要 seq） */
export interface BarrierRequest {
  op: BarrierOp;
  name: string;
  peer: string;
  n?: number;
  seq?: number;
}
