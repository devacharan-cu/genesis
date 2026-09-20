/**
 * Every reading the fold has, including the ones a successful run never
 * produces.
 *
 * A factory run that works exercises perhaps half of these. The other half are
 * the interesting ones: a model call that failed, output the core refused, a
 * proposal it would not accept, a lease that went stale. Those are exactly the
 * events an operator most needs to read correctly, and exactly the events a
 * suite driven only by successful runs would never see.
 *
 * The payloads below are built to match the schemas the producing packages
 * declare, so a reading tested here is a reading of something the system can
 * actually emit.
 */

import type { GenesisEvent } from '@genesis/core-types';
import { describe, expect, it } from 'vitest';
import { foldConsole } from '../src/view.js';

let seq = 0;

/** One event, with the shape the ledger gives it. */
const event = (
  type: string,
  payload: unknown,
  over: { actor?: { kind: string; id: string; agentRole?: string }; authority?: string } = {},
): GenesisEvent =>
  ({
    id: `evt_01M2ZHGT8R30TRRW6FF044${String(seq).padStart(4, '0')}`,
    projectId: 'prj_01M2ZHGT8BFNQ4Q9BFGWHX26BV',
    seq: (seq += 1),
    schemaVersion: 1,
    type,
    actor: over.actor ?? { kind: 'SYSTEM', id: 'core' },
    subject: null,
    before: null,
    after: null,
    cause: null,
    cycleId: null,
    authority: over.authority ?? 'VERIFIED_SYSTEM_STATE',
    payload,
    timestamp: '2026-09-20T12:00:00.000Z',
    payloadHash: 'a'.repeat(64),
    prevHash: null,
  }) as unknown as GenesisEvent;

/** The single event's view, folded in isolation. */
const only = (type: string, payload: unknown, over?: Parameters<typeof event>[2]) => {
  const state = foldConsole([event(type, payload, over)]);
  const view = state.events[0];
  if (view === undefined) throw new Error('the fold produced no view');
  return { view, state };
};

/** A task assigned to a role, so later events on it can be attributed. */
const assigned = (taskId: string, role: string): GenesisEvent =>
  event('AGENT_TASK_ASSIGNED', { taskId, attempt: 1, agentId: 'agt_1', role, kind: `${role}_TASK`, contributesTo: [], deadline: null, proposalKinds: [] });

describe('cognition readings', () => {
  it('reads an uncertainty as something worth a person’s attention', () => {
    const { view } = only('UNCERTAINTY_RECORDED', {
      uncertainty: { id: 'unc-1', statement: 'is cancellation refundable?', risk: 'HIGH' },
    });
    expect(view.lane).toBe('HUMAN');
    expect(view.headline).toContain('is cancellation refundable?');
    expect(view.severity).toBe('WARN');
  });

  it('reads an uncertainty with no statement without inventing one', () => {
    expect(only('UNCERTAINTY_RECORDED', { uncertainty: {} }).view.headline).toContain('unstated');
  });

  it('reads a goal reaching satisfaction as a success', () => {
    const { view } = only('GOAL_STATUS_CHANGED', { goalId: 'goal-1', from: 'ACTIVE', to: 'SATISFIED', reason: null });
    expect(view.severity).toBe('SUCCESS');
    expect(view.detail).toBe('ACTIVE → SATISFIED');
  });

  it('reads a goal change with missing ends without crashing', () => {
    expect(only('GOAL_STATUS_CHANGED', {}).view.detail).toBe('? → ?');
    expect(only('GOAL_STATUS_CHANGED', {}).view.headline).toBe('Goal changed');
  });

  it('ignores a status change for a goal it never saw proposed', () => {
    expect(foldConsole([event('GOAL_STATUS_CHANGED', { goalId: 'ghost', to: 'ACTIVE' })]).goals).toEqual([]);
  });

  it('ignores a proposed goal with no id', () => {
    expect(foldConsole([event('GOAL_PROPOSED', { goal: { description: 'x' } })]).goals).toEqual([]);
  });
});

