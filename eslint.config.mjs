// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/target/**',
      // Generated/tooling output, never source: Vercel build artifacts
      // (minified bundles) and Claude Code git worktrees (full repo copies that
      // would otherwise be linted N times over). Both are gitignored.
      '**/.vercel/**',
      '**/.claude/**',
      '.workflow-*.js',
      // Standalone Node demo/repro scripts (never imported by the app/tests):
      // they run under Node globals (console/process) the browser config doesn't
      // declare, so lint them as the throwaway scripts they are.
      '**/*.example.mjs',
      '**/*.bug-repro.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Allow intentionally-unused identifiers via a leading underscore (e.g. an
  // interface-required arg not yet consumed: `(_side: 'yes' | 'no') => …`).
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  // React-specific rules for all React apps (apps/web + apps/bridge).
  {
    files: ['apps/web/**/*.{ts,tsx}', 'apps/bridge/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  // Secret-hygiene guard (docs/bridge-sdk-refactor.md §3 "Secret hygiene").
  //
  // bridge-core's core orchestrators (moveIntoPool/fundAccountFromPool/cashOut/
  // returnToPool + the aa/ paymaster path) take the raw wallet signature and
  // derive private keys in-memory; neither may ever reach console.* or
  // localStorage/sessionStorage. This is a CI-enforced invariant, not a
  // review-only one, because several of those orchestrators land concurrently
  // on the same files. Exclude test files: `secretSinks.ts`'s own test
  // deliberately logs a fixture secret to prove the spy catches it.
  {
    files: ['packages/bridge-core/src/core/**/*.{ts,tsx}'],
    ignores: ['packages/bridge-core/src/core/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='console'] :matches(Identifier[name=/signature/i], Identifier[name=/privateKey/i], Identifier[name=/privKey/i], Identifier[name=/secret/i], MemberExpression[property.name=/signature/i], MemberExpression[property.name=/privateKey/i], MemberExpression[property.name=/privKey/i], MemberExpression[property.name=/secret/i])",
          message:
            'Secret hygiene: do not pass a signature/privateKey/privKey/secret-named value to console.* (docs/bridge-sdk-refactor.md §3).',
        },
        {
          selector:
            "CallExpression[callee.property.name='setItem'][callee.object.name=/^(localStorage|sessionStorage)$/] :matches(Identifier[name=/signature/i], Identifier[name=/privateKey/i], Identifier[name=/privKey/i], Identifier[name=/secret/i], MemberExpression[property.name=/signature/i], MemberExpression[property.name=/privateKey/i], MemberExpression[property.name=/privKey/i], MemberExpression[property.name=/secret/i])",
          message:
            'Secret hygiene: do not persist a signature/privateKey/privKey/secret-named value to localStorage/sessionStorage (docs/bridge-sdk-refactor.md §3). Only the viewing key may be persisted.',
        },
      ],
    },
  },
);
