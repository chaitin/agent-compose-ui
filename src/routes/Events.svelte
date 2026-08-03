<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import CollectionPage from '$lib/components/collection-page.svelte';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { t } from '$lib/i18n.svelte';
  import { navigate, router } from '$lib/router.svelte';
  import { listWebhookSources, type WebhookSource } from '../api/config';
  import { listEventTopics, listTopicEvents, type EventTopic, type TopicEvent } from '../api/loaders';
  import { dispatchStatus, eventSourceLabel } from '../model/event-status';

  const PAGE_SIZE = 100;

  const initial = new URLSearchParams(location.search);
  let topic = $state(initial.get('topic') ?? '');
  let correlationId = $state(initial.get('correlationId') ?? '');
  let items = $state<TopicEvent[]>([]);
  let eventTopics = $state<EventTopic[]>([]);
  let webhookSources = $state<WebhookSource[]>([]);
  let topicsLoading = $state(true);
  let loading = $state(false);
  let error = $state('');
  let nextOffset = $state(0);
  let total = $state(0);
  let hasMore = $state(false);

  onMount(() => {
    void Promise.all([loadTopics(), load()]);
  });

  async function loadTopics(): Promise<void> {
    topicsLoading = true;
    try {
      [eventTopics, webhookSources] = await Promise.all([listEventTopics(), listWebhookSources()]);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : t('事件主题配置加载失败');
    } finally {
      topicsLoading = false;
    }
  }

  function selectTopic(value: string): void {
    topic = value;
    correlationId = '';
    void load(false);
  }

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
      applyResponse(response, append);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : t('事件加载失败');
    } finally {
      loading = false;
    }
  }

  function applyResponse(response: Awaited<ReturnType<typeof listTopicEvents>>, append = false): void {
    items = append
      ? [...new Map([...items, ...response.items].map((item) => [item.eventId, item])).values()]
      : response.items;
    total = response.total;
    nextOffset = append ? nextOffset + response.items.length : response.items.length;
    hasMore = nextOffset < total;
    if (append || router.path !== '/events') return;
    const query = new SvelteURLSearchParams();
    if (topic.trim()) query.set('topic', topic.trim());
    if (correlationId.trim()) query.set('correlationId', correlationId.trim());
    const search = query.toString();
    router.replace(`/events${search ? `?${search}` : ''}`);
  }
</script>