describe('factory readings a successful run never produces', () => {
  it('reads a stale impact lease, and says whether the stage will run again', () => {
    const { view } = only('FACTORY_LEASE_STALE', {
      runId: 'run_1',
      stage: 'BUILD',
      pass: 1,
      reason: 'the graph moved under the change',
      touched: ['node_1'],
      willRerun: true,
    });
    expect(view.severity).toBe('WARN');
    expect(view.headline).toContain('BUILD');
    expect(view.detail).toContain('rerunning');

    const blocking = only('FACTORY_LEASE_STALE', { runId: 'r', stage: 'BUILD', reason: 'again', willRerun: false });
    expect(blocking.view.detail).toContain('blocking');
  });

  it('reads a blocked change, and keeps the findings that blocked it', () => {
    const { view, state } = only('FACTORY_CHANGE_BLOCKED', {
      runId: 'run_1',
      stage: 'SECURITY_REVIEW',
      reason: 'a CRITICAL finding stopped the change',
      blocking: [{ rule: 'process-spawn', severity: 'CRITICAL', artifactId: 'art_1', detail: 'spawns a process' }],
    });
    expect(view.severity).toBe('FAILURE');
    expect(state.findings).toEqual([
      { rule: 'process-spawn', severity: 'CRITICAL', artifactId: 'art_1', detail: 'spawns a process', blocking: true, seq: view.seq },
    ]);
  });

  it('reads a blocked change with no findings attached', () => {
    const { state } = only('FACTORY_CHANGE_BLOCKED', { runId: 'r', stage: 'REPAIR', reason: 'no repair path' });
    expect(state.findings).toEqual([]);
    expect(state.run).toBeNull();
  });

  it('reads a skipped stage as neither a pass nor a failure', () => {
    const { view } = only('FACTORY_STAGE_SETTLED', {
      runId: 'r',
      stage: 'TEST',
      pass: 1,
      result: 'SKIPPED',
      taskId: null,
      detail: 'nothing to test',
    });
    expect(view.severity).toBe('WARN');
    expect(view.headline).toBe('Test skipped');
  });

  it('reads a run that finished as anything other than verified as a failure', () => {
    expect(only('FACTORY_RUN_FINISHED', { runId: 'r', outcome: 'BLOCKED', summary: 'stopped' }).view.severity).toBe('FAILURE');
    expect(only('FACTORY_RUN_FINISHED', { runId: 'r', outcome: 'VERIFIED', summary: 'done' }).view.severity).toBe('SUCCESS');
    expect(only('FACTORY_RUN_FINISHED', {}).view.headline).toContain('unknown');
  });

  it('reads a stage whose name it does not recognise without guessing a lane', () => {
    const { view } = only('FACTORY_STAGE_ENTERED', { runId: 'r', stage: 'TELEPORT', pass: 1 });
    expect(view.lane).toBe('SYSTEM');
    expect(view.headline).toContain('TELEPORT');
    expect(only('FACTORY_STAGE_ENTERED', { runId: 'r' }).view.lane).toBe('SYSTEM');
    expect(only('FACTORY_STAGE_SETTLED', { runId: 'r', result: 'PASSED' }).view.lane).toBe('SYSTEM');
  });

  it('ignores a settle for a stage that was never entered', () => {
    const state = foldConsole([event('FACTORY_STAGE_SETTLED', { runId: 'r', stage: 'TEST', pass: 9, result: 'PASSED', detail: 'x' })]);
    expect(state.stages).toEqual([]);
  });

  it('ignores a verification ruling for an artifact it never saw proposed', () => {
    const state = foldConsole([event('FACTORY_ARTIFACT_VERIFIED', { runId: 'r', artifactId: 'ghost', path: 'x', state: 'UNIT_TESTED', evidenceCount: 1 })]);
    expect(state.artifacts).toEqual([]);
  });

  it('ignores a run finishing when no run started', () => {
    expect(foldConsole([event('FACTORY_RUN_FINISHED', { runId: 'r', outcome: 'VERIFIED' })]).run).toBeNull();
  });
});

