// src/sandbox/apply.ts
// ΠΑΝ-39（死接线修复 · 单一装配函数）：D-5 沙箱栈的完整装配面。
// 病灶（C2-3 H1）：dsh.plugin.json 的 entry 唯一指向 dist/index.js（根插件），
// 而根插件从不装载 sandbox-execution-plugin ⇒ 4 个工具从未注册、三条事件接线
// 从未发生、engine.configure/persistMemory/sandboxLog.configure 从未执行 ——
// 487 行装配层（含宿主执行器适配）在生产不可达；D-6/D-7 复用 sandboxLog 的
// pipeline-*/knowledge-* 段因此永不落盘（log.append 的 `if (this.filePath)`
// 恒 false，"append-only 哈希链账本"实为进程内存态 —— 双断点）。
// 修法：装配收口为单一导出函数 applySandboxStack(ctx, config, ports?) ——
// engine.configure / sandboxLog 落盘 / 三条事件接线 / 四个工具注册全部在此，
// 接受注入端口保持可测（引擎/执行器/验证参数均可替换）。插件入口（index.ts
// 的 apply）与宿主组合根（src/index.ts）都只是本函数的一行挂线：
//   ctx.plugin(require('./sandbox'))            // cordis 装配（插件入口自调本函数）
//   —— 或在组合根直接：applySandboxStack(ctx, sandboxConfig)
// 物理法则合规：一切皆插件（标准 apply 委派）/ 依赖驱动加载（可选服务缺席
// 诚实降级）/ 可逆注册与隔离（ctx.effect 登记清理）/ 事件总线通信（与 D-1/
// D-4/宿主管线零直接调用）/ 可观测性对齐（沙箱独立哈希链账本）。
// Token 纪律：工具返回只进紧凑数字（尝试/漂移/置信度），全量证据走 reportPath。
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  onCognitionPlanReady, onDoctorVerdict, onHostToolPost, sniffFingerprint,
  isBinaryFingerprint,
} from './events';
import { sandboxLog } from './log';
import { SandboxEngineImpl } from './engine';
import { validateActionChainInput, validateVirtualSceneInput } from './actionSchema';
import {
  muscleReliability, type HostExecutor, type HostExecutorStepResult,
  type SandboxConfig, type VirtualWidget,
} from './types';
// ΠΑΝ-42：链级效果验证复用 actionVerifier 的终帧 dHash 路径 —— type-only 装载
// （运行时懒动态 import，模块图零新增边；apply.ts 是 D-5 唯一允许 import 根层
// 模块的装配特权文件，与既有 ../system/../journal 懒导入同律）。
import type { BeforeState } from '../actionVerifier';

// ══════════════════════════════════════════════════════════════════════
// ── ΑΩ-R19/ΝΩ-1：宿主执行器适配层（physicalBackend 动作面 → HostExecutor 端口）──
// ══════════════════════════════════════════════════════════════════════
// 装配层特权：本文件是 D-5 唯一允许 import 根层模块的文件（engine 保持零根层
// 依赖 —— 破环纪律）。懒导入根层模块：开关关闭时模块图与现状一致。
// ΝΩ-1（宿主安全链接入）：适配层全部派发经 system 层包装 —— 黑名单/
// dryRun/互斥队列全部继承宿主唯一事实源；坐标方言对齐宿主 replayActions.
// replayOneTraced（沙箱归一化 [0,1]² → getScreenSize 单次读取 → 像素域，system
// 内部再归一化回 [0,1]，往返恒等零漂移）。适配器执法端口契约：永不抛 —— 一切
// 异常/非法参数收敛为 ok:false + note 归因。切签方言对齐宿主 replayActions.
// replayOne：ctrl(+shift)+tab 热键（同一事实源的宿主词表，不另造第二套切签机制）。
// ioMutex 取舍（ΝΩ-1）：serialize 非重入（嵌套即死锁 —— system.pressHotkey 的
// set_zoom 前例外正因此立法），故重放不持整链一把锁，而是每步派发各自经 system
// 内的互斥队列（同一 ioMutex、同一到达序），步间顺序由 await 串行保证 —— 等价
// 于"分段持锁"：重放派发与宿主其余物理 IO 永不交错执行，链级原子性不主张
//（诚实注记：步间隙允许其他宿主动作入队，与宏重放 replay_actions 同律）。
// ΝΩ-1 审计接线：每次派发经 journal.appendMarker 提交 SANDBOX_HOST_REPLAY
// 存证行（结果三态 ok/failed/threw；脱敏纪律同 GUARD_PROBE 先例 —— 只记动作
// 种类/归一坐标/字符计数，文本内容/标题关键词/令牌零明文）。fail-open：审计
// 通道故障绝不瘫痪派发（GUARD_PROBE 同律 —— 这里被审计的是已过五门的重放，
// 不是越权动作）。JournalMarker 联合的 SANDBOX_HOST_REPLAY 扩展归宿主账本侧
//（journal.ts）立法；联合未扩展时运行时被 MARKER_TOOLS 门控静默 no-op（诚实
// 缺席）。窄类型视图单点收口（events.ts 对 ctx.emit 的集中 as-any 同方言）。
type HostMarkerSink = { appendMarker(marker: Record<string, unknown>): Promise<void> | void };

