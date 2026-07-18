import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createScriptService, assertUsableToken } from './app.mjs';

let root;
let server;
let baseUrl;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'script-api-'));
  const app = await createScriptService({ root, token: 'test-token', maxBodyBytes: 1024, maxFileBytes: 1024 });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/script-api/v1`;
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

const request = (pathname, init = {}) => fetch(`${baseUrl}${pathname}`, {
  ...init,
  headers: { 'x-script-service-token': 'test-token', 'content-type': 'application/json', ...init.headers },
});

test('rejects requests without the internal token', async () => {
  const response = await fetch(`${baseUrl}/health`);
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
});

test('rejects requests with a wrong token', async () => {
  const response = await fetch(`${baseUrl}/health`, { headers: { 'x-script-service-token': 'wrong' } });
  expect(response.status).toBe(401);
});

test('assertUsableToken rejects empty, short, and known-placeholder tokens', () => {
  for (const bad of [
    '',
    'short',
    'secret',
    'replace-me',
    'changeme',
    'cf3675f0466c32d703281eba8656d24d4458b5f2fb824c51e8b3fd14b34cd0fd',
  ]) {
    expect(() => assertUsableToken(bad)).toThrow();
  }
});

test('assertUsableToken accepts a freshly generated 32-byte token', () => {
  expect(() => assertUsableToken('a'.repeat(64))).not.toThrow();
});

test('health returns ok', async () => {
  const response = await request('/health');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true });
});

test('creates a folder and file, then lists and reads it', async () => {
  expect((await request('/folders', { method: 'POST', body: JSON.stringify({ path: 'demo' }) })).status).toBe(201);
  expect((await request('/files', { method: 'PUT', body: JSON.stringify({ path: 'demo/a.js', content: 'a', expectedSha256: null }) })).status).toBe(200);
  expect(await (await request('/files?path=demo%2Fa.js')).json()).toMatchObject({ content: 'a' });
  expect(await (await request('/tree')).json()).toMatchObject({ children: [{ name: 'demo' }] });
});

test('deletes a file via the API', async () => {
  await request('/folders', { method: 'POST', body: JSON.stringify({ path: 'demo' }) });
  const written = await (await request('/files', { method: 'PUT', body: JSON.stringify({ path: 'demo/a.js', content: 'a', expectedSha256: null }) })).json();
  expect((await request(`/files?path=demo%2Fa.js&expectedSha256=${encodeURIComponent(written.sha256)}`, { method: 'DELETE' })).status).toBe(200);
  expect((await request('/files?path=demo%2Fa.js')).status).toBe(404);
});

test('rejects an oversized JSON body', async () => {
  const response = await request('/files', { method: 'PUT', body: JSON.stringify({ path: 'demo/a.js', content: 'x'.repeat(2048) }) });
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
});

test('ensures a project and writes, reads, deletes a manifest', async () => {
  expect((await request('/projects/sha256:proj1', { method: 'PUT', body: JSON.stringify({ projectName: 'data-pipeline' }) })).status).toBe(200);
  const manifest = { version: 1, projectId: 'proj1', projectName: 'data-pipeline', references: [] };
  expect((await request('/projects/sha256:proj1/manifest', { method: 'PUT', body: JSON.stringify(manifest) })).status).toBe(200);
  expect(await (await request('/projects/sha256:proj1/manifest')).json()).toMatchObject({ projectId: 'proj1' });
  expect((await request('/projects/missing/manifest')).status).toBe(200);
  expect(await (await request('/projects/missing/manifest')).json()).toBeNull();
  expect((await request('/projects/sha256:proj1/manifest', { method: 'DELETE' })).status).toBe(200);
  expect(await (await request('/projects/sha256:proj1/manifest')).json()).toBeNull();
});

test('deletes a project directory and its metadata by project id', async () => {
  expect((await request('/projects/sha256:delete-me', { method: 'PUT', body: JSON.stringify({ projectName: 'delete-me-dir' }) })).status).toBe(200);
  expect((await request('/files', { method: 'PUT', body: JSON.stringify({ path: 'delete-me-dir/a.js', content: 'a', expectedSha256: null }) })).status).toBe(200);
  const manifest = { version: 1, projectId: 'delete-me', projectName: 'delete-me-dir', references: [] };
  expect((await request('/projects/delete-me/manifest', { method: 'PUT', body: JSON.stringify(manifest) })).status).toBe(200);

  expect((await request('/projects/sha256:delete-me', { method: 'DELETE' })).status).toBe(200);
  expect((await request('/files?path=delete-me-dir%2Fa.js')).status).toBe(404);
  expect(await (await request('/projects/delete-me/manifest')).json()).toBeNull();
});

test('rejects a path traversal attempt with 400', async () => {
  const response = await request('/files?path=..%2Fsecret.js');
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'INVALID_PATH' } });
});

test('returns 404 for unknown routes', async () => {
  const response = await request('/unknown');
  expect(response.status).toBe(404);
});
