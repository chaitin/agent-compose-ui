<script lang="ts">
  import type { Snippet } from 'svelte';
  import * as Dialog from '$lib/components/ui/dialog';

  let {
    open,
    onOpenChange,
    title,
    description = '',
    children,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: string;
    children: Snippet;
  } = $props();
</script>

<Dialog.Root {open} {onOpenChange}>
  <Dialog.Content
    class="inset-y-0 right-0 left-auto top-0 grid h-dvh max-w-none translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)] content-stretch overflow-hidden rounded-none border-l border-border p-0 sm:w-[32rem] sm:max-w-[min(32rem,calc(100vw-2rem))]"
  >
    <Dialog.Header class="border-b border-border px-5 py-4 pr-12">
      <Dialog.Title>{title}</Dialog.Title>
      {#if description}<Dialog.Description>{description}</Dialog.Description>{/if}
    </Dialog.Header>
    <div data-scroll-pane class="min-h-0 overflow-y-auto px-5 py-4">
      {@render children()}
    </div>
  </Dialog.Content>
</Dialog.Root>
