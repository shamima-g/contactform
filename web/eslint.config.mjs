import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import testingLibrary from 'eslint-plugin-testing-library';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Node.js scripts (not part of Next.js build)
    'scripts/**',
  ]),
  // Testing Library rules for test files only
  {
    files: ['**/__tests__/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    plugins: {
      'testing-library': testingLibrary,
    },
    rules: {
      // Prefer semantic queries over getByTestId
      // https://testing-library.com/docs/queries/about/#priority
      'testing-library/prefer-screen-queries': 'warn',

      // Avoid using container for querying - encourages implementation detail testing
      'testing-library/no-container': 'warn',

      // Prefer userEvent over fireEvent for more realistic interactions
      'testing-library/prefer-user-event': 'warn',

      // Avoid querying by test ID when better queries are available
      // Note: This is 'warn' not 'error' because sometimes testId is necessary
      'testing-library/prefer-presence-queries': 'warn',

      // Ensure proper async handling
      'testing-library/await-async-queries': 'error',
      'testing-library/await-async-utils': 'error',
      'testing-library/no-await-sync-queries': 'error',

      // Avoid debugging code in tests
      'testing-library/no-debugging-utils': 'warn',

      // Prefer find* queries for async element appearance
      'testing-library/prefer-find-by': 'warn',
    },
  },
]);

export default eslintConfig;
