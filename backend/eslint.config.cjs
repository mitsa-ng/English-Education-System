// ESLint 9 flat config — typescript-eslint（NestJS 慣例）
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', '*.js', '*.mjs', '*.cjs'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { project: false },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
