import { afterEach, describe, expect, test, vi } from 'vitest';
import { SharedDirectoryApiError, sharedDirectoryApi } from './shared-directories';

afterEach(() => vi.unstubAllGlobals());

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('sharedDirectoryApi.list', () => {
  test('uses the exact authenticated catalog endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ entries: [
      { id: 'docs', name: 'Documents', path: '/srv/docs', writable: true },
    ] }));
    vi.stubGlobal('fetch', fetch);
    await expect(sharedDirectoryApi.list()).resolves.toEqual([
      { id: 'docs', name: 'Documents', path: '/srv/docs', writable: true },
    ]);
    expect(fetch).toHaveBeenCalledWith('/api/shared-directories', { credentials: 'same-origin' });
  });

  test.each([
    [{}, 'missing envelope'],
    [{ entries: [{ id: 'x', name: 'X', path: 'relative', writable: false }] }, 'relative path'],
    [{ entries: [{ id: 'x', name: 'X', path: '/a/../b', writable: false }] }, 'non canonical path'],
    [{ entries: [{ id: 'x', name: 'X', path: '/a', writable: false }, { id: 'x', name: 'Y', path: '/b', writable: true }] }, 'duplicate id'],
    [{ entries: [{ id: 'x', name: 'X', path: '/a', writable: false }, { id: 'y', name: 'Y', path: '/a', writable: true }] }, 'duplicate path'],
    [{ entries: [{ id: 'x', name: 'X', path: '/', writable: false }] }, 'root'],
    [{ entries: [{ id: 'x', name: 'X', path: '/data/projects', writable: false }] }, 'data subtree'],
    [{ entries: [{ id: 'x', name: 'X', path: '/proc/self', writable: false }] }, 'proc'],
    [{ entries: [{ id: 'x', name: 'X', path: '/sys/kernel', writable: false }] }, 'sys'],
    [{ entries: [{ id: 'x', name: 'X', path: '/dev/shm', writable: false }] }, 'dev'],
    [{ entries: [{ id: 'x', name: 'X', path: '/var/run/docker.sock', writable: false }] }, 'docker socket'],
    [{ entries: [{ id: 'Upper', name: 'X', path: '/srv/x', writable: false }] }, 'uppercase ID'],
    [{ entries: [{ id: `${'a'.repeat(65)}`, name: 'X', path: '/srv/x', writable: false }] }, 'long ID'],
    [{ entries: [{ id: 'x', name: 'Bad\u200bname', path: '/srv/x', writable: false }] }, 'format character name'],
    [{ entries: [{ id: 'x', name: 'X', path: '/srv/bad\u0001path', writable: false }] }, 'control character path'],
  ])('rejects invalid successful responses: %s', async (body, _label) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));
    await expect(sharedDirectoryApi.list()).rejects.toMatchObject({ status: 200, code: 'invalid_response' });
  });

  test.each(['/root/secrets', '/run/cri-dockerd.sock', '/run/Docker.sock'])('accepts paths accepted by the server contract: %s', async (path) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ entries: [{ id: 'entry', name: 'Entry', path, writable: false }] })));
    await expect(sharedDirectoryApi.list()).resolves.toHaveLength(1);
  });

  test('preserves gateway error status and code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: { code: 'denied', message: 'No access' } }, 403)));
    await expect(sharedDirectoryApi.list()).rejects.toEqual(expect.objectContaining<Partial<SharedDirectoryApiError>>({
      status: 403, code: 'denied', message: 'No access',
    }));
  });
});
