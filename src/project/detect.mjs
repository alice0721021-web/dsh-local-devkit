/**
 * 项目检查目标探测：Node / Python / Go 三类项目，定位可运行的检查命令。
 *
 * 每种类型产出统一的 targets 结构：{ target, script, command, args }，
 * 执行层只关心 runner.bin + baseArgs + target.args。
 *
 * @module dsh-devkit/project/detect
 */
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runtimeDependencies, nodeBinary } from '../env.mjs';

/** Node 目标名 → package.json script 的候选名；顺序即执行顺序。 */
const TARGET_SCRIPTS = {
    typecheck: ['typecheck', 'type-check', 'check-types', 'tsc'],
    lint: ['lint', 'eslint', 'stylelint'],
    test: ['test', 'tests', 'jest', 'vitest', 'mocha'],
    build: ['build', 'compile'],
};

/** Python 项目标记文件。 */
const PYTHON_MARKERS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'pytest.ini', 'conftest.py', 'requirements.txt'];

async function exists(file) {
    try {
        await fs.access(file);
        return true;
    } catch {
        return false;
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

async function detectManager(dir, pkg) {
    if (typeof pkg.packageManager === 'string') {
        for (const manager of ['pnpm', 'yarn', 'bun', 'npm']) {
            if (pkg.packageManager.startsWith(manager)) return manager;
        }
    }
    const lockfiles = [
        ['pnpm-lock.yaml', 'pnpm'],
        ['yarn.lock', 'yarn'],
        ['bun.lockb', 'bun'],
        ['package-lock.json', 'npm'],
    ];
    for (const [file, manager] of lockfiles) {
        if (await exists(path.join(dir, file))) return manager;
    }
    // 没有任何线索时选 pnpm：DSH 环境自带内置 pnpm，而 npm / yarn 常不在 PATH。
    // pnpm 读同一份 package.json scripts，对 npm 项目同样可用。
    return 'pnpm';
}

/**
 * 定位 Node 包管理器可执行方式：优先 PATH，其次 DSH 内置 pnpm。
 * @returns {{bin: string, baseArgs: string[], source: string}|null}
 */
export function locateRunner(manager) {
    const candidates = [`${manager}.cmd`, `${manager}.exe`, manager];
    const onPath = findOnPath(candidates);
    if (onPath) return { bin: onPath, baseArgs: [], source: 'path' };
    if (manager === 'pnpm') {
        const base = runtimeDependencies();
        const bundled = [
            path.join(base, 'pnpm', 'bin', 'pnpm.mjs'),
            path.join(base, 'pnpm', 'pnpm.cjs'),
        ];
        for (const file of bundled) {
            if (existsSync(file)) return { bin: nodeBinary(), baseArgs: [file], source: 'bundled' };
        }
    }
    return null;
}

async function detectNode(dir) {
    const file = path.join(dir, 'package.json');
    if (!(await exists(file))) return null;
    let pkg;
    try {
        pkg = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
        return null;
    }
    const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    const manager = await detectManager(dir, pkg);
    // npm / yarn 不在 PATH 时回退到内置 pnpm：`pnpm run <script>` 只读 package.json，
    // 不依赖 node_modules 布局，对 npm 项目同样可用。展示的命令跟着实际执行者走。
    const runner = locateRunner(manager) ?? locateRunner('pnpm');
    const executable = runner && runner.source === 'bundled' ? 'pnpm' : manager;
    const targets = [];
    for (const [target, candidates] of Object.entries(TARGET_SCRIPTS)) {
        const script = candidates.find((name) => typeof scripts[name] === 'string' && scripts[name].trim() !== '');
        if (script) {
            targets.push({ target, script, command: `${executable} run ${script}`, args: ['run', script] });
        }
    }
    return {
        ok: true,
        kind: 'node',
        dir,
        name: typeof pkg.name === 'string' ? pkg.name : undefined,
        manager,
        runner,
        targets,
        availableScripts: Object.keys(scripts),
    };
}

async function detectPython(dir) {
    const found = [];
    for (const marker of PYTHON_MARKERS) {
        if (await exists(path.join(dir, marker))) found.push(marker);
    }
    if (found.length === 0) return null;

    let pyproject = '';
    try {
        pyproject = await fs.readFile(path.join(dir, 'pyproject.toml'), 'utf8');
    } catch {
        // 没有 pyproject 时只依赖标记文件判断。
    }

    const venv = ['Scripts/python.exe', 'Scripts/python', 'bin/python3', 'bin/python']
        .map((relative) => path.join(dir, '.venv', relative))
        .find((candidate) => existsSync(candidate));
    const bundled = [
        path.join(runtimeDependencies(), 'python', 'python.exe'),
        path.join(runtimeDependencies(), 'python', 'bin', 'python3'),
    ].find((candidate) => existsSync(candidate));
    const python = venv ?? bundled ?? null;

    const hasPytest = found.some((marker) => marker === 'pytest.ini' || marker === 'conftest.py')
        || /\[tool\.pytest/.test(pyproject)
        || (await exists(path.join(dir, 'tests')));
    const hasRuff = (await exists(path.join(dir, 'ruff.toml'))) || (await exists(path.join(dir, '.ruff.toml')))
        || /\[tool\.ruff/.test(pyproject);
    const hasMypy = (await exists(path.join(dir, 'mypy.ini'))) || (await exists(path.join(dir, '.mypy.ini')))
        || /\[tool\.mypy/.test(pyproject);

    const targets = [];
    if (hasMypy) targets.push({ target: 'typecheck', script: 'mypy', command: 'python -m mypy .', args: ['-m', 'mypy', '.'] });
    if (hasRuff) targets.push({ target: 'lint', script: 'ruff', command: 'python -m ruff check .', args: ['-m', 'ruff', 'check', '.'] });
    if (hasPytest) targets.push({ target: 'test', script: 'pytest', command: 'python -m pytest', args: ['-m', 'pytest'] });

    const nameMatch = pyproject.match(/^\s*name\s*=\s*["']([^"']+)["']/m);

    return {
        ok: true,
        kind: 'python',
        dir,
        name: nameMatch ? nameMatch[1] : undefined,
        manager: 'python',
        runner: python ? { bin: python, baseArgs: [], source: venv ? 'venv' : 'bundled' } : null,
        targets,
        availableScripts: found,
    };
}

async function detectGo(dir) {
    const file = path.join(dir, 'go.mod');
    if (!(await exists(file))) return null;
    let mod = '';
    try {
        mod = await fs.readFile(file, 'utf8');
    } catch {
        // 读不到模块名时仍然可以跑测试。
    }
    const moduleName = mod.match(/^module\s+(\S+)/m)?.[1] ?? undefined;
    const go = findOnPath(['go.exe', 'go']);
    return {
        ok: true,
        kind: 'go',
        dir,
        name: moduleName,
        manager: 'go',
        runner: go ? { bin: go, baseArgs: [], source: 'path' } : null,
        targets: [{ target: 'test', script: 'go test', command: 'go test ./...', args: ['test', './...'] }],
        availableScripts: ['go test'],
    };
}

/**
 * 探测一个项目中可运行的检查目标。
 */
export async function detectProject(cwd) {
    const dir = path.resolve(cwd);
    const node = await detectNode(dir);
    if (node) return node;
    const python = await detectPython(dir);
    if (python) return python;
    const go = await detectGo(dir);
    if (go) return go;
    return { ok: false, code: 'NO_PROJECT', dir };
}

export { TARGET_SCRIPTS };
