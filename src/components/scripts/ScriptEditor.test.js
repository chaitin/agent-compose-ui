import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./ScriptEditor.svelte', import.meta.url), 'utf8');

test('places the new-script action at the top right of the editor', () => {
  assert.match(source, /onCreateFile:\s*\(\) => void/);
  assert.match(source, /class="new-script"[^>]*onclick=\{onCreateFile\}[^>]*>\+ 新建脚本<\/button>/s);
  assert.match(source, /\.new-script\s*\{[^}]*margin-left:\s*auto/s);
});
