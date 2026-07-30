import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';
import yaml from 'js-yaml';
import DataMountPanel from './DataMountPanel.svelte';
import { managedVolumeName } from '../../lib/project-resources/volume-names';
import { volumeService } from '../../lib/rpc';
import { managedVolumeDeletionGuard } from '../../lib/project-resources/physical-deletion-guard';
import { readFileSync } from 'node:fs';

vi.mock('../../lib/rpc', () => ({ volumeService: { removeVolume: vi.fn() } }));

const KEY = 'ws_0123456789abcdef0123456789abcdef';
const SOURCE = 'agents:\n  alpha: {}\n  beta: {}\n';
afterEach(() => { vi.unstubAllGlobals(); managedVolumeDeletionGuard.clearForTests(); });

function setup(props: Record<string, unknown> = {}) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ entries: [] }), { headers: { 'content-type': 'application/json' } })));
  const onYamlChange = vi.fn().mockResolvedValue(undefined);
  render(DataMountPanel, { yaml: SOURCE, projectKey: KEY, onYamlChange, onApply: vi.fn().mockResolvedValue(undefined), ...props });
  return onYamlChange;
}

test('groups data resources and opens the selected resource detail', async () => {
  const source = `volumes:
  project-memory: { driver: local }
  bun-cache: { driver: local }
agents:
  alpha:
    volumes:
      - { type: volume, source: project-memory, target: /data/project-memory }
      - { type: volume, source: bun-cache, target: /root/.bun }
      - { type: bind, source: /srv/shared, target: /workspace/shared, read_only: true }
`;
  setup({ yaml: source });
  expect(screen.getByRole('navigation', { name: '数据资源' })).toBeInTheDocument();
  expect(screen.getByRole('group', { name: '持久数据' })).toBeInTheDocument();
  expect(screen.getByRole('group', { name: '依赖缓存' })).toBeInTheDocument();
  expect(screen.getByRole('group', { name: '共享目录' })).toBeInTheDocument();
  await fireEvent.click(screen.getByRole('button', { name: /project-memory/ }));
  expect(screen.getByRole('region', { name: 'project-memory 详情' })).toHaveTextContent('/data/project-memory');
});

test('fills the resource panel and assigns remaining height to the browser', () => {
  setup();
  const source = readFileSync(`${process.cwd()}/src/components/mounts/DataMountPanel.svelte`, 'utf8');
  expect(source).toMatch(/\.mount-panel\{[^}]*flex:1[^}]*grid-template-rows:auto minmax\(0,1fr\)[^}]*min-height:0[^}]*overflow:hidden/);
  expect(source).toMatch(/\.resource-browser\{[^}]*height:100%[^}]*min-height:0[^}]*overflow:hidden/);
});

test('creates an isolated managed local volume and one mount in a single callback', async () => {
  const onYamlChange = setup();
  await fireEvent.click(screen.getByRole('button', { name: '创建数据卷' }));
  await fireEvent.input(screen.getByLabelText('逻辑名称'), { target: { value: 'memory' } });
  await fireEvent.click(screen.getByRole('button', { name: '创建并挂载' }));
  await waitFor(() => expect(onYamlChange).toHaveBeenCalledTimes(1));
  const result = yaml.load(onYamlChange.mock.calls[0][0]) as any;
  expect(result.volumes.memory).toEqual({
    name: await managedVolumeName(KEY, 'memory'), driver: 'local',
    labels: { 'agent-compose-ui.logical-name': 'memory', 'agent-compose-ui.project-key': KEY, 'agent-compose-ui.managed': 'true' },
  });
  expect(result.agents.alpha.volumes).toEqual([{ type: 'volume', source: 'memory', target: '/data/memory', read_only: false }]);
});

test('styles mount modal actions by intent', async () => {
  setup();
  await fireEvent.click(screen.getByRole('button', { name: '创建数据卷' }));
  expect(screen.getByRole('button', { name: '取消' })).toHaveClass('ui-button', 'ghost');
  expect(screen.getByRole('button', { name: '创建并挂载' })).toHaveClass('ui-button', 'primary');
});

