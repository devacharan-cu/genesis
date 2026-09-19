/**
 * The uncertainty engine (SPEC-01 §7). Unknowns are records; these tests make
 * sure none of them can quietly disappear, be closed by the wrong actor, or be
 * double-counted by a detector that runs twice.
 */

import {
  detectBeliefGaps,
  detectCapabilityGaps,
  detectCriterionGaps,
  draftToCommand,
  isBlocking,
  openUncertainties,
  selectResolution,
  uncertaintiesByRisk,
} from '@genesis/cognition';
import { selfModelProjector } from '@genesis/projections';
import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT, expectRefused, HUMAN, Mind, SYSTEM, testCriterion } from './support.js';

let mind: Mind;
beforeEach(() => {
  mind = new Mind();
});

const record = (over: Record<string, unknown> = {}, actor = SYSTEM): string => {
  mind.run(actor, {
    kind: 'RECORD_UNCERTAINTY',
    statement: 'which region?',
    whatBreaksIfWrong: 'deploys land in the wrong region',
    risk: 'MEDIUM',
    resolution: 'SEARCH',
    ...over,
  });
  return mind.lastId('uncertainty');
};

const setStatus = (kind: string, id: string, actor = SYSTEM, extra: Record<string, unknown> = {}): void => {
  mind.run(actor, { kind, uncertaintyId: id, ...extra });
};

describe('recording', () => {
  it('records an explicit unknown with impact, risk, affected nodes and resolution', () => {
    const id = record({ affectedRefs: [{ nodeType: 'COMPONENT', nodeId: 'node_gw' }], relatedQuestions: ['q-2', 'q-1', 'q-1'] });
    const u = mind.state.uncertainties[id];
    expect(u?.status).toBe('OPEN');
    expect(u?.impact.affectedRefs).toEqual([{ nodeType: 'COMPONENT', nodeId: 'node_gw' }]);
    expect([u?.risk, u?.resolution, u?.source, u?.sourceRef]).toEqual(['MEDIUM', 'SEARCH', 'MANUAL', null]);
    expect(u?.relatedQuestions).toEqual(['q-1', 'q-2']);
    expect(u && isBlocking(u)).toBe(false);
  });

  it('blocks named goals, and refuses a goal that is missing or closed', () => {
    mind.run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'g', priority: 1, successCriteria: [testCriterion()] });
    const goal = mind.lastId('goal');
    const id = record({ blocksGoalIds: [goal, goal] });
    const u = mind.state.uncertainties[id];
    expect(u?.blocksGoalIds).toEqual([goal]);
    expect(u && isBlocking(u)).toBe(true);

    expectRefused(mind, 'GOAL_NOT_FOUND', () => record({ blocksGoalIds: ['goal-404'] }));
    mind.run(HUMAN, { kind: 'ABANDON_GOAL', goalId: goal, reason: 'x' });
    expectRefused(mind, 'GOAL_CLOSED', () => record({ blocksGoalIds: [goal] }));
  });

  it('links beliefs, and refuses one that does not exist', () => {
    mind.run(SYSTEM, { kind: 'RECORD_BELIEF', statement: 'b' });
    const belief = mind.lastId('belief');
    // Record first, then read: `mind.state` is replaced by the fold, so reading
    // it in the same expression would look at the state from before the record.
    const id = record({ relatedBeliefs: [belief] });
    expect(mind.state.uncertainties[id]?.relatedBeliefs).toEqual([belief]);
    expectRefused(mind, 'BELIEF_NOT_FOUND', () => record({ relatedBeliefs: ['bel-404'] }));
  });

  it('requires provenance for a detected uncertainty, and refuses a duplicate', () => {
    expectRefused(mind, 'SOURCE_REF_REQUIRED', () => record({ source: 'BELIEF_GAP' }));
    mind.run(SYSTEM, { kind: 'RECORD_BELIEF', statement: 'b' });
    const belief = mind.lastId('belief');
    record({ source: 'BELIEF_GAP', sourceRef: belief });
    expectRefused(mind, 'DUPLICATE_UNCERTAINTY', () => record({ source: 'BELIEF_GAP', sourceRef: belief }));
  });

  it('reserves the CONTRADICTION source for the contradiction engine', () => {
    expectRefused(mind, 'RESERVED_SOURCE', () => record({ source: 'CONTRADICTION', sourceRef: 'ctr-1' }));
  });

  it('refuses an unknown risk or resolution', () => {
    expectRefused(mind, 'INVALID_COMMAND', () => record({ risk: 'SEVERE' }));
    expectRefused(mind, 'INVALID_COMMAND', () => record({ resolution: 'GUESS' }));
  });
});

