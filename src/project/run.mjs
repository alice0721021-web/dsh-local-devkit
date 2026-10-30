/**
 * 运行单个检查目标并收集结构化结果。
 *
 * @module dsh-devkit/project/run
 */
import path from 'node:path';
import { runCommand } from '../exec.mjs';
import { nodeBinary } from '../env.mjs';

const MAX_OUTPUT_CHARS = 8_000;
const MAX_FAILURES = 10;

/**
 * DSH 进程里的 node 通常不在 PATH，而 package.json 的 script 大量依赖裸 `node`。
 * 执行前把当前 node 的目录前置到 PATH，否则 `pnpm run test` 会以 ENOENT 失败。
 */
function childEnv() {
    const nodeDir = path.dirname(nodeBinary());
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    const current = process.env[pathKey] ?? '';
    return {
        ...process.env,
        [pathKey]: current === '' ? nodeDir : `${nodeDir}${path.delimiter}${current}`,
    };
}

function truncate(text) {
    if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
    return { text: `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated ${text.length - MAX_OUTPUT_CHARS} chars]`, truncated: true };
}

/** 从输出里抓取失败行，给模型一个可读的失败摘要。 */
export function extractFailures(text) {
    const lines = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === '') continue;
        if (/^(FAIL|✗|✖|not ok|AssertionError|Error:)/i.test(line) || /\bfailed\b/i.test(line)) {
            lines.push(line.slice(0, 240));
            if (lines.length >= MAX_FAILURES) break;
        }
    }
    if (lines.length === 0) {
        // 没匹配到典型失败行时，退回到输出尾部，至少让调用方看到上下文。
        const tail = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-5);
        lines.push(...tail.map((line) => line.slice(0, 240)));
    }
    return lines;
}

/** 合并匹配到的失败行与 stderr 尾部，去重后限量。 */
function mergeFailures(lines, stderr) {
    const tail = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-3);
    const merged = [];
    for (const line of [...lines, ...tail]) {
        const trimmed = line.slice(0, 240);
        if (!merged.includes(trimmed)) merged.push(trimmed);
    }
    return merged.slice(0, MAX_FAILURES);
}

/**
 * 执行一个 target。失败不抛异常，而是返回 ok:false 与错误码。
 */
export async function runTarget(target, runner, options = {}) {
    const { cwd, timeoutMs = 180_000, signal } = options;
    const started = Date.now();
    let result;
    try {
        result = await runCommand(runner.bin, [...(runner.baseArgs ?? []), ...(target.args ?? [])], {
            cwd,
            timeoutMs,
            signal,
            maxBuffer: 8_000_000,
            env: childEnv(),
        });
    } catch (error) {
        return {
            target: target.target,
            script: target.script,
            command: target.command,
            ok: false,
            code: error?.devkitCode ?? 'EXEC_ERROR',
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - started,
        };
    }
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    const { text, truncated } = truncate(combined);
    return {
        target: target.target,
        script: target.script,
        command: target.command,
        ok: result.code === 0,
        exitCode: result.code,
        durationMs: Date.now() - started,
        output: text,
        truncated,
        failures: result.code === 0 ? [] : mergeFailures(extractFailures(combined), result.stderr),
    };
}
