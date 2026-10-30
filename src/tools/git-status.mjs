/**
 * `git_status` 工具定义。
 *
 * @module dsh-devkit/tools/git-status
 */
import { readStatus } from '../git.mjs';
import { asRecord, errorValue, shouldRethrow, resolveCwd, renderFailure } from './common.mjs';

const entrySchema = {
    type: 'object',
    properties: {
        path: { type: 'string' },
        status: { type: 'string' },
        origPath: { type: 'string' },
        xy: { type: 'string' },
    },
    additionalProperties: true,
};

function render(_args, value) {
    if (value?.ok === false) return renderFailure(value);
    const lines = [];
    lines.push(`仓库：${value.repo}`);
    const tracking = value.upstream ? ` → ${value.upstream}` : '';
    const divergence = value.ahead || value.behind ? `（ahead ${value.ahead}，behind ${value.behind}）` : '';
    lines.push(`分支：${value.branch ?? '(detached)'}${tracking}${divergence}`);
    const section = (title, list) => {
        if (!Array.isArray(list) || list.length === 0) return;
        lines.push(`${title}（${list.length}）：`);
        for (const item of list.slice(0, 100)) {
            lines.push(`  - ${item.status ?? 'untracked'} ${item.path}${item.origPath ? ` ← ${item.origPath}` : ''}`);
        }
        if (list.length > 100) lines.push(`  … 其余 ${list.length - 100} 项省略`);
    };
    section('已暂存', value.staged);
    section('未暂存', value.unstaged);
    section('未跟踪', value.untracked);
    section('冲突', value.conflicted);
    const total = ['staged', 'unstaged', 'untracked', 'conflicted']
        .reduce((sum, key) => sum + (Array.isArray(value[key]) ? value[key].length : 0), 0);
    if (total === 0) lines.push('工作区干净。');
    return [{ type: 'text', text: lines.join('\n') }];
}

export function createGitStatusTool() {
    return {
        name: 'git_status',
        description: '查看 git 仓库状态：分支、上游、ahead/behind、已暂存 / 未暂存 / 未跟踪 / 冲突文件。只读，不修改仓库。非 git 目录返回 NO_REPO。',
        parameters: {
            type: 'object',
            properties: {
                cwd: { type: 'string', description: '工作目录，默认当前会话目录。' },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    repo: { type: 'string' },
                    // branch / upstream 在 detached HEAD 或无上游时为 null，
                    // 不声明具体类型，避免被宿主的输出校验拒绝。
                    ahead: { type: 'integer' },
                    behind: { type: 'integer' },
                    staged: { type: 'array', items: entrySchema },
                    unstaged: { type: 'array', items: entrySchema },
                    untracked: { type: 'array', items: entrySchema },
                    conflicted: { type: 'array', items: entrySchema },
                },
                additionalProperties: true,
            },
            render,
        },
        async execute(rawArgs, exec) {
            const args = asRecord(rawArgs);
            try {
                return await readStatus(resolveCwd(args, exec), exec?.signal);
            } catch (error) {
                if (shouldRethrow(error, exec?.signal)) throw error;
                return errorValue(error);
            }
        },
    };
}
