import { type EventLedger } from '@genesis/ledger';
import { type SandboxProvider, type SandboxRequest, SandboxError } from '@genesis/sandbox';
import type { EventInput, ProjectId } from '@genesis/core-types';
import { newExperimentId, newObservationId } from '@genesis/core-types';

export interface ExperimentTarget {
  taskId: string;
  hypothesis: string;
  sandboxRequest: SandboxRequest;
}

export class ExperimentEngine {
  constructor(
    private readonly ledger: EventLedger,
    private readonly sandbox: SandboxProvider,
  ) {}

  /**
   * Executes an experiment securely in the sandbox and records the result as evidence.
   */
  async runExperiment(projectId: ProjectId, target: ExperimentTarget, abortSignal?: AbortSignal): Promise<void> {
    const experimentId = newExperimentId();

    // 1. Record START
    await this.ledger.append({ projectId }, {
      type: 'EXPERIMENT_STARTED',
      actor: { kind: 'SYSTEM', id: 'experiment-engine' },
      authority: 'VERIFIED_SYSTEM_STATE',
      payload: {
        experimentId,
        taskId: target.taskId,
        hypothesis: target.hypothesis,
        timeoutMs: target.sandboxRequest.timeoutMs,
      },
    } as EventInput);

    let result;
    try {
      // 2. Execute
      result = await this.sandbox.run(target.sandboxRequest, abortSignal);

      // 3. Record COMPLETED evidence
      await this.ledger.append({ projectId }, {
        type: 'EXPERIMENT_COMPLETED',
        actor: { kind: 'SYSTEM', id: 'experiment-engine' },
        authority: 'EVIDENCE',
        payload: {
          experimentId,
          taskId: target.taskId,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          observation: {
            id: newObservationId(),
            kind: 'EVIDENCE',
            environment: 'SANDBOX',
            raw: result.stdout + '\n' + result.stderr,
            hash: 'hash-placeholder', // In a real system, compute SHA-256
          },
        },
      } as EventInput);

    } catch (err) {
      // 4. Record FAILED
      const errorKind = err instanceof SandboxError ? err.kind : 'UNKNOWN';
      const errorMessage = err instanceof Error ? err.message : String(err);
      
      await this.ledger.append({ projectId }, {
        type: 'EXPERIMENT_FAILED',
        actor: { kind: 'SYSTEM', id: 'experiment-engine' },
        authority: 'VERIFIED_SYSTEM_STATE',
        payload: {
          experimentId,
          taskId: target.taskId,
          reason: errorKind,
          message: errorMessage,
        },
      } as EventInput);
      throw err;
    }
  }
}
