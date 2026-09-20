/**
 * The GENESIS stack (SPEC-07 §2, ADR-0026 §2).
 *
 * One stack per project (SPEC-07 §7: no shared mutable infrastructure), emitted
 * from the same constants the code uses. Nothing here has been deployed —
 * ADR-0026 §5 says so plainly, and the tests prove the template is well formed
 * and least-privilege, not that it works in an account.
 *
 * What is deliberately absent:
 *
 *   - **Neptune.** ADR-0025 §3: the graph is a rebuildable projection and no
 *     measured graph size justifies the fixed cost yet. The DynamoDB graph
 *     store passes the identical conformance suite, so adding Neptune later is
 *     a deployment change, not an architecture change.
 *   - **Bedrock AgentCore.** ADR-0025 §2: its agents act; ours propose.
 *   - **A second event store.** DynamoDB Streams feeds projections and the bus.
 *     Both are downstream of the ledger and neither is authoritative.
 */

import {
  assumedBy,
  denyLedgerMutation,
  denyLedgerWrites,
  derivedWrite,
  dynamoRead,
  invokeFunctions,
  invokeModels,
  kmsUse,
  ledgerAppend,
  listUnder,
  objectsUnder,
  policy,
  type PolicyStatement,
  publishToBus,
  resolveSecrets,
  runSandboxTasks,
  streamRead,
  writeOwnLogs,
} from './policy.js';
import {
  buildTemplate,
  type CloudFormationTemplate,
  getAtt,
  ref,
  sub,
  type TemplateOutput,
  type TemplateResource,
  type TemplateValue,
} from './template.js';
import { GSI1, GSI2, TABLE_KEYS } from './table.js';

export interface StackConfig {
  /** The project this stack belongs to. One project, one stack. */
  readonly projectId: string;
  readonly environment: 'dev' | 'staging' | 'prod';
  /** Where the built handler bundles live. Supplied by the deployment pipeline. */
  readonly deploymentBucket: string;
  readonly deploymentKey: string;
  /** The models this deployment may call, named rather than wildcarded. */
  readonly modelIds: readonly string[];
  readonly logRetentionDays?: number;
  readonly lambdaMemoryMb?: number;
}

const TABLE = 'GenesisTable';
const KEY = 'GenesisKey';
const EVIDENCE = 'EvidenceBucket';
const ARTIFACTS = 'ArtifactBucket';
const BUS = 'LedgerBus';
const POOL = 'UserPool';
const CLUSTER = 'SandboxCluster';

/** Handlers, and what each is allowed to do. The list is the trust boundary. */
const HANDLERS = [
  'ApiHandler',
  'CyclePhaseHandler',
  'FactoryStageHandler',
  'ProjectionUpdater',
  'LedgerFanOut',
  'AgentWorker',
  'ApprovalHandler',
] as const;
export type HandlerName = (typeof HANDLERS)[number];
export const HANDLER_NAMES: readonly HandlerName[] = HANDLERS;

const tableArn = getAtt(TABLE, 'Arn');
const streamArn = getAtt(TABLE, 'StreamArn');
const keyArn = getAtt(KEY, 'Arn');
const evidenceArn = getAtt(EVIDENCE, 'Arn');
const artifactArn = getAtt(ARTIFACTS, 'Arn');
const busArn = getAtt(BUS, 'Arn');

/**
 * What each handler may do.
 *
 * Read this as the deployment's statement of the trust boundaries:
 *
 *   - Only `ApiHandler` and `CyclePhaseHandler` may append to the ledger, and
 *     neither may update or delete an item on it.
 *   - `AgentWorker` may read everything it needs, call a named model, and write
 *     artifacts. It has **no** write access to the table at all, which is
 *     ADR-0006 — agents propose, the core mutates — enforced by IAM rather than
 *     by the agent runtime remembering to check.
 *   - `ProjectionUpdater` may write derived state and may not append events, so
 *     a projection cannot become a source of truth (ADR-0013).
 *   - `LedgerFanOut` may read the stream and publish. It cannot write anything.
 */
