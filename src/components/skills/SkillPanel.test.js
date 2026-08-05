import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./SkillPanel.svelte', import.meta.url), 'utf8');

test('fills the resource panel body width', () => {
  assert.match(source, /\.skill-shell\s*\{[^}]*width:\s*100%/s);
});
