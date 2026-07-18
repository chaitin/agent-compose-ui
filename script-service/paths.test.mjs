import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveDirectoryPath,
  resolveScriptPath,
  validateProjectDirectoryName,
} from './paths.mjs';

let root;
let cleanupPaths;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'script-paths-'));
  cleanupPaths = [root];
});

afterEach(async () => {
  await Promise.all(cleanupPaths.map((entry) => rm(entry, { recursive: true, force: true })));
});

describe('resolveScriptPath', () => {
  test('accepts a js path under the canonical data root', async () => {
    await mkdir(path.join(root, 'demo', 'scripts'), { recursive: true });

    expect(await resolveScriptPath(root, 'demo/scripts/job.js', { mustExist: false })).toBe(
      path.join(await realpath(root), 'demo', 'scripts', 'job.js'),
    );
  });

  test.each([
    '../secret.js',
    '/tmp/secret.js',
    'demo/../secret.js',
    '.metadata/x.js',
    'demo\\x.js',
    'demo/x.txt',
    'demo/%2e%2e/x.js',
    'demo//x.js',
    'demo/./x.js',
    'demo/x%2ejs',
    'demo/\0x.js',
  ])('%s is rejected', async (value) => {
    await expect(resolveScriptPath(root, value, { mustExist: false })).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_PATH',
    });
  });

  test('rejects a symlink in the path chain', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'script-outside-'));
    cleanupPaths.push(outside);
    await writeFile(path.join(outside, 'secret.js'), 'secret');
    await symlink(outside, path.join(root, 'linked'));

    await expect(resolveScriptPath(root, 'linked/secret.js')).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
  });

  test('checks existing parent segments for symlinks when the leaf may not exist', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'script-outside-'));
    cleanupPaths.push(outside);
    await symlink(outside, path.join(root, 'linked'));

    await expect(
      resolveScriptPath(root, 'linked/new/nested.js', { mustExist: false }),
    ).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });
});

describe('resolveDirectoryPath', () => {
  test('accepts a nested directory path', async () => {
    expect(await resolveDirectoryPath(root, 'demo/scripts', { mustExist: false })).toBe(
      path.join(await realpath(root), 'demo', 'scripts'),
    );
  });

  test.each(['.metadata', 'demo/.metadata', 'demo//scripts', '../demo', '/tmp/demo'])(
    '%s is rejected',
    async (value) => {
      await expect(resolveDirectoryPath(root, value, { mustExist: false })).rejects.toMatchObject({
        code: 'INVALID_PATH',
      });
    },
  );
});

describe('validateProjectDirectoryName', () => {
  test('returns a readable single segment', () => {
    expect(validateProjectDirectoryName('data-pipeline')).toBe('data-pipeline');
  });

  test.each(['', '.', '..', '.metadata', 'a/b', 'a\\b', 'a\0b', 'line\nbreak'])(
    '%s is rejected',
    (name) => {
      expect(() => validateProjectDirectoryName(name)).toThrowError(
        expect.objectContaining({ status: 400, code: 'INVALID_PATH' }),
      );
    },
  );
});
