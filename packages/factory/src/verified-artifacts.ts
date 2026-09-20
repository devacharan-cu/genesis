/**
 * What a verified artifact is, rebuilt from the ledger (ADR-0023 §5).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). This is the answer to "is it done", and the
 * whole point of the phase is that the answer cannot be faked. Four rules, each
 * tested:
 *
 *   1. **The state comes from the P5 engine.** This fold collects evidence and
 *      asks. It never computes a state itself, so there is no second
 *      verification truth model to disagree with the first.
 *   2. **`GENERATED` is the default.** An artifact with no evidence is
 *      generated, not verified, and the field that says so is the same field
 *      that would say otherwise.
 *   3. **A content hash change restarts verification.** Artifact identity is
 *      derived from path and content hash, so different bytes are a different
 *      artifact at `GENERATED`. Nothing is inherited (SPEC-05 §2).
 *   4. **Blocking security findings hold an artifact down.** A change blocked
 *      before `VERIFY` leaves its artifacts wherever their evidence put them,
 *      and the record says it was blocked.
 *
 * It is a projection, not a record anyone writes: there is no `verified` flag
 * for a component to set, because there is no field for one.
 */

import {
  type GenesisEvent,
  SEVERITIES,
  type Severity,
  VERIFICATION_STATES,
  type VerificationState,
} from '@genesis/core-types';
import {
  emptyObservations,
  noteAnomaly,
  noteUnhandled,
  ObservationLog,
  parseProjectionState,
  type Projector,
} from '@genesis/projections';
import { z } from 'zod';
import { FACTORY_EVENTS } from './events.js';

const Id = z.string().min(1);

export const ArtifactEvidence = z
  .object({
    observationId: Id,
    hash: z.string(),
    environment: z.enum(['SANDBOX', 'STAGING', 'PRODUCTION', 'LOCAL']),
    exitCode: z.number().int(),
    testKind: z.string().nullable(),
    raw: z.string(),
    seq: z.number().int().positive(),
  })
  .strict();
export type ArtifactEvidence = z.infer<typeof ArtifactEvidence>;

export const VerifiedArtifact = z
  .object({
    artifactId: Id,
    path: Id,
    contentHash: Id,
    bytes: z.number().int().nonnegative(),
    /** Who proposed it, and in which run. Provenance back to the work. */
    proposedBy: z.object({ kind: z.string(), id: Id, agentRole: z.string().nullable() }).strict(),
    proposedSeq: z.number().int().positive(),
    /** The state the P5 engine returned. `GENERATED` until evidence says more. */
    state: z.enum(VERIFICATION_STATES),
    evidence: z.array(ArtifactEvidence),
    security: z
      .object({
        reviewed: z.boolean(),
        findings: z.number().int().nonnegative(),
        blocking: z.number().int().nonnegative(),
      })
      .strict(),
    /** Null unless the state is above GENERATED: nothing is verified by existing. */
    verifiedAt: z.string().nullable(),
    /** Every event that justifies the above, in order. */
    events: z.array(z.number().int().positive()),
  })
  .strict();
export type VerifiedArtifact = z.infer<typeof VerifiedArtifact>;

export const VerifiedArtifactsState = z
  .object({ artifacts: z.record(VerifiedArtifact), observations: ObservationLog })
  .strict();
export type VerifiedArtifactsState = z.infer<typeof VerifiedArtifactsState>;

export const VERIFIED_ARTIFACTS_PROJECTION = 'verified-artifacts';
export const VERIFIED_ARTIFACTS_VERSION = 1;

const put = (state: VerifiedArtifactsState, artifact: VerifiedArtifact): VerifiedArtifactsState => ({
  ...state,
  artifacts: { ...state.artifacts, [artifact.artifactId]: artifact },
});

const anomaly = (
  state: VerifiedArtifactsState,
  event: GenesisEvent,
  kind: 'MALFORMED_PAYLOAD' | 'STATE_MISMATCH' | 'UNKNOWN_REFERENCE',
  detail: string,
): VerifiedArtifactsState => ({ ...state, observations: noteAnomaly(state.observations, event, kind, detail) });

