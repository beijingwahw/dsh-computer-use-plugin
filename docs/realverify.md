# 真机验证收割指南（ΤΕΛ-9 realverify）

> 定位：DEBTS.md 中 8 条「需真机」债（D-A2 / D-A3 / D-A4 / D-A6 / D-A7 /
> D-A8 / D-B1 / D-G4，另含已闭债 D-A1 唯余的采集卡现场标定残余）的**一键
> 验证基建**。每条债一个自包含探针（`scripts/realverify/`），形态模仿
> `python_service/real_probe.py`（真机实证探针先例）：环境自检（硬件在场
> 判定）→ 缺席诚实退出 → 在场时执行验证并输出结构化判定。
>
> 目标：**硬件到位当天即可收割**——不需要写一行临时代码。

## 0. 一键总跑（ΤΕΛ-9b）

```bash
node scripts/realverify/run-all.mjs            # 全部探针串行 + 汇总报告
node scripts/realverify/run-all.mjs --only D-A2,D-A3   # 只跑指定债
node scripts/realverify/run-all.mjs --list     # 登记册一览
```

- **退出码**：`1` 仅当有 `fail`（在场但验证失败）或探针自身故障；
  全部 `absent`（设备缺席，各探针 exit 2）/`degraded`/`pass` ⇒ `0`。
  **缺席不红**——缺席是诚实信号，不是失败。
- **输出**：逐探针 `[PASS/ABSENT/DEGRADED/FAIL/ERROR] 债号 标题` + 结论行 +
  `SUMMARY {json}`；报告落盘 `scripts/realverify/realverify-report.json`
  （`DSH_REALVERIFY_REPORT` 可改道）。
- **单探针判定语义**（全部探针一致）：stdout 最后一行
  `REALVERIFY <json>`（`verdict` = pass/fail/degraded/absent + 证据）；
  退出码 `0`=pass / `1`=fail / `2`=absent / `3`=degraded。
- **离线自检**：`DSH_REALVERIFY_FORCE_ABSENT=1`（或 `--force-absent`）强制
  全部探针走缺席路径——`test/realverify.test.ts` 用它做确定性离线测试。

本机基线（Windows 开发机，2026-10-04）：9 探针 = pass 2（D-A1 摄像头帧标定
工作流、D-A4 raw-vtable 真声学整环：播放叮声→回环→分类 `notification_ding`
conf 0.73）+ absent 7 + fail 0，run-all exit 0。

## 1. 逐债收割手册（ΤΕΛ-9a 探针 × 硬件清单 × 预期）

### D-A1（残余）· UVC 采集卡现场标定 — `probe-da1-uvc.py`

| 项 | 内容 |
| --- | --- |
| 硬件清单 | HDMI→USB 采集卡（UVC 协议，如 MS2109/CV9102 芯片卡）×1；HDMI 线 ×1；信号源（另一台电脑/机顶盒的桌面输出）×1 |
| 接线方式 | 信号源 HDMI 输出 → 采集卡 HDMI in → 采集卡 USB → 本机 USB 口。多摄像头机器上用 `DSH_REALVERIFY_UVC_INDEX=<n>` 钉死设备索引 |
| 运行命令 | `python scripts/realverify/probe-da1-uvc.py` |
| 预期输出 | `pass`：12 帧稳定读出（如 1920×1080）、黑边剖面 → 建议四角（接入真信号源时角偏离恒等）、`rectify` 矫正尺寸=natural_size、证据帧 `evidence-da1-frame.jpg` 落盘 |
| 收割后回填 | 台账行（D-A1 状态列追加）：`唯余现场标定已收割（ΤΕΛ-9 探针 realverify-report.json D-A1 段：建议角 {tl…bl} + 证据帧）` |

### D-A2 · CH9329 串口 HID 真棒 — `probe-da2-ch9329.py`

