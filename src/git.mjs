/**
 * git 子命令封装与输出解析（porcelain v2 / numstat / log 记录分隔）。
 *
 * @module dsh-devkit/git
 */
import path from 'node:path';
import { runCommand, devkitError, failureFrom } from './exec.mjs';
import { resolveRepo, assertInside, toRepoPath } from './repo.mjs';

const STATUS_TEXT = {
    M: 'modified',
    A: 'added',
    D: 'deleted',
    R: 'renamed',
    C: 'copied',
    T: 'typechange',
    U: 'unmerged',
};

function statusOf(char) {
    return STATUS_TEXT[char] ?? null;
}

/** 解析 `git status --porcelain=v2 --branch` 输出。 */
export function parseStatus(stdout) {
    const result = {
        oid: null,
        branch: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: [],
    };
    for (const raw of stdout.split(/\r?\n/)) {
        const line = raw.trimEnd();
        if (!line) continue;
        if (line.startsWith('# branch.oid ')) {
            result.oid = line.slice('# branch.oid '.length).trim();
            continue;
        }
        if (line.startsWith('# branch.head ')) {
            result.branch = line.slice('# branch.head '.length).trim();
            continue;
        }
        if (line.startsWith('# branch.upstream ')) {
            result.upstream = line.slice('# branch.upstream '.length).trim();
            continue;
        }
        if (line.startsWith('# branch.ab ')) {
            const match = line.match(/\+(\d+)\s+-(\d+)/);
            if (match) {
                result.ahead = Number(match[1]);
                result.behind = Number(match[2]);
            }
            continue;
        }
        if (line.startsWith('? ')) {
            result.untracked.push({ path: line.slice(2) });
            continue;
        }
        const tabParts = line.split('\t');
        const fields = tabParts[0].split(' ');
        const kind = fields[0];
        if (kind === 'u') {
            result.conflicted.push({
                path: fields.slice(10).join(' '),
                xy: fields[1],
                status: 'conflicted',
            });
            continue;
        }
        if (kind !== '1' && kind !== '2') continue;
        const xy = fields[1] ?? '..';
        const filePath = kind === '1' ? fields.slice(8).join(' ') : fields.slice(9).join(' ');
        const entry = { path: filePath };
        if (kind === '2' && tabParts[1]) entry.origPath = tabParts[1];
        const indexStatus = statusOf(xy[0]);
        const worktreeStatus = statusOf(xy[1]);
        if (indexStatus) result.staged.push({ ...entry, status: indexStatus });
        if (worktreeStatus) result.unstaged.push({ ...entry, status: worktreeStatus });
    }
    return result;
}

/** 解析 `git diff --numstat`。 */
export function parseNumstat(stdout) {
    const files = [];
    for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const [addedRaw, removedRaw] = parts;
        const filePath = parts.slice(2).join('\t');
        files.push({
            path: filePath,
            added: addedRaw === '-' ? null : Number(addedRaw),
            removed: removedRaw === '-' ? null : Number(removedRaw),
            binary: addedRaw === '-',
        });
    }
    return files;
}

/** 解析 `git log --pretty=format:%H%x00%h%x00%an%x00%aI%x00%s%x00%D%x1e`。 */
export function parseLog(stdout) {
    return stdout
        .split('\x1e')
        .map((chunk) => chunk.replace(/^\r?\n/, ''))
        .filter((chunk) => chunk.trim())
        .map((chunk) => {
            const [hash, short, author, date, subject, refs] = chunk.split('\x00');
            return {
                hash,
                short,
                author,
                date,
                subject,
                refs: (refs ?? '').split(',').map((item) => item.trim()).filter(Boolean),
            };
        });
}

/**
 * 解析仓库并返回根目录；不是仓库时返回 null。
 * @returns {Promise<string|null>}
 */
export async function openRepo(cwd, signal) {
    return resolveRepo(cwd, { signal });
}

/** `git_status` 的领域实现。 */
export async function readStatus(cwd, signal) {
    const repo = await openRepo(cwd, signal);
    if (!repo) return { ok: false, code: 'NO_REPO', cwd };
    const result = await runCommand('git', ['-C', repo, 'status', '--porcelain=v2', '--branch', '--untracked-files=all'], { signal });
    if (result.code !== 0) throw failureFrom(result, 'git status');
    return { ok: true, repo, ...parseStatus(result.stdout) };
}

