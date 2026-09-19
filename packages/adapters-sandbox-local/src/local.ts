/**
 * The local sandbox adapter: a child process in a fresh temporary directory
 * (ADR-0019, SPEC-06 §4 tier 1).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). This is the only place in the repository that
 * starts a process, so what it refuses matters as much as what it runs:
 *
 *   - Staged files are resolved against the working directory and must land
 *     inside it. A path that escapes is refused, never rewritten: rewriting a
 *     traversal is how one survives, since a sanitiser that turns `../../x`
 *     into `/../x` has escaped while looking careful.
 *   - The working directory is created only once the request is known to name
 *     a command, and it is removed on every exit path — timeout, cancellation,
 *     a spawn that never started, and a staging error.
 *   - Output is captured under a byte ceiling per stream, so a runaway process
 *     exhausts its own time rather than this process's memory.
 *   - The first outcome wins. A timeout kills the child and settles; the
 *     `close` that follows is ignored rather than resolving a run that already
 *     failed.
 *
 * A non-zero exit is a result, not an error: the experiment that fails is the
 * reason for running it. Only the sandbox failing at its own job throws.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { SandboxError, type SandboxProvider, type SandboxRequest, type SandboxResult } from '@genesis/sandbox';

/** Per stream. Far more than any check's output, and far less than a leak. */
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface LocalSandboxOptions {
  /** Ceiling on captured stdout, and separately on captured stderr, in bytes. */
  readonly maxOutputBytes?: number;
  /**
   * How the working directory is removed. Injected only so the teardown
   * failure path can be exercised; the default is the real removal.
   */
  readonly removeDir?: (dir: string) => Promise<void>;
}

/**
 * The absolute path `relPath` names inside `workDir`, or null when it names
 * anything else. Containment is decided after resolution, so `..`, an absolute
 * path and a Windows drive letter are each judged by where they actually land.
 * The trailing separator is what stops `/w2` passing as a child of `/w`.
 */
export function containedPath(workDir: string, relPath: string): string | null {
  const root = resolve(workDir);
  const target = resolve(root, relPath);
  return target.startsWith(root + sep) ? target : null;
}

/**
 * A process terminated by a signal reports no exit code. That is a failure the
 * caller must see, not an absence to be read as success.
 */
export const exitCodeOf = (code: number | null): number => code ?? 1;

/** Node rejects with Errors; anything else is still worth reporting faithfully. */
export const asError = (thrown: unknown): Error => (thrown instanceof Error ? thrown : new Error(String(thrown)));

/** Captures a stream up to a byte ceiling, dropping the rest. */
export class OutputCapture {
  #text = '';
  #bytes = 0;

  constructor(private readonly limit: number) {}

  add(chunk: Buffer): void {
    const room = this.limit - this.#bytes;
    if (room <= 0) return;
    const kept = chunk.subarray(0, room);
    this.#text += kept.toString('utf8');
    this.#bytes += kept.length;
  }

  get text(): string {
    return this.#text;
  }

  /** True once the ceiling has been reached and further output is being dropped. */
  get truncated(): boolean {
    return this.#bytes >= this.limit;
  }
}

/**
 * Removal retries because a just-killed child still holds its working
 * directory open for a moment — on Windows reliably so, and the first attempt
 * fails with EBUSY. Without the retries the sandbox leaks a directory per
 * timeout and per cancellation, which is every interesting case.
 */
const removeRecursively = async (dir: string): Promise<void> => {
  await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
};

export class LocalSandboxProvider implements SandboxProvider {
  readonly #maxOutputBytes: number;
  readonly #removeDir: (dir: string) => Promise<void>;

  constructor(options: LocalSandboxOptions = {}) {
    this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.#removeDir = options.removeDir ?? removeRecursively;
  }

  async run(request: SandboxRequest, abortSignal?: AbortSignal): Promise<SandboxResult> {
    if (abortSignal?.aborted === true) {
      throw new SandboxError('CANCELLED', 'sandbox run cancelled before starting');
    }

    // Checked before anything is created, so a request that cannot run leaves
    // nothing behind to clean up.
    const cmd = request.command[0];
    if (cmd === undefined) {
      throw new SandboxError('SETUP_FAILED', 'a sandbox request names no command');
    }

    const workDir = await this.#stage(request, cmd);
    const child = await this.#spawn(request, cmd, workDir);
    return this.#await(request, cmd, workDir, child, abortSignal);
  }

