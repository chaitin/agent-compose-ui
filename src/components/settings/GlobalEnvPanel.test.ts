import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, expect, test, vi } from 'vitest';
import GlobalEnvPanel from './GlobalEnvPanel.svelte';
import componentSource from './GlobalEnvPanel.svelte?raw';

const mocks = vi.hoisted(() => ({ settingsService: { getGlobalEnv: vi.fn(), updateGlobalEnv: vi.fn() } }));
vi.mock('../../lib/rpc', () => ({ settingsService: mocks.settingsService }));

beforeEach(() => vi.clearAllMocks());

const loaded = [
  { name: 'REGION', value: 'east', secret: false },
  { name: 'ZONE', value: 'one', secret: false },
  { name: 'TOKEN', value: '', secret: true },
];

async function openEditor() {
  const modify = await screen.findByRole('button', { name: '修改变量' });
  await fireEvent.click(modify);
  return screen.getByRole('dialog', { name: '环境变量' });
}

test('offers one entry action and opens every loaded row safely', async () => {
  mocks.settingsService.getGlobalEnv.mockResolvedValue({ env: loaded });
  render(GlobalEnvPanel);
  const modify = await screen.findByRole('button', { name: '修改变量' });
  expect(screen.getByRole('heading', { name: '全局环境变量' })).toBeInTheDocument();
  expect(screen.queryByText('DAEMON SCOPE')).not.toBeInTheDocument();
  expect(modify).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '新增变量' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '保存环境变量' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^编辑 / })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^删除 / })).not.toBeInTheDocument();
  await fireEvent.click(modify);
  expect(screen.getByLabelText('变量名称 1')).toHaveValue('REGION');
  expect(screen.getByLabelText('变量值 1')).toHaveValue('east');
  expect(screen.getByLabelText('敏感变量 1')).not.toBeChecked();
  expect(screen.getByRole('button', { name: '删除变量 1' })).toBeInTheDocument();
  expect(screen.getByLabelText('变量名称 3')).toHaveValue('TOKEN');
  expect(screen.getByLabelText('变量值 3')).toHaveValue('');
  expect(screen.getByLabelText('敏感变量 3')).toBeChecked();
});

test('shows non-secret values in the read-only list and masks stored secrets', async () => {
  mocks.settingsService.getGlobalEnv.mockResolvedValue({ env: [
    ...loaded.slice(0, 2),
    { name: 'TOKEN', value: 'server-secret-must-not-render', secret: true },
  ] });
  render(GlobalEnvPanel);

  expect(await screen.findByText('east')).toBeInTheDocument();
  expect(screen.getByText('one')).toBeInTheDocument();
  expect(screen.getByText('••••••••')).toBeInTheDocument();
  expect(screen.queryByText('server-secret-must-not-render')).not.toBeInTheDocument();
});

test('appends an empty row from the dialog add button', async () => {
  mocks.settingsService.getGlobalEnv.mockResolvedValue({ env: [loaded[0]] });
  render(GlobalEnvPanel);
  const dialog = await openEditor();
  expect(dialog).toHaveClass('viewport-modal');
  await fireEvent.click(within(dialog).getByRole('button', { name: '新增变量' }));
  expect(screen.getByLabelText('变量名称 2')).toHaveValue('');
  expect(screen.getByLabelText('变量值 2')).toHaveValue('');
});

test('places cancel in the header, add below the rows, and only save in the footer', async () => {
  mocks.settingsService.getGlobalEnv.mockResolvedValue({ env: [loaded[0]] });
  render(GlobalEnvPanel);
  const dialog = await openEditor();
  const header = within(dialog).getByRole('banner');
  const content = within(dialog).getByTestId('environment-editor-content');
  const footer = within(dialog).getByRole('contentinfo');

  expect(within(header).getByRole('button', { name: '取消本次编辑' })).toHaveTextContent('×');
  expect(within(content).getByRole('button', { name: '新增变量' })).toHaveTextContent('+');
  expect(within(footer).getAllByRole('button')).toHaveLength(1);
  expect(within(footer).getByRole('button', { name: '保存' })).toBeInTheDocument();
  expect(within(footer).queryByRole('button', { name: '取消' })).not.toBeInTheDocument();
});

