import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Lint rules that enforce ADR-0002. These are errors, not warnings: a warning
 * nobody fixes is a rule nobody has.
 *
 * Type-aware rules are deliberately not enabled yet — they need the project
 * service and are slow enough to discourage running lint locally. The rules
 * below are all syntactic and cost nothing.
 */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The console's components are TypeScript too, and are held to the same
    // rules: an app that is not linted is where `any` comes back.
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // ADR-0002 rule 1: no `any`. Use `unknown` plus narrowing.
      '@typescript-eslint/no-explicit-any': 'error',

      // The blanket-ignore directive is banned outright; the expect-error one
      // needs a stated reason. (Spelling either out here would trip this very
      // rule, which is a decent sign it works.)
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-expect-error': 'allow-with-description',
          minimumDescriptionLength: 10,
        },
      ],

      // ADR-0002 rule 5 support: a non-serialisable wrapper is useless if it is
      // casually asserted away.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off', // needs type info; revisit
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['error', 'warn'] }],
    },
  },
  {
    // Tools are Node scripts: they print, and they are plain JS.
    // `no-undef` needs to be told about Node's globals here; inside .ts files
    // TypeScript already catches undefined identifiers, which is why the rule
    // is off there.
    files: ['tools/**/*.mjs', 'tools/**/*.js'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
      },
    },
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: { 'no-undef': 'off' },
  },
  {
    // The browser console is how a lost graphics context reports itself, and
    // the API logs failures it must never swallow.
    files: ['apps/**/*.ts', 'apps/**/*.tsx'],
    rules: { 'no-console': ['error', { allow: ['error', 'warn'] }] },
  },
  {
    // Conformance suites and tests legitimately reach into internals.
    files: ['**/test/**/*.ts', 'packages/testkit/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