const Proposed = z
  .object({
    artifactId: Id,
    path: Id,
    contentHash: Id,
    bytes: z.number().int().nonnegative(),
    contents: z.string(),
  })
  .passthrough();

const Verified = z
  .object({ artifactId: Id, state: z.enum(VERIFICATION_STATES), evidenceCount: z.number().int().nonnegative() })
  .passthrough();

const Evidence = z
  .object({
    taskId: Id,
    environment: z.enum(['SANDBOX', 'STAGING', 'PRODUCTION', 'LOCAL']),
    exitCode: z.number().int(),
    raw: z.string(),
    claimedArtifacts: z.array(Id),
  })
  .passthrough();

const Message = z.object({ messageKind: z.string(), messageId: Id, envelope: z.unknown() }).passthrough();

/** The severity floor above which a finding blocks. Kept here so the fold agrees with the factory. */
export const DEFAULT_BLOCK_AT: Severity = 'HIGH';

export const emptyVerifiedArtifactsState = (): VerifiedArtifactsState => ({
  artifacts: {},
  observations: emptyObservations(),
});

function proposed(state: VerifiedArtifactsState, event: GenesisEvent): VerifiedArtifactsState {
  const parsed = Proposed.safeParse(event.payload);
  if (!parsed.success) return anomaly(state, event, 'MALFORMED_PAYLOAD', 'ARTIFACT_PROPOSED payload does not match');
  const { artifactId, path, contentHash, bytes } = parsed.data;
  const existing = state.artifacts[artifactId];
  // The same bytes at the same path are the same artifact. Re-proposing one is
  // not a new version and does not reset anything it has earned.
  if (existing !== undefined) {
    return put(state, { ...existing, events: [...existing.events, event.seq] });
  }
  return put(state, {
    artifactId,
    path,
    contentHash,
    bytes,
    proposedBy: { kind: event.actor.kind, id: event.actor.id, agentRole: event.actor.agentRole ?? null },
    proposedSeq: event.seq,
    // The honest default, and the same field that would say otherwise.
    state: 'GENERATED',
    evidence: [],
    security: { reviewed: false, findings: 0, blocking: 0 },
    verifiedAt: null,
    events: [event.seq],
  });
}

/**
 * Evidence an agent submitted, attached to every artifact it claims.
 *
 * Attaching it advances nothing by itself: the state only moves when the engine
 * is asked, and the engine is asked by the factory, not here.
 */
function evidenceReceived(state: VerifiedArtifactsState, event: GenesisEvent): VerifiedArtifactsState {
  const outer = Message.safeParse(event.payload);
  if (!outer.success) return anomaly(state, event, 'MALFORMED_PAYLOAD', 'AGENT_MESSAGE_RECEIVED payload does not match');
  if (outer.data.messageKind !== 'EVIDENCE_SUBMISSION') {
    return { ...state, observations: noteUnhandled(state.observations, event) };
  }
  const envelope = outer.data.envelope as { body?: unknown } | null;
  const body = Evidence.safeParse(envelope?.body);
  if (!body.success) return anomaly(state, event, 'MALFORMED_PAYLOAD', 'the evidence submission has no readable body');

  let next = state;
  for (const artifactId of body.data.claimedArtifacts) {
    const artifact = next.artifacts[artifactId];
    // Evidence for an artifact nobody proposed is recorded as an anomaly rather
    // than creating one: an artifact that exists only because something claimed
    // to have tested it has no bytes and no provenance.
    if (artifact === undefined) {
      next = anomaly(next, event, 'UNKNOWN_REFERENCE', `evidence claims artifact ${artifactId}, which was never proposed`);
      continue;
    }
    next = put(next, {
      ...artifact,
      evidence: [
        ...artifact.evidence,
        {
          observationId: outer.data.messageId,
          hash: '',
          environment: body.data.environment,
          exitCode: body.data.exitCode,
          testKind: (envelope as { body?: { testKind?: string } })?.body?.testKind ?? null,
          raw: body.data.raw,
          seq: event.seq,
        },
      ],
      events: [...artifact.events, event.seq],
    });
  }
  return next;
}

