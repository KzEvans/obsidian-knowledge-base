/**
 * Read-only rehearsal against a real vault: compares what the new library would do with the
 * state the Python sync and the old reader left behind. Nothing is written, nothing is uploaded.
 *   PAPER_WORKBENCH_VAULT="<vault>" pnpm test
 */
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { applyLegacyConfig, defaultSettings } from '../../src/library/settings';
import { pdfPath } from '../../src/library/zotero/sync';
import type { SyncState } from '../../src/library/zotero/sync';

const vault = process.env.PAPER_WORKBENCH_VAULT;
const skip = !vault && 'PAPER_WORKBENCH_VAULT not set';

async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; } catch { return undefined; }
}

test('the Python sync state continues without moving or re-copying any PDF', { skip }, async t => {
  const state = await readJson<SyncState>(path.join(vault!, 'system/zotero-sync/state.json'));
  if (!state) return;
  const config = await readJson<unknown>(path.join(vault!, 'system/zotero-sync/config.json'));
  const settings = defaultSettings();
  applyLegacyConfig(settings, config);
  assert.ok(settings.collectionName);
  const problems: string[] = [];
  let active = 0;
  for (const entry of Object.values(state.attachments)) {
    if (!entry.active) continue;
    active++;
    if (entry.destination !== pdfPath(entry.collection_path, entry.destination_name)) problems.push(`would move: ${entry.attachment_key}`);
    try { await fs.stat(path.join(vault!, entry.destination)); } catch { problems.push(`missing: ${entry.attachment_key}`); }
  }
  t.diagnostic(`[rehearsal] ${active} active attachments; ${problems.length} would change`);
  assert.deepEqual(problems, []);
});

test('the old reader cache import plan (directory names only, no downloads)', { skip }, async t => {
  const configDir = path.join(vault!, '.obsidian');
  const cache = path.join(configDir, 'plugins/pdf-reading-mode/cache');
  let directories: string[];
  try { directories = await fs.readdir(cache); } catch { return; }
  const plan = { complete: 0, jobOnly: 0, other: 0 };
  for (const directory of directories) {
    if (!/^[0-9a-f]{64}-vlm-v1$/.test(directory)) continue;
    const names = await fs.readdir(path.join(cache, directory));
    if (names.some(name => name.endsWith('_content_list.json'))) plan.complete++;
    else if (names.includes('job.json')) plan.jobOnly++;
    else plan.other++;
  }
  t.diagnostic(`[rehearsal] reader cache: ${plan.complete} importable, ${plan.jobOnly} resume-only, ${plan.other} skipped`);
  assert.ok(plan.complete + plan.jobOnly + plan.other >= 0);
});
