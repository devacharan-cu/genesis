/**
 * The console view: a pure, replayable derivation of what a person sees from
 * the ledger alone.
 *
 * It holds no state, calls nothing and writes nothing. Everything it shows is
 * something the ledger says, and anything it cannot read is reported as an
 * anomaly rather than hidden.
 */

export * from './lanes.js';
export * from './view.js';
