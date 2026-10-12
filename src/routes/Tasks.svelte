<script lang="ts">
  import { onMount } from 'svelte';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import EmptyState from '$lib/components/empty-state.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import { Button } from '$lib/components/ui/button';
  import { navigate } from '$lib/router.svelte';
  import { t } from '$lib/i18n.svelte';
  import { listTasks } from '../api/tasks';
  import {
    executionName,
    filterTasks,
    groupTasksByDay,
    TASK_STATUS_FILTERS,
    taskAttempts,
    taskDuration,
    taskError,
    taskHref,
    taskLabel,
    taskStatusCounts,
    taskStatusLabel,
    taskWorker,
    type TaskStatusFilter,
    type TaskSummary,
  } from '../model/task-list';
  import { formatBeijingClock, formatBeijingTime } from '../time';

  const REFRESH_MS = 15_000;

  let tasks = $state<TaskSummary[]>([]);
  let titlesEnabled = $state(true);
  let truncated = $state(false);
  let status = $state<TaskStatusFilter>('all');
  let search = $state('');
  let loading = $state(true);
  let refreshing = $state(false);
  let error = $state('');
  let now = $state(Date.now());

  const counts = $derived(taskStatusCounts(tasks));
  const groups = $derived(groupTasksByDay(filterTasks(tasks, status, search), now));

  onMount(() => {
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load(true);
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  });

  async function load(background = false): Promise<void> {
    if (background) refreshing = true;
    else loading = true;
    try {
      const response = await listTasks();
      tasks = response.tasks;
      titlesEnabled = response.titlesEnabled;
      truncated = response.truncated;
      now = Date.now();
      error = '';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : t('请求失败');
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  function open(task: TaskSummary): void {
    const href = taskHref(task);
    if (href) navigate(href);
  }
</script>

<div data-page-layout="collection" class="flex h-full min-h-0 flex-col">
  <h1 class="sr-only">{t('任务')}</h1>
  <div
    data-page-header
    class="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-4 py-2.5 sm:px-5 xl:px-6"
  >
    <div role="tablist" aria-label={t('状态')} class="flex rounded-md bg-muted p-0.5">
      {#each TASK_STATUS_FILTERS as option (option.value)}
        {@const active = status === option.value}
        <button
          type="button"
          role="tab"
          aria-selected={active}
          onclick={() => (status = option.value)}
          class="h-6 rounded-[5px] px-2.5 text-xs transition-colors {active
            ? 'bg-card font-medium text-foreground shadow-[0_0_0_1px_var(--input)]'
            : 'text-muted-foreground hover:text-foreground'}"
        >
          {t(option.label)}<span
            class="ml-1 tabular-nums {option.value === 'failed' && counts.failed ? 'text-destructive' : 'text-faint'}"
            >{counts[option.value]}</span
          >
        </button>
      {/each}
    </div>
    <input
      bind:value={search}
      aria-label={t('筛选任务')}
      placeholder={t(titlesEnabled ? '按任务标题或自动化名称筛选' : '按自动化名称筛选')}
      class="h-7 w-64 max-w-full rounded-md border border-transparent bg-muted px-2.5 text-xs text-foreground outline-none transition-colors placeholder:text-faint hover:bg-accent focus-visible:border-ring"
    />
    <div class="ml-auto flex items-center gap-1.5 text-[11px] text-faint">
      {#if truncated}<span>{t('只显示每个智能体最近的执行')}</span>{/if}
      <Button variant="ghost" size="sm" disabled={refreshing} onclick={() => void load(true)}
        >{t(refreshing ? '刷新中…' : '刷新')}</Button
      >
    </div>
  </div>
  {#if error}<div data-page-error class="shrink-0 bg-destructive/8 px-4 py-2 text-xs text-destructive sm:px-5 xl:px-6">
      {error}
    </div>{/if}

  <div data-scroll-pane data-route-scroll="tasks" class="min-h-0 flex-1 overflow-auto">
    {#if loading && !tasks.length}
      <p class="px-6 py-10 text-center text-sm text-muted-foreground">{t('正在加载任务…')}</p>
    {:else if !tasks.length && !error}
      <EmptyState title={t('还没有任务')} description={t('自动化被触发后，它处理的任务会出现在这里')} />
    {:else if !groups.length}
      <EmptyState title={t('没有匹配的任务')} />
    {:else}
      <table data-table="dense" class="w-full min-w-[56rem] table-fixed border-collapse text-[13px]">
        <colgroup>
          <col class="w-9" />
          <col />
          <col class="w-[26%]" />
          <col class="w-20" />
          <col class="w-24" />
        </colgroup>
        <thead class="sticky top-0 z-10 bg-background">
          <tr class="h-8 text-left text-[11px] text-faint [&>th]:border-b [&>th]:border-border [&>th]:font-normal">
            <th><span class="sr-only">{t('状态')}</span></th>
            <th>{t(titlesEnabled ? '任务' : '自动化')}</th>
            <th>{t('处理方')}</th>
            <th class="text-right" title={t('处理任务的那次执行的耗时')}>{t('耗时')}</th>
            <th class="pr-4 text-right sm:pr-5 xl:pr-6">{t('最近活动')}</th>
          </tr>
        </thead>
        {#each groups as day (day.key)}
          <tbody>
            <tr>
              <td colspan="5" class="h-7 pb-1 pl-4 align-bottom text-[11px] text-faint sm:pl-5 xl:pl-6">{day.label}</td>
            </tr>
            {#each day.items as task (task.key)}
              {@const worker = taskWorker(task)}
              {@const attempts = taskAttempts(task)}
              {@const failure = taskError(task)}
              <tr
                data-task-key={task.key}
                class="cursor-pointer border-b border-border transition-colors hover:bg-accent/60"
                onclick={() => open(task)}
              >
                <td class="h-8 pl-4 align-top leading-8 sm:pl-5 xl:pl-6"
                  ><StatusBadge status={task.status} label={taskStatusLabel(task.status)} dotOnly /></td
                >
                <td class="min-w-0 py-1.5 pr-3 align-top leading-5">
                  <div class="flex min-w-0 items-center gap-1.5">
                    <span class="truncate font-medium text-foreground" title={taskLabel(task)}>{taskLabel(task)}</span>
                    {#if task.url}<a
                        href={task.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={t('打开任务页面')}
                        aria-label={t('打开任务页面')}
                        class="shrink-0 text-faint transition-colors hover:text-foreground"
                        onclick={(event) => event.stopPropagation()}><ExternalLink class="size-3.5" /></a
                      >{/if}
                    {#if attempts > 1}<span class="shrink-0 text-[11px] text-faint"
                        >{t('第 {count} 次', { count: attempts })}</span
                      >{/if}
                  </div>
                  {#if failure}
                    <div class="truncate font-mono text-[11.5px] leading-5 text-destructive" title={failure}>
                      {failure}
                    </div>
                  {/if}
                </td>
                <td
                  class="truncate pr-3 align-top leading-8 text-muted-foreground"
                  title={worker ? executionName(worker) : ''}
                >
                  {#if titlesEnabled && worker}{executionName(worker)}{/if}
                </td>
                <td class="text-right align-top leading-8 tabular-nums text-muted-foreground"
                  >{taskDuration(task, now)}</td
                >
                <td class="pr-4 text-right align-top leading-8 text-muted-foreground sm:pr-5 xl:pr-6">
                  <time datetime={task.latestAt} title={formatBeijingTime(task.latestAt)} class="tabular-nums"
                    >{formatBeijingClock(task.latestAt)}</time
                  >
                </td>
              </tr>
            {/each}
          </tbody>
        {/each}
      </table>
    {/if}
  </div>
</div>