| 项 | 内容 |
| --- | --- |
| 硬件清单 | CH9329 串口 HID 棒 ×1（常见 CH340/CP210x/FT232 桥，VID 0x1A86/0x10C4/0x0403 自动识别）；USB 口目标机（可以是本机或另一台机——探针只发**无害绝对移动帧**，不点击不按键） |
| 接线方式 | 棒的 USB 口插本机（探针从这里写命令帧）。可选强化：把棒 的 TX-RX 短接成环回头，回读流即我们写出的命令帧本身（最完整的通道回环） |
| 运行命令 | `python scripts/realverify/probe-da2-ch9329.py`（口不自动识别时 `DSH_REALVERIFY_HID_PORT=COM3`；波特率 `DSH_PHYSICAL_HID_BAUD`，缺省 115200） |
| 预期输出 | `pass`：`3 帧绝对移动命令经真串口写出` + 回读 ≥1 帧解 SUM 校验通过（`kind: ack`（应答模式回执）或 `echo`（TX-RX 短接回显））。仅写出无回读 ⇒ `degraded`（出厂模式 0 不回执——短接 TX-RX 或设应答模式后重跑） |
| 收割后回填 | 台账 D-A2 行状态 → `已闭环（真棒通道回环：ΤΕΛ-9 探针 realverify-report.json D-A2 段）` |

### D-A3 · Android 真机 adb/scrcpy — `probe-da3-android.py`

| 项 | 内容 |
| --- | --- |
| 硬件清单 | Android 真机 ×1（系统 ≥7，开发者模式 + USB 调试开）；（可选）scrcpy ≥2.0（`--screenshot` 单帧低带宽优选） |
| 接线方式 | USB 连真机 → 弹窗允许调试授权（state=device）。无线设备先 `adb connect <ip:port>`。adb 位置：PATH 或 `ANDROID_HOME`（或 `DSSH_REALVERIFY_ADB` 显式指定） |
| 运行命令 | `python scripts/realverify/probe-da3-android.py`（多设备时 `DSH_REALVERIFY_ANDROID_SERIAL=<serial>`；注入冒烟 `DSH_REALVERIFY_ANDROID_INJECT=1` 才发 home 键） |
| 预期输出 | `pass`：清单 + 分辨率（如 1080×2400）+ `grab_frame` 帧源降级链真执行（scrcpy 命中或降级 `adb exec-out screencap`——note 如实申报），证据 PNG `evidence-da3-frame.png`。scrcpy 缺席 ⇒ `degraded`（降级链语义正确） |
| 收割后回填 | 台账 D-A3 行状态 → `已闭环（真机端到端：ΤΕΛ-9 探针 realverify-report.json D-A3 段 + evidence-da3-frame.png）` |

### D-A4 · WASAPI 声学真环 — `probe-da4-audio.py`

| 项 | 内容 |
| --- | --- |
| 硬件清单 | Windows 机器（有默认 render 音频端点——本机扬声器/耳机即可，**无需额外硬件**）；可发声状态（非静音） |
| 接线方式 | 无物理接线——回环采集走 WASAPI loopback（系统混音总线），播放与捕获同 bus |
| 运行命令 | `python scripts/realverify/probe-da4-audio.py` |
| 预期输出 | `pass`：播放合成叮声 → 回环 ~2.5s → `classify_window` = `notification_ding`（引擎标记 raw-vtable（py≥3.14）或 comtypes（py<3.14）如实入证据）。系统静音/无声卡 ⇒ `absent` 或 `degraded`（reason 逐字带回） |
| 收割后回填 | 台账 D-A4 行状态 → `已闭环（真声学整环：ΤΕΛ-9 探针 realverify-report.json D-A4 段，分类判决+引擎标记在案）` |

### D-A6 · 真 VLM 模型长跑 — `probe-da6-vlm.mjs`

