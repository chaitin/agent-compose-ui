<script lang="ts">
  import Clock3 from '@lucide/svelte/icons/clock-3';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import AgentRecordEventView from '$lib/components/agent-record-event.svelte';
  import { t } from '$lib/i18n.svelte';
  import { downloadAgentRecord, listAgentRecords, readAgentRecord, type AgentRecord } from '../../api/agent-records';
  import type { RunEvent } from '../../gen/agentcompose/v2/agentcompose_pb.js';
  import { agentRecordEventMatches, parseAgentRecordEvents } from '../../model/agent-record-events';
  import { buildRunExecutionEvents, eventWithinRange } from '../../model/run-execution';

  let {
    events,
    sandboxId,
    logs,
    runStatus,
    startedAt,
    completedAt,
    onDownloadLogs,
  }: {
    events: RunEvent[];
    sandboxId: string;
    logs: string;
    runStatus: string;
    startedAt: string;
    completedAt: string;
    onDownloadLogs: () => void;
  } = $props();

  let records = $state<AgentRecord[]>([]);
  let recordContents = $state<Array<{ record: AgentRecord; content: string }>>([]);
  let loading = $state(false);
  let error = $state('');
  let query = $state('');
  let loadedKey = '';

  const agentEvents = $derived(
    recordContents.flatMap(({ record, content }) =>
      parseAgentRecordEvents(content, record.provider).filter((event) =>
        eventWithinRange(event.timestamp, startedAt, completedAt),
      ),
    ),
  );
  const executionEvents = $derived(buildRunExecutionEvents(events, agentEvents, logs, completedAt));
  const visibleEvents = $derived(executionEvents.filter((event) => agentRecordEventMatches(event, query)));
  const waitingForSandbox = $derived(runStatus === 'pending' && !sandboxId);
  const rawDataAvailable = $derived(Boolean(records.length || logs.trim()));

  $effect(() => {
    const key = `${sandboxId}:${startedAt}:${completedAt}`;
    if (!sandboxId) {
      records = [];
      recordContents = [];
      loadedKey = key;
    } else if (key !== loadedKey) {
      loadedKey = key;
      void loadRecords();
    }
  });

  async function loadRecords(): Promise<void> {
    loading = true;
    error = '';
    try {
      records = await listAgentRecords(sandboxId);
      const chunks = await Promise.all(
        records
          .slice(0, 5)
          .map(async (record) => ({ record, content: (await readAgentRecord(sandboxId, record.id)).content })),
      );
      recordContents = chunks;
    } catch (cause) {
      records = [];
      recordContents = [];
      error = cause instanceof Error ? cause.message : t('加载智能体记录失败');
    } finally {
      loading = false;
    }
  }

  function recordLabel(record: AgentRecord): string {
    const file = record.path.split('/').pop() || record.path;
    return file.length > 42 ? `${file.slice(0, 25)}…${file.slice(-12)}` : file;
  }
</script>

<section class="flex h-full min-h-0 flex-col overflow-hidden" data-run-execution-process>
  <div class="flex shrink-0 flex-wrap items-center gap-2 pb-3">
    <Input bind:value={query} class="min-w-[12rem] flex-1 sm:max-w-sm" placeholder={t('搜索执行过程')} />
    <span class="text-xs text-muted-foreground">{visibleEvents.length} / {executionEvents.length} {t('条事件')}</span>
    {#if sandboxId}<Button variant="outline" size="sm" disabled={loading} onclick={() => void loadRecords()}
        ><RefreshCw class="size-3.5 {loading ? 'animate-spin' : ''}" />{t('刷新')}</Button
      >{/if}
  </div>

  {#if error}<div class="mb-3 shrink-0 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>{/if}

  <div data-scroll-pane class="min-h-0 flex-1 overflow-y-auto pr-1">
    {#if waitingForSandbox}<div
        class="flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed border-border p-8 text-center"
      >
        <Clock3 class="mb-3 size-7 text-warning" />
        <p class="text-sm font-medium">{t('正在等待执行环境')}</p>
        <p class="mt-1 max-w-md text-xs text-muted-foreground">{t('运行已提交，执行环境可用后将开始处理。')}</p>
      </div>{:else if loading && !executionEvents.length}<div
        class="flex min-h-48 items-center justify-center text-sm text-muted-foreground"
      >
        {t('正在准备执行过程…')}
      </div>{:else}<div data-execution-timeline class="space-y-2">
        {#each visibleEvents as event (event.id)}
          <AgentRecordEventView {event} />
        {:else}<div class="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            {t(query.trim() ? '没有匹配的事件' : '当前运行没有可展示的执行活动。')}
          </div>{/each}
      </div>{/if}

    {#if rawDataAvailable}<details class="mt-3 rounded-lg border border-border bg-muted/20 text-sm">
        <summary class="cursor-pointer select-none px-3 py-2 font-medium">{t('原始数据')}</summary>
        <div class="flex flex-wrap gap-2 border-t border-border p-3">
          {#if logs.trim()}<Button variant="outline" size="sm" onclick={onDownloadLogs}>{t('下载输出日志')}</Button
            >{/if}
          {#each records as record (record.id)}
            <Button variant="outline" size="sm" onclick={() => downloadAgentRecord(sandboxId, record)}
              >{t('下载智能体记录')} · {recordLabel(record)}</Button
            >
          {/each}
        </div>
      </details>{/if}
  </div>
</section>