describe('lifecycle', () => {
  it('moves OPEN → IN_PROGRESS → RESOLVED with evidence, and stamps resolvedAt', () => {
    const id = record();
    setStatus('START_RESOLVING', id);
    setStatus('RESOLVE_UNCERTAINTY', id, SYSTEM, { evidence: ['doc-2', 'doc-1', 'doc-1'] });
    const u = mind.state.uncertainties[id];
    expect(u?.status).toBe('RESOLVED');
    expect(u?.resolutionEvidence).toEqual(['doc-1', 'doc-2']);
    expect(u?.resolvedAt).not.toBeNull();
    expect(u?.history.map((h) => h.to)).toEqual(['IN_PROGRESS', 'RESOLVED']);
  });

  it('refuses resolving without evidence', () => {
    const id = record();
    expectRefused(mind, 'RESOLUTION_EVIDENCE_REQUIRED', () =>
      setStatus('RESOLVE_UNCERTAINTY', id, SYSTEM, { evidence: [] }),
    );
  });

  it('lets only a human answer an ASK_HUMAN uncertainty', () => {
    const id = record({ resolution: 'ASK_HUMAN' });
    expectRefused(mind, 'HUMAN_ANSWER_REQUIRED', () =>
      setStatus('RESOLVE_UNCERTAINTY', id, AGENT, { evidence: ['guess'] }),
    );
    setStatus('RESOLVE_UNCERTAINTY', id, HUMAN, { evidence: ['answer'], reason: 'eu-west-1' });
    expect(mind.state.uncertainties[id]?.history.at(-1)?.reason).toBe('eu-west-1');
  });

  it('lets only a human accept one, with a reason, and records that it was accepted rather than closed', () => {
    const id = record();
    expectRefused(mind, 'HUMAN_ONLY', () => setStatus('ACCEPT_UNCERTAINTY', id, SYSTEM, { reason: 'fine' }));
    expectRefused(mind, 'REASON_REQUIRED', () => setStatus('ACCEPT_UNCERTAINTY', id, HUMAN));
    setStatus('ACCEPT_UNCERTAINTY', id, HUMAN, { reason: 'we can live with either region' });
    expect(mind.state.uncertainties[id]?.status).toBe('ACCEPTED');
  });

  it('marks one obsolete with a reason', () => {
    const id = record();
    expectRefused(mind, 'REASON_REQUIRED', () => setStatus('MARK_UNCERTAINTY_OBSOLETE', id));
    setStatus('MARK_UNCERTAINTY_OBSOLETE', id, AGENT, { reason: 'feature removed' });
    expect(mind.state.uncertainties[id]?.status).toBe('OBSOLETE');
  });

  it('never reopens a terminal uncertainty', () => {
    const id = record();
    setStatus('MARK_UNCERTAINTY_OBSOLETE', id, SYSTEM, { reason: 'x' });
    expectRefused(mind, 'UNCERTAINTY_NOT_OPEN', () => setStatus('START_RESOLVING', id));
    expectRefused(mind, 'UNCERTAINTY_CLOSED', () => setStatus('RESOLVE_UNCERTAINTY', id, SYSTEM, { evidence: ['e'] }));
    expectRefused(mind, 'UNCERTAINTY_CLOSED', () => setStatus('ACCEPT_UNCERTAINTY', id, HUMAN, { reason: 'x' }));
    expectRefused(mind, 'UNCERTAINTY_CLOSED', () => setStatus('MARK_UNCERTAINTY_OBSOLETE', id, SYSTEM, { reason: 'x' }));
  });

  it('refuses a command for an uncertainty that does not exist', () => {
    expectRefused(mind, 'UNCERTAINTY_NOT_FOUND', () => setStatus('START_RESOLVING', 'unc-404'));
  });
});

describe('ordering and strategy (SPEC-01 §7.2)', () => {
  it('lists open uncertainties by risk, then age, then id', () => {
    const low = record({ risk: 'LOW' });
    const critical = record({ risk: 'CRITICAL' });
    const mediumOld = record({ risk: 'MEDIUM' });
    const mediumNew = record({ risk: 'MEDIUM' });
    const closed = record({ risk: 'CRITICAL' });
    setStatus('MARK_UNCERTAINTY_OBSOLETE', closed, SYSTEM, { reason: 'x' });

    expect(uncertaintiesByRisk(mind.state).map((u) => u.id)).toEqual([critical, mediumOld, mediumNew, low]);
    expect(openUncertainties(mind.state).map((u) => u.id)).not.toContain(closed);
  });

  it('breaks an exact tie by id, so the order is total', () => {
    // Two records folded with one timestamp: only the id can order them.
    const a = record();
    const b = record();
    const at = mind.state.uncertainties[a]?.openedAt ?? '';
    const tied = {
      ...mind.state,
      uncertainties: Object.fromEntries(
        Object.entries(mind.state.uncertainties).map(([k, u]) => [k, { ...u, openedAt: at }]),
      ),
    };
    expect(uncertaintiesByRisk(tied).map((u) => u.id)).toEqual([a, b]);
  });

  it('prefers the cheapest strategy that can settle the question', () => {
    expect(selectResolution({ bySearch: true, byExperiment: true })).toBe('SEARCH');
    expect(selectResolution({ bySearch: false, byExperiment: true })).toBe('EXPERIMENT');
    expect(selectResolution({ bySearch: false, byExperiment: false })).toBe('ASK_HUMAN');
  });
});

