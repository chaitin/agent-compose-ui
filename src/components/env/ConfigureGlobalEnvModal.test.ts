import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, expect, test, vi } from 'vitest';
import ConfigureGlobalEnvModal from './ConfigureGlobalEnvModal.svelte';

const mocks = vi.hoisted(() => ({ settingsService: { getGlobalEnv: vi.fn(), updateGlobalEnv: vi.fn() } }));
vi.mock('../../lib/rpc', () => ({ settingsService: mocks.settingsService }));
beforeEach(() => vi.clearAllMocks());

test('merges new values into the latest global snapshot and preserves stored secrets', async () => {
  mocks.settingsService.getGlobalEnv.mockResolvedValue({ env: [
    { name: 'REGION', value: 'east', secret: false },
    { name: 'STORED_TOKEN', value: '', secret: true },
  ] });
  mocks.settingsService.updateGlobalEnv.mockResolvedValue({ env: [] });
  const onSaved = vi.fn();
  render(ConfigureGlobalEnvModal, { agentName: 'coder', names: ['OPENAI_API_KEY', 'HOST'], onSaved, onCancel: vi.fn() });

  await fireEvent.input(await screen.findByLabelText('变量值 1'), { target: { value: 'secret-value' } });
  await fireEvent.input(screen.getByLabelText('变量值 2'), { target: { value: 'api.example.com' } });
  await fireEvent.click(screen.getByRole('button', { name: '保存' }));

  await waitFor(() => expect(mocks.settingsService.updateGlobalEnv).toHaveBeenCalledOnce());
  const env = mocks.settingsService.updateGlobalEnv.mock.calls[0][0].env;
  expect(env.map((item: { name: string }) => item.name)).toEqual(['REGION', 'STORED_TOKEN', 'OPENAI_API_KEY', 'HOST']);
  expect(env[1].value).toBeUndefined();
  expect(env[2]).toMatchObject({ name: 'OPENAI_API_KEY', value: 'secret-value', secret: true });
  expect(onSaved).toHaveBeenCalledWith(['OPENAI_API_KEY', 'HOST']);
});

test('does not overwrite a variable that appeared before save', async () => {
  mocks.settingsService.getGlobalEnv.mockResolvedValue({ env: [{ name: 'HOST', value: 'other-value', secret: false }] });
  const onSaved = vi.fn();
  render(ConfigureGlobalEnvModal, { agentName: 'coder', names: ['HOST'], onSaved, onCancel: vi.fn() });
  await fireEvent.input(await screen.findByLabelText('变量值 1'), { target: { value: 'mine' } });
  await fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(['HOST']));
  expect(mocks.settingsService.updateGlobalEnv).not.toHaveBeenCalled();
});
