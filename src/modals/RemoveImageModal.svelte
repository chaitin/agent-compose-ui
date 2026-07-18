<script lang="ts">
  import { untrack } from 'svelte';
  import { imageService } from '../lib/rpc';
  import type { Image } from '../gen/agentcompose/v2/agentcompose_pb';
  import { imageStoreLabel } from '../lib/images';
  import {
    imageDisplayRef,
    imageSelectionKey,
    removeImagesSequentially,
    type ImageRemovalResult,
  } from '../lib/image-management';

  let { images, onclose, oncomplete }: {
    images: Image[];
    onclose: () => void;
    oncomplete: (results: ImageRemovalResult[]) => void;
  } = $props();

  let force = $state(false);
  let pruneChildren = $state(false);
  let running = $state(false);
  let pendingImages: Image[] = $state(untrack(() => [...images]));
  let results: ImageRemovalResult[] = $state([]);
  let succeeded = $derived(results.filter(result => !result.error));
  let failed = $derived(results.filter(result => result.error));

  async function submit() {
    const count = pendingImages.length;
    if (count === 0 || !window.confirm(`确认删除 ${count} 个镜像？此操作不可撤销。`)) return;
    running = true;
    try {
      const batchResults = await removeImagesSequentially({ images: pendingImages, force, pruneChildren, client: imageService });
      const byKey = new Map(results.map(result => [imageSelectionKey(result.image), result]));
      for (const result of batchResults) byKey.set(imageSelectionKey(result.image), result);
      results = images.flatMap(image => {
        const result = byKey.get(imageSelectionKey(image));
        return result ? [result] : [];
      });
      pendingImages = results.filter(result => result.error).map(result => result.image);
      oncomplete(batchResults);
    } finally {
      running = false;
    }
  }
</script>

<div class="overlay"></div>
<div class="modal" role="dialog" aria-modal="true" aria-labelledby="remove-title">
  <header>
    <div><span>危险操作</span><h2 id="remove-title">删除镜像</h2><p>{images.length} 个目标 · 将按顺序处理</p></div>
    <button aria-label="关闭删除弹框" onclick={onclose} disabled={running}>×</button>
  </header>
  <div class="body">
    <div class="targets" aria-label="待删除镜像">
      {#each images as image}
        <div class:failed={results.some(result => result.image === image && result.error)} class:succeeded={results.some(result => result.image === image && !result.error)}>
          <i>{results.some(result => result.image === image && result.error) ? '!' : results.some(result => result.image === image && !result.error) ? '✓' : '·'}</i>
          <code>{imageDisplayRef(image)}</code>
          <small>{imageStoreLabel(image.store)}</small>
        </div>
      {/each}
    </div>
    <div class="options">
      <label><input aria-label="强制删除" type="checkbox" bind:checked={force} disabled={running}/> 强制删除</label>
      <label><input aria-label="同时清理子层" type="checkbox" bind:checked={pruneChildren} disabled={running}/> 同时清理子层</label>
    </div>
    {#if results.length > 0}
      <section class="summary" aria-label="删除结果">
        <div class="totals"><strong class="ok">成功 {succeeded.length}</strong><strong class="bad">失败 {failed.length}</strong></div>
        {#each results as result}
          <div class="outcome" class:failed={!!result.error}>
            <code>{result.imageRef}</code>
            {#if result.error}<span>{result.error}</span>{:else}<span>已删除</span>{/if}
            {#if result.response?.untaggedRefs.length}<small>已取消标签：{result.response.untaggedRefs.join('、')}</small>{/if}
            {#if result.response?.deletedIds.length}<small>已删除 ID：{result.response.deletedIds.join('、')}</small>{/if}
            {#each result.response?.warnings ?? [] as warning}<small class="warning">{warning}</small>{/each}
          </div>
        {/each}
      </section>
    {/if}
  </div>
  <footer>
    <button onclick={onclose} disabled={running}>关闭</button>
    {#if pendingImages.length > 0}
      <button class="danger" onclick={submit} disabled={running}>
        {running ? '删除中…' : results.length > 0 ? `重试失败项（${pendingImages.length}）` : `确认删除 ${pendingImages.length} 个镜像`}
      </button>
    {/if}
  </footer>
</div>

<style>
  .overlay{position:fixed;inset:0;background:#000a;backdrop-filter:blur(3px);z-index:100}
  .modal{position:fixed;z-index:101;top:50%;left:50%;transform:translate(-50%,-50%);width:min(560px,92vw);max-height:min(720px,88vh);display:flex;flex-direction:column;background:var(--bg-secondary);border:1px solid #3d444d;border-top-color:#656c76;border-radius:9px;box-shadow:0 24px 80px #000b;color:var(--text-secondary)}
  header,footer{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid var(--border-color)}
  footer{border:0;border-top:1px solid var(--border-color);justify-content:flex-end;gap:8px}
  .body{padding:14px 16px;display:grid;gap:13px;overflow:auto}
  h2{font-size:var(--font-size-xl);margin:2px 0;color:var(--text-primary)}header span{font:var(--font-size-xs) var(--font-mono);color:var(--accent-red);letter-spacing:.08em}header p{margin:4px 0 0;font-size:var(--font-size-xs);color:var(--text-muted)}
  button{border:1px solid var(--border-color);border-radius:4px;background:var(--bg-tertiary);color:var(--text-secondary);padding:7px 10px}.danger{color:white;background:var(--accent-red);border-color:var(--accent-red)}button:disabled{opacity:.55}
  .targets{border:1px solid var(--border-color);border-radius:6px;overflow:hidden}.targets>div{display:grid;grid-template-columns:18px 1fr auto;gap:8px;align-items:center;padding:8px 10px;border-bottom:1px solid var(--border-color);background:#0d111780}.targets>div:last-child{border:0}.targets i{font-style:normal;color:var(--text-muted)}.targets code{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-primary)}.targets small{color:var(--text-muted)}.targets .succeeded i{color:var(--accent-green)}.targets .failed i{color:var(--accent-red)}
  .options{display:flex;gap:18px}.options label{display:flex;gap:6px;align-items:center;font-size:var(--font-size-sm)}
  .summary{display:grid;gap:7px}.totals{display:flex;gap:8px}.totals strong{padding:4px 8px;border:1px solid currentColor;border-radius:12px;font-size:var(--font-size-xs)}.ok{color:var(--accent-green)}.bad{color:var(--accent-red)}
  .outcome{display:grid;grid-template-columns:minmax(100px,1fr) 1fr;gap:3px 10px;padding:8px 10px;border-left:2px solid var(--accent-green);background:var(--bg-tertiary);font-size:var(--font-size-xs)}.outcome.failed{border-color:var(--accent-red)}.outcome code{color:var(--text-primary)}.outcome span{color:var(--text-secondary)}.outcome.failed span,.warning{color:var(--accent-red)!important}.outcome small{grid-column:1/-1;color:var(--text-muted)}
</style>
