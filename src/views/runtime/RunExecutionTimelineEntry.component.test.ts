import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';
import RunExecutionTimelineEntry from './RunExecutionTimelineEntry.svelte';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('shows a decorative arrow matching the entry expansion state', async () => {
  const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 352 });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 704 });

  try {
    const view = render(RunExecutionTimelineEntry, { entry: {
      id: 'log-1', timestamp: '', sortTime: 0, sequence: 0, kind: 'log', source: 'run',
      level: 'info', content: 'long content', timestampInferred: false,
    } });

    await waitFor(() => expect(view.container.querySelector('.entry-toggle')).toBeTruthy());
    const toggle = view.container.querySelector('.entry-toggle') as HTMLButtonElement;
    expect(toggle).toHaveAccessibleName('展示全部');
    expect(toggle.querySelector('.entry-toggle-icon')).toHaveTextContent('↓');
    expect(toggle.querySelector('.entry-toggle-icon')).toHaveAttribute('aria-hidden', 'true');

    await fireEvent.click(toggle);
    expect(toggle).toHaveAccessibleName('收起');
    expect(toggle.querySelector('.entry-toggle-icon')).toHaveTextContent('↑');
  } finally {
    if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
    if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
  }
});

test('shows raw content without a duplicate copy action and keeps copy full text', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  const view = render(RunExecutionTimelineEntry, { entry: {
    id: 'sandbox-1', timestamp: '', sortTime: 0, sequence: 0, kind: 'sandbox', source: 'run',
    level: 'info', content: 'sandbox raw content', timestampInferred: false,
  } });

  await fireEvent.click(screen.getByRole('button', { name: '复制全文：SANDBOX' }));
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith('sandbox raw content');
  await fireEvent.click(screen.getByText('查看完整原始数据'));
  expect(screen.queryByRole('button', { name: /复制原始数据/ })).toBeNull();
  expect(view.container.querySelector('pre.raw')).toHaveTextContent('sandbox raw content');
});

test('does not render Sandbox navigation inside timeline rows', () => {
  render(RunExecutionTimelineEntry, { entry: {
    id: 'cell-1', timestamp: '', sortTime: 0, sequence: 0, kind: 'output', source: 'Agent Cell',
    level: 'info', content: 'answer', timestampInferred: false,
  } });

  expect(screen.queryByRole('button', { name: '查看 Sandbox 运行详情' })).toBeNull();
});
