import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./ScriptCreateModal.svelte', import.meta.url), 'utf8');

test('keeps the creation dialog above Monaco editor overlays', () => {
  assert.match(source, /\.modal-backdrop\s*\{[^}]*z-index:\s*(?:[1-9]\d{2,})/s);
});
