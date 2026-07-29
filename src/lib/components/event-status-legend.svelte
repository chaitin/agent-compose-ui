<script lang="ts">
  import Circle from '@lucide/svelte/icons/circle';
  import { t } from '$lib/i18n.svelte';
  import { dispatchStatusLegend } from '../../model/event-status';

  const tones = {
    pending: 'fill-warning text-warning',
    running: 'fill-info text-info',
    success: 'fill-success text-success',
    failed: 'fill-destructive text-destructive',
    skipped: 'fill-muted-foreground text-muted-foreground',
    stopped: 'fill-muted-foreground text-muted-foreground',
  };
</script>

<details class="rounded-lg border border-border bg-card px-3 py-2 text-xs">
  <summary class="cursor-pointer select-none font-medium">{t('状态说明')}</summary>
  <div class="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
    {#each dispatchStatusLegend as item (item.label)}
      <div class="flex items-start gap-2">
        <Circle class={`mt-0.5 size-2.5 shrink-0 ${tones[item.semantic]}`} />
        <div>
          <div class="font-medium">{t(item.label)}</div>
          <div class="mt-0.5 text-muted-foreground">{t(item.description)}</div>
        </div>
      </div>
    {/each}
  </div>
</details>
