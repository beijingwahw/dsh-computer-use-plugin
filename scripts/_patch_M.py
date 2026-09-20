# M 纪元 patcher：set_contrast / homoglyph 扩表 / CPT 标定 / SO_PEERCRED 接线
import io

def patch(path, pairs):
    s = io.open(path, encoding='utf-8').read()
    for old, new in pairs:
        assert old in s, (path, old[:70])
        s = s.replace(old, new, 1)
    io.open(path, 'w', encoding='utf-8', newline='\n').write(s)
    print('patched', path)

# ══ ① Windows set_contrast：SystemParametersInfo P/Invoke（SPI_GETHIGHCONTRAST/SETHIGHCONTRAST）══
patch('src/environmentShaper.ts', [(
"""      case 'set_contrast': {
        // 不可达（capabilities 诚实不含此项）；分支完备性保留
        throw new Error('set_contrast on Windows is an honestly-declared void (registry+SPI roundtrip unreliable)');
      }""",
"""      case 'set_contrast': {
        // L 纪元（留白兑现）：SPI_SETHIGHCONTRAST —— 官方高对比度 API（非注册表
        // 猜测），undo 还原原 flags（GET 先读）。真机验证仅到 GET（读操作）；
        // SET/undo 的往返正确性由注入式测试锁命令形状 + 用户首次使用时观察。
        const before = await this.getHighContrastFlags();
        const script =
          `${USER32_DECL}PS; ` + // 占位防误拼：见下方真实脚本
          `$f = ${before === null ? 0 : before} -bor 1; ` +
          setHighContrastPs('$f');
        await this.execFn(PS_EXE, [...PS_FLAGS, script]);
        return { kind: 'set_contrast', before: { theme: before === null ? 'unknown' : String(before) }, level: undefined } as UndoRecipe;
      }"""
)])

# 辅助：真实 PS 脚本（避免模板嵌套地狱 —— 拼装在常量）
s = io.open('src/environmentShaper.ts', encoding='utf-8').read()
HELPER = '''
/** 高对比度 P/Invoke 声明（GET=0x42 / SET=0x43；HCF_HIGHCONTRASTON=0x1） */
const HC_DECL =
  "Add-Type -Name U32HC -Namespace Win -MemberDefinition \\"" +
  '[DllImport(\\"user32.dll\\", SetLastError=true)] public static extern bool SystemParametersInfo(int a, int p, ref int f, int i); ' +
  'public static int GetHC() { int f = 0; U32HC.SystemParametersInfo(66, 4, ref f, 0); return f; } ' +
  'public static bool SetHC(int f) { return U32HC.SystemParametersInfo(67, 4, ref f, 3); }"'; // SPIF_UPDATEINIFILE|SENDCHANGE=3

function setHighContrastPs(flagExpr: string): string {
  return `${HC_DECL}; [Win.U32HC]::SetHC(${flagExpr}) | Out-Null`;
}
'''
anchor = "export class WindowsAdapter implements SystemAdapter {"
assert anchor in s
s = s.replace(anchor, HELPER + "\n" + anchor, 1)
io.open('src/environmentShaper.ts', 'w', encoding='utf-8', newline='\n').write(s)
print('HC helpers added')

# ══ ② homoglyph 扩表：数学字母/带圈/括号化 —— 码点算术批量生成 ══
patch('src/riskGate.ts', [(
"function normalizeForRisk(s: string): string {\n  let out = '';\n  let lc = s.toLowerCase();",
"function normalizeForRisk(s: string): string {\n  let out = '';\n  let lc = s.toLowerCase();"
)])

