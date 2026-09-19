import { describe, expect, test } from 'vitest';
import { ExperimentEngine } from '../src/engine.js';
import { MockSandboxProvider, SandboxError } from '@genesis/sandbox';
import { canonicalJson, InMemoryEventLedger, sha256Hex } from '@genesis/ledger';
import { newProjectId } from '@genesis/core-types';

describe('ExperimentEngine', () => {
  test('records EXPERIMENT_STARTED and EXPERIMENT_COMPLETED for a successful run', async () => {
    const ledger = new InMemoryEventLedger();
    const sandbox = new MockSandboxProvider([
      { matchCommand: ['test'], result: { exitCode: 0, stdout: 'pass', stderr: '', durationMs: 10 } }
    ]);
    const engine = new ExperimentEngine(ledger, sandbox);
    
    const projectId = newProjectId();
    
    await engine.runExperiment(projectId, {
      taskId: 'task_1',
      hypothesis: 'it works',
      sandboxRequest: { command: ['test'], timeoutMs: 1000 }
    });
    
    const events = await ledger.read({ projectId });
    expect(events.length).toBe(2);
    expect(events[0]!.type).toBe('EXPERIMENT_STARTED');
    expect(events[1]!.type).toBe('EXPERIMENT_COMPLETED');
    const payload1 = events[1]!.payload as { exitCode: number, observation: { raw: string } };
    expect(payload1.exitCode).toBe(0);
    expect(payload1.observation.raw).toBe('pass\n');
  });

  test('the observation hash commits to what was observed, not to a label', async () => {
    const run = async (stdout: string, stderr: string, exitCode: number): Promise<string> => {
      const ledger = new InMemoryEventLedger();
      const sandbox = new MockSandboxProvider([
        { matchCommand: ['test'], result: { exitCode, stdout, stderr, durationMs: 10 } },
      ]);
      const projectId = newProjectId();
      await new ExperimentEngine(ledger, sandbox).runExperiment(projectId, {
        taskId: 'task_1',
        hypothesis: 'it works',
        sandboxRequest: { command: ['test'], timeoutMs: 1000 },
      });
      const events = await ledger.read({ projectId });
      return (events[1]!.payload as { observation: { hash: string } }).observation.hash;
    };

    const hash = await run('pass', '', 0);
    expect(hash).toBe(sha256Hex(canonicalJson({ exitCode: 0, stdout: 'pass', stderr: '' })));

    // Each observed field is actually covered, so no two outcomes collide.
    expect(await run('fail', '', 0)).not.toBe(hash);
    expect(await run('pass', 'warning', 0)).not.toBe(hash);
    expect(await run('pass', '', 1)).not.toBe(hash);

    // And the same outcome in a different project hashes the same way.
    expect(await run('pass', '', 0)).toBe(hash);
  });

  test('records EXPERIMENT_STARTED and EXPERIMENT_FAILED for a sandbox error', async () => {
    const ledger = new InMemoryEventLedger();
    const sandbox = new MockSandboxProvider([
      { matchCommand: ['test'], error: new SandboxError('TIMEOUT', 'too slow') }
    ]);
    const engine = new ExperimentEngine(ledger, sandbox);
    
    const projectId = newProjectId();
    
    await expect(engine.runExperiment(projectId, {
      taskId: 'task_1',
      hypothesis: 'it hangs',
      sandboxRequest: { command: ['test'], timeoutMs: 100 }
    })).rejects.toThrowError('too slow');
    
    const events = await ledger.read({ projectId });
    expect(events.length).toBe(2);
    expect(events[0]!.type).toBe('EXPERIMENT_STARTED');
    const payload1 = events[1]!.payload as { reason: string };
    expect(payload1.reason).toBe('TIMEOUT');
  });

  test('records EXPERIMENT_FAILED for a generic error', async () => {
    const ledger = new InMemoryEventLedger();
    const sandbox = new MockSandboxProvider([
      { matchCommand: ['test'], error: new Error('generic error') }
    ]);
    const engine = new ExperimentEngine(ledger, sandbox);
    
    const projectId = newProjectId();
    
    await expect(engine.runExperiment(projectId, {
      taskId: 'task_1',
      hypothesis: 'it hangs',
      sandboxRequest: { command: ['test'], timeoutMs: 100 }
    })).rejects.toThrowError('generic error');
    
    const events = await ledger.read({ projectId });
    expect(events.length).toBe(2);
    expect(events[0]!.type).toBe('EXPERIMENT_STARTED');
    const payload1 = events[1]!.payload as { reason: string };
    expect(payload1.reason).toBe('UNKNOWN');
  });

  test('records EXPERIMENT_FAILED for a non-error throw', async () => {
    const ledger = new InMemoryEventLedger();
    const sandbox = new MockSandboxProvider([
      { matchCommand: ['test'], error: 'string error' }
    ]);
    const engine = new ExperimentEngine(ledger, sandbox);
    
    const projectId = newProjectId();
    
    await expect(engine.runExperiment(projectId, {
      taskId: 'task_1',
      hypothesis: 'it hangs',
      sandboxRequest: { command: ['test'], timeoutMs: 100 }
    })).rejects.toThrowError('string error');
    
    const events = await ledger.read({ projectId });
    expect(events.length).toBe(2);
    expect(events[0]!.type).toBe('EXPERIMENT_STARTED');
    const payload1 = events[1]!.payload as { reason: string, message: string };
    expect(payload1.reason).toBe('UNKNOWN');
    expect(payload1.message).toBe('string error');
  });
});