const permissionsFor = (name: HandlerName, config: StackConfig): readonly PolicyStatement[] => {
  const prefix = `${config.projectId}/`;
  const common = [writeOwnLogs(sub(`\${AWS::StackName}-${name}`)), kmsUse(keyArn, 'UseStackKey')];
  switch (name) {
    case 'ApiHandler':
      return [...common, dynamoRead(tableArn, 'ReadState'), ledgerAppend(tableArn), denyLedgerMutation(tableArn), objectsUnder(evidenceArn, `${prefix}*`, 'ReadEvidence', false), listUnder(evidenceArn, `${prefix}*`, 'ListOwnEvidence')];
    case 'CyclePhaseHandler':
      return [
        ...common,
        dynamoRead(tableArn, 'ReadState'),
        ledgerAppend(tableArn),
        denyLedgerMutation(tableArn),
        invokeModels(config.modelIds),
        objectsUnder(evidenceArn, `${prefix}*`, 'WriteEvidence', true),
        resolveSecrets(`genesis/${config.projectId}/`),
      ];
    case 'FactoryStageHandler':
      return [
        ...common,
        dynamoRead(tableArn, 'ReadState'),
        ledgerAppend(tableArn),
        denyLedgerMutation(tableArn),
        objectsUnder(artifactArn, `${prefix}*`, 'WriteArtifacts', true),
        objectsUnder(evidenceArn, `${prefix}*`, 'WriteEvidence', true),
        runSandboxTasks(ref('SandboxTaskDefinition'), getAtt(CLUSTER, 'Arn')),
      ];
    case 'ProjectionUpdater':
      // Derived state only. No ledger append: a projection that could write
      // history could manufacture the history it then reports (ADR-0013).
      return [...common, streamRead(streamArn), dynamoRead(tableArn, 'ReadState'), derivedWrite(tableArn), denyLedgerWrites(tableArn)];
    case 'LedgerFanOut':
      return [...common, streamRead(streamArn), publishToBus(busArn)];
    case 'AgentWorker':
      return [
        ...common,
        dynamoRead(tableArn, 'ReadState'),
        invokeModels(config.modelIds),
        objectsUnder(artifactArn, `${prefix}*`, 'WriteArtifacts', true),
        objectsUnder(evidenceArn, `${prefix}*`, 'ReadEvidence', false),
        resolveSecrets(`genesis/${config.projectId}/`),
      ];
    case 'ApprovalHandler':
      return [...common, dynamoRead(tableArn, 'ReadState'), ledgerAppend(tableArn), denyLedgerMutation(tableArn)];
  }
};

const roleId = (name: HandlerName): string => `${name}Role`;
const logGroupId = (name: HandlerName): string => `${name}Logs`;

const handlerResources = (name: HandlerName, config: StackConfig): Record<string, TemplateResource> => ({
  [roleId(name)]: {
    Type: 'AWS::IAM::Role',
    Properties: {
      AssumeRolePolicyDocument: assumedBy('lambda.amazonaws.com'),
      // No ManagedPolicyArns: the managed basic-execution policy grants logs on
      // a wildcard resource, which the posture rules forbid outright.
      Policies: [{ PolicyName: `${name}Permissions`, PolicyDocument: policy(permissionsFor(name, config)) as unknown as TemplateValue }],
    },
  },
  [logGroupId(name)]: {
    Type: 'AWS::Logs::LogGroup',
    DeletionPolicy: 'Retain',
    Properties: {
      LogGroupName: sub(`/aws/lambda/\${AWS::StackName}-${name}`),
      RetentionInDays: config.logRetentionDays ?? 90,
      KmsKeyId: keyArn,
    },
  },
  [name]: {
    Type: 'AWS::Lambda::Function',
    DependsOn: [logGroupId(name)],
    Properties: {
      FunctionName: sub(`\${AWS::StackName}-${name}`),
      Handler: `handlers/${name}.handler`,
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      MemorySize: config.lambdaMemoryMb ?? 1024,
      Timeout: 900,
      Role: getAtt(roleId(name), 'Arn'),
      Code: { S3Bucket: config.deploymentBucket, S3Key: config.deploymentKey },
      KmsKeyArn: keyArn,
      Environment: {
        Variables: {
          GENESIS_TABLE: ref(TABLE),
          GENESIS_PROJECT_ID: config.projectId,
          GENESIS_ENVIRONMENT: config.environment,
          GENESIS_EVIDENCE_BUCKET: ref(EVIDENCE),
          GENESIS_ARTIFACT_BUCKET: ref(ARTIFACTS),
          GENESIS_EVENT_BUS: ref(BUS),
          GENESIS_KMS_KEY: keyArn,
          // Which models this deployment may call. The list is also in the IAM
          // policy; configuration says what to ask for, IAM says what is
          // permitted, and the narrower of the two wins.
          GENESIS_MODEL_IDS: config.modelIds.join(','),
        },
      },
    },
  },
});