test('rejects a duplicate target across bind and volume mounts without a callback', async () => {
  const source = 'volumes:\n  cache: {}\nagents:\n  alpha:\n    volumes:\n      - { type: bind, source: /srv/docs, target: /data//memory, read_only: true }\n';
  const onYamlChange = setup({ yaml: source });
  await fireEvent.click(screen.getByRole('button', { name: '创建数据卷' }));
  await fireEvent.input(screen.getByLabelText('逻辑名称'), { target: { value: 'memory' } });
  await fireEvent.click(screen.getByRole('button', { name: '创建并挂载' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('挂载目标已被使用');
  expect(onYamlChange).not.toHaveBeenCalled();
});

test('mounts the same declaration to a second Agent and unmounts only that reference', async () => {
  const source = 'volumes:\n  cache: {}\nagents:\n  alpha: {}\n  beta:\n    volumes:\n      - { type: volume, source: cache, target: /cache, read_only: false }\n';
  const onYamlChange = setup({ yaml: source });
  await fireEvent.click(screen.getByRole('button', { name: '挂载资源' }));
  await fireEvent.change(screen.getByLabelText('现有卷'), { target: { value: 'cache' } });
  await fireEvent.input(screen.getByLabelText('现有卷挂载目标'), { target: { value: '/cache' } });
  await fireEvent.click(screen.getByRole('button', { name: /^挂载$/ }));
  await waitFor(() => expect(onYamlChange).toHaveBeenCalledOnce());
  const result = yaml.load(onYamlChange.mock.calls[0][0]) as any;
  expect(result.volumes.cache).toEqual({});
  expect(result.agents.beta.volumes).toHaveLength(1);
  expect(result.agents.alpha.volumes).toEqual([{ type: 'volume', source: 'cache', target: '/cache', read_only: false }]);
});

test('explicit apply reports rejection without reverting YAML', async () => {
  const onApply = vi.fn().mockRejectedValue(new Error('offline'));
  const onYamlChange = setup({ onApply });
  await fireEvent.click(screen.getByRole('button', { name: '应用 YAML' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('应用失败：offline');
  expect(onYamlChange).not.toHaveBeenCalled();
});

test('treats confirmation cancellation as neutral', async () => {
  const cancelled = Object.assign(new Error('应用已取消'), { code: 'apply_cancelled' });
  setup({ onApply: vi.fn().mockRejectedValue(cancelled) });
  await fireEvent.click(screen.getByRole('button', { name: '应用 YAML' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '应用 YAML' })).toBeEnabled());
  expect(screen.queryByText('应用成功')).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('keeps all mutations disabled until the exact async apply callback settles', async () => {
  let resolve!: () => void;
  const onApply = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
  setup({ onApply });
  const apply = screen.getByRole('button', { name: '应用 YAML' });
  await fireEvent.click(apply);
  expect(onApply).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: '正在应用…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '创建数据卷' })).toBeDisabled();
  resolve();
  await waitFor(() => expect(screen.getByRole('button', { name: '应用 YAML' })).toBeEnabled());
});

test.each([
  ['unmanaged', 'volumes:\n  memory: { name: user-memory, driver: local }\n'],
  ['other owner', "volumes:\n  memory: { name: wrong, driver: local, labels: { agent-compose-ui.managed: 'true', agent-compose-ui.project-key: ws_fedcba9876543210fedcba9876543210 } }\n"],
  ['different system', `volumes:\n  memory: { name: wrong, driver: local, labels: { agent-compose-ui.managed: 'true', agent-compose-ui.project-key: ${KEY} } }\n`],
])('does not overwrite a colliding %s declaration', async (_kind, declaration) => {
  const onYamlChange = setup({ yaml: `${declaration}agents:\n  alpha: {}\n` });
  await fireEvent.click(screen.getByRole('button', { name: '创建数据卷' }));
  await fireEvent.input(screen.getByLabelText('逻辑名称'), { target: { value: 'memory' } });
  await fireEvent.click(screen.getByRole('button', { name: '创建并挂载' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('卷声明 memory 冲突');
  expect(onYamlChange).not.toHaveBeenCalled();
});

test('refreshes changed detach references and requires a second confirmation', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ entries: [] }))));
  const onYamlChange = vi.fn().mockResolvedValue(undefined);
  const first = 'volumes:\n  cache: {}\nagents:\n  alpha:\n    volumes: [{ type: volume, source: cache, target: /one }]\n  beta: {}\n';
  const view = render(DataMountPanel, { yaml: first, projectKey: KEY, onYamlChange, onApply: vi.fn() });
  await fireEvent.click(screen.getByRole('button', { name: '移除声明…' }));
  expect(screen.getByRole('dialog')).toHaveAccessibleDescription(/不会删除实际 daemon 卷数据/);
  const changed = 'name: keep\nvolumes:\n  cache: {}\nagents:\n  alpha:\n    volumes: [{ type: volume, source: cache, target: /one }]\n  beta:\n    volumes: [{ type: volume, source: cache, target: /two }]\n';
  await view.rerender({ yaml: changed, projectKey: KEY, onYamlChange, onApply: vi.fn() });
  await fireEvent.click(screen.getByRole('button', { name: '仅移除并保留数据' }));
  expect(onYamlChange).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toHaveTextContent('beta → /two');
  await fireEvent.click(screen.getByRole('button', { name: '仅移除并保留数据' }));
  await waitFor(() => expect(onYamlChange).toHaveBeenCalledOnce());
  const result = yaml.load(onYamlChange.mock.calls[0][0]) as any;
  expect(result.name).toBe('keep'); expect(result.volumes).toBeUndefined();
  expect(result.agents.alpha.volumes).toBeUndefined(); expect(result.agents.beta.volumes).toBeUndefined();
});

test('resets shared mounts to read-only whenever the selected catalog ID changes', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ entries: [
    { id: 'one', name: 'One', path: '/srv/one', writable: true },
    { id: 'two', name: 'Two', path: '/srv/two', writable: true },
  ] }))));
  render(DataMountPanel, { yaml: SOURCE, projectKey: KEY, onYamlChange: vi.fn(), onApply: vi.fn() });
  await fireEvent.click(screen.getByRole('button', { name: '挂载资源' }));
  await fireEvent.change(screen.getByLabelText('资源类型'), { target: { value: 'share' } });
  await screen.findByRole('option', { name: 'One (可写)' });
  const readOnly = screen.getByRole('checkbox', { name: '只读' });
  expect(readOnly).toBeChecked();
  await fireEvent.click(screen.getByRole('button', { name: '允许写入' }));
  expect(readOnly).not.toBeChecked();
  await fireEvent.change(screen.getByLabelText('共享目录'), { target: { value: 'two' } });
  await waitFor(() => expect(readOnly).toBeChecked());
});