| 项 | 内容 |
| --- | --- |
| 硬件清单 | 真 VLM API 密钥 ×1（智谱开放平台 GLM，或任意 OpenAI 兼容端点）；网络可达 |
| 接线方式 | 环境变量：`GLM_API_KEY=<key>`（或 `ZHIPUAI_API_KEY`/`ZAI_API_KEY`/`DSH_REALVERIFY_VLM_KEY` 任一）；异构端点 `DSH_REALVERIFY_VLM_BASE_URL` / `DSH_REALVERIFY_VLM_MODEL`（缺省 `https://open.bigmodel.cn/api/paas/v4` + `glm-5.3-flash`，与 config.ts 纪元 Ω 缺省同源） |
| 运行命令 | `GLM_API_KEY=... DSH_REALVERIFY_VLM_ROUNDS=50 node scripts/realverify/probe-da6-vlm.mjs`（轮数缺省 8、上限 500；`DSH_REALVERIFY_VLM_VISION=0` 关视觉冒烟轮） |
| 预期输出 | `pass`：N 文本轮 + 1 视觉轮全过（p50/max 延迟、total_tokens、逐轮 status 在证据）；成功率 ≥80% <100% ⇒ `degraded`（「不稳」如实申报）；密钥 401/403 ⇒ `fail` |
| 收割后回填 | 台账 D-A6 行状态 → `已闭环（真模型长跑：ΤΕΛ-9 探针 realverify-report.json D-A6 段——成功率/延迟分布/token 计量在案）` |

### D-A7 · Linux 真机首验（uinput/peercred） — `probe-da7-linux.py`

| 项 | 内容 |
| --- | --- |
| 硬件清单 | 任意 Linux 机器/容器（物理机或 GitHub ubuntu runner——`/dev/uinput` 在场需 root 或 uinput 组/udev 规则） |
| 接线方式 | 无。要验服务面另开终端 `python -m dsh_physical`（tcp:8421）后设 `DSH_REALVERIFY_LINUX_SERVICE=1`（探针只读探活，不自行起服务） |
| 运行命令 | `python scripts/realverify/probe-da7-linux.py` |
| 预期输出 | `pass`：`/dev/uinput` 可写 + `/dev/shm` 可写（剩余字节入证据）+ AF_UNIX `SO_PEERCRED` 对端 pid == 本进程 pid（内核佐证）+ peercred 协议插件可构造。uinput/shm 缺配置 ⇒ `degraded`（UDS 面证毕） |
| 收割后回填 | 台账 D-A7 行状态 → `已闭环（Linux 首验：ΤΕΛ-9 探针 realverify-report.json D-A7 段 + ci.yml e2e 步骤绿）` |

### D-A8 · comtypes 建链臂真机冒烟（py<3.14） — `probe-da8-comtypes.py`

| 项 | 内容 |
| --- | --- |
| 硬件清单 | Windows 机器 + **Python < 3.14 解释器**（3.8–3.13 任一）+ `pip install comtypes` + 有默认 render 音频端点 |
| 接线方式 | 版本域说明：py≥3.14 上生产代码首选 raw-vtable（ΑΩ-R1/D-E2 已闭），comtypes 臂不是活动臂——探针在 py≥3.14 上诚实 `absent`。用 `py -3.12 scripts/realverify/probe-da8-comtypes.py` 这类版本选择器跑 |
| 运行命令 | `py -3.12 -m pip install comtypes && py -3.12 scripts/realverify/probe-da8-comtypes.py` |
| 预期输出 | `pass`：`_build_comtypes()` 接口定义构造成 + `_open_session_comtypes()` 真建链（GetDefaultAudioEndpoint 出参 → Activate → GetMixFormat（Hz/bit/ch 入证据）→ Initialize(LOOPBACK) → Start → GetService）+ 引擎标记 `comtypes` + 读到样本。无端点 ⇒ `absent`；建链抛错 ⇒ `fail`（正是本债要抓的出参约定形态） |
| 收割后回填 | 台账 D-A8 行状态 → `已闭环（py<3.14 comtypes 建链冒烟：ΤΕΛ-9 探针 realverify-report.json D-A8 段）` |

### D-B1 · 稀疏 SoM 在线 A/B — `probe-db1-som.mjs`