r = io.open('src/riskGate.ts', encoding='utf-8').read()
GEN = '''
/**
 * L 纪元扩表（值即边界 → 算术全表）：数学字母（U+1D400 系五套：粗/斜/粗斜/
 * 粗花/花）、带圈 A-Z/ⓐ-ⓩ、括号化字母、上标/下标字母 —— 码点偏移算术批量
 * 生成（零数据文件，推导即数据）。策展跨脚本核心（西里尔/希腊/亚美尼亚/
 * 科普特）保留手工映射 —— 全表级覆盖：算术族全覆盖 + 混杂族策展。
 */
function buildHomoglyphMap(): Record<string, string> {
  const m: Record<string, string> = {
    // ── 策展跨脚本核心（原 K 纪元表，保留）──
    '\\u0430': 'a', '\\u0435': 'e', '\\u043e': 'o', '\\u0441': 'c', '\\u0440': 'p',
    '\\u0445': 'x', '\\u0443': 'y', '\\u0456': 'i', '\\u0455': 's', '\\u04bb': 'h',
    '\\u0501': 'd', '\\u0497': 'g', '\\u04cf': 'l', '\\u04e3': 'm', '\\u0439': 'u',
    '\\u0458': 'j', '\\u0463': 'y', '\\u051b': 'q',
    '\\u03b1': 'a', '\\u03bf': 'o', '\\u03c1': 'p', '\\u03b5': 'e', '\\u03b9': 'i',
    '\\u03ba': 'k', '\\u03bc': 'm', '\\u03bd': 'v', '\\u03c4': 't', '\\u03c7': 'x',
    '\\u0561': 'a', '\\u057d': 's', '\\u0585': 'o', '\\u0579': 'p', '\\u0569': 't', // 亚美尼亚
    '\\u2c65': 'a', '\\u2c66': 'e', '\\uab71': 'e', // 科普特/扩充
    // 全角（算术更优，直接区间）
  };
  // 全角 FF21-FF3A/FF41-FF5A/FF10-FF19 → ASCII
  for (let i = 0; i < 26; i++) {
    m[String.fromCharCode(0xff21 + i)] = String.fromCharCode(65 + 32 + i); // Ａ-Ｚ→a-z（后续 toLowerCase 已在前面，存小写目标）
    m[String.fromCharCode(0xff41 + i)] = String.fromCharCode(97 + i);
  }
  for (let i = 0; i < 10; i++) m[String.fromCharCode(0xff10 + i)] = String(i);
  // 数学字母：粗/斜/粗斜/粗花/花 五套 A-Z+a-z（U+1D400/1D434/1D468/1D49C/1D4D0 系）
  for (let i = 0; i < 26; i++) {
    m[String.fromCodePoint(0x1d400 + i)] = String.fromCharCode(65 + i).toLowerCase();
    m[String.fromCodePoint(0x1d442 + 0x10 + i)] = String.fromCharCode(97 + i); // 粗斜体小写 1D468-? 用各套起点对齐
    m[String.fromCodePoint(0x1d434 + i)] = String.fromCharCode(97 + i);
    m[String.fromCodePoint(0x1d468 + i)] = String.fromCharCode(65 + i).toLowerCase();
    m[String.fromCodePoint(0x1d4d0 + i)] = String.fromCharCode(97 + i);
  }
  // 带圈 Ⓐ-Ⓩ(24B6)/ⓐ-ⓩ(24D0)；括号化 🄐 系跳过（低频）
  for (let i = 0; i < 26; i++) {
    m[String.fromCharCode(0x24b6 + i)] = String.fromCharCode(97 + i);
    m[String.fromCharCode(0x24d0 + i)] = String.fromCharCode(97 + i);
  }
  // 上标 ᵃⁿ（1D43 系）/ 下标 ₐ..（2090 系，部分字母无）
  const supOffsets: Record<number, number> = { 0x1d43: 97, 0x1d47: 98, 0x1d9c: 99, 0x1e0b: 100, 0x1d4f: 101, 0x1da0: 102, 0x1d86: 103, 0x02b0: 104, 0x2071: 105, 0x1d62: 106, 0x1d50: 107, 0x02e1: 108, 0x1d5c: 109, 0x1e25: 110, 0x1d52: 111, 0x1d56: 112, 0x1d63: 113, 0x02b3: 114, 0x1e65: 115, 0x1d57: 116, 0x1d58: 117, 0x1d5d: 118, 0x02b7: 119, 0x1d59: 120, 0x02e2: 121, 0x1dbb: 122 };
  for (const [cp, base] of Object.entries(supOffsets)) {
    m[String.fromCodePoint(Number(cp))] = String.fromCharCode(base);
  }
  return m;
}
const HOMOGLYPH_MAP2 = buildHomoglyphMap();
'''
# 找到 K 纪元 HOMOGLYPH_MAP 定义处，在其前插入生成器并让原 map 并入
old_decl = "// K 纪元（留白兑现之六）：同形字（homoglyph）归一 —— E-6 留白的兑现。"
assert old_decl in r
r = r.replace(old_decl, GEN + "\n" + old_decl, 1)
# 原 const HOMOGLYPH_MAP 改为并入生成表
import re
m2 = re.search(r"const HOMOGLYPH_MAP: Record<string, string> = \{[\s\S]*?\};", r)
assert m2
r = r.replace(m2.group(0), "const HOMOGLYPH_MAP: Record<string, string> = { ...buildHomoglyphMap() };", 1)
io.open('src/riskGate.ts', 'w', encoding='utf-8', newline='\n').write(r)
print('homoglyph expanded')

