/**
 * The deployment, as typed code (ADR-0026 §2).
 *
 * Nothing in this package has been deployed. It emits a CloudFormation template
 * and two Step Functions definitions from the same constants the runtime uses,
 * and the tests prove the result is well formed, deterministic and
 * least-privilege. Proving it works in an account needs an account, which
 * ADR-0026 §5 records as outstanding.
 */

export * from './template.js';
export * from './policy.js';
export * from './table.js';
export * from './state-machines.js';
export * from './stack.js';
export * from './posture.js';
