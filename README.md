# dsh-local-devkit

为 Harness 补齐「本地事实层」的插件：探测执行环境、检查功能是否还在产出、把 git 变成模型可直接调用的一等工具、在每次写文件前自动留快照，并能跑项目自带的检查。

纯 node 内置模块实现，无第三方依赖，不修改宿主文件。

## 工具

| 工具 | 作用 | 写操作 |
| --- | --- | --- |
| `env_probe` | 探测 bash / pwsh / node / pnpm / git / python 与 DSH profile 可写性，给出修复建议 | 否 |
| `git_status` | 分支、上游、ahead/behind、已暂存 / 未暂存 / 未跟踪 / 冲突 | 否 |
| `git_diff` | 工作区或暂存区 diff，支持路径过滤、`--stat`、字节上限截断 | 否 |
| `git_log` | 提交历史（短 hash、作者、日期、标题、引用） | 否 |
| `git_commit` | 可选先 `git add` 再提交；`dryRun` 只预览；不暴露 `--amend` / `--force` | 是 |
| `fs_checkpoints` | 列出当前项目的写入前快照，可按路径过滤 | 否 |
| `fs_restore` | 回滚：给 `path` 撤销该文件上一次写入（连续调用逐版回退），给 `id` 精确恢复；恢复前会再拍快照 | 是 |
| `project_check` | 探测并运行项目检查（Node scripts / Python pytest·ruff·mypy / Go test），结构化返回结果 | 部分是 |
| `health_probe` | 检查功能是否还在产出：recall 快照最后更新时间、工作区是否超过快照上限、profile bundles 是否装齐 | 否 |

非 git 目录统一返回 `NO_REPO` 而不是抛异常；越界路径返回 `PATH_OUTSIDE_REPO`。

## 写入前快照

插件挂到宿主的 `tools/execute` waterfall 上：`write` / `edit`（以及 `fs_write` / `fs_edit` / `multi_edit` / `apply_patch`）在真正落盘**之前**，把目标文件的原始内容存到 `<DSH_HOME>/devkit/checkpoints/<projectHash>/`。

- 快照失败只 `console.warn`，绝不阻断工具执行；
- 文件此前不存在时记录 `existed: false`，恢复即删除；
- 单文件超过 `checkpoint.maxFileBytes`（默认 4 MB）只记元数据、标 `skipped: too-large`；
- 每个项目最多保留 `checkpoint.maxEntries`（默认 500）条，超出删最旧；
- 快照目录自身不会被再次快照，避免递归。

配置示例（profile 的 `cordis.patch.yml`）：

```yaml
- id: devkit
  name: dsh-local-devkit
  config:
    checkpoint:
      maxEntries: 500
      maxFileBytes: 4194304
```

典型用法：

```
fs_restore({ path: "src/app.ts" })   # 撤销这个文件的上一次写入
fs_restore({ path: "src/app.ts" })   # 再调一次 → 再退一版（v3 → v2 → v1 → 删除）
fs_restore({ id: "1793376673288-..." })  # 知道 id 时精确回到某一版
```

按路径回退时，被用掉的那条快照会标记 `consumed: true`，恢复动作留下的 `pre-restore` 快照不参与选择——所以连续调用是**逐版后退**，不会在两个状态之间来回跳。想把某次回退本身也撤掉，用 `fs_checkpoints` 找到那条 `pre-restore` 记录，按 `id` 恢复。

## 项目验证

`project_check` 按项目形态自行探测，按 `typecheck → lint → test → build` 顺序执行，第一个失败就停。

**Node**（`package.json` scripts）：

| 目标 | 匹配的 script 名 |
| --- | --- |
| typecheck | `typecheck` / `type-check` / `check-types` / `tsc` |
| lint | `lint` / `eslint` / `stylelint` |
| test | `test` / `tests` / `jest` / `vitest` / `mocha` |
| build | `build` / `compile` |

**Python**（`pyproject.toml` / `pytest.ini` / `conftest.py` 等标记）：

| 目标 | 判据 | 命令 |
| --- | --- | --- |
| typecheck | `mypy.ini` / `.mypy.ini` / `[tool.mypy]` | `python -m mypy .` |
| lint | `ruff.toml` / `.ruff.toml` / `[tool.ruff]` | `python -m ruff check .` |
| test | `pytest.ini` / `conftest.py` / `[tool.pytest]` / `tests/` | `python -m pytest` |

解释器优先用项目内 `.venv`，其次 DSH 内置 python。**只有 `pyproject.toml` 而没有对应声明时不会臆造目标**——避免造出稳定假失败。

**Go**（`go.mod`）：`go test ./...`，`go` 不在 PATH 时返回 `MANAGER_MISSING` 并提示安装。

通用约定：

- Node 包管理器按 `packageManager` → lock 文件推断，不在 PATH 时回落到 DSH 内置 pnpm；
- **只运行项目自己声明的检查**，不接受自定义命令，避免注入；
- 每个目标默认 180s 超时（上限 600s），输出截断到 8 KB，失败时抽取最多 10 条失败行；
- `dryRun: true` 只列出将执行的命令；
- 失败摘要是"匹配到的失败行 + stderr 尾部"去重后的结果，不会只剩一句 `ELIFECYCLE`。

