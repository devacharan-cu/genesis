/**
 * The pipeline table, checked exhaustively.
 *
 * These are the properties ADR-0023 rests on, and they are asserted over the
 * table rather than over a path someone thought to walk: a repair cannot reach
 * VERIFY without being re-tested, nothing is verified that was not reviewed,
 * and no stage is unreachable decoration.
 */

import { FACTORY_STAGES, type FactoryStage } from '@genesis/core-types';
import { describe, expect, test } from 'vitest';
import {
  FACTORY_OUTCOMES,
  FIRST_STAGE,
  isDeterministic,
  ON_FAILURE,
  ON_SUCCESS,
  outcomeOfDeadEnd,
  reachableStages,
  REASONING_STAGES,
  REPAIR_CYCLE,
  stagesLeadingToVerify,
} from '../src/pipeline.js';

describe('the stage table', () => {
  test('covers every stage exactly once, in both directions', () => {
    expect(Object.keys(ON_SUCCESS).sort()).toEqual([...FACTORY_STAGES].sort());
    expect(Object.keys(ON_FAILURE).sort()).toEqual([...FACTORY_STAGES].sort());
  });

  test('names only real stages as destinations', () => {
    for (const table of [ON_SUCCESS, ON_FAILURE]) {
      for (const [from, to] of Object.entries(table)) {
        if (to === null) continue;
        expect(FACTORY_STAGES, `${from} -> ${to}`).toContain(to);
      }
    }
  });

  test('no stage succeeds into itself: a pass has to move', () => {
    for (const stage of FACTORY_STAGES) {
      expect(ON_SUCCESS[stage], stage).not.toBe(stage);
    }
  });

  test('every stage is reachable from PLAN, so none is decoration', () => {
    expect(reachableStages()).toEqual([...FACTORY_STAGES]);
  });

  test('the run starts at PLAN', () => {
    expect(FIRST_STAGE).toBe('PLAN');
  });
});

describe('what cannot be skipped', () => {
  test('a repair re-enters at TEST, never at VERIFY', () => {
    expect(ON_SUCCESS.REPAIR).toBe('TEST');
    expect(ON_SUCCESS.REPAIR).not.toBe('VERIFY');
    expect(ON_FAILURE.REPAIR).not.toBe('VERIFY');
  });

  test('VERIFY is reachable only from SECURITY_REVIEW', () => {
    expect(stagesLeadingToVerify()).toEqual(['SECURITY_REVIEW']);
  });

  test('the repair cycle passes through test, review and verify, in that order', () => {
    expect(REPAIR_CYCLE).toEqual(['DIAGNOSE', 'REPAIR', 'TEST', 'SECURITY_REVIEW', 'VERIFY']);
    // And the table actually walks it: each step leads to the next on success.
    for (let i = 0; i < REPAIR_CYCLE.length - 1; i += 1) {
      const from = REPAIR_CYCLE[i] as FactoryStage;
      expect(ON_SUCCESS[from], `${from}`).toBe(REPAIR_CYCLE[i + 1]);
    }
  });

  test('walking from a TEST failure reaches VERIFY only after TEST and SECURITY_REVIEW again', () => {
    const walked: FactoryStage[] = [];
    let stage: FactoryStage | null = ON_FAILURE.TEST;
    while (stage !== null && walked.length < 10) {
      walked.push(stage);
      if (stage === 'VERIFY') break;
      stage = ON_SUCCESS[stage];
    }
    expect(walked).toEqual(['DIAGNOSE', 'REPAIR', 'TEST', 'SECURITY_REVIEW', 'VERIFY']);
  });

  test('planning and architecture have no repair path: they need a person', () => {
    expect(ON_FAILURE.PLAN).toBeNull();
    expect(ON_FAILURE.ARCHITECT).toBeNull();
  });

  test('a failed build, test, review or verify is diagnosed rather than dropped', () => {
    for (const stage of ['BUILD', 'TEST', 'SECURITY_REVIEW', 'VERIFY'] as const) {
      expect(ON_FAILURE[stage], stage).toBe('DIAGNOSE');
    }
  });

  test('a failed diagnosis or repair is a dead end, not another attempt', () => {
    expect(ON_FAILURE.DIAGNOSE).toBeNull();
    expect(ON_FAILURE.REPAIR).toBeNull();
  });

  test('the success path terminates', () => {
    expect(ON_SUCCESS.VERIFY).toBeNull();
  });

  test('following success from PLAN reaches VERIFY without revisiting a stage', () => {
    const walked: FactoryStage[] = [];
    let stage: FactoryStage | null = FIRST_STAGE;
    while (stage !== null) {
      expect(walked, `revisited ${stage}`).not.toContain(stage);
      walked.push(stage);
      stage = ON_SUCCESS[stage];
    }
    expect(walked).toEqual(['PLAN', 'ARCHITECT', 'BUILD', 'TEST', 'SECURITY_REVIEW', 'VERIFY']);
  });
});

describe('which stages use a model', () => {
  test('the reasoning stages are the four that ask for something', () => {
    expect([...REASONING_STAGES]).toEqual(['PLAN', 'ARCHITECT', 'BUILD', 'DIAGNOSE']);
  });

  test('test, review and verify are deterministic: no model decides them', () => {
    for (const stage of ['TEST', 'SECURITY_REVIEW', 'VERIFY'] as const) {
      expect(isDeterministic(stage), stage).toBe(true);
    }
  });

  test('every stage is one or the other', () => {
    for (const stage of FACTORY_STAGES) {
      expect(isDeterministic(stage)).toBe(!REASONING_STAGES.includes(stage));
    }
  });
});

describe('dead ends', () => {
  test('reaching the end of VERIFY is the only way to be verified', () => {
    expect(outcomeOfDeadEnd('VERIFY')).toBe('VERIFIED');
    for (const stage of FACTORY_STAGES) {
      if (stage === 'VERIFY') continue;
      expect(outcomeOfDeadEnd(stage), stage).toBe('BLOCKED');
    }
  });

  test('a stage that stops short leaves the run blocked, not failed', () => {
    // BLOCKED means the work exists and a person can pick it up. FAILED is
    // reserved for the factory being unable to run at all.
    expect(outcomeOfDeadEnd('SECURITY_REVIEW')).toBe('BLOCKED');
    expect(FACTORY_OUTCOMES).toContain('BLOCKED');
    expect(FACTORY_OUTCOMES).toContain('FAILED');
  });
});
