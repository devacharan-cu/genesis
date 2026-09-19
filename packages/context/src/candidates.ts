/**
 * Candidate builders: turn records into context candidates (SPEC-01 §11.1).
 *
 * Pure functions over data the caller already holds — a cognition state, a
 * self model, memory records, graph nodes with their impact depths. They never
 * read a store; `gather.ts` does the reading. Each builder decides two things
 * and nothing else: which of its records are candidates at all, and which of
 * those are MANDATORY under §11.3.
 */

import {
  actionAuthority,
  type Belief,
  type CognitionState,
  type Contradiction,
  type Goal,
  isBlocking,
  isTerminalGoal,
  isTerminalUncertainty,
  type Question,
  type RecordedBy,
  type Uncertainty,
} from '@genesis/cognition';
import { type Authority, AUTHORITY_LEVELS, BELIEF_STATES, outranks } from '@genesis/core-types';
import type { GraphNode, ImpactEntry } from '@genesis/graph';
import { type MemoryRecord, VISIBLE_BY_DEFAULT } from '@genesis/memory';
import type { SelfModelState } from '@genesis/projections';
import type { ContextCandidate, ParsedContextRequest } from './model.js';

// =================================================================== distances

/**
 * Graph distance of every node the task reaches: its own nodes at 0, the rest
 * at their impact depth. The shortest wins.
 */
export function nodeDistances(taskNodeIds: readonly string[], impact: readonly ImpactEntry[]): Map<string, number> {
  const distances = new Map<string, number>();
  for (const entry of impact) {
    distances.set(entry.nodeId, Math.min(entry.depth, distances.get(entry.nodeId) ?? entry.depth));
  }
  for (const id of taskNodeIds) distances.set(id, 0);
  return distances;
}

/** The nearest of some nodes, or null when none is reached. */
function nearest(nodeIds: readonly string[], distances: ReadonlyMap<string, number>): number | null {
  const found = nodeIds.flatMap((id) => {
    const d = distances.get(id);
    return d === undefined ? [] : [d];
  });
  return found.length === 0 ? null : Math.min(...found);
}

/** Every ancestor of a goal with its distance, the goal itself at 0. */
function lineage(state: CognitionState, goalId: string): Map<string, number> {
  const out = new Map<string, number>();
  let current: Goal | undefined = state.goals[goalId];
  // Parents are fixed at creation and must already exist, so the chain ends.
  for (let depth = 0; current !== undefined; depth++) {
    out.set(current.id, depth);
    current = current.parentId === null ? undefined : state.goals[current.parentId];
  }
  return out;
}

/**
 * Steps between two goals in the goal tree, through their nearest common
 * ancestor; null when they share none or either is unknown.
 */
export function goalDistance(state: CognitionState, from: string, to: string): number | null {
  const a = lineage(state, from);
  const b = lineage(state, to);
  let best: number | null = null;
  for (const [id, da] of a) {
    const db = b.get(id);
    if (db !== undefined && (best === null || da + db < best)) best = da + db;
  }
  return best;
}

function nearestGoal(state: CognitionState, activeGoalId: string | null, goalIds: readonly string[]): number | null {
  if (activeGoalId === null) return null;
  const found = goalIds.flatMap((id) => {
    const d = goalDistance(state, activeGoalId, id);
    return d === null ? [] : [d];
  });
  return found.length === 0 ? null : Math.min(...found);
}

// ================================================================== cognition

/** A record's authority from who made it: the same ladder as an action's (ADR-0014). */
const madeBy = (by: RecordedBy): Authority => actionAuthority({ kind: by.actorKind, id: by.actorId });

/** Belief state (80%) and evidence count up to four (20%). */
const beliefStrength = (b: Belief): number =>
  (BELIEF_STATES.indexOf(b.state) / (BELIEF_STATES.length - 1)) * 0.8 +
  (Math.min(4, b.supportingEvidence.length) / 4) * 0.2;

const refIds = (refs: readonly { readonly nodeId: string }[]): string[] => refs.map((r) => r.nodeId);

function goalCandidate(state: CognitionState, req: ParsedContextRequest, g: Goal): ContextCandidate {
  const met = g.successCriteria.filter((c) => c.met).length;
  return {
    id: `goal:${g.id}`,
    kind: 'GOAL',
    text: `Goal (${g.status}, priority ${g.priority}): ${g.description}`,
    authority: madeBy(g.createdBy),
    goalDistance: nearestGoal(state, req.activeGoalId, [g.id]),
    dependencyDistance: null,
    evidenceStrength: g.successCriteria.length === 0 ? 0 : met / g.successCriteria.length,
    timestamp: g.history.at(-1)?.at ?? g.createdAt,
    mandatory: null,
    source: { store: 'COGNITION', id: g.id, version: null },
  };
}

