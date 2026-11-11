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
