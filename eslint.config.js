// @ts-check
import tseslint from 'typescript-eslint';

/** Import restrictions from docs/adr/0002-package-boundaries.md. */
const adapterImports = ['@blindsignal/storage-*', '@blindsignal/coordination-*'];
const noServer = {
  group: ['@blindsignal/server', '@blindsignal/server/*'],
  message: 'Nothing imports apps/server (ADR 0002).',
};

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'coverage/**'] },
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ['*.js', '*.ts'] } },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-restricted-imports': ['error', { patterns: [noServer] }],
    },
  },
  {
    files: ['packages/protocol/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            noServer,
            { group: ['node:*'], message: 'protocol is isomorphic: no node:* imports (ADR 0002).' },
            { group: ['@blindsignal/*'], message: 'protocol depends only on zod (ADR 0002).' },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/sdk/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            noServer,
            {
              group: [
                '@blindsignal/core',
                ...adapterImports,
                '@blindsignal/dev-issuer',
                'jose',
                'ws',
                'node:*',
              ],
              message: 'The SDK imports only protocol and web-standard globals (ADR 0002).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/dev-issuer/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@blindsignal/*'], message: 'dev-issuer depends only on jose (ADR 0002).' },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/core/src/**', 'adapters/**/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            noServer,
            {
              group: [...adapterImports, '@blindsignal/sdk', '@blindsignal/dev-issuer'],
              message: 'core and adapters depend only on core and protocol (ADR 0002).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/server/src/**'],
    ignores: ['apps/server/src/main.ts', '**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: adapterImports, message: 'Only src/main.ts imports adapters (ADR 0002).' },
            {
              group: ['@blindsignal/dev-issuer'],
              message: 'Server source never imports dev-issuer (ADR 0002).',
            },
          ],
        },
      ],
    },
  },
);
