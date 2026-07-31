import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import CacheListView from './CacheListView.svelte';
import VolumeListView from './VolumeListView.svelte';
import { CacheDomain, CacheItem, CacheStatus, Volume } from '../gen/agentcompose/v2/agentcompose_pb';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const rpc = vi.hoisted(() => ({
  cacheService: { listCaches: vi.fn(), inspectCache: vi.fn(), pruneCaches: vi.fn(), removeCache: vi.fn() },
  volumeService: { listVolumes: vi.fn(), inspectVolume: vi.fn(), createVolume: vi.fn(), removeVolume: vi.fn(), pruneVolumes: vi.fn() },
}));

vi.mock('../lib/rpc', () => rpc);

const cache = new CacheItem({
  cacheId: 'cache-1', driver: 'docker', domain: CacheDomain.RUNTIME_DERIVED_CACHE,
  kind: 'build', status: CacheStatus.UNUSED, removable: true, blockedReasons: ['仍被任务引用'], warnings: ['缓存警告'],
});
const volume = new Volume({ name: 'data-one', driver: 'local', projectId: 'project-1', path: '/volumes/data-one' });

beforeEach(() => {
  vi.clearAllMocks();
  rpc.cacheService.listCaches.mockResolvedValue({ caches: [cache], warnings: ['列表部分失败'] });
  rpc.cacheService.inspectCache.mockResolvedValue({ cache, warnings: ['详情警告'] });
  rpc.volumeService.listVolumes.mockResolvedValue({ volumes: [volume] });
  rpc.volumeService.inspectVolume.mockResolvedValue({ volume });
});

