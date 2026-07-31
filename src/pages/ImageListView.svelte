<script lang="ts">
  import { onMount } from 'svelte';
  import { imageService } from '../lib/rpc';
  import { store } from '../lib/stores.svelte';
  import {
    ImageStoreKind,
    InspectImageRequest,
    ListImagesRequest,
    type Image,
    type InspectImageResponse,
    type ImageStoreStatus,
  } from '../gen/agentcompose/v2/agentcompose_pb';
  import { formatImageBytes, formatImagePlatform, imageAvailabilityLabel, imageStoreLabel } from '../lib/images';
  import { imageDisplayRef, imageSelectionKey, isSystemImage, type ImageRemovalResult } from '../lib/image-management';
  import PullImageModal from '../modals/PullImageModal.svelte';
  import RemoveImageModal from '../modals/RemoveImageModal.svelte';

  let { showTitle = true, showPullAction = true }: { showTitle?: boolean; showPullAction?: boolean } = $props();

  const PAGE_SIZE = 20;
  let images: Image[] = $state([]);
  let query = $state('');
  let storeFilter: ImageStoreKind = $state(ImageStoreKind.UNSPECIFIED);
  let showIntermediate = $state(false);
  let nextOffset = $state(0);
  let hasMore = $state(false);
  let loading = $state(true);
  let error = $state('');
  let storeStatus: ImageStoreStatus | undefined = $state();
  let queryTimer: ReturnType<typeof setTimeout> | undefined;
  let requestGeneration = 0;
  let selectedKeys: Set<string> = $state(new Set());
  let expandedKey = $state('');
  let inspectingKey = $state('');
  let inspectError = $state('');
  let inspected: InspectImageResponse | undefined = $state();
  let showPull = $state(false);
  let removeTargets: Image[] = $state([]);

  let allLoadedSelected = $derived(images.length > 0 && images.every(image => selectedKeys.has(imageSelectionKey(image))));
  let someLoadedSelected = $derived(images.some(image => selectedKeys.has(imageSelectionKey(image))));
  let selectedImages = $derived(images.filter(image => selectedKeys.has(imageSelectionKey(image))));

  function formatCreated(value: string): string {
    if (!value) return '后端未提供';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
  }

  async function load(reset = true) {
    const generation = ++requestGeneration;
    const includeIntermediate = showIntermediate;
    loading = true;
    error = '';
    try {
      let requestOffset = reset ? 0 : nextOffset;
      let resp;
      let receivedImages: Image[] = [];
      while (true) {
        resp = await imageService.listImages(new ListImagesRequest({
          query: query.trim(),
          store: storeFilter,
          all: includeIntermediate,
          includeCacheStatus: true,
          offset: requestOffset,
          limit: PAGE_SIZE,
        }));
        if (generation !== requestGeneration) return;
        const visiblePage = resp.images.filter(image => (includeIntermediate || !image.dangling) && !isSystemImage(image));
        receivedImages = [...receivedImages, ...visiblePage];
        if (visiblePage.length > 0 || !resp.hasMore || resp.nextOffset <= requestOffset) break;
        requestOffset = resp.nextOffset;
      }
      if (generation !== requestGeneration) return;
      const nextImages = reset ? receivedImages : [...images, ...receivedImages];
      images = nextImages;
      if (reset) {
        const loadedKeys = new Set(nextImages.map(imageSelectionKey));
        selectedKeys = new Set([...selectedKeys].filter(key => loadedKeys.has(key)));
        if (expandedKey && !loadedKeys.has(expandedKey)) closeDetail();
      }
      storeStatus = resp.storeStatus;
      hasMore = resp.hasMore;
      nextOffset = resp.nextOffset || images.length;
    } catch (cause: any) {
      if (generation === requestGeneration) {
        error = cause?.message || '加载镜像失败';
        store.addToast(`加载镜像失败：${error}`, 'error');
      }
    } finally {
      if (generation === requestGeneration) loading = false;
    }
  }

  function onQueryInput(event: Event) {
    query = (event.currentTarget as HTMLInputElement).value;
    if (queryTimer) clearTimeout(queryTimer);
    queryTimer = setTimeout(() => { void load(true); }, 250);
  }

  function toggleSelected(image: Image) {
    const key = imageSelectionKey(image);
    const next = new Set(selectedKeys);
    if (next.has(key)) next.delete(key); else next.add(key);
    selectedKeys = next;
  }

  function toggleAllLoaded() {
    const next = new Set(selectedKeys);
    if (allLoadedSelected) images.forEach(image => next.delete(imageSelectionKey(image)));
    else images.forEach(image => next.add(imageSelectionKey(image)));
    selectedKeys = next;
  }

  function closeDetail() {
    expandedKey = '';
    inspectingKey = '';
    inspectError = '';
    inspected = undefined;
  }

  async function toggleDetail(image: Image) {
    const key = imageSelectionKey(image);
    if (expandedKey === key) {
      closeDetail();
      return;
    }
    expandedKey = key;
    await inspectDetail(image, key);
  }

  async function inspectDetail(image: Image, key = imageSelectionKey(image)) {
    inspectingKey = key;
    inspectError = '';
    inspected = undefined;
    try {
      const response = await imageService.inspectImage(new InspectImageRequest({
        imageRef: imageDisplayRef(image), store: image.store, includeCacheStatus: true,
      }));
      if (expandedKey === key) {
        inspected = response;
      }
    } catch (cause: any) {
      if (expandedKey === key) inspectError = cause?.message || '检查镜像失败';
    } finally {
      if (inspectingKey === key) inspectingKey = '';
    }
  }

  function handleRemovalComplete(results: ImageRemovalResult[]) {
    const next = new Set(selectedKeys);
    for (const result of results) if (!result.error) next.delete(imageSelectionKey(result.image));
    selectedKeys = next;
    void load(true);
  }

  onMount(() => {
    void load(true);
    return () => { if (queryTimer) clearTimeout(queryTimer); };
  });
