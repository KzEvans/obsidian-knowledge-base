import { registerHooks } from 'node:module';

// Plugin code uses `window.*` timers for popout-window compatibility; Node has no window.
const host = globalThis as unknown as { window?: unknown };
host.window ??= globalThis;

// The `obsidian` package ships types only, so tests load a small runtime stub.
const stub = new URL('./stubs/obsidian.ts', import.meta.url).href;
registerHooks({
  resolve: (specifier, context, nextResolve) =>
    specifier === 'obsidian' ? { url: stub, shortCircuit: true } : nextResolve(specifier, context),
});
