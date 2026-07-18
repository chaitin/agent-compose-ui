import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  FILE_PREVIEW_BYTES,
  DIRECTORY_LIST_BYTES,
  MAX_DIRECTORY_ENTRIES,
  MAX_WRITABLE_FILE_BYTES,
  createLimitedOutput,
  appendLimitedOutput,
  formatExecError,
  isAbortError,
  parseDirectoryListing,
  prepareWritableFile,
  writeBoundedFile,
} from './file-browser';

describe('file browser output limits', () => {
  test('caps accumulated output even when a stream exceeds its declared backend limit', () => {
    const first = appendLimitedOutput(createLimitedOutput(), 'a'.repeat(FILE_PREVIEW_BYTES - 2), FILE_PREVIEW_BYTES);
    const second = appendLimitedOutput(first, 'bcdef', FILE_PREVIEW_BYTES);

    expect(new TextEncoder().encode(second.value)).toHaveLength(FILE_PREVIEW_BYTES);
    expect(second.value.endsWith('bc')).toBe(true);
    expect(second.truncated).toBe(true);
  });

  test('caps multibyte text by UTF-8 bytes', () => {
    const result = appendLimitedOutput(createLimitedOutput(), '你好世界', 7);

    expect(new TextEncoder().encode(result.value).length).toBeLessThanOrEqual(7);
    expect(result.truncated).toBe(true);
  });

  test('tracks accumulated bytes without re-encoding prior chunks', () => {
    let output = createLimitedOutput();
    output = appendLimitedOutput(output, '你好', 7);
    output = appendLimitedOutput(output, 'a世界', 7);

    expect(output.value).toBe('你好a');
    expect(output.bytes).toBe(7);
    expect(output.truncated).toBe(true);
  });

  test('uses a bounded directory listing size', () => {
    expect(DIRECTORY_LIST_BYTES).toBeGreaterThan(0);
    expect(DIRECTORY_LIST_BYTES).toBeLessThanOrEqual(FILE_PREVIEW_BYTES);
    expect(MAX_DIRECTORY_ENTRIES).toBe(5000);
  });
});

describe('bounded file writes', () => {
  test('measures multibyte content by UTF-8 bytes at the exact boundary', () => {
    const content = '你'.repeat(21_845) + 'a';
    const prepared = prepareWritableFile(content);
    expect(prepared.bytes).toBe(MAX_WRITABLE_FILE_BYTES);
    expect(prepared.remainingBytes).toBe(0);
    expect(prepared.base64.length).toBeLessThan(128 * 1024);
  });

  test('rejects oversized content before invoking the write transport', async () => {
    let calls = 0;
    await expect(writeBoundedFile('你'.repeat(21_846), '/workspace/a', async () => { calls++; })).rejects.toThrow('65536');
    expect(calls).toBe(0);
  });

  test('passes bounded base64 and path as separate argv values', async () => {
    let received;
    await writeBoundedFile('你好', '/workspace/a;$(bad)', async (base64, path) => { received = [base64, path]; });
    expect(received).toEqual(['5L2g5aW9', '/workspace/a;$(bad)']);
  });
});

describe('parseDirectoryListing', () => {
  test('parses newline-delimited names without trimming whitespace', () => {
    expect(parseDirectoryListing('d\tdir\nf\t spaced file \n', '/workspace')).toEqual([
      { name: 'dir', isDir: true, fullPath: '/workspace/dir' },
      { name: ' spaced file ', isDir: false, fullPath: '/workspace/ spaced file ' },
    ]);
  });

  test('discards a final unterminated record after directory output is cut', () => {
    expect(parseDirectoryListing('d\tdocs\nf\tpartial', '/workspace')).toEqual([
      { name: 'docs', isDir: true, fullPath: '/workspace/docs' },
    ]);
  });
});

describe('formatExecError', () => {
  test('prefers stderr and falls back to the operation label', () => {
    expect(formatExecError('find: Permission denied\n', '列出目录失败')).toBe('find: Permission denied');
    expect(formatExecError('', '读取文件失败')).toBe('读取文件失败');
  });
});

describe('isAbortError', () => {
  test('recognizes aborted requests without surfacing an error toast', () => {
    expect(isAbortError(new DOMException('cancelled', 'AbortError'))).toBe(true);
    expect(isAbortError(new Error('network failed'))).toBe(false);
  });
});

describe('v2 sandbox file browser requests', () => {
  const source = readFileSync(new URL('./FileBrowser.svelte', import.meta.url), 'utf8');

  test('uses bounded ExecStream requests addressed by sandbox id', () => {
    expect(source).toContain('execService.execStream');
    expect(source).toContain("target: { case: 'sandboxId', value: sandboxId }");
    expect(source).toContain('DIRECTORY_LIST_BYTES');
    expect(source).toContain('FILE_PREVIEW_BYTES');
    expect(source).toContain('AbortController');
    expect(source).toContain("'%y\\t%f\\n'");
    expect(source).not.toContain("'%y\\t%f\\0'");
  });

  test('passes paths as argv and never interpolates them into shell source', () => {
    expect(source).toContain("stream('/usr/bin/find', [path");
    expect(source).toContain("stream('/bin/cat', ['--', entry.fullPath]");
    expect(source).toContain("['--', entry.fullPath]");
    expect(source).not.toMatch(/`[^`]*\$\{(?:path|currentPath|sandboxId)\}/);
  });

  test('shows explicit dirty, saving, saved, and failed write states', () => {
    expect(source).toContain("type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'failed'");
    expect(source).toContain("saveState = 'saving'");
    expect(source).toContain("saveState = 'saved'");
    expect(source).toContain("saveState = 'failed'");
    expect(source).toContain("saveState = 'dirty'");
    expect(source).toContain('保存中…');
    expect(source).toContain('已保存');
    expect(source).toContain('保存失败');
    expect(source).toContain('超过写入上限');
    expect(source).toContain("writeBytes > MAX_WRITABLE_FILE_BYTES ? '无法保存'");
  });
});
