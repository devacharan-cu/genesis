import type { VerificationState } from '@genesis/core-types';
import type { EvidenceRecord } from './evidence.js';

/**
 * The deterministic engine that decides if an artifact's VerificationState can advance
 * based purely on evidence. It implements SPEC-05 section 2.
 */
export class VerificationEngine {
  /**
   * Evaluates a set of evidence against an artifact to determine its highest justified state.
   */
  evaluate(artifactId: string, evidence: EvidenceRecord[]): VerificationState {
    let hasStatic = false;
    let hasUnit = false;
    let hasIntegration = false;
    let hasE2E = false;
    let hasDeploy = false;
    let hasProd = false;

    // Filter evidence down to what actually covers this artifact and succeeded
    const relevant = evidence.filter(e => e.claimedArtifacts.includes(artifactId));
    const successful = relevant.filter(e => e.exitCode === 0);

    for (const ev of successful) {
      // Evidence with no test kind is a static check: a compile, a lint, a
      // type pass. It says the artifact holds together, and nothing more.
      if (!ev.testKind) {
        hasStatic = true;
      }
      
      if (ev.testKind === 'UNIT' || ev.testKind === 'PROPERTY' || ev.testKind === 'CONFORMANCE') {
        // UNIT_TESTED anti-gaming: check for coverage attribution in `raw`.
        // A real implementation would parse the coverage report. Here we check a simple heuristic:
        // the raw output must contain the artifactId as a covered file.
        if (ev.raw.includes(artifactId)) {
          hasUnit = true;
        }
      }

      if (ev.testKind === 'INTEGRATION' || ev.testKind === 'CONFORMANCE') {
        if (ev.raw.includes(artifactId)) {
          hasIntegration = true;
        }
      }

      if (ev.testKind === 'E2E' && (ev.environment === 'STAGING' || ev.environment === 'SANDBOX')) {
        hasE2E = true;
      }

      if (ev.environment === 'PRODUCTION') {
        hasDeploy = true;
        // In a full implementation, PRODUCTION_VERIFIED requires synthetic checks or traffic data.
        if (ev.raw.includes('PRODUCTION_VERIFIED')) {
          hasProd = true;
        }
      }
    }

    // States are monotonic in absence of contradictions.
    // If there is ANY failing evidence for this artifact, it downgrades! (Regression - SPEC-05 2.2)
    const failing = relevant.filter(e => e.exitCode !== 0);
    for (const fail of failing) {
      if (fail.testKind === 'UNIT' || fail.testKind === 'PROPERTY') hasUnit = false;
      if (fail.testKind === 'INTEGRATION') hasIntegration = false;
      if (fail.testKind === 'E2E') hasE2E = false;
      if (fail.environment === 'PRODUCTION') {
        hasProd = false;
        hasDeploy = false;
      }
      if (!fail.testKind) hasStatic = false;
    }

    // SPEC-05 §2: the highest state still supported by non-contradicted
    // evidence. Absence of evidence is not evidence, so the ladder bottoms out
    // at GENERATED rather than at anything that sounds checked.
    if (hasProd) return 'PRODUCTION_VERIFIED';
    if (hasDeploy) return 'DEPLOYED';
    if (hasE2E) return 'E2E_TESTED';
    if (hasIntegration) return 'INTEGRATION_TESTED';
    if (hasUnit) return 'UNIT_TESTED';
    if (hasStatic) return 'STATIC_CHECKED';
    
    return 'GENERATED';
  }
}
