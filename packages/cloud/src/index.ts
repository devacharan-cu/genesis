/**
 * The composition root and the cloud handlers (ADR-0026 section 4).
 *
 * The only package permitted to name both a port and its cloud adapter, and
 * therefore the only place where the deployment's declarations are checked
 * against the runtime's.
 */

export * from './config.js';
export * from './runtime.js';
export * from './stream.js';
export * from './handlers.js';
export * from './api.js';
export * from './bindings.js';
