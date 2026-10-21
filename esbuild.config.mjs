import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';

const production = !process.argv.includes('--dev');

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

// Each module owns its stylesheet, so parallel work never edits one shared file.
const STYLES = ['src/core/styles.css', 'src/library/styles.css', 'src/agent/styles.css', 'src/reader/styles.css', 'src/reader/selection/styles.css'];
writeFileSync('styles.css', STYLES.map(file => `/* ${file} */\n${readFileSync(file, 'utf8').trim()}\n`).join('\n'));
