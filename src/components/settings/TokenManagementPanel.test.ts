import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, expect, test, vi } from 'vitest';
import TokenManagementPanel from './TokenManagementPanel.svelte';

const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), revoke: vi.fn(), copy: vi.fn() }));
vi.mock('../../lib/api-tokens', () => ({
  apiTokens: { list: mocks.list, create: mocks.create, revoke: mocks.revoke },
  ApiTokenError: class extends Error { constructor(public status: number, message: string) { super(message); } },
}));
vi.mock('../../lib/clipboard', () => ({ copyText: mocks.copy }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([]);
});

test('shows the disabled state for a 503 response', async () => {
  const { ApiTokenError } = await import('../../lib/api-tokens');
  mocks.list.mockRejectedValue(new ApiTokenError(503, 'disabled'));
  render(TokenManagementPanel);
  expect(await screen.findByText('Token 管理功能未启用')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '创建 Token' })).toBeDisabled();
});

test('shows API Token usage instructions', async () => {
  render(TokenManagementPanel);
  await fireEvent.click(screen.getByRole('button', { name: '使用说明' }));
  expect(screen.getByRole('dialog', { name: 'API Token 使用说明' })).toBeInTheDocument();
  expect(screen.getByText('8081')).toBeInTheDocument();
  expect(screen.getAllByText(/Authorization: Bearer/)).toHaveLength(2);
  expect(screen.getByText('具体可访问的 API Base URL 请联系管理员获取。')).toBeInTheDocument();
  expect(screen.queryByText(/http:\/\//)).not.toBeInTheDocument();
  await fireEvent.click(screen.getByRole('button', { name: '知道了' }));
  expect(screen.queryByRole('dialog', { name: 'API Token 使用说明' })).not.toBeInTheDocument();
});

test('shows a created token once, copies it, then clears it', async () => {
  mocks.create.mockResolvedValue({ id: 'id', name: 'ci', role: 'read-only-admin', createdAt: '2026-07-23T00:00:00Z', expiresAt: '2026-10-21T00:00:00Z', token: 'acp_once' });
  mocks.copy.mockResolvedValue(undefined);
  render(TokenManagementPanel);
  await screen.findByText('尚未创建 API Token。');
  await fireEvent.click(screen.getByRole('button', { name: '创建 Token' }));
  await fireEvent.input(screen.getByPlaceholderText('例如：CI 只读巡检'), { target: { value: 'ci' } });
  await fireEvent.click(screen.getByRole('button', { name: '创建' }));
  expect(mocks.create).toHaveBeenCalledWith('ci', 'read-only-admin', 90);
  expect(await screen.findByText('acp_once')).toBeInTheDocument();
  await fireEvent.click(screen.getByRole('button', { name: '复制 Token' }));
  await waitFor(() => expect(mocks.copy).toHaveBeenCalledWith('acp_once'));
  await fireEvent.click(screen.getByRole('button', { name: '完成' }));
  expect(screen.queryByText('acp_once')).not.toBeInTheDocument();
});

test('revokes an active token after confirmation', async () => {
  mocks.list.mockResolvedValue([{ id: 'id', name: 'ci', role: 'admin', createdAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' }]);
  mocks.revoke.mockResolvedValue(undefined);
  render(TokenManagementPanel);
  await fireEvent.click(await screen.findByRole('button', { name: '撤销' }));
  await fireEvent.click(screen.getByRole('button', { name: '确认撤销' }));
  await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith('id'));
});

test('selects a fixed validity and renders expired tokens without extension actions', async () => {
  mocks.create.mockResolvedValue({ id: 'new', name: 'yearly', role: 'admin', createdAt: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z', token: 'acp_year' });
  mocks.list.mockResolvedValueOnce([{ id: 'expired', name: 'old', role: 'admin', createdAt: '2025-01-01T00:00:00Z', expiresAt: '2025-01-02T00:00:00Z' }]).mockResolvedValueOnce([]);
  render(TokenManagementPanel);
  expect(await screen.findByText('已过期')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '撤销' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: /延期/ })).not.toBeInTheDocument();

  await fireEvent.click(screen.getByRole('button', { name: '创建 Token' }));
  await fireEvent.input(screen.getByPlaceholderText('例如：CI 只读巡检'), { target: { value: 'yearly' } });
  await fireEvent.change(screen.getByLabelText('有效期'), { target: { value: '365' } });
  await fireEvent.click(screen.getByRole('button', { name: '创建' }));
  expect(mocks.create).toHaveBeenCalledWith('yearly', 'read-only-admin', 365);
});
