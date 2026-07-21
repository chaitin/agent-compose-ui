import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import WebhookRegisterModal from './WebhookRegisterModal.svelte';

const upsertMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/webhook/store.svelte', () => ({
  webhookStore: {
    upsert: upsertMock,
    sessionTokens: new Map(),
  },
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

test('shows form fields when open', () => {
  render(WebhookRegisterModal, { props: { open: true, onclose: () => {} } });
  expect(screen.getByText('注册 Webhook 源')).toBeInTheDocument();
  expect(screen.getByLabelText('名称')).toBeInTheDocument();
  expect(screen.getByLabelText('Topic 前缀')).toBeInTheDocument();
  expect(screen.getByText('访问 Token')).toBeInTheDocument();
  expect(screen.getByText('立即启用')).toBeInTheDocument();
});

test('disables register button when topic_prefix is invalid', async () => {
  render(WebhookRegisterModal, { props: { open: true, onclose: () => {} } });
  const topicInput = screen.getByLabelText('Topic 前缀');
  await fireEvent.input(topicInput, { target: { value: 'invalid-prefix' } });
  expect(screen.getByRole('button', { name: '注册' })).toBeDisabled();
});

test('enables register button when topic_prefix matches required format', async () => {
  render(WebhookRegisterModal, { props: { open: true, onclose: () => {} } });
  const nameInput = screen.getByLabelText('名称');
  const topicInput = screen.getByLabelText('Topic 前缀');
  await fireEvent.input(nameInput, { target: { value: 'siem-alert' } });
  await fireEvent.input(topicInput, { target: { value: 'webhook.siem.alert.' } });
  expect(screen.getByRole('button', { name: '注册' })).not.toBeDisabled();
});

test('on submit success, switches to success view showing token', async () => {
  upsertMock.mockResolvedValueOnce({ id: 'new-id', name: 'siem-alert', enabled: true, provider: 'generic', topic_prefix: 'webhook.siem.alert.', has_token: true, has_signature_secret: false, body_limit_bytes: 0, created_at: '', updated_at: '' });
  render(WebhookRegisterModal, { props: { open: true, onclose: () => {} } });
  await fireEvent.input(screen.getByLabelText('名称'), { target: { value: 'siem-alert' } });
  await fireEvent.input(screen.getByLabelText('Topic 前缀'), { target: { value: 'webhook.siem.alert.' } });
  await fireEvent.click(screen.getByRole('button', { name: '注册' }));
  await waitFor(() => {
    expect(screen.getByText('源已注册')).toBeInTheDocument();
  });
  expect(screen.getByText(/这是您最后一次能看到此 token/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '我已保存，关闭' })).toBeInTheDocument();
});

test('on submit failure, shows error in form view', async () => {
  const { WebhookApiError } = await import('../../lib/webhook/api');
  upsertMock.mockRejectedValueOnce(new WebhookApiError(400, 'topic prefix already exists'));
  render(WebhookRegisterModal, { props: { open: true, onclose: () => {} } });
  await fireEvent.input(screen.getByLabelText('名称'), { target: { value: 'siem-alert' } });
  await fireEvent.input(screen.getByLabelText('Topic 前缀'), { target: { value: 'webhook.siem.alert.' } });
  await fireEvent.click(screen.getByRole('button', { name: '注册' }));
  await waitFor(() => {
    expect(screen.getByText('topic prefix already exists')).toBeInTheDocument();
  });
  expect(screen.getByText('注册 Webhook 源')).toBeInTheDocument();
});
