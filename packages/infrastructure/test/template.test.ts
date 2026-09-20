/**
 * The emitter itself: it must refuse what CloudFormation would refuse, and it
 * must be deterministic, because a diff between two builds is supposed to mean
 * the architecture changed.
 */

import { describe, expect, it } from 'vitest';
import {
  buildTemplate,
  emitTemplate,
  getAtt,
  join,
  ref,
  referencedIds,
  resourcesOfType,
  sortDeep,
  sub,
  TemplateError,
  type TemplateResource,
} from '../src/template.js';

const bucket = (name = 'a-bucket'): TemplateResource => ({
  Type: 'AWS::S3::Bucket',
  Properties: { BucketName: name },
});

describe('intrinsics', () => {
  it('produce the shapes CloudFormation understands', () => {
    expect(ref('Thing')).toEqual({ Ref: 'Thing' });
    expect(getAtt('Thing', 'Arn')).toEqual({ 'Fn::GetAtt': ['Thing', 'Arn'] });
    expect(sub('${AWS::Region}')).toEqual({ 'Fn::Sub': '${AWS::Region}' });
    expect(join('-', ['a', ref('B')])).toEqual({ 'Fn::Join': ['-', ['a', { Ref: 'B' }]] });
  });
});

describe('finding references', () => {
  it('sees a Ref and a GetAtt wherever they are nested', () => {
    const found = referencedIds({ a: [{ b: ref('One') }], c: { d: getAtt('Two', 'Arn') } });
    expect([...found].sort()).toEqual(['One', 'Two']);
  });

  it('understands the dotted GetAtt form', () => {
    expect([...referencedIds({ x: { 'Fn::GetAtt': 'Three.Arn' } })]).toEqual(['Three']);
  });

  it('ignores values that only look like references', () => {
    expect([...referencedIds({ Ref: 42, note: 'Ref: NotAResource' })]).toEqual([]);
    expect([...referencedIds(null)]).toEqual([]);
    expect([...referencedIds('a string')]).toEqual([]);
  });
});

describe('building a template', () => {
  it('assembles a valid template', () => {
    const template = buildTemplate({ description: 'a stack', resources: { Bucket: bucket() } });
    expect(template.AWSTemplateFormatVersion).toBe('2010-09-09');
    expect(template.Description).toBe('a stack');
    expect(template.Parameters).toEqual({});
    expect(template.Outputs).toEqual({});
  });

  it('refuses a template with no resources, which deploys nothing', () => {
    expect(() => buildTemplate({ description: 'empty', resources: {} })).toThrow(TemplateError);
  });

  it('refuses a logical id CloudFormation would not accept', () => {
    for (const id of ['my-bucket', '1Bucket', 'bucket_one', '']) {
      expect(() => buildTemplate({ description: 'd', resources: { [id]: bucket() } }), id).toThrow(TemplateError);
    }
  });

  it('refuses a reference to something the template does not declare', () => {
    expect(() =>
      buildTemplate({
        description: 'd',
        resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: ref('Missing') } } },
      }),
    ).toThrow(/Missing is referenced but not declared/);
  });

  it('refuses a dangling reference in an output too', () => {
    expect(() =>
      buildTemplate({
        description: 'd',
        resources: { Bucket: bucket() },
        outputs: { Name: { Description: 'n', Value: ref('Absent') } },
      }),
    ).toThrow(/Absent is referenced but not declared/);
  });

  it('accepts a reference to a parameter or a pseudo-parameter', () => {
    const template = buildTemplate({
      description: 'd',
      parameters: { Stage: { Type: 'String', Description: 'which environment' } },
      resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: ref('Stage'), Region: { Ref: 'AWS::Region' } } } },
    });
    expect(template.Parameters['Stage']?.Type).toBe('String');
  });

  it('refuses a DependsOn naming a resource that is not there', () => {
    expect(() =>
      buildTemplate({ description: 'd', resources: { Bucket: { ...bucket(), DependsOn: ['Nowhere'] } } }),
    ).toThrow(/depends on Nowhere/);
  });

  it('accepts a DependsOn that resolves', () => {
    expect(() =>
      buildTemplate({ description: 'd', resources: { A: bucket('a'), B: { ...bucket('b'), DependsOn: ['A'] } } }),
    ).not.toThrow();
  });
});

describe('emitting', () => {
  const template = buildTemplate({
    description: 'd',
    resources: { Zebra: bucket('z'), Alpha: bucket('a') },
    outputs: { Name: { Description: 'n', Value: ref('Alpha') } },
  });

  it('is byte-identical across builds of the same stack', () => {
    expect(emitTemplate(template)).toBe(emitTemplate(template));
  });

  it('does not depend on the order keys were written in', () => {
    const reordered = buildTemplate({
      description: 'd',
      resources: { Alpha: bucket('a'), Zebra: bucket('z') },
      outputs: { Name: { Value: ref('Alpha'), Description: 'n' } },
    });
    expect(emitTemplate(reordered)).toBe(emitTemplate(template));
  });

  it('keeps array order, because an ordered list is meaningful', () => {
    expect(sortDeep(['c', 'a', 'b'])).toEqual(['c', 'a', 'b']);
    expect(sortDeep([{ b: 1, a: 2 }])).toEqual([{ a: 2, b: 1 }]);
  });

  it('leaves scalars alone', () => {
    expect(sortDeep(7)).toBe(7);
    expect(sortDeep(null)).toBeNull();
    expect(sortDeep('x')).toBe('x');
  });

  it('ends with a newline, so the file is a well-formed text file', () => {
    expect(emitTemplate(template).endsWith('}\n')).toBe(true);
  });

  it('parses back to the same structure', () => {
    expect(JSON.parse(emitTemplate(template))).toEqual(JSON.parse(JSON.stringify(sortDeep(template))));
  });
});

describe('finding resources by type', () => {
  it('returns them sorted, so a report reads the same way twice', () => {
    const template = buildTemplate({
      description: 'd',
      resources: { Zebra: bucket('z'), Alpha: bucket('a'), Key: { Type: 'AWS::KMS::Key', Properties: {} } },
    });
    expect(resourcesOfType(template, 'AWS::S3::Bucket').map(([id]) => id)).toEqual(['Alpha', 'Zebra']);
    expect(resourcesOfType(template, 'AWS::SQS::Queue')).toEqual([]);
  });
});