function verified(state: VerifiedArtifactsState, event: GenesisEvent): VerifiedArtifactsState {
  const parsed = Verified.safeParse(event.payload);
  if (!parsed.success) return anomaly(state, event, 'MALFORMED_PAYLOAD', 'FACTORY_ARTIFACT_VERIFIED payload does not match');
  const artifact = state.artifacts[parsed.data.artifactId];
  if (artifact === undefined) {
    return anomaly(state, event, 'UNKNOWN_REFERENCE', `no artifact ${parsed.data.artifactId}`);
  }
  const ruling = parsed.data.state;
  return put(state, {
    ...artifact,
    state: ruling,
    // Above GENERATED is the only thing that counts as verified at all, so it
    // is the only thing that gets a timestamp.
    verifiedAt: ruling === 'GENERATED' ? null : event.timestamp,
    events: [...artifact.events, event.seq],
  });
}

const Blocked = z.object({ blocking: z.array(z.object({ artifactId: Id }).passthrough()) }).passthrough();

function blocked(state: VerifiedArtifactsState, event: GenesisEvent): VerifiedArtifactsState {
  const parsed = Blocked.safeParse(event.payload);
  if (!parsed.success) return anomaly(state, event, 'MALFORMED_PAYLOAD', 'FACTORY_CHANGE_BLOCKED payload does not match');
  let next = state;
  for (const finding of parsed.data.blocking) {
    const artifact = next.artifacts[finding.artifactId];
    if (artifact === undefined) continue;
    next = put(next, {
      ...artifact,
      security: { reviewed: true, findings: artifact.security.findings + 1, blocking: artifact.security.blocking + 1 },
      events: [...artifact.events, event.seq],
    });
  }
  return next;
}

export const verifiedArtifactsProjector: Projector<VerifiedArtifactsState> = {
  name: VERIFIED_ARTIFACTS_PROJECTION,
  version: VERIFIED_ARTIFACTS_VERSION,
  initial: emptyVerifiedArtifactsState,
  apply(state, event) {
    switch (event.type) {
      case 'ARTIFACT_PROPOSED':
        return proposed(state, event);
      case 'AGENT_MESSAGE_RECEIVED':
        return evidenceReceived(state, event);
      case FACTORY_EVENTS.FACTORY_ARTIFACT_VERIFIED:
        return verified(state, event);
      case FACTORY_EVENTS.FACTORY_CHANGE_BLOCKED:
        return blocked(state, event);
      default:
        return { ...state, observations: noteUnhandled(state.observations, event) };
    }
  },
  parse: (value) => parseProjectionState(VerifiedArtifactsState, value, VERIFIED_ARTIFACTS_PROJECTION),
  observationsOf: (state) => state.observations,
};

/** True when this artifact has earned more than existing. */
export const isVerified = (artifact: VerifiedArtifact): boolean => artifact.state !== 'GENERATED';

/** The highest state anything in the run reached, lowest-first ordering respected. */
export const highestState = (artifacts: readonly VerifiedArtifact[]): VerificationState =>
  artifacts.reduce<VerificationState>(
    (best, a) => (VERIFICATION_STATES.indexOf(a.state) > VERIFICATION_STATES.indexOf(best) ? a.state : best),
    'GENERATED',
  );

/** The phrase SPEC-05 §6 requires for an artifact that exists and is not verified. */
export const describeState = (artifact: VerifiedArtifact): string =>
  isVerified(artifact) ? `${artifact.path} is ${artifact.state}` : `${artifact.path} is generated, not verified`;

/** Exported so the factory and the fold agree on what blocks. */
export const BLOCKING_SEVERITIES: readonly Severity[] = SEVERITIES.slice(0, SEVERITIES.indexOf(DEFAULT_BLOCK_AT) + 1);
