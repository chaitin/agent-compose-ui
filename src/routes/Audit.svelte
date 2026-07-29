<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Download from '@lucide/svelte/icons/download';
  import AuditDetailDrawer from '$lib/components/audit-detail-drawer.svelte';
  import AuditEventList from '$lib/components/audit-event-list.svelte';
  import AuditFilterPanel from '$lib/components/audit-filter-panel.svelte';
  import CollectionPage from '$lib/components/collection-page.svelte';
  import { Button } from '$lib/components/ui/button';
  import { t } from '$lib/i18n.svelte';
  import { downloadAuditEvents, listAuditEvents, type AuditEvent, type AuditFilter } from '../api/audit';

  const PAGE_SIZE = 50;

  let items = $state<AuditEvent[]>([]);
  let loading = $state(true);
  let error = $state('');
  let selected = $state<AuditEvent | null>(null);
  let actor = $state('');
  let action = $state('');
  let outcome = $state('');
  let resourceType = $state('');
  let resourceId = $state('');
  let from = $state('');
  let to = $state('');
  let cursor = $state('');
  let nextCursor = $state('');
  let cursorHistory = $state<string[]>([]);

  onMount(load);

  function filter(): AuditFilter {
    return {
      actor: actor.trim(),
      action: action.trim(),
      outcome,
      resourceType,
      resourceId: resourceId.trim(),
      from: from ? new Date(from).toISOString() : '',
      to: to ? new Date(to).toISOString() : '',
      cursor,
      limit: PAGE_SIZE,
    };
  }

  async function load(reset = false): Promise<void> {
    if (reset) {
      cursor = '';
      cursorHistory = [];
    }
    loading = true;
    error = '';
    try {
      const page = await listAuditEvents(filter());
      items = page.items;
      nextCursor = page.nextCursor || '';
      selected = null;
      await tick();
      document.querySelector<HTMLElement>('[data-audit-list]')?.scrollTo({ top: 0, left: 0 });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : t('审计日志加载失败');
    } finally {
      loading = false;
    }
  }

  async function next(): Promise<void> {
    if (!nextCursor) return;
    cursorHistory = [...cursorHistory, cursor];
    cursor = nextCursor;
    await load();
  }

  async function previous(): Promise<void> {
    if (!cursorHistory.length) return;
    cursor = cursorHistory.at(-1) || '';
    cursorHistory = cursorHistory.slice(0, -1);
    await load();
  }
</script>

<CollectionPage title="审计日志" description="查看登录与变更记录">
  {#snippet actions()}
    <Button variant="outline" size="sm" onclick={() => downloadAuditEvents('json', filter())}>
      <Download class="size-3.5" />JSON
    </Button>
    <Button variant="outline" size="sm" onclick={() => downloadAuditEvents('csv', filter())}>
      <Download class="size-3.5" />CSV
    </Button>
  {/snippet}

  {#snippet toolbar()}
    <AuditFilterPanel
      bind:actor
      bind:action
      bind:outcome
      bind:resourceType
      bind:resourceId
      bind:from
      bind:to
      {loading}
      onSubmit={() => void load(true)}
    />
    {#if error}
      <div data-page-error class="mt-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
    {/if}
  {/snippet}

  <AuditEventList {items} {loading} selectedId={selected?.id || ''} onSelect={(item) => (selected = item)} />

  {#snippet footer()}
    <div class="flex items-center justify-between gap-3 border-t border-border pt-3">
      <span class="text-xs text-muted-foreground">
        {t('第 {page} 页 · 每页最多 {count} 条', { page: cursorHistory.length + 1, count: PAGE_SIZE })}
      </span>
      <div class="flex gap-2">
        <Button variant="outline" size="sm" disabled={!cursorHistory.length || loading} onclick={previous}>
          {t('上一页')}
        </Button>
        <Button variant="outline" size="sm" disabled={!nextCursor || loading} onclick={next}>{t('下一页')}</Button>
      </div>
    </div>
  {/snippet}
</CollectionPage>

<AuditDetailDrawer event={selected} onClose={() => (selected = null)} />
