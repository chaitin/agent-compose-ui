import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { Timestamp } from '@bufbuild/protobuf';
import { readFileSync } from 'node:fs';
import { beforeEach, expect, test, vi } from 'vitest';

import EventSandboxDetailPage from './EventSandboxDetailPage.svelte';
import { Sandbox } from '../gen/agentcompose/v2/agentcompose_pb';

const mocks = vi.hoisted(() => ({
  loadLinks: vi.fn(),
  getSandbox: vi.fn(),
}));

vi.mock('../lib/event-sandbox-links', () => ({ loadEventSandboxLinks: mocks.loadLinks }));
vi.mock('../lib/rpc', () => ({ sandboxService: { getSandbox: mocks.getSandbox } }));
vi.mock('../views/runtime/SandboxDetailView.svelte', async () => ({
  default: (await import('../../test/fixtures/SandboxDetailViewStub.svelte')).default,
}));

function sandbox(id: string, updatedAt: string, status = 'RUNNING') {
  return new Sandbox({ sandboxId: id, projectId: `project-${id}`, title: `Title ${id}`, status, updatedAt: Timestamp.fromDate(new Date(updatedAt)) });
}

beforeEach(() => {
  vi.clearAllMocks();
  history.replaceState(null, '', '/events/evt-1');
  mocks.loadLinks.mockResolvedValue([
    { sandboxId: 'old', createdAt: '2026-07-16T00:00:00Z' },
    { sandboxId: 'new', createdAt: '2026-07-17T00:00:00Z' },
  ]);
  mocks.getSandbox.mockImplementation(async ({ sandboxId }: { sandboxId: string }) => ({
    sandbox: sandboxId === 'new' ? sandbox('new', '2026-07-17T02:00:00Z') : sandbox('old', '2026-07-16T02:00:00Z', 'STOPPED'),
  }));
});

test('pins the detail region to the flexible third grid row when no notice is rendered', () => {
  const source = readFileSync('src/pages/EventSandboxDetailPage.svelte', 'utf8');

  expect(source).toMatch(/\.detail-region\s*\{[^}]*grid-row:\s*3/);
});

test('selects the newest Session and embeds sandbox detail without its breadcrumb', async () => {
  render(EventSandboxDetailPage, { props: { eventId: 'evt-1' } });

  const select = await screen.findByLabelText('Session');
  expect(select).toHaveValue('new');
  expect(select).toHaveTextContent('Title new');
  expect(select).toHaveTextContent('运行中');
  expect(screen.getByTestId('embedded-sandbox')).toHaveAttribute('data-project-id', 'project-new');
  expect(screen.getByTestId('embedded-sandbox')).toHaveAttribute('data-sandbox-id', 'new');
  expect(screen.getByTestId('embedded-sandbox')).toHaveAttribute('data-show-breadcrumb', 'false');
});

test('restores a linked query selection and updates it when changed', async () => {
  history.replaceState(null, '', '/events/evt-1?sandboxId=old');
  const replaceState = vi.spyOn(history, 'replaceState');
  render(EventSandboxDetailPage, { props: { eventId: 'evt-1' } });

  const select = await screen.findByLabelText('Session');
  expect(select).toHaveValue('old');
  await fireEvent.change(select, { target: { value: 'new' } });
  expect(select).toHaveValue('new');
  expect(replaceState).toHaveBeenLastCalledWith(null, '', '/events/evt-1?sandboxId=new');
});

test('retains the selected Session across refresh', async () => {
  history.replaceState(null, '', '/events/evt-1?sandboxId=old');
  render(EventSandboxDetailPage, { props: { eventId: 'evt-1' } });
  expect(await screen.findByLabelText('Session')).toHaveValue('old');

  await fireEvent.click(screen.getByRole('button', { name: '刷新 Session' }));

  await waitFor(() => expect(mocks.loadLinks).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText('Session')).toHaveValue('old');
});

test('shows an empty state when the Event has no linked Session', async () => {
  mocks.loadLinks.mockResolvedValue([]);
  render(EventSandboxDetailPage, { props: { eventId: 'evt-1' } });
  expect(await screen.findByText('该事件未关联 Session')).toBeTruthy();
});

test('keeps available Sessions when one linked Sandbox cannot be loaded', async () => {
  mocks.getSandbox.mockImplementation(async ({ sandboxId }: { sandboxId: string }) => {
    if (sandboxId === 'new') throw new Error('gone');
    return { sandbox: sandbox('old', '2026-07-16T02:00:00Z') };
  });
  render(EventSandboxDetailPage, { props: { eventId: 'evt-1' } });

  expect(await screen.findByLabelText('Session')).toHaveValue('old');
  expect(screen.getByText('1 个关联 Session 暂时无法加载')).toBeTruthy();
});

test('shows a retryable Event loading error', async () => {
  mocks.loadLinks.mockRejectedValueOnce(new Error('event unavailable'));
  render(EventSandboxDetailPage, { props: { eventId: 'evt-1' } });
  expect(await screen.findByText('event unavailable')).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByLabelText('Session')).toHaveValue('new');
});
