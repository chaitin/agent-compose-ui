import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'bun:test';

function source(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

test('the pointer-only resizer is not exposed as a keyboard-focusable control', () => {
  const resizer = source('../components/Resizer.svelte');
  assert.doesNotMatch(resizer, /class="resizer"[\s\S]*?tabindex=/);
});

test('run modal marks one-time prop prefills as intentionally untracked', () => {
  const modal = source('../modals/RunAgentModal.svelte');
  assert.match(modal, /untrack\(\(\) => prefilledAgent\)/);
  assert.match(modal, /untrack\(\(\) => \(\{[\s\S]*input: prefilledPrompt,[\s\S]*\}\)\)/);
});

test('run detail does not retain selectors for removed event markup', () => {
  const detail = source('../views/runtime/RunDetailView.svelte');
  assert.doesNotMatch(detail, /\.inline-data-heading span:last-child/);
  assert.doesNotMatch(detail, /\.event-row\s*>|\.event-row code|\.event-row p/);
});
