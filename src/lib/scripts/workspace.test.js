import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createScriptWorkspace, scriptWorkspace, ScriptWorkspace } from './workspace.svelte';

function makeApi(overrides = {}) {
  const writes = [];
  const api = {
    listTree: async () => ({ kind: 'directory', name: '', path: '', children: [] }),
    readFile: async (path) => ({ path, content: `old-${path}`, sha256: `sha256:${path}`, size: 3, mtimeMs: 1 }),
    writeFile: async (input) => {
      writes.push(input);
      return { path: input.path, content: input.content, sha256: `sha256:new-${input.path}`, size: 3, mtimeMs: 2 };
    },
    createFolder: async () => {},
    deleteFile: async () => {},
    deleteFolder: async () => {},
    ...overrides,
  };
  return { api, writes };
}

test('shared workspace is initialized after the class declaration', () => {
  expect(scriptWorkspace).toBeInstanceOf(ScriptWorkspace);
  const source = readFileSync(new URL('./workspace.svelte.ts', import.meta.url), 'utf8');
  expect(source.indexOf('export class ScriptWorkspace')).toBeLessThan(
    source.indexOf('export const scriptWorkspace'),
  );
});

test('edits stay in memory until explicitly saved', async () => {
  const { api, writes } = makeApi();
  const workspace = createScriptWorkspace(api);
  await workspace.openFile('demo/a.js');
  workspace.updateActiveContent('new');
  expect(workspace.activeFile.dirty).toBe(true);
  expect(writes).toEqual([]);
  await workspace.saveActive();
  expect(writes).toEqual([{ path: 'demo/a.js', content: 'new', expectedSha256: 'sha256:demo/a.js' }]);
  expect(workspace.activeFile.dirty).toBe(false);
  expect(workspace.activeFile.sha256).toBe('sha256:new-demo/a.js');
});

test('opening the same file twice does not refetch', async () => {
  let reads = 0;
  const { api } = makeApi({
    readFile: async (path) => { reads += 1; return { path, content: 'c', sha256: 'sha256:c', size: 1, mtimeMs: 1 }; },
  });
  const workspace = createScriptWorkspace(api);
  await workspace.openFile('demo/a.js');
  await workspace.openFile('demo/a.js');
  expect(reads).toBe(1);
});

test('updateActiveContent marks dirty only when content differs from saved', async () => {
  const { api } = makeApi();
  const workspace = createScriptWorkspace(api);
  await workspace.openFile('demo/a.js');
  workspace.updateActiveContent('old-demo/a.js');
  expect(workspace.activeFile.dirty).toBe(false);
  workspace.updateActiveContent('changed');
  expect(workspace.activeFile.dirty).toBe(true);
});

test('flushDirty saves all dirty files and stops on a conflict', async () => {
  const writes = [];
  const api = {
    listTree: async () => ({ kind: 'directory', name: '', path: '', children: [] }),
    readFile: async (path) => ({ path, content: `old-${path}`, sha256: `sha256:${path}`, size: 3, mtimeMs: 1 }),
    writeFile: async (input) => {
      writes.push(input);
      if (input.path === 'demo/b.js') {
        const err = new Error('conflict');
        err.code = 'CONTENT_CONFLICT';
        throw err;
      }
      return { path: input.path, content: input.content, sha256: `sha256:new-${input.path}`, size: 3, mtimeMs: 2 };
    },
    createFolder: async () => {},
    deleteFile: async () => {},
    deleteFolder: async () => {},
  };
  const workspace = createScriptWorkspace(api);
  await workspace.openFile('demo/a.js');
  workspace.updateActiveContent('new-a');
  await workspace.openFile('demo/b.js');
  workspace.updateActiveContent('new-b');

  await expect(workspace.flushDirty()).rejects.toMatchObject({ code: 'CONTENT_CONFLICT' });
  expect(writes.map((item) => item.path)).toEqual(['demo/a.js', 'demo/b.js']);
  expect(workspace.files.get('demo/a.js').dirty).toBe(false);
  expect(workspace.files.get('demo/b.js').dirty).toBe(true);
  expect(workspace.files.get('demo/b.js').content).toBe('new-b');
});

test('createFile writes a default body and selects the new file', async () => {
  const writes = [];
  const api = {
    listTree: async () => ({ kind: 'directory', name: '', path: '', children: [] }),
    readFile: async () => { throw new Error('should not read'); },
    writeFile: async (input) => { writes.push(input); return { path: input.path, content: input.content, sha256: 'sha256:new', size: 3, mtimeMs: 2 }; },
    createFolder: async () => {},
    deleteFile: async () => {},
    deleteFolder: async () => {},
  };
  const workspace = createScriptWorkspace(api);
  await workspace.createFile('demo/new.js');
  expect(writes).toEqual([{ path: 'demo/new.js', content: '// 新脚本\n', expectedSha256: null }]);
  expect(workspace.activePath).toBe('demo/new.js');
  expect(workspace.activeFile.dirty).toBe(false);
});

test('createFile writes supplied extracted content and selects the new file', async () => {
  const { api, writes } = makeApi();
  const workspace = createScriptWorkspace(api);
  await workspace.createFile('demo/extracted.js', 'engine.notify("done")');
  expect(writes).toEqual([{
    path: 'demo/extracted.js',
    content: 'engine.notify("done")',
    expectedSha256: null,
  }]);
  expect(workspace.activeFile.content).toBe('engine.notify("done")');
  expect(workspace.activeFile.dirty).toBe(false);
});

