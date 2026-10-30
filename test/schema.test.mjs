/**
 * 输出 schema 校验：宿主会拒绝与声明类型不符的值（尤其是 null）。
 * 这里用等价规则跑一遍全部工具与边界场景，防止可空字段回归。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTools } from '../index.js';

function validate(value, schema, at, errors) {
    const type = schema?.type;
    if (type === undefined) return;
    if (type === 'object') {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            errors.push(`${at}: expected object, got ${value === null ? 'null' : typeof value}`);
            return;
        }
        for (const [key, sub] of Object.entries(schema.properties ?? {})) {
            if (value[key] === undefined) continue;
            validate(value[key], sub, `${at}.${key}`, errors);
        }
        return;
    }
    if (type === 'array') {
        if (!Array.isArray(value)) {
            errors.push(`${at}: expected array, got ${value === null ? 'null' : typeof value}`);
            return;
        }
        value.forEach((item, index) => validate(item, schema.items ?? {}, `${at}[${index}]`, errors));
        return;
    }
    const actual = value === null ? 'null' : typeof value;
    if (type === 'string' && typeof value !== 'string') errors.push(`${at}: expected string, got ${actual}`);
    if (type === 'integer' && !Number.isInteger(value)) errors.push(`${at}: expected integer, got ${actual}`);
    if (type === 'boolean' && typeof value !== 'boolean') errors.push(`${at}: expected boolean, got ${actual}`);
}

function assertSchema(tools, name, value) {
    const tool = tools.get(name);
    assert.ok(tool, `未注册工具 ${name}`);
    const errors = [];
    validate(value, tool.output.schema, name, errors);
    assert.deepEqual(errors, [], `${name} 输出与 schema 不符`);
}

const gitAvailable = (() => {
    try {
        execFileSync('git', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
})();

const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

test('全部工具输出满足声明的输出 schema', { skip: !gitAvailable && 'git 不可用' }, async () => {
    const tools = new Map(buildTools().map((tool) => [tool.name, tool]));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-schema-'));
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-empty-'));
    try {
        git(repo, ['init', '-q']);
        git(repo, ['config', 'user.email', 'a@b.c']);
        git(repo, ['config', 'user.name', 't']);
        fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
        git(repo, ['add', 'a.txt']);
        git(repo, ['commit', '-q', '-m', 'init']);
        fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
        fs.writeFileSync(path.join(repo, 'b.txt'), 'bee\n');
        fs.writeFileSync(path.join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
        git(repo, ['add', 'logo.png']);

        assertSchema(tools, 'env_probe', await tools.get('env_probe').execute({}, {}));
        assertSchema(tools, 'git_status', await tools.get('git_status').execute({ cwd: repo }, {}));
        assertSchema(tools, 'git_diff', await tools.get('git_diff').execute({ cwd: repo }, {}));
        assertSchema(tools, 'git_diff', await tools.get('git_diff').execute({ cwd: repo, stat: true }, {}));
        assertSchema(tools, 'git_diff', await tools.get('git_diff').execute({ cwd: repo, staged: true }, {}));
        assertSchema(tools, 'git_log', await tools.get('git_log').execute({ cwd: repo }, {}));
        assertSchema(tools, 'git_commit', await tools.get('git_commit').execute({ cwd: repo, message: 'x', dryRun: true }, {}));
        assertSchema(tools, 'git_commit', await tools.get('git_commit').execute({ cwd: repo, message: '  ' }, {}));
        assertSchema(tools, 'git_status', await tools.get('git_status').execute({ cwd: os.tmpdir() }, {}));
        assertSchema(tools, 'fs_checkpoints', await tools.get('fs_checkpoints').execute({ cwd: repo }, {}));
        assertSchema(tools, 'fs_restore', await tools.get('fs_restore').execute({ id: 'no-such-id', cwd: repo }, {}));
        assertSchema(tools, 'project_check', await tools.get('project_check').execute({ cwd: repo }, {}));
        assertSchema(tools, 'health_probe', await tools.get('health_probe').execute({ cwd: repo, scanBudgetMs: 200 }, {}));

        const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-check-'));
        fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({
            name: 'demo',
            scripts: { test: 'node -e ""', build: 'node -e ""' },
        }));
        assertSchema(tools, 'project_check', await tools.get('project_check').execute({ cwd: projectDir, dryRun: true }, {}));
        fs.rmSync(projectDir, { recursive: true, force: true });

        git(repo, ['checkout', '--detach', '-q']);
        assertSchema(tools, 'git_status', await tools.get('git_status').execute({ cwd: repo }, {}));

        git(empty, ['init', '-q']);
        assertSchema(tools, 'git_status', await tools.get('git_status').execute({ cwd: empty }, {}));
        assertSchema(tools, 'git_log', await tools.get('git_log').execute({ cwd: empty }, {}));
    } finally {
        fs.rmSync(repo, { recursive: true, force: true });
        fs.rmSync(empty, { recursive: true, force: true });
    }
});
