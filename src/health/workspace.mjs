/**
 * 工作区体积测量：用于判断快照类功能是否因超过上限而停用。
 *
 * 只做粗略统计（有预算上限、跳过依赖/构建目录），不追求与插件内部排除规则完全一致。
 *
 * @module dsh-devkit/health/workspace
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** 这些目录几乎总是依赖或产物，统计体积时跳过。 */
export const DEFAULT_SKIP = new Set([
    'node_modules',
    '.git',
    '.venv',
    'venv',
    '__pycache__',
    '.next',
    '.nuxt',
    'dist',
    'build',
    'target',
    'out',
    '.cache',
]);

/**
 * 统计一个目录的可快照体积。
 *
 * @param {string} root
 * @param {{budgetMs?: number, skip?: Set<string>}} [options]
 * @returns {Promise<{root: string, total: number, files: number, partial: boolean, topDirs: {name: string, bytes: number}[]}>}
 */
export async function measureWorkspace(root, options = {}) {
    const budgetMs = Number.isInteger(options.budgetMs) && options.budgetMs > 0 ? options.budgetMs : 1_500;
    const skip = options.skip ?? DEFAULT_SKIP;
    const deadline = Date.now() + budgetMs;
    const top = new Map();
    const stack = [{ dir: root, depth: 0, top: null }];
    let total = 0;
    let files = 0;
    let partial = false;

    while (stack.length > 0) {
        if (Date.now() > deadline) {
            partial = true;
            break;
        }
        const current = stack.pop();
        let entries;
        try {
            entries = await fs.readdir(current.dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (skip.has(entry.name)) continue;
            const full = path.join(current.dir, entry.name);
            if (entry.isDirectory()) {
                stack.push({
                    dir: full,
                    depth: current.depth + 1,
                    top: current.depth === 0 ? entry.name : current.top,
                });
            } else if (entry.isFile()) {
                try {
                    const stat = await fs.stat(full);
                    total += stat.size;
                    files += 1;
                    if (current.top) top.set(current.top, (top.get(current.top) ?? 0) + stat.size);
                } catch {
                    // 不可读文件跳过，不影响整体统计。
                }
            }
        }
    }

    const topDirs = [...top.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, bytes]) => ({ name, bytes }));

    return { root: path.resolve(root), total, files, partial, topDirs };
}