| 项 | 内容 |
| --- | --- |
| 硬件清单 | 真 VLM 密钥（同 D-A6）+ 一张**真实屏幕截图** PNG（越真实越好——桌面/浏览器/复杂 UI） |
| 接线方式 | `GLM_API_KEY=<key> DSH_REALVERIFY_SCREEN=/path/shot.png`；稀疏预算 `DSH_REALVERIFY_SOM_BUDGET`（缺省 12）、每臂轮数 `DSH_REALVERIFY_SOM_ROUNDS`（缺省 3） |
| 运行命令 | `GLM_API_KEY=... DSH_REALVERIFY_SCREEN=shot.png node scripts/realverify/probe-db1-som.mjs` |
| 预期输出 | `pass`：A 臂（原图 grounding）vs B 臂（`renderSomOverlay` 叠加编号锚点 + `sparseBudget` 稀疏选择真执行）交替轮——两臂全合法 JSON 且可观测差异（标记引用率 >0 或元素数中位差 ≠0）；合法但无差异 ⇒ `degraded`（**负结果同样构成开闸决策证据**）；对照建不起来 ⇒ `fail` |
| 收割后回填 | 台账 D-B1 行：开闸证据段追加 `ΤΕΛ-9 A/B 在案（realverify-report.json D-B1 段：引用率/元素数中位/延迟双臂对照）`——翻不翻 `somSparseBudget` 缺省由部署方按此证据决策（D-B1 的立法语义不变） |

### D-G4 · 标定生产数据 — `probe-dg4-calib.mjs`

| 项 | 内容 |
| --- | --- |
| 硬件清单 | 生产长跑数据目录（`.jsonl` 三族记录，见下方方言）；`npm run build` 后的 `dist/`（calibration.ts 权威源构建件） |
| 接线方式 | `DSH_REALVERIFY_DATA_DIR=/path/to/runs`（缺省探 `<repo>/.dsh` 与 `~/.dsh`）。**数据方言**（每行一个 JSON 对象，三族任选；裸数组 `[p,o]`/`[sem,geo,pop]`/`[s,rel]` 兼容）：`{"drift":{"predicted":0.3,"observed":0.41}}`（Kalman Q/R）｜`{"popup":{"semantic":true,"geometric":false,"isPopup":true}}`（Schmitt 弹窗三元组）｜`{"ncd":{"similarity":0.42,"relevant":true}}`（NCD 回访标签） |
| 运行命令 | `DSH_REALVERIFY_DATA_DIR=/path/to/runs node scripts/realverify/probe-dg4-calib.mjs` |
| 预期输出 | `pass`：≥1 族标定返回建议值（Q/R、Schmitt 证据强度对、NCD 阈值 + TPR/FPR/Youden J、GPD A² 临界表——样本量 n 入证据；诚实下限 ≥8、Schmitt 双侧各 ≥2 由 calibration.ts 单源执法）。数据在场但量不够 ⇒ `degraded` |
| 收割后回填 | 台账 D-G4 行：数据面段追加 `ΤΕΛ-9 标定收割（realverify-report.json D-G4 段：各族建议值 + n）`——睡眠④幕「只建议不落值」的立法是否落值仍由部署方决策 |

## 2. 台账回填行模板（收割当天复制即用）

收割判定为 `pass` 后，在 DEBTS.md 对应行做最小编辑（状态列 + 证据列追加，不改
他行；与本册各闭环行的格式同族）：

```markdown
| D-A2 | W4-6（零 API 设备面·HID） | （原描述不动） | 已闭环（真棒通道回环：ΤΕΛ-9 探针 pass——scripts/realverify/realverify-report.json D-A2 段：<日期>） | （原证据列不动）；scripts/realverify/probe-da2-ch9329.py |
```

- 状态列主词改 `已闭环（…）`，括号内一句：`ΤΕΛ-9 探针 pass + 日期 + 报告锚`。
- D-B1 / D-G4 不闭债（开闸/落值是部署决策）：只在描述或证据列**追加**探针证据段。

## 3. 工程契约（探针纪律）

- **绝不抛**：任何探针异常折叠为结构化 `fail`（诚实失败码）；python 侧
  `probe_common.run_probe` 外包裹，node 侧 try/catch 收口。
- **无新依赖**：node 用内置模块 + 全局 fetch + 既有 `dist/` 构建件与
  `sharp`（既有 dependencies）；python 用标准库 + 仓库 `dsh_physical`
  （cv2/pyserial/comtypes 为可选导入，缺席=诚实缺席）。
- **确定性**：`REALVERIFY` 行键序固定；缺席模式（`--force-absent`）全链路
  确定性可测（`test/realverify.test.ts`）。
- **退出码单源**：`scripts/realverify/common.mjs` 的 `EXIT`/`VERDICT_EXIT`
  （node）与 `probe_common.py` 同律（python）——缺席 2 不红是立法，不是约定。
