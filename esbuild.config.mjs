import { build } from 'esbuild';
import { builtinModules } from 'node:module';

const production = process.argv.includes('--production') || !process.argv.includes('--dev');

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', ...builtinModules, ...builtinModules.map(name => `node:${name}`)],
  platform: 'node',
  format: 'cjs',
  target: 'es2022',
  outfile: 'main.js',
  minify: production,
  sourcemap: production ? false : 'inline',
  // skills/paper-note/*.md are bundled as text and passed to the CLIs.
  loader: { '.md': 'text' },
  logLevel: 'info',
});