/** ΝΩ-1：guardDryRun 在场探测。system 层的 dryRun 守卫不抛不返错（静默吞派发
 *  —— 提示词调试语义），宿主重放若把静默吞当成派发成功即是谎言，故须显式拒绝。
 *  探测原语：零量滚动 —— dryRun 在场 ⇒ guardDryRun 在 system.scroll 同步入口
 *  打印 '[dry-run] …' 后早退（零服务接触、零世界触碰）；dryRun 缺席 ⇒
 *  scrollPage(down, 0) 物理零位移（或服务报错 ⇒ 探测不可判定，如实放行，交由
 *  真实派发自己诚实归因）。'[dry-run]' 前缀全库唯一（system.ts guardDryRun 的
 *  唯一打印点）。侦听只覆盖同步调用窗（JS 单线程，无异步交错窗口）；转发原
 *  console.log，日志零丢失。纯探测、永不抛。 */
function guardDryRunPresent(sys: typeof import('../system')): boolean {
  let hit = false;
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[dry-run]')) hit = true;
    return orig(...args);
  };
  try {
    sys.system.scroll('down', 0).catch(() => { /* 探测原语自身失败 = 不可判定，旁路 */ });
  } catch {
    /* 同步抛 = 不可判定：后续真实派发自会诚实归因 */
  } finally {
    console.log = orig;
  }
  return hit;
}

/** ΝΩ-1：无机械动作的步（noop / dismiss_popup 模型侧占位）—— 无派发即无
 *  guardDryRun 吞没风险，免探测免审计（与宿主 replayOne 的无害占位同律）。 */
const NON_PHYSICAL_KINDS = new Set(['noop', 'dismiss_popup']);

/** ΠΑΝ-42：链级效果验证的参数面（缺省对齐宿主 config 缺省 —— actionSettleMs
 *  400 / noopSimilarityThreshold 0.97 / adaptiveSettle true；装配方可注入部署
 *  实值，测试可注入快时钟小窗）。 */
export interface HostExecutorVerifyOptions {
  /** 动作后固定等待 ms（adaptive=false 时生效；缺省 400 —— config.actionSettleMs 同缺省） */
  settleMs?: number;
  /** 相似度高于此 = 判无效果（缺省 0.97 —— config.noopSimilarityThreshold 同缺省） */
  threshold?: number;
  /** 自适应稳定等待（缺省 true —— config.adaptiveSettle 同缺省） */
  adaptive?: boolean;
  /** F4-4（终验工单）：before 基线取证注入缝 —— 缺省 undefined = 生产路径
   *  懒动态 import actionVerifier（ΠΑΝ-42 原行为逐字节保持）。装配方/测试可
   *  注入替身；返回 null = 基线缺席（既有诚实降级路径，引擎回落派发基线）。
   *  动机：离线测试经生产路径取证会拉起真实 D-5 物理服务（spawn python），
   *  被拉起的服务持有子进程句柄使 node:test 子进程永不退出 ⇒ 全量套件挂起。 */
  captureBeforeProbe?: () => Promise<BeforeState | null>;
}

