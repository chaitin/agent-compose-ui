<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title,
    description = '',
    actions,
    children,
  }: {
    title: string;
    description?: string;
    actions?: Snippet;
    children?: Snippet;
  } = $props();
</script>

<div
  data-page-header
  class="sticky top-0 z-20 flex shrink-0 flex-col gap-3 border-b border-border bg-background/95 px-4 py-4 backdrop-blur sm:px-5 md:flex-row md:items-center md:justify-between xl:px-6"
>
  <div class="min-w-0">
    <h1 class="text-lg font-semibold tracking-tight text-foreground">{title}</h1>
    {#if description}
      <p class="mt-0.5 break-words text-sm text-muted-foreground">{description}</p>
    {/if}
  </div>
  {#if actions}
    <div class="flex min-w-0 flex-wrap items-center gap-2 md:justify-end">
      {@render actions()}
    </div>
  {/if}
</div>
{#if children}
  {@render children()}
{/if}
