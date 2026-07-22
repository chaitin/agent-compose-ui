import { afterEach, expect, test, vi } from 'vitest';
import { apiTokens } from './api-tokens';

afterEach(() => vi.restoreAllMocks());

test('uses same-origin fetch without the local auth fetch wrapper', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ items: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  await expect(apiTokens.list()).resolves.toEqual([]);
  expect(fetchMock).toHaveBeenCalledWith('/ui-api/v1/tokens', expect.objectContaining({ credentials: 'same-origin' }));
});

test('surfaces disabled management as a 503 without changing login state', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'token management is not enabled' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  }));
  await expect(apiTokens.list()).rejects.toEqual(expect.objectContaining({
    status: 503,
    message: 'token management is not enabled',
  }));
});

test('creates and revokes through strict JSON endpoints', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'id', name: 'ci', role: 'admin', createdAt: 'now', token: 'once' }), { status: 201 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  await expect(apiTokens.create('ci', 'admin')).resolves.toMatchObject({ token: 'once' });
  await apiTokens.revoke('id/unsafe');
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ name: 'ci', role: 'admin' }) });
  expect(fetchMock.mock.calls[1][0]).toBe('/ui-api/v1/tokens/id%2Funsafe');
});
