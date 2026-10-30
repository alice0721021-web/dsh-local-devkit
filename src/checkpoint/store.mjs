/**
 * 文件快照存储：在工具改写文件前保存原内容，支持列出与恢复。
 *
 * 布局：<DSH_HOME>/devkit/checkpoints/<projectHash>/<ts>-<rand>.{json,bin}
 *
 * @module dsh-devkit/checkpoint/store
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dshHome } from '../env.mjs';
import { devkitError } from '../exec.mjs';

export const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_ENTRIES = 500;

let sequence = 0;

/** 同一毫秒内也能保持单调顺序的快照序号。 */
function nextSequence() {
    sequence = (sequence + 1) % 100_000;
    return sequence;
}

export function checkpointsRoot() {
    return path.join(dshHome(), 'devkit', 'checkpoints');
}

function normalise(target) {
    const resolved = path.resolve(target);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function projectKey(cwd) {
    return createHash('sha1').update(normalise(cwd)).digest('hex').slice(0, 12);
}

async function readJson(file) {
    return JSON.parse(await fs.readFile(file, 'utf8'));
}

export class CheckpointStore {
    constructor(options = {}) {
        this.maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
            ? options.maxEntries
            : DEFAULT_MAX_ENTRIES;
        this.maxFileBytes = Number.isInteger(options.maxFileBytes) && options.maxFileBytes > 0
            ? options.maxFileBytes
            : DEFAULT_MAX_FILE_BYTES;
        this.root = options.root ? path.resolve(options.root) : checkpointsRoot();
    }

    dirFor(cwd) {
        return path.join(this.root, projectKey(cwd));
    }

    /** 是否落在快照目录内部，避免对自己的写入再打快照造成递归。 */
    isInsideStore(target) {
        const store = normalise(this.root);
        const resolved = normalise(target);
        return resolved === store || resolved.startsWith(store + path.sep);
    }

    /**
     * 在文件被修改前保存其当前内容。
     *
     * @param {{path: string, tool: string, cwd: string, reason?: string}} input
     * @returns {Promise<object|null>} 快照元数据；跳过时带 skipped 字段
     */
    async capture(input) {
        const target = path.resolve(input.path);
        if (this.isInsideStore(target)) return null;

        const dir = this.dirFor(input.cwd);
        await fs.mkdir(dir, { recursive: true });

        const id = `${Date.now()}-${String(nextSequence()).padStart(5, '0')}-${randomBytes(2).toString('hex')}`;
        const metaFile = path.join(dir, `${id}.json`);
        const blobFile = path.join(dir, `${id}.bin`);
        const createdAt = new Date().toISOString();

        let stat = null;
        try {
            stat = await fs.stat(target);
        } catch {
            stat = null;
        }

        const base = {
            id,
            tool: input.tool,
            path: target,
            cwd: path.resolve(input.cwd),
            reason: input.reason ?? 'pre-tool',
            createdAt,
        };

        if (stat === null) {
            const meta = { ...base, existed: false, size: 0, skipped: null };
            await fs.writeFile(metaFile, JSON.stringify(meta, null, 2), 'utf8');
            await this.prune(dir);
            return meta;
        }

        if (!stat.isFile()) {
            const meta = { ...base, existed: true, size: stat.size, skipped: 'not-a-regular-file' };
            await fs.writeFile(metaFile, JSON.stringify(meta, null, 2), 'utf8');
            await this.prune(dir);
            return meta;
        }

        if (stat.size > this.maxFileBytes) {
            const meta = { ...base, existed: true, size: stat.size, skipped: 'too-large' };
            await fs.writeFile(metaFile, JSON.stringify(meta, null, 2), 'utf8');
            await this.prune(dir);
            return meta;
        }

        const content = await fs.readFile(target);
        await fs.writeFile(blobFile, content);
        const meta = { ...base, existed: true, size: stat.size, skipped: null };
        await fs.writeFile(metaFile, JSON.stringify(meta, null, 2), 'utf8');
        await this.prune(dir);
        return meta;
    }

    /** 只保留最近的 maxEntries 条，删除更旧的元数据与内容。 */
    async prune(dir) {
        let names;
        try {
            names = await fs.readdir(dir);
        } catch {
            return;
        }
        const metas = names.filter((name) => name.endsWith('.json')).sort();
        if (metas.length <= this.maxEntries) return;
        for (const name of metas.slice(0, metas.length - this.maxEntries)) {
            const id = name.slice(0, -'.json'.length);
            await fs.rm(path.join(dir, name), { force: true });
            await fs.rm(path.join(dir, `${id}.bin`), { force: true });
        }
    }

    /** 列出快照，按时间倒序。 */
    async list(options = {}) {
        const dir = this.dirFor(options.cwd ?? process.cwd());
        const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 200) : 20;
        let names;
        try {
            names = await fs.readdir(dir);
        } catch {
            return [];
        }
        const wanted = options.path ? normalise(options.path) : null;
        const entries = [];
        for (const name of names.filter((item) => item.endsWith('.json'))) {
            try {
                const meta = await readJson(path.join(dir, name));
                if (wanted && normalise(meta.path) !== wanted) continue;
                entries.push(meta);
            } catch {
                // 损坏的元数据跳过，不影响其它条目。
            }
        }
        return entries.sort((a, b) => String(b.id).localeCompare(String(a.id))).slice(0, limit);
    }

    async find(id, cwd) {
        const dir = this.dirFor(cwd ?? process.cwd());
        const metaFile = path.join(dir, `${id}.json`);
        try {
            return { dir, meta: await readJson(metaFile) };
        } catch {
            return null;
        }
    }

    /** 标记某条快照已被回退消费，避免 restoreLatest 反复选中同一条。 */
    async markConsumed(dir, id) {
        const file = path.join(dir, `${id}.json`);
        try {
            const meta = await readJson(file);
            meta.consumed = true;
            await fs.writeFile(file, JSON.stringify(meta, null, 2), 'utf8');
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 回退某个文件的上一次写入。
     *
     * 选中该路径最近一条「未被消费、且不是恢复前快照」的记录；连续调用会逐步回退：
     * v3 → v2 → v1 → 删除（文件最初不存在时）。
     */
    async restoreLatest(targetPath, options = {}) {
        const cwd = options.cwd ?? process.cwd();
        const dir = this.dirFor(cwd);
        const entries = await this.list({ cwd, path: targetPath, limit: 200 });
        const candidate = entries.find((meta) => meta.reason !== 'pre-restore' && meta.consumed !== true);
        if (!candidate) {
            throw devkitError('CHECKPOINT_NOT_FOUND', `没有可回退的快照：${targetPath}`);
        }
        await this.markConsumed(dir, candidate.id);
        const result = await this.restore(candidate.id, { cwd });
        return { ...result, id: candidate.id };
    }

    /**
     * 恢复到某个快照；恢复前对当前文件再拍一次快照，保证可逆。
     */
    async restore(id, options = {}) {
        const cwd = options.cwd ?? process.cwd();
        const found = await this.find(id, cwd);
        if (!found) {
            throw devkitError('CHECKPOINT_NOT_FOUND', `找不到快照 ${id}（项目 ${path.resolve(cwd)}）`);
        }
        const { dir, meta } = found;

        // 恢复前先记录当前状态，使“恢复”本身也可撤销。
        await this.capture({ path: meta.path, tool: 'fs_restore', cwd, reason: 'pre-restore' });

        if (meta.existed === false) {
            await fs.rm(meta.path, { force: true });
            return { ok: true, path: meta.path, action: 'removed', id };
        }

        const blob = path.join(dir, `${meta.id}.bin`);
        let content;
        try {
            content = await fs.readFile(blob);
        } catch {
            throw devkitError('CHECKPOINT_BLOB_MISSING', `快照 ${id} 的内容文件已丢失`);
        }
        await fs.mkdir(path.dirname(meta.path), { recursive: true });
        await fs.writeFile(meta.path, content);
        return { ok: true, path: meta.path, action: 'restored', bytes: content.length, id };
    }
}
