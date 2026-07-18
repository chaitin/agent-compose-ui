import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';
import ScriptPanel from './ScriptPanel.svelte';
import { createScriptWorkspace } from '../../lib/scripts/workspace.svelte';

vi.mock('./ScriptEditor.svelte', async () => ({
  default: (await import('../../test/fixtures/ScriptEditorStub.svelte')).default,
}));

test('opens the new-script dialog when no script is selected', async () => {
  const workspace = createScriptWorkspace({
    listTree: async () => ({ kind: 'directory', name: '', path: '', children: [] }),
    readFile: vi.fn(), writeFile: vi.fn(), createFolder: vi.fn(), deleteFile: vi.fn(), deleteFolder: vi.fn(),
  });
  workspace.panelOpen = true;
  render(ScriptPanel, { workspace });

  expect(workspace.activeFile).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: '新建脚本' }));

  expect(screen.getByRole('dialog')).toHaveTextContent('新建脚本文件');
});
