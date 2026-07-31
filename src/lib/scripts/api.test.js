import { afterEach, describe, expect, test } from 'bun:test';
import { scriptApi, ScriptApiError, scriptErrorMessage } from './api';
import { subscribeUnauthorized } from '../auth';

const originalFetch = globalThis.fetch;

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const record = { url: String(url), init: init ?? {} };
    calls.push(record);
    return handler(record.url, record.init);
  };
  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body, status = 200) {
  return new Response(body === null || body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('scriptApi.readFile', () => {
  test('reads a file via /script-api/v1/files?path=', async () => {
    const calls = mockFetch(() => jsonResponse({ path: 'demo/a.js', content: 'a', size: 1, mtimeMs: 1, sha256: 'sha256:x' }));
    const file = await scriptApi.readFile('demo/a.js');
    expect(file).toMatchObject({ content: 'a', sha256: 'sha256:x' });
    expect(calls[0].url).toBe('/script-api/v1/files?path=demo%2Fa.js');
    expect(calls[0].init.method).toBeUndefined();
  });

  test('throws ScriptApiError with code on 409', async () => {
    mockFetch(() => jsonResponse({ error: { code: 'CONTENT_CONFLICT', message: '磁盘脚本已变化' } }, 409));
    await expect(
      scriptApi.writeFile({ path: 'demo/a.js', content: 'a', expectedSha256: 'sha256:old' }),
    ).rejects.toMatchObject({ code: 'CONTENT_CONFLICT' });
  });

  test('throws a ScriptApiError instance preserving status and code', async () => {
    mockFetch(() => jsonResponse({ error: { code: 'NOT_FOUND', message: '不存在' } }, 404));
    let caught;
    try {
      await scriptApi.readFile('demo/missing.js');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ScriptApiError);
    expect(caught.code).toBe('NOT_FOUND');
    expect(caught.status).toBe(404);
    expect(scriptErrorMessage(caught)).toBe('脚本文件不存在');
  });

  test('maps a failed fetch to SERVICE_UNAVAILABLE', async () => {
    mockFetch(() => { throw new TypeError('fetch failed'); });
    await expect(scriptApi.readFile('demo/a.js')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      status: 0,
    });
  });

  test('reports a gateway 401 as an expired UI session, not script-service UNAUTHORIZED', async () => {
    let notifications = 0;
    const unsubscribe = subscribeUnauthorized(() => { notifications += 1; });
    mockFetch(() => jsonResponse({ error: 'authentication required' }, 401));

    try {
      await scriptApi.readFile('demo/a.js');
    } catch (error) {
      expect(error).toBeInstanceOf(ScriptApiError);
      expect(error.status).toBe(401);
      expect(error.code).not.toBe('UNAUTHORIZED');
    } finally {
      unsubscribe();
    }
    expect(notifications).toBe(1);
  });
});

test('readManifest returns null for an empty body', async () => {
  mockFetch(() => new Response('', { status: 200 }));
  expect(await scriptApi.readManifest('p1')).toBeNull();
});

test('readManifest returns the manifest object when present', async () => {
  mockFetch(() => jsonResponse({ version: 1, projectId: 'p1', projectName: 'demo', updatedAt: '', references: [] }));
  const manifest = await scriptApi.readManifest('p1');
  expect(manifest).toMatchObject({ projectId: 'p1', references: [] });
});

test('ensureProject PUTs projectName to the encoded project path', async () => {
  const calls = mockFetch(() => jsonResponse({ projectId: 'abc', projectName: 'demo', directory: 'demo' }));
  const result = await scriptApi.ensureProject('sha256:abc', 'demo');
  expect(result).toMatchObject({ directory: 'demo' });
  expect(calls[0].url).toBe('/script-api/v1/projects/sha256%3Aabc');
  expect(calls[0].init.method).toBe('PUT');
});

test('deleteProject deletes the encoded project resource', async () => {
  const calls = mockFetch(() => jsonResponse({ deleted: true }));
  await scriptApi.deleteProject('sha256:abc');
  expect(calls[0].url).toBe('/script-api/v1/projects/sha256%3Aabc');
  expect(calls[0].init.method).toBe('DELETE');
});

test('deleteFolder sends the recursive flag', async () => {
  const calls = mockFetch(() => jsonResponse({ deleted: true }));
  await scriptApi.deleteFolder('demo', true);
  expect(calls[0].url).toBe('/script-api/v1/folders?path=demo&recursive=true');
  expect(calls[0].init.method).toBe('DELETE');
});

test('listTree returns the tree root', async () => {
  mockFetch(() => jsonResponse({ kind: 'directory', name: '', path: '', children: [] }));
  const tree = await scriptApi.listTree();
  expect(tree).toMatchObject({ kind: 'directory', children: [] });
});
