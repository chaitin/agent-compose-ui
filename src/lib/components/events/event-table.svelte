<script lang="ts">
  import StatusBadge from '$lib/components/status-badge.svelte';
  import { t } from '$lib/i18n.svelte';
  import type { DayGroup } from '../../../model/day-groups';
  import type { EventGroup } from '../../../model/event-groups';
  import { eventSourceLabel } from '../../../model/event-status';
  import { formatBeijingClock, formatBeijingTime } from '../../../time';

  // 一行是一个任务（关联 ID 相同的一串事件），没有关联 ID 的事件单独一行。
  // 圆点只标出投递异常（死信、重试中、无订阅方），正常投递不画点，避免满屏绿点。
  let { groups, onOpen }: { groups: DayGroup<EventGroup>[]; onOpen: (group: EventGroup) => void } = $props();
</script>

<table data-table="dense" class="w-full table-fixed border-collapse text-[13px]">
  <colgroup>
    <col class="w-9" />
    <col />
    <col class="w-[16%]" />
    <col class="w-20" />
    <col class="w-24" />
  </colgroup>
  <thead class="sticky top-0 z-10 bg-background">
    <tr class="h-8 text-left text-[11px] text-faint [&>th]:border-b [&>th]:border-border [&>th]:font-normal">
      <th><span class="sr-only">{t('投递状态')}</span></th>
      <th>{t('任务（关联 ID）· 事件主题')}</th>
      <th>{t('来源')}</th>
      <th class="text-right">{t('事件数')}</th>
      <th class="pr-4 text-right sm:pr-5 xl:pr-6">{t('最近收到')}</th>
    </tr>
  </thead>
  {#each groups as day (day.key)}
    <tbody>
      <tr>
        <td colspan="5" class="h-7 pb-1 pl-4 align-bottom text-[11px] text-faint sm:pl-5 xl:pl-6">{day.label}</td>
      </tr>
      {#each day.items as group (group.key)}
        {@const latest = group.latest}
        <tr
          title={latest.eventId}
          class="h-8 cursor-pointer border-b border-border transition-colors hover:bg-accent/60"
          onclick={() => onOpen(group)}
        >
          <td class="pl-4 sm:pl-5 xl:pl-6">
            {#if group.attention}<StatusBadge status={group.attention} label={group.attentionLabel} dotOnly />{/if}
          </td>
          <td class="truncate pr-3">
            {#if group.correlationId}
              <span class="font-mono text-[12.5px] text-foreground">{group.correlationId}</span>
              <span class="ml-2 font-mono text-[11px] text-faint">{group.topics.join(' · ')}</span>
            {:else}
              <span class="font-mono text-[12.5px] text-foreground">{latest.topic}</span>
            {/if}
          </td>
          <td class="truncate pr-3 text-muted-foreground">
            {t(eventSourceLabel(latest.source))}{#if latest.provider}<span class="px-1 text-faint">·</span><span
                class="text-faint">{latest.provider}</span
              >{/if}{#if latest.intent}<span class="px-1 text-faint">·</span><span
                class="font-mono text-[11px] text-faint">{latest.intent}</span
              >{/if}
          </td>
          <td class="text-right tabular-nums">
            {#if group.events.length > 1}<span class="text-foreground/80"
                >{t('{count} 个', { count: group.events.length })}</span
              >{:else}<span class="font-mono text-[11px] text-faint">#{latest.sequence}</span>{/if}
          </td>
          <td class="pr-4 text-right text-muted-foreground sm:pr-5 xl:pr-6">
            <time datetime={latest.createdAt} title={formatBeijingTime(latest.createdAt)} class="tabular-nums"
              >{formatBeijingClock(latest.createdAt)}</time
            >
          </td>
        </tr>
      {/each}
    </tbody>
  {/each}
</table>
