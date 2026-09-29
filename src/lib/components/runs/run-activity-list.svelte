<script lang="ts">
  import { t } from '$lib/i18n.svelte';
  import { activityOffset, RUN_ACTIVITY_LABEL, type RunActivity } from '../../../model/run-list';

  let { activities, startedAt }: { activities: RunActivity[]; startedAt: string } = $props();
</script>

<ol class="space-y-0.5">
  {#each activities as item (item.id)}
    <li class="grid grid-cols-[2.75rem_0.5rem_minmax(0,1fr)_auto] items-baseline gap-2 text-xs leading-6">
      <span class="text-right font-mono text-[11px] text-faint">{activityOffset(item.at, startedAt)}</span>
      <span class="size-1.5 self-center rounded-full {item.failed ? 'bg-destructive' : 'bg-faint/60'}"></span>
      <span
        class="truncate {item.failed
          ? 'text-destructive'
          : item.kind === 'status'
            ? 'text-muted-foreground'
            : 'text-foreground'}"
      >
        <span class="mr-1 text-faint">{t(RUN_ACTIVITY_LABEL[item.kind])}</span><span
          class={item.kind === 'tool' ? 'font-mono text-[11.5px]' : ''}>{item.text || '—'}</span
        >
      </span>
      {#if item.failed}<span class="font-mono text-[11px] text-destructive">exit {item.exitCode}</span>{/if}
    </li>
  {:else}
    <li class="text-xs text-muted-foreground">{t('没有记录到活动')}</li>
  {/each}
</ol>
