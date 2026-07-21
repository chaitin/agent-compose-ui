<script lang="ts">
  import { onMount } from 'svelte';
  import { webhookStore } from '../../lib/webhook/store.svelte';
  import WebhookSourceTable from './WebhookSourceTable.svelte';
  import WebhookRegisterModal from './WebhookRegisterModal.svelte';
  import type { TestState } from '../../lib/webhook/types';

  let testStates = $state<Map<string, TestState>>(new Map());
  let registerOpen = $state(false);
  let deleteTarget = $state<{ id: string; name: string; topic: string } | null>(null);
  let togglingId = $state<string | null>(null);

  function sessionTokenIds(): Set<string> {
    return new Set(webhookStore.sessionTokens.keys());
  }

  onMount(() => {
    webhookStore.loadSources();
  });

  async function handleToggle(id: string): Promise<void> {
    const source = webhookStore.sources.find(s => s.id === id);
    if (!source) return;
    togglingId = id;
    try {
      await webhookStore.upsert({
        id: source.id,
        name: source.name,
        enabled: !source.enabled,
        provider: source.provider,
        topic_prefix: source.topic_prefix,
        signature_type: source.signature_type ?? 'none',
      });
    } catch (error) {
      console.error('toggle failed', error);
    } finally {
      togglingId = null;
    }
  }

  function handleDeleteRequest(id: string): void {
    const source = webhookStore.sources.find(s => s.id === id);
    if (!source) return;
    deleteTarget = { id, name: source.name, topic: source.topic_prefix };
  }

  async function handleDeleteConfirm(): Promise<void> {
    if (!deleteTarget) return;
    try {
      await webhookStore.remove(deleteTarget.id);
    } catch (error) {
      console.error('delete failed', error);
    } finally {
      deleteTarget = null;
    }
  }
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
      <button type="button" class="btn primary" onclick={() => registerOpen = true}>+ 注册源</button>
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
        onselect={(id) => webhookStore.selectSource(id)}
        ontoggle={handleToggle}
        ondelete={handleDeleteRequest}
        oncopycurl={(id) => { /* Task 7 */ }}
        ontest={(id) => { /* Task 6 */ }}
        onregen={(id) => { /* Task 8 */ }}
      />
    {/if}
  </section>
</div>

<WebhookRegisterModal open={registerOpen} onclose={() => registerOpen = false} />

{#if deleteTarget}
  <div class="modal-backdrop" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) deleteTarget = null; }}>
    <div class="modal" role="dialog" aria-modal="true">
      <header class="modal-header">
        <span class="icon danger">⚠</span>
        <div class="title">删除 Webhook 源</div>
        <button type="button" class="close" onclick={() => deleteTarget = null}>×</button>
      </header>
      <div class="modal-body">
        <p>确定删除源 <code>{deleteTarget.name}</code>？此操作不可撤销。</p>
        <ul class="impact-list">
          <li>所有使用此源 token 的调用方将立即收到 401</li>
          <li>YAML 中 <code>scheduler.on("{deleteTarget.topic}*", ...)</code> 的订阅将不再被触发</li>
          <li>已入库的历史事件保留，可通过 /api/events 查询</li>
        </ul>
      </div>
      <footer class="modal-footer">
        <button type="button" class="btn" onclick={() => deleteTarget = null}>取消</button>
        <button type="button" class="btn danger" onclick={handleDeleteConfirm}>删除</button>
      </footer>
    </div>
  </div>
{/if}

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

  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(1,4,9,0.7);
    display: flex; align-items: center; justify-content: center;
    z-index: 100; backdrop-filter: blur(2px);
  }
  .modal {
    background: var(--bg-secondary); border: 1px solid var(--border-color);
    border-radius: 8px; width: 480px; max-width: calc(100% - 32px);
    box-shadow: 0 16px 48px rgba(0,0,0,0.5);
  }
  .modal-header { display: flex; align-items: center; gap: 8px; padding: 14px 18px; border-bottom: 1px solid var(--border-color); }
  .modal-header .title { font-size: var(--font-size-xl); font-weight: 600; }
  .modal-header .icon.danger { color: var(--accent-red); font-size: 18px; }
  .modal-header .close { margin-left: auto; color: var(--text-muted); font-size: 18px; padding: 4px; }
  .modal-header .close:hover { color: var(--text-primary); }
  .modal-body { padding: 16px 18px; }
  .modal-body p { margin: 0 0 12px; font-size: var(--font-size-sm); color: var(--text-primary); }
  .modal-body code { font-family: var(--font-mono); color: var(--accent-blue); background: color-mix(in srgb, var(--accent-blue) 10%, transparent); padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  .impact-list { margin: 0; padding-left: 18px; color: var(--text-secondary); font-size: var(--font-size-sm); line-height: 1.7; }
  .impact-list li { margin-bottom: 4px; }
  .impact-list code { font-family: var(--font-mono); color: var(--accent-blue); background: color-mix(in srgb, var(--accent-blue) 10%, transparent); padding: 1px 4px; border-radius: 2px; font-size: 11px; }

  .modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--border-color); background: var(--bg-tertiary); border-radius: 0 0 8px 8px; }
  .modal-footer .btn { padding: 6px 14px; border-radius: 4px; font-size: var(--font-size-sm); border: 1px solid var(--border-color); background: var(--bg-secondary); color: var(--text-primary); }
  .modal-footer .btn:hover:not(:disabled) { border-color: var(--accent-blue); }
  .modal-footer .btn.danger { background: var(--accent-red); color: #fff; border-color: var(--accent-red); font-weight: 600; }
  .modal-footer .btn.danger:hover { opacity: 0.9; }
</style>
