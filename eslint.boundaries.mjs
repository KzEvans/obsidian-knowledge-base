/**
 * Module boundaries (docs/architecture.md §2), enforced by lint and tested in
 * tests/boundaries.test.ts. Patterns match import specifiers.
 */
const anyDepth = name => [`**/${name}`, `**/${name}/**`];
const boundary = (files, banned, message) => ({
  files,
  rules: {
    'no-restricted-imports': ['error', { patterns: [{ group: banned.flatMap(anyDepth), message }] }],
  },
});

export const boundaries = [
  boundary(['src/core/**/*.ts'], ['library', 'agent', 'reader'], 'core 不能依赖任何模块。'),
  boundary(['src/library/**/*.ts'], ['agent', 'reader'], 'library 只能依赖 core。'),
  boundary(['src/agent/**/*.ts'], ['library', 'reader'], 'agent 只能依赖 core。'),
  boundary(['src/reader/*.ts', 'src/reader/!(selection)/**/*.ts'], ['library', 'agent', 'selection'], 'reader 只能依赖 core，与 selection 通过事件和 DOM 约定配合。'),
  {
    files: ['src/reader/selection/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['library', 'agent'].flatMap(anyDepth), message: 'selection 只能依赖 core。' },
          { regex: '^\\.\\.(?:/|$)(?!\\.\\./core(?:/|$))', message: 'selection 只能引用 ../../core，不能引用 reader 的代码。' },
        ],
      }],
    },
  },
  // Only library receives the store writer.
  {
    files: ['src/reader/**/*.ts', 'src/agent/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', { selector: "Identifier[name='StoreWriter']", message: '只有流水线可以写解析存储。' }],
    },
  },
];
