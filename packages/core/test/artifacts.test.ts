/**
 * The artifact door, and the purpose table behind it.
 *
 * The door is where a produced file becomes a record and no more than a record,
 * so most of this is refusal: a path that escapes, a path that is not one, a
 * file too large, a set that writes the same path twice.
 */

import { ArtifactId } from '@genesis/core-types';
import {
  ARTIFACT_OUTPUT_SCHEMA,
  ArtifactOutput,
  artifactIdOf,
  artifactPayload,
  checkArtifactPath,
  checkArtifacts,
  contractFor,
  DECLARED_PURPOSES,
  DEFAULT_ARTIFACT_LIMITS,
  DIAGNOSIS_OUTPUT_SCHEMA,
  DiagnosisOutput,
  OUTCOME_KINDS,
  PURPOSE_CONTRACTS,
} from '@genesis/core';
import { sha256Hex } from '@genesis/ledger';
import { describe, expect, it } from 'vitest';

const LIMITS = DEFAULT_ARTIFACT_LIMITS;

describe('checkArtifactPath accepts', () => {
  it('a plain relative path', () => {
    expect(checkArtifactPath('src/add.ts')).toEqual({ ok: true, path: 'src/add.ts' });
  });

  it('a backslash path, normalised', () => {
    expect(checkArtifactPath('src\\deep\\add.ts')).toEqual({ ok: true, path: 'src/deep/add.ts' });
  });

  it('a path with surrounding space', () => {
    expect(checkArtifactPath('  src/add.ts  ')).toEqual({ ok: true, path: 'src/add.ts' });
  });
});

describe('checkArtifactPath refuses', () => {
  const refused = (raw: string): string => {
    const checked = checkArtifactPath(raw);
    if (checked.ok) throw new Error(`expected ${raw} to be refused`);
    return checked.reason;
  };

  it('an empty path', () => {
    expect(refused('')).toContain('empty');
    expect(refused('   ')).toContain('empty');
  });

  it('an absolute path', () => {
    expect(refused('/etc/passwd')).toContain('absolute');
  });

  it('a drive letter', () => {
    expect(refused('C:/Windows/system.ini')).toContain('drive');
    expect(refused('C:\\Windows\\system.ini')).toContain('drive');
  });

  it('a directory', () => {
    expect(refused('src/')).toContain('directory');
  });

  it('a traversal, rather than rewriting it', () => {
    // The sandbox adapter was caught rewriting one of these once. Refusing is
    // the only way that cannot be fooled.
    expect(refused('../escape.ts')).toContain('..');
    expect(refused('src/../../escape.ts')).toContain('..');
    expect(refused('a/./b.ts')).toContain('.');
  });

  it('a path through a reserved directory', () => {
    expect(refused('.git/config')).toContain('.git');
    expect(refused('node_modules/evil/index.js')).toContain('node_modules');
  });

  it('an empty segment', () => {
    expect(refused('src//add.ts')).toContain('empty path segment');
  });

  it('a null byte', () => {
    expect(refused('src/add\u0000.ts')).toContain('null byte');
  });
});

describe('artifact identity', () => {
  it('is the same for the same bytes at the same path', () => {
    const hash = sha256Hex('export const x = 1;');
    expect(artifactIdOf('src/x.ts', hash)).toBe(artifactIdOf('src/x.ts', hash));
  });

  it('differs when the bytes differ, so a new version is a new artifact', () => {
    const a = artifactIdOf('src/x.ts', sha256Hex('export const x = 1;'));
    const b = artifactIdOf('src/x.ts', sha256Hex('export const x = 2;'));
    expect(a).not.toBe(b);
  });

  it('differs when the path differs', () => {
    const hash = sha256Hex('export const x = 1;');
    expect(artifactIdOf('src/x.ts', hash)).not.toBe(artifactIdOf('src/y.ts', hash));
  });

  it('is a well-formed artifact id', () => {
    expect(ArtifactId.safeParse(artifactIdOf('src/x.ts', sha256Hex('x'))).success).toBe(true);
  });
});