describe('agent and orchestration failure readings', () => {
  it('reads a failed agent task', () => {
    const { view } = only('AGENT_TASK_FAILED', { taskId: 'task_1', kind: 'TIMEOUT', detail: 'no answer in 20000ms' });
    expect(view.severity).toBe('FAILURE');
    expect(view.headline).toContain('TIMEOUT');
    expect(view.detail).toContain('20000ms');
    expect(only('AGENT_TASK_FAILED', { taskId: 't' }).view.headline).toContain('unknown');
  });

  it('reads a message the runtime rejected', () => {
    const { view } = only('AGENT_MESSAGE_REJECTED', { taskId: 'task_1', reason: 'the manifest does not permit that proposal' });
    expect(view.severity).toBe('FAILURE');
    expect(view.detail).toContain('manifest');
  });

  it('reads a model call that failed', () => {
    const { view } = only('REASONING_FAILED', { callId: 'rsn_1', kind: 'TIMEOUT', detail: 'no answer' });
    expect(view.severity).toBe('FAILURE');
    expect(view.headline).toContain('TIMEOUT');
    expect(only('REASONING_FAILED', { callId: 'x' }).view.headline).toContain('unknown');
  });

  it('reads output the core refused, which is the trust boundary in action', () => {
    const { view } = only('REASONING_OUTPUT_REJECTED', { callId: 'rsn_1', reason: 'the output did not satisfy the schema' });
    expect(view.severity).toBe('FAILURE');
    expect(view.headline).toBe('Model output rejected by the core');
  });

  it('reads a proposal the core accepted and one it refused', () => {
    expect(only('PROPOSAL_EVALUATED', { taskId: 't', kind: 'RECORD_BELIEF', accepted: true, reason: 'ok' }).view.severity).toBe('SUCCESS');
    const refused = only('PROPOSAL_EVALUATED', { taskId: 't', kind: 'RECORD_BELIEF', accepted: false, reason: 'no evidence' });
    expect(refused.view.severity).toBe('WARN');
    expect(refused.view.headline).toContain('refused');
    expect(only('PROPOSAL_EVALUATED', { taskId: 't', accepted: true }).view.headline).toContain('unknown');
  });

  it('reads an execution failure and a task too large for its budget', () => {
    expect(only('EXECUTION_FAILED', { taskId: 't', detail: 'the sandbox died' }).view.severity).toBe('FAILURE');
    const split = only('TASK_SPLIT_REQUIRED', { taskId: 't', reason: 'mandatory context exceeds the budget' });
    expect(split.view.severity).toBe('WARN');
    expect(split.view.detail).toContain('budget');
  });

  it('reads a task state it has no special wording for', () => {
    const { view } = only('AGENT_TASK_STATE_CHANGED', { taskId: 't', from: 'RUNNING', to: 'BLOCKED', reason: 'waiting' });
    expect(view.headline).toBe('Task blocked');
    expect(view.severity).toBe('INFO');
    expect(only('AGENT_TASK_STATE_CHANGED', { taskId: 't' }).view.headline).toBe('Task moved');
    expect(only('AGENT_TASK_STATE_CHANGED', { taskId: 't', to: 'CANCELLED' }).view.severity).toBe('FAILURE');
  });

  it('reads an assignment with no role without inventing one', () => {
    expect(only('AGENT_TASK_ASSIGNED', { taskId: 't', attempt: 1 }).view.lane).toBe('SYSTEM');
    expect(only('AGENT_TASK_ASSIGNED', { attempt: 2 }).view.detail).toContain('unknown');
  });

  it('reads a finished task that failed', () => {
    const { view } = only('AGENT_TASK_FINISHED', { taskId: 't', finalState: 'FAILED', attempts: 3, messages: 1, proposalsAccepted: 0 });
    expect(view.severity).toBe('FAILURE');
    expect(only('AGENT_TASK_FINISHED', { taskId: 't' }).view.headline).toBe('Task finished');
  });
});

describe('message readings', () => {
  it('summarises a result envelope by its outcome', () => {
    const { view } = only('AGENT_MESSAGE_RECEIVED', {
      taskId: 't',
      messageKind: 'RESULT',
      envelope: { from: { role: 'QA' }, body: { outcome: 'FAILED', summary: 'the suite did not pass' } },
    });
    expect(view.lane).toBe('QA');
    expect(view.detail).toBe('FAILED: the suite did not pass');
  });

  it('summarises an envelope that carries only an outcome, or only findings', () => {
    expect(
      only('AGENT_MESSAGE_RECEIVED', { taskId: 't', messageKind: 'RESULT', envelope: { body: { outcome: 'PASSED' } } }).view.detail,
    ).toBe('PASSED');
    expect(
      only('AGENT_MESSAGE_RECEIVED', {
        taskId: 't',
        messageKind: 'FINDING',
        envelope: { findings: [{ rule: 'a' }, { rule: 'b' }] },
      }).view.detail,
    ).toBe('2 finding(s)');
  });

  it('has nothing to say about an envelope that says nothing', () => {
    expect(only('AGENT_MESSAGE_RECEIVED', { taskId: 't', messageKind: 'STATUS', envelope: {} }).view.detail).toBeNull();
    expect(only('AGENT_MESSAGE_RECEIVED', { taskId: 't', envelope: {} }).view.headline).toContain('unknown');
  });

  it('reads an error message as a failure', () => {
    expect(only('AGENT_MESSAGE_RECEIVED', { taskId: 't', messageKind: 'ERROR', envelope: {} }).view.severity).toBe('FAILURE');
  });

  it('collects findings from a finding message, marked non-blocking', () => {
    const { state } = only('AGENT_MESSAGE_RECEIVED', {
      taskId: 't',
      messageKind: 'FINDING',
      envelope: { body: { findings: [{ id: 'unsafe-any', severity: 'LOW', artifactId: 'art_1', message: 'uses any' }] } },
    });
    expect(state.findings[0]).toMatchObject({ rule: 'unsafe-any', severity: 'LOW', blocking: false, detail: 'uses any' });
  });

  it('ignores a finding message whose findings are not a list', () => {
    expect(only('AGENT_MESSAGE_RECEIVED', { taskId: 't', messageKind: 'FINDING', envelope: { findings: 'many' } }).state.findings).toEqual([]);
  });
});

