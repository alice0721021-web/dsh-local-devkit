/**
 * 把 dsh-devkit 注册进指定 DSH profile（幂等）。
 *
 *   node scripts/install.mjs [--profile desktop] [--dry-run] [--uninstall]
 *
 * 改动三处，写入前全部备份：
 *   1. profiles/<profile>/package.json —— dependencies 增加 link: 依赖
 *   2. profiles/<profile>/package.json —— dsh.profile.bundles 增加 dsh-devkit
 *   3. profiles/<profile>/cordis.patch.yml —— 标记块内的 - insert: 条目
 *
 * @module dsh-devkit/install
 */
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PACKAGE = 'dsh-local-devkit';
const LINK = 'link:F:/FJ/dsh-devkit';
const BEGIN = '# === dsh-local-devkit BEGIN ===';
const END = '# === dsh-local-devkit END ===';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback = null) {
    const index = process.argv.indexOf(`--${name}`);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value && !value.startsWith('--') ? value : true;
}

const dryRun = Boolean(arg('dry-run', false));
const uninstall = Boolean(arg('uninstall', false));
const profile = String(arg('profile', 'desktop'));
const dshHome = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
const profileDir = path.join(dshHome, 'profiles', profile);

function stamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

async function backup(file) {
    const target = `${file}.bak-devkit-${stamp()}`;
    await fs.copyFile(file, target);
    return target;
}

function block() {
    return [
        BEGIN,
        '# 由 dsh-devkit/scripts/install.mjs 写入；请在安装脚本里改，不要手动编辑本块。',
        '- insert:',
        '    - id: devkit',
        '      name: dsh-devkit',
        '      config: {}',
        END,
        '',
    ].join('\n');
}

async function patchPackageJson() {
    const file = path.join(profileDir, 'package.json');
    const pkg = JSON.parse(await fs.readFile(file, 'utf8'));
    const dependencies = pkg.dependencies ?? {};
    const bundles = pkg.dsh?.profile?.bundles ?? [];
    let changed = false;

    if (uninstall) {
        if (dependencies[PACKAGE] !== undefined) {
            delete dependencies[PACKAGE];
            changed = true;
        }
        const index = bundles.indexOf(PACKAGE);
        if (index >= 0) {
            bundles.splice(index, 1);
            changed = true;
        }
    } else {
        if (dependencies[PACKAGE] !== LINK) {
            dependencies[PACKAGE] = LINK;
            changed = true;
        }
        if (!bundles.includes(PACKAGE)) {
            bundles.push(PACKAGE);
            changed = true;
        }
    }

    if (!changed) return { file, changed: false };
    pkg.dependencies = dependencies;
    if (pkg.dsh?.profile) pkg.dsh.profile.bundles = bundles;
    const next = `${JSON.stringify(pkg, null, 2)}\n`;
    if (dryRun) return { file, changed: true, preview: next };
    const backupFile = await backup(file);
    await fs.writeFile(file, next, 'utf8');
    return { file, changed: true, backup: backupFile };
}

async function patchCordis() {
    const file = path.join(profileDir, 'cordis.patch.yml');
    const current = await fs.readFile(file, 'utf8');
    const start = current.indexOf(BEGIN);
    const stop = current.indexOf(END);
    let next;
    if (start >= 0 && stop > start) {
        const tail = current.slice(stop + END.length).replace(/^\r?\n/, '');
        next = uninstall
            ? `${current.slice(0, start)}${tail}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
            : `${current.slice(0, start)}${block()}${tail}`;
    } else if (uninstall) {
        return { file, changed: false };
    } else {
        const separator = current.endsWith('\n') ? '' : '\n';
        next = `${current}${separator}\n${block()}`;
    }
    if (next === current) return { file, changed: false };
    if (dryRun) return { file, changed: true, preview: next.slice(Math.max(0, next.length - 700)) };
    const backupFile = await backup(file);
    await fs.writeFile(file, next, 'utf8');
    return { file, changed: true, backup: backupFile };
}

function findPnpm() {
    const candidates = [
        path.join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
        path.join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'pnpm.cjs'),
    ];
    for (const candidate of candidates) {
        try {
            statSync(candidate);
            return candidate;
        } catch {
            // 继续找下一个候选。
        }
    }
    return null;
}

async function runPnpmInstall() {
    // 先备份 lock，pnpm install 失败时便于对照回滚。
    const lock = path.join(profileDir, 'pnpm-lock.yaml');
    try {
        await fs.copyFile(lock, `${lock}.bak-devkit-${stamp()}`);
    } catch {
        // 没有 lock 文件时跳过备份。
    }
    const pnpm = findPnpm();
    if (!pnpm) {
        return {
            ok: false,
            code: 'PNPM_MISSING',
            message: '未找到内置 pnpm，跳过 install；请手动在 profile 目录执行 pnpm install。',
        };
    }
    return new Promise((resolve) => {
        execFile(process.execPath, [pnpm, 'install'], {
            cwd: profileDir,
            timeout: 180_000,
            windowsHide: true,
        }, (error, stdout, stderr) => {
            if (error) {
                resolve({ ok: false, code: 'PNPM_FAILED', message: String(stderr || error.message).slice(0, 2_000) });
                return;
            }
            resolve({ ok: true, message: String(stdout).trim().split(/\r?\n/).slice(-5).join('\n') });
        });
    });
}

async function main() {
    const packageResult = await patchPackageJson();
    const cordisResult = await patchCordis();
    const report = {
        profile,
        dryRun,
        uninstall,
        package: { file: packageResult.file, changed: packageResult.changed, backup: packageResult.backup },
        cordis: { file: cordisResult.file, changed: cordisResult.changed, backup: cordisResult.backup },
        packagePreview: packageResult.preview ?? null,
        cordisPreview: cordisResult.preview ?? null,
    };

    if (dryRun) {
        console.log(JSON.stringify(report, null, 2));
        return;
    }

    if (!packageResult.changed && !cordisResult.changed) {
        console.log(JSON.stringify({ ...report, message: '已是目标状态，无需改动。' }, null, 2));
        return;
    }

    const install = await runPnpmInstall();
    report.install = install;
    report.next = install.ok
        ? '重启 DSH 使插件生效，然后在新会话里调用 env_probe 验证。'
        : '修复 install 报告的问题后，在 profile 目录手动执行 pnpm install，再重启 DSH。';
    console.log(JSON.stringify(report, null, 2));
    if (!install.ok) process.exitCode = 1;
}

main().catch((error) => {
    console.error(`[dsh-devkit] install failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
