<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import PageHeader from '$lib/components/page-header.svelte';
  import PageContent from '$lib/components/page-content.svelte';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import EventStatusLegend from '$lib/components/event-status-legend.svelte';
  import { t } from '$lib/i18n.svelte';
  import { navigate, router } from '$lib/router.svelte';
  import { listWebhookSources, type WebhookSource } from '../api/config';
  import {
    listConfiguredEventTopics,
    listTopicEvents,
    type ConfiguredEventTopic,
    type TopicEvent,
  } from '../api/loaders';
  import { dispatchStatus, eventSourceLabel } from '../model/event-status';

  const PAGE_SIZE = 100;

  const initial = new URLSearchParams(location.search);
  let topic = $state(initial.get('topic') ?? '');
  let correlationId = $state(initial.get('correlationId') ?? '');
  let items = $state<TopicEvent[]>([]);
  let configuredTopics = $state<ConfiguredEventTopic[]>([]);
  let webhookSources = $state<WebhookSource[]>([]);
  let topicsLoading = $state(true);
  let loading = $state(false);
  let error = $state('');
  let nextAfterSequence = $state(0);
  let hasMore = $state(false);

  onMount(async () => {
    await loadTopics();
    if (topic || correlationId) await load();
    else if (configuredTopics.length) {
      topic = configuredTopics.find((item) => item.enabled)?.topic ?? configuredTopics[0].topic;
      await load();
    }
  });

  async function loadTopics(): Promise<void> {
    topicsLoading = true;
    try {
      [configuredTopics, webhookSources] = await Promise.all([listConfiguredEventTopics(), listWebhookSources()]);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : t('Topic 配置加载失败');
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
    if (!topic.trim() && !correlationId.trim()) {
      error = t('请输入完整 Topic 或 Correlation ID');
      return;
    }
    loading = true;
    error = '';
    try {
      const response = await listTopicEvents({
        topic,
        correlationId,
        afterSequence: append ? nextAfterSequence : undefined,
        limit: PAGE_SIZE,
      });
      items = append
        ? [...new Map([...items, ...response.items].map((item) => [item.eventId, item])).values()]
        : response.items;
      nextAfterSequence = response.nextAfterSequence;
      hasMore = response.items.length === PAGE_SIZE && response.nextAfterSequence > 0;
      if (!append && router.path === '/events') {
        const query = new URLSearchParams();
        if (topic.trim()) query.set('topic', topic.trim());
        if (correlationId.trim()) query.set('correlationId', correlationId.trim());
        const search = query.toString();
        router.replace(`/events${search ? `?${search}` : ''}`);
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : t('事件加载失败');
    } finally {
      loading = false;
    }
  }
</script>

<PageHeader title="事件" description="Webhook 与内部 Topic 的投递、关联运行和沙箱溯源" />
<PageContent class="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
  <aside class="space-y-4">
    <section class="rounded-lg border border-border bg-card p-3">
      <h2 class="px-1 text-sm font-medium">{t('已配置 Topic')}</h2>
      <p class="mt-1 px-1 text-xs text-muted-foreground">{t('来自自动化任务的 event trigger')}</p>
      <div class="mt-3 space-y-1">
        {#each configuredTopics as item (item.topic)}<button
            class={`w-full rounded-md border px-3 py-2 text-left transition-colors hover:bg-accent ${topic === item.topic && !correlationId ? 'border-primary bg-primary/5' : 'border-border'}`}
            onclick={() => selectTopic(item.topic)}
          >
            <div class="flex items-center justify-between gap-2">
              <span class="min-w-0 break-all font-mono text-xs">{item.topic}</span>
              <StatusBadge status={item.enabled ? 'enabled' : 'disabled'} label={t(item.enabled ? '启用' : '停用')} />
            </div>
            <div class="mt-1 truncate text-[11px] text-muted-foreground" title={item.automationNames.join('、')}>
              {item.automationNames.join('、')}
            </div>
          </button>{:else}<p class="px-1 py-3 text-xs text-muted-foreground">
            {t(topicsLoading ? '正在加载 Topic…' : '没有配置 event trigger')}
          </p>{/each}
      </div>
    </section>

    <section class="rounded-lg border border-border bg-card p-3">
      <h2 class="px-1 text-sm font-medium">{t('Webhook 前缀')}</h2>
      <p class="mt-1 px-1 text-xs text-muted-foreground">{t('前缀不是可直接查询的完整 Topic')}</p>
      <div class="mt-3 space-y-2">
        {#each webhookSources as source (source.id)}<div class="rounded-md border border-border px-3 py-2">
            <div class="break-all font-mono text-xs">{source.topicPrefix}</div>
            <div class="mt-1 text-[11px] text-muted-foreground">
              {source.name} · {t(source.enabled ? '启用' : '停用')}
            </div>
          </div>{:else}<p class="px-1 py-3 text-xs text-muted-foreground">{t('没有配置 Webhook source')}</p>{/each}
      </div>
    </section>
  </aside>

  <div class="min-w-0 space-y-4">
    <form
      class="grid gap-3 rounded-lg border border-border bg-card p-4 md:grid-cols-[1fr_1fr_auto]"
      onsubmit={(event) => {
        event.preventDefault();
        void load();
      }}
    >
      <label class="space-y-1">
        <span class="text-xs text-muted-foreground">{t('完整 Topic')}</span>
        <Input bind:value={topic} placeholder="webhook.github.push" />
      </label>
      <label class="space-y-1">
        <span class="text-xs text-muted-foreground">Correlation ID</span>
        <Input bind:value={correlationId} placeholder={t('可二选一')} />
      </label>
      <Button type="submit" class="self-end" disabled={loading}>{t(loading ? '查询中…' : '查询')}</Button>
    </form>
    {#if error}<div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>{/if}
    <EventStatusLegend />
    <div class="space-y-2 md:hidden">
      {#each items as item (item.eventId)}
        {@const status = dispatchStatus(item.dispatchStatus)}
        <button
          type="button"
          class="w-full rounded-lg border border-border bg-card p-3 text-left"
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
          {#if item.correlationId}<div class="mt-2 truncate font-mono text-[11px] text-muted-foreground">
              {item.correlationId}
            </div>{/if}
        </button>
      {:else}
        <p class="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {t(loading ? '正在查询事件…' : topic || correlationId ? '没有匹配事件' : '输入查询条件查看事件')}
        </p>
      {/each}
    </div>
    <div data-scroll-surface class="hidden overflow-x-auto rounded-lg border border-border md:block">
      <table class="min-w-[56rem] w-full text-sm">
        <thead class="bg-muted/40">
          <tr>
            <th class="p-3 text-left">{t('序号 / 时间')}</th>
            <th class="p-3 text-left">Topic</th>
            <th class="p-3 text-left">{t('来源')}</th>
            <th class="p-3 text-left">{t('关联标识')}</th>
            <th class="p-3 text-left">{t('状态')}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-border">
          {#each items as item (item.eventId)}
            {@const status = dispatchStatus(item.dispatchStatus)}
            <tr class="cursor-pointer hover:bg-accent/50" onclick={() => navigate(`/events/${item.eventId}`)}>
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
            <tr
              ><td colspan="5" class="p-10 text-center text-muted-foreground">
                {t(loading ? '正在查询事件…' : topic || correlationId ? '没有匹配事件' : '输入查询条件查看事件')}
              </td></tr
            >
          {/each}
        </tbody>
      </table>
    </div>
    {#if items.length}<div class="flex justify-center">
        {#if hasMore}<Button variant="outline" disabled={loading} onclick={() => void load(true)}
            >{t('加载更多')}</Button
          >{:else}<span class="text-xs text-muted-foreground">{t('已加载全部事件')}</span>{/if}
      </div>{/if}
  </div>
</PageContent>