describe('attribution when the stream is incomplete', () => {
  it('falls back to the running stage when it never saw the assignment', () => {
    // A client that joined mid-run has no record of who the task belongs to.
    // The stage's owner is the honest answer; inventing an agent would not be.
    const state = foldConsole([
      event('FACTORY_STAGE_ENTERED', { runId: 'r', stage: 'TEST', pass: 1 }),
      event('AGENT_TASK_STATE_CHANGED', { taskId: 'unseen', from: 'ASSIGNED', to: 'RUNNING', reason: 'x' }),
    ]);
    expect(state.events[1]?.lane).toBe('QA');
  });

  it('falls back to the core when there is no stage either', () => {
    const state = foldConsole([event('AGENT_TASK_STATE_CHANGED', { taskId: 'unseen', to: 'RUNNING' })]);
    expect(state.events[0]?.lane).toBe('SYSTEM');
  });

  it('attributes a model response through the call it answers', () => {
    const state = foldConsole([
      assigned('task_1', 'BUILDER'),
      event('REASONING_REQUESTED', { taskId: 'task_1', callId: 'rsn_1', providerId: 'mock', purpose: 'PRODUCE_ARTIFACT' }),
      event('REASONING_RESPONDED', { callId: 'rsn_1', modelId: 'm', stopReason: 'END_TURN', outputLength: 12 }),
    ]);
    expect(state.events[2]?.lane).toBe('BUILDER');
    expect(state.events[2]?.taskId).toBe('task_1');
  });

  it('does not attribute a response to a call it never saw requested', () => {
    expect(foldConsole([event('REASONING_RESPONDED', { callId: 'ghost' })]).events[0]?.lane).toBe('SYSTEM');
  });

  it('names an unrecognised reasoning purpose without pretending to know it', () => {
    const state = foldConsole([
      assigned('task_1', 'PLANNER'),
      event('REASONING_REQUESTED', { taskId: 'task_1', callId: 'c', purpose: 'SOMETHING_ELSE' }),
    ]);
    expect(state.events[1]?.headline).toBe('Asked the model to reason');
  });

  it('reads a diagnosis with no approach recorded', () => {
    const { view } = only('FAILURE_DIAGNOSED', { callId: 'c', rootCause: 'unclear', targetArtifacts: [] });
    expect(view.detail).toBeNull();
    expect(only('FAILURE_DIAGNOSED', {}).view.headline).toContain('no root cause recorded');
  });

  it('reads context assembly against the task in its manifest', () => {
    const state = foldConsole([
      assigned('task_1', 'ARCHITECT'),
      event('CONTEXT_ASSEMBLED', { manifest: { taskId: 'task_1', taskKind: 'DECOMPOSE_GOAL', budgetTokens: 4000 } }),
    ]);
    expect(state.events[1]?.lane).toBe('ARCHITECT');
    expect(state.events[1]?.detail).toContain('4000');
    expect(only('CONTEXT_ASSEMBLED', {}).view.detail).toContain('task');
  });

  it('attributes an artifact to whichever agent the ledger says proposed it', () => {
    const { view } = only(
      'ARTIFACT_PROPOSED',
      { artifactId: 'art_1', path: 'src/a.js', contentHash: 'h', bytes: 10, verificationState: 'GENERATED' },
      { actor: { kind: 'AGENT', id: 'agt_1', agentRole: 'REPAIR' }, authority: 'AI_ASSUMPTION' },
    );
    expect(view.lane).toBe('REPAIR');
    // And to the Builder when the ledger names no role, which is the only
    // role that proposes artifacts.
    expect(only('ARTIFACT_PROPOSED', { artifactId: 'a', path: 'p' }).view.lane).toBe('BUILDER');
  });

  it('puts an unknown event in the agent’s lane when the actor names one', () => {
    const { view } = only('SOMETHING_ODD', null, { actor: { kind: 'AGENT', id: 'agt_1', agentRole: 'SECURITY' } });
    expect(view.lane).toBe('SECURITY');
    expect(view.unrecognised).toBe(true);
  });

  it('carries the current stage onto events that do not name one', () => {
    const state = foldConsole([
      event('FACTORY_RUN_STARTED', { runId: 'r', goalId: 'g', title: 't', maxRepairAttempts: 3 }),
      event('FACTORY_STAGE_ENTERED', { runId: 'r', stage: 'BUILD', pass: 2 }),
      assigned('task_1', 'BUILDER'),
    ]);
    expect(state.events[2]?.stage).toBe('BUILD');
    expect(state.events[2]?.pass).toBe(2);
    expect(state.events[2]?.runId).toBe('r');
  });

  it('clears the stage once the run has finished', () => {
    const state = foldConsole([
      event('FACTORY_RUN_STARTED', { runId: 'r', goalId: 'g', title: 't', maxRepairAttempts: 1 }),
      event('FACTORY_STAGE_ENTERED', { runId: 'r', stage: 'VERIFY', pass: 1 }),
      event('FACTORY_RUN_FINISHED', { runId: 'r', outcome: 'VERIFIED', summary: 's', stagesRun: 1, repairAttempts: 0, highestState: 'UNIT_TESTED' }),
      event('SOMETHING_AFTER', null),
    ]);
    expect(state.events[3]?.stage).toBeNull();
  });
});

