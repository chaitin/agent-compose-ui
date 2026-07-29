<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import PageContent from '$lib/components/page-content.svelte';
  import PageHeader from '$lib/components/page-header.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import { t } from '$lib/i18n.svelte';
  import { downloadAuditEvents, listAuditEvents, type AuditEvent, type AuditFilter } from '../api/audit';
  import Download from '@lucide/svelte/icons/download';

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
      limit: 100,
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
  const outcomeLabel = (value: string) =>
    t({ success: '成功', failure: '失败', denied: '拒绝', started: '进行中' }[value] || value);
  const outcomeStatus = (value: string) =>
    value === 'success' ? 'success' : value === 'started' ? 'running' : 'failed';
</script>

<PageHeader title="审计日志" description="登录安全事件与变更操作 · 默认保留 180 天">
  {#snippet actions()}<Button variant="outline" size="sm" onclick={() => downloadAuditEvents('json', filter())}
      ><Download class="size-3.5" />JSON</Button
    ><Button variant="outline" size="sm" onclick={() => downloadAuditEvents('csv', filter())}
      ><Download class="size-3.5" />CSV</Button
    >{/snippet}
</PageHeader>
<PageContent class="space-y-4">
  <form
    class="grid gap-2 rounded-lg border border-border bg-card p-3 md:grid-cols-3 xl:grid-cols-7"
    onsubmit={(event) => {
      event.preventDefault();
      void load(true);
    }}
  >
    <Input bind:value={actor} placeholder={t('用户 ID')} aria-label={t('用户 ID')} />
    <Input bind:value={action} placeholder={t('操作')} aria-label={t('操作')} />
    <select
      bind:value={outcome}
      aria-label={t('结果')}
      class="h-8 rounded-lg border border-input bg-background px-2 text-sm"
      ><option value="">{t('全部结果')}</option><option value="success">{t('成功')}</option><option value="failure"
        >{t('失败')}</option
      ><option value="denied">{t('拒绝')}</option><option value="started">{t('进行中')}</option></select
    >
    <Input bind:value={resourceType} placeholder={t('资源类型')} aria-label={t('资源类型')} />
    <Input bind:value={resourceId} placeholder={t('资源 ID')} aria-label={t('资源 ID')} />
    <Input bind:value={from} type="datetime-local" aria-label={t('开始时间')} />
    <div class="flex gap-2">
      <Input bind:value={to} type="datetime-local" aria-label={t('结束时间')} /><Button type="submit" size="sm"
        >{t('查询')}</Button
      >
    </div>
  </form>
  {#if error}<div data-page-error class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>{/if}
  <div class="space-y-2 md:hidden">
    {#each items as item (item.id)}
      <button
        type="button"
        class="w-full rounded-lg border border-border bg-card p-3 text-left"
        onclick={() => (selected = item)}
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="truncate text-sm font-medium">{item.action}</div>
            <div class="mt-0.5 truncate text-xs text-muted-foreground">
              {item.actor.displayName || item.actor.username} · {item.category}
            </div>
          </div>
          <StatusBadge status={outcomeStatus(item.outcome)} label={outcomeLabel(item.outcome)} />
        </div>
        <div class="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <Timestamp value={item.occurredAt} />
          <span>{item.durationMs} ms</span>
        </div>
        {#if item.resourceId}<div class="mt-2 min-w-0">
            <CopyableText
              value={item.resourceId}
              display={`${item.resourceType} · ${item.resourceId.slice(0, 16)}`}
              label="资源 ID"
              class="max-w-full text-xs"
            />
          </div>{/if}
      </button>
    {:else}
      <p class="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        {t(loading ? '正在加载审计日志…' : '没有匹配的审计记录')}
      </p>
    {/each}
  </div>
  <div data-scroll-surface class="hidden overflow-x-auto rounded-lg border border-border md:block">
    <table class="min-w-[72rem] w-full text-sm">
      <thead class="bg-muted/40"
        ><tr
          ><th class="p-3 text-left">{t('时间')}</th><th class="p-3 text-left">{t('用户')}</th><th class="p-3 text-left"
            >{t('操作')}</th
          ><th class="p-3 text-left">{t('资源')}</th><th class="p-3 text-left">{t('结果')}</th><th class="p-3 text-left"
            >{t('耗时')}</th
          ><th class="p-3 text-left">{t('来源')}</th></tr
        ></thead
      >
      <tbody class="divide-y divide-border"
        >{#each items as item (item.id)}<tr class="cursor-pointer hover:bg-accent/50" onclick={() => (selected = item)}
            ><td class="p-3"><Timestamp value={item.occurredAt} mode="full" /></td><td class="p-3"
              ><div class="font-medium">{item.actor.displayName || item.actor.username}</div>
              <div class="text-xs text-muted-foreground">{item.actor.source}</div></td
            ><td class="p-3"
              ><div class="font-medium">{item.action}</div>
              <div class="text-xs text-muted-foreground">{item.category}</div></td
            ><td class="p-3"
              >{#if item.resourceId}<CopyableText
                  value={item.resourceId}
                  display={`${item.resourceType} · ${item.resourceId.slice(0, 16)}`}
                  label="资源 ID"
                />{:else}—{/if}</td
            ><td class="p-3"><StatusBadge status={outcomeStatus(item.outcome)} label={outcomeLabel(item.outcome)} /></td
            ><td class="p-3">{item.durationMs} ms</td><td class="p-3 text-xs text-muted-foreground"
              >{item.remoteIp || '—'}</td
            ></tr
          >{:else}<tr
            ><td colspan="7" class="p-10 text-center text-muted-foreground"
              >{t(loading ? '正在加载审计日志…' : '没有匹配的审计记录')}</td
            ></tr
          >{/each}</tbody
      >
    </table>
  </div>
  <div class="flex justify-end gap-2">
    <Button variant="outline" size="sm" disabled={!cursorHistory.length} onclick={previous}>{t('上一页')}</Button
    ><Button variant="outline" size="sm" disabled={!nextCursor} onclick={next}>{t('下一页')}</Button>
  </div>
  {#if selected}<section class="rounded-lg border border-border bg-card p-4">
      <div class="flex items-center justify-between">
        <h2 class="font-medium">{t('审计详情')}</h2>
        <Button variant="ghost" size="sm" onclick={() => (selected = null)}>{t('关闭')}</Button>
      </div>
      <dl class="mt-3 grid gap-x-4 gap-y-2 text-sm md:grid-cols-[9rem_1fr]">
        <dt class="text-muted-foreground">{t('事件 ID')}</dt>
        <dd><CopyableText value={selected.id} label="审计事件 ID" /></dd>
        <dt class="text-muted-foreground">{t('接口')}</dt>
        <dd class="font-mono text-xs">{selected.method} {selected.path}</dd>
        <dt class="text-muted-foreground">{t('用户 ID')}</dt>
        <dd><CopyableText value={selected.actor.id} label="用户 ID" /></dd>
        <dt class="text-muted-foreground">{t('认证方式')}</dt>
        <dd>{selected.actor.authMethod}</dd>
        <dt class="text-muted-foreground">{t('HTTP 状态')}</dt>
        <dd>{selected.status}</dd>
        <dt class="text-muted-foreground">Request ID</dt>
        <dd>{selected.requestId || '—'}</dd>
        <dt class="text-muted-foreground">User-Agent</dt>
        <dd class="break-all">{selected.userAgent || '—'}</dd>
      </dl>
    </section>{/if}
</PageContent>
