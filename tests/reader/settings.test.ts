import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { importLegacySettings, readSettings } from '../../src/reader/settings';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

test('settings fall back to defaults and keep only sha-keyed positions', () => {
  assert.deepEqual(readSettings(undefined), { fontSize: 18, lineHeight: 1.5, scrollDiagnostics: false, positions: {}, legacyImported: false });
  const settings = readSettings({ fontSize: 40, lineHeight: 1, scrollDiagnostics: true, positions: { [SHA_A]: 3, 'paper.pdf': 4, [SHA_B]: -1 }, legacyImported: true });
  assert.deepEqual(settings, { fontSize: 24, lineHeight: 1.3, scrollDiagnostics: true, positions: { [SHA_A]: 3 }, legacyImported: true });
});

test('the old plugin data imports typography and re-keys positions by sha through the path index', async () => {
  const settings = readSettings({ positions: { [SHA_B]: 9 } });
  const index: Record<string, string> = { 'papers/a.pdf': SHA_A };
  const hashed: Record<string, string> = { 'papers/b.pdf': SHA_B };
  const asked: string[] = [];
  const result = await importLegacySettings(settings, {
    fontSize: 20, lineHeight: 1.6, scrollDiagnostics: true,
    positions: { 'papers/a.pdf': 7, 'papers/b.pdf': 2, 'papers/gone.pdf': 5, 'papers/bad.pdf': 'x' },
  }, index, async path => { asked.push(path); if (path === 'papers/gone.pdf') throw new Error('ENOENT'); return hashed[path]; });
  assert.deepEqual(result, { positions: 1 });
  assert.equal(settings.fontSize, 20);
  assert.equal(settings.lineHeight, 1.6);
  assert.equal(settings.scrollDiagnostics, true);
  // A position already recorded by sha wins over the imported one.
  assert.deepEqual(settings.positions, { [SHA_A]: 7, [SHA_B]: 9 });
  assert.equal(settings.legacyImported, true);
  // Only paths missing from the index are hashed.
  assert.deepEqual(asked, ['papers/b.pdf', 'papers/gone.pdf']);
});

test('missing or malformed old data still marks the import done', async () => {
  const settings = readSettings({});
  assert.deepEqual(await importLegacySettings(settings, null, {}, async () => undefined), { positions: 0 });
  assert.equal(settings.fontSize, 18);
  assert.equal(settings.legacyImported, true);
});
