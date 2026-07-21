import { describe, expect, test } from 'vitest';
import { buildHash, store } from '../lib/stores.svelte';

describe('webhook routing', () => {
  test('Page type includes webhooks', () => {
    store.goTo('webhooks');
    expect(store.currentPage).toBe('webhooks');
  });

  test('buildHash produces #/system/webhooks', () => {
    const hash = buildHash('webhooks', '', { level: 'agents', agentName: '', runId: '', sessionId: '' });
    expect(hash).toBe('#/system/webhooks');
  });
});
