import { expect, test } from 'bun:test'; import { readFileSync } from 'node:fs';
test('disables loader run lists under v2', () => { expect(readFileSync(new URL('./LoaderRunListView.svelte', import.meta.url),'utf8')).toContain("V2_CAPABILITIES['loader-runs']"); });
