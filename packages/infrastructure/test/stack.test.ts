/**
 * The emitted stack.
 *
 * The central assertion is that `checkPosture` finds nothing. Everything else
 * here pins a specific boundary that the posture rules state generally: which
 * handler may append to the ledger, what the agent worker may not do, and what
 * the sandbox can reach.
 */

import { describe, expect, it } from 'vitest';
import { checkPosture, LEDGER_WRITERS, statementsOf, TABLE_WRITERS } from '../src/posture.js';
import { emitTemplate, resourcesOfType } from '../src/template.js';
import { genesisStack, HANDLER_NAMES, type StackConfig } from '../src/stack.js';
import { KEY_ATTRIBUTES, GSI1, GSI2, TABLE_KEYS } from '../src/table.js';

const CONFIG: StackConfig = {
  projectId: 'prj-test',
  environment: 'dev',
  deploymentBucket: 'genesis-deploy',
  deploymentKey: 'builds/abc123.zip',
  modelIds: ['anthropic.claude-sonnet-4-5-v1:0'],
};

const stack = genesisStack(CONFIG);

const roleFor = (handler: string) => stack.Resources[`${handler}Role`];
const actionsFor = (handler: string, effect: 'Allow' | 'Deny' = 'Allow'): readonly string[] => {
  const role = roleFor(handler);
  if (role === undefined) throw new Error(`no role for ${handler}`);
  return statementsOf(role)
    .filter(([, statement]) => statement.Effect === effect)
    .flatMap(([, statement]) => (Array.isArray(statement.Action) ? statement.Action : []))
    .filter((a): a is string => typeof a === 'string');
};

describe('the stack as a whole', () => {
  it('satisfies every posture rule', () => {
    expect(checkPosture(stack)).toEqual([]);
  });

  it('is deterministic: the same config emits the same bytes', () => {
    expect(emitTemplate(genesisStack(CONFIG))).toBe(emitTemplate(stack));
  });

  it('names the project it belongs to, because one stack serves one project', () => {
    expect(stack.Description).toContain('prj-test');
    const table = stack.Resources['GenesisTable'];
    expect(table?.Properties['Tags']).toEqual([{ Key: 'genesis:project', Value: 'prj-test' }]);
  });

  it('refuses to emit a stack that may call any model', () => {
    expect(() => genesisStack({ ...CONFIG, modelIds: [] })).toThrow(/name the models/);
  });

  it('exposes what a deployment needs to wire the runtime', () => {
    expect(Object.keys(stack.Outputs).sort()).toEqual([
      'ApiEndpoint',
      'ArtifactBucketName',
      'EventBusName',
      'EvidenceBucketName',
      'TableName',
      'UserPoolId',
    ]);
  });
});

describe('the single table', () => {
  const table = stack.Resources['GenesisTable'];

  it('declares exactly the key attributes the adapter uses', () => {
    const declared = (table?.Properties['AttributeDefinitions'] as { AttributeName: string }[]).map((a) => a.AttributeName);
    expect(declared.sort()).toEqual([...KEY_ATTRIBUTES].sort());
  });

  it('keys on the partition and sort attributes the schema builds', () => {
    expect(table?.Properties['KeySchema']).toEqual([
      { AttributeName: TABLE_KEYS.partition, KeyType: 'HASH' },
      { AttributeName: TABLE_KEYS.sort, KeyType: 'RANGE' },
    ]);
  });

  it('creates both indexes the access patterns need, and no more', () => {
    const indexes = (table?.Properties['GlobalSecondaryIndexes'] as { IndexName: string }[]).map((i) => i.IndexName);
    expect(indexes).toEqual([GSI1, GSI2]);
  });

  it('bills per request, because a cognitive cycle is bursty', () => {
    expect(table?.Properties['BillingMode']).toBe('PAY_PER_REQUEST');
  });

  it('survives the stack, because the ledger cannot be rebuilt', () => {
    expect(table?.DeletionPolicy).toBe('Retain');
    expect(table?.UpdateReplacePolicy).toBe('Retain');
  });
});

