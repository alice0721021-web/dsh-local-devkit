/**
 * 子进程执行封装：永不经过 shell，统一超时、缓冲与错误映射。
 *
 * @module dsh-devkit/exec
 */
import { execFile } from 'node:child_process';

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BUFFER = 1_000_000;
const STDERR_LIMIT = 2_000;

/** 生成带结构化 code 的错误，供工具层转成可读输出。 */
export function devkitError(code, message, extra = {}) {
    const error = new Error(message);
    error.devkitCode = code;
    return Object.assign(error, extra);
}

function truncate(text, limit) {
    if (text.length <= limit) return { text, truncated: false };
    return { text: `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`, truncated: true };
}

/**
 * 运行一个外部命令。
 *
 * @param {string} file 可执行文件
 * @param {string[]} args 参数数组
 * @param {{cwd?: string, timeoutMs?: number, maxBuffer?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export function runCommand(file, args, options = {}) {
    const { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER, signal, env } = options;
    return new Promise((resolve, reject) => {
        const child = execFile(file, args, {
            cwd,
            timeout: timeoutMs,
            maxBuffer,
            windowsHide: true,
            encoding: 'utf8',
            shell: false,
            signal,
            ...(env ? { env } : {}),
        }, (error, stdout, stderr) => {
            const out = typeof stdout === 'string' ? stdout : '';
            const err = typeof stderr === 'string' ? stderr : '';
            if (!error) {
                resolve({ code: 0, stdout: out, stderr: err });
                return;
            }
            if (signal?.aborted) {
                reject(signal.reason ?? devkitError('ABORTED', 'command aborted'));
                return;
            }
            if (error.name === 'AbortError') {
                reject(devkitError('ABORTED', 'command aborted'));
                return;
            }
            if (error.code === 'ENOENT') {
                reject(devkitError('BINARY_MISSING', `${file} not found`, { bin: file }));
                return;
            }
            if (error.killed === true || error.signal === 'SIGTERM') {
                reject(devkitError('TIMEOUT', `command timed out after ${timeoutMs}ms`, { bin: file }));
                return;
            }
            resolve({
                code: typeof error.code === 'number' ? error.code : 1,
                stdout: out,
                stderr: err,
            });
        });
        // 避免未处理的 error 事件让进程崩溃（execFile 已回调，这里只是兜底）。
        child.on('error', () => {});
    });
}

/** 把命令失败转成工具层可读的错误对象。 */
export function failureFrom(result, label) {
    const { text } = truncate(result.stderr.trim(), STDERR_LIMIT);
    return devkitError('COMMAND_FAILED', `${label} exited with code ${result.code}: ${text || '(no stderr)'}`);
}

export { truncate };
