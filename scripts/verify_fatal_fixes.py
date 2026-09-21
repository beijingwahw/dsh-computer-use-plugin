# scripts/verify_fatal_fixes.py
# J 纪元致命级修复的运行时证据（世界级验收：不是"我改了"，而是"我证明了"）。
# 在无 pyautogui 的环境用受控桩直击原崩溃路径；shm 用真实 mmap-file 全程。
import gc
import os
import sys
import asyncio
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'python_service'))
os.environ.setdefault('DSH_PHYSICAL_TEST_SCREEN', '1')

from dsh_physical import input as input_mod  # noqa: E402
from dsh_physical import shm as shm_mod  # noqa: E402
from dsh_physical import routes  # noqa: E402
from dsh_physical.config import ActionConfig, ScreenshotConfig, AppConfig  # noqa: E402
from dsh_physical.errors import PhysicalError  # noqa: E402

PASS = 0
def ok(name, cond, detail=''):
    global PASS
    mark = 'PASS' if cond else 'FAIL'
    print(f'[{mark}] {name}{(" — " + detail) if detail else ""}')
    if cond:
        PASS += 1
    else:
        sys.exit(1)

# ═══ V1：致命级 #1 —— click kwargs 路径（原 _run_in_executor 不收 kwargs 必抛 TypeError）═══
calls = []
class FakePA:
    FAILSAFE = True
    LOG_SCREEN_SIZE = False
    class _Size:
        width, height = 1920, 1080
    def size(self): return FakePA._Size()
    def click(self, x, y, button='left', **kw):
        calls.append(('click', x, y, button, dict(kw)))
    def typewrite(self, text, interval=0): calls.append(('type', text))
    def hotkey(self, *ks): calls.append(('hotkey', ks))
    def press(self, k): calls.append(('press', k))

input_mod._pyautogui = FakePA()  # 受控桩：真实点击不可在验收机上乱点
ctrl = input_mod.InputController(ActionConfig())

async def v1():
    # dry_run=False：正是旧实现 100% 抛 TypeError 的那一行
    r = await ctrl.click(0.5, 0.5, 'right')
    return r

r = asyncio.run(v1())
ok('V1a 真实(非 dry-run)点击路径不再抛 TypeError', len(calls) == 1)
ok('V1b kwargs 完整抵达 pyautogui（button 与 _pause）',
   calls and calls[0][3] == 'right' and calls[0][4].get('_pause') is False,
   f'calls[0]={calls[0] if calls else None}')
ok('V1c 像素回执正确', r['pixel'] == {'x': 960, 'y': 540} and r['screen'] == {'width': 1920, 'height': 1080})

# 屏幕尺寸 TTL 缓存（分辨率变更可刷新）
FakePA._Size.width, FakePA._Size.height = 2560, 1440
ctrl._screen_size_at -= 31.0  # 强制过期（实例级 TTL 时钟）
asyncio.run(ctrl.click(0.5, 0.5))
ok('V1d 屏幕尺寸 TTL 过期后刷新（分辨率热插拔不再终身旧值）',
   calls[-1][1] == 1280, f'last_px_x={calls[-1][1]}（2560/2=1280）')

# ═══ V2：致命级 #2 —— health 的 screen 字段类型 ═══
from dsh_physical.screen import ScreenCapture  # noqa: E402
from dsh_physical.ui_tree import UIFunnel  # noqa: E402
from dsh_physical.window import WindowManager  # noqa: E402

cfg = AppConfig()
routes.set_controllers(ctrl, ScreenCapture(cfg.screenshot), UIFunnel(cfg.funnel), WindowManager(cfg.window), cfg)
health = asyncio.run(routes.health())
sc = health['data']['screen'] if 'data' in health else health.get('screen', {})
ok('V2a health.screen 是 dict 且携带 width/height（成功臂）',
   isinstance(sc, dict) and isinstance(sc.get('width'), int) and isinstance(sc.get('height'), int),
   f'screen={sc}')
ok('V2b capabilities 是能力位图而非控制器名',
   isinstance(health['data'].get('capabilities'), list) and 'click' in health['data']['capabilities']
   and isinstance(health['data'].get('controllers'), list))
# 错误臂 → PhysicalError → {error: ...}（TS 契约的联合另一臂）
# O/P 纪元修正：旧模拟依赖「pyautogui 未安装」的环境假设 —— 真机装上
# pyautogui（且有显示）后假设破产、检查恒假。环境无关律：向 sys.modules
# 注入毒性桩（size()/screenshot() 必炸）—— 任何机器上确定性走 error 臂。
input_mod._pyautogui = None
os.environ.pop('DSH_PHYSICAL_TEST_SCREEN', None)


class _PoisonedPyautogui:
    """毒性桩：模拟「显示服务不可用」的运行时故障面。"""

    class _Boom(Exception):
        pass

    @staticmethod
    def size():
        raise RuntimeError('poisoned: display backend unavailable (V2c simulation)')

    @staticmethod
    def screenshot():
        raise RuntimeError('poisoned: display backend unavailable (V2c simulation)')

    @staticmethod
    def position():
        raise RuntimeError('poisoned: display backend unavailable (V2c simulation)')


_real_pyautogui = sys.modules.get('pyautogui')
sys.modules['pyautogui'] = _PoisonedPyautogui
try:
    bad = input_mod.InputController(ActionConfig())
    routes.set_controllers(bad, ScreenCapture(cfg.screenshot), UIFunnel(cfg.funnel), WindowManager(cfg.window), cfg)
    health2 = asyncio.run(routes.health())