test('moves resource creation and mounting into typed modals', async () => {
  setup();
  expect(screen.getByRole('toolbar', { name: '数据与挂载操作' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '创建数据卷' })).toHaveClass('primary');
  expect(screen.getByRole('button', { name: '挂载资源' })).toHaveClass('secondary');
  expect(screen.getByRole('button', { name: '应用 YAML' })).toHaveClass('ghost');
  expect(screen.queryByLabelText('逻辑名称')).not.toBeInTheDocument();
  await fireEvent.click(screen.getByRole('button', { name: '挂载资源' }));
  await fireEvent.change(screen.getByLabelText('资源类型'), { target: { value: 'cache' } });
  expect(screen.getByLabelText('缓存预设')).toBeInTheDocument();
  expect(screen.queryByLabelText('共享目录')).not.toBeInTheDocument();
});

test('shows file browsing only for managed volumes, never external volumes or bind mounts', async () => {
  const source = `volumes:
  managed:
    name: ui-managed
    driver: local
    labels:
      agent-compose-ui.managed: 'true'
      agent-compose-ui.project-key: ${KEY}
  external: { external: true, name: customer-data }
agents:
  alpha:
    volumes:
      - { type: volume, source: managed, target: /managed }
      - { type: volume, source: external, target: /external }
      - { type: bind, source: /srv/shared, target: /shared }
`;
  setup({ yaml: source });
  expect(await screen.findByRole('region', { name: '卷文件 ui-managed' })).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: '卷文件 customer-data' })).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: /卷文件 \/srv\/shared/ })).not.toBeInTheDocument();
});

