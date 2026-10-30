/**
 * 本机执行环境探测：shell / node / pnpm / git / python 与 DSH profile 可写性。
 *
 * 只做只读检查，不修改任何文件或配置。
 *
 * @module dsh-devkit/env
 */
import { existsSync } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from './exec.mjs';

/** DSH 主运行时依赖目录（bundled node / pnpm / python）。 */
export function runtimeDependencies() {
    return path.join(dshHome(), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies');
}

export function dshHome() {
    return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function profileDir(name = process.env.DSH_PROFILE || 'desktop') {
    return path.join(dshHome(), 'profiles', name);
}

/**
 * 真正的 node 可执行文件。
 *
 * DSH 桌面版主进程是 Electron，`process.execPath` 指向 “DeepSeek Harness.exe”，
 * 直接把它当 node 用（或把它所在目录塞进 PATH）都不会让 `node` 变得可调用。
 * 必须回落到内置运行时里的 node。
 */
export function nodeBinary() {
    const bundled = [
        path.join(runtimeDependencies(), 'node', 'bin', 'node.exe'),
        path.join(runtimeDependencies(), 'node', 'bin', 'node'),
    ];
    for (const candidate of bundled) {
        if (existsSync(candidate)) return candidate;
    }
    const base = path.basename(process.execPath).toLowerCase();
    if (base === 'node' || base === 'node.exe') return process.execPath;
    return 'node';
}

/** 当前 DSH 用于 ops_bash 的 bash payload 候选路径。 */
function bashCandidates() {
    const list = [
        path.join(profileDir(), 'node_modules', '@dsh-ops', 'bash-win32-x64', 'bin', 'bash.exe'),
        path.join(profileDir(), 'node_modules', '@dsh-ops', 'bash-win32-x64', 'bin', 'bash'),
    ];
    const seen = new Set(list.map((item) => item.toLowerCase()));
    for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
        if (!entry) continue;
        for (const bin of process.platform === 'win32' ? ['bash.exe', 'bash.cmd'] : ['bash']) {
            const candidate = path.join(entry, bin);
            if (!seen.has(candidate.toLowerCase())) {
                seen.add(candidate.toLowerCase());
                list.push(candidate);
            }
        }
    }
    return list;
}

/** 探测单个可执行文件：存在性 + 版本。 */
async function probeBinary(id, bin, args, fix, signal) {
    if (!bin) {
        return { id, ok: false, fix };
    }
    try {
        const result = await runCommand(bin, args, { timeoutMs: 8_000, signal });
        const text = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/)[0] ?? '';
        if (result.code !== 0) {
            return { id, ok: false, path: bin, detail: `exit ${result.code}`, fix };
        }
        return { id, ok: true, path: bin, version: text.slice(0, 120) };
    } catch (error) {
        const code = error?.devkitCode;
        if (code === 'BINARY_MISSING') {
            return { id, ok: false, fix };
        }
        return { id, ok: false, path: bin, detail: error instanceof Error ? error.message : String(error), fix };
    }
}

/** 在 PATH 中按文件名查找第一个存在的可执行文件。 */
function findOnPath(names) {
    const entries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    for (const entry of entries) {
        for (const name of names) {
            const candidate = path.join(entry, name);
            if (existsSync(candidate)) return candidate;
        }
    }
    return null;
}

/** 第一个存在的路径；都不存在时返回 null。 */
function firstExisting(candidates) {
    for (const candidate of candidates) {
        if (candidate && existsSync(candidate)) return candidate;
    }
    return null;
}

/**
 * 执行全部探测。
 *
 * @param {{detail?: boolean, signal?: AbortSignal}} [options]
 * @returns {Promise<{checks: object[], okCount: number, failedCount: number, summary: string}>}
 */
export async function probeEnvironment(options = {}) {
    const { signal } = options;
    const checks = [];

    const bash = firstExisting(bashCandidates());
    checks.push({
        id: 'bash',
        ok: Boolean(bash),
        ...(bash ? { path: bash } : {}),
        fix: '运行 dsh-ops provision-shells --bash 重新获取内置 bash',
        note: bash ? undefined : 'ops_bash 会因缺少 bash 后端而全部失败',
    });

    checks.push(await probeBinary(
        'pwsh',
        findOnPath(['powershell.exe', 'pwsh.exe']),
        ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'],
        'terminal 依赖 PowerShell 后端；Windows 通常自带',
        signal,
    ));

    const nodeBin = nodeBinary();
    checks.push({
        id: 'node',
        ok: existsSync(nodeBin) && nodeBin !== 'node',
        path: nodeBin,
        version: process.version,
        fix: existsSync(nodeBin) && nodeBin !== 'node' ? undefined : '未找到内置 node；重装 DSH 或把它放到 PATH 中',
        note: `DSH 主进程是 Electron（execPath=${path.basename(process.execPath)}），运行脚本请用 nodeBinary() 返回的绝对路径`,
    });

    const pnpm = firstExisting([
        path.join(runtimeDependencies(), 'pnpm', 'bin', 'pnpm.mjs'),
        path.join(runtimeDependencies(), 'pnpm', 'pnpm.cjs'),
    ]);
    checks.push({
        id: 'pnpm',
        ok: Boolean(pnpm),
        ...(pnpm ? { path: pnpm } : {}),
        fix: '重装 DSH 以恢复内置 pnpm；无 pnpm 时无法安装本地插件',
    });

    const git = await probeBinary('git', 'git', ['--version'], '安装 Git 并确保 git 在 PATH 中', signal);
    checks.push(git);

    const python = firstExisting([
        path.join(runtimeDependencies(), 'python', 'python.exe'),
        path.join(runtimeDependencies(), 'python', 'bin', 'python3'),
    ]);
    checks.push({
        id: 'python',
        ok: Boolean(python),
        ...(python ? { path: python } : {}),
        fix: '需要 Python 的技能与脚本将不可用；可安装或忽略',
    });

    const home = dshHome();
    checks.push({
        id: 'dsh-home',
        ok: existsSync(home),
        path: home,
        fix: '首次运行 DSH 会自动创建；若缺失说明 DSH 尚未初始化',
    });

    const profile = profileDir();
    let profileWritable = false;
    try {
        await access(profile, constants.W_OK);
        profileWritable = true;
    } catch {
        profileWritable = false;
    }
    checks.push({
        id: 'profile',
        ok: profileWritable,
        path: profile,
        fix: profileWritable ? undefined : '检查 profile 目录是否存在或被只读挂载',
    });

    const okCount = checks.filter((check) => check.ok).length;
    const failed = checks.filter((check) => !check.ok);
    const summary = failed.length === 0
        ? `全部 ${checks.length} 项可用`
        : `${failed.length}/${checks.length} 项不可用：${failed.map((check) => check.id).join(', ')}`;

    return { checks, okCount, failedCount: failed.length, summary };
}

/** 把探测结果渲染成工具输出文本。 */
export function renderProbe(value) {
    const lines = [`环境探测：${value.summary}`];
    for (const check of value.checks ?? []) {
        const mark = check.ok ? 'ok  ' : 'FAIL';
        const detail = check.version ?? check.path ?? check.detail ?? '';
        lines.push(`- [${mark}] ${check.id}${detail ? `: ${detail}` : ''}`);
        if (!check.ok && check.fix) lines.push(`        修复：${check.fix}`);
        if (check.note) lines.push(`        说明：${check.note}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
}
