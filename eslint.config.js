import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'
import { readFileSync } from 'node:fs'

// What a checkout keeps only for itself (.git/info/exclude) isn't the project's code either.
const localExcludes = (() => {
  try {
    return readFileSync('.git/info/exclude', 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
  } catch {
    return []
  }
})()

export default defineConfig([
  globalIgnores([
    'dist',
    'src-tauri/target',
    'src-tauri/target-e2e',
    'plugins/marketplaces',
    ...localExcludes,
    // The video runtime is a separate Remotion project the app never bundles; it has its own
    // typecheck, and the app's fast-refresh and React rules don't apply to it.
    'src-tauri/resources/video-template',
    // Video projects the app creates when this repo is the open workspace.
    'videos',
    // Plugins the app ships as they come from their marketplace (Anthropic's theme-examples).
    'resources/plugins',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-irregular-whitespace': ['error', { skipRegExps: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // The wrapper turns a coded backend error into a BackendError (src/lib/ipc.ts).
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@tauri-apps/api/core',
              importNames: ['invoke'],
              message: 'Import invoke from "@/lib/ipc".',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/lib/ipc.ts', '**/__tests__/**', '**/*.test.{ts,tsx}'],
    rules: { 'no-restricted-imports': 'off' },
  },
  // Playwright fixtures: `use` is Playwright's, not React's, and `{}` is how a fixture says it
  // depends on no other fixture.
  {
    files: ['e2e/**', 'playwright.config.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: { 'react-hooks/rules-of-hooks': 'off', 'no-empty-pattern': 'off' },
  },
])
