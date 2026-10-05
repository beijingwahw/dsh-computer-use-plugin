// src/guards/sessionLru.ts
// ── ΠΑΝ-76（C2-1 F10）：守卫会话 LRU 的洪泛防护统一件 ──
//
// 病灶（批判取证）：circuitBreakerGuard / canaryGuard(预算账) / repeatActionGuard
// 三处按 sessionId 分键的 Map「插入序淘汰、命中不重插」——攻击者只需批量新建
// 会话即可把**熔断冷静期 / 探针预算 / 死循环记忆**等安全态键静默逐出（熔断被
// 绕过、预算上限被重置、循环记忆清零）。三处两种语义本身就是漂移病灶。
//
// 本件统一为「分保护区 + 全局上界 + 新会话速率限制」三律：
//   1. 分保护区（safety-tier）：isProtected(value) 为真的键（熔断在场/失败证据
//      在册/预算已消耗/循环样本在环）**不参与普通逐出**——新键入场只淘汰普通
//      （无安全内容的纯净）键；普通桶空且总量已达上界 ⇒ 新键被拒（见 3），
//      绝不为给新键腾位而驱逐安全态。安全态的离场通道只有两条：显式 clear
//      （插件卸载/测试隔离）与陈旧清扫（protectedIdleMs 无 touch ⇒ 遗忘——
//      会话静默 30 分钟后忘掉它的熔断记忆是诚实的有界周转，洪泛者触不到）。
//   2. 全局上界：protected + unprotected ≤ capacity——内存永不对会话数开放。
//   3. 新会话速率限制：每时间窗（翻窗制）最多接纳 maxNewKeysPerWindow 个**新键**
//      （既有键的 touch 不占额度）；超限的新键降级为「无历史」——调用方拿到
//      factory() 的临时实例但不驻留（不驱逐任何旧键）。方向取舍由调用方立法：
//      熔断/防死循环 ⇒ 无历史状态照常放行（可用性优先，只是不计账）；
//      金丝雀预算 ⇒ 视同预算耗尽（不试演——探针花的是真实物理动作，限流期
//      不给洪泛者无限量的 ephemeral 预算）。
//
// 热度刷新（对 F10「最旧创建的会话可能正是最活跃者」的修正）：get/admit/update
// 一律 delete+set 重插（popupGuard.writeCell 的既有正确语义收编为单源）。守卫
// 在 get 之外原地改写状态（如 st.window.push）不通知本件——桶籍在每次
// get/admit/淘汰扫描时按谓词**重算**（值是活引用，谓词读的是当下字段），
// 代价 O(capacity)，容量 ≤128 恒廉价。
//
// 纪律：本件绝不抛（守卫面铁律）；一切输入垃圾收敛为诚实返回值。
/** 分保护区会话 LRU（ΠΑΝ-76 立法件；导出供守卫与测试消费） */
export interface SessionLruOptions<V> {
  /** 全局上界（protected + unprotected 之和） */
  capacity: number;
  /** 安全态判据（读活值：每次 get/admit/淘汰扫描时重算桶籍） */
  isProtected: (value: V) => boolean;
  /** 时间窗内新键接纳上限（缺省 8 —— 翻窗制；既有键 touch 不占额度） */
  maxNewKeysPerWindow?: number;
  /** 时间窗宽度 ms（缺省 60s） */
  windowMs?: number;
  /** 安全态陈旧遗忘阈 ms（缺省 30min 无 touch ⇒ 清扫离场） */
  protectedIdleMs?: number;
  /** 注入钟（缺省 Date.now；测试离线确定性） */
  now?: () => number;
  /** 新键被限流时的记账钩子（遥测；本件不直接 import telemetry——保持纯件） */
  onNewKeyLimited?: (key: string) => void;
}

/** admit 的产出：value 恒可用（限流 ⇒ factory() 的临时实例）；limited=true 表示未驻留 */
export interface SessionLruAdmitResult<V> {
  value: V;
  limited: boolean;
}

