import { afterEach, expect, test, vi } from 'vitest';
import { VolumeFileApiError, volumeFileApi } from './api';

const SHA = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

test('implements the exact volume file HTTP contract', async () => {
  const entry = { name: 'a.txt', path: 'dir/a.txt', dir: false, size: 1, mtimeMs: 7, sha256: SHA };
  const fetch = vi.fn()
    .mockResolvedValueOnce(json({ entries: [entry] }))
    .mockResolvedValueOnce(json({ path: entry.path, content: 'a', sha256: SHA, truncated: false }))
    .mockResolvedValueOnce(json({ file: entry }, 201))
    .mockResolvedValueOnce(json({ path: 'dir' }, 201))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetch);
  await volumeFileApi.list('ws_a&b', 'vol one', 'dir');
  await volumeFileApi.preview('ws_a&b', 'vol one', entry.path);
  await volumeFileApi.upload('ws_a&b', 'vol one', entry.path, new File(['a'], 'a.txt'));
  await volumeFileApi.mkdir('ws_a&b', 'vol one', 'dir');
  await volumeFileApi.removeFile('ws_a&b', 'vol one', entry.path);
  await volumeFileApi.removeFolder('ws_a&b', 'vol one', 'dir', true);
  expect(fetch.mock.calls[0][0]).toBe('/api/volume-files?projectKey=ws_a%26b&volume=vol%20one&path=dir');
  expect(fetch.mock.calls[1][0]).toContain('/api/volume-files/preview?');
  expect(fetch.mock.calls[2][1]).toMatchObject({ method: 'POST', credentials: 'same-origin' });
  expect(fetch.mock.calls[3][1].body).toBe(JSON.stringify({ projectKey: 'ws_a&b', volume: 'vol one', path: 'dir' }));
  expect(fetch.mock.calls[5][0]).toContain('recursive=true');
});

test('builds an encoded same-origin download URL', () => {
  expect(volumeFileApi.downloadURL('ws_a&b', 'v/x', 'dir/a b')).toBe('/api/volume-files/download?projectKey=ws_a%26b&volume=v%2Fx&path=dir%2Fa%20b');
});

test('passes abort signals and exposes conflict envelopes', async () => {
  const fetch = vi.fn().mockResolvedValue(json({ error: { code: 'conflict', message: 'resource conflict' } }, 409));
  vi.stubGlobal('fetch', fetch); const controller = new AbortController();
  const error = await volumeFileApi.preview('ws_1', 'v', 'a', controller.signal).catch((value) => value);
  expect(error).toBeInstanceOf(VolumeFileApiError);
  expect(error).toMatchObject({ status: 409, code: 'conflict' });
  expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
});

test('rejects physical-path or malformed successful payloads', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ entries: [{ name: 'x', path: '/data/volumes/local/private', dir: false, size: 1, mtimeMs: 1 }] })));
  await expect(volumeFileApi.list('ws_1', 'v', '')).rejects.toMatchObject({ code: 'invalid_response' });
});

test('writes with the exact JSON request', async () => {
  const file = { name: 'a', path: 'a', dir: false, size: 1, mtimeMs: 1, sha256: SHA };
  const fetch = vi.fn().mockResolvedValue(json({ file })); vi.stubGlobal('fetch', fetch);
  await volumeFileApi.write('ws', 'vol', 'a', 'x', SHA);
  expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ projectKey: 'ws', volume: 'vol', path: 'a', content: 'x', expectedSHA256: SHA }) });
});

test.each([
  ['wrong status', json({ entries: [] }, 201)],
  ['wrong content type', new Response(JSON.stringify({ entries: [] }), { status: 200, headers: { 'content-type': 'text/plain' } })],
  ['extra success key', json({ entries: [], physicalPath: '/private' })],
  ['extra error key', json({ error: { code: 'x', message: 'x', physicalPath: '/private' } }, 400)],
])('rejects %s', async (_name, response) => { vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response)); await expect(volumeFileApi.list('ws', 'v')).rejects.toMatchObject({ code: 'invalid_response' }); });

test('maps response body read failures to network_error', async () => {
  const response = new Response('{}', { headers: { 'content-type': 'application/json' } }); vi.spyOn(response, 'text').mockRejectedValue(new Error('read failed')); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  await expect(volumeFileApi.list('ws', 'v')).rejects.toMatchObject({ status: 0, code: 'network_error' });
});
