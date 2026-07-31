import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMetadataStore } from './metadata.mjs';

let root;
let metadata;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'script-metadata-'));
  metadata = await createMetadataStore(root);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test('ensures a project directory and persists a manifest', async () => {
  expect(await metadata.ensureProject({ projectId: 'sha256:abc', projectName: 'data-pipeline' }))
    .toMatchObject({ projectId: 'abc', directory: 'data-pipeline' });
  const manifest = { version: 1, projectId: 'abc', projectName: 'data-pipeline', references: [{ pointer: '/agents/data/scheduler/script', path: 'data-pipeline/a.js', contentSha256: 'sha256:1' }] };
  await metadata.writeManifest('sha256:abc', manifest);
  expect(await metadata.readManifest('abc')).toEqual(expect.objectContaining(manifest));
});

test('rejects two project IDs claiming one directory', async () => {
  await metadata.ensureProject({ projectId: 'one', projectName: 'demo' });
  await expect(metadata.ensureProject({ projectId: 'two', projectName: 'demo' })).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
});

test('missing and corrupt manifests safely return null', async () => {
  expect(await metadata.readManifest('missing')).toBeNull();
  const corruptPath = path.join(root, '.metadata', 'manifests', 'corrupt.json');
  await writeFile(corruptPath, '{ not valid json', { mode: 0o600 });
  expect(await metadata.readManifest('corrupt')).toBeNull();
});

test('deleteManifest removes a persisted manifest', async () => {
  await metadata.ensureProject({ projectId: 'p1', projectName: 'demo' });
  await metadata.writeManifest('p1', { version: 1, projectId: 'p1', projectName: 'demo', references: [] });
  expect(await metadata.readManifest('p1')).not.toBeNull();
  await metadata.deleteManifest('p1');
  expect(await metadata.readManifest('p1')).toBeNull();
});

test('rejects project IDs that could escape the manifest directory', async () => {
  for (const projectId of ['../outside', 'folder/project', 'folder\\project', '.', 'sha256:']) {
    await expect(metadata.readManifest(projectId)).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(metadata.ensureProject({ projectId, projectName: 'safe-name' }))
      .rejects.toMatchObject({ code: 'INVALID_PATH' });
  }
});

test('rejects a manifest whose project ID does not match its URL', async () => {
  await expect(metadata.writeManifest('p1', {
    version: 1,
    projectId: 'p2',
    projectName: 'demo',
    references: [],
  })).rejects.toMatchObject({ code: 'INVALID_PATH' });
});
