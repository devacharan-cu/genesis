export type SandboxErrorKind =
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'SETUP_FAILED'
  | 'TEARDOWN_FAILED'
  | 'UNKNOWN';

export class SandboxError extends Error {
  constructor(
    public readonly kind: SandboxErrorKind,
    message: string,
    public readonly originalError?: Error
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}
