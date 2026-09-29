<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import { t } from '$lib/i18n.svelte';
  import RunActivityList from './run-activity-list.svelte';
  import RunHistoryStrip from './run-history-strip.svelte';
  import type { RunDetail, RunSummary } from '../../../gen/agentcompose/v2/agentcompose_pb.js';
  import {
    RUN_STATE_LABEL,
    runDuration,
    runShowsError,
    runSourceLabel,
    runStartedAt,
    runState,
    runTriggerDetail,
    type RunActivity,
  } from '../../../model/run-list';

  let {
    run,
    detail,
    activities,
    history,
    loading = false,
    onOpen,
    onTerminal,
    onStop,
    onSelectHistory,
  }: {
    run: RunSummary;
    detail: RunDetail | null;
    activities: RunActivity[];
    history: RunSummary[];
    loading?: boolean;
    onOpen: () => void;
    onTerminal: () => void;
    onStop?: () => void;
    onSelectHistory: (run: RunSummary) => void;
  } = $props();

  const state = $derived(runState(run.status));
  const trigger = $derived(runTriggerDetail(run));
  const labels = $derived(Object.entries(detail?.labels ?? {}));
  const section = 'border-b border-border px-5 py-4';
  const heading = 'mb-2.5 flex items-center justify-between text-[11px] text-faint';
</script>

<div class="flex h-full min-h-0 flex-col">
  <header class="border-b border-border px-5 pt-4 pb-3.5">
    <div class="flex items-center gap-2 text-sm font-semibold tracking-tight">
      <StatusBadge status={state} dotOnly />
      <span class="shrink-0">{run.agentName}</span>
      <span class="min-w-0 truncate font-normal text-muted-foreground">· {run.projectName}</span>
    </div>
    <div class="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
      <span class={state === 'failed' ? 'text-destructive' : 'text-foreground/80'}>{t(RUN_STATE_LABEL[state])}</span>
      <span class="text-faint">·</span><span class="tabular-nums">{runDuration(run) || t('进行中')}</span>
      <span class="text-faint">·</span><Timestamp value={runStartedAt(run)} />
      <span class="text-faint">·</span><span>{runSourceLabel(run.source)}{trigger ? ` · ${trigger}` : ''}</span>
    </div>
    <div class="mt-3 flex gap-1.5">
      <Button size="sm" onclick={onOpen}>{t('打开详情')}</Button>
      {#if run.sandboxId}<Button size="sm" variant="outline" onclick={onTerminal}>{t('终端')}</Button>{/if}
      {#if onStop}<Button size="sm" variant="outline" onclick={onStop}>{t('停止')}</Button>{/if}
    </div>
  </header>

  <div data-scroll-surface class="min-h-0 flex-1 overflow-y-auto">
    {#if runShowsError(run)}
      <section class={section}>
        <h3 class={heading}>{t('错误')}</h3>
        <div class="rounded-r-md border-l-2 border-destructive bg-destructive/5 px-3 py-2">
          <div class="mb-1 text-[11px] text-muted-foreground">
            {t('退出码')} <span class="font-semibold text-destructive">{run.exitCode}</span>
          </div>
          <pre
            class="max-h-40 overflow-auto font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap text-foreground">{run.error ||
              t('后端未返回错误信息')}</pre>
        </div>
      </section>
    {/if}

    <section class={section}>
      <h3 class={heading}>
        <span>{t('最后的活动')}</span>
        <button type="button" class="text-primary hover:underline" onclick={onOpen}>{t('全部')} →</button>
      </h3>
      {#if loading && !activities.length}
        <p class="text-xs text-muted-foreground">{t('加载中…')}</p>
      {:else}
        <RunActivityList activities={activities.slice(-6)} startedAt={runStartedAt(run)} />
      {/if}
    </section>

    <section class={section}>
      <h3 class={heading}>{t('该智能体最近运行')}</h3>
      <RunHistoryStrip runs={history} currentId={run.runId} onSelect={onSelectHistory} />
    </section>

    <section class={section}>
      <h3 class={heading}>{t('运行信息')}</h3>
      <dl class="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
        <dt class="text-faint">{t('项目版本')}</dt>
        <dd>r{run.projectRevision}</dd>
        {#if detail?.driver}<dt class="text-faint">{t('运行时')}</dt>
          <dd>{detail.driver}</dd>{/if}
        {#if detail?.imageRef}<dt class="text-faint">{t('镜像地址')}</dt>
          <dd class="truncate font-mono text-[11.5px]" title={detail.imageRef}>{detail.imageRef}</dd>{/if}
        {#each labels as [key, value] (key)}
          <dt class="truncate text-faint" title={key}>{key}</dt>
          <dd class="truncate font-mono text-[11.5px]" title={value}>{value}</dd>
        {/each}
      </dl>
      {#if run.warnings.length}
        <ul class="mt-3 space-y-1 text-xs text-warning-foreground dark:text-warning">
          {#each run.warnings as warning, index (index)}<li>{warning}</li>{/each}
        </ul>
      {/if}
    </section>

    <section class="px-5 py-4">
      <h3 class={heading}>{t('技术细节')}</h3>
      <dl class="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
        <dt class="text-faint">Run</dt>
        <dd class="min-w-0"><CopyableText value={run.runId} label="Run ID" class="font-mono" /></dd>
        {#if run.sandboxId}<dt class="text-faint">Sandbox</dt>
          <dd class="min-w-0"><CopyableText value={run.sandboxId} label="Sandbox ID" class="font-mono" /></dd>{/if}
        {#if run.schedulerRunId}<dt class="text-faint">Scheduler run</dt>
          <dd class="min-w-0">
            <CopyableText value={run.schedulerRunId} label="Scheduler run ID" class="font-mono" />
          </dd>{/if}
      </dl>
    </section>
  </div>
</div>
