<script lang="ts">
  import type { Snippet } from 'svelte';
  import CopyableText from './copyable-text.svelte';
  import { t } from '$lib/i18n.svelte';

  export type TechnicalDetailItem = {
    label: string;
    value: string;
    copyable?: boolean;
  };

  let {
    title = '更多信息',
    items = [],
    children,
    class: className = '',
  }: {
    title?: string;
    items?: TechnicalDetailItem[];
    children?: Snippet;
    class?: string;
  } = $props();
</script>

<details class="rounded-md border border-border bg-muted/30 text-xs text-muted-foreground {className}">
  <summary class="cursor-pointer select-none px-3 py-2 font-medium text-foreground">{t(title)}</summary>
  <div class="space-y-2 border-t border-border px-3 py-3">
    {#each items.filter((item) => item.value) as item (`${item.label}:${item.value}`)}
      <div class="grid min-w-0 gap-1 sm:grid-cols-[8rem_minmax(0,1fr)]">
        <span>{t(item.label)}</span>
        {#if item.copyable === false}
          <span class="min-w-0 break-all font-mono">{item.value}</span>
        {:else}
          <CopyableText value={item.value} label={item.label} class="max-w-full font-mono" />
        {/if}
      </div>
    {/each}
    {#if children}{@render children()}{/if}
  </div>
</details>
