import eslint from '@eslint/js';
import eslintImport from 'eslint-plugin-import';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/coverage',
      '**/.vscode',
      '**/.github',
      '**/CHANGELOG.md',
    ],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.stylistic,
  eslintPluginPrettierRecommended,
  eslintImport.flatConfigs.recommended,

  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  {
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          ignoreRestSiblings: false,
          vars: 'all',
        },
      ],
      // TODO: This rule is disabled because it is not working properly. Maybe
      // it will work after we switch to ESM? (#399)
      'import/no-unresolved': 'off',
      'import/order': [
        'error',
        {
          alphabetize: { caseInsensitive: true, order: 'asc' },
          groups: [
            'builtin',
            'external',
            ['internal', 'parent', 'sibling', 'index'],
          ],
          'newlines-between': 'always',
        },
      ],
      'max-params': ['error', 5],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-param-reassign': 'error',
      'no-unused-vars': 'off',
      'no-var': 'error',
      'prefer-arrow-callback': ['error', { allowNamedFunctions: true }],
      'sort-keys': 'error',
    },
  },
];
