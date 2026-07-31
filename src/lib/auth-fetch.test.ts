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

  test('notifies for every 401 regardless of interleaved successful responses', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    await authFetch('/first');
    await authFetch('/interleaved-success');
    await authFetch('/second');
    expect(requireLogin).toHaveBeenCalledTimes(2);
  });

  test('does not let a non-401 response suppress a later expiry broadcast', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    await authFetch('/expired-before-login');
    await authFetch('/login-or-unrelated-success');
    await authFetch('/expired-after-login');

    expect(requireLogin).toHaveBeenCalledTimes(2);
  });
});
