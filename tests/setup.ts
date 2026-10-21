import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';

// Plugin code uses `window.*` timers for popout-window compatibility; Node has no window.
const host = globalThis as unknown as { window?: unknown };
host.window ??= globalThis;

// The `obsidian` package ships types only, so tests load a small runtime stub.
// Markdown imports load as text, matching esbuild's text loader.
const stub = new URL('./stubs/obsidian.ts', import.meta.url).href;
registerHooks({
  resolve: (specifier, context, nextResolve) =>
    specifier === 'obsidian' ? { url: stub, shortCircuit: true } : nextResolve(specifier, context),
  load: (url, context, nextLoad) => url.endsWith('.md')
    ? { format: 'module', source: `export default ${JSON.stringify(readFileSync(fileURLToPath(url), 'utf8'))};`, shortCircuit: true }
    : nextLoad(url, context),
});
