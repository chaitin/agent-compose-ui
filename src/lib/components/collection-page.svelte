<script lang="ts">
  import type { Snippet } from 'svelte';
  import PageHeader from './page-header.svelte';

  let {
    title,
    description = '',
    compactHeader = false,
    actions,
    toolbar,
    children,
    footer,
    class: className = '',
  }: {
    title: string;
    description?: string;
    compactHeader?: boolean;
    actions?: Snippet;
    toolbar?: Snippet;
    children: Snippet;
    footer?: Snippet;
    class?: string;
  } = $props();
</script>

<div data-page-layout="collection" class="flex h-full min-h-0 flex-col overflow-hidden {className}">
  <PageHeader {title} {description} {actions} compact={compactHeader} />
  <div
    data-page-frame
    class="mx-auto flex min-h-0 w-full max-w-[112rem] flex-1 flex-col px-4 sm:px-5 xl:px-6 {compactHeader
      ? 'py-3'
      : 'py-4'}"
  >
    {#if toolbar}
      <div data-collection-toolbar class="shrink-0 pb-3">
        {@render toolbar()}
      </div>
    {/if}
    <div data-collection-body class="flex min-h-0 min-w-0 flex-1 flex-col">
      {@render children()}
    </div>
    {#if footer}
      <div data-collection-footer class="shrink-0 pt-3">
        {@render footer()}
      </div>
    {/if}
  </div>
</div>