test('createFile ensures a parent directory exists before writing', async () => {
  const calls = [];
  const { api } = makeApi({
    writeFile: async (input) => {
      calls.push(`write:${input.path}`);
      return { path: input.path, content: input.content, sha256: 'sha256:new', size: 3, mtimeMs: 2 };
    },
    createFolder: async (path) => { calls.push(`folder:${path}`); },
  });
  const workspace = createScriptWorkspace(api);
  await workspace.createFile('demo/scripts/new.js');
  expect(calls).toEqual([
    'folder:demo/scripts',
    'write:demo/scripts/new.js',
  ]);
});

test('createFile ignores an existing parent directory', async () => {
  const calls = [];
  const { api } = makeApi({
    createFolder: async (path) => {
      calls.push(`folder:${path}`);
      const error = new Error('exists');
      error.code = 'ALREADY_EXISTS';
      throw error;
    },
    writeFile: async (input) => {
      calls.push(`write:${input.path}`);
      return { path: input.path, content: input.content, sha256: 'sha256:new', size: 3, mtimeMs: 2 };
    },
  });
  const workspace = createScriptWorkspace(api);
  await workspace.createFile('scripts/new.js');
  expect(calls).toEqual([
    'folder:scripts',
    'write:scripts/new.js',
  ]);
});

test('writeFileForce creates a missing draft directory before extracting a new script', async () => {
  const calls = [];
  const { api } = makeApi({
    readFile: async () => {
      const error = new Error('missing');
      error.code = 'NOT_FOUND';
      throw error;
    },
    createFolder: async (path) => { calls.push(`folder:${path}`); },
    writeFile: async (input) => {
      calls.push(`write:${input.path}`);
      return { path: input.path, content: input.content, sha256: 'sha256:new', size: 3, mtimeMs: 2 };
    },
  });
  const workspace = createScriptWorkspace(api);

  await workspace.writeFileForce('draft-project/worker.js', 'console.log("hello")');

  expect(calls).toEqual([
    'folder:draft-project',
    'write:draft-project/worker.js',
  ]);
  expect(workspace.activePath).toBe('draft-project/worker.js');
  expect(workspace.activeFile.content).toBe('console.log("hello")');
});

test('deleteFile removes the file and clears active path when needed', async () => {
  const deletes = [];
  const api = {
    listTree: async () => ({ kind: 'directory', name: '', path: '', children: [] }),
    readFile: async (path) => ({ path, content: 'c', sha256: `sha256:${path}`, size: 1, mtimeMs: 1 }),
    writeFile: async () => { throw new Error('no writes'); },
    createFolder: async () => {},
    deleteFile: async (path, sha) => { deletes.push({ path, sha }); },
    deleteFolder: async () => {},
  };
  const workspace = createScriptWorkspace(api);
  await workspace.openFile('demo/a.js');
  await workspace.deleteFile('demo/a.js');
  expect(deletes).toEqual([{ path: 'demo/a.js', sha: 'sha256:demo/a.js' }]);
  expect(workspace.files.has('demo/a.js')).toBe(false);
  expect(workspace.activePath).toBe('');
});

test('deleteFolder closes every open file below the deleted folder', async () => {
  const { api } = makeApi();
  const workspace = createScriptWorkspace(api);
  await workspace.openFile('demo/scripts/a.js');
  await workspace.openFile('demo/keep.js');
  await workspace.openFile('demo/scripts/b.js');
  await workspace.deleteFolder('demo/scripts');
  expect(workspace.files.has('demo/scripts/a.js')).toBe(false);
  expect(workspace.files.has('demo/scripts/b.js')).toBe(false);
  expect(workspace.files.has('demo/keep.js')).toBe(true);
  expect(workspace.activePath).toBe('');
});

test('getContent returns in-memory content for an open file', async () => {
  const { api } = makeApi();
  const workspace = createScriptWorkspace(api);
  await workspace.openFile('demo/a.js');
  workspace.updateActiveContent('dirty-code');
  expect(workspace.getContent('demo/a.js')).toBe('dirty-code');
  expect(workspace.getContent('demo/missing.js')).toBeUndefined();
});

test('resetForProject clears open files and warnings', async () => {
  const { api } = makeApi();
  const workspace = createScriptWorkspace(api);
  await workspace.openFile('demo/a.js');
  workspace.warnings = [{ path: 'demo/a.js', reason: 'x' }];
  workspace.resetForProject('p1', 'demo');
  expect(workspace.projectId).toBe('p1');
  expect(workspace.projectName).toBe('demo');
  expect(workspace.files.size).toBe(0);
  expect(workspace.activePath).toBe('');
  expect(workspace.warnings).toEqual([]);
});

test('ignores a tree response started for an earlier project', async () => {
  let resolveFirst;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  let calls = 0;
  const { api } = makeApi({
    listTree: async () => {
      calls += 1;
      if (calls === 1) return first;
      return { kind: 'directory', name: '', path: '', children: [{ kind: 'file', name: 'new.js', path: 'new.js' }] };
    },
  });
  const workspace = createScriptWorkspace(api);
  workspace.resetForProject('old', 'Old');
  const staleRefresh = workspace.refreshTree();
  workspace.resetForProject('new', 'New');
  await workspace.refreshTree();
  resolveFirst({ kind: 'directory', name: '', path: '', children: [{ kind: 'file', name: 'old.js', path: 'old.js' }] });
  await staleRefresh;

  expect(workspace.tree.children.map((node) => node.path)).toEqual(['new.js']);
});
