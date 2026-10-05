// src/tools/pressHotkey.ts
// 薄委托层：白名单、数量对账、对称时序全部下沉 system.pressHotkey，工具层只做锚点。
// B-4：返回值统一走 toolResult 工厂（反幻觉锚点全覆盖）。
// P1-3：系统级热键黑名单拦截在 system 层执法，工具层按错误类别给出针对性 next_step。
// P1-1：IO 排队超时（[TIMEOUT] 方言）透传 + 专属恢复指引。
//
// ΠΑΝ-12（键盘侧门封堵 · 批判报告 C1-5 H5 的修法面）：press_hotkey 接入
// actionGate 闸门（此前完全在 ActionKind 闭集之外 —— 点击危险按钮后
// press_hotkey(['enter']) 激活确认零审批；敏感焦点上 ctrl+v 把剪贴板粘进
// 凭据框绕过 sensitive-input 闸）。执法三层（判定事实源 = actionGate）：
//   ① 黑名单和弦（config.hotkeyBlacklist 随 config 在场时前置结构化拒绝；
//     缺 config 的调用方保持完全旧路径 —— system 层 P1-3 执法不变，p1-fixes
//     的 FAILED 方言逐字节保持）；
//   ② ctrl/cmd+v × 敏感焦点 ⇒ sensitive-input（凭据粘贴不代劳）；
//   ③ context_description 命中危险词 ⇒ 审批域（enter 激活危险默认钮的主通道，
//     一枚已授予令牌可解 —— 与 click 闸门同律）。
// 危险语义放行后的一次性令牌律：派发成功即消费（无效果验证面的热键不适用
// 验收式消费 —— 与 drag 的旧方言同律；经 consumeApprovalWithHint 统一落点，
// targetHint 随行透传）。
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Config } from '../config';
import { system, isHotkeyBlacklistError } from '../system';
import { isIoTimeoutError } from '../ioMutex';
import { toolOk, toolErr } from '../toolResult';
import { assertActionAllowed } from './actionGate';
import { consumeApprovalWithHint } from './clickMouse';
// ΑΝΒ-2（W-07/W-08 · D2）：选族效果验证面 —— 派发前后同区域 dHash 差分，
// 伪锚/点击锚定区域，结论经 focusTracker 选区账本贯通给 type_text。
import { captureBefore, settleAndVerify } from '../actionVerifier';
import type { BeforeState } from '../actionVerifier';
import {
  resolveCaretAnchor,
  refreshCaretPseudoAnchorAfterNavKey,
  recordSelectionVerification,
  invalidateSelectionVerification,
  type CaretAnchor,
} from '../focusTracker';

/**
 * ΝΩ-31（人体工学）：白名单键集 —— system 层 `_getKey` fallbackMap 的键名镜像
 * （单一执法事实源仍在 system 层：白名单外的键名由 system.pressHotkey 拒绝；
 * 系统级热键黑名单 alt+f4/meta/... 在其上再拦一道）。此处枚举进 schema 的唯一
 * 目的是把合法键集**前置呈现给模型**：协议层即拒（ToolArgsError），模型不必
 * 先错一次才知道键名是否合法。漂移防线：no31 测试对照 system.ts 源码
 * fallbackMap —— system 层改键集而此处未跟 ⇒ 测试红。
 */
