<script lang="ts">
  import CopyableText from '$lib/components/copyable-text.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import { t } from '$lib/i18n.svelte';
  import { auditActionLabel, resourceTypeLabel } from '../../model/presentation';
  import type { AuditEvent } from '../../api/audit';

  let {
    items,
    loading = false,
    selectedId = '',
    onSelect,
  }: {
    items: AuditEvent[];
    loading?: boolean;
    selectedId?: string;
    onSelect: (item: AuditEvent) => void;
  } = $props();

  const outcomeLabel = (value: string) =>
    t({ success: '成功', failure: '失败', denied: '拒绝', started: '进行中' }[value] || value);
  const outcomeStatus = (value: string) =>
    value === 'success' ? 'success' : value === 'started' ? 'running' : 'failed';
</script>

<div
  data-scroll-pane
  data-route-scroll="audit-events"
  data-audit-list
  class="min-h-0 flex-1 overflow-auto overscroll-contain pr-1"
>
  <div class="space-y-2 md:hidden">
    {#each items as item (item.id)}
      <button
        type="button"
        class="w-full rounded-lg border bg-card p-3 text-left transition-colors {selectedId === item.id
          ? 'border-primary bg-primary/5'
          : 'border-border'}"
        onclick={() => onSelect(item)}
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="truncate text-sm font-medium">{t(auditActionLabel(item.action))}</div>
            <div class="mt-0.5 truncate text-xs text-muted-foreground">
              {item.actor.displayName || item.actor.username}
            </div>
          </div>
          <StatusBadge status={outcomeStatus(item.outcome)} label={outcomeLabel(item.outcome)} />
        </div>
        <div class="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <Timestamp value={item.occurredAt} />
          <span class="shrink-0">{item.durationMs} ms</span>
        </div>
        {#if item.resourceId}
          <div class="mt-2 min-w-0">
            <CopyableText
              value={item.resourceId}
              display={`${t(resourceTypeLabel(item.resourceType))} · ${item.resourceId.slice(0, 16)}`}
              label="资源 ID"
              class="max-w-full text-xs"
            />
          </div>
        {/if}
      </button>
    {:else}
      <p class="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        {t(loading ? '正在加载审计日志…' : '没有匹配的审计记录')}
      </p>
    {/each}
  </div>

  <div class="hidden min-h-full rounded-lg border border-border md:block">
    <table class="w-full min-w-[68rem] table-fixed text-sm">
      <colgroup>
        <col class="w-[11.5rem]" />
        <col class="w-[10rem]" />
        <col />
        <col class="w-[17rem]" />
        <col class="w-[6rem]" />
        <col class="w-[6rem]" />
        <col class="w-[10rem]" />
      </colgroup>
      <thead class="sticky top-0 z-10 bg-muted/95 text-xs backdrop-blur">
        <tr>
          <th class="p-3 text-left font-medium">{t('时间')}</th>
          <th class="p-3 text-left font-medium">{t('用户')}</th>
          <th class="p-3 text-left font-medium">{t('操作')}</th>
          <th class="p-3 text-left font-medium">{t('资源')}</th>
          <th class="p-3 text-left font-medium">{t('结果')}</th>
          <th class="p-3 text-left font-medium">{t('耗时')}</th>
          <th class="p-3 text-left font-medium">{t('来源')}</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-border">
        {#each items as item (item.id)}
          <tr
            class="cursor-pointer transition-colors hover:bg-accent/50 {selectedId === item.id ? 'bg-primary/5' : ''}"
            onclick={() => onSelect(item)}
          >
            <td class="p-3"><Timestamp value={item.occurredAt} mode="full" /></td>
            <td class="p-3">
              <div class="truncate font-medium">{item.actor.displayName || item.actor.username}</div>
              <div class="truncate text-xs text-muted-foreground">{item.actor.source}</div>
            </td>
            <td class="p-3">
              <div class="truncate font-medium" title={item.action}>{t(auditActionLabel(item.action))}</div>
            </td>
            <td class="p-3">
              {#if item.resourceId}
                <CopyableText
                  value={item.resourceId}
                  display={`${t(resourceTypeLabel(item.resourceType))} · ${item.resourceId.slice(0, 16)}`}
                  label="资源 ID"
                  class="max-w-full"
                />
              {:else}—{/if}
            </td>
            <td class="p-3"><StatusBadge status={outcomeStatus(item.outcome)} label={outcomeLabel(item.outcome)} /></td>
            <td class="p-3 tabular-nums">{item.durationMs} ms</td>
            <td class="truncate p-3 text-xs text-muted-foreground" title={item.remoteIp}>{item.remoteIp || '—'}</td>
          </tr>
        {:else}
          <tr>
            <td colspan="7" class="p-10 text-center text-muted-foreground">
              {t(loading ? '正在加载审计日志…' : '没有匹配的审计记录')}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>
