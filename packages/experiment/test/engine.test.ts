import { describe, expect, test } from 'vitest';
import { ExperimentEngine } from '../src/engine.js';
import { MockSandboxProvider, SandboxError } from '@genesis/sandbox';
import { InMemoryEventLedger } from '@genesis/ledger';
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
    const payload1 = events[1]!.payload as any;
    expect(payload1.exitCode).toBe(0);
    expect(payload1.observation.raw).toBe('pass\n');
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
    const payload1 = events[1]!.payload as any;
    expect(payload1.reason).toBe('TIMEOUT');
  });
});
