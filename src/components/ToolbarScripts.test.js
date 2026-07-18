import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./Toolbar.svelte', import.meta.url), 'utf8');

test('toolbar does not expose the script-panel shortcut', () => {
  expect(source).not.toContain('countScriptFiles(scriptWorkspace.tree)');
  expect(source).not.toContain('scriptWorkspace.panelOpen = !scriptWorkspace.panelOpen');
  expect(source).not.toContain('btn-script');
  expect(source).not.toContain('script-dirty-dot');
});
