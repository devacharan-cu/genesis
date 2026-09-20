/**
 * The verified-artifact fold, driven directly.
 *
 * This is the answer to "is it done", so most of this drives the ways it could
 * be made to say yes when it should not: evidence for an artifact nobody built,
 * a ruling for one that does not exist, a malformed payload, a second version
 * of the same path. Each must be recorded as an anomaly or refused, never
 * absorbed.
 */

import { type GenesisEvent, type JsonValue } from '@genesis/core-types';
import { describe, expect, it } from 'vitest';
import { FACTORY_EVENTS } from '../src/events.js';
import {
  BLOCKING_SEVERITIES,
  describeState,
  emptyVerifiedArtifactsState,
  highestState,
  isVerified,
  verifiedArtifactsProjector,
} from '../src/verified-artifacts.js';

let seq = 0;

const event = (type: string, payload: JsonValue, over: Partial<GenesisEvent> = {}): GenesisEvent =>
  ({
    id: `evt_${'0'.repeat(20)}${String((seq += 1)).padStart(6, '0')}`,
    projectId: 'prj_1',
    seq,
    schemaVersion: 1,
    type,
    actor: { kind: 'AGENT', id: 'agt_1', agentRole: 'BUILDER' },
    subject: null,
    before: null,
    after: null,
    cause: null,
    cycleId: null,
    authority: 'AI_ASSUMPTION',
    payload,
    timestamp: '2026-09-20T00:00:00.000Z',
    payloadHash: 'a'.repeat(64),
    prevHash: null,
    ...over,
  }) as GenesisEvent;

const fold = (events: readonly GenesisEvent[]) => {
  seq = 0;
  return events.reduce((state, e) => verifiedArtifactsProjector.apply(state, e), emptyVerifiedArtifactsState());
};

const proposed = (over: Record<string, unknown> = {}) =>
  event('ARTIFACT_PROPOSED', {
    artifactId: 'art_1',
    path: 'src/add.ts',
    contentHash: 'h1',
    bytes: 30,
    language: 'typescript',
    contents: 'export const add = 1;',
    callId: 'rsn_1',
    verificationState: 'GENERATED',
    ...over,
  });

const evidence = (over: Record<string, unknown> = {}) =>
  event(
    'AGENT_MESSAGE_RECEIVED',
    {
      taskId: 'task_1',
      messageId: 'msg_1',
      messageKind: 'EVIDENCE_SUBMISSION',
      envelope: {
        kind: 'EVIDENCE_SUBMISSION',
        body: {
          taskId: 'task_1',
          environment: 'SANDBOX',
          exitCode: 0,
          raw: 'src/add.ts ok',
          testKind: 'UNIT',
          claimedArtifacts: ['art_1'],
          ...over,
        },
      },
    },
    { actor: { kind: 'SYSTEM', id: 'agent-runtime' } },
  );

const ruled = (state: string, artifactId = 'art_1') =>
  event(FACTORY_EVENTS.FACTORY_ARTIFACT_VERIFIED, {
    runId: 'run_1',
    artifactId,
    path: 'src/add.ts',
    contentHash: 'h1',
    state,
    evidenceCount: 1,
  });

describe('an artifact starts generated, and nothing else', () => {
  it('records provenance back to who proposed it', () => {
    const state = fold([proposed()]);
    const artifact = state.artifacts['art_1'];
    expect(artifact).toMatchObject({ path: 'src/add.ts', contentHash: 'h1', state: 'GENERATED', verifiedAt: null });
    expect(artifact?.proposedBy).toEqual({ kind: 'AGENT', id: 'agt_1', agentRole: 'BUILDER' });
    expect(artifact?.proposedSeq).toBe(1);
  });

  it('is not verified, and says so in the words SPEC-05 requires', () => {
    const artifact = fold([proposed()]).artifacts['art_1'];
    expect(isVerified(artifact as never)).toBe(false);
    expect(describeState(artifact as never)).toBe('src/add.ts is generated, not verified');
  });

  it('collecting evidence advances nothing by itself', () => {
    const state = fold([proposed(), evidence()]);
    const artifact = state.artifacts['art_1'];
    expect(artifact?.evidence).toHaveLength(1);
    // Evidence exists; the state has not moved, because nothing asked the engine.
    expect(artifact?.state).toBe('GENERATED');
    expect(artifact?.verifiedAt).toBeNull();
  });

  it('only a recorded ruling advances it', () => {
    const state = fold([proposed(), evidence(), ruled('UNIT_TESTED')]);
    const artifact = state.artifacts['art_1'];
    expect(artifact?.state).toBe('UNIT_TESTED');
    expect(artifact?.verifiedAt).toBe('2026-09-20T00:00:00.000Z');
    expect(describeState(artifact as never)).toBe('src/add.ts is UNIT_TESTED');
  });

  it('a ruling of GENERATED leaves it unverified and untimestamped', () => {
    const artifact = fold([proposed(), evidence(), ruled('GENERATED')]).artifacts['art_1'];
    expect(artifact?.state).toBe('GENERATED');
    expect(artifact?.verifiedAt).toBeNull();
  });
});

