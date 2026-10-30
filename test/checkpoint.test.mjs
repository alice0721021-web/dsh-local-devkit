/**
 * 快照存储的行为测试：捕获、恢复、可逆性、跳过与清理。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CheckpointStore } from '../src/checkpoint/store.mjs';

function makeEnv(options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-cp-'));
    const project = path.join(root, 'project');
    fs.mkdirSync(project, { recursive: true });
    const store = new CheckpointStore({ root: path.join(root, 'store'), maxEntries: 5, maxFileBytes: 1024, ...options });
    return { root, project, store, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('capture 记录已存在文件，restore 恢复原内容', async () => {
    const { project, store, cleanup } = makeEnv();
    try {
        const file = path.join(project, 'a.txt');
        fs.writeFileSync(file, 'original');
        const meta = await store.capture({ path: file, tool: 'write', cwd: project });
        assert.equal(meta.existed, true);
        assert.equal(meta.skipped, null);

        fs.writeFileSync(file, 'changed');
        const result = await store.restore(meta.id, { cwd: project });
        assert.equal(result.action, 'restored');
        assert.equal(fs.readFileSync(file, 'utf8'), 'original');
    } finally {
        cleanup();
    }
});

test('capture 对尚不存在的文件记录 existed=false，restore 会删除它', async () => {
    const { project, store, cleanup } = makeEnv();
    try {
        const file = path.join(project, 'new.txt');
        const meta = await store.capture({ path: file, tool: 'write', cwd: project });
        assert.equal(meta.existed, false);

        fs.writeFileSync(file, 'created');
        const result = await store.restore(meta.id, { cwd: project });
        assert.equal(result.action, 'removed');
        assert.equal(fs.existsSync(file), false);
    } finally {
        cleanup();
    }
});

test('restore 本身可撤销：恢复前会再拍一次快照', async () => {
    const { project, store, cleanup } = makeEnv();
    try {
        const file = path.join(project, 'a.txt');
        fs.writeFileSync(file, 'A');
        const first = await store.capture({ path: file, tool: 'write', cwd: project });

        fs.writeFileSync(file, 'B');
        await store.restore(first.id, { cwd: project });
        assert.equal(fs.readFileSync(file, 'utf8'), 'A');

        const entries = await store.list({ cwd: project });
        const pre = entries.find((entry) => entry.reason === 'pre-restore');
        assert.ok(pre, '应存在恢复前的快照');
        await store.restore(pre.id, { cwd: project });
        assert.equal(fs.readFileSync(file, 'utf8'), 'B');
    } finally {
        cleanup();
    }
});

test('list 支持按路径过滤并按时间倒序', async () => {
    const { project, store, cleanup } = makeEnv();
    try {
        const a = path.join(project, 'a.txt');
        const b = path.join(project, 'b.txt');
        fs.writeFileSync(a, 'a');
        await store.capture({ path: a, tool: 'write', cwd: project });
        fs.writeFileSync(b, 'b');
        await store.capture({ path: b, tool: 'write', cwd: project });

        assert.equal((await store.list({ cwd: project })).length, 2);
        const onlyA = await store.list({ cwd: project, path: a });
        assert.equal(onlyA.length, 1);
        assert.equal(onlyA[0].path, a);
    } finally {
        cleanup();
    }
});

test('超过 maxFileBytes 的文件跳过且不写 blob', async () => {
    const { project, store, cleanup } = makeEnv();
    try {
        const file = path.join(project, 'big.bin');
        fs.writeFileSync(file, Buffer.alloc(2048, 1));
        const meta = await store.capture({ path: file, tool: 'write', cwd: project });
        assert.equal(meta.skipped, 'too-large');
        const blobs = fs.readdirSync(store.dirFor(project)).filter((name) => name.endsWith('.bin'));
        assert.deepEqual(blobs, []);
    } finally {
        cleanup();
    }
});

test('不记录快照目录自身，避免递归', async () => {
    const { root, project, store, cleanup } = makeEnv();
    try {
        const inside = path.join(root, 'store', 'self.txt');
        fs.mkdirSync(path.dirname(inside), { recursive: true });
        fs.writeFileSync(inside, 'x');
        const meta = await store.capture({ path: inside, tool: 'write', cwd: project });
        assert.equal(meta, null);
    } finally {
        cleanup();
    }
});

test('prune 只保留最近的 maxEntries 条', async () => {
    const { project, store, cleanup } = makeEnv({ maxEntries: 3 });
    try {
        const file = path.join(project, 'a.txt');
        fs.writeFileSync(file, 'v0');
        for (let i = 0; i < 7; i += 1) {
            fs.writeFileSync(file, `v${i}`);
            await store.capture({ path: file, tool: 'write', cwd: project });
        }
        const entries = await store.list({ cwd: project, limit: 200 });
        assert.ok(entries.length <= 3, `期望 <=3，实际 ${entries.length}`);
    } finally {
        cleanup();
    }
});
