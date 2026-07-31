import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import CapabilityGatewayPanel from './CapabilityGatewayPanel.svelte';

const mocks = vi.hoisted(() => ({
  settingsService: {
    getCapabilityGatewayConfig: vi.fn(),
    updateCapabilityGatewayConfig: vi.fn(),
  },
  capabilityService: { getCapabilityStatus: vi.fn() },
}));

vi.mock('../../lib/rpc', () => ({
  settingsService: mocks.settingsService,
  capabilityService: mocks.capabilityService,
}));

describe('CapabilityGatewayPanel', () => {
  beforeEach(() => vi.resetAllMocks());

  test('shows configuration instead of a zero service count when gateway is unconfigured', async () => {
    mocks.settingsService.getCapabilityGatewayConfig.mockResolvedValue({ config: { addr: '', tokenSet: false } });
    mocks.capabilityService.getCapabilityStatus.mockResolvedValue({ configured: false, ok: false, status: 'not_configured', serviceCount: 0 });
    render(CapabilityGatewayPanel);
    expect(await screen.findByText('未配置')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '能力网关' })).toBeInTheDocument();
    expect(screen.queryByText('CAPABILITY GATEWAY')).not.toBeInTheDocument();
    expect(screen.queryByText('0 个服务')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Gateway 地址')).toBeInTheDocument();
  });

  test('shows address and service count without exposing an unreliable token state', async () => {
    mocks.settingsService.getCapabilityGatewayConfig.mockResolvedValue({ config: { addr: 'https://octobus.example', tokenSet: true } });
    mocks.capabilityService.getCapabilityStatus.mockResolvedValue({
      configured: true, ok: true, status: 'ready', serviceCount: 7,
      runtimeConfigured: true, proxyListenConfigured: true, proxyTargetConfigured: true,
    });
    render(CapabilityGatewayPanel);
    expect(await screen.findByText('https://octobus.example')).toBeInTheDocument();
    const overview = screen.getByTestId('gateway-overview');
    expect(screen.getByTestId('gateway-address-row')).toHaveTextContent(/^Gateway 地址https:\/\/octobus\.example$/);
    const statusRow = screen.getByTestId('gateway-status-row');
    expect(statusRow).toHaveTextContent(/连接正常.*运行时可用.*监听已配置.*目标已配置.*7 个服务.*编辑配置/);
    expect(statusRow).not.toHaveTextContent(/令牌(?:已|未)设置/);
    expect(within(overview).getByRole('img', { name: '连接正常' })).toBeInTheDocument();
    expect(within(overview).getByText('连接正常')).toBeInTheDocument();
    expect(within(overview).getByRole('button', { name: '编辑配置' })).toBeInTheDocument();
    expect(within(overview).queryByRole('button', { name: '更换现有令牌' })).not.toBeInTheDocument();
    expect(within(overview).getByText('运行时可用')).toBeInTheDocument();
    expect(within(overview).getByText('监听已配置')).toBeInTheDocument();
    expect(within(overview).getByText('目标已配置')).toBeInTheDocument();
    expect(overview.querySelector('.runtime-warning')).not.toBeInTheDocument();
  });

  test('shows backend connection errors and runtime proxy availability without a misleading service count', async () => {
    mocks.settingsService.getCapabilityGatewayConfig.mockResolvedValue({ config: { addr: 'https://octobus.example', tokenSet: true } });
    mocks.capabilityService.getCapabilityStatus.mockResolvedValue({
      configured: true,
      ok: false,
      status: 'unreachable',
      error: 'dial tcp: connection refused',
      serviceCount: 9,
      runtimeConfigured: false,
      proxyListenConfigured: true,
      proxyTargetConfigured: false,
    });
    render(CapabilityGatewayPanel);
    expect(await screen.findByRole('img', { name: '连接异常' })).toBeInTheDocument();
    expect(screen.getByText('dial tcp: connection refused')).toBeInTheDocument();
    expect(screen.queryByText('9 个服务')).not.toBeInTheDocument();
    const statusRow = screen.getByTestId('gateway-status-row');
    expect(statusRow).toHaveTextContent(/连接异常.*运行时不可用.*监听已配置.*目标未配置/);
    expect(statusRow).not.toHaveTextContent(/令牌(?:已|未)设置/);
    expect(statusRow.querySelector('.runtime-warning')).not.toBeInTheDocument();
  });

  test('saves the first address and token', async () => {
    mocks.settingsService.getCapabilityGatewayConfig
      .mockResolvedValueOnce({ config: { addr: '', tokenSet: false } })
      .mockResolvedValueOnce({ config: { addr: 'https://octobus.example', tokenSet: true } });
    mocks.capabilityService.getCapabilityStatus
      .mockResolvedValueOnce({ configured: false, ok: false, status: 'not_configured', serviceCount: 0 })
      .mockResolvedValueOnce({ configured: true, ok: true, status: 'ready', serviceCount: 1 });
    mocks.settingsService.updateCapabilityGatewayConfig.mockResolvedValue({});
    render(CapabilityGatewayPanel);
    await fireEvent.input(await screen.findByLabelText('Gateway 地址'), { target: { value: 'https://octobus.example' } });
    await fireEvent.input(screen.getByLabelText('Gateway 令牌'), { target: { value: 'first-token' } });
    await fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(mocks.settingsService.updateCapabilityGatewayConfig).toHaveBeenCalledWith(
      expect.objectContaining({ addr: 'https://octobus.example', token: 'first-token' }),
    ));
  });

  test('rejects a non-http gateway address', async () => {
    mocks.settingsService.getCapabilityGatewayConfig.mockResolvedValue({ config: { addr: '', tokenSet: false } });
    mocks.capabilityService.getCapabilityStatus.mockResolvedValue({ configured: false, ok: false, status: 'not_configured', serviceCount: 0 });
    render(CapabilityGatewayPanel);
    await fireEvent.input(await screen.findByLabelText('Gateway 地址'), { target: { value: 'ftp://invalid.example' } });
    await fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    expect(await screen.findByText('地址必须使用 http:// 或 https://')).toBeInTheDocument();
    expect(mocks.settingsService.updateCapabilityGatewayConfig).not.toHaveBeenCalled();
  });

  test('replaces an existing token through edit configuration', async () => {
    mocks.settingsService.getCapabilityGatewayConfig.mockResolvedValue({ config: { addr: 'https://octobus.example', tokenSet: true } });
    mocks.capabilityService.getCapabilityStatus.mockResolvedValue({ configured: true, ok: true, status: 'ready', serviceCount: 7 });
    mocks.settingsService.updateCapabilityGatewayConfig.mockResolvedValue({});
    render(CapabilityGatewayPanel);
    await fireEvent.click(await screen.findByRole('button', { name: '编辑配置' }));
    await fireEvent.input(screen.getByLabelText('Gateway 令牌'), { target: { value: 'replacement-token' } });
    await fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(mocks.settingsService.updateCapabilityGatewayConfig).toHaveBeenCalledWith(
      expect.objectContaining({ addr: 'https://octobus.example', token: 'replacement-token' }),
    ));
    expect(mocks.settingsService.updateCapabilityGatewayConfig.mock.calls[0][0].token).toBe('replacement-token');
  });

  test('reports configuration state before the saved callback after refresh', async () => {
    const order: string[] = [];
    mocks.settingsService.getCapabilityGatewayConfig
      .mockResolvedValueOnce({ config: { addr: '', tokenSet: false } })
      .mockResolvedValueOnce({ config: { addr: 'https://octobus.example', tokenSet: false } });
    mocks.capabilityService.getCapabilityStatus.mockResolvedValue({ configured: true, ok: true, serviceCount: 1 });
    mocks.settingsService.updateCapabilityGatewayConfig.mockResolvedValue({});
    render(CapabilityGatewayPanel, {
      onconfigurationchange: (configured) => order.push(`configured:${configured}`),
      onconfigured: () => order.push('saved'),
    });
    await fireEvent.input(await screen.findByLabelText('Gateway 地址'), { target: { value: 'https://octobus.example' } });
    await fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(order).toEqual(['configured:false', 'configured:true', 'saved']));
    expect(mocks.settingsService.getCapabilityGatewayConfig).toHaveBeenCalledTimes(2);
    expect(mocks.capabilityService.getCapabilityStatus).toHaveBeenCalledTimes(2);
  });
});
