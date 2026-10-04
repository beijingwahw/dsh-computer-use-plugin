#!/bin/bash
# 同步插件构建产物到 DSH 安装副本并重启 web 服务
#
# Y6 战果注记（为什么有两份 INST）：
#   DSH 实际加载的插件在 data/profiles/web/node_modules（运行时真正 require 的副本）；
#   store/v11/projects/... 是物化源 —— DSH 重启时从 store 向 profile 建硬链接刷新。
#   旧脚本只同步 store，靠重启刷新间接生效；一旦某次重启没触发刷新（或
#   rm -rf+cp 断开了硬链接），profile 就停留在旧代码，表现为"改了没生效"。
#   现在两处都显式同步：store 保住物化源，profile 保住加载点，确定性生效。
#
# ΑΩ-R30: 机器相关路径全部环境变量驱动（前缀统一 DSH_BENCH_），修复"路径写死 d 盘"：
#   SRC     = DSH_BENCH_SRC      —— 缺省从脚本位置推导本仓根（bench/ 的上一级，与实际
#                                   checkout 位置无关）；DSH 实际部署另有仓库副本时，
#                                   export DSH_BENCH_SRC=/d/dsh3/dsh-computer-use-plugin 覆盖。
#   INSTS   = DSH_BENCH_INST_STORE / DSH_BENCH_INST_PROFILE —— 两处安装副本，缺省为当前
#                                   部署机器的 DeepSeekHarness 路径；换机/换盘时 export 覆盖，
#                                   留空串可跳过该副本。
#   DSH 根  = DSH_BENCH_DSH_ROOT —— 重启命令 cd 的目标（dsh.cmd 所在目录），缺省当前部署值。
#   日志    = DSH_BENCH_WEB_LOG  —— 缺省写到本仓 bench/dsh-web.log（*.log 已 gitignore）。
#   端点    = DSH_BENCH_ENDPOINT —— 缺省 http://127.0.0.1:3080；杀端口与探活均由此派生，
#                                   与 battery/dsh-drive 共用同一环境变量。
SRC="${DSH_BENCH_SRC:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
INST_STORE="${DSH_BENCH_INST_STORE:-/d/DeepSeekHarness/bin/store/v11/projects/6f96f97015f3572ba5a7890f3b3570fd/node_modules/dsh-computer-use-plugin}"
INST_PROFILE="${DSH_BENCH_INST_PROFILE:-/d/DeepSeekHarness/data/profiles/web/node_modules/dsh-computer-use-plugin}"
DSH_ROOT="${DSH_BENCH_DSH_ROOT:-/d/DeepSeekHarness}"
WEB_LOG="${DSH_BENCH_WEB_LOG:-$SRC/bench/dsh-web.log}"
ENDPOINT="${DSH_BENCH_ENDPOINT:-http://127.0.0.1:3080}"
ENDPOINT="${ENDPOINT%/}"
PORT="${ENDPOINT##*:}"
# 空串 = 显式跳过该副本（如新机器上尚未部署 profile）
INSTS=()
[ -n "$INST_STORE" ] && INSTS+=("$INST_STORE")
[ -n "$INST_PROFILE" ] && INSTS+=("$INST_PROFILE")

# 0. 先杀 dsh_physical 服务进程（python_service 目录被运行中进程占用）
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { \$_.CommandLine -like '*dsh_physical*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" 2>/dev/null || true
sleep 1

for INST in "${INSTS[@]}"; do
  if [ ! -d "$INST" ]; then
    echo "[sync] SKIP (absent): $INST"
    continue
  fi
  echo "[sync] $INST"
  rm -rf "$INST/dist" "$INST/python_service"
  cp -r "$SRC/dist" "$INST/dist"
  cp -r "$SRC/python_service" "$INST/python_service"
  find "$INST/python_service" -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
  cp "$SRC/package.json" "$INST/package.json"
done

# 同步后校验：任一副本的关键指纹（新仲裁代码标记）缺失即报错 —— 防静默旧码
for INST in "${INSTS[@]}"; do
  [ -d "$INST" ] || continue
  if ! grep -q "ABSENCE" "$INST/dist/system.js" 2>/dev/null; then
    echo "[sync] VERIFY-FAIL: $INST/dist/system.js lacks expected marker" >&2
    exit 1
  fi
done
echo "[sync] verified (native-first arbitration marker present in all copies)"

echo "[sync] done. restarting DSH..."
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort $PORT -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id \$_ -Force }" 2>/dev/null || true
sleep 2

mkdir -p "$(dirname "$WEB_LOG")"
cd "$DSH_ROOT" || { echo "[restart] FAIL: DSH_ROOT 不存在: $DSH_ROOT" >&2; exit 1; }
cmd //c "dsh.cmd web" > "$WEB_LOG" 2>&1 &
echo "[restart] launched; waiting for $PORT..."
for i in $(seq 1 30); do
  sleep 2
  if curl -s -m 2 -o /dev/null -w "%{http_code}" "$ENDPOINT/" | grep -q 200; then
    echo "[restart] DSH is UP"
    exit 0
  fi
done
echo "[restart] WARNING: $PORT not up after 60s"
exit 1
