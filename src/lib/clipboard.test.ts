import { afterEach, expect, test, vi } from 'vitest';
import { copyText } from './clipboard';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('uses the Clipboard API when it is available', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });

  await copyText('hello');

  expect(writeText).toHaveBeenCalledWith('hello');
});

test('falls back to a selected textarea when Clipboard API rejects', async () => {
  const writeText = vi.fn().mockRejectedValue(new Error('permission denied'));
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const execCommand = vi.fn().mockReturnValue(true);
  Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });

  await copyText('fallback text');

  expect(execCommand).toHaveBeenCalledWith('copy');
  expect(document.querySelector('textarea[data-clipboard-fallback]')).toBeNull();
});

test('reports failure when neither copy mechanism succeeds', async () => {
  vi.stubGlobal('navigator', {});
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn().mockReturnValue(false) });

  await expect(copyText('cannot copy')).rejects.toThrow('clipboard copy failed');
});
