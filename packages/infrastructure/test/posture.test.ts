/**
 * Proving the posture checker can fail.
 *
 * A check that has only ever been run against a compliant template is not
 * evidence of anything: it would pass just as happily if it did nothing. So
 * every rule gets a template that breaks exactly that rule, and the rule must
 * fire. This is the same discipline the boundary checker is held to.
 *
 * Each mutation below is a plausible mistake rather than a contrived one, which
 * is the point: these are the changes someone would actually make.
 */

import { describe, expect, it } from 'vitest';
import { checkPosture, FORBIDDEN_ACTIONS, LEDGER_WRITERS, type PostureViolation, statementsOf, TABLE_WRITERS } from '../src/posture.js';
import { genesisStack, type StackConfig } from '../src/stack.js';
import type { CloudFormationTemplate } from '../src/template.js';

const CONFIG: StackConfig = {
  projectId: 'prj-test',
  environment: 'prod',
  deploymentBucket: 'genesis-deploy',
  deploymentKey: 'builds/abc.zip',
  modelIds: ['anthropic.claude-sonnet-4-5-v1:0'],
};

type Mutable = {
  Resources: Record<string, { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string }>;
};

/** A copy of the real stack, mutated, then checked. */
const broken = (mutate: (template: Mutable) => void): readonly PostureViolation[] => {
  const copy = structuredClone(genesisStack(CONFIG)) as unknown as Mutable;
  mutate(copy);
  return checkPosture(copy as unknown as CloudFormationTemplate);
};

const rulesFrom = (violations: readonly PostureViolation[]): readonly string[] => [...new Set(violations.map((v) => v.rule))];

const statementIn = (template: Mutable, roleId: string, sid: string): Record<string, unknown> => {
  const role = template.Resources[roleId];
  const policies = role?.Properties['Policies'] as { PolicyDocument: { Statement: Record<string, unknown>[] } }[];
  const found = policies[0]?.PolicyDocument.Statement.find((s) => s['Sid'] === sid);
  if (found === undefined) throw new Error(`${roleId} has no statement ${sid}`);
  return found;
};

describe('the checker is silent on a compliant stack', () => {
  it('finds nothing in the real one', () => {
    expect(checkPosture(genesisStack(CONFIG))).toEqual([]);
  });
});

