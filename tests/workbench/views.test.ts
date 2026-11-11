import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CollectionTreeView, LibraryTableView } from '../../src/workbench/views';
import type { Workbench } from '../../src/workbench/views';

// Class fields use define semantics (ES2022), so a field named like one of ItemView's internal
// header elements resets it to undefined after super() and Obsidian cannot build the view header.
test('views keep the header elements ItemView sets up', () => {
  const workbench = {} as Workbench;
  for (const view of [new LibraryTableView({} as never, workbench), new CollectionTreeView({} as never, workbench)]) {
    const fields = view as unknown as Record<string, unknown>;
    for (const name of ['containerEl', 'contentEl', 'headerEl', 'titleContainerEl', 'titleEl', 'titleParentEl', 'actionsEl']) {
      assert.ok(fields[name], `${view.constructor.name}.${name} was overwritten`);
    }
  }
});

test('switching collection refreshes the view header title', async () => {
  const view = new LibraryTableView({} as never, {} as Workbench);
  await view.setState({ collection: 'DEA' }, { history: false });
  assert.equal(view.getDisplayText(), 'DEA');
  assert.equal((view as unknown as { titleEl: { text: string } }).titleEl.text, 'DEA');
});

test('table state round-trips collection, search, note filter and sort', async () => {
  const view = new LibraryTableView({} as never, {} as Workbench);
  const saved = { collection: 'DEA', query: 'elastomer', noteState: 'draft', sort: { column: 'impactFactor', descending: true } };
  await view.setState(saved, { history: false });
  assert.deepEqual(view.getState(), saved);
  await view.setState({ noteState: 'bogus', sort: { column: 'nope' } }, { history: false });
  assert.deepEqual(view.getState(), { collection: null, query: '', noteState: 'all', sort: { column: 'impactFactor', descending: true } });
});
