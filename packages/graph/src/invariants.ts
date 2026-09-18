/**
 * Graph invariants G1–G13 (SPEC-03 §4).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). These are what make the graph's structural
 * claims true rather than aspirational: that the project tree is a tree, that
 * no edge crosses a project boundary, that an illegal relationship is a
 * rejected write and not a silent insert.
 *
 * Every check is a PURE FUNCTION over a small view of the graph, so the store
 * gathers the facts and this module decides. Keeping the decision separate is
 * what lets both adapters share one implementation of each rule rather than
 * each re-deriving it in its own query language.
 *
 * Three outcomes, and the difference matters:
 *   REJECT       the write does not happen (G1, G2, G3-component, G5, G6, G7, G10, G11)
 *   AUTO_REPAIR  the store performs a compensating write (G4)
 *   OBSERVE      the write proceeds and something is recorded (G3-file, G8, G9, G13)
 */

import {
  type Authority,
  type EdgeType,
  type NodeId,
  type NodeType,
  GenesisError,
} from '@genesis/core-types';
import { type GraphNode } from './schema.js';

export type InvariantId =
  | 'G1'
  | 'G2'
  | 'G3'
  | 'G4'
  | 'G5'
  | 'G6'
  | 'G7'
  | 'G8'
  | 'G9'
  | 'G10'
  | 'G11'
  | 'G12'
  | 'G13';

export type InvariantDisposition = 'REJECT' | 'AUTO_REPAIR' | 'OBSERVE';