/** `git_diff` 的领域实现。 */
export async function readDiff(cwd, options = {}) {
    const { staged = false, paths = [], stat = false, maxBytes = 65_536, signal } = options;
    const repo = await openRepo(cwd, signal);
    if (!repo) return { ok: false, code: 'NO_REPO', cwd };
    const relativePaths = paths.length > 0
        ? paths.map((item) => toRepoPath(repo, assertInside(repo, item)))
        : [];
    const scopeArgs = relativePaths.length > 0 ? ['--', ...relativePaths] : [];
    const base = ['-C', repo, 'diff'];
    if (staged) base.push('--cached');

    const numstat = await runCommand('git', [...base, '--numstat', ...scopeArgs], { signal });
    if (numstat.code !== 0) throw failureFrom(numstat, 'git diff --numstat');
    const files = parseNumstat(numstat.stdout);

    if (stat) {
        return { ok: true, repo, staged, files, patch: '', truncated: false };
    }
    const patchResult = await runCommand('git', [...base, ...scopeArgs], { signal, maxBuffer: Math.max(maxBytes * 4, 1_000_000) });
    if (patchResult.code !== 0) throw failureFrom(patchResult, 'git diff');
    const patch = patchResult.stdout;
    const truncated = Buffer.byteLength(patch, 'utf8') > maxBytes;
    return {
        ok: true,
        repo,
        staged,
        files,
        patch: truncated ? patch.slice(0, maxBytes) : patch,
        truncated,
        ...(truncated ? { hint: 'diff 超出 maxBytes，按路径过滤或调大 maxBytes（上限 1MB）' } : {}),
    };
}

/** `git_log` 的领域实现。 */
export async function readLog(cwd, options = {}) {
    const { limit = 20, signal } = options;
    const repo = await openRepo(cwd, signal);
    if (!repo) return { ok: false, code: 'NO_REPO', cwd };
    const result = await runCommand('git', [
        '-C', repo, 'log',
        '-n', String(limit),
        '--pretty=format:%H%x00%h%x00%an%x00%aI%x00%s%x00%D%x1e',
    ], { signal });
    if (result.code !== 0) {
        if (/does not have any commits yet/i.test(result.stderr)) { return { ok: true, repo, commits: [] }; }
        throw failureFrom(result, 'git log');
    }
    return { ok: true, repo, commits: parseLog(result.stdout) };
}

/** `git_commit` 的领域实现。 */
export async function commit(cwd, options = {}) {
    const { message, paths = [], dryRun = false, signal } = options;
    if (typeof message !== 'string' || message.trim() === '') {
        throw devkitError('INVALID_ARGS', 'message 不能为空');
    }
    const repo = await openRepo(cwd, signal);
    if (!repo) return { ok: false, code: 'NO_REPO', cwd };
    const relativePaths = paths.map((item) => toRepoPath(repo, assertInside(repo, item)));

    if (dryRun) {
        const cached = await runCommand('git', ['-C', repo, 'diff', '--cached', '--name-status'], { signal });
        const pending = await runCommand('git', ['-C', repo, 'status', '--porcelain=v2'], { signal });
        return {
            ok: true,
            repo,
            dryRun: true,
            message,
            wouldAdd: relativePaths,
            staged: cached.code === 0 ? cached.stdout.trim().split(/\r?\n/).filter(Boolean) : [],
            pending: pending.code === 0 ? parseStatus(pending.stdout) : null,
        };
    }

    if (relativePaths.length > 0) {
        const add = await runCommand('git', ['-C', repo, 'add', '--', ...relativePaths], { signal });
        if (add.code !== 0) throw failureFrom(add, 'git add');
    }
    const staged = await runCommand('git', ['-C', repo, 'diff', '--cached', '--name-status'], { signal });
    if (staged.code !== 0) throw failureFrom(staged, 'git diff --cached');
    if (!staged.stdout.trim()) {
        return { ok: false, code: 'NOTHING_TO_COMMIT', repo, message };
    }
    const result = await runCommand('git', ['-C', repo, 'commit', '-m', message], { signal });
    if (result.code !== 0) throw failureFrom(result, 'git commit');
    const head = await runCommand('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { signal });
    return {
        ok: true,
        repo,
        dryRun: false,
        commit: { short: head.code === 0 ? head.stdout.trim() : null },
        files: staged.stdout.trim().split(/\r?\n/).filter(Boolean),
    };
}

export { toRepoPath };
