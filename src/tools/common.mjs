/**
 * 工具层共享工具函数。
 *
 * @module dsh-devkit/tools/common
 */
import path from 'node:path';

export function asRecord(value) {
    return typeof value === 'object' && value !== null ? value : {};
}

export function optionalString(args, key) {
    const value = args[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function stringArray(args, key) {
    const value = args[key];
    if (!Array.isArray(value)) return [];
    return value
        .filter((item) => typeof item === 'string' && item.trim() !== '')
        .map((item) => item.trim());
}

export function limitInt(raw, min, max, fallback) {
    if (typeof raw !== 'number' || !Number.isInteger(raw)) return fallback;
    return Math.min(max, Math.max(min, raw));
}

/** 解析工作目录：参数优先，其次会话 cwd，最后进程 cwd。 */
export function resolveCwd(args, exec) {
    const explicit = optionalString(args, 'cwd');
    if (explicit) return path.resolve(explicit);
    const fromSession = exec?.agent?.session?.header?.cwd;
    if (typeof fromSession === 'string' && fromSession !== '') return path.resolve(fromSession);
    return process.cwd();
}

/** 把异常转成结构化工具返回值。 */
export function errorValue(error) {
    const code = error?.devkitCode ?? 'TOOL_ERROR';
    return {
        ok: false,
        code,
        error: error instanceof Error ? error.message : String(error),
        ...(code === 'PATH_OUTSIDE_REPO' || code === 'BINARY_MISSING' ? { fatal: false } : {}),
    };
}

/** 中断（用户取消）必须继续向上抛，不能被工具层吞掉。 */
export function shouldRethrow(error, signal) {
    return signal?.aborted === true || error?.devkitCode === 'ABORTED';
}

export function renderFailure(value) {
    const lines = [`失败：${value.code}`];
    if (value.error) lines.push(String(value.error));
    if (value.code === 'NO_REPO') lines.push('当前目录不在 git 仓库内；换到仓库目录或先 git init。');
    return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * DSH 要求工具返回值是 lossless JSON：undefined 会让序列化丢字段并被判为非法。
 * 用一次 JSON round-trip 剔除 undefined，顶层 undefined 降级为 null。
 */
export function lossless(value) {
    if (value === undefined) return null;
    return JSON.parse(JSON.stringify(value));
}
