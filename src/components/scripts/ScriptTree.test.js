import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./ScriptTree.svelte', import.meta.url), 'utf8');

test('every tree row carries a data-path attribute and a tree-delete button', () => {
  assert.match(source, /data-path=\{node\.path\}/);
  assert.match(source, /class="tree-delete"/);
});

test('the delete button is a real <button> and the row is not a button (avoids nested buttons)', () => {
  assert.match(source, /<div\s[^>]*class="tree-row"/);
  assert.match(source, /<button\s[^>]*class="tree-delete"/);
});

test('delete handler stops propagation so clicking delete does not open the file', () => {
  assert.match(source, /event\.stopPropagation\(\)/);
  assert.match(source, /handleDelete\(event, node\)/);
});

test('file deletion confirmation warns about auto-fallback to inline code', () => {
  assert.ok(
    source.includes('确定删除文件 ${node.path} 吗？引用该文件的项目下次打开时会自动回退为原后端保存的内联代码。'),
    'file delete confirmation text must mention inline fallback',
  );
});

test('folder deletion confirmation describes recursive deletion', () => {
  assert.ok(
    source.includes('确定递归删除文件夹 ${node.path} 吗？文件夹内的所有脚本和子目录都会被删除。'),
    'folder delete confirmation text must mention recursive deletion',
  );
});

test('delete button routes files to onDeleteFile and folders to onDeleteFolder', () => {
  assert.match(source, /onDeleteFile\(node\.path\)/);
  assert.match(source, /onDeleteFolder\(node\.path\)/);
});

test('tree-delete is hidden until the row is hovered or focused', () => {
  assert.match(source, /\.tree-row:hover \.tree-delete/);
  assert.match(source, /\.tree-row:focus-within \.tree-delete/);
  assert.match(source, /\.tree-delete\s*\{[^}]*display:\s*none/);
});

test('tree-delete has a clearly clickable size and right alignment', () => {
  assert.match(source, /margin-left:\s*auto/);
  assert.match(source, /flex:\s*0 0 2[0-9]px/);
  assert.match(source, /font-size:\s*1[5-9]px/);
});

test('dirty dot is shown for open files that are dirty', () => {
  assert.match(source, /dirtyPaths\.has\(node\.path\)/);
  assert.match(source, /class="dirty-dot"/);
});

test('offers a directory-name search without changing file open behavior', () => {
  assert.match(source, /<span>目录<\/span>\s*<input[^>]*aria-label="检索脚本目录"/s);
  assert.match(source, /aria-label="检索脚本目录"/);
  assert.match(source, /filterScriptDirectories\(tree, directoryQuery\)/);
  assert.match(source, /未找到匹配目录/);
});

test('keeps creation controls out of the directory header', () => {
  assert.doesNotMatch(source, /title="新建文件"/);
  assert.doesNotMatch(source, /title="新建文件夹"/);
  assert.doesNotMatch(source, /onCreateFolder/);
});
