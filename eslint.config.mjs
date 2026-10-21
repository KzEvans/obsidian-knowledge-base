import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import { boundaries } from './eslint.boundaries.mjs';

export default tseslint.config(
  { ignores: ['main.js', 'legacy/**', 'node_modules/**', 'tests/e2e/results/**'] },
  ...obsidianmd.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ['*.mjs', 'scripts/*.mjs'] }, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      // The UI is Chinese; the rule mis-cases product names such as Qwen-MT and API Key.
      'obsidianmd/ui/sentence-case': 'off',
      // Each module renders its own settings section; the declarative API cannot express that split.
      'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
    },
  },
  {
    // node:test's test() returns a promise the runner tracks itself.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      // Tests run in Node, where popout-window rules do not apply.
      'obsidianmd/no-global-this': 'off',
      'obsidianmd/prefer-window-timers': 'off',
      'obsidianmd/hardcoded-config-path': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs', '*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
    // Node build and repository scripts, not plugin code.
    rules: { ...tseslint.configs.disableTypeChecked.rules, 'no-console': 'off', 'obsidianmd/rule-custom-message': 'off', 'obsidianmd/hardcoded-config-path': 'off' },
  },
  ...boundaries,
);