  /** A fresh working directory holding exactly the requested files, and nothing outside it. */
  async #stage(request: SandboxRequest, cmd: string): Promise<string> {
    const workDir = await mkdtemp(join(tmpdir(), 'genesis-sandbox-'));
    try {
      for (const [relPath, content] of Object.entries(request.files ?? {})) {
        const fullPath = containedPath(workDir, relPath);
        if (fullPath === null) {
          throw new SandboxError('SETUP_FAILED', `staged file ${JSON.stringify(relPath)} resolves outside the sandbox`);
        }
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, content);
      }
      return workDir;
    } catch (thrown) {
      await this.#discard(workDir);
      if (thrown instanceof SandboxError) throw thrown;
      const error = asError(thrown);
      throw new SandboxError('SETUP_FAILED', `could not prepare the sandbox for ${cmd}: ${error.message}`, error);
    }
  }

  /**
   * Starting the child is its own step because `spawn` can refuse an argument
   * outright — a null byte in the command, say — and that must not leave a
   * working directory behind.
   */
  async #spawn(request: SandboxRequest, cmd: string, workDir: string): Promise<ChildProcessWithoutNullStreams> {
    try {
      // No `stdio` option, so node types both pipes as present rather than
      // nullable, and there is no absent-stream branch to pretend to test.
      return spawn(cmd, request.command.slice(1), {
        cwd: workDir,
        env: { ...process.env, ...request.env },
        // Never a shell: the command is an argv, and an argv a shell re-parses
        // is an injection waiting for an argument with a space in it.
        shell: false,
      });
    } catch (thrown) {
      await this.#discard(workDir);
      const error = asError(thrown);
      throw new SandboxError('SETUP_FAILED', `could not start ${cmd}: ${error.message}`, error);
    }
  }

  #await(
    request: SandboxRequest,
    cmd: string,
    workDir: string,
    child: ChildProcessWithoutNullStreams,
    abortSignal?: AbortSignal,
  ): Promise<SandboxResult> {
    return new Promise<SandboxResult>((settleOk, settleErr) => {
      const startedAt = Date.now();
      const stdout = new OutputCapture(this.#maxOutputBytes);
      const stderr = new OutputCapture(this.#maxOutputBytes);

      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let detachAbort: (() => void) | null = null;

      /** The first outcome wins; everything after it is the aftermath. */
      const settle = (deliver: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (detachAbort !== null) detachAbort();
        void this.#discard(workDir).then(deliver);
      };

      /** Kills first: no result is reported while the child may still be writing. */
      const fail = (error: SandboxError): void => {
        child.kill('SIGKILL');
        settle(() => {
          settleErr(error);
        });
      };

      if (abortSignal !== undefined) {
        const onAbort = (): void => {
          fail(new SandboxError('CANCELLED', 'sandbox run cancelled'));
        };
        abortSignal.addEventListener('abort', onAbort);
        detachAbort = (): void => {
          abortSignal.removeEventListener('abort', onAbort);
        };
      }

      if (request.timeoutMs > 0) {
        timer = setTimeout(() => {
          fail(new SandboxError('TIMEOUT', `sandbox execution timed out after ${request.timeoutMs}ms`));
        }, request.timeoutMs);
      }

      child.stdout.on('data', (chunk: Buffer) => {
        stdout.add(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr.add(chunk);
      });

      // The child never started, or a kill could not be delivered. Either way
      // the run has no result; a late error after settling is the aftermath.
      child.on('error', (error: Error) => {
        settle(() => {
          settleErr(new SandboxError('SETUP_FAILED', `could not start ${cmd}: ${error.message}`, error));
        });
      });

      child.on('close', (code: number | null) => {
        settle(() => {
          settleOk({
            exitCode: exitCodeOf(code),
            stdout: stdout.text,
            stderr: stderr.text,
            durationMs: Date.now() - startedAt,
          });
        });
      });
    });
  }

  /**
   * Teardown never changes an outcome. A directory that will not go away is a
   * housekeeping problem, and reporting it as a wrong answer would be worse.
   */
  async #discard(workDir: string): Promise<void> {
    try {
      await this.#removeDir(workDir);
    } catch {
      // Deliberately swallowed; see above.
    }
  }
}
