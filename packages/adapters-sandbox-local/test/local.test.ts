/**
 * The local sandbox adapter, against real processes.
 *
 * The point of a sandbox is what it refuses, so most of this is refusal:
 * traversal, cancellation, timeout, a command that will not start, output that
 * will not stop. The two effectful things that cannot be provoked on demand —
 * a working directory that will not delete, and a `spawn` that throws before
 * the process exists — are reached through the one injected seam and a command
 * argument node rejects outright, not by stubbing the adapter's own logic.
 */

import { existsSync, readFileSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { SandboxError } from '@genesis/sandbox';
import { describe, expect, test } from 'vitest';
import {
  asError,
  containedPath,
  DEFAULT_MAX_OUTPUT_BYTES,
  exitCodeOf,
  LocalSandboxProvider,
  OutputCapture,
} from '../src/local.js';

const isWin = platform() === 'win32';

/** Node is the one interpreter guaranteed present, so every scripted case uses it. */
const node = (script: string): string[] => [process.execPath, '-e', script];

const sandboxDirs = async (): Promise<string[]> =>
  (await readdir(tmpdir())).filter((name) => name.startsWith('genesis-sandbox-'));

describe('containedPath', () => {
  const root = isWin ? 'C:\\work\\box' : '/work/box';

  test('accepts a plain relative path', () => {
    expect(containedPath(root, 'a.txt')).toBe(join(root, 'a.txt'));
  });

  test('accepts a nested relative path', () => {
    expect(containedPath(root, 'src/deep/a.txt')).toBe(join(root, 'src', 'deep', 'a.txt'));
  });

  test('refuses a traversal', () => {
    expect(containedPath(root, '../escaped.txt')).toBeNull();
  });

  test('refuses the traversal that the old sanitiser rewrote into an escape', () => {
    // '../../foo' through a regex that blanks `../` once becomes '/../foo',
    // which still escapes. Resolution-then-containment cannot be fooled by it.
    expect(containedPath(root, '../../foo')).toBeNull();
  });

  test('refuses an absolute path', () => {
    expect(containedPath(root, isWin ? 'C:\\Windows\\system.ini' : '/etc/passwd')).toBeNull();
  });

  test('refuses the working directory itself', () => {
    expect(containedPath(root, '')).toBeNull();
    expect(containedPath(root, '.')).toBeNull();
  });

  test('refuses a sibling directory that merely shares a prefix', () => {
    expect(containedPath(root, `..${sep}box-evil${sep}a.txt`)).toBeNull();
  });
});

describe('exitCodeOf', () => {
  test('passes a real exit code through', () => {
    expect(exitCodeOf(0)).toBe(0);
    expect(exitCodeOf(42)).toBe(42);
  });

  test('reads a signalled process as a failure, not a success', () => {
    expect(exitCodeOf(null)).toBe(1);
  });
});

describe('asError', () => {
  test('passes an Error through unchanged', () => {
    const original = new Error('boom');
    expect(asError(original)).toBe(original);
  });

  test('wraps a non-Error so its text survives', () => {
    expect(asError('boom').message).toBe('boom');
  });
});

describe('OutputCapture', () => {
  test('keeps everything below the ceiling', () => {
    const capture = new OutputCapture(16);
    capture.add(Buffer.from('abc'));
    expect(capture.text).toBe('abc');
    expect(capture.truncated).toBe(false);
  });

  test('keeps the prefix that fits and drops the rest', () => {
    const capture = new OutputCapture(4);
    capture.add(Buffer.from('abcdefgh'));
    expect(capture.text).toBe('abcd');
    expect(capture.truncated).toBe(true);
  });

  test('drops a chunk that arrives after the ceiling', () => {
    const capture = new OutputCapture(4);
    capture.add(Buffer.from('abcd'));
    capture.add(Buffer.from('efgh'));
    expect(capture.text).toBe('abcd');
  });

  test('a zero ceiling keeps nothing', () => {
    const capture = new OutputCapture(0);
    capture.add(Buffer.from('abc'));
    expect(capture.text).toBe('');
    expect(capture.truncated).toBe(true);
  });
});

describe('LocalSandboxProvider', () => {
  const provider = new LocalSandboxProvider();

  test('runs a command and returns its output', async () => {
    const result = await provider.run({ command: node('process.stdout.write("hello")'), timeoutMs: 5_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('captures stderr separately from stdout', async () => {
    const result = await provider.run({
      command: node('process.stdout.write("out");process.stderr.write("err")'),
      timeoutMs: 5_000,
    });
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
  });

  test('a non-zero exit is a result, not an error', async () => {
    const result = await provider.run({ command: node('process.exit(42)'), timeoutMs: 5_000 });
    expect(result.exitCode).toBe(42);
  });

  test('stages files into the working directory', async () => {
    const result = await provider.run({
      command: node('process.stdout.write(require("fs").readFileSync("nested/hello.txt","utf8"))'),
      timeoutMs: 5_000,
      files: { 'nested/hello.txt': 'sandbox content' },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('sandbox content');
  });

  test('passes the requested environment through', async () => {
    const result = await provider.run({
      command: node('process.stdout.write(process.env.GENESIS_TEST_VAR ?? "unset")'),
      timeoutMs: 5_000,
      env: { GENESIS_TEST_VAR: 'present' },
    });
    expect(result.stdout).toBe('present');
  });

  test('each run gets its own working directory, and it is gone afterwards', async () => {
    const before = await sandboxDirs();
    const result = await provider.run({
      command: node('process.stdout.write(process.cwd())'),
      timeoutMs: 5_000,
    });
    const workDir = result.stdout;
    expect(workDir).toContain('genesis-sandbox-');
    expect(existsSync(workDir)).toBe(false);
    expect(await sandboxDirs()).toEqual(before);
  });

  // ---------------------------------------------------------------- refusals

  test('refuses a request that names no command, without creating anything', async () => {
    const before = await sandboxDirs();
    await expect(provider.run({ command: [], timeoutMs: 5_000 })).rejects.toThrow(
      expect.objectContaining({ kind: 'SETUP_FAILED', message: expect.stringContaining('names no command') }),
    );
    expect(await sandboxDirs()).toEqual(before);
  });

  test('refuses a staged file that escapes the sandbox, and leaves no directory behind', async () => {
    const before = await sandboxDirs();
    const escapee = join(tmpdir(), 'genesis-escape-proof.txt');
    await expect(
      provider.run({
        command: node('process.exit(0)'),
        timeoutMs: 5_000,
        files: { '../../genesis-escape-proof.txt': 'escaped' },
      }),
    ).rejects.toThrow(expect.objectContaining({ kind: 'SETUP_FAILED', message: expect.stringContaining('outside the sandbox') }));
    expect(existsSync(escapee)).toBe(false);
    expect(await sandboxDirs()).toEqual(before);
  });

  test('reports a staging failure as SETUP_FAILED and cleans up', async () => {
    const before = await sandboxDirs();
    // 'a' is written as a file, then 'a/b' asks for 'a' to be a directory.
    await expect(
      provider.run({ command: node('process.exit(0)'), timeoutMs: 5_000, files: { a: 'file', 'a/b': 'impossible' } }),
    ).rejects.toThrow(expect.objectContaining({ kind: 'SETUP_FAILED', message: expect.stringContaining('could not prepare') }));
    expect(await sandboxDirs()).toEqual(before);
  });

  test('reports a command that cannot be started', async () => {
    const before = await sandboxDirs();
    await expect(provider.run({ command: ['genesis-no-such-binary-xyz'], timeoutMs: 5_000 })).rejects.toThrow(
      expect.objectContaining({ kind: 'SETUP_FAILED', message: expect.stringContaining('genesis-no-such-binary-xyz') }),
    );
    expect(await sandboxDirs()).toEqual(before);
  });

  test('reports a command node refuses outright, before any process exists', async () => {
    const before = await sandboxDirs();
    // A null byte is rejected synchronously by spawn: there is never a child.
    await expect(provider.run({ command: ['bad\u0000name'], timeoutMs: 5_000 })).rejects.toThrow(
      expect.objectContaining({ kind: 'SETUP_FAILED' }),
    );
    expect(await sandboxDirs()).toEqual(before);
  });

  // ------------------------------------------------------- time and interrupt

  test('kills a process that outruns its timeout', async () => {
    const before = await sandboxDirs();
    await expect(
      provider.run({ command: node('setTimeout(() => {}, 60_000)'), timeoutMs: 150 }),
    ).rejects.toThrow(expect.objectContaining({ kind: 'TIMEOUT', message: expect.stringContaining('timed out after 150ms') }));
    expect(await sandboxDirs()).toEqual(before);
  });

  test('a timeout of zero means no timer, and a quick command still finishes', async () => {
    const result = await provider.run({ command: node('process.stdout.write("no timer")'), timeoutMs: 0 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('no timer');
  });

  test('refuses before starting when the signal is already aborted', async () => {
    const before = await sandboxDirs();
    const controller = new AbortController();
    controller.abort();
    await expect(provider.run({ command: node('process.exit(0)'), timeoutMs: 5_000 }, controller.signal)).rejects.toThrow(
      expect.objectContaining({ kind: 'CANCELLED', message: expect.stringContaining('before starting') }),
    );
    expect(await sandboxDirs()).toEqual(before);
  });

  test('cancels a running process and cleans up', async () => {
    const before = await sandboxDirs();
    const controller = new AbortController();
    const running = provider.run({ command: node('setTimeout(() => {}, 60_000)'), timeoutMs: 30_000 }, controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 50);
    await expect(running).rejects.toThrow(expect.objectContaining({ kind: 'CANCELLED' }));
    expect(await sandboxDirs()).toEqual(before);
  });

  test('a signal that never fires does not hold the run open', async () => {
    const controller = new AbortController();
    const result = await provider.run({ command: node('process.stdout.write("done")'), timeoutMs: 5_000 }, controller.signal);
    expect(result.stdout).toBe('done');
    // Aborting afterwards must not reject an already-settled run.
    controller.abort();
  });

  test('the first outcome wins: a close after a timeout does not resolve the run', async () => {
    // The child exits shortly after the deadline, so `close` arrives once the
    // run has already failed. It must stay failed.
    const outcome = await provider
      .run({ command: node('setTimeout(() => {}, 300)'), timeoutMs: 60 })
      .then(() => 'resolved' as const, (error: unknown) => error);
    expect(outcome).toBeInstanceOf(SandboxError);
    expect((outcome as SandboxError).kind).toBe('TIMEOUT');
    await new Promise((r) => setTimeout(r, 400));
  });

  // ------------------------------------------------------------- limits, seam

  test('truncates output at the configured ceiling', async () => {
    const small = new LocalSandboxProvider({ maxOutputBytes: 8 });
    const result = await small.run({
      command: node('process.stdout.write("x".repeat(100000));process.stderr.write("y".repeat(100000))'),
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('xxxxxxxx');
    expect(result.stderr).toBe('yyyyyyyy');
  });

  test('the default ceiling is a megabyte per stream', () => {
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBe(1024 * 1024);
  });

  test('a working directory that will not delete does not change the result', async () => {
    let attempted = '';
    const stubborn = new LocalSandboxProvider({
      removeDir: (dir) => {
        attempted = dir;
        return Promise.reject(new Error('EBUSY: directory in use'));
      },
    });
    const result = await stubborn.run({ command: node('process.stdout.write("still fine")'), timeoutMs: 5_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('still fine');
    expect(attempted).toContain('genesis-sandbox-');
    // The real directory is still there, because removal was stubbed out.
    expect(existsSync(attempted)).toBe(true);
    await rm(attempted, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  });

  test('a working directory that will not delete does not mask a staging failure', async () => {
    const stubborn = new LocalSandboxProvider({
      removeDir: () => Promise.reject(new Error('EBUSY: directory in use')),
    });
    await expect(
      stubborn.run({ command: node('process.exit(0)'), timeoutMs: 5_000, files: { '../out.txt': 'no' } }),
    ).rejects.toThrow(expect.objectContaining({ kind: 'SETUP_FAILED', message: expect.stringContaining('outside the sandbox') }));
  });

  test('the sandbox does not inherit the caller working directory', async () => {
    const result = await provider.run({ command: node('process.stdout.write(process.cwd())'), timeoutMs: 5_000 });
    expect(result.stdout).not.toBe(process.cwd());
  });

  test('a staged file is written with exactly the requested bytes', async () => {
    const result = await provider.run({
      command: node('process.stdout.write(String(require("fs").statSync("blob.bin").size))'),
      timeoutMs: 5_000,
      files: { 'blob.bin': new Uint8Array([1, 2, 3, 4, 5]) },
    });
    expect(result.stdout).toBe('5');
  });
});

describe('the escape proof is a real one', () => {
  test('the sanitiser this adapter replaced really did escape', () => {
    // Kept as a regression witness: if anyone reintroduces pattern-rewriting,
    // this is the input that walks straight out of the sandbox.
    const rewritten = '../../foo'.replace(/\\/g, '/').replace(/(^|\/)\.\.(\/|$)/g, '/');
    expect(rewritten).toBe('/../foo');
    expect(containedPath(isWin ? 'C:\\w' : '/w', rewritten)).toBeNull();
  });

  test('nothing was written outside any sandbox during this suite', () => {
    expect(existsSync(join(tmpdir(), 'genesis-escape-proof.txt'))).toBe(false);
  });
});

// A guard against the suite silently testing a stale build of the adapter.
test('the adapter under test is the one in src', () => {
  const source = readFileSync(new URL('../src/local.ts', import.meta.url), 'utf8');
  expect(source).toContain('containedPath');
  expect(source).not.toContain('replace(/(^|\\/)\\.\\.');
});