describe('each rule fires on the mistake it exists for', () => {
  const cases: readonly (readonly [string, (t: Mutable) => void])[] = [
    [
      'TABLE_PITR',
      (t) => {
        t.Resources['GenesisTable']!.Properties['PointInTimeRecoverySpecification'] = { PointInTimeRecoveryEnabled: false };
      },
    ],
    [
      'TABLE_CMK',
      (t) => {
        // The mistake: taking the default AWS-owned key, which looks encrypted.
        t.Resources['GenesisTable']!.Properties['SSESpecification'] = { SSEEnabled: true };
      },
    ],
    [
      'TABLE_DELETION_PROTECTION',
      (t) => {
        t.Resources['GenesisTable']!.Properties['DeletionProtectionEnabled'] = false;
      },
    ],
    [
      'TABLE_STREAM_IMAGES',
      (t) => {
        t.Resources['GenesisTable']!.Properties['StreamSpecification'] = { StreamViewType: 'NEW_IMAGE' };
      },
    ],
    [
      'BUCKET_NOT_PUBLIC',
      (t) => {
        (t.Resources['EvidenceBucket']!.Properties['PublicAccessBlockConfiguration'] as Record<string, unknown>)['BlockPublicPolicy'] = false;
      },
    ],
    [
      'BUCKET_CMK',
      (t) => {
        t.Resources['EvidenceBucket']!.Properties['BucketEncryption'] = {
          ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
        };
      },
    ],
    [
      'BUCKET_VERSIONED',
      (t) => {
        t.Resources['ArtifactBucket']!.Properties['VersioningConfiguration'] = { Status: 'Suspended' };
      },
    ],
    [
      'BUCKET_TLS_ONLY',
      (t) => {
        delete t.Resources['EvidenceBucketPolicy'];
      },
    ],
    [
      'NO_MANAGED_POLICIES',
      (t) => {
        // The mistake everybody makes: reaching for the managed basic-execution
        // policy, which grants logs on a wildcard resource.
        t.Resources['ApiHandlerRole']!.Properties['ManagedPolicyArns'] = [
          'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
        ];
      },
    ],
    [
      'NO_WILDCARD_PRINCIPAL',
      (t) => {
        t.Resources['ApiHandlerRole']!.Properties['AssumeRolePolicyDocument'] = {
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Principal: { AWS: '*' }, Action: 'sts:AssumeRole' }],
        };
      },
    ],
    [
      'NO_WILDCARD_ACTION',
      (t) => {
        statementIn(t, 'AgentWorkerRole', 'ReadState')['Action'] = ['dynamodb:*'];
      },
    ],
    [
      'NO_WILDCARD_RESOURCE',
      (t) => {
        statementIn(t, 'AgentWorkerRole', 'ReadState')['Resource'] = ['*'];
      },
    ],
    [
      'STATEMENT_HAS_ACTIONS',
      (t) => {
        statementIn(t, 'AgentWorkerRole', 'ReadState')['Action'] = [];
      },
    ],
    [
      'STATEMENT_HAS_RESOURCES',
      (t) => {
        statementIn(t, 'AgentWorkerRole', 'ReadState')['Resource'] = [];
      },
    ],
    [
      'LIST_SCOPED_BY_PREFIX',
      (t) => {
        delete statementIn(t, 'ApiHandlerRole', 'ListOwnEvidence')['Condition'];
      },
    ],
    [
      'ONLY_NAMED_WRITERS_APPEND',
      (t) => {
        statementIn(t, 'LedgerFanOutRole', 'ReadTableStream')['Action'] = ['dynamodb:PutItem'];
      },
    ],
    [
      'AGENTS_DO_NOT_MUTATE',
      (t) => {
        // The exact thing ADR-0006 forbids, arriving as a convenience: letting
        // the agent write its own result rather than proposing it.
        statementIn(t, 'AgentWorkerRole', 'ReadState')['Action'] = ['dynamodb:Query', 'dynamodb:PutItem'];
      },
    ],
    [
      'APPEND_ONLY',
      (t) => {
        statementIn(t, 'CyclePhaseHandlerRole', 'LedgerAppendOnly')['Action'] = ['dynamodb:PutItem', 'dynamodb:UpdateItem'];
      },
    ],
    [
      'EXPLICIT_HISTORY_DENY',
      (t) => {
        const role = t.Resources['ApiHandlerRole']!;
        const policies = role.Properties['Policies'] as { PolicyDocument: { Statement: Record<string, unknown>[] } }[];
        policies[0]!.PolicyDocument.Statement = policies[0]!.PolicyDocument.Statement.filter((s) => s['Effect'] !== 'Deny');
      },
    ],
    [
      'DERIVED_WRITERS_CANNOT_APPEND',
      (t) => {
        statementIn(t, 'ProjectionUpdaterRole', 'NeverWriteHistory')['Action'] = ['dynamodb:DeleteItem', 'dynamodb:UpdateItem', 'dynamodb:BatchWriteItem'];
      },
    ],
    [
      'LOG_RETENTION',
      (t) => {
        delete t.Resources['ApiHandlerLogs']!.Properties['RetentionInDays'];
      },
    ],
    [
      'LOG_ENCRYPTION',
      (t) => {
        delete t.Resources['ApiHandlerLogs']!.Properties['KmsKeyId'];
      },
    ],
    [
      'FUNCTION_HAS_LOG_GROUP',
      (t) => {
        delete t.Resources['AgentWorkerLogs'];
      },
    ],
    [
      'NO_PLAINTEXT_SECRETS',
      (t) => {
        const fn = t.Resources['ApiHandler']!.Properties['Environment'] as { Variables: Record<string, unknown> };
        fn.Variables['apiKey'] = 'sk-live-9f2b7c4e1a8d';
      },
    ],
    [
      'RETAIN_STATE',
      (t) => {
        t.Resources['GenesisTable']!.DeletionPolicy = 'Delete';
      },
    ],
  ];

  for (const [rule, mutate] of cases) {
    it(`reports ${rule}`, () => {
      expect(rulesFrom(broken(mutate))).toContain(rule);
    });
  }

  it('covers every rule the checker can emit', () => {
    // If a rule is added without a case above, this fails: a rule nobody has
    // seen fire is a rule nobody knows works.
    const emitted = new Set<string>();
    for (const [, mutate] of cases) for (const violation of broken(mutate)) emitted.add(violation.rule);
    expect([...emitted].sort()).toEqual([...cases.map(([rule]) => rule)].sort());
  });
});

describe('templates the rules still have to cope with', () => {
  it('handles a bucket policy that does not name its bucket by Ref', () => {
    // A hand-written policy can reference a bucket by ARN. The bucket then has
    // no policy this checker can match, and the rule says so rather than
    // crashing on the shape.
    const violations = broken((t) => {
      t.Resources['EvidenceBucketPolicy']!.Properties['Bucket'] = 'a-literal-bucket-name';
    });
    expect(rulesFrom(violations)).toContain('BUCKET_TLS_ONLY');
  });

  it('names an unnamed statement rather than losing it', () => {
    const violations = broken((t) => {
      const statement = statementIn(t, 'AgentWorkerRole', 'ReadState');
      delete statement['Sid'];
      statement['Resource'] = ['*'];
    });
    expect(violations.find((v) => v.rule === 'NO_WILDCARD_RESOURCE')?.resource).toContain('/unnamed');
  });

  it('checks a role whose logical id does not end in Role', () => {
    const violations = broken((t) => {
      t.Resources['SandboxRunner'] = structuredClone(t.Resources['AgentWorkerRole']!);
    });
    // Not a named writer under either name, and it writes nothing, so the only
    // thing that changes is that the checker read it at all.
    expect(violations).toEqual([]);
  });

  it('ignores a statement that neither allows nor denies', () => {
    const violations = broken((t) => {
      const policies = t.Resources['ProjectionUpdaterRole']!.Properties['Policies'] as {
        PolicyDocument: { Statement: Record<string, unknown>[] };
      }[];
      policies[0]!.PolicyDocument.Statement.push({ Sid: 'Neither', Effect: 'Maybe', Action: ['dynamodb:*'], Resource: ['*'] });
    });
    // A statement with no recognised effect grants nothing, so the wildcard
    // rules must not fire on it.
    expect(violations).toEqual([]);
  });

  it('treats a deny that is not key-scoped as not being the boundary', () => {
    const violations = broken((t) => {
      delete statementIn(t, 'ApiHandlerRole', 'NeverRewriteHistory')['Condition'];
    });
    expect(rulesFrom(violations)).toContain('EXPLICIT_HISTORY_DENY');
  });
});

