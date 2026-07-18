import { describe, expect, test, vi } from 'vitest';

import { loadEventSandboxLinks } from './event-sandbox-links';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('loadEventSandboxLinks', () => {
  test('normalizes current sandbox links and URL-encodes the event ID', async () => {
    const fetcher = vi.fn(async () => response({ sandboxes: [{
      sandbox_id: 'sandbox-1', relation: 'created', loader_id: 'loader-1', run_id: 'run-1',
      trigger_id: 'trigger-1', loader_event_id: 'loader-event-1', event_id: 'evt/a', created_at: '2026-07-17T01:00:00Z',
    }] }));

    await expect(loadEventSandboxLinks('evt/a', fetcher)).resolves.toEqual([{
      sandboxId: 'sandbox-1', relation: 'created', loaderId: 'loader-1', runId: 'run-1',
      triggerId: 'trigger-1', loaderEventId: 'loader-event-1', eventId: 'evt/a', createdAt: '2026-07-17T01:00:00Z',
    }]);
    expect(fetcher).toHaveBeenCalledWith('/api/events/evt%2Fa/sessions', expect.objectContaining({ headers: { Accept: 'application/json' } }));
  });

  test('accepts legacy sessions and keeps the newest duplicate link', async () => {
    const fetcher = vi.fn(async () => response({ sessions: [
      { session_id: 'sandbox-1', relation: 'old', created_at: '2026-07-16T01:00:00Z' },
      { session_id: '', relation: 'ignored' },
      { session_id: 'sandbox-1', relation: 'new', created_at: '2026-07-17T01:00:00Z' },
    ] }));

    const links = await loadEventSandboxLinks('evt-1', fetcher);

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ sandboxId: 'sandbox-1', relation: 'new' });
  });

  test('returns an empty list for an empty or malformed collection', async () => {
    await expect(loadEventSandboxLinks('evt-1', vi.fn(async () => response({ sandboxes: null })))).resolves.toEqual([]);
  });

  test('reports a non-success response without exposing its body', async () => {
    await expect(loadEventSandboxLinks('evt-1', vi.fn(async () => response({ secret: 'hidden' }, 503))))
      .rejects.toThrow('加载 Event Session 失败（503）');
  });
});