describe('detection (SPEC-01 §7.1)', () => {
  it('source 1: beliefs a plan depends on that are UNKNOWN or ASSUMED', () => {
    mind.run(SYSTEM, { kind: 'RECORD_BELIEF', statement: 'unknown one' });
    const unknown = mind.lastId('belief');
    mind.run(SYSTEM, { kind: 'RECORD_BELIEF', statement: 'assumed one', state: 'ASSUMED', rationale: 'r' });
    const assumed = mind.lastId('belief');
    mind.run(SYSTEM, { kind: 'RECORD_BELIEF', statement: 'supported', state: 'ASSUMED', rationale: 'r' });
    const supported = mind.lastId('belief');
    mind.run(SYSTEM, {
      kind: 'ADD_BELIEF_EVIDENCE',
      beliefId: supported,
      polarity: 'SUPPORTING',
      evidence: { evidenceId: 'e', kind: 'DOCUMENT', producedBy: 'x', environment: 'NONE', couldFalsify: false },
    });
    mind.run(SYSTEM, { kind: 'TRANSITION_BELIEF', beliefId: supported, to: 'SUPPORTED' });

    const drafts = detectBeliefGaps(mind.state, [supported, assumed, unknown, unknown]);
    // Ordered by belief id; unknown (bel-1) sorts before assumed (bel-2).
    expect(drafts.map((d) => [d.sourceRef, d.risk])).toEqual([
      [unknown, 'HIGH'],
      [assumed, 'MEDIUM'],
    ]);

    // Recording one makes the detector stop reporting it: detectors never double-count.
    const first = drafts[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    mind.run(SYSTEM, draftToCommand(first));
    expect(detectBeliefGaps(mind.state, [supported, assumed, unknown]).map((d) => d.sourceRef)).not.toContain(
      first.sourceRef,
    );
  });

  it('source 1 refuses a dependency on a belief nobody recorded', () => {
    expect(() => detectBeliefGaps(mind.state, ['bel-404'])).toThrow(/no belief bel-404/);
  });

  it('source 3: machine-checked criteria of ACTIVE goals that name no check', () => {
    mind.run(HUMAN, {
      kind: 'PROPOSE_GOAL',
      description: 'g',
      priority: 1,
      successCriteria: [
        testCriterion(),
        { statement: 'docs exist', checkKind: 'EVIDENCE' },
        { statement: 'sign-off', checkKind: 'HUMAN_CONFIRMATION' },
      ],
    });
    const goal = mind.lastId('goal');
    expect(detectCriterionGaps(mind.state)).toEqual([]); // not ACTIVE yet
    mind.run(HUMAN, { kind: 'ACTIVATE_GOAL', goalId: goal });

    const drafts = detectCriterionGaps(mind.state);
    expect(drafts).toHaveLength(1);
    const gap = drafts[0];
    if (gap === undefined) return;
    mind.run(SYSTEM, draftToCommand(gap));
    expect(detectCriterionGaps(mind.state)).toEqual([]);
  });

  it('source 3 ignores a criterion that is already met', () => {
    mind.run(HUMAN, {
      kind: 'PROPOSE_GOAL',
      description: 'g',
      priority: 1,
      successCriteria: [testCriterion(), { statement: 'docs', checkKind: 'EVIDENCE' }],
    });
    const goal = mind.lastId('goal');
    mind.run(HUMAN, { kind: 'ACTIVATE_GOAL', goalId: goal });
    const docs = mind.state.goals[goal]?.successCriteria[1]?.id ?? '';
    mind.run(SYSTEM, { kind: 'MARK_CRITERION_MET', goalId: goal, criterionId: docs, evidenceRef: 'e' });
    expect(detectCriterionGaps(mind.state)).toEqual([]);
  });

  it('source 5: required capabilities the self model has as UNAVAILABLE or never saw', () => {
    const self = selfModelProjector.initial();
    const withCaps = {
      ...self,
      capabilities: {
        deploy: { id: 'deploy', description: '', status: 'UNAVAILABLE' as const, evidenceRef: null, since: 't', seq: 1 },
        test: { id: 'test', description: '', status: 'AVAILABLE' as const, evidenceRef: 'e', since: 't', seq: 2 },
        lint: { id: 'lint', description: '', status: 'DEGRADED' as const, evidenceRef: null, since: 't', seq: 3 },
      },
    };
    const drafts = detectCapabilityGaps(mind.state, withCaps, ['test', 'deploy', 'lint', 'migrate', 'deploy']);
    expect(drafts.map((d) => [d.sourceRef, d.resolution])).toEqual([
      ['deploy', 'EXPERIMENT'],
      ['migrate', 'EXPERIMENT'],
    ]);
    expect(drafts[0]?.whatBreaksIfWrong).toMatch(/UNAVAILABLE/);
    expect(drafts[1]?.whatBreaksIfWrong).toMatch(/unobserved/);

    const first = drafts[0];
    if (first === undefined) return;
    mind.run(SYSTEM, draftToCommand(first));
    expect(detectCapabilityGaps(mind.state, withCaps, ['deploy']).map((d) => d.sourceRef)).toEqual([]);
  });
});
