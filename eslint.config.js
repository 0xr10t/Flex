import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // §7.3: randomness only from node:crypto randomBytes.
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use node:crypto randomBytes (spec §7.3).' },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.object.name='console']", message: 'Use the allowlist logger (spec §18).' },
      ],
    },
  },
  {
    files: ['scripts/**', 'test/**'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
