const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/', 'uploads/', 'backups/', 'public/attachement/',
      'e2e/node_modules/', 'e2e/playwright-report/', 'e2e/test-results/', 'e2e/.auth/',
    ],
  },
  js.configs.recommended,
  {
    // Node, CommonJS
    files: ['*.js', 'src/**/*.js', 'scripts/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: globals.node,
    },
  },
  {
    // Playwright specs: Node, plus browser globals inside page.evaluate() callbacks
    files: ['e2e/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    // Browser scripts (classic <script> tags, no modules)
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        io: 'readonly',
        Chat: 'readonly',
        tailwind: 'readonly',
      },
    },
  },
];
