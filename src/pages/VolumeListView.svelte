<script lang="ts">
  import { onMount } from 'svelte';
  import { volumeService } from '../lib/rpc';
  import { CreateVolumeRequest, InspectVolumeRequest, ListVolumesRequest, PruneVolumesRequest, RemoveVolumeRequest, type InspectVolumeResponse, type PruneVolumesResponse, type RemoveVolumeResponse, type Volume } from '../gen/agentcompose/v2/agentcompose_pb';
  import { formatVolumeTime, volumeName } from '../lib/volumes';

  let volumes: Volume[] = $state([]); let loading = $state(true); let error = $state(''); let query = $state(''); let driver = $state(''); let projectId = $state('');
  let inspected: InspectVolumeResponse | undefined = $state(); let inspecting = $state(false); let createName = $state(''); let createDriver = $state('local'); let createResult = $state('');
  type Pair = { key: string; value: string };
  let createLabels: Pair[] = $state([]); let createOptions: Pair[] = $state([]); let createValidationError = $state('');
  let pruneResult: PruneVolumesResponse | undefined = $state(); let removeResult: RemoveVolumeResponse | undefined = $state(); let resultTitle = $state(''); let pending: 'prune' | 'remove' | undefined = $state(); let removeTarget = $state(''); let operating = $state(false); let operationError = $state('');
  let pruneSnapshot: PruneVolumesRequest | undefined; let removeSnapshot: RemoveVolumeRequest | undefined;
  let operationGeneration = 0;
  let listGeneration = 0;
  let inspectGeneration = 0;

  function listRequest() { return new ListVolumesRequest({ query: query.trim(), driver: driver.trim(), projectId: projectId.trim() }); }
  async function load() { const generation = ++listGeneration; loading = true; error = ''; try { const response = await volumeService.listVolumes(listRequest()); if (generation === listGeneration) volumes = response.volumes; } catch (cause: any) { if (generation === listGeneration) error = cause?.message || '加载数据卷失败'; } finally { if (generation === listGeneration) loading = false; } }
  async function inspect(item: Volume) { const generation = ++inspectGeneration; inspecting = true; operationError = ''; try { const response = await volumeService.inspectVolume(new InspectVolumeRequest({ name: item.name })); if (generation === inspectGeneration) inspected = response; } catch (cause: any) { if (generation === inspectGeneration) operationError = cause?.message || '检查数据卷失败'; } finally { if (generation === inspectGeneration) inspecting = false; } }
  function pairMap(pairs: Pair[], label: string) {
    const result: Record<string, string> = {};
    for (const pair of pairs) {
      const key = pair.key.trim();
      if (!key) throw new Error(`${label}键不能为空`);
      if (Object.prototype.hasOwnProperty.call(result, key)) throw new Error(`${label}键不能重复：${key}`);
      result[key] = pair.value.trim();
    }
    return result;
  }
  async function create() {
    createValidationError = ''; operationError = '';
    let labels: Record<string, string>; let options: Record<string, string>;
    try { labels = pairMap(createLabels, '标签'); options = pairMap(createOptions, '选项'); }
    catch (cause: any) { createValidationError = cause.message; return; }
    operating = true;
    try { const response = await volumeService.createVolume(new CreateVolumeRequest({ name: createName.trim(), driver: createDriver.trim(), labels, options })); createResult = response.created ? `已创建 ${response.volume?.name || createName}` : `后端返回未创建 ${createName}`; await load(); } catch (cause: any) { operationError = cause?.message || '创建数据卷失败'; } finally { operating = false; }
  }
  function clearPreview() { pruneResult = undefined; removeResult = undefined; pending = undefined; removeTarget = ''; pruneSnapshot = undefined; removeSnapshot = undefined; }
  async function prune(force: boolean) {
    if (operating) return;
    const generation = ++operationGeneration;
    if (!force) clearPreview();
    const request = force
      ? (pruneSnapshot && new PruneVolumesRequest({ query: pruneSnapshot.query, driver: pruneSnapshot.driver, projectId: pruneSnapshot.projectId, force: true }))
      : new PruneVolumesRequest({ query: query.trim(), driver: driver.trim(), projectId: projectId.trim(), force: false });
    if (!request) return;
    if (force) { pending = undefined; pruneSnapshot = undefined; removeSnapshot = undefined; }
    operating = true; operationError = '';
    try { const response = await volumeService.pruneVolumes(request); if (generation !== operationGeneration) return; pruneResult = response; resultTitle = force ? '清理执行结果' : '清理预览'; if (!force) { pruneSnapshot = new PruneVolumesRequest({ query: request.query, driver: request.driver, projectId: request.projectId, force: false }); pending = 'prune'; } if (force) await load(); }
    catch (cause: any) { if (generation === operationGeneration) operationError = cause?.message || '清理数据卷失败'; }
    finally { if (generation === operationGeneration) operating = false; }
  }
  async function remove(name: string, force: boolean) {
    if (operating) return;
    const generation = ++operationGeneration;
    if (!force) clearPreview();
    const request = force ? (removeSnapshot && new RemoveVolumeRequest({ name: removeSnapshot.name, force: true })) : new RemoveVolumeRequest({ name, force: false });
    if (!request) return;
    if (force) { pending = undefined; pruneSnapshot = undefined; removeSnapshot = undefined; }
    operating = true; operationError = '';
    try { const response = await volumeService.removeVolume(request); if (generation !== operationGeneration) return; removeResult = response; resultTitle = force ? '删除执行结果' : '删除预览'; if (!force) { removeSnapshot = new RemoveVolumeRequest({ name: request.name, force: false }); removeTarget = request.name; pending = 'remove'; } if (force) await load(); }
    catch (cause: any) { if (generation === operationGeneration) operationError = cause?.message || '删除数据卷失败'; }
    finally { if (generation === operationGeneration) operating = false; }
  }
  onMount(() => { void load(); });
