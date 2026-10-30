# 更新日志

本文件格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [0.1.0] - 2026-10-31

首个发布版本：为 Harness 补齐「本地事实层」。

### 新增

- **环境探测** `env_probe`：bash / pwsh / node / pnpm / git / python 可用性与 DSH profile 可写性，缺失项给出修复建议。
- **git 工具** `git_status` / `git_diff` / `git_log` / `git_commit`：基于 porcelain v2 解析，只读优先，commit 不暴露 `--amend` / `--force`。
- **写入前快照** `fs_checkpoints` / `fs_restore`：挂 `tools/execute` 钩子，在 `write` / `edit` 落盘前保存原内容；`fs_restore` 支持按路径逐版回退（`consumed` 机制防止横跳）与按 id 精确恢复，恢复动作本身也可撤销。
- **项目检查** `project_check`：自动探测 Node（package.json scripts）/ Python（pytest / ruff / mypy）/ Go（go test），只运行项目已声明的检查，缺依赖时给出清晰降级。
- **健康检查** `health_probe`：检查功能是否仍在产出——recall 快照最后更新时间、工作区是否超过快照上限、profile bundles 是否装齐、本插件快照条数。

### 设计约束

- 工具返回值必须是 lossless JSON；`output.schema` 里可空字段不声明类型，避免被宿主校验拒绝。
- 所有需要 node 的地方走 `nodeBinary()`：DSH 桌面版主进程是 Electron，`process.execPath` 不是 node。
- 快照与检查失败只告警，不阻断工具执行。

### 已知限制

- 写入前快照只覆盖 `write` / `edit` 类工具；`bash` 里的 `sed -i`、`rm` 不会被自动快照。
- `project_check` 目前覆盖 Node / Python / Go 三类，Rust 与 monorepo 多根未实现。
