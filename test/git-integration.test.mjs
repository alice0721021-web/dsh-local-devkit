/**
 * 对真实临时仓库的集成测试；没有 git 时整体跳过。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStatus, readDiff, readLog, commit } from '../src/git.mjs';

function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function hasGit() {
    try {
        execFileSync('git', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

const gitAvailable = hasGit();

function makeRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-devkit-'));
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'devkit@example.test']);
    git(dir, ['config', 'user.name', 'dsh-devkit']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git(dir, ['add', 'a.txt']);
    git(dir, ['commit', '-q', '-m', 'init']);
    return dir;
}

function cleanup(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

test('readStatus 识别干净与已修改状态', { skip: !gitAvailable && 'git 不可用' }, async () => {
    const dir = makeRepo();
    try {
        const clean = await readStatus(dir);
        assert.equal(clean.ok, true);
        assert.ok(clean.repo);

        fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
        const dirty = await readStatus(dir);
        assert.equal(dirty.unstaged.length, 1);
        assert.equal(dirty.unstaged[0].path, 'a.txt');
        assert.equal(dirty.unstaged[0].status, 'modified');
    } finally {
        cleanup(dir);
    }
});

test('readDiff 返回文件统计与补丁正文', { skip: !gitAvailable && 'git 不可用' }, async () => {
    const dir = makeRepo();
    try {
        fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
        const diff = await readDiff(dir, { stat: false });
        assert.equal(diff.ok, true);
        assert.equal(diff.files.length, 1);
        assert.ok(diff.files[0].added >= 1);
        assert.match(diff.patch, /\+two/);
        assert.equal(diff.truncated, false);

        const stat = await readDiff(dir, { stat: true });
        assert.equal(stat.patch, '');
        assert.equal(stat.files.length, 1);
    } finally {
        cleanup(dir);
    }
});

test('readDiff 遵守 maxBytes 截断', { skip: !gitAvailable && 'git 不可用' }, async () => {
    const dir = makeRepo();
    try {
        fs.writeFileSync(path.join(dir, 'a.txt'), `${'x'.repeat(5_000)}\n`);
        const diff = await readDiff(dir, { maxBytes: 1_024 });
        assert.equal(diff.truncated, true);
        assert.ok(Buffer.byteLength(diff.patch, 'utf8') <= 1_024);
        assert.ok(diff.hint);
    } finally {
        cleanup(dir);
    }
});

test('readLog 返回提交历史', { skip: !gitAvailable && 'git 不可用' }, async () => {
    const dir = makeRepo();
    try {
        const log = await readLog(dir, { limit: 5 });
        assert.equal(log.ok, true);
        assert.equal(log.commits.length, 1);
        assert.equal(log.commits[0].subject, 'init');
    } finally {
        cleanup(dir);
    }
});

test('commit 先 add 再提交，dryRun 不写任何内容', { skip: !gitAvailable && 'git 不可用' }, async () => {
    const dir = makeRepo();
    try {
        fs.writeFileSync(path.join(dir, 'b.txt'), 'bee\n');
        const dry = await commit(dir, { message: 'add b', paths: ['b.txt'], dryRun: true });
        assert.equal(dry.ok, true);
        assert.equal(dry.dryRun, true);
        assert.deepEqual(dry.wouldAdd, ['b.txt']);
        assert.equal((await readStatus(dir)).untracked.length, 1, 'dryRun 不能改动暂存区');

        const real = await commit(dir, { message: 'add b', paths: ['b.txt'] });
        assert.equal(real.ok, true);
        assert.ok(real.commit.short);
        assert.equal((await readStatus(dir)).untracked.length, 0);
        assert.equal((await readLog(dir, { limit: 5 })).commits.length, 2);
    } finally {
        cleanup(dir);
    }
});

test('commit 拒绝仓库外路径与空 message', { skip: !gitAvailable && 'git 不可用' }, async () => {
    const dir = makeRepo();
    try {
        await assert.rejects(
            () => commit(dir, { message: '  ', paths: ['a.txt'] }),
            (error) => error.devkitCode === 'INVALID_ARGS',
        );
        await assert.rejects(
            () => commit(dir, { message: 'escape', paths: [path.join('..', 'outside.txt')] }),
            (error) => error.devkitCode === 'PATH_OUTSIDE_REPO',
        );
    } finally {
        cleanup(dir);
    }
});

test('非 git 目录返回 NO_REPO', { skip: !gitAvailable && 'git 不可用' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-devkit-plain-'));
    try {
        const status = await readStatus(dir);
        assert.equal(status.ok, false);
        assert.equal(status.code, 'NO_REPO');
    } finally {
        cleanup(dir);
    }
});
