import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import SystemSettings from '../../src/pages/SystemSettings.svelte';
import systemSettingsSource from '../../src/pages/SystemSettings.svelte?raw';
import { store } from '../../src/lib/stores.svelte';

const mocks = vi.hoisted(() => ({
  capabilityService: {
    getCapabilityStatus: vi.fn().mockResolvedValue({ ok: true, status: 'ready', serviceCount: 1 }),
    listCapabilitySets: vi.fn().mockResolvedValue({ capsets: [] }),
    getCapabilityCatalog: vi.fn(),
  },
  imageService: {
    listImages: vi.fn().mockResolvedValue({ images: [], hasMore: false, nextOffset: 0 }),
  },
  settingsService: {
    getCapabilityGatewayConfig: vi.fn().mockResolvedValue({ config: { addr: '', tokenSet: false } }),
    updateCapabilityGatewayConfig: vi.fn().mockResolvedValue({}),
    getGlobalEnv: vi.fn().mockResolvedValue({ env: [] }),
    listWorkspacePresets: vi.fn().mockResolvedValue({ presets: [] }),
    updateGlobalEnv: vi.fn(),
    createWorkspacePreset: vi.fn(),
    updateWorkspacePreset: vi.fn(),
    deleteWorkspacePreset: vi.fn(),
  },
}));

vi.mock('../../src/lib/rpc', () => mocks);

describe('SystemSettings v2 boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.currentPage = 'images';
    window.location.hash = '';
  });

  test('stacks the gateway above the full-width catalog without a duplicate connection rail', () => {
    expect(systemSettingsSource).toContain('class="capability-stack"');
    expect(systemSettingsSource).not.toContain('class="connection-rail"');
    expect(systemSettingsSource).not.toContain("'LIVE'");
    expect(systemSettingsSource).not.toContain("'OFF'");
  });

  test('renders three route-backed tabs with only the visible modules', async () => {
    render(SystemSettings);
    const systemHeading = screen.getByRole('heading', { name: '系统管理' });
    expect(systemHeading).toBeInTheDocument();
    const tablist = screen.getByRole('tablist', { name: '系统管理模块' });
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tablist).toHaveTextContent('镜像');
    expect(tablist).toHaveTextContent('环境变量');
    expect(tablist).toHaveTextContent('能力服务');
    expect(tablist).not.toHaveTextContent('缓存');
    expect(tablist).not.toHaveTextContent('存储卷');
    expect(tablist).not.toHaveTextContent('工作区预设');
    expect(tablist).not.toHaveTextContent('/system/images');
    expect(tablist).not.toHaveTextContent('/system/environment');
    expect(tablist).not.toHaveTextContent('/system/capabilities');
    expect(screen.queryByText('DAEMON CONTROL PLANE')).not.toBeInTheDocument();
    expect(screen.queryByText('daemon 资源')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '镜像' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: '镜像' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '镜像' })).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole('tab', { name: '环境变量' }));
    expect(window.location.hash).toBe('#/system/environment');
    expect(screen.getByRole('tab', { name: '环境变量' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: '环境变量' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '环境变量' })).not.toBeInTheDocument();
    expect(screen.queryByText('SYSTEM / ENVIRONMENT')).not.toBeInTheDocument();
    expect(await screen.findByRole('region', { name: '全局环境变量' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('tab', { name: '能力服务' }));
    expect(window.location.hash).toBe('#/system/capabilities');
    expect(screen.getByRole('tab', { name: '能力服务' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: '能力服务' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '能力服务' })).not.toBeInTheDocument();
    expect(screen.queryByText('SYSTEM / CAPABILITIES')).not.toBeInTheDocument();
    expect(await screen.findByRole('region', { name: '能力服务连接' })).toBeInTheDocument();
    const gateway = screen.getByRole('region', { name: '能力网关' });
    const catalog = screen.getByRole('region', { name: '能力目录' });
    expect(gateway).toBeInTheDocument();
    expect(catalog).toBeInTheDocument();
    expect(gateway.compareDocumentPosition(catalog) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/^(LIVE|OFF)$/)).not.toBeInTheDocument();
  });

  test('matches the system header height to the sidebar brand height', () => {
    const source = readFileSync('src/pages/SystemSettings.svelte', 'utf8');
    expect(source).toMatch(/\.page-header\{[^}]*min-height:46px/);
    expect(source).toMatch(/\.page-header h1\{[^}]*font-size:var\(--font-size-3xl\)/);
    expect(source).toMatch(/\.route-tabs button\{[^}]*text-align:center/);
    expect(source).not.toMatch(/\.route-tabs button\{[^}]*text-align:left/);
  });

  test('stretches the global environment panel to the same module width as the gateway', () => {
    expect(systemSettingsSource).toMatch(/\.environment-panel\{[^}]*width:100%/);
    expect(systemSettingsSource).not.toMatch(/\.environment-panel\{[^}]*max-width/);
  });

  test('hides the pull image entry without removing the image module', async () => {
    render(SystemSettings);
    expect(await screen.findByRole('tabpanel', { name: '镜像' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '拉取镜像' })).not.toBeInTheDocument();
    expect(systemSettingsSource).toContain('showPullAction={false}');
  });

  test('refreshes the capability catalog after saving gateway configuration', async () => {
    store.currentPage = 'settings';
    mocks.settingsService.getCapabilityGatewayConfig
      .mockResolvedValueOnce({ config: { addr: '', tokenSet: false } })
      .mockResolvedValueOnce({ config: { addr: 'https://octobus.example', tokenSet: true } });
    render(SystemSettings);

    await fireEvent.input(await screen.findByLabelText('Gateway 地址'), {
      target: { value: 'https://octobus.example' },
    });
    await fireEvent.input(screen.getByLabelText('Gateway 令牌'), {
      target: { value: 'first-token' },
    });
    await fireEvent.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() => expect(mocks.capabilityService.listCapabilitySets).toHaveBeenCalledTimes(1));
  });
});
