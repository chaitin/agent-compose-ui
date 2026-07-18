<script lang="ts">
  import { onMount } from 'svelte';
  import { cacheService } from '../lib/rpc';
  import { CacheDomain, CacheFilter, CacheStatus, InspectCacheRequest, ListCachesRequest, PruneCachesRequest, RemoveCacheRequest, type CacheItem, type InspectCacheResponse, type PruneCachesResponse, type RemoveCacheResponse } from '../gen/agentcompose/v2/agentcompose_pb';
  import { cacheDomainLabel, cacheId, cacheStatusLabel, formatBytes } from '../lib/caches';

  let caches: CacheItem[] = $state([]); let warnings: string[] = $state([]); let loading = $state(true); let error = $state('');
  let driver = $state(''); let domain: CacheDomain = $state(CacheDomain.UNSPECIFIED); let type = $state(''); let status: CacheStatus = $state(CacheStatus.UNSPECIFIED); let ageDays = $state('');
  let showDangerousOptions = $state(false); let includeReferenced = $state(false);
  let inspected: InspectCacheResponse | undefined = $state(); let inspecting = $state(false);
  let result: PruneCachesResponse | RemoveCacheResponse | undefined = $state(); let resultTitle = $state(''); let pending: 'prune' | 'remove' | undefined = $state(); let targetId = $state(''); let operating = $state(false); let operationError = $state('');
  let pruneSnapshot: PruneCachesRequest | undefined; let removeSnapshot: RemoveCacheRequest | undefined;
  let operationGeneration = 0;
  let listGeneration = 0;
  let inspectGeneration = 0;

  function filter() { return new CacheFilter({ driver: driver.trim(), domain, type: type.trim(), status, olderThanSeconds: BigInt(Math.max(0, Number(ageDays) || 0) * 86400) }); }
  function toggleDangerousOptions() {
    if (operating) return;
    showDangerousOptions = !showDangerousOptions;
    if (!showDangerousOptions) { includeReferenced = false; clearPreview(); }
  }
  async function load() { const generation = ++listGeneration; loading = true; error = ''; try { const response = await cacheService.listCaches(new ListCachesRequest({ filter: filter() })); if (generation !== listGeneration) return; caches = response.caches; warnings = response.warnings; } catch (cause: any) { if (generation === listGeneration) error = cause?.message || '加载缓存失败'; } finally { if (generation === listGeneration) loading = false; } }
  async function inspect(item: CacheItem) { const generation = ++inspectGeneration; inspecting = true; operationError = ''; try { const response = await cacheService.inspectCache(new InspectCacheRequest({ cacheId: item.cacheId })); if (generation === inspectGeneration) inspected = response; } catch (cause: any) { if (generation === inspectGeneration) operationError = cause?.message || '检查缓存失败'; } finally { if (generation === inspectGeneration) inspecting = false; } }
  function clearPreview() { result = undefined; pending = undefined; targetId = ''; pruneSnapshot = undefined; removeSnapshot = undefined; }
  async function prune(force: boolean) {
    if (operating) return;
    const generation = ++operationGeneration;
    if (!force) clearPreview();
    const request = force
      ? (pruneSnapshot && new PruneCachesRequest({ filter: pruneSnapshot.filter && new CacheFilter(pruneSnapshot.filter), includeReferenced: pruneSnapshot.includeReferenced, force: true }))
      : new PruneCachesRequest({ filter: filter(), includeReferenced, force: false });
    if (!request) return;
    if (force) { pending = undefined; pruneSnapshot = undefined; removeSnapshot = undefined; }
    operating = true; operationError = '';
    try { const response = await cacheService.pruneCaches(request); if (generation !== operationGeneration) return; result = response; resultTitle = force ? '清理执行结果' : '清理预览'; if (!force) { pruneSnapshot = new PruneCachesRequest({ filter: request.filter && new CacheFilter(request.filter), includeReferenced: request.includeReferenced, force: false }); pending = 'prune'; } if (force) await load(); }
    catch (cause: any) { if (generation === operationGeneration) operationError = cause?.message || '清理缓存失败'; }
    finally { if (generation === operationGeneration) operating = false; }
  }
  async function remove(id: string, force: boolean) {
    if (operating) return;
    const generation = ++operationGeneration;
    if (!force) clearPreview();
    const request = force ? (removeSnapshot && new RemoveCacheRequest({ cacheId: removeSnapshot.cacheId, force: true })) : new RemoveCacheRequest({ cacheId: id, force: false });
    if (!request) return;
    if (force) { pending = undefined; pruneSnapshot = undefined; removeSnapshot = undefined; }
    operating = true; operationError = '';
    try { const response = await cacheService.removeCache(request); if (generation !== operationGeneration) return; result = response; resultTitle = force ? '删除执行结果' : '删除预览'; if (!force) { removeSnapshot = new RemoveCacheRequest({ cacheId: request.cacheId, force: false }); targetId = request.cacheId; pending = 'remove'; } if (force) await load(); }
    catch (cause: any) { if (generation === operationGeneration) operationError = cause?.message || '删除缓存失败'; }
    finally { if (generation === operationGeneration) operating = false; }
  }
  onMount(() => { void load(); });