const secureBucket = (logicalId: string, config: StackConfig): TemplateResource => ({
  Type: 'AWS::S3::Bucket',
  // Evidence outlives the stack that produced it. SPEC-05 §4's anti-fabrication
  // rule depends on the bytes still being there to re-hash.
  DeletionPolicy: 'Retain',
  UpdateReplacePolicy: 'Retain',
  Properties: {
    BucketName: sub(`\${AWS::StackName}-${logicalId.toLowerCase()}-\${AWS::AccountId}`),
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: keyArn }, BucketKeyEnabled: true },
      ],
    },
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
    VersioningConfiguration: { Status: 'Enabled' },
    OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
    LifecycleConfiguration: {
      Rules: [{ Id: 'AbandonedUploads', Status: 'Enabled', AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 } }],
    },
    Tags: [{ Key: 'genesis:project', Value: config.projectId }],
  },
});

const denyInsecureTransport = (bucketId: string): TemplateResource => ({
  Type: 'AWS::S3::BucketPolicy',
  Properties: {
    Bucket: ref(bucketId),
    PolicyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'DenyInsecureTransport',
          Effect: 'Deny',
          Principal: '*',
          Action: 's3:*',
          Resource: [getAtt(bucketId, 'Arn'), sub(`\${${bucketId}.Arn}/*`)],
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        },
      ],
    },
  },
});

