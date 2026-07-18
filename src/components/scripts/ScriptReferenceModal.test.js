import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./ScriptReferenceModal.svelte', import.meta.url), 'utf8');

test('extract mode renders an editable prefilled path', () => {
  expect(source).toContain("mode: 'extract' | 'reference'");
  expect(source).toContain('bind:value={path}');
  expect(source).toContain('fileExists');
  expect(source).toContain("'更新脚本文件'");
  expect(source).toContain("'提取脚本到文件'");
  expect(source).toContain('完整路径');
});

test('reference mode renders selectable script files and an empty state', () => {
  expect(source).toContain('{#each files as file (file.path)}');
  expect(source).toContain('type="radio"');
  expect(source).toContain('暂无可引用的脚本文件');
});

test('modal validates js paths and supports cancellation', () => {
  expect(source).toContain("path.trim().endsWith('.js')");
  expect(source).toContain("event.key === 'Escape'");
  expect(source).toContain('disabled={!canSubmit}');
});
