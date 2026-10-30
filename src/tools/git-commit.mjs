/**
 * `git_commit` 工具定义。
 *
 * @module dsh-devkit/tools/git-commit
 */
import { commit } from '../git.mjs';
import { asRecord, errorValue, shouldRethrow, resolveCwd, renderFailure, stringArray, optionalString } from './common.mjs';

function render(_args, value) {
    if (value?.ok === false) {
        if (value.code === 'NOTHING_TO_COMMIT') {
            return [{ type: 'text', text: '没有可提交的变更：暂存区为空（可先用 paths 指定文件，或先 git add）。' }];
        }
        return renderFailure(value);
    }
    const lines = [];
    if (value.dryRun) {
        lines.push('提交预览（dry-run，未修改任何内容）');
        lines.push(`仓库：${value.repo}`);
        lines.push(`message：${value.message}`);
        if (Array.isArray(value.wouldAdd) && value.wouldAdd.length > 0) {
            lines.push(`将执行 git add：${value.wouldAdd.join(', ')}`);
        }
        if (Array.isArray(value.staged) && value.staged.length > 0) {
            lines.push('当前已暂存：', ...value.staged.map((line) => `  ${line}`));
        } else {
            lines.push('当前已暂存：（空——dry-run 不会执行 git add）');
        }
        return [{ type: 'text', text: lines.join('\n') }];
    }
    lines.push(`已提交 ${value.commit?.short ?? '(unknown)'}`);
    const files = Array.isArray(value.files) ? value.files : [];
    lines.push(`涉及 ${files.length} 个文件：`, ...files.map((line) => `  ${line}`));
    return [{ type: 'text', text: lines.join('\n') }];
}

export function createGitCommitTool() {
    return {
        name: 'git_commit',
        description: '提交变更：可先 git add 指定 paths 再 commit，message 必填。dryRun=true 时只预览不写入。不提供 --amend / --force / --no-verify 等危险参数；非 git 目录返回 NO_REPO，无变更返回 NOTHING_TO_COMMIT。',
        parameters: {
            type: 'object',
            properties: {
                cwd: { type: 'string', description: '工作目录，默认当前会话目录。' },
                message: { type: 'string', description: '提交说明，必填且不能为空。' },
                paths: { type: 'array', items: { type: 'string' }, description: '先 git add 这些路径再提交；省略则只提交已暂存内容。路径必须位于仓库内。' },
                dryRun: { type: 'boolean', description: '为 true 时只预览，不执行 add / commit。' },
            },
            required: ['message'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    repo: { type: 'string' },
                    dryRun: { type: 'boolean' },
                    message: { type: 'string' },
                    wouldAdd: { type: 'array', items: { type: 'string' } },
                    staged: { type: 'array', items: { type: 'string' } },
                    // short 取自 rev-parse，异常情况下可能为 null，不声明具体字段。
                    commit: { type: 'object', additionalProperties: true },
                    files: { type: 'array', items: { type: 'string' } },
                },
                additionalProperties: true,
            },
            render,
        },
        async execute(rawArgs, exec) {
            const args = asRecord(rawArgs);
            const message = optionalString(args, 'message');
            if (!message) return errorValue(Object.assign(new Error('message 不能为空'), { devkitCode: 'INVALID_ARGS' }));
            try {
                return await commit(resolveCwd(args, exec), {
                    message,
                    paths: stringArray(args, 'paths'),
                    dryRun: args.dryRun === true,
                    signal: exec?.signal,
                });
            } catch (error) {
                if (shouldRethrow(error, exec?.signal)) throw error;
                return errorValue(error);
            }
        },
    };
}
