/**
 * Where the deployment and the runtime are checked against each other
 * (ADR-0026 §2).
 *
 * `@genesis/infrastructure` may not import an adapter, and `@genesis/factory`
 * owns its own pipeline table. Both of those are the right boundaries, and both
 * mean the deployment restates something the runtime also states. This package
 * is the one permitted to name both, so this is where the restatements are
 * compared.
 *
 * Every mismatch here is a deployment that would fail at run time in a way that
 * is hard to read: a table whose attribute the adapter never writes, or a state
 * machine that sends a repaired change straight to verification. Caught here,
 * it is a failing test with a sentence explaining it.
 */

import { GENESIS_TABLE_SCHEMA, TABLE_KEYS as ADAPTER_KEYS } from '@genesis/adapters-aws';
import { FIRST_STAGE, ON_FAILURE, ON_SUCCESS } from '@genesis/factory';
import {
  factoryStateMachine,
  GSI1,
  GSI2,
  type StateMachineDefinition,
  TABLE_KEYS,
} from '@genesis/infrastructure';

export interface BindingMismatch {
  readonly what: string;
  readonly deployment: string;
  readonly runtime: string;
}

/** What the stack declares. Defaulted, and injectable so the check can be shown to fail. */
export interface DeploymentNames {
  readonly partition: string;
  readonly sort: string;
  readonly indexes: readonly string[];
}

/** What the adapters use. */
export interface RuntimeNames {
  readonly partition: string;
  readonly sort: string;
  readonly indexes: Readonly<Record<string, { readonly partition: string; readonly sort: string }>>;
}

export const DEPLOYMENT_NAMES: DeploymentNames = {
  partition: TABLE_KEYS.partition,
  sort: TABLE_KEYS.sort,
  indexes: [GSI1, GSI2],
};

export const RUNTIME_NAMES: RuntimeNames = {
  partition: ADAPTER_KEYS.partition,
  sort: ADAPTER_KEYS.sort,
  indexes: GENESIS_TABLE_SCHEMA.indexes,
};

/**
 * Compares what the stack declares with what the adapters use.
 *
 * Both sides default to the real ones, and both are parameters so a test can
 * hand it a deliberately wrong pair — a checker that has only ever seen
 * matching inputs is not evidence that it compares anything.
 *
 * Returns every mismatch rather than the first, so one run says everything that
 * needs renaming.
 */
export function checkDeploymentBindings(
  deployment: DeploymentNames = DEPLOYMENT_NAMES,
  runtime: RuntimeNames = RUNTIME_NAMES,
): readonly BindingMismatch[] {
  const mismatches: BindingMismatch[] = [];
  const compare = (what: string, declared: string, used: string): void => {
    if (declared !== used) mismatches.push({ what, deployment: declared, runtime: used });
  };

  compare('table partition key', deployment.partition, runtime.partition);
  compare('table sort key', deployment.sort, runtime.sort);

  const used = Object.keys(runtime.indexes).sort();
  compare('index names', [...deployment.indexes].sort().join(','), used.join(','));

  // The stack declares the index key attributes by convention (`gsi1pk`); the
  // adapter's schema says what it actually writes them as. A mismatch produces
  // queries against an index that is always empty, which reads as "the data is
  // missing" rather than as a naming error.
  for (const index of deployment.indexes) {
    const keys = runtime.indexes[index];
    if (keys === undefined) continue;
    compare(`${index} partition attribute`, `${index}pk`, keys.partition);
    compare(`${index} sort attribute`, `${index}sk`, keys.sort);
  }

  return mismatches;
}

/**
 * The change-lifecycle state machine, built from the factory's own table.
 *
 * This is the binding, not a copy of it: the transitions come from
 * `@genesis/factory`, so the deployed machine cannot disagree with the factory
 * about what follows a repair.
 */
export const deployedFactoryMachine = (stageHandlerArn: string): StateMachineDefinition =>
  factoryStateMachine({ stageHandlerArn, onSuccess: ON_SUCCESS, onFailure: ON_FAILURE, firstStage: FIRST_STAGE });
