import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./scripts/ScriptLineActions.svelte', import.meta.url), 'utf8');

test('shows mutually exclusive actions for empty and populated inline scripts', () => {
  expect(source).toContain("kind === 'inline'");
  expect(source).toContain('{#if empty}');
  expect(source).toContain('aria-pressed="true"');
  expect(source).toContain('>内联脚本</button>');
  expect(source).toContain('{:else}');
  expect(source).toContain('更新文件');
  expect(source).toContain('提取到文件');
  expect(source).toContain('fileExists');
});

test('only offers referencing when the inline script is empty', () => {
  expect(source).toContain('>📁 引用已有文件</button>');
  const emptyBranch = source.slice(source.indexOf('{#if empty}'), source.indexOf('{:else}'));
  expect(emptyBranch).toContain('onReference');
  const populatedBranch = source.slice(source.indexOf('{:else}'), source.indexOf('{/if}', source.indexOf('{:else}')));
  expect(populatedBranch).not.toContain('onReference');
});

test('matches the demo glyph styling without a floating card', () => {
  expect(source).toContain('font-size: var(--font-size-xs)');
  expect(source).toContain('padding: 2px 8px');
  expect(source).toContain('border: 1px solid #a371f7');
  expect(source).toContain('background: rgba(163, 113, 247, 0.12)');
  expect(source).toContain('button:hover { background: rgba(163, 113, 247, 0.25); }');
  expect(source).not.toContain('box-shadow');
  expect(source).not.toContain('action-label');
});

test('shows file actions for script references', () => {
  expect(source).toContain('切换内联');
});

test('shrinks long actions inside a narrow editor viewport', () => {
  expect(source).toContain('min-width: 0');
  expect(source).toContain('max-width: 100%');
  expect(source).toContain('overflow: hidden');
  expect(source).toContain('text-overflow: ellipsis');
});
