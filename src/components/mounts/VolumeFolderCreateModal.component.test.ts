import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';
import VolumeFolderCreateModal from './VolumeFolderCreateModal.svelte';

function setup(overrides: Record<string, unknown> = {}) {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  render(VolumeFolderCreateModal, {
    value: '', busy: false, onValue: vi.fn(), onSubmit, onClose, ...overrides,
  });
  return { onSubmit, onClose };
}

test('uses the script command-modal layout and disables blank submission', () => {
  setup();
  expect(screen.getByRole('dialog', { name: '新建文件夹' })).toBeInTheDocument();
  expect(screen.getByText('VOLUME / CREATE')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '创建' })).toBeDisabled();
});

test('submits a trimmed name through the form and closes with Escape', async () => {
  const { onSubmit, onClose } = setup({ value: ' docs ' });
  await fireEvent.submit(screen.getByRole('form', { name: '新建文件夹表单' }));
  expect(onSubmit).toHaveBeenCalledWith('docs');
  await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(onClose).toHaveBeenCalledOnce();
});

test('does not dismiss while busy', async () => {
  const { onClose } = setup({ value: 'docs', busy: true });
  await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  await fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(onClose).not.toHaveBeenCalled();
});
