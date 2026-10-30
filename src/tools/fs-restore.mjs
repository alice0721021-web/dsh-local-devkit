/**
 * `fs_restore` 工具定义：把文件回滚到某个快照，或直接回退上一次写入。
 *
 * @module dsh-devkit/tools/fs-restore
 */
import path from 'node:path';
import { asRecord, errorValue, shouldRethrow, resolveCwd, renderFailure, optionalString } from './common.mjs';

function render(_args, value) {
    if (value?.ok === false) return renderFailure(value);
    if (value.action === 'removed') {
        return [{ type: 'text', text: `已删除 ${value.path}（该文件在快照时尚未存在）\n恢复前的状态也已拍快照，可用 id 再回滚。` }];
    }
    const via = value.id ? `（快照 ${value.id}）` : '';
    return [{ type: 'text', text: `已恢复 ${value.path}${via}，${value.bytes} B\n恢复前的状态也已拍快照，可用 id 再回滚。` }];
}

export function createFsRestoreTool(store) {
    return {
        name: 'fs_restore',
        description: '回滚文件。给 path 时直接撤销该文件的上一次写入（连续调用会逐版回退，直到文件最初不存在）；给 id 时精确恢复到指定快照。恢复动作本身会先拍快照，因此仍可再回滚。',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '要回退的文件（绝对路径或相对 cwd）。与 id 二选一，优先 id。' },
                id: { type: 'string', description: '精确快照 id，来自 fs_checkpoints。' },
                cwd: { type: 'string', description: '项目目录，默认当前会话目录；必须与拍快照时一致。' },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    path: { type: 'string' },
                    action: { type: 'string' },
                    bytes: { type: 'integer' },
                    id: { type: 'string' },
                },
                additionalProperties: true,
            },
            render,
        },
        async execute(rawArgs, exec) {
            const args = asRecord(rawArgs);
            const id = optionalString(args, 'id');
            const target = optionalString(args, 'path');
            if (!id && !target) {
                return errorValue(Object.assign(new Error('需要提供 id 或 path'), { devkitCode: 'INVALID_ARGS' }));
            }
            try {
                const cwd = resolveCwd(args, exec);
                if (id) return await store.restore(id, { cwd });
                return await store.restoreLatest(path.resolve(cwd, target), { cwd });
            } catch (error) {
                if (shouldRethrow(error, exec?.signal)) throw error;
                return errorValue(error);
            }
        },
    };
}
