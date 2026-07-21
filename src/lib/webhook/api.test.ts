import { afterEach, expect, test, vi } from 'vitest';
import { webhookApi, WebhookApiError } from './api';
import type { WebhookSource } from './types';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../auth-fetch', () => ({
  authFetch: (...args: unknown[]) => fetchMock(...args),
}));

afterEach(() => fetchMock.mockReset());

const sampleSource: WebhookSource = {
  id: 'src_001',
  name: 'siem-alert',
  enabled: true,
  provider: 'generic',
  topic_prefix: 'webhook.siem.alert.',
  has_token: true,
  has_signature_secret: false,
  body_limit_bytes: 0,
  created_at: '2026-07-21T14:00:00Z',
  updated_at: '2026-07-21T14:00:00Z',
};

test('listSources calls GET /api/webhook-sources and returns items', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ items: [sampleSource] }), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  const result = await webhookApi.listSources();
  expect(fetchMock).toHaveBeenCalledWith('/api/webhook-sources', expect.anything());
  expect(result).toEqual([sampleSource]);
});

test('upsertSource calls PUT /api/webhook-sources/:id with JSON body', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ source: sampleSource }), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  const result = await webhookApi.upsertSource({
    id: 'src_001',
    name: 'siem-alert',
    enabled: true,
    provider: 'generic',
    topic_prefix: 'webhook.siem.alert.',
    token: 'tok_abc',
  });
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/webhook-sources/src_001',
    expect.objectContaining({ method: 'PUT', body: expect.stringContaining('"token":"tok_abc"') }),
  );
  expect(result).toEqual(sampleSource);
});

test('deleteSource calls DELETE and resolves on 204', async () => {
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
  await webhookApi.deleteSource('src_001');
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/webhook-sources/src_001',
    expect.objectContaining({ method: 'DELETE' }),
  );
});

test('publishEvent uses plain fetch (not authFetch) with Bearer token', async () => {
  const plainFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify({ accepted: true, topic: 'webhook.siem.alert', event_id: 'evt_x', sequence: 1, correlation_id: 'evt_x' }), { status: 202 }),
  );
  const result = await webhookApi.publishEvent('webhook.siem.alert', 'tok_abc', { test: true });
  expect(plainFetch).toHaveBeenCalledWith(
    '/api/webhooks/webhook.siem.alert',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'Authorization': 'Bearer tok_abc',
        'Content-Type': 'application/json',
      }),
    }),
  );
  expect(result.event_id).toBe('evt_x');
  plainFetch.mockRestore();
});

test('error response is parsed into WebhookApiError', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: 'topic prefix is invalid' }), { status: 400, headers: { 'content-type': 'application/json' } }),
  );
  try {
    await webhookApi.listSources();
    expect.fail('listSources should have thrown');
  } catch (e) {
    expect(e).toBeInstanceOf(WebhookApiError);
    expect((e as WebhookApiError).status).toBe(400);
    expect((e as WebhookApiError).message).toBe('topic prefix is invalid');
  }
});
