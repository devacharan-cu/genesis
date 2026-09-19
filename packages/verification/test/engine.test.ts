import { describe, expect, test } from 'vitest';
import { VerificationEngine } from '../src/engine.js';
import { EvidenceRecord } from '../src/evidence.js';

describe('VerificationEngine', () => {
  const engine = new VerificationEngine();
  const artifactId = 'node_01';

  test('no evidence -> GENERATED', () => {
    expect(engine.evaluate(artifactId, [])).toBe('GENERATED');
  });

  test('static check passing -> STATIC_CHECKED', () => {
    const evidence: EvidenceRecord[] = [
      { observationId: 'obs_1', raw: 'success', hash: 'h', environment: 'LOCAL', exitCode: 0, claimedArtifacts: [artifactId] }
    ];
    expect(engine.evaluate(artifactId, evidence)).toBe('STATIC_CHECKED');
  });

  test('unit test passing with coverage -> UNIT_TESTED', () => {
    const evidence: EvidenceRecord[] = [
      { observationId: 'obs_1', raw: `coverage for ${artifactId}`, hash: 'h', environment: 'LOCAL', exitCode: 0, testKind: 'UNIT', claimedArtifacts: [artifactId] }
    ];
    expect(engine.evaluate(artifactId, evidence)).toBe('UNIT_TESTED');
  });

  test('unit test passing WITHOUT coverage -> GENERATED (anti-gaming)', () => {
    const evidence: EvidenceRecord[] = [
      { observationId: 'obs_1', raw: `coverage for other stuff`, hash: 'h', environment: 'LOCAL', exitCode: 0, testKind: 'UNIT', claimedArtifacts: [artifactId] }
    ];
    // No static checks either, so it stays GENERATED
    expect(engine.evaluate(artifactId, evidence)).toBe('GENERATED');
  });

  test('failing unit test downgrades previously verified artifact', () => {
    const evidence: EvidenceRecord[] = [
      { observationId: 'obs_0', raw: `static pass`, hash: 'h', environment: 'LOCAL', exitCode: 0, claimedArtifacts: [artifactId] },
      { observationId: 'obs_1', raw: `coverage for ${artifactId}`, hash: 'h', environment: 'LOCAL', exitCode: 0, testKind: 'UNIT', claimedArtifacts: [artifactId] },
      { observationId: 'obs_2', raw: `coverage for ${artifactId}`, hash: 'h', environment: 'LOCAL', exitCode: 1, testKind: 'UNIT', claimedArtifacts: [artifactId] } // Failing regression test!
    ];
    expect(engine.evaluate(artifactId, evidence)).toBe('STATIC_CHECKED'); // Falls back to static checked because unit tests are failing
  });
  
  test('e2e test passing -> E2E_TESTED', () => {
    const evidence: EvidenceRecord[] = [
      { observationId: 'obs_1', raw: `coverage for ${artifactId}`, hash: 'h', environment: 'STAGING', exitCode: 0, testKind: 'E2E', claimedArtifacts: [artifactId] }
    ];
    expect(engine.evaluate(artifactId, evidence)).toBe('E2E_TESTED');
  });
});