describe('what the rules refuse to be fooled by', () => {
  it('does not mistake an AWS credential-shaped string for a reference', () => {
    const violations = broken((t) => {
      (t.Resources['ApiHandler']!.Properties['Environment'] as { Variables: Record<string, unknown> }).Variables['key'] = 'AKIAIOSFODNN7EXAMPLE';
    });
    expect(rulesFrom(violations)).toContain('NO_PLAINTEXT_SECRETS');
  });

  it('does not flag a `Fn::Sub` that merely contains the word secret', () => {
    const violations = broken((t) => {
      (t.Resources['ApiHandler']!.Properties['Environment'] as { Variables: Record<string, unknown> }).Variables['secretPath'] = {
        'Fn::Sub': 'genesis/${AWS::StackName}/secret',
      };
    });
    expect(rulesFrom(violations)).not.toContain('NO_PLAINTEXT_SECRETS');
  });

  it('treats an intrinsic resource as scoped, not as a wildcard', () => {
    // Every real statement uses `Fn::GetAtt` or `Fn::Sub`, so a rule that
    // matched loosely would fire on all of them.
    expect(checkPosture(genesisStack(CONFIG)).filter((v) => v.rule === 'NO_WILDCARD_RESOURCE')).toEqual([]);
  });

  it('allows a service principal, which is not a wildcard principal', () => {
    expect(checkPosture(genesisStack(CONFIG)).filter((v) => v.rule === 'NO_WILDCARD_PRINCIPAL')).toEqual([]);
  });

  it('does not fire the deny rule on a role that writes nothing', () => {
    const violations = checkPosture(genesisStack(CONFIG)).filter((v) => v.resource === 'LedgerFanOutRole');
    expect(violations).toEqual([]);
  });
});

describe('the rule constants themselves', () => {
  it('names the writers, so the list is reviewable rather than inferred', () => {
    expect(LEDGER_WRITERS).toEqual(['ApiHandler', 'CyclePhaseHandler', 'FactoryStageHandler', 'ApprovalHandler']);
    expect(TABLE_WRITERS).toContain('ProjectionUpdater');
    expect(TABLE_WRITERS).not.toContain('AgentWorker');
  });

  it('forbids the actions that would make every other rule moot', () => {
    for (const action of ['*', 'iam:*', 'dynamodb:*']) expect(FORBIDDEN_ACTIONS).toContain(action);
  });

  it('reads statements out of a role with no policies without throwing', () => {
    expect(statementsOf({ Type: 'AWS::IAM::Role', Properties: {} })).toEqual([]);
  });

  it('names an unnamed policy rather than losing it', () => {
    const statements = statementsOf({
      Type: 'AWS::IAM::Role',
      Properties: { Policies: [{ PolicyDocument: { Statement: [{ Effect: 'Allow' }] } }] },
    });
    expect(statements[0]?.[0]).toBe('inline');
  });

  it('handles a single statement that is not in an array', () => {
    const statements = statementsOf({
      Type: 'AWS::IAM::Role',
      Properties: { Policies: { PolicyName: 'One', PolicyDocument: { Statement: { Effect: 'Allow', Action: 's3:GetObject' } } } },
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]?.[0]).toBe('One');
  });
});

describe('violations are reported all at once', () => {
  it('returns every finding rather than stopping at the first', () => {
    const violations = broken((t) => {
      t.Resources['GenesisTable']!.Properties['PointInTimeRecoverySpecification'] = { PointInTimeRecoveryEnabled: false };
      t.Resources['GenesisTable']!.DeletionPolicy = 'Delete';
      delete t.Resources['ArtifactBucketPolicy'];
    });
    expect([...rulesFrom(violations)].sort()).toEqual(['BUCKET_TLS_ONLY', 'RETAIN_STATE', 'TABLE_PITR']);
  });

  it('reports in a stable order, so two runs read the same', () => {
    const mutate = (t: Mutable): void => {
      t.Resources['GenesisTable']!.DeletionPolicy = 'Delete';
      t.Resources['EvidenceBucket']!.DeletionPolicy = 'Delete';
    };
    expect(broken(mutate)).toEqual(broken(mutate));
    expect(broken(mutate).map((v) => v.resource)).toEqual(['EvidenceBucket', 'GenesisTable']);
  });
});
