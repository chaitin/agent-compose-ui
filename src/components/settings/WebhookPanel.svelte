<script lang="ts">
  import { onMount } from 'svelte';
  import { webhookStore } from '../../lib/webhook/store.svelte';
  import WebhookSourceTable from './WebhookSourceTable.svelte';
  import type { TestState } from '../../lib/webhook/types';

  let testStates = $state<Map<string, TestState>>(new Map());

  function sessionTokenIds(): Set<string> {
    return new Set(webhookStore.sessionTokens.keys());
  }

  onMount(() => {
    webhookStore.loadSources();
  });
</script>

<div class="webhook-panel">
  <header class="page-heading">
    <h2>Webhook 源</h2>
    <p>注册外部系统向 daemon 推送事件的入口。每个源绑定一个 topic 前缀和访问 token，YAML 里的 <code>scheduler.on("webhook.siem.alert", ...)</code> 通过 topic 匹配这些源。</p>
  </header>

  <section class="section-card">
    <header class="section-card-header">
      <div>
        <span class="title">已注册的源</span>
        <span class="desc">{webhookStore.sources.length} 个源 · {webhookStore.sources.filter(s => s.enabled).length} 启用</span>
      </div>
      <div class="spacer"></div>
      <button type="button" class="btn primary" disabled>+ 注册源</button>
    </header>
    {#if webhookStore.loading}
      <div class="loading">加载中...</div>
    {:else if webhookStore.lastError}
      <div class="error">
        加载失败：{webhookStore.lastError.message}
        <button type="button" onclick={() => webhookStore.loadSources()}>重试</button>
      </div>
    {:else}
      <WebhookSourceTable
        sources={webhookStore.sources}
        sessionTokenIds={sessionTokenIds()}
        selectedSourceId={webhookStore.selectedSourceId}
        {testStates}
      />
    {/if}
  </section>
</div>

<style>
  .webhook-panel { display: flex; flex-direction: column; gap: 16px; }
  .page-heading h2 { margin: 0 0 4px; font-size: var(--font-size-3xl); font-weight: 600; }
  .page-heading p { margin: 0; color: var(--text-secondary); font-size: var(--font-size-sm); max-width: 820px; line-height: 1.6; }
  .page-heading code { font-family: var(--font-mono); color: var(--accent-blue); background: color-mix(in srgb, var(--accent-blue) 10%, transparent); padding: 1px 5px; border-radius: 3px; font-size: 12px; }

  .section-card { background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; overflow: hidden; }
  .section-card-header { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border-color); background: var(--bg-tertiary); }
  .section-card-header .title { font-size: var(--font-size-md); font-weight: 600; }
  .section-card-header .desc { color: var(--text-muted); font-size: var(--font-size-xs); margin-left: 8px; }
  .section-card-header .spacer { flex: 1; }
  .section-card-header .btn { padding: 5px 12px; border: 1px solid var(--border-color); border-radius: 4px; background: var(--bg-secondary); color: var(--text-primary); font-size: var(--font-size-sm); }
  .section-card-header .btn.primary { background: var(--accent-green); color: #0d1117; border-color: var(--accent-green); font-weight: 600; }
  .section-card-header .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .loading, .error { padding: 24px; color: var(--text-secondary); font-size: var(--font-size-sm); }
  .error button { margin-left: 12px; padding: 4px 10px; border: 1px solid var(--border-color); border-radius: 3px; background: var(--bg-tertiary); color: var(--text-primary); font-size: var(--font-size-xs); }
</style>
