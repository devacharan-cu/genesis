import { describe, expect, test } from 'vitest';
import { MockSandboxProvider } from '../src/mock.js';
import { SandboxError } from '../src/errors.js';

describe('MockSandboxProvider', () => {
  test('returns default success', async () => {
    const sandbox = new MockSandboxProvider();
    const result = await sandbox.run({ command: ['foo'], timeoutMs: 1000 });
    expect(result.exitCode).toBe(0);
  });

  test('matches command and returns result', async () => {
    const sandbox = new MockSandboxProvider([
      { matchCommand: ['foo'], result: { exitCode: 42, stdout: 'out', stderr: 'err', durationMs: 0 } }
    ]);
    const result = await sandbox.run({ command: ['foo'], timeoutMs: 1000 });
    expect(result.exitCode).toBe(42);
  });

  test('throws specified error', async () => {
    const sandbox = new MockSandboxProvider([
      { matchCommand: ['foo'], error: new SandboxError('SETUP_FAILED', 'fail') }
    ]);
    await expect(sandbox.run({ command: ['foo'], timeoutMs: 1000 })).rejects.toThrowError('fail');
  });

  test('enforces timeout if delay > timeout', async () => {
    const sandbox = new MockSandboxProvider([
      { matchCommand: ['foo'], delayMs: 200 }
    ]);
    await expect(sandbox.run({ command: ['foo'], timeoutMs: 50 })).rejects.toThrowError(/timed out/);
  });
});

