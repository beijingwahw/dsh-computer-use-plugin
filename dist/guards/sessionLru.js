export class SessionLruCache {
    opts;
    now;
    onNewKeyLimited;
    /** 普通桶：无安全内容的键（Map 迭代序 = 热度序，delete+set 重插刷新） */
    unprot = new Map();
    /** 安全桶：isProtected 为真的键（同热度序；携带 touch 时钟供陈旧清扫） */
    prot = new Map();
    /** 翻窗计数（新键接纳/拒绝；窗口起点） */
    windowStart = 0;
    windowAdmitted = 0;
    windowRejected = 0;
    /** 累计被限流的新键数（观测面/测试锚点） */
    limitedTotal = 0;
    constructor(opts) {
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
    recomputeBucket(key) {
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
    sweepStaleProtected() {
        const now = this.now();
        for (const [key, cell] of this.prot) {
            if (now - cell.at > this.opts.protectedIdleMs)
                this.prot.delete(key);
        }
    }
    /** 翻窗：窗口过期 ⇒ 计数归零重开（确定性：同窗内上限恒定） */
    rollWindow(now) {
        if (now - this.windowStart >= this.opts.windowMs || this.windowStart === 0) {
            this.windowStart = now;
            this.windowAdmitted = 0;
            this.windowRejected = 0;
        }
    }
    /** 读 + 热度刷新 + 桶籍重算（缺席 ⇒ undefined；绝不抛） */
    get(key) {
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
        }
        catch {
            return undefined;
        }
    }
    has(key) {
        return this.unprot.has(key) || this.prot.has(key);
    }
    /**
     * 既有键 ⇒ touch + 返回；新键 ⇒ 三道闸（陈旧清扫 → 窗口限流 → 普通桶腾位）
     * 全过则驻留，任一不过则返回 factory() 的**临时实例**（limited=true，不驱逐任何旧键）。
     */
    admit(key, factory) {
        try {
            if (this.has(key)) {
                return { value: this.get(key), limited: false }; // 既有键：touch + 返回（不占新键额度）
            }
            const now = this.now();
            this.sweepStaleProtected();
            this.rollWindow(now);
            if (this.windowAdmitted >= this.opts.maxNewKeysPerWindow) {
                // ΠΑΝ-76：超限新键降级为「无历史」——绝不驱逐旧键来给它腾位
                this.windowRejected++;
                this.limitedTotal++;
                try {
                    this.onNewKeyLimited?.(key);
                }
                catch { /* 记账钩子故障：吞 */ }
                return { value: factory(), limited: true };
            }
            if (this.unprot.size + this.prot.size >= this.opts.capacity) {
                // 上界已达：只淘汰普通桶最旧；普通桶空（全安全态）⇒ 拒收新键（限流）
                const oldestUnprot = this.unprot.keys().next().value;
                if (oldestUnprot === undefined) {
                    this.windowRejected++;
                    this.limitedTotal++;
                    try {
                        this.onNewKeyLimited?.(key);
                    }
                    catch { /* 记账钩子故障：吞 */ }
                    return { value: factory(), limited: true };
                }
                this.unprot.delete(oldestUnprot);
            }
            const value = factory();
            if (this.opts.isProtected(value))
                this.prot.set(key, { value, at: now });
            else
                this.unprot.set(key, value);
            this.windowAdmitted++;
            return { value, limited: false };
        }
        catch {
            return { value: factory(), limited: true }; // 防御式：簿记故障 ⇒ 无历史降级
        }
    }
    /**
     * 更新驻留值（fn 收旧值返新值；重插刷新热度 + 桶籍）。既有键 ⇒ fn 恰调用
     * 一次；新键 ⇒ fn(undefined) 的铸值先过 admit 三道闸再驻留（限流 ⇒ 不驻留）。
     * 返回是否**驻留生效**（限流 ⇒ false —— fn 的结果只落在临时值上由调用方处置）。
     */
    update(key, fn) {
        try {
            const existing = this.get(key); // 命中即刷热度 + 重算桶籍
            if (existing !== undefined) {
                const next = fn(existing);
                if (this.opts.isProtected(next))
                    this.prot.set(key, { value: next, at: this.now() });
                else {
                    this.prot.delete(key);
                    this.unprot.set(key, next);
                }
                return true;
            }
            if (this.has(key))
                return true; // 驻留值为 undefined 的病态键：不重铸（防御式）
            const r = this.admit(key, () => fn(undefined));
            return !r.limited;
        }
        catch {
            return false;
        }
    }
    /** 只读窥视（不刷热度；内部/观测用） */
    peek(key) {
        return this.prot.get(key)?.value ?? this.unprot.get(key);
    }
    /** 全量条目（观测面：快照/测试；无序保证） */
    entries() {
        return [
            ...[...this.unprot.entries()],
            ...[...this.prot.entries()].map(([k, c]) => [k, c.value]),
        ];
    }
    /** 观测面：尺寸/限流计数（测试锚点 + 遥测诊断） */
    stats() {
        return {
            total: this.unprot.size + this.prot.size,
            protected: this.prot.size,
            unprotected: this.unprot.size,
            limitedTotal: this.limitedTotal,
        };
    }
    /** 生命周期归零（插件卸载 / 测试隔离） */
    clear() {
        this.unprot.clear();
        this.prot.clear();
        this.windowStart = 0;
        this.windowAdmitted = 0;
        this.windowRejected = 0;
        this.limitedTotal = 0;
    }
}
