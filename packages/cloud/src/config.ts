/**
 * The deployment's configuration, as a parsed value (ADR-0026 §4).
 *
 * A handler that reads `process.env.GENESIS_TABLE` at the point of use fails at
 * the point of use, halfway through a request, with a name that is `undefined`.
 * This parses everything once, at start-up, and refuses to build a runtime at
 * all when something is missing — so a misconfigured deployment fails on its
 * first invocation with a message naming what is absent, rather than writing to
 * a table called "undefined".
 *
 * Nothing here holds a secret. Secrets are resolved at the moment of use
 * through the `SecretResolver` port (SPEC-06 §5), and a configuration object
 * that carried one would end up in a log the first time somebody debugged a
 * start-up problem.
 */

import { z } from 'zod';

const name = z.string().trim().min(1);

/** Comma-separated in the environment, a list here. Empty entries are dropped. */
const list = z
  .string()
  .trim()
  .min(1)
  .transform((raw) => raw.split(',').map((part) => part.trim()).filter((part) => part.length > 0))
  .pipe(z.array(name).min(1));

export const CloudConfig = z
  .object({
    /** The project this deployment serves. One stack, one project (SPEC-07 §7). */
    projectId: name,
    environment: z.enum(['dev', 'staging', 'prod']),
    region: name,
    table: name,
    evidenceBucket: name,
    artifactBucket: name,
    eventBusName: name,
    eventBusArn: name,
    /** Which models this deployment may ask for. IAM permits the same list. */
    modelIds: z.array(name).min(1),
    /** `https://cognito-idp.<region>.amazonaws.com/<userPoolId>`. */
    identityIssuer: name,
    identityAudience: name,
    /** The prefix every secret this deployment may resolve lives under. */
    secretPrefix: name,
  })
  .strict();
export type CloudConfig = z.infer<typeof CloudConfig>;

export class ConfigurationError extends Error {
  constructor(
    message: string,
    readonly missing: readonly string[],
  ) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/** Environment variable names, matching what the stack sets (ADR-0026 §2). */
export const ENVIRONMENT_KEYS = {
  projectId: 'GENESIS_PROJECT_ID',
  environment: 'GENESIS_ENVIRONMENT',
  region: 'AWS_REGION',
  table: 'GENESIS_TABLE',
  evidenceBucket: 'GENESIS_EVIDENCE_BUCKET',
  artifactBucket: 'GENESIS_ARTIFACT_BUCKET',
  eventBusName: 'GENESIS_EVENT_BUS',
  eventBusArn: 'GENESIS_EVENT_BUS_ARN',
  modelIds: 'GENESIS_MODEL_IDS',
  identityIssuer: 'GENESIS_IDENTITY_ISSUER',
  identityAudience: 'GENESIS_IDENTITY_AUDIENCE',
  secretPrefix: 'GENESIS_SECRET_PREFIX',
} as const satisfies Record<keyof CloudConfig, string>;

/**
 * Reads the configuration from an environment, or says what is missing.
 *
 * Reports *every* absent variable rather than the first: a deployment being
 * fixed one variable per redeploy is how a five-minute problem becomes an
 * afternoon.
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): CloudConfig {
  const raw: Record<string, unknown> = {};
  for (const [field, key] of Object.entries(ENVIRONMENT_KEYS)) {
    const value = env[key];
    if (value === undefined || value.trim().length === 0) continue;
    raw[field] = field === 'modelIds' ? list.parse(value) : value;
  }

  const parsed = CloudConfig.safeParse(raw);
  if (parsed.success) return parsed.data;

  // Every issue path is a field of `raw`, and `raw` is built only from the
  // table above, so the lookup is total.
  const missing = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))]
    .map((field) => ENVIRONMENT_KEYS[field as keyof CloudConfig])
    .sort();
  throw new ConfigurationError(`the deployment is missing or misconfigured: ${missing.join(', ')}`, missing);
}
