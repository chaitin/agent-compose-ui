import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import RunAgentModal from './RunAgentModal.svelte';
import { RunSummary, Sandbox } from '../gen/agentcompose/v2/agentcompose_pb';

const mocks = vi.hoisted(() => ({
  runService: { listRuns: vi.fn(), startRun: vi.fn(), runAgentStream: vi.fn(), runAttach: vi.fn(), stopRun: vi.fn() },
  sandboxService: { listSandboxes: vi.fn() },
  store: { activeProjectId: 'project-1', addToast: vi.fn(), navigateTo: vi.fn() },
}));
vi.mock('../lib/rpc', () => ({ runService: mocks.runService, sandboxService: mocks.sandboxService }));
vi.mock('../lib/stores.svelte', () => ({ store: mocks.store }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runService.listRuns.mockResolvedValue({ runs: [
    new RunSummary({ runId: 'run-old', agentName: 'worker', sandboxId: 'sandbox-1', updatedAt: '2026-07-14T00:00:00Z' }),
  ] });
  mocks.runService.startRun.mockResolvedValue({ run: new RunSummary({ runId: 'run-new' }) });
  mocks.runService.runAgentStream.mockImplementation(async function* () {});
  mocks.sandboxService.listSandboxes.mockResolvedValue({ sandboxes: [], nextCursor: '' });
});
afterEach(() => vi.useRealTimers());

async function flushAsync() { for (let index = 0; index < 8; index++) await Promise.resolve(); }
async function setMode(mode: string) {
  await fireEvent.change(screen.getByLabelText('输入模式'), { target: { value: mode } });
  await flushAsync();
}
async function setInput(value: string) {
  await fireEvent.input(screen.getByLabelText('运行内容'), { target: { value } });
  await flushAsync();
}
async function setDriver(value: string) {
  await fireEvent.input(screen.getByLabelText('驱动'), { target: { value } });
  await flushAsync();
}
async function setSandbox(value: string) {
  await fireEvent.input(screen.getByLabelText('Sandbox ID'), { target: { value } });
  await flushAsync();
}
test('hides observation modes and enters Run detail after submission returns a Run ID', async () => {
  const onstarted = vi.fn();
  const oncreated = vi.fn();
  const onclose = vi.fn();
  render(RunAgentModal, { prefilledAgent: 'worker', prefilledPrompt: 'hello', onstarted, oncreated, onclose });
  expect(screen.queryByLabelText('观察方式')).not.toBeInTheDocument();
  expect(screen.queryByText('启动新交互 Run（TTY）')).not.toBeInTheDocument();

  await fireEvent.click(screen.getByRole('button', { name: '运行' }));

  await waitFor(() => expect(mocks.store.navigateTo).toHaveBeenCalledWith('run-detail', { agentName: 'worker', runId: 'run-new' }));
  expect(onstarted).toHaveBeenCalledWith('run-new');
  expect(oncreated).toHaveBeenCalledTimes(1);
  expect(onclose).toHaveBeenCalledTimes(1);
  expect(onclose.mock.invocationCallOrder[0]).toBeLessThan(mocks.store.navigateTo.mock.invocationCallOrder[0]);
});

test('keeps the modal open and reports an error when detached submission returns no Run ID', async () => {
  mocks.runService.startRun.mockResolvedValue({ run: new RunSummary() });
  const onstarted = vi.fn();
  const oncreated = vi.fn();
  const onclose = vi.fn();
  render(RunAgentModal, { prefilledAgent: 'worker', prefilledPrompt: 'hello', onstarted, oncreated, onclose });

  await fireEvent.click(screen.getByRole('button', { name: '运行' }));

  await waitFor(() => expect(mocks.store.addToast).toHaveBeenCalledWith('运行已提交，但未返回 Run ID', 'error'));
  expect(screen.getByRole('dialog', { name: '手动运行 worker' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '运行' })).toBeEnabled();
  expect(onstarted).not.toHaveBeenCalled();
  expect(oncreated).not.toHaveBeenCalled();
  expect(onclose).not.toHaveBeenCalled();
  expect(mocks.store.navigateTo).not.toHaveBeenCalled();
});

test('submits command, sandbox ID, and explicit driver override from the form', async () => {
  render(RunAgentModal, { prefilledAgent: 'worker' });
  await setMode('command');
  await setInput('bun test');
  await setDriver('docker');
  await setSandbox('sandbox-1');
  await fireEvent.click(screen.getByRole('button', { name: '运行' }));
  await waitFor(() => expect(mocks.runService.startRun).toHaveBeenCalledTimes(1));
  const request = mocks.runService.startRun.mock.calls[0][0].run;
  expect(request).toMatchObject({ prompt: '', command: 'bun test', sandboxId: 'sandbox-1', driver: 'docker' });
});

test('disables the run button and sends no run RPC when the run content is empty', async () => {
  render(RunAgentModal, { prefilledAgent: 'worker' });
  expect(screen.getByRole('button', { name: '运行' })).toBeDisabled();
  await fireEvent.click(screen.getByRole('button', { name: '运行' }));
  expect(mocks.runService.startRun).not.toHaveBeenCalled();
});

test('populates driver and sandbox options from the agent existing sandboxes', async () => {
  mocks.sandboxService.listSandboxes.mockResolvedValue({ sandboxes: [
    new Sandbox({ sandboxId: 'sb-1', projectId: 'project-1', agentName: 'worker', driver: 'docker' }),
    new Sandbox({ sandboxId: 'sb-2', projectId: 'project-1', agentName: 'worker', driver: 'microsandbox' }),
    new Sandbox({ sandboxId: 'sb-3', projectId: 'project-1', agentName: 'other', driver: 'docker' }),
  ], nextCursor: '' });
  render(RunAgentModal, { prefilledAgent: 'worker', prefilledPrompt: 'hello' });

  await waitFor(() => expect(mocks.sandboxService.listSandboxes).toHaveBeenCalled());
  await flushAsync();
  const driverValues = Array.from(document.querySelectorAll('#run-agent-driver-options option'), (option) => option.getAttribute('value'));
  const sandboxValues = Array.from(document.querySelectorAll('#run-agent-sandbox-options option'), (option) => option.getAttribute('value'));
  expect(driverValues).toEqual(['docker', 'microsandbox']);
  expect(sandboxValues).toEqual(['sb-1', 'sb-2']);
});
