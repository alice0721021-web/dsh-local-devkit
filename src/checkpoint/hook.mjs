/**
 * 写入前自动快照：挂到 tools/execute waterfall，拦截 write / edit 等写文件工具。
 *
 * 失败绝不阻断工具执行——快照是增强，不是门禁。
 *
 * @module dsh-devkit/checkpoint/hook
 */
import path from 'node:path';

/** 内置与常见写文件工具名。 */
const WRITE_TOOL = /^(fs_)?(write|edit)$/i;
const EXTRA_WRITE_TOOLS = new Set(['multi_edit', 'apply_patch', 'notebook_edit']);

export function isWriteTool(name) {
    return typeof name === 'string' && (WRITE_TOOL.test(name) || EXTRA_WRITE_TOOLS.has(name));
}

/** 从工具参数里取出目标文件路径。 */
export function resolveWriteTarget(exec) {
    if (!isWriteTool(exec?.name)) return null;
    const args = exec?.arguments ?? {};
    for (const candidate of [args.file_path, args.path, args.filePath]) {
        if (typeof candidate === 'string' && candidate.trim() !== '') return path.resolve(candidate);
    }
    return null;
}

export function resolveCwd(exec) {
    const fromSession = exec?.agent?.session?.header?.cwd;
    if (typeof fromSession === 'string' && fromSession !== '') return path.resolve(fromSession);
    return process.cwd();
}

/**
 * 在工具链上安装快照钩子。
 *
 * @param {object} ctx 插件上下文
 * @param {{capture: Function}} store
 * @returns {() => void} 卸载函数
 */
export function installCheckpointHook(ctx, store) {
    if (typeof ctx?.on !== 'function') {
        console.warn('[dsh-devkit] ctx.on 不可用，跳过写入前快照');
        return () => {};
    }
    const handler = async (exec, next) => {
        try {
            const target = resolveWriteTarget(exec);
            if (target) {
                await store.capture({ path: target, tool: String(exec.name), cwd: resolveCwd(exec) });
            }
        } catch (error) {
            console.warn(`[dsh-devkit] 写入前快照失败：${error instanceof Error ? error.message : String(error)}`);
        }
        return next();
    };
    const dispose = ctx.on('tools/execute', handler);
    return typeof dispose === 'function' ? dispose : () => {};
}
