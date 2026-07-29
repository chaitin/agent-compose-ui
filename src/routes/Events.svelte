<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import PageHeader from '$lib/components/page-header.svelte';
  import PageContent from '$lib/components/page-content.svelte';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import { navigate, router } from '$lib/router.svelte';
  import { listWebhookSources, type WebhookSource } from '../api/config';
  import {
    listConfiguredEventTopics,
    listTopicEvents,
    type ConfiguredEventTopic,
    type TopicEvent,
  } from '../api/loaders';

  const initial = new URLSearchParams(location.search);
  let topic = $state(initial.get('topic') ?? '');
  let correlationId = $state(initial.get('correlationId') ?? '');
  let items = $state<TopicEvent[]>([]);
  let configuredTopics = $state<ConfiguredEventTopic[]>([]);
  let webhookSources = $state<WebhookSource[]>([]);
  let topicsLoading = $state(true);
  let loading = $state(false);
  let error = $state('');

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
      error = cause instanceof Error ? cause.message : 'Topic 配置加载失败';
    } finally {
      topicsLoading = false;
    }
  }

  function selectTopic(value: string): void {
    topic = value;
    correlationId = '';
    void load();
  }

  async function load(): Promise<void> {
    if (!topic.trim() && !correlationId.trim()) {
      error = '请输入完整 Topic 或 Correlation ID';
      return;
    }
    loading = true;
    error = '';
    try {
      items = (await listTopicEvents({ topic, correlationId, limit: 200 })).items;
      if (router.path === '/events') {
        const query = new URLSearchParams();
        if (topic.trim()) query.set('topic', topic.trim());
        if (correlationId.trim()) query.set('correlationId', correlationId.trim());
        const search = query.toString();
        router.replace(`/events${search ? `?${search}` : ''}`);
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : '事件加载失败';
    } finally {
      loading = false;
    }
  }
</script>

<PageHeader title="事件" description="Webhook 与内部 Topic 的投递、关联运行和沙箱溯源" />
<PageContent class="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
  <aside class="space-y-4">
    <section class="rounded-lg border border-border bg-card p-3">
      <h2 class="px-1 text-sm font-medium">已配置 Topic</h2>
      <p class="mt-1 px-1 text-xs text-muted-foreground">来自自动化任务的 event trigger</p>
      <div class="mt-3 space-y-1">
        {#each configuredTopics as item (item.topic)}<button
            class={`w-full rounded-md border px-3 py-2 text-left transition-colors hover:bg-accent ${topic === item.topic && !correlationId ? 'border-primary bg-primary/5' : 'border-border'}`}
            onclick={() => selectTopic(item.topic)}
          >
            <div class="flex items-center justify-between gap-2">
              <span class="min-w-0 break-all font-mono text-xs">{item.topic}</span>
              <StatusBadge status={item.enabled ? 'enabled' : 'disabled'} label={item.enabled ? '启用' : '停用'} />
            </div>
            <div class="mt-1 truncate text-[11px] text-muted-foreground" title={item.automationNames.join('、')}>
              {item.automationNames.join('、')}
            </div>
          </button>{:else}<p class="px-1 py-3 text-xs text-muted-foreground">
            {topicsLoading ? '正在加载 Topic…' : '没有配置 event trigger'}
          </p>{/each}
      </div>
    </section>

    <section class="rounded-lg border border-border bg-card p-3">
      <h2 class="px-1 text-sm font-medium">Webhook 前缀</h2>
      <p class="mt-1 px-1 text-xs text-muted-foreground">前缀不是可直接查询的完整 Topic</p>
      <div class="mt-3 space-y-2">
        {#each webhookSources as source (source.id)}<div class="rounded-md border border-border px-3 py-2">
            <div class="break-all font-mono text-xs">{source.topicPrefix}</div>
            <div class="mt-1 text-[11px] text-muted-foreground">
              {source.name} · {source.enabled ? '启用' : '停用'}
            </div>
          </div>{:else}<p class="px-1 py-3 text-xs text-muted-foreground">没有配置 Webhook source</p>{/each}
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
        <span class="text-xs text-muted-foreground">完整 Topic</span>
        <Input bind:value={topic} placeholder="webhook.github.push" />
      </label>
      <label class="space-y-1">
        <span class="text-xs text-muted-foreground">Correlation ID</span>
        <Input bind:value={correlationId} placeholder="可二选一" />
      </label>
      <Button type="submit" class="self-end" disabled={loading}>{loading ? '查询中…' : '查询'}</Button>
    </form>
    {#if error}<div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>{/if}
    <div data-scroll-surface class="overflow-x-auto rounded-lg border border-border">
      <table class="min-w-[56rem] w-full text-sm">
        <thead class="bg-muted/40">
          <tr>
            <th class="p-3 text-left">序号 / 时间</th>
            <th class="p-3 text-left">Topic</th>
            <th class="p-3 text-left">来源</th>
            <th class="p-3 text-left">关联标识</th>
            <th class="p-3 text-left">状态</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-border">
          {#each items as item (item.eventId)}
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
                <div>{item.source}</div>
                <div class="text-xs text-muted-foreground">{item.provider || '—'} · {item.intent || '—'}</div>
              </td>
              <td class="p-3 font-mono text-xs text-muted-foreground">{item.correlationId || '—'}</td>
              <td class="p-3"
                ><StatusBadge status={item.dispatchStatus || 'pending'} label={item.dispatchStatus || 'pending'} /></td
              >
            </tr>
          {:else}
            <tr
              ><td colspan="5" class="p-10 text-center text-muted-foreground">
                {loading ? '正在查询事件…' : topic || correlationId ? '没有匹配事件' : '输入查询条件查看事件'}
              </td></tr
            >
          {/each}
        </tbody>
      </table>
    </div>
  </div>
</PageContent>