describe('CacheListView', () => {
  test('keeps the newest cache list and inspect responses when older requests resolve last', async () => {
    const oldList = deferred<any>();
    const oldInspect = deferred<any>();
    const newest = new CacheItem({ cacheId: 'cache-new' });
    rpc.cacheService.listCaches.mockReturnValueOnce(oldList.promise).mockResolvedValueOnce({ caches: [newest], warnings: [] });
    rpc.cacheService.inspectCache.mockReturnValueOnce(oldInspect.promise).mockResolvedValueOnce({ cache: newest, warnings: [] });
    render(CacheListView);
    await fireEvent.click(screen.getByRole('button', { name: '应用筛选' }));
    expect(await screen.findByText('cache-new')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /检查 cache-new/ }));
    await waitFor(() => expect(rpc.cacheService.inspectCache).toHaveBeenCalledTimes(1));
    await fireEvent.click(screen.getByRole('button', { name: /检查 cache-new/ }));
    oldList.resolve({ caches: [cache], warnings: ['stale'] });
    oldInspect.resolve({ cache, warnings: [] });
    await Promise.resolve();
    expect(screen.queryByText('cache-1')).not.toBeInTheDocument();
    expect(screen.getByText('缓存详情：cache-new')).toBeInTheDocument();
  });
  test('constructs filters, inspects, and preserves partial list warnings', async () => {
    render(CacheListView);
    await screen.findByText('cache-1');
    expect(screen.getByText('列表部分失败')).toBeInTheDocument();

    await fireEvent.input(screen.getByLabelText('缓存驱动'), { target: { value: 'docker' } });
    await fireEvent.change(screen.getByLabelText('缓存域'), { target: { value: String(CacheDomain.RUNTIME_DERIVED_CACHE) } });
    await fireEvent.input(screen.getByLabelText('缓存类型'), { target: { value: 'build' } });
    await fireEvent.change(screen.getByLabelText('缓存状态'), { target: { value: String(CacheStatus.UNUSED) } });
    await fireEvent.input(screen.getByLabelText('超过天数未使用'), { target: { value: '7' } });
    await fireEvent.click(screen.getByRole('button', { name: '应用筛选' }));
    await waitFor(() => expect(rpc.cacheService.listCaches).toHaveBeenCalledTimes(2));
    const request = rpc.cacheService.listCaches.mock.calls.at(-1)![0];
    expect(request.filter.driver).toBe('docker');
    expect(request.filter.domain).toBe(CacheDomain.RUNTIME_DERIVED_CACHE);
    expect(request.filter.type).toBe('build');
    expect(request.filter.status).toBe(CacheStatus.UNUSED);
    expect(request.filter.olderThanSeconds).toBe(604800n);

    await fireEvent.click(screen.getByRole('button', { name: /检查 cache-1/ }));
    expect(rpc.cacheService.inspectCache).toHaveBeenCalledWith(expect.objectContaining({ cacheId: 'cache-1' }));
    expect(await screen.findByText('详情警告')).toBeInTheDocument();
  });

  test('previews then confirms prune and single removal with force only in phase two', async () => {
    rpc.cacheService.pruneCaches
      .mockResolvedValueOnce({ dryRun: true, matched: [cache], removed: [], skipped: [cache], warnings: ['预览警告'] })
      .mockResolvedValueOnce({ dryRun: false, matched: [cache], removed: ['cache-1'], skipped: [], warnings: ['执行警告'] });
    rpc.cacheService.removeCache
      .mockResolvedValueOnce({ dryRun: true, matched: [cache], removed: [], skipped: [cache], warnings: ['删除预览'] })
      .mockResolvedValueOnce({ dryRun: false, matched: [cache], removed: ['cache-1'], skipped: [], warnings: [] });
    render(CacheListView);
    await screen.findByText('cache-1');

    await fireEvent.click(screen.getByRole('button', { name: '预览清理' }));
    expect(rpc.cacheService.pruneCaches.mock.calls[0][0]).toEqual(expect.objectContaining({ force: false }));
    expect(await screen.findByText('预览警告')).toBeInTheDocument();
    expect(screen.getAllByText(/仍被任务引用/)).not.toHaveLength(0);
    await fireEvent.click(screen.getByRole('button', { name: '确认执行清理' }));
    expect(rpc.cacheService.pruneCaches.mock.calls[1][0]).toEqual(expect.objectContaining({ force: true }));
    expect(await screen.findByText('cache-1', { selector: '.removed-item' })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: /删除 cache-1/ }));
    expect(rpc.cacheService.removeCache.mock.calls[0][0]).toEqual(expect.objectContaining({ cacheId: 'cache-1', force: false }));
    expect(await screen.findAllByText('删除预览')).not.toHaveLength(0);
    await fireEvent.click(screen.getByRole('button', { name: '确认删除缓存' }));
    expect(rpc.cacheService.removeCache.mock.calls[1][0]).toEqual(expect.objectContaining({ cacheId: 'cache-1', force: true }));
  });

  test('executes cache prune with the successful preview snapshot after filters change', async () => {
    rpc.cacheService.pruneCaches
      .mockResolvedValueOnce({ dryRun: true, matched: [cache], removed: [], skipped: [], warnings: [] })
      .mockResolvedValueOnce({ dryRun: false, matched: [cache], removed: ['cache-1'], skipped: [], warnings: [] });
    render(CacheListView);
    await screen.findByText('cache-1');
    await fireEvent.input(screen.getByLabelText('缓存驱动'), { target: { value: 'preview-driver' } });
    await fireEvent.input(screen.getByLabelText('缓存类型'), { target: { value: 'preview-kind' } });
    await fireEvent.click(screen.getByRole('button', { name: '预览清理' }));
    await screen.findByRole('button', { name: '确认执行清理' });

    await fireEvent.input(screen.getByLabelText('缓存驱动'), { target: { value: 'changed-driver' } });
    await fireEvent.input(screen.getByLabelText('缓存类型'), { target: { value: 'changed-kind' } });
    await fireEvent.click(screen.getByRole('button', { name: '确认执行清理' }));

    const preview = rpc.cacheService.pruneCaches.mock.calls[0][0];
    const execute = rpc.cacheService.pruneCaches.mock.calls[1][0];
    expect(execute.force).toBe(true);
    expect(execute.filter.driver).toBe(preview.filter.driver);
    expect(execute.filter.type).toBe(preview.filter.type);
  });

  test('keeps referenced caches excluded by default and executes the disclosed dangerous preview snapshot', async () => {
    rpc.cacheService.pruneCaches
      .mockResolvedValueOnce({ dryRun: true, matched: [cache], removed: [], skipped: [], warnings: [] })
      .mockResolvedValueOnce({ dryRun: false, matched: [cache], removed: ['cache-1'], skipped: [], warnings: [] });
    render(CacheListView);
    await screen.findByText('cache-1');
    expect(screen.queryByRole('checkbox', { name: /仍被引用的缓存/ })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: '显示危险选项' }));
    const includeReferenced = screen.getByRole('checkbox', { name: /仍被引用的缓存/ });
    expect(includeReferenced).not.toBeChecked();
    expect(screen.getByText(/可能破坏仍引用这些缓存的任务或沙箱/)).toBeInTheDocument();
    await fireEvent.click(includeReferenced);
    await fireEvent.click(screen.getByRole('button', { name: '预览清理' }));
    await screen.findByRole('button', { name: '确认执行清理' });
    expect(rpc.cacheService.pruneCaches.mock.calls[0][0].includeReferenced).toBe(true);

    await fireEvent.click(includeReferenced);
    await fireEvent.click(screen.getByRole('button', { name: '确认执行清理' }));
    expect(rpc.cacheService.pruneCaches.mock.calls[1][0]).toEqual(expect.objectContaining({ includeReferenced: true, force: true }));
  });

  test('disables includeReferenced when its dangerous disclosure is hidden', async () => {
    rpc.cacheService.pruneCaches.mockResolvedValueOnce({ dryRun: true, matched: [], removed: [], skipped: [], warnings: [] });
    render(CacheListView);
    await screen.findByText('cache-1');
    await fireEvent.click(screen.getByRole('button', { name: '显示危险选项' }));
    await fireEvent.click(screen.getByRole('checkbox', { name: /仍被引用的缓存/ }));
    await fireEvent.click(screen.getByRole('button', { name: '隐藏危险选项' }));
    await fireEvent.click(screen.getByRole('button', { name: '预览清理' }));
    expect(rpc.cacheService.pruneCaches.mock.calls[0][0].includeReferenced).toBe(false);
  });

  test('hiding a dangerous referenced-cache preview revokes its confirmation authorization', async () => {
    rpc.cacheService.pruneCaches.mockResolvedValueOnce({ dryRun: true, matched: [cache], removed: [], skipped: [], warnings: [] });
    render(CacheListView);
    await screen.findByText('cache-1');
    await fireEvent.click(screen.getByRole('button', { name: '显示危险选项' }));
    await fireEvent.click(screen.getByRole('checkbox', { name: /仍被引用的缓存/ }));
    await fireEvent.click(screen.getByRole('button', { name: '预览清理' }));
    await screen.findByRole('button', { name: '确认执行清理' });

    await fireEvent.click(screen.getByRole('button', { name: '隐藏危险选项' }));
    expect(screen.queryByRole('button', { name: '确认执行清理' })).not.toBeInTheDocument();
    expect(screen.queryByText('清理预览')).not.toBeInTheDocument();
    expect(rpc.cacheService.pruneCaches.mock.calls.filter(([request]) => request.force)).toHaveLength(0);
  });

  test('cannot hide dangerous options while their preview request is in flight', async () => {
    const preview = deferred<any>();
    rpc.cacheService.pruneCaches.mockReturnValueOnce(preview.promise);
    render(CacheListView);
    await screen.findByText('cache-1');
    await fireEvent.click(screen.getByRole('button', { name: '显示危险选项' }));
    await fireEvent.click(screen.getByRole('checkbox', { name: /仍被引用的缓存/ }));
    await fireEvent.click(screen.getByRole('button', { name: '预览清理' }));

    const hide = screen.getByRole('button', { name: '隐藏危险选项' });
    expect(hide).toBeDisabled();
    await fireEvent.click(hide);
    expect(screen.getByRole('checkbox', { name: /仍被引用的缓存/ })).toBeChecked();

    preview.resolve({ dryRun: true, matched: [cache], removed: [], skipped: [], warnings: [] });
    expect(await screen.findByRole('button', { name: '确认执行清理' })).toBeInTheDocument();
    expect(screen.getByText(/可能破坏仍引用这些缓存/)).toBeInTheDocument();
  });

  test('revokes old cache removal confirmation when a new preview fails', async () => {
    rpc.cacheService.removeCache
      .mockResolvedValueOnce({ dryRun: true, matched: [cache], removed: [], skipped: [], warnings: [] });
    rpc.cacheService.pruneCaches.mockRejectedValueOnce(new Error('preview B failed'));
    render(CacheListView);
    await screen.findByText('cache-1');
    await fireEvent.click(screen.getByRole('button', { name: /删除 cache-1/ }));
    await screen.findByRole('button', { name: '确认删除缓存' });

    await fireEvent.click(screen.getByRole('button', { name: '预览清理' }));
    expect(await screen.findByText(/preview B failed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认删除缓存' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认执行清理' })).not.toBeInTheDocument();
    expect(rpc.cacheService.removeCache).toHaveBeenCalledTimes(1);
  });

  test('blocks concurrent cache previews while a deferred preview owns authorization', async () => {
    const first = deferred<any>();
    rpc.cacheService.removeCache.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ dryRun: false, matched: [cache], removed: ['cache-1'], skipped: [], warnings: [] });
    render(CacheListView);
    await screen.findByText('cache-1');
    const removeButton = screen.getByRole('button', { name: /删除 cache-1/ });
    await fireEvent.click(removeButton);

    expect(removeButton).toBeDisabled();
    expect(screen.getByRole('button', { name: '预览清理' })).toBeDisabled();
    await fireEvent.click(screen.getByRole('button', { name: '预览清理' }));
    expect(rpc.cacheService.pruneCaches).not.toHaveBeenCalled();

    first.resolve({ dryRun: true, matched: [cache], removed: [], skipped: [], warnings: [] });
    const confirm = await screen.findByRole('button', { name: '确认删除缓存' });
    await fireEvent.click(confirm);
    await fireEvent.click(confirm);
    expect(rpc.cacheService.removeCache.mock.calls.filter(([request]) => request.force)).toHaveLength(1);
  });
});

