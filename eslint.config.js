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
    /**
     * G4 guard: nothing on the server may ever submit an employer's form.
     * See docs/07-form-automation.md. This rule is a release gate, not a style preference.
     *
     * It used to be one selector,
     *
     *     CallExpression[callee.property.name='click'][callee.object.name=/[Ss]ubmit/]
     *
     * and `callee.object.name` only exists when the receiver is a bare identifier. So it
     * caught `submitBtn.click()` and could not see `page.click('button[type=submit]')` —
     * the ordinary Playwright way to submit a form, and the first thing anyone adding "just
     * advance the wizard" would reach for. `npm run lint` passed on it.
     *
     * The rule that keeps this honest: the word "submit" can sit in the receiver, in a
     * selector string, in a locator chained ahead of the click, or nowhere at all (Enter
     * submits a single-input form; so does requestSubmit). A selector per one of those is a
     * gate with a hole in it, so all of them are here, and anything new goes in beside them.
     *
     * Scoped to the whole server rather than core/filling: the browser session is reachable
     * from a route handler, and the routes were never covered by any of the three gates.
     * apps/web is left out on purpose — a submit button in the interface is the user
     * pressing it, which is the point of G4.
     */
    files: ['apps/server/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...[
          // A click on something whose identifier names it: submitBtn.click().
          "CallExpression[callee.property.name='click'][callee.object.name=/[Ss]ubmit/]",
          // A click whose target names it anywhere in the call — page.click('[type=submit]'),
          // page.locator('#submit-application').click(), getByRole('button', {name:'Submit'}).
          "CallExpression[callee.property.name='click'] Literal[value=/submit/i]",
          "CallExpression[callee.property.name='click'] TemplateElement[value.raw=/submit/i]",
          // Submitting without a click at all.
          "CallExpression[callee.property.name='requestSubmit']",
          "CallExpression[callee.property.name='submit'][arguments.length=0]",
          "NewExpression[callee.name='SubmitEvent']",
          "NewExpression[callee.name='Event'] > Literal[value='submit']",
          "CallExpression[callee.property.name='dispatchEvent'] Literal[value='submit']",
          // Enter is the submit button of any single-input form.
          'CallExpression[callee.property.name=/^(press|down)$/] > Literal[value=/^Enter$/i]',
        ].map((selector) => ({
          selector,
          message:
            'The tool must never submit an application. The user does that themselves (G4, docs/07-form-automation.md).',
        })),
      ],
    },
  },
);
