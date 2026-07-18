import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import ProjectRuntimeView from './ProjectRuntimeView.svelte';
import { RunSource, RunStatus, RunSummary } from '../../gen/agentcompose/v2/agentcompose_pb';
import { store } from '../../lib/stores.svelte';

const mocks = vi.hoisted(() => ({
  runService: { listRuns: vi.fn() },
}));
vi.mock('../../lib/rpc', () => ({ runService: mocks.runService }));

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

beforeEach(() => { vi.clearAllMocks(); store.activeProjectId = 'project-1'; vi.spyOn(store, 'addToast').mockImplementation(() => {}); vi.spyOn(store, 'navigateTo').mockImplementation(() => {}); });
afterEach(() => cleanup());

test('opens the native date picker when either date field is clicked', async () => {
  mocks.runService.listRuns.mockResolvedValue({ runs: [] });
  render(ProjectRuntimeView);
  const start = screen.getByLabelText('开始日期') as HTMLInputElement & { showPicker: () => void };
  const end = screen.getByLabelText('结束日期') as HTMLInputElement & { showPicker: () => void };
  start.showPicker = vi.fn();
  end.showPicker = vi.fn();

  await fireEvent.click(start);
  await fireEvent.click(end);

  expect(start.showPicker).toHaveBeenCalledOnce();
  expect(end.showPicker).toHaveBeenCalledOnce();
});

test('queries v2 runs with lookahead and refreshes the expanded window without losing filters', async () => {
  mocks.runService.listRuns.mockResolvedValueOnce({ runs: [] })
    .mockResolvedValueOnce({ runs: Array.from({ length: 51 }, (_, i) => new RunSummary({ runId: `run-${i}` })) })
    .mockResolvedValueOnce({ runs: [new RunSummary({ runId: 'inserted' }), ...Array.from({ length: 100 }, (_, i) => new RunSummary({ runId: `run-${i}` }))] });
  render(ProjectRuntimeView);
  await waitFor(() => expect(mocks.runService.listRuns).toHaveBeenCalledTimes(1));
  await fireEvent.change(screen.getByLabelText('状态'), { target: { value: String(RunStatus.RUNNING) } });
  await fireEvent.change(screen.getByLabelText('来源'), { target: { value: String(RunSource.API) } });
  await fireEvent.input(screen.getByLabelText('开始日期'), { target: { value: '2026-07-01' } });
  await fireEvent.input(screen.getByLabelText('结束日期'), { target: { value: '2026-07-15' } });
  expect(screen.queryByLabelText('Sandbox')).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: '应用筛选' }));
  await waitFor(() => expect(mocks.runService.listRuns).toHaveBeenCalledTimes(2));
  const filtered = mocks.runService.listRuns.mock.calls[1][0];
  expect(filtered).toMatchObject({ projectId: 'project-1', status: RunStatus.RUNNING, source: RunSource.API, startedFrom: new Date(2026, 6, 1).toISOString(), startedTo: new Date(new Date(2026, 6, 16).getTime() - 1).toISOString(), sandboxId: '', offset: 0, limit: 51 });
  await fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
  await waitFor(() => expect(mocks.runService.listRuns).toHaveBeenCalledTimes(3));
  expect(mocks.runService.listRuns.mock.calls[2][0]).toMatchObject({ status: RunStatus.RUNNING, source: RunSource.API, sandboxId: '', offset: 0, limit: 101 });
  expect(await screen.findByText('inserted')).toBeTruthy();
  expect(screen.getAllByText('run-0')).toHaveLength(1);
});

test('does not offer load more for exactly 50 server records', async () => {
  mocks.runService.listRuns.mockResolvedValue({ runs: Array.from({ length: 50 }, (_, i) => new RunSummary({ runId: `exact-${i}` })) });
  render(ProjectRuntimeView);
  await screen.findByText('exact-49');
  expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull();
});

test('isolates late responses when the project changes', async () => {
  const old = deferred<{ runs: RunSummary[] }>();
  mocks.runService.listRuns.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ runs: [new RunSummary({ runId: 'new-run' })] });
  render(ProjectRuntimeView);
  await waitFor(() => expect(mocks.runService.listRuns).toHaveBeenCalledTimes(1));
  store.activeProjectId = 'project-2';
  await waitFor(() => expect(mocks.runService.listRuns).toHaveBeenCalledTimes(2));
  expect(await screen.findByText('new-run')).toBeTruthy();
  old.resolve({ runs: [new RunSummary({ runId: 'old-run' })] });
  await old.promise;
  await Promise.resolve();
  expect(screen.queryByText('old-run')).toBeNull();
});