test('hides a collision-shaped external volume even when managed ownership labels and local driver match', async () => {
  const source = `volumes:
  collision:
    external: true
    name: external-managed-looking
    driver: local
    labels:
      agent-compose-ui.managed: 'true'
      agent-compose-ui.project-key: ${KEY}
agents:
  alpha:
    volumes: [{ type: volume, source: collision, target: /collision }]
`;
  setup({ yaml: source });
  await Promise.resolve();
  expect(screen.queryByRole('region', { name: '卷文件 external-managed-looking' })).not.toBeInTheDocument();
});

const MANAGED = `volumes:
  managed:
    name: ui-managed
    driver: local
    labels:
      agent-compose-ui.managed: 'true'
      agent-compose-ui.project-key: ${KEY}
agents:
  alpha:
    volumes: [{ type: volume, source: managed, target: /data }]
`;

test('deletes managed data only after YAML detach and actual apply succeed', async () => {
  const order: string[] = [];
  vi.mocked(volumeService.removeVolume).mockReset().mockImplementation(async () => { order.push('remove'); return { removed: true } as never; });
  const onYamlChange = vi.fn(async () => { order.push('detach'); });
  const onApply = vi.fn(async () => { order.push('apply'); });
  setup({ yaml: MANAGED, onYamlChange, onApply });
  await fireEvent.click(screen.getByRole('button', { name: '移除声明…' }));
  await fireEvent.click(screen.getByRole('button', { name: '删除数据并移除' }));
  await waitFor(() => expect(volumeService.removeVolume).toHaveBeenCalledOnce());
  expect(order).toEqual(['detach', 'apply', 'remove']);
  expect(volumeService.removeVolume).toHaveBeenCalledWith(expect.objectContaining({ name: 'ui-managed', force: true }));
});

test('never removes managed data when actual apply fails', async () => {
  vi.mocked(volumeService.removeVolume).mockReset();
  setup({ yaml: MANAGED, onApply: vi.fn().mockRejectedValue(new Error('apply offline')) });
  await fireEvent.click(screen.getByRole('button', { name: '移除声明…' }));
  await fireEvent.click(screen.getByRole('button', { name: '删除数据并移除' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('apply offline');
  expect(volumeService.removeVolume).not.toHaveBeenCalled();
});

test('keeps detached cleanup retryable after daemon removal fails', async () => {
  vi.mocked(volumeService.removeVolume).mockReset().mockRejectedValueOnce(new Error('daemon busy')).mockResolvedValueOnce({ removed: true } as never);
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ entries: [] }), { headers: { 'content-type': 'application/json' } })));
  const view = render(DataMountPanel, { yaml: MANAGED, projectKey: KEY, onYamlChange: vi.fn(), onApply: vi.fn().mockResolvedValue(undefined) });
  await fireEvent.click(screen.getByRole('button', { name: '移除声明…' }));
  await fireEvent.click(screen.getByRole('button', { name: '删除数据并移除' }));
  expect(await screen.findByText(/daemon busy/)).toBeInTheDocument();
  await view.rerender({ yaml: 'agents:\n  alpha: {}\n', projectKey: KEY, onYamlChange: vi.fn(), onApply: vi.fn() });
  await fireEvent.click(screen.getByRole('button', { name: '重试删除数据' }));
  await waitFor(() => expect(volumeService.removeVolume).toHaveBeenCalledTimes(2));
});

test('keeps initial cleanup pending when daemon reports removed false', async () => {
  vi.mocked(volumeService.removeVolume).mockReset().mockResolvedValue({ removed: false } as never);
  setup({ yaml: MANAGED });
  await fireEvent.click(screen.getByRole('button', { name: '移除声明…' }));
  await fireEvent.click(screen.getByRole('button', { name: '删除数据并移除' }));
  expect(await screen.findByText(/未确认删除/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '重试删除数据' })).toBeInTheDocument();
});

