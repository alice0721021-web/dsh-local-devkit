/**
 * 健康检查的测试：模拟 recall 快照目录，覆盖停滞、超限与 profile 缺包。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRecallStatus } from '../src/health/recall.mjs';
import { measureWorkspace } from '../src/health/workspace.mjs';
import { readCheckpointStatus } from '../src/health/checkpoints.mjs';
import { buildTools } from '../index.js';

/** 在临时 DSH_HOME 下搭一个 recall 快照目录。 */
function seedRecall(dshHome, cwd, entries) {
    const hash = 'a'.repeat(64);
    const dir = path.join(dshHome, 'dsh-recall-snapshots', hash);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'root.txt'), cwd);
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(entries, null, 2));
    return dir;
}

function withDshHome(dshHome) {
    const previous = process.env.DSH_HOME;
    process.env.DSH_HOME = dshHome;
    return () => {
        if (previous === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = previous;
    };
}

test('readRecallStatus 能找到当前工作区的快照', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-health-'));
    const project = path.join(root, 'project');
    fs.mkdirSync(project, { recursive: true });
    const restore = withDshHome(root);
    try {
        const now = Date.now();
        seedRecall(root, project, [
            { id: 'a', time: now - 3_600_000, root: project, sessionId: 's1' },
            { id: 'b', time: now - 60_000, root: project, sessionId: 's1' },
        ]);
        const status = await readRecallStatus(project);
        assert.equal(status.installed, true);
        assert.ok(status.forCwd);
        assert.equal(status.forCwd.entries, 2);
        assert.equal(status.forCwd.newest, now - 60_000);
    } finally {
        restore();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('未安装 recall 时 installed=false', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-health-'));
    const restore = withDshHome(root);
    try {
        const status = await readRecallStatus(root);
        assert.equal(status.installed, false);
        assert.equal(status.forCwd, null);
    } finally {
        restore();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('measureWorkspace 统计体积并跳过依赖目录', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-ws-'));
    try {
        fs.mkdirSync(path.join(root, 'src'), { recursive: true });
        fs.writeFileSync(path.join(root, 'src', 'a.txt'), 'x'.repeat(100));
        fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
        fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'big.js'), 'y'.repeat(10_000));
        fs.writeFileSync(path.join(root, 'root.txt'), 'z'.repeat(50));

        const result = await measureWorkspace(root);
        assert.equal(result.total, 150, '应只统计 src 与根文件');
        assert.equal(result.files, 2);
        assert.equal(result.topDirs[0].name, 'src');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('readCheckpointStatus 汇总条数与最新时间', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-cp-status-'));
    try {
        const dir = path.join(root, 'proj');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '1-0001-ab.json'), '{}');
        fs.writeFileSync(path.join(dir, '2-0002-cd.json'), '{}');
        const status = await readCheckpointStatus(root);
        assert.equal(status.total, 2);
        assert.ok(status.newest > 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('health_probe 把停滞的 recall 判为需要关注', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-health-'));
    const project = path.join(root, 'project');
    fs.mkdirSync(project, { recursive: true });
    const restore = withDshHome(root);
    try {
        // 48 小时前的快照 → 超过默认 24 小时阈值
        seedRecall(root, project, [{ id: 'a', time: Date.now() - 48 * 3_600_000, root: project, sessionId: 's1' }]);
        const tool = buildTools().find((item) => item.name === 'health_probe');
        const value = await tool.execute({ cwd: project, scanBudgetMs: 500 }, {});
        const recall = value.checks.find((check) => check.id === 'recall');
        assert.equal(recall.ok, false);
        assert.equal(recall.status, 'stalled');
        assert.equal(value.ok, false);
    } finally {
        restore();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('health_probe 对新鲜快照与正常体积返回 ok', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-health-'));
    const project = path.join(root, 'project');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'a.txt'), 'small');
    const restore = withDshHome(root);
    try {
        seedRecall(root, project, [{ id: 'a', time: Date.now() - 60_000, root: project, sessionId: 's1' }]);
        const tool = buildTools().find((item) => item.name === 'health_probe');
        const value = await tool.execute({ cwd: project, scanBudgetMs: 500 }, {});
        const recall = value.checks.find((check) => check.id === 'recall');
        const workspace = value.checks.find((check) => check.id === 'workspace');
        assert.equal(recall.ok, true);
        assert.equal(workspace.ok, true);
    } finally {
        restore();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
