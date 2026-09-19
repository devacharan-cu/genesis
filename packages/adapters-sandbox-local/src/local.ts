import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { SandboxError, type SandboxProvider, type SandboxRequest, type SandboxResult } from '@genesis/sandbox';

export class LocalSandboxProvider implements SandboxProvider {
  /**
   * Limit stdout/stderr capture to avoid memory exhaustion from runaway processes.
   * Defaults to 1MB per stream.
   */
  constructor(private readonly maxOutputBytes = 1024 * 1024) {}

  async run(request: SandboxRequest, abortSignal?: AbortSignal): Promise<SandboxResult> {
    if (abortSignal?.aborted) {
      throw new SandboxError('CANCELLED', 'Sandbox run cancelled before starting');
    }

    let workDir: string | undefined;
    
    try {
      // 1. Setup isolated directory
      workDir = await mkdtemp(join(tmpdir(), 'genesis-sandbox-'));
      
      if (request.files) {
        for (const [relPath, content] of Object.entries(request.files)) {
          // Prevent directory traversal attacks if someone passes '../foo'
          const safePath = relPath.replace(/\\/g, '/').replace(/(^|\/)\.\.(\/|$)/g, '/');
          const fullPath = join(workDir, safePath);
          await mkdir(dirname(fullPath), { recursive: true });
          await writeFile(fullPath, content);
        }
      }
    } catch (e) {
      throw new SandboxError('SETUP_FAILED', `Failed to initialize sandbox environment: ${(e as Error).message}`, e as Error);
    }

    // 2. Execution
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let isDone = false;

      const cmd = request.command[0];
      if (!cmd) {
        throw new SandboxError('SETUP_FAILED', 'Empty command');
      }

      // Spawn the process
      const child = spawn(cmd, request.command.slice(1), {
        cwd: workDir,
        env: { ...process.env, ...request.env },
        // Windows needs shell for things like 'npm', but this is a sandbox adapter. 
        // We will default shell: false to avoid command injection, but callers must use the right binary (e.g. 'npm.cmd' on win).
        shell: false, 
      });

      let timeoutId: NodeJS.Timeout | undefined;
      let abortListener: (() => void) | undefined;

      const cleanup = async () => {
        if (isDone) return;
        isDone = true;
        
        if (timeoutId) clearTimeout(timeoutId);
        if (abortSignal && abortListener) {
          abortSignal.removeEventListener('abort', abortListener);
        }

        // 3. Teardown
        if (workDir) {
          try {
            await rm(workDir, { recursive: true, force: true });
          } catch {
            // Teardown failures after success shouldn't fail the result, but in a real isolated system we'd log this.
            // If the process was killed, the cleanup might fail on Windows if handles are still open.
          }
        }
      };

      const finishWithError = async (error: SandboxError) => {
        // Force kill the child process
        try {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        } catch {
          // ignore kill errors
        }
        await cleanup();
        reject(error);
      };

      if (abortSignal) {
        abortListener = () => finishWithError(new SandboxError('CANCELLED', 'Sandbox run cancelled'));
        abortSignal.addEventListener('abort', abortListener);
        if (abortSignal.aborted) {
          abortListener();
        }
      }

      if (request.timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          finishWithError(new SandboxError('TIMEOUT', `Sandbox execution timed out after ${request.timeoutMs}ms`));
        }, request.timeoutMs);
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdoutBytes < this.maxOutputBytes) {
          const toAdd = chunk.subarray(0, this.maxOutputBytes - stdoutBytes);
          stdout += toAdd.toString('utf8');
          stdoutBytes += toAdd.length;
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrBytes < this.maxOutputBytes) {
          const toAdd = chunk.subarray(0, this.maxOutputBytes - stderrBytes);
          stderr += toAdd.toString('utf8');
          stderrBytes += toAdd.length;
        }
      });

      child.on('error', async (err) => {
        if (isDone) return;
        await finishWithError(new SandboxError('UNKNOWN', `Process spawn or execution failed: ${err.message}`, err));
      });

      child.on('close', async (code) => {
        if (isDone) return;
        await cleanup();
        resolve({
          exitCode: code ?? 1, // If killed/interrupted, treat as non-zero
          stdout,
          stderr,
          durationMs: Date.now() - startTime,
        });
      });
    });
  }
}