describe('checkArtifacts accepts', () => {
  it('a set of well-formed artifacts, hashing each', () => {
    const checked = checkArtifacts(
      { artifacts: [{ path: 'src/add.ts', contents: 'export const add = 1;' }] },
      LIMITS,
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const [only] = checked.artifacts;
    expect(only?.path).toBe('src/add.ts');
    expect(only?.contentHash).toBe(sha256Hex('export const add = 1;'));
    expect(only?.bytes).toBe(Buffer.byteLength('export const add = 1;', 'utf8'));
    expect(only?.language).toBe('typescript');
  });

  it('an empty set, which is a real answer', () => {
    const checked = checkArtifacts({ artifacts: [], limitations: ['could not infer the schema'] }, LIMITS);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.artifacts).toEqual([]);
    expect(checked.limitations).toEqual(['could not infer the schema']);
  });

  it('a stated language', () => {
    const checked = checkArtifacts({ artifacts: [{ path: 'a.py', contents: 'x = 1', language: 'python' }] }, LIMITS);
    expect(checked.ok && checked.artifacts[0]?.language).toBe('python');
  });
});

describe('checkArtifacts refuses', () => {
  const refused = (output: unknown, limits = LIMITS): string => {
    const checked = checkArtifacts(output, limits);
    if (checked.ok) throw new Error('expected a refusal');
    return checked.reason;
  };

  it('output that is not a set of artifacts', () => {
    expect(refused(null)).toContain('not a set of artifacts');
    expect(refused({ files: [] })).toContain('not a set of artifacts');
    expect(refused({ artifacts: [{ path: 'a.ts' }] })).toContain('not a set of artifacts');
  });

  it('more artifacts than the limit, naming both numbers', () => {
    const artifacts = Array.from({ length: 4 }, (_, i) => ({ path: `src/a${i}.ts`, contents: 'x' }));
    expect(refused({ artifacts }, { maxArtifacts: 3, maxBytes: 1000 })).toContain('4 artifacts exceeds the limit of 3');
  });

  it('an artifact whose path escapes, naming which one', () => {
    expect(refused({ artifacts: [{ path: 'ok.ts', contents: 'x' }, { path: '../out.ts', contents: 'y' }] })).toContain(
      'artifact 1',
    );
  });

  it('the same path written twice', () => {
    expect(
      refused({ artifacts: [{ path: 'a.ts', contents: 'x' }, { path: 'a.ts', contents: 'y' }] }),
    ).toContain('written twice');
  });

  it('a path normalising to one already written', () => {
    expect(
      refused({ artifacts: [{ path: 'a/b.ts', contents: 'x' }, { path: 'a\\b.ts', contents: 'y' }] }),
    ).toContain('written twice');
  });

  it('an artifact over the byte ceiling', () => {
    const reason = refused({ artifacts: [{ path: 'big.ts', contents: 'x'.repeat(200) }] }, { maxArtifacts: 5, maxBytes: 100 });
    expect(reason).toContain('200 bytes');
    expect(reason).toContain('limit of 100');
  });

  it('the whole set when one is bad: a half-landed build is unreasonable about', () => {
    const checked = checkArtifacts(
      { artifacts: [{ path: 'good.ts', contents: 'x' }, { path: '/bad.ts', contents: 'y' }] },
      LIMITS,
    );
    expect(checked.ok).toBe(false);
  });
});

