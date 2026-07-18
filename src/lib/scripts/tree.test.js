import { expect, test } from 'bun:test';
import { collectScriptDirectories, collectScriptFiles, countScriptFiles, filterScriptDirectories } from './tree';

const tree = {
  kind: 'directory',
  name: '',
  path: '',
  children: [
    {
      kind: 'directory',
      name: 'scripts',
      path: 'scripts',
      children: [
        { kind: 'file', name: 'one.js', path: 'scripts/one.js', size: 1, mtimeMs: 1, sha256: 'a' },
        {
          kind: 'directory',
          name: 'nested',
          path: 'scripts/nested',
          children: [
            { kind: 'file', name: 'two.js', path: 'scripts/nested/two.js', size: 2, mtimeMs: 2, sha256: 'b' },
          ],
        },
      ],
    },
  ],
};

test('collectScriptFiles flattens files in tree order', () => {
  expect(collectScriptFiles(tree).map((file) => file.path)).toEqual([
    'scripts/one.js',
    'scripts/nested/two.js',
  ]);
});

test('countScriptFiles handles a missing tree', () => {
  expect(countScriptFiles(null)).toBe(0);
  expect(countScriptFiles(tree)).toBe(2);
});

test('collectScriptDirectories returns nested directory paths', () => {
  expect(collectScriptDirectories(tree)).toEqual(['scripts', 'scripts/nested']);
});

test('directory search keeps a matched directory with its complete subtree', () => {
  const result = filterScriptDirectories(tree, 'SCRIPTS');
  expect(collectScriptFiles(result.tree).map((file) => file.path)).toEqual([
    'scripts/one.js',
    'scripts/nested/two.js',
  ]);
  expect(result.expandedPaths).toEqual(new Set(['scripts', 'scripts/nested']));
});

test('directory search keeps parent context for a nested match', () => {
  const result = filterScriptDirectories(tree, 'nested');
  expect(result.tree?.kind === 'directory' ? result.tree.children[0]?.path : '').toBe('scripts');
  expect(collectScriptDirectories(result.tree)).toEqual(['scripts', 'scripts/nested']);
  expect(collectScriptFiles(result.tree).map((file) => file.path)).toEqual(['scripts/nested/two.js']);
  expect(result.expandedPaths).toEqual(new Set(['scripts', 'scripts/nested']));
});

test('directory search returns an empty root when nothing matches', () => {
  const result = filterScriptDirectories(tree, 'missing');
  expect(result.tree).toMatchObject({ kind: 'directory', children: [] });
  expect(result.expandedPaths.size).toBe(0);
});