test('keeps the dialog viewport-centered and its narrow header horizontally aligned', () => {
  expect(componentSource).toMatch(/dialog\.viewport-modal\{[^}]*position:fixed;[^}]*inset:0;[^}]*margin:auto;/);
  expect(componentSource).toMatch(/@media\(max-width:600px\)\{\.panel > header\{[^}]*flex-direction:column[^}]*\}[^}]*\.dialog-title\{[^}]*flex-direction:row;[^}]*justify-content:space-between;/);
});

test('contains long values and progressively reflows editor rows on narrow viewports', () => {
  expect(componentSource).toMatch(/dialog\.viewport-modal\{[^}]*box-sizing:border-box/);
  expect(componentSource).toMatch(/dialog input\{[^}]*box-sizing:border-box;[^}]*width:100%;[^}]*min-width:0/);
  expect(componentSource).toMatch(/\.row\{[^}]*min-width:0/);
  expect(componentSource).toMatch(/\.name\{[^}]*min-width:0;[^}]*overflow:hidden;[^}]*text-overflow:ellipsis;[^}]*white-space:nowrap/);
  expect(componentSource).toMatch(/\.value\{[^}]*flex:1 1 auto;[^}]*min-width:0/);
  expect(componentSource).toMatch(/\.editor-row>\*\{[^}]*min-width:0/);
  expect(componentSource).toMatch(/@media\(max-width:900px\)[\s\S]*\.editor-row\{[^}]*grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/);
  expect(componentSource).toMatch(/@media\(max-width:600px\)[\s\S]*\.editor-row\{[^}]*grid-template-columns:minmax\(0,1fr\)/);
});

test('saves two inline modifications in one replacement request', async () => {
  mocks.settingsService.getGlobalEnv.mockResolvedValue({ env: loaded });
  mocks.settingsService.updateGlobalEnv.mockResolvedValue({ env: [
    { ...loaded[0], value: 'west' }, { ...loaded[1], value: 'two' }, loaded[2],
  ] });
  render(GlobalEnvPanel);
  await openEditor();
  await fireEvent.input(screen.getByLabelText('变量值 1'), { target: { value: 'west' } });
  await fireEvent.input(screen.getByLabelText('变量值 2'), { target: { value: 'two' } });
  await fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(mocks.settingsService.updateGlobalEnv).toHaveBeenCalledTimes(1));
  expect(mocks.settingsService.updateGlobalEnv.mock.calls[0][0].env).toEqual([
    expect.objectContaining({ name: 'REGION', value: 'west', secret: false }),
    expect.objectContaining({ name: 'ZONE', value: 'two', secret: false }),
    expect.objectContaining({ name: 'TOKEN', value: undefined, secret: true }),
  ]);
  expect(screen.queryByRole('dialog', { name: '环境变量' })).not.toBeInTheDocument();
});

test('deletes only from the modal draft and omits the row on save', async () => {
  mocks.settingsService.getGlobalEnv.mockResolvedValue({ env: loaded });
  mocks.settingsService.updateGlobalEnv.mockResolvedValue({ env: loaded.slice(1) });
  render(GlobalEnvPanel);
  await openEditor();
  await fireEvent.click(screen.getByRole('button', { name: '删除变量 1' }));
  await fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(mocks.settingsService.updateGlobalEnv).toHaveBeenCalled());
  expect(mocks.settingsService.updateGlobalEnv.mock.calls[0][0].env.map((row: { name: string }) => row.name)).toEqual(['ZONE', 'TOKEN']);
});