</script>

<div class="root">
  <header>
    <div>{#if showTitle}<h1>镜像</h1>{/if}<p>查看和管理 daemon 中已有镜像；镜像构建由项目 YAML 声明，并在保存或运行时确认。</p></div>
  </header>

  <div class="filters">
    <input value={query} oninput={onQueryInput} placeholder="筛选镜像引用或 ID…" aria-label="筛选镜像" />
    <select bind:value={storeFilter} onchange={() => load(true)} aria-label="镜像存储">
      <option value={ImageStoreKind.UNSPECIFIED}>全部存储</option>
      <option value={ImageStoreKind.DOCKER_DAEMON}>Docker daemon</option>
      <option value={ImageStoreKind.OCI_CACHE}>OCI 缓存</option>
    </select>
    <label><input type="checkbox" bind:checked={showIntermediate} onchange={() => load(true)} /> 显示中间层</label>
    <span class="filter-spacer"></span>
    {#if selectedImages.length > 0}<span class="selection-count">已选 {selectedImages.length} 项</span><button class="bulk-danger" onclick={() => removeTargets = selectedImages}>删除所选（{selectedImages.length}）</button>{/if}
    <div class="header-actions"><button onclick={() => load(true)} disabled={loading}>刷新</button>{#if showPullAction}<button class="primary" onclick={() => showPull = true}>拉取镜像</button>{/if}</div>
  </div>

  {#if storeStatus && !storeStatus.available}<div class="notice error">存储不可用：{storeStatus.error || '后端未提供原因'}</div>{/if}
  {#if error && images.length === 0}
    <div class="state error">{error}<button onclick={() => load(true)}>重试</button></div>
  {:else if loading && images.length === 0}
    <div class="state">正在读取 daemon 镜像…</div>
  {:else if images.length === 0}
    <div class="state">没有匹配的镜像</div>
  {:else}
    <div class="table-shell"><div class="table">
      <div class="row head">
        <span class="select-cell"><input type="checkbox" aria-label="选择当前已加载镜像" checked={allLoadedSelected} indeterminate={someLoadedSelected && !allLoadedSelected} onchange={toggleAllLoaded} /></span>
        <span>镜像引用 / ID</span><span>类型</span><span>存储</span><span>状态</span><span>大小</span><span>创建时间</span>
      </div>
      {#each images as image (imageSelectionKey(image))}
        {@const ref = imageDisplayRef(image)}
        {@const key = imageSelectionKey(image)}
        <div class="image-row" class:expanded={expandedKey === key}>
          <span class="select-cell"><input type="checkbox" aria-label={`选择镜像 ${ref}`} checked={selectedKeys.has(key)} onchange={() => toggleSelected(image)} /></span>
          <button class="row-trigger" type="button" aria-label={`${expandedKey === key ? '收起' : '展开'}镜像 ${ref}`} aria-expanded={expandedKey === key} aria-controls={`image-detail-${key}`} onclick={() => toggleDetail(image)}>
            <span class="ref"><strong>{ref}</strong><small>{image.imageId || '后端未提供'}</small></span>
            <span><b class="type-pill" class:intermediate={image.dangling}>{image.dangling ? '中间层' : '成品镜像'}</b></span>
            <span>{imageStoreLabel(image.store)}</span>
            <span class:error-text={imageAvailabilityLabel(image.availabilityStatus) === '错误'}>{imageAvailabilityLabel(image.availabilityStatus)}</span>
            <span>{formatImageBytes(image.sizeBytes)}</span><span>{formatCreated(image.createdAt)}</span>
          </button>
        </div>
        {#if expandedKey === key}
          <div class="detail-row" id={`image-detail-${key}`} data-image-detail data-testid={`image-detail-${ref}`}>
            {#if inspectingKey === key}
              <div class="detail-state">正在检查镜像…</div>
            {:else if inspectError}
              <div class="detail-state error">{inspectError}<button onclick={() => inspectDetail(image, key)}>重试</button></div>
            {:else if inspected?.image}
              <div class="detail-title"><div><span class="scope">镜像详情</span><h2>{imageDisplayRef(inspected.image)}</h2></div><button class="danger" onclick={() => removeTargets = [image]}>删除镜像</button></div>
              <dl><div><dt>ID</dt><dd>{inspected.image.imageId || '后端未提供'}</dd></div><div><dt>完整引用</dt><dd>{inspected.image.resolvedRef || imageDisplayRef(inspected.image)}</dd></div><div><dt>平台</dt><dd>{formatImagePlatform(inspected.image.platform)}</dd></div><div class="inspect-size" hidden><dt>大小</dt><dd>{formatImageBytes(inspected.image.sizeBytes)}</dd></div><div><dt>容器数</dt><dd>{String(inspected.image.containerCount)}</dd></div><div><dt>存储端点</dt><dd>{inspected.storeStatus?.endpoint || '后端未提供'}</dd></div></dl>
              <div class="labels"><strong>标签</strong>{#if Object.keys(inspected.image.labels).length}{#each Object.entries(inspected.image.labels) as [name, value]}<code>{name}={value}</code>{/each}{:else}<span>无</span>{/if}</div>
            {/if}
          </div>
        {/if}
      {/each}
    </div></div>
    {#if hasMore}<button class="more" onclick={() => load(false)} disabled={loading}>{loading ? '加载中…' : '加载更多'}</button>{/if}
  {/if}
</div>
{#if showPull}<PullImageModal onclose={() => showPull = false} oncomplete={() => load(true)} />{/if}
{#if removeTargets.length}<RemoveImageModal images={removeTargets} onclose={() => removeTargets = []} oncomplete={handleRemovalComplete} />{/if}

<style>
  .root{height:100%;overflow:auto;padding:18px 20px;background:var(--bg-primary);color:var(--text-secondary)}
  header{display:flex;align-items:end;justify-content:space-between;border-bottom:1px solid var(--border-color);padding-bottom:14px}.scope{color:var(--accent-blue);font:var(--font-size-xs) var(--font-mono);letter-spacing:.04em}h1{margin:5px 0 0;color:var(--text-primary);font-size:var(--font-size-3xl)}p{margin:5px 0 0;color:var(--text-muted);font-size:var(--font-size-sm)}
  button,select,input{border:1px solid var(--border-color);border-radius:4px;background:var(--bg-tertiary);color:var(--text-secondary);padding:6px 8px;font-size:var(--font-size-sm)}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent-blue);outline-offset:2px}.header-actions{display:flex;gap:7px}.primary{background:var(--accent-blue);color:white}.filters{display:flex;align-items:center;gap:8px;padding:12px 0}.filters>input{min-width:260px}.filters label{display:flex;align-items:center;gap:5px;font-size:var(--font-size-xs)}.filters label input,.select-cell input{accent-color:var(--accent-blue)}.filter-spacer{flex:1}.selection-count{color:var(--text-muted);font:var(--font-size-xs) var(--font-mono)}.bulk-danger,.danger{color:var(--accent-red);border-color:rgba(248,81,73,.55);background:rgba(248,81,73,.06)}
  .notice,.state{border:1px solid var(--border-color);padding:12px;font-size:var(--font-size-sm)}.state{text-align:center;padding:36px}.state button{margin-left:8px}.error{color:var(--accent-red)}
  .table-shell{overflow-x:auto;border:1px solid var(--border-color);border-radius:6px}.table{min-width:900px}.row{display:grid;grid-template-columns:34px minmax(230px,2fr) 92px .8fr .65fr .65fr 1fr;gap:10px;align-items:center}.head{padding:8px 10px;background:var(--bg-tertiary);color:var(--text-muted);font-size:var(--font-size-xs);border-bottom:1px solid var(--border-color)}.select-cell{display:grid;place-items:center}.select-cell input{width:14px;height:14px;margin:0;padding:0}
  .image-row{display:grid;grid-template-columns:34px 1fr;align-items:stretch;padding-left:10px;border-bottom:1px solid var(--border-color);background:transparent}.image-row.expanded{background:rgba(88,166,255,.055);box-shadow:inset 2px 0 var(--accent-blue)}.row-trigger{display:grid;grid-template-columns:minmax(230px,2fr) 92px .8fr .65fr .65fr 1fr;gap:10px;align-items:center;width:100%;padding:9px 10px;border:0;border-radius:0;background:transparent;text-align:left}.row-trigger:hover{background:var(--bg-secondary)}.ref{min-width:0}.ref strong,.ref small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ref strong{color:var(--text-primary);font:var(--font-size-sm) var(--font-mono)}.ref small{margin-top:3px;color:var(--text-muted);font:var(--font-size-xs) var(--font-mono)}.error-text{color:var(--accent-red)}
  .type-pill{display:inline-block;padding:2px 7px;border:1px solid rgba(63,185,80,.4);border-radius:10px;color:var(--accent-green);background:rgba(63,185,80,.08);font-size:var(--font-size-xs);font-weight:600}.type-pill.intermediate{color:var(--accent-yellow);border-color:rgba(210,153,34,.45);background:rgba(210,153,34,.08)}
  .detail-row{position:relative;padding:16px 18px 17px 54px;border-bottom:1px solid var(--border-color);background:linear-gradient(90deg,rgba(88,166,255,.07),transparent 42%),#0b0f14}.detail-row::before{content:'';position:absolute;left:26px;top:0;bottom:0;width:1px;background:rgba(88,166,255,.35)}.detail-title{display:flex;justify-content:space-between;align-items:start;margin-bottom:12px}.detail-title h2{margin:3px 0 0;color:var(--text-primary);font:var(--font-size-md) var(--font-mono)}.detail-state{padding:12px;color:var(--text-muted);font-size:var(--font-size-sm)}.detail-state.error{color:var(--accent-red)}dl{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:0}dl>div{min-width:0;padding:9px 10px;border:1px solid rgba(48,54,61,.75);background:rgba(13,17,23,.55)}dl>.inspect-size{display:none}dt{margin-bottom:4px;color:var(--text-muted);font-size:var(--font-size-xs);text-transform:uppercase}dd{margin:0;overflow-wrap:anywhere;color:var(--text-secondary);font:var(--font-size-xs) var(--font-mono)}.labels{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:10px;font-size:var(--font-size-xs)}.labels strong{margin-right:4px;color:var(--text-muted)}.labels code{padding:3px 6px;background:var(--bg-tertiary);color:var(--text-secondary)}.labels span{color:var(--text-muted)}.more{display:block;margin:10px auto}
  @media(max-width:720px){.root{padding:14px 12px}.filters{flex-wrap:wrap}.filters>input{min-width:100%}.filter-spacer{display:none}dl{grid-template-columns:1fr}.detail-row{padding-left:42px}}
</style>
