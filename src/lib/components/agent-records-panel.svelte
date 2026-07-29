<script lang="ts">
  import { tick } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import AgentRecordEventView from '$lib/components/agent-record-event.svelte';
  import SearchableText from '$lib/components/searchable-text.svelte';
  import { t } from '$lib/i18n.svelte';
  import { downloadAgentRecord, listAgentRecords, readAgentRecord, type AgentRecord } from '../../api/agent-records';
  import {
    agentRecordEventMatches,
    parseAgentRecordEvents,
    type AgentRecordCategory,
  } from '../../model/agent-record-events';
  import { textMatchCount } from '../../model/text-search';
  import { formatBeijingTime } from '../../time';

  type EventFilter = 'process' | AgentRecordCategory | 'all';

  let {
    sandboxId,
    active,
    eventFrom = '',
    eventTo = '',
  }: { sandboxId: string; active: boolean; eventFrom?: string; eventTo?: string } = $props();

  let records = $state<AgentRecord[]>([]);
  let selectedId = $state('');
  let content = $state('');
  let startOffset = $state(0);
  let hasEarlier = $state(false);
  let loading = $state(false);
  let loadingEarlier = $state(false);
  let error = $state('');
  let query = $state('');
  let view = $state<'events' | 'raw'>('events');
  let eventFilter = $state<EventFilter>('process');
  let loadedSandboxId = '';

  const selected = $derived(records.find((item) => item.id === selectedId));
  const parsedEvents = $derived(parseAgentRecordEvents(content, selected?.provider ?? ''));
  const visibleEvents = $derived(
    parsedEvents.filter(
      (event) =>
        eventWithinRange(event.timestamp, eventFrom, eventTo) &&
        (eventFilter === 'all' ||
          (eventFilter === 'process' ? event.category !== 'system' : event.category === eventFilter)) &&
        agentRecordEventMatches(event, query),
    ),
  );
  const matchCount = $derived(view === 'events' ? visibleEvents.length : textMatchCount(content, query));

  $effect(() => {
    if (active && sandboxId && loadedSandboxId !== sandboxId) {
      loadedSandboxId = sandboxId;
      void loadRecords();
    }
  });

  async function loadRecords(): Promise<void> {
    loading = true;
    error = '';
    try {
      records = await listAgentRecords(sandboxId);
      const next = records.find((item) => item.id === selectedId) ?? records[0];
      selectedId = next?.id ?? '';
      if (next) await loadSelected(next, false);
      else resetContent();
    } catch (cause) {
      records = [];
      resetContent();
      error = message(cause);
    } finally {
      loading = false;
    }
  }

  async function chooseRecord(id: string): Promise<void> {
    selectedId = id;
    const record = records.find((item) => item.id === id);
    if (record) await loadSelected(record, true);
  }

  async function loadSelected(record: AgentRecord, resetView: boolean): Promise<void> {
    loading = true;
    error = '';
    if (resetView) {
      query = '';
      view = 'events';
      eventFilter = 'process';
    }
    try {
      const chunk = await readAgentRecord(sandboxId, record.id);
      content = chunk.content;
      startOffset = chunk.startOffset;
      hasEarlier = chunk.hasEarlier;
    } catch (cause) {
      resetContent();
      error = message(cause);
    } finally {
      loading = false;
    }
  }

  async function loadEarlier(): Promise<void> {
    if (!selected || !hasEarlier || loadingEarlier) return;
    loadingEarlier = true;
    error = '';
    try {
      const chunk = await readAgentRecord(sandboxId, selected.id, startOffset);
      content = chunk.content + content;
      startOffset = chunk.startOffset;
      hasEarlier = chunk.hasEarlier;
      await tick();
    } catch (cause) {
      error = message(cause);
    } finally {
      loadingEarlier = false;
    }
  }

  function resetContent(): void {
    content = '';
    startOffset = 0;
    hasEarlier = false;
    query = '';
    view = 'events';
    eventFilter = 'process';
  }

  function message(cause: unknown): string {
    return cause instanceof Error ? cause.message : t('加载智能体记录失败');
  }

  function sizeLabel(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function recordLabel(record: AgentRecord): string {
    const provider = record.provider ? record.provider[0].toUpperCase() + record.provider.slice(1) : t('智能体');
    const file = record.path.split('/').pop() ?? record.path;
    const shortFile = file.length > 34 ? `${file.slice(0, 20)}…${file.slice(-10)}` : file;
    return `${provider} · ${shortFile}`;
  }

  function eventWithinRange(timestamp: string, from: string, to: string): boolean {
    if (!timestamp) return true;
    const value = Date.parse(timestamp);
    if (!Number.isFinite(value)) return true;
    const lower = Date.parse(from);
    const upper = Date.parse(to);
    return (!Number.isFinite(lower) || value >= lower) && (!Number.isFinite(upper) || value <= upper);
  }
</script>

<section data-agent-records class="flex h-full min-h-0 flex-col gap-3">
  <div class="flex shrink-0 flex-wrap items-center gap-2">
    <select
      value={selectedId}
      onchange={(event) => void chooseRecord(event.currentTarget.value)}
      aria-label={t('选择智能体记录')}
      disabled={loading || !records.length}
      class="h-8 min-w-48 flex-1 rounded-lg border border-input bg-background px-2 text-sm"
    >
      {#each records as record (record.id)}
        <option value={record.id}>{recordLabel(record)}</option>
      {/each}
    </select>
    {#if selected}<span class="text-xs text-muted-foreground"
        >{sizeLabel(selected.size)} · {formatBeijingTime(selected.modifiedAt)}</span
      >{/if}
    <Button variant="outline" size="sm" disabled={loading} onclick={() => void loadRecords()}>{t('刷新')}</Button>
    <Button
      variant="outline"
      size="sm"
      disabled={!selected}
      onclick={() => selected && downloadAgentRecord(sandboxId, selected)}>{t('下载')}</Button
    >
  </div>

  {#if selected}<div class="flex shrink-0 flex-wrap items-center gap-2">
      <Input bind:value={query} class="min-w-[12rem] flex-1 sm:max-w-sm" placeholder={t('搜索智能体记录')} />
      {#if view === 'events'}<select
          bind:value={eventFilter}
          aria-label={t('筛选事件类型')}
          class="h-8 rounded-lg border border-input bg-background px-2 text-sm"
        >
          <option value="process">{t('执行过程')}</option>
          <option value="conversation">{t('对话')}</option>
          <option value="tool">{t('工具')}</option>
          <option value="activity">{t('活动')}</option>
          <option value="error">{t('错误')}</option>
          <option value="system">{t('系统信息')}</option>
          <option value="all">{t('全部')}</option>
        </select>{/if}
      <span class="text-xs text-muted-foreground">{matchCount} {t(view === 'events' ? '条事件' : '处匹配')}</span>
      <div class="inline-flex rounded-lg border border-input p-0.5">
        <Button
          size="sm"
          variant={view === 'events' ? 'secondary' : 'ghost'}
          class="h-7"
          onclick={() => (view = 'events')}>{t('事件')}</Button
        >
        <Button size="sm" variant={view === 'raw' ? 'secondary' : 'ghost'} class="h-7" onclick={() => (view = 'raw')}
          >{t('原文')}</Button
        >
      </div>
      {#if hasEarlier}<Button variant="outline" size="sm" disabled={loadingEarlier} onclick={() => void loadEarlier()}
          >{t(loadingEarlier ? '正在加载…' : '加载更早内容')}</Button
        >{/if}
    </div>{/if}

  {#if error}<div class="shrink-0 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>{/if}
  {#if loading && !content}<p class="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
      {t('正在加载…')}
    </p>{:else if selected && view === 'events'}<div
      data-agent-record-events
      data-scroll-pane
      class="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1"
    >
      {#each visibleEvents as event (event.id)}
        <AgentRecordEventView {event} />
      {:else}
        <p class="py-10 text-center text-sm text-muted-foreground">{t('没有匹配的事件')}</p>
      {/each}
    </div>{:else if selected}<pre
      data-agent-record-content
      data-scroll-surface
      class="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-slate-700 bg-[#0b1018] p-4 font-mono text-xs leading-5 text-[#cdd6e3]"><SearchableText
        text={content}
        {query}
      /></pre>{:else if !error}<p class="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
      {t('没有智能体记录')}
    </p>{/if}
</section>
