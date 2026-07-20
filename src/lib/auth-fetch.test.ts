import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('./auth', () => ({ requireLogin: vi.fn() }));

import { requireLogin } from './auth';
import { authFetch } from './auth-fetch';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.mocked(requireLogin).mockClear();
});

describe('authFetch', () => {
  test('marks the session anonymous on a 401 and returns the original readable response', async () => {
    const upstream = new Response('{"error":"authentication required"}', { status: 401 });
    globalThis.fetch = vi.fn().mockResolvedValue(upstream);

    const response = await authFetch('/agentcompose.v2.ProjectService/ListProjects');

    expect(response).toBe(upstream);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'authentication required' });
    expect(requireLogin).toHaveBeenCalledOnce();
  });

  test('notifies only once until a non-401 response ends the anonymous transition', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    await authFetch('/initial-state');
    vi.mocked(requireLogin).mockClear();
    await authFetch('/first');
    await authFetch('/second');
    expect(requireLogin).toHaveBeenCalledOnce();

    await authFetch('/recovered');
    await authFetch('/expired-again');
    expect(requireLogin).toHaveBeenCalledTimes(2);
  });
});
