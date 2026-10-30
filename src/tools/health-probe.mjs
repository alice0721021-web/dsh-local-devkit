/**
 * `health_probe` 工具定义：检查"功能是否还在产出"，而不只是"进程是否活着"。
 *
 * 背景：dsh-recall-plugin 在工作区超过 maxWorkspaceBytes 时会静默停用快照，
 * 进程与心跳都正常，只能靠 index.json 是否更新发现。这个工具把这类失效显式化。
 *
 * @module dsh-devkit/tools/health-probe
 */
import { readRecallStatus, readRecallExcludes } from '../health/recall.mjs';
import { readProfileStatus } from '../health/profile.mjs';
import { readCheckpointStatus } from '../health/checkpoints.mjs';
import { measureWorkspace, DEFAULT_SKIP } from '../health/workspace.mjs';
import { checkpointsRoot } from '../checkpoint/store.mjs';
import { asRecord, errorValue, shouldRethrow, resolveCwd, renderFailure, limitInt } from './common.mjs';

const DEFAULT_STALENESS_HOURS = 24;
const DEFAULT_WORKSPACE_LIMIT = 268_435_456;
const DEFAULT_SCAN_BUDGET_MS = 1_500;

function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '?';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function render(_args, value) {
    if (value?.ok === undefined && value?.code) return renderFailure(value);
    const lines = [`健康检查：${value.cwd}`];
    for (const check of value.checks ?? []) {
        const mark = check.ok ? 'ok  ' : 'FAIL';
        lines.push(`[${mark}] ${check.id}  ${check.detail ?? ''}`);
        if (check.lastActivity) lines.push(`        最后活动：${check.lastActivity}`);
        if (Array.isArray(check.topDirs) && check.topDirs.length > 0) {
            lines.push(`        最大目录：${check.topDirs.map((dir) => `${dir.name} ${formatBytes(dir.bytes)}`).join('，')}`);
        }
        if (check.fix) lines.push(`        修复：${check.fix}`);
    }
    const failed = (value.checks ?? []).filter((check) => check.ok === false).length;
    lines.push(failed === 0 ? '全部正常。' : `${failed} 项需要关注。`);
    return [{ type: 'text', text: lines.join('\n') }];
}