describe('VolumeListView', () => {
  test('keeps the newest volume list and inspect responses when older requests resolve last', async () => {
    const oldList = deferred<any>();
    const oldInspect = deferred<any>();
    const newest = new Volume({ name: 'volume-new' });
    rpc.volumeService.listVolumes.mockReturnValueOnce(oldList.promise).mockResolvedValueOnce({ volumes: [newest] });
    rpc.volumeService.inspectVolume.mockReturnValueOnce(oldInspect.promise).mockResolvedValueOnce({ volume: newest });
    render(VolumeListView);
    await fireEvent.click(screen.getByRole('button', { name: '应用筛选' }));
    expect(await screen.findByText('volume-new')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /检查 volume-new/ }));
    await waitFor(() => expect(rpc.volumeService.inspectVolume).toHaveBeenCalledTimes(1));
    await fireEvent.click(screen.getByRole('button', { name: /检查 volume-new/ }));
    oldList.resolve({ volumes: [volume] });
    oldInspect.resolve({ volume });
    await Promise.resolve();
    expect(screen.queryByText('data-one')).not.toBeInTheDocument();
    expect(screen.getByText('数据卷详情：volume-new')).toBeInTheDocument();
  });
  test('constructs list/inspect/create requests and states that YAML is unchanged', async () => {
    rpc.volumeService.createVolume.mockResolvedValue({ volume: new Volume({ name: 'created', driver: 'local' }), created: true });
    render(VolumeListView);
    await screen.findByText('data-one');
    expect(screen.getAllByText(/不会修改.*YAML/)).not.toHaveLength(0);

    await fireEvent.input(screen.getByLabelText('卷查询'), { target: { value: 'data' } });
    await fireEvent.input(screen.getByLabelText('卷驱动'), { target: { value: 'local' } });
    await fireEvent.input(screen.getByLabelText('项目 ID'), { target: { value: 'project-1' } });
    await fireEvent.click(screen.getByRole('button', { name: '应用筛选' }));
    await waitFor(() => expect(rpc.volumeService.listVolumes).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'data', driver: 'local', projectId: 'project-1' })));
    await fireEvent.click(screen.getByRole('button', { name: /检查 data-one/ }));
    expect(rpc.volumeService.inspectVolume).toHaveBeenCalledWith(expect.objectContaining({ name: 'data-one' }));

    await fireEvent.input(screen.getByLabelText('新卷名称'), { target: { value: 'created' } });
    await fireEvent.input(screen.getByLabelText('新卷驱动'), { target: { value: 'local' } });
    await fireEvent.click(screen.getByRole('button', { name: '创建卷' }));
    expect(rpc.volumeService.createVolume).toHaveBeenCalledWith(expect.objectContaining({ name: 'created', driver: 'local' }));
  });

  test('creates a volume with trimmed label and option maps', async () => {
    rpc.volumeService.createVolume.mockResolvedValue({ volume: new Volume({ name: 'created', driver: 'local' }), created: true });
    render(VolumeListView);
    await screen.findByText('data-one');
    await fireEvent.input(screen.getByLabelText('新卷名称'), { target: { value: 'created' } });
    await fireEvent.click(screen.getByRole('button', { name: '添加标签' }));
    await fireEvent.input(screen.getByLabelText('标签键 1'), { target: { value: ' team ' } });
    await fireEvent.input(screen.getByLabelText('标签值 1'), { target: { value: ' platform ' } });
    await fireEvent.click(screen.getByRole('button', { name: '添加选项' }));
    await fireEvent.input(screen.getByLabelText('选项键 1'), { target: { value: ' type ' } });
    await fireEvent.input(screen.getByLabelText('选项值 1'), { target: { value: ' tmpfs ' } });
    await fireEvent.click(screen.getByRole('button', { name: '创建卷' }));

    const request = rpc.volumeService.createVolume.mock.calls[0][0];
    expect(request.labels).toEqual({ team: 'platform' });
    expect(request.options).toEqual({ type: 'tmpfs' });
    expect(request.labels).not.toBeInstanceOf(Map);
  });

  test('rejects empty and duplicate trimmed volume map keys before sending a request', async () => {
    render(VolumeListView);
    await screen.findByText('data-one');
    await fireEvent.input(screen.getByLabelText('新卷名称'), { target: { value: 'created' } });
    await fireEvent.click(screen.getByRole('button', { name: '添加标签' }));
    await fireEvent.click(screen.getByRole('button', { name: '添加标签' }));
    await fireEvent.input(screen.getByLabelText('标签键 2'), { target: { value: '   ' } });
    await fireEvent.click(screen.getByRole('button', { name: '创建卷' }));
    expect(await screen.findByText('标签键不能为空')).toBeInTheDocument();
    expect(rpc.volumeService.createVolume).not.toHaveBeenCalled();

    await fireEvent.input(screen.getByLabelText('标签键 1'), { target: { value: 'team' } });
    await fireEvent.input(screen.getByLabelText('标签键 2'), { target: { value: ' team ' } });
    await fireEvent.click(screen.getByRole('button', { name: '创建卷' }));
    expect(await screen.findByText('标签键不能重复：team')).toBeInTheDocument();
    expect(rpc.volumeService.createVolume).not.toHaveBeenCalled();
  });

  test('previews then confirms prune and removal using false then true force', async () => {
    rpc.volumeService.pruneVolumes
      .mockResolvedValueOnce({ dryRun: true, matched: [volume], removed: [], skipped: [volume] })
      .mockResolvedValueOnce({ dryRun: false, matched: [volume], removed: [volume], skipped: [] });
    rpc.volumeService.removeVolume
      .mockResolvedValueOnce({ name: 'data-one', removed: false })
      .mockResolvedValueOnce({ name: 'data-one', removed: true });
    render(VolumeListView);
    await screen.findByText('data-one');

    await fireEvent.click(screen.getByRole('button', { name: '预览清理' }));
    expect(rpc.volumeService.pruneVolumes.mock.calls[0][0]).toEqual(expect.objectContaining({ force: false }));
    expect(await screen.findByText('匹配项 (1)')).toBeInTheDocument();
    expect(screen.getByText('跳过项 (1)')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: '确认执行清理' }));
    expect(rpc.volumeService.pruneVolumes.mock.calls[1][0]).toEqual(expect.objectContaining({ force: true }));
    expect(await screen.findByText('已移除 (1)')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: /删除 data-one/ }));
    expect(rpc.volumeService.removeVolume.mock.calls[0][0]).toEqual(expect.objectContaining({ name: 'data-one', force: false }));
    expect(await screen.findByText(/预览结果.*尚未移除/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: '确认删除卷' }));
    expect(rpc.volumeService.removeVolume.mock.calls[1][0]).toEqual(expect.objectContaining({ name: 'data-one', force: true }));
    expect(await screen.findByText(/执行结果.*已移除/)).toBeInTheDocument();
  });

  test('executes volume prune with the successful preview snapshot after filters change', async () => {
    rpc.volumeService.pruneVolumes
      .mockResolvedValueOnce({ dryRun: true, matched: [volume], removed: [], skipped: [] })
      .mockResolvedValueOnce({ dryRun: false, matched: [volume], removed: [volume], skipped: [] });
    render(VolumeListView);
    await screen.findByText('data-one');
    await fireEvent.input(screen.getByLabelText('卷查询'), { target: { value: 'preview-query' } });
    await fireEvent.input(screen.getByLabelText('卷驱动'), { target: { value: 'preview-driver' } });
    await fireEvent.input(screen.getByLabelText('项目 ID'), { target: { value: 'preview-project' } });
    await fireEvent.click(screen.getByRole('button', { name: '预览清理' }));
    await screen.findByRole('button', { name: '确认执行清理' });

    await fireEvent.input(screen.getByLabelText('卷查询'), { target: { value: 'changed-query' } });
    await fireEvent.input(screen.getByLabelText('卷驱动'), { target: { value: 'changed-driver' } });
    await fireEvent.input(screen.getByLabelText('项目 ID'), { target: { value: 'changed-project' } });
    await fireEvent.click(screen.getByRole('button', { name: '确认执行清理' }));

    const preview = rpc.volumeService.pruneVolumes.mock.calls[0][0];
    const execute = rpc.volumeService.pruneVolumes.mock.calls[1][0];
    expect(execute).toEqual(expect.objectContaining({ force: true, query: preview.query, driver: preview.driver, projectId: preview.projectId }));
  });

  test('revokes old volume prune confirmation when a removal preview fails', async () => {
    rpc.volumeService.pruneVolumes.mockResolvedValueOnce({ dryRun: true, matched: [volume], removed: [], skipped: [] });
    rpc.volumeService.removeVolume.mockRejectedValueOnce(new Error('remove preview failed'));
    render(VolumeListView);
    await screen.findByText('data-one');
    await fireEvent.click(screen.getByRole('button', { name: '预览清理' }));
    await screen.findByRole('button', { name: '确认执行清理' });

    await fireEvent.click(screen.getByRole('button', { name: /删除 data-one/ }));
    expect(await screen.findByText(/remove preview failed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认执行清理' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认删除卷' })).not.toBeInTheDocument();
    expect(rpc.volumeService.pruneVolumes).toHaveBeenCalledTimes(1);
  });

  test('blocks concurrent volume previews and double confirm while a request is deferred', async () => {
    const preview = deferred<any>();
    const execute = deferred<any>();
    rpc.volumeService.pruneVolumes.mockReturnValueOnce(preview.promise).mockReturnValueOnce(execute.promise);
    render(VolumeListView);
    await screen.findByText('data-one');
    const pruneButton = screen.getByRole('button', { name: '预览清理' });
    await fireEvent.click(pruneButton);

    expect(pruneButton).toBeDisabled();
    expect(screen.getByRole('button', { name: /删除 data-one/ })).toBeDisabled();
    await fireEvent.click(screen.getByRole('button', { name: /删除 data-one/ }));
    expect(rpc.volumeService.removeVolume).not.toHaveBeenCalled();

    preview.resolve({ dryRun: true, matched: [volume], removed: [], skipped: [] });
    const confirm = await screen.findByRole('button', { name: '确认执行清理' });
    await fireEvent.click(confirm);
    await fireEvent.click(confirm);
    expect(rpc.volumeService.pruneVolumes.mock.calls.filter(([request]) => request.force)).toHaveLength(1);
    execute.resolve({ dryRun: false, matched: [volume], removed: [volume], skipped: [] });
  });
});
