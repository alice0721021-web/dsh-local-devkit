/**
 * `git_diff` 工具定义。
 *
 * @module dsh-devkit/tools/git-diff
 */
import { readDiff } from '../git.mjs';
import { asRecord, errorValue, shouldRethrow, resolveCwd, renderFailure, stringArray, limitInt } from './common.mjs';

const DEFAULT_MAX_BYTES = 65_536;
const HARD_MAX_BYTES = 1_048_576;

function render(_args, value) {
    if (value?.ok === false) return renderFailure(value);
    const lines = [];
    lines.push(`仓库：${value.repo}${value.staged ? '（暂存区 vs HEAD）' : '（工作区 vs 暂存区）'}`);
    const files = Array.isArray(value.files) ? value.files : [];
    if (files.length === 0) {
        lines.push('无差异。');
    } else {
        lines.push(`变更文件（${files.length}）：`);
        for (const file of files.slice(0, 100)) {
            const counts = file.binary ? 'binary' : `+${file.added ?? 0}/-${file.removed ?? 0}`;
            lines.push(`  - ${file.path}  ${counts}`);
        }
        if (files.length > 100) lines.push(`  … 其余 ${files.length - 100} 个文件省略`);
    }
    if (value.patch) {
        lines.push('', value.patch);
    }
    if (value.truncated) lines.push('', `注意：${value.hint ?? 'diff 已截断'}`);
    return [{ type: 'text', text: lines.join('\n') }];
}

export function createGitDiffTool() {
    return {
        name: 'git_diff',
        description: '查看 git 差异：默认工作区 vs 暂存区，staged=true 时看暂存区 vs HEAD；可按路径过滤、只看 --stat 汇总。输出超过 maxBytes 时截断并标记。只读。',
        parameters: {
            type: 'object',
            properties: {
                cwd: { type: 'string', description: '工作目录，默认当前会话目录。' },
                staged: { type: 'boolean', description: '为 true 时查看暂存区（git diff --cached）。' },
                paths: { type: 'array', items: { type: 'string' }, description: '只查看这些路径（相对仓库根或绝对路径）。' },
                stat: { type: 'boolean', description: '为 true 时只返回 --numstat 统计，不返回正文。' },
                maxBytes: { type: 'integer', description: `diff 正文上限字节数，默认 ${DEFAULT_MAX_BYTES}，最大 ${HARD_MAX_BYTES}。` },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    repo: { type: 'string' },
                    staged: { type: 'boolean' },
                    files: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                path: { type: 'string' },
                                // added / removed 对二进制文件为 null，不声明具体类型。
                                binary: { type: 'boolean' },
                            },
                            additionalProperties: true,
                        },
                    },
                    patch: { type: 'string' },
                    truncated: { type: 'boolean' },
                    hint: { type: 'string' },
                },
                additionalProperties: true,
            },
            render,
        },
        async execute(rawArgs, exec) {
            const args = asRecord(rawArgs);
            try {
                return await readDiff(resolveCwd(args, exec), {
                    staged: args.staged === true,
                    paths: stringArray(args, 'paths'),
                    stat: args.stat === true,
                    maxBytes: limitInt(args.maxBytes, 1_024, HARD_MAX_BYTES, DEFAULT_MAX_BYTES),
                    signal: exec?.signal,
                });
            } catch (error) {
                if (shouldRethrow(error, exec?.signal)) throw error;
                return errorValue(error);
            }
        },
    };
}
