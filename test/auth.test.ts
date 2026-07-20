import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAuthStatus } from '../src/lib/auth';

describe('auth client response validation', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    null,
    [],
    { enabled: true },
    { enabled: 'yes', loggedIn: true },
    { enabled: true, loggedIn: false, username: 42 },
    { enabled: true, loggedIn: false, expiresAt: null },
  ])('rejects malformed successful JSON without exposing its contents: %j', async (body) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(getAuthStatus()).rejects.toThrow('认证服务返回了无效响应');
  });
});
