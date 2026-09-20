/**
 * CloudFormation as typed data (ADR-0026 §2).
 *
 * The deployed stack is emitted from these types rather than hand-written in
 * YAML, for one reason: a hand-written template is a second description of the
 * architecture, and second descriptions drift. Emitting it means the table's key
 * schema, the pipeline's stages and the loop's phases reach the deployment from
 * the same constants the code uses, and a divergence is a failing test rather
 * than an incident.
 *
 * This module knows CloudFormation's shapes and nothing about GENESIS. The
 * stack itself is in `stack.ts`, and what may not be deployed is in
 * `posture.ts`.
 */

/** A CloudFormation intrinsic, kept opaque so a template stays JSON. */
export type Intrinsic = Readonly<Record<string, unknown>>;
export type TemplateValue = string | number | boolean | null | Intrinsic | readonly TemplateValue[] | { readonly [k: string]: TemplateValue };

export const ref = (logicalId: string): Intrinsic => ({ Ref: logicalId });
export const getAtt = (logicalId: string, attribute: string): Intrinsic => ({ 'Fn::GetAtt': [logicalId, attribute] });
export const sub = (template: string): Intrinsic => ({ 'Fn::Sub': template });
export const join = (delimiter: string, parts: readonly TemplateValue[]): Intrinsic => ({
  'Fn::Join': [delimiter, parts],
});
export const AWS_REGION = { Ref: 'AWS::Region' } as const;
export const AWS_ACCOUNT = { Ref: 'AWS::AccountId' } as const;
export const AWS_PARTITION = { Ref: 'AWS::Partition' } as const;

/**
 * Whether a resource survives the stack being deleted.
 *
 * `Retain` on anything holding history is not caution, it is the event-sourcing
 * rule (ADR-0004) reaching the deployment: a ledger that a `cloudformation
 * delete-stack` can erase is not append-only in any sense that matters.
 */
export type DeletionPolicy = 'Retain' | 'Delete' | 'Snapshot';

export interface TemplateResource {
  readonly Type: string;
  readonly Properties: Readonly<Record<string, TemplateValue>>;
  readonly DeletionPolicy?: DeletionPolicy;
  readonly UpdateReplacePolicy?: DeletionPolicy;
  readonly DependsOn?: readonly string[];
  readonly Condition?: string;
  readonly Metadata?: Readonly<Record<string, TemplateValue>>;
}

export interface TemplateParameter {
  readonly Type: 'String' | 'Number' | 'CommaDelimitedList';
  readonly Description: string;
  readonly Default?: string | number;
  readonly AllowedValues?: readonly (string | number)[];
  readonly AllowedPattern?: string;
  readonly MinLength?: number;
  readonly NoEcho?: boolean;
}

export interface TemplateOutput {
  readonly Description: string;
  readonly Value: TemplateValue;
  readonly Export?: { readonly Name: TemplateValue };
}

export interface CloudFormationTemplate {
  readonly AWSTemplateFormatVersion: '2010-09-09';
  readonly Description: string;
  readonly Parameters: Readonly<Record<string, TemplateParameter>>;
  readonly Resources: Readonly<Record<string, TemplateResource>>;
  readonly Outputs: Readonly<Record<string, TemplateOutput>>;
}

/** A logical id CloudFormation will accept: alphanumeric, and it must exist. */
const LOGICAL_ID = /^[A-Za-z][A-Za-z0-9]*$/;

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

/**
 * Assembles a template, refusing what CloudFormation would refuse later.
 *
 * Catching a bad logical id or a dangling `Ref` here rather than at deploy time
 * is the point of emitting at all: the failure lands in a test run instead of
 * halfway through a stack update.
 */
export function buildTemplate(input: {
  readonly description: string;
  readonly parameters?: Readonly<Record<string, TemplateParameter>>;
  readonly resources: Readonly<Record<string, TemplateResource>>;
  readonly outputs?: Readonly<Record<string, TemplateOutput>>;
}): CloudFormationTemplate {
  const parameters = input.parameters ?? {};
  const outputs = input.outputs ?? {};

  for (const id of [...Object.keys(input.resources), ...Object.keys(parameters), ...Object.keys(outputs)]) {
    if (!LOGICAL_ID.test(id)) throw new TemplateError(`${id} is not a usable logical id`);
  }
  if (Object.keys(input.resources).length === 0) {
    throw new TemplateError('a template with no resources deploys nothing');
  }

  const known = new Set([
    ...Object.keys(input.resources),
    ...Object.keys(parameters),
    'AWS::Region',
    'AWS::AccountId',
    'AWS::Partition',
    'AWS::StackName',
    'AWS::NoValue',
    'AWS::URLSuffix',
  ]);
  for (const missing of danglingReferences({ resources: input.resources, outputs }, known)) {
    throw new TemplateError(`${missing} is referenced but not declared`);
  }

  for (const [id, resource] of Object.entries(input.resources)) {
    for (const dependency of resource.DependsOn ?? []) {
      if (!(dependency in input.resources)) {
        throw new TemplateError(`${id} depends on ${dependency}, which is not in the template`);
      }
    }
  }

  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: input.description,
    Parameters: parameters,
    Resources: input.resources,
    Outputs: outputs,
  };
}

/** Every logical id named by a `Ref` or `Fn::GetAtt` anywhere in a value. */
export function referencedIds(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) referencedIds(item, found);
    return found;
  }
  if (typeof value !== 'object' || value === null) return found;

  const record = value as Record<string, unknown>;
  if (typeof record['Ref'] === 'string') found.add(record['Ref']);
  const att = record['Fn::GetAtt'];
  if (Array.isArray(att) && typeof att[0] === 'string') found.add(att[0]);
  if (typeof att === 'string') found.add(att.split('.')[0] as string);

  for (const nested of Object.values(record)) referencedIds(nested, found);
  return found;
}

const danglingReferences = (subject: unknown, known: ReadonlySet<string>): readonly string[] =>
  [...referencedIds(subject)].filter((id) => !known.has(id)).sort();

/**
 * The template as the text that gets deployed.
 *
 * Keys are emitted in sorted order so two builds of the same stack produce
 * byte-identical output: a diff then means the architecture changed, not that
 * an object literal was rearranged.
 */
export const emitTemplate = (template: CloudFormationTemplate): string => `${JSON.stringify(sortDeep(template), null, 2)}\n`;

export function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (typeof value !== 'object' || value === null) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortDeep((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/** Every resource of a type, as `[logicalId, resource]` pairs, in a stable order. */
export const resourcesOfType = (
  template: CloudFormationTemplate,
  type: string,
): readonly (readonly [string, TemplateResource])[] =>
  Object.entries(template.Resources)
    .filter(([, resource]) => resource.Type === type)
    .sort(([a], [b]) => a.localeCompare(b));
