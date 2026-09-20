import { describeIdentityConformance } from '@genesis/testkit';
import { DevelopmentIdentityProvider } from '../src/development.js';

describeIdentityConformance({
  name: 'DevelopmentIdentityProvider',
  create: async () => ({
    provider: new DevelopmentIdentityProvider([
      { token: 'dev-token-abc', subject: 'dev-subject-1', displayName: 'Dev', groups: ['operators'] },
    ]),
    validToken: 'dev-token-abc',
    expectedSubject: 'dev-subject-1',
  }),
});
