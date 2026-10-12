<script lang="ts">
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import { t } from '$lib/i18n.svelte';
  import type { TopicEvent } from '../../../api/loaders';
  import type { DayGroup } from '../../../model/day-groups';
  import type { TaskLink } from '../../../model/task-list';
  import { dispatchStatus, eventSourceLabel } from '../../../model/event-status';
  import { formatBeijingClock, formatBeijingTime } from '../../../time';

  // 一行是一个收到的事件，按收到时间倒序。这一页回答「事件进来没有、投出去没有」，
  // 所以投递状态是第一列；所属任务只是一列，没有任务时显示关联 ID。
  let {
    days,
    taskOf,
    onOpen,
    onOpenTask,
  }: {
    days: DayGroup<TopicEvent>[];
    taskOf: (event: TopicEvent) => TaskLink | null;
    onOpen: (event: TopicEvent) => void;
    onOpenTask: (event: TopicEvent) => void;
  } = $props();
</script>

<table data-table="dense" class="w-full table-fixed border-collapse text-[13px]">
  <colgroup>
    <col class="w-28" />
    <col class="w-[34%]" />
    <col />
    <col class="w-[15%]" />
    <col class="w-24" />
  </colgroup>
  <thead class="sticky top-0 z-10 bg-background">
    <tr class="h-8 text-left text-[11px] text-faint [&>th]:border-b [&>th]:border-border [&>th]:font-normal">
      <th class="pl-4 sm:pl-5 xl:pl-6">{t('投递状态')}</th>
      <th>{t('事件主题')}</th>
      <th>{t('所属任务')}</th>
      <th>{t('来源')}</th>
      <th class="pr-4 text-right sm:pr-5 xl:pr-6">{t('收到时间')}</th>
    </tr>
  </thead>
  {#each days as day (day.key)}
    <tbody>
      <tr>
        <td colspan="5" class="h-7 pb-1 pl-4 align-bottom text-[11px] text-faint sm:pl-5 xl:pl-6">{day.label}</td>
      </tr>
      {#each day.items as item (item.eventId)}
        {@const status = dispatchStatus(item.dispatchStatus)}
        {@const task = taskOf(item)}
        <tr
          data-event-id={item.eventId}
          class="h-8 cursor-pointer border-b border-border transition-colors hover:bg-accent/60"
          onclick={() => onOpen(item)}
        >
          <td class="truncate pr-3 pl-4 sm:pl-5 xl:pl-6" title={t(status.description)}>
            <StatusBadge status={status.semantic} label={status.label} />
          </td>
          <td class="truncate pr-3 font-mono text-[12.5px] text-foreground" title={item.topic}>{item.topic}</td>
          <td class="pr-3">
            {#if task}
              <span class="flex min-w-0 items-center gap-1.5">
                <button
                  type="button"
                  class="min-w-0 truncate text-foreground hover:underline"
                  title={task.title}
                  onclick={(event) => {
                    event.stopPropagation();
                    onOpenTask(item);
                  }}>{task.title}</button
                >
                {#if task.url}<a
                    href={task.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={t('打开任务页面')}
                    aria-label={t('打开任务页面')}
                    class="shrink-0 text-faint transition-colors hover:text-foreground"
                    onclick={(event) => event.stopPropagation()}><ExternalLink class="size-3.5" /></a
                  >{/if}
              </span>
            {:else if item.correlationId}
              <span class="block truncate font-mono text-[11px] text-faint" title={t('关联 ID')}
                >{item.correlationId}</span
              >
            {:else}
              <span class="text-faint">—</span>
            {/if}
          </td>
          <td class="truncate pr-3 text-muted-foreground">
            {t(eventSourceLabel(item.source))}{#if item.provider}<span class="px-1 text-faint">·</span><span
                class="text-faint">{item.provider}</span
              >{/if}
          </td>
          <td class="pr-4 text-right text-muted-foreground sm:pr-5 xl:pr-6">
            <time datetime={item.createdAt} title={formatBeijingTime(item.createdAt)} class="tabular-nums"
              >{formatBeijingClock(item.createdAt)}</time
            >
          </td>
        </tr>
      {/each}
    </tbody>
  {/each}
</table>