finally:
    if _real_pyautogui is not None:
        sys.modules['pyautogui'] = _real_pyautogui
    else:
        sys.modules.pop('pyautogui', None)
sc2 = health2['data']['screen']
ok('V2c 无显示时 health.screen 诚实进入 error 臂（毒性桩环境无关律）',
   isinstance(sc2, dict) and 'error' in sc2 and 'width' not in sc2, f'screen={sc2}')

# ═══ V3：致命级 #3 —— shm 生命周期（注册表唯一持有者 + 键名一致 + 无 weakref 过早释放）═══
ok('V3a weakref 兜底已移除（生命周期唯一事实源 = 注册表）',
   getattr(shm_mod, 'weakref', None) is None)
payload = bytes(range(256)) * 40  # 10240 字节确定性载荷
with tempfile.TemporaryDirectory() as td:
    conf = ScreenshotConfig(transport='mmap-file', mmap_dir=td)
    h = shm_mod.make_handle(payload, 256, 160, 'PNG', conf)
    key_ok = h.name in shm_mod._active_handles  # 注册键 == handle.name（旧实现键=短名恒 miss）
    gc.collect()  # 旧实现：weakref 在此触发 munmap/unlink —— 现在 handle 必须 still alive
    alive_after_gc = os.path.exists(h.name)
    data = open(h.name, 'rb').read()
    ok('V3b 注册表键 == ShmHandle.name（DELETE 端点按名释放可命中）', key_ok, f'name={h.name}')
    ok('V3c GC 后文件仍存活（无 weakref 过早释放）', alive_after_gc)
    ok('V3d 数据完整（10240 字节逐位一致）', data == payload, f'{len(data)}B')
    ok('V3e 显式释放命中（release_by_name(handle.name) == True）', shm_mod.release_by_name(h.name) is True)
    ok('V3f 释放后文件消失', not os.path.exists(h.name))
    ok('V3g 二次释放诚实 miss（幂等无害）', shm_mod.release_by_name(h.name) is False)

print(f'\n=== 致命级修复运行时证据：{PASS}/{PASS} 全部通过 ===')

# ═══ 严重级证据（J 纪元升级验收）═══
print('\n--- 严重级（协议错位/安全）---')

# S1：mint_token 自举死锁已移除（端点从路由表消失）
paths = [getattr(r, 'path', '') for r in routes.router.routes]
ok('S1 /v1/mint_token 已移除（自举死锁 + 免密钥全能力铸造洞）',
   '/v1/mint_token' not in paths, f'routes={len(paths)} 条')

# S2：AppleScript 转义纯函数（顺序铁律：先反斜杠后引号）
from dsh_physical.window import escape_applescript  # noqa: E402
BS = chr(92)  # 反斜杠经 chr 构造 —— 免疫任何 shell/编辑器转义环境
Q = chr(34)   # 双引号
ok('S2a escape_applescript 转义引号与反斜杠（顺序铁律）',
   escape_applescript(f'He said {Q}hi{Q}{BS}done') == f'He said {BS}{Q}hi{BS}{Q}{BS}{BS}done',
   repr(escape_applescript(f'He said {Q}hi{Q}{BS}done')))
s2b = escape_applescript(f'a{Q}b{BS}{Q}c')
unescaped = any(ch == Q and (i == 0 or s2b[i - 1] != BS) for i, ch in enumerate(s2b))
ok('S2b 每个引号都被反斜杠前导（无未转义引号 = 注入面闭合）',
   not unescaped, repr(s2b))
ok('S2c 反斜杠先行（旧实现的顺序错误形态永不复现：先引号后反斜杠会翻倍）',
   escape_applescript(f'{BS}{Q}') == f'{BS}{BS}{BS}{Q}',
   repr(escape_applescript(f'{BS}{Q}')))

# S3：AuthResult 携带 exp（nonce 防重放不再手工双解）
from dsh_physical import auth as auth_mod  # noqa: E402
key = auth_mod.ensure_key(os.path.join(tempfile.mkdtemp(), 'k.key'))
tok = auth_mod.mint_token(key, 4242, auth_mod.ALL_CAPS, 60)
res = auth_mod.parse_token(key, tok)
ok('S3 parse_token 单次解析携带 exp/caps/pid（nonce 上界直取）',
   res.ok and res.pid == 4242 and res.exp > 0 and len(res.caps) == len(auth_mod.ALL_CAPS),
   f'exp={res.exp}')
bad = auth_mod.parse_token(key, tok + 'x')
ok('S3b 篡改签名拒绝', not bad.ok)

print(f'[section] 致命级 14/14 + 严重级 {PASS - 14}/ {PASS - 14} —— 继续中等级…')


# S5：PID 白名单装载器（空壳机制化 —— 纯函数三态）
from dsh_physical.auth import _load_pid_whitelist  # noqa: E402
ok('S5a 缺席/空 ⇒ 开放模式（CI 友好，现状语义）',
   _load_pid_whitelist(None) == set() and _load_pid_whitelist('') == set())
ok('S5b 合法 64-hex 条目装载（逗号分隔，大小写归一）',
   _load_pid_whitelist('AB' + '0' * 62 + ', ' + 'cd' + 'f' * 62) ==
   {'ab' + '0' * 62, 'cd' + 'f' * 62})
try:
    _load_pid_whitelist('abc')
    ok('S5c 非法条目整条拒绝（拒绝半载白名单）', False, '未抛错')
except ValueError:
    ok('S5c 非法条目整条拒绝（拒绝半载白名单）', True)

print('')
print(f'=== 全部证据：{PASS}/{PASS} 通过 ===')