describe('provenance and evidence detail', () => {
  it('records no role for an actor that has none', () => {
    const state = fold([proposed(), event('ARTIFACT_PROPOSED', { artifactId: 'art_2', path: 'b.ts', contentHash: 'h2', bytes: 1, language: 'ts', contents: 'y', callId: null, verificationState: 'GENERATED' }, { actor: { kind: 'SYSTEM', id: 'core' } })]);
    expect(state.artifacts['art_2']?.proposedBy).toEqual({ kind: 'SYSTEM', id: 'core', agentRole: null });
  });

  it('records a null test kind when the evidence named none', () => {
    const withoutKind = event(
      'AGENT_MESSAGE_RECEIVED',
      {
        taskId: 'task_1',
        messageId: 'msg_1',
        messageKind: 'EVIDENCE_SUBMISSION',
        envelope: {
          kind: 'EVIDENCE_SUBMISSION',
          body: { taskId: 'task_1', environment: 'LOCAL', exitCode: 0, raw: 'ok', claimedArtifacts: ['art_1'] },
        },
      },
      { actor: { kind: 'SYSTEM', id: 'agent-runtime' } },
    );
    const state = fold([proposed(), withoutKind]);
    expect(state.artifacts['art_1']?.evidence[0]?.testKind).toBeNull();
  });

  it('records the test kind when the evidence named one', () => {
    const state = fold([proposed(), evidence()]);
    expect(state.artifacts['art_1']?.evidence[0]?.testKind).toBe('UNIT');
  });
});

describe('versions', () => {
  it('different bytes at the same path are a different artifact, at GENERATED', () => {
    const state = fold([
      proposed(),
      evidence(),
      ruled('UNIT_TESTED'),
      proposed({ artifactId: 'art_2', contentHash: 'h2', contents: 'export const add = 2;' }),
    ]);
    expect(state.artifacts['art_1']?.state).toBe('UNIT_TESTED');
    // Nothing is inherited: the new version starts where every artifact starts.
    expect(state.artifacts['art_2']?.state).toBe('GENERATED');
    expect(state.artifacts['art_2']?.evidence).toEqual([]);
  });

  it('re-proposing the same bytes is not a new version and resets nothing', () => {
    const state = fold([proposed(), evidence(), ruled('UNIT_TESTED'), proposed()]);
    expect(Object.keys(state.artifacts)).toEqual(['art_1']);
    expect(state.artifacts['art_1']?.state).toBe('UNIT_TESTED');
    // The second proposal is still on the record.
    expect(state.artifacts['art_1']?.events).toContain(4);
  });

  it('the highest state across a set is the run’s answer', () => {
    const state = fold([proposed(), proposed({ artifactId: 'art_2', contentHash: 'h2' }), evidence(), ruled('UNIT_TESTED')]);
    const artifacts = Object.values(state.artifacts);
    expect(highestState(artifacts)).toBe('UNIT_TESTED');
    expect(highestState([])).toBe('GENERATED');
  });
});

