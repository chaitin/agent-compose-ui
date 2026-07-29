<script lang="ts">
  import CopyableText from './copyable-text.svelte';
  import StatusBadge from './status-badge.svelte';
  import Timestamp from './timestamp.svelte';
  import { deliveryStatus } from '../../model/event-status';
  import { t } from '$lib/i18n.svelte';
  import type { EventRunTrace } from '../../model/event-detail';

  let { runTraces, layout = 'stack' }: { runTraces: EventRunTrace[]; layout?: 'stack' | 'grid' } = $props();
</script>

<section class="rounded-lg border border-border bg-card p-4">
  <div class="mb-3 flex items-center justify-between">
    <h2 class="text-sm font-medium">{t('自动化执行')}</h2>
    <span class="text-xs text-muted-foreground">{runTraces.length} {t('条')}</span>
  </div>
  <div class={layout === 'grid' ? 'grid gap-3 md:grid-cols-2' : 'space-y-2'}>
    {#each runTraces as trace (trace.delivery.runId)}
      {@const status = deliveryStatus(trace.delivery.status)}
      <details
        class="group min-w-0 rounded-md border border-border bg-background"
        open={runTraces.length === 1 || status.semantic === 'failed'}
      >
        <summary class="flex cursor-pointer list-none items-start justify-between gap-3 p-3 marker:hidden">
          <div class="min-w-0">
            <h3 class="truncate text-sm font-medium">{trace.task?.name || t('自动化任务')}</h3>
            <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span>{trace.delivery.triggerId || t('无触发条件')}</span>
              <span>{trace.run ? `${trace.run.durationMs} ms` : '—'}</span>
            </div>
          </div>
          <StatusBadge status={status.semantic} label={status.label} />
        </summary>
        <div class="border-t border-border px-3 pb-3 pt-3">
          <dl class="grid gap-x-3 gap-y-2 text-xs sm:grid-cols-[6rem_minmax(0,1fr)]">
            <dt class="text-muted-foreground">{t('执行 ID')}</dt>
            <dd>
              <CopyableText
                value={trace.delivery.runId}
                label="自动化运行 ID"
                class="max-w-full font-mono text-[11px]"
              />
            </dd>
            <dt class="text-muted-foreground">{t('开始时间')}</dt>
            <dd><Timestamp value={trace.run?.startedAt || trace.delivery.createdAt} mode="full" /></dd>
            <dt class="text-muted-foreground">{t('完成时间')}</dt>
            <dd><Timestamp value={trace.run?.completedAt || trace.delivery.updatedAt} mode="full" /></dd>
          </dl>
          {#if trace.delivery.error || trace.run?.error}
            <div class="mt-3 break-words rounded bg-destructive/10 p-2 text-xs text-destructive">
              {trace.delivery.error || trace.run?.error}
            </div>
          {/if}
        </div>
      </details>
    {:else}
      <p class="py-6 text-center text-sm text-muted-foreground md:col-span-2">{t('暂无自动化执行')}</p>
    {/each}
  </div>
</section>
