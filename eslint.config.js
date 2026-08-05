import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      'data/**',
      'logs/**',
      'apps/server/drizzle/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    /**
     * `formMap.ts` needs DOM types for the scanner it ships into the browser, and a
     * `/// <reference lib="dom" />` makes those globals visible to the WHOLE server
     * program — so TypeScript would no longer object to `document` in, say, a route
     * handler, and the mistake would surface only as a runtime crash.
     *
     * This puts the guard back where the type system stopped providing one. The scanner
     * itself is exempted below, since running in the page is its entire job.
     */
    files: ['apps/server/src/**/*.ts'],
    ignores: ['apps/server/src/core/filling/formMap.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['document', 'window', 'navigator', 'localStorage', 'HTMLElement', 'CSS'].map(
          (name) => ({
            name,
            message: `${name} does not exist on the server. Browser-side code belongs in a function passed to page.evaluate().`,
          }),
        ),
      ],
    },
  },
  {
    // G4 guard: nothing in the form-filling module may ever click a submit control.
    // See docs/07-form-automation.md. This rule is a release gate, not a style preference.
    files: ['apps/server/src/core/filling/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='click'][callee.object.name=/[Ss]ubmit/]",
          message:
            'The tool must never click a submit control. The user submits their own application (G4, docs/07-form-automation.md).',
        },
      ],
    },
  },
);
