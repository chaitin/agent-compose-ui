import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, expect, test, vi } from 'vitest';
import { Timestamp } from '@bufbuild/protobuf';
import Dashboard from './Dashboard.svelte';
import { DashboardOverview, RunOverview } from '../gen/agentcompose/v2/agentcompose_pb';

const mocks = vi.hoisted(() => ({
  dashboardService: { getDashboardOverview: vi.fn(), watchDashboardOverview: vi.fn() },
}));
vi.mock('../lib/rpc', () => ({ dashboardService: mocks.dashboardService }));

function overview(running: number, recent: number, attention: number, updatedAt: string) {
  return new DashboardOverview({
    runs: new RunOverview({ runningCount: running, recentCount: recent, attentionCount: attention }),
    updatedAt: Timestamp.fromDate(new Date(updatedAt)),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

test('loads the dashboard overview, applies watch updates, and aborts the stream on unmount', async () => {
  let releaseUpdate!: () => void;
  const updateReady = new Promise<void>((resolve) => { releaseUpdate = resolve; });
  let signal: AbortSignal | undefined;
  mocks.dashboardService.getDashboardOverview.mockResolvedValue({
    overview: overview(2, 8, 1, '2026-07-15T02:03:04Z'),
  });
  mocks.dashboardService.watchDashboardOverview.mockImplementation((_request, options) => {
    signal = options.signal;
    return {
      async *[Symbol.asyncIterator]() {
        await updateReady;
        yield { overview: overview(5, 13, 3, '2026-07-15T03:04:05Z') };
        await new Promise(() => {});
      },
    };
  });

  const view = render(Dashboard);

  expect(await screen.findByText('2')).toBeInTheDocument();
  expect(screen.getByText('8')).toBeInTheDocument();
  expect(screen.getByText('1')).toBeInTheDocument();
  expect(screen.getByText(/2026/)).toBeInTheDocument();
  releaseUpdate();
  expect(await screen.findByText('5')).toBeInTheDocument();
  expect(screen.getByText('13')).toBeInTheDocument();
  expect(screen.getByText('3')).toBeInTheDocument();
  await waitFor(() => expect(signal).toBeDefined());

  view.unmount();
  expect(signal?.aborted).toBe(true);
});

test('keeps the last successful snapshot when watching fails and retries on demand', async () => {
  mocks.dashboardService.getDashboardOverview.mockResolvedValue({
    overview: overview(7, 21, 4, '2026-07-15T04:05:06Z'),
  });
  mocks.dashboardService.watchDashboardOverview
    .mockImplementationOnce(async function* () { throw new Error('stream offline'); })
    .mockImplementationOnce(async function* () {});

  render(Dashboard);

  expect(await screen.findByText('21')).toBeInTheDocument();
  expect(await screen.findByText(/stream offline/)).toBeInTheDocument();
  expect(screen.getByText('7')).toBeInTheDocument();
  await fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(mocks.dashboardService.getDashboardOverview).toHaveBeenCalledTimes(2));
});
