/**
 * `fs_checkpoints` 工具定义：列出写入前快照。
 *
 * @module dsh-devkit/tools/fs-checkpoints
 */
import path from 'node:path';
import { asRecord, errorValue, shouldRethrow, resolveCwd, renderFailure, limitInt, optionalString } from './common.mjs';

function render(_args, value) {
    if (value?.ok === false) return renderFailure(value);
    const lines = [`项目：${value.project}，快照 ${value.total} 条`];
    if (value.total === 0) {
        lines.push('（暂无快照；write / edit 落盘前会自动记录，也可以先手动改一个文件试试）');
    }
    for (const item of value.checkpoints ?? []) {
        const note = item.skipped ? `  [跳过：${item.skipped}]` : item.existed === false ? '  [此前不存在]' : `  ${item.size} B`;
        const flags = [
            item.reason === 'pre-restore' ? '恢复前' : null,
            item.consumed === true ? '已回退' : null,
        ].filter(Boolean);
        lines.push(`- ${item.id}  ${item.createdAt}  ${item.tool}  ${item.path}${note}${flags.length > 0 ? `  [${flags.join('，')}]` : ''}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
}

export function createFsCheckpointsTool(store) {
    return {
        name: 'fs_checkpoints',
        description: '列出当前项目最近的文件写入快照。每次 write / edit 落盘前会自动保存原内容；可用 path 只看某个文件，用 fs_restore 回滚。',
        parameters: {
            type: 'object',
            properties: {
                cwd: { type: 'string', description: '项目目录，默认当前会话目录。' },
                path: { type: 'string', description: '只看这个文件的快照（绝对路径或相对 cwd）。' },
                limit: { type: 'integer', description: '返回条数 1-200，默认 20。' },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    project: { type: 'string' },
                    total: { type: 'integer' },
                    checkpoints: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                path: { type: 'string' },
                                tool: { type: 'string' },
                                createdAt: { type: 'string' },
                                size: { type: 'integer' },
                                existed: { type: 'boolean' },
                                reason: { type: 'string' },
                            },
                            additionalProperties: true,
                        },
                    },
                },
                additionalProperties: true,
            },
            render,
        },
        async execute(rawArgs, exec) {
            const args = asRecord(rawArgs);
            try {
                const cwd = resolveCwd(args, exec);
                const explicit = optionalString(args, 'path');
                const target = explicit ? path.resolve(cwd, explicit) : undefined;
                const entries = await store.list({
                    cwd,
                    path: target,
                    limit: limitInt(args.limit, 1, 200, 20),
                });
                return { ok: true, project: cwd, total: entries.length, checkpoints: entries };
            } catch (error) {
                if (shouldRethrow(error, exec?.signal)) throw error;
                return errorValue(error);
            }
        },
    };
}