describe('the recorded payload', () => {
  it('states GENERATED, so a reader of one event needs no rule', () => {
    const checked = checkArtifacts({ artifacts: [{ path: 'a.ts', contents: 'x' }] }, LIMITS);
    if (!checked.ok) throw new Error('expected artifacts');
    const payload = artifactPayload(checked.artifacts[0] as never, 'rsn_1') as Record<string, unknown>;
    expect(payload['verificationState']).toBe('GENERATED');
    expect(payload['callId']).toBe('rsn_1');
    expect(payload['contents']).toBe('x');
  });

  it('carries the contents, because a replay needs them', () => {
    const checked = checkArtifacts({ artifacts: [{ path: 'a.ts', contents: 'export const a = 1;' }] }, LIMITS);
    if (!checked.ok) throw new Error('expected artifacts');
    const payload = artifactPayload(checked.artifacts[0] as never, null) as Record<string, unknown>;
    expect(payload['contents']).toBe('export const a = 1;');
    expect(payload['callId']).toBeNull();
  });
});

describe('the purpose table', () => {
  it('has a contract for every canonical purpose', () => {
    expect(Object.keys(PURPOSE_CONTRACTS).sort()).toEqual([...DECLARED_PURPOSES].sort());
  });

  it('gives every purpose all three parts, so none is a runtime gap', () => {
    for (const purpose of DECLARED_PURPOSES) {
      const contract = contractFor(purpose);
      expect(contract.system.length, purpose).toBeGreaterThan(80);
      expect(Object.keys(contract.outputSchema).length, purpose).toBeGreaterThan(0);
      expect(OUTCOME_KINDS, purpose).toContain(contract.outcome);
    }
  });

  it('gives each purpose its own prompt: two purposes asking the same thing would share one', () => {
    const prompts = DECLARED_PURPOSES.map((p) => contractFor(p).system);
    expect(new Set(prompts).size).toBe(prompts.length);
  });

  it('tells every purpose it cannot decide what is true', () => {
    for (const purpose of DECLARED_PURPOSES) {
      const system = contractFor(purpose).system.toLowerCase();
      const disclaims =
        system.includes('do not decide what is true') ||
        system.includes('you do not test them') ||
        system.includes('not as a finding of fact');
      expect(disclaims, purpose).toBe(true);
    }
  });

  it('never names a model, a provider or a sampling parameter', () => {
    for (const purpose of DECLARED_PURPOSES) {
      const system = contractFor(purpose).system.toLowerCase();
      for (const banned of ['claude', 'gpt', 'bedrock', 'temperature', 'top_p', 'anthropic', 'openai']) {
        expect(system, `${purpose} names ${banned}`).not.toContain(banned);
      }
    }
  });
});

describe('the non-cognitive output schemas', () => {
  it('accept what the schema asks for', () => {
    expect(ArtifactOutput.safeParse({ artifacts: [{ path: 'a.ts', contents: 'x' }] }).success).toBe(true);
    expect(
      DiagnosisOutput.safeParse({ rootCause: 'off by one', targetArtifacts: ['art_1'], approach: 'fix the bound' })
        .success,
    ).toBe(true);
  });

  it('refuse a field nobody declared', () => {
    expect(ArtifactOutput.safeParse({ artifacts: [], verified: true }).success).toBe(false);
    expect(
      DiagnosisOutput.safeParse({ rootCause: 'x', targetArtifacts: ['a'], approach: 'y', fixed: true }).success,
    ).toBe(false);
  });

  it('refuse a diagnosis that implicates nothing', () => {
    expect(DiagnosisOutput.safeParse({ rootCause: 'x', targetArtifacts: [], approach: 'y' }).success).toBe(false);
  });

  it('describe the same shapes the model is asked for', () => {
    expect(ARTIFACT_OUTPUT_SCHEMA['required']).toEqual(['artifacts']);
    expect(DIAGNOSIS_OUTPUT_SCHEMA['required']).toEqual(['rootCause', 'targetArtifacts', 'approach']);
  });

  it('forbid extra properties in the schema the model is given', () => {
    expect(ARTIFACT_OUTPUT_SCHEMA['additionalProperties']).toBe(false);
    expect(DIAGNOSIS_OUTPUT_SCHEMA['additionalProperties']).toBe(false);
  });
});
