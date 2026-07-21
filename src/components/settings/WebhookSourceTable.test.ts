import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';
import WebhookSourceTable from './WebhookSourceTable.svelte';
import type { WebhookSource } from '../../lib/webhook/types';

const baseSource: WebhookSource = {
  id: 'a', name: 'siem-alert', enabled: true, provider: 'generic',
  topic_prefix: 'webhook.siem.alert.', has_token: true, has_signature_secret: false,
  body_limit_bytes: 0, created_at: '2026-07-21T10:00:00Z', updated_at: '2026-07-21T10:00:00Z',
};

const noopCallbacks = {
  onselect: () => {},
  ontoggle: () => {},
  ondelete: () => {},
  oncopycurl: () => {},
  ontest: () => {},
  onregen: () => {},
};

test('renders header row with all columns', () => {
  render(WebhookSourceTable, { props: { sources: [], sessionTokenIds: new Set<string>(), selectedSourceId: null, testStates: new Map(), ...noopCallbacks } });
  expect(screen.getByText('名称')).toBeInTheDocument();
  expect(screen.getByText('Topic 前缀')).toBeInTheDocument();
  expect(screen.getByText('状态')).toBeInTheDocument();
  expect(screen.getByText('Token')).toBeInTheDocument();
  expect(screen.getByText('操作')).toBeInTheDocument();
});

test('renders empty state when sources is empty', () => {
  render(WebhookSourceTable, { props: { sources: [], sessionTokenIds: new Set<string>(), selectedSourceId: null, testStates: new Map(), ...noopCallbacks } });
  expect(screen.getByText('暂无 webhook 源')).toBeInTheDocument();
});

test('renders one row per source', () => {
  const sources = [
    baseSource,
    { ...baseSource, id: 'b', name: 'github-push', topic_prefix: 'webhook.github.', enabled: false },
  ];
  render(WebhookSourceTable, { props: { sources, sessionTokenIds: new Set<string>(['a']), selectedSourceId: 'a', testStates: new Map(), ...noopCallbacks } });
  expect(screen.getByText('siem-alert')).toBeInTheDocument();
  expect(screen.getByText('github-push')).toBeInTheDocument();
  expect(screen.getByText('webhook.siem.alert.')).toBeInTheDocument();
});

test('shows enabled pill for enabled source and disabled pill for disabled', () => {
  const sources = [
    baseSource,
    { ...baseSource, id: 'b', name: 'beta', topic_prefix: 'webhook.beta.', enabled: false },
  ];
  render(WebhookSourceTable, { props: { sources, sessionTokenIds: new Set<string>(), selectedSourceId: null, testStates: new Map(), ...noopCallbacks } });
  expect(screen.getByText('启用')).toBeInTheDocument();
  expect(screen.getByText('停用')).toBeInTheDocument();
});

test('shows session-available badge when sessionTokenIds has the id', () => {
  render(WebhookSourceTable, { props: { sources: [baseSource], sessionTokenIds: new Set<string>(['a']), selectedSourceId: 'a', testStates: new Map(), ...noopCallbacks } });
  expect(screen.getByText('会话内')).toBeInTheDocument();
});

test('shows needs-regen badge when sessionTokenIds does not have the id', () => {
  render(WebhookSourceTable, { props: { sources: [baseSource], sessionTokenIds: new Set<string>(), selectedSourceId: null, testStates: new Map(), ...noopCallbacks } });
  expect(screen.getByText('需重生成')).toBeInTheDocument();
});

test('clicking row calls onselect with source id', async () => {
  const onselect = vi.fn();
  const { container } = render(WebhookSourceTable, { props: { sources: [baseSource], sessionTokenIds: new Set<string>(), selectedSourceId: null, testStates: new Map(), ...noopCallbacks, onselect } });
  await fireEvent.click(screen.getByText('siem-alert'));
  expect(onselect).toHaveBeenCalledWith('a');
});

test('clicking toggle calls ontoggle with source id', async () => {
  const ontoggle = vi.fn();
  const { container } = render(WebhookSourceTable, { props: { sources: [baseSource], sessionTokenIds: new Set<string>(), selectedSourceId: null, testStates: new Map(), ...noopCallbacks, ontoggle } });
  const toggle = container.querySelector('.mini-toggle');
  if (!toggle) throw new Error('mini-toggle not found');
  await fireEvent.click(toggle);
  expect(ontoggle).toHaveBeenCalledWith('a');
});

test('renders test status bar when testStates has entry for source', () => {
  const testStates = new Map<string, import('../../lib/webhook/types').TestState>([
    ['a', { phase: 'success', status: 202, eventId: 'evt_abc', sequence: 5, at: Date.now() }],
  ]);
  render(WebhookSourceTable, {
    props: {
      sources: [baseSource],
      sessionTokenIds: new Set<string>(['a']),
      selectedSourceId: 'a',
      testStates,
      ...noopCallbacks,
    },
  });
  expect(screen.getByText('202 Accepted')).toBeInTheDocument();
  expect(screen.getByText('evt_abc')).toBeInTheDocument();
});

test('test button is enabled when session has token and source is enabled', () => {
  render(WebhookSourceTable, {
    props: {
      sources: [baseSource],
      sessionTokenIds: new Set<string>(['a']),
      selectedSourceId: 'a',
      testStates: new Map(),
      ...noopCallbacks,
    },
  });
  expect(screen.getByRole('button', { name: /⚡ 测试/ })).not.toBeDisabled();
});

test('test button is disabled when session has no token', () => {
  render(WebhookSourceTable, {
    props: {
      sources: [baseSource],
      sessionTokenIds: new Set<string>(),
      selectedSourceId: null,
      testStates: new Map(),
      ...noopCallbacks,
    },
  });
  const btn = screen.getByRole('button', { name: /⚡ 测试/ });
  expect(btn).toBeDisabled();
  expect(btn.getAttribute('title')).toContain('需重新生成 token');
});

test('test button is disabled when source is disabled', () => {
  render(WebhookSourceTable, {
    props: {
      sources: [{ ...baseSource, enabled: false }],
      sessionTokenIds: new Set<string>(['a']),
      selectedSourceId: null,
      testStates: new Map(),
      ...noopCallbacks,
    },
  });
  const btn = screen.getByRole('button', { name: /⚡ 测试/ });
  expect(btn).toBeDisabled();
  expect(btn.getAttribute('title')).toContain('源已停用');
});