test('discards add, edit, and delete drafts from the header cancel action', async () => {
  mocks.settingsService.getGlobalEnv.mockResolvedValue({ env: loaded });
  render(GlobalEnvPanel);
  await openEditor();
  await fireEvent.input(screen.getByLabelText('变量值 1'), { target: { value: 'changed' } });
  await fireEvent.click(screen.getByRole('button', { name: '删除变量 2' }));
  await fireEvent.click(screen.getByRole('button', { name: '新增变量' }));
  await fireEvent.click(screen.getByRole('button', { name: '取消本次编辑' }));
  await openEditor();
  expect(screen.getByLabelText('变量值 1')).toHaveValue('east');
  expect(screen.getByLabelText('变量名称 2')).toHaveValue('ZONE');
  expect(screen.getByLabelText('变量名称 3')).toHaveValue('TOKEN');
  expect(mocks.settingsService.updateGlobalEnv).not.toHaveBeenCalled();
});

test('dialog cancel event discards drafts and restores trigger focus', async () => {
  mocks.settingsService.getGlobalEnv.mockResolvedValue({ env: loaded });
  render(GlobalEnvPanel);
  const trigger = await screen.findByRole('button', { name: '修改变量' });
  trigger.focus();
  const dialog = await openEditor();
  expect(screen.getByLabelText('变量名称 1')).toHaveFocus();
  await fireEvent.input(screen.getByLabelText('变量值 1'), { target: { value: 'changed' } });
  await fireEvent(dialog, new Event('cancel', { cancelable: true }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '环境变量' })).not.toBeInTheDocument());
  expect(trigger).toHaveFocus();
  await fireEvent.click(trigger);
  expect(screen.getByLabelText('变量值 1')).toHaveValue('east');
});

test('keeps every inline draft in the open dialog when save fails', async () => {
  mocks.settingsService.getGlobalEnv.mockResolvedValue({ env: loaded });
  mocks.settingsService.updateGlobalEnv.mockRejectedValue(new Error('save failed'));
  render(GlobalEnvPanel);
  await openEditor();
  await fireEvent.input(screen.getByLabelText('变量值 1'), { target: { value: 'changed' } });
  await fireEvent.click(screen.getByRole('button', { name: '删除变量 2' }));
  await fireEvent.click(screen.getByRole('button', { name: '新增变量' }));
  await fireEvent.input(screen.getByLabelText('变量名称 3'), { target: { value: 'EXTRA' } });
  await fireEvent.input(screen.getByLabelText('变量值 3'), { target: { value: 'new' } });
  await fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('save failed');
  expect(screen.getByRole('dialog', { name: '环境变量' })).toBeInTheDocument();
  expect(screen.getByLabelText('变量值 1')).toHaveValue('changed');
  expect(screen.getByLabelText('变量名称 2')).toHaveValue('TOKEN');
  expect(screen.getByLabelText('变量名称 3')).toHaveValue('EXTRA');
});

test.each([
  ['blank name', '变量名称 1', '   ', '变量名称不能为空'],
  ['duplicate name', '变量名称 2', 'REGION', '变量名称不能重复'],
  ['new blank value', 'new', '', '变量值不能为空'],
])('validates the entire draft: %s', async (_case, field, value, message) => {
  mocks.settingsService.getGlobalEnv.mockResolvedValue({ env: loaded.slice(0, 2) });
  render(GlobalEnvPanel);
  await openEditor();
  if (field === 'new') {
    await fireEvent.click(screen.getByRole('button', { name: '新增变量' }));
    await fireEvent.input(screen.getByLabelText('变量名称 3'), { target: { value: 'EXTRA' } });
  } else await fireEvent.input(screen.getByLabelText(field), { target: { value } });
  await fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(screen.getByRole('alert')).toHaveTextContent(message);
  expect(mocks.settingsService.updateGlobalEnv).not.toHaveBeenCalled();
});

test('requires a replacement when a stored secret identity or kind changes', async () => {
  mocks.settingsService.getGlobalEnv.mockResolvedValue({ env: [loaded[2]] });
  render(GlobalEnvPanel);
  await openEditor();
  await fireEvent.input(screen.getByLabelText('变量名称 1'), { target: { value: 'RENAMED' } });
  await fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(screen.getByRole('alert')).toHaveTextContent('变量值不能为空');
});