function beliefCandidate(b: Belief, distances: ReadonlyMap<string, number>): ContextCandidate {
  const superseded = b.supersededBy.length > 0 ? ' [superseded by authority]' : '';
  return {
    id: `belief:${b.id}`,
    kind: 'BELIEF',
    text: `Belief (${b.state}${superseded}): ${b.statement}`,
    authority: b.authority,
    goalDistance: null,
    dependencyDistance: nearest(refIds(b.subjectRefs), distances),
    evidenceStrength: beliefStrength(b),
    timestamp: b.lastTransitionAt,
    mandatory: null,
    source: { store: 'COGNITION', id: b.id, version: null },
  };
}

function uncertaintyCandidate(
  state: CognitionState,
  req: ParsedContextRequest,
  u: Uncertainty,
  distances: ReadonlyMap<string, number>,
): ContextCandidate {
  const blocksActive = req.activeGoalId !== null && isBlocking(u) && u.blocksGoalIds.includes(req.activeGoalId);
  return {
    id: `uncertainty:${u.id}`,
    kind: 'UNCERTAINTY',
    text: `Open question (${u.risk} risk, ${u.status}): ${u.statement} — if wrong: ${u.impact.whatBreaksIfWrong}`,
    authority: madeBy(u.openedBy),
    goalDistance: nearestGoal(state, req.activeGoalId, u.blocksGoalIds),
    dependencyDistance: nearest(refIds(u.impact.affectedRefs), distances),
    evidenceStrength: 0,
    timestamp: u.openedAt,
    mandatory: blocksActive ? 'BLOCKING_UNCERTAINTY' : null,
    source: { store: 'COGNITION', id: u.id, version: null },
  };
}

function contradictionCandidate(
  state: CognitionState,
  c: Contradiction,
  distances: ReadonlyMap<string, number>,
): ContextCandidate {
  // A contradiction touches the impact set through its own refs, or through
  // the subjects of a belief on either side.
  const beliefRefs = c.sides.flatMap((s) =>
    s.ref.kind === 'BELIEF' ? refIds(state.beliefs[s.ref.id]?.subjectRefs ?? []) : [],
  );
  const distance = nearest([...refIds(c.affectedRefs), ...beliefRefs], distances);
  const [a, b] = c.sides;
  return {
    id: `contradiction:${c.id}`,
    kind: 'CONTRADICTION',
    text: `Contradiction (${c.status}): "${a.claim}" [${a.authority}] vs "${b.claim}" [${b.authority}]`,
    // Decided: as established as the side that governs. Undecided: only as
    // established as the weaker claim — otherwise a side whose authority an
    // agent asserted could lift the whole record up the ranking.
    authority: c.governingSide !== null ? c.sides[c.governingSide].authority : outranks(a.authority, b.authority) ? b.authority : a.authority,
    goalDistance: null,
    dependencyDistance: distance,
    evidenceStrength: 0,
    timestamp: c.resolution?.at ?? c.detectedAt,
    mandatory: c.status === 'ESCALATED' && distance !== null ? 'CONTRADICTION_IN_IMPACT' : null,
    source: { store: 'COGNITION', id: c.id, version: null },
  };
}

function answerCandidate(state: CognitionState, req: ParsedContextRequest, q: Question): ContextCandidate[] {
  if (q.response === null) return [];
  const r = q.response;
  return [
    {
      id: `answer:${q.id}`,
      kind: 'ANSWER',
      text: `Q: ${q.text} — ${r.kind}: ${r.text}`,
      authority: r.authority,
      goalDistance: nearestGoal(state, req.activeGoalId, q.affectedGoalIds),
      dependencyDistance: null,
      evidenceStrength: Math.min(4, r.evidence.length + 1) / 4,
      timestamp: r.respondedAt,
      mandatory: null,
      source: { store: 'COGNITION', id: q.id, version: null },
    },
  ];
}

/**
 * Candidates from the cognition projection: open goals, every belief (a
 * superseded one says so), open uncertainties, contradictions, and answered
 * questions — a person's answer is a decision the task must respect.
 */
export function cognitionCandidates(
  state: CognitionState,
  request: ParsedContextRequest,
  impact: readonly ImpactEntry[] = [],
): ContextCandidate[] {
  const distances = nodeDistances(request.task.nodeIds, impact);
  return [
    ...Object.values(state.goals)
      .filter((g) => !isTerminalGoal(g.status))
      .map((g) => goalCandidate(state, request, g)),
    ...Object.values(state.beliefs).map((b) => beliefCandidate(b, distances)),
    ...Object.values(state.uncertainties)
      .filter((u) => !isTerminalUncertainty(u.status))
      .map((u) => uncertaintyCandidate(state, request, u, distances)),
    ...Object.values(state.contradictions).map((c) => contradictionCandidate(state, c, distances)),
    ...Object.values(state.questions).flatMap((q) => answerCandidate(state, request, q)),
  ];
}

