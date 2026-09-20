/**
 * Configuration is parsed once, at start-up, or the runtime is not built.
 *
 * The property under test is that a misconfigured deployment fails immediately
 * and says what is wrong, rather than failing later at the point of use with a
 * table name of `undefined`.
 */

import { describe, expect, it } from 'vitest';
import { CloudConfig, ConfigurationError, ENVIRONMENT_KEYS, loadConfig } from '../src/config.js';

const COMPLETE: Record<string, string> = {
  GENESIS_PROJECT_ID: 'prj-1',
  GENESIS_ENVIRONMENT: 'prod',
  AWS_REGION: 'eu-west-1',
  GENESIS_TABLE: 'genesis-state',
  GENESIS_EVIDENCE_BUCKET: 'evidence',
  GENESIS_ARTIFACT_BUCKET: 'artifacts',
  GENESIS_EVENT_BUS: 'genesis-ledger',
  GENESIS_EVENT_BUS_ARN: 'arn:aws:events:eu-west-1:1:event-bus/genesis-ledger',
  GENESIS_MODEL_IDS: 'anthropic.claude-sonnet-4-5-v1:0',
  GENESIS_IDENTITY_ISSUER: 'https://cognito-idp.eu-west-1.amazonaws.com/pool',
  GENESIS_IDENTITY_AUDIENCE: 'genesis-console',
  GENESIS_SECRET_PREFIX: 'genesis/prj-1/',
};

describe('reading a complete environment', () => {
  it('parses every field', () => {
    const config = loadConfig(COMPLETE);
    expect(config.projectId).toBe('prj-1');
    expect(config.environment).toBe('prod');
    expect(config.table).toBe('genesis-state');
    expect(config.modelIds).toEqual(['anthropic.claude-sonnet-4-5-v1:0']);
  });

  it('reads several models from one comma-separated variable', () => {
    const config = loadConfig({ ...COMPLETE, GENESIS_MODEL_IDS: 'model.a , model.b,model.c' });
    expect(config.modelIds).toEqual(['model.a', 'model.b', 'model.c']);
  });

  it('ignores anything else in the environment', () => {
    const config = loadConfig({ ...COMPLETE, AWS_SECRET_ACCESS_KEY: 'not-read', HOME: '/root' });
    expect(Object.keys(config).sort()).toEqual(Object.keys(ENVIRONMENT_KEYS).sort());
  });

  it('holds no secret, because a resolved secret would end up in a log', () => {
    expect(JSON.stringify(loadConfig(COMPLETE))).not.toContain('not-read');
    expect(Object.keys(CloudConfig.shape)).not.toContain('secret');
  });
});

describe('refusing an incomplete one', () => {
  const missing = (env: Record<string, string | undefined>): readonly string[] => {
    try {
      loadConfig(env);
    } catch (error) {
      if (error instanceof ConfigurationError) return error.missing;
      throw error;
    }
    throw new Error('expected a refusal');
  };

  it('names the one variable that is absent', () => {
    const { GENESIS_TABLE: _omitted, ...rest } = COMPLETE;
    expect(missing(rest)).toEqual(['GENESIS_TABLE']);
  });

  it('names every absent variable at once, not the first', () => {
    // A deployment fixed one variable per redeploy is how five minutes of work
    // becomes an afternoon.
    expect(missing({ GENESIS_PROJECT_ID: 'prj-1' }).length).toBe(Object.keys(ENVIRONMENT_KEYS).length - 1);
  });

  it('treats an empty or blank value as absent', () => {
    expect(missing({ ...COMPLETE, GENESIS_TABLE: '' })).toEqual(['GENESIS_TABLE']);
    expect(missing({ ...COMPLETE, GENESIS_TABLE: '   ' })).toEqual(['GENESIS_TABLE']);
  });

  it('refuses an environment name it does not recognise', () => {
    expect(missing({ ...COMPLETE, GENESIS_ENVIRONMENT: 'production' })).toEqual(['GENESIS_ENVIRONMENT']);
  });

  it('refuses a model list that is only separators', () => {
    expect(() => loadConfig({ ...COMPLETE, GENESIS_MODEL_IDS: ' , , ' })).toThrow();
  });

  it('says so in a message a person can act on', () => {
    const { GENESIS_EVENT_BUS: _a, GENESIS_TABLE: _b, ...rest } = COMPLETE;
    expect(() => loadConfig(rest)).toThrow(/GENESIS_EVENT_BUS, GENESIS_TABLE/);
  });

  it('refuses an empty environment rather than defaulting to anything', () => {
    expect(() => loadConfig({})).toThrow(ConfigurationError);
  });
});

describe('the variable names', () => {
  it('covers every field of the configuration, so nothing is unsettable', () => {
    expect(Object.keys(ENVIRONMENT_KEYS).sort()).toEqual(Object.keys(CloudConfig.shape).sort());
  });

  it('uses the names the stack sets', () => {
    expect(ENVIRONMENT_KEYS.table).toBe('GENESIS_TABLE');
    expect(ENVIRONMENT_KEYS.region).toBe('AWS_REGION');
  });
});