export const HOTKEY_WHITELIST_KEYS: readonly string[] = [
  'ctrl', 'cmd', 'alt', 'shift',
  'enter', 'tab', 'space', 'backspace', 'delete', 'esc',
  // R2-2: 导航/编辑键补齐（home/end/pageup/pagedown/方向键）—— suite-full 行级
  // 编辑任务的主路径（ctrl+home 回文首 / ctrl+end 跳文末 / shift+end 选整行 /
  // 方向键移动）。python 侧 _KEY_MAP 早已立法同集（"导航与编辑键——滚动/选择/
  // 对话框导航的键盘模态"），本镜像收口使三层（schema/system fallbackMap/python）
  // 收敛到同一生效键集。
  'home', 'end', 'pageup', 'pagedown', 'up', 'down', 'left', 'right',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
  // R2-2: 全字母表补齐（原 a/c/v/z 四字母子集收口）—— 根因修复 R1-8 冒烟
  // 遗留①：白名单缺 s ⇒ ctrl+s 在协议层（schema 枚举 ToolArgsError）被拒 ⇒
  // 一切"ctrl+s 保存"类套件话术被迫走菜单旁路（R1-8 attempt5-9 的主要成本源）。
  // 立法依据：黑名单的宪法边界是**射向 OS 壳层/会话管理器的逃逸和弦**
  // （alt+f4 / meta 族 / ctrl+alt+delete / ctrl+shift+esc / alt+space），
  // 字母键无论与什么修饰键组合都在应用表面 + 纯视觉闭环内（效果可见可验证、
  // 可 ctrl+z 回滚）；危险和弦由 config.hotkeyBlacklist 独立执法且**不因本
  // 扩员弱化**——cmd+q（归一为 meta+q）仍被黑名单的 meta 单键条目与和弦条目
  // 双重命中。与 python _KEY_MAP 既有立法（"全字母表补齐——ctrl+s/ctrl+o/
  // ctrl+n 等组合的完整覆盖"）双向同步；win/meta/printscreen/insert/capslock
  // 刻意**不**入白名单（OS 壳层域 / 无套件需求面）。
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
  'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
];

/**
 * R5-2（T8·选区回执）：选族和弦判定 —— shift + 导航键（home/end/方向键/
 * pageup/pagedown）会改变文本选区。此类和弦的效果（选区高亮）在回执中
 * 不可机检（无光标锚定的验证区域），须明示「未证实」并前置视觉核验。
 * 纯文本增强：锚点形状与非选族和弦回执逐字节不变。
 */
const SELECTION_NAV_KEYS: ReadonlySet<string> = new Set([
  'home', 'end', 'left', 'right', 'up', 'down', 'pageup', 'pagedown',
]);

export function isSelectionChord(keys: unknown): boolean {
  if (!Array.isArray(keys) || keys.length < 2) return false;
  const lower = keys.map((k) => (typeof k === 'string' ? k.toLowerCase() : ''));
  return lower.includes('shift') && lower.some((k) => SELECTION_NAV_KEYS.has(k));
}

// ─── ΑΝΒ-2（W-08 · D2-d）：选族区域 dHash 效果验证的立法常量与话术 ───

/**
 * ΑΝΒ-2（W-08）：选区可见性判定阈（区域相似度百分比上界，低于此 = 区域差分
 * 超阈 = 选区蓝条/反色可见）。立法理由：比 noopSimilarityThreshold 缺省 0.97
 * 更严 —— 假 VERIFIED 会把 type_text 变成盲插入（T8 危害方向：三段拼接），
 * 而假 UNVERIFIED 只是多保留一句防盲打话术（安全方向）；R5-2 §4.3 离线实证
 * 选区蓝条的区域 sim≈0.80（r=0.15），对 95 阈余量充足，对全屏 2 bit 余量
 * （0.9688）的问题免疫（全屏通道根本不参与本判定）。
 */
export const SELECTION_VERIFY_REGION_SIM_MAX_PCT = 95 as const;

/** ΑΝΒ-2（W-08）：R5-2 选族盲态回执（字节级原样保留 —— 无验证面时的降级文案，
 *  也是 r52 T8-C1 回归钉的锁定文本）。 */
const SELECTION_BLIND_RECEIPT =
  'SELECTION UNVERIFIED: this receipt CANNOT see whether a text selection was actually made — the ' +
  'selection highlight (blue/reversed strip) is the ONLY ground truth that the intended range is ' +
  'selected. Verify it FIRST (take_screenshot + ask_screen asking specifically about the highlight, ' +
  'or zoom_inspect for small text) BEFORE typing over the selection: typing with NO active selection ' +
  'INSERTS at the caret instead of replacing — a duplicate-text hazard.';