export function physicalBackendHostExecutor(
  sys: typeof import('../system'),
  markerSink: HostMarkerSink,
  verifyOpts: HostExecutorVerifyOptions = {},
): HostExecutor {
  const S = sys.system; // 宿主系统层唯一事实源（黑名单/dryRun/ioMutex 全在內）
  const fail = (note: string) => ({ ok: false, note });
  const done = (note: string) => ({ ok: true, note });
  const num01 = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
  /** ΝΩ-1：单步派发的宿主账本存证（三态 + 脱敏；fail-open 绝不抛） */
  const audit = (
    action: string, result: 'ok' | 'failed' | 'threw',
    redacted: { point?: { x: number; y: number }; charCount?: number } = {},
  ): void => {
    try {
      const p = markerSink.appendMarker({
        kind: 'SANDBOX_HOST_REPLAY', action, result,
        ...(redacted.point !== undefined ? { point: redacted.point } : {}),
        ...(redacted.charCount !== undefined ? { charCount: redacted.charCount } : {}),
      });
      if (p && typeof p.catch === 'function') p.catch(() => { /* fail-open：存证旁路 */ });
    } catch { /* fail-open：审计通道故障绝不拦截已过五门的重放派发 */ }
  };
  // ── ΠΑΝ-42（终帧 dHash 效果验证的 before 基线）：首个物理步派发**之前**懒取
  // 一次全屏指纹（captureBefore 一次往返；取证失败 ⇒ null = 验证面缺席 ——
  // 诚实降级，引擎回落派发基线并如实标注，绝不虚报）。before 必须先于首步
  // 派发完成 —— 之后才取就掺入了本链自己的世界改变。promise 单飞（一次取
  // 证，链内复用；actionVerifier 懒动态 import —— 未验证的重放零装载成本）。
  let beforePromise: Promise<BeforeState | null> | null = null;
  const captureBeforeOnce = (): Promise<BeforeState | null> => {
    if (beforePromise === null) {
      // F4-4：注入缝优先（离线替身）；缺省 undefined 走生产懒取证路径（原行为）。
      beforePromise = verifyOpts.captureBeforeProbe !== undefined
        ? Promise.resolve()
            .then(() => verifyOpts.captureBeforeProbe!())
            .catch(() => null) // 替身故障 = 缺席（与生产路径同律：旁路义务，绝不抛）
        : import('../actionVerifier')
            .then(av => av.captureBefore(null, 0, false))
            .catch(() => null); // 取证失败 = 缺席（旁路义务，绝不抛）
    }
    return beforePromise;
  };
  return {
    async executeAction(action) {
      const a = action.args ?? {};
      const kindLabel = typeof (action as { kind?: unknown })?.kind === 'string'
        ? (action as { kind: string }).kind : 'unknown';
      // 脱敏参数面（GUARD_PROBE 同律）：归一化坐标（沙箱方言的区域定位事实）+
      // 字符计数（长度事实）；文本/关键词/热键和弦/令牌零明文。
      const redacted: { point?: { x: number; y: number }; charCount?: number } = {};
      let ret: HostExecutorStepResult;
      let result: 'ok' | 'failed' | 'threw';
      try {
        // ΝΩ-1 dryRun 前置拒绝（诚实报错）：物理步在 dryRun 宿主上派发必被
        // guardDryRun 静默吞没 —— 拒绝并归因，绝不把"被吞"报告成"已交付"。
        if (!NON_PHYSICAL_KINDS.has(kindLabel) && guardDryRunPresent(sys)) {
          ret = fail('host replay refused: host is in dry-run mode (guardDryRun would '
            + 'silently swallow the dispatch) — rehearsal must not be reported as delivery');
          result = 'failed';
        } else {
          // ΠΑΝ-42：首物理步派发前锁定效果验证的 before 基线（取证不阻塞
          // 判定 —— 失败即缺席，链照旧派发并按派发基线结算）。
          if (!NON_PHYSICAL_KINDS.has(kindLabel)) await captureBeforeOnce();
          switch (kindLabel) {
            case 'click_mouse': {
              const x = num01(a.x), y = num01(a.y);
              if (x === null || y === null) {
                ret = fail('click_mouse requires finite x/y in [0,1]');
                break;
              }
              const button = a.button === 'right' || a.button === 'middle' ? a.button : 'left';
              redacted.point = { x, y };
              // 尺寸只取一次（replayOneTraced 同律：两次独立异步读在分辨率切换
              // 间隙会用不同比例映射 x/y）；像素域换算后由 system 内部再归一化
              const s = await S.getScreenSize();
              await S.clickMouse(x * s.width, y * s.height, button);
              ret = done(`clicked (${x.toFixed(3)},${y.toFixed(3)}) ${button}`);
              break;
            }
            case 'type_text': {
              if (typeof a.text !== 'string') {
                ret = fail('type_text requires string text');
                break;
              }
              redacted.charCount = a.text.length; // 只记长度，内容零明文（脱敏纪律）
              await S.typeText(a.text, a.clearFirst === true);
              ret = done(`typed ${a.text.length} char(s)${a.clearFirst === true ? ' (cleared first)' : ''}`);
              break;
            }
            case 'scroll_page': {
              const amount = typeof a.amount === 'number' && Number.isFinite(a.amount) && a.amount > 0
                ? a.amount : null;
              if (amount === null) {
                ret = fail('scroll_page requires finite positive amount');
                break;
              }
              const direction = a.direction === 'up' || a.direction === 'left' || a.direction === 'right'
                ? a.direction : 'down';
              await S.scroll(direction, amount);
              ret = done(`scrolled ${direction} x${amount}`);
              break;
            }
            case 'press_hotkey': {
              if (!Array.isArray(a.keys) || a.keys.length === 0
                || !a.keys.every(k => typeof k === 'string')) {
                ret = fail('press_hotkey requires non-empty string array keys');
                break;
              }
              // ΝΩ-1：黑名单执法在 system 层（两条躯体之前拦截）—— 命中即抛
              // HOTKEY_BLACKLIST_MARKER 错误，下方 catch 收敛为 ok:false 归因。
              await S.pressHotkey(a.keys);
              ret = done(`hotkey ${a.keys.join('+')}`);
              break;
            }
            case 'drag_mouse': {
              const sx = num01(a.startX), sy = num01(a.startY);
              const ex = num01(a.endX), ey = num01(a.endY);
              if (sx === null || sy === null || ex === null || ey === null) {
                ret = fail('drag_mouse requires finite startX/startY/endX/endY in [0,1]');
                break;
              }
              redacted.point = { x: ex, y: ey };
              const s = await S.getScreenSize();
              await S.dragMouse(
                { x: sx * s.width, y: sy * s.height },
                { x: ex * s.width, y: ey * s.height },
              );
              ret = done(`dragged (${sx.toFixed(3)},${sy.toFixed(3)})→(${ex.toFixed(3)},${ey.toFixed(3)})`);
              break;
            }
            case 'switch_tab': {
              const keys = a.direction === 'previous' ? ['ctrl', 'shift', 'tab'] : ['ctrl', 'tab'];
              await S.pressHotkey(keys);
              ret = done(`tab switched ${a.direction === 'previous' ? 'previous' : 'next'}`);
              break;
            }
            case 'switch_window': {
              const kw = typeof a.titleKeyword === 'string' ? a.titleKeyword : '';
              if (!kw) {
                ret = fail('switch_window requires non-empty titleKeyword');
                break;
              }
              const r = await S.switchWindowByTitle(kw);
              if (!r || r.matched === null || r.matched === undefined) {
                ret = fail(`no window title matched "${kw.slice(0, 60)}"`);
                break;
              }
              ret = done(`window switched to ${String(r.matched).slice(0, 60)}`);
              break;
            }
            case 'dismiss_popup':
              // 纯模型侧恢复指令（无机械动作）—— 宿主 replayOne 同律：无害占位不作失败
              ret = done('model-side recovery instruction; nothing to execute');
              break;
            case 'noop':
              ret = done('noop');
              break;
            default:
              ret = fail(`unsupported kind ${JSON.stringify(kindLabel)} — executor vocabulary closed`);
          }
          result = ret.ok ? 'ok' : 'failed';
        }
      } catch (e: any) {
        // 三态归因：黑名单拦截是政策拒绝（世界未被触碰）⇒ failed；其余派发通道
        // 异常 ⇒ threw（防御式收口，端口契约本就永不抛 —— 这是双保险层）。
        result = sys.isHotkeyBlacklistError(e) ? 'failed' : 'threw';
        ret = fail(`dispatch error: ${e?.message ?? 'unknown'}`);
      }
      if (!NON_PHYSICAL_KINDS.has(kindLabel)) audit(kindLabel, result, redacted);
      return ret;
    },
    // ── ΠΑΝ-42：链级效果验证（可靠度从「派发完成」升级为「效果验证」）──
    // 复用 actionVerifier 的终帧 dHash 路径：before 基线取自首物理步之前（见
    // 上），settleAndVerify 自适应等稳定帧后双尺度比对产效果判决。诚实分层：
    // 返回 null = 验证面缺席（全非物理链 / before 取证失败 / 验证器故障 /
    // 指纹退化 unverifiable）⇒ 引擎回落派发基线并如实标注 —— 缺席降级，
    // 绝不虚报已验证，也绝不把不可判定的取证误杀成失败。永不抛。
    async verifyChainEffect({ steps }) {
      const hasPhysical = Array.isArray(steps)
        && steps.some(s => s && !NON_PHYSICAL_KINDS.has(s.kind));
      if (!hasPhysical) return null; // 全非物理链：无可验证的世界效果面
      const before = beforePromise !== null ? await beforePromise : null;
      if (!before || !before.screen) {
        return null; // before 基线缺席（首步前取证失败）—— 无法比对，诚实缺席
      }
      try {
        const av = await import('../actionVerifier');
        const effect = await av.settleAndVerify(before, {
          adaptive: verifyOpts.adaptive ?? true,
          settleMs: verifyOpts.settleMs ?? 400,
          threshold: verifyOpts.threshold ?? 0.97,
          regionRadius: 0, // 链级验证无单点焦点 —— 全屏单尺度（区域尺度属步级验证）
        });
        if (effect.detected === true) {
          return { verified: true, note: `world-effect observed (${effect.scale}, final-frame dHash dual-scale verdict)` };
        }
        if (effect.unverifiable !== undefined) {
          return null; // 指纹退化/取证通道缺席 = 不可判定 —— 缺席而非误杀
        }
        return {
          verified: false,
          note: 'dispatch completed but no screen change observed (similarity ≥ threshold '
            + '— the world did not respond; treat as effect-missing, not delivery)',
        };
      } catch {
        return null; // 验证器故障 = 缺席（旁路义务，绝不抛）
      }
    },
  };
}

