import { describe, expect, test } from 'vitest';
import { LocalSandboxProvider } from '../src/local.js';
import { SandboxError } from '@genesis/sandbox';
import * as os from 'node:os';

describe('LocalSandboxProvider', () => {
  const isWin = os.platform() === 'win32';
  const provider = new LocalSandboxProvider();

  test('executes a basic command', async () => {
    const cmd = isWin ? ['cmd.exe', '/c', 'echo hello'] : ['echo', 'hello'];
    const result = await provider.run({ command: cmd, timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  test('writes files to the sandbox', async () => {
    const cmd = isWin ? ['cmd.exe', '/c', 'type', 'hello.txt'] : ['cat', 'hello.txt'];
    const result = await provider.run({ 
      command: cmd, 
      timeoutMs: 5000,
      files: {
        'hello.txt': 'sandbox content'
      }
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('sandbox content');
  });

  test('enforces timeout', async () => {
    // Sleep equivalent
    const cmd = isWin ? ['ping', '127.0.0.1', '-n', '5'] : ['sleep', '5'];
    
    await expect(provider.run({ command: cmd, timeoutMs: 100 })).rejects.toThrowError(SandboxError);
    await expect(provider.run({ command: cmd, timeoutMs: 100 })).rejects.toThrowError(/timed out/);
  });

  test('supports cancellation', async () => {
    const abort = new AbortController();
    const cmd = isWin ? ['ping', '127.0.0.1', '-n', '5'] : ['sleep', '5'];
    
    const promise = provider.run({ command: cmd, timeoutMs: 5000 }, abort.signal);
    abort.abort();
    
    await expect(promise).rejects.toThrowError(SandboxError);
    await expect(promise).rejects.toThrowError(/cancelled/i);
  });

  test('handles failing commands without throwing SandboxError', async () => {
    const cmd = isWin ? ['cmd.exe', '/c', 'exit 42'] : ['bash', '-c', 'exit 42'];
    const result = await provider.run({ command: cmd, timeoutMs: 5000 });
    
    expect(result.exitCode).toBe(42);
    // It should NOT throw.
  });
});