test('keeps retry pending when daemon reports removed false', async () => {
  vi.mocked(volumeService.removeVolume).mockReset().mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce({ removed: false } as never);
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ entries: [] }), { headers: { 'content-type': 'application/json' } })));
  const view = render(DataMountPanel, { yaml: MANAGED, projectKey: KEY, onYamlChange: vi.fn(), onApply: vi.fn().mockResolvedValue(undefined) });
  await fireEvent.click(screen.getByRole('button', { name: '移除声明…' })); await fireEvent.click(screen.getByRole('button', { name: '删除数据并移除' }));
  await screen.findByText(/busy/);
  await view.rerender({ yaml: 'agents:\n  alpha: {}\n', projectKey: KEY, onYamlChange: vi.fn(), onApply: vi.fn() });
  await fireEvent.click(screen.getByRole('button', { name: '重试删除数据' }));
  expect(await screen.findByText(/未确认删除/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '重试删除数据' })).toBeInTheDocument();
});

test('preserves daemon data when the user only removes the YAML declaration', async () => {
  vi.mocked(volumeService.removeVolume).mockReset();
  const onYamlChange = setup({ yaml: MANAGED });
  await fireEvent.click(screen.getByRole('button', { name: '移除声明…' }));
  await fireEvent.click(screen.getByRole('button', { name: '仅移除并保留数据' }));
  await waitFor(() => expect(onYamlChange).toHaveBeenCalledOnce());
  expect(volumeService.removeVolume).not.toHaveBeenCalled();
});

test('keeps a late initial cleanup failure under its original project and restores it on return', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ entries: [] }), { headers: { 'content-type': 'application/json' } })));
  let rejectRemove!: (error: unknown) => void;
  vi.mocked(volumeService.removeVolume).mockReset().mockReturnValue(new Promise((_, reject) => { rejectRemove = reject; }));
  const onYamlChange = vi.fn(); const onApply = vi.fn().mockResolvedValue(undefined);
  const view = render(DataMountPanel, { yaml: MANAGED, projectKey: KEY, onYamlChange, onApply });
  await fireEvent.click(screen.getByRole('button', { name: '移除声明…' }));
  await fireEvent.click(screen.getByRole('button', { name: '删除数据并移除' }));
  await view.rerender({ yaml: 'agents:\n  other: {}\n', projectKey: 'ws_fedcba9876543210fedcba9876543210', onYamlChange, onApply });
  rejectRemove(new Error('old daemon busy'));
  await waitFor(() => expect(screen.queryByText(/old daemon busy/)).not.toBeInTheDocument());
  await view.rerender({ yaml: 'agents:\n  alpha: {}\n', projectKey: KEY, onYamlChange, onApply });
  expect(await screen.findByRole('alert')).toHaveTextContent('old daemon busy');
  expect(screen.getByRole('button', { name: '重试删除数据' })).toBeInTheDocument();
  expect(onYamlChange).toHaveBeenCalledOnce(); expect(onApply).toHaveBeenCalledOnce();
});

test('keeps retry completion scoped to its cleanup identity across project switches', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ entries: [] }), { headers: { 'content-type': 'application/json' } })));
  let rejectRetry!: (error: unknown) => void;
  vi.mocked(volumeService.removeVolume).mockReset().mockRejectedValueOnce(new Error('first failure'))
    .mockReturnValueOnce(new Promise((_, reject) => { rejectRetry = reject; }));
  const onYamlChange = vi.fn(); const onApply = vi.fn().mockResolvedValue(undefined);
  const view = render(DataMountPanel, { yaml: MANAGED, projectKey: KEY, onYamlChange, onApply });
  await fireEvent.click(screen.getByRole('button', { name: '移除声明…' }));
  await fireEvent.click(screen.getByRole('button', { name: '删除数据并移除' }));
  await view.rerender({ yaml: 'agents:\n  alpha: {}\n', projectKey: KEY, onYamlChange, onApply });
  await fireEvent.click(await screen.findByRole('button', { name: '重试删除数据' }));
  await view.rerender({ yaml: 'agents:\n  other: {}\n', projectKey: 'ws_fedcba9876543210fedcba9876543210', onYamlChange, onApply });
  rejectRetry(new Error('retry still busy'));
  await waitFor(() => expect(screen.queryByText(/retry still busy/)).not.toBeInTheDocument());
  await view.rerender({ yaml: 'agents:\n  alpha: {}\n', projectKey: KEY, onYamlChange, onApply });
  expect(await screen.findByRole('alert')).toHaveTextContent('retry still busy');
  expect(onYamlChange).toHaveBeenCalledOnce(); expect(onApply).toHaveBeenCalledOnce();
  expect(volumeService.removeVolume).toHaveBeenCalledTimes(2);
  expect(volumeService.removeVolume).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'ui-managed', force: true }));
});

