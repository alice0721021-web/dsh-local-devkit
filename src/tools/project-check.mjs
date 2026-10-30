/**
 * `project_check` 工具定义：跑项目的检查脚本（typecheck / lint / test / build）并结构化返回。
 *
 * @module dsh-devkit/tools/project-check
 */
import { detectProject } from '../project/detect.mjs';
import { runTarget } from '../project/run.mjs';
import { asRecord, errorValue, shouldRethrow, resolveCwd, renderFailure, limitInt, optionalString } from './common.mjs';

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 600_000;

function render(_args, value) {
    if (value?.ok === false && value?.code) {
        if (value.code === 'NO_TARGET') {
            return [{ type: 'text', text: `没有找到可运行的 ${value.target} 目标。可用目标：${(value.available ?? []).join(', ') || '(无)'}\n项目已提供的标记：${(value.availableScripts ?? []).join(', ') || '(无)'}` }];
        }
        return renderFailure(value);
    }
    const lines = [`项目：${value.project}（${value.kind ?? '?'} / ${value.manager}，runner=${value.runner ?? 'unknown'}）`];
    if (value.dryRun) {
        lines.push('dry-run：只会执行以下命令，未真正运行');
        for (const item of value.plan ?? []) lines.push(`- ${item.target}: ${item.command}`);
        return [{ type: 'text', text: lines.join('\n') }];
    }
    for (const result of value.results ?? []) {
        const mark = result.ok ? 'ok  ' : 'FAIL';
        lines.push(`[${mark}] ${result.target}  <${result.command}>  ${result.durationMs}ms${result.exitCode !== undefined ? `  exit ${result.exitCode}` : ''}`);
        for (const failure of result.failures ?? []) lines.push(`        ${failure}`);
        if (!result.ok && result.error) lines.push(`        ${result.error}`);
    }
    const failed = (value.results ?? []).filter((result) => !result.ok).length;
    lines.push(failed === 0 ? '全部通过。' : `${failed} 个目标失败，已停止后续目标。`);
    return [{ type: 'text', text: lines.join('\n') }];
}

export function createProjectCheckTool() {
    return {
        name: 'project_check',
        description: '跑项目自带的检查：自动探测 Node（package.json scripts）、Python（pytest / ruff / mypy）与 Go（go test）三类项目，用项目自己的工具链执行并按顺序返回结构化结果。dryRun 只列出会跑什么。只运行项目已声明的检查，不接受自定义命令。',
        parameters: {
            type: 'object',
            properties: {
                cwd: { type: 'string', description: '项目目录，默认当前会话目录。' },
                target: { type: 'string', enum: ['all', 'typecheck', 'lint', 'test', 'build'], description: '只跑某个目标，默认 all（按 typecheck → lint → test → build 顺序，失败即停）。' },
                dryRun: { type: 'boolean', description: '为 true 时只列出将执行的命令，不真正运行。' },
                timeoutMs: { type: 'integer', description: `每个目标的超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}。` },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    dryRun: { type: 'boolean' },
                    project: { type: 'string' },
                    kind: { type: 'string' },
                    manager: { type: 'string' },
                    runner: { type: 'string' },
                    plan: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: { target: { type: 'string' }, script: { type: 'string' }, command: { type: 'string' } },
                            additionalProperties: true,
                        },
                    },
                    results: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                target: { type: 'string' },
                                script: { type: 'string' },
                                command: { type: 'string' },
                                ok: { type: 'boolean' },
                                exitCode: { type: 'integer' },
                                durationMs: { type: 'integer' },
                                truncated: { type: 'boolean' },
                                output: { type: 'string' },
                                failures: { type: 'array', items: { type: 'string' } },
                            },
                            additionalProperties: true,
                        },
                    },
                    code: { type: 'string' },
                    target: { type: 'string' },
                    available: { type: 'array', items: { type: 'string' } },
                    availableScripts: { type: 'array', items: { type: 'string' } },
                },
                additionalProperties: true,
            },
            render,
        },
        async execute(rawArgs, exec) {
            const args = asRecord(rawArgs);
            try {
                const detected = await detectProject(resolveCwd(args, exec));
                if (detected.ok !== true) return detected;

                const base = {
                    ok: false,
                    dryRun: false,
                    project: detected.dir,
                    kind: detected.kind ?? 'unknown',
                    manager: detected.manager,
                    runner: detected.runner?.source ?? 'missing',
                };

                if (!detected.runner) {
                    return { ...base, code: 'MANAGER_MISSING', error: `找不到可用的 ${detected.manager}；把它放进 PATH 或改用内置包管理器` };
                }

                const wanted = optionalString(args, 'target') ?? 'all';
                const selected = wanted === 'all'
                    ? detected.targets
                    : detected.targets.filter((item) => item.target === wanted);

                if (selected.length === 0) {
                    return {
                        ...base,
                        code: 'NO_TARGET',
                        target: wanted,
                        available: detected.targets.map((item) => item.target),
                        availableScripts: detected.availableScripts,
                    };
                }

                const plan = selected.map((item) => ({ target: item.target, script: item.script, command: item.command }));
                if (args.dryRun === true) return { ...base, ok: true, dryRun: true, plan };

                const timeoutMs = limitInt(args.timeoutMs, 1_000, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
                const results = [];
                for (const target of selected) {
                    const result = await runTarget(target, detected.runner, {
                        cwd: detected.dir,
                        timeoutMs,
                        signal: exec?.signal,
                    });
                    results.push(result);
                    if (!result.ok) break;
                }
                return {
                    ...base,
                    ok: results.every((result) => result.ok),
                    plan,
                    results,
                };
            } catch (error) {
                if (shouldRethrow(error, exec?.signal)) throw error;
                return errorValue(error);
            }
        },
    };
}
