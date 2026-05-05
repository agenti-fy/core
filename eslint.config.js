import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      // Config files are not part of any tsconfig project — skip them.
      'eslint.config.js',
      'vitest.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      // The codebase intentionally uses template literals on `unknown` errors
      // (`String(err)`, `${err}`) — disable the over-zealous restriction.
      '@typescript-eslint/restrict-template-expressions': 'off',
      // We rely on `as` casts for narrow JSON parsing boundaries that are
      // already validated by Zod; flagging them is noise.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // Fastify route handlers and test mocks are intentionally async even
      // when the body is sync, for signature consistency. The rule misfires.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Test files: relax rules that produce false positives for test mocks
    // and assertion helpers that pull `process.stdout.write` etc.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