describe('what the fold refuses to absorb', () => {
  const anomalyOf = (events: readonly GenesisEvent[]) => {
    const state = fold(events);
    expect(state.observations.anomalies.length).toBeGreaterThan(0);
    return state.observations.anomalies[0];
  };

  it('evidence for an artifact nobody proposed', () => {
    // An artifact that exists only because something claimed to have tested it
    // has no bytes and no provenance, so it is not created here.
    const state = fold([evidence()]);
    expect(state.artifacts).toEqual({});
    expect(state.observations.anomalies[0]?.detail).toContain('never proposed');
  });

  it('a ruling for an artifact that does not exist', () => {
    expect(anomalyOf([ruled('UNIT_TESTED', 'art_missing')])?.detail).toContain('no artifact art_missing');
  });

  it('a malformed proposal', () => {
    expect(anomalyOf([event('ARTIFACT_PROPOSED', { path: 'a.ts' })])?.detail).toContain('ARTIFACT_PROPOSED payload');
  });

  it('a malformed ruling', () => {
    expect(anomalyOf([proposed(), ruled('NOT_A_STATE')])?.detail).toContain('FACTORY_ARTIFACT_VERIFIED payload');
  });

  it('an evidence message with no readable body', () => {
    const broken = event('AGENT_MESSAGE_RECEIVED', {
      taskId: 't',
      messageId: 'msg_1',
      messageKind: 'EVIDENCE_SUBMISSION',
      envelope: { kind: 'EVIDENCE_SUBMISSION', body: { nope: true } },
    });
    expect(anomalyOf([proposed(), broken])?.detail).toContain('no readable body');
  });

  it('a malformed message envelope', () => {
    expect(anomalyOf([proposed(), event('AGENT_MESSAGE_RECEIVED', { nope: 1 })])?.detail).toContain(
      'AGENT_MESSAGE_RECEIVED payload',
    );
  });

  it('a malformed block record', () => {
    expect(anomalyOf([proposed(), event(FACTORY_EVENTS.FACTORY_CHANGE_BLOCKED, { blocking: 'none' })])?.detail).toContain(
      'FACTORY_CHANGE_BLOCKED payload',
    );
  });
});

describe('what the fold ignores', () => {
  it('a message that is not evidence', () => {
    const state = fold([
      proposed(),
      event('AGENT_MESSAGE_RECEIVED', { taskId: 't', messageId: 'msg_1', messageKind: 'RESULT', envelope: {} }),
    ]);
    expect(state.artifacts['art_1']?.evidence).toEqual([]);
    expect(state.observations.anomalies).toEqual([]);
    expect(state.observations.unhandled['AGENT_MESSAGE_RECEIVED']).toBe(1);
  });

  it('an event it has no handler for', () => {
    const state = fold([event('SOMETHING_ELSE', { note: 'x' })]);
    expect(state.artifacts).toEqual({});
    expect(state.observations.unhandled['SOMETHING_ELSE']).toBe(1);
  });

  it('a block naming an artifact it does not know', () => {
    const state = fold([
      proposed(),
      event(FACTORY_EVENTS.FACTORY_CHANGE_BLOCKED, { blocking: [{ artifactId: 'art_missing' }] }),
    ]);
    expect(state.observations.anomalies).toEqual([]);
    expect(state.artifacts['art_1']?.security.reviewed).toBe(false);
  });
});

describe('security findings hold an artifact down', () => {
  it('a blocking finding is counted against the artifact', () => {
    const state = fold([
      proposed(),
      event(FACTORY_EVENTS.FACTORY_CHANGE_BLOCKED, {
        runId: 'run_1',
        stage: 'SECURITY_REVIEW',
        reason: 'blocked',
        blocking: [{ rule: 'dynamic-eval', severity: 'CRITICAL', artifactId: 'art_1', detail: 'eval' }],
      }),
    ]);
    const artifact = state.artifacts['art_1'];
    expect(artifact?.security).toEqual({ reviewed: true, findings: 1, blocking: 1 });
    // And it is still generated, not verified.
    expect(isVerified(artifact as never)).toBe(false);
  });

  it('the blocking severities are the ones at or above the threshold', () => {
    expect([...BLOCKING_SEVERITIES]).toEqual(['CRITICAL', 'HIGH']);
  });
});

describe('the projector contract', () => {
  it('parses a state it wrote, and refuses one it did not', () => {
    const state = fold([proposed(), evidence(), ruled('UNIT_TESTED')]);
    expect(verifiedArtifactsProjector.parse(JSON.parse(JSON.stringify(state)) as unknown)).toEqual(state);
    expect(() => verifiedArtifactsProjector.parse({ artifacts: { art_1: { state: 'MADE_UP' } } })).toThrow();
  });

  it('names and versions itself, and starts empty', () => {
    expect(verifiedArtifactsProjector.name).toBe('verified-artifacts');
    expect(verifiedArtifactsProjector.version).toBe(1);
    expect(verifiedArtifactsProjector.initial()).toEqual(emptyVerifiedArtifactsState());
    expect(verifiedArtifactsProjector.observationsOf(emptyVerifiedArtifactsState())).toEqual(
      emptyVerifiedArtifactsState().observations,
    );
  });

  it('cites every event that justifies what it says', () => {
    const state = fold([proposed(), evidence(), ruled('UNIT_TESTED')]);
    expect(state.artifacts['art_1']?.events).toEqual([1, 2, 3]);
  });
});
