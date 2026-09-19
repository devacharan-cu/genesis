/**
 * Question scoring (SPEC-01 §9.2, ADR-0017).
 *
 *     value = informationGain × decisionImpact × riskReduction × dependencyCoverage
 *
 * SPEC-01 is explicit that this is a heuristic that will be wrong in ways not
 * yet known, so the formula lives behind `QuestionScorer`, in this one module,
 * and the scorer's name and version are recorded next to every score it makes.
 *
 * A scorer returns the four FACTORS, never the value. The value is always their
 * product, computed here, so a recorded score cannot disagree with its own
 * breakdown. Factors are checked before anything is recorded: a scorer that
 * returns NaN, a negative number or 1.5 is refused, not clamped — clamping
 * would record a score the scorer never produced.
 *
 * The default scorer is a pure function of the cognition state. No clock, no
 * randomness, no model: the same state always scores the same.
 */

import { type BeliefState, type GoalStatus, RISK_LEVELS } from '@genesis/core-types';
import { violation } from './context.js';
import { blockingUncertainties, isTerminalGoal } from './goals.js';
import { type CognitionState, QuestionScore, type ScoreFactors, type Uncertainty } from './records.js';

export interface QuestionScorer {
  /** Recorded with every score, so a replaced scorer leaves an audit trail. */
  readonly name: string;
  readonly version: number;
  /** The four factors for a question that would settle `uncertainty`. Must be pure. */
  score(state: CognitionState, uncertainty: Uncertainty): ScoreFactors;
}

/** Belief states an answer could still move. Past SUPPORTED, a belief needs tests, not answers. */
const TRANSITIONABLE: ReadonlySet<BeliefState> = new Set<BeliefState>(['UNKNOWN', 'ASSUMED']);

/** Goals whose plans an answer can change right now. */
const IN_PLAY: ReadonlySet<GoalStatus> = new Set<GoalStatus>(['ACTIVE', 'BLOCKED']);

/**
 * informationGain: the belief-transition proxy of §9.2. Of the beliefs the
 * uncertainty names, how many could an answer still move? `(1 + movable) /
 * (1 + named)`, so an uncertainty with no named beliefs scores 1 — an answer
 * settles the uncertainty itself — and one whose beliefs are all past ASSUMED
 * scores low: the answer would teach the system little it does not know.
 */
function informationGain(state: CognitionState, u: Uncertainty): number {
  const named = new Set(u.relatedBeliefs);
  const movable = Object.values(state.beliefs).filter(
    (b) => named.has(b.id) && TRANSITIONABLE.has(b.state),
  ).length;
  return (1 + movable) / (1 + named.size);
}

/**
 * decisionImpact: does the answer change a pending decision? 1 when it blocks a
 * goal in play, 0.6 when it blocks only goals not yet started, 0.4 when it
 * blocks no goal but names affected graph nodes, 0.2 otherwise.
 */
function decisionImpact(state: CognitionState, u: Uncertainty): number {
  const blocked = Object.values(state.goals).filter(
    (g) => u.blocksGoalIds.includes(g.id) && !isTerminalGoal(g.status),
  );
  if (blocked.some((g) => IN_PLAY.has(g.status))) return 1;
  if (blocked.length > 0) return 0.6;
  return u.impact.affectedRefs.length > 0 ? 0.4 : 0.2;
}

/** riskReduction: the uncertainty's risk, normalised so CRITICAL is 1 and LOW 0.25. */
const riskReduction = (u: Uncertainty): number => (RISK_LEVELS.indexOf(u.risk) + 1) / RISK_LEVELS.length;

/**
 * dependencyCoverage: of the uncertainties blocking a goal, the share this one
 * is. Answering the only blocker of a goal unblocks it entirely (1); answering
 * one of four unblocks a quarter. The best goal counts. An uncertainty that
 * blocks no open goal covers no dependency, and scores 0 — see ADR-0017,
 * "Negative", for why that is kept rather than floored.
 */
function dependencyCoverage(state: CognitionState, u: Uncertainty): number {
  return Object.values(state.goals)
    .filter((g) => u.blocksGoalIds.includes(g.id) && !isTerminalGoal(g.status))
    .map((g) => 1 / Math.max(1, blockingUncertainties(state, g.id).length))
    .reduce((best, share) => Math.max(best, share), 0);
}

export const defaultQuestionScorer: QuestionScorer = {
  name: 'genesis.default-question-scorer',
  version: 1,
  score: (state, u) => ({
    informationGain: informationGain(state, u),
    decisionImpact: decisionImpact(state, u),
    riskReduction: riskReduction(u),
    dependencyCoverage: dependencyCoverage(state, u),
  }),
};

/**
 * Scores a question with `scorer`, and records which scorer did it. Refuses a
 * breakdown that is not four numbers in [0, 1] (`INVALID_SCORE`).
 */
export function scoreQuestion(
  state: CognitionState,
  uncertainty: Uncertainty,
  scorer: QuestionScorer = defaultQuestionScorer,
): QuestionScore {
  const f = scorer.score(state, uncertainty);
  const parsed = QuestionScore.safeParse({
    informationGain: f.informationGain,
    decisionImpact: f.decisionImpact,
    riskReduction: f.riskReduction,
    dependencyCoverage: f.dependencyCoverage,
    value: f.informationGain * f.decisionImpact * f.riskReduction * f.dependencyCoverage,
    scorer: { name: scorer.name, version: scorer.version },
  });
  if (!parsed.success) {
    return violation('INVALID_SCORE', `scorer ${scorer.name} returned an invalid score`, {
      scorer: scorer.name,
      issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  return parsed.data;
}
