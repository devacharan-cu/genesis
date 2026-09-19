export type TestKind = 'PROPERTY' | 'UNIT' | 'CONFORMANCE' | 'INTEGRATION' | 'E2E' | 'REGRESSION';

export interface EvidenceRecord {
  /** The observation ID this evidence is tied to */
  observationId: string;
  
  /** The raw output from the execution */
  raw: string;
  
  /** Hash of the raw output to guarantee immutability */
  hash: string;
  
  /** Environment the execution took place in */
  environment: 'SANDBOX' | 'STAGING' | 'PRODUCTION' | 'LOCAL';
  
  /** The exit code of the execution. 0 is success. */
  exitCode: number;
  
  /** The test kind if this was a test execution */
  testKind?: TestKind;
  
  /** 
   * A list of artifact IDs that this evidence claims to cover. 
   * For UNIT tests, these artifacts MUST be in the coverage report (parsed from `raw`). 
   */
  claimedArtifacts: string[];
}

