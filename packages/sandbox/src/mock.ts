import { SandboxError } from './errors.js';
import { type SandboxProvider, type SandboxRequest, type SandboxResult } from './port.js';

export interface MockSandboxRule {
  matchCommand: string[];
  delayMs?: number;
  result?: SandboxResult;
  /**
   * What the run throws. Deliberately `unknown`: a real provider can fail in
   * ways that are not a `SandboxError`, or not an `Error` at all, and every
   * caller has to classify whatever arrives. A mock that could only throw the
   * typed error would leave that classification untested.
   */
  error?: unknown;
}

export class MockSandboxProvider implements SandboxProvider {
  public calls: SandboxRequest[] = [];
  
  constructor(private readonly rules: MockSandboxRule[] = []) {}
  
  async run(request: SandboxRequest, abortSignal?: AbortSignal): Promise<SandboxResult> {
    this.calls.push(request);
    
    // Find matching rule
    const rule = this.rules.find(r => 
      r.matchCommand.length === request.command.length &&
      r.matchCommand.every((part, i) => part === request.command[i])
    );
    
    if (abortSignal?.aborted) {
      throw new SandboxError('CANCELLED', 'Sandbox run cancelled before starting');
    }
    
    // Simulate delay
    const delay = rule?.delayMs ?? 0;
    if (delay > 0 || request.timeoutMs > 0 || abortSignal) {
      await new Promise<void>((resolve, reject) => {
        let timeoutId: NodeJS.Timeout | undefined;
        let abortListener: (() => void) | undefined;
        
        const cleanup = () => {
          if (timeoutId) clearTimeout(timeoutId);
          if (abortSignal && abortListener) {
            abortSignal.removeEventListener('abort', abortListener);
          }
        };

        if (abortSignal) {
          abortListener = () => {
            cleanup();
            reject(new SandboxError('CANCELLED', 'Sandbox run cancelled'));
          };
          abortSignal.addEventListener('abort', abortListener);
        }
        
        // Timeout check (if the mock delay exceeds the request timeout)
        if (delay > request.timeoutMs) {
          timeoutId = setTimeout(() => {
            cleanup();
            reject(new SandboxError('TIMEOUT', `Sandbox execution timed out after ${request.timeoutMs}ms`));
          }, request.timeoutMs);
        } else if (delay > 0) {
          timeoutId = setTimeout(() => {
            cleanup();
            resolve();
          }, delay);
        } else {
          resolve();
        }
      });
    }

    if (rule?.error !== undefined) {
      throw rule.error;
    }
    
    if (rule?.result) {
      return rule.result;
    }
    
    // Default success
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: delay,
    };
  }
}