/** ΑΝΒ-2（W-08）：验证锚的诚实标签（回执申报 —— 伪锚绝不冒充实测位）。 */
const anchorLabel = (kind: CaretAnchor['kind']): string => kind === 'click-tracked'
  ? 'click-tracked focus'
  : 'window-center PSEUDO anchor (NOT the real caret — the verified region is centered on the target window center)';

/** ΑΝΒ-2（W-07）：keys 是否含导航键（含 shift 组合 —— 选族与裸导航都是光标移动）。 */
function hasNavigationKey(keys: unknown): boolean {
  if (!Array.isArray(keys)) return false;
  return keys.some((k) => typeof k === 'string' && SELECTION_NAV_KEYS.has(k.toLowerCase()));
}

/**
 * ΠΑΝ-12：config 改为可选 —— index.ts 装配面传 config（闸门随之激活）；
 * 零参调用（既有测试/独立装配）保持完全旧路径（闸门对黑名单缺席不重复执法，
 * system 层 P1-3 事实源不变）。
 */
export function createPressHotkeyTool(config?: Config) {
  return defineTool({
    name: 'press_hotkey',
    description:
      'Presses a combination of keyboard keys simultaneously. ' +
      'Useful for shortcuts (e.g., ctrl+c, ctrl+shift+t). ' +
      'Only whitelisted key names are accepted (see keys enum); ' +
      'system-level hotkeys (alt+f4, meta/win combos, ctrl+alt+delete) are blacklist-rejected. ' +
      'Activation keys (enter/space) acting on a DANGEROUS context (e.g., a delete/pay confirmation ' +
      'dialog) require approval_token — describe the context in context_description. ' +
      'Recovery chords are always safe and NEVER gated: ctrl+z / ctrl+shift+z / ctrl+y (undo/redo) ' +
      'and bare delete/backspace (editor text keys, undoable) — use them freely to roll back a ' +
      'botched edit instead of working around the gate.',
    parameters: {
      keys: {
        type: 'array',
        required: true,
        description: 'An array of key names to press. Examples: ["ctrl", "c"], ["ctrl", "shift", "tab"]. ' +
          `Allowed key names (whitelist): ${HOTKEY_WHITELIST_KEYS.join(', ')}.`,
        items: { type: 'string', enum: HOTKEY_WHITELIST_KEYS },
      },
      // ΠΑΝ-12：热键作用面的模型自述通道（与 click 的 target_description 同律）——
      // enter/space 激活的是哪个对话框/按钮。命中危险词 ⇒ 审批域。
      context_description: {
        type: 'string',
        description: 'Short description of WHAT this hotkey acts on (e.g., "the 删除订单 confirmation dialog\'s ' +
          'default button", "the search box"). Feeds the danger/approval gate: an activation key (enter) in a ' +
          'dangerous context (delete/send/pay/submit dialog) requires approval_token.',
      },
      approval_token: {
        type: 'string',
        description: 'One-shot token from request_approval. Required when this hotkey acts in an irreversible ' +
          'context (e.g., enter confirming a delete/pay dialog).',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const { keys, context_description, approval_token } = args;

      // ── ΠΑΝ-12：键盘侧门闸门（结构化拒绝，绝不抛；判定事实源 = actionGate）───
      const gate = assertActionAllowed(
        'press_hotkey',
        { keys, context_description, approval_token },
        config,
      );
      if (!gate.allowed) {
        // 黑名单和弦：OS 壳层逃逸动作令牌不可解 —— 常规途径出口（P1-3 同律）
        if (gate.reason === 'blacklisted-hotkey') {
          return JSON.stringify({
            status: 'ACTION_REQUIRED',
            state_anchor: {
              keys: Array.isArray(keys) ? keys : [],
              danger_signal: 'blacklist',
              reason: gate.reason,
              note: 'This chord escapes the application surface into the OS shell / session manager — its ' +
                'effects are outside the visual closed loop (invisible to verification) and mostly irreversible.',
            },
            next_step: '系统级热键被闸门拦截：改用常规途径 —— 关闭窗口点其关闭按钮（click_mouse）、' +
              '切换窗口用 switch_window、打开地址用 open_url。',
          }, null, 2);
        }
        // 粘贴面：敏感焦点上的 ctrl/cmd+v —— 凭据粘贴不代劳（type 臂的键盘孪生）
        if (gate.reason === 'sensitive-input') {
          return JSON.stringify({
            status: 'ACTION_REQUIRED',
            state_anchor: {
              keys: Array.isArray(keys) ? keys : [],
              danger_signal: gate.dangerSignalChannel ?? 'focus',
              reason: gate.reason,
              note: 'The current focus is marked as a credentials/input-secret area — pasting the clipboard ' +
                'into it is credential handling, which the agent must not do on the user\'s behalf.',
            },
            next_step: 'STOP: do not paste into this sensitive field yourself. Ask the user to press Ctrl+V ' +
              'personally (or provide the value explicitly in chat). After the user finishes, continue with ' +
              'take_screenshot.',
          }, null, 2);
        }
        // 审批域：危险上下文（enter 激活危险默认钮等）—— 与 click/drag 闸门同律
        return JSON.stringify({
          status: 'ACTION_REQUIRED',
          state_anchor: {
            keys: Array.isArray(keys) ? keys : [],
            target: context_description ?? '(undescribed context)',
            danger_signal: gate.dangerSignalChannel ?? 'context_description',
            reason: gate.reason,
            note: approval_token
              ? 'The token exists but the user has not granted it yet (or it expired).'
              : 'This hotkey acts in an irreversible context (activating a delete/send/pay/submit dialog...).',
          },
          next_step: 'PAUSE: this hotkey needs explicit user approval. Call request_approval with a clear ' +
            'description (what dialog the key acts on and what it triggers), relay the message, wait for ' +
            'consent, call grant_approval(token, true), then re-invoke press_hotkey with the returned ' +
            'approval_token. Never proceed without consent. Alternatively use click_mouse on the specific ' +
            'button — it goes through the same gate.',
        }, null, 2);
      }

      // ── ΑΝΒ-2（W-08）：选族效果验证前置 —— 派发前定锚 + 区域快照 ──
      // 锚定阶梯（R5-2 §4.3 结论「选区蓝块 dHash 看得见——但前提是区域锚在光标处」
      // 的接线）：点击记账焦点（实测位，光标最可能仍在其邻域）＞ 窗口中心伪锚
      //（W-07：目标窗记账物化 —— 消灭 T8 的「锚在任务栏鼠标位 ⇒ 恒 100%」假 noop）。
      // 验证是旁路证据车道：定锚/快照失败 ⇒ 诚实降级 blind（R5-2 盲态回执原样），
      // 绝不阻断热键派发本身。
      const selectionChord = isSelectionChord(keys);
      // 验证面资格：config 在场 + verifyActions 开 + 非 dry-run + 区域半径 > 0
      //（vcfg 非空 = 全部就绪 —— TS 收窄用；缺任一 ⇒ blind 降级，绝不阻断派发）
      const vcfg = config
        && config.verifyActions === true
        && config.dryRun !== true
        && config.regionVerifyRadius > 0
        ? config
        : null;
      let verifyAnchor: CaretAnchor | null = null;
      let beforeSnap: BeforeState | null = null;
      if (selectionChord && vcfg) {
        verifyAnchor = resolveCaretAnchor(vcfg.focusMaxAgeMs);
        if (verifyAnchor) {
          try {
            beforeSnap = await captureBefore(
              { x: verifyAnchor.x, y: verifyAnchor.y },
              vcfg.regionVerifyRadius,
            );
            // 区域指纹缺席（服务端未返回 region_dhash）⇒ 无区域比对面 ⇒ blind
            if (!beforeSnap.region) beforeSnap = null;
          } catch { beforeSnap = null; } // 防御式：快照失败 = 验证缺席，不毒化派发
        }
      }

      try {
        // 白名单外的键名会被 system 层拒绝 —— 模型无法注入白名单之外的任何键
        await system.pressHotkey(keys);

        // ── ΑΝΒ-2（W-07）：导航键派发成功 ⇒ 伪锚记账/保鲜 + 选区账本维护 ──
        // 键击落在当时前台窗（= 目标窗记账的窗）⇒ 光标仍在其内 ⇒ 伪锚在场/保鲜。
        // 选区账本失效律：非选族派发（裸导航折叠选区 / 其他键可能消费选区）⇒ 清账
        //（保守方向：假 UNVERIFIED 只是多一句防盲打话术，假 VERIFIED 是盲插入）。
        if (hasNavigationKey(keys)) {
          refreshCaretPseudoAnchorAfterNavKey(config?.focusMaxAgeMs);
        }
        if (!selectionChord) {
          invalidateSelectionVerification();
        }

        // ── ΑΝΒ-2（W-08）：选族效果验证 —— 派发后同区域快照差分（纯本地 dHash，
        // 零 VLM 调用）── 选区蓝条/反色 ⇒ 区域相似度陡降（R5-2 §4.3 实测 ≈0.80）
        // ⇒ VERIFIED；未达阈 ⇒ UNVERIFIED 但附实测值（比盲态多一个证据维度）。
        let selectionCheck: {
          verified: boolean;
          region_similarity_pct: number;
          anchor: CaretAnchor['kind'];
        } | null = null;
        if (selectionChord && vcfg && beforeSnap && verifyAnchor) {
          try {
            const effect = await settleAndVerify(beforeSnap, {
              adaptive: vcfg.adaptiveSettle,
              settleMs: vcfg.actionSettleMs,
              threshold: vcfg.noopSimilarityThreshold,
              regionRadius: vcfg.regionVerifyRadius,
            });
            // 判据（Δ-7 同律）：只有**非退化**的区域测量才有判决资格 ——
            // effect_detected=null（指纹退化）⇒ 证据不可用，诚实 blind；
            // 有效测量 ⇒ 必附实测值（verified 与否都比盲态多一个证据维度）。
            const region = effect.region;
            if (region && region.effect_detected !== null) {
              const rpct = region.similarity_pct;
              const verified = region.effect_detected === true
                && rpct < SELECTION_VERIFY_REGION_SIM_MAX_PCT;
              selectionCheck = { verified, region_similarity_pct: rpct, anchor: verifyAnchor.kind };
              recordSelectionVerification({
                verdict: verified ? 'verified' : 'unverified',
                region_similarity_pct: rpct,
                keys,
                anchor: verifyAnchor.kind,
              });
            }
          } catch { /* 验证车道故障 ⇒ 诚实 blind（下方记账），绝不抛 */ }
        }
        if (selectionChord && !selectionCheck) {
          // 无验证面（无 config/verify 关/无锚/快照或比对失败）⇒ R5-2 盲态，
          // 账本如实记 blind —— type_text 侧维持防盲打话术
          recordSelectionVerification({
            verdict: 'blind', region_similarity_pct: null, keys,
            anchor: verifyAnchor ? verifyAnchor.kind : null,
          });
        }

        // ΠΑΝ-12：一次性令牌律 —— 危险语义放行后随派发消费（热键无效果验证面，
        // 不适用验收式消费；统一落点 + targetHint 接线预留：作用面描述入提示）
        if (gate.dangerous && approval_token) {
          consumeApprovalWithHint(approval_token, { tool: 'press_hotkey', target_description: context_description });
        }
        return toolOk(
          `Hotkey ${keys.join(' + ')} pressed.`,
          {
            keys,
            note: 'keys are whitelist-enforced at the system layer',
            // ΠΑΝ-12：审批域透明化（危险上下文 + 令牌已随派发消费）
            ...(gate.dangerous ? { approval_gate: { described: true, token_consumed_on_dispatch: true } } : {}),
            // ΑΝΒ-2（W-08）：选族验证证据（加法式键 —— 无验证面时缺席，锚点形状与
            // 旧路逐字节一致）。verified=区域差分超阈；诚实申报验证锚种类。
            ...(selectionCheck
              ? {
                  selection_check: {
                    verified: selectionCheck.verified,
                    region_similarity_pct: selectionCheck.region_similarity_pct,
                    verification_anchor: selectionCheck.anchor,
                  },
                }
              : {}),
          },
          // R5-2（T8 深因·选区回执）：选族和弦（shift+home/end/方向键/pageup/
          // pagedown）会改变文本选区。R5-2 时点回执看不见选区（SELECTION
          // UNVERIFIED 盲态）；ΑΝΒ-2（W-08）升级为区域 dHash 效果验证：
          //   · 差分超阈 ⇒ SELECTION VERIFIED（附实测值与锚标签）；
          //   · 已测量未达阈 ⇒ SELECTION UNVERIFIED + 区域差分实测值；
          //   · 无验证面 ⇒ 盲态回执逐字节原样（R5-2 话术，r52 T8-C1 钉）。
          // 非选族和弦回执逐字节不变。
          !selectionChord
            ? "Call 'take_screenshot' to verify the shortcut took effect."
            : selectionCheck === null
              ? SELECTION_BLIND_RECEIPT
              : selectionCheck.verified
                ? 'SELECTION VERIFIED: the regional dHash check detected a visible change consistent ' +
                  'with a selection being made — region around the ' + anchorLabel(selectionCheck.anchor) +
                  ` measured ${selectionCheck.region_similarity_pct}% similarity before vs after the chord ` +
                  `(visibility threshold: below ${SELECTION_VERIFY_REGION_SIM_MAX_PCT}%). It is now safe to ` +
                  'type over the selection: type_text will REPLACE the verified selected range (not insert at ' +
                  'the caret). Honesty note: the check proves a visible regional change, not WHICH text got ' +
                  'selected — if the exact range matters, one take_screenshot still beats assumption.'
                : 'SELECTION UNVERIFIED: the regional visual check found NO selection highlight — the region ' +
                  'around the ' + anchorLabel(selectionCheck.anchor) +
                  ` measured ${selectionCheck.region_similarity_pct}% similarity before vs after the chord ` +
                  `(visibility threshold: below ${SELECTION_VERIFY_REGION_SIM_MAX_PCT}%), i.e. the change a ` +
                  'selection bar would cause was NOT detected inside the verified region. The selection may ' +
                  'still exist OUTSIDE the verified region; the selection highlight (blue/reversed strip) is ' +
                  'the ONLY ground truth that the intended range is selected. Verify it FIRST (take_screenshot + ' +
                  'ask_screen asking specifically about the highlight, or zoom_inspect for small text) BEFORE ' +
                  'typing over the selection: typing with NO active selection INSERTS at the caret instead of ' +
                  'replacing — a duplicate-text hazard.',
        );
      } catch (error: any) {
        // P1-3：黑名单拦截 ⇒ 明说被什么拦住 + 常规途径出口（逃逸动作没有合法通道）
        if (isHotkeyBlacklistError(error)) {
          return toolErr(
            `Hotkey ${keys.join(' + ')} press failed.`,
            error.message,
            '系统级热键被黑名单拦截：改用常规途径 —— 关闭窗口点其关闭按钮（click_mouse）、' +
              '切换窗口用 switch_window、打开地址用 open_url、复制粘贴用右键菜单（click_mouse button=right）。',
          );
        }
        // P1-1：IO 排队超时 ⇒ [TIMEOUT] 方言专属指引（底层假死的恢复路径）
        if (isIoTimeoutError(error)) {
          return toolErr(
            `Hotkey ${keys.join(' + ')} press failed.`,
            error.message,
            '物理 IO 队列超时：底层执行器可能假死。稍等后重试一次；仍超时则改用 ' +
            "take_screenshot 检查屏幕是否已变化（动作可能已生效但回执迟到）。",
          );
        }
        // R2-2: 拒绝指引的键集速记与白名单同步（字母表全集 + 导航键）
        return toolErr(
          `Hotkey ${keys.join(' + ')} press failed.`,
          error.message,
          "Check key names against the whitelist (ctrl/cmd/alt/shift/enter/tab/space/backspace/delete/esc/" +
          "home/end/pageup/pagedown/up/down/left/right/f1-f12/a-z letters). " +
          "For unsupported keys, fall back to click_mouse on the target UI control.",
        );
      }
    },
  });
}