describe('what the lane summary counts', () => {
  it('counts a failure against the lane that failed, not the core', () => {
    const state = foldConsole([
      event('FACTORY_STAGE_ENTERED', { runId: 'r', stage: 'TEST', pass: 1 }),
      event('FACTORY_STAGE_SETTLED', { runId: 'r', stage: 'TEST', pass: 1, result: 'FAILED', taskId: null, detail: 'exited 1' }),
    ]);
    expect(state.lanes['QA']?.failures).toBe(1);
    expect(state.lanes['SYSTEM']).toBeUndefined();
  });

  it('leaves the highlighted lane alone for a core-only event', () => {
    const state = foldConsole([event('FACTORY_RUN_STARTED', { runId: 'r', goalId: 'g', title: 't', maxRepairAttempts: 1 })]);
    expect(state.activeLane).toBeNull();
  });
});

describe('payloads that are missing what they should carry', () => {
  /**
   * Every fallback in the fold, exercised.
   *
   * These are defensive: a well-formed ledger never produces them. They exist
   * because a console that threw on a surprising payload would take the whole
   * timeline down at the moment it was most needed, and a console that silently
   * rendered `undefined` would be worse.
   */
  it('names a goal, a run and a stage that arrive without one', () => {
    expect(only('GOAL_PROPOSED', { goal: { id: 'g' } }).view.headline).toContain('untitled');
    expect(only('FACTORY_RUN_STARTED', { runId: 'r' }).view.headline).toContain('untitled');
    expect(only('FACTORY_LEASE_STALE', { runId: 'r', willRerun: true }).view.headline).toContain('a stage');
    expect(only('FACTORY_ARTIFACT_VERIFIED', { runId: 'r', artifactId: 'a' }).view.headline).toBe(
      'artifact reached a state',
    );
  });

  it('keeps a goal it can record even when fields are missing', () => {
    const { state } = only('GOAL_PROPOSED', { goal: { id: 'g' } });
    expect(state.goals[0]).toEqual({ goalId: 'g', description: '', status: 'PROPOSED', priority: 0 });
  });

  it('keeps a goal’s status when a change does not say what it changed to', () => {
    const state = foldConsole([
      event('GOAL_PROPOSED', { goal: { id: 'g', description: 'd', status: 'PROPOSED', priority: 1 } }),
      event('GOAL_STATUS_CHANGED', { goalId: 'g' }),
    ]);
    expect(state.goals[0]?.status).toBe('PROPOSED');
  });

  it('records a run that arrives with nothing but a type', () => {
    const { state } = only('FACTORY_RUN_STARTED', {});
    expect(state.run).toMatchObject({ runId: '', goalId: '', title: '', maxRepairAttempts: 0 });
  });

  it('defaults a stage’s pass and a settle’s result rather than dropping them', () => {
    const state = foldConsole([
      event('FACTORY_STAGE_ENTERED', { runId: 'r', stage: 'BUILD' }),
      event('FACTORY_STAGE_SETTLED', { runId: 'r', stage: 'BUILD', pass: 1, taskId: null, detail: 'x' }),
    ]);
    expect(state.stages[0]?.pass).toBe(1);
    expect(state.stages[0]?.result).toBe('PASSED');
  });

  it('does not settle a stage twice', () => {
    const state = foldConsole([
      event('FACTORY_STAGE_ENTERED', { runId: 'r', stage: 'BUILD', pass: 1 }),
      event('FACTORY_STAGE_SETTLED', { runId: 'r', stage: 'BUILD', pass: 1, result: 'PASSED', detail: 'first' }),
      event('FACTORY_STAGE_SETTLED', { runId: 'r', stage: 'BUILD', pass: 1, result: 'FAILED', detail: 'second' }),
    ]);
    expect(state.stages).toHaveLength(1);
    expect(state.stages[0]?.detail).toBe('first');
  });

  it('records an artifact and a finding that arrive half-formed', () => {
    const { state } = only('ARTIFACT_PROPOSED', { artifactId: 'a' });
    expect(state.artifacts[0]).toMatchObject({ path: '', contentHash: '', bytes: 0, state: 'GENERATED' });

    const blocked = only('FACTORY_CHANGE_BLOCKED', { runId: 'r', stage: 'S', reason: 'x', blocking: [{}] });
    expect(blocked.state.findings[0]).toMatchObject({ rule: 'unknown', severity: 'INFO', artifactId: '', detail: '' });

    const reported = only('AGENT_MESSAGE_RECEIVED', { taskId: 't', messageKind: 'FINDING', envelope: { findings: [{}] } });
    expect(reported.state.findings[0]?.rule).toBe('unknown');
  });

  it('keeps an artifact’s state when a ruling does not name a new one', () => {
    const state = foldConsole([
      event('ARTIFACT_PROPOSED', { artifactId: 'a', path: 'p', verificationState: 'GENERATED' }),
      event('FACTORY_ARTIFACT_VERIFIED', { runId: 'r', artifactId: 'a' }),
    ]);
    expect(state.artifacts[0]?.state).toBe('GENERATED');
    expect(state.artifacts[0]?.evidenceCount).toBe(0);
    expect(state.artifacts[0]?.verifiedSeq).not.toBeNull();
  });

  it('does not attribute a model event that carries no call id', () => {
    for (const type of ['REASONING_RESPONDED', 'REASONING_FAILED', 'REASONING_OUTPUT_REJECTED']) {
      expect(only(type, {}).view.lane, type).toBe('SYSTEM');
      expect(only(type, {}).view.taskId, type).toBeNull();
    }
  });

  it('falls back to the core when the running stage is not one it knows', () => {
    const state = foldConsole([
      event('FACTORY_STAGE_ENTERED', { runId: 'r', stage: 'TELEPORT', pass: 1 }),
      event('AGENT_TASK_STATE_CHANGED', { taskId: 'unseen', to: 'RUNNING' }),
    ]);
    expect(state.events[1]?.lane).toBe('SYSTEM');
  });
});

describe('the last few shapes a malformed ledger could take', () => {
  it('reads a settled stage whose name it does not know', () => {
    const { view } = only('FACTORY_STAGE_SETTLED', { runId: 'r', stage: 'TELEPORT', pass: 1, result: 'FAILED', detail: 'x' });
    expect(view.lane).toBe('SYSTEM');
    expect(view.headline).toBe('TELEPORT failed');
  });

  it('assumes a first attempt when an assignment does not number itself', () => {
    expect(only('AGENT_TASK_ASSIGNED', { taskId: 'task_1', role: 'QA' }).view.detail).toContain('attempt 1');
  });

  it('ignores a verification ruling that names no artifact at all', () => {
    const state = foldConsole([
      event('ARTIFACT_PROPOSED', { artifactId: 'a', path: 'p' }),
      event('FACTORY_ARTIFACT_VERIFIED', { runId: 'r', state: 'UNIT_TESTED', evidenceCount: 2 }),
    ]);
    expect(state.artifacts[0]?.verifiedSeq).toBeNull();
    expect(state.artifacts[0]?.evidenceCount).toBe(0);
  });
});
