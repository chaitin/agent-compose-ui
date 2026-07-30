import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./ScriptCreateModal.svelte', import.meta.url), 'utf8');
const resourcePanelSource = readFileSync(new URL('../ResourcePanel.svelte', import.meta.url), 'utf8');
const appStyles = readFileSync(new URL('../../app.css', import.meta.url), 'utf8');

test('keeps the creation dialog above Monaco editor overlays', () => {
  assert.match(source, /\.modal-backdrop\s*\{[^}]*z-index:\s*(?:[1-9]\d{2,})/s);
});

test('uses the shared resource-panel modal boundary', () => {
  assert.match(source, /class="[^"]*resource-modal-backdrop[^"]*"/);
  assert.match(source, /class="[^"]*resource-modal-card[^"]*"/);
  assert.match(resourcePanelSource, /\.panel-body\s*\{[^}]*position:\s*relative/s);
});

test('uses a compact command layout without card scrolling', () => {
  assert.match(source, /class="[^"]*command-modal[^"]*"/);
  assert.match(source, /class="[^"]*command-fields[^"]*"/);
  assert.match(source, /class="[^"]*command-footer[^"]*"/);
  const cardRule = appStyles.match(/\.resource-modal-card,[\s\S]*?\n\}/)?.[0] ?? '';
  assert.doesNotMatch(cardRule, /max-height|overflow:\s*auto/);
});
