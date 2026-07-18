import { expect, test } from 'bun:test'; import { readFileSync } from 'node:fs';
test('disables loader run details under v2', () => { expect(readFileSync(new URL('./LoaderRunDetailView.svelte', import.meta.url),'utf8')).toContain("V2_CAPABILITIES['loader-runs']"); });
