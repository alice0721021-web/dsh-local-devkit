/**
 * dsh-recall-plugin 快照状态：最后产出时间、条目数、是否覆盖当前工作区。
 *
 * 背景：它按 maxWorkspaceBytes（默认 256 MB）在工作区超限时静默停用快照，
 * 进程与心跳仍然正常，只能通过 index.json 是否更新来发现。
 *
 * @module dsh-devkit/health/recall
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { dshHome } from '../env.mjs';

export function recallSnapshotsRoot() {
    return path.join(dshHome(), 'dsh-recall-snapshots');
}

/**
 * 读取 recall 的排除表（gitignore 语法），返回顶层目录名集合。
 *
 * 只取每条规则的第一段并去掉尾部斜杠，用于让工作区体积统计与插件的实际排除接近；
 * 对多级路径是保守近似（会多排一点，而不是少排）。
 */
export async function readRecallExcludes() {
    const names = new Set();
    let text;
    try {
        text = await fs.readFile(path.join(recallSnapshotsRoot(), 'exclude.txt'), 'utf8');
    } catch {
        return names;
    }
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
        const name = line.replace(/\/+$/, '').replace(/^\//, '').split('/')[0];
        if (name && name !== '*') names.add(name);
    }
    return names;
}

function samePath(a, b) {
    const left = path.resolve(a);
    const right = path.resolve(b);
    return process.platform === 'win32'
        ? left.toLowerCase() === right.toLowerCase()
        : left === right;
}

/**
 * 读取 recall 的全部项目快照状态，并找出当前工作区对应的那一份。
 *
 * @param {string} cwd
 * @returns {Promise<{installed: boolean, projects: object[], forCwd: object|null}>}
 */
export async function readRecallStatus(cwd) {
    const root = recallSnapshotsRoot();
    let names;
    try {
        names = await fs.readdir(root);
    } catch {
        return { installed: false, projects: [], forCwd: null };
    }

    const projects = [];
    for (const name of names) {
        const dir = path.join(root, name);
        let stat;
        try {
            stat = await fs.stat(dir);
        } catch {
            continue;
        }
        if (!stat.isDirectory()) continue;

        let projectRoot = null;
        try {
            projectRoot = (await fs.readFile(path.join(dir, 'root.txt'), 'utf8')).trim() || null;
        } catch {
            // 没有 root.txt 视为未知项目。
        }

        let entries = 0;
        let newest = null;
        try {
            const list = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8'));
            if (Array.isArray(list)) {
                entries = list.length;
                for (const item of list) {
                    if (typeof item?.time === 'number' && (newest === null || item.time > newest)) {
                        newest = item.time;
                    }
                }
            }
        } catch {
            // index.json 缺失或损坏时保留 0 条。
        }

        let heartbeat = null;
        try {
            const text = (await fs.readFile(path.join(dir, 'heartbeat'), 'utf8')).trim();
            const [pid, stamp] = text.split(/\s+/);
            heartbeat = { pid: Number(pid) || null, at: Number(stamp) ? Number(stamp) * 1000 : null };
        } catch {
            // 心跳文件可选。
        }

        projects.push({ id: name, root: projectRoot, entries, newest, heartbeat });
    }

    const forCwd = projects.find((project) => project.root && samePath(project.root, cwd)) ?? null;
    return { installed: true, projects, forCwd };
}
