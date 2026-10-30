/**
 * 项目检查探测与执行的测试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectProject, locateRunner } from '../src/project/detect.mjs';
import { runTarget, extractFailures } from '../src/project/run.mjs';

function makeProject(pkg, files = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-proj-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
    for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), content);
    }
    return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('没有任何项目标记时返回 NO_PROJECT', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-nopkg-'));
    try {
        const result = await detectProject(dir);
        assert.equal(result.ok, false);
        assert.equal(result.code, 'NO_PROJECT');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('按 scripts 识别目标并保持执行顺序', async () => {
    const { dir, cleanup } = makeProject({
        name: 'demo',
        scripts: { build: 'vite build', test: 'vitest run', 'type-check': 'tsc --noEmit' },
    });
    try {
        const result = await detectProject(dir);
        assert.equal(result.ok, true);
        assert.deepEqual(result.targets.map((item) => item.target), ['typecheck', 'test', 'build']);
        assert.equal(result.targets[0].script, 'type-check');
        assert.deepEqual(result.availableScripts.sort(), ['build', 'test', 'type-check']);
    } finally {
        cleanup();
    }
});

test('packageManager 字段优先于 lock 文件', async () => {
    const { dir, cleanup } = makeProject(
        { name: 'demo', packageManager: 'pnpm@11.0.0', scripts: { test: 'x' } },
        { 'package-lock.json': '{}' },
    );
    try {
        const result = await detectProject(dir);
        assert.equal(result.manager, 'pnpm');
    } finally {
        cleanup();
    }
});

test('没有 packageManager 时按 lock 文件推断', async () => {
    const { dir, cleanup } = makeProject({ name: 'demo', scripts: {} }, { 'yarn.lock': '' });
    try {
        const result = await detectProject(dir);
        assert.equal(result.manager, 'yarn');
    } finally {
        cleanup();
    }
});

test('runTarget 记录退出码、耗时与失败摘要', async () => {
    const okRunner = { bin: process.execPath, baseArgs: ['-e', 'process.exit(0)'], source: 'test' };
    const failRunner = { bin: process.execPath, baseArgs: ['-e', 'console.log("FAIL src/a.test.ts > boom"); process.exit(1)'], source: 'test' };
    const target = { target: 'test', script: 'test', command: 'test run test' };

    const passed = await runTarget(target, okRunner, { cwd: os.tmpdir() });
    assert.equal(passed.ok, true);
    assert.equal(passed.exitCode, 0);
    assert.equal(typeof passed.durationMs, 'number');

    const failed = await runTarget(target, failRunner, { cwd: os.tmpdir() });
    assert.equal(failed.ok, false);
    assert.equal(failed.exitCode, 1);
    assert.ok(failed.failures.length >= 1);
    assert.match(failed.failures[0], /FAIL/);
});

test('runTarget 把超时转成结构化错误', async () => {
    const slowRunner = { bin: process.execPath, baseArgs: ['-e', 'setTimeout(()=>{}, 5000)'], source: 'test' };
    const result = await runTarget({ target: 'test', script: 'test', command: 'x' }, slowRunner, {
        cwd: os.tmpdir(),
        timeoutMs: 300,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TIMEOUT');
});

test('extractFailures 只抓失败行并限制条数', () => {
    const text = ['all good', 'FAIL a.test.ts > one', 'ok', 'AssertionError: nope', ...Array.from({ length: 20 }, (_, i) => `FAIL case-${i}`)].join('\n');
    const failures = extractFailures(text);
    assert.ok(failures.length <= 10);
    assert.match(failures[0], /FAIL a\.test\.ts/);
});

test('locateRunner 对未知包管理器返回 null', () => {
    assert.equal(locateRunner('__definitely_not_a_manager__'), null);
});

function makeTree(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-tree-'));
    for (const [name, content] of Object.entries(files)) {
        const full = path.join(dir, name);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }
    return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('识别 Python 项目并探测 pytest / ruff / mypy', async () => {
    const { dir, cleanup } = makeTree({
        'pyproject.toml': '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n\n[tool.ruff]\nline-length = 100\n\n[tool.mypy]\nstrict = true\n',
        'tests/test_a.py': 'def test_a():\n    assert True\n',
    });
    try {
        const result = await detectProject(dir);
        assert.equal(result.ok, true);
        assert.equal(result.kind, 'python');
        assert.equal(result.manager, 'python');
        const targets = result.targets.map((item) => item.target);
        assert.deepEqual(targets, ['typecheck', 'lint', 'test']);
        assert.deepEqual(result.targets.find((item) => item.target === 'test').args, ['-m', 'pytest']);
        assert.deepEqual(result.targets.find((item) => item.target === 'lint').args, ['-m', 'ruff', 'check', '.']);
        assert.ok(result.runner, '应能找到 venv 或内置 python');
    } finally {
        cleanup();
    }
});

test('只有 pyproject.toml 时不臆造 ruff 目标', async () => {
    const { dir, cleanup } = makeTree({
        'pyproject.toml': '[project]\nname = "demo"\nversion = "0.1.0"\n',
    });
    try {
        const result = await detectProject(dir);
        assert.equal(result.ok, true);
        assert.equal(result.kind, 'python');
        assert.deepEqual(result.targets, [], '没有 pytest/ruff/mypy 声明时不应产出目标');
        assert.equal(result.name, 'demo');
    } finally {
        cleanup();
    }
});

test('识别 Go 项目并给出 go test', async () => {
    const { dir, cleanup } = makeTree({
        'go.mod': 'module example.com/demo\n\ngo 1.22\n',
    });
    try {
        const result = await detectProject(dir);
        assert.equal(result.ok, true);
        assert.equal(result.kind, 'go');
        assert.equal(result.name, 'example.com/demo');
        assert.deepEqual(result.targets[0].args, ['test', './...']);
    } finally {
        cleanup();
    }
});

test('runTarget 使用 target.args 而非固定 run', async () => {
    // 用一个等价于 `node -e "process.exit(0)"` 的 runner，验证参数拼接走的是 args。
    const runner = { bin: process.execPath, baseArgs: [], source: 'test' };
    const target = { target: 'test', script: 'x', command: 'x', args: ['-e', 'process.exit(0)'] };
    const result = await runTarget(target, runner, { cwd: os.tmpdir() });
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
});
