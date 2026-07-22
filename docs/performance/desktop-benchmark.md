# Office Viewer 真实桌面性能基准

该基准启动真实 Electron 桌面进程，使用真实 XLSX 解析器和生产 AI IPC/上下文/HTTP 链路，输出可用于机器间留档及同机版本比较的结构化 JSON。

## 运行

```powershell
npm run benchmark:desktop
```

默认结果写入 `docs/performance/results/latest.json`。可追加参数：

```powershell
npm run benchmark:desktop -- --output docs/performance/results/candidate.json
npm run benchmark:desktop -- --baseline docs/performance/results/baseline.json
npm run benchmark:desktop -- --baseline docs/performance/results/baseline.json --enforce
```

直接测量已有的 `win-unpacked` 产物，无需重新构建：

```powershell
node scripts/performance/run-desktop-benchmark.mjs `
  --packaged "dist/desktop/win-unpacked/Office Viewer.exe" `
  --output docs/performance/results/packaged.json
```

基准只支持 Windows。每次运行都会创建并最终删除独立的临时 `user-data-dir`、真实 XLSX 夹具和 AI 设置，不读取或修改用户 Office Viewer 配置。

## 指标边界

| 指标 | 起点 | 终点 | 比较值 |
|---|---|---|---|
| 冷启动 | 创建主 Electron 进程前 | 可见 `.desktop-shell` 后连续两个动画帧 | 单次毫秒 |
| 首文档打开 | 创建第二实例并交付真实 XLSX 前 | 标签、表格、目标 A1 值及两个动画帧全部就绪 | 单次毫秒 |
| 标签切换 | Renderer 内点击目标标签前 | 目标标签、表格、目标 A1 值及两个动画帧全部就绪 | 6 次样本的 p95 |
| AI 首字 | Renderer 内点击发送前 | 第一段非空助手文字进入 DOM | 单次毫秒 |
| 内存峰值 | 主进程创建后立即开始 | 最终 AI 流式响应完成后 | Main、全部 Renderer、完整 Electron 进程树 Working Set 峰值，MiB |

AI 测量不会调用真实 LLM。脚本启动仅监听 `127.0.0.1` 的确定性 NDJSON mock，固定延迟 60 ms，但请求仍经过真实文档抽取、Renderer → IPC → Main AI Service → HTTP → 流式事件链路。

内存采样器先立即跟踪 Main PID，再通过当前 Electron 的 CDP `SystemInfo.getProcessInfo` 发现同一实例的 Renderer/辅助 PID；PowerShell 以 100 ms 为目标间隔读取这些 PID 的真实 Working Set，不使用每轮 WMI 扫描。JSON 同时记录目标间隔和根据样本时间戳计算的实际 p50/p95/max 间隔。主流程会等待首个样本后才继续，并要求完整运行至少产生 20 个样本，否则基准直接失败。

## 阈值和版本比较

绝对预算定义在 `test/desktop/performance/thresholds.mjs`：

- 冷启动：8,000 ms
- 首 XLSX：8,000 ms
- 标签切换 p95：2,500 ms
- AI 首字：2,000 ms
- Main 峰值：350 MiB
- Renderer 合计峰值：700 MiB
- 完整进程树峰值：1,200 MiB

默认阈值为 **advisory**，便于开发机留档且不会因机器波动导致命令失败。使用 `--enforce` 后，任一绝对预算失败会返回非零退出码。

使用 `--baseline` 时，脚本从基准 JSON 的 `summary.comparableValues` 比较同名指标。仅当同时满足以下条件才判定回退：

1. 相对基准增加超过 20%；
2. 时间指标至少增加 150 ms，或内存指标至少增加 32 MiB。

这能过滤 Windows 调度、杀毒扫描和缓存造成的小幅噪声。版本比较必须尽量在同一机器、电源模式、显示缩放和后台负载条件下进行；冷启动建议分别重启应用后采集至少三次并取中位数作为发布基线。

## JSON 结构

结果包含：

- Git 提交与工作区状态；
- 操作系统、CPU、内存、Node/Electron 和运行模式；
- 每项指标的起止定义、单位、原始样本和统计值；
- Main/Renderer/总进程树内存峰值及采样数；
- 绝对阈值结果和可选 baseline 比较；
- 隔离和本地 mock 声明。