test('cancels pending physical cleanup when the same system volume is redeclared', async () => {
  vi.mocked(volumeService.removeVolume).mockReset().mockRejectedValueOnce(new Error('busy'));
  const view = render(DataMountPanel, { yaml: MANAGED, projectKey: KEY, onYamlChange: vi.fn(), onApply: vi.fn().mockResolvedValue(undefined) });
  await fireEvent.click(screen.getByRole('button', { name: '移除声明…' }));
  await fireEvent.click(screen.getByRole('button', { name: '删除数据并移除' }));
  await screen.findByRole('button', { name: '重试删除数据' });
  await view.rerender({ yaml: 'agents:\n  alpha: {}\n', projectKey: KEY, onYamlChange: vi.fn(), onApply: vi.fn() });
  await view.rerender({ yaml: MANAGED, projectKey: KEY, onYamlChange: vi.fn(), onApply: vi.fn() });
  expect(await screen.findByRole('alert')).toHaveTextContent('已重新声明或挂载');
  expect(screen.queryByRole('button', { name: '重试删除数据' })).not.toBeInTheDocument();
  expect(volumeService.removeVolume).toHaveBeenCalledOnce();
});

test('cancels pending physical cleanup when an agent remounts the old declaration key', async () => {
  vi.mocked(volumeService.removeVolume).mockReset().mockRejectedValueOnce(new Error('busy'));
  const view = render(DataMountPanel, { yaml: MANAGED, projectKey: KEY, onYamlChange: vi.fn(), onApply: vi.fn().mockResolvedValue(undefined) });
  await fireEvent.click(screen.getByRole('button', { name: '移除声明…' }));
  await fireEvent.click(screen.getByRole('button', { name: '删除数据并移除' }));
  await screen.findByRole('button', { name: '重试删除数据' });
  await view.rerender({ yaml: 'agents:\n  alpha: {}\n', projectKey: KEY, onYamlChange: vi.fn(), onApply: vi.fn() });
  await view.rerender({ yaml: 'agents:\n  alpha:\n    volumes: [{ type: volume, source: managed, target: /again }]\n', projectKey: KEY, onYamlChange: vi.fn(), onApply: vi.fn() });
  expect(await screen.findByRole('alert')).toHaveTextContent('已重新声明或挂载');
  expect(volumeService.removeVolume).toHaveBeenCalledOnce();
});

test('keeps an already-issued delete guarded while YAML is edited and releases after RPC settlement', async () => {
  let resolveRemove!: (value: never) => void;
  vi.mocked(volumeService.removeVolume).mockReset().mockReturnValue(new Promise((resolve) => { resolveRemove = resolve; }));
  const view = render(DataMountPanel, { yaml: MANAGED, projectKey: KEY, onYamlChange: vi.fn(), onApply: vi.fn().mockResolvedValue(undefined) });
  await fireEvent.click(screen.getByRole('button', { name: '移除声明…' })); await fireEvent.click(screen.getByRole('button', { name: '删除数据并移除' }));
  await waitFor(() => expect(() => managedVolumeDeletionGuard.assertApplyAllowed()).toThrow(/正在删除/));
  await view.rerender({ yaml: `${MANAGED}\n# edited while deleting\n`, projectKey: KEY, onYamlChange: vi.fn(), onApply: vi.fn() });
  expect(await screen.findByText(/请等待完成后再应用/)).toBeInTheDocument();
  expect(() => managedVolumeDeletionGuard.assertApplyAllowed()).toThrow(/正在删除/);
  resolveRemove({ removed: true } as never);
  await waitFor(() => expect(() => managedVolumeDeletionGuard.assertApplyAllowed()).not.toThrow());
  expect(await screen.findByText(/再次应用会创建新的卷/)).toBeInTheDocument();
});