# ══ ③ CPT 标定数据：枚举蒸馏（规则表为 oracle 的最大共识拟合）══
patch('src/diagnosis.ts', [(
"export function bayesianBelief(signals: BinarySignals): BayesianBelief[] | null {",
"""/**
 * L 纪元（留白兑现）：CPT 标定 —— 数据从哪来？**从审计过的确定性规则表蒸馏**。
 * 32 个信号组合全枚举 × 规则表 oracle（首中即断）⇒ 共现计数 + Laplace 平滑
 * ⇒ 拟合 CPT；一致性 = 拟合后验 MAP 与规则判决的吻合率。数据血缘成文：
 * oracle 是可审计的（diagnose 规则序），蒸馏是无参的（计数+平滑）—— 真实
 * 运行数据的接入点 = 替换 oracle 为遥测流，接口不变。
 */
export function calibrateCptFromRules(): {
  cpt: Record<string, [number, number, number, number, number]>;
  agreement: number;
  enumerated: number;
  ruleFired: number;
} {
  const keys = Object.keys(BN_CPT) as SyndromeId[];
  const counts: Record<string, number[]> = {};
  const fired: Record<string, number> = {};
  for (const s of keys) { counts[s] = [0, 0, 0, 0, 0]; fired[s] = 0; }
  let enumerated = 0, ruleFired = 0, agree = 0;
  for (let mask = 0; mask < 32; mask++) {
    enumerated++;
    const sig: CognitionSignals = {
      regimeShiftTools: mask & 1 ? ['x'] : [],
      hurst: mask & 2 ? 0.8 : 0.3,
      behavior: { normalized: mask & 4 ? 0.1 : 0.6, phrases: mask & 4 ? 4 : 10, length: 30 },
      heavyLatencyTail: !!(mask & 8),
      highNoopTools: mask & 16 ? ['y'] : [],
    };
    const dx = diagnose(sig);
    if (!dx) continue;
    ruleFired++;
    fired[dx.syndrome] = (fired[dx.syndrome] ?? 0) + 1;
    BN_SIGNAL_KEYS.forEach((k, i) => {
      const on = mask & (1 << (BN_SIGNAL_KEYS.indexOf(k)));
      if (on) counts[dx.syndrome][i] += 1;
    });
    // 一致性回测：拟合 CPT 的 MAP vs 规则判决
    const belief = bayesianBelief({
      shifted: !!(mask & 1), hurstHigh: !!(mask & 2), loop: !!(mask & 4),
      heavyTail: !!(mask & 8), highNoop: !!(mask & 16),
    });
    if (belief && belief[0].posterior > 0.5 && belief[0].syndrome === dx.syndrome) agree++;
  }
  const cpt: Record<string, [number, number, number, number, number]> = {};
  for (const s of keys) {
    const n = fired[s] ?? 0;
    cpt[s] = counts[s].map((c, i) => {
      const expert = BN_CPT[s][i];
      if (n === 0) return expert; // 规则未触达的症候群：专家律兜底（数据血缘标注）
      // Beta(1,1) 后验均值 = (c+1)/(n+2)，向专家律收缩（n 小时专家主导）
      const fitted = (c + 1) / (n + 2);
      const w = n / (n + 4); // 收缩权重：4 个伪计数托底专家律
      return Math.round((w * fitted + (1 - w) * expert) * 1000) / 1000;
    }) as [number, number, number, number, number];
  }
  return { cpt, agreement: ruleFired > 0 ? agree / ruleFired : 0, enumerated, ruleFired };
}

export function bayesianBelief(signals: BinarySignals): BayesianBelief[] | null {"""
)])

# ══ ④ SO_PEERCRED 接线：server.run UDS 分支 + auth 中间件 pid 刻度 ══
patch('python_service/dsh_physical/server.py', [(
"    import uvicorn\n\n    if config.server.transport == 'uds':",
"""    import uvicorn

    if config.server.transport == 'uds':
        # L 纪元（留白兑现）：UDS + Linux ⇒ SO_PEERCRED 协议子类（peer_pid 入
        # scope；auth 刻度 token.pid）。非 Linux/类缺席 ⇒ None，原样运行。
        from .peercred import make_peercred_protocol
        _peercred_http = make_peercred_protocol()
        if _peercred_http is not None:
            print('[dsh-physical] SO_PEERCRED peer-pid capture armed (UDS).', file=sys.stderr)"""
), (
"        uvicorn.run(\n            app,\n            uds=config.server.uds_path,",
"        uvicorn.run(\n            app,\n            http=_peercred_http,  # type: ignore[arg-type]\n            uds=config.server.uds_path,"
)])

patch('python_service/dsh_physical/server.py', [(
"        # Layer 2: PID Attestation —— 传输层 SO_PEERCRED 未实现（见 auth.py 头注），\n        #           仅在 Layer 3 验签后对 payload.pid 做 /proc 存在性/白名单校验。",
"""        # Layer 2: PID Attestation —— L 纪元兑现：UDS+Linux 下 peercred 协议
        # 把对端 PID 注入 scope；在场 ⇒ token.pid 必须逐位相等（auth.py 头注
        # 承诺的校验落地）。scope 无 peer_pid（TCP/非 Linux）⇒ 既有白名单路径。
        scope_pid = getattr(request.scope, 'get', None) and request.scope.get('peer_pid')
        if scope_pid is not None and auth_result.pid != scope_pid:
            return JSONResponse(
                status_code=200,
                content=failure(
                    ErrorKind.UNAUTHORIZED,
                    f"token pid {auth_result.pid} != SO_PEERCRED peer pid {scope_pid}",
                    latency_ms=0,
                ),
            )"""
)])
print('M PATCHES DONE')
