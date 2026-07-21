<script lang="ts">
  import { onMount } from 'svelte';
  import { webhookStore } from '../../lib/webhook/store.svelte';

  onMount(() => {
    webhookStore.loadSources();
  });
</script>

<div class="webhook-panel">
  <header class="page-heading">
    <h2>Webhook 源</h2>
    <p>注册外部系统向 daemon 推送事件的入口。每个源绑定一个 topic 前缀和访问 token。</p>
  </header>
  {#if webhookStore.loading}
    <div class="loading">加载中...</div>
  {:else if webhookStore.lastError}
    <div class="error">
      加载失败：{webhookStore.lastError.message}
      <button onclick={() => webhookStore.loadSources()}>重试</button>
    </div>
  {:else}
    <div class="placeholder">（待实现）</div>
  {/if}
</div>

<style>
  .webhook-panel { display: flex; flex-direction: column; gap: 16px; }
  .page-heading h2 { margin: 0 0 4px; font-size: var(--font-size-3xl); font-weight: 600; }
  .page-heading p { margin: 0; color: var(--text-secondary); font-size: var(--font-size-sm); }
  .loading, .error, .placeholder { padding: 24px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-secondary); }
</style>
