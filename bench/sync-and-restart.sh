#!/bin/bash
# 同步插件构建产物到 DSH 安装副本并重启 web 服务
#
# Y6 战果注记（为什么有两份 INST）：
#   DSH 实际加载的插件在 data/profiles/web/node_modules（运行时真正 require 的副本）；
#   store/v11/projects/... 是物化源 —— DSH 重启时从 store 向 profile 建硬链接刷新。
#   旧脚本只同步 store，靠重启刷新间接生效；一旦某次重启没触发刷新（或
#   rm -rf+cp 断开了硬链接），profile 就停留在旧代码，表现为"改了没生效"。
#   现在两处都显式同步：store 保住物化源，profile 保住加载点，确定性生效。
SRC="/d/dsh3/dsh-computer-use-plugin"
INSTS=(
  "/d/DeepSeekHarness/bin/store/v11/projects/6f96f97015f3572ba5a7890f3b3570fd/node_modules/dsh-computer-use-plugin"
  "/d/DeepSeekHarness/data/profiles/web/node_modules/dsh-computer-use-plugin"
)

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
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3080 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id \$_ -Force }" 2>/dev/null || true
sleep 2

cd /d/DeepSeekHarness
cmd //c "dsh.cmd web" > /d/dsh3/test-runs/dsh-web.log 2>&1 &
echo "[restart] launched; waiting for 3080..."
for i in $(seq 1 30); do
  sleep 2
  if curl -s -m 2 -o /dev/null -w "%{http_code}" http://127.0.0.1:3080/ | grep -q 200; then
    echo "[restart] DSH is UP"
    exit 0
  fi
done
echo "[restart] WARNING: 3080 not up after 60s"
exit 1
