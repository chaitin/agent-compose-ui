<script lang="ts">
  import type { RunSummary } from '../../../gen/agentcompose/v2/agentcompose_pb.js';
  import { RUN_STATE_LABEL, runStartedAt, runState } from '../../../model/run-list';
  import { formatBeijingTime } from '../../../time';
  import { t } from '$lib/i18n.svelte';

  let { runs, currentId, onSelect }: { runs: RunSummary[]; currentId: string; onSelect: (run: RunSummary) => void } =
    $props();

  const tone = {
    success: 'bg-success/70',
    failed: 'bg-destructive/85',
    running: 'bg-info/70',
    stopped: 'bg-faint/60',
    pending: 'bg-warning/70',
  };
  // 左旧右新，和阅读顺序一致。
  const ordered = $derived([...runs].reverse());
</script>

<div class="flex flex-wrap items-center gap-[3px]">
  {#each ordered as run (run.runId)}
    {@const state = runState(run.status)}
    <button
      type="button"
      onclick={() => onSelect(run)}
      title={`${t(RUN_STATE_LABEL[state])} · ${formatBeijingTime(runStartedAt(run))}`}
      aria-label={`${t(RUN_STATE_LABEL[state])} · ${formatBeijingTime(runStartedAt(run))}`}
      class="h-3.5 w-2 rounded-[2px] transition-opacity hover:opacity-70 {tone[state]} {run.runId === currentId
        ? 'outline outline-offset-1 outline-foreground'
        : ''}"
    ></button>
  {:else}
    <span class="text-xs text-muted-foreground">—</span>
  {/each}
</div>