/** Builds the whole stack. Deterministic: same config, same bytes. */
export function genesisStack(config: StackConfig): CloudFormationTemplate {
  if (config.modelIds.length === 0) {
    // A deployment that may call any model has no provenance story (ADR-0007),
    // and an empty list would emit a policy with no resources, which IAM
    // rejects at deploy time rather than here.
    throw new Error('a stack must name the models it may call');
  }

  const resources: Record<string, TemplateResource> = {
    [KEY]: {
      Type: 'AWS::KMS::Key',
      DeletionPolicy: 'Retain',
      Properties: {
        Description: sub('Encryption for ${AWS::StackName}: ledger, memory, evidence, artifacts and logs'),
        EnableKeyRotation: true,
        KeyPolicy: {
          Version: '2012-10-17',
          Statement: [
            { Sid: 'AccountRoot', Effect: 'Allow', Principal: { AWS: sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:root') }, Action: 'kms:*', Resource: '*' },
            {
              Sid: 'LogsMayEncrypt',
              Effect: 'Allow',
              Principal: { Service: sub('logs.${AWS::Region}.amazonaws.com') },
              Action: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey'],
              Resource: '*',
              Condition: { StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } } },
            },
          ],
        },
      },
    },
    GenesisKeyAlias: {
      Type: 'AWS::KMS::Alias',
      Properties: { AliasName: sub('alias/${AWS::StackName}'), TargetKeyId: ref(KEY) },
    },

    [TABLE]: {
      Type: 'AWS::DynamoDB::Table',
      // The system of record. A stack deletion that took the ledger with it
      // would destroy the only thing that cannot be rebuilt (ADR-0004).
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: {
        TableName: sub('${AWS::StackName}-state'),
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: TABLE_KEYS.partition, AttributeType: 'S' },
          { AttributeName: TABLE_KEYS.sort, AttributeType: 'S' },
          { AttributeName: 'gsi1pk', AttributeType: 'S' },
          { AttributeName: 'gsi1sk', AttributeType: 'S' },
          { AttributeName: 'gsi2pk', AttributeType: 'S' },
          { AttributeName: 'gsi2sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: TABLE_KEYS.partition, KeyType: 'HASH' },
          { AttributeName: TABLE_KEYS.sort, KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: GSI1,
            KeySchema: [
              { AttributeName: 'gsi1pk', KeyType: 'HASH' },
              { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
          {
            IndexName: GSI2,
            KeySchema: [
              { AttributeName: 'gsi2pk', KeyType: 'HASH' },
              { AttributeName: 'gsi2sk', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
        // Both images: a projection updater needs the prior state to fold
        // correctly, and a fan-out consumer needs to know what changed.
        StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        SSESpecification: { SSEEnabled: true, SSEType: 'KMS', KMSMasterKeyId: keyArn },
        DeletionProtectionEnabled: true,
        Tags: [{ Key: 'genesis:project', Value: config.projectId }],
      },
    },

    [EVIDENCE]: secureBucket(EVIDENCE, config),
    EvidenceBucketPolicy: denyInsecureTransport(EVIDENCE),
    [ARTIFACTS]: secureBucket(ARTIFACTS, config),
    ArtifactBucketPolicy: denyInsecureTransport(ARTIFACTS),

    [BUS]: {
      Type: 'AWS::Events::EventBus',
      Properties: { Name: sub('${AWS::StackName}-ledger') },
    },

    [POOL]: {
      Type: 'AWS::Cognito::UserPool',
      DeletionPolicy: 'Retain',
      Properties: {
        UserPoolName: sub('${AWS::StackName}-humans'),
        // Every HUMAN_DECISION on the ledger is attributed to a subject from
        // this pool (ADR-0005), so self-signup would let anyone mint the
        // highest authority in the system.
        AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
        MfaConfiguration: 'ON',
        EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
        Policies: {
          PasswordPolicy: {
            MinimumLength: 16,
            RequireLowercase: true,
            RequireNumbers: true,
            RequireSymbols: true,
            RequireUppercase: true,
          },
        },
        UserPoolAddOns: { AdvancedSecurityMode: 'ENFORCED' },
      },
    },
    UserPoolClient: {
      Type: 'AWS::Cognito::UserPoolClient',
      Properties: {
        ClientName: sub('${AWS::StackName}-console'),
        UserPoolId: ref(POOL),
        // No secret: the console is a public client and a secret it shipped
        // would not be one.
        GenerateSecret: false,
        ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
        AccessTokenValidity: 60,
        IdTokenValidity: 60,
        RefreshTokenValidity: 1,
        TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'days' },
        PreventUserExistenceErrors: 'ENABLED',
      },
    },

    [CLUSTER]: {
      Type: 'AWS::ECS::Cluster',
      Properties: {
        ClusterName: sub('${AWS::StackName}-sandbox'),
        ClusterSettings: [{ Name: 'containerInsights', Value: 'enabled' }],
      },
    },
    SandboxTaskRole: {
      Type: 'AWS::IAM::Role',
      Properties: {
        AssumeRolePolicyDocument: assumedBy('ecs-tasks.amazonaws.com'),
        Policies: [
          {
            PolicyName: 'SandboxPermissions',
            // Everything generated code could touch, and nothing else. No
            // table access at all: code GENESIS wrote must not be able to reach
            // the ledger, whatever it tries (SPEC-06 §6).
            PolicyDocument: policy([
              objectsUnder(artifactArn, `${config.projectId}/sandbox/*`, 'SandboxScratch', true),
              listUnder(artifactArn, `${config.projectId}/sandbox/*`, 'ListOwnScratch'),
              kmsUse(keyArn, 'UseStackKey'),
            ]) as unknown as TemplateValue,
          },
        ],
      },
    },
    SandboxExecutionRole: {
      Type: 'AWS::IAM::Role',
      Properties: {
        AssumeRolePolicyDocument: assumedBy('ecs-tasks.amazonaws.com'),
        Policies: [
          {
            PolicyName: 'PullAndLog',
            PolicyDocument: policy([
              {
                Sid: 'PullImage',
                Effect: 'Allow',
                Action: ['ecr:GetAuthorizationToken', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'],
                Resource: [sub('arn:${AWS::Partition}:ecr:${AWS::Region}:${AWS::AccountId}:repository/genesis-sandbox')],
              },
              {
                Sid: 'WriteSandboxLogs',
                Effect: 'Allow',
                Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
                Resource: [getAtt('SandboxLogs', 'Arn')],
              },
            ]) as unknown as TemplateValue,
          },
        ],
      },
    },
    SandboxLogs: {
      Type: 'AWS::Logs::LogGroup',
      DeletionPolicy: 'Retain',
      Properties: {
        LogGroupName: sub('/aws/ecs/${AWS::StackName}-sandbox'),
        RetentionInDays: config.logRetentionDays ?? 90,
        KmsKeyId: keyArn,
      },
    },
    SandboxTaskDefinition: {
      Type: 'AWS::ECS::TaskDefinition',
      Properties: {
        Family: sub('${AWS::StackName}-sandbox'),
        RequiresCompatibilities: ['FARGATE'],
        NetworkMode: 'awsvpc',
        Cpu: '2048',
        Memory: '4096',
        TaskRoleArn: getAtt('SandboxTaskRole', 'Arn'),
        ExecutionRoleArn: getAtt('SandboxExecutionRole', 'Arn'),
        ContainerDefinitions: [
          {
            Name: 'sandbox',
            Image: sub('${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}/genesis-sandbox:latest'),
            Essential: true,
            ReadonlyRootFilesystem: true,
            // The container runs code the system generated. It gets no
            // credentials, no privileges and a read-only root; its scratch
            // space is a mounted volume (ADR-0025 §1).
            Privileged: false,
            User: '10001:10001',
            LinuxParameters: { InitProcessEnabled: true },
            MountPoints: [{ SourceVolume: 'scratch', ContainerPath: '/workspace', ReadOnly: false }],
            LogConfiguration: {
              LogDriver: 'awslogs',
              Options: {
                'awslogs-group': ref('SandboxLogs'),
                'awslogs-region': { Ref: 'AWS::Region' },
                'awslogs-stream-prefix': 'run',
              },
            },
          },
        ],
        Volumes: [{ Name: 'scratch' }],
      },
    },
  };

  for (const name of HANDLERS) Object.assign(resources, handlerResources(name, config));

  // Stream consumers. Two mappings on one stream: projections fold it, fan-out
  // publishes it. Neither is the ledger, and neither can write history.
  for (const [id, target] of [
    ['ProjectionStreamMapping', 'ProjectionUpdater'],
    ['FanOutStreamMapping', 'LedgerFanOut'],
  ] as const) {
    resources[id] = {
      Type: 'AWS::Lambda::EventSourceMapping',
      Properties: {
        EventSourceArn: streamArn,
        FunctionName: getAtt(target, 'Arn'),
        // Order matters for a fold over a hash chain, so one batch at a time
        // per shard and a failed batch is retried rather than skipped.
        StartingPosition: 'TRIM_HORIZON',
        BatchSize: 100,
        MaximumBatchingWindowInSeconds: 1,
        BisectBatchOnFunctionError: true,
        MaximumRetryAttempts: 10,
        ParallelizationFactor: 1,
        FunctionResponseTypes: ['ReportBatchItemFailures'],
      },
    };
  }

  resources['StateMachineRole'] = {
    Type: 'AWS::IAM::Role',
    Properties: {
      AssumeRolePolicyDocument: assumedBy('states.amazonaws.com'),
      Policies: [
        {
          PolicyName: 'InvokeHandlers',
          PolicyDocument: policy([
            invokeFunctions([getAtt('CyclePhaseHandler', 'Arn'), getAtt('FactoryStageHandler', 'Arn'), getAtt('ApprovalHandler', 'Arn')]),
          ]) as unknown as TemplateValue,
        },
      ],
    },
  };

  resources['ApiAuthorizer'] = {
    Type: 'AWS::ApiGatewayV2::Authorizer',
    Properties: {
      ApiId: ref('HttpApi'),
      AuthorizerType: 'JWT',
      IdentitySource: ['$request.header.Authorization'],
      Name: 'CognitoJwt',
      JwtConfiguration: {
        Audience: [ref('UserPoolClient')],
        Issuer: sub('https://cognito-idp.${AWS::Region}.${AWS::URLSuffix}/${UserPool}'),
      },
    },
  };
  resources['HttpApi'] = {
    Type: 'AWS::ApiGatewayV2::Api',
    Properties: {
      Name: sub('${AWS::StackName}-api'),
      ProtocolType: 'HTTP',
      // No CORS wildcard: the console's origin is configured per deployment,
      // and a wildcard here would let any page call an authenticated API.
      DisableExecuteApiEndpoint: false,
    },
  };
  resources['ApiIntegration'] = {
    Type: 'AWS::ApiGatewayV2::Integration',
    Properties: {
      ApiId: ref('HttpApi'),
      IntegrationType: 'AWS_PROXY',
      IntegrationUri: getAtt('ApiHandler', 'Arn'),
      PayloadFormatVersion: '2.0',
      TimeoutInMillis: 29_000,
    },
  };
  resources['ApiRoute'] = {
    Type: 'AWS::ApiGatewayV2::Route',
    Properties: {
      ApiId: ref('HttpApi'),
      RouteKey: 'ANY /{proxy+}',
      // Every route is authorized. There is no unauthenticated surface: an
      // anonymous caller has no subject, and without a subject nothing it did
      // could be attributed on the ledger.
      AuthorizationType: 'JWT',
      AuthorizerId: ref('ApiAuthorizer'),
      Target: sub('integrations/${ApiIntegration}'),
    },
  };
  resources['ApiStage'] = {
    Type: 'AWS::ApiGatewayV2::Stage',
    Properties: {
      ApiId: ref('HttpApi'),
      StageName: '$default',
      AutoDeploy: true,
      DefaultRouteSettings: { ThrottlingBurstLimit: 20, ThrottlingRateLimit: 10, DetailedMetricsEnabled: true },
      AccessLogSettings: {
        DestinationArn: getAtt('ApiLogs', 'Arn'),
        Format: '{"requestId":"$context.requestId","status":"$context.status","route":"$context.routeKey","sub":"$context.authorizer.claims.sub"}',
      },
    },
  };
  resources['ApiLogs'] = {
    Type: 'AWS::Logs::LogGroup',
    DeletionPolicy: 'Retain',
    Properties: {
      LogGroupName: sub('/aws/apigateway/${AWS::StackName}'),
      RetentionInDays: config.logRetentionDays ?? 90,
      KmsKeyId: keyArn,
    },
  };
  resources['ApiInvokePermission'] = {
    Type: 'AWS::Lambda::Permission',
    Properties: {
      Action: 'lambda:InvokeFunction',
      FunctionName: getAtt('ApiHandler', 'Arn'),
      Principal: 'apigateway.amazonaws.com',
      SourceArn: sub('arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${HttpApi}/*'),
    },
  };

  const outputs: Record<string, TemplateOutput> = {
    TableName: { Description: 'The single table holding the ledger, memory, graph and snapshots', Value: ref(TABLE) },
    EvidenceBucketName: { Description: 'Content-addressed evidence', Value: ref(EVIDENCE) },
    ArtifactBucketName: { Description: 'Generated artifacts', Value: ref(ARTIFACTS) },
    EventBusName: { Description: 'Ledger fan-out bus', Value: ref(BUS) },
    UserPoolId: { Description: 'The pool every HUMAN_DECISION is attributed to', Value: ref(POOL) },
    ApiEndpoint: { Description: 'The authenticated HTTP surface', Value: getAtt('HttpApi', 'ApiEndpoint') },
  };

  return buildTemplate({
    description: `GENESIS runtime for project ${config.projectId} (${config.environment}). Emitted from @genesis/infrastructure; see ADR-0026.`,
    resources,
    outputs,
  });
}

export { TABLE as TABLE_RESOURCE_ID, KEY as KEY_RESOURCE_ID, EVIDENCE as EVIDENCE_RESOURCE_ID, ARTIFACTS as ARTIFACT_RESOURCE_ID, BUS as BUS_RESOURCE_ID, POOL as POOL_RESOURCE_ID };
