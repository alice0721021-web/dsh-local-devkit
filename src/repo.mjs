/**
 * git 仓库定位与路径越界校验。
 *
 * @module dsh-devkit/repo
 */
import path from 'node:path';
import { runCommand, devkitError } from './exec.mjs';

/** Windows 路径大小写不敏感，比较前统一小写。 */
export function normalise(target) {
    const resolved = path.resolve(target);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * 找到 cwd 所在的 git 工作树根；不是仓库时返回 null。
 *
 * @param {string} cwd
 * @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
 * @returns {Promise<string|null>}
 */
export async function resolveRepo(cwd, options = {}) {
    const result = await runCommand('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 10_000,
    });
    if (result.code !== 0) return null;
    const top = result.stdout.trim();
    return top ? path.resolve(top) : null;
}

/**
 * 把相对路径解析到仓库根内的绝对路径；越界时抛 PATH_OUTSIDE_REPO。
 *
 * @param {string} toplevel 仓库根（绝对路径）
 * @param {string} target 用户提供的路径（相对仓库根，或绝对路径）
 * @returns {string} 绝对路径
 */
export function assertInside(toplevel, target) {
    const base = normalise(toplevel);
    const absolute = path.resolve(toplevel, target);
    const normalised = normalise(absolute);
    if (normalised === base) return absolute;
    const relative = path.relative(base, normalised);
    if (relative === '' ) return absolute;
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw devkitError('PATH_OUTSIDE_REPO', `路径越界，拒绝操作仓库外的文件：${target}`);
    }
    return absolute;
}

/** 把仓库内绝对路径转回相对仓库根的 posix 路径，便于展示与传参。 */
export function toRepoPath(toplevel, absolute) {
    return path.relative(toplevel, absolute).split(path.sep).join('/');
}
