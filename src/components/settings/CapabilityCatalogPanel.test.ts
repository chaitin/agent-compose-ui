import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, expect, test, vi } from 'vitest';
import CapabilityCatalogPanel from './CapabilityCatalogPanel.svelte';

const mocks = vi.hoisted(() => ({ capabilityService: { listCapabilitySets: vi.fn(), getCapabilityCatalog: vi.fn() } }));
vi.mock('../../lib/rpc', () => ({ capabilityService: mocks.capabilityService }));

beforeEach(() => vi.clearAllMocks());

test('explains unconfigured and empty catalog states and refreshes when configured', async () => {
  mocks.capabilityService.listCapabilitySets.mockResolvedValue({ capsets: [] });
  const { rerender } = render(CapabilityCatalogPanel, { configured: false, refreshRevision: 0 });
  expect(screen.getByText('能力目录')).toBeInTheDocument();
  expect(screen.queryByText('SERVICE SURFACE')).not.toBeInTheDocument();
  expect(screen.getByText('请先配置能力网关')).toBeInTheDocument();
  expect(mocks.capabilityService.listCapabilitySets).not.toHaveBeenCalled();

  await rerender({ configured: true, refreshRevision: 1 });
  await waitFor(() => expect(mocks.capabilityService.listCapabilitySets).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('网关未发布可用能力集')).toBeInTheDocument();
});

test('selects capability sets and renders catalog methods and endpoints', async () => {
  mocks.capabilityService.listCapabilitySets.mockResolvedValue({ capsets: [
    { id: 'core', name: 'Core tools', description: 'Built in', enabled: true },
    { id: 'extra', name: 'Extra tools', description: 'Optional', enabled: false },
  ] });
  mocks.capabilityService.getCapabilityCatalog.mockImplementation(({ capsetId }) => Promise.resolve({
    capsetId, name: capsetId === 'extra' ? 'Extra tools' : 'Core tools', methods: [{
      serviceId: 'files', methodFullName: 'agent.Files.Read', backendInstanceStatus: 'ready',
      endpoints: [
        { protocol: 'connect', endpoint: '/rpc', methodPath: '/agent.Files/Read', httpMethod: 'POST' },
        { protocol: 'http', endpoint: '/v1/files/read', httpMethod: 'POST' },
      ],
    }, {
      serviceId: 'shell', methodFullName: 'agent.Shell.Ping', backendInstanceStatus: 'ready', endpoints: [],
    }],
  }));
  render(CapabilityCatalogPanel, { configured: true });
  expect(await screen.findByText('agent.Files.Read')).toBeInTheDocument();
  expect(screen.getAllByText('agent.Files.Read')).toHaveLength(1);
  expect(screen.getByText('/agent.Files/Read')).toBeInTheDocument();
  expect(screen.getByText('/v1/files/read')).toBeInTheDocument();
  expect(screen.queryByText('+1')).not.toBeInTheDocument();
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  expect(screen.getByText('—')).toBeInTheDocument();
  expect(screen.getByTestId('capability-list-scroll')).toBeInTheDocument();
  const columnHeaders = screen.getByRole('row', { name: '能力方法列名' });
  expect(columnHeaders).toHaveTextContent('方法名称');
  expect(columnHeaders).toHaveTextContent('服务 ID');
  expect(columnHeaders).toHaveTextContent('运行状态');
  expect(columnHeaders).toHaveTextContent('访问端点');
  await fireEvent.change(screen.getByLabelText('能力集'), { target: { value: 'extra' } });
  await waitFor(() => expect(mocks.capabilityService.getCapabilityCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ capsetId: 'extra' })));
});

test('always exposes the catalog without a collapse control', async () => {
  mocks.capabilityService.listCapabilitySets.mockResolvedValue({ capsets: [
    { id: 'core', name: 'Core', enabled: true },
  ] });
  mocks.capabilityService.getCapabilityCatalog.mockResolvedValue({
    capsetId: 'core', name: 'Core catalog', description: 'Core services', methods: [],
  });

  render(CapabilityCatalogPanel, { configured: true });

  expect(await screen.findByText('Core services')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /能力目录/ })).not.toBeInTheDocument();
});

test('does not repeat the catalog name as a description', async () => {
  mocks.capabilityService.listCapabilitySets.mockResolvedValue({ capsets: [
    { id: 'ssh', name: 'SSH tools', enabled: true },
  ] });
  mocks.capabilityService.getCapabilityCatalog.mockResolvedValue({
    capsetId: 'ssh', name: 'ssh-exec', methods: [],
  });

  const { container } = render(CapabilityCatalogPanel, { configured: true });
  await waitFor(() => expect(mocks.capabilityService.getCapabilityCatalog).toHaveBeenCalled());

  expect(container.querySelector('.description')).toBeNull();
  expect(screen.queryByText('ssh-exec')).not.toBeInTheDocument();
});

test('preserves the catalog snapshot when selecting a set fails', async () => {
  mocks.capabilityService.listCapabilitySets.mockResolvedValue({ capsets: [{ id: 'core', name: 'Core', enabled: true }, { id: 'bad', name: 'Bad' }] });
  mocks.capabilityService.getCapabilityCatalog
    .mockResolvedValueOnce({ capsetId: 'core', name: 'Core', methods: [{ methodFullName: 'agent.Core.Ping', endpoints: [] }] })
    .mockRejectedValueOnce(new Error('catalog offline'));
  render(CapabilityCatalogPanel, { configured: true });
  expect(await screen.findByText('agent.Core.Ping')).toBeInTheDocument();
  await fireEvent.change(screen.getByLabelText('能力集'), { target: { value: 'bad' } });
  expect(await screen.findByText('catalog offline')).toBeInTheDocument();
  expect(screen.getByText('agent.Core.Ping')).toBeInTheDocument();
});

test('ignores a stale capability-set response from an earlier refresh', async () => {
  let resolveFirst!: (value: { capsets: Array<{ id: string; name: string; enabled: boolean }> }) => void;
  mocks.capabilityService.listCapabilitySets
    .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
    .mockResolvedValueOnce({ capsets: [{ id: 'fresh', name: 'Fresh', enabled: true }] });
  mocks.capabilityService.getCapabilityCatalog.mockResolvedValue({ capsetId: 'fresh', name: 'Fresh catalog', methods: [] });
  const { rerender } = render(CapabilityCatalogPanel, { configured: true, refreshRevision: 0 });
  await waitFor(() => expect(mocks.capabilityService.listCapabilitySets).toHaveBeenCalledTimes(1));
  await rerender({ configured: true, refreshRevision: 1 });
  expect(await screen.findByRole('option', { name: /Fresh/ })).toBeInTheDocument();
  resolveFirst({ capsets: [{ id: 'stale', name: 'Stale', enabled: true }] });
  await Promise.resolve();
  expect(screen.queryByRole('option', { name: /Stale/ })).not.toBeInTheDocument();
  expect(screen.getByRole('option', { name: /Fresh/ })).toBeInTheDocument();
});