</script>

<div class="root"><header><div><div class="scope">daemon 资源</div><h1>缓存</h1><p>管理 daemon 全局缓存，不进入项目 YAML 或 Runtime。</p></div><div class="actions"><button onclick={load} disabled={loading}>刷新</button><button class="danger" onclick={() => prune(false)} disabled={operating}>预览清理</button></div></header>
  <div class="filters"><input aria-label="缓存驱动" bind:value={driver} placeholder="驱动"/><select aria-label="缓存域" value={domain} onchange={(event) => domain = Number(event.currentTarget.value) as CacheDomain}><option value={CacheDomain.UNSPECIFIED}>全部域</option><option value={CacheDomain.OCI_IMAGE_STORE}>OCI 镜像存储</option><option value={CacheDomain.MATERIALIZED_IMAGE_CACHE}>物化镜像</option><option value={CacheDomain.RUNTIME_DERIVED_CACHE}>运行时派生</option><option value={CacheDomain.SANDBOX_EPHEMERAL_STATE}>沙箱临时</option></select><input aria-label="缓存类型" bind:value={type} placeholder="类型"/><select aria-label="缓存状态" value={status} onchange={(event) => status = Number(event.currentTarget.value) as CacheStatus}><option value={CacheStatus.UNSPECIFIED}>全部状态</option><option value={CacheStatus.ACTIVE}>活跃</option><option value={CacheStatus.REFERENCED}>被引用</option><option value={CacheStatus.UNUSED}>未使用</option><option value={CacheStatus.EXPIRED}>过期</option><option value={CacheStatus.ORPHANED}>孤立</option></select><input aria-label="超过天数未使用" type="number" min="0" bind:value={ageDays} placeholder="未使用天数"/><button onclick={load}>应用筛选</button></div>
  <section class="danger-options"><button onclick={toggleDangerousOptions} disabled={operating}>{showDangerousOptions ? '隐藏危险选项' : '显示危险选项'}</button>{#if showDangerousOptions}<label><input type="checkbox" bind:checked={includeReferenced} disabled={operating}/>清理仍被引用的缓存</label><span>高风险：可能破坏仍引用这些缓存的任务或沙箱。执行前必须先用相同选项成功预览。</span>{/if}</section>
  {#if warnings.length}<section class="notice warning"><strong>部分结果</strong>{#each warnings as warning}<div>{warning}</div>{/each}</section>{/if}
  {#if error}<section class="state error">加载失败：{error}<button onclick={load}>重试</button></section>{:else if loading && caches.length === 0}<section class="state">正在读取 daemon 缓存…</section>{:else if caches.length === 0}<section class="state">没有匹配的缓存</section>{:else}<div class="table"><div class="row head"><span>ID</span><span>驱动 / 类型</span><span>域</span><span>状态</span><span>大小</span><span>操作</span></div>{#each caches as item (item.cacheId)}<div class="row"><span class="mono">{cacheId(item)}</span><span>{item.driver || '未提供'} / {item.kind || '未提供'}</span><span>{cacheDomainLabel(item.domain)}</span><span>{cacheStatusLabel(item.status)}</span><span>{formatBytes(item.sizeBytes)}</span><span class="actions"><button aria-label={`检查 ${cacheId(item)}`} onclick={() => inspect(item)}>检查</button><button class="danger" aria-label={`删除 ${cacheId(item)}`} onclick={() => remove(item.cacheId, false)} disabled={operating}>删除</button></span></div>{/each}</div>{/if}
  {#if inspecting}<aside class="panel">正在检查缓存…</aside>{:else if inspected?.cache}<aside class="panel"><h2>缓存详情：{cacheId(inspected.cache)}</h2><div>路径：{inspected.cache.path || '后端未提供'}</div><div>最后使用：{inspected.cache.lastUsedAt || '后端未提供'}</div>{#each inspected.cache.blockedReasons as reason}<div class="blocked">阻止原因：{reason}</div>{/each}{#each inspected.warnings as warning}<div class="warning">{warning}</div>{/each}</aside>{/if}
  {#if result}<section class="panel result" aria-live="polite"><h2>{resultTitle}</h2><div>后端 dry-run：{result.dryRun ? '是' : '否'}</div><h3>匹配项 ({result.matched.length})</h3>{#each result.matched as item}<div>{cacheId(item)}</div>{#each item.blockedReasons as reason}<div class="blocked">阻止原因：{reason}</div>{/each}{/each}<h3>已移除 ({result.removed.length})</h3>{#each result.removed as id}<div class="removed-item">{id}</div>{/each}<h3>跳过项 ({result.skipped.length})</h3>{#each result.skipped as item}<div>{cacheId(item)}</div>{#each item.blockedReasons as reason}<div class="blocked">阻止原因：{reason}</div>{/each}{/each}{#each result.warnings as warning}<div class="warning">{warning}</div>{/each}{#if pending === 'prune'}<button class="danger" onclick={() => prune(true)} disabled={operating}>确认执行清理</button>{:else if pending === 'remove'}<button class="danger" onclick={() => remove(targetId, true)} disabled={operating}>确认删除缓存</button>{/if}</section>{/if}
  {#if operationError}<section class="panel error">操作失败：{operationError}</section>{/if}
</div>

<style>
  .root{height:100%;overflow:auto;padding:18px 20px;background:var(--bg-primary);color:var(--text-secondary)}header{display:flex;align-items:end;justify-content:space-between;border-bottom:1px solid var(--border-color);padding-bottom:14px}.scope{color:var(--accent-blue);font:var(--font-size-xs) var(--font-mono)}h1{margin:5px 0 0;color:var(--text-primary);font-size:var(--font-size-3xl)}h2{font-size:var(--font-size-md);color:var(--text-primary)}h3{margin:10px 0 4px;font-size:var(--font-size-sm)}p{margin:5px 0 0;color:var(--text-muted);font-size:var(--font-size-sm)}button,select,input{border:1px solid var(--border-color);border-radius:4px;background:var(--bg-tertiary);color:var(--text-secondary);padding:6px 8px;font-size:var(--font-size-sm)}.filters,.actions{display:flex;gap:7px}.filters{padding:12px 0;flex-wrap:wrap}.danger,.error,.blocked{color:var(--accent-red)}.notice,.state,.panel{border:1px solid var(--border-color);padding:12px;margin-bottom:12px;font-size:var(--font-size-sm)}.state{text-align:center;padding:36px}.warning{color:var(--accent-yellow)}.table{border:1px solid var(--border-color)}.row{display:grid;grid-template-columns:1.3fr 1fr 1fr .7fr .6fr .8fr;gap:8px;align-items:center;padding:9px;border-bottom:1px solid var(--border-color);font-size:var(--font-size-xs)}.head{background:var(--bg-tertiary);color:var(--text-muted)}.mono{font-family:var(--font-mono);color:var(--text-primary)}.panel{background:var(--bg-secondary)}
</style>
