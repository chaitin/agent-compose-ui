<script lang="ts">
  import type { Snippet } from 'svelte';
  import { t } from '$lib/i18n.svelte';

  let {
    title,
    description = '',
    compact = false,
    meta,
    actions,
    children,
  }: {
    title: string;
    description?: string;
    compact?: boolean;
    meta?: Snippet;
    actions?: Snippet;
    children?: Snippet;
  } = $props();
</script>

<div data-page-header class="sticky top-0 z-20 shrink-0 border-b border-border bg-background/95 backdrop-blur">
  <div
    data-page-frame
    class="mx-auto flex w-full max-w-[112rem] flex-col px-4 sm:px-5 md:flex-row md:items-center md:justify-between xl:px-6 {compact
      ? 'gap-2 py-2'
      : 'gap-3 py-4'}"
  >
    <div class="min-w-0">
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <h1 class="shrink-0 font-semibold tracking-tight text-foreground {compact ? 'text-base' : 'text-lg'}">
          {t(title)}
        </h1>
        {#if meta}<div class="flex min-w-0 flex-wrap items-center gap-2">{@render meta()}</div>{/if}
      </div>
      {#if description}
        <p class="mt-0.5 break-words text-muted-foreground {compact ? 'hidden text-xs xl:block' : 'text-sm'}">
          {t(description)}
        </p>
      {/if}
    </div>
    {#if actions}
      <div class="flex min-w-0 flex-wrap items-center gap-2 md:justify-end">
        {@render actions()}
      </div>
    {/if}
  </div>
</div>
{#if children}
  {@render children()}
{/if}
