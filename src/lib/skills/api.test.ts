import { afterEach, expect, test, vi } from 'vitest';
import { SkillApiError, skillApi } from './api';

const SHA = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

afterEach(() => vi.unstubAllGlobals());

test('lists project skills with an encoded exact query and unwraps entries', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ entries: [{ path: 'demo', name: 'demo', isDir: true, size: 0, modTime: '2026-01-01T00:00:00Z' }] })));
  vi.stubGlobal('fetch', fetch);
  await expect(skillApi.list('ws_a&b')).resolves.toEqual([expect.objectContaining({ name: 'demo', isDir: true })]);
  expect(fetch).toHaveBeenCalledWith('/api/project-files/skills?projectKey=ws_a%26b', expect.objectContaining({ credentials: 'same-origin' }));
});

test('creates, reads, writes and removes with the strict project-files contract', async () => {
  const file = { path: 'demo/SKILL.md', name: 'SKILL.md', isDir: false, size: 4, modTime: 'now', sha256: SHA, content: 'body' };
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ file }), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ file })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ file: { ...file, content: undefined } })))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetch);
  await skillApi.create('ws_1', 'demo');
  await skillApi.read('ws_1', 'demo/SKILL.md');
  await skillApi.write('ws_1', 'demo/SKILL.md', 'next', 'abc');
  await skillApi.remove('ws_1', 'demo', true);
  expect(fetch.mock.calls.map(([url, init]) => [url, init.method, init.body])).toEqual([
    ['/api/project-files/skills/create', 'POST', JSON.stringify({ projectKey: 'ws_1', name: 'demo' })],
    ['/api/project-files/file?projectKey=ws_1&path=demo%2FSKILL.md', undefined, undefined],
    ['/api/project-files/file', 'PUT', JSON.stringify({ projectKey: 'ws_1', path: 'demo/SKILL.md', content: 'next', expectedSHA256: 'abc' })],
    ['/api/project-files/folder?projectKey=ws_1&path=demo&recursive=true', 'DELETE', undefined],
  ]);
});

test('accepts an empty text file as valid read content', async () => {
  const file = { path: 'demo/SKILL.md', name: 'SKILL.md', isDir: false, size: 0, modTime: 'now', sha256: SHA, content: '' };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ file }))));
  await expect(skillApi.read('ws_1', 'demo/SKILL.md')).resolves.toEqual(file);
});

test.each([
  ['list null entries', () => skillApi.list('ws_1'), { entries: null }],
  ['list malformed entry', () => skillApi.list('ws_1'), { entries: [{ path: 'demo', name: 'demo', isDir: true, size: -1, modTime: 'now' }] }],
  ['create directory response', () => skillApi.create('ws_1', 'demo'), { file: { path: 'demo', name: 'demo', isDir: true, size: 0, modTime: 'now', sha256: SHA } }],
  ['read missing content', () => skillApi.read('ws_1', 'demo/SKILL.md'), { file: { path: 'demo/SKILL.md', name: 'SKILL.md', isDir: false, size: 0, modTime: 'now', sha256: SHA } }],
  ['write malformed metadata', () => skillApi.write('ws_1', 'demo/SKILL.md', 'x', SHA), { file: { path: 'demo/SKILL.md', name: 'SKILL.md', isDir: false, size: 1, modTime: null, sha256: SHA } }],
])('rejects malformed successful %s', async (_name, invoke, body) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })));
  const error = await invoke().catch((value) => value);
  expect(error).toMatchObject({ status: 200, code: 'invalid_response' });
});

test('rejects non-JSON successful responses as invalid_response', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>ok</html>', { status: 200 })));
  await expect(skillApi.list('ws_1')).rejects.toMatchObject({ status: 200, code: 'invalid_response' });
});

test('exposes status, code and message from exact error envelopes', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'content_conflict', message: 'changed' } }), { status: 409 })));
  const error = await skillApi.read('ws_1', 'x').catch((value) => value);
  expect(error).toBeInstanceOf(SkillApiError);
  expect(error).toMatchObject({ status: 409, code: 'content_conflict', message: 'changed' });
});
