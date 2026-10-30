/**
 * dsh-devkit —— 环境探测、git 工具与写入前快照（node 半身）。
 *
 * 注册九个面向模型的工具：env_probe / git_status / git_diff / git_log / git_commit
 * / fs_checkpoints / fs_restore / project_check / health_probe，并挂上 tools/execute 钩子为 write / edit 自动快照。
 * 纯 node 内置模块实现，不引入第三方依赖。
 *
 * @module dsh-devkit
 */
import { createEnvProbeTool } from './src/tools/env-probe.mjs';
import { createGitStatusTool } from './src/tools/git-status.mjs';
import { createGitDiffTool } from './src/tools/git-diff.mjs';
import { createGitLogTool } from './src/tools/git-log.mjs';
import { createGitCommitTool } from './src/tools/git-commit.mjs';
import { createFsCheckpointsTool } from './src/tools/fs-checkpoints.mjs';
import { createFsRestoreTool } from './src/tools/fs-restore.mjs';
import { createProjectCheckTool } from './src/tools/project-check.mjs';
import { createHealthProbeTool } from './src/tools/health-probe.mjs';
import { lossless } from './src/tools/common.mjs';
import { CheckpointStore } from './src/checkpoint/store.mjs';
import { installCheckpointHook } from './src/checkpoint/hook.mjs';

/** cordis 服务注入：注册工具需要 ctx.tools。 */
export const inject = ['tools'];

export const name = 'dsh-devkit';

/**
 * 统一把 execute 返回值净化成 lossless JSON。
 * 宿主对含 undefined 的返回值会直接报 “value is not lossless JSON”；
 * 在这里兜住比让每个工具各自记得清理更可靠。
 */
function withLosslessOutput(definition) {
    const original = definition.execute;
    return {
        ...definition,
        async execute(args, exec) {
            return lossless(await original.call(definition, args, exec));
        },
    };
}

export function createStore(config = {}) {
    const checkpoint = config?.checkpoint ?? {};
    return new CheckpointStore({
        maxEntries: checkpoint.maxEntries,
        maxFileBytes: checkpoint.maxFileBytes,
        root: checkpoint.root,
    });
}

/** 构建全部工具定义（导出以便测试与冒烟脚本直接调用）。 */
export function buildTools(config = {}) {
    const store = createStore(config);
    return [
        createEnvProbeTool(),
        createGitStatusTool(),
        createGitDiffTool(),
        createGitLogTool(),
        createGitCommitTool(),
        createFsCheckpointsTool(store),
        createFsRestoreTool(store),
        createProjectCheckTool(),
        createHealthProbeTool(),
    ].map(withLosslessOutput);
}

/**
 * 插件入口：注册工具并安装写入前快照钩子。
 * 任何单个工具或钩子失败只告警，不影响其它工具与宿主启动。
 */
export function apply(ctx, config) {
    const disposers = [];
    try {
        for (const definition of buildTools(config ?? {})) {
            try {
                disposers.push(ctx.tools.register(definition));
            } catch (error) {
                console.warn(`[dsh-devkit] 注册 ${definition.name} 失败：${error instanceof Error ? error.message : String(error)}`);
            }
        }
    } catch (error) {
        console.warn(`[dsh-devkit] 工具注册初始化失败：${error instanceof Error ? error.message : String(error)}`);
    }
    try {
        disposers.push(installCheckpointHook(ctx, createStore(config ?? {})));
    } catch (error) {
        console.warn(`[dsh-devkit] 写入前快照钩子安装失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof ctx.on === 'function') {
        ctx.on('dispose', () => {
            for (const dispose of disposers) {
                try {
                    if (typeof dispose === 'function') dispose();
                } catch {
                    // 卸载期错误不应影响宿主关闭流程。
                }
            }
        });
    }
}

export { probeEnvironment } from './src/env.mjs';
export { parseStatus, parseNumstat, parseLog } from './src/git.mjs';
export { assertInside, resolveRepo } from './src/repo.mjs';
export { CheckpointStore } from './src/checkpoint/store.mjs';
