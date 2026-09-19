export interface SandboxRequest {
  /** The command to execute (e.g. `['npm', 'run', 'test']`) */
  command: string[];
  
  /** Files to write to the sandbox before execution */
  files?: Record<string, string | Uint8Array>;
  
  /** Environment variables to expose to the process */
  env?: Record<string, string>;
  
  /** Maximum execution time in milliseconds before forceful termination */
  timeoutMs: number;
}

export interface SandboxResult {
  /** The process exit code (0 for success, non-zero for failure) */
  exitCode: number;
  
  /** Standard output, possibly truncated if extremely large */
  stdout: string;
  
  /** Standard error, possibly truncated if extremely large */
  stderr: string;
  
  /** Actual wall-clock duration of the execution */
  durationMs: number;
}

export interface SandboxProvider {
  /**
   * Executes a command in an isolated environment.
   * Throws a SandboxError if the execution times out, is cancelled, or fails to set up.
   * Normal process failures (e.g. exit code 1) do NOT throw; they return a SandboxResult.
   */
  run(request: SandboxRequest, abortSignal?: AbortSignal): Promise<SandboxResult>;
}