interface ProtCell<V> {
  value: V;
  /** 最后一次 touch 的时钟读数（陈旧清扫判据；非身份 id） */
  at: number;
}

export class SessionLruCache<V> {
  private readonly opts: Required<Pick<SessionLruOptions<V>, 'capacity' | 'isProtected' | 'maxNewKeysPerWindow' | 'windowMs' | 'protectedIdleMs'>>;
  private readonly now: () => number;
  private readonly onNewKeyLimited?: (key: string) => void;
  /** 普通桶：无安全内容的键（Map 迭代序 = 热度序，delete+set 重插刷新） */
  private readonly unprot = new Map<string, V>();
  /** 安全桶：isProtected 为真的键（同热度序；携带 touch 时钟供陈旧清扫） */
  private readonly prot = new Map<string, ProtCell<V>>();
  /** 翻窗计数（新键接纳/拒绝；窗口起点） */
  private windowStart = 0;
  private windowAdmitted = 0;
  private windowRejected = 0;
  /** 累计被限流的新键数（观测面/测试锚点） */
  private limitedTotal = 0;

  constructor(opts: SessionLruOptions<V>) {
    this.opts = {
      capacity: Math.max(1, Math.floor(opts.capacity) || 1),
      isProtected: typeof opts.isProtected === 'function' ? opts.isProtected : () => false,
      maxNewKeysPerWindow: Math.max(1, Math.floor(opts.maxNewKeysPerWindow ?? 8) || 1),
      windowMs: Math.max(1, Math.floor(opts.windowMs ?? 60_000) || 1),
      protectedIdleMs: Math.max(1, Math.floor(opts.protectedIdleMs ?? 30 * 60_000) || 1),
    };
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.onNewKeyLimited = typeof opts.onNewKeyLimited === 'function' ? opts.onNewKeyLimited : undefined;
  }

  /** 惰性重算桶籍：值可能在 get 之外被原地改写（守卫直接 mutate 活引用） */
  private recomputeBucket(key: string): void {
    const cell = this.prot.get(key);
    if (cell !== undefined) {
      if (!this.opts.isProtected(cell.value)) {
        this.prot.delete(key);
        this.unprot.set(key, cell.value); // 降级为普通键（保留热度尾位）
      }
      return;
    }
    const v = this.unprot.get(key);
    if (v !== undefined && this.opts.isProtected(v)) {
      this.unprot.delete(key);
      this.prot.set(key, { value: v, at: this.now() }); // 升格安全键（晋升即记 touch）
    }
  }

  /** 陈旧清扫：安全键超过 protectedIdleMs 无 touch ⇒ 遗忘（洪泛触不到的离场通道） */
  private sweepStaleProtected(): void {
    const now = this.now();
    for (const [key, cell] of this.prot) {
      if (now - cell.at > this.opts.protectedIdleMs) this.prot.delete(key);
    }
  }

  /** 翻窗：窗口过期 ⇒ 计数归零重开（确定性：同窗内上限恒定） */
  private rollWindow(now: number): void {
    if (now - this.windowStart >= this.opts.windowMs || this.windowStart === 0) {
      this.windowStart = now;
      this.windowAdmitted = 0;
      this.windowRejected = 0;
    }
  }

