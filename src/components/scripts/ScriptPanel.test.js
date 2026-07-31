import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./ScriptPanel.svelte', import.meta.url), 'utf8');

test('composes the tree and the editor from the shared workspace', () => {
  assert.match(source, /import ScriptTree from '\.\/ScriptTree\.svelte'/);
  assert.match(source, /import ScriptEditor from '\.\/ScriptEditor\.svelte'/);
  assert.match(source, /import ScriptCreateModal from '\.\/ScriptCreateModal\.svelte'/);
  assert.match(source, /<ScriptTree\s/);
  assert.match(source, /<ScriptEditor\s/);
});

test('refreshes the tree when the panel is opened', () => {
  assert.match(source, /if \(workspace\.panelOpen\)/);
  assert.match(source, /workspace\.refreshTree\(\)/);
});

test('refreshes an already-open tree when the active project changes', () => {
  assert.match(source, /workspace\.contextRevision;/);
});

test('reports API errors via store.addToast', () => {
  assert.match(source, /store\.addToast\(/);
  assert.match(source, /scriptErrorMessage/);
});

test('wires editor script creation to the existing file modal', () => {
  assert.match(source, /<ScriptEditor \{workspace\} onCreateFile=\{\(\) => \(createMode = 'file'\)\} \/>/);
  assert.match(source, /<ScriptCreateModal/);
  assert.doesNotMatch(source, /createMode = 'folder'/);
});

test('delete handlers delegate to workspace.deleteFile and workspace.deleteFolder', () => {
  assert.match(source, /workspace\.deleteFile\(path\)/);
  assert.match(source, /workspace\.deleteFolder\(path\)/);
});

test('reports the script service error through the shared toast surface', () => {
  assert.match(source, /store\.addToast\('脚本服务不可用：' \+ message\(e\), 'error'\)/);
});

test('supports dragging the directory edge to resize the tree horizontally', () => {
  assert.match(source, /let treeWidth = \$state\(220\)/);
  assert.match(source, /function startResize/);
  assert.match(source, /aria-label="调整脚本目录宽度"/);
  assert.match(source, /col-resize/);
  assert.match(source, /startWidth \+ \(e\.clientX - startX\)/);
});
