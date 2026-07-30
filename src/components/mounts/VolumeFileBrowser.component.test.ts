import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import VolumeFileBrowser from './VolumeFileBrowser.svelte';
import { volumeFileApi } from '../../lib/volume-files/api';

vi.mock('../../lib/volume-files/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/volume-files/api')>('../../lib/volume-files/api');
  return { ...actual, volumeFileApi: { list: vi.fn(), preview: vi.fn(), write: vi.fn(), upload: vi.fn(), mkdir: vi.fn(), removeFile: vi.fn(), removeFolder: vi.fn(), downloadURL: vi.fn() } };
});
const KEY_A = 'ws_0123456789abcdef0123456789abcdef'; const KEY_B = 'ws_fedcba9876543210fedcba9876543210';
const file = { name: 'a.txt', path: 'a.txt', dir: false, size: 1, mtimeMs: 1 };
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => { vi.mocked(volumeFileApi.list).mockReset().mockResolvedValue([file]); vi.mocked(volumeFileApi.preview).mockReset().mockResolvedValue({ path: 'a.txt', content: 'hello', sha256: 'a'.repeat(64), truncated: false }); vi.mocked(volumeFileApi.write).mockReset(); vi.mocked(volumeFileApi.upload).mockReset(); vi.mocked(volumeFileApi.mkdir).mockReset(); vi.mocked(volumeFileApi.removeFile).mockReset(); vi.mocked(volumeFileApi.removeFolder).mockReset(); vi.mocked(volumeFileApi.downloadURL).mockReset().mockReturnValue('/download'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('lists, previews and provides a download link without physical paths', async () => {
  render(VolumeFileBrowser, { projectKey: KEY_A, volume: 'managed' });
  await fireEvent.click(await screen.findByRole('button', { name: 'a.txt' }));
  expect(await screen.findByRole('textbox', { name: '文件内容' })).toHaveValue('hello');
  expect(screen.getByRole('link', { name: '下载' })).toHaveAttribute('href', '/download');
  expect(document.body.textContent).not.toContain('/data/volumes');
});

test('creates folders, uploads and confirms deletion', async () => {
  render(VolumeFileBrowser, { projectKey: KEY_A, volume: 'managed' }); await screen.findByText('a.txt');
  await fireEvent.input(screen.getByLabelText('新建文件夹'), { target: { value: 'docs' } }); await fireEvent.click(screen.getByRole('button', { name: '创建文件夹' }));
  expect(volumeFileApi.mkdir).toHaveBeenCalledWith(KEY_A, 'managed', 'docs', expect.any(AbortSignal));
  const input = screen.getByLabelText('上传文件'); await fireEvent.change(input, { target: { files: [new File(['x'], 'x.txt')] } });
  await waitFor(() => expect(volumeFileApi.upload).toHaveBeenCalled());
  await fireEvent.click(screen.getByRole('button', { name: '删除 a.txt' })); const dialog = screen.getByRole('dialog');
  expect(volumeFileApi.removeFile).not.toHaveBeenCalled(); await fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(volumeFileApi.removeFile).toHaveBeenCalledWith(KEY_A, 'managed', 'a.txt', expect.any(AbortSignal)));
});

test('suppresses stale list and preview responses after identity switch', async () => {
  const old = deferred<typeof file[]>(); vi.mocked(volumeFileApi.list).mockReturnValueOnce(old.promise).mockResolvedValueOnce([{ ...file, name: 'new.txt', path: 'new.txt' }]);
  const view = render(VolumeFileBrowser, { projectKey: KEY_A, volume: 'one' });
  await view.rerender({ projectKey: KEY_B, volume: 'two' }); expect(await screen.findByText('new.txt')).toBeInTheDocument(); old.resolve([file]);
  await Promise.resolve(); expect(screen.queryByText('a.txt')).not.toBeInTheDocument();
});

test('suppresses a deferred preview content and error after project and volume switch', async () => {
  const pending = deferred<Awaited<ReturnType<typeof volumeFileApi.preview>>>();
  vi.mocked(volumeFileApi.preview).mockReturnValueOnce(pending.promise);
  const view = render(VolumeFileBrowser, { projectKey: KEY_A, volume: 'one' });
  await fireEvent.click(await screen.findByRole('button', { name: 'a.txt' }));
  await view.rerender({ projectKey: KEY_B, volume: 'two' });
  await screen.findByText('a.txt');
  pending.resolve({ path: 'a.txt', content: 'stale secret', sha256: 'a'.repeat(64), truncated: false });
  await Promise.resolve();
  expect(screen.queryByDisplayValue('stale secret')).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('warns that folder deletion is recursive and only removes it after confirmation', async () => {
  const folder = { name: 'docs', path: 'docs', dir: true, size: 0, mtimeMs: 1 };
  vi.mocked(volumeFileApi.list).mockResolvedValue([folder]);
  render(VolumeFileBrowser, { projectKey: KEY_A, volume: 'managed' });
  await fireEvent.click(await screen.findByRole('button', { name: '删除 docs' }));
  const dialog = screen.getByRole('dialog', { name: '确认删除' });
  expect(dialog).toHaveTextContent('文件夹将递归删除');
  expect(volumeFileApi.removeFolder).not.toHaveBeenCalled();
  await fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(volumeFileApi.removeFolder).toHaveBeenCalledWith(KEY_A, 'managed', 'docs', true, expect.any(AbortSignal)));
});

test('shows actionable conflict messaging', async () => {
  const { VolumeFileApiError } = await import('../../lib/volume-files/api'); vi.mocked(volumeFileApi.removeFile).mockRejectedValue(new VolumeFileApiError(409, 'conflict', 'resource conflict'));
  render(VolumeFileBrowser, { projectKey: KEY_A, volume: 'managed' }); await screen.findByText('a.txt'); await fireEvent.click(screen.getByRole('button', { name: '删除 a.txt' })); await fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认删除' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('冲突'); expect(screen.getByRole('button', { name: '重新加载' })).toBeInTheDocument();
});

test('a mutation invalidates an older preview and ignores its late completion', async () => {
  const pending = deferred<Awaited<ReturnType<typeof volumeFileApi.preview>>>(); vi.mocked(volumeFileApi.preview).mockReturnValue(pending.promise);
  render(VolumeFileBrowser, { projectKey: KEY_A, volume: 'managed' }); await fireEvent.click(await screen.findByRole('button', { name: 'a.txt' }));
  await fireEvent.input(screen.getByLabelText('新建文件夹'), { target: { value: 'docs' } }); await fireEvent.click(screen.getByRole('button', { name: '创建文件夹' }));
  pending.resolve({ path: 'a.txt', content: 'late preview', sha256: 'a'.repeat(64), truncated: false }); await Promise.resolve();
  expect(screen.queryByDisplayValue('late preview')).not.toBeInTheDocument(); expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('serializes mutations and disables later operations until the first settles', async () => {
  const oldMutation = deferred<void>();
  vi.mocked(volumeFileApi.mkdir).mockReturnValueOnce(oldMutation.promise);
  render(VolumeFileBrowser, { projectKey: KEY_A, volume: 'managed' }); await screen.findByText('a.txt');
  const folder = screen.getByLabelText('新建文件夹'); await fireEvent.input(folder, { target: { value: 'old' } }); await fireEvent.click(screen.getByRole('button', { name: '创建文件夹' }));
  expect(screen.getByRole('button', { name: '创建文件夹' })).toBeDisabled();
  expect(screen.getByLabelText('上传文件')).toBeDisabled();
  expect(screen.getByRole('button', { name: '删除 a.txt' })).toBeDisabled();
  await fireEvent.click(screen.getByRole('button', { name: '创建文件夹' }));
  expect(volumeFileApi.mkdir).toHaveBeenCalledOnce(); oldMutation.resolve();
  await waitFor(() => expect(screen.getByRole('button', { name: '创建文件夹' })).toBeEnabled());
});

test('keeps a failed folder name and resets upload input after failure for same-file retry', async () => {
  vi.mocked(volumeFileApi.mkdir).mockRejectedValueOnce(new Error('mkdir failed')); vi.mocked(volumeFileApi.upload).mockRejectedValue(new Error('upload failed'));
  render(VolumeFileBrowser, { projectKey: KEY_A, volume: 'managed' }); await screen.findByText('a.txt');
  const folder = screen.getByLabelText('新建文件夹'); await fireEvent.input(folder, { target: { value: 'docs' } }); await fireEvent.click(screen.getByRole('button', { name: '创建文件夹' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('mkdir failed'); expect(folder).toHaveValue('docs');
  const input = screen.getByLabelText('上传文件') as HTMLInputElement; const selected = new File(['x'], 'same.txt'); await fireEvent.change(input, { target: { files: [selected] } });
  await waitFor(() => expect(volumeFileApi.upload).toHaveBeenCalledTimes(1)); expect(input.value).toBe('');
  await fireEvent.change(input, { target: { files: [selected] } }); await waitFor(() => expect(volumeFileApi.upload).toHaveBeenCalledTimes(2));
});

test('saves edited preview with CAS and refreshes content and checksum', async () => {
  vi.mocked(volumeFileApi.write).mockResolvedValue({ ...file, sha256: 'b'.repeat(64) });
  vi.mocked(volumeFileApi.preview).mockResolvedValueOnce({ path: 'a.txt', content: 'hello', sha256: 'a'.repeat(64), truncated: false })
    .mockResolvedValueOnce({ path: 'a.txt', content: 'changed', sha256: 'b'.repeat(64), truncated: false });
  render(VolumeFileBrowser, { projectKey: KEY_A, volume: 'managed' });
  await fireEvent.click(await screen.findByRole('button', { name: 'a.txt' }));
  const editor = await screen.findByRole('textbox', { name: '文件内容' });
  await fireEvent.input(editor, { target: { value: 'changed' } });
  await fireEvent.click(screen.getByRole('button', { name: '保存文件' }));
  await waitFor(() => expect(volumeFileApi.write).toHaveBeenCalledWith(KEY_A, 'managed', 'a.txt', 'changed', 'a'.repeat(64), expect.any(AbortSignal)));
  await waitFor(() => expect(volumeFileApi.preview).toHaveBeenCalledTimes(2));
  expect(editor).toHaveValue('changed');
});

test('preserves the draft on CAS conflict and supports reload then retry', async () => {
  vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
  const { VolumeFileApiError } = await import('../../lib/volume-files/api');
  vi.mocked(volumeFileApi.write).mockRejectedValueOnce(new VolumeFileApiError(409, 'content_conflict', 'changed elsewhere')).mockResolvedValueOnce({ ...file, sha256: 'c'.repeat(64) });
  vi.mocked(volumeFileApi.preview).mockResolvedValueOnce({ path: 'a.txt', content: 'hello', sha256: 'a'.repeat(64), truncated: false })
    .mockResolvedValueOnce({ path: 'a.txt', content: 'theirs', sha256: 'b'.repeat(64), truncated: false });
  render(VolumeFileBrowser, { projectKey: KEY_A, volume: 'managed' });
  await fireEvent.click(await screen.findByRole('button', { name: 'a.txt' }));
  const editor = await screen.findByRole('textbox', { name: '文件内容' });
  await fireEvent.input(editor, { target: { value: 'mine' } });
  await fireEvent.click(screen.getByRole('button', { name: '保存文件' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('冲突');
  expect(editor).toHaveValue('mine');
  await fireEvent.click(screen.getByRole('button', { name: '重新加载文件' }));
  await waitFor(() => expect(editor).toHaveValue('theirs'));
  await fireEvent.input(editor, { target: { value: 'retry' } });
  await fireEvent.click(screen.getByRole('button', { name: '保存文件' }));
  await waitFor(() => expect(volumeFileApi.write).toHaveBeenLastCalledWith(KEY_A, 'managed', 'a.txt', 'retry', 'b'.repeat(64), expect.any(AbortSignal)));
});

test('requires confirmation before user navigation discards a dirty draft', async () => {
  const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true); vi.stubGlobal('confirm', confirm);
  render(VolumeFileBrowser, { projectKey: KEY_A, volume: 'managed' });
  await fireEvent.click(await screen.findByRole('button', { name: 'a.txt' }));
  await fireEvent.input(screen.getByRole('textbox', { name: '文件内容' }), { target: { value: 'mine' } });
  await fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
  expect(confirm).toHaveBeenCalledOnce(); expect(volumeFileApi.list).toHaveBeenCalledOnce();
  await fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
  await waitFor(() => expect(volumeFileApi.list).toHaveBeenCalledTimes(2));
});

test('resets saving state on identity invalidation and disables editing while save is active', async () => {
  const pending = deferred<Awaited<ReturnType<typeof volumeFileApi.write>>>(); vi.mocked(volumeFileApi.write).mockReturnValue(pending.promise);
  const view = render(VolumeFileBrowser, { projectKey: KEY_A, volume: 'managed' });
  await fireEvent.click(await screen.findByRole('button', { name: 'a.txt' }));
  const editor = screen.getByRole('textbox', { name: '文件内容' }); await fireEvent.input(editor, { target: { value: 'mine' } });
  await fireEvent.click(screen.getByRole('button', { name: '保存文件' })); expect(editor).toBeDisabled();
  await view.rerender({ projectKey: KEY_B, volume: 'other' });
  await screen.findByText('a.txt'); expect(screen.getByRole('button', { name: '重新加载' })).toBeEnabled();
  pending.resolve({ ...file, sha256: 'b'.repeat(64) }); await Promise.resolve();
  expect(screen.queryByDisplayValue('mine')).not.toBeInTheDocument();
});
