import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import WebhookPanel from './WebhookPanel.svelte';

const storeMock = vi.hoisted(() => ({
  sources: [] as Array<{ id: string; name: string; enabled: boolean; provider: string; topic_prefix: string; has_token: boolean; has_signature_secret: boolean; body_limit_bytes: number; created_at: string; updated_at: string; signature_type?: string }>,
  loading: false,
  lastError: null,
  selectedSourceId: null as string | null,
  sessionTokens: new Map<string, string>(),
  loadSources: vi.fn(),
  selectSource: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../../lib/webhook/store.svelte', () => ({ webhookStore: storeMock }));
vi.mock('../../lib/webhook/api', () => ({
  webhookApi: { publishEvent: vi.fn() },
  WebhookApiError: class extends Error {
    constructor(public status: number, message: string) { super(message); this.name = 'WebhookApiError'; }
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  storeMock.sources = [{
    id: 'a', name: 'siem-alert', enabled: true, provider: 'generic',
    topic_prefix: 'webhook.siem.alert.', has_token: true, has_signature_secret: false,
    body_limit_bytes: 0, created_at: '', updated_at: '',
  }];
  storeMock.selectedSourceId = 'a';
  storeMock.sessionTokens = new Map([['a', 'old-token']]);
});

afterEach(() => vi.restoreAllMocks());

test('clicking regen button opens confirm modal', async () => {
  render(WebhookPanel);
  await fireEvent.click(screen.getByRole('button', { name: /↻ 重生成/ }));
  expect(screen.getByText('重新生成 Token')).toBeInTheDocument();
  expect(screen.getByText(/会使旧 token 立即失效/)).toBeInTheDocument();
});

test('confirming regen calls upsert with new token and shows new token display', async () => {
  storeMock.upsert.mockResolvedValueOnce(storeMock.sources[0]);
  render(WebhookPanel);
  await fireEvent.click(screen.getByRole('button', { name: /↻ 重生成/ }));
  await fireEvent.click(screen.getByRole('button', { name: '重新生成' }));
  await waitFor(() => {
    expect(storeMock.upsert).toHaveBeenCalledWith(expect.objectContaining({
      id: 'a',
      token: expect.stringMatching(/^tok_[a-f0-9]{24}$/),
    }));
  });
  await waitFor(() => {
    expect(screen.getByText(/新 token 已生成/)).toBeInTheDocument();
  });
});

test('canceling regen closes modal without calling upsert', async () => {
  render(WebhookPanel);
  await fireEvent.click(screen.getByRole('button', { name: /↻ 重生成/ }));
  await fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(storeMock.upsert).not.toHaveBeenCalled();
});
