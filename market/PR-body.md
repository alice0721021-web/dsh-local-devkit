## 新增插件：dsh-local-devkit

为 Harness 补齐「本地事实层」：环境探测、运行时健康检查、git 工具、写入前快照、多语言项目检查。

### 为什么值得收录

- **`health_probe` 填补一个空白**：它检查的是「功能是否还在产出」，而不只是「进程是否活着」。本机真实遇到过 `dsh-recall-plugin` 因工作区超过 `maxWorkspaceBytes` 静默停用快照 48 小时——进程正常、心跳正常、配置也正确，只有这类检查能发现。
- **`env_probe` 覆盖桌面版的一个坑**：DSH Desktop 主进程是 Electron，`process.execPath` 指向 `DeepSeek Harness.exe` 而不是 node，插件作者很容易在这里踩空。
- **与 `@jayyuen66/dsh-quality-gate` 互补**：那个做回合末自动门禁且明确「不注册任何模型工具」，白名单也限定在 `pnpm check`/`cargo check`/`ruff check`/`tsc`；这里是模型可主动调用的检查入口，覆盖 Node / Python / Go 的 test 与 typecheck。

### 清单

- [x] public 仓库（`alice0721021-web/dsh-local-devkit`），已加 `dsh-plugin` topic
- [x] `dsh.bundle.patch` 指向 `cordis.patch.yml`
- [x] `engines.dsh`: `>=0.2.1-rc.3 <0.3.0`
- [x] 41 个单元与集成测试（含输出 schema 校验）
- [x] 零运行时依赖，仅使用 node 内置模块

### 工具一览

| 工具 | 作用 |
| --- | --- |
| `env_probe` | bash / pwsh / node / pnpm / git / python 可用性 |
| `health_probe` | recall 快照最后更新时间、工作区体积上限、profile bundles |
| `git_status` / `git_diff` / `git_log` / `git_commit` | git 闭环，commit 不暴露 `--amend` / `--force` |
| `fs_checkpoints` / `fs_restore` | 写入前快照，按路径逐版回退或按 id 精确恢复 |
| `project_check` | Node / Python / Go 项目检查，只跑项目已声明的命令 |