describe('who may write history', () => {
  it('gives exactly the named writers an append', () => {
    for (const handler of HANDLER_NAMES) {
      const appends = actionsFor(handler).includes('dynamodb:TransactWriteItems');
      expect(appends, handler).toBe(LEDGER_WRITERS.includes(handler));
    }
  });

  it('lets only the named writers touch the table at all', () => {
    for (const handler of HANDLER_NAMES) {
      const writes = actionsFor(handler).some((a) => /^dynamodb:(Put|Update|Delete|BatchWrite|TransactWrite)/.test(a));
      expect(writes, handler).toBe(TABLE_WRITERS.includes(handler));
    }
  });

  it('gives no writer the ability to change what it wrote', () => {
    for (const handler of LEDGER_WRITERS) {
      expect(actionsFor(handler), handler).not.toContain('dynamodb:UpdateItem');
      expect(actionsFor(handler), handler).not.toContain('dynamodb:DeleteItem');
    }
  });

  it('carries an explicit deny on rewriting history, not merely an omission', () => {
    for (const handler of LEDGER_WRITERS) {
      expect(actionsFor(handler, 'Deny'), handler).toContain('dynamodb:UpdateItem');
    }
  });

  it('lets the projection updater write derived state and not history', () => {
    expect(actionsFor('ProjectionUpdater')).toContain('dynamodb:UpdateItem');
    expect(actionsFor('ProjectionUpdater')).not.toContain('dynamodb:TransactWriteItems');
    // It holds PutItem for its own derived items, and is denied it on the
    // ledger's own keys. Omission would not have been enough.
    expect(actionsFor('ProjectionUpdater')).toContain('dynamodb:PutItem');
    expect(actionsFor('ProjectionUpdater', 'Deny')).toContain('dynamodb:PutItem');
    expect(actionsFor('ProjectionUpdater', 'Deny')).toContain('dynamodb:DeleteItem');
  });

  it('gives nobody a Scan, because every access pattern is a scoped Query', () => {
    for (const handler of HANDLER_NAMES) {
      expect(actionsFor(handler), handler).not.toContain('dynamodb:Scan');
    }
  });
});

describe('what an agent may do', () => {
  it('may read canonical state', () => {
    expect(actionsFor('AgentWorker')).toContain('dynamodb:Query');
    expect(actionsFor('AgentWorker')).toContain('dynamodb:GetItem');
  });

  it('may not write any of it, whatever the agent runtime believes', () => {
    const writes = actionsFor('AgentWorker').filter((a) => /^dynamodb:(Put|Update|Delete|BatchWrite|TransactWrite)/.test(a));
    expect(writes).toEqual([]);
  });

  it('may call only the models the deployment named', () => {
    const role = roleFor('AgentWorker');
    const invoke = statementsOf(role!).find(([, s]) => s.Sid === 'InvokeNamedModelsOnly');
    expect(JSON.stringify(invoke?.[1].Resource)).toContain('anthropic.claude-sonnet-4-5-v1:0');
    expect(JSON.stringify(invoke?.[1].Resource)).not.toContain('foundation-model/*');
  });

  it('may write artifacts and only read evidence', () => {
    const role = roleFor('AgentWorker');
    const evidence = statementsOf(role!).find(([, s]) => s.Sid === 'ReadEvidence');
    expect(evidence?.[1].Action).toEqual(['s3:GetObject']);
  });

  it('may not publish to the bus, which is the ledger’s fan-out and not an agent’s', () => {
    expect(actionsFor('AgentWorker')).not.toContain('events:PutEvents');
  });
});

describe('the sandbox tier', () => {
  const role = stack.Resources['SandboxTaskRole'];

  it('cannot reach the table at all', () => {
    const actions = statementsOf(role!).flatMap(([, s]) => (Array.isArray(s.Action) ? s.Action : []));
    expect(actions.filter((a) => typeof a === 'string' && a.startsWith('dynamodb:'))).toEqual([]);
  });

  it('is confined to one prefix of one bucket', () => {
    const resources = JSON.stringify(statementsOf(role!).map(([, s]) => s.Resource));
    expect(resources).toContain('prj-test/sandbox/*');
    expect(resources).not.toContain('ArtifactBucket.Arn}/*');
  });

  it('runs unprivileged, as a non-root user, on a read-only root', () => {
    const container = (stack.Resources['SandboxTaskDefinition']?.Properties['ContainerDefinitions'] as Record<string, unknown>[])[0];
    expect(container?.['Privileged']).toBe(false);
    expect(container?.['ReadonlyRootFilesystem']).toBe(true);
    expect(container?.['User']).toBe('10001:10001');
  });

  it('is Fargate, as ADR-0025 §1 decided', () => {
    expect(stack.Resources['SandboxTaskDefinition']?.Properties['RequiresCompatibilities']).toEqual(['FARGATE']);
  });
});