export interface InvariantViolation {
  readonly invariant: InvariantId;
  readonly disposition: InvariantDisposition;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export class InvariantViolationError extends GenesisError {
  readonly violation: InvariantViolation;

  constructor(violation: InvariantViolation) {
    super('VALIDATION_FAILED', `${violation.invariant}: ${violation.message}`, violation.details);
    this.violation = violation;
  }
}

const reject = (
  invariant: InvariantId,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): InvariantViolation => ({ invariant, disposition: 'REJECT', message, details });

const observe = (
  invariant: InvariantId,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): InvariantViolation => ({ invariant, disposition: 'OBSERVE', message, details });

// ---------------------------------------------------------------- G7 table

/**
 * Legal endpoint types per edge type (SPEC-03 §3.1).
 *
 * `null` means "any node type". The table is the enforcement, so it is written
 * out rather than inferred: an edge type missing from it is a rejected write,
 * which is the safe direction when someone adds an edge type and forgets this.
 */
interface EndpointRule {
  readonly from: readonly NodeType[] | null;
  readonly to: readonly NodeType[] | null;
  readonly symmetric?: boolean;
}

export const ENDPOINT_RULES: Record<EdgeType, EndpointRule> = {
  CONTAINS: {
    from: ['PROJECT', 'COMPONENT', 'FILE', 'FEATURE', 'DATABASE'],
    to: null,
  },
  DEPENDS_ON: {
    from: ['COMPONENT', 'FILE', 'FEATURE', 'API', 'DATABASE'],
    to: ['COMPONENT', 'FILE', 'FEATURE', 'API', 'DATABASE'],
  },
  IMPLEMENTS: {
    from: ['FILE', 'FUNCTION', 'COMPONENT', 'API'],
    to: ['REQUIREMENT', 'FEATURE'],
  },
  VERIFIES: {
    from: ['TEST', 'EVIDENCE', 'EXPERIMENT'],
    to: ['REQUIREMENT', 'BELIEF', 'CHANGE', 'FEATURE'],
  },
  SUPPORTS: {
    from: ['EVIDENCE', 'BELIEF'],
    to: ['BELIEF'],
  },
  CONTRADICTS: { from: null, to: null, symmetric: true },
  AFFECTS: { from: null, to: null },
  CAUSES: {
    from: ['EVENT', 'CHANGE', 'ISSUE'],
    to: ['ISSUE', 'EVENT'],
  },
  FIXES: { from: ['CHANGE'], to: ['ISSUE'] },
  CALLS: { from: ['FUNCTION'], to: ['FUNCTION', 'API'] },
  READS: { from: ['FUNCTION', 'COMPONENT'], to: ['DATABASE', 'FILE'] },
  WRITES: { from: ['FUNCTION', 'COMPONENT'], to: ['DATABASE', 'FILE'] },
  CREATED_BY: { from: null, to: ['EVENT'] },
  MODIFIED_BY: { from: null, to: ['CHANGE', 'EVENT'] },
  SUPERSEDES: { from: null, to: null },
  DERIVED_FROM: { from: null, to: null },
  REQUIRES: { from: ['GOAL', 'CHANGE', 'FEATURE'], to: null },
  BLOCKS: {
    from: ['ISSUE', 'QUESTION', 'UNCERTAINTY'],
    to: ['GOAL', 'CHANGE'],
  },
  ACHIEVES: { from: ['CHANGE', 'FEATURE', 'EXPERIMENT'], to: ['GOAL'] },
};

/** Edge types whose endpoints must be the same node type (part of G5). */
const SAME_TYPE_EDGES: readonly EdgeType[] = ['SUPERSEDES'];

// ------------------------------------------------------- per-edge checks

/**
 * The slice of graph state an edge write needs to be validated against.
 *
 * Gathered by the store, which knows how to query; decided here, which knows
 * the rules.
 */
export interface EdgeWriteContext {
  readonly projectId: string;
  readonly from: GraphNode | null;
  readonly to: GraphNode | null;
  /** Existing CONTAINS parent of the `to` node, if any. Powers G1. */
  readonly existingContainsParent: NodeId | null;
  /**
   * True when a path already runs from `to` back to `from` along edges of the
   * same type. Powers the acyclicity rules G2, G3 and G5.
   */
  readonly wouldCreateCycle: boolean;
  /** True when the reciprocal CONTRADICTS edge already exists. Powers G4. */
  readonly reciprocalExists: boolean;
}

/**
 * Validates an edge write against G1–G7 and G11.
 *
 * Returns every violation found rather than the first, so a caller fixing a bad
 * write sees all of it at once. The store rejects if any has disposition
 * `REJECT`.
 */
export function checkEdgeWrite(
  edge: { type: EdgeType; from: NodeId; to: NodeId; authority: Authority },
  ctx: EdgeWriteContext,
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  // G6 — endpoints must exist and not be logically deleted.
  if (ctx.from === null) {
    violations.push(reject('G6', `edge source ${edge.from} does not exist`, { id: edge.from }));
  } else if (ctx.from.status === 'DELETED_LOGICALLY') {
    violations.push(
      reject('G6', `edge source ${edge.from} is logically deleted`, { id: edge.from }),
    );
  }
  if (ctx.to === null) {
    violations.push(reject('G6', `edge target ${edge.to} does not exist`, { id: edge.to }));
  } else if (ctx.to.status === 'DELETED_LOGICALLY') {
    violations.push(reject('G6', `edge target ${edge.to} is logically deleted`, { id: edge.to }));
  }

  // Everything below needs both endpoints. Bail rather than report noise.
  if (ctx.from === null || ctx.to === null) return violations;

  // G11 — no edge crosses a project boundary. Checked before the type rules
  // because a cross-project edge is a containment failure, not a modelling one.
  if (ctx.from.projectId !== ctx.projectId || ctx.to.projectId !== ctx.projectId) {
    violations.push(
      reject('G11', 'an edge may not cross a project boundary', {
        edgeProject: ctx.projectId,
        fromProject: ctx.from.projectId,
        toProject: ctx.to.projectId,
      }),
    );
  }

  // G7 — endpoint types must be legal for the edge type.
  const rule = ENDPOINT_RULES[edge.type];
  if (rule === undefined) {
    violations.push(
      reject('G7', `no endpoint rule declared for edge type ${edge.type}`, { type: edge.type }),
    );
  } else {
    if (rule.from !== null && !rule.from.includes(ctx.from.type)) {
      violations.push(
        reject(
          'G7',
          `${edge.type} may not start at a ${ctx.from.type} node (allowed: ${rule.from.join(', ')})`,
          { type: edge.type, fromType: ctx.from.type, allowed: rule.from },
        ),
      );
    }
    if (rule.to !== null && !rule.to.includes(ctx.to.type)) {
      violations.push(
        reject(
          'G7',
          `${edge.type} may not end at a ${ctx.to.type} node (allowed: ${rule.to.join(', ')})`,
          { type: edge.type, toType: ctx.to.type, allowed: rule.to },
        ),
      );
    }
  }

  // G5 — SUPERSEDES is same-type.
  if (SAME_TYPE_EDGES.includes(edge.type) && ctx.from.type !== ctx.to.type) {
    violations.push(
      reject('G5', `${edge.type} requires both endpoints to be the same node type`, {
        fromType: ctx.from.type,
        toType: ctx.to.type,
      }),
    );
  }

  // G1 — CONTAINS forms a forest: at most one parent.
  if (edge.type === 'CONTAINS' && ctx.existingContainsParent !== null) {
    violations.push(
      reject('G1', `node ${edge.to} already has a CONTAINS parent`, {
        child: edge.to,
        existingParent: ctx.existingContainsParent,
      }),
    );
  }

  // Self-loops are meaningless for every edge type the graph has.
  if (edge.from === edge.to) {
    violations.push(reject('G2', 'a node may not be linked to itself', { id: edge.from }));
  }

  // G2 / G3 / G5 — acyclicity.
  if (ctx.wouldCreateCycle) {
    if (edge.type === 'CONTAINS') {
      violations.push(reject('G2', 'CONTAINS must remain acyclic', { from: edge.from, to: edge.to }));
    } else if (edge.type === 'SUPERSEDES') {
      violations.push(
        reject('G5', 'SUPERSEDES must remain acyclic', { from: edge.from, to: edge.to }),
      );
    } else if (edge.type === 'DEPENDS_ON') {
      // G3 splits by layer. A cycle between architectural COMPONENT nodes is a
      // design defect worth blocking; a FILE-level cycle is a real and common
      // fact about code, so it is recorded as an issue instead of rejected.
      const architectural = ctx.from.type === 'COMPONENT' && ctx.to.type === 'COMPONENT';
      violations.push(
        architectural
          ? reject('G3', 'DEPENDS_ON must remain acyclic across COMPONENT nodes', {
              from: edge.from,
              to: edge.to,
            })
          : observe('G3', 'DEPENDS_ON cycle recorded below the component layer', {
              from: edge.from,
              to: edge.to,
              fromType: ctx.from.type,
              toType: ctx.to.type,
            }),
      );
    }
  }

  return violations;
}

/**
 * G4 — CONTRADICTS is symmetric.
 *
 * Returns true when the store must write the reciprocal edge. Auto-repair
 * rather than rejection: the caller's intent is unambiguous, and refusing a
 * well-meant one-directional write would be pedantry. Reporting it as a
 * violation at all is what makes the repair visible.
 */
export function needsReciprocal(type: EdgeType, ctx: { reciprocalExists: boolean }): boolean {
  return ENDPOINT_RULES[type]?.symmetric === true && !ctx.reciprocalExists;
}

// ------------------------------------------------------- node-level checks

/**
 * G10 has no function here on purpose.
 *
 * "Nodes are never hard-deleted" is enforced by the PORT not having a delete
 * method — there is no call to guard. A checker function would be decoration:
 * nothing could ever call it with a failing value. The conformance suite
 * asserts the absence of the method instead, which is the real guarantee.
 */

/**
 * The structural gaps the graph notices about itself: G8, G9 and G13.
 *
 * These do NOT block writes. They are how the structure generates
 * uncertainties — a requirement nobody implemented, an implementation nobody
 * tested, a blocking uncertainty that blocks nothing. The uncertainty engine
 * that consumes them arrives in P2; P1 surfaces them so the gap is visible in
 * the type rather than only in a document.
 */
export interface OrphanView {
  readonly node: GraphNode;
  readonly inboundTypes: readonly EdgeType[];
  readonly outboundTypes: readonly EdgeType[];
}

export function checkStructuralGaps(view: OrphanView): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const { node, inboundTypes, outboundTypes } = view;

  if (node.type === 'REQUIREMENT' && node.attrs['inForce'] === true) {
    if (!inboundTypes.includes('IMPLEMENTS')) {
      violations.push(
        observe('G8', 'requirement is in force but nothing implements it', { id: node.id }),
      );
    } else if (!inboundTypes.includes('VERIFIES')) {
      violations.push(
        observe('G9', 'requirement is implemented but nothing verifies it', { id: node.id }),
      );
    }
  }

  if (
    node.type === 'UNCERTAINTY' &&
    node.attrs['blocking'] === true &&
    node.attrs['status'] === 'OPEN' &&
    !outboundTypes.includes('BLOCKS')
  ) {
    violations.push(
      observe('G13', 'blocking uncertainty is open but blocks nothing', { id: node.id }),
    );
  }

  return violations;
}

/** Splits a violation list into the ones that stop a write and the rest. */
export function rejections(violations: readonly InvariantViolation[]): InvariantViolation[] {
  return violations.filter((v) => v.disposition === 'REJECT');
}
