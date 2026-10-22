import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRunner } from '../core/services';
import { collect, createAdapter } from './cli/adapter';
import type { AdapterName, AgentAdapter, AgentRequest } from './cli/adapter';
import { claudeDialect } from './cli/claude';
import { codexDialect } from './cli/codex';
import type { AgentSettings } from './settings';

export interface AgentChoice extends Pick<AgentRequest, 'model' | 'reasoningEffort'> { adapter: AgentAdapter }

/** The adapter, model and reasoning chosen in settings, read on every call so changes apply at once. */
export function currentAgent(settings: AgentSettings, name: AdapterName = settings.adapter): AgentChoice {
  const codex = name === 'codex';
  const adapter = createAdapter(codex ? codexDialect : claudeDialect, {
    cliPath: () => codex ? settings.codexPath : settings.claudePath,
    proxyUrl: () => settings.proxyUrl,
  });
  const model = (codex ? settings.codexModel : settings.claudeModel) || undefined;
  return { adapter, model, reasoningEffort: codex ? settings.codexReasoningEffort || undefined : undefined };
}

/** `context.services.agent`: one read-only, unsaved turn in an empty directory (impact-factor lookup). */
export function createAgentRunner(agent: () => AgentChoice): AgentRunner {
  return {
    async runReadOnly(prompt, options) {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-workbench-query-'));
      try {
        const { adapter, model, reasoningEffort } = agent();
        const { text } = await collect(adapter.run({
          prompt, cwd, model, reasoningEffort, mode: 'read-only', ephemeral: true,
          timeoutMs: options.timeoutMs, webSearch: options.allowWebSearch, outputSchema: options.outputSchema,
        }, options.signal ?? new AbortController().signal));
        return text;
      } finally {
        await fs.rm(cwd, { recursive: true, force: true });
      }
    },
  };
}
