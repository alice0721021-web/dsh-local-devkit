/**
 * profile 一致性检查：bundles 声明的包是否真的装上了。
 *
 * @module dsh-devkit/health/profile
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { profileDir } from '../env.mjs';

/**
 * @param {string} [name]
 * @returns {Promise<object>}
 */
export async function readProfileStatus(name) {
    const dir = profileDir(name);
    let pkg;
    try {
        pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    } catch {
        return { ok: false, code: 'NO_PROFILE', dir };
    }

    const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
    const dependencies = pkg?.dependencies ?? {};
    // 只检查同时出现在 dependencies 里的 bundle：@deepseek-ai/* 这类官方包由
    // DSH 本体提供，本来就不在 profile 的 node_modules 里。
    const checkable = bundles.filter((bundle) => Object.hasOwn(dependencies, String(bundle)));
    const missing = [];
    for (const bundle of checkable) {
        const target = path.join(dir, 'node_modules', ...String(bundle).split('/'));
        try {
            await fs.access(target);
        } catch {
            missing.push(String(bundle));
        }
    }

    let patchMentionsDevkit = false;
    try {
        const patch = await fs.readFile(path.join(dir, 'cordis.patch.yml'), 'utf8');
        patchMentionsDevkit = patch.includes('dsh-local-devkit') || patch.includes('dsh-devkit');
    } catch {
        // 没有 patch 文件时保持 false。
    }

    return {
        ok: missing.length === 0,
        dir,
        bundles: bundles.length,
        dependencies: Object.keys(dependencies).length,
        missing,
        patchMentionsDevkit,
    };
}