export function createHealthProbeTool() {
    return {
        name: 'health_probe',
        description: '检查 DSH 功能是否还在产出：recall 快照最后更新时间、工作区体积是否超过快照上限、profile bundles 是否装齐、本插件快照条数。排查“插件好像没反应”时优先调用；只读。',
        parameters: {
            type: 'object',
            properties: {
                cwd: { type: 'string', description: '工作区目录，默认当前会话目录。' },
                stalenessHours: { type: 'integer', description: `超过多少小时未产出视为停滞，默认 ${DEFAULT_STALENESS_HOURS}。` },
                workspaceLimitBytes: { type: 'integer', description: `工作区可快照体积上限，默认 ${DEFAULT_WORKSPACE_LIMIT}（recall 的默认值）。` },
                scanBudgetMs: { type: 'integer', description: `工作区体积扫描时间预算，默认 ${DEFAULT_SCAN_BUDGET_MS} ms。` },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    cwd: { type: 'string' },
                    checks: {
                        type: 'array',
                        items: {
                            // 只声明必然存在的字段；其余可能为 null/缺失，交给 additionalProperties。
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                ok: { type: 'boolean' },
                                status: { type: 'string' },
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
                const stalenessHours = limitInt(args.stalenessHours, 1, 720, DEFAULT_STALENESS_HOURS);
                const workspaceLimit = limitInt(args.workspaceLimitBytes, 1, 1_000_000_000_000, DEFAULT_WORKSPACE_LIMIT);
                const scanBudgetMs = limitInt(args.scanBudgetMs, 100, 10_000, DEFAULT_SCAN_BUDGET_MS);

                const [recall, recallExcludes, profile, checkpoints] = await Promise.all([
                    readRecallStatus(cwd),
                    readRecallExcludes(),
                    readProfileStatus(),
                    readCheckpointStatus(checkpointsRoot()),
                ]);
                const workspace = await measureWorkspace(cwd, {
                    budgetMs: scanBudgetMs,
                    // 把 recall 自己的排除表并进来，否则已排除的大目录会算成 over-limit。
                    skip: new Set([...DEFAULT_SKIP, ...recallExcludes]),
                });

                const now = Date.now();
                const checks = [];

                if (recall.installed !== true) {
                    checks.push({ id: 'recall', ok: true, status: 'not-installed', detail: '未安装 dsh-recall-plugin，跳过' });
                } else if (!recall.forCwd) {
                    checks.push({
                        id: 'recall',
                        ok: false,
                        status: 'no-snapshots',
                        detail: '当前工作区没有快照目录',
                        fix: '确认 recall 已启用，并在该工作区发过消息',
                    });
                } else {
                    const newest = recall.forCwd.newest;
                    const ageHours = typeof newest === 'number' ? (now - newest) / 3_600_000 : null;
                    const stalled = ageHours === null || ageHours > stalenessHours;
                    const ageText = ageHours === null ? '从未产出' : `${ageHours.toFixed(1)} 小时前`;
                    checks.push({
                        id: 'recall',
                        ok: !stalled,
                        status: stalled ? 'stalled' : 'ok',
                        entries: recall.forCwd.entries,
                        ...(typeof newest === 'number' ? { lastActivity: new Date(newest).toISOString() } : {}),
                        ...(ageHours === null ? {} : { ageHours: Math.round(ageHours * 10) / 10 }),
                        detail: stalled ? `快照停滞（${ageText}，${recall.forCwd.entries} 条）` : `快照正常（${ageText}，${recall.forCwd.entries} 条）`,
                        ...(stalled ? { fix: '工作区可能超过 maxWorkspaceBytes；在 dsh-recall-snapshots/exclude.txt 排除大目录' } : {}),
                    });
                }

                const overLimit = workspace.total > workspaceLimit;
                checks.push({
                    id: 'workspace',
                    ok: !overLimit,
                    status: overLimit ? 'over-limit' : 'ok',
                    bytes: workspace.total,
                    limitBytes: workspaceLimit,
                    files: workspace.files,
                    partial: workspace.partial,
                    topDirs: workspace.topDirs,
                    detail: overLimit
                        ? `可快照体积 ${formatBytes(workspace.total)} 超过上限 ${formatBytes(workspaceLimit)}`
                        : `可快照体积 ${formatBytes(workspace.total)}（上限 ${formatBytes(workspaceLimit)}）`,
                    ...(overLimit ? { fix: '把大目录移出工作区，或加入插件的 exclude 列表' } : {}),
                });

                checks.push({
                    id: 'checkpoints',
                    ok: true,
                    status: checkpoints.total > 0 ? 'ok' : 'empty',
                    total: checkpoints.total,
                    ...(checkpoints.newest === null ? {} : { lastActivity: new Date(checkpoints.newest).toISOString() }),
                    detail: checkpoints.total > 0 ? `本插件快照 ${checkpoints.total} 条` : '本插件暂无快照',
                });

                const bundleOk = profile.ok === true;
                checks.push({
                    id: 'profile',
                    ok: bundleOk,
                    status: bundleOk ? 'ok' : (profile.code ?? 'missing-bundles'),
                    bundles: profile.bundles ?? 0,
                    dependencies: profile.dependencies ?? 0,
                    missing: profile.missing ?? [],
                    patchMentionsDevkit: profile.patchMentionsDevkit === true,
                    detail: bundleOk
                        ? `${profile.bundles} 个 bundle 均已安装`
                        : `${(profile.missing ?? []).length} 个 bundle 未安装`,
                    ...(bundleOk ? {} : { fix: '在 profile 目录执行 pnpm install' }),
                });

                const failed = checks.filter((check) => check.ok === false);
                return {
                    ok: failed.length === 0,
                    cwd,
                    checks,
                };
            } catch (error) {
                if (shouldRethrow(error, exec?.signal)) throw error;
                return errorValue(error);
            }
        },
    };
}