为什么不直接用市场上的插件：`@jayyuen66/dsh-quality-gate` 做的是**回合末自动门禁**，README 明确"不注册任何模型工具"，且白名单只有 `pnpm check`/`cargo check`/`ruff check`/`tsc` 四条，不含 pytest 与 go test。`dsh-flakefinder` 支持 pytest 但定位是 flaky 调查。**模型可主动调用的检查入口**仍是空白。

为什么不做"结构化代码检索"：宿主里没有 LSP、diagnostics、tree-sitter 或 TypeScript（`dsh-util-code-language` 只是扩展名映射）。靠正则模拟"找定义/找引用"与现有 `ops_grep` 高度重叠，自建 tree-sitter 又要背原生模块的跨平台成本——投入产出比不成立。而"改完能不能验证"是更实在的缺口。

## 健康检查

`env_probe` 回答"二进制在不在、能不能跑"，`health_probe` 回答"功能还在不在产出"。两者对应不同的失效模式——进程活着、心跳正常、配置也正确，但功能静默停产，只靠前者发现不了。

它检查四件事：

| 检查项 | 判据 | 典型故障 |
| --- | --- | --- |
| `recall` | `dsh-recall-snapshots/*/index.json` 最新条目的时间是否超过 `stalenessHours`（默认 24h） | 工作区超过 `maxWorkspaceBytes`（默认 256 MB）导致快照静默停用 |
| `workspace` | 粗略统计可快照体积（跳过 `node_modules` / `.venv` / `dist` 等），与上限比较 | 大文件（安装包、数据集）留在工作区 |
| `checkpoints` | 本插件快照条数与最后时间 | 钩子未生效 |
| `profile` | `dsh.profile.bundles` 里的包是否都存在于 `node_modules` | 装了但没执行 `pnpm install` |

输出结构是"最后活动时间 + 状态"，而不是简单的 ok/fail，这样一眼能看出哪个插件在装死。工作区扫描有 `scanBudgetMs`（默认 1500 ms）预算，超时会标记 `partial` 而不是卡住。

```js
health_probe({ cwd, stalenessHours?, workspaceLimitBytes?, scanBudgetMs? })
```

## 安装

在插件目录执行安装脚本（幂等，写前自动备份 package.json / cordis.patch.yml / pnpm-lock.yaml）：

```powershell
node scripts/install.mjs --dry-run   # 先预览改动
node scripts/install.mjs             # 写入 package.json / cordis.patch.yml 并 pnpm install
```

脚本会：

1. 在 `profiles/<profile>/package.json` 增加 `"dsh-local-devkit": "link:F:/FJ/dsh-devkit"`；
2. 把 `dsh-local-devkit` 追加到 `dsh.profile.bundles`；
3. 在 `cordis.patch.yml` 写入标记块，内含 `- insert: - id: devkit`；
4. 调用内置 pnpm 执行 `install`。

之后重启 DSH，在会话里调用 `env_probe` 验证。

卸载：`node scripts/install.mjs --uninstall`（同样会刷新依赖）。

## 测试

node 不在 PATH 时用内置解释器：

```powershell
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" --test test/
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" scripts/smoke.mjs
```

- `test/parse.test.mjs`：porcelain v2 / numstat / log 解析与路径守卫，纯函数、无需 git；
- `test/git-integration.test.mjs`：在 `os.tmpdir()` 建临时仓库，验证 status / diff / log / commit 的真实行为，无 git 时整体跳过；
- `test/schema.test.mjs`：按宿主规则校验全部工具输出，覆盖二进制、detached HEAD、空仓库、无上游等边界。

## 设计约束

- 子进程一律 `execFile` + `shell: false`，避免注入；
- 默认超时 15s、输出缓冲 1MB，stderr 摘要截断 2KB；
- `apply` 内任何注册失败只 `console.warn`，不阻断宿主启动；
- `commit` 的路径先 `resolveRepo` 再 `assertInside` 校验，Windows 下按大小写不敏感比较。

### 输出契约（宿主强制）

DSH 会校验工具的返回值，两条规则踩过坑：

1. **必须是 lossless JSON**：返回值里出现 `undefined` 会被判为 `value is not lossless JSON`。`buildTools()` 已统一用 `lossless()` 做一次 JSON round-trip 剔除，工具内部不必各自清理。
2. **声明了类型的字段不能是 `null`**：`output.schema` 里写成 `{ type: 'string' }` 的字段若返回 `null`，会被拒绝为 `"value.x" must be a string`。因此**可空字段不要声明类型**（依赖 `additionalProperties: true` 放过），例如 `branch` / `upstream` / `added` / `removed` / `commit.short`。

改 schema 或新增字段后，跑 `test/schema.test.mjs` 可以在本地复现宿主校验，无需重启 DSH。
