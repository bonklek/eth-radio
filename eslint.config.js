import js from '@eslint/js'
import globals from 'globals'

const sharedRules = {
  'no-unused-vars': ['error', {
    argsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
  }],
}

export default [
  {
    ignores: [
      '.private/**',
      'build/**',
      'coverage/**',
      'dist/**',
      'node_modules/**',
      'work/**',
      '.venv*/**',
    ],
  },
  js.configs.recommended,
  {
    files: [
      '*.js',
      'packages/**/*.{js,mjs}',
      'scripts/**/*.{js,mjs}',
      'apps/publisher-console/**/*.{js,mjs}',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: sharedRules,
  },
  {
    files: [
      'public/**/*.js',
      'apps/publisher-console/public/**/*.js',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
    },
    rules: sharedRules,
  },
]
