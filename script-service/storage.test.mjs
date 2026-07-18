import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStorage } from './storage.mjs';

let root;
let storage;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'script-storage-'));
  storage = createStorage(root, { maxFileBytes: 2 * 1024 * 1024 });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test('creates folders and writes, reads, lists, then deletes js files', async () => {
  await storage.createFolder('demo/scripts');
  const written = await storage.writeFile({ path: 'demo/scripts/a.js', content: 'const a = 1;\n', expectedSha256: null });
  expect(written.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(await storage.readFile('demo/scripts/a.js')).toMatchObject({ content: 'const a = 1;\n', sha256: written.sha256 });
  expect((await storage.listTree()).children[0].children[0].children[0]).toMatchObject({ name: 'a.js', kind: 'file' });
  await storage.deleteFile('demo/scripts/a.js', written.sha256);
  await expect(storage.readFile('demo/scripts/a.js')).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

test('does not overwrite a file changed by another writer', async () => {
  await storage.createFolder('demo');
  const first = await storage.writeFile({ path: 'demo/a.js', content: 'one', expectedSha256: null });
  await storage.writeFile({ path: 'demo/a.js', content: 'two', expectedSha256: first.sha256 });
  await expect(storage.writeFile({ path: 'demo/a.js', content: 'three', expectedSha256: first.sha256 }))
    .rejects.toMatchObject({ code: 'CONTENT_CONFLICT' });
});

test('recursive folder deletion requires the explicit flag', async () => {
  await storage.createFolder('demo/scripts');
  await storage.writeFile({ path: 'demo/scripts/a.js', content: 'a', expectedSha256: null });
  await expect(storage.deleteFolder('demo', false)).rejects.toMatchObject({ code: 'DIRECTORY_NOT_EMPTY' });
  await storage.deleteFolder('demo', true);
  expect((await storage.listTree()).children).toEqual([]);
});
