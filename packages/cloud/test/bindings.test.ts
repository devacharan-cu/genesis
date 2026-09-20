/**
 * Where the deployment and the runtime are checked against each other.
 *
 * Two packages deliberately restate something a third owns, because importing
 * across those boundaries would invert the dependencies. This is the file that
 * makes the restatement safe, and it is the only place that can be: it is the
 * only package allowed to name the infrastructure, the adapters and the factory
 * at once.
 */

import { GENESIS_TABLE_SCHEMA } from '@genesis/adapters-aws';
import { FACTORY_STAGES } from '@genesis/core-types';
import { FIRST_STAGE, ON_FAILURE, ON_SUCCESS } from '@genesis/factory';
import { danglingTransitions, genesisStack, KEY_ATTRIBUTES, reachableStates, stageStateName } from '@genesis/infrastructure';
import { describe, expect, it } from 'vitest';
import {
  checkDeploymentBindings,
  DEPLOYMENT_NAMES,
  deployedFactoryMachine,
  RUNTIME_NAMES,
} from '../src/bindings.js';

describe('the table the stack creates is the table the adapters query', () => {
  it('agrees on every key name', () => {
    expect(checkDeploymentBindings()).toEqual([]);
  });

  it('declares every attribute the adapter indexes on', () => {
    const declared = new Set(KEY_ATTRIBUTES);
    for (const keys of Object.values(GENESIS_TABLE_SCHEMA.indexes)) {
      expect(declared.has(keys.partition as never), keys.partition).toBe(true);
      expect(declared.has(keys.sort as never), keys.sort).toBe(true);
    }
    expect(declared.has(GENESIS_TABLE_SCHEMA.keys.partition as never)).toBe(true);
    expect(declared.has(GENESIS_TABLE_SCHEMA.keys.sort as never)).toBe(true);
  });

  it('creates exactly the indexes the adapter expects, by name', () => {
    const stack = genesisStack({
      projectId: 'prj-1',
      environment: 'dev',
      deploymentBucket: 'b',
      deploymentKey: 'k.zip',
      modelIds: ['m'],
    });
    const created = (stack.Resources['GenesisTable']?.Properties['GlobalSecondaryIndexes'] as { IndexName: string }[]).map(
      (index) => index.IndexName,
    );
    expect(created.sort()).toEqual(Object.keys(GENESIS_TABLE_SCHEMA.indexes).sort());
  });

  it('reports a renamed key, so the check is known to compare', () => {
    const mismatches = checkDeploymentBindings({ ...DEPLOYMENT_NAMES, partition: 'partitionKey' });
    expect(mismatches).toEqual([{ what: 'table partition key', deployment: 'partitionKey', runtime: 'pk' }]);
  });

  it('reports a renamed sort key', () => {
    expect(checkDeploymentBindings({ ...DEPLOYMENT_NAMES, sort: 'sortKey' }).map((m) => m.what)).toEqual([
      'table sort key',
    ]);
  });

  it('reports an index the adapters do not have', () => {
    const mismatches = checkDeploymentBindings({ ...DEPLOYMENT_NAMES, indexes: ['gsi1', 'gsi3'] });
    expect(mismatches.map((m) => m.what)).toEqual(['index names']);
  });

  it('reports an index whose key attributes were renamed', () => {
    const renamed = {
      ...RUNTIME_NAMES,
      indexes: { gsi1: { partition: 'g1p', sort: 'g1s' }, gsi2: RUNTIME_NAMES.indexes['gsi2'] as never },
    };
    expect(checkDeploymentBindings(DEPLOYMENT_NAMES, renamed).map((m) => m.what)).toEqual([
      'gsi1 partition attribute',
      'gsi1 sort attribute',
    ]);
  });

  it('reports every mismatch at once rather than the first', () => {
    const wrong = { partition: 'a', sort: 'b', indexes: ['gsi1', 'gsi2'] };
    expect(checkDeploymentBindings(wrong)).toHaveLength(2);
  });
});

describe('the deployed state machine is the factory’s own pipeline', () => {
  const machine = deployedFactoryMachine('arn:aws:lambda:eu-west-1:1:function:stage');

  it('starts where the factory starts', () => {
    expect(machine.StartAt).toBe(stageStateName(FIRST_STAGE));
  });

  it('follows the factory’s transitions exactly', () => {
    for (const stage of FACTORY_STAGES) {
      const outcome = machine.States[`${stageStateName(stage)}Outcome`];
      expect(outcome?.Type, stage).toBe('Choice');
      if (outcome?.Type !== 'Choice') return;

      const success = ON_SUCCESS[stage];
      const failure = ON_FAILURE[stage];
      expect(outcome.Choices[0]?.['Next'], `${stage} succeeded`).toBe(success === null ? 'RunComplete' : stageStateName(success));
      expect(outcome.Default, `${stage} failed`).toBe(failure === null ? 'RunBlocked' : stageStateName(failure));
    }
  });

  it('sends a repaired change back through the checks', () => {
    // The property ADR-0023 §2 exists for, asserted against the deployment
    // rather than only against the factory's own table.
    expect(ON_SUCCESS.REPAIR).toBe('TEST');
    const outcome = machine.States['StageRepairOutcome'];
    expect(outcome?.Type === 'Choice' && outcome.Choices[0]?.['Next']).toBe(stageStateName('TEST'));
  });

  it('can be deployed: every transition resolves and no state is unreachable', () => {
    expect(danglingTransitions(machine)).toEqual([]);
    expect(reachableStates(machine)).toEqual(Object.keys(machine.States).sort());
  });

  it('invokes the handler it was given, and only that one', () => {
    const targets = new Set(
      Object.values(machine.States)
        .filter((state) => state.Type === 'Task')
        .map((state) => (state.Type === 'Task' ? state.Parameters['FunctionName'] : null)),
    );
    expect([...targets]).toEqual(['arn:aws:lambda:eu-west-1:1:function:stage']);
  });
});
