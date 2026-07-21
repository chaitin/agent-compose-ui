import { render, screen, fireEvent } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';
import WebhookCurlPreview from './WebhookCurlPreview.svelte';
import type { WebhookSource } from '../../lib/webhook/types';

const source: WebhookSource = {
  id: 'a', name: 'siem-alert', enabled: true, provider: 'generic',
  topic_prefix: 'webhook.siem.alert.', has_token: true, has_signature_secret: false,
  body_limit_bytes: 0, created_at: '', updated_at: '',
};

test('renders placeholder when source is null', () => {
  render(WebhookCurlPreview, { props: { source: null, token: null } });
  expect(screen.getByText(/点击上方表格中的源/)).toBeInTheDocument();
});

test('renders curl command with real token when token is provided', () => {
  render(WebhookCurlPreview, { props: { source, token: 'tok_abc123' } });
  expect(screen.getByText(/tok_abc123/)).toBeInTheDocument();
  // topic appears in source line and curl preview
  expect(screen.getAllByText(/webhook\.siem\.alert/).length).toBeGreaterThan(0);
});

test('renders curl command with placeholder when token is null', () => {
  render(WebhookCurlPreview, { props: { source, token: null } });
  // placeholder appears in curl preview and warning hint
  expect(screen.getAllByText(/<your-token>/).length).toBeGreaterThan(0);
});

test('shows session-visible warning when token is present', () => {
  render(WebhookCurlPreview, { props: { source, token: 'tok_abc123' } });
  expect(screen.getByText(/包含明文 token，仅您当前会话可见/)).toBeInTheDocument();
});

test('shows regenerate hint when token is null', () => {
  render(WebhookCurlPreview, { props: { source, token: null } });
  expect(screen.getByText(/替换 <your-token> 为您的源 token/)).toBeInTheDocument();
});

test('copy button calls clipboard.writeText with curl command', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, writable: true, configurable: true });
  render(WebhookCurlPreview, { props: { source, token: 'tok_abc123' } });
  await fireEvent.click(screen.getByRole('button', { name: /复制/ }));
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining('tok_abc123'));
});