// ================================================================= self model

/**
 * Whether a failure signature matches a task kind. Provisional (ADR-0017;
 * SPEC-01 §12 item 2): the signature itself, or its first `:`-separated
 * segment, equals the kind — `migrate:timeout` matches `migrate`.
 */
export const signatureMatches = (signature: string, taskKind: string): boolean =>
  signature === taskKind || signature.split(':')[0] === taskKind;

/** Known failures matching the task kind. Every one is mandatory (§11.3). */
export function knownFailureCandidates(selfModel: SelfModelState, request: ParsedContextRequest): ContextCandidate[] {
  return Object.values(selfModel.knownFailures)
    .filter((f) => signatureMatches(f.signature, request.task.kind))
    .map((f) => ({
      id: `failure:${f.signature}`,
      kind: 'KNOWN_FAILURE' as const,
      text: `Known failure ${f.signature} (seen ${f.occurrences}x)${f.mitigation === null ? '' : `; mitigation: ${f.mitigation}`}`,
      // An observed failure is evidence about the system.
      authority: 'EVIDENCE' as const,
      goalDistance: null,
      dependencyDistance: null,
      evidenceStrength: Math.min(4, f.occurrences) / 4,
      timestamp: f.lastSeen,
      mandatory: 'MATCHING_FAILURE' as const,
      source: { store: 'SELF_MODEL' as const, id: f.signature, version: null },
    }));
}

// =================================================================== policies

/**
 * A policy that applies to the task. Which policies apply is the policy
 * engine's decision (P6); until it exists the caller supplies them.
 */
export interface ApplicablePolicy {
  readonly id: string;
  readonly text: string;
  readonly authority: Authority;
}

export function policyCandidates(policies: readonly ApplicablePolicy[]): ContextCandidate[] {
  return policies.map((p) => ({
    id: `policy:${p.id}`,
    kind: 'POLICY' as const,
    text: `Policy: ${p.text}`,
    authority: p.authority,
    goalDistance: null,
    dependencyDistance: null,
    evidenceStrength: 0,
    timestamp: null,
    mandatory: 'POLICY' as const,
    source: { store: 'POLICY' as const, id: p.id, version: null },
  }));
}

// ===================================================================== memory

/**
 * Memory records visible by default (SPEC-02: ACTIVE and CONTRADICTED — a
 * contradicted record is shown, and says so). Superseded, archived and
 * retracted records are never context.
 */
export function memoryCandidates(
  records: readonly MemoryRecord[],
  request: ParsedContextRequest,
  impact: readonly ImpactEntry[] = [],
): ContextCandidate[] {
  const distances = nodeDistances(request.task.nodeIds, impact);
  return records
    .filter((r) => VISIBLE_BY_DEFAULT.includes(r.status))
    .map((r) => ({
      id: `memory:${r.id}`,
      kind: 'MEMORY' as const,
      text: `${r.class} memory${r.status === 'CONTRADICTED' ? ' [contradicted]' : ''}: ${r.content.statement}`,
      authority: r.authority,
      goalDistance: null,
      dependencyDistance: nearest(refIds(r.relatedEntities), distances),
      evidenceStrength: Math.min(4, r.evidenceRefs.length) / 4,
      timestamp: r.updatedAt,
      mandatory: null,
      source: { store: 'MEMORY' as const, id: r.id, version: r.version },
    }));
}

// ====================================================================== graph

/**
 * Graph nodes in the task's impact set. A node's authority is that of the
 * weakest edge on the path that reached it (SPEC-03 §5.1): impact inherited
 * through a guess is worth a guess.
 */
export function graphCandidates(nodes: readonly GraphNode[], impact: readonly ImpactEntry[]): ContextCandidate[] {
  const byId = new Map(impact.map((e) => [e.nodeId as string, e]));
  return nodes.flatMap((n) => {
    const entry = byId.get(n.id);
    if (entry === undefined || n.status !== 'ACTIVE') return [];
    return [
      {
        id: `node:${n.id}`,
        kind: 'GRAPH_NODE' as const,
        text: `${n.type} ${n.label}`,
        authority: AUTHORITY_LEVELS[entry.weakestAuthorityRank - 1] as Authority,
        goalDistance: null,
        dependencyDistance: entry.depth,
        evidenceStrength: 0,
        timestamp: n.updatedAt,
        mandatory: null,
        source: { store: 'GRAPH' as const, id: n.id, version: n.version },
      },
    ];
  });
}
