<script lang="ts">
  import StatusBadge from '$lib/components/status-badge.svelte';
  import { formatBeijingClock, formatBeijingTime } from '../../../time';
  import { t } from '$lib/i18n.svelte';
  import type { RunSummary } from '../../../gen/agentcompose/v2/agentcompose_pb.js';
  import {
    runDuration,
    runShowsError,
    runSourceLabel,
    runStartedAt,
    runState,
    runTriggerDetail,
    type RunDayGroup,
  } from '../../../model/run-list';

  let {
    groups,
    selectedId,
    onSelect,
    onOpen,
  }: {
    groups: RunDayGroup[];
    selectedId: string;
    onSelect: (run: RunSummary) => void;
    onOpen: (run: RunSummary) => void;
  } = $props();
</script>

<table data-table="dense" class="w-full table-fixed border-collapse text-[13px]">
  <colgroup>
    <col class="w-9" />
    <col />
    <col class="w-[24%]" />
    <col class="w-20" />
    <col class="w-28" />
  </colgroup>
  <thead class="sticky top-0 z-10 bg-background">
    <tr class="h-8 text-left text-[11px] text-faint [&>th]:border-b [&>th]:border-border [&>th]:font-normal">
      <th><span class="sr-only">{t('状态')}</span></th>
      <th>{t('智能体 · 项目')}</th>
      <th>{t('触发')}</th>
      <th class="text-right">{t('耗时')}</th>
      <th class="pr-4 text-right sm:pr-5 xl:pr-6">{t('开始')}</th>
    </tr>
  </thead>
  {#each groups as group (group.key)}
    <tbody>
      <tr>
        <td colspan="5" class="h-7 pb-1 pl-4 align-bottom text-[11px] text-faint sm:pl-5 xl:pl-6">{group.label}</td>
      </tr>
      {#each group.items as run (run.runId)}
        {@const selected = run.runId === selectedId}
        {@const failed = runShowsError(run)}
        {@const trigger = runTriggerDetail(run)}
        <tr
          data-run-id={run.runId}
          aria-selected={selected}
          class="cursor-pointer border-b border-border transition-colors {selected
            ? 'bg-selected'
            : 'hover:bg-accent/60'}"
          onclick={() => onSelect(run)}
          ondblclick={() => onOpen(run)}
        >
          <td class="h-8 pl-4 align-top leading-8 sm:pl-5 xl:pl-6"
            ><StatusBadge status={runState(run.status)} dotOnly /></td
          >
          <td class="min-w-0 py-1.5 pr-3 align-top leading-5">
            <div class="truncate">
              <span class="font-medium text-foreground">{run.agentName}</span>
              <span class="text-muted-foreground"> · {run.projectName}</span>
            </div>
            {#if failed}
              <div class="truncate font-mono text-[11.5px] leading-5 text-muted-foreground" title={run.error}>
                <span class="text-destructive">exit {run.exitCode}</span>{#if run.error}<span class="px-1.5 text-faint"
                    >·</span
                  >{run.error}{/if}
              </div>
            {/if}
          </td>
          <td class="truncate pr-3 align-top leading-8 text-muted-foreground">
            <span class="text-faint">{runSourceLabel(run.source)}</span>{#if trigger}<span class="text-foreground/80">
                · {trigger}</span
              >{/if}
          </td>
          <td class="text-right align-top leading-8 tabular-nums text-muted-foreground">{runDuration(run)}</td>
          <td class="pr-4 text-right align-top leading-8 text-muted-foreground sm:pr-5 xl:pr-6">
            <time datetime={runStartedAt(run)} title={formatBeijingTime(runStartedAt(run))} class="tabular-nums"
              >{formatBeijingClock(runStartedAt(run))}</time
            >
          </td>
        </tr>
      {/each}
    </tbody>
  {/each}
</table>