describe('the human surface', () => {
  it('lets nobody sign themselves up into the top of the authority hierarchy', () => {
    const pool = stack.Resources['UserPool'];
    expect(pool?.Properties['AdminCreateUserConfig']).toEqual({ AllowAdminCreateUserOnly: true });
    expect(pool?.Properties['MfaConfiguration']).toBe('ON');
  });

  it('authorizes every route, leaving no anonymous surface', () => {
    for (const [, route] of resourcesOfType(stack, 'AWS::ApiGatewayV2::Route')) {
      expect(route.Properties['AuthorizationType']).toBe('JWT');
      expect(route.Properties['AuthorizerId']).toBeDefined();
    }
  });

  it('accepts tokens only from this deployment’s pool and app', () => {
    const jwt = stack.Resources['ApiAuthorizer']?.Properties['JwtConfiguration'] as Record<string, unknown>;
    expect(jwt['Audience']).toEqual([{ Ref: 'UserPoolClient' }]);
    expect(JSON.stringify(jwt['Issuer'])).toContain('${UserPool}');
  });

  it('issues a public client with no secret it would have to ship', () => {
    expect(stack.Resources['UserPoolClient']?.Properties['GenerateSecret']).toBe(false);
  });
});

describe('stream consumers', () => {
  it('feeds projections and the fan-out from the one stream', () => {
    const mappings = resourcesOfType(stack, 'AWS::Lambda::EventSourceMapping');
    expect(mappings.map(([id]) => id)).toEqual(['FanOutStreamMapping', 'ProjectionStreamMapping']);
    for (const [, mapping] of mappings) {
      expect(mapping.Properties['EventSourceArn']).toEqual({ 'Fn::GetAtt': ['GenesisTable', 'StreamArn'] });
    }
  });

  it('reads the stream in order, one batch at a time', () => {
    for (const [, mapping] of resourcesOfType(stack, 'AWS::Lambda::EventSourceMapping')) {
      expect(mapping.Properties['ParallelizationFactor']).toBe(1);
      expect(mapping.Properties['StartingPosition']).toBe('TRIM_HORIZON');
      expect(mapping.Properties['FunctionResponseTypes']).toEqual(['ReportBatchItemFailures']);
    }
  });

  it('gives the fan-out no way to write anything', () => {
    const writes = actionsFor('LedgerFanOut').filter((a) => /Put(Item)?$|Delete|Update/.test(a) && !a.startsWith('events:'));
    expect(writes.filter((a) => !a.startsWith('logs:'))).toEqual([]);
  });
});

describe('what is deliberately not here', () => {
  it('has no Neptune cluster: the graph is a rebuildable projection (ADR-0025 §3)', () => {
    expect(resourcesOfType(stack, 'AWS::Neptune::DBCluster')).toEqual([]);
    expect(emitTemplate(stack)).not.toContain('Neptune');
  });

  it('has no second event store', () => {
    expect(resourcesOfType(stack, 'AWS::SQS::Queue')).toEqual([]);
    expect(resourcesOfType(stack, 'AWS::Kinesis::Stream')).toEqual([]);
    expect(resourcesOfType(stack, 'AWS::DynamoDB::Table')).toHaveLength(1);
  });

  it('has no inline handler code, because the code is built and uploaded', () => {
    for (const [, fn] of resourcesOfType(stack, 'AWS::Lambda::Function')) {
      expect((fn.Properties['Code'] as Record<string, unknown>)['ZipFile']).toBeUndefined();
      expect((fn.Properties['Code'] as Record<string, unknown>)['S3Key']).toBe('builds/abc123.zip');
    }
  });
});
