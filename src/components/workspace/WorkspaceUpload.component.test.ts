import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import WorkspaceUpload from './WorkspaceUpload.svelte';
import { workspaceFiles } from '../../lib/workspace/store.svelte';
import { store } from '../../lib/stores.svelte';

type UploadStore = Pick<typeof workspaceFiles, 'hasFile' | 'upload'>;

function folderFile(path: string): File {
  const file = new File(['content'], path.split('/').at(-1) ?? 'file');
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}

function folderInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[webkitdirectory]') as HTMLInputElement;
}

function customFiles(existing: string[] = []): UploadStore {
  return {
    hasFile: vi.fn((path: string) => existing.includes(path)),
    upload: vi.fn(async () => []),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WorkspaceUpload file store reuse', () => {
  test('uses workspaceFiles by default and preserves the selected folder root', async () => {
    const hasFile = vi.spyOn(workspaceFiles, 'hasFile').mockReturnValue(false);
    const upload = vi.spyOn(workspaceFiles, 'upload').mockResolvedValue([]);
    const { container } = render(WorkspaceUpload);

    await fireEvent.change(folderInput(container), {
      target: { files: [folderFile('selected-project/docker/Dockerfile')] },
    });

    await waitFor(() => expect(upload).toHaveBeenCalled());
    expect(hasFile).toHaveBeenCalledWith('selected-project/docker/Dockerfile');
    expect(upload).toHaveBeenCalledWith(
      expect.any(File),
      'selected-project/docker/Dockerfile',
      expect.any(Function),
    );
  });

  test('uses the supplied file store and strips only the folder root when requested', async () => {
    const files = customFiles();
    const { container } = render(WorkspaceUpload, {
      files,
      locationLabel: 'project image files',
      stripFolderRoot: true,
    });

    await fireEvent.change(folderInput(container), {
      target: { files: [folderFile('selected-project/docker/Dockerfile')] },
    });

    await waitFor(() => expect(files.upload).toHaveBeenCalled());
    expect(files.hasFile).toHaveBeenCalledWith('docker/Dockerfile');
    expect(files.upload).toHaveBeenCalledWith(expect.any(File), 'docker/Dockerfile', expect.any(Function));
  });

  test('uses locationLabel in the overwrite prompt and uploads through the supplied store', async () => {
    const files = customFiles(['Dockerfile']);
    const { container } = render(WorkspaceUpload, {
      files,
      locationLabel: 'project image files',
    });
    const input = container.querySelector('input[type="file"]:not([webkitdirectory])') as HTMLInputElement;

    await fireEvent.change(input, { target: { files: [new File(['FROM scratch'], 'Dockerfile')] } });

    expect(await screen.findByText(/已存在于 project image files/)).toBeInTheDocument();
    expect(files.hasFile).toHaveBeenCalledWith('Dockerfile');
    expect(files.upload).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: '覆盖' }));
    await waitFor(() => expect(files.upload).toHaveBeenCalledWith(
      expect.any(File),
      'Dockerfile',
      expect.any(Function),
    ));
  });

  test('rejects folder selections with different roots when stripping the root', async () => {
    const files = customFiles();
    const toast = vi.spyOn(store, 'addToast');
    const { container } = render(WorkspaceUpload, { files, stripFolderRoot: true });

    await fireEvent.change(folderInput(container), {
      target: { files: [folderFile('project-a/a.txt'), folderFile('project-b/b.txt')] },
    });

    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/同一个顶层目录/), 'error');
    expect(files.hasFile).not.toHaveBeenCalled();
    expect(files.upload).not.toHaveBeenCalled();
  });

  test('rejects folder entries that sanitize to the same target path', async () => {
    const files = customFiles();
    const toast = vi.spyOn(store, 'addToast');
    const { container } = render(WorkspaceUpload, { files, stripFolderRoot: true });

    await fireEvent.change(folderInput(container), {
      target: {
        files: [
          folderFile('selected-project/docker/Dockerfile'),
          folderFile('selected-project/docker\\Dockerfile'),
        ],
      },
    });

    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/目标路径重复.*docker\/Dockerfile/), 'error');
    expect(files.hasFile).not.toHaveBeenCalled();
    expect(files.upload).not.toHaveBeenCalled();
  });
});
