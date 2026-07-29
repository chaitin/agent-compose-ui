<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { navigate } from '$lib/router.svelte';
  import CopyableText from './copyable-text.svelte';
  import Timestamp from './timestamp.svelte';
  import type { TopicEvent } from '../../api/loaders';
  import type { EventRunTrace, EventTimelineItem } from '../../model/event-detail';
  import StatusBadge from './status-badge.svelte';
  import { deliveryStatus, eventSourceLabel } from '../../model/event-status';
  import { t } from '$lib/i18n.svelte';

  let {
    event,
    runTraces,
    timeline,
  }: {
    event: TopicEvent;
    runTraces: EventRunTrace[];
    timeline: EventTimelineItem[];
  } = $props();
</script>

<aside data-scroll-pane class="min-w-0 space-y-4 lg:h-full lg:min-h-0 lg:overflow-y-auto lg:pr-1">
  <section class="rounded-lg border border-border bg-card p-4">
    <h2 class="mb-3 text-sm font-medium">{t('事件摘要')}</h2>
    <dl class="grid gap-3 text-sm">
      <div>
        <dt class="text-xs text-muted-foreground">{t('事件 ID')}</dt>
        <dd><CopyableText value={event.eventId} label="Event ID" class="max-w-full font-mono text-xs" /></dd>
      </div>
      <div>
        <dt class="text-xs text-muted-foreground">Topic</dt>
        <dd class="break-all font-mono text-xs">{event.topic}</dd>
      </div>
      <div>
        <dt class="text-xs text-muted-foreground">{t('来源')}</dt>
        <dd>{eventSourceLabel(event.source)} · {event.provider || '—'}</dd>
      </div>
      <div>
        <dt class="text-xs text-muted-foreground">Correlation</dt>
        <dd class="break-all font-mono text-xs">{event.correlationId || '—'}</dd>
      </div>
      <div>
        <dt class="text-xs text-muted-foreground">{t('创建时间')}</dt>
        <dd><Timestamp value={event.createdAt} mode="full" /></dd>
      </div>
    </dl>
    <p class="mt-4 text-xs text-muted-foreground">{t('请求正文已隐藏。')}</p>
  </section>

  <section class="rounded-lg border border-border bg-card p-4">
    <div class="mb-3 flex items-center justify-between">
      <h2 class="text-sm font-medium">{t('历史任务')}</h2>
      <span class="text-xs text-muted-foreground">{runTraces.length} {t('条')}</span>
    </div>
    <div class="space-y-2">
      {#each runTraces as trace (trace.delivery.runId)}
        {@const status = deliveryStatus(trace.delivery.status)}
        <article class="min-w-0 rounded-md border border-border p-3">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <h3 class="truncate text-sm font-medium">{trace.task?.name || t('调度任务')}</h3>
              <CopyableText
                value={trace.delivery.runId}
                label="Scheduler Run ID"
                class="mt-1 max-w-full font-mono text-[11px] text-primary"
              />
            </div>
            <StatusBadge status={status.semantic} label={status.label} />
          </div>
          <dl class="mt-2 grid grid-cols-2 gap-2 text-xs">
            <div>
              <dt class="text-muted-foreground">Trigger</dt>
              <dd class="break-all">{trace.delivery.triggerId || '—'}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">{t('耗时')}</dt>
              <dd>{trace.run ? `${trace.run.durationMs} ms` : '—'}</dd>
            </div>
          </dl>
          {#if trace.delivery.error || trace.run?.error}
            <div class="mt-2 break-words rounded bg-destructive/10 p-2 text-xs text-destructive">
              {trace.delivery.error || trace.run?.error}
            </div>
          {/if}
          <Button
            class="mt-2"
            size="sm"
            variant="outline"
            onclick={() => navigate(`/automation-runs/${encodeURIComponent(trace.delivery.runId)}`)}
            >{t('查看调度运行')}</Button
          >
        </article>
      {:else}
        <p class="py-6 text-center text-sm text-muted-foreground">{t('这个事件没有匹配到自动任务。')}</p>
      {/each}
    </div>
  </section>

  <section class="rounded-lg border border-border bg-card p-4">
    <div class="mb-3 flex items-center justify-between">
      <h2 class="text-sm font-medium">{t('事件时间线')}</h2>
      <span class="text-xs text-muted-foreground">{timeline.length} {t('条')}</span>
    </div>
    <div class="space-y-3">
      {#each timeline as item (item.id)}
        <div class="border-l-2 border-border pl-3">
          <Timestamp value={item.createdAt} class="text-[11px] text-muted-foreground" />
          <div class="text-xs font-medium">{item.type}</div>
          {#if item.message}
            <p class="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{item.message}</p>
          {/if}
        </div>
      {:else}
        <p class="py-6 text-center text-sm text-muted-foreground">{t('暂无时间线事件')}</p>
      {/each}
    </div>
  </section>
</aside>
