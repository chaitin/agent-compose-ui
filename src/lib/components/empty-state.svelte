<script lang="ts">
  import type { Component, Snippet } from 'svelte';
  import Inbox from '@lucide/svelte/icons/inbox';

  let {
    icon = Inbox,
    title,
    description = '',
    action,
  }: {
    icon?: Component;
    title: string;
    description?: string;
    action?: Snippet;
  } = $props();

  const Icon = $derived(icon);
</script>

<div
  class="flex flex-col items-center justify-center rounded-lg border border-dashed border-border px-6 py-16 text-center"
>
  <div class="mb-3 flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
    <Icon class="size-5" />
  </div>
  <p class="text-sm font-medium text-foreground">{title}</p>
  {#if description}
    <p class="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
  {/if}
  {#if action}
    <div class="mt-4">{@render action()}</div>
  {/if}
</div>
