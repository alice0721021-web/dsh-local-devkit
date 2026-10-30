/**
 * `env_probe` 工具定义。
 *
 * @module dsh-devkit/tools/env-probe
 */
import { probeEnvironment, renderProbe } from '../env.mjs';
import { asRecord, errorValue, shouldRethrow, renderFailure } from './common.mjs';

const checksSchema = {
    type: 'array',
    items: {
        type: 'object',
        properties: {
            id: { type: 'string' },
            ok: { type: 'boolean' },
            path: { type: 'string' },
            version: { type: 'string' },
            detail: { type: 'string' },
            fix: { type: 'string' },
            note: { type: 'string' },
        },
        additionalProperties: true,
    },
};

export function createEnvProbeTool() {
    return {
        name: 'env_probe',
        description: '探测本机执行环境：bash / pwsh / node / pnpm / git / python 是否可用，DSH_HOME 与 profile 是否可写，并对缺失项给出修复建议。排查“命令跑不起来”时优先调用；纯只读，不修改任何文件。',
        parameters: {
            type: 'object',
            properties: {
                detail: { type: 'boolean', description: '保留原始探测细节（默认精简输出）。' },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    okCount: { type: 'integer' },
                    failedCount: { type: 'integer' },
                    summary: { type: 'string' },
                    checks: checksSchema,
                },
                additionalProperties: true,
            },
            render: (_args, value) => (value?.ok === false && value?.code
                ? renderFailure(value)
                : renderProbe(value)),
        },
        async execute(rawArgs, exec) {
            const args = asRecord(rawArgs);
            try {
                const result = await probeEnvironment({ detail: args.detail === true, signal: exec?.signal });
                return { ok: result.failedCount === 0, ...result };
            } catch (error) {
                if (shouldRethrow(error, exec?.signal)) throw error;
                return errorValue(error);
            }
        },
    };
}