<CollectionPage title="Webhook 事件" description="查看 Webhook 投递与关联运行" compactHeader>
  {#snippet toolbar()}
    <div class="space-y-2">
      <select
        value={eventTopics.some((item) => item.topic === topic) && !correlationId ? topic : ''}
        class="h-8 w-full rounded-md border border-input bg-background px-2 text-sm lg:hidden"
        aria-label={t('已接收事件主题')}
        onchange={(event) => selectTopic(event.currentTarget.value)}
      >
        <option value="">{t(topicsLoading ? '正在加载事件主题…' : '全部 Webhook 主题')}</option>
        {#each eventTopics as item (item.topic)}
          <option value={item.topic}>{item.topic} ({item.eventCount})</option>
        {/each}
      </select>

      <form
        class="flex flex-col gap-2 sm:flex-row"
        onsubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <label class="min-w-0 flex-1">
          <span class="sr-only">{t('完整事件主题')}</span>
          <Input bind:value={topic} placeholder={t('完整事件主题')} />
        </label>
        <label class="min-w-0 flex-1">
          <span class="sr-only">{t('关联 ID')}</span>
          <Input bind:value={correlationId} placeholder={t('关联 ID')} />
        </label>
        <Button type="submit" size="sm" disabled={loading}>{t(loading ? '查询中…' : '查询')}</Button>
      </form>
      {#if error}<div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>{/if}
    </div>
  {/snippet}

  <div class="grid min-h-0 flex-1 gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
    <aside
      data-scroll-pane
      data-route-scroll="event-topics"
      class="hidden min-h-0 space-y-4 overflow-y-auto pr-1 lg:block"
    >
      <section class="rounded-lg border border-border bg-card p-3">
        <h2 class="px-1 text-sm font-medium">{t('已接收事件主题')}</h2>
        <p class="mt-1 px-1 text-xs text-muted-foreground">{t('来自历史 Webhook 事件')}</p>
        <div class="mt-3 space-y-1">
          {#each eventTopics as item (item.topic)}
            <button
              class="w-full rounded-md border px-3 py-2 text-left transition-colors hover:bg-accent {topic ===
                item.topic && !correlationId
                ? 'border-primary bg-primary/5'
                : 'border-border'}"
              onclick={() => selectTopic(item.topic)}
            >
              <div class="flex items-center justify-between gap-2">
                <span class="min-w-0 break-all font-mono text-xs">{item.topic}</span>
                <span class="shrink-0 text-[11px] text-muted-foreground">{item.eventCount}</span>
              </div>
              <Timestamp value={item.latestEventAt} class="mt-1 text-[11px] text-muted-foreground" />
            </button>
          {:else}
            <p class="px-1 py-3 text-xs text-muted-foreground">
              {t(topicsLoading ? '正在加载事件主题…' : '还没有接收到 Webhook 事件')}
            </p>
          {/each}
        </div>
      </section>

      <section class="rounded-lg border border-border bg-card p-3">
        <h2 class="px-1 text-sm font-medium">{t('Webhook 前缀')}</h2>
        <p class="mt-1 px-1 text-xs text-muted-foreground">{t('前缀不是可直接查询的完整事件主题')}</p>
        <div class="mt-3 space-y-2">
          {#each webhookSources as source (source.id)}
            <div class="rounded-md border border-border px-3 py-2">
              <div class="break-all font-mono text-xs">{source.topicPrefix}</div>
              <div class="mt-1 text-[11px] text-muted-foreground">
                {source.name} · {t(source.enabled ? '启用' : '停用')}
              </div>
            </div>
          {:else}
            <p class="px-1 py-3 text-xs text-muted-foreground">{t('没有配置 Webhook 来源')}</p>
          {/each}
        </div>
      </section>
    </aside>

    <div class="flex min-h-0 min-w-0 flex-col">
      <div data-scroll-pane data-route-scroll="events" class="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 md:hidden">
        {#each items as item (item.eventId)}
          {@const status = dispatchStatus(item.dispatchStatus)}
          <button
            type="button"
            class="w-full rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-accent/40"
            onclick={() => navigate(`/events/${item.eventId}`)}
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="break-all font-mono text-xs font-medium">{item.topic}</div>
                <div class="mt-1 text-xs text-muted-foreground">
                  #{item.sequence} · {eventSourceLabel(item.source)}
                </div>
              </div>
              <StatusBadge status={status.semantic} label={status.label} />
            </div>
            <div class="mt-3 flex items-center justify-between gap-3">
              <CopyableText value={item.eventId} label="Event ID" class="min-w-0 font-mono text-[11px]" />
              <Timestamp value={item.createdAt} class="shrink-0 text-xs text-muted-foreground" />
            </div>
            {#if item.correlationId}
              <div class="mt-2 truncate font-mono text-[11px] text-muted-foreground">{item.correlationId}</div>
            {/if}
          </button>
        {:else}
          <p class="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            {t(loading ? '正在查询事件…' : '没有匹配的 Webhook 事件')}
          </p>
        {/each}
      </div>

      <div
        data-scroll-pane
        data-route-scroll="events"
        class="hidden min-h-0 flex-1 overflow-auto rounded-lg border border-border md:block"
      >
        <table class="w-full min-w-[56rem] text-sm">
          <thead class="sticky top-0 z-10 bg-muted/95 text-xs backdrop-blur">
            <tr>
              <th class="p-3 text-left font-medium">{t('序号 / 时间')}</th>
              <th class="p-3 text-left font-medium">{t('事件主题')}</th>
              <th class="p-3 text-left font-medium">{t('来源')}</th>
              <th class="p-3 text-left font-medium">{t('关联标识')}</th>
              <th class="p-3 text-left font-medium">{t('状态')}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            {#each items as item (item.eventId)}
              {@const status = dispatchStatus(item.dispatchStatus)}
              <tr
                class="cursor-pointer transition-colors hover:bg-accent/50"
                onclick={() => navigate(`/events/${item.eventId}`)}
              >
                <td class="p-3">
                  <div class="font-mono text-xs">#{item.sequence}</div>
                  <CopyableText
                    value={item.eventId}
                    label="Event ID"
                    class="max-w-44 font-mono text-[11px] text-muted-foreground"
                  />
                  <Timestamp value={item.createdAt} class="text-xs text-muted-foreground" />
                </td>
                <td class="p-3 font-medium">{item.topic}</td>
                <td class="p-3">
                  <div>{eventSourceLabel(item.source)}</div>
                  <div class="text-xs text-muted-foreground">{item.provider || '—'} · {item.intent || '—'}</div>
                </td>
                <td class="p-3 font-mono text-xs text-muted-foreground">{item.correlationId || '—'}</td>
                <td class="p-3"><StatusBadge status={status.semantic} label={status.label} /></td>
              </tr>
            {:else}
              <tr>
                <td colspan="5" class="p-10 text-center text-muted-foreground">
                  {t(loading ? '正在查询事件…' : '没有匹配的 Webhook 事件')}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  </div>

  {#snippet footer()}
    {#if items.length}
      <div class="flex justify-center border-t border-border pt-3">
        {#if hasMore}
          <Button variant="outline" disabled={loading} onclick={() => void load(true)}>{t('加载更多')}</Button>
        {:else}
          <span class="text-xs text-muted-foreground">{t('已加载全部事件')}</span>
        {/if}
      </div>
    {/if}
  {/snippet}
</CollectionPage>
