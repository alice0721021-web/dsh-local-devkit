/**
 * 解析器与路径守卫的纯函数测试（不依赖真实仓库）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { parseStatus, parseNumstat, parseLog } from '../src/git.mjs';
import { assertInside, normalise } from '../src/repo.mjs';

const STATUS_SAMPLE = [
    '# branch.oid 1234567890abcdef',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -1',
    '1 M. N... 100644 100644 100644 aaaa bbbb file-one.txt',
    '1 .M N... 100644 100644 100644 aaaa bbbb dir/file two.txt',
    '2 R. N... 100644 100644 100644 aaaa bbbb R100 new.txt\told.txt',
    '? untracked.txt',
    'u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.txt',
].join('\n');

test('parseStatus 解析分支、ahead/behind 与各类变更', () => {
    const value = parseStatus(STATUS_SAMPLE);
    assert.equal(value.branch, 'main');
    assert.equal(value.upstream, 'origin/main');
    assert.equal(value.ahead, 2);
    assert.equal(value.behind, 1);

    assert.deepEqual(
        value.staged.map((item) => `${item.status}:${item.path}`),
        ['modified:file-one.txt', 'renamed:new.txt'],
    );
    assert.equal(value.staged[1].origPath, 'old.txt');

    assert.deepEqual(
        value.unstaged.map((item) => `${item.status}:${item.path}`),
        ['modified:dir/file two.txt'],
    );
    assert.deepEqual(value.untracked.map((item) => item.path), ['untracked.txt']);
    assert.deepEqual(value.conflicted.map((item) => item.path), ['conflict.txt']);
});

test('parseStatus 对空输出返回干净结构', () => {
    const value = parseStatus('');
    assert.equal(value.branch, null);
    assert.deepEqual(value.staged, []);
    assert.deepEqual(value.unstaged, []);
});

test('parseNumstat 处理普通与二进制文件', () => {
    const files = parseNumstat('3\t1\tsrc/a.js\n-\t-\tassets/logo.png\n');
    assert.deepEqual(files, [
        { path: 'src/a.js', added: 3, removed: 1, binary: false },
        { path: 'assets/logo.png', added: null, removed: null, binary: true },
    ]);
});

test('parseLog 按记录分隔符还原提交', () => {
    const records = [
        ['abc123', 'abc', 'Alice', '2026-10-30T00:00:00+08:00', 'fix: thing', 'HEAD -> main, tag: v1'],
        ['def456', 'def', 'Bob', '2026-10-29T00:00:00+08:00', 'feat: other', ''],
    ];
    const raw = `${records.map((fields) => fields.join('\u0000')).join('\x1e')}\x1e`;
    const commits = parseLog(raw);
    assert.equal(commits.length, 2);
    assert.equal(commits[0].short, 'abc');
    assert.deepEqual(commits[0].refs, ['HEAD -> main', 'tag: v1']);
    assert.equal(commits[1].subject, 'feat: other');
    assert.deepEqual(commits[1].refs, []);
});

test('assertInside 允许仓库内路径，拒绝越界路径', () => {
    const repo = path.resolve(os.tmpdir(), 'devkit-repo-guard');
    const inside = assertInside(repo, path.join('src', 'a.js'));
    assert.equal(normalise(inside), normalise(path.join(repo, 'src', 'a.js')));

    assert.throws(() => assertInside(repo, path.join('..', 'escape.txt')), (error) => error.devkitCode === 'PATH_OUTSIDE_REPO');
    assert.throws(() => assertInside(repo, path.resolve(repo, '..', 'sibling')), (error) => error.devkitCode === 'PATH_OUTSIDE_REPO');
});