// ══════════════════════════════════════════════════════════════════════
// ── ΠΑΝ-39：单一装配函数 applySandboxStack ──
// ══════════════════════════════════════════════════════════════════════

/** 装配注入端口（保持可测：引擎/执行器/验证参数全部可替换；全部可选） */
export interface SandboxStackPorts {
  /** 注入替代引擎（测试隔离 —— 缺省 new SandboxEngineImpl(ctx)） */
  engine?: SandboxEngineImpl;
  /** 显式注入宿主执行器（缺省按 enableHostReplayExecution 开关懒装配
   *  physicalBackend 适配器；null = 强制未接线语义） */
  hostExecutor?: HostExecutor | null;
  /** ΠΑΝ-42：physicalBackend 适配器的效果验证参数（settle/threshold/adaptive） */
  hostExecutorVerify?: HostExecutorVerifyOptions;
}

/** 装配产物句柄：引擎引用 + 可直接调用的清理体（= ctx.effect 登记的同一函数） */
export interface SandboxStackHandle {
  engine: SandboxEngineImpl;
  /** 卸载语义（持久化先行 → 内存归零）；与 ctx.effect 登记的清理体同一函数 */
  dispose(): void;
}

// D-5 替身人格（三正交段内嵌于工具描述 —— DSH 模式：工具即角色的躯壳）
const SHADOW_DOCTRINE =
  'You are the Sandbox Execution Engine — the safe avatar of this digital organism in the physical world. ' +
  'THE HOST IS SACRED: everything here is virtual; replay_on_host is the ONLY exit and only passes ' +
  'the five gates (token / doctor / reliability / fingerprint / step-level safety scan — ' +
  'replays are never exempt from the approval and risk gates). ' +
  'DRILL, THEN DELIVER: errors are nutrients — captured, diagnosed, corrected, repeated; ' +
  'the conversation sees results, never sweat. ' +
  'TRUST IS A FINGERPRINT: replay starts only when the host state matches the rehearsal state; ' +
  'a stale rehearsal is a lie.';

