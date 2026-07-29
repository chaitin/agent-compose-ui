<script lang="ts">
  import Timestamp from './timestamp.svelte';
  import { t } from '$lib/i18n.svelte';
  import type { EventTimelineItem } from '../../model/event-detail';

  let { timeline }: { timeline: EventTimelineItem[] } = $props();
</script>

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
