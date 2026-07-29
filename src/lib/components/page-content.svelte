<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    children,
    compact = false,
    class: className = '',
  }: {
    children: Snippet;
    compact?: boolean;
    class?: string;
  } = $props();
</script>

<div
  data-page-frame
  class={`mx-auto w-full min-w-0 max-w-[112rem] px-4 sm:px-5 xl:px-6 ${compact ? 'py-3' : 'py-4 sm:py-5 xl:py-6'} ${className}`}
>
  {@render children()}
</div>