</script>

<div class="root"><header><div><div class="scope">daemon 资源</div><h1>数据卷</h1><p>这里仅创建和管理 daemon 全局资源，不会修改项目 YAML，也不进入 Runtime。</p></div><div class="actions"><button onclick={load} disabled={loading}>刷新</button><button class="danger" onclick={() => prune(false)} disabled={operating}>预览清理</button></div></header>
  <div class="filters"><input aria-label="卷查询" bind:value={query} placeholder="名称查询"/><input aria-label="卷驱动" bind:value={driver} placeholder="驱动"/><input aria-label="项目 ID" bind:value={projectId} placeholder="项目 ID"/><button onclick={load}>应用筛选</button></div>
  <section class="create"><strong>创建 daemon 数据卷</strong><span>只创建 daemon 资源，不会修改任何项目 YAML。</span><input aria-label="新卷名称" bind:value={createName} placeholder="名称"/><input aria-label="新卷驱动" bind:value={createDriver} placeholder="驱动"/><button onclick={() => createLabels = [...createLabels, { key: '', value: '' }]}>添加标签</button><button onclick={() => createOptions = [...createOptions, { key: '', value: '' }]}>添加选项</button>{#each createLabels as pair, index}<div class="pair"><input aria-label={`标签键 ${index + 1}`} bind:value={pair.key} placeholder="标签键"/><input aria-label={`标签值 ${index + 1}`} bind:value={pair.value} placeholder="标签值"/><button aria-label={`删除标签 ${index + 1}`} onclick={() => createLabels = createLabels.filter((_, itemIndex) => itemIndex !== index)}>×</button></div>{/each}{#each createOptions as pair, index}<div class="pair"><input aria-label={`选项键 ${index + 1}`} bind:value={pair.key} placeholder="选项键"/><input aria-label={`选项值 ${index + 1}`} bind:value={pair.value} placeholder="选项值"/><button aria-label={`删除选项 ${index + 1}`} onclick={() => createOptions = createOptions.filter((_, itemIndex) => itemIndex !== index)}>×</button></div>{/each}<button class="primary" onclick={create} disabled={operating || !createName.trim()}>创建卷</button>{#if createValidationError}<span class="error">{createValidationError}</span>{/if}{#if createResult}<span class="success">{createResult}</span>{/if}</section>
  {#if error}<section class="state error">加载失败：{error}<button onclick={load}>重试</button></section>{:else if loading && volumes.length === 0}<section class="state">正在读取 daemon 数据卷…</section>{:else if volumes.length === 0}<section class="state">没有匹配的数据卷</section>{:else}<div class="table"><div class="row head"><span>名称</span><span>驱动</span><span>项目</span><span>路径</span><span>更新时间</span><span>操作</span></div>{#each volumes as item (item.name)}<div class="row"><span class="mono">{volumeName(item)}</span><span>{item.driver || '未提供'}</span><span>{item.projectId || '全局'}</span><span class="mono">{item.path || '未提供'}</span><span>{formatVolumeTime(item.updatedAt)}</span><span class="actions"><button aria-label={`检查 ${volumeName(item)}`} onclick={() => inspect(item)}>检查</button><button class="danger" aria-label={`删除 ${volumeName(item)}`} onclick={() => remove(item.name, false)} disabled={operating}>删除</button></span></div>{/each}</div>{/if}
  {#if inspecting}<aside class="panel">正在检查数据卷…</aside>{:else if inspected?.volume}<aside class="panel"><h2>数据卷详情：{volumeName(inspected.volume)}</h2><div>驱动：{inspected.volume.driver || '后端未提供'}</div><div>路径：{inspected.volume.path || '后端未提供'}</div><div>项目：{inspected.volume.projectId || '全局'}</div></aside>{/if}
  {#if pruneResult}<section class="panel result" aria-live="polite"><h2>{resultTitle}</h2><div>后端 dry-run：{pruneResult.dryRun ? '是' : '否'}</div><h3>匹配项 ({pruneResult.matched.length})</h3>{#each pruneResult.matched as item}<div>{volumeName(item)}</div>{/each}<h3>已移除 ({pruneResult.removed.length})</h3>{#each pruneResult.removed as item}<div class="removed-item">{volumeName(item)}</div>{/each}<h3>跳过项 ({pruneResult.skipped.length})</h3>{#each pruneResult.skipped as item}<div>{volumeName(item)}</div>{/each}{#if pending === 'prune'}<button class="danger" onclick={() => prune(true)} disabled={operating}>确认执行清理</button>{/if}</section>{/if}
  {#if removeResult}<section class="panel result" aria-live="polite"><h2>{resultTitle}</h2><div>{resultTitle === '删除预览' ? '预览结果' : '执行结果'}：{removeResult.name || removeTarget} {removeResult.removed ? '已移除' : '尚未移除'}</div>{#if pending === 'remove'}<button class="danger" onclick={() => remove(removeTarget, true)} disabled={operating}>确认删除卷</button>{/if}</section>{/if}
  {#if operationError}<section class="panel error">操作失败：{operationError}</section>{/if}
</div>

<style>
  .root{height:100%;overflow:auto;padding:18px 20px;background:var(--bg-primary);color:var(--text-secondary)}header{display:flex;align-items:end;justify-content:space-between;border-bottom:1px solid var(--border-color);padding-bottom:14px}.scope{color:var(--accent-blue);font:var(--font-size-xs) var(--font-mono)}h1{margin:5px 0 0;color:var(--text-primary);font-size:var(--font-size-3xl)}h2{font-size:var(--font-size-md);color:var(--text-primary)}h3{margin:10px 0 4px;font-size:var(--font-size-sm)}p{margin:5px 0 0;color:var(--text-muted);font-size:var(--font-size-sm)}button,input{border:1px solid var(--border-color);border-radius:4px;background:var(--bg-tertiary);color:var(--text-secondary);padding:6px 8px;font-size:var(--font-size-sm)}.filters,.actions,.create{display:flex;align-items:center;gap:7px}.filters{padding:12px 0}.create{border:1px solid var(--border-color);padding:10px;margin-bottom:12px;font-size:var(--font-size-xs);flex-wrap:wrap}.create span{color:var(--text-muted)}.primary{background:var(--accent-blue);color:white}.danger,.error{color:var(--accent-red)}.success{color:var(--accent-green)!important}.state,.panel{border:1px solid var(--border-color);padding:12px;margin:12px 0;font-size:var(--font-size-sm)}.state{text-align:center;padding:36px}.table{border:1px solid var(--border-color)}.row{display:grid;grid-template-columns:1fr .7fr .8fr 1.4fr 1fr .8fr;gap:8px;align-items:center;padding:9px;border-bottom:1px solid var(--border-color);font-size:var(--font-size-xs)}.head{background:var(--bg-tertiary);color:var(--text-muted)}.mono{font-family:var(--font-mono);color:var(--text-primary);overflow-wrap:anywhere}.panel{background:var(--bg-secondary)}
</style>