/**
 * ΠΑΝ-39：D-5 沙箱栈单一装配函数 —— engine.configure / sandboxLog 落盘 /
 * 三条事件接线 / 四个工具注册 / 可逆清理，全部收口于此。插件入口
 * （sandbox/index.ts 的 apply）与宿主组合根（src/index.ts）的一行挂线即得
 * 全套装配；测试经 ports 注入隔离引擎/执行器直测接线完备性。
 * 《异常诚实分层契约》第一条（加载层）：配置非法 throw（engine.configure
 * 执法 —— 拒绝带病上线）；此后第二条（运行层）：一切运行时永不抛。
 */
export function applySandboxStack(
  ctx: Context,
  config: SandboxConfig,
  ports: SandboxStackPorts = {},
): SandboxStackHandle {
  console.log('[Sandbox] Initializing Sandbox Execution Engine (D-5)...');

  const engine = ports.engine ?? new SandboxEngineImpl(ctx);
  // 《异常诚实分层契约》第一条（加载层）：配置非法 throw —— 拒绝带病上线；
  // 此后第二条（运行层）：一切运行时永不抛错（Result/verdict 降级）
  engine.configure(config);

  // ΑΩ-R19：宿主执行器接线（config 开关，缺省关闭 = 开发者预览语义零回归 ——
  // 四门全过仍诚实 failed "no host executor wired"）。懒导入根层模块：开关关闭
  // 时模块图与现状一致（装配失败也诚实降级为未接线，不阻断插件加载）。
  // ΝΩ-1：装配改经 system 安全链（黑名单 + guardDryRun + ioMutex serialize）
  // + journal（SANDBOX_HOST_REPLAY 派发存证）—— 第四条物理派发通道收编。
  // ΠΑΝ-42：适配器增链级效果验证（actionVerifier 终帧 dHash 路径懒接线）。
  if (ports.hostExecutor !== undefined) {
    engine.wireHostExecutor(ports.hostExecutor ?? null);
  } else if (config.enableHostReplayExecution === true) {
    // 懒动态 import 的双模块装配（async IIFE —— 装配失败诚实降级为未接线）
    void (async () => {
      try {
        const sys = await import('../system');
        const { journal } = await import('../journal');
        engine.wireHostExecutor(physicalBackendHostExecutor(sys, journal, ports.hostExecutorVerify));
        console.log('[Sandbox] Host executor wired via system safety chain (hotkey blacklist '
          + '+ dryRun + ioMutex + SANDBOX_HOST_REPLAY audit markers + ΠΑΝ-42 effect verification) '
          + '— five-gate replays now end in real dispatch.');
      } catch (e: any) {
        console.warn(`[Sandbox] Host executor wiring failed (${e?.message ?? e}) — `
          + 'replay stays in developer preview (honest failure).');
      }
    })();
  }

  // L 纪元（服务归属决策）：D-5 是 'dsh.sandbox' 的天然属主 —— 向总线自荐注册
  // 引擎视图（rehearse/recall/replay 面由 SandboxStationView 等消费方言定义）。
  // 宿主无 set 面 ⇒ 注册不成立，消费方（D-6 探测）保持既有诚实降级；决策成文。
  try {
    (ctx as any).set?.('dsh.sandbox', {
      rehearse: (chain: any) => engine.rehearse(chain),
      recall: (q: string) => engine.recallMuscleMemory(q),
      replayOnHost: (id: string, o: any) => engine.replayOnHost(id, o),
    });
    console.log('[Sandbox] service self-registered as dsh.sandbox (host bus accepted).');
  } catch { /* 注册失败 = 旁路义务：消费方降级路径不变 */ }
  // ΠΑΝ-39（D-6/D-7 双断点恢复）：sandboxLog.configure 只在此装配面执行 ——
  // 复用本账本的 pipeline-*/knowledge-* 段（checkpoint.ts / pipeline.helpers.ts）
  // 自此真实落盘（此前 configure 只在未装载的 apply 里调用 ⇒ log.append 的
  // `if (this.filePath)` 恒 false，哈希链账本实为进程内存态）。reportDir 缺席
  // ⇒ 空串（不落盘 —— 内存窗口语义，防御式缺席零回归）。
  sandboxLog.configure(config.reportDir ? `${config.reportDir}/sandbox-log.jsonl` : '', 2000);

  // ── 事件总线接线（与 D-1/D-4/宿主管线的唯一咬合通道）──

  // D-1 计划投喂：候选链到达即入排练（DRILL）。
  // P0-3 联合方言纪律：plan-ready 载荷可能是 chain（D-5 需求）或 intent 双方言
  // （D-6/D-7 主权）—— D-5 只排练链臂，意图臂静默让渡（主权边界，不是故障）。
  onCognitionPlanReady(ctx, payload => {
    if (!('chain' in payload) || !payload.chain) return;
    void engine.receivePlan(payload.chain).then(outcome => {
      console.log(`[Sandbox] Rehearsed plan ${outcome.chainId}: verdict=${outcome.verdict} ` +
        `steps=${outcome.steps.length} latency=${outcome.totalLatencyMs}ms report=${outcome.reportPath}`);
    }).catch(e => {
      // 观察者义务：排练崩溃不得变成 unhandled rejection 击穿宿主进程
      console.warn(`[Sandbox] Plan rehearsal crashed: ${e?.message ?? e}`);
    });
  });

  // D-4 判决回执：入缓存（双闸门复核 + 重放时刻否决源）+ 与最近排练结果
  // 配对走 consolidate（肌肉记忆写入路径：passed + approved ⇒ 固化入库）
  onDoctorVerdict(ctx, payload => {
    engine.noteDoctorVerdict(payload);
    const r = engine.tryConsolidate(payload);
    if (r.ok && r.value) {
      console.log(`[Sandbox] Muscle memory consolidated: ${r.value.id} ` +
        `(${r.value.steps.length} steps, trigger="${r.value.trigger.slice(0, 60)}")`);
    }
  });

  // 宿主管线观察（纯观察透传）：嗅探屏指纹 —— TRUST IS A FINGERPRINT 的镜像源头
  // ΠΑΝ-40c：嗅探键名/方言已对齐真实生产者（screen/region/exitFingerprint/
  // hash/sceneHash + hex dhash 归一），宿主观察自此可非空。
  onHostToolPost(ctx, (_call, result) => {
    engine.noteHostObservation(sniffFingerprint(result));
  });

  // 可选服务在场探测（dsh.quality-doctor：只持句柄不读全文 —— Token 纪律）
  const doctor = ctx.get('dsh.quality-doctor') as
    | { reportPath?: () => string | null }
    | undefined;
  console.log(doctor
    ? '[Sandbox] Quality doctor service detected — verdicts will be honored.'
    : '[Sandbox] Quality doctor service absent — consolidation defaults to freeze-for-review (honest degradation).');

  // ── 演武工具面（对话流只见紧凑数字）──

  ctx.tools.register(defineTool({
    name: 'rehearse_chain',
    description: SHADOW_DOCTRINE + ' Rehearse an action chain in the virtual sandbox. ' +
      'Returns compact numbers only (verdict, steps, latency, score); full evidence goes to reportPath. ' +
      'Provide virtual_scene (real widget geometry) to unlock genuine verification layers — ' +
      'without a scene the rehearsal degrades honestly (no evidence, verdict=degraded, never consolidated).',
    parameters: {
      actions: {
        type: 'string', required: true,
        description: 'JSON array of actions: [{"kind":"click_mouse","args":{"x":0.5,"y":0.5},'
          + '"expect":{"scale":"element-level","expectedText":"Sign in"}}] '
          + '(kinds: click_mouse|type_text|scroll_page|press_hotkey|drag_mouse|switch_tab|switch_window|dismiss_popup|noop)',
      },
      virtual_scene: {
        type: 'string',
        description: 'ΠΑΝ-40b: Optional JSON array of virtual widgets to rehearse against — '
          + '[{"role":"button","name":"Sign in","rect":{"x":0.4,"y":0.5,"width":0.2,"height":0.05},'
          + '"acceptsText":false,"scrollable":false,"popup":false}]. With a real scene the rehearsal '
          + 'produces L1/L4 evidence (verdict can be passed); without it the rehearsal degrades honestly '
          + '(degraded, never consolidated). Source widgets from the latest screenshot\'s element boxes.',
      },
      entry_scene_fingerprint: {
        type: 'string',
        description: 'ΠΑΝ-40d: Optional [01]{32,256} scene fingerprint at plan time (the screen the '
          + 'chain was authored against). Minted automatically from the latest host observation when omitted.',
      },
      budget_ms: {
        type: 'number',
        description: 'Optional wall-clock budget; on expiry the rehearsal aborts gracefully with partial trajectory.',
      },
    },
    output: { schema: { type: 'string' }, render: (_a: any, v: any) => [{ type: "text", text: v }] },
    async execute(args: any) {
      try {
        // ΑΩ-R19：入参执法升级 —— JSON 合法性 + 动作 schema（kind 闭集 / 坐标
        // 值域 [0,1] / 字符串与数量上限）双闸。非法条目整链拒绝，拒绝原因如实
        // 入结果（运行层铁律：不抛 —— 校验器本身也永不抛）。
        const parsed = JSON.parse(args.actions);
        const schema = validateActionChainInput(parsed);
        if (!schema.ok) {
          return JSON.stringify({ status: 'FAILED', reason: `actions schema rejected: ${schema.reason}` });
        }
        const actions = schema.actions;
        // ΠΑΝ-40b：virtual_scene 双闸（JSON 合法性 + 逐控件 asVirtualWidget 同律
        // 防御铸造 —— 畸形控件整链拒绝，半截场景排练出的证词是毒证）。参数
        // 缺席 ⇒ 场景 undefined ⇒ 既有诚实 degraded 语义零回归。
        let virtualScene: VirtualWidget[] | undefined;
        if (args.virtual_scene !== undefined && args.virtual_scene !== null
          && args.virtual_scene !== '') {
          let sceneRaw: unknown;
          try {
            sceneRaw = JSON.parse(args.virtual_scene);
          } catch (e: any) {
            return JSON.stringify({ status: 'FAILED', reason: `virtual_scene malformed JSON: ${e?.message ?? e}` });
          }
          const sceneVerdict = validateVirtualSceneInput(sceneRaw);
          if (!sceneVerdict.ok) {
            return JSON.stringify({ status: 'FAILED', reason: `virtual_scene rejected: ${sceneVerdict.reason}` });
          }
          virtualScene = sceneVerdict.scene;
        }
        // ΠΑΝ-40d：入口指纹显式供源（[01]{32,256} 单源正则 —— 非法即拒，绝不
        // 静默丢弃后伪装铸造成功；缺席 ⇒ 引擎按排练时刻宿主观察自动铸造）。
        let entrySceneFingerprint: string | undefined;
        if (args.entry_scene_fingerprint !== undefined && args.entry_scene_fingerprint !== null
          && args.entry_scene_fingerprint !== '') {
          const fp = String(args.entry_scene_fingerprint);
          if (!isBinaryFingerprint(fp)) {
            return JSON.stringify({
              status: 'FAILED',
              reason: 'entry_scene_fingerprint must be a [01]{32,256} bitstring (see sandbox/events fingerprint dialect)',
            });
          }
          entrySceneFingerprint = fp;
        }
        const chain = {
          id: `chain-manual-${Date.now().toString(36)}`,
          actions,
          budgetMs: typeof args.budget_ms === 'number' ? args.budget_ms : undefined,
          origin: 'manual' as const,
          ...(virtualScene !== undefined ? { virtualScene } : {}),
          ...(entrySceneFingerprint !== undefined ? { entrySceneFingerprint } : {}),
        };
        const o = await engine.rehearse(chain);
        // 紧凑数字战报（Token 纪律）：全量证据在 reportPath
        return JSON.stringify({
          status: 'SUCCESS',
          verdict: o.verdict,
          chain_id: o.chainId,
          steps: o.steps.length,
          failed_at: o.failedAtIndex,
          total_latency_ms: o.totalLatencyMs,
          budget_ms: o.budgetMs,
          score: o.score,
          verification_layers: o.verificationLayers,
          entry_scene_fingerprint_minted: o.entrySceneFingerprint !== undefined,
          chain_tip: o.chainTip,
          report: o.reportPath,
        });
      } catch (e: any) {
        return JSON.stringify({ status: 'FAILED', reason: `malformed input: ${e.message}` });
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'recall_muscle',
    description: 'Recall muscle memory entries by natural-language query (prior, not guarantee — '
      + 'every replay still passes the five gates). Ranked by text overlap × reliability + scene bonus + recency.',
    parameters: {
      query: { type: 'string', required: true, description: 'Natural language query.' },
    },
    output: { schema: { type: 'string' }, render: (_a: any, v: any) => [{ type: "text", text: v }] },
    async execute(args: any) {
      const r = engine.recallMuscleMemory(String(args.query ?? ''));
      if (!r.ok) return JSON.stringify({ status: 'FAILED', reason: r.reason });
      return JSON.stringify({
        status: 'SUCCESS',
        hits: r.value.map(e => ({
          id: e.id,
          trigger: e.trigger,
          steps: e.steps.length,
          reliability: Number(muscleReliability(e).toFixed(3)),
          rehearsal_passes: e.rehearsalPassCount,
          host_replays: e.hostReplayCount,
        })),
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'replay_on_host',
    description: SHADOW_DOCTRINE + ' Request host replay of a muscle-memory entry. '
      + 'Phase 1: omit confirm_token to obtain a pending token. Phase 2: re-call with the token. '
      + 'Five gates: token / doctor verdict / reliability threshold / entry-scene fingerprint match '
      + '(absent evidence fails closed for irreversible steps; reversible chains degrade honestly) / '
      + 'step-level safety scan (dangerous steps need a granted approval_token in step args).',
    parameters: {
      entry_id: { type: 'string', required: true, description: 'Muscle memory entry id.' },
      confirm_token: {
        type: 'string',
        description: 'Omit in phase 1 to get a token; include in phase 2 to attempt the replay.',
      },
    },
    output: { schema: { type: 'string' }, render: (_a: any, v: any) => [{ type: "text", text: v }] },
    async execute(args: any) {
      const entryId = String(args.entry_id ?? '');
      if (!args.confirm_token) {
        const token = engine.requestReplayToken(entryId);
        return JSON.stringify({
          status: 'PENDING_USER_CONSENT',
          entry_id: entryId,
          token,
          note: 'Re-call replay_on_host with confirm_token to pass the gates (TTL 120s).',
        });
      }
      const outcome = await engine.replayOnHost(entryId, { confirmToken: String(args.confirm_token) });
      return JSON.stringify({
        status: outcome.verdict === 'confirmed' ? 'SUCCESS' : 'FAILED',
        verdict: outcome.verdict,
        muscle_memory_id: outcome.muscleMemoryId,
        divergences: outcome.divergences.length,
        reliability_after: Number(outcome.reliabilityAfter.toFixed(3)),
        journal_refs: outcome.journalRefs.length,
        report: outcome.reportPath,
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'verify_sandbox_log',
    description: 'Verify the append-only hash chain of the sandbox session log (tamper-evidence audit).',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a: any, v: any) => [{ type: "text", text: v }] },
    async execute() {
      // L 纪元：hasVerificationLayer 从死导出升级为活引用 —— 审计面携带四层
      // 在场性判据说明（该函数对任意 RehearsalOutcome 可用；此处声明判据就绪性）。
      const layerGuide = ['L1-pixel', 'L2-diff', 'L3-semantic', 'L4-expectation']
        .map(l => `${l}: 判据就绪(hasVerificationLayer)`).join(' | ');
      const r = engine.verifyLog();
      if (!r.ok) return JSON.stringify({ status: 'FAILED', reason: r.reason });
      return JSON.stringify({
        status: 'SUCCESS',
        chain_intact: r.value.ok,
        entries: r.value.length,
        broken_at: r.value.brokenAt,
        verification_layers: layerGuide,
      });
    },
  }));

  console.log('[Sandbox] 4 rehearsal tools registered (rehearse_chain / recall_muscle / replay_on_host / verify_sandbox_log).');

  // ── 可逆注册：一切资源登记清理（Cordis 注册即效果模型）──
  // ΠΑΝ-39：清理体单点铸造 —— ctx.effect 登记与返回句柄的 dispose 是同一函数
  //（测试无需伪造 cordis 生命周期即可执行卸载语义）。
  const dispose = (): void => {
    console.log('[Sandbox] Unloading, rolling back resources...');
    // 持久化资产先行落盘（肌肉记忆的寿命长于会话）；账本随 JSONL 已增量落盘
    engine.persistMemory(); // 必须先于 reset（内存态归零后无可存）
    engine.reset(); // 内存态归零：记忆/令牌/判决缓存/待配对面/观察缓存/账本窗口
    console.log('[Sandbox] Unloaded. Zero residue.');
  };
  ctx.effect(() => dispose);

  console.log('[Sandbox] Initialization complete! The host remains untouched until all gates open.');
  return { engine, dispose };
}