  /** 读 + 热度刷新 + 桶籍重算（缺席 ⇒ undefined；绝不抛） */
  get(key: string): V | undefined {
    try {
      const cell = this.prot.get(key);
      if (cell !== undefined) {
        // delete+set 重插 = 热度刷新（F10：最旧创建≠最旧使用）
        this.prot.delete(key);
        this.prot.set(key, { value: cell.value, at: this.now() });
        this.recomputeBucket(key);
        return cell.value;
      }
      const v = this.unprot.get(key);
      if (v !== undefined) {
        this.unprot.delete(key);
        this.unprot.set(key, v);
        this.recomputeBucket(key);
        return v;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  has(key: string): boolean {
    return this.unprot.has(key) || this.prot.has(key);
  }

  /**
   * 既有键 ⇒ touch + 返回；新键 ⇒ 三道闸（陈旧清扫 → 窗口限流 → 普通桶腾位）
   * 全过则驻留，任一不过则返回 factory() 的**临时实例**（limited=true，不驱逐任何旧键）。
   */
  admit(key: string, factory: () => V): SessionLruAdmitResult<V> {
    try {
      if (this.has(key)) {
        return { value: this.get(key) as V, limited: false }; // 既有键：touch + 返回（不占新键额度）
      }
      const now = this.now();
      this.sweepStaleProtected();
      this.rollWindow(now);
      if (this.windowAdmitted >= this.opts.maxNewKeysPerWindow) {
        // ΠΑΝ-76：超限新键降级为「无历史」——绝不驱逐旧键来给它腾位
        this.windowRejected++;
        this.limitedTotal++;
        try { this.onNewKeyLimited?.(key); } catch { /* 记账钩子故障：吞 */ }
        return { value: factory(), limited: true };
      }
      if (this.unprot.size + this.prot.size >= this.opts.capacity) {
        // 上界已达：只淘汰普通桶最旧；普通桶空（全安全态）⇒ 拒收新键（限流）
        const oldestUnprot = this.unprot.keys().next().value;
        if (oldestUnprot === undefined) {
          this.windowRejected++;
          this.limitedTotal++;
          try { this.onNewKeyLimited?.(key); } catch { /* 记账钩子故障：吞 */ }
          return { value: factory(), limited: true };
        }
        this.unprot.delete(oldestUnprot);
      }
      const value = factory();
      if (this.opts.isProtected(value)) this.prot.set(key, { value, at: now });
      else this.unprot.set(key, value);
      this.windowAdmitted++;
      return { value, limited: false };
    } catch {
      return { value: factory(), limited: true }; // 防御式：簿记故障 ⇒ 无历史降级
    }
  }

  /**
   * 更新驻留值（fn 收旧值返新值；重插刷新热度 + 桶籍）。既有键 ⇒ fn 恰调用
   * 一次；新键 ⇒ fn(undefined) 的铸值先过 admit 三道闸再驻留（限流 ⇒ 不驻留）。
   * 返回是否**驻留生效**（限流 ⇒ false —— fn 的结果只落在临时值上由调用方处置）。
   */
  update(key: string, fn: (v: V) => V): boolean {
    try {
      const existing = this.get(key); // 命中即刷热度 + 重算桶籍
      if (existing !== undefined) {
        const next = fn(existing);
        if (this.opts.isProtected(next)) this.prot.set(key, { value: next, at: this.now() });
        else {
          this.prot.delete(key);
          this.unprot.set(key, next);
        }
        return true;
      }
      if (this.has(key)) return true; // 驻留值为 undefined 的病态键：不重铸（防御式）
      const r = this.admit(key, () => fn(undefined as unknown as V));
      return !r.limited;
    } catch {
      return false;
    }
  }

  /** 只读窥视（不刷热度；内部/观测用） */
  peek(key: string): V | undefined {
    return this.prot.get(key)?.value ?? this.unprot.get(key);
  }

  /** 全量条目（观测面：快照/测试；无序保证） */
  entries(): Array<[string, V]> {
    return [
      ...[...this.unprot.entries()],
      ...[...this.prot.entries()].map(([k, c]) => [k, c.value] as [string, V]),
    ];
  }

  /** 观测面：尺寸/限流计数（测试锚点 + 遥测诊断） */
  stats(): { total: number; protected: number; unprotected: number; limitedTotal: number } {
    return {
      total: this.unprot.size + this.prot.size,
      protected: this.prot.size,
      unprotected: this.unprot.size,
      limitedTotal: this.limitedTotal,
    };
  }

  /** 生命周期归零（插件卸载 / 测试隔离） */
  clear(): void {
    this.unprot.clear();
    this.prot.clear();
    this.windowStart = 0;
    this.windowAdmitted = 0;
    this.windowRejected = 0;
    this.limitedTotal = 0;
  }
}
