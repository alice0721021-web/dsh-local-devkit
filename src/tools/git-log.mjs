/**
 * `git_log` 工具定义。
 *
 * @module dsh-devkit/tools/git-log
 */
import { readLog } from '../git.mjs';
import { asRecord, errorValue, shouldRethrow, resolveCwd, renderFailure, limitInt } from './common.mjs';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function render(_args, value) {
    if (value?.ok === false) return renderFailure(value);
    const commits = Array.isArray(value.commits) ? value.commits : [];
    const lines = [`仓库：${value.repo}，返回 ${commits.length} 条提交`];
    if (commits.length === 0) lines.push('（还没有提交）');
    for (const item of commits) {
        const refs = Array.isArray(item.refs) && item.refs.length > 0 ? `  [${item.refs.join(', ')}]` : '';
        lines.push(`${item.short}  ${String(item.date ?? '').slice(0, 10)}  ${item.author}  ${item.subject}${refs}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
}

export function createGitLogTool() {
    return {
        name: 'git_log',
        description: '查看 git 提交历史：短 hash、作者、日期、标题与引用（分支/标签）。只读。',
        parameters: {
            type: 'object',
            properties: {
                cwd: { type: 'string', description: '工作目录，默认当前会话目录。' },
                limit: { type: 'integer', description: `返回条数 1-${MAX_LIMIT}，默认 ${DEFAULT_LIMIT}。` },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    repo: { type: 'string' },
                    commits: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                hash: { type: 'string' },
                                short: { type: 'string' },
                                author: { type: 'string' },
                                date: { type: 'string' },
                                subject: { type: 'string' },
                                refs: { type: 'array', items: { type: 'string' } },
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
                return await readLog(resolveCwd(args, exec), {
                    limit: limitInt(args.limit, 1, MAX_LIMIT, DEFAULT_LIMIT),
                    signal: exec?.signal,
                });
            } catch (error) {
                if (shouldRethrow(error, exec?.signal)) throw error;
                return errorValue(error);
            }
        },
    };
}
