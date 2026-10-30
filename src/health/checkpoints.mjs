/**
 * 本插件的快照状态：总条数与最后产出时间。
 *
 * @module dsh-devkit/health/checkpoints
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * @param {string} root 快照根目录
 */
export async function readCheckpointStatus(root) {
    let names;
    try {
        names = await fs.readdir(root);
    } catch {
        return { installed: false, total: 0, newest: null };
    }

    let total = 0;
    let newest = null;
    for (const name of names) {
        const dir = path.join(root, name);
        let entries;
        try {
            entries = await fs.readdir(dir);
        } catch {
            continue;
        }
        for (const file of entries) {
            if (!file.endsWith('.json')) continue;
            try {
                const stat = await fs.stat(path.join(dir, file));
                total += 1;
                if (newest === null || stat.mtimeMs > newest) newest = stat.mtimeMs;
            } catch {
                // 统计失败不影响其它条目。
            }
        }
    }
    return { installed: true, total, newest };
}
