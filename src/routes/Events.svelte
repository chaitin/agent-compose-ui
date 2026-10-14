<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import EmptyState from '$lib/components/empty-state.svelte';
  import EventTable from '$lib/components/events/event-table.svelte';
  import { Button } from '$lib/components/ui/button';
  import { t } from '$lib/i18n.svelte';
  import { navigate, router } from '$lib/router.svelte';
  import { listEventTopics, listTopicEvents, type EventTopic, type TopicEvent } from '../api/loaders';
  import { listEventTasks } from '../api/tasks';
  import type { TaskLink } from '../model/task-list';
  import { groupByDay } from '../model/day-groups';
  import {
    EVENT_STATUS_FILTERS,
    filterEventsByStatus,
    groupEvents,
    taskCandidates,
    tasksByEvent,
    type EventStatusFilter,
  } from '../model/event-groups';

  const PAGE_SIZE = 100;

  const initial = new URLSearchParams(location.search);
  let topic = $state(initial.get('topic') ?? '');
  let correlationId = $state(initial.get('correlationId') ?? '');
  let status = $state<EventStatusFilter>('all');
  let items = $state<TopicEvent[]>([]);
  let eventTopics = $state<EventTopic[]>([]);
  let loading = $state(false);
  let error = $state('');
  let nextOffset = $state(0);
  let total = $state(0);
  let now = $state(Date.now());
  /** 已经问过 UI server 的事件：带任务的记下标题和链接，不带的记 null，避免重复查询。 */
  let eventTasks = $state<Record<string, TaskLink | null>>({});

  // 一行一个事件，按天分组。后端的事件查询不支持按投递状态过滤，状态筛选只作用于已加载的事件。
  const shown = $derived(filterEventsByStatus(items, status));
  const days = $derived(groupByDay(shown, (item) => item.createdAt, now));
  const counts = $derived(
    Object.fromEntries(
      EVENT_STATUS_FILTERS.map((option) => [option.value, filterEventsByStatus(items, option.value).length]),
    ) as Record<EventStatusFilter, number>,
  );
  // 关联 ID 相同的事件属于同一个任务，任务标题按组查一次。
  const tasks = $derived(tasksByEvent(groupEvents(items), eventTasks));
  const hasMore = $derived(nextOffset < total);
  // URL 里带来的主题可能还没出现在已接收列表里，也要能在下拉中显示。
  const topicOptions = $derived(
    topic && !eventTopics.some((item) => item.topic === topic)
      ? [{ topic, eventCount: 0, latestEventAt: '' }, ...eventTopics]
      : eventTopics,
  );

  const control =
    'h-7 rounded-md border border-transparent bg-muted px-2.5 text-xs text-foreground outline-none transition-colors hover:bg-accent focus-visible:border-ring';

  onMount(() => {
    void listEventTopics()
      .then((value) => (eventTopics = value))
      .catch((cause) => (error = cause instanceof Error ? cause.message : t('事件主题配置加载失败')));
    void load();
  });

  async function load(append = false): Promise<void> {
    loading = true;
    error = '';
    try {
      const response = await listTopicEvents({
        topic,
        correlationId,
        offset: append ? nextOffset : 0,
        limit: PAGE_SIZE,
      });
      items = append
        ? [...new Map([...items, ...response.items].map((item) => [item.eventId, item])).values()]
        : response.items;
      total = response.total;
      nextOffset = append ? nextOffset + response.items.length : response.items.length;
      now = Date.now();
      if (!append) syncUrl();
      void loadTasks();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : t('事件加载失败');
    } finally {
      loading = false;
    }
  }

  async function loadTasks(): Promise<void> {
    const unknown = taskCandidates(groupEvents(items)).filter((id) => !(id in eventTasks));
    if (!unknown.length) return;
    try {
      const found = await listEventTasks(unknown);
      eventTasks = { ...eventTasks, ...Object.fromEntries(unknown.map((id) => [id, found.get(id) ?? null])) };
    } catch {
      // 任务标题只是辅助信息：取不到时行标签退回关联 ID。
    }
  }

  function syncUrl(): void {
    if (router.path !== '/events') return;
    const query = new SvelteURLSearchParams();
    if (topic.trim()) query.set('topic', topic.trim());
    if (correlationId.trim()) query.set('correlationId', correlationId.trim());
    const search = query.toString();
    router.replace(`/events${search ? `?${search}` : ''}`);
  }
</script>

<div data-page-layout="collection" class="flex h-full min-h-0 flex-col">
  <h1 class="sr-only">{t('Webhook 事件')}</h1>
  <form
    data-collection-toolbar
    class="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-4 py-2.5 sm:px-5 xl:px-6"
    onsubmit={(event) => {
      event.preventDefault();
      void load();
    }}
  >
    <div role="tablist" aria-label={t('投递状态')} class="flex rounded-md bg-muted p-0.5">
      {#each EVENT_STATUS_FILTERS as option (option.value)}
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
    <select
      class="{control} w-64 max-w-full cursor-pointer truncate {topic ? 'font-mono' : ''}"
      aria-label={t('事件主题')}
      value={topic}
      onchange={(event) => {
        topic = event.currentTarget.value;
        void load();
      }}
    >
      <option value="">{t('全部 Webhook 主题')}</option>
      {#each topicOptions as item (item.topic)}
        <option value={item.topic}>{item.topic}{item.eventCount ? ` (${item.eventCount})` : ''}</option>
      {/each}
    </select>
    <input
      class="{control} w-64 max-w-full font-mono placeholder:font-sans placeholder:text-faint"
      aria-label={t('关联 ID')}
      placeholder={t('按关联 ID 查找，回车确认')}
      bind:value={correlationId}
    />
    {#if topic || correlationId}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onclick={() => {
          topic = '';
          correlationId = '';
          void load();
        }}>{t('清除筛选')}</Button
      >
    {/if}
    <span class="ml-auto text-[11px] text-faint tabular-nums"
      >{t('已加载 {loaded} / 共 {total} 个事件', { loaded: items.length, total })}</span
    >
  </form>
  {#if error}<div class="shrink-0 bg-destructive/8 px-4 py-2 text-xs text-destructive sm:px-5 xl:px-6">
      {error}
    </div>{/if}

  <div data-scroll-pane data-route-scroll="events" class="min-h-0 flex-1 overflow-auto">
    {#if loading && !items.length}
      <p class="px-6 py-10 text-center text-sm text-muted-foreground">{t('正在查询事件…')}</p>
    {:else if !items.length}
      <EmptyState
        title={t('没有匹配的 Webhook 事件')}
        description={t(
          topic || correlationId ? '换一个主题或关联 ID 再试' : 'Webhook 来源在 系统 › 设置 › Webhook 中配置',
        )}
      />
    {:else}
      {#if shown.length}
        <div class="min-w-[48rem]">
          <EventTable
            {days}
            taskOf={(item) => tasks.get(item.eventId) ?? null}
            onOpen={(item) => navigate(`/events/${encodeURIComponent(item.eventId)}`)}
            onOpenTask={(item) => navigate(`/tasks/${encodeURIComponent(item.eventId)}`)}
          />
        </div>
      {:else}
        <p class="px-6 py-10 text-center text-sm text-muted-foreground">
          {t('已加载的 {loaded} 个事件里没有这个状态的', { loaded: items.length })}
        </p>
      {/if}
      {#if hasMore}
        <div class="flex justify-center py-4">
          <Button variant="ghost" size="sm" disabled={loading} onclick={() => void load(true)}
            >{t(loading ? '加载中…' : '加载更多')}</Button
          >
        </div>
      {/if}
    {/if}
  </div>
</div>
