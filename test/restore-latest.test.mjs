/**
 * 按路径回退（restoreLatest）的行为测试：连续调用应逐版回退，而不是原地横跳。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CheckpointStore } from '../src/checkpoint/store.mjs';

function makeEnv() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-latest-'));
    const project = path.join(root, 'project');
    fs.mkdirSync(project, { recursive: true });
    const store = new CheckpointStore({ root: path.join(root, 'store'), maxEntries: 200 });
    return { root, project, store, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** 模拟三次写入：每次写入前 capture，最后文件是 v3。 */
async function seed(store, file, project) {
    await store.capture({ path: file, tool: 'write', cwd: project });
    fs.writeFileSync(file, 'v1');
    await store.capture({ path: file, tool: 'write', cwd: project });
    fs.writeFileSync(file, 'v2');
    await store.capture({ path: file, tool: 'write', cwd: project });
    fs.writeFileSync(file, 'v3');
}

test('restoreLatest 连续调用逐版回退，最后回到不存在', async () => {
    const { project, store, cleanup } = makeEnv();
    try {
        const file = path.join(project, 'a.txt');
        await seed(store, file, project);
        assert.equal(fs.readFileSync(file, 'utf8'), 'v3');

        const first = await store.restoreLatest(file, { cwd: project });
        assert.equal(first.action, 'restored');
        assert.equal(fs.readFileSync(file, 'utf8'), 'v2');

        const second = await store.restoreLatest(file, { cwd: project });
        assert.equal(second.action, 'restored');
        assert.equal(fs.readFileSync(file, 'utf8'), 'v1');

        const third = await store.restoreLatest(file, { cwd: project });
        assert.equal(third.action, 'removed');
        assert.equal(fs.existsSync(file), false);

        await assert.rejects(
            () => store.restoreLatest(file, { cwd: project }),
            (error) => error.devkitCode === 'CHECKPOINT_NOT_FOUND',
        );
    } finally {
        cleanup();
    }
});

test('被回退消费的快照会标记 consumed，恢复前快照不参与选择', async () => {
    const { project, store, cleanup } = makeEnv();
    try {
        const file = path.join(project, 'a.txt');
        await seed(store, file, project);
        await store.restoreLatest(file, { cwd: project });

        const entries = await store.list({ cwd: project, path: file, limit: 200 });
        const consumed = entries.filter((entry) => entry.consumed === true);
        assert.equal(consumed.length, 1, '应恰好有一条被消费');

        const preRestore = entries.filter((entry) => entry.reason === 'pre-restore');
        assert.ok(preRestore.length >= 1, '恢复前应留下 pre-restore 快照');
        assert.ok(preRestore.every((entry) => entry.consumed !== true), 'pre-restore 不应被当作回退目标');
    } finally {
        cleanup();
    }
});

test('按 id 精确恢复不消费快照，可重复使用', async () => {
    const { project, store, cleanup } = makeEnv();
    try {
        const file = path.join(project, 'a.txt');
        fs.writeFileSync(file, 'origin');
        const meta = await store.capture({ path: file, tool: 'write', cwd: project });

        fs.writeFileSync(file, 'changed');
        await store.restore(meta.id, { cwd: project });
        assert.equal(fs.readFileSync(file, 'utf8'), 'origin');

        fs.writeFileSync(file, 'changed-again');
        await store.restore(meta.id, { cwd: project });
        assert.equal(fs.readFileSync(file, 'utf8'), 'origin');

        const entries = await store.list({ cwd: project, path: file, limit: 200 });
        const target = entries.find((entry) => entry.id === meta.id);
        assert.notEqual(target.consumed, true);
    } finally {
        cleanup();
    }
});
