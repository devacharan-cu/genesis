import { describeSecretResolverConformance } from '@genesis/testkit';
import { InMemorySecretResolver } from '../src/in-memory.js';
import { SecretRef } from '../src/port.js';

describeSecretResolverConformance({
  name: 'InMemorySecretResolver',
  create: async () => ({
    resolver: new InMemorySecretResolver({
      'LOCAL:plain-secret': 'the-plain-value',
      'LOCAL:structured-secret': JSON.stringify({ password: 'the-keyed-value', username: 'svc' }),
    }),
    plain: SecretRef.parse({ provider: 'LOCAL', name: 'plain-secret' }),
    plainValue: 'the-plain-value',
    keyed: SecretRef.parse({ provider: 'LOCAL', name: 'structured-secret', key: 'password' }),
    keyedValue: 'the-keyed-value',
    absent: SecretRef.parse({ provider: 'LOCAL', name: 'no-such-secret' }),
  }),
});
