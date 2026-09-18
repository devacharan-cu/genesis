/**
 * Canonical enumerations.
 *
 * These lists are NOT the source of truth. `docs/architecture/00-MASTER-SPEC.md`
 * is, in its ```canonical:<Name>``` blocks. The test
 * `test/canonical-enums.test.ts` parses those blocks out of the markdown and
 * asserts these arrays match exactly, in the same order — so the specification
 * and the code cannot drift apart without a test going red.
 *
 * Add a value here and the test fails until the spec says the same thing.
 * Add it to the spec and the test fails until the code catches up. That is the
 * intended friction.
 */

export const MEMORY_CLASSES = [
  'WORKING',
  'SEMANTIC',
  'EPISODIC',
  'DECISION',
  'PROCEDURAL',
  'EVIDENCE',
  'ARCHIVED',
] as const;
export type MemoryClass = (typeof MEMORY_CLASSES)[number];

/** Ordered highest authority first. The order is load-bearing — see authority.ts. */
export const AUTHORITY_LEVELS = [
  'HUMAN_DECISION',
  'VERIFIED_SYSTEM_STATE',
  'ACTIVE_REQUIREMENT',
  'EVIDENCE',
  'HISTORICAL',
  'AI_ASSUMPTION',
] as const;
export type Authority = (typeof AUTHORITY_LEVELS)[number];

export const BELIEF_STATES = ['UNKNOWN', 'ASSUMED', 'SUPPORTED', 'TESTED', 'VERIFIED'] as const;
export type BeliefState = (typeof BELIEF_STATES)[number];

export const VERIFICATION_STATES = [
  'GENERATED',
  'STATIC_CHECKED',
  'UNIT_TESTED',
  'INTEGRATION_TESTED',
  'E2E_TESTED',
  'DEPLOYED',
  'PRODUCTION_VERIFIED',
] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

export const CHANGE_LIFECYCLE = [
  'PROPOSE',
  'IMPACT_ANALYSIS',
  'POLICY_CHECK',
  'APPLY',
  'TEST',
  'VERIFY',
  'COMMIT_STATE',
] as const;
export type ChangeLifecycle = (typeof CHANGE_LIFECYCLE)[number];

export const UNCERTAINTY_RESOLUTIONS = ['ASK_HUMAN', 'SEARCH', 'EXPERIMENT'] as const;
export type UncertaintyResolution = (typeof UNCERTAINTY_RESOLUTIONS)[number];

export const NODE_TYPES = [
  'PROJECT',
  'GOAL',
  'REQUIREMENT',
  'DECISION',
  'FEATURE',
  'COMPONENT',
  'FILE',
  'FUNCTION',
  'API',
  'DATABASE',
  'TEST',
  'ISSUE',
  'CHANGE',
  'EVIDENCE',
  'BELIEF',
  'UNCERTAINTY',
  'QUESTION',
  'EXPERIMENT',
  'DEPLOYMENT',
  'EVENT',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const EDGE_TYPES = [
  'CONTAINS',
  'DEPENDS_ON',
  'IMPLEMENTS',
  'VERIFIES',
  'SUPPORTS',
  'CONTRADICTS',
  'AFFECTS',
  'CAUSES',
  'FIXES',
  'CALLS',
  'READS',
  'WRITES',
  'CREATED_BY',
  'MODIFIED_BY',
  'SUPERSEDES',
  'DERIVED_FROM',
  'REQUIRES',
  'BLOCKS',
  'ACHIEVES',
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

export const COGNITIVE_LOOP_PHASES = [
  'OBSERVE',
  'UPDATE_WORLD_MODEL',
  'UPDATE_SELF_MODEL',
  'RETRIEVE_MEMORY',
  'CHECK_GOALS',
  'DETECT_UNCERTAINTY',
  'GENERATE_QUESTIONS',
  'GATHER_INFORMATION',
  'UPDATE_BELIEFS',
  'PLAN',
  'ACT',
  'VERIFY',
  'STORE_EXPERIENCE',
] as const;
export type CognitiveLoopPhase = (typeof COGNITIVE_LOOP_PHASES)[number];

/**
 * Maps each canonical block name in the specification to the array above.
 * Used by the drift test; exported so future tooling can reuse it.
 */
export const CANONICAL_ENUMS = {
  MemoryClass: MEMORY_CLASSES,
  Authority: AUTHORITY_LEVELS,
  BeliefState: BELIEF_STATES,
  VerificationState: VERIFICATION_STATES,
  ChangeLifecycle: CHANGE_LIFECYCLE,
  UncertaintyResolution: UNCERTAINTY_RESOLUTIONS,
  NodeType: NODE_TYPES,
  EdgeType: EDGE_TYPES,
  CognitiveLoopPhase: COGNITIVE_LOOP_PHASES,
} as const satisfies Record<string, readonly string[]>;
