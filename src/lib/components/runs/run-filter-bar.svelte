<script lang="ts">
  import { t } from '$lib/i18n.svelte';
  import {
    RUN_SOURCE_FILTERS,
    RUN_STATUS_FILTERS,
    RUN_WINDOWS,
    type RunListQuery,
    type RunStatusFilter,
  } from '../../../model/run-list';

  type Option = { value: string; label: string };

  let {
    query,
    counts,
    projects,
    agents,
    onChange,
    onOptionsNeeded,
  }: {
    query: RunListQuery;
    counts: Partial<Record<RunStatusFilter, number>>;
    projects: Option[];
    agents: Option[];
    onChange: (next: RunListQuery) => void;
    /** 第一次展开项目或智能体下拉时调用，用来按需加载完整选项。 */
    onOptionsNeeded?: () => void;
  } = $props();

  const select =
    'h-7 w-36 cursor-pointer appearance-none truncate rounded-md border border-transparent bg-muted pl-2.5 pr-7 text-xs text-foreground outline-none transition-colors hover:bg-accent focus-visible:border-ring';
  const chevron =
    "bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%2210%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23888%22 stroke-width=%223%22><path d=%22m6 9 6 6 6-6%22/></svg>')] bg-[right_0.6rem_center] bg-no-repeat";

  function update(patch: Partial<RunListQuery>): void {
    onChange({ ...query, ...patch });
  }
</script>

<div class="flex flex-wrap items-center gap-1.5">
  <div role="tablist" aria-label={t('状态')} class="flex rounded-md bg-muted p-0.5">
    {#each RUN_STATUS_FILTERS as option (option.value)}
      {@const active = query.status === option.value}
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onclick={() => update({ status: option.value })}
        class="h-6 rounded-[5px] px-2.5 text-xs transition-colors {active
          ? 'bg-card font-medium text-foreground shadow-[0_0_0_1px_var(--input)]'
          : 'text-muted-foreground hover:text-foreground'}"
      >
        {t(option.label)}{#if counts[option.value] !== undefined}<span
            class="ml-1 tabular-nums {option.value === 'failed' && counts.failed ? 'text-destructive' : 'text-faint'}"
            >{counts[option.value]}</span
          >{/if}
      </button>
    {/each}
  </div>

  <select
    class="{select} {chevron}"
    aria-label={t('项目')}
    onfocus={onOptionsNeeded}
    onpointerdown={onOptionsNeeded}
    value={query.projectId}
    onchange={(event) => update({ projectId: event.currentTarget.value, agentName: '' })}
  >
    <option value="">{t('全部项目')}</option>
    {#each projects as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
  </select>
  <select
    class="{select} {chevron}"
    aria-label={t('智能体')}
    onfocus={onOptionsNeeded}
    onpointerdown={onOptionsNeeded}
    value={query.agentName}
    onchange={(event) => update({ agentName: event.currentTarget.value })}
  >
    <option value="">{t('全部智能体')}</option>
    {#each agents as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
  </select>
  <select
    class="{select} {chevron}"
    aria-label={t('来源')}
    value={query.source}
    onchange={(event) => update({ source: event.currentTarget.value as RunListQuery['source'] })}
  >
    {#each RUN_SOURCE_FILTERS as option (option.value)}<option value={option.value}>{t(option.label)}</option>{/each}
  </select>
  <select
    class="{select} {chevron}"
    aria-label={t('时间范围')}
    value={query.window}
    onchange={(event) => update({ window: event.currentTarget.value as RunListQuery['window'] })}
  >
    {#each RUN_WINDOWS as option (option.value)}<option value={option.value}>{t(option.label)}</option>{/each}
  </select>
</div>
