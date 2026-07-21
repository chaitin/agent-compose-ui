import { beforeEach, expect, test, vi } from 'vitest';
import { webhookStore } from './store.svelte';
import { WebhookApiError } from './api';
import type { WebhookSource } from './types';

const apiMock = vi.hoisted(() => ({
  listSources: vi.fn(),
  upsertSource: vi.fn(),
  deleteSource: vi.fn(),
  WebhookApiError: class WebhookApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
      this.name = 'WebhookApiError';
    }
  },
}));
vi.mock('./api', () => ({
  webhookApi: apiMock,
  WebhookApiError: apiMock.WebhookApiError,
}));

beforeEach(() => {
  vi.clearAllMocks();
  webhookStore.sources = [];
  webhookStore.loading = false;
  webhookStore.lastError = null;
  webhookStore.selectedSourceId = null;
  webhookStore.sessionTokens.clear();
});

const sourceA: WebhookSource = {
  id: 'a', name: 'alpha', enabled: true, provider: 'generic',
  topic_prefix: 'webhook.alpha.', has_token: true, has_signature_secret: false,
  body_limit_bytes: 0, created_at: '2026-07-21T10:00:00Z', updated_at: '2026-07-21T10:00:00Z',
};

const sourceB: WebhookSource = {
  ...sourceA, id: 'b', name: 'beta', topic_prefix: 'webhook.beta.',
};

test('loadSources populates sources and selects first by default', async () => {
  apiMock.listSources.mockResolvedValueOnce([sourceA, sourceB]);
  await webhookStore.loadSources();
  expect(webhookStore.sources).toEqual([sourceA, sourceB]);
  expect(webhookStore.selectedSourceId).toBe('a');
  expect(webhookStore.loading).toBe(false);
  expect(webhookStore.lastError).toBe(null);
});

test('loadSources stores error on failure', async () => {
  apiMock.listSources.mockRejectedValueOnce(new WebhookApiError(500, 'boom'));
  await webhookStore.loadSources();
  expect(webhookStore.sources).toEqual([]);
  expect(webhookStore.lastError).toBeInstanceOf(WebhookApiError);
  expect(webhookStore.lastError?.message).toBe('boom');
});

test('loadSources preserves selectedSourceId if still present', async () => {
  webhookStore.selectedSourceId = 'b';
  apiMock.listSources.mockResolvedValueOnce([sourceA, sourceB]);
  await webhookStore.loadSources();
  expect(webhookStore.selectedSourceId).toBe('b');
});

test('loadSources falls back to first if previous selection is gone', async () => {
  webhookStore.selectedSourceId = 'gone';
  apiMock.listSources.mockResolvedValueOnce([sourceA, sourceB]);
  await webhookStore.loadSources();
  expect(webhookStore.selectedSourceId).toBe('a');
});

test('selectSource updates selectedSourceId', () => {
  webhookStore.sources = [sourceA, sourceB];
  webhookStore.selectSource('b');
  expect(webhookStore.selectedSourceId).toBe('b');
});

test('sessionTokens map is in-memory only', () => {
  webhookStore.sessionTokens.set('a', 'tok_xyz');
  expect(webhookStore.sessionTokens.get('a')).toBe('tok_xyz');
  webhookStore.sessionTokens.delete('a');
  expect(webhookStore.sessionTokens.get('a')).toBe(undefined);
});
